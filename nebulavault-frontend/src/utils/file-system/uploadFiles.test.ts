import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlatFile } from "@/types/FileFolderBuffer";
import type { EncryptedObjectMetadata } from "./encryptedObject";
import { downloadCurrentFile } from "./encryptedTransfers";
import { unlockVaultWithRecoveryKit, lockVault } from "./vaultKey";
import { uploadFiles } from "./uploadFiles";
import RecoveryKitUnlockForm from "../../app/(protected)/_components/RecoveryKitUnlockForm";

type FetchCall = [RequestInfo | URL, RequestInit | undefined];
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalURL = globalThis.URL;
const originalWindow = globalThis.window;
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
  lockVault(VAULT_ID);
  lockVault(VECTOR_VAULT_ID);
});

beforeEach(installWindowTimers);

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

  test("downloads encrypted bytes with a scoped read grant and exports only authenticated plaintext", async () => {
    const vector = encryptedVector();
    await unlockVaultWithRecoveryKit(VECTOR_VAULT_ID, recoveryKit(vector.vaultMasterKeyHex, VECTOR_VAULT_ID), PASSPHRASE);
    const ciphertext = Buffer.from(vector.ciphertextBase64Url, "base64url");
    const calls: FetchCall[] = [];
    const fetchMock: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/files/node-1/encrypted-object") return Response.json({ data: { encryptedObject: vector.metadata } });
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

    const legacy = await downloadCurrentFile("node-1", vector.storageHash, "notes.txt", VECTOR_VAULT_ID);

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
        if (input === "/api/files/node-1/encrypted-object") return Response.json({ data: { encryptedObject: vector.metadata } });
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
        throw new Error(`Unexpected request: ${String(input)}`);
      });
      setGlobal("document", { createElement: () => ({ click: () => { exports += 1; }, remove: () => undefined }), body: { appendChild: () => undefined } });

      await assert.rejects(downloadCurrentFile("node-1", vector.storageHash, "notes.txt", VECTOR_VAULT_ID), /authenticated copy/);
      assert.equal(exports, 0, `${scenario} must not export plaintext`);
      assert.equal(calls.length, scenario === "head-mismatch" ? 3 : 4);
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
});
