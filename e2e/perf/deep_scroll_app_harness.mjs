#!/usr/bin/env node
/* global process, console, window, document, HTMLElement, Event */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/deep-scroll-app.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const RECORD_COUNT = Math.max(1000, Number(process.env.SCROLLMARK_DEEP_SCROLL_COUNT || 10000));
const SOURCE_WINDOW_DELAY_MS = Math.max(
  0,
  Number(process.env.SCROLLMARK_DEEP_SCROLL_DELAY_MS || 550),
);

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Deep Scroll Harness</title></head>
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

function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    mode: entry?.mode,
    totalCount: Number(entry?.totalCount || 0),
    cachedPages: Number(entry?.cachedPages || 0),
    cachedRows: Number(entry?.cachedRows || 0),
    lastWindowRows: Number(entry?.lastWindowRows || 0),
    lastWindowStartIndex: Number(entry?.lastWindowStartIndex || 0),
    lastFetchDurationMs: Number(entry?.lastFetchDurationMs || 0),
    lastCacheHit: Boolean(entry?.lastCacheHit),
    sourceKey: String(entry?.sourceKey || ''),
  }));
}

function summarizePerfEvents(events, sinceMs = 0) {
  const recentEvents = events.filter((entry) => Number(entry?.atMs || 0) >= sinceMs);
  const valuesFor = (kind, name) =>
    recentEvents
      .filter((entry) => entry?.kind === kind && entry?.name === name)
      .map((entry) => Number(entry?.value || 0));
  const maxValue = (kind, name) => {
    const values = valuesFor(kind, name);
    return values.length ? Math.max(...values) : 0;
  };
  const longTaskEvents = recentEvents.filter(
    (entry) => entry?.kind === 'longtask' && entry?.name === 'main-thread-longtask',
  );
  const dbEvents = recentEvents.filter((entry) => entry?.kind === 'db');
  const slowDbEvents = dbEvents
    .filter((entry) => Number(entry?.durationMs || 0) > 25)
    .sort((left, right) => Number(right?.durationMs || 0) - Number(left?.durationMs || 0))
    .slice(0, 20);
  return {
    maxHydratedRecords: maxValue('viewer', 'table-hydrated-records'),
    maxVisibleRows: maxValue('viewer', 'table-visible-rows'),
    maxResultIds: maxValue('viewer', 'table-result-ids'),
    maxSearchDocuments: maxValue('viewer', 'table-search-documents'),
    maxLookupIds: maxValue('viewer', 'table-record-lookup-ids'),
    maxLongTaskMs: longTaskEvents.length
      ? Math.max(...longTaskEvents.map((entry) => Number(entry?.durationMs || 0)))
      : 0,
    maxDbEventMs: dbEvents.length
      ? Math.max(...dbEvents.map((entry) => Number(entry?.durationMs || 0)))
      : 0,
    longTaskEvents,
    slowDbEvents,
    coalescedEvents: recentEvents.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'source-window-request-coalesced',
    ),
    staleIgnoredEvents: recentEvents.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'source-window-stale-ignored',
    ),
    captureWindowEvents: recentEvents.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'db-backed-capture-window',
    ),
    visibleRowsEvents: recentEvents.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'table-visible-rows',
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

async function readDiagnostics(page) {
  return normalizeDiagnostics(
    await page.evaluate(() => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      return map instanceof Map ? Array.from(map.values()) : [];
    }),
  );
}

async function scrollToFraction(page, fraction) {
  return await page.evaluate((nextFraction) => {
    const scroller = document.querySelector('dialog.modal-open main.overflow-y-auto');
    if (!(scroller instanceof HTMLElement)) {
      return { ok: false, reason: 'scroll container missing' };
    }
    const estimatedTotalHeight = Math.max(1, Number(window.__scrollmarkDeepScrollEstimatedHeight));
    const targetTop = estimatedTotalHeight * nextFraction;
    scroller.scrollTop = targetTop;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return {
      ok: true,
      targetTop,
    };
  }, fraction);
}

async function waitForCaptureWindowAtLeast(page, minStartIndex) {
  await page.waitForFunction(
    (minimum) => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      if (!(map instanceof Map)) return false;
      return Array.from(map.values()).some(
        (entry) =>
          entry?.mode === 'captures' &&
          Number(entry?.totalCount || 0) >= 1000 &&
          Number(entry?.lastWindowStartIndex || 0) >= minimum &&
          Number(entry?.lastWindowRows || 0) > 0,
      );
    },
    minStartIndex,
    { timeout: 60_000 },
  );
}

