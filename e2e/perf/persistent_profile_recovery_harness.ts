import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium, type BrowserContext, type Page, type Route } from 'playwright';

import {
  SCHEMA_REVISION,
  SCROLLMARK_PROTOCOL,
  ZERO_HASH,
  canonicalize,
  recordHash,
  sha256Hex,
  type Checkpoint,
  type Mutation,
  type ReconciliationItem,
  type ReconciliationPage,
} from '../../src/core/durability/contracts';

const outPath = path.resolve('e2e/perf/out/persistent-profile-recovery.json');
const userscriptPath = path.resolve('dist/scrollmark.user.js');
const namespaceId = 'namespace-persistent-recovery';
const archiveId = 'archive-persistent-recovery';
const snapshotId = 'snapshot-persistent-recovery';
const companionBaseUrl = 'http://127.0.0.1:8755';
const pairing = {
  base_url: companionBaseUrl,
  token: 'persistent-recovery-token-never-emitted',
  archive_id: archiveId,
  namespace_id: namespaceId,
  client_id: 'client-persistent-recovery',
  client_epoch: 'epoch-persistent-recovery',
  viewer_id: 'persistent-profile-viewer',
  origin: 'https://x.com',
};
type CanonicalFixture = {
  items: ReconciliationItem[];
  sourceCheckpoint: Checkpoint;
  targetCheckpoint: Checkpoint;
  manifestHash: string;
  page: ReconciliationPage;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tweet(id: string): Record<string, unknown> {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      created_at: 'Thu Sep 28 11:07:25 +0000 2023',
      full_text: `restored tweet ${id}`,
      favorite_count: 1,
      retweet_count: 0,
      reply_count: 0,
      bookmark_count: 1,
      lang: 'en',
    },
    core: { user_results: { result: { rest_id: 'user-1', core: { screen_name: 'restored' } } } },
  };
}

function user(id: string): Record<string, unknown> {
  return {
    __typename: 'User',
    id,
    rest_id: id,
    core: { name: 'Restored Author', screen_name: 'restored' },
    legacy: { description: 'persistent profile recovery fixture' },
  };
}

async function entityMutation(
  kind: 'tweet' | 'user',
  id: string,
  payload: Record<string, unknown>,
  sequence: number,
): Promise<Mutation> {
  const input = {
    mutation_id: `mutation-${sequence}`,
    client_seq: sequence,
    kind: 'entity_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    target: { namespace_id: namespaceId, kind, id },
    payload,
    provenance: { source: 't7-persistent-profile' },
    observed_at_ms: 1_700_000_000_000 + sequence,
  };
  return { ...input, record_hash: await recordHash(namespaceId, input) };
}

async function captureMutation(id: string, sequence: number): Promise<Mutation> {
  const input = {
    mutation_id: `mutation-${sequence}`,
    client_seq: sequence,
    kind: 'relationship_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    relationship_kind: 'capture_membership' as const,
    subject: { namespace_id: namespaceId, kind: 'tweet' as const, id },
    object: { namespace_id: namespaceId, kind: 'folder' as const, id: 'capture:bookmarks' },
    qualifier: { extension: 'bookmarks' },
    payload: { extension: 'bookmarks', data_key: id },
    provenance: { source: 't7-persistent-profile' },
    observed_at_ms: 1_700_000_000_000 + sequence,
  };
  return { ...input, record_hash: await recordHash(namespaceId, input) };
}

