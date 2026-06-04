#!/usr/bin/env node
/* global process, console, window, document, Event */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/media-masonry-app.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const MEDIA_COUNT = Math.max(1, Number(process.env.SCROLLMARK_MEDIA_MASONRY_COUNT || 720));
const RAW_RECORD_MODE = ['complete', 'source-window'].includes(
  String(process.env.SCROLLMARK_MEDIA_MASONRY_RAW_RECORD_MODE || '').trim(),
)
  ? String(process.env.SCROLLMARK_MEDIA_MASONRY_RAW_RECORD_MODE).trim()
  : 'complete';
const CONTENT_PROFILE = ['default', 'variable-heights', 'sparse-media', 'dense-media'].includes(
  String(process.env.SCROLLMARK_MEDIA_MASONRY_CONTENT_PROFILE || '').trim(),
)
  ? String(process.env.SCROLLMARK_MEDIA_MASONRY_CONTENT_PROFILE).trim()
  : 'variable-heights';
const SKIP_EXPORT = ['1', 'true', 'yes'].includes(
  String(process.env.SCROLLMARK_MEDIA_MASONRY_SKIP_EXPORT || '')
    .trim()
    .toLowerCase(),
);

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Media Masonry Harness</title></head>
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

  await page.addInitScript(
    ({ rawRecordMode, contentProfile }) => {
      window.__META_DATA__ = { userId: 'media-masonry-harness' };
      window.unsafeWindow = window;
      window.__scrollmarkMediaMasonryRawRecordMode = rawRecordMode;
      window.__scrollmarkMediaMasonryContentProfile = contentProfile;
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
    },
    { rawRecordMode: RAW_RECORD_MODE, contentProfile: CONTENT_PROFILE },
  );

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

async function mediaState(page) {
  return await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('original tweet attachments only'),
    );
    const text = dialog?.textContent || '';
    const mediaMatch = text.match(/media\s+(\d+)\/(\d+)/);
    const scannedMatch = text.match(/scanned\s+(\d+)\/(\d+|\?)/);
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    const mediaEvents = events.filter(
      (entry) => entry?.kind === 'viewer' && entry?.name === 'media-source-scan',
    );
    const mediaDbEvents = events.filter(
      (entry) => entry?.kind === 'db' && entry?.name === 'search-document-media-cursor-page',
    );
    const maxScannedRows = mediaEvents.length
      ? Math.max(...mediaEvents.map((entry) => Number(entry?.tags?.scannedRowsTotal || 0)))
      : 0;
    const maxMediaItems = mediaEvents.length
      ? Math.max(...mediaEvents.map((entry) => Number(entry?.tags?.mediaItems || 0)))
      : 0;
    return {
      text,
      visibleMedia: mediaMatch ? Number(mediaMatch[1]) : 0,
      loadedMedia: mediaMatch ? Number(mediaMatch[2]) : 0,
      scannedRows: scannedMatch ? Number(scannedMatch[1]) : 0,
      sourceTotal: scannedMatch && scannedMatch[2] !== '?' ? Number(scannedMatch[2]) : null,
      cardCount: dialog?.querySelectorAll('article').length || 0,
      folderBadgeCount: Array.from(dialog?.querySelectorAll('.badge') || []).filter((item) =>
        /Folder|Synthetic/.test(item.textContent || ''),
      ).length,
      mediaEvents,
      mediaDbEvents,
      maxScannedRows,
      maxMediaItems,
    };
  });
}

