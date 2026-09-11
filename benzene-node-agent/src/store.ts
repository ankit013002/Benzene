import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

/**
 * The device's contributed storage.
 *
 * Objects are addressed by the SHA-256 of their bytes rather than by the user's
 * filename or path (architecture §29/§30). That decouples physical layout from
 * the logical tree, makes corruption detectable, makes transfers idempotent,
 * and opens the door to deduplication later.
 */

/**
 * On-disk format version, recorded per object.
 *
 * Encryption is not implemented yet, but it lands before this is deployed
 * widely, and by then there will be stored objects. Recording a version and an
 * explicit `encryption` field now means a reader can tell plaintext-era objects
 * from encrypted ones and a migration is unnecessary — the alternative is
 * rewriting every stored byte on machines we do not control.
 */
export const OBJECT_FORMAT_VERSION = 1;
const STORE_MARKER = "benzene-object-store-v1\n";
const REMOVAL_PENDING_MARKER = "benzene-removal-pending-v1\n";

export interface ObjectMetadata {
  v: number;
  hash: string;
  size: number;
  /** "none" until client-side encryption ships; then the scheme identifier. */
  encryption: string;
  receivedAt: string;
}

export interface StoredObject {
  hash: string;
  size: number;
}

export class AllocationExceededError extends Error {
  constructor(readonly attempted: number, readonly available: number) {
    super(
      `Object of ${attempted} bytes exceeds the ${available} bytes still allocated to this device`
    );
    this.name = "AllocationExceededError";
  }
}

export class IntegrityError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`Object failed integrity check: expected ${expected}, computed ${actual}`);
    this.name = "IntegrityError";
  }
}

