#!/usr/bin/env node
/* global process, console, window, document, HTMLElement, HTMLTableRowElement, Event, performance */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/variable-height-table.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const ROW_COUNT = Math.max(120, Number(process.env.SCROLLMARK_VARIABLE_HEIGHT_COUNT || 720));

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Variable Height Harness</title></head>
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
    window.__META_DATA__ = { userId: 'variable-height-table' };
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
        language: 'zh-Hans',
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

async function readPerfSummary(page) {
  return await page.evaluate(() => {
    const summary = window.__twe_perf_summary_v1;
    if (!summary || typeof summary !== 'object') return {};
    return {
      counters: summary.counters || {},
    };
  });
}

async function collectGeometry(page, label) {
  return await page.evaluate((sampleLabel) => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('Synthetic bookmark'),
    );
    const scrollArea = dialog?.querySelector('main');
    const rows = Array.from(dialog?.querySelectorAll('tbody tr[data-vrow="1"]') ?? []).filter(
      (row) => row instanceof HTMLTableRowElement,
    );
    const rects = rows.map((row) => {
      const rect = row.getBoundingClientRect();
      const text = row.textContent || '';
      return {
        key: row.dataset.vrowKey || '',
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        hasMedia: text.includes('Synthetic media thumbnail') || text.includes('ALT'),
      };
    });
    const cellOverflows = [];
    rows.forEach((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, cellIndex) => {
        const cellRect = cell.getBoundingClientRect();
        const scrollOverflow = cell.scrollWidth - cell.clientWidth;
        const descendants = Array.from(cell.querySelectorAll('*'));
        const visualOverflow = descendants.reduce(
          (worst, node) => {
            const rect = node.getBoundingClientRect();
            if (!rect.width && !rect.height) return worst;
            return {
              left: Math.min(worst.left, rect.left - cellRect.left),
              right: Math.max(worst.right, rect.right - cellRect.right),
            };
          },
          { left: 0, right: 0 },
        );
        if (scrollOverflow > 2 || visualOverflow.left < -2 || visualOverflow.right > 2) {
          cellOverflows.push({
            rowIndex,
            cellIndex,
            key: row.dataset.vrowKey || '',
            scrollOverflow,
            visualOverflow,
            text: (cell.textContent || '').slice(0, 160),
          });
        }
      });
    });
    const gaps = [];
    const overlaps = [];
    for (let index = 1; index < rects.length; index += 1) {
      const previous = rects[index - 1];
      const current = rects[index];
      const gap = current.top - previous.bottom;
      if (gap > 14) gaps.push({ index, gap, previous: previous.key, current: current.key });
      if (gap < -1) overlaps.push({ index, gap, previous: previous.key, current: current.key });
    }
    const heights = rects.map((row) => row.height);
    const visibleText = dialog?.textContent || '';
    const summary = Array.from(dialog?.querySelectorAll('.font-mono') ?? [])
      .map((item) => item.textContent || '')
      .filter(
        (text) => text.includes('rows') || text.includes('selected') || text.includes('rendered'),
      )
      .slice(-4);
    return {
      label: sampleLabel,
      rowCount: rects.length,
      scrollTop: scrollArea instanceof HTMLElement ? scrollArea.scrollTop : 0,
      scrollHeight: scrollArea instanceof HTMLElement ? scrollArea.scrollHeight : 0,
      clientHeight: scrollArea instanceof HTMLElement ? scrollArea.clientHeight : 0,
      minHeight: heights.length ? Math.min(...heights) : 0,
      maxHeight: heights.length ? Math.max(...heights) : 0,
      tallRows: rects.filter((row) => row.height >= 90).length,
      mediaRows: rects.filter((row) => row.hasMedia).length,
      gaps,
      overlaps,
      cellOverflows,
      translated: visibleText.includes('内容') && visibleText.includes('导出数据'),
      summary,
    };
  }, label);
}

async function scrollTableTo(page, ratio) {
  await page.evaluate((scrollRatio) => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('Synthetic bookmark'),
    );
    const scrollArea = dialog?.querySelector('main');
    if (scrollArea instanceof HTMLElement) {
      scrollArea.scrollTop = Math.max(
        0,
        (scrollArea.scrollHeight - scrollArea.clientHeight) * scrollRatio,
      );
      scrollArea.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }, ratio);
  await page.waitForTimeout(550);
}

