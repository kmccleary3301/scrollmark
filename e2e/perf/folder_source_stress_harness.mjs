#!/usr/bin/env node
/* global process, console, window, document, HTMLElement, Event */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/folder-source-stress.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const HUGE_FOLDER_COUNT = Math.max(1, Number(process.env.SCROLLMARK_FOLDER_STRESS_HUGE || 5000));
const MANY_FOLDER_COUNT = Math.max(1, Number(process.env.SCROLLMARK_FOLDER_STRESS_MANY || 5000));
const RAW_RECORD_MODE = ['complete', 'source-window'].includes(
  String(process.env.SCROLLMARK_FOLDER_STRESS_RAW_RECORD_MODE || '').trim(),
)
  ? String(process.env.SCROLLMARK_FOLDER_STRESS_RAW_RECORD_MODE).trim()
  : 'complete';
const ENABLED_SCENARIOS = new Set(
  String(process.env.SCROLLMARK_FOLDER_STRESS_SCENARIOS || 'huge,many')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const DEEP_INDEX_PROBE = ['1', 'true', 'yes'].includes(
  String(process.env.SCROLLMARK_FOLDER_STRESS_DEEP_INDEX || '')
    .trim()
    .toLowerCase(),
);
const RAPID_FOLDER_SCROLL_PROBE = ['1', 'true', 'yes'].includes(
  String(process.env.SCROLLMARK_FOLDER_STRESS_RAPID_SCROLL || '')
    .trim()
    .toLowerCase(),
);
const RAPID_FOLDER_SCROLL_DELAY_MS = Math.max(
  0,
  Number(process.env.SCROLLMARK_FOLDER_STRESS_RAPID_SCROLL_DELAY_MS || 550),
);

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Folder Source Stress</title></head>
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
    lastCacheHit: Boolean(entry?.lastCacheHit),
    sourceKey: String(entry?.sourceKey || ''),
  }));
}

function summarizePerfEvents(events) {
  const tableSearchDocumentValues = events
    .filter((entry) => entry?.kind === 'viewer' && entry?.name === 'table-search-documents')
    .map((entry) => Number(entry?.value || 0));
  const folderWindowEvents = events.filter(
    (entry) => entry?.kind === 'viewer' && entry?.name === 'db-backed-folder-window',
  );
  const folderWindowDurations = folderWindowEvents.map((entry) => Number(entry?.durationMs || 0));
  const folderIndexBuildEvents = events.filter(
    (entry) => entry?.kind === 'db' && entry?.name === 'folder-source-index-build',
  );
  const folderIndexPageEvents = events.filter(
    (entry) => entry?.kind === 'db' && entry?.name === 'folder-source-index-page',
  );
  const folderFacetEvents = events.filter(
    (entry) => entry?.kind === 'db' && entry?.name === 'search-document-folder-facets',
  );
  const coalescedEvents = events.filter(
    (entry) => entry?.kind === 'viewer' && entry?.name === 'source-window-request-coalesced',
  );
  const staleIgnoredEvents = events.filter(
    (entry) => entry?.kind === 'viewer' && entry?.name === 'source-window-stale-ignored',
  );
  return {
    maxTableSearchDocuments: tableSearchDocumentValues.length
      ? Math.max(...tableSearchDocumentValues)
      : 0,
    maxFolderWindowDurationMs: folderWindowDurations.length
      ? Math.max(...folderWindowDurations)
      : 0,
    folderWindowEvents: folderWindowEvents.slice(-8),
    folderIndexBuildEvents: folderIndexBuildEvents.slice(-4),
    folderIndexPageEvents: folderIndexPageEvents.slice(-4),
    folderFacetEvents: folderFacetEvents.slice(-4),
    coalescedEvents: coalescedEvents.slice(-8),
    staleIgnoredEvents: staleIgnoredEvents.slice(-8),
  };
}

async function installApp(page, url, errors, consoleMessages) {
  page.on('pageerror', (error) => {
    errors.push(error?.stack || error?.message || String(error));
  });
  page.on('console', (message) => {
    const text = message.text();
    consoleMessages.push({ type: message.type(), text });
    if (text.includes('[scrollmark-synthetic-seed]')) {
      console.log(text);
    }
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
    window.__META_DATA__ = { userId: 'folder-source-stress' };
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
    return typeof window.__scrollmarkSyntheticDb?.seedBookmarks === 'function';
  });
}

async function openBookmarksTable(page, count) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(`Captured: ${expected}`),
    count,
    { timeout: Math.max(90_000, Math.min(600_000, count * 8)) },
  );
  const bookmarksPanel = page.locator('.module-panel').filter({ hasText: 'Bookmarks' }).first();
  await bookmarksPanel.locator('button').click();
  await page.waitForSelector('dialog.modal-open', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    return Boolean(dialog && dialog.textContent?.includes('Synthetic bookmark'));
  });
}

