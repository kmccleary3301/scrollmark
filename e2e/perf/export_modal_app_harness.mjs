#!/usr/bin/env node
/* global process, console, window, document, URL, Document */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/export-modal-app.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const EXPORT_COUNT = Math.max(1, Number(process.env.SCROLLMARK_EXPORT_MODAL_COUNT || 1200));

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Export Modal Harness</title></head>
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
    maxRecordLookupIds: maxValue('viewer', 'table-record-lookup-ids'),
    recordLookupEvents: events.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'table-record-lookup-ids',
    ),
    exportStarts: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'modal-export-start',
    ),
    exportCompletes: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'modal-export-complete',
    ),
    exportCancels: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'modal-export-cancel',
    ),
    arrayExportRows: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'modal-array-export-rows',
    ),
    bundleBatchSends: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-batch-sent',
    ),
    bundleStreamCompletes: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-stream-complete',
    ),
    bundleCompletes: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-complete',
    ),
    bundleCancels: events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-cancel',
    ),
    selectionExceptionToggles: events.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'selection-all-exception-toggle',
    ),
  };
}

async function readDownloads(page) {
  return await page.evaluate(() => {
    const downloads = Array.isArray(window.__scrollmarkRecordedDownloads)
      ? window.__scrollmarkRecordedDownloads
      : [];
    return downloads.map((download) => ({
      filename: download.filename,
      size: Number(download.size || 0),
      type: String(download.type || ''),
      text: typeof download.text === 'string' ? download.text : null,
    }));
  });
}

