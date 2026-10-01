import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlatFile } from "@/types/FileFolderBuffer";
import type { EncryptedObjectMetadata } from "./encryptedObject";
import { downloadCurrentFile, migrateLegacyDeviceFileToEncrypted } from "./encryptedTransfers";
import { unlockVaultWithRecoveryKit, isVaultKeyPersisted, loadUnlockedVaultKey, lockVault } from "./vaultKey";
import { uploadFiles } from "./uploadFiles";
import RecoveryKitUnlockForm from "../../app/(protected)/_components/RecoveryKitUnlockForm";

type FetchCall = [RequestInfo | URL, RequestInit | undefined];
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalURL = globalThis.URL;
const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;
const VAULT_ID = "test-vault";
const VECTOR_VAULT_ID = "vector-vault";
const PASSPHRASE = "correct horse battery staple phrase";

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function recoveryKit(
  vmkHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  vaultId = VAULT_ID,
): string {
  const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const nonce = Buffer.from("ffeeddccbbaa998877665544", "hex");
  const saltEncoded = salt.toString("base64url");
  const aad = Buffer.from(`benzene-vmk-recovery\n1\n${vaultId}\nPBKDF2-HMAC-SHA-256\n600000\n${saltEncoded}\nAES-256-GCM`);
  const key = pbkdf2Sync(PASSPHRASE, salt, 600_000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const vmk = Buffer.from(vmkHex, "hex");
  const encrypted = Buffer.concat([cipher.update(vmk), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    format: "benzene-vmk-recovery", version: 1, vaultId,
    kdf: "PBKDF2-HMAC-SHA-256", iterations: 600_000, cipher: "AES-256-GCM",
    salt: saltEncoded, nonce: nonce.toString("base64url"), ciphertext: encrypted.toString("base64url"),
  });
}

function fileEntry(contents: string, name = "notes.txt"): FlatFile {
  return { file: new File([contents], name, { type: "text/plain" }), path: name };
}

function encryptedVector() {
  return JSON.parse(readFileSync(new URL("../../../../contracts/encrypted-object-v1/vectors.json", import.meta.url), "utf8")) as {
    metadata: EncryptedObjectMetadata;
    ciphertextBase64Url: string;
    vaultMasterKeyHex: string;
    plaintextBase64Url: string;
    storageHash: string;
  };
}

function installWindowTimers(): void {
  setGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
}

async function unlock(): Promise<void> {
  await unlockVaultWithRecoveryKit(VAULT_ID, recoveryKit(), PASSPHRASE);
}

afterEach(() => {
  setGlobal("fetch", originalFetch);
  setGlobal("document", originalDocument);
  setGlobal("URL", originalURL);
  setGlobal("window", originalWindow);
  setGlobal("WebSocket", originalWebSocket);
  lockVault(VAULT_ID);
  lockVault(VECTOR_VAULT_ID);
});

beforeEach(installWindowTimers);

describe("desktop and browser Vault key storage", () => {
  test("restores a desktop key from its Vault-scoped OS bridge after the page cache is cleared", async () => {
    const persisted = new Map<string, string>();
    setGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      benzeneDesktop: {
        async saveVaultKey(vaultId: string, keyHex: string) {
          const previous = persisted.get(vaultId);
          if (previous && previous !== keyHex) throw new Error("replacement denied");
          persisted.set(vaultId, keyHex);
          return true;
        },
        async loadVaultKey(vaultId: string) { return persisted.get(vaultId) ?? null; },
      },
    });

    assert.equal(await unlockVaultWithRecoveryKit(VAULT_ID, recoveryKit(), PASSPHRASE), true);
    assert.equal(isVaultKeyPersisted(VAULT_ID), true);
    assert.equal(persisted.size, 1);
    assert.equal(persisted.get(VAULT_ID), "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    lockVault(VAULT_ID);
    assert.deepEqual(await loadUnlockedVaultKey(VAULT_ID), Uint8Array.from({ length: 32 }, (_, index) => index));
  });

  test("keeps browser unlocks in memory and does not add persistent browser storage", async () => {
    assert.equal(await unlockVaultWithRecoveryKit(VAULT_ID, recoveryKit(), PASSPHRASE), false);
    assert.equal(isVaultKeyPersisted(VAULT_ID), false);
    assert.ok(await loadUnlockedVaultKey(VAULT_ID));
  });
});

