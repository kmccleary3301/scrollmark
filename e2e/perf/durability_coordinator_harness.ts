import fs from 'node:fs/promises';
import path from 'node:path';

import 'fake-indexeddb/auto';

import {
  batchHash,
  canonicalize,
  chainHash,
  recordHash,
  SCHEMA_REVISION,
  SCROLLMARK_PROTOCOL,
  ZERO_HASH,
  type ArchiveDeltaRequest,
  type Capabilities,
  type Checkpoint,
  type CommitReceipt,
  type Health,
  type ReconciliationDescriptor,
  type ReconciliationPage,
  type ReconciliationRequest,
} from '../../src/core/durability/contracts';
import {
  CompanionClient,
  CompanionClientError,
  type CompanionClientLike,
} from '../../src/core/durability/companion-client';
import { DurabilityCoordinator, DurabilityError } from '../../src/core/durability/coordinator';
import {
  IdentityController,
  type IdentityEvidence,
  type PairingContext,
} from '../../src/core/durability/identity';
import { OutboxStore } from '../../src/core/durability/outbox';

const outPath = path.resolve(process.argv[2] ?? 'e2e/perf/out/durability-coordinator-t4.json');
const now = () => 1_700_000_000_000;
const namespaceId = 'namespace-alpha';
const archiveId = 'archive-demo';
const clientId = 'client-browser-harness';
const clientEpoch = 'epoch-harness';

const pairing: PairingContext = {
  base_url: 'http://127.0.0.1:8755',
  token: 'harness-token-never-emitted',
  archive_id: archiveId,
  namespace_id: namespaceId,
  client_id: clientId,
  client_epoch: clientEpoch,
  viewer_id: 'viewer-1',
};

const identityEvidence: IdentityEvidence[] = [
  {
    viewer_id: 'viewer-1',
    source: 'meta.userId',
    signal_class: 'metadata',
    observed_at_ms: now(),
    origin: 'https://x.com',
    confidence: 60,
  },
  {
    viewer_id: 'viewer-1',
    source: 'session.viewerId',
    signal_class: 'session_state',
    observed_at_ms: now(),
    origin: 'https://x.com',
    confidence: 70,
  },
];

class FakeCompanion implements CompanionClientLike {
  readonly received: ArchiveDeltaRequest[] = [];
  private readonly receipts = new Map<string, CommitReceipt>();
  private checkpointValue: Checkpoint = {
    namespace_id: namespaceId,
    archive_seq: 0,
    chain_hash: ZERO_HASH,
    schema_revision: SCHEMA_REVISION,
  };
  private nextClientSequence = 1;
  failBefore = 0;
  crashAfterCommit = 0;
  conflict = false;
  malformed = false;

  async capabilities(): Promise<Capabilities> {
    return {
      protocol_versions: [{ major: 1, minor: 0 }],
      schema_revisions: [1],
      hash_algorithm: 'sha256-jcs-hex',
      capability_revision: 'cap-harness-1',
      limits: {
        max_mutations_per_batch: 5000,
        max_request_bytes: 64 * 1024 * 1024,
        max_page_items: 5000,
      },
      features: { reconciliation: true, state_bootstrap: true },
    };
  }

  async health(): Promise<Health> {
    return {
      protocol: SCROLLMARK_PROTOCOL,
      ready: true,
      archive: { archive_id: archiveId },
      active_namespace_ids: [namespaceId],
    };
  }

  async checkpoint(requestedNamespaceId: string): Promise<Checkpoint> {
    if (requestedNamespaceId !== namespaceId) throw new Error('namespace mismatch');
    return this.checkpointValue;
  }

