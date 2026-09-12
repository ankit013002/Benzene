import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetConfigCache, type AppConfig } from "../config/env.js";
import DriveNodeModel from "../models/driveNode.model.js";
import FileVersionModel from "../models/fileVersion.model.js";
import { LocalStorageDriver } from "../storage/local.driver.js";
import { setStorageDriver } from "../storage/index.js";
import * as placementService from "../modules/placement/placement.service.js";
import {
  createFolders,
  deleteNode,
  getUsage,
  listDirectory,
} from "./driveNodes.services.js";
import {
  completeDeviceUploads,
  completeUploads,
  presignUploads,
} from "./uploads.services.js";

const OWNER = "user-alpha";
const OTHER_OWNER = "user-beta";

let mongo: MongoMemoryServer;
let storageRoot: string;
let driver: LocalStorageDriver;

function makeConfig(): AppConfig {
  return {
    port: 5000,
    mongooseUri: mongo.getUri(),
    storageDriver: "local",
    maxUploadBytes: 1024 * 1024,
    presignTtlSeconds: 900,
    enrollmentCodeTtlSeconds: 600,
    enrollmentRateLimitMax: 10,
    enrollmentRateLimitWindowSeconds: 60,
    enrollmentPairingRateLimitMax: 10,
    enrollmentPairingRateLimitWindowSeconds: 60,
    s3: { bucket: "", region: "", endpoint: undefined, forcePathStyle: false },
    local: { rootDir: storageRoot, publicBaseUrl: "http://localhost:5000/local-objects" },
  };
}

/** Performs the browser's half of the flow: PUT the bytes to the signed URL. */
async function uploadBytes(key: string, body: string): Promise<void> {
  await driver.putObject(key, Buffer.from(body));
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storageRoot = await mkdtemp(path.join(tmpdir(), "nv-int-"));

  process.env["MONGOOSE_URI"] = mongo.getUri();
  // Required by config(); these tests never open a Postgres connection.
  process.env["DATABASE_URL"] ??=
    process.env["TEST_DATABASE_URL"] ?? "postgres://localhost:5432/unused";
  process.env["STORAGE_DRIVER"] = "local";
  process.env["LOCAL_STORAGE_DIR"] = storageRoot;
  process.env["MAX_UPLOAD_BYTES"] = String(1024 * 1024);
  resetConfigCache();

  driver = new LocalStorageDriver(makeConfig());
  setStorageDriver(driver);

  await mongoose.connect(mongo.getUri());
  // Indexes carry the correctness guarantees under test (one current version
  // per node, one live name per directory), so build them before asserting.
  await Promise.all([
    DriveNodeModel.init(),
    FileVersionModel.init(),
  ]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await rm(storageRoot, { recursive: true, force: true });
  setStorageDriver(undefined);
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await Promise.all([
    DriveNodeModel.deleteMany({}),
    FileVersionModel.deleteMany({}),
  ]);
});