describe("encrypted web upload orchestration", () => {
  test("reserves v1 metadata and PUTs only ciphertext with the scoped grant", async () => {
    await unlock();
    const calls: FetchCall[] = [];
    const fetchMock: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/files/uploads/device/v1/encrypted") {
        const request = JSON.parse(String(init?.body)) as { encryptedObject: { storageHash: string; plaintextSize: number } };
        assert.equal(request.encryptedObject.plaintextSize, 15);
        const data = {
          versionId: "version-1",
          storageHash: request.encryptedObject.storageHash,
          placement: {
            storageHash: request.encryptedObject.storageHash,
            shortfall: false,
            desiredReplicas: 1,
            alreadyHeldBy: [],
            targets: [{ deviceId: "device-a", deviceName: "Desk", url: `http://192.168.1.10:7070/objects/${request.encryptedObject.storageHash}`, grant: "grant-a", expiresAt: "2099-01-01T00:00:00.000Z" }],
          },
        };
        return Response.json({ data });
      }
      if (String(input).startsWith("http://192.168.1.10:7070/objects/")) return new Response(null, { status: 201 });
      if (input === "/api/files/uploads/device/v1/encrypted/complete") {
        return Response.json({ data: { completed: [{ nodeId: "node-1", shortfall: false, protection: { desiredReplicas: 1, healthyReplicas: 1 } }] } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    };
    setGlobal("fetch", fetchMock);

    const result = await uploadFiles("My Drive", VAULT_ID, [fileEntry("protected bytes")], []);

    assert.deepEqual(result, { uploaded: 1, bytes: 15, issues: [] });
    assert.equal(calls.length, 3);
    const reservation = JSON.parse(String(calls[0]?.[1]?.body)) as { name: string; path: string; encryptedObject: { storageHash: string } };
    assert.equal(calls[0]?.[0], "/api/files/uploads/device/v1/encrypted");
    assert.equal(reservation.name, "notes.txt");
    assert.equal(reservation.path, "My Drive/notes.txt");
    assert.equal(reservation.encryptedObject.storageHash.length, 64);
    const put = calls[1]?.[1];
    assert.equal(put?.method, "PUT");
    assert.deepEqual(put?.headers, { "X-Transfer-Grant": "grant-a", "Content-Type": "text/plain" });
    const bytes = new Uint8Array(await new Response(put?.body).arrayBuffer());
    assert.equal(bytes.byteLength, 15 + 16);
    assert.notDeepEqual(bytes, new TextEncoder().encode("protected bytes"));
    assert.equal(calls[2]?.[0], "/api/files/uploads/device/v1/encrypted/complete");
  });

  test("refuses to place plaintext when no recovery kit has been unlocked", async () => {
    const calls: FetchCall[] = [];
    setGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      throw new Error("No network request was expected");
    });

    await assert.rejects(uploadFiles("Vault", VAULT_ID, [fileEntry("secret")], []), /Import this Vault’s recovery kit/);
    assert.equal(calls.length, 0);
  });

  test("does not let another recovery kit replace a Vault key already unlocked in the tab", async () => {
    await unlock();
    const otherKit = recoveryKit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await assert.rejects(
      unlockVaultWithRecoveryKit(VAULT_ID, otherKit, PASSPHRASE),
      /different key is already unlocked/,
    );
  });

  test("rejects unsafe transfer URLs before sending a grant", async () => {
    await unlock();
    const calls: FetchCall[] = [];
    setGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      const request = JSON.parse(String(init?.body)) as { encryptedObject: { storageHash: string } };
      return Response.json({ data: {
        versionId: "version-unsafe",
        storageHash: request.encryptedObject.storageHash,
        placement: {
          storageHash: request.encryptedObject.storageHash,
          shortfall: false,
          desiredReplicas: 1,
          alreadyHeldBy: [],
          targets: [{ deviceId: "device-a", deviceName: "Desk", url: `http://10.1.2.3/objects/${request.encryptedObject.storageHash}?next=https://example.com`, grant: "grant", expiresAt: "2099-01-01T00:00:00.000Z" }],
        },
      } });
    });

    const result = await uploadFiles("Vault", VAULT_ID, [fileEntry("secret")], []);

    assert.equal(result.uploaded, 0);
    assert.match(result.issues.join(" "), /unsafe or expired storage-device target/);
    assert.equal(calls.length, 1);
  });

  test("does not commit when no device confirms ciphertext possession", async () => {
    await unlock();
    const calls: FetchCall[] = [];
    setGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/files/uploads/device/v1/encrypted") {
        const request = JSON.parse(String(init?.body)) as { encryptedObject: { storageHash: string } };
        return Response.json({ data: { versionId: "pending", storageHash: request.encryptedObject.storageHash, placement: { storageHash: request.encryptedObject.storageHash, shortfall: false, desiredReplicas: 1, alreadyHeldBy: [], targets: [{ deviceId: "device-a", deviceName: "Desk", url: `http://192.168.1.10/objects/${request.encryptedObject.storageHash}`, grant: "grant", expiresAt: "2099-01-01T00:00:00.000Z" }] } } });
      }
      if (String(input).startsWith("http://192.168.1.10/objects/")) return new Response(JSON.stringify({ code: "POSSESSION_UNCONFIRMED" }), { status: 503 });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const result = await uploadFiles("Vault", VAULT_ID, [fileEntry("pending")], []);
    assert.equal(result.uploaded, 0);
    assert.ok(result.issues.some((issue) => issue.includes("not confirmed on any device")));
    assert.equal(calls.some(([url]) => String(url).includes("/complete")), false);
  });

  test("copies a hash-verified legacy device object into a new encrypted version", async () => {
    await unlockVaultWithRecoveryKit(VECTOR_VAULT_ID, recoveryKit(encryptedVector().vaultMasterKeyHex, VECTOR_VAULT_ID), PASSPHRASE);
    const sourceBytes = Buffer.from("old readable file");
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const calls: FetchCall[] = [];
    const fetchMock: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === `/api/placement/download-targets/${sourceHash}`) {
        return Response.json({ data: { targets: [{ deviceId: "old-device", deviceName: "Old Mac", url: `http://192.168.1.10/objects/${sourceHash}`, grant: "legacy-read-grant", expiresAt: "2099-01-01T00:00:00.000Z" }] } });
      }
      if (input === `http://192.168.1.10/objects/${sourceHash}`) {
        return new Response(sourceBytes, { status: 200, headers: { "content-length": String(sourceBytes.byteLength) } });
      }
      if (input === "/api/files/uploads/device/v1/encrypted") {
        const request = JSON.parse(String(init?.body)) as { encryptedObject: { storageHash: string }; migrationSource: { versionId: string; objectHash: string } };
        assert.deepEqual(request.migrationSource, { versionId: "legacy-version-id", objectHash: sourceHash });
        return Response.json({ data: {
          versionId: "new-version-id",
          storageHash: request.encryptedObject.storageHash,
          placement: {
            storageHash: request.encryptedObject.storageHash,
            shortfall: false,
            desiredReplicas: 1,
            alreadyHeldBy: [],
            targets: [{ deviceId: "new-device", deviceName: "New Mac", url: `http://192.168.1.11/objects/${request.encryptedObject.storageHash}`, grant: "encrypted-write-grant", expiresAt: "2099-01-01T00:00:00.000Z" }],
          },
        } });
      }
      if (String(input).startsWith("http://192.168.1.11/objects/")) {
        assert.equal(init?.method, "PUT");
        const stored = new Uint8Array(await new Response(init?.body).arrayBuffer());
        assert.equal(stored.byteLength, sourceBytes.byteLength + 16);
        assert.notDeepEqual(stored, sourceBytes);
        return new Response(null, { status: 201 });
      }
      if (input === "/api/files/uploads/device/v1/encrypted/complete") {
        return Response.json({ data: { completed: [{ nodeId: "node-id", shortfall: false, protection: { desiredReplicas: 1, healthyReplicas: 1 } }] } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    };
    setGlobal("fetch", fetchMock);

    const result = await migrateLegacyDeviceFileToEncrypted(
      sourceHash, "legacy-version-id", "old.txt", "docs/", "text/plain", VECTOR_VAULT_ID,
    );

    assert.deepEqual(result, { bytes: sourceBytes.byteLength, issues: [] });
    assert.equal(calls[0]?.[0], `/api/placement/download-targets/${sourceHash}`);
    assert.equal(new Headers(calls[1]?.[1]?.headers).get("X-Transfer-Grant"), "legacy-read-grant");
  });

  test("does not encrypt a legacy object whose downloaded bytes fail the source hash", async () => {
    await unlockVaultWithRecoveryKit(VECTOR_VAULT_ID, recoveryKit(encryptedVector().vaultMasterKeyHex, VECTOR_VAULT_ID), PASSPHRASE);
    const sourceHash = createHash("sha256").update("expected source").digest("hex");
    const calls: FetchCall[] = [];
    setGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === `/api/placement/download-targets/${sourceHash}`) {
        return Response.json({ data: { targets: [{ deviceId: "old-device", deviceName: "Old Mac", url: `http://192.168.1.10/objects/${sourceHash}`, grant: "legacy-read-grant", expiresAt: "2099-01-01T00:00:00.000Z" }] } });
      }
      if (input === `http://192.168.1.10/objects/${sourceHash}`) {
        return new Response("wrong bytes", { status: 200, headers: { "content-length": "11" } });
      }
      throw new Error(`No reservation should be created: ${String(input)}`);
    });

    await assert.rejects(
      migrateLegacyDeviceFileToEncrypted(sourceHash, "legacy-version-id", "old.txt", "", "text/plain", VECTOR_VAULT_ID),
      /hash-verified copy/,
    );
    assert.equal(calls.length, 2);
  });

  test("downloads encrypted bytes with a scoped read grant and exports only authenticated plaintext", async () => {
    const vector = encryptedVector();
    await unlockVaultWithRecoveryKit(VECTOR_VAULT_ID, recoveryKit(vector.vaultMasterKeyHex, VECTOR_VAULT_ID), PASSPHRASE);
    const ciphertext = Buffer.from(vector.ciphertextBase64Url, "base64url");
    const calls: FetchCall[] = [];
    const fetchMock: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/files/abcdef0123456789abcdef01/encrypted-object") return Response.json({ data: { encryptedObject: vector.metadata } });
      if (input === `/api/placement/download-targets/${vector.storageHash}`) {
        return Response.json({ data: { targets: [{ deviceId: "device-a", deviceName: "Desk", url: `http://192.168.1.10/objects/${vector.storageHash}`, grant: "read-grant", expiresAt: "2099-01-01T00:00:00.000Z" }] } });
      }
      if (input === `http://192.168.1.10/objects/${vector.storageHash}` && init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(ciphertext.byteLength) } });
      if (input === `http://192.168.1.10/objects/${vector.storageHash}`) return new Response(Uint8Array.from(ciphertext).buffer, { status: 200, headers: { "content-length": String(ciphertext.byteLength) } });
      throw new Error(`Unexpected request: ${String(input)}`);
    };
    setGlobal("fetch", fetchMock);
    const exportState: { text?: string; clicks: number } = { clicks: 0 };
    const anchor = { href: "", download: "", click: () => { exportState.clicks += 1; }, remove: () => undefined };
    setGlobal("document", { createElement: () => anchor, body: { appendChild: () => undefined } });
    class DownloadURL extends (originalURL as typeof URL) {
      static createObjectURL(blob: Blob): string {
        void blob.text().then((text) => { exportState.text = text; });
        return "blob:decrypted";
      }
      static revokeObjectURL(): void {}
    }
    setGlobal("URL", DownloadURL);
    setGlobal("window", { setTimeout: () => 1, clearTimeout: () => undefined });

    const legacy = await downloadCurrentFile("abcdef0123456789abcdef01", vector.storageHash, "notes.txt", VECTOR_VAULT_ID);

    assert.equal(legacy, false);
    assert.equal(calls.length, 4);
    assert.equal(calls[2]?.[1]?.method, "HEAD");
    assert.equal(new Headers(calls[2]?.[1]?.headers).get("X-Transfer-Grant"), "read-grant");
    assert.equal(new Headers(calls[3]?.[1]?.headers).get("X-Transfer-Grant"), "read-grant");
    assert.equal(anchor.download, "notes.txt");
    assert.equal(exportState.clicks, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(exportState.text, Buffer.from(vector.plaintextBase64Url, "base64url").toString());
  });

  test("requests relay only after direct reads fail and exports authenticated relay plaintext", async () => {
    const vector = encryptedVector();
    await unlockVaultWithRecoveryKit(VECTOR_VAULT_ID, recoveryKit(vector.vaultMasterKeyHex, VECTOR_VAULT_ID), PASSPHRASE);
    const ciphertext = Buffer.from(vector.ciphertextBase64Url, "base64url");
    const expiry = Math.floor(Date.now() / 1000) + 120;
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const scope = {
      v: 1, sessionId, storageHash: vector.storageHash,
      deviceId: "123e4567-e89b-42d3-a456-426614174001", op: "get", exp: expiry,
      maxBytes: ciphertext.byteLength, role: "client", ticketId: "123e4567-e89b-42d3-a456-426614174002",
    };
    const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
    const fallback = {
      kind: "relay_fallback", relayUrl: "wss://relay.example.test", sessionId,
      ticket: `${base64Url(new TextEncoder().encode(JSON.stringify(scope)))}.${base64Url(new Uint8Array(64).fill(1))}`,
      storageHash: vector.storageHash, ciphertextBytes: ciphertext.byteLength,
      expiresAt: new Date(expiry * 1000).toISOString(),
    };
    const calls: FetchCall[] = [];
    const fetchMock: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/files/abcdef0123456789abcdef01/encrypted-object") return Response.json({ data: { encryptedObject: vector.metadata } });
      if (input === `/api/placement/download-targets/${vector.storageHash}`) {
        return Response.json({ data: { targets: [{ deviceId: "device-a", deviceName: "Desk", url: `http://192.168.1.10/objects/${vector.storageHash}`, grant: "read-grant", expiresAt: "2099-01-01T00:00:00.000Z" }] } });
      }
      if (input === `http://192.168.1.10/objects/${vector.storageHash}` && init?.method === "HEAD") return new Response(null, { status: 503 });
      if (input === "/api/placement/relay-read") return Response.json({ data: fallback }, { status: 201 });
      throw new Error(`Unexpected request: ${String(input)}`);
    };
    setGlobal("fetch", fetchMock);

    class RelaySocket {
      readyState = 1;
      binaryType = "";
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      constructor(url: string) {
        assert.equal(url, `wss://relay.example.test/relay/${sessionId}`);
        queueMicrotask(() => this.onopen?.({}));
      }
      send(message: string) {
        assert.deepEqual(JSON.parse(message), { type: "authenticate", ticket: fallback.ticket });
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: "paired" }) });
          this.onmessage?.({ data: Uint8Array.from(ciphertext).buffer });
          this.readyState = 3;
          this.onclose?.({ code: 1000, reason: "transfer_complete" });
        });
      }
      close() { this.readyState = 3; }
    }
    setGlobal("WebSocket", RelaySocket);
    const exportState: { text?: string; clicks: number } = { clicks: 0 };
    const anchor = { href: "", download: "", click: () => { exportState.clicks += 1; }, remove: () => undefined };
    setGlobal("document", { createElement: () => anchor, body: { appendChild: () => undefined } });
    class DownloadURL extends (originalURL as typeof URL) {
      static createObjectURL(blob: Blob): string {
        void blob.text().then((text) => { exportState.text = text; });
        return "blob:decrypted";
      }
      static revokeObjectURL(): void {}
    }
    setGlobal("URL", DownloadURL);

    const legacy = await downloadCurrentFile("abcdef0123456789abcdef01", vector.storageHash, "notes.txt", VECTOR_VAULT_ID);

    assert.equal(legacy, false);
    assert.equal(calls.findIndex(([url]) => url === "/api/placement/relay-read") > calls.findIndex(([url]) => String(url).startsWith("http://192.168.1.10/")), true);
    assert.equal(anchor.download, "notes.txt");
    assert.equal(exportState.clicks, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(exportState.text, Buffer.from(vector.plaintextBase64Url, "base64url").toString());
  });

  test("rejects oversized and mismatched ciphertext before exporting", async () => {
    const vector = encryptedVector();
    await unlockVaultWithRecoveryKit(VECTOR_VAULT_ID, recoveryKit(vector.vaultMasterKeyHex, VECTOR_VAULT_ID), PASSPHRASE);
    const expectedLength = vector.metadata.plaintextSize + 16;
    for (const scenario of ["head-mismatch", "oversized-header", "oversized-body", "mismatched-body"] as const) {
      const calls: FetchCall[] = [];
      let exports = 0;
      setGlobal("URL", originalURL);
      setGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([input, init]);
        if (input === "/api/files/abcdef0123456789abcdef01/encrypted-object") return Response.json({ data: { encryptedObject: vector.metadata } });
        if (input === `/api/placement/download-targets/${vector.storageHash}`) {
          return Response.json({ data: { targets: [{ deviceId: "device-a", deviceName: "Desk", url: `http://192.168.1.2/objects/${vector.storageHash}`, grant: "read-grant", expiresAt: "2099-01-01T00:00:00.000Z" }] } });
        }
        if (input === `http://192.168.1.2/objects/${vector.storageHash}` && init?.method === "HEAD") {
          const length = scenario === "head-mismatch" ? expectedLength + 1 : expectedLength;
          return Response.json(null, { status: 200, headers: { "content-length": String(length) } });
        }
        if (input === `http://192.168.1.2/objects/${vector.storageHash}`) {
          const length = scenario === "oversized-header" ? expectedLength + 1 : expectedLength;
          const bodyLength = scenario === "oversized-body" ? expectedLength + 1 : scenario === "mismatched-body" ? expectedLength - 1 : expectedLength;
          return new Response(new Uint8Array(bodyLength).buffer, { status: 200, headers: { "content-length": String(length) } });
        }
        if (input === "/api/placement/relay-read") return new Response(null, { status: 409 });
        throw new Error(`Unexpected request: ${String(input)}`);
      });
      setGlobal("document", { createElement: () => ({ click: () => { exports += 1; }, remove: () => undefined }), body: { appendChild: () => undefined } });

      await assert.rejects(downloadCurrentFile("abcdef0123456789abcdef01", vector.storageHash, "notes.txt", VECTOR_VAULT_ID), /No online encrypted copy/);
      assert.equal(exports, 0, `${scenario} must not export plaintext`);
      assert.equal(calls.length, scenario === "head-mismatch" ? 4 : 5);
    }
  });
});

test("recovery kit entry uses an accessible password field without a browser prompt", () => {
  const markup = renderToStaticMarkup(createElement(RecoveryKitUnlockForm, { vaultId: "vault-1", onUnlocked: () => undefined }));
  assert.match(markup, /<label[^>]*for="vault-recovery-passphrase"[^>]*>Recovery passphrase<\/label>/);
  assert.match(markup, /type="password"/);
  assert.match(markup, /type="file"/);
  const componentSource = readFileSync(new URL("../../app/(protected)/_components/RecoveryKitUnlockForm.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(componentSource, /window\.prompt/);
  assert.match(componentSource, /Verify saved recovery kit/);
  assert.match(componentSource, /unlockVaultWithRecoveryKit\(vaultId, await submittedFile\.text\(\), submittedPassphrase\)/);
  assert.doesNotMatch(componentSource, /acknowledgeRecoveryKitSaved/);
});