async function waitForDownload(page, count, extension, needsText = false) {
  await page.waitForFunction(
    ({ expectedCount, expectedExtension, requireText }) => {
      const downloads = Array.isArray(window.__scrollmarkRecordedDownloads)
        ? window.__scrollmarkRecordedDownloads
        : [];
      if (downloads.length < expectedCount) return false;
      const latest = downloads[expectedCount - 1];
      if (!String(latest?.filename || '').endsWith(expectedExtension)) return false;
      return !requireText || typeof latest.text === 'string';
    },
    { expectedCount: count, expectedExtension: extension, requireText: needsText },
    { timeout: 60_000 },
  );
  const downloads = await readDownloads(page);
  return downloads[count - 1];
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
    window.__META_DATA__ = { userId: 'export-modal-harness' };
    window.unsafeWindow = window;
    window.__twe_allow_continuity_local_fallback_v1 = true;
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

    window.__scrollmarkRecordedDownloads = [];
    const blobsByUrl = new Map();
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const originalCreateElement = Document.prototype.createElement;

    URL.createObjectURL = (blob) => {
      const url = originalCreateObjectURL(blob);
      blobsByUrl.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.setTimeout(() => blobsByUrl.delete(url), 0);
      return originalRevokeObjectURL(url);
    };
    Document.prototype.createElement = function createElement(tagName, options) {
      const element = originalCreateElement.call(this, tagName, options);
      if (String(tagName).toLowerCase() !== 'a') {
        return element;
      }
      const originalClick = element.click.bind(element);
      element.click = function click() {
        const blob = blobsByUrl.get(this.href);
        if (blob && this.download) {
          const record = {
            filename: this.download,
            size: blob.size,
            type: blob.type,
            text: null,
          };
          window.__scrollmarkRecordedDownloads.push(record);
          if (!String(this.download).endsWith('.zip')) {
            void blob.text().then((text) => {
              record.text = text;
            });
          }
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
    { timeout: 120_000 },
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
      userCount: Math.min(200, Math.max(20, Math.floor(count / 10))),
      folderDistribution: 'mixed',
      clearFirst: true,
    });
  }, EXPORT_COUNT);
  await openBookmarksTable(page, EXPORT_COUNT);

  const tableModal = page
    .locator('dialog.modal-open')
    .filter({ hasText: 'Synthetic bookmark' })
    .first();
  const initialRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();
  await tableModal.locator('thead th').nth(1).click();
  await page.waitForTimeout(150);
  const summaryAfterSourceSortClick = await tableModal
    .locator('.font-mono')
    .filter({ hasText: 'rendered' })
    .last()
    .textContent();

  const allExportModal = await openExportModal(page);
  const companionExportDisabledWithoutPairing = await allExportModal
    .getByRole('button', { name: 'Export Companion Namespace' })
    .isDisabled();
  await allExportModal.getByRole('button', { name: 'Start Export' }).click();
  const allDownload = await waitForDownload(page, 1, '.json', true);
  const allRows = JSON.parse(allDownload.text);
  await allExportModal.getByRole('button', { name: 'Cancel' }).click();

  const rowCheckboxes = tableModal.locator('tbody input[type="checkbox"]');
  const firstAllRowId = Array.isArray(allRows) ? String(allRows[0]?.id || '') : '';
  await rowCheckboxes.nth(0).uncheck();
  await page.waitForFunction((expectedSelected) => {
    const text = Array.from(document.querySelectorAll('dialog.modal-open'))
      .map((dialog) => dialog.textContent || '')
      .join('\n');
    return text.includes(`selected ${expectedSelected} (all)`);
  }, EXPORT_COUNT - 1);

  const allMinusOneExportModal = await openExportModal(page);
  await allMinusOneExportModal.getByText('All current results').click();
  await allMinusOneExportModal.getByRole('button', { name: 'Start Export' }).click();
  const allMinusOneDownload = await waitForDownload(page, 2, '.json', true);
  const allMinusOneRows = JSON.parse(allMinusOneDownload.text);
  await allMinusOneExportModal.getByRole('button', { name: 'Cancel' }).click();

  const headerCheckbox = tableModal.locator('thead input[type="checkbox"]').first();
  await headerCheckbox.check();
  await page.waitForFunction((expectedSelected) => {
    const text = Array.from(document.querySelectorAll('dialog.modal-open'))
      .map((dialog) => dialog.textContent || '')
      .join('\n');
    return text.includes(`selected ${expectedSelected} (all)`);
  }, EXPORT_COUNT);
  await headerCheckbox.uncheck();
  await page.waitForFunction(() => {
    const text = Array.from(document.querySelectorAll('dialog.modal-open'))
      .map((dialog) => dialog.textContent || '')
      .join('\n');
    return text.includes('selected 0 (explicit)');
  });

  await rowCheckboxes.nth(0).check();
  await rowCheckboxes.nth(1).check();
  await page.waitForFunction(() => {
    const text = Array.from(document.querySelectorAll('dialog.modal-open'))
      .map((dialog) => dialog.textContent || '')
      .join('\n');
    return text.includes('selected 2 (explicit)');
  });

  const selectedExportModal = await openExportModal(page);
  await selectedExportModal.getByRole('button', { name: 'Start Export' }).click();
  const selectedDownload = await waitForDownload(page, 3, '.json', true);
  const selectedRows = JSON.parse(selectedDownload.text);
  await selectedExportModal.getByRole('button', { name: 'Cancel' }).click();

  const bundleExportModal = await openExportModal(page);
  await bundleExportModal.getByText('All current results').click();
  await bundleExportModal.locator('select').nth(1).selectOption('0');
  const bundleMetadataCheckbox = bundleExportModal.getByRole('checkbox', {
    name: 'Include original record metadata in bundle:',
  });
  const bundleMetadataCheckedByDefault = await bundleMetadataCheckbox.isChecked();
  await bundleMetadataCheckbox.check();
  const bundleMetadataStoredAfterOptIn = await page.evaluate(() => {
    const stored = JSON.parse(window.localStorage.getItem('scrollmark') || '{}');
    return stored.bundleIncludeOriginalMetadata;
  });
  await bundleMetadataCheckbox.uncheck();
  const bundleMetadataStoredAfterOptOut = await page.evaluate(() => {
    const stored = JSON.parse(window.localStorage.getItem('scrollmark') || '{}');
    return stored.bundleIncludeOriginalMetadata;
  });
  await bundleExportModal.getByRole('button', { name: 'Export Bundle ZIP' }).click();
  const bundleDownload = await waitForDownload(page, 4, '.zip', false);
  await bundleExportModal.getByRole('button', { name: 'Cancel' }).click();

  const downloadsBeforeCancel = (await readDownloads(page)).length;
  const batchSendsBeforeCancel = await page.evaluate(() => {
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    return events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-batch-sent',
    ).length;
  });
  await page.evaluate(() => {
    window.localStorage.setItem('twe_bundle_export_batch_delay_ms_v1', '200');
  });
  const cancellableBundleModal = await openExportModal(page);
  await cancellableBundleModal.getByText('All current results').click();
  await cancellableBundleModal.locator('select').nth(1).selectOption('0');
  await cancellableBundleModal.getByRole('button', { name: 'Export Bundle ZIP' }).click();
  await page.waitForFunction(
    (previousBatchCount) => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return (
        events.filter(
          (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-batch-sent',
        ).length > previousBatchCount
      );
    },
    batchSendsBeforeCancel,
    { timeout: 30_000 },
  );
  await cancellableBundleModal.getByRole('button', { name: 'Cancel Export' }).click();
  await page.waitForFunction(
    () => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return events.some(
        (entry) => entry?.kind === 'export' && entry?.name === 'bundle-worker-cancel',
      );
    },
    null,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.localStorage.removeItem('twe_bundle_export_batch_delay_ms_v1');
  });
  const downloadsAfterCancel = (await readDownloads(page)).length;
  await cancellableBundleModal.getByRole('button', { name: 'Cancel' }).click();

  const downloadsBeforeStreamCancel = (await readDownloads(page)).length;
  await page.evaluate(() => {
    window.localStorage.setItem('twe_stream_export_row_delay_ms_v1', '50');
  });
  const cancellableStreamExportModal = await openExportModal(page);
  await cancellableStreamExportModal.getByText('All current results').click();
  await cancellableStreamExportModal.getByRole('button', { name: 'Start Export' }).click();
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
  await cancellableStreamExportModal.getByRole('button', { name: 'Cancel Export' }).click();
  await page.waitForFunction(
    () => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return events.some(
        (entry) => entry?.kind === 'export' && entry?.name === 'modal-export-cancel',
      );
    },
    null,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.localStorage.removeItem('twe_stream_export_row_delay_ms_v1');
  });
  const downloadsAfterStreamCancel = (await readDownloads(page)).length;
  await cancellableStreamExportModal.getByRole('button', { name: 'Cancel' }).click();

  const perfEvents = await page.evaluate(() => {
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    return events.map((entry) => ({
      kind: entry?.kind,
      name: entry?.name,
      value: entry?.value,
      durationMs: entry?.durationMs,
      tags: entry?.tags,
    }));
  });
  const perfSummary = summarizePerfEvents(perfEvents);
  const diagnostics = await page.evaluate(() => {
    const map = window.__scrollmark_result_source_diagnostics_v1;
    if (!(map instanceof Map)) return [];
    return Array.from(map.values()).map((entry) => ({
      mode: entry?.mode,
      totalCount: Number(entry?.totalCount || 0),
      cachedRows: Number(entry?.cachedRows || 0),
      sourceKey: String(entry?.sourceKey || ''),
    }));
  });
  const maxDiagnosticCachedRows = diagnostics.length
    ? Math.max(...diagnostics.map((entry) => Number(entry.cachedRows || 0)))
    : 0;

  const checks = [
    {
      name: 'synthetic app runtime seeds export fixture through the actual DB layer',
      ok: seed?.ok === true && seed?.tweetCount === EXPORT_COUNT,
      details: seed,
    },
    {
      name: 'Bookmarks table opens with bounded visible rows before export',
      ok: initialRows > 0 && initialRows <= 120,
      details: { initialRows },
    },
    {
      name: 'source-backed column sort click does not sort only the visible window',
      ok:
        typeof summaryAfterSourceSortClick === 'string' &&
        summaryAfterSourceSortClick.includes(`/${EXPORT_COUNT}`),
      details: { summaryAfterSourceSortClick },
    },
    {
      name: 'canonical companion namespace export is visible and disabled without pairing',
      ok: companionExportDisabledWithoutPairing,
      details: { companionExportDisabledWithoutPairing },
    },
    {
      name: 'all-results JSON export streams from the active source and preserves row count',
      ok:
        Array.isArray(allRows) &&
        allRows.length === EXPORT_COUNT &&
        allDownload.filename.includes('results') &&
        perfSummary.exportCompletes.some(
          (entry) => Number(entry?.value || 0) === EXPORT_COUNT && entry?.tags?.streaming === true,
        ),
      details: {
        filename: allDownload.filename,
        exportedRows: Array.isArray(allRows) ? allRows.length : null,
        exportCompletes: perfSummary.exportCompletes,
      },
    },
    {
      name: 'explicit selected JSON export streams through the selection source adapter',
      ok:
        Array.isArray(selectedRows) &&
        selectedRows.length === 2 &&
        selectedDownload.filename.includes('selected') &&
        perfSummary.exportStarts.some(
          (entry) =>
            Number(entry?.value || 0) === 2 &&
            entry?.tags?.scope === 'selected' &&
            entry?.tags?.streaming === true,
        ) &&
        perfSummary.exportCompletes.some(
          (entry) =>
            Number(entry?.value || 0) === 2 &&
            entry?.tags?.scope === 'selected' &&
            entry?.tags?.streaming === true,
        ) &&
        !perfSummary.arrayExportRows.some((entry) => entry?.tags?.scope === 'selected'),
      details: {
        filename: selectedDownload.filename,
        selectedRows: Array.isArray(selectedRows) ? selectedRows.length : null,
        exportStarts: perfSummary.exportStarts,
        exportCompletes: perfSummary.exportCompletes,
        arrayExportRows: perfSummary.arrayExportRows,
      },
    },
    {
      name: 'all-mode row deselection remains descriptor-backed and exports all-minus-exceptions',
      ok:
        Array.isArray(allMinusOneRows) &&
        allMinusOneRows.length === EXPORT_COUNT - 1 &&
        firstAllRowId.length > 0 &&
        !allMinusOneRows.some((row) => String(row?.id || '') === firstAllRowId) &&
        perfSummary.exportCompletes.some(
          (entry) =>
            Number(entry?.value || 0) === EXPORT_COUNT - 1 &&
            entry?.tags?.scope === 'result_set' &&
            entry?.tags?.streaming === true &&
            Number(entry?.tags?.excluded || 0) === 1,
        ) &&
        perfSummary.selectionExceptionToggles.some((entry) => Number(entry?.value || 0) === 1),
      details: {
        filename: allMinusOneDownload.filename,
        firstAllRowId,
        exportedRows: Array.isArray(allMinusOneRows) ? allMinusOneRows.length : null,
        exportCompletes: perfSummary.exportCompletes,
        selectionExceptionToggles: perfSummary.selectionExceptionToggles,
      },
    },
    {
      name: 'bundle original metadata is explicit, off by default, and persisted',
      ok:
        bundleMetadataCheckedByDefault === false &&
        bundleMetadataStoredAfterOptIn === true &&
        bundleMetadataStoredAfterOptOut === false,
      details: {
        bundleMetadataCheckedByDefault,
        bundleMetadataStoredAfterOptIn,
        bundleMetadataStoredAfterOptOut,
      },
    },
    {
      name: 'bundle ZIP export streams bounded batches to the worker',
      ok:
        bundleDownload.filename.endsWith('.zip') &&
        bundleDownload.size > 0 &&
        perfSummary.bundleBatchSends.length > 1 &&
        perfSummary.bundleBatchSends.every((entry) => Number(entry?.value || 0) <= 100) &&
        perfSummary.bundleStreamCompletes.some(
          (entry) => Number(entry?.value || 0) === EXPORT_COUNT,
        ) &&
        perfSummary.bundleCompletes.some(
          (entry) =>
            Number(entry?.value || 0) > 0 &&
            Number(entry?.tags?.records || 0) === EXPORT_COUNT &&
            Number(entry?.tags?.sentRows || 0) === EXPORT_COUNT,
        ),
      details: {
        filename: bundleDownload.filename,
        size: bundleDownload.size,
        bundleBatchSends: perfSummary.bundleBatchSends,
        bundleStreamCompletes: perfSummary.bundleStreamCompletes,
        bundleCompletes: perfSummary.bundleCompletes,
      },
    },
    {
      name: 'bundle ZIP cancellation stops the worker stream without saving a partial ZIP',
      ok:
        downloadsAfterCancel === downloadsBeforeCancel &&
        perfSummary.bundleCancels.some(
          (entry) => Number(entry?.value || 0) > 0 && Number(entry?.value || 0) < EXPORT_COUNT,
        ),
      details: {
        downloadsBeforeCancel,
        downloadsAfterCancel,
        bundleCancels: perfSummary.bundleCancels,
      },
    },
    {
      name: 'streamed JSON export cancellation stops the modal source stream without saving a partial file',
      ok:
        downloadsAfterStreamCancel === downloadsBeforeStreamCancel &&
        perfSummary.exportCancels.some(
          (entry) =>
            entry?.tags?.format === 'JSON' &&
            entry?.tags?.streaming === true &&
            Number(entry?.value || 0) > 0 &&
            Number(entry?.value || 0) < EXPORT_COUNT,
        ),
      details: {
        downloadsBeforeStreamCancel,
        downloadsAfterStreamCancel,
        exportCancels: perfSummary.exportCancels,
      },
    },
    {
      name: 'export modal paths do not hydrate the full table or load search documents',
      ok:
        perfSummary.maxHydratedRecords <= 720 &&
        perfSummary.maxSearchDocuments === 0 &&
        perfSummary.maxRecordLookupIds <= 2500 &&
        maxDiagnosticCachedRows <= 1600,
      details: { ...perfSummary, maxDiagnosticCachedRows, diagnostics },
    },
    {
      name: 'export modal app harness has no page errors',
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
    consoleMessages: consoleMessages.slice(-80),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
