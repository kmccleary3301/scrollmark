#!/usr/bin/env node
/* global console, process, Buffer, document, window, Event */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const [, , recordsPathArg, outPathArg] = process.argv;
if (!recordsPathArg || !outPathArg) {
  console.error(
    'usage: node e2e/perf/browser_viewer_scroll_harness.mjs <records.json> <out.json> [--browsers=chromium,firefox]',
  );
  process.exit(2);
}

const recordsPath = path.resolve(recordsPathArg);
const outPath = path.resolve(outPathArg);
const browserArg = process.argv.find((arg) => arg.startsWith('--browsers='));
const requestedBrowsers = (browserArg ? browserArg.split('=')[1] : 'chromium,firefox')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function normalizeRecord(record, index) {
  const id = String(
    record.rest_id || record.id || record.id_str || record?.legacy?.id_str || index,
  );
  const text = String(
    record.full_text || record.text || record?.legacy?.full_text || record?.legacy?.text || '',
  );
  const folderName = String(
    record.bookmark_folder_name ||
      record.__bookmark_folder_name ||
      record.folder_name ||
      ['Research Revisit 02', 'Cool Art', 'Design 02', 'AI Lab Rumors'][index % 4],
  );
  const folderId = String(
    record.bookmark_folder_id ||
      record.__bookmark_folder_id ||
      record.folder_id ||
      `folder-${folderName}`,
  );
  const media = Array.isArray(record.media)
    ? record.media
    : Array.isArray(record?.legacy?.extended_entities?.media)
      ? record.legacy.extended_entities.media
      : [];
  const mediaCount = media.length || (index % 3 === 0 ? 1 : 0);
  return {
    id,
    index,
    text:
      text ||
      `Synthetic variable-height tweet ${index}. Full writeup on how browser viewer virtualization should stay smooth.`,
    folderId,
    folderName,
    author: String(
      record.screen_name ||
        record?.core?.user_results?.result?.core?.screen_name ||
        `user_${index % 41}`,
    ),
    createdAt: String(
      record.created_at ||
        record?.legacy?.created_at ||
        new Date(Date.now() - index * 60000).toUTCString(),
    ),
    mediaCount,
    favoriteCount: Number(record.favorite_count || record?.legacy?.favorite_count || index % 10000),
    retweetCount: Number(record.retweet_count || record?.legacy?.retweet_count || index % 500),
  };
}

const raw = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
const records = asArray(raw)
  .map(normalizeRecord)
  .slice(0, Number(process.env.VIEWER_HARNESS_MAX_RECORDS || 25000));
if (!records.length) {
  throw new Error(`No records found in ${recordsPath}`);
}

