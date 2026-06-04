#!/usr/bin/env node
/* global process, console, window, document, Buffer, fetch, HTMLInputElement, Event */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const DEFAULT_EXPORT_PATH =
  '/home/skra/projects/twitter_scraping/misc/round_019/twitter-web-exporter-1779916291277.json';
const [, , outPathArg = 'e2e/perf/out/recovered-db-browser.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const exportPath = path.resolve(process.env.SCROLLMARK_RECOVERED_DB_EXPORT || DEFAULT_EXPORT_PATH);

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}
if (!fs.existsSync(exportPath)) {
  console.error(`Missing recovered DB export at ${exportPath}.`);
  process.exit(2);
}

function readExportHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, length).toString('utf8');
    const databaseVersion = Number(head.match(/"databaseVersion":(\d+)/)?.[1] || 0);
    const rowCounts = new Map();
    for (const match of head.matchAll(/"name":"([^"]+)","schema":"[^"]*","rowCount":(\d+)/g)) {
      rowCounts.set(match[1], Number(match[2] || 0));
    }
    return {
      databaseVersion,
      rowCounts: Object.fromEntries(rowCounts),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Recovered DB Browser Harness</title></head>
  <body><main id="host-page">host page</main></body>
</html>`;
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/recovered-export')) {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(fs.statSync(exportPath).size),
      });
      fs.createReadStream(exportPath).pipe(response);
      return;
    }
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

function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    mode: entry?.mode,
    totalCount: Number(entry?.totalCount || 0),
    cachedPages: Number(entry?.cachedPages || 0),
    cachedRows: Number(entry?.cachedRows || 0),
    lastWindowRows: Number(entry?.lastWindowRows || 0),
    lastWindowStartIndex: Number(entry?.lastWindowStartIndex || 0),
    lastCacheHit: Boolean(entry?.lastCacheHit),
    sourceKey: String(entry?.sourceKey || ''),
  }));
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
    captureWindows: events.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'db-backed-capture-window',
    ),
    folderWindows: events.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'db-backed-folder-window',
    ),
    folderFacets: events.filter(
      (entry) => entry?.kind === 'db' && entry?.name === 'search-document-folder-facets',
    ),
    captureIndexPages: events.filter(
      (entry) => entry?.kind === 'db' && entry?.name === 'capture-index-page',
    ),
    captureIndexMisses: events.filter(
      (entry) => entry?.kind === 'db' && entry?.name === 'capture-index-page-miss',
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
    window.__META_DATA__ = { userId: 'recovered-db-browser-harness' };
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
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: userscriptPath });
  await page.waitForSelector('#twe-root', { state: 'attached', timeout: 10_000 });
  await page.waitForFunction(() => {
    return typeof window.__scrollmarkSyntheticDb?.importDbExport === 'function';
  });
}

async function readDiagnostics(page) {
  return normalizeDiagnostics(
    await page.evaluate(() => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      if (!(map instanceof Map)) return [];
      return Array.from(map.values());
    }),
  );
}

async function readPerfEvents(page) {
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
const exportStats = fs.statSync(exportPath);
const exportHeader = readExportHeader(exportPath);
const expectedTweets = Number(exportHeader.rowCounts.tweets || 0);
const expectedCaptures = Number(exportHeader.rowCounts.captures || 0);
const expectedSearchDocuments = Number(exportHeader.rowCounts.search_documents || 0);
const { server, url } = await createServer();
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installApp(page, url, errors, consoleMessages);

  const importSummary = await page.evaluate(async () => {
    const response = await fetch('/recovered-export');
    if (!response.ok) throw new Error(`Recovered export fetch failed: ${response.status}`);
    const blob = await response.blob();
    return await window.__scrollmarkSyntheticDb.importDbExport(blob);
  });

  await page.waitForFunction(
    (expected) => document.body.innerText.includes(`Captured: ${expected}`),
    importSummary.bookmarkCaptureCount,
    { timeout: 120_000 },
  );
  const bookmarksPanel = page.locator('.module-panel').filter({ hasText: 'Bookmarks' }).first();
  await bookmarksPanel.locator('button').click();
  await page.waitForSelector('dialog.modal-open', { timeout: 20_000 });
  const tableModal = page.locator('dialog.modal-open').filter({ hasText: 'Bookmarks' }).first();
  await tableModal.locator('tbody tr[data-vrow="1"]').first().waitFor({ timeout: 30_000 });
  const initialRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();
  const tableSummary = await tableModal
    .locator('.font-mono')
    .filter({ hasText: 'rendered' })
    .last()
    .textContent();

  await page.waitForFunction(
    (expectedTotal) => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      if (!(map instanceof Map)) return false;
      return Array.from(map.values()).some(
        (entry) => entry?.mode === 'captures' && Number(entry?.totalCount || 0) === expectedTotal,
      );
    },
    importSummary.bookmarkCaptureCount,
    { timeout: 20_000 },
  );
  const captureDiagnostics = await readDiagnostics(page);

  const folderCheckboxes = tableModal.locator('.dropdown input[type="checkbox"]');
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('dialog.modal-open .dropdown input[type="checkbox"]').length > 0,
      null,
      { timeout: 45_000 },
    )
    .catch(() => undefined);
  const folderCheckboxCount = await folderCheckboxes.count();
  if (folderCheckboxCount > 0) {
    await page.evaluate(() => {
      const checkbox = document.querySelector('dialog.modal-open .dropdown input[type="checkbox"]');
      if (!(checkbox instanceof HTMLInputElement)) return;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(
      () => {
        const map = window.__scrollmark_result_source_diagnostics_v1;
        if (!(map instanceof Map)) return false;
        return Array.from(map.values()).some(
          (entry) => entry?.mode === 'folder' && Number(entry?.cachedRows || 0) > 0,
        );
      },
      null,
      { timeout: 30_000 },
    );
    await page
      .waitForFunction(
        () => document.querySelectorAll('dialog.modal-open tbody tr[data-vrow="1"]').length > 0,
        null,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
  }
  const folderRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();
  const finalDiagnostics = await readDiagnostics(page);
  const perfEvents = await readPerfEvents(page);
  const perfSummary = summarizePerfEvents(perfEvents);

  const captureDiag = finalDiagnostics.find(
    (entry) => entry.mode === 'captures' && entry.totalCount === importSummary.bookmarkCaptureCount,
  );
  const folderDiag = finalDiagnostics.find(
    (entry) => entry.mode === 'folder' && entry.cachedRows > 0,
  );

  const checks = [
    {
      name: 'recovered v6 export imports through the built userscript in Chromium IndexedDB',
      ok:
        exportHeader.databaseVersion === 6 &&
        importSummary?.ok === true &&
        importSummary.counts?.tweets === expectedTweets &&
        importSummary.counts?.captures === expectedCaptures &&
        importSummary.counts?.search_documents === expectedSearchDocuments &&
        importSummary.bookmarkCaptureCount > 0 &&
        importSummary.bookmarkSearchDocumentCount > 0,
      details: {
        exportHeader,
        exportBytes: exportStats.size,
        expectedTweets,
        expectedCaptures,
        expectedSearchDocuments,
        importSummary,
      },
    },
    {
      name: 'recovered Bookmarks table opens from a source descriptor with bounded rows',
      ok:
        initialRows > 0 &&
        initialRows <= 120 &&
        typeof tableSummary === 'string' &&
        tableSummary.includes(`/${importSummary.bookmarkCaptureCount}`) &&
        captureDiag?.cachedRows > 0 &&
        captureDiag.cachedRows <= 400,
      details: { initialRows, tableSummary, captureDiag, captureDiagnostics },
    },
    {
      name: 'recovered folder picker uses DB facets and source-backed folder windows',
      ok:
        folderCheckboxCount > 0 &&
        folderRows > 0 &&
        folderRows <= 120 &&
        folderDiag?.cachedRows > 0 &&
        folderDiag.cachedRows <= 400 &&
        perfSummary.folderFacets.some((entry) => Number(entry?.value || 0) > 0) &&
        perfSummary.folderWindows.some((entry) => Number(entry?.value || 0) > 0),
      details: {
        folderCheckboxCount,
        folderRows,
        folderDiag,
        folderFacets: perfSummary.folderFacets,
      },
    },
    {
      name: 'recovered browser QC keeps table memory counters bounded',
      ok:
        perfSummary.maxHydratedRecords <= 160 &&
        perfSummary.maxSearchDocuments === 0 &&
        perfSummary.maxResultIds <= 160 &&
        perfSummary.maxRecordLookupIds <= 500,
      details: perfSummary,
    },
    {
      name: 'recovered DB browser harness has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const report = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    exportPath,
    exportBytes: exportStats.size,
    checks,
    diagnostics: finalDiagnostics,
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
