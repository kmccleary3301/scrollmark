#!/usr/bin/env node
/* global process, console, window, document, URL, Document */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/export-memory-app.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const EXPORT_COUNT = Math.max(1, Number(process.env.SCROLLMARK_EXPORT_MEMORY_COUNT || 100_000));

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Export Memory Harness</title></head>
  <body><main id="host-page">host page</main></body>
</html>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(html);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate HTTP port'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}/?scrollmarkSyntheticDb=1` });
    });
  });
}

function summarizePerfEvents(events) {
  const valuesFor = (kind, name) =>
    events
      .filter((entry) => entry?.kind === kind && entry?.name === name)
      .map((entry) => Number(entry?.value || 0));
  const maxValue = (kind, name) => {
    const values = valuesFor(kind, name);
    return values.length ? Math.max(...values) : 0;
  };
  return {
    maxHydratedRecords: maxValue('viewer', 'table-hydrated-records'),
    maxSearchDocuments: maxValue('viewer', 'table-search-documents'),
    maxResultIds: maxValue('viewer', 'table-result-ids'),
    maxRecordLookupIds: maxValue('viewer', 'table-record-lookup-ids'),
    exportStarts: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'modal-export-start',
    ),
    exportCancels: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'modal-export-cancel',
    ),
    bundleBatchSends: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-batch-sent',
    ),
    bundleCancels: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-cancel',
    ),
    tableHydrationEvents: events.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'table-hydrated-records',
    ),
    tableSearchDocumentEvents: events.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'table-search-documents',
    ),
  };
}

async function installApp(page, url, errors, consoleMessages) {
  page.on('pageerror', (error) => {
    errors.push(error?.stack || error?.message || String(error));
  });
  page.on('console', (message) => {
    const text = message.text();
    consoleMessages.push({ type: message.type(), text });
    if (
      message.type() === 'error' &&
      !text.includes('suppressed global error') &&
      !text.includes('Failed to load resource:')
    ) {
      errors.push(text);
    }
  });
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith(url.replace(/\?.*$/, ''))) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 204, body: '' });
  });

  await page.addInitScript(() => {
    window.__META_DATA__ = { userId: 'export-memory-harness' };
    window.unsafeWindow = window;
    window.localStorage.setItem('twe_enable_synthetic_db_tools_v1', '1');
    window.localStorage.setItem(
      'scrollmark',
      JSON.stringify({
        showControlPanel: true,
        safeMode: true,
        hookMode: 'off',
        repairMode: 'off',
        debug: false,
      }),
    );
    window.localStorage.setItem('twe_stream_export_row_delay_ms_v1', '20');
    window.localStorage.setItem('twe_bundle_export_batch_delay_ms_v1', '120');

    window.__scrollmarkRecordedDownloads = [];
    const blobsByUrl = new Map();
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const originalCreateElement = Document.prototype.createElement;

    URL.createObjectURL = (blob) => {
      const createdUrl = originalCreateObjectURL(blob);
      blobsByUrl.set(createdUrl, blob);
      return createdUrl;
    };
    URL.revokeObjectURL = (createdUrl) => {
      window.setTimeout(() => blobsByUrl.delete(createdUrl), 0);
      return originalRevokeObjectURL(createdUrl);
    };
    Document.prototype.createElement = function createElement(tagName, options) {
      const element = originalCreateElement.call(this, tagName, options);
      if (String(tagName).toLowerCase() !== 'a') return element;
      const originalClick = element.click.bind(element);
      element.click = function click() {
        const blob = blobsByUrl.get(this.href);
        if (blob && this.download) {
          window.__scrollmarkRecordedDownloads.push({
            filename: this.download,
            size: blob.size,
            type: blob.type,
          });
          return;
        }
        return originalClick();
      };
      return element;
    };
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: userscriptPath });
  await page.waitForSelector('#twe-root', { state: 'attached', timeout: 10_000 });
  await page.waitForFunction(() => {
    return typeof window.__scrollmarkSyntheticDb?.seedBookmarks === 'function';
  });
}