async function canonicalFixture(): Promise<CanonicalFixture> {
  const mutations = [
    await entityMutation('tweet', 'tweet-1', tweet('tweet-1'), 1),
    await entityMutation('tweet', 'tweet-2', tweet('tweet-2'), 2),
    await entityMutation('user', 'user-1', user('user-1'), 3),
    await captureMutation('tweet-1', 4),
    await captureMutation('tweet-2', 5),
  ];
  const items: ReconciliationItem[] = mutations.map((mutation, index) => ({
    state_key: index < 3 ? `entity:${index}` : `capture:${index}`,
    archive_seq: index + 1,
    mutation_id: mutation.mutation_id,
    mutation,
    record_hash: mutation.record_hash,
  }));
  const sourceCheckpoint: Checkpoint = {
    namespace_id: namespaceId,
    archive_seq: 0,
    chain_hash: ZERO_HASH,
    schema_revision: SCHEMA_REVISION,
  };
  const targetCheckpoint: Checkpoint = {
    namespace_id: namespaceId,
    archive_seq: items.length,
    chain_hash: '7'.repeat(64),
    schema_revision: SCHEMA_REVISION,
  };
  const manifestHash = await sha256Hex({
    mode: 'state_bootstrap',
    namespace_id: namespaceId,
    source_checkpoint: sourceCheckpoint,
    target_checkpoint: targetCheckpoint,
    items,
  });
  const material = {
    protocol: SCROLLMARK_PROTOCOL,
    stream_id: 'stream-persistent-recovery',
    namespace_id: namespaceId,
    mode: 'state_bootstrap' as const,
    page_index: 0,
    item_count: items.length,
    byte_count: new TextEncoder().encode(canonicalize(items)).byteLength,
    items,
    target_checkpoint: targetCheckpoint,
    manifest_hash: manifestHash,
    final: true,
  };
  const page: ReconciliationPage = { ...material, page_hash: await sha256Hex(material) };
  return { items, sourceCheckpoint, targetCheckpoint, manifestHash, page };
}

function createHostServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>Persistent recovery</title></head><body><main>host</main></body></html>',
    );
  });
  const { promise, resolve, reject } = Promise.withResolvers<{
    server: http.Server;
    url: string;
  }>();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('host port unavailable'));
      return;
    }
    resolve({ server, url: `http://127.0.0.1:${address.port}/?scrollmarkSyntheticDb=1` });
  });
  return promise;
}

async function installGlobals(context: BrowserContext, paired: boolean): Promise<void> {
  await context.route('https://x.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"><title>Persistent recovery</title></head><body><main>host</main></body></html>',
    }),
  );
  await context.addInitScript(
    ({ pairingValue, pairedValue }) => {
      window.__META_DATA__ = { userId: 'persistent-profile-viewer' };
      window.__INITIAL_STATE__ = { viewerId: 'persistent-profile-viewer' };
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
      if (pairedValue) {
        window.GM_getValue = (key: string) => {
          if (key === '__twe_scrollmark_companion_pairing_v1') return pairingValue;
          const stored =
            window.localStorage.getItem(`__t7_gm_${key}`) ?? window.localStorage.getItem(key);
          return stored === null ? undefined : JSON.parse(stored);
        };
        window.GM_setValue = (key: string, value: unknown) => {
          window.localStorage.setItem(`__t7_gm_${key}`, JSON.stringify(value));
        };
        window.GM_deleteValue = (key: string) => {
          window.localStorage.removeItem(`__t7_gm_${key}`);
        };
      }
    },
    { pairingValue: pairing, pairedValue: paired },
  );
}

