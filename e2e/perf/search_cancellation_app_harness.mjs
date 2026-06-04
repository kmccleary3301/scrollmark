#!/usr/bin/env node
/* global process, console, window, document */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/search-cancellation-app.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const SEARCH_TWEET_COUNT = 800;
const DELAYED_QUERY_MS = 1200;
const BASELINE_QUERY = 'synthetic bookmark';
const CANCELLED_QUERY = 'autonomous indexing alpha';
const FINAL_QUERY = 'synthetic bookmark 7';

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Search Cancellation Harness</title></head>
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

function summarizePerfEvents(events, sinceMs = 0) {
  const recent = events.filter((entry) => Number(entry?.atMs || 0) >= sinceMs);
  return {
    readinessEvents: recent.filter(
      (entry) => entry?.kind === 'search' && entry?.name === 'readiness-state',
    ),
    queryCancelEvents: recent.filter(
      (entry) => entry?.kind === 'search' && entry?.name === 'query-cancel',
    ),
    delayedQueryCancelEvents: recent.filter(
      (entry) => entry?.kind === 'search' && entry?.name === 'delayed-query-cancelled-before-post',
    ),
    queryTotalEvents: recent.filter(
      (entry) => entry?.kind === 'search' && entry?.name === 'query-total',
    ),
    queryErrorEvents: recent.filter(
      (entry) => entry?.kind === 'search' && entry?.name === 'query-error',
    ),
    workerQueryEvents: recent.filter(
      (entry) => entry?.kind === 'search' && entry?.name === 'worker-query',
    ),
  };
}

async function readPerfEvents(page) {
  return await page.evaluate(() => {
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    return events.map((entry) => ({
      kind: entry?.kind,
      name: entry?.name,
      atMs: entry?.atMs,
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
    window.__META_DATA__ = { userId: 'search-cancellation-harness' };
    window.unsafeWindow = window;
    window.localStorage.setItem('twe_enable_synthetic_db_tools_v1', '1');
    window.localStorage.removeItem('twe_search_worker_request_delay_ms_v1');
    window.localStorage.removeItem('twe_search_document_full_load_count_override_v1');
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
    return typeof window.__scrollmarkSyntheticDb?.seedBookmarks === 'function';
  });

  const seed = await page.evaluate(async (count) => {
    return await window.__scrollmarkSyntheticDb.seedBookmarks({
      count,
      userCount: 50,
      folderDistribution: 'none',
      clearFirst: true,
    });
  }, SEARCH_TWEET_COUNT);

  await page.waitForFunction(
    (count) => document.body.innerText.includes(`Captured: ${count}`),
    SEARCH_TWEET_COUNT,
    { timeout: 120_000 },
  );

  const bookmarksPanel = page.locator('.module-panel').filter({ hasText: 'Bookmarks' }).first();
  await bookmarksPanel.locator('button').click();
  await page.waitForSelector('dialog.modal-open', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    return Boolean(dialog && dialog.textContent?.includes('Synthetic bookmark'));
  });

  const searchInput = page.locator('dialog.modal-open input[type="text"]').first();
  const baselineStartedAt = await page.evaluate(() => Date.now());
  await searchInput.fill(BASELINE_QUERY);
  await page.waitForFunction(
    (args) => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return events.some(
        (entry) =>
          entry?.atMs >= args.sinceMs &&
          entry?.kind === 'search' &&
          entry?.name === 'readiness-state' &&
          entry?.tags?.phase === 'ready' &&
          entry?.tags?.queryLength === args.queryLength,
      );
    },
    { sinceMs: baselineStartedAt, queryLength: BASELINE_QUERY.length },
    { timeout: 60_000 },
  );

  const cancellationStartedAt = await page.evaluate((delayMs) => {
    window.localStorage.setItem('twe_search_worker_request_delay_ms_v1', String(delayMs));
    return Date.now();
  }, DELAYED_QUERY_MS);
  await searchInput.fill(CANCELLED_QUERY);
  await page.waitForFunction(
    (args) => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return events.some(
        (entry) =>
          entry?.atMs >= args.sinceMs &&
          entry?.kind === 'search' &&
          entry?.name === 'readiness-state' &&
          entry?.tags?.phase === 'querying' &&
          entry?.tags?.queryLength === args.queryLength,
      );
    },
    { sinceMs: cancellationStartedAt, queryLength: CANCELLED_QUERY.length },
    { timeout: 20_000 },
  );
  await searchInput.fill(FINAL_QUERY);
  await page.waitForFunction(
    (args) => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return events.some(
        (entry) =>
          entry?.atMs >= args.sinceMs &&
          entry?.kind === 'search' &&
          entry?.name === 'query-total' &&
          entry?.tags?.queryLength === args.queryLength,
      );
    },
    { sinceMs: cancellationStartedAt, queryLength: FINAL_QUERY.length },
    { timeout: 60_000 },
  );

  const dialogText = String(await page.locator('dialog.modal-open').textContent());
  const perfEvents = await readPerfEvents(page);
  const cancellationSummary = summarizePerfEvents(perfEvents, cancellationStartedAt);
  const baselineSummary = summarizePerfEvents(perfEvents, baselineStartedAt);

  const checks = [
    {
      name: 'synthetic bookmark seed stays below large-corpus search guard',
      ok:
        seed?.ok === true &&
        seed?.tweetCount === SEARCH_TWEET_COUNT &&
        Number(seed?.searchDocumentCount || 0) >= SEARCH_TWEET_COUNT &&
        Number(seed?.searchDocumentCount || 0) < 50_000,
      details: { seed },
    },
    {
      name: 'baseline search reaches ready state before cancellation scenario',
      ok: baselineSummary.readinessEvents.some(
        (entry) =>
          entry?.tags?.phase === 'ready' && entry?.tags?.queryLength === BASELINE_QUERY.length,
      ),
      details: baselineSummary.readinessEvents,
    },
    {
      name: 'rapid query change cancels a pending worker query',
      ok: cancellationSummary.queryCancelEvents.some((entry) => entry?.tags?.pending === true),
      details: cancellationSummary.queryCancelEvents,
    },
    {
      name: 'delayed diagnostic query is cancelled before posting stale work to worker',
      ok: cancellationSummary.delayedQueryCancelEvents.some(
        (entry) =>
          entry?.tags?.type === 'search:query' && Number(entry?.value || 0) === DELAYED_QUERY_MS,
      ),
      details: cancellationSummary.delayedQueryCancelEvents,
    },
    {
      name: 'final query resolves after cancelling stale in-flight query',
      ok:
        cancellationSummary.readinessEvents.some(
          (entry) =>
            entry?.tags?.phase === 'cancelled' &&
            entry?.tags?.queryLength === CANCELLED_QUERY.length,
        ) &&
        cancellationSummary.readinessEvents.some(
          (entry) =>
            entry?.tags?.phase === 'ready' && entry?.tags?.queryLength === FINAL_QUERY.length,
        ) &&
        dialogText.includes('search ready'),
      details: {
        readinessEvents: cancellationSummary.readinessEvents,
        dialogText: dialogText.slice(0, 1200),
      },
    },
    {
      name: 'cancellation harness has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const report = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    checks,
    baselineSummary,
    cancellationSummary,
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