async function openBookmarksTable(page, count) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(`Captured: ${expected}`),
    count,
    { timeout: 180_000 },
  );
  const bookmarksPanel = page.locator('.module-panel').filter({ hasText: 'Bookmarks' }).first();
  await bookmarksPanel.locator('button').click();
  await page.waitForSelector('dialog.modal-open', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('Synthetic bookmark'),
    );
    return Boolean(dialog);
  });
}

async function openExportModal(page) {
  const tableModal = page
    .locator('dialog.modal-open')
    .filter({ hasText: 'Synthetic bookmark' })
    .first();
  await tableModal.getByRole('button', { name: 'Export Data' }).click();
  const exportModal = page.locator('dialog.modal-open').filter({ hasText: 'Data length:' }).last();
  await exportModal.waitFor({ state: 'visible', timeout: 10_000 });
  return exportModal;
}

async function recordedDownloadCount(page) {
  return await page.evaluate(() =>
    Array.isArray(window.__scrollmarkRecordedDownloads)
      ? window.__scrollmarkRecordedDownloads.length
      : 0,
  );
}

async function getPerfEvents(page) {
  return await page.evaluate(() => {
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    return events.map((entry) => ({
      kind: entry?.kind,
      name: entry?.name,
      value: entry?.value,
      durationMs: entry?.durationMs,
      tags: entry?.tags,
    }));
  });
}

