import fs from 'node:fs';
import path from 'node:path';

import 'fake-indexeddb/auto';

import type {
  ArchiveDeltaRequest,
  Capabilities,
  Checkpoint,
  CommitReceipt,
  Health,
  Mutation,
  ReconciliationDescriptor,
  ReconciliationPage,
} from '../../src/core/durability/contracts';
import type { CompanionClientLike } from '../../src/core/durability/companion-client';
import type { ActiveGenerationPointer } from '../../src/core/durability/generation-state';
import type { PairingContext } from '../../src/core/durability/identity';

const [, , outPathArg = 'e2e/perf/out/generation-rebuild.json'] = process.argv;
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
const windowMock = {
  localStorage,
  setTimeout,
  clearTimeout,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  __META_DATA__: { userId: 'generation-rebuild-harness' },
};
Object.assign(globalThis, {
  localStorage,
  window: windowMock,
  unsafeWindow: windowMock,
  self: globalThis,
  GM_getValue: (key: string) => gmValues.get(key),
  GM_setValue: (key: string, value: unknown) => gmValues.set(key, value),
  GM_deleteValue: (key: string) => gmValues.delete(key),
});

// These modules touch browser globals at evaluation time; load them after the harness installs fake browser storage.
const { canonicalize, recordHash, SCHEMA_REVISION, SCROLLMARK_PROTOCOL, sha256Hex, ZERO_HASH } =
  await import('../../src/core/durability/contracts');
const { ensureCanonicalArchiveProjection, rebuildCanonicalGeneration } =
  await import('../../src/core/durability/generation');
const { clearMigrationJournal, readActiveGenerationPointer } =
  await import('../../src/core/durability/generation-state');
const { DatabaseManager } = await import('../../src/core/database/manager');
const Dexie = (await import('dexie')).default;
const {
  bootstrapExistingBrowserArchiveIfNeeded,
  migrateBrowserGeneration,
  readMigrationState,
  recoverInterruptedMigration,
} = await import('../../src/core/durability/migration');
const { IdentityController } = await import('../../src/core/durability/identity');

const pairing: PairingContext = {
  base_url: 'http://127.0.0.1:8755',
  token: 'harness-token-never-emitted',
  archive_id: 'archive-generation-harness',
  namespace_id: 'namespace-generation-harness',
  client_id: 'client-generation-harness',
  client_epoch: 'epoch-generation-harness',
  viewer_id: 'viewer-generation-harness',
  origin: 'https://x.com',
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkpoint(archiveSeq: number, chainHash: string): Checkpoint {
  return {
    namespace_id: pairing.namespace_id,
    archive_seq: archiveSeq,
    chain_hash: chainHash,
    schema_revision: SCHEMA_REVISION,
  };
}

function tweet(id: string, text: string): Record<string, unknown> {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      created_at: 'Thu Sep 28 11:07:25 +0000 2023',
      full_text: text,
      favorite_count: 1,
      retweet_count: 0,
      reply_count: 0,
      bookmark_count: 1,
      lang: 'en',
    },
    core: {
      user_results: {
        result: {
          rest_id: 'user-1',
          core: { screen_name: 'author_one' },
        },
      },
    },
  };
}

function user(id: string): Record<string, unknown> {
  return {
    __typename: 'User',
    id,
    rest_id: id,
    core: { name: 'Author One', screen_name: 'author_one' },
    legacy: { description: 'A reconstructed user' },
  };
}

async function entityMutation(
  kind: 'tweet' | 'user',
  id: string,
  payload: Record<string, unknown>,
  clientSeq: number,
): Promise<Mutation> {
  const mutationInput = {
    mutation_id: `mutation-${clientSeq}`,
    client_seq: clientSeq,
    kind: 'entity_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    target: { namespace_id: pairing.namespace_id, kind, id },
    payload,
    provenance: { source: 'generation-rebuild-harness', source_event_id: `event-${clientSeq}` },
    observed_at_ms: 1_700_000_000_000 + clientSeq,
  };
  return { ...mutationInput, record_hash: await recordHash(pairing.namespace_id, mutationInput) };
}

