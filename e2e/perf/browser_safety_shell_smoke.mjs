#!/usr/bin/env node
/* global process, console, window, document, indexedDB, localStorage */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const [, , outPathArg = 'e2e/perf/out/browser-safety-shell.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const userscriptPath = path.resolve('dist/scrollmark.user.js');

if (!fs.existsSync(userscriptPath)) {
  console.error(`Missing built userscript at ${userscriptPath}. Run npm run build first.`);
  process.exit(2);
}

function createServer() {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Scrollmark Browser Safety Shell</title></head>
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

async function installApp(page, url, errors) {
  page.on('pageerror', (error) => {
    errors.push(error?.stack || error?.message || String(error));
  });
  page.on('console', (message) => {
    const text = message.text();
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
    window.__META_DATA__ = { userId: 'browser-safety-shell' };
    window.unsafeWindow = window;
    window.__twe_allow_continuity_local_fallback_v1 = true;
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
}

async function readSentinel(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('__twe_continuity_sentinel_v1');
    return raw ? JSON.parse(raw) : null;
  });
}

const errors = [];
const { server, url } = await createServer();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

try {
  let page = await context.newPage();
  await installApp(page, url, errors);
  await page.waitForFunction(
    () => typeof window.__scrollmarkSyntheticDb?.seedBookmarks === 'function',
  );
  const seed = await page.evaluate(async () => {
    return window.__scrollmarkSyntheticDb.seedBookmarks({
      count: 40,
      userCount: 4,
      clearFirst: true,
      includeSearchDocuments: true,
    });
  });

  await installApp(page, url, errors);
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('__twe_continuity_sentinel_v1');
    if (!raw) return false;
    return Number(JSON.parse(raw)?.approximate_counts?.total || 0) >= 40;
  });
  const healthySentinel = await readSentinel(page);
  const persistenceReport = await page.evaluate(() => {
    const raw = localStorage.getItem('__twe_persistence_report_v1');
    return raw ? JSON.parse(raw) : null;
  });
  if (!['granted', 'denied', 'unsupported', 'error'].includes(persistenceReport?.state)) {
    throw new Error('Expected a one-time persistence report in manager/test storage');
  }
  const activeDbName = await page.evaluate(() => localStorage.getItem('__twe_active_db_name_v1'));
  if (!activeDbName) throw new Error('Expected active database name before deletion');

  await page.close();
  page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate((name) => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error || new Error('deleteDatabase failed'));
      request.onblocked = () => reject(new Error('deleteDatabase blocked'));
    });
  }, activeDbName);
  await page.close();
  page = await context.newPage();

  await installApp(page, url, errors);
  try {
    await page.waitForFunction(() =>
      document.body.innerText.includes('Scrollmark recovery required'),
    );
  } catch (error) {
    const diagnosticText = await page
      .locator('#twe-root')
      .innerText()
      .catch(() => '');
    const diagnosticSentinel = await readSentinel(page).catch(() => null);
    console.error(JSON.stringify({ diagnosticText, diagnosticSentinel, errors }, null, 2));
    throw error;
  }
  const recoveryText = await page.locator('#twe-root').innerText();
  const recoveryReason = recoveryText.match(/Reason: ([^\n]+)/)?.[1] || '';
  if (
    !['active-database-missing', 'active-database-unreadable', 'archive-count-dropped'].includes(
      recoveryReason,
    )
  ) {
    throw new Error(`Recovery gate did not report a cache discontinuity: ${recoveryText}`);
  }
  const durableDestroyButton = page.getByRole('button', { name: 'Destroy durable archive' });
  if (!(await durableDestroyButton.isDisabled())) {
    throw new Error('Durable archive destruction must remain disabled without a companion');
  }
  const syntheticToolsPresent = await page.evaluate(
    () => typeof window.__scrollmarkSyntheticDb?.seedBookmarks === 'function',
  );
  if (syntheticToolsPresent) {
    throw new Error('Recovery gate must not install database mutation tools');
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('\n')}`);

  const result = {
    ok: true,
    seed: { tweetCount: seed.tweetCount, userCount: seed.userCount },
    healthySentinel: {
      total: healthySentinel?.approximate_counts?.total || 0,
      activeDbName: healthySentinel?.active_db_name || null,
    },
    persistence: {
      state: persistenceReport.state,
      origin: persistenceReport.origin,
    },
    deletedDbName: activeDbName,
    recoveryReason,
    errors,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
