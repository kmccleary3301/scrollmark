#!/usr/bin/env node
/* global process, console, window, document */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/folder-search-app.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const ROW_COUNT = Math.max(
  60,
  Math.floor(Number(process.env.SCROLLMARK_FOLDER_SEARCH_ROWS || 600)),
);
const QUERY = 'IndexedDB';
const EXPECTED_TOPIC = 'IndexedDB cursor pagination';
const EXCLUDED_TOPIC = 'local-first archive scaling';

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Folder Search Harness</title></head>
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
    window.__META_DATA__ = { userId: 'folder-search-harness' };
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
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: userscriptPath });
  await page.waitForSelector('#twe-root', { state: 'attached', timeout: 10_000 });
  await page.waitForFunction(() => {
    return typeof window.__scrollmarkSyntheticDb?.seedBookmarks === 'function';
  });
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
const { server, url } = await createServer();
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installApp(page, url, errors, consoleMessages);

  const seed = await page.evaluate(async (count) => {
    return await window.__scrollmarkSyntheticDb.seedBookmarks({
      count,
      userCount: 24,
      folderDistribution: 'one-huge',
      contentProfile: 'dense-media',
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
  const initialText = String(await tableModal.textContent());
  const initialRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();

  await tableModal.locator('.dropdown').first().click();
  await tableModal.locator('.dropdown input[type="checkbox"]').first().check();
  await page.waitForFunction(() => {
    const map = window.__scrollmark_result_source_diagnostics_v1;
    if (!(map instanceof Map)) return false;
    return Array.from(map.values()).some(
      (entry) => entry?.mode === 'folder' && Number(entry?.totalCount || 0) > 0,
    );
  });
  const folderText = String(await tableModal.textContent());
  const folderRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();

  await tableModal.getByRole('button', { name: 'Media masonry' }).click();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    return Boolean(
      dialog &&
      dialog.textContent?.includes('Media masonry view') &&
      dialog.querySelectorAll('article').length > 0,
    );
  });
  const unfilteredMasonryCardTexts = await tableModal
    .locator('article')
    .evaluateAll((cards) => cards.map((card) => card.textContent || ''));

  const searchInput = tableModal.locator('input[type="text"]').first();
  await searchInput.fill(QUERY);
  await page.waitForFunction(
    (queryLength) => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return events.some(
        (entry) =>
          entry?.kind === 'search' &&
          entry?.name === 'query-total' &&
          entry?.tags?.queryLength === queryLength,
      );
    },
    QUERY.length,
    { timeout: 60_000 },
  );
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    return Boolean(dialog?.textContent?.includes('search ready'));
  });
  await page.waitForFunction(
    ({ expectedTopic, excludedTopic }) => {
      const dialog = document.querySelector('dialog.modal-open');
      if (!dialog?.textContent?.includes('search ready')) return false;
      if (!dialog.textContent.includes('result rows')) return false;
      const cards = Array.from(dialog.querySelectorAll('article'));
      if (!cards.length) return false;
      return cards.every((card) => {
        const text = card.textContent || '';
        return text.includes(expectedTopic) && !text.includes(excludedTopic);
      });
    },
    { expectedTopic: EXPECTED_TOPIC, excludedTopic: EXCLUDED_TOPIC },
    { timeout: 60_000 },
  );

  const masonrySearchText = String(await tableModal.textContent());
  const masonrySearchCardTexts = await tableModal
    .locator('article')
    .evaluateAll((cards) => cards.map((card) => card.textContent || ''));

  await tableModal.getByRole('button', { name: 'Table view' }).click();
  await page.waitForFunction(
    ({ expectedTopic, excludedTopic }) => {
      const dialog = document.querySelector('dialog.modal-open');
      const rows = Array.from(dialog?.querySelectorAll('tbody tr[data-vrow="1"]') ?? []);
      if (!rows.length) return false;
      return rows.every((row) => {
        const text = row.textContent || '';
        return text.includes(expectedTopic) && !text.includes(excludedTopic);
      });
    },
    { expectedTopic: EXPECTED_TOPIC, excludedTopic: EXCLUDED_TOPIC },
    { timeout: 20_000 },
  );
  const searchRows = await tableModal.locator('tbody tr[data-vrow="1"]').count();
  const renderedRowTexts = await tableModal
    .locator('tbody tr[data-vrow="1"]')
    .evaluateAll((rows) => rows.map((row) => row.textContent || ''));
  const perfEvents = await readPerfEvents(page);
  const queryTotals = perfEvents.filter(
    (entry) => entry?.kind === 'search' && entry?.name === 'query-total',
  );
  const latestQueryTotal = queryTotals[queryTotals.length - 1] ?? null;
  const workerCorpusEvents = perfEvents.filter(
    (entry) => entry?.kind === 'search' && entry?.name === 'worker-corpus-candidates',
  );
  const latestCorpusEvent = workerCorpusEvents[workerCorpusEvents.length - 1] ?? null;

  const checks = [
    {
      name: 'synthetic one-folder archive seeds through the app DB layer',
      ok:
        seed?.ok === true &&
        seed?.tweetCount === ROW_COUNT &&
        seed?.searchDocumentCount > 0 &&
        seed?.contentProfile === 'dense-media',
      details: seed,
    },
    {
      name: 'unfiltered folder view includes mixed topic rows',
      ok:
        initialRows > 0 &&
        folderRows > 0 &&
        folderText.includes(EXPECTED_TOPIC) &&
        folderText.includes(EXCLUDED_TOPIC),
      details: {
        initialRows,
        folderRows,
        hasExpectedTopic: folderText.includes(EXPECTED_TOPIC),
        hasExcludedTopic: folderText.includes(EXCLUDED_TOPIC),
        initialText: initialText.slice(0, 300),
      },
    },
    {
      name: 'unfiltered folder masonry starts from the broad media source',
      ok:
        unfilteredMasonryCardTexts.length > 0 &&
        unfilteredMasonryCardTexts.some((text) => text.includes(EXPECTED_TOPIC)) &&
        unfilteredMasonryCardTexts.some((text) => text.includes(EXCLUDED_TOPIC)),
      details: {
        cardCount: unfilteredMasonryCardTexts.length,
        sampleCards: unfilteredMasonryCardTexts.slice(0, 5),
      },
    },
    {
      name: 'search inside selected folder reaches ready state and trims matches',
      ok:
        masonrySearchText.includes('search ready') &&
        Number(latestQueryTotal?.tags?.resultCount || 0) > 0 &&
        Number(latestQueryTotal?.tags?.resultCount || 0) < ROW_COUNT,
      details: { latestQueryTotal, searchText: masonrySearchText.slice(0, 600) },
    },
    {
      name: 'masonry folder-scoped search cards all match the query topic',
      ok:
        masonrySearchCardTexts.length > 0 &&
        masonrySearchCardTexts.every((text) => text.includes(EXPECTED_TOPIC)) &&
        !masonrySearchCardTexts.some((text) => text.includes(EXCLUDED_TOPIC)) &&
        masonrySearchText.includes('result rows') &&
        !masonrySearchText.includes('source rows'),
      details: {
        cardCount: masonrySearchCardTexts.length,
        sampleCards: masonrySearchCardTexts.slice(0, 5),
        masonrySearchText: masonrySearchText.slice(0, 800),
      },
    },
    {
      name: 'rendered folder-scoped search rows all match the query topic',
      ok:
        searchRows > 0 &&
        renderedRowTexts.length > 0 &&
        renderedRowTexts.every((text) => text.includes(EXPECTED_TOPIC)) &&
        !renderedRowTexts.some((text) => text.includes(EXCLUDED_TOPIC)),
      details: {
        searchRows,
        renderedRowTexts: renderedRowTexts.slice(0, 5),
      },
    },
    {
      name: 'folder search uses the full search-document corpus, not only the visible folder window',
      ok:
        Number(latestCorpusEvent?.value || 0) >= ROW_COUNT &&
        latestCorpusEvent?.tags?.source === 'search-documents' &&
        Number(latestCorpusEvent?.tags?.records || 0) < ROW_COUNT,
      details: { latestCorpusEvent },
    },
    {
      name: 'folder search harness has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const report = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    query: QUERY,
    expectedTopic: EXPECTED_TOPIC,
    excludedTopic: EXCLUDED_TOPIC,
    checks,
    perfEvents: perfEvents.slice(-80),
    consoleMessages,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
