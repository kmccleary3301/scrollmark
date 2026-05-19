import { saveAs } from 'file-saver-es';
import logger from './logger';

export type FileLike = { filename: string; url: string; type?: string };
export type BlobFileLike = { filename: string; blob: Blob };

export type ProgressCallback<T = unknown> = (current: number, total: number, value?: T) => void;

export type ZipStreamDownloadOptions = {
  minDelayBetweenStartsMs?: number;
  globalConcurrency?: number;
  perHostConcurrency?: number;
  videoConcurrency?: number;
  maxRetries?: number;
  onZipProgress?: ProgressCallback<BlobFileLike>;
};

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;

let crc32TableCache: Uint32Array | null = null;

function getCrc32Table(): Uint32Array {
  if (crc32TableCache) return crc32TableCache;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crc32TableCache = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrc32Table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosTime(date: Date): number {
  const seconds = Math.floor(date.getSeconds() / 2);
  return ((date.getHours() << 11) | (date.getMinutes() << 5) | seconds) & 0xffff;
}

function toDosDate(date: Date): number {
  const year = Math.max(1980, date.getFullYear());
  return (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
}

function buildLocalFileHeader(
  nameBytes: Uint8Array,
  crc: number,
  size: number,
  dosTime: number,
  dosDate: number,
): Uint8Array {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(0, ZIP_LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_UTF8_FLAG, true);
  view.setUint16(8, 0, true); // store (no compression)
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true); // extra length
  header.set(nameBytes, 30);
  return header;
}

function buildCentralFileHeader(
  nameBytes: Uint8Array,
  crc: number,
  size: number,
  dosTime: number,
  dosDate: number,
  localHeaderOffset: number,
): Uint8Array {
  const header = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(0, ZIP_CENTRAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true); // version made by
  view.setUint16(6, ZIP_VERSION, true); // version needed
  view.setUint16(8, ZIP_UTF8_FLAG, true);
  view.setUint16(10, 0, true); // store
  view.setUint16(12, dosTime, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true); // extra length
  view.setUint16(32, 0, true); // comment length
  view.setUint16(34, 0, true); // disk number
  view.setUint16(36, 0, true); // internal attrs
  view.setUint32(38, 0, true); // external attrs
  view.setUint32(42, localHeaderOffset, true);
  header.set(nameBytes, 46);
  return header;
}

function buildEndOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
) {
  const footer = new Uint8Array(22);
  const view = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
  view.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 0, true); // disk number
  view.setUint16(6, 0, true); // central directory disk
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true); // comment length
  return footer;
}