async function readResultSourceDiagnostics(page) {
  return normalizeDiagnostics(
    await page.evaluate(() => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      return map instanceof Map ? Array.from(map.values()) : [];
    }),
  );
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

async function waitForPerfEvent(page, name) {
  await page.waitForFunction(
    (eventName) => {
      const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
      return events.some((entry) => entry?.kind === 'db' && entry?.name === eventName);
    },
    name,
    { timeout: 60_000 },
  );
}

async function scrollToFolderFraction(page, totalCount, fraction) {
  return await page.evaluate(
    ({ count, nextFraction }) => {
      const scroller = document.querySelector('dialog.modal-open main.overflow-y-auto');
      if (!(scroller instanceof HTMLElement)) {
        return { ok: false, reason: 'scroll container missing' };
      }
      const targetTop = Math.max(1, count * 98) * nextFraction;
      scroller.scrollTop = targetTop;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { ok: true, targetTop };
    },
    { count: totalCount, nextFraction: fraction },
  );
}

async function waitForFolderWindowAtLeast(page, totalCount, minStartIndex) {
  await page.waitForFunction(
    ({ expectedTotal, minimum }) => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      if (!(map instanceof Map)) return false;
      return Array.from(map.values()).some(
        (entry) =>
          entry?.mode === 'folder' &&
          Number(entry?.totalCount || 0) === expectedTotal &&
          Number(entry?.lastWindowStartIndex || 0) >= minimum &&
          Number(entry?.lastWindowRows || 0) > 0,
      );
    },
    { expectedTotal: totalCount, minimum: minStartIndex },
    { timeout: Math.max(60_000, Math.min(240_000, totalCount * 2)) },
  );
}