const errors = [];
const consoleMessages = [];
const { server, url } = await createServer();
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installApp(page, url, errors, consoleMessages);

  const seed = await page.evaluate(async (count) => {
    return await window.__scrollmarkSyntheticDb.seedBookmarks({
      count,
      userCount: 200,
      folderDistribution: 'none',
      rawRecordMode: 'source-window',
      includeSearchDocuments: false,
      clearFirst: true,
    });
  }, EXPORT_COUNT);

  await openBookmarksTable(page, EXPORT_COUNT);
  const tableModal = page
    .locator('dialog.modal-open')
    .filter({ hasText: 'Synthetic bookmark' })
    .first();
  const initialRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();
  const tableSummary = await tableModal
    .locator('.font-mono')
    .filter({ hasText: 'rendered' })
    .last()
    .textContent();

  const downloadsBeforeJson = await recordedDownloadCount(page);
  const jsonModal = await openExportModal(page);
  await jsonModal.getByRole('button', { name: 'Start Export' }).click();
  await page.waitForFunction(
    (expectedTotal) => {
      const text = Array.from(document.querySelectorAll('dialog.modal-open'))
        .map((dialog) => dialog.textContent || '')
        .join('\n');
      return new RegExp(`[1-9][0-9]*/${expectedTotal}`).test(text);
    },
    EXPORT_COUNT,
    { timeout: 30_000 },
  );
  await jsonModal.getByRole('button', { name: 'Cancel Export' }).click();
  await page.waitForFunction(() => {
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    return events.some(
      (entry) => entry?.kind === 'export' && entry?.name === 'modal-export-cancel',
    );
  });
  await page.waitForTimeout(300);
  const downloadsAfterJson = await recordedDownloadCount(page);
  await jsonModal.getByRole('button', { name: 'Cancel' }).click();

  const downloadsBeforeBundle = await recordedDownloadCount(page);
  const batchSendsBeforeBundle = await page.evaluate(() => {
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    return events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-batch-sent',
    ).length;
  });
  const bundleModal = await openExportModal(page);
  await bundleModal.locator('select').nth(1).selectOption('0');
  await bundleModal.getByRole('button', { name: 'Export Bundle ZIP' }).click();
  await page.waitForFunction(
    (previousBatchCount) => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return (
        events.filter(
          (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-batch-sent',
        ).length > previousBatchCount
      );
    },
    batchSendsBeforeBundle,
    { timeout: 30_000 },
  );
  await bundleModal.getByRole('button', { name: 'Cancel Export' }).click();
  await page.waitForFunction(() => {
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    return events.some(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-cancel',
    );
  });
  await page.waitForTimeout(300);
  const downloadsAfterBundle = await recordedDownloadCount(page);
  await bundleModal.getByRole('button', { name: 'Cancel' }).click();

  const perfEvents = await getPerfEvents(page);
  const perfSummary = summarizePerfEvents(perfEvents);
  const diagnostics = await page.evaluate(() => {
    const map = window.__scrollmark_result_source_diagnostics_v1;
    if (!(map instanceof Map)) return [];
    return Array.from(map.values()).map((entry) => ({
      mode: entry?.mode,
      totalCount: Number(entry?.totalCount || 0),
      cachedRows: Number(entry?.cachedRows || 0),
      cachedPages: Number(entry?.cachedPages || 0),
      sourceKey: String(entry?.sourceKey || ''),
    }));
  });
  const maxDiagnosticCachedRows = diagnostics.length
    ? Math.max(...diagnostics.map((entry) => Number(entry.cachedRows || 0)))
    : 0;

  const checks = [
    {
      name: '100k source-window export fixture seeds without full raw tweet storage',
      ok:
        seed?.ok === true &&
        seed?.tweetCount === EXPORT_COUNT &&
        seed?.rawRecordMode === 'source-window' &&
        seed?.includeSearchDocuments === false &&
        Number(seed?.storedTweetCount || 0) < EXPORT_COUNT,
      details: seed,
    },
    {
      name: 'Bookmarks table opens against the 100k descriptor-backed source',
      ok:
        initialRows > 0 &&
        initialRows <= 120 &&
        typeof tableSummary === 'string' &&
        tableSummary.includes(`/${EXPORT_COUNT}`),
      details: { initialRows, tableSummary },
    },
    {
      name: '100k JSON result-set export starts from the descriptor and cancels without download',
      ok:
        downloadsAfterJson === downloadsBeforeJson &&
        perfSummary.exportStarts.some(
          (entry) =>
            Number(entry?.value || 0) === EXPORT_COUNT &&
            entry?.tags?.scope === 'result_set' &&
            entry?.tags?.streaming === true,
        ) &&
        perfSummary.exportCancels.some(
          (entry) =>
            Number(entry?.value || 0) > 0 &&
            Number(entry?.value || 0) < EXPORT_COUNT &&
            entry?.tags?.scope === 'result_set' &&
            entry?.tags?.streaming === true,
        ),
      details: {
        downloadsBeforeJson,
        downloadsAfterJson,
        exportStarts: perfSummary.exportStarts,
        exportCancels: perfSummary.exportCancels,
      },
    },
    {
      name: '100k bundle export sends bounded worker batches and cancels without ZIP download',
      ok:
        downloadsAfterBundle === downloadsBeforeBundle &&
        perfSummary.bundleBatchSends.some(
          (entry) =>
            Number(entry?.value || 0) > 0 &&
            Number(entry?.value || 0) <= 100 &&
            Number(entry?.tags?.totalRecords || 0) === EXPORT_COUNT,
        ) &&
        perfSummary.bundleBatchSends.every((entry) => Number(entry?.value || 0) <= 100) &&
        perfSummary.bundleCancels.some(
          (entry) => Number(entry?.value || 0) > 0 && Number(entry?.value || 0) < EXPORT_COUNT,
        ),
      details: {
        downloadsBeforeBundle,
        downloadsAfterBundle,
        bundleBatchSends: perfSummary.bundleBatchSends,
        bundleCancels: perfSummary.bundleCancels,
      },
    },
    {
      name: '100k export start/cancel keeps UI table state bounded',
      ok:
        perfSummary.maxHydratedRecords <= 160 &&
        perfSummary.maxSearchDocuments === 0 &&
        perfSummary.maxResultIds <= 160 &&
        perfSummary.maxRecordLookupIds <= 500 &&
        maxDiagnosticCachedRows <= 1600,
      details: { ...perfSummary, maxDiagnosticCachedRows, diagnostics },
    },
    {
      name: 'export memory app harness has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const report = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    count: EXPORT_COUNT,
    checks,
    diagnostics,
    consoleMessages: consoleMessages.slice(-120),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
