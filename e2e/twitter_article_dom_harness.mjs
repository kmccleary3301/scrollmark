#!/usr/bin/env node
/* global console */

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();

const address = server.httpServer?.address();
if (!address || typeof address === 'string') {
  await server.close();
  throw new Error('Unable to resolve the Vite fixture server port.');
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/e2e/fixtures/twitter-article-dom.html`, {
    waitUntil: 'networkidle',
  });
  const markdown = await page.evaluate(() => globalThis.__twitterArticleMarkdown || '');

  assert.match(markdown, /^!\[Article cover image\]/m);
  assert.match(markdown, /^# DOM Article Fixture$/m);
  assert.match(markdown, /\*\*bold\*\*/);
  assert.match(markdown, /\*careful\*/);
  assert.match(markdown, /\[reference\]\(https:\/\/example\.com\/article-reference\)/);
  assert.match(markdown, /`inline\(\)`/);
  assert.match(markdown, /^## Structured DOM$/m);
  assert.match(markdown, /- first bullet\n {2}- nested bullet/);
  assert.match(markdown, /```python\ndef dom_kernel\(\):\n {4}return 7\n```/);
  assert.match(markdown, /\| Feature \| Value \|/);
  assert.match(markdown, /\| table \| `preserved` \|/);
  assert.match(markdown, /\$x\^2 \+ y\^2\$/);
  assert.match(markdown, /\$\$\n\\int_0\^1 x\^2\\,dx\n\$\$/);
  assert.match(markdown, /> DOM quote survives\./);
  assert.match(markdown, /^---$/m);
  assert.match(markdown, /!\[Article diagram\]\(https:\/\/pbs\.twimg\.com\/media\/diagram\.jpg\)/);
  assert.doesNotMatch(markdown, /Like Repost Bookmark UI/);

  console.log('twitter article DOM harness passed');
} finally {
  await browser.close();
  await server.close();
}
