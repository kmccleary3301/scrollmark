#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const files = process.argv.slice(2);
const defaultFiles = [
  'dist/scrollmark.user.js',
  'dist/scrollmark.store.user.js',
  'store/scrollmark.user.js',
  'dist/twitter-web-exporter-e2e.user.js',
  'dist/twitter-web-exporter-chrome-e2e.user.js',
];
const targets = files.length ? files : defaultFiles.filter((file) => existsSync(file));

if (!targets.length) {
  throw new Error('No userscript files found to validate. Run a build first.');
}

function parseMetadata(source, file) {
  const match = source.match(/\/\/ ==UserScript==\n([\s\S]*?)\n\/\/ ==\/UserScript==/);
  if (!match) throw new Error(`${file}: missing UserScript metadata block`);
  const metadata = new Map();
  for (const line of match[1].split('\n')) {
    const parsed = line.match(/^\/\/ @([^\s]+)\s+(.*)$/);
    if (!parsed) continue;
    const [, key, value] = parsed;
    const values = metadata.get(key) ?? [];
    values.push(value.trim());
    metadata.set(key, values);
  }
  return metadata;
}

function one(metadata, key, file) {
  const values = metadata.get(key) ?? [];
  if (!values.length) throw new Error(`${file}: missing @${key}`);
  return values[0];
}

function has(metadata, key, value) {
  return (metadata.get(key) ?? []).includes(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const file of targets) {
  const source = readFileSync(file, 'utf8');
  const metadata = parseMetadata(source, file);
  const name = basename(file);
  const isStore = name === 'scrollmark.store.user.js' || file === 'store/scrollmark.user.js';
  const isRelease = name === 'scrollmark.user.js' && file !== 'store/scrollmark.user.js';
  const isE2E = name.includes('e2e');

  assert(one(metadata, 'name', file) === 'Scrollmark', `${file}: @name must be Scrollmark`);
  assert(
    one(metadata, 'version', file) === packageJson.version,
    `${file}: @version must match package.json`,
  );
  assert(
    one(metadata, 'author', file) === 'Kyle McCleary',
    `${file}: @author must be Kyle McCleary`,
  );
  assert(
    one(metadata, 'namespace', file) === 'https://github.com/kmccleary3301/scrollmark',
    `${file}: @namespace must point at the Scrollmark repo`,
  );
  assert(has(metadata, 'match', '*://x.com/*'), `${file}: missing x.com @match`);
  assert(has(metadata, 'match', '*://twitter.com/*'), `${file}: missing twitter.com @match`);
  assert(has(metadata, 'match', '*://mobile.x.com/*'), `${file}: missing mobile.x.com @match`);
  assert(has(metadata, 'grant', 'unsafeWindow'), `${file}: missing unsafeWindow grant`);
  assert(has(metadata, 'grant', 'GM_xmlhttpRequest'), `${file}: missing GM_xmlhttpRequest grant`);
  assert(
    one(metadata, 'run-at', file) === 'document-start',
    `${file}: @run-at must be document-start`,
  );

  if (isRelease) {
    const expected =
      'https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js';
    assert(has(metadata, 'downloadURL', expected), `${file}: missing release @downloadURL`);
    assert(has(metadata, 'updateURL', expected), `${file}: missing release @updateURL`);
    assert(
      (metadata.get('require') ?? []).length > 0,
      `${file}: production build should externalize dependencies`,
    );
  }

  if (isStore) {
    assert(
      !(metadata.get('downloadURL') ?? []).length,
      `${file}: store artifact should omit @downloadURL`,
    );
    assert(
      !(metadata.get('updateURL') ?? []).length,
      `${file}: store artifact should omit @updateURL`,
    );
    assert(
      (metadata.get('require') ?? []).length > 0,
      `${file}: store build should externalize dependencies`,
    );
  }

  if (isE2E) {
    assert(
      (metadata.get('downloadURL') ?? []).some((url) => url.includes('localhost:8123')),
      `${file}: e2e build must use local downloadURL`,
    );
    assert(
      (metadata.get('updateURL') ?? []).some((url) => url.includes('localhost:8123')),
      `${file}: e2e build must use local updateURL`,
    );
  }

  console.log(`validated ${file}`);
}