async function runScenario(browser, serverUrl, scenario) {
  const errors = [];
  const consoleMessages = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(Math.max(30_000, Math.min(600_000, scenario.count * 8)));
  try {
    console.log(
      `[folder-source-stress] starting ${scenario.name} with ${scenario.count} bookmarks`,
    );
    await installApp(page, serverUrl, errors, consoleMessages);
    const seed = await page.evaluate(
      async (args) => {
        return await window.__scrollmarkSyntheticDb.seedBookmarks({
          count: args.count,
          userCount: Math.min(500, Math.max(10, Math.floor(args.count / 10))),
          folderDistribution: args.folderDistribution,
          rawRecordMode: args.rawRecordMode,
          clearFirst: true,
        });
      },
      { ...scenario, rawRecordMode: RAW_RECORD_MODE },
    );
    await openBookmarksTable(page, scenario.count);
    const initialRows = await page.locator('dialog.modal-open tbody tr').count();
    await page.locator('dialog.modal-open .dropdown').first().click();
    if (scenario.minRenderedFolderOptions) {
      await page.waitForFunction(
        (minCount) =>
          document.querySelectorAll('dialog.modal-open .dropdown input[type="checkbox"]').length >=
          minCount,
        scenario.minRenderedFolderOptions,
        { timeout: 30_000 },
      );
    }
    const checkboxCount = await page
      .locator('dialog.modal-open .dropdown input[type="checkbox"]')
      .count();
    const filterInputCount = await page
      .locator('dialog.modal-open .dropdown input.input-xs')
      .count();

    await page.locator('dialog.modal-open .dropdown input[type="checkbox"]').first().check();
    await page.waitForFunction(
      (expectedTotal) => {
        const map = window.__scrollmark_result_source_diagnostics_v1;
        if (!(map instanceof Map)) return false;
        return Array.from(map.values()).some(
          (entry) =>
            entry?.mode === 'folder' &&
            Number(entry?.totalCount || 0) === expectedTotal &&
            Number(entry?.cachedRows || 0) > 0 &&
            Number(entry?.cachedRows || 0) <= 720,
        );
      },
      scenario.expectedSelectedFolderCount,
      { timeout: 30_000 },
    );

    let rapidScrollProbe = null;
    if (scenario.rapidScrollProbe) {
      const rapidStartedAt = Date.now();
      await page.evaluate((delayMs) => {
        window.localStorage.setItem('twe_source_window_request_delay_ms_v1', String(delayMs));
      }, RAPID_FOLDER_SCROLL_DELAY_MS);
      for (const [label, fraction] of [
        ['quarter', 0.25],
        ['middle', 0.5],
        ['deep', 0.82],
      ]) {
        const action = await scrollToFolderFraction(
          page,
          scenario.expectedSelectedFolderCount,
          fraction,
        );
        if (!rapidScrollProbe) {
          rapidScrollProbe = { actions: [], diagnostics: [], perfSummary: null };
        }
        rapidScrollProbe.actions.push({ label, ...action });
        await page.waitForTimeout(50);
      }
      await waitForFolderWindowAtLeast(
        page,
        scenario.expectedSelectedFolderCount,
        Math.floor(scenario.expectedSelectedFolderCount * 0.6),
      );
      await page.evaluate(() => {
        window.localStorage.removeItem('twe_source_window_request_delay_ms_v1');
      });
      const rapidDiagnostics = await readResultSourceDiagnostics(page);
      const rapidPerfEvents = (await readPerfEvents(page)).filter(
        (entry) => Number(entry?.atMs || 0) >= rapidStartedAt,
      );
      rapidScrollProbe = {
        ...(rapidScrollProbe || { actions: [] }),
        diagnostics: rapidDiagnostics.filter(
          (entry) =>
            entry.mode === 'folder' && entry.totalCount === scenario.expectedSelectedFolderCount,
        ),
        perfSummary: summarizePerfEvents(rapidPerfEvents),
      };
    }

    let deepIndexProbe = null;
    if (scenario.deepIndexProbe) {
      await waitForPerfEvent(page, 'folder-source-index-build');
      const deepScroll = await scrollToFolderFraction(
        page,
        scenario.expectedSelectedFolderCount,
        0.86,
      );
      try {
        await waitForFolderWindowAtLeast(
          page,
          scenario.expectedSelectedFolderCount,
          Math.floor(scenario.expectedSelectedFolderCount * 0.65),
        );
      } catch (error) {
        const diagnostics = await readResultSourceDiagnostics(page);
        const perfSummary = summarizePerfEvents(await readPerfEvents(page));
        console.error(
          JSON.stringify(
            {
              deepIndexFailure: true,
              scenario: scenario.name,
              deepScroll,
              expectedSelectedFolderCount: scenario.expectedSelectedFolderCount,
              diagnostics: diagnostics.filter(
                (entry) =>
                  entry.mode === 'folder' &&
                  entry.totalCount === scenario.expectedSelectedFolderCount,
              ),
              perfSummary,
            },
            null,
            2,
          ),
        );
        throw error;
      }
      await waitForPerfEvent(page, 'folder-source-index-page');
      const deepDiagnostics = await readResultSourceDiagnostics(page);
      const deepPerfEvents = await readPerfEvents(page);
      deepIndexProbe = {
        scroll: deepScroll,
        diagnostics: deepDiagnostics.filter(
          (entry) =>
            entry.mode === 'folder' && entry.totalCount === scenario.expectedSelectedFolderCount,
        ),
        perfSummary: summarizePerfEvents(deepPerfEvents),
      };
    }

    const diagnostics = await readResultSourceDiagnostics(page);
    const selectedFolderDiag = diagnostics.find(
      (entry) =>
        entry.mode === 'folder' && entry.totalCount === scenario.expectedSelectedFolderCount,
    );
    const perfEvents = await readPerfEvents(page);
    const perfSummary = summarizePerfEvents(perfEvents);

    const result = {
      name: scenario.name,
      seed,
      initialRows,
      checkboxCount,
      filterInputCount,
      selectedFolderDiag,
      perfSummary,
      deepIndexProbe,
      rapidScrollProbe,
      errors,
      consoleMessages,
    };
    console.log(`[folder-source-stress] finished ${scenario.name}`);
    return result;
  } finally {
    await page.close();
  }
}

const { server, url } = await createServer();
const browser = await chromium.launch({ headless: true });

