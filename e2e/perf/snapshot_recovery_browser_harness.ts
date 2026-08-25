import fs from 'node:fs';
import path from 'node:path';

import 'fake-indexeddb/auto';

import type {
  ArchiveDeltaRequest,
  Checkpoint,
  Mutation,
  ReconciliationDescriptor,
  ReconciliationItem,
  ReconciliationPage,
} from '../../src/core/durability/contracts';
import type { PairingContext } from '../../src/core/durability/identity';

const [, , outPathArg = 'e2e/perf/out/snapshot-recovery-browser.json'] = process.argv;
const outPath = path.resolve(outPathArg);
class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const localStorage = new MemoryStorage();
const gmValues = new Map<string, unknown>();
const pairing: PairingContext = {
  base_url: 'http://127.0.0.1:8755',
  token: 'recovery-token-never-emitted',
  archive_id: 'archive-recovery-browser',
  namespace_id: 'namespace-recovery-browser',
  client_id: 'client-recovery-browser',
  client_epoch: 'epoch-recovery-browser',
  viewer_id: 'viewer-recovery-browser',
  origin: 'https://x.com',
};
const windowMock = {
  __META_DATA__: { userId: pairing.viewer_id },
  __INITIAL_STATE__: { session: { viewerId: pairing.viewer_id } },
  location: { origin: 'https://x.com' },
  localStorage,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  setTimeout,
  clearTimeout,
};
Object.assign(globalThis, {
  window: windowMock,
  unsafeWindow: windowMock,
  self: globalThis,
  location: windowMock.location,
  localStorage,
  GM_getValue: (key: string) => gmValues.get(key),
  GM_setValue: (key: string, value: unknown) => gmValues.set(key, value),
  GM_deleteValue: (key: string) => gmValues.delete(key),
});

// Recovery modules read browser globals at module initialization, so the harness installs them first.
const { canonicalize, recordHash, SCHEMA_REVISION, SCROLLMARK_PROTOCOL, sha256Hex, ZERO_HASH } =
  await import('../../src/core/durability/contracts');
const { PAIRING_STORAGE_KEY } = await import('../../src/core/durability/identity');
gmValues.set(PAIRING_STORAGE_KEY, pairing);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const material = {
  mutation_id: 'recovery-state-mutation-1',
  client_seq: 1,
  kind: 'entity_upsert' as const,
  schema_revision: SCHEMA_REVISION,
  target: { namespace_id: pairing.namespace_id, kind: 'tweet' as const, id: 'tweet-restored' },
  payload: {
    __typename: 'Tweet',
    rest_id: 'tweet-restored',
    full_text: 'restored canonical state',
  },
  provenance: { source: 'snapshot-recovery-browser-harness' },
  observed_at_ms: 1_700_000_000_001,
};
const mutation: Mutation = {
  ...material,
  record_hash: await recordHash(pairing.namespace_id, material),
};
const checkpoint: Checkpoint = {
  namespace_id: pairing.namespace_id,
  archive_seq: 4,
  chain_hash: await sha256Hex({ restored: mutation.record_hash }),
  schema_revision: SCHEMA_REVISION,
};
const sourceCheckpoint: Checkpoint = {
  namespace_id: pairing.namespace_id,
  archive_seq: 0,
  chain_hash: ZERO_HASH,
  schema_revision: SCHEMA_REVISION,
};
const items: ReconciliationItem[] = [
  {
    state_key: 'entity:tweet:tweet-restored',
    archive_seq: 4,
    mutation_id: mutation.mutation_id,
    mutation,
    record_hash: mutation.record_hash,
  },
];
const manifestHash = await sha256Hex({
  mode: 'state_bootstrap',
  namespace_id: pairing.namespace_id,
  source_checkpoint: sourceCheckpoint,
  target_checkpoint: checkpoint,
  items,
});
const pageMaterial = {
  protocol: SCROLLMARK_PROTOCOL,
  stream_id: 'stream-recovery-browser',
  namespace_id: pairing.namespace_id,
  mode: 'state_bootstrap' as const,
  page_index: 0,
  item_count: items.length,
  byte_count: new TextEncoder().encode(canonicalize(items)).byteLength,
  items,
  target_checkpoint: checkpoint,
  manifest_hash: manifestHash,
  final: true,
};
const page: ReconciliationPage = { ...pageMaterial, page_hash: await sha256Hex(pageMaterial) };
const descriptor: ReconciliationDescriptor = {
  protocol: SCROLLMARK_PROTOCOL,
  stream_id: page.stream_id,
  namespace_id: pairing.namespace_id,
  mode: 'state_bootstrap',
  source_checkpoint: sourceCheckpoint,
  target_checkpoint: checkpoint,
  manifest_hash: manifestHash,
  item_count: 1,
  page_count: 1,
};
const snapshotId = 'snapshot-recovery-browser-proof';
const snapshot = {
  format: 'twe.snapshot.v1',
  snapshot_id: snapshotId,
  archive_id: pairing.archive_id,
  created_at_ms: 1_700_000_000_000,
  verified_at_ms: 1_700_000_000_100,
  namespaces: [
    {
      namespace_id: pairing.namespace_id,
      identity_fingerprint: 'a'.repeat(24),
      checkpoint_seq: 1,
      checkpoint_chain_hash: 'b'.repeat(64),
      journal_first_seq: 1,
      journal_last_seq: 1,
    },
  ],
  image: { path: 'archive.sqlite3', bytes: 4096, sha256: 'c'.repeat(64), mode: 'plaintext' },
  encryption: { mode: 'plaintext', algorithm: null, key_id: null },
  verification: {
    state: 'verified',
    verifier_version: '1',
    checks: ['sqlite-integrity'],
    failures: [],
  },
  manifest_payload_hash: 'd'.repeat(64),
};

