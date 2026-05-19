import { strFromU8, strToU8, unzipSync, zipSync, type ZipOptions, type Zippable } from 'fflate';

type ZipCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface BundleZipEntry {
  path: string;
  data: Uint8Array | string;
  level?: ZipCompressionLevel;
}

export interface BundleZipReadOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export interface BundleZipReadResult {
  entries: Map<string, Uint8Array>;
  totalBytes: number;
}

const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function isBlobLike(value: unknown): value is { arrayBuffer: () => Promise<ArrayBuffer> } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  );
}

function copyToLocalBytes(bytes: Uint8Array): Uint8Array {
  const local = new Uint8Array(bytes.byteLength);
  local.set(bytes);
  return local;
}

async function bytesFromBlobLike(value: { arrayBuffer: () => Promise<ArrayBuffer> }) {
  const buffer = await value.arrayBuffer();
  return copyToLocalBytes(new Uint8Array(buffer));
}

function bytesFromBufferLike(value: unknown): Uint8Array | null {
  if (!value || typeof value !== 'object') return null;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return copyToLocalBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  const candidate = value as { byteLength?: unknown; slice?: unknown };
  if (typeof candidate.byteLength === 'number' && typeof candidate.slice === 'function') {
    return copyToLocalBytes(new Uint8Array(value as ArrayBuffer));
  }
  return null;
}

export function validateBundleZipPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error(`Unsafe bundle ZIP path: ${path}`);
  }
  return normalized;
}

export function createBundleZip(entries: BundleZipEntry[]): Uint8Array {
  const payload: Zippable = {};
  for (const entry of entries) {
    const path = validateBundleZipPath(entry.path);
    const options: ZipOptions = { level: entry.level ?? 6 };
    payload[path] = [typeof entry.data === 'string' ? strToU8(entry.data) : entry.data, options];
  }
  return zipSync(payload);
}

export async function readBundleZip(
  data: Blob | ArrayBuffer | Uint8Array,
  options: BundleZipReadOptions = {},
): Promise<BundleZipReadResult> {
  const bytes = isBlobLike(data) ? await bytesFromBlobLike(data) : bytesFromBufferLike(data);
  if (!bytes) {
    throw new Error('Bundle ZIP input must be a File, Blob, ArrayBuffer, or Uint8Array.');
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const unzipped = unzipSync(bytes);
  const entries = new Map<string, Uint8Array>();
  let totalBytes = 0;

  for (const [rawPath, entryBytes] of Object.entries(unzipped)) {
    if (entries.size >= maxEntries) {
      throw new Error(`Bundle ZIP exceeds ${maxEntries} entries.`);
    }
    const path = validateBundleZipPath(rawPath);
    if (entryBytes.byteLength > maxEntryBytes) {
      throw new Error(`Bundle ZIP entry exceeds limit: ${path}`);
    }
    totalBytes += entryBytes.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Bundle ZIP exceeds ${maxTotalBytes} bytes after decompression.`);
    }
    entries.set(path, copyToLocalBytes(entryBytes));
  }

  return { entries, totalBytes };
}

export function decodeBundleTextEntry(entries: Map<string, Uint8Array>, path: string): string {
  const bytes = entries.get(path);
  if (!bytes) {
    throw new Error(`Missing bundle ZIP entry: ${path}`);
  }
  return strFromU8(bytes);
}
