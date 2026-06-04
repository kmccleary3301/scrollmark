#!/usr/bin/env node
/* global process, console, window, document, URL, Document */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/small-dataset-workflow.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const ROW_COUNT = 180;

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Small Dataset Workflow</title></head>
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
    window.__META_DATA__ = { userId: 'small-dataset-workflow' };
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
        dedicatedDbForAccounts: true,
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
          void blob.text().then((text) => {
            record.text = text;
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

async function waitForDownload(page, count, extension) {
  await page.waitForFunction(
    ({ expectedCount, expectedExtension }) => {
      const downloads = Array.isArray(window.__scrollmarkRecordedDownloads)
        ? window.__scrollmarkRecordedDownloads
        : [];
      if (downloads.length < expectedCount) return false;
      const latest = downloads[expectedCount - 1];
      return (
        String(latest?.filename || '').endsWith(expectedExtension) &&
        typeof latest.text === 'string'
      );
    },
    { expectedCount: count, expectedExtension: extension },
    { timeout: 30_000 },
  );
  const downloads = await readDownloads(page);
  return downloads[count - 1];
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

async function readResultSourceDiagnostics(page) {
  return await page.evaluate(() => {
    const map = window.__scrollmark_result_source_diagnostics_v1;
    if (!(map instanceof Map)) return [];
    return Array.from(map.values()).map((entry) => ({
      mode: String(entry?.mode || ''),
      totalCount: Number(entry?.totalCount || 0),
      cachedRows: Number(entry?.cachedRows || 0),
      sourceKey: String(entry?.sourceKey || ''),
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
      userCount: 24,
      folderDistribution: 'mixed',
      clearFirst: true,
    });
  }, ROW_COUNT);

  await page.waitForFunction(
    (count) => document.body.innerText.includes(`Captured: ${count}`),
    ROW_COUNT,
    { timeout: 60_000 },
  );

  const bookmarksPanel = page.locator('.module-panel').filter({ hasText: 'Bookmarks' }).first();
  await bookmarksPanel.locator('button').click();
  await page.waitForSelector('dialog.modal-open', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    return Boolean(dialog && dialog.textContent?.includes('Synthetic bookmark'));
  });

  const tableModal = page.locator('dialog.modal-open').filter({ hasText: 'Synthetic bookmark' });
  const initialRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();
  await tableModal.locator('.dropdown').first().click();
  const folderCheckboxes = tableModal.locator('.dropdown input[type="checkbox"]');
  await folderCheckboxes.nth(0).check();
  await page.waitForFunction(() => {
    const map = window.__scrollmark_result_source_diagnostics_v1;
    if (!(map instanceof Map)) return false;
    return Array.from(map.values()).some(
      (entry) => entry?.mode === 'folder' && Number(entry?.cachedRows || 0) > 0,
    );
  });
  const folderRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();
  await folderCheckboxes.nth(0).uncheck();

  const searchInput = tableModal.locator('input[type="text"]').first();
  await searchInput.fill('"Exact phrase checkpoint 7"');
  await page.waitForFunction(() => {
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    return events.some(
      (entry) =>
        entry?.kind === 'search' &&
        entry?.name === 'readiness-state' &&
        entry?.tags?.phase === 'ready',
    );
  });
  const searchText = String(await tableModal.textContent());

  await tableModal.getByRole('button', { name: 'Export Data' }).click();
  const searchExportModal = page
    .locator('dialog.modal-open')
    .filter({ hasText: 'Data length:' })
    .last();
  await searchExportModal.waitFor({ state: 'visible', timeout: 10_000 });
  await searchExportModal.getByText('All current results').click();
  await searchExportModal.getByRole('button', { name: 'Start Export' }).click();
  const searchDownload = await waitForDownload(page, 1, '.json');
  const searchRows = JSON.parse(searchDownload.text);
  await searchExportModal.getByRole('button', { name: 'Cancel' }).click();

  await searchInput.fill('');
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    const text = dialog?.textContent || '';
    return (
      !text.includes('search ready') &&
      text.includes('selected 180 (all)') &&
      text.includes('rows') &&
      text.includes('/180')
    );
  });

  await tableModal.getByRole('button', { name: 'Export Data' }).click();
  const exportModal = page.locator('dialog.modal-open').filter({ hasText: 'Data length:' }).last();
  await exportModal.waitFor({ state: 'visible', timeout: 10_000 });
  await exportModal.getByText('All current results').click();
  await exportModal.getByRole('button', { name: 'Start Export' }).click();
  const allDownload = await waitForDownload(page, 2, '.json');
  const allRows = JSON.parse(allDownload.text);
  await exportModal.getByRole('button', { name: 'Cancel' }).click();

  const beforeMutationCount = await page
    .locator('dialog.modal-open')
    .filter({ hasText: 'Synthetic bookmark' })
    .locator('tbody tr[data-vrow="1"]')
    .count();
  const reseed = await page.evaluate(async () => {
    return await window.__scrollmarkSyntheticDb.seedBookmarks({
      count: 210,
      userCount: 28,
      folderDistribution: 'mixed',
      clearFirst: true,
    });
  });
  await page.waitForFunction(() => document.body.innerText.includes('Captured: 210'), null, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => {
    const map = window.__scrollmark_result_source_diagnostics_v1;
    if (!(map instanceof Map)) return false;
    return Array.from(map.values()).some(
      (entry) => entry?.mode === 'captures' && Number(entry?.totalCount || 0) === 210,
    );
  });
  const afterMutationText = String(await tableModal.textContent());

  await tableModal.getByRole('button', { name: 'Clear' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Captured: 0'), null, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('Bookmarks'),
    );
    const text = dialog?.textContent || '';
    return text.includes('No data available') || text.includes('rows 0');
  });
  const afterClearText = String(
    await page.locator('dialog.modal-open').filter({ hasText: 'Bookmarks' }).first().textContent(),
  );

  const perfEvents = await readPerfEvents(page);
  const resultSourceDiagnostics = await readResultSourceDiagnostics(page);
  const checks = [
    {
      name: 'small synthetic archive seeds through the app DB layer',
      ok: seed?.ok === true && seed?.tweetCount === ROW_COUNT && seed?.searchDocumentCount > 0,
      details: seed,
    },
    {
      name: 'Bookmarks table opens with visible rows',
      ok: initialRows > 0,
      details: { initialRows },
    },
    {
      name: 'folder filter remains functional on a small archive',
      ok: folderRows > 0 && folderRows <= initialRows,
      details: { folderRows, initialRows },
    },
    {
      name: 'search remains functional on a small archive',
      ok: searchText.includes('search ready') && searchText.includes('Exact phrase checkpoint 7'),
      details: { searchText: searchText.slice(0, 500) },
    },
    {
      name: 'search result export streams through the search source adapter',
      ok:
        Array.isArray(searchRows) &&
        searchRows.length > 0 &&
        searchDownload.filename.includes('results') &&
        perfEvents.some(
          (entry) =>
            entry?.kind === 'export' &&
            entry?.name === 'modal-export-complete' &&
            entry?.tags?.scope === 'result_set' &&
            entry?.tags?.streaming === true &&
            Number(entry?.value || 0) === searchRows.length,
        ) &&
        resultSourceDiagnostics.some(
          (entry) => entry.mode === 'search' && entry.totalCount === searchRows.length,
        ),
      details: {
        filename: searchDownload.filename,
        size: searchDownload.size,
        rows: Array.isArray(searchRows) ? searchRows.length : null,
        resultSourceDiagnostics,
      },
    },
    {
      name: 'JSON export preserves small archive rows',
      ok: Array.isArray(allRows) && allRows.length === ROW_COUNT && allDownload.size > 0,
      details: { filename: allDownload.filename, size: allDownload.size, rows: allRows.length },
    },
    {
      name: 'mutation while table is open refreshes counts and source diagnostics',
      ok:
        reseed?.ok === true &&
        reseed?.tweetCount === 210 &&
        beforeMutationCount > 0 &&
        afterMutationText.includes('rows') &&
        afterMutationText.includes('210'),
      details: {
        beforeMutationCount,
        reseed,
        afterMutationText: afterMutationText.slice(0, 500),
      },
    },
    {
      name: 'clear action resets the small archive',
      ok: afterClearText.includes('No data available') || afterClearText.includes('rows 0'),
      details: { afterClearText: afterClearText.slice(0, 500) },
    },
    {
      name: 'small workflow records source, search, export, and mutation evidence',
      ok:
        perfEvents.some((entry) => entry.kind === 'viewer') &&
        perfEvents.some((entry) => entry.kind === 'search') &&
        perfEvents.some((entry) => entry.kind === 'export') &&
        perfEvents.some((entry) => entry.kind === 'db'),
      details: { recent: perfEvents.slice(-30) },
    },
    {
      name: 'small workflow has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const payload = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    checks,
    consoleMessages: consoleMessages.slice(-80),
    resultSourceDiagnostics,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
} finally {
  await browser.close();
  server.close();
}
