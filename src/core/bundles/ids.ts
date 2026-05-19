const FALLBACK_HASH_MOD = 0x100000000;

function fallbackHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;

  if (globalThis.crypto?.subtle) {
    const digestInput = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // Non-crypto fallback for test-like runtimes without Web Crypto.
  let accumulator = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    accumulator += fallbackHash(String.fromCharCode(...bytes.slice(offset, offset + 4096)));
  }
  return fallbackHash(`${bytes.length}:${accumulator}:${FALLBACK_HASH_MOD}`);
}

export async function createBundleId(seed: string): Promise<string> {
  return `bundle_${(await sha256Hex(seed)).slice(0, 24)}`;
}

export async function createBundleRecordId(bundleId: string, kind: string, sourceId: string) {
  return `record_${(await sha256Hex(`${bundleId}:${kind}:${sourceId}`)).slice(0, 32)}`;
}