try {
  const scenarios = [
    {
      id: 'huge',
      name: 'huge single folder',
      count: HUGE_FOLDER_COUNT,
      folderDistribution: 'one-huge',
      expectedSelectedFolderCount: HUGE_FOLDER_COUNT,
      deepIndexProbe: DEEP_INDEX_PROBE && HUGE_FOLDER_COUNT >= 5200,
      rapidScrollProbe: RAPID_FOLDER_SCROLL_PROBE && HUGE_FOLDER_COUNT >= 1000,
    },
    {
      id: 'many',
      name: 'many folders picker',
      count: MANY_FOLDER_COUNT,
      folderDistribution: 'many-small',
      expectedSelectedFolderCount: Math.ceil(MANY_FOLDER_COUNT / 2000),
      minRenderedFolderOptions: 81,
    },
  ].filter((scenario) => ENABLED_SCENARIOS.has(scenario.id));
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(browser, url, scenario));
  }

  const hugeFolder = results.find((result) => result.name === 'huge single folder');
  const manyFolders = results.find((result) => result.name === 'many folders picker');
  const allErrors = results.flatMap((result) => result.errors);
  const checks = [];
  if (ENABLED_SCENARIOS.has('huge')) {
    checks.push({
      name: 'huge single folder stays source-backed and bounded',
      ok:
        hugeFolder?.seed?.ok === true &&
        hugeFolder?.selectedFolderDiag?.totalCount === HUGE_FOLDER_COUNT &&
        hugeFolder?.selectedFolderDiag?.cachedRows > 0 &&
        hugeFolder?.selectedFolderDiag?.cachedRows <= 720 &&
        hugeFolder?.perfSummary?.maxTableSearchDocuments === 0 &&
        hugeFolder?.perfSummary?.folderFacetEvents?.some(
          (entry) =>
            Number(entry?.value || 0) === 1 &&
            Number(entry?.tags?.totalDocuments || 0) === HUGE_FOLDER_COUNT,
        ),
      details: hugeFolder,
    });
    if (DEEP_INDEX_PROBE) {
      checks.push({
        name: 'huge folder cold deep window uses persisted folder source index pages',
        ok:
          hugeFolder?.deepIndexProbe?.scroll?.ok === true &&
          hugeFolder?.deepIndexProbe?.diagnostics?.some(
            (entry) =>
              entry.totalCount === HUGE_FOLDER_COUNT &&
              entry.lastWindowStartIndex >= Math.floor(HUGE_FOLDER_COUNT * 0.65) &&
              entry.lastWindowRows > 0,
          ) &&
          hugeFolder?.deepIndexProbe?.perfSummary?.folderIndexBuildEvents?.length > 0 &&
          hugeFolder?.deepIndexProbe?.perfSummary?.folderIndexPageEvents?.length > 0,
        details: hugeFolder?.deepIndexProbe,
      });
    }
    if (RAPID_FOLDER_SCROLL_PROBE) {
      checks.push({
        name: 'rapid folder deep scroll coalesces and ignores stale folder windows',
        ok:
          hugeFolder?.rapidScrollProbe?.actions?.every((action) => action.ok) &&
          hugeFolder?.rapidScrollProbe?.diagnostics?.some(
            (entry) =>
              entry.totalCount === HUGE_FOLDER_COUNT &&
              entry.lastWindowStartIndex >= Math.floor(HUGE_FOLDER_COUNT * 0.6) &&
              entry.lastWindowRows > 0,
          ) &&
          hugeFolder?.rapidScrollProbe?.perfSummary?.coalescedEvents?.some(
            (entry) => entry?.tags?.mode === 'folder',
          ) &&
          hugeFolder?.rapidScrollProbe?.perfSummary?.staleIgnoredEvents?.some(
            (entry) => entry?.tags?.mode === 'folder',
          ),
        details: hugeFolder?.rapidScrollProbe,
      });
    }
  }
  if (ENABLED_SCENARIOS.has('many')) {
    checks.push(
      {
        name: 'many-folder picker caps rendered options and keeps filter available',
        ok:
          manyFolders?.seed?.ok === true &&
          manyFolders?.checkboxCount > 80 &&
          manyFolders?.checkboxCount <= 250 &&
          manyFolders?.filterInputCount === 1 &&
          manyFolders?.perfSummary?.maxTableSearchDocuments === 0 &&
          manyFolders?.perfSummary?.folderFacetEvents?.some(
            (entry) =>
              Number(entry?.value || 0) === Math.min(2000, MANY_FOLDER_COUNT) &&
              Number(entry?.tags?.totalDocuments || 0) === MANY_FOLDER_COUNT,
          ),
        details: manyFolders,
      },
      {
        name: 'many-folder selection remains source-backed',
        ok:
          manyFolders?.selectedFolderDiag?.totalCount === Math.ceil(MANY_FOLDER_COUNT / 2000) &&
          manyFolders?.selectedFolderDiag?.cachedRows > 0 &&
          manyFolders?.selectedFolderDiag?.cachedRows <= 720,
        details: manyFolders?.selectedFolderDiag,
      },
    );
  }
  checks.push({
    name: 'folder source windows stay inside latency budget',
    ok: results.every((result) => {
      const duration = Number(result.perfSummary?.maxFolderWindowDurationMs || 0);
      return duration > 0 && duration <= 2500;
    }),
    details: results.map((result) => ({
      name: result.name,
      maxFolderWindowDurationMs: result.perfSummary?.maxFolderWindowDurationMs,
      folderWindowEvents: result.perfSummary?.folderWindowEvents,
    })),
  });
  checks.push({
    name: 'folder source stress harness has no page errors',
    ok: allErrors.length === 0,
    details: { errors: allErrors },
  });
  const report = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    counts: {
      hugeFolder: HUGE_FOLDER_COUNT,
      manyFolders: MANY_FOLDER_COUNT,
    },
    rawRecordMode: RAW_RECORD_MODE,
    deepIndexProbe: DEEP_INDEX_PROBE,
    rapidFolderScrollProbe: RAPID_FOLDER_SCROLL_PROBE,
    scenarios: [...ENABLED_SCENARIOS],
    checks,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
