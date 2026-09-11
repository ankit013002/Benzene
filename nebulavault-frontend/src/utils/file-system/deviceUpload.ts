/**
 * Uploading to the user's own devices.
 *
 * The browser hashes the file, asks the control plane where it should live, and
 * PUTs the bytes straight to those devices. Bytes never pass through Next.js,
 * the gateway or the control plane — those only decide and authorise.
 */

export interface UploadTarget {
  deviceId: string;
  deviceName: string;
  url: string;
  grant: string;
  expiresAt: string;
}

/**
 * SHA-256 of the file, computed in the browser.
 *
 * Content addressing needs the hash *before* placement, so this necessarily
 * happens client-side. `crypto.subtle` requires the whole buffer in memory,
 * which is fine for ordinary files and is the reason chunking exists in the
 * architecture — a 40 GB video will need a streaming hash over chunks.
 */
export async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function messageFrom(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message !== "") {
      return payload.message;
    }
  } catch {
    // Non-JSON body.
  }
  return fallback;
}

/** Fetches an object back from whichever device holds it. */
export async function downloadFromDevices(
  objectHash: string,
  filename: string
): Promise<void> {
  const res = await fetch(
    `/api/placement/download-targets/${encodeURIComponent(objectHash)}`
  );
  if (!res.ok) {
    throw new Error(await messageFrom(res, "Could not find this file on your devices"));
  }

  const { targets } = ((await res.json()) as { data: { targets: UploadTarget[] } }).data;
  if (targets.length === 0) {
    throw new Error("None of the devices holding this file are reachable right now");
  }

  // Try each holder in turn: the first may be asleep or on another network.
  for (const target of targets) {
    try {
      const objectRes = await fetch(target.url, {
        headers: { "X-Transfer-Grant": target.grant },
      });
      if (!objectRes.ok) continue;

      const blob = await objectRes.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Let the browser start the download before releasing the Blob URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    } catch {
      // Unreachable device; fall through to the next holder.
    }
  }

  throw new Error("None of the devices holding this file could be reached");
}