const errors = [];
const consoleMessages = [];
const scrollActions = [];
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
    window.__META_DATA__ = { userId: 'deep-scroll-harness' };
    window.unsafeWindow = window;
    window.localStorage.setItem('twe_enable_synthetic_db_tools_v1', '1');
    window.localStorage.removeItem('twe_source_window_request_delay_ms_v1');
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
      userCount: Math.min(500, Math.max(50, Math.floor(count / 10))),
      folderDistribution: 'none',
      includeSearchDocuments: false,
      clearFirst: true,
    });
  }, RECORD_COUNT);

  await page.waitForFunction(
    (count) => document.body.innerText.includes(`Captured: ${count}`),
    RECORD_COUNT,
    { timeout: 180_000 },
  );

  const tableStartedAt = await page.evaluate(() => Date.now());
  const bookmarksPanel = page.locator('.module-panel').filter({ hasText: 'Bookmarks' }).first();
  await bookmarksPanel.locator('button').click();
  await page.waitForSelector('dialog.modal-open', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    return Boolean(dialog && dialog.textContent?.includes('Synthetic bookmark'));
  });

  const initialDiagnostics = await readDiagnostics(page);
  await page.evaluate((count) => {
    window.__scrollmarkDeepScrollEstimatedHeight = count * 98;
  }, RECORD_COUNT);
  const middleAction = await scrollToFraction(page, 0.5);
  scrollActions.push({ label: 'middle', ...middleAction });
  await waitForCaptureWindowAtLeast(page, Math.floor(RECORD_COUNT * 0.35));
  const middleDiagnostics = await readDiagnostics(page);

  const topAction = await scrollToFraction(page, 0);
  scrollActions.push({ label: 'top', ...topAction });
  await page.waitForFunction(() => {
    const text = document.querySelector('dialog.modal-open')?.textContent || '';
    return text.includes('window 1-');
  });

  await page.evaluate((delayMs) => {
    window.localStorage.setItem('twe_source_window_request_delay_ms_v1', String(delayMs));
  }, SOURCE_WINDOW_DELAY_MS);
  for (const [label, fraction] of [
    ['quarter', 0.25],
    ['middle-again', 0.5],
    ['bottom', 0.92],
  ]) {
    const action = await scrollToFraction(page, fraction);
    scrollActions.push({ label, ...action });
    await page.waitForTimeout(50);
  }
  await waitForCaptureWindowAtLeast(page, Math.floor(RECORD_COUNT * 0.7));
  const finalDiagnostics = await readDiagnostics(page);
  const finalDialogText = String(await page.locator('dialog.modal-open').textContent());
  const perfEvents = await readPerfEvents(page);
  const perfSummary = summarizePerfEvents(perfEvents, tableStartedAt);
  const captureDiagnostics = finalDiagnostics.filter((entry) => entry.mode === 'captures');
  const finalCaptureDiag = captureDiagnostics.find((entry) => entry.totalCount === RECORD_COUNT);

  const checks = [
    {
      name: 'synthetic complete-mode dataset seeded for deep scroll',
      ok:
        seed?.ok === true &&
        seed?.tweetCount === RECORD_COUNT &&
        seed?.storedTweetCount === RECORD_COUNT &&
        seed?.includeSearchDocuments === false &&
        seed?.searchDocumentCount === 0,
      details: { seed },
    },
    {
      name: 'initial table open is source-backed and bounded',
      ok: initialDiagnostics.some(
        (entry) =>
          entry.mode === 'captures' &&
          entry.totalCount === RECORD_COUNT &&
          entry.cachedRows > 0 &&
          entry.cachedRows <= 720,
      ),
      details: { initialDiagnostics },
    },
    {
      name: 'middle scroll fetches a bounded source window without sequential loading',
      ok: middleDiagnostics.some(
        (entry) =>
          entry.mode === 'captures' &&
          entry.totalCount === RECORD_COUNT &&
          entry.lastWindowStartIndex >= Math.floor(RECORD_COUNT * 0.35) &&
          entry.cachedRows <= 3600,
      ),
      details: { middleDiagnostics },
    },
    {
      name: 'rapid deep scroll coalesces obsolete source-window requests',
      ok:
        SOURCE_WINDOW_DELAY_MS > 0 &&
        perfSummary.coalescedEvents.some((entry) => entry?.tags?.mode === 'captures'),
      details: perfSummary.coalescedEvents,
    },
    {
      name: 'final deep scroll lands near the requested bottom window',
      ok:
        finalCaptureDiag !== undefined &&
        finalCaptureDiag.lastWindowStartIndex >= Math.floor(RECORD_COUNT * 0.7) &&
        finalCaptureDiag.cachedRows <= 3600 &&
        finalDialogText.includes('Synthetic bookmark'),
      details: { finalCaptureDiag, finalDialogText: finalDialogText.slice(0, 1200) },
    },
    {
      name: 'table state remains bounded during top/middle/bottom scrolling',
      ok:
        perfSummary.maxHydratedRecords > 0 &&
        perfSummary.maxHydratedRecords <= 360 &&
        perfSummary.maxResultIds <= 360 &&
        perfSummary.maxLookupIds <= 2500 &&
        perfSummary.maxSearchDocuments === 0,
      details: perfSummary,
    },
    {
      name: 'table open and deep scroll do not create long main-thread stalls',
      ok: perfSummary.maxLongTaskMs <= 250,
      details: {
        maxLongTaskMs: perfSummary.maxLongTaskMs,
        longTaskEvents: perfSummary.longTaskEvents,
      },
    },
    {
      name: 'deep-scroll harness has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const report = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    recordCount: RECORD_COUNT,
    sourceWindowDelayMs: SOURCE_WINDOW_DELAY_MS,
    checks,
    scrollActions,
    initialDiagnostics,
    middleDiagnostics,
    finalDiagnostics,
    perfSummary,
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
