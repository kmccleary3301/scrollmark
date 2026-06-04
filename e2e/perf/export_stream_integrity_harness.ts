import fs from 'node:fs';
import path from 'node:path';

const [, , outPathArg = 'e2e/perf/out/export-stream-integrity.json'] = process.argv;
const outPath = path.resolve(outPathArg);

type DataType = Record<string, unknown>;

type Download = {
  filename: string;
  blob: Blob;
};

const downloads: Download[] = [];
const blobsByUrl = new Map<string, Blob>();
let nextBlobUrl = 0;

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

function installDownloadMocks() {
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout,
    clearTimeout,
    dispatchEvent: () => true,
  };
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tagName: string) => {
      if (tagName !== 'a') {
        throw new Error(`Unexpected element ${tagName}`);
      }
      return {
        href: '',
        download: '',
        click() {
          const blob = blobsByUrl.get(this.href);
          if (!blob) throw new Error(`Missing blob for ${this.href}`);
          downloads.push({ filename: this.download, blob });
        },
      };
    },
  };
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:mock-${nextBlobUrl++}`;
    blobsByUrl.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    blobsByUrl.delete(url);
  };
}

function restoreDownloadMocks() {
  (globalThis as unknown as { document: unknown }).document = originalDocument;
  (globalThis as unknown as { window: unknown }).window = originalWindow;
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
}

async function* rows(count: number): AsyncIterable<DataType> {
  for (let index = 0; index < count; index += 1) {
    yield {
      id: `row-${index}`,
      text: index === 1 ? 'comma, quote " newline\n html <tag>' : `plain ${index}`,
      count: index,
      nested: { value: index },
    };
  }
}

async function blobText(download: Download | undefined): Promise<string> {
  if (!download) return '';
  return await download.blob.text();
}

installDownloadMocks();
try {
  const { EXPORT_FORMAT, exportDataFromAsyncRows } = await import('@/utils/exporter');

  await exportDataFromAsyncRows(rows(3), EXPORT_FORMAT.JSON, 'rows.json', {});
  await exportDataFromAsyncRows(rows(3), EXPORT_FORMAT.CSV, 'rows.csv', {});
  await exportDataFromAsyncRows(rows(2), EXPORT_FORMAT.HTML, 'rows.html', {
    id: 'Identifier',
    text: 'Text',
    count: 'Count',
    nested: 'Nested',
  });

  const beforeCancelDownloads = downloads.length;
  const abortController = new AbortController();
  await exportDataFromAsyncRows(
    rows(5),
    EXPORT_FORMAT.JSON,
    'cancelled.json',
    {},
    {
      signal: abortController.signal,
      onProgress: (processed) => {
        if (processed === 2) {
          abortController.abort();
        }
      },
    },
  );

  const jsonText = await blobText(downloads.find((download) => download.filename === 'rows.json'));
  const csvText = await blobText(downloads.find((download) => download.filename === 'rows.csv'));
  const htmlText = await blobText(downloads.find((download) => download.filename === 'rows.html'));
  const parsedJson = JSON.parse(jsonText) as DataType[];
  const completedFilenames = downloads
    .map((download) => download.filename)
    .sort()
    .join(',');

  const checks = [
    {
      name: 'streamed JSON exports all rows in order',
      ok:
        parsedJson.length === 3 &&
        parsedJson.map((row) => row.id).join(',') === 'row-0,row-1,row-2',
      details: { ids: parsedJson.map((row) => row.id) },
    },
    {
      name: 'streamed CSV escapes commas, quotes, newlines, and objects',
      ok:
        csvText.includes('"comma, quote "" newline\\n html <tag>"') &&
        csvText.includes('"{""value"":1}"'),
      details: { csvText },
    },
    {
      name: 'streamed HTML escapes cell content and uses translated headers',
      ok:
        htmlText.includes('<th>Identifier</th>') &&
        htmlText.includes('html &lt;tag&gt;') &&
        !htmlText.includes('html <tag>'),
      details: { htmlText },
    },
    {
      name: 'stream cancellation prevents partial file download',
      ok: downloads.length === beforeCancelDownloads,
      details: {
        beforeCancelDownloads,
        afterCancelDownloads: downloads.length,
      },
    },
    {
      name: 'streamed exports create one file per completed format',
      ok: completedFilenames === 'rows.csv,rows.html,rows.json',
      details: { filenames: downloads.map((download) => download.filename) },
    },
  ];

  const payload = {
    ok: checks.every((check) => check.ok),
    checks,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
} finally {
  restoreDownloadMocks();
}