async function mediaExportState(page) {
  return await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('Source-backed media'),
    );
    const text = dialog?.textContent || '';
    const scannedMatch = text.match(/rows scanned:\s*(\d+)(?:\/(\d+))?/i);
    const urlMatch = text.match(/media URLs:\s*(\d+)/i);
    const events = Array.isArray(window.__twe_perf_events_v1) ? window.__twe_perf_events_v1 : [];
    const scanEvents = events.filter(
      (entry) => entry?.kind === 'export' && entry?.name === 'media-export-source-scan',
    );
    return {
      text,
      rowsScanned: scannedMatch ? Number(scannedMatch[1]) : 0,
      sourceRows: scannedMatch?.[2] ? Number(scannedMatch[2]) : null,
      mediaUrls: urlMatch ? Number(urlMatch[1]) : 0,
      startExportDisabled: Boolean(
        dialog?.querySelector('button.btn-secondary[disabled], button.btn-secondary.btn-disabled'),
      ),
      scanEvents,
    };
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
      userCount: Math.min(200, Math.max(20, Math.floor(count / 10))),
      folderDistribution: 'mixed',
      rawRecordMode: window.__scrollmarkMediaMasonryRawRecordMode || 'complete',
      contentProfile: window.__scrollmarkMediaMasonryContentProfile || 'variable-heights',
      clearFirst: true,
    });
  }, MEDIA_COUNT);
  await openBookmarksTable(page, MEDIA_COUNT);

  const tableModal = page
    .locator('dialog.modal-open')
    .filter({ hasText: 'Synthetic bookmark' })
    .first();
  await tableModal.getByRole('button', { name: 'Media masonry' }).click();
  try {
    await page.waitForFunction(() => {
      const text = Array.from(document.querySelectorAll('dialog.modal-open'))
        .map((dialog) => dialog.textContent || '')
        .join('\n');
      return /media\s+[1-9]\d*\/[1-9]\d*/.test(text) && text.includes('scanned');
    });
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body.textContent?.slice(0, 4000) || '');
    console.error(
      JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          errors,
          recentConsole: consoleMessages.slice(-20),
          bodyText,
        },
        null,
        2,
      ),
    );
    throw error;
  }

  const initialMediaState = await mediaState(page);
  await tableModal.getByRole('button', { name: 'Compact density' }).click();
  await page.waitForTimeout(100);
  const compactMediaState = await mediaState(page);
  await tableModal.getByRole('button', { name: 'Comfortable density' }).click();
  await page.waitForTimeout(100);

  await tableModal.locator('main').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  const afterScrollMediaState = await mediaState(page);

  let mediaExport = null;
  if (!SKIP_EXPORT) {
    await tableModal.getByRole('button', { name: 'Export Media' }).click();
    await page.waitForFunction(
      () => {
        const text = Array.from(document.querySelectorAll('dialog.modal-open'))
          .map((dialog) => dialog.textContent || '')
          .join('\n');
        const events = Array.isArray(window.__twe_perf_events_v1)
          ? window.__twe_perf_events_v1
          : [];
        return (
          text.includes('Source-backed media') &&
          /media URLs:\s*[1-9]\d*/i.test(text) &&
          events.some(
            (entry) => entry?.kind === 'export' && entry?.name === 'media-export-source-scan',
          )
        );
      },
      null,
      { timeout: 60_000 },
    );
    mediaExport = await mediaExportState(page);
    await page
      .locator('dialog.modal-open')
      .filter({ hasText: 'Source-backed media' })
      .getByRole('button', { name: 'Cancel' })
      .click();
  }

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
  const maxTableHydrated = Math.max(
    0,
    ...perfEvents
      .filter((entry) => entry.kind === 'viewer' && entry.name === 'table-hydrated-records')
      .map((entry) => Number(entry.value || 0)),
  );
  const maxSearchDocuments = Math.max(
    0,
    ...perfEvents
      .filter((entry) => entry.kind === 'viewer' && entry.name === 'table-search-documents')
      .map((entry) => Number(entry.value || 0)),
  );

  const checks = [
    {
      name: 'synthetic app runtime seeds media fixture through the actual DB layer',
      ok:
        seed?.ok === true &&
        seed?.tweetCount === MEDIA_COUNT &&
        seed?.contentProfile === CONTENT_PROFILE &&
        seed?.rawRecordMode === RAW_RECORD_MODE,
      details: seed,
    },
    {
      name: 'media masonry opens from the built app and renders source-backed media cards',
      ok:
        initialMediaState.loadedMedia > 0 &&
        initialMediaState.cardCount > 0 &&
        initialMediaState.sourceTotal > 0 &&
        initialMediaState.sourceTotal <= MEDIA_COUNT &&
        initialMediaState.mediaDbEvents.length > 0,
      details: initialMediaState,
    },
    {
      name: 'density controls preserve the masonry view',
      ok:
        compactMediaState.loadedMedia >= initialMediaState.loadedMedia &&
        compactMediaState.cardCount > 0,
      details: compactMediaState,
    },
    {
      name: 'scrolling grows media incrementally without hydrating full table rows',
      ok:
        afterScrollMediaState.loadedMedia >= initialMediaState.loadedMedia &&
        afterScrollMediaState.maxScannedRows <=
          (afterScrollMediaState.sourceTotal || MEDIA_COUNT) &&
        maxTableHydrated <= 720 &&
        maxSearchDocuments === 0,
      details: {
        afterScrollMediaState,
        maxTableHydrated,
        maxSearchDocuments,
      },
    },
    ...(SKIP_EXPORT
      ? []
      : [
          {
            name: 'media export modal prepares source-backed media without full table rows',
            ok:
              mediaExport?.rowsScanned > 0 &&
              mediaExport?.mediaUrls > 0 &&
              mediaExport?.scanEvents.length > 0 &&
              mediaExport?.rowsScanned <= (mediaExport?.sourceRows || MEDIA_COUNT) &&
              maxTableHydrated <= 720 &&
              maxSearchDocuments === 0,
            details: {
              mediaExport,
              maxTableHydrated,
              maxSearchDocuments,
            },
          },
        ]),
    {
      name: 'media masonry app harness has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const report = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    count: MEDIA_COUNT,
    rawRecordMode: RAW_RECORD_MODE,
    contentProfile: CONTENT_PROFILE,
    skipExport: SKIP_EXPORT,
    checks,
    consoleMessages,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
