import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AllocationExceededError,
  IntegrityError,
  InventoryTooLargeError,
  MAX_INVENTORY_OBJECTS,
  ObjectStore,
  OBJECT_FORMAT_VERSION,
  SizeMismatchError,
} from "./store.js";

const MB = 1024 * 1024;

let root: string;

function bytes(content: string): Readable {
  return Readable.from([Buffer.from(content)]);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function makeStore(allocatedBytes = 10 * MB): Promise<ObjectStore> {
  const store = new ObjectStore({ rootDir: root, allocatedBytes });
  await store.load();
  return store;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "benzene-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("storing objects", () => {
  it("addresses an object by the hash of its bytes", async () => {
    const store = await makeStore();

    const result = await store.put(bytes("hello benzene"));

    expect(result.hash).toBe(sha256("hello benzene"));
    expect(result.size).toBe("hello benzene".length);
    expect(await store.has(result.hash)).toBe(true);
  });

  it("reads back exactly what was written", async () => {
    const store = await makeStore();
    const { hash } = await store.put(bytes("round trip"));

    const chunks: Buffer[] = [];
    for await (const chunk of store.read(hash)) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString()).toBe("round trip");
  });

  it("does not lay out storage by the user's filenames", async () => {
    const store = await makeStore();
    const { hash } = await store.put(bytes("secret tax return"));

    // Two-character fan-out under objects/, named only by hash.
    const onDisk = path.join(root, "objects", hash.slice(0, 2), hash);
    await expect(readFile(onDisk, "utf8")).resolves.toBe("secret tax return");
  });

  it("records a versioned sidecar so a later format can be told apart", async () => {
    const store = await makeStore();
    const { hash } = await store.put(bytes("payload"));

    const meta = await store.metadata(hash);

    expect(meta).toMatchObject({
      v: OBJECT_FORMAT_VERSION,
      hash,
      size: "payload".length,
      // Encryption is not implemented yet; recording it explicitly means
      // encrypted objects can coexist without migrating these.
      encryption: "none",
    });
  });

  it("treats a repeated transfer of the same bytes as a no-op", async () => {
    const store = await makeStore();

    const first = await store.put(bytes("duplicate"));
    const second = await store.put(bytes("duplicate"));

    expect(second.hash).toBe(first.hash);
    // Counted once: content addressing makes the second transfer redundant.
    expect(store.usedBytes()).toBe("duplicate".length);
    expect(await store.list()).toEqual([first.hash]);
  });

  it("replaces an existing object when its on-disk bytes are corrupt", async () => {
    const store = await makeStore();
    const first = await store.put(bytes("original"));
    await writeFile(path.join(root, "objects", first.hash.slice(0, 2), first.hash), "tampered");

    await expect(
      store.put(bytes("original"), { expectedHash: first.hash })
    ).resolves.toMatchObject({ hash: first.hash, size: "original".length });

    expect(await store.verify(first.hash)).toBe(true);
    expect(store.usedBytes()).toBe("original".length);
  });

  it("replaces corrupt bytes at the exact allocation ceiling", async () => {
    const store = await makeStore(8);
    const first = await store.put(bytes("12345678"));
    await writeFile(path.join(root, "objects", first.hash.slice(0, 2), first.hash), "87654321");

    await expect(
      store.put(bytes("12345678"), { expectedHash: first.hash, expectedSize: 8 })
    ).resolves.toMatchObject({ hash: first.hash, size: 8 });
    expect(store.usedBytes()).toBe(8);
    expect(await store.verify(first.hash)).toBe(true);
  });

  it("rejects bytes that do not match the hash the caller promised", async () => {
    const store = await makeStore();

    await expect(
      store.put(bytes("actual"), { expectedHash: sha256("expected") })
    ).rejects.toBeInstanceOf(IntegrityError);

    expect(await store.list()).toEqual([]);
  });

  it("rejects bytes that do not match the promised size", async () => {
    const store = await makeStore();

    await expect(store.put(bytes("actual"), { expectedSize: 5 })).rejects.toBeInstanceOf(
      SizeMismatchError
    );
    expect(await store.list()).toEqual([]);
    expect(store.usedBytes()).toBe(0);
  });
});