export class SizeMismatchError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Object has size ${actual} bytes, expected ${expected} bytes`);
    this.name = "SizeMismatchError";
  }
}

export interface ObjectStoreOptions {
  rootDir: string;
  /** Hard ceiling. The agent must never write outside what the user granted. */
  allocatedBytes: number;
}

export class ObjectStore {
  private readonly rootDir: string;
  private allocatedBytes: number;
  private used = 0;
  private loaded = false;
  private removalPendingState = false;
  /** Serialises mutations so concurrent PUTs cannot spend the same free bytes. */
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: ObjectStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.allocatedBytes = options.allocatedBytes;
  }

  private get objectsDir(): string {
    return path.join(this.rootDir, "objects");
  }

  private get metaDir(): string {
    return path.join(this.rootDir, "meta");
  }

  private get tmpDir(): string {
    return path.join(this.rootDir, "tmp");
  }

  private get markerPath(): string {
    return path.join(this.rootDir, ".benzene-store");
  }

  private get removalPendingPath(): string {
    return path.join(this.rootDir, ".benzene-removal-pending");
  }

  /** Two-character fan-out keeps directories from growing unboundedly wide. */
  private pathFor(dir: string, hash: string, suffix = ""): string {
    return path.join(dir, hash.slice(0, 2), `${hash}${suffix}`);
  }

  /**
   * Recomputes usage from what is actually on disk.
   *
   * The agent cannot trust a counter across restarts: it may have been killed
   * mid-write, and the control plane's view of usage is only as good as the
   * last heartbeat.
   */
  async load(): Promise<void> {
    await this.assertSafeStoreRoot();
    // Claim the root before creating or deleting any managed child. An
    // unmarked non-empty directory may belong to another application; the
    // old pre-marker layout is intentionally not auto-upgraded because its
    // ownership cannot be established safely.
    await this.claimOrValidateRoot();
    await mkdir(this.objectsDir, { recursive: true });
    await mkdir(this.metaDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    this.removalPendingState = await this.hasRemovalPendingMarker();

    // Anything in tmp is the debris of an interrupted write.
    await rm(this.tmpDir, { recursive: true, force: true });
    await mkdir(this.tmpDir, { recursive: true });

    let total = 0;
    const prefixes = await readdir(this.objectsDir, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue;
      const entries = await readdir(path.join(this.objectsDir, prefix.name));
      for (const entry of entries) {
        const info = await stat(path.join(this.objectsDir, prefix.name, entry));
        total += info.size;
      }
    }

    this.used = total;
    this.loaded = true;
  }

  usedBytes(): number {
    return this.used;
  }

  allocation(): number {
    return this.allocatedBytes;
  }

  availableBytes(): number {
    return Math.max(0, this.allocatedBytes - this.used);
  }

  removalPending(): boolean {
    return this.removalPendingState;
  }

  /** Applied when the user changes how much this device contributes. */
  setAllocation(bytes: number): void {
    this.allocatedBytes = bytes;
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.pathFor(this.objectsDir, hash));
      return true;
    } catch {
      return false;
    }
  }

  async metadata(hash: string): Promise<ObjectMetadata | null> {
    try {
      const raw = await readFile(this.pathFor(this.metaDir, hash, ".json"), "utf8");
      return JSON.parse(raw) as ObjectMetadata;
    } catch {
      return null;
    }
  }

  /**
   * Streams an object in, hashing as it goes.
   *
   * Written to a temp file and renamed only once complete, so a crash mid-write
   * leaves debris in tmp rather than a truncated object that would pass a
   * existence check and fail verification later.
   */
  async put(
    source: Readable,
    options: { expectedSize?: number; expectedHash?: string } = {}
  ): Promise<StoredObject> {
    return this.withMutationLock(() => this.putUnlocked(source, options));
  }

  private async putUnlocked(
    source: Readable,
    options: { expectedSize?: number; expectedHash?: string }
  ): Promise<StoredObject> {
    this.assertLoaded();

    // A device may already hold the expected object. Verify that path before
    // accepting more bytes: retaining a valid copy needs no allocation, while
    // retaining known-corrupt bytes during a replacement could exceed the
    // physical ceiling even if logical accounting subtracts them.
    if (options.expectedHash && (await this.has(options.expectedHash))) {
      const existingSize = await this.existingObjectSize(options.expectedHash);
      if (await this.verify(options.expectedHash)) {
        const incoming = await this.hashSource(source, existingSize);
        if (typeof options.expectedSize === "number" && options.expectedSize !== incoming.size) {
          throw new SizeMismatchError(options.expectedSize, incoming.size);
        }
        if (incoming.hash !== options.expectedHash) {
          throw new IntegrityError(options.expectedHash, incoming.hash);
        }
        return incoming;
      }

      await this.removeCorruptObject(options.expectedHash, existingSize);
    }

    const availableForWrite = this.availableBytes();
    if (
      typeof options.expectedSize === "number" &&
      options.expectedSize > availableForWrite
    ) {
      throw new AllocationExceededError(options.expectedSize, availableForWrite);
    }

    const tmpPath = path.join(this.tmpDir, randomUUID());
    const hasher = createHash("sha256");
    let size = 0;
    const remaining = this.availableBytes();

    try {
      await pipeline(
        source,
        async function* (chunks) {
          for await (const chunk of chunks) {
            const buf = chunk as Buffer;
            size += buf.length;
            // Enforced during the stream too: a client may under-report, and
            // the agent must never exceed what the user granted.
            if (size > remaining) {
              throw new AllocationExceededError(size, remaining);
            }
            hasher.update(buf);
            yield buf;
          }
        },
        createWriteStream(tmpPath)
      );

      const hash = hasher.digest("hex");

      if (typeof options.expectedSize === "number" && options.expectedSize !== size) {
        throw new SizeMismatchError(options.expectedSize, size);
      }

      if (options.expectedHash && options.expectedHash !== hash) {
        throw new IntegrityError(options.expectedHash, hash);
      }

      // Already held and still valid: the transfer was redundant, so drop the
      // duplicate rather than counting it twice. A path alone is not evidence
      // of possession because a disk can corrupt bytes in place.
      if (await this.has(hash)) {
        if (await this.verify(hash)) {
          await rm(tmpPath, { force: true });
          return { hash, size };
        }

        const corruptSize = (await stat(this.pathFor(this.objectsDir, hash))).size;
        // The old bytes are already known to be unusable. Remove them before
        // installing the replacement so temp + old + replacement never exceed
        // the allocation ceiling. A failed replacement leaves the object
        // absent and retryable rather than restoring corrupt content.
        await this.removeCorruptObject(hash, corruptSize);
        try {
          await mkdir(path.dirname(this.pathFor(this.objectsDir, hash)), { recursive: true });
          await rename(tmpPath, this.pathFor(this.objectsDir, hash));
          await writeFile(
            this.pathFor(this.metaDir, hash, ".json"),
            JSON.stringify({
              v: OBJECT_FORMAT_VERSION,
              hash,
              size,
              encryption: "none",
              receivedAt: new Date().toISOString(),
            } satisfies ObjectMetadata),
            "utf8"
          );
          this.used += size;
          return { hash, size };
        } catch (err) {
          await rm(this.pathFor(this.objectsDir, hash), { force: true });
          await rm(this.pathFor(this.metaDir, hash, ".json"), { force: true });
          throw err;
        }
      }

      await mkdir(path.dirname(this.pathFor(this.objectsDir, hash)), { recursive: true });
      await mkdir(path.dirname(this.pathFor(this.metaDir, hash, ".json")), {
        recursive: true,
      });
      await rename(tmpPath, this.pathFor(this.objectsDir, hash));

      const meta: ObjectMetadata = {
        v: OBJECT_FORMAT_VERSION,
        hash,
        size,
        encryption: "none",
        receivedAt: new Date().toISOString(),
      };
      await writeFile(
        this.pathFor(this.metaDir, hash, ".json"),
        JSON.stringify(meta),
        "utf8"
      );

      this.used += size;
      return { hash, size };
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
  }

  private async existingObjectSize(hash: string): Promise<number> {
    try {
      return (await stat(this.pathFor(this.objectsDir, hash))).size;
    } catch {
      return 0;
    }
  }

  private async hashSource(source: Readable, remaining: number): Promise<StoredObject> {
    const hasher = createHash("sha256");
    let size = 0;
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > remaining) throw new AllocationExceededError(size, remaining);
      hasher.update(buf);
    }
    return { hash: hasher.digest("hex"), size };
  }

  private async removeCorruptObject(hash: string, size: number): Promise<void> {
    // Remove metadata first. If permissions prevent that, leave the corrupt
    // object in place and fail without silently deleting its valid metadata.
    await rm(this.pathFor(this.metaDir, hash, ".json"), { force: true });
    await rm(this.pathFor(this.objectsDir, hash), { force: true });
    this.used = Math.max(0, this.used - size);
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  /** Opens an object for reading. Callers that need integrity should verify. */
  read(hash: string): NodeJS.ReadableStream {
    return createReadStream(this.pathFor(this.objectsDir, hash));
  }

  /**
   * Reads an object back and confirms its bytes still hash to its name.
   *
   * This is the scrub operation of architecture §48: disks rot, and an object
   * that silently changed is worse than one that is missing, because it would
   * be served as if it were correct.
   */
  async verify(hash: string): Promise<boolean> {
    if (!(await this.has(hash))) return false;

    const hasher = createHash("sha256");
    await pipeline(this.read(hash), async function (chunks) {
      for await (const chunk of chunks) hasher.update(chunk as Buffer);
    });

    return hasher.digest("hex") === hash;
  }

  async delete(hash: string): Promise<void> {
    await this.withMutationLock(() => this.deleteUnlocked(hash));
  }

  /**
   * Erases only Benzene-managed object, metadata and temporary directories.
   * The configured store root itself and every sibling path remain untouched;
   * device removal must never become a general-purpose filesystem wipe. This
   * removes filesystem entries; it is not a secure media overwrite guarantee.
   */
  async erase(): Promise<void> {
    await this.assertSafeStoreRoot();
    await this.withMutationLock(async () => {
      this.assertLoaded();
      await this.verifyMarker();
      await writeFile(this.removalPendingPath, REMOVAL_PENDING_MARKER, {
        encoding: "utf8",
        flag: "w",
      });
      this.removalPendingState = true;
      await Promise.all([
        rm(this.objectsDir, { recursive: true, force: true }),
        rm(this.metaDir, { recursive: true, force: true }),
        rm(this.tmpDir, { recursive: true, force: true }),
      ]);
      await mkdir(this.objectsDir, { recursive: true });
      await mkdir(this.metaDir, { recursive: true });
      await mkdir(this.tmpDir, { recursive: true });
      this.used = 0;
    });
  }

  async clearRemovalPending(): Promise<void> {
    await this.withMutationLock(async () => {
      this.assertLoaded();
      await this.verifyMarker();
      await rm(this.removalPendingPath, { force: true });
      this.removalPendingState = false;
    });
  }

  private async claimOrValidateRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    try {
      const marker = await readFile(this.markerPath, "utf8");
      if (marker !== STORE_MARKER) {
        throw new Error("Configured storage root has an invalid Benzene marker");
      }
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
      const entries = await readdir(this.rootDir);
      if (entries.length > 0) {
        throw new Error(
          "Refusing to claim an unmarked non-empty storage root; existing-store upgrade is unsupported"
        );
      }
      try {
        await writeFile(this.markerPath, STORE_MARKER, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (claimError) {
        // Another process may have claimed the empty root between the scan and
        // the exclusive create. Validate its marker rather than overwriting it.
        if (!isErrno(claimError, "EEXIST")) throw claimError;
        await this.verifyMarker();
      }
    }
  }

  private async verifyMarker(): Promise<void> {
    const marker = await readFile(this.markerPath, "utf8");
    if (marker !== STORE_MARKER) {
      throw new Error("Configured storage root has an invalid Benzene marker");
    }
  }

  private async hasRemovalPendingMarker(): Promise<boolean> {
    try {
      const marker = await readFile(this.removalPendingPath, "utf8");
      if (marker !== REMOVAL_PENDING_MARKER) {
        throw new Error("Configured storage root has an invalid removal marker");
      }
      return true;
    } catch (err) {
      if (isErrno(err, "ENOENT")) return false;
      throw err;
    }
  }

  private async assertSafeStoreRoot(): Promise<void> {
    const root = path.resolve(this.rootDir);
    const canonicalRoot = await canonicalPath(root);
    const filesystemRoot = path.parse(canonicalRoot).root;
    const broadRoots = new Set(
      await Promise.all(
        [
          filesystemRoot,
          path.resolve(homedir()),
          path.resolve(tmpdir()),
          "/tmp",
          "/private/tmp",
          "/var/tmp",
          "/mnt",
        ].map((candidate) => canonicalPath(candidate))
      )
    );
    if (
      broadRoots.has(canonicalRoot) ||
      path.dirname(canonicalRoot) === filesystemRoot
    ) {
      throw new Error(`Refusing to erase unsafe storage root: ${canonicalRoot}`);
    }
  }

  private async deleteUnlocked(hash: string): Promise<void> {
    this.assertLoaded();

    let size = 0;
    try {
      size = (await stat(this.pathFor(this.objectsDir, hash))).size;
    } catch {
      return;
    }

    await rm(this.pathFor(this.objectsDir, hash), { force: true });
    await rm(this.pathFor(this.metaDir, hash, ".json"), { force: true });
    this.used = Math.max(0, this.used - size);
  }

  /** Every object held, for reporting and for reconciliation with the plane. */
  async list(): Promise<string[]> {
    this.assertLoaded();

    const hashes: string[] = [];
    const prefixes = await readdir(this.objectsDir, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue;
      const entries = await readdir(path.join(this.objectsDir, prefix.name));
      hashes.push(...entries);
    }
    return hashes.sort();
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("ObjectStore.load() must be awaited before use");
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    return path.join(await canonicalPath(parent), path.basename(candidate));
  }
}