describe("upload lifecycle", () => {
  it("does not expose a file until its upload is completed", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "notes.txt", size: 5, contentType: "text/plain" }],
    });
    expect(presigned).toBeDefined();

    const beforeUpload = await listDirectory(OWNER, "");
    expect(beforeUpload.files[0]?.hasContent).toBe(false);
    expect(beforeUpload.files[0]?.bytes).toBe(0);

    await uploadBytes(presigned!.key, "hello");
    await completeUploads(OWNER, [presigned!.versionId]);

    const afterUpload = await listDirectory(OWNER, "");
    expect(afterUpload.files[0]?.hasContent).toBe(true);
    expect(afterUpload.files[0]?.bytes).toBe(5);
  });

  it("refuses to complete an upload whose bytes never arrived", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "ghost.txt", size: 10 }],
    });

    await expect(completeUploads(OWNER, [presigned!.versionId])).rejects.toThrow(
      /presigned PUT did not complete/
    );
  });

  it("records the size storage reports, not the size the client claimed", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "liar.txt", size: 1 }],
    });

    await uploadBytes(presigned!.key, "a much longer body than declared");
    const [completed] = await completeUploads(OWNER, [presigned!.versionId]);

    expect(completed!.bytes).toBe("a much longer body than declared".length);

    const usage = await getUsage(OWNER);
    expect(usage.bytes).toBe("a much longer body than declared".length);
  });

  it("rejects a file larger than the configured maximum", async () => {
    await expect(
      presignUploads(OWNER, { path: "", files: [{ name: "big.bin", size: 2 * 1024 * 1024 }] })
    ).rejects.toThrow(/over the/);
  });

  it("is idempotent when the same version is completed twice", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "twice.txt", size: 3 }],
    });
    await uploadBytes(presigned!.key, "abc");

    const first = await completeUploads(OWNER, [presigned!.versionId]);
    const second = await completeUploads(OWNER, [presigned!.versionId]);

    expect(second).toEqual(first);
    expect(await FileVersionModel.countDocuments({ isCurrent: true })).toBe(1);
  });

  it("keeps the highest version current when completions overlap", async () => {
    const first = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "overlap.txt", size: 2 }],
    });
    await uploadBytes(first[0]!.key, "v1");

    const second = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "overlap.txt", size: 8 }],
    });
    await uploadBytes(second[0]!.key, "version2");

    const originalHeadObject = driver.headObject.bind(driver);
    let headCalls = 0;
    let releaseHeaded: () => void = () => undefined;
    let releaseGate: () => void = () => undefined;
    const bothHeaded = new Promise<void>((resolve) => {
      releaseHeaded = resolve;
    });
    const headGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    driver.headObject = async (key) => {
      const stored = await originalHeadObject(key);
      headCalls += 1;
      if (headCalls === 2) {
        releaseHeaded();
      }
      await headGate;
      return stored;
    };

    try {
      const lower = completeUploads(OWNER, [first[0]!.versionId]);
      const higher = completeUploads(OWNER, [second[0]!.versionId]);
      await bothHeaded;
      releaseGate();
      await Promise.all([lower, higher]);
    } finally {
      driver.headObject = originalHeadObject;
    }

    const versions = await FileVersionModel.find({ nodeId: first[0]!.nodeId })
      .sort({ version: 1 })
      .lean();
    expect(versions.map((version) => [version.version, version.status, version.isCurrent])).toEqual([
      [1, "committed", false],
      [2, "committed", true],
    ]);

    const node = await DriveNodeModel.findById(first[0]!.nodeId).lean();
    expect(node).toMatchObject({ bytes: 8, versionsCount: 2 });
  });

  it("keeps the highest device version current when completions overlap", async () => {
    const node = await DriveNodeModel.create({
      ownerId: OWNER,
      type: "file",
      name: "device-overlap.bin",
      nameLower: "device-overlap.bin",
      path: "",
      parentId: null,
      ancestors: [],
      createdBy: OWNER,
    });
    const first = await FileVersionModel.create({
      nodeId: node._id,
      ownerId: OWNER,
      version: 1,
      bytes: 2,
      contentType: "application/octet-stream",
      objectHash: "a".repeat(64),
      status: "pending",
      uploadedBy: OWNER,
      isCurrent: false,
    });
    const second = await FileVersionModel.create({
      nodeId: node._id,
      ownerId: OWNER,
      version: 2,
      bytes: 8,
      contentType: "application/octet-stream",
      objectHash: "b".repeat(64),
      status: "pending",
      uploadedBy: OWNER,
      isCurrent: false,
    });

    let protectionCalls = 0;
    let releaseProtection: () => void = () => undefined;
    let releaseGate: () => void = () => undefined;
    const bothProtected = new Promise<void>((resolve) => {
      releaseProtection = resolve;
    });
    const protectionGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const protectionSpy = vi
      .spyOn(placementService, "getObjectProtection")
      .mockImplementation(async (_ownerId, objectHash) => {
        protectionCalls += 1;
        if (protectionCalls === 2) releaseProtection();
        await protectionGate;
        return {
          objectHash,
          desiredReplicas: 1,
          healthyReplicas: 1,
          placingReplicas: 0,
          state: "healthy",
          deviceIds: ["device-for-test"],
        };
      });

    try {
      const lower = completeDeviceUploads(OWNER, [first._id.toString()]);
      const higher = completeDeviceUploads(OWNER, [second._id.toString()]);
      await bothProtected;
      releaseGate();
      await Promise.all([lower, higher]);
    } finally {
      protectionSpy.mockRestore();
    }

    const versions = await FileVersionModel.find({ nodeId: node._id })
      .sort({ version: 1 })
      .lean();
    expect(versions.map((version) => [version.version, version.status, version.isCurrent])).toEqual([
      [1, "committed", false],
      [2, "committed", true],
    ]);

    const persistedNode = await DriveNodeModel.findById(node._id).lean();
    expect(persistedNode).toMatchObject({ bytes: 8, versionsCount: 2 });
  });
});

