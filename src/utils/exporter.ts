import logger from './logger';

const STREAM_EXPORT_ROW_DELAY_KEY = 'twe_stream_export_row_delay_ms_v1';

/**
 * Supported formats of exporting.
 */
export const EXPORT_FORMAT = {
  JSON: 'JSON',
  HTML: 'HTML',
  CSV: 'CSV',
} as const;

export type ExportFormatType = (typeof EXPORT_FORMAT)[keyof typeof EXPORT_FORMAT];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataType = Record<string, any>;

/**
 * Escape characters for CSV file.
 */
export function csvEscapeStr(str: string) {
  return `"${str.replace(/"/g, '""').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/**
 * Save a text file to disk.
 */
export function saveFile(filename: string, content: string | Blob, prependBOM: boolean = false) {
  const link = document.createElement('a');
  let blob: Blob;

  if (content instanceof Blob) {
    blob = content;
  } else {
    blob = new Blob(prependBOM ? [new Uint8Array([0xef, 0xbb, 0xbf]), content] : [content], {
      type: 'text/plain;charset=utf-8',
    });
  }

  const url = URL.createObjectURL(blob);

  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Export data and download as a file.
 *
 * @param data Data list to export.
 * @param format Export format. (JSON, HTML, CSV)
 * @param filename Filename to save.
 * @param translations Translations for headers.
 */
export async function exportData(
  data: DataType[],
  format: ExportFormatType,
  filename: string,
  translations: Record<string, string>,
) {
  try {
    let content = '';
    let prependBOM = false;
    logger.info(`Exporting to ${format} file: ${filename}`);

    switch (format) {
      case EXPORT_FORMAT.JSON:
        content = await jsonExporter(data);
        break;
      case EXPORT_FORMAT.HTML:
        content = await htmlExporter(data, translations);
        break;
      case EXPORT_FORMAT.CSV:
        prependBOM = true;
        content = await csvExporter(data);
        break;
    }
    saveFile(filename, content, prependBOM);
  } catch (err) {
    logger.errorWithBanner('Failed to export file', err as Error);
  }
}

type StreamExportOptions = {
  onProgress?: (processed: number) => void;
  signal?: AbortSignal;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringifyCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function readDiagnosticStreamExportRowDelayMs(): number {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(STREAM_EXPORT_ROW_DELAY_KEY);
    const value = Number(raw || 0);
    return Number.isFinite(value) && value > 0 ? Math.min(1000, value) : 0;
  } catch {
    return 0;
  }
}

async function waitForDiagnosticStreamExportRowDelay(delayMs: number): Promise<void> {
  if (!delayMs) return;
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

export async function exportDataFromAsyncRows(
  rows: AsyncIterable<DataType>,
  format: ExportFormatType,
  filename: string,
  translations: Record<string, string>,
  options: StreamExportOptions = {},
) {
  try {
    logger.info(`Streaming export to ${format} file: ${filename}`);
    let processed = 0;
    let headers: string[] = [];
    const chunks: string[] = [];
    const diagnosticRowDelayMs = readDiagnosticStreamExportRowDelayMs();
    const updateProgress = () => {
      processed += 1;
      options.onProgress?.(processed);
    };

    if (format === EXPORT_FORMAT.JSON) {
      chunks.push('[\n');
      let first = true;
      for await (const row of rows) {
        if (options.signal?.aborted) return;
        chunks.push(first ? '' : ',\n');
        chunks.push(JSON.stringify(row, undefined, '  ').replace(/^/gm, '  '));
        first = false;
        updateProgress();
        await waitForDiagnosticStreamExportRowDelay(diagnosticRowDelayMs);
      }
      chunks.push('\n]\n');
      saveFile(filename, new Blob(chunks, { type: 'application/json;charset=utf-8' }));
      return;
    }

    if (format === EXPORT_FORMAT.CSV) {
      let wroteHeader = false;
      for await (const row of rows) {
        if (options.signal?.aborted) return;
        if (!wroteHeader) {
          headers = Object.keys(row);
          chunks.push(headers.join(',') + '\n');
          wroteHeader = true;
        }
        chunks.push(
          headers
            .map((header) => {
              const value = row[header];
              return typeof value === 'object'
                ? csvEscapeStr(JSON.stringify(value))
                : csvEscapeStr(stringifyCellValue(value));
            })
            .join(',') + '\n',
        );
        updateProgress();
        await waitForDiagnosticStreamExportRowDelay(diagnosticRowDelayMs);
      }
      saveFile(
        filename,
        new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), ...chunks], {
          type: 'text/csv;charset=utf-8',
        }),
      );
      return;
    }

    chunks.push(`
    <html>
      <head>
        <meta charset="utf-8">
        <title>Exported Data ${new Date().toISOString()}</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
      </head>
      <body>
        <table class="table table-striped">
`);
    let wroteHeader = false;
    for await (const row of rows) {
      if (options.signal?.aborted) return;
      if (!wroteHeader) {
        headers = Object.keys(row);
        chunks.push('<thead><tr>');
        for (const header of headers) {
          chunks.push(`<th>${escapeHtml(translations[header] ?? header)}</th>`);
        }
        chunks.push('</tr></thead><tbody>');
        wroteHeader = true;
      }
      chunks.push('<tr>');
      for (const header of headers) {
        chunks.push(`<td>${escapeHtml(stringifyCellValue(row[header]))}</td>`);
      }
      chunks.push('</tr>');
      updateProgress();
      await waitForDiagnosticStreamExportRowDelay(diagnosticRowDelayMs);
    }
    chunks.push(`
          </tbody>
        </table>
      </body>
    </html>
`);
    saveFile(filename, new Blob(chunks, { type: 'text/html;charset=utf-8' }));
  } catch (err) {
    logger.errorWithBanner('Failed to stream export file', err as Error);
  }
}

export async function jsonExporter(data: DataType[]) {
  return JSON.stringify(data, undefined, '  ');
}

export async function htmlExporter(data: DataType[], translations: Record<string, string>) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');

  // The keys of the first row are translated and used as headers.
  const exportKeys = Object.keys(data[0] ?? {});
  const headerRow = document.createElement('tr');
  for (const exportKey of exportKeys) {
    const th = document.createElement('th');
    th.textContent = translations[exportKey] ?? exportKey;
    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);
  table.className = 'table table-striped';

  for (const row of data) {
    const tr = document.createElement('tr');
    for (const exportKey of exportKeys) {
      const td = document.createElement('td');
      const value = row[exportKey];

      if (exportKey === 'profile_image_url' || exportKey === 'profile_banner_url') {
        const img = document.createElement('img');
        img.src = value;
        img.width = 50;
        td.innerHTML = '';
        td.appendChild(img);
      } else if (exportKey === 'media') {
        if (value?.length > 0) {
          for (const media of value) {
            const img = document.createElement('img');
            img.src = media.thumbnail;
            img.width = 50;
            img.alt = media.ext_alt_text || '';
            img.title = media.ext_alt_text || '';
            const link = document.createElement('a');
            link.href = media.original;
            link.target = '_blank';
            link.style.marginRight = '0.5em';
            link.appendChild(img);
            td.appendChild(link);
          }
        }
      } else if (exportKey === 'full_text' || exportKey === 'description') {
        const p = document.createElement('p');
        p.textContent = typeof value === 'string' ? value : JSON.stringify(value);
        p.style.whiteSpace = 'pre-wrap';
        p.style.maxWidth = '640px';
        td.appendChild(p);
      } else if (exportKey === 'metadata') {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Expand';
        details.appendChild(summary);
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(value, undefined, '  ');
        details.appendChild(pre);
        td.appendChild(details);
      } else if (exportKey === 'url') {
        const link = document.createElement('a');
        link.href = value;
        link.target = '_blank';
        link.textContent = value;
        td.appendChild(link);
      } else {
        td.textContent = typeof value === 'string' ? value : JSON.stringify(row[exportKey]);
      }

      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);

  return `
    <html>
      <head>
        <meta charset="utf-8">
        <title>Exported Data ${new Date().toISOString()}</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
      </head>
      <body>
        ${table.outerHTML}
      </body>
    </html>
  `;
}

export async function csvExporter(data: DataType[]) {
  const headers = Object.keys(data[0] ?? {});
  let content = headers.join(',') + '\n';

  for (const row of data) {
    const values = headers.map((header) => {
      const value = row[header];
      if (typeof value === 'string') {
        return csvEscapeStr(value);
      }

      if (typeof value === 'object') {
        return csvEscapeStr(JSON.stringify(value));
      }

      return value;
    });
    content += values.join(',');
    content += '\n';
  }

  return content;
}