async function captureMutation(
  kind: 'tweet' | 'user',
  id: string,
  extension: string,
  clientSeq: number,
): Promise<Mutation> {
  const mutationInput = {
    mutation_id: `mutation-${clientSeq}`,
    client_seq: clientSeq,
    kind: 'relationship_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    relationship_kind: 'capture_membership' as const,
    subject: { namespace_id: pairing.namespace_id, kind, id },
    object: {
      namespace_id: pairing.namespace_id,
      kind: 'folder' as const,
      id: `capture:${extension}`,
    },
    qualifier: { extension },
    payload: { extension, data_key: id },
    provenance: { source: 'generation-rebuild-harness', source_event_id: `event-${clientSeq}` },
    observed_at_ms: 1_700_000_000_000 + clientSeq,
  };
  return { ...mutationInput, record_hash: await recordHash(pairing.namespace_id, mutationInput) };
}

async function bookmarkFolderMutation(id: string, clientSeq: number): Promise<Mutation> {
  const mutationInput = {
    mutation_id: `mutation-${clientSeq}`,
    client_seq: clientSeq,
    kind: 'relationship_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    relationship_kind: 'bookmark_folder_membership' as const,
    subject: { namespace_id: pairing.namespace_id, kind: 'tweet' as const, id },
    object: { namespace_id: pairing.namespace_id, kind: 'folder' as const, id: 'folder-recovered' },
    qualifier: {},
    payload: { folder_id: 'folder-recovered', folder_name: 'Recovered folder' },
    provenance: { source: 'generation-rebuild-harness', source_event_id: `event-${clientSeq}` },
    observed_at_ms: 1_700_000_000_000 + clientSeq,
  };
  return { ...mutationInput, record_hash: await recordHash(pairing.namespace_id, mutationInput) };
}

async function articleMutation(id: string, clientSeq: number): Promise<Mutation> {
  const mutationInput = {
    mutation_id: `mutation-${clientSeq}`,
    client_seq: clientSeq,
    kind: 'enrichment_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    enrichment_kind: 'article_markdown' as const,
    target: { namespace_id: pairing.namespace_id, kind: 'tweet' as const, id },
    payload: { markdown: '# Recovered article', version: 3 },
    provenance: { source: 'generation-rebuild-harness', source_event_id: `event-${clientSeq}` },
    observed_at_ms: 1_700_000_000_000 + clientSeq,
  };
  return { ...mutationInput, record_hash: await recordHash(pairing.namespace_id, mutationInput) };
}