describe("allocation limits", () => {
  it("serializes concurrent writes against one allocation ceiling", async () => {
    const store = await makeStore(10);

    const results = await Promise.allSettled([
      store.put(bytes("123456")),
      store.put(bytes("abcdef")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(store.usedBytes()).toBe(6);
  });

  it("refuses an object larger than the remaining allocation", async () => {
    const store = await makeStore(10);

    await expect(
      store.put(bytes("far too many bytes"), { expectedSize: 18 })
    ).rejects.toBeInstanceOf(AllocationExceededError);
  });

  // A caller may under-report, so the ceiling is enforced against the bytes
  // that actually arrive, not the ones that were promised.
  it("stops mid-stream when a client under-reports the size", async () => {
    const store = await makeStore(10);

    await expect(
      store.put(bytes("far too many bytes"), { expectedSize: 1 })
    ).rejects.toBeInstanceOf(AllocationExceededError);

    expect(await store.list()).toEqual([]);
    expect(store.usedBytes()).toBe(0);
  });

  it("leaves nothing behind when a write is refused", async () => {
    const store = await makeStore(10);

    await store.put(bytes("under")).catch(() => undefined);
    await store.put(bytes("way way way too long")).catch(() => undefined);

    // The failed write must not have consumed allocation.
    expect(store.usedBytes()).toBe("under".length);
  });

  it("tracks how much room is left", async () => {
    const store = await makeStore(100);
    await store.put(bytes("12345"));

    expect(store.usedBytes()).toBe(5);
    expect(store.availableBytes()).toBe(95);
  });

  it("accepts more once the user raises the allocation", async () => {
    const store = await makeStore(4);
    await expect(store.put(bytes("too big"))).rejects.toBeInstanceOf(
      AllocationExceededError
    );

    store.setAllocation(100);

    await expect(store.put(bytes("too big"))).resolves.toMatchObject({ size: 7 });
  });

  it("never reports negative headroom when over an lowered allocation", async () => {
    const store = await makeStore(100);
    await store.put(bytes("some bytes here"));

    store.setAllocation(1);

    expect(store.availableBytes()).toBe(0);
  });
});

describe("integrity", () => {
  it("confirms an untouched object verifies", async () => {
    const store = await makeStore();
    const { hash } = await store.put(bytes("intact"));

    await expect(store.verify(hash)).resolves.toBe(true);
  });

  // Silent corruption is worse than a missing object: it would be served as
  // though it were correct.
  it("detects an object whose bytes changed on disk", async () => {
    const store = await makeStore();
    const { hash } = await store.put(bytes("original"));

    await writeFile(path.join(root, "objects", hash.slice(0, 2), hash), "tampered");

    await expect(store.verify(hash)).resolves.toBe(false);
  });

  it("reports a missing object as unverifiable rather than throwing", async () => {
    const store = await makeStore();

    await expect(store.verify(sha256("never stored"))).resolves.toBe(false);
  });
});

describe("inventory reconciliation", () => {
  it("enforces the shared eight-thousand-object ceiling without truncating", async () => {
    const store = await makeStore();
    await store.put(bytes("first"));
    await store.put(bytes("second"));

    expect(MAX_INVENTORY_OBJECTS).toBe(8_000);
    const error = await store.inventory(1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InventoryTooLargeError);
    expect(error).toMatchObject({
      count: 2,
      maximum: 1,
    });
    await expect(store.inventory()).resolves.toHaveLength(2);
  });

  it("surfaces a read failure and releases the mutation lock", async () => {
    const store = await makeStore();
    await store.put(bytes("existing"));
    const read = vi.spyOn(store, "read").mockImplementationOnce(() => {
      throw new Error("inventory read failed");
    });

    await expect(store.inventory()).rejects.toThrow("inventory read failed");
    read.mockRestore();
    await expect(store.put(bytes("after failure"))).resolves.toMatchObject({
      size: "after failure".length,
    });
  });
});

describe("deletion", () => {
  it("frees the allocation it was using", async () => {
    const store = await makeStore();
    const { hash } = await store.put(bytes("temporary"));

    await store.delete(hash);

    expect(await store.has(hash)).toBe(false);
    expect(store.usedBytes()).toBe(0);
    expect(await store.metadata(hash)).toBeNull();
  });

  it("is safe to call for an object that is not held", async () => {
    const store = await makeStore();

    await expect(store.delete(sha256("absent"))).resolves.toBeUndefined();
  });

  it("erases only Benzene-managed directories", async () => {
    const store = await makeStore();
    await store.put(bytes("removable"));
    await writeFile(path.join(root, "keep.txt"), "not Benzene data");

    await store.erase();

    expect(await store.list()).toEqual([]);
    expect(store.usedBytes()).toBe(0);
    await expect(readFile(path.join(root, "keep.txt"), "utf8")).resolves.toBe(
      "not Benzene data"
    );
    await expect(stat(path.join(root, "objects"))).resolves.toBeDefined();
  });

  it.each(["/", homedir(), "/tmp", "/mnt"])(
    "refuses to erase a broad configured root (%s)",
    async (unsafeRoot) => {
      const unsafe = new ObjectStore({ rootDir: unsafeRoot, allocatedBytes: 100 });

      await expect(unsafe.erase()).rejects.toThrow(/unsafe storage root/);
    }
  );

  it.each(["/", homedir(), "/tmp", "/mnt"])(
    "refuses to load a broad configured root (%s) before touching it",
    async (unsafeRoot) => {
      const unsafe = new ObjectStore({ rootDir: unsafeRoot, allocatedBytes: 100 });

      await expect(unsafe.load()).rejects.toThrow(/unsafe storage root/);
    }
  );

  it("refuses to erase when its ownership marker is missing", async () => {
    const store = await makeStore();
    await store.put(bytes("must remain"));
    await rm(path.join(root, ".benzene-store"));

    await expect(store.erase()).rejects.toThrow(/ENOENT|no such file/i);
    expect(await store.list()).toHaveLength(1);
  });

  it("persists an erase-pending marker across restart", async () => {
    const first = await makeStore();
    await first.erase();
    expect(first.removalPending()).toBe(true);

    const restarted = await makeStore();
    expect(restarted.removalPending()).toBe(true);
    await restarted.clearRemovalPending();
    expect(restarted.removalPending()).toBe(false);
  });
});

describe("restarting", () => {
  it("refuses an unmarked non-empty root without changing its contents", async () => {
    await writeFile(path.join(root, "keep.txt"), "not Benzene data");
    await mkdir(path.join(root, "tmp"), { recursive: true });
    await writeFile(path.join(root, "tmp", "keep.txt"), "still not Benzene data");

    const store = new ObjectStore({ rootDir: root, allocatedBytes: 100 });

    await expect(store.load()).rejects.toThrow(/unmarked non-empty storage root/);
    await expect(readFile(path.join(root, "keep.txt"), "utf8")).resolves.toBe(
      "not Benzene data"
    );
    await expect(readFile(path.join(root, "tmp", "keep.txt"), "utf8")).resolves.toBe(
      "still not Benzene data"
    );
  });

  // The agent cannot trust an in-memory counter across a restart: it may have
  // been killed mid-write.
  it("recomputes usage from what is actually on disk", async () => {
    const first = await makeStore();
    await first.put(bytes("persisted across restart"));

    const second = await makeStore();

    expect(second.usedBytes()).toBe("persisted across restart".length);
    expect(await second.list()).toHaveLength(1);
  });

  it("clears debris left by a write that was interrupted", async () => {
    const store = await makeStore();
    await writeFile(path.join(root, "tmp", "half-written"), "partial");

    const restarted = await makeStore();

    // The partial file is discarded rather than counted or served.
    expect(restarted.usedBytes()).toBe(0);
    expect(await restarted.list()).toEqual([]);
  });

  it("refuses to serve before load() has run", async () => {
    const store = new ObjectStore({ rootDir: root, allocatedBytes: 100 });

    await expect(store.put(bytes("too early"))).rejects.toThrow(/load\(\)/);
  });
});