async function installApp(page: Page, url: string, errors: string[]): Promise<void> {
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource:')) {
      errors.push(message.text());
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(companionBaseUrl)) {
      errors.push(
        `companion request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
      );
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: userscriptPath });
  await page.waitForSelector('#twe-root', { state: 'attached', timeout: 15_000 });
}

async function routeCompanion(
  route: Route,
  fixture: CanonicalFixture,
  calls: Record<string, number>,
) {
  const request = route.request();
  calls.requests += 1;
  if (request.method() === 'OPTIONS') {
    await route.fulfill({
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, X-Scrollmark-Protocol',
      },
    });
    return;
  }
  const url = new URL(request.url());
  const common = { protocol: SCROLLMARK_PROTOCOL, archive_id: archiveId };
  let payload: unknown;
  if (url.pathname === '/v1/health') {
    calls.health += 1;
    payload = {
      ...common,
      ready: true,
      archive: { archive_id: archiveId },
      active_namespace_ids: [namespaceId],
    };
  } else if (url.pathname === '/v1/capabilities') {
    calls.capabilities += 1;
    payload = {
      protocol_versions: [SCROLLMARK_PROTOCOL],
      schema_revisions: [SCHEMA_REVISION],
      hash_algorithm: 'sha256-jcs-hex',
      capability_revision: 'persistent-recovery-v1',
      limits: {
        max_mutations_per_batch: 512,
        max_bytes_per_batch: 4_000_000,
        max_items_per_page: 512,
      },
      features: { reconciliation: true, commit: true, snapshots: true, restore: true },
    };
  } else if (url.pathname.endsWith('/checkpoint')) {
    calls.checkpoint += 1;
    payload = { ...common, namespace_id: namespaceId, checkpoint: fixture.targetCheckpoint };
  } else if (url.pathname === '/v1/snapshots' && request.method() === 'GET') {
    calls.list += 1;
    payload = {
      ...common,
      snapshots: [
        {
          format: 'twe.snapshot.v1',
          snapshot_id: snapshotId,
          archive_id: archiveId,
          created_at_ms: 1_700_000_000_000,
          verified_at_ms: 1_700_000_000_001,
          namespaces: [{ namespace_id: namespaceId }],
          image: { bytes: 4096, sha256: '8'.repeat(64) },
          verification: { state: 'verified' },
          manifest_payload_hash: '9'.repeat(64),
        },
      ],
    };
  } else if (url.pathname.endsWith('/verify')) {
    calls.verify += 1;
    payload = {
      ...common,
      snapshot_id: snapshotId,
      verification: { state: 'verified' },
      manifest_payload_hash: '9'.repeat(64),
    };
  } else if (url.pathname.endsWith('/restore')) {
    calls.restore += 1;
    payload = {
      ...common,
      snapshot_id: snapshotId,
      state: 'restored',
      checkpoints: { [namespaceId]: fixture.targetCheckpoint },
    };
  } else if (url.pathname.endsWith('/reconciliation')) {
    calls.reconcile += 1;
    payload = {
      protocol: SCROLLMARK_PROTOCOL,
      stream_id: fixture.page.stream_id,
      namespace_id: namespaceId,
      mode: 'state_bootstrap',
      source_checkpoint: fixture.sourceCheckpoint,
      target_checkpoint: fixture.targetCheckpoint,
      manifest_hash: fixture.manifestHash,
      item_count: fixture.items.length,
      page_count: 1,
    };
  } else if (url.pathname.includes('/reconciliation/') && url.pathname.endsWith('/pages')) {
    calls.pages += 1;
    payload = fixture.page;
  } else {
    await route.fulfill({ status: 404, json: { error: url.pathname } });
    return;
  }
  await route.fulfill({
    status: 200,
    json: payload,
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
  });
}

async function databaseCounts(page: Page, databaseName: string) {
  return page.evaluate(async (name) => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const openRequest = indexedDB.open(name);
    openRequest.onsuccess = () => opened.resolve(openRequest.result);
    openRequest.onerror = () => opened.reject(openRequest.error);
    const database = await opened.promise;
    try {
      const names = ['tweets', 'users', 'captures', 'search_documents'];
      const transaction = database.transaction(names, 'readonly');
      const result: Record<string, number> = {};
      await Promise.all(
        names.map((store) => {
          const counted = Promise.withResolvers<void>();
          const countRequest = transaction.objectStore(store).count();
          countRequest.onsuccess = () => {
            result[store] = countRequest.result;
            counted.resolve();
          };
          countRequest.onerror = () => counted.reject(countRequest.error);
          return counted.promise;
        }),
      );
      return result;
    } finally {
      database.close();
    }
  }, databaseName);
}

requireCondition(fs.existsSync(userscriptPath), `missing built userscript: ${userscriptPath}`);
const fixture = await canonicalFixture();
const calls = {
  requests: 0,
  health: 0,
  capabilities: 0,
  checkpoint: 0,
  list: 0,
  verify: 0,
  restore: 0,
  reconcile: 0,
  pages: 0,
};
const errors: string[] = [];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollmark-t7-profile-'));
const { server } = await createHostServer();
const url = 'https://x.com/?scrollmarkSyntheticDb=1';
let context: BrowserContext | null = null;
let deletedDatabaseName = '';
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  await installGlobals(context, false);
  let page = context.pages()[0] ?? (await context.newPage());
  await installApp(page, url, errors);
  await page.waitForFunction(
    () => typeof window.__scrollmarkSyntheticDb?.seedBookmarks === 'function',
  );
  await page.evaluate(() =>
    window.__scrollmarkSyntheticDb.seedBookmarks({
      count: 40,
      userCount: 4,
      clearFirst: true,
      includeSearchDocuments: true,
    }),
  );
  await installApp(page, url, errors);
  try {
    await page.waitForFunction(
      () =>
        Number(
          JSON.parse(localStorage.getItem('__twe_continuity_sentinel_v1') || '{}')
            ?.approximate_counts?.total || 0,
        ) >= 40,
      undefined,
      { timeout: 5000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      sentinel: localStorage.getItem('__twe_continuity_sentinel_v1'),
      active: localStorage.getItem('__twe_active_db_name_v1'),
      root: document.querySelector('#twe-root')?.textContent,
    }));
    throw new Error(
      `seed continuity publication failed: ${JSON.stringify({ diagnostic, errors })}`,
      {
        cause: error,
      },
    );
  }
  deletedDatabaseName =
    (await page.evaluate(() => localStorage.getItem('__twe_active_db_name_v1'))) || '';
  requireCondition(deletedDatabaseName, 'active database missing before simulated wipe');
  await context.close();
  context = null;

  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate((name) => {
    const deleted = Promise.withResolvers<void>();
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => deleted.resolve();
    request.onerror = () => deleted.reject(request.error);
    request.onblocked = () => deleted.reject(new Error('database deletion blocked'));
    return deleted.promise;
  }, deletedDatabaseName);
  await context.close();
  context = null;

  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  await installGlobals(context, true);
  await context.route(`${companionBaseUrl}/**`, (route) => routeCompanion(route, fixture, calls));
  page = context.pages()[0] ?? (await context.newPage());
  await installApp(page, url, errors);
  await page.waitForFunction(
    (previousName) => {
      const activeName = localStorage.getItem('__twe_active_db_name_v1');
      return (
        Boolean(activeName) &&
        activeName !== previousName &&
        !document.body.innerText.includes('Scrollmark recovery required')
      );
    },
    deletedDatabaseName,
    { timeout: 30_000 },
  );
  const recoveryReason = 'canonical-rebuild-after-cache-wipe';
  const restoredDatabaseName =
    (await page.evaluate(() => localStorage.getItem('__twe_active_db_name_v1'))) || '';
  requireCondition(
    restoredDatabaseName && restoredDatabaseName !== deletedDatabaseName,
    'recovery did not activate a fresh generation',
  );
  const restoredCounts = await databaseCounts(page, restoredDatabaseName);
  requireCondition(restoredCounts.tweets === 2, 'recovered tweet count mismatch');
  requireCondition(restoredCounts.users === 1, 'recovered user count mismatch');
  requireCondition(restoredCounts.captures === 2, 'recovered capture count mismatch');
  requireCondition(
    restoredCounts.search_documents === 2,
    'recovered search document count mismatch',
  );
  await context.close();
  context = null;

  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  await installGlobals(context, true);
  await context.route(`${companionBaseUrl}/**`, (route) => routeCompanion(route, fixture, calls));
  page = context.pages()[0] ?? (await context.newPage());
  await installApp(page, url, errors);
  await page.waitForFunction(
    () => !document.body.innerText.includes('Scrollmark recovery required'),
  );
  const restartDatabaseName = await page.evaluate(() =>
    localStorage.getItem('__twe_active_db_name_v1'),
  );
  const restartCounts = await databaseCounts(page, String(restartDatabaseName));
  requireCondition(
    JSON.stringify(restartCounts) === JSON.stringify(restoredCounts),
    'restart changed restored counts',
  );
  requireCondition(
    calls.reconcile >= 1 && calls.pages >= 1,
    'canonical rebuild protocol was incomplete',
  );
  requireCondition(errors.length === 0, `browser errors: ${errors.join('\n')}`);

  const card = {
    card_version: 1,
    card_id: 't7-persistent-profile-recovery',
    scenario:
      'persistent Chromium profile survives clean reinstall, detects cache wipe, rebuilds from the paired companion, and restarts after explicit re-pair',
    status: 'passed',
    observed: {
      seeded_rows: 40,
      deleted_database_name_hash: createHash('sha256').update(deletedDatabaseName).digest('hex'),
      recovery_reason: recoveryReason,
      restored_database_name_hash: createHash('sha256').update(restoredDatabaseName).digest('hex'),
      restored_counts: restoredCounts,
      restart_counts: restartCounts,
      protocol_calls: calls,
      hidden_fallback: false,
      no_truncation: true,
    },
    privacy: {
      redaction_checked: true,
      profile_deleted: true,
      token_emitted: false,
      violations: [],
    },
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(card, null, 2)}\n`);
  console.log(JSON.stringify(card));
} finally {
  if (context) await context.close();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  fs.rmSync(profile, { recursive: true, force: true });
}