describe("versioning", () => {
  it("keeps one current version while retaining history", async () => {
    const upload = async (body: string): Promise<void> => {
      const [presigned] = await presignUploads(OWNER, {
        path: "",
        files: [{ name: "doc.txt", size: body.length }],
      });
      await uploadBytes(presigned!.key, body);
      await completeUploads(OWNER, [presigned!.versionId]);
    };

    await upload("v1");
    await upload("version two");

    const versions = await FileVersionModel.find({}).sort({ version: 1 }).lean();
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions.filter((v) => v.isCurrent).map((v) => v.version)).toEqual([2]);

    // Re-uploading updates the existing node rather than creating a second one.
    expect(await DriveNodeModel.countDocuments({ type: "file", isDeleted: false })).toBe(1);

    const listing = await listDirectory(OWNER, "");
    expect(listing.files[0]?.bytes).toBe("version two".length);
  });

  it("gives each version its own object key so history is not overwritten", async () => {
    const first = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "doc.txt", size: 2 }],
    });
    await uploadBytes(first[0]!.key, "v1");
    await completeUploads(OWNER, [first[0]!.versionId]);

    const second = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "doc.txt", size: 2 }],
    });

    expect(second[0]!.key).not.toBe(first[0]!.key);
    expect(second[0]!.version).toBe(2);
    expect(await driver.headObject(first[0]!.key)).not.toBeNull();
  });
});

describe("folder handling", () => {
  it("creates the whole ancestor chain for a nested upload", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "projects/2026/q1",
      files: [{ name: "plan.md", size: 4 }],
    });
    await uploadBytes(presigned!.key, "plan");
    await completeUploads(OWNER, [presigned!.versionId]);

    const root = await listDirectory(OWNER, "");
    expect(root.folders.map((f) => f.name)).toEqual(["projects"]);

    const nested = await listDirectory(OWNER, "projects/2026/q1");
    expect(nested.files.map((f) => f.name)).toEqual(["plan.md"]);
  });

  it("rolls descendant sizes up into folder totals", async () => {
    const uploadInto = async (dir: string, name: string, body: string): Promise<void> => {
      const [presigned] = await presignUploads(OWNER, {
        path: dir,
        files: [{ name, size: body.length }],
      });
      await uploadBytes(presigned!.key, body);
      await completeUploads(OWNER, [presigned!.versionId]);
    };

    await uploadInto("docs", "a.txt", "aaaa");
    await uploadInto("docs/deep", "b.txt", "bbbbbb");

    const root = await listDirectory(OWNER, "");
    const docs = root.folders.find((f) => f.name === "docs");

    // 4 bytes directly inside docs/ plus 6 from the nested folder.
    expect(docs?.bytes).toBe(10);
  });

  it("normalises equivalent paths to the same directory", async () => {
    await presignUploads(OWNER, { path: "a/b", files: [{ name: "x.txt", size: 1 }] });
    await presignUploads(OWNER, { path: "/a/b/", files: [{ name: "y.txt", size: 1 }] });

    const listing = await listDirectory(OWNER, "a/b");
    expect(listing.files.map((f) => f.name).sort()).toEqual(["x.txt", "y.txt"]);
    expect(await DriveNodeModel.countDocuments({ type: "folder" })).toBe(2);
  });

  it("keeps a dropped folder tree in shape using each file's own path", async () => {
    // What a folder drag-and-drop sends: one batch, files at differing depths.
    const presigned = await presignUploads(OWNER, {
      path: "",
      files: [
        { name: "root.txt", size: 1, path: "tree" },
        { name: "nested.txt", size: 1, path: "tree/inner" },
        { name: "deep.txt", size: 1, path: "tree/inner/deeper" },
      ],
    });

    expect(presigned.map((p) => p.path)).toEqual([
      "tree/",
      "tree/inner/",
      "tree/inner/deeper/",
    ]);

    expect((await listDirectory(OWNER, "tree")).files.map((f) => f.name)).toEqual([
      "root.txt",
    ]);
    expect(
      (await listDirectory(OWNER, "tree/inner/deeper")).files.map((f) => f.name)
    ).toEqual(["deep.txt"]);
  });

  it("creates an empty folder that no file implies", async () => {
    await createFolders(OWNER, ["blank/inner"]);

    expect((await listDirectory(OWNER, "")).folders.map((f) => f.name)).toEqual(["blank"]);
    expect((await listDirectory(OWNER, "blank")).folders.map((f) => f.name)).toEqual([
      "inner",
    ]);
  });

  it("does not duplicate folders when two uploads target the same new directory", async () => {
    await Promise.all([
      presignUploads(OWNER, { path: "shared", files: [{ name: "one.txt", size: 1 }] }),
      presignUploads(OWNER, { path: "shared", files: [{ name: "two.txt", size: 1 }] }),
    ]);

    expect(
      await DriveNodeModel.countDocuments({ type: "folder", nameLower: "shared" })
    ).toBe(1);
  });
});