function toBlobPart(bytes: Uint8Array): BlobPart {
  return toOwnedArrayBuffer(bytes);
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function isVideoLike(file: FileLike) {
  return (
    file.type === 'video' || file.type === 'animated_gif' || /\.mp4(?:[?#].*)?$/i.test(file.url)
  );
}

function hostForUrl(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function normalizeDownloadOptions(
  optionsOrRateLimit?: ZipStreamDownloadOptions | number,
): Required<Omit<ZipStreamDownloadOptions, 'onZipProgress'>> {
  if (typeof optionsOrRateLimit === 'number') {
    return {
      minDelayBetweenStartsMs: Math.max(0, optionsOrRateLimit),
      globalConcurrency: 1,
      perHostConcurrency: 1,
      videoConcurrency: 1,
      maxRetries: 0,
    };
  }

  const options = optionsOrRateLimit || {};
  return {
    minDelayBetweenStartsMs: Math.max(0, options.minDelayBetweenStartsMs ?? 100),
    globalConcurrency: Math.max(1, Math.min(32, options.globalConcurrency ?? 8)),
    perHostConcurrency: Math.max(1, Math.min(32, options.perHostConcurrency ?? 8)),
    videoConcurrency: Math.max(1, Math.min(16, options.videoConcurrency ?? 3)),
    maxRetries: Math.max(0, Math.min(8, options.maxRetries ?? 3)),
  };
}

function retryDelayMs(attempt: number) {
  const base = Math.min(30_000, 750 * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(base * jitter);
}

async function fetchBlobWithRetry(file: FileLike, maxRetries: number): Promise<Blob> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(file.url);
      if (!response.ok) {
        const error = new Error(`Failed to fetch ${file.url}: HTTP ${response.status}`);
        if (response.status === 403 || response.status === 404) {
          throw error;
        }
        lastError = error;
      } else {
        return await response.blob();
      }
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP (403|404)/.test(message)) {
        throw error;
      }
    }

    if (attempt < maxRetries) {
      await sleep(retryDelayMs(attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${file.url}`);
}

/**
 * Download multiple files from URL and save as a zip archive.
 *
 * @see https://github.com/jimmywarting/StreamSaver.js/issues/106
 * @param zipFilename Name of the zip archive file
 * @param files List of files to download
 * @param onProgress Callback function to track progress
 * @param rateLimit The minimum time gap between two downloads (in milliseconds)
 */
export async function zipStreamDownload(
  zipFilename: string,
  files: FileLike[],
  onProgress?: ProgressCallback<FileLike>,
  optionsOrRateLimit?: ZipStreamDownloadOptions | number,
) {
  const options = normalizeDownloadOptions(optionsOrRateLimit);
  const blobFiles = new Array<BlobFileLike | undefined>(files.length);
  const total = files.length;
  let nextIndex = 0;
  let completed = 0;
  let lastStartAt = 0;
  let activeGlobal = 0;
  let activeVideo = 0;
  const activeByHost = new Map<string, number>();

  const acquireStartSlot = async (file: FileLike) => {
    const host = hostForUrl(file.url);
    const video = isVideoLike(file);

    while (true) {
      const hostActive = activeByHost.get(host) || 0;
      const elapsed = Date.now() - lastStartAt;
      if (
        activeGlobal < options.globalConcurrency &&
        hostActive < options.perHostConcurrency &&
        (!video || activeVideo < options.videoConcurrency) &&
        elapsed >= options.minDelayBetweenStartsMs
      ) {
        activeGlobal += 1;
        if (video) activeVideo += 1;
        activeByHost.set(host, hostActive + 1);
        lastStartAt = Date.now();
        return () => {
          activeGlobal -= 1;
          if (video) activeVideo -= 1;
          const currentHostActive = activeByHost.get(host) || 1;
          if (currentHostActive <= 1) {
            activeByHost.delete(host);
          } else {
            activeByHost.set(host, currentHostActive - 1);
          }
        };
      }

      await sleep(Math.max(25, Math.min(100, options.minDelayBetweenStartsMs - elapsed)));
    }
  };

  const worker = async () => {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      const file = files[index];
      if (!file) continue;

      const release = await acquireStartSlot(file);
      const start = Date.now();
      try {
        logger.debug(`Start downloading ${file.filename} from ${file.url}`);
        blobFiles[index] = {
          filename: file.filename,
          blob: await fetchBlobWithRetry(file, options.maxRetries),
        };
        completed += 1;
        onProgress?.(completed, total, file);
        logger.debug(`Finished downloading ${file.filename} in ${Date.now() - start}ms`);
      } finally {
        release();
      }
    }
  };

  const workerCount = Math.min(options.globalConcurrency, files.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  await zipBlobFiles(
    zipFilename,
    blobFiles.filter((file): file is BlobFileLike => !!file),
    typeof optionsOrRateLimit === 'object' ? optionsOrRateLimit.onZipProgress : undefined,
  );
}

/**
 * Save in-memory blobs as a zip archive.
 */
export async function zipBlobFiles(
  zipFilename: string,
  files: BlobFileLike[],
  onProgress?: ProgressCallback<BlobFileLike>,
): Promise<Blob> {
  logger.info(`Exporting to ZIP file: ${zipFilename}`);

  const now = new Date();
  const dosTime = toDosTime(now);
  const dosDate = toDosDate(now);

  const zipParts: BlobPart[] = [];
  const centralParts: Uint8Array[] = [];
  let currentOffset = 0;
  let centralSize = 0;
  const textEncoder = new TextEncoder();

  const total = files.length;
  for (const [index, file] of files.entries()) {
    const { filename, blob } = file;
    const nameBytes = textEncoder.encode(filename);
    const data = new Uint8Array(await blob.arrayBuffer());
    const dataCrc = crc32(data);
    const size = data.byteLength;

    const localHeaderOffset = currentOffset;
    const localHeader = buildLocalFileHeader(nameBytes, dataCrc, size, dosTime, dosDate);
    zipParts.push(toBlobPart(localHeader), toBlobPart(data));
    currentOffset += localHeader.byteLength + data.byteLength;

    const centralHeader = buildCentralFileHeader(
      nameBytes,
      dataCrc,
      size,
      dosTime,
      dosDate,
      localHeaderOffset,
    );
    centralParts.push(centralHeader);
    centralSize += centralHeader.byteLength;
    onProgress?.(index + 1, total, file);

    if (index % 4 === 3) {
      await nextFrame();
    }
  }

  for (const centralPart of centralParts) {
    zipParts.push(toBlobPart(centralPart));
  }
  const footer = buildEndOfCentralDirectory(files.length, centralSize, currentOffset);
  zipParts.push(toBlobPart(footer));

  const blob = new Blob(zipParts, { type: 'application/zip' });

  logger.info('Zip stream closed.');
  saveAs(blob, zipFilename);
  return blob;
}