let restoreCalls = 0;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  if (url.pathname === '/v1/snapshots' && init?.method === 'GET') {
    return response({
      protocol: SCROLLMARK_PROTOCOL,
      archive_id: pairing.archive_id,
      snapshots: [snapshot],
    });
  }
  if (url.pathname.endsWith('/verify') && init?.method === 'POST') {
    return response({
      protocol: SCROLLMARK_PROTOCOL,
      archive_id: pairing.archive_id,
      snapshot_id: snapshotId,
      manifest_payload_hash: snapshot.manifest_payload_hash,
    });
  }
  if (url.pathname.endsWith('/restore') && init?.method === 'POST') {
    restoreCalls += 1;
    return response({
      protocol: SCROLLMARK_PROTOCOL,
      archive_id: pairing.archive_id,
      snapshot_id: snapshotId,
      state: 'restored',
      checkpoints: { [pairing.namespace_id]: checkpoint },
    });
  }
  if (url.pathname.endsWith('/reconciliation') && init?.method === 'POST')
    return response(descriptor);
  if (url.pathname.includes('/reconciliation/') && url.pathname.endsWith('/pages'))
    return response(page);
  throw new Error(`unexpected recovery request: ${init?.method} ${url.pathname}`);
};
Object.assign(globalThis, { fetch: fetchMock });

const { getDurabilityCoordinator, resetDatabaseManager } = await import('../../src/core/database');
const { restoreVerifiedSnapshot } = await import('../../src/core/durability/recovery');
const coordinator = getDurabilityCoordinator();
const outboxMutation = {
  ...material,
  mutation_id: 'pending-mutation-1',
  record_hash: await recordHash(pairing.namespace_id, {
    ...material,
    mutation_id: 'pending-mutation-1',
  }),
};
const pendingRequest: ArchiveDeltaRequest = {
  protocol: SCROLLMARK_PROTOCOL,
  request_id: 'pending-request-1',
  archive_id: pairing.archive_id,
  namespace_id: pairing.namespace_id,
  client_id: pairing.client_id,
  client_epoch: pairing.client_epoch,
  sent_at_ms: Date.now(),
  client_sequence: { from: 1, to: 1 },
  batch: {
    batch_id: 'pending-batch-1',
    mutation_count: 1,
    mutations: [outboxMutation],
    batch_hash: 'e'.repeat(64),
  },
  known_checkpoint: null,
};
await coordinator.outbox.admit(pendingRequest, 512);
const pendingBefore = await coordinator.outbox.listAllPending();
const restored = await restoreVerifiedSnapshot(snapshotId);
const pendingAfter = await coordinator.outbox.listAllPending();
assert(restoreCalls === 1, 'browser recovery did not call canonical restore exactly once');
assert(
  restored.generation.pointer.target_checkpoint.archive_seq === 4,
  'browser projection did not pin restored checkpoint',
);
assert(
  pendingBefore.length === 1 && pendingAfter.length === 1,
  'snapshot restore changed browser outbox contents',
);
assert(
  pendingAfter[0]?.batch_id === pendingBefore[0]?.batch_id,
  'snapshot restore replaced browser outbox batch',
);
assert(
  restored.safety.phase !== 'recovery_required',
  'restored projection failed browser safety refresh',
);
resetDatabaseManager();

const report = {
  status: 'passed',
  scenario: 'browser snapshot restore rebuilds projection without clearing outbox',
  observed: {
    restore_calls: restoreCalls,
    restored_checkpoint_seq: restored.generation.pointer.target_checkpoint.archive_seq,
    pending_batches_before: pendingBefore.length,
    pending_batches_after: pendingAfter.length,
    browser_safety_phase: restored.safety.phase,
  },
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