describe("tenant isolation", () => {
  it("never lists another owner's files", async () => {
    await presignUploads(OWNER, { path: "", files: [{ name: "mine.txt", size: 1 }] });

    expect((await listDirectory(OTHER_OWNER, "")).files).toEqual([]);
    expect((await getUsage(OTHER_OWNER)).bytes).toBe(0);
  });

  it("refuses to complete an upload belonging to another owner", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "mine.txt", size: 2 }],
    });
    await uploadBytes(presigned!.key, "hi");

    await expect(completeUploads(OTHER_OWNER, [presigned!.versionId])).rejects.toThrow(
      /not found/
    );
  });

  it("lets two owners hold the same filename independently", async () => {
    await presignUploads(OWNER, { path: "", files: [{ name: "same.txt", size: 1 }] });
    await presignUploads(OTHER_OWNER, { path: "", files: [{ name: "same.txt", size: 1 }] });

    expect((await listDirectory(OWNER, "")).files).toHaveLength(1);
    expect((await listDirectory(OTHER_OWNER, "")).files).toHaveLength(1);
  });

  it("scopes object keys to the owner", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "k.txt", size: 1 }],
    });

    expect(presigned!.key.startsWith(`users/${OWNER}/`)).toBe(true);
  });
});

describe("deletion", () => {
  it("hides a soft-deleted file but keeps its bytes recoverable", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "temp.txt", size: 4 }],
    });
    await uploadBytes(presigned!.key, "temp");
    await completeUploads(OWNER, [presigned!.versionId]);

    const result = await deleteNode(OWNER, presigned!.nodeId, { purge: false });

    expect(result).toEqual({ deletedNodes: 1, purgedObjects: 0 });
    expect((await listDirectory(OWNER, "")).files).toEqual([]);
    expect(await driver.headObject(presigned!.key)).not.toBeNull();
  });

  it("removes the stored objects when purging", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "gone.txt", size: 4 }],
    });
    await uploadBytes(presigned!.key, "gone");
    await completeUploads(OWNER, [presigned!.versionId]);

    const result = await deleteNode(OWNER, presigned!.nodeId, { purge: true });

    expect(result.purgedObjects).toBe(1);
    expect(await driver.headObject(presigned!.key)).toBeNull();
  });

  it("deletes a folder together with its whole subtree", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "parent/child",
      files: [{ name: "deep.txt", size: 4 }],
    });
    await uploadBytes(presigned!.key, "deep");
    await completeUploads(OWNER, [presigned!.versionId]);

    const root = await listDirectory(OWNER, "");
    const parentId = root.folders.find((f) => f.name === "parent")?.id;

    const result = await deleteNode(OWNER, parentId!, { purge: false });

    // parent, child and the file beneath them.
    expect(result.deletedNodes).toBe(3);
    expect((await listDirectory(OWNER, "")).folders).toEqual([]);
    expect((await getUsage(OWNER)).bytes).toBe(0);
  });

  it("frees the name so it can be reused after deletion", async () => {
    const [first] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "reuse.txt", size: 1 }],
    });
    await deleteNode(OWNER, first!.nodeId, { purge: false });

    await expect(
      presignUploads(OWNER, { path: "", files: [{ name: "reuse.txt", size: 1 }] })
    ).resolves.toHaveLength(1);
  });

  it("refuses to delete a node owned by someone else", async () => {
    const [presigned] = await presignUploads(OWNER, {
      path: "",
      files: [{ name: "mine.txt", size: 1 }],
    });

    await expect(
      deleteNode(OTHER_OWNER, presigned!.nodeId, { purge: false })
    ).rejects.toThrow(/not found/);
  });
});