  async commit(request: ArchiveDeltaRequest): Promise<CommitReceipt> {
    if (this.malformed) {
      this.malformed = false;
      throw new CompanionClientError('malformed_response', 'fake malformed receipt', {
        retryable: false,
      });
    }
    if (this.conflict) {
      this.conflict = false;
      throw new CompanionClientError('mutation_hash_conflict', 'fake immutable conflict');
    }
    if (this.failBefore > 0) {
      this.failBefore -= 1;
      throw new CompanionClientError('companion_unavailable', 'fake transport outage', {
        retryable: true,
      });
    }
    for (const mutation of request.batch.mutations) {
      const { record_hash, ...withoutHash } = mutation;
      const expectedRecordHash = await recordHash(namespaceId, withoutHash);
      if (expectedRecordHash !== record_hash) {
        throw new CompanionClientError('batch_hash_mismatch', 'fake record hash mismatch');
      }
      for (const endpoint of ['target', 'subject', 'object'] as const) {
        const value = mutation[endpoint];
        if (value && value.namespace_id !== namespaceId) {
          throw new CompanionClientError(
            'archive_binding_mismatch',
            'fake cross-namespace endpoint',
          );
        }
      }
    }
    const expectedBatchHash = await batchHash(namespaceId, { mutations: request.batch.mutations });
    if (expectedBatchHash !== request.batch.batch_hash) {
      throw new CompanionClientError('batch_hash_mismatch', 'fake batch hash mismatch');
    }
    const duplicate = this.receipts.get(request.batch.batch_id);
    if (duplicate) {
      return { ...duplicate, request_id: request.request_id, result: 'duplicate' };
    }
    if (request.client_sequence.from !== this.nextClientSequence) {
      throw new CompanionClientError('client_sequence_gap', 'fake sequence gap');
    }
    const archiveFrom = this.checkpointValue.archive_seq + 1;
    const archiveTo = archiveFrom + request.batch.mutation_count - 1;
    const committedChainHash = await chainHash(
      namespaceId,
      this.checkpointValue.chain_hash,
      request.batch.batch_hash,
      archiveFrom,
      archiveTo,
    );
    const receipt: CommitReceipt = {
      protocol: SCROLLMARK_PROTOCOL,
      request_id: request.request_id,
      archive_id: archiveId,
      namespace_id: namespaceId,
      client_id: clientId,
      client_epoch: clientEpoch,
      batch_id: request.batch.batch_id,
      result: 'committed',
      client_sequence: request.client_sequence,
      archive_sequence: { from: archiveFrom, to: archiveTo },
      mutation_count: request.batch.mutation_count,
      batch_hash: request.batch.batch_hash,
      prior_chain_hash: this.checkpointValue.chain_hash,
      chain_hash: committedChainHash,
      checkpoint: {
        namespace_id: namespaceId,
        archive_seq: archiveTo,
        chain_hash: committedChainHash,
        schema_revision: SCHEMA_REVISION,
      },
      capability_revision: 'cap-harness-1',
    };
    this.received.push(request);
    this.receipts.set(request.batch.batch_id, receipt);
    this.checkpointValue = receipt.checkpoint;
    this.nextClientSequence = request.client_sequence.to + 1;
    if (this.crashAfterCommit > 0) {
      this.crashAfterCommit -= 1;
      throw new CompanionClientError('internal_commit_unknown', 'fake response lost after commit', {
        retryable: true,
      });
    }
    return receipt;
  }

  async reconcile(request: ReconciliationRequest): Promise<ReconciliationDescriptor> {
    void request;
    return {
      protocol: SCROLLMARK_PROTOCOL,
      stream_id: 'stream-harness',
      namespace_id: namespaceId,
      mode: 'deltas',
      source_checkpoint: this.checkpointValue,
      target_checkpoint: this.checkpointValue,
      manifest_hash: 'a'.repeat(64),
      item_count: 0,
      page_count: 0,
    };
  }

