#!/usr/bin/env node
/* global process, console, window, document, Blob */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { strFromU8, unzipSync } from 'fflate';

const [, , outPathArg = 'e2e/perf/out/app-diagnostics-smoke.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark App Diagnostics Smoke</title></head>
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
    window.__META_DATA__ = { userId: 'app-diagnostics-smoke' };
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

  const firstSeed = await page.evaluate(async () => {
    return await window.__scrollmarkSyntheticDb.seedBookmarks({
      count: 1000,
      userCount: 100,
      folderDistribution: 'mixed',
      clearFirst: true,
    });
  });

  await page.waitForFunction(() => document.body.innerText.includes('Bookmarks'), null, {
    timeout: 10_000,
  });
  await page.waitForFunction(() => document.body.innerText.includes('Captured: 1000'), null, {
    timeout: 15_000,
  });

  const bookmarksPanel = page.locator('.module-panel').filter({ hasText: 'Bookmarks' }).first();
  await bookmarksPanel.locator('button').click();
  await page.waitForSelector('dialog.modal-open', { timeout: 10_000 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    return Boolean(dialog && dialog.textContent?.includes('Synthetic bookmark'));
  });

  const firstDiagnostics = normalizeDiagnostics(
    await page.evaluate(() => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      return map instanceof Map ? Array.from(map.values()) : [];
    }),
  );
  const initialVisibleRows = await page.locator('dialog.modal-open tbody tr').count();
  await page.locator('dialog.modal-open .dropdown').first().click();
  const folderCheckboxes = page.locator('dialog.modal-open .dropdown input[type="checkbox"]');
  await folderCheckboxes.nth(0).check();
  await folderCheckboxes.nth(1).check();
  await page.waitForFunction(() => {
    const map = window.__scrollmark_result_source_diagnostics_v1;
    if (!(map instanceof Map)) return false;
    return Array.from(map.values()).some(
      (entry) =>
        entry?.mode === 'folder' &&
        Array.isArray(entry?.descriptor?.folderIds) &&
        entry.descriptor.folderIds.length === 2 &&
        Number(entry?.cachedRows || 0) > 0,
    );
  });
  const multiFolderDiagnostics = normalizeDiagnostics(
    await page.evaluate(() => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      return map instanceof Map ? Array.from(map.values()) : [];
    }),
  );
  await folderCheckboxes.nth(0).uncheck();
  await folderCheckboxes.nth(1).uncheck();

  const secondSeed = await page.evaluate(async () => {
    return await window.__scrollmarkSyntheticDb.seedBookmarks({
      count: 1200,
      userCount: 120,
      folderDistribution: 'mixed',
      clearFirst: true,
    });
  });

  await page.waitForFunction(() => document.body.innerText.includes('Captured: 1200'), null, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => {
    const map = window.__scrollmark_result_source_diagnostics_v1;
    if (!(map instanceof Map)) return false;
    return Array.from(map.values()).some(
      (entry) => entry?.mode === 'captures' && Number(entry?.totalCount || 0) === 1200,
    );
  });

  const finalDiagnostics = normalizeDiagnostics(
    await page.evaluate(() => {
      const map = window.__scrollmark_result_source_diagnostics_v1;
      return map instanceof Map ? Array.from(map.values()) : [];
    }),
  );
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
  const recordLookupEvents = perfEvents.filter(
    (entry) => entry.kind === 'viewer' && entry.name === 'table-record-lookup-ids',
  );
  const maxRecordLookupIds = recordLookupEvents.length
    ? Math.max(...recordLookupEvents.map((entry) => Number(entry.value || 0)))
    : 0;
  const maxRecordLookupSourceRecords = recordLookupEvents.length
    ? Math.max(...recordLookupEvents.map((entry) => Number(entry.tags?.records || 0)))
    : 0;
  const captureDiag1000 = firstDiagnostics.find(
    (entry) => entry.mode === 'captures' && entry.totalCount === 1000,
  );
  const captureDiag1200 = finalDiagnostics.find(
    (entry) => entry.mode === 'captures' && entry.totalCount === 1200,
  );
  const multiFolderDiag = multiFolderDiagnostics.find((entry) => {
    try {
      const parsed = JSON.parse(entry.sourceKey);
      return (
        entry.mode === 'folder' && Array.isArray(parsed.folderIds) && parsed.folderIds.length === 2
      );
    } catch {
      return false;
    }
  });
  const diagnosticsExport = await page.evaluate(async () => {
    const exportDiagnostics =
      window.__scrollmark_export_diagnostics_bundle_zip_v1 ||
      window.__scrollmark_collect_diagnostics_bundle_v1;
    if (typeof exportDiagnostics !== 'function') {
      return { ok: false, error: 'diagnostics harness global missing' };
    }
    const result = await exportDiagnostics();
    if (result instanceof Blob) {
      const bytes = Array.from(new Uint8Array(await result.arrayBuffer()));
      return { ok: true, kind: 'zip', size: result.size, type: result.type, bytes };
    }
    return { ok: true, kind: 'json', size: 0, type: 'application/json', payload: result };
  });
  const diagnosticsZip =
    diagnosticsExport.kind === 'zip'
      ? unzipSync(Uint8Array.from(diagnosticsExport.bytes ?? []))
      : {};
  const diagnosticsSummaryRaw = diagnosticsZip['summary.json'];
  const diagnosticsSummary =
    diagnosticsExport.kind === 'json'
      ? diagnosticsExport.payload
      : diagnosticsSummaryRaw
        ? JSON.parse(strFromU8(diagnosticsSummaryRaw))
        : null;
  const bundledCaptureDiag = Array.isArray(diagnosticsSummary?.result_sources)
    ? diagnosticsSummary.result_sources.find(
        (entry) => entry?.mode === 'captures' && Number(entry?.totalCount || 0) === 1200,
      )
    : null;
  const bundledPerformanceCounters =
    diagnosticsSummary?.performance && typeof diagnosticsSummary.performance === 'object'
      ? diagnosticsSummary.performance.counters || {}
      : {};

  const checks = [
    {
      name: 'userscript app mounts on a local host page',
      ok: await page
        .locator('#twe-root')
        .count()
        .then((count) => count === 1),
      details: { url },
    },
    {
      name: 'synthetic app runtime seeds bookmark records through the actual DB layer',
      ok:
        firstSeed?.ok === true &&
        firstSeed?.tweetCount === 1000 &&
        firstSeed?.searchDocumentCount === 1100,
      details: firstSeed,
    },
    {
      name: 'Bookmarks table opens and renders rows from the actual app',
      ok: initialVisibleRows > 0,
      details: { visibleRows: initialVisibleRows },
    },
    {
      name: 'app table open records capture result-source diagnostics',
      ok:
        captureDiag1000 !== undefined &&
        captureDiag1000.cachedRows > 0 &&
        captureDiag1000.cachedRows <= 720,
      details: { captureDiag1000, firstDiagnostics },
    },
    {
      name: 'multi-folder selection stays source-backed in the actual app',
      ok:
        multiFolderDiag !== undefined &&
        multiFolderDiag.cachedRows > 0 &&
        multiFolderDiag.cachedRows <= 720,
      details: { multiFolderDiag, multiFolderDiagnostics },
    },
    {
      name: 'source diagnostics update after a DB mutation while the table is open',
      ok:
        secondSeed?.ok === true &&
        secondSeed?.tweetCount === 1200 &&
        captureDiag1200 !== undefined &&
        captureDiag1200.cachedRows > 0 &&
        captureDiag1200.cachedRows <= 720,
      details: { secondSeed, captureDiag1200, finalDiagnostics },
    },
    {
      name: 'app runtime records viewer/database performance events',
      ok:
        perfEvents.some((entry) => entry.kind === 'viewer') &&
        perfEvents.some((entry) => entry.kind === 'db'),
      details: {
        recent: perfEvents.slice(-20),
      },
    },
    {
      name: 'table record lookup map stays bounded during source-backed browsing',
      ok:
        recordLookupEvents.length > 0 &&
        maxRecordLookupIds > 0 &&
        maxRecordLookupIds <= 2500 &&
        maxRecordLookupSourceRecords <= 720,
      details: {
        maxRecordLookupIds,
        maxRecordLookupSourceRecords,
        recordLookupEvents,
      },
    },
    {
      name: 'exported diagnostics bundle includes source and performance evidence',
      ok:
        diagnosticsExport.ok === true &&
        diagnosticsExport.size > 0 &&
        diagnosticsSummary !== null &&
        bundledCaptureDiag !== null &&
        Number(bundledCaptureDiag?.cachedRows || 0) > 0 &&
        Number(bundledCaptureDiag?.cachedRows || 0) <= 720 &&
        Number(bundledPerformanceCounters['viewer:table-record-lookup-ids:count'] || 0) > 0 &&
        Number(bundledPerformanceCounters['viewer:table-search-documents:value'] || 0) === 0,
      details: {
        kind: diagnosticsExport.kind,
        size: diagnosticsExport.size,
        bundledCaptureDiag,
        performanceCounters: bundledPerformanceCounters,
        zipFiles: Object.keys(diagnosticsZip),
      },
    },
    {
      name: 'app diagnostics smoke has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const payload = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    checks,
    firstDiagnostics,
    multiFolderDiagnostics,
    finalDiagnostics,
    consoleMessages: consoleMessages.slice(-80),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
} finally {
  await browser.close();
  server.close();
}
