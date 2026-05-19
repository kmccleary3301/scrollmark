#!/usr/bin/env node
/* global WebSocket, process, console, setTimeout */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const outPath = process.argv[2] || `e2e/perf/out/chrome-cdp-smoke-${Date.now()}.json`;
const defaultUserscriptPath = fs.existsSync('dist/twitter-web-exporter-e2e.user.js')
  ? 'dist/twitter-web-exporter-e2e.user.js'
  : 'dist/twitter-web-exporter-chrome-e2e.user.js';
const userscriptPath =
  process.env.TWE_CDP_USERSCRIPT ||
  (fs.existsSync(defaultUserscriptPath) ? defaultUserscriptPath : undefined);
const chromeCandidates = [
  process.env.CHROME_BIN,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const candidate of chromeCandidates) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
      return { bin: candidate, version: result.stdout.trim() };
    }
  }
  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function createHarnessServer(html) {
  const server = http.createServer((request, response) => {
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
        reject(new Error('Unable to allocate harness HTTP port.'));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

async function waitForDebugger(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await getJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await wait(100);
    }
  }
  throw new Error('Chrome remote debugging endpoint did not become available.');
}

function createCdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      events.push(message);
    }
  };

  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  return {
    ready,
    events,
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    close() {
      socket.close();
    },
  };
}

function metricMap(metrics) {
  return Object.fromEntries((metrics.metrics || []).map((metric) => [metric.name, metric.value]));
}

function metricDeltas(before, after) {
  const beforeMap = metricMap(before);
  const afterMap = metricMap(after);
  return {
    JSHeapUsedSize: (afterMap.JSHeapUsedSize || 0) - (beforeMap.JSHeapUsedSize || 0),
    TaskDuration: (afterMap.TaskDuration || 0) - (beforeMap.TaskDuration || 0),
    ScriptDuration: (afterMap.ScriptDuration || 0) - (beforeMap.ScriptDuration || 0),
    LayoutDuration: (afterMap.LayoutDuration || 0) - (beforeMap.LayoutDuration || 0),
  };
}

async function exerciseHarness(client, label) {
  return client.send('Runtime.evaluate', {
    expression: `
      (() => {
        const input = document.querySelector('input[data-label="${label}"]') || document.createElement('input');
        input.dataset.label = "${label}";
        document.body.prepend(input);
        const query = 'full writeup on how phrase boosting exact snippets';
        for (const char of query) {
          input.value += char;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, data: char }));
        }
        window.scrollTo(0, document.body.scrollHeight);
        return { queryLength: query.length, scrollY: window.scrollY };
      })()
    `,
  });
}

const chromeInfo = findChrome();
if (!chromeInfo) {
  const payload = {
    ok: false,
    skipped: true,
    reason: 'No Chrome/Chromium binary found. Set CHROME_BIN to enable this benchmark.',
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const port = Number(process.env.CDP_PORT || 9223);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twe-cdp-profile-'));
const harnessHtml = `<!doctype html>
<meta charset="utf-8">
<title>TWE CDP Smoke Harness</title>
<main id="root"></main>
<script>
const root = document.getElementById('root');
for (let i = 0; i < 5000; i++) {
  const article = document.createElement('article');
  article.textContent = 'Synthetic tweet row ' + i + ' full writeup on how phrase boosting should rank exact snippets.';
  root.appendChild(article);
}
window.__tweHarnessReady = true;
</script>`;
const harness = await createHarnessServer(harnessHtml);
const chrome = spawn(chromeInfo.bin, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
]);

let stderr = '';
chrome.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

try {
  const version = await waitForDebugger(port);
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const pageTarget = targets.find((target) => target.type === 'page') || targets[0];
  const client = createCdpClient(pageTarget.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Performance.enable');
  await client.send('Page.navigate', { url: harness.url });
  await wait(500);
  await client.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        const tick = () => window.__tweHarnessReady ? resolve(true) : setTimeout(tick, 25);
        tick();
      })
    `,
    awaitPromise: true,
  });
  const before = await client.send('Performance.getMetrics');
  await exerciseHarness(client, 'baseline');
  await wait(250);
  const after = await client.send('Performance.getMetrics');

  let injected = null;
  if (userscriptPath && fs.existsSync(userscriptPath)) {
    const source = fs.readFileSync(userscriptPath, 'utf8');
    const injectBefore = await client.send('Performance.getMetrics');
    const injectionResult = await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          try {
            window.GM_info ||= { scriptHandler: 'cdp-harness', version: '0', script: { name: 'Scrollmark CDP Harness' } };
            window.unsafeWindow ||= window;
            const source = ${JSON.stringify(source)};
            (0, eval)(source);
            return { ok: true, rootExists: !!document.getElementById('twe-root') };
          } catch (error) {
            return { ok: false, message: String(error && error.message || error), stack: String(error && error.stack || '') };
          }
        })()
      `,
      returnByValue: true,
    });
    await wait(750);
    await exerciseHarness(client, 'injected');
    await wait(250);
    const injectAfter = await client.send('Performance.getMetrics');
    injected = {
      script_path: userscriptPath,
      injection: injectionResult.result?.value ?? null,
      deltas: metricDeltas(injectBefore, injectAfter),
    };
  }
  client.close();

  const payload = {
    ok: true,
    chrome: chromeInfo,
    protocol_browser: version.Browser,
    baseline_deltas: metricDeltas(before, after),
    injected,
    gates: {
      chrome_cdp_available: true,
      userscript_injection_attempted: !!userscriptPath,
      userscript_injection_ok: injected?.injection?.ok ?? null,
    },
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
} catch (error) {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderr.slice(-4000),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
} finally {
  chrome.kill('SIGTERM');
  harness.server.close();
}