async function stressScrollTable(page) {
  return await page.evaluate(async () => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('Synthetic bookmark'),
    );
    const scrollArea = dialog?.querySelector('main');
    if (!(scrollArea instanceof HTMLElement)) {
      return { ok: false, reason: 'table scroll area not found' };
    }

    const longFrames = [];
    const sampledWindows = [];
    let previousFrameAt = performance.now();
    for (let index = 0; index < 96; index += 1) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const now = performance.now();
      const frameMs = now - previousFrameAt;
      if (frameMs > 200) {
        longFrames.push({ index, frameMs });
      }
      previousFrameAt = now;

      const sweep = index % 32;
      const ratio = sweep < 16 ? sweep / 15 : (31 - sweep) / 15;
      scrollArea.scrollTop = Math.max(
        0,
        (scrollArea.scrollHeight - scrollArea.clientHeight) * ratio,
      );
      scrollArea.dispatchEvent(new Event('scroll', { bubbles: true }));

      if (index % 12 === 0) {
        const rows = Array.from(dialog.querySelectorAll('tbody tr[data-vrow="1"]')).filter(
          (row) => row instanceof HTMLTableRowElement,
        );
        const bufferingPlaceholders = Array.from(
          dialog.querySelectorAll('tbody tr[data-source-buffering-window="1"]'),
        ).filter((row) => row instanceof HTMLTableRowElement);
        const summary = Array.from(dialog.querySelectorAll('.font-mono'))
          .map((item) => item.textContent || '')
          .filter((text) => text.includes('rendered'))
          .slice(-1)[0];
        sampledWindows.push({
          index,
          rowCount: rows.length,
          bufferingPlaceholderCount: bufferingPlaceholders.length,
          scrollTop: scrollArea.scrollTop,
          summary,
        });
      }
    }

    await new Promise((resolve) => window.setTimeout(resolve, 450));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const rows = Array.from(dialog.querySelectorAll('tbody tr[data-vrow="1"]')).filter(
      (row) => row instanceof HTMLTableRowElement,
    );
    return {
      ok: true,
      rowCount: rows.length,
      scrollTop: scrollArea.scrollTop,
      scrollHeight: scrollArea.scrollHeight,
      clientHeight: scrollArea.clientHeight,
      longFrames,
      sampledWindows,
    };
  });
}

