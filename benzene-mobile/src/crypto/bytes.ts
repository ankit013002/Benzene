const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64_ALPHABET[first >> 2];
    output += BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) output += BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)];
    if (third !== undefined) output += BASE64_ALPHABET[third & 63];
  }
  return output.replace(/\+/g, '-').replace(/\//g, '_');
}

export function decodeBase64Url(value: string, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${field} must be canonical unpadded base64url`);
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const output = new Uint8Array(Math.floor((normalized.length * 3) / 4));
  let outputIndex = 0;
  for (let index = 0; index < normalized.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(normalized[index] ?? '');
    const b = BASE64_ALPHABET.indexOf(normalized[index + 1] ?? '');
    const c = BASE64_ALPHABET.indexOf(normalized[index + 2] ?? '');
    const d = BASE64_ALPHABET.indexOf(normalized[index + 3] ?? '');
    if (a < 0 || b < 0 || (index + 2 < normalized.length && c < 0) || (index + 3 < normalized.length && d < 0)) {
      throw new TypeError(`${field} must be canonical unpadded base64url`);
    }
    output[outputIndex++] = (a << 2) | (b >> 4);
    if (index + 2 < normalized.length) output[outputIndex++] = ((b & 15) << 4) | (c >> 2);
    if (index + 3 < normalized.length) output[outputIndex++] = ((c & 3) << 6) | d;
  }
  const decoded = output.subarray(0, outputIndex);
  if (encodeBase64Url(decoded) !== value) throw new TypeError(`${field} must be canonical unpadded base64url`);
  return decoded;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(value: string, field: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})*$/.test(value)) throw new TypeError(`${field} must be lowercase hex`);
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