async function makePage(
  streamId: string,
  pageIndex: number,
  items: Array<{ state_key: string; archive_seq: number; mutation: Mutation }>,
  manifestHash: string,
  targetCheckpoint: Checkpoint,
  final: boolean,
  nextCursor?: string,
): Promise<ReconciliationPage> {
  const pageWithoutHash = {
    protocol: SCROLLMARK_PROTOCOL,
    stream_id: streamId,
    namespace_id: pairing.namespace_id,
    mode: 'state_bootstrap' as const,
    page_index: pageIndex,
    item_count: items.length,
    byte_count: 0,
    items: items.map((item) => ({
      state_key: item.state_key,
      archive_seq: item.archive_seq,
      mutation_id: item.mutation.mutation_id,
      mutation: item.mutation,
      record_hash: item.mutation.record_hash,
    })),
    page_hash: '',
    target_checkpoint: targetCheckpoint,
    manifest_hash: manifestHash,
    final,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
  pageWithoutHash.byte_count = new TextEncoder().encode(
    canonicalize(pageWithoutHash.items),
  ).byteLength;
  const pageHash = await sha256Hex({ ...pageWithoutHash, page_hash: undefined });
  const page = { ...pageWithoutHash, page_hash: pageHash } as ReconciliationPage;
  const { page_hash: _ignored, ...material } = page;
  void _ignored;
  page.page_hash = await sha256Hex(material);
  return page;
}

class FakeGenerationCompanion implements CompanionClientLike {
  private readonly pages = new Map<string, ReconciliationPage>();
  private readonly descriptor: ReconciliationDescriptor;
  private bootstrapProbe = false;
  private bootstrapCommitted = false;

  constructor() {
    this.descriptor = undefined as unknown as ReconciliationDescriptor;
  }

  async capabilities(): Promise<Capabilities> {
    return {
      protocol_versions: [SCROLLMARK_PROTOCOL],
      schema_revisions: [SCHEMA_REVISION],
      hash_algorithm: 'sha256-jcs-hex',
      capability_revision: 'generation-harness-v1',
      limits: {
        max_mutations_per_batch: 5_000,
        max_bytes_per_batch: 4_000_000,
        max_items_per_page: 5_000,
      },
      features: { reconciliation: true, commit: true },
    };
  }

  async health(): Promise<Health> {
    return {
      protocol: SCROLLMARK_PROTOCOL,
      ready: true,
      archive: { archive_id: pairing.archive_id },
      active_namespace_ids: [pairing.namespace_id],
    };
  }

  async checkpoint(): Promise<Checkpoint> {
    return this.bootstrapProbe && !this.bootstrapCommitted
      ? checkpoint(0, ZERO_HASH)
      : this.descriptor.target_checkpoint;
  }

  async commit(request: ArchiveDeltaRequest): Promise<CommitReceipt> {
    this.bootstrapCommitted = true;
    const first = request.batch.mutations[0]?.client_seq ?? request.client_sequence.from;
    const last = request.batch.mutations[request.batch.mutations.length - 1]?.client_seq ?? first;
    return {
      protocol: SCROLLMARK_PROTOCOL,
      request_id: request.request_id,
      archive_id: pairing.archive_id,
      namespace_id: pairing.namespace_id,
      client_id: pairing.client_id,
      client_epoch: pairing.client_epoch,
      batch_id: request.batch.batch_id,
      result: 'committed',
      client_sequence: { from: first, to: last },
      archive_sequence: { from: 1, to: request.batch.mutation_count },
      mutation_count: request.batch.mutation_count,
      batch_hash: request.batch.batch_hash,
      prior_chain_hash: ZERO_HASH,
      chain_hash: this.descriptor.target_checkpoint.chain_hash,
      checkpoint: this.descriptor.target_checkpoint,
      capability_revision: 'generation-harness-v1',
    };
  }

  prepareBrowserBootstrap(): void {
    this.bootstrapProbe = true;
    this.bootstrapCommitted = false;
  }

  async reconcile(): Promise<ReconciliationDescriptor> {
    if (this.bootstrapProbe && !this.bootstrapCommitted) {
      return {
        ...this.descriptor,
        source_checkpoint: checkpoint(0, ZERO_HASH),
        target_checkpoint: checkpoint(0, ZERO_HASH),
        manifest_hash: '0'.repeat(64),
        item_count: 0,
        page_count: 1,
      };
    }
    return this.descriptor;
  }

  async reconciliationPage(streamId: string, cursor?: string): Promise<ReconciliationPage> {
    const key = cursor ?? `${streamId}:0`;
    const page = this.pages.get(key);
    assert(page, `missing page ${key}`);
    return page;
  }

  static async create(): Promise<FakeGenerationCompanion> {
    const companion = new FakeGenerationCompanion();
    const streamId = 'stream-generation-harness';
    const targetCheckpoint = checkpoint(8, 'f'.repeat(64));
    const mutations = [
      {
        state_key: 'relationship:bookmark-folder:tweet-1',
        archive_seq: 1,
        mutation: await bookmarkFolderMutation('tweet-1', 1),
      },
      {
        state_key: 'enrichment:article:tweet-1',
        archive_seq: 2,
        mutation: await articleMutation('tweet-1', 2),
      },
      {
        state_key: 'entity:tweet:tweet-1',
        archive_seq: 3,
        mutation: await entityMutation(
          'tweet',
          'tweet-1',
          tweet('tweet-1', 'First reconstructed tweet'),
          3,
        ),
      },
      {
        state_key: 'entity:tweet:tweet-2',
        archive_seq: 4,
        mutation: await entityMutation(
          'tweet',
          'tweet-2',
          tweet('tweet-2', 'Second reconstructed tweet'),
          4,
        ),
      },
      {
        state_key: 'entity:user:user-1',
        archive_seq: 5,
        mutation: await entityMutation('user', 'user-1', user('user-1'), 5),
      },
      {
        state_key: 'capture:bookmarks:tweet-1',
        archive_seq: 6,
        mutation: await captureMutation('tweet', 'tweet-1', 'bookmarks', 6),
      },
      {
        state_key: 'capture:bookmarks:tweet-2',
        archive_seq: 7,
        mutation: await captureMutation('tweet', 'tweet-2', 'bookmarks', 7),
      },
      {
        state_key: 'capture:followers:user-1',
        archive_seq: 8,
        mutation: await captureMutation('user', 'user-1', 'followers', 8),
      },
    ];
    const items = mutations.map((item) => ({
      state_key: item.state_key,
      archive_seq: item.archive_seq,
      mutation: item.mutation,
      record_hash: item.mutation.record_hash,
      mutation_id: item.mutation.mutation_id,
    }));
    const manifestHash = await sha256Hex({
      mode: 'state_bootstrap',
      namespace_id: pairing.namespace_id,
      source_checkpoint: checkpoint(0, ZERO_HASH),
      target_checkpoint: targetCheckpoint,
      items,
    });
    const first = await makePage(
      streamId,
      0,
      mutations.slice(0, 2),
      manifestHash,
      targetCheckpoint,
      false,
      'cursor-1',
    );
    const second = await makePage(
      streamId,
      1,
      mutations.slice(2, 4),
      manifestHash,
      targetCheckpoint,
      false,
      'cursor-2',
    );
    const third = await makePage(
      streamId,
      2,
      mutations.slice(4, 6),
      manifestHash,
      targetCheckpoint,
      false,
      'cursor-3',
    );
    const fourth = await makePage(
      streamId,
      3,
      mutations.slice(6),
      manifestHash,
      targetCheckpoint,
      true,
    );
    companion.pages.set(`${streamId}:0`, first);
    companion.pages.set('cursor-1', second);
    companion.pages.set('cursor-2', third);
    companion.pages.set('cursor-3', fourth);
    (companion as { descriptor: ReconciliationDescriptor }).descriptor = {
      protocol: SCROLLMARK_PROTOCOL,
      stream_id: streamId,
      namespace_id: pairing.namespace_id,
      mode: 'state_bootstrap',
      source_checkpoint: checkpoint(0, ZERO_HASH),
      target_checkpoint: targetCheckpoint,
      manifest_hash: manifestHash,
      item_count: items.length,
      page_count: 4,
    };
    return companion;
  }
}

async function inspect(pointer: ActiveGenerationPointer) {
  const manager = new DatabaseManager({
    databaseName: pointer.database_name,
    publishActiveName: false,
  });
  await manager.whenReady();
  const stats = await manager.count();
  assert(stats, 'database stats unavailable');
  const indexedTweets = await manager.extGetCaptureIdsIndexedPage('bookmarks', {
    type: 'tweet' as never,
    offset: 0,
    limit: 10,
    sourceCount: 2,
  });
  const indexedUsers = await manager.extGetCaptureIdsIndexedPage('followers', {
    type: 'user' as never,
    offset: 0,
    limit: 10,
    sourceCount: 1,
  });
  const recoveredTweet = await (
    manager as unknown as {
      tweets(): { get(id: string): Promise<Record<string, unknown> | undefined> };
    }
  )
    .tweets()
    .get('tweet-1');
  manager.close();
  return {
    database_name: pointer.database_name,
    counts: {
      tweets: stats.tweets,
      users: stats.users,
      captures: stats.captures,
      social_edges: stats.social_edges,
      search_documents: stats.search_documents,
      capture_index_pages: stats.capture_index_pages,
    },
    indexed_tweets: indexedTweets,
    indexed_users: indexedUsers,
    recovered_tweet: recoveredTweet,
  };
}

const companion = await FakeGenerationCompanion.create();
const first = await rebuildCanonicalGeneration({ pairing, client: companion });
const firstInspection = await inspect(first.pointer);
assert(firstInspection.counts.tweets === 2, 'first generation lost tweets');
assert(firstInspection.counts.users === 1, 'first generation lost users');
assert(firstInspection.counts.captures === 3, 'first generation lost captures');
assert(firstInspection.counts.search_documents === 3, 'first generation lost search documents');
assert(firstInspection.indexed_tweets?.includes('tweet-1'), 'tweet capture index was not rebuilt');
assert(
  firstInspection.recovered_tweet?.__bookmark_folder_id === 'folder-recovered',
  'cross-page bookmark folder membership was lost',
);
assert(
  (firstInspection.recovered_tweet?.twe_private_fields as Record<string, unknown> | undefined)
    ?.article_markdown === '# Recovered article',
  'article Markdown enrichment was lost',
);
assert(firstInspection.indexed_users?.includes('user-1'), 'user capture index was not rebuilt');

await Dexie.delete(first.pointer.database_name);
assert(
  !(await Dexie.exists(first.pointer.database_name)),
  'generation database deletion did not complete',
);
const second = await ensureCanonicalArchiveProjection({ pairing, client: companion });
assert(second, 'missing-generation ensure did not rebuild');
const secondInspection = await inspect(second.pointer);
assert(
  secondInspection.counts.tweets === firstInspection.counts.tweets,
  'rebuild tweet count changed',
);
assert(
  secondInspection.counts.users === firstInspection.counts.users,
  'rebuild user count changed',
);
assert(
  secondInspection.counts.captures === firstInspection.counts.captures,
  'rebuild capture count changed',
);
assert(
  secondInspection.counts.search_documents === firstInspection.counts.search_documents,
  'rebuild search count changed',
);
assert(
  readActiveGenerationPointer()?.database_name === second.pointer.database_name,
  'active generation pointer not swapped',
);
assert(second.pointer.verification === 'verified', 'active generation pointer is not verified');
const damaged = new DatabaseManager({
  databaseName: second.pointer.database_name,
  publishActiveName: false,
});
await damaged.whenReady();
await damaged.applyGenerationProjection({ deleteTweets: ['tweet-2'] });
damaged.close();
const repairedPartial = await ensureCanonicalArchiveProjection({ pairing, client: companion });
assert(repairedPartial, 'partial active generation was trusted without exact count verification');
const repairedInspection = await inspect(repairedPartial.pointer);
assert(repairedInspection.counts.tweets === 2, 'partial generation repair lost canonical tweets');
const sameCountCorruptor = new DatabaseManager({
  databaseName: repairedPartial.pointer.database_name,
  publishActiveName: false,
});
await sameCountCorruptor.whenReady();
await sameCountCorruptor.applyGenerationProjection({
  tweets: [tweet('tweet-2', 'Same-count corrupted tweet') as never],
});
sameCountCorruptor.close();
const repairedContent = await ensureCanonicalArchiveProjection({ pairing, client: companion });
assert(
  repairedContent,
  'same-count row corruption was trusted without projection hash verification',
);
const repairedContentInspection = await inspect(repairedContent.pointer);
assert(
  repairedContentInspection.recovered_tweet?.legacy &&
    repairedContentInspection.counts.tweets === 2,
  'same-count content repair lost canonical projection',
);
assert(second.pointer.protocol_version.major === 1, 'active generation protocol proof missing');
const admittedEvidence = [
  {
    viewer_id: pairing.viewer_id,
    source: 'harness-meta',
    signal_class: 'metadata' as const,
    observed_at_ms: Date.now(),
    origin: 'https://x.com',
    confidence: 1,
  },
  {
    viewer_id: pairing.viewer_id,
    source: 'harness-session',
    signal_class: 'session_state' as const,
    observed_at_ms: Date.now(),
    origin: 'https://x.com',
    confidence: 1,
  },
];
const migrationIdentity = new IdentityController(pairing);

const migrated = await migrateBrowserGeneration({
  pairing,
  identity: migrationIdentity,
  identityEvidence: admittedEvidence,
  client: companion,
});
assert(migrated.pointer.archive_id === pairing.archive_id, 'migration changed archive binding');
assert(readMigrationState()?.phase === 'committed', 'migration journal did not reach committed');
assert(
  await Dexie.exists(repairedContent.pointer.database_name),
  'prior verified generation was retired too early',
);
const migratedPointerName = migrated.pointer.database_name;
let unknownMigrationRejected = false;
try {
  await migrateBrowserGeneration({
    pairing,
    identity: migrationIdentity,
    identityEvidence: admittedEvidence,
    client: companion,
    sourceProtocol: { major: 2, minor: 0 },
  });
} catch {
  unknownMigrationRejected = true;
}
assert(unknownMigrationRejected, 'unknown protocol migration was not rejected');
assert(
  recoverInterruptedMigration().action === 'rollback_required',
  'interrupted migration was not gated',
);
assert(
  readActiveGenerationPointer()?.database_name === migratedPointerName,
  'rejected migration changed active pointer',
);
clearMigrationJournal();

const browserSource = new DatabaseManager({
  databaseName: 'twitter-web-exporter',
  publishActiveName: false,
});
await browserSource.whenReady();
await browserSource.upsertTweets([
  tweet('tweet-1', 'Browser-only tweet one') as never,
  tweet('tweet-2', 'Browser-only tweet two') as never,
]);
await browserSource.upsertUsers([user('user-1') as never]);
await browserSource.upsertCaptures([
  {
    id: 'capture-bookmarks-1',
    extension: 'bookmarks',
    type: 'tweet',
    data_key: 'tweet-1',
    created_at: 1_700_000_000_001,
  },
  {
    id: 'capture-bookmarks-2',
    extension: 'bookmarks',
    type: 'tweet',
    data_key: 'tweet-2',
    created_at: 1_700_000_000_002,
  },
]);
const browserSourceStats = await browserSource.count();
assert(
  browserSourceStats?.tweets === 2 && browserSourceStats.captures === 2,
  'browser-only source seed failed',
);
browserSource.close();
gmValues.delete('__twe_generation_pointer_v1');
companion.prepareBrowserBootstrap();
const bootstrapManager = new DatabaseManager({
  databaseName: 'twitter-web-exporter',
  publishActiveName: false,
});
const bootstrapIdentity = new IdentityController(pairing);
const bootstrap = await bootstrapExistingBrowserArchiveIfNeeded({
  manager: bootstrapManager,
  identity: bootstrapIdentity,
  identityEvidence: admittedEvidence,
  pairing,
  client: companion,
  clientSequenceStart: 100,
  batchSize: 2,
});
assert(bootstrap.bootstrapped, 'browser-only archive was not bootstrapped');
assert(bootstrap.result?.receipts.length === 3, 'bootstrap receipt batching changed');
assert(bootstrap.result?.source_counts.tweets === 2, 'bootstrap tweet source count changed');
assert(bootstrap.result?.source_counts.captures === 2, 'bootstrap capture source count changed');
assert(
  readActiveGenerationPointer()?.archive_id === pairing.archive_id,
  'bootstrap pointer archive binding missing',
);
assert(
  await Dexie.exists('twitter-web-exporter'),
  'browser source database was destructively removed',
);
bootstrapManager.close();
const tombstoneDatabaseName = 'twitter-web-exporter-generation-tombstone-harness';
await Dexie.delete(tombstoneDatabaseName);
const tombstoneManager = new DatabaseManager({
  databaseName: tombstoneDatabaseName,
  publishActiveName: false,
});
await tombstoneManager.whenReady();
await tombstoneManager.applyGenerationProjection({
  deleteTweets: ['deleted-tweet'],
  tweetPatches: [
    {
      id: 'deleted-tweet',
      fields: {
        twe_private_fields: {
          article_markdown: '# Must not resurrect',
          article_markdown_version: 1,
        },
      } as never,
    },
  ],
});
const tombstoneStubsRemoved = await tombstoneManager.deleteGenerationPatchStubs();
const tombstoneStats = await tombstoneManager.count();
assert(
  tombstoneStubsRemoved === 1 && tombstoneStats?.tweets === 0,
  `enrichment patch resurrected a tombstoned tweet: removed=${tombstoneStubsRemoved} tweets=${tombstoneStats?.tweets}`,
);
tombstoneManager.close();
await Dexie.delete(tombstoneDatabaseName);

const evidence = {
  card_version: 1,
  card_id: 't5-generation-rebuild',
  scenario: 'browser cache generation rebuild from immutable companion bootstrap pages',
  status: 'passed',
  source_identity: {
    build_id: 't5-generation-harness',
    config_hash: 'local-generation-rebuild',
    contract_revision: 'scrollmark-companion-0.1.0',
  },
  expected: {
    pages: 4,
    items: 8,
    counts: { tweets: 2, users: 1, captures: 3, search_documents: 3 },
    recovery:
      'delete, partially damage, or same-count corrupt active IndexedDB then rebuild from the same pinned stream',
    migration: 'compatible migration commits; unknown protocol rejects without pointer change',
    bootstrap:
      'identity-admitted browser-only rows commit in bounded batches and source remains intact',
  },
  observed: {
    first: firstInspection,
    second: secondInspection,
    first_pointer: first.pointer,
    second_pointer: second.pointer,
    migrated_pointer: migrated.pointer,
    bootstrap: {
      receipts: bootstrap.result?.receipts.length,
      source_counts: bootstrap.result?.source_counts,
    },
    tombstone_stubs_removed: tombstoneStubsRemoved,
    same_count_repair: repairedContent.pointer,
    partial_repair: repairedPartial.pointer,
  },
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(evidence));