function createServer(payload) {
  const html = buildHtml();
  const server = http.createServer((request, response) => {
    if (request.url === '/records.json') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(payload));
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
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

function buildHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Scrollmark Browser Viewer Perf Harness</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #20222d; color: #eef1ff; }
    * { box-sizing: border-box; }
    body { margin: 0; overflow: hidden; }
    .shell { height: 100vh; display: flex; flex-direction: column; padding: 10px; gap: 8px; }
    .toolbar { display: flex; align-items: center; gap: 10px; min-height: 36px; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .toolbar button, .toolbar select { background: #303342; color: #eef1ff; border: 1px solid #55596b; border-radius: 8px; padding: 6px 9px; }
    .viewport { flex: 1; min-height: 0; overflow: auto; border: 1px solid #363a49; border-radius: 10px; background: #242632; position: relative; }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; }
    thead { position: sticky; top: 0; z-index: 2; background: #292c38; }
    th, td { border-bottom: 1px solid #3b3f50; padding: 8px 10px; vertical-align: middle; font-size: 12px; }
    th { text-align: left; color: #bec4d7; }
    td.id { width: 12%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: #c9d1ff; }
    td.text { width: 42%; line-height: 1.45; }
    td.media { width: 14%; }
    td.meta { width: 16%; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .media-box { display: inline-block; width: 46px; height: 36px; margin-right: 4px; border-radius: 6px; background: linear-gradient(135deg, #e86aa9, #7ac7ff); opacity: .88; }
    .spacer td { padding: 0 !important; border: 0 !important; }
    .masonry { padding: 12px; column-gap: 14px; }
    .card { break-inside: avoid; margin: 0 0 14px; border: 1px solid #363a49; border-radius: 16px; overflow: hidden; background: #292c38; box-shadow: 0 8px 18px rgba(0,0,0,.18); }
    .thumb { background: linear-gradient(135deg, #ec6cae, #55c4e8 45%, #f4cf6a); min-height: 170px; display: flex; align-items: end; padding: 10px; font-weight: 800; color: white; text-shadow: 0 1px 5px #000; }
    .card-body { padding: 10px 12px; font-size: 12px; line-height: 1.45; }
    .folder { display: inline-block; margin: 6px 0; padding: 2px 7px; border: 1px solid #8f95aa; border-radius: 999px; font-size: 11px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <button id="tableBtn">Table</button>
      <button id="masonryBtn">Masonry</button>
      <select id="folderSelect"><option value="">All folders</option></select>
      <span id="stats">loading</span>
    </div>
    <main id="viewport" class="viewport"></main>
  </div>
<script>
(() => {
  const INITIAL_PAGE = 160;
  const NEXT_PAGE = 320;
  const WARM_TARGET = 960;
  const MAX_WINDOW_ROWS = 90;
  const OVERSCAN_ROWS = 12;
  const OVERSCAN_PX = 1600;
  const INITIAL_ROW_HEIGHT = 74;
  const MASONRY_INITIAL = 42;
  const MASONRY_BATCH = 36;
  const MASONRY_THRESHOLD = 1200;
  const state = {
    allRecords: [], loadedRecords: [], mode: 'table', folderId: '', scrollTop: 0,
    rowHeights: new Map(), estimatedRowHeight: INITIAL_ROW_HEIGHT, raf: 0, masonryVisible: MASONRY_INITIAL,
    renderCount: 0, loadCount: 0, longTasks: [], frameDeltas: [], blankViolations: [], duplicateViolations: [], orderViolations: [],
    memorySamples: [], lastFrame: performance.now(), lastMinIndex: -1, maxVisibleIndexEver: -1,
  };
  window.__viewerHarness = state;
  if ('PerformanceObserver' in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push({ duration: entry.duration, startTime: entry.startTime });
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {}
  }
  const frameLoop = (now) => {
    state.frameDeltas.push(now - state.lastFrame);
    if (state.frameDeltas.length > 2400) state.frameDeltas.shift();
    state.lastFrame = now;
    requestAnimationFrame(frameLoop);
  };
  requestAnimationFrame(frameLoop);
  setInterval(() => {
    const mem = performance.memory || null;
    state.memorySamples.push({ t: performance.now(), used: mem ? mem.usedJSHeapSize : null, total: mem ? mem.totalJSHeapSize : null });
  }, 250);

  const viewport = document.getElementById('viewport');
  const stats = document.getElementById('stats');
  const folderSelect = document.getElementById('folderSelect');
  const tableBtn = document.getElementById('tableBtn');
  const masonryBtn = document.getElementById('masonryBtn');

  function filteredAll() {
    return state.folderId ? state.allRecords.filter((r) => r.folderId === state.folderId) : state.allRecords;
  }
  function filteredLoaded() {
    const full = filteredAll();
    if (state.folderId) return full.slice(0, Math.max(state.loadedRecords.length, INITIAL_PAGE));
    return state.loadedRecords;
  }
  function hydrateForFolder() {
    if (!state.folderId) return;
    const full = filteredAll();
    const wanted = Math.min(full.length, Math.max(INITIAL_PAGE, state.loadedRecords.length, WARM_TARGET));
    state.loadedRecords = full.slice(0, wanted);
  }
  function loadMore() {
    const source = filteredAll();
    const current = state.folderId ? state.loadedRecords.length : state.loadedRecords.length;
    if (current >= source.length) return;
    state.loadCount += 1;
    const next = source.slice(0, Math.min(source.length, current + NEXT_PAGE));
    state.loadedRecords = next;
  }
  function warmLoad() {
    while (state.loadedRecords.length < Math.min(WARM_TARGET, filteredAll().length)) loadMore();
  }
  function rowKey(record, index) { return record.id + '::' + index; }
  function offsets(records) {
    const out = new Array(records.length + 1); out[0] = 0;
    for (let i = 0; i < records.length; i++) {
      const h = state.rowHeights.get(rowKey(records[i], i)) || state.estimatedRowHeight;
      out[i + 1] = out[i] + Math.max(24, h);
    }
    return out;
  }
  function findIndex(values, offset) {
    if (offset <= 0 || values.length <= 1) return 0;
    let low = 0, high = values.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if ((values[mid] || 0) <= offset) low = mid; else high = mid - 1;
    }
    return Math.max(0, Math.min(values.length - 2, low));
  }
  function variableText(record) {
    const repeat = 1 + (record.index % 7);
    return Array.from({ length: repeat }, () => record.text).join(' ');
  }
  function renderTable() {
    const records = filteredLoaded();
    const off = offsets(records);
    const totalHeight = off[records.length] || 0;
    const top = viewport.scrollTop;
    const start = Math.max(0, findIndex(off, top - OVERSCAN_PX) - OVERSCAN_ROWS);
    const requestedEnd = findIndex(off, top + viewport.clientHeight + OVERSCAN_PX) + OVERSCAN_ROWS + 1;
    const end = Math.min(records.length, Math.max(start + 1, Math.min(requestedEnd, start + MAX_WINDOW_ROWS)));
    const visible = records.slice(start, end);
    const topSpacer = off[start] || 0;
    const bottomSpacer = Math.max(0, totalHeight - (off[end] || totalHeight));
    viewport.innerHTML = '<table><thead><tr><th>ID</th><th>Text</th><th>Media</th><th>Folder</th><th>Stats</th></tr></thead><tbody>' +
      (topSpacer ? '<tr class="spacer"><td colspan="5" style="height:' + topSpacer + 'px"></td></tr>' : '') +
      visible.map((r, i) => '<tr class="row" data-index="' + (start + i) + '" data-id="' + r.id + '">' +
        '<td class="id">' + r.id + '</td><td class="text">' + escapeHtml(variableText(r)) + '</td>' +
        '<td class="media">' + Array.from({ length: Math.min(4, r.mediaCount) }, () => '<span class="media-box"></span>').join('') + '</td>' +
        '<td>' + escapeHtml(r.folderName) + '</td><td class="meta">' + r.favoriteCount + ' fav<br>' + r.retweetCount + ' rt</td></tr>').join('') +
      (bottomSpacer ? '<tr class="spacer"><td colspan="5" style="height:' + bottomSpacer + 'px"></td></tr>' : '') +
      '</tbody></table>';
    state.renderCount += 1;
    requestAnimationFrame(() => measureRows(records, start));
    updateStats(records.length, filteredAll().length, visible.length, start, end);
  }
  function measureRows(records, start) {
    const rows = [...viewport.querySelectorAll('tr.row')];
    let total = 0, count = 0, changed = false;
    const seen = new Set();
    let minIndex = Infinity;
    for (const row of rows) {
      const idx = Number(row.dataset.index);
      minIndex = Math.min(minIndex, idx);
      if (seen.has(row.dataset.id)) state.duplicateViolations.push({ mode: 'table', id: row.dataset.id, scrollTop: viewport.scrollTop });
      seen.add(row.dataset.id);
      const rect = row.getBoundingClientRect();
      total += rect.height; count += 1;
      const key = rowKey(records[idx], idx);
      const prev = state.rowHeights.get(key);
      if (!prev || Math.abs(prev - rect.height) > 2) { state.rowHeights.set(key, rect.height); changed = true; }
    }
    if (count) {
      const avg = total / count;
      if (Math.abs(avg - state.estimatedRowHeight) > 3) state.estimatedRowHeight = state.estimatedRowHeight * .85 + avg * .15;
    }
    validateVisible('table');
    if (Number.isFinite(minIndex) && minIndex + 3 < state.lastMinIndex) state.orderViolations.push({ mode: 'table', minIndex, previous: state.lastMinIndex });
    if (Number.isFinite(minIndex)) state.lastMinIndex = Math.max(state.lastMinIndex, minIndex);
    if (changed) scheduleRender();
  }
  function renderMasonry() {
    const all = filteredAll().filter((r) => r.mediaCount > 0);
    const wanted = Math.min(all.length, state.masonryVisible);
    const visible = all.slice(0, wanted);
    const folderTotal = all.length;
    const width = viewport.clientWidth || 1200;
    const columns = Math.max(1, Math.min(6, Math.floor(width / 300)));
    viewport.innerHTML = '<div class="masonry" style="column-count:' + columns + '">' +
      visible.map((r, index) => '<article class="card" data-index="' + index + '" data-id="' + r.id + '">' +
        '<div class="thumb" style="height:' + (150 + (r.index % 8) * 34) + 'px">PHOTO</div>' +
        '<div class="card-body"><strong>@' + escapeHtml(r.author) + '</strong><br><span class="folder">' + escapeHtml(r.folderName) + '</span><p>' + escapeHtml(variableText(r)).slice(0, 480) + '</p></div></article>').join('') +
      '</div>';
    state.renderCount += 1;
    updateStats(visible.length, folderTotal, visible.length, 0, visible.length);
    validateVisible('masonry');
  }
  function render() { state.mode === 'table' ? renderTable() : renderMasonry(); }
  function scheduleRender() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => { state.raf = 0; render(); });
  }
  function validateVisible(mode) {
    const viewRect = viewport.getBoundingClientRect();
    const selector = mode === 'table' ? 'tr.row' : '.card';
    const nodes = [...viewport.querySelectorAll(selector)];
    const visible = nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom >= viewRect.top && rect.top <= viewRect.bottom;
    });
    if (!visible.length && nodes.length) state.blankViolations.push({ mode, scrollTop: viewport.scrollTop, rendered: nodes.length });
    const ids = new Set();
    for (const node of nodes) {
      const id = node.dataset.id;
      if (ids.has(id)) state.duplicateViolations.push({ mode, id, scrollTop: viewport.scrollTop });
      ids.add(id);
    }
  }
  function updateStats(loaded, total, rendered, start, end) {
    stats.textContent = state.mode + ' loaded ' + loaded + '/' + total + ' rendered ' + rendered + ' window ' + start + '-' + end + ' longTasks ' + state.longTasks.length;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function onScroll() {
    if (state.mode === 'table') {
      const records = filteredLoaded();
      const remaining = viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight);
      if (remaining < Math.max(1200, viewport.clientHeight * 4)) loadMore();
      scheduleRender();
    } else {
      const remaining = viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight);
      if (remaining < MASONRY_THRESHOLD) {
        const before = state.masonryVisible;
        state.masonryVisible = Math.min(filteredAll().filter((r) => r.mediaCount > 0).length, state.masonryVisible + MASONRY_BATCH);
        if (state.masonryVisible !== before) scheduleRender();
      }
    }
  }
  viewport.addEventListener('scroll', onScroll, { passive: true });
  tableBtn.onclick = () => { state.mode = 'table'; viewport.scrollTop = 0; state.lastMinIndex = -1; render(); };
  masonryBtn.onclick = () => { state.mode = 'masonry'; viewport.scrollTop = 0; state.masonryVisible = MASONRY_INITIAL; render(); };
  folderSelect.onchange = () => {
    state.folderId = folderSelect.value;
    viewport.scrollTop = 0;
    state.masonryVisible = MASONRY_INITIAL;
    if (state.folderId) hydrateForFolder(); else state.loadedRecords = state.allRecords.slice(0, Math.min(INITIAL_PAGE, state.allRecords.length));
    warmLoad();
    render();
  };
  fetch('/records.json').then((res) => res.json()).then((records) => {
    state.allRecords = records;
    state.loadedRecords = records.slice(0, Math.min(INITIAL_PAGE, records.length));
    const folders = new Map();
    for (const row of records) folders.set(row.folderId, { id: row.folderId, name: row.folderName, count: (folders.get(row.folderId)?.count || 0) + 1 });
    [...folders.values()].sort((a, b) => b.count - a.count).forEach((folder) => {
      const option = document.createElement('option'); option.value = folder.id; option.textContent = folder.name + ' (' + folder.count + ')'; folderSelect.appendChild(option);
    });
    warmLoad(); render(); window.__viewerHarnessReady = true;
  });
})();
</script>
</body>
</html>`;
}

function summarizeFrameDeltas(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const pick = (p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
  return {
    count: sorted.length,
    p50_ms: Number((pick(0.5) || 0).toFixed(2)),
    p95_ms: Number((pick(0.95) || 0).toFixed(2)),
    p99_ms: Number((pick(0.99) || 0).toFixed(2)),
    max_ms: Number((sorted.at(-1) || 0).toFixed(2)),
  };
}

async function scrollViewport(page, steps, stepPx) {
  for (let index = 0; index < steps; index += 1) {
    await page.evaluate((delta) => {
      const viewport = document.getElementById('viewport');
      viewport.scrollTop = Math.min(viewport.scrollHeight, viewport.scrollTop + delta);
      viewport.dispatchEvent(new Event('scroll'));
    }, stepPx);
    await page.waitForTimeout(32);
  }
}

async function runBrowser(browserName, serverUrl) {
  const launcher = browserName === 'firefox' ? firefox : chromium;
  const browser = await launcher.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error?.stack || error?.message || error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const started = Date.now();
  await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewerHarnessReady === true, null, { timeout: 20000 });
  const initMs = Date.now() - started;

  await scrollViewport(page, 80, 520);
  const snapshot = () =>
    page.evaluate(() => {
      const state = window.__viewerHarness;
      return {
        mode: state.mode,
        records: state.allRecords.length,
        loadedRecords: state.loadedRecords.length,
        renderCount: state.renderCount,
        loadCount: state.loadCount,
        longTasks: state.longTasks,
        frameDeltas: state.frameDeltas,
        blankViolations: state.blankViolations,
        duplicateViolations: state.duplicateViolations,
        orderViolations: state.orderViolations,
        memorySamples: state.memorySamples,
        statsText: document.getElementById('stats')?.textContent || '',
        visibleRows: document.querySelectorAll('tr.row').length,
        visibleCards: document.querySelectorAll('.card').length,
      };
    });
  const tableSnapshot = await snapshot();

  await page.click('#masonryBtn');
  await scrollViewport(page, 70, 760);
  const masonryAllSnapshot = await snapshot();

  const largeFolder = await page.evaluate(() => {
    const select = document.getElementById('folderSelect');
    const options = [...select.options].slice(1).map((option) => {
      const match = option.textContent.match(/\((\d+)\)$/);
      return {
        value: option.value,
        label: option.textContent,
        count: match ? Number(match[1]) : 0,
      };
    });
    return options.sort((a, b) => b.count - a.count)[0] || null;
  });
  let masonryFolderSnapshot = null;
  if (largeFolder) {
    await page.selectOption('#folderSelect', largeFolder.value);
    await page.click('#masonryBtn');
    await scrollViewport(page, 80, 760);
    masonryFolderSnapshot = await snapshot();
  }
  await browser.close();

  const allLongTasks = [
    ...(tableSnapshot.longTasks || []),
    ...(masonryAllSnapshot.longTasks || []),
    ...((masonryFolderSnapshot && masonryFolderSnapshot.longTasks) || []),
  ];
  const maxLongTaskMs = Math.max(0, ...allLongTasks.map((entry) => Number(entry.duration) || 0));
  const frameSummary = summarizeFrameDeltas(
    masonryFolderSnapshot?.frameDeltas ||
      masonryAllSnapshot.frameDeltas ||
      tableSnapshot.frameDeltas ||
      [],
  );
  const folderTotal = largeFolder?.count || 0;
  const folderStats = masonryFolderSnapshot
    ? await Promise.resolve({
        blankViolations: masonryFolderSnapshot.blankViolations?.length || 0,
        duplicateViolations: masonryFolderSnapshot.duplicateViolations?.length || 0,
      })
    : null;

  const gates = {
    no_page_errors: errors.length === 0,
    initial_ready_under_3000_ms: initMs < 3000,
    no_blank_windows:
      (masonryFolderSnapshot?.blankViolations?.length ||
        masonryAllSnapshot.blankViolations?.length ||
        tableSnapshot.blankViolations?.length ||
        0) === 0,
    no_duplicate_visible_ids:
      (masonryFolderSnapshot?.duplicateViolations?.length ||
        masonryAllSnapshot.duplicateViolations?.length ||
        tableSnapshot.duplicateViolations?.length ||
        0) === 0,
    max_long_task_under_250_ms: maxLongTaskMs < 250,
    p95_frame_under_80_ms: frameSummary.p95_ms < 80,
    large_folder_available: folderTotal >= 1000,
    large_folder_masonry_not_trimmed_to_loaded_page: folderTotal
      ? (masonryFolderSnapshot?.visibleCards || 0) > 160
      : null,
  };

  return {
    ok: Object.values(gates).every((value) => value === true || value === null),
    browser: browserName,
    records: records.length,
    init_ms: initMs,
    max_long_task_ms: Number(maxLongTaskMs.toFixed(2)),
    frame_summary: frameSummary,
    large_folder: largeFolder,
    table: {
      loaded: tableSnapshot.loadedRecords || 0,
      renders: tableSnapshot.renderCount,
      loads: tableSnapshot.loadCount,
      blank_violations: tableSnapshot.blankViolations?.length || 0,
      duplicate_violations: tableSnapshot.duplicateViolations?.length || 0,
      order_violations: tableSnapshot.orderViolations?.length || 0,
    },
    masonry_all: {
      renders: masonryAllSnapshot.renderCount,
      blank_violations: masonryAllSnapshot.blankViolations?.length || 0,
      duplicate_violations: masonryAllSnapshot.duplicateViolations?.length || 0,
    },
    masonry_folder: masonryFolderSnapshot
      ? {
          folder_expected_count: folderTotal,
          blank_violations: folderStats.blankViolations,
          duplicate_violations: folderStats.duplicateViolations,
          visible_cards_after_scroll: masonryFolderSnapshot.visibleCards,
          stats_text: masonryFolderSnapshot.statsText,
          renders: masonryFolderSnapshot.renderCount,
        }
      : null,
    gates,
    errors,
  };
}

const server = await createServer(records);
const results = [];
try {
  for (const browserName of requestedBrowsers) {
    try {
      results.push(await runBrowser(browserName, server.url));
    } catch (error) {
      results.push({
        ok: false,
        browser: browserName,
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
    }
  }
} finally {
  server.server.close();
}

const payload = {
  ok: results.every((result) => result.ok),
  records_path: recordsPath,
  records: records.length,
  payload_bytes: Buffer.byteLength(JSON.stringify(records)),
  generated_at: new Date().toISOString(),
  results,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