  async reconciliationPage(): Promise<ReconciliationPage> {
    throw new Error('reconciliation pages are not used by the coordinator harness');
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectCode(error: unknown, code: string): void {
  assert(
    error instanceof DurabilityError || error instanceof CompanionClientError,
    `expected typed error ${code}`,
  );
  assert(error.code === code, `expected ${code}, observed ${error.code}`);
}

function makeDbName(label: string): string {
  return `scrollmark-t4-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function makeCoordinator(
  label: string,
  client: FakeCompanion,
  options: { evidence?: IdentityEvidence[]; maxMutations?: number; maxBytes?: number } = {},
) {
  const outbox = new OutboxStore({
    dbName: makeDbName(label),
    now,
    limits: {
      max_mutations: options.maxMutations,
      max_bytes: options.maxBytes,
    },
  });
  const identity = new IdentityController(pairing, now);
  identity.setEvidence(options.evidence ?? identityEvidence);
  const coordinator = new DurabilityCoordinator({
    pairing,
    client,
    identity,
    outbox,
    now,
    randomId: (() => {
      let counter = 0;
      return (prefix = 'id') => `${prefix}-harness-${counter++}`;
    })(),
    retryBaseMs: 1,
  });
  return { coordinator, outbox };
}

function syntheticRequest(sequence: number, batchId: string): ArchiveDeltaRequest {
  return {
    protocol: SCROLLMARK_PROTOCOL,
    request_id: `request-${batchId}`,
    archive_id: archiveId,
    namespace_id: namespaceId,
    client_id: clientId,
    client_epoch: clientEpoch,
    sent_at_ms: now(),
    client_sequence: { from: sequence, to: sequence },
    batch: {
      batch_id: batchId,
      mutation_count: 1,
      mutations: [],
      batch_hash: ZERO_HASH,
    },
    known_checkpoint: null,
  };
}

async function main(): Promise<void> {
  const checks: string[] = [];
  const observed: Record<string, unknown> = {};

  const canonicalLeft = canonicalize({ b: 2, a: { d: false, c: 1 } });
  const canonicalRight = canonicalize({ a: { c: 1, d: false }, b: 2 });
  assert(canonicalLeft === canonicalRight, 'canonical JSON key ordering diverged');
  const vectorHash = await batchHash(namespaceId, { mutations: [] });
  assert(/^[0-9a-f]{64}$/.test(vectorHash), 'batch hash is not SHA-256 hex');
  checks.push('canonical-hash-vectors');
  observed.canonical = { bytes: canonicalLeft.length, empty_batch_hash: vectorHash };

  const missingClient = new FakeCompanion();
  const missing = await makeCoordinator('identity-missing', missingClient, {
    evidence: [identityEvidence[0]],
  });
  let missingLocalWrites = 0;
  try {
    await missing.coordinator.route(
      'extAddTweets',
      ['bookmarks', [{ rest_id: 'unverified-1' }]],
      () => {
        missingLocalWrites += 1;
      },
    );
    throw new Error('unverified identity unexpectedly admitted');
  } catch (error) {
    expectCode(error, 'identity_required');
  }
  assert(missingLocalWrites === 0, 'unverified identity reached local projection');
  await missing.outbox.deleteDatabase();
  checks.push('identity-missing-read-only');

  const conflictClient = new FakeCompanion();
  const conflict = await makeCoordinator('identity-conflict', conflictClient, {
    evidence: [
      identityEvidence[0],
      identityEvidence[1],
      {
        ...identityEvidence[1],
        viewer_id: 'viewer-2',
        source: 'navigation.viewerId',
        signal_class: 'navigation_state',
      },
    ],
  });
  let conflictLocalWrites = 0;
  try {
    await conflict.coordinator.route(
      'extAddUsers',
      ['bookmarks', [{ rest_id: 'conflicting-1' }]],
      () => {
        conflictLocalWrites += 1;
      },
    );
    throw new Error('conflicting identity unexpectedly admitted');
  } catch (error) {
    expectCode(error, 'identity_required');
  }
  assert(conflictLocalWrites === 0, 'conflicting identity reached local projection');
  await conflict.outbox.deleteDatabase();
  checks.push('identity-conflict-read-only');

  const client = new FakeCompanion();
  const { coordinator, outbox } = await makeCoordinator('routes', client);
  let localWrites = 0;
  const localWrite = () => {
    localWrites += 1;
  };
  await coordinator.route(
    'extAddTweets',
    ['bookmarks', [{ rest_id: 'tweet-1', legacy: { full_text: 'hello' } }]],
    localWrite,
  );
  await coordinator.route(
    'extAddUsers',
    ['bookmarks', [{ rest_id: 'user-1', legacy: { screen_name: 'reader' } }]],
    localWrite,
  );
  await coordinator.route('extAddTweetCaptureIds', ['bookmarks', ['tweet-1']], localWrite);
  await coordinator.route('extAddUserCaptureIds', ['bookmarks', ['user-1']], localWrite);
  await coordinator.route(
    'extAddSocialEdges',
    ['bookmarks', [{ id: 'edge-1', subject_user_id: 'user-1', related_user_id: 'user-2' }]],
    localWrite,
  );
  await coordinator.route(
    'extAddCustomCaptures',
    ['notes', [{ id: 'note-1', data_key: 'media-1' }]],
    localWrite,
  );
  await coordinator.route('upsertTweets', [[{ rest_id: 'tweet-2' }]], localWrite);
  await coordinator.route('upsertUsers', [[{ rest_id: 'user-2' }]], localWrite);
  await coordinator.route(
    'upsertCaptures',
    [[{ id: 'capture-1', data_key: 'tweet-2', type: 'tweet', extension: 'bookmarks' }]],
    localWrite,
  );
  await coordinator.route(
    'upsertSocialEdges',
    [
      [
        {
          id: 'edge-2',
          subject_user_id: 'user-2',
          related_user_id: 'user-1',
          extension: 'bookmarks',
        },
      ],
    ],
    localWrite,
  );
  await coordinator.route('extRemoveTweetCaptureIds', ['bookmarks', ['tweet-1']], localWrite);
  assert(localWrites === 11, `expected all successful route writes, got ${localWrites}`);
  assert(
    client.received.length === 11,
    `expected 11 companion batches, got ${client.received.length}`,
  );
  const kinds = client.received.flatMap((request) =>
    request.batch.mutations.map((mutation) => mutation.kind),
  );
  assert(kinds.includes('entity_upsert'), 'entity mutation never reached companion');
  assert(kinds.includes('relationship_upsert'), 'relationship mutation never reached companion');
  assert(
    client.received[0]?.batch.mutations.some((mutation) => mutation.kind === 'relationship_upsert'),
    'tweet insertion omitted capture membership',
  );
  assert(
    client.received[1]?.batch.mutations.some((mutation) => mutation.kind === 'relationship_upsert'),
    'user insertion omitted capture membership',
  );
  assert(kinds.includes('tombstone'), 'tombstone mutation never reached companion');
  assert(
    client.received.every((request) => request.namespace_id === namespaceId),
    'cross-namespace request emitted',
  );
  assert((await outbox.usage()).pending_batches === 0, 'successful route left pending outbox rows');
  checks.push('mutation-route-coverage');
  observed.routes = {
    batches: client.received.length,
    mutation_kinds: [...new Set(kinds)],
    local_writes: localWrites,
    first_batch_mutations: client.received[0]?.batch.mutation_count ?? 0,
    second_batch_mutations: client.received[1]?.batch.mutation_count ?? 0,
  };

  const concurrentClient = new FakeCompanion();
  const concurrent = await makeCoordinator('concurrent-admission', concurrentClient);
  let concurrentWrites = 0;
  await Promise.all([
    concurrent.coordinator.route(
      'extAddTweets',
      ['bookmarks', [{ rest_id: 'concurrent-tweet-1' }]],
      () => {
        concurrentWrites += 1;
      },
    ),
    concurrent.coordinator.route(
      'extAddUsers',
      ['bookmarks', [{ rest_id: 'concurrent-user-1' }]],
      () => {
        concurrentWrites += 1;
      },
    ),
  ]);
  assert(concurrentWrites === 2, 'serialized concurrent routes lost local writes');
  assert(concurrentClient.received.length === 2, 'concurrent routes did not both commit');
  assert(
    concurrentClient.received[1].client_sequence.from ===
      concurrentClient.received[0].client_sequence.to + 1,
    'concurrent routes created a client sequence collision',
  );
  await concurrent.outbox.deleteDatabase();
  checks.push('serialized-concurrent-admission');

  const transportCalls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    protocol: string | null;
    credentials: RequestCredentials | undefined;
  }> = [];
  const transport = new CompanionClient(pairing, {
    origin: 'https://x.com',
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      transportCalls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('Authorization'),
        protocol: headers.get('X-Scrollmark-Protocol'),
        credentials: init?.credentials,
      });
      const url = String(input);
      let payload: unknown;
      if (url.endsWith('/v1/capabilities')) payload = await client.capabilities();
      else if (url.endsWith('/v1/health')) payload = await client.health();
      else if (url.includes('/checkpoint'))
        payload = {
          archive_id: archiveId,
          namespace_id: namespaceId,
          checkpoint: await client.checkpoint(namespaceId),
        };
      else if (url.endsWith('/v1/archive/deltas')) {
        const request = JSON.parse(String(init?.body)) as ArchiveDeltaRequest;
        payload = await client.commit(request);
      } else throw new Error(`unexpected transport URL: ${url}`);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await transport.capabilities();
  await transport.health();
  await transport.checkpoint(namespaceId);
  await transport.commit(client.received[0]);
  assert(
    transportCalls.every((call) => call.authorization === `Bearer ${pairing.token}`),
    'transport omitted bearer authentication',
  );
  assert(
    transportCalls.every((call) => call.protocol === 'v1'),
    'transport omitted protocol header',
  );
  assert(
    transportCalls.every((call) => call.credentials === 'omit'),
    'transport allowed ambient credentials',
  );
  assert(
    transportCalls.some((call) => call.method === 'POST'),
    'transport did not exercise POST proof path',
  );
  try {
    await transport.commit({ ...client.received[0], namespace_id: 'other-namespace' });
    throw new Error('cross-namespace request unexpectedly passed client binding');
  } catch (error) {
    expectCode(error, 'archive_binding_mismatch');
  }
  try {
    new CompanionClient(pairing, {
      origin: 'https://evil.example',
      fetchImpl: async () => new Response('{}'),
    });
    throw new Error('unapproved origin unexpectedly constructed a client');
  } catch (error) {
    expectCode(error, 'origin_denied');
  }
  const badProtocol = new CompanionClient(pairing, {
    origin: 'https://x.com',
    fetchImpl: async () =>
      new Response(JSON.stringify({ protocol: { major: 2, minor: 0 } }), { status: 200 }),
  });
  try {
    await badProtocol.health();
    throw new Error('unsupported protocol health unexpectedly passed');
  } catch (error) {
    expectCode(error, 'protocol_version_unsupported');
  }
  checks.push('authenticated-client-proof-validation');
  observed.transport = {
    requests: transportCalls.length,
    methods: transportCalls.map((call) => call.method),
  };

  const outageClient = new FakeCompanion();
  outageClient.failBefore = 2;
  const outage = await makeCoordinator('outage-fifo', outageClient);
  let outageWrites = 0;
  await outage.coordinator.route('extAddTweets', ['bookmarks', [{ rest_id: 'queued-1' }]], () => {
    outageWrites += 1;
  });
  await outage.coordinator.route('extAddTweets', ['bookmarks', [{ rest_id: 'queued-2' }]], () => {
    outageWrites += 1;
  });
  assert(outageWrites === 2, 'degraded writes did not preserve local projection');
  assert(
    (await outage.outbox.usage()).pending_batches === 2,
    'outage did not retain both immutable rows',
  );
  outage.coordinator.identity.setEvidence([identityEvidence[0]]);
  await outage.coordinator.replayPending();
  assert(
    (await outage.outbox.usage()).pending_batches === 2,
    'identity loss replayed pending rows',
  );
  outage.coordinator.identity.setEvidence(identityEvidence);
  await outage.coordinator.replayPending();
  assert(
    (await outage.outbox.usage()).pending_batches === 0,
    'FIFO replay did not drain outage rows',
  );
  assert(outageClient.received.length === 2, 'FIFO replay did not commit both rows');
  assert(
    outageClient.received[0].batch.mutations[0].mutation_id !==
      outageClient.received[1].batch.mutations[0].mutation_id,
    'replay regenerated mutation identity',
  );
  await outage.outbox.deleteDatabase();
  checks.push('fifo-retry-and-bounds');

  const crashClient = new FakeCompanion();
  crashClient.crashAfterCommit = 1;
  const crash = await makeCoordinator('crash-duplicate', crashClient);
  let crashWrites = 0;
  await crash.coordinator.route('extAddUsers', ['bookmarks', [{ rest_id: 'crash-user' }]], () => {
    crashWrites += 1;
  });
  assert(crashWrites === 1, 'post-commit response loss did not preserve local projection');
  assert((await crash.outbox.usage()).pending_batches === 1, 'unknown commit was not retained');
  await crash.coordinator.replayPending();
  assert(
    (await crash.outbox.usage()).pending_batches === 0,
    'duplicate replay did not acknowledge exact batch',
  );
  assert(crashClient.received.length === 1, 'duplicate replay created a second committed batch');
  await crash.outbox.deleteDatabase();
  checks.push('unknown-commit-duplicate-replay');

  const projectionClient = new FakeCompanion();
  const projection = await makeCoordinator('projection-failure', projectionClient);
  try {
    await projection.coordinator.route(
      'extAddTweets',
      ['bookmarks', [{ rest_id: 'projection-failure' }]],
      () => {
        throw new Error('synthetic local projection failure');
      },
    );
    throw new Error('local projection failure unexpectedly resolved');
  } catch (error) {
    assert(
      error instanceof Error && error.message === 'synthetic local projection failure',
      'wrong projection error',
    );
  }
  assert(
    (await projection.outbox.usage()).pending_batches === 0,
    'verified canonical receipt left an outbox row after projection failure',
  );
  assert(
    projection.coordinator.getStatus().reason === 'local-projection-failed-recovery-required',
    'projection divergence was not reported',
  );
  await projection.outbox.deleteDatabase();
  checks.push('local-projection-divergence');

  const conflictCompanion = new FakeCompanion();
  conflictCompanion.conflict = true;
  const permanent = await makeCoordinator('permanent-conflict', conflictCompanion);
  let permanentWrites = 0;
  try {
    await permanent.coordinator.route(
      'extAddTweets',
      ['bookmarks', [{ rest_id: 'conflict-tweet' }]],
      () => {
        permanentWrites += 1;
      },
    );
    throw new Error('permanent conflict unexpectedly succeeded');
  } catch (error) {
    expectCode(error, 'mutation_hash_conflict');
  }
  assert(permanentWrites === 0, 'permanent conflict reached local projection');
  const permanentUsage = await permanent.outbox.usage();
  assert(permanentUsage.quarantined_batches === 1, 'permanent conflict was not quarantined');
  assert(
    (await permanent.outbox.listQuarantine()).length === 1,
    'quarantine evidence was not persisted',
  );
  assert((await permanent.outbox.usage()).stopped, 'permanent quarantine did not stop the outbox');
  const restartedIdentity = new IdentityController(pairing, now);
  restartedIdentity.setEvidence(identityEvidence);
  const restarted = new DurabilityCoordinator({
    pairing,
    client: conflictCompanion,
    identity: restartedIdentity,
    outbox: permanent.outbox,
    now,
    randomId: (prefix = 'id') => `${prefix}-restarted`,
  });
  await restarted.initialize();
  assert(
    restarted.getStatus().state === 'stopped',
    'quarantine stop did not persist across restart',
  );
  await permanent.outbox.deleteDatabase();
  checks.push('permanent-conflict-quarantine');

  const boundClient = new FakeCompanion();
  boundClient.failBefore = 5;
  const bounded = await makeCoordinator('hard-bound', boundClient, { maxMutations: 2 });
  let boundWrites = 0;
  await bounded.coordinator.route('extAddTweets', ['bookmarks', [{ rest_id: 'bound-1' }]], () => {
    boundWrites += 1;
  });
  try {
    await bounded.coordinator.route('extAddTweets', ['bookmarks', [{ rest_id: 'bound-2' }]], () => {
      boundWrites += 1;
    });
    throw new Error('outbox mutation bound unexpectedly admitted a second row');
  } catch (error) {
    assert(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'outbox_bound_exceeded',
      'wrong hard-bound error',
    );
  }
  assert(boundWrites === 1, 'hard bound allowed a local write without durable admission');
  assert(
    (await bounded.coordinator.getStatus()).state === 'stopped',
    'hard bound did not stop durability',
  );
  await bounded.outbox.deleteDatabase();
  checks.push('hard-bound-stop');

  const warningOutbox = new OutboxStore({
    dbName: makeDbName('warning'),
    now,
    limits: { max_mutations: 5, max_bytes: 1000, max_age_ms: 1000 },
  });
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    await warningOutbox.admit(syntheticRequest(sequence, `warning-${sequence}`), 1);
  }
  assert((await warningOutbox.usage()).warning, '80 percent mutation warning did not surface');
  await warningOutbox.deleteDatabase();

  const byteOutbox = new OutboxStore({
    dbName: makeDbName('bytes'),
    now,
    limits: { max_mutations: 10, max_bytes: 10, max_age_ms: 1000 },
  });
  await byteOutbox.admit(syntheticRequest(1, 'byte-1'), 8);
  try {
    await byteOutbox.admit(syntheticRequest(2, 'byte-2'), 3);
    throw new Error('byte bound unexpectedly admitted a second row');
  } catch (error) {
    assert(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'outbox_bound_exceeded',
      'wrong byte-bound error',
    );
  }
  await byteOutbox.deleteDatabase();

  let ageNow = now();
  const ageOutbox = new OutboxStore({
    dbName: makeDbName('age'),
    now: () => ageNow,
    limits: { max_mutations: 10, max_bytes: 1000, max_age_ms: 10 },
  });
  await ageOutbox.admit(syntheticRequest(1, 'age-1'), 1);
  ageNow += 11;
  try {
    await ageOutbox.admit(syntheticRequest(2, 'age-2'), 1);
    throw new Error('age bound unexpectedly admitted a stale row');
  } catch (error) {
    assert(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'outbox_bound_exceeded',
      'wrong age-bound error',
    );
  }
  assert((await ageOutbox.usage()).stopped, 'age bound did not stop outbox');
  await ageOutbox.deleteDatabase();

  const persistenceOutbox = new OutboxStore({ dbName: makeDbName('persistence'), now });
  await persistenceOutbox.close();
  try {
    await persistenceOutbox.admit(syntheticRequest(1, 'persistence-1'), 1);
    throw new Error('closed outbox unexpectedly admitted a row');
  } catch (error) {
    assert(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'outbox_bound_exceeded',
      'wrong persistence error',
    );
  }
  await persistenceOutbox.deleteDatabase();
  checks.push('outbox-warning-byte-age-persistence-bounds');

  const privateClient = new FakeCompanion();
  const privateLane = await makeCoordinator('private-lane', privateClient);
  let privateWrites = 0;
  try {
    await privateLane.coordinator.route(
      'extAddTweets',
      ['bookmarks', [{ rest_id: 'private-1', direct_messages: ['blocked'] }]],
      () => {
        privateWrites += 1;
      },
    );
    throw new Error('private payload unexpectedly admitted');
  } catch (error) {
    expectCode(error, 'private_lane_disabled');
  }
  assert(privateWrites === 0, 'private payload reached local projection');
  await privateLane.outbox.deleteDatabase();
  checks.push('private-lane-rejection');

  const evidence = {
    card_version: 1,
    card_id: 't4-durability-coordinator',
    scenario: 'browser companion identity outbox coordinator',
    status: 'passed',
    source_identity: {
      build_id: 't4-harness',
      config_hash: 'local-focused-harness',
      contract_revision: 'scrollmark-companion-0.1.0',
    },
    fixture: 'durability_coordinator_harness.ts',
    expected: {
      identity_signals: 2,
      hard_bounds: {
        mutations: 50_000,
        bytes: 512 * 1024 * 1024,
        oldest_age_ms: 24 * 60 * 60 * 1000,
      },
      warning_ratio: 0.8,
      receipt_rule: 'committed-or-duplicate-linked-receipt-only',
    },
    observed: { checks, ...observed },
    privacy: {
      dm_allowed: false,
      excluded_fields: ['bearer_token', 'cookies', 'raw_response_body', 'direct_messages'],
    },
    retries: { attempts: 1, retryable_failures: 3, permanent_failures: 1 },
    artifacts: [],
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

await main();