async function collectSearchHelpOverlay(page) {
  await page
    .locator('dialog.modal-open')
    .filter({ hasText: 'Synthetic bookmark' })
    .getByTitle('Search help')
    .click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('dialog.modal-open')).some((dialog) =>
      dialog.textContent?.includes('Query semantics'),
    ),
  );
  const state = await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('Query semantics'),
    );
    const box = dialog?.querySelector('.modal-box');
    const rect = box?.getBoundingClientRect();
    return {
      open: Boolean(dialog),
      width: rect?.width || 0,
      height: rect?.height || 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      clipped:
        !rect ||
        rect.left < -1 ||
        rect.top < -1 ||
        rect.right > window.innerWidth + 1 ||
        rect.bottom > window.innerHeight + 1,
    };
  });
  await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll('dialog.modal-open')).find((item) =>
      item.textContent?.includes('Query semantics'),
    );
    const closeButton = dialog?.querySelector('header .cursor-pointer');
    if (closeButton instanceof HTMLElement) closeButton.click();
  });
  await page.waitForTimeout(100);
  return state;
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
      userCount: 48,
      folderDistribution: 'mixed',
      contentProfile: 'variable-heights',
      clearFirst: true,
    });
  }, ROW_COUNT);

  await page.waitForFunction(() => document.querySelectorAll('.module-panel').length > 0, null, {
    timeout: 30_000,
  });
  const bookmarksPanel = page
    .locator('.module-panel')
    .filter({ hasText: /Bookmarks|书签/ })
    .first();
  await bookmarksPanel.locator('button').click();
  await page.waitForSelector('dialog.modal-open', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.modal-open');
    return Boolean(dialog?.textContent?.includes('Synthetic bookmark'));
  });

  const searchHelpOverlay = await collectSearchHelpOverlay(page);
  const normalTop = await collectGeometry(page, 'normal-top');
  await scrollTableTo(page, 0.5);
  const normalMiddle = await collectGeometry(page, 'normal-middle');
  await scrollTableTo(page, 0.98);
  const normalBottom = await collectGeometry(page, 'normal-bottom');

  const tableModal = page.locator('dialog.modal-open').filter({ hasText: 'Synthetic bookmark' });
  await tableModal.getByTitle('Fullscreen').click();
  await page.waitForTimeout(350);
  await scrollTableTo(page, 0);
  const fullscreenTop = await collectGeometry(page, 'fullscreen-top');
  await scrollTableTo(page, 0.7);
  const fullscreenDeep = await collectGeometry(page, 'fullscreen-deep');
  const scrollStress = await stressScrollTable(page);

  const samples = [normalTop, normalMiddle, normalBottom, fullscreenTop, fullscreenDeep];
  const perfEvents = await readPerfEvents(page);
  const perfSummary = await readPerfSummary(page);
  const tableVisibleEvents = perfEvents.filter(
    (entry) => entry?.kind === 'viewer' && entry?.name === 'table-visible-rows',
  );
  const rowHeightCacheEvents = perfEvents.filter(
    (entry) => entry?.kind === 'viewer' && entry?.name === 'table-row-height-cache',
  );
  const longTasks = perfEvents.filter(
    (entry) => entry?.kind === 'longtask' && Number(entry?.durationMs || 0) > 250,
  );

  const checks = [
    {
      name: 'variable-height synthetic fixture seeds through the app DB layer',
      ok:
        seed?.ok === true &&
        seed?.tweetCount === ROW_COUNT &&
        seed?.contentProfile === 'variable-heights',
      details: seed,
    },
    {
      name: 'translated table UI renders while variable-height rows are visible',
      ok: samples.some((sample) => sample.translated),
      details: samples.map(({ label, translated, summary }) => ({ label, translated, summary })),
    },
    {
      name: 'search help opens as a large unclipped overlay from the small explorer',
      ok:
        searchHelpOverlay.open &&
        searchHelpOverlay.width >= 800 &&
        searchHelpOverlay.height >= 600 &&
        !searchHelpOverlay.clipped,
      details: searchHelpOverlay,
    },
    {
      name: 'normal viewport variable-height rows do not overlap or leave persistent gaps',
      ok:
        [normalTop, normalMiddle, normalBottom].every(
          (sample) =>
            sample.rowCount > 0 &&
            sample.overlaps.length === 0 &&
            sample.gaps.length === 0 &&
            sample.cellOverflows.length === 0,
        ) && [normalTop, normalMiddle, normalBottom].some((sample) => sample.tallRows > 0),
      details: [normalTop, normalMiddle, normalBottom],
    },
    {
      name: 'fullscreen viewport variable-height rows do not overlap or leave persistent gaps',
      ok:
        [fullscreenTop, fullscreenDeep].every(
          (sample) =>
            sample.rowCount > 0 &&
            sample.overlaps.length === 0 &&
            sample.gaps.length === 0 &&
            sample.cellOverflows.length === 0,
        ) && [fullscreenTop, fullscreenDeep].some((sample) => sample.tallRows > 0),
      details: [fullscreenTop, fullscreenDeep],
    },
    {
      name: 'variable-height virtualizer reports bounded visible rows without long table stalls',
      ok:
        tableVisibleEvents.length > 0 &&
        Math.max(...tableVisibleEvents.map((entry) => Number(entry?.value || 0))) <= 90 &&
        longTasks.length === 0,
      details: { tableVisibleEvents: tableVisibleEvents.slice(-20), longTasks },
    },
    {
      name: 'repeated table scroll sweeps remain responsive and bounded',
      ok:
        scrollStress.ok === true &&
        scrollStress.rowCount > 0 &&
        scrollStress.rowCount <= 90 &&
        scrollStress.longFrames.length === 0 &&
        scrollStress.sampledWindows.every(
          (sample) =>
            sample.rowCount <= 90 &&
            (!sample.summary?.includes('buffering') ||
              sample.rowCount > 0 ||
              sample.bufferingPlaceholderCount > 0),
        ),
      details: scrollStress,
    },
    {
      name: 'measured row-height cache is populated and bounded',
      ok:
        (rowHeightCacheEvents.length > 0 ||
          Number(perfSummary.counters?.['viewer:table-row-height-cache:count'] || 0) > 0) &&
        (rowHeightCacheEvents.length === 0 ||
          (Math.max(...rowHeightCacheEvents.map((entry) => Number(entry?.value || 0))) > 0 &&
            rowHeightCacheEvents.every(
              (entry) =>
                Number(entry?.value || 0) <= Number(entry?.tags?.limit || 0) &&
                Number(entry?.tags?.limit || 0) === 2500,
            ))),
      details: {
        rowHeightCacheEvents: rowHeightCacheEvents.slice(-20),
        rowHeightCacheSummaryCount:
          perfSummary.counters?.['viewer:table-row-height-cache:count'] || 0,
      },
    },
    {
      name: 'variable-height harness has no page errors',
      ok: errors.length === 0,
      details: { errors },
    },
  ];

  const report = {
    ok: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    count: ROW_COUNT,
    checks,
    samples,
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
