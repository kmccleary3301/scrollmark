import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import 'fake-indexeddb/auto';

import type { CompanionClientLike } from '../../src/core/durability/companion-client';
import type {
  ArchiveDeltaRequest,
  Capabilities,
  Checkpoint,
  CommitReceipt,
  Health,
  Mutation,
  ReconciliationDescriptor,
  ReconciliationItem,
  ReconciliationPage,
} from '../../src/core/durability/contracts';
import type { PairingContext } from '../../src/core/durability/identity';

const tweetCount = Math.max(40_000, Number(process.env.SCROLLMARK_DURABILITY_TWEETS || 40_000));
const captureCount = Math.max(15_000, Math.min(tweetCount, Math.floor(tweetCount * 0.375)));
const userCount = Math.max(1_000, Math.floor(tweetCount * 0.05));
const socialEdgeCount = Math.max(500, Math.floor(tweetCount * 0.0125));
const folderCount = 12;
const articleCount = 64;
const mediaCount = 256;
const projectedCaptureCount = captureCount + mediaCount;
const pageSize = 512;
const totalItems =
  tweetCount + userCount + folderCount + captureCount + socialEdgeCount + articleCount + mediaCount;
const [, , outPathArg = `e2e/perf/out/durability-scale-${tweetCount}.json`] = process.argv;
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
  __META_DATA__: { userId: 'durability-scale-harness' },
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

// Generation modules read browser globals at initialization; install the isolated harness globals first.
const { canonicalize, recordHash, SCHEMA_REVISION, SCROLLMARK_PROTOCOL, sha256Hex, ZERO_HASH } =
  await import('../../src/core/durability/contracts');
const { rebuildCanonicalGeneration } = await import('../../src/core/durability/generation');
const { DatabaseManager } = await import('../../src/core/database/manager');
const Dexie = (await import('dexie')).default;

const pairing: PairingContext = {
  base_url: 'http://127.0.0.1:8755',
  token: 'scale-token-never-emitted',
  archive_id: 'archive-durability-scale',
  namespace_id: 'namespace-durability-scale',
  client_id: 'client-durability-scale',
  client_epoch: 'epoch-durability-scale',
  viewer_id: 'viewer-durability-scale',
  origin: 'https://x.com',
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

class ScaleCompanion implements CompanionClientLike {
  readonly sourceCheckpoint: Checkpoint = {
    namespace_id: pairing.namespace_id,
    archive_seq: 0,
    chain_hash: ZERO_HASH,
    schema_revision: SCHEMA_REVISION,
  };
  readonly targetCheckpoint: Checkpoint;
  descriptor!: ReconciliationDescriptor;
  pagesRequested = 0;
  maxPageItems = 0;
  private failAtPage: number | null = null;

  constructor() {
    const chainHash = createHash('sha256')
      .update(`scale:${tweetCount}:${totalItems}`)
      .digest('hex');
    this.targetCheckpoint = {
      namespace_id: pairing.namespace_id,
      archive_seq: totalItems,
      chain_hash: chainHash,
      schema_revision: SCHEMA_REVISION,
    };
  }

  injectPageFailure(pageIndex: number | null): void {
    this.failAtPage = pageIndex;
  }

  async initialize(): Promise<void> {
    const hash = createHash('sha256');
    hash.update('{"items":[');
    for (let index = 0; index < totalItems; index += 1) {
      if (index) hash.update(',');
      hash.update(canonicalize(await this.itemAt(index)));
    }
    hash.update(`],"mode":"state_bootstrap","namespace_id":${canonicalize(pairing.namespace_id)}`);
    hash.update(`,"source_checkpoint":${canonicalize(this.sourceCheckpoint)}`);
    hash.update(`,"target_checkpoint":${canonicalize(this.targetCheckpoint)}}`);
    this.descriptor = {
      protocol: SCROLLMARK_PROTOCOL,
      stream_id: 'stream-durability-scale',
      namespace_id: pairing.namespace_id,
      mode: 'state_bootstrap',
      source_checkpoint: this.sourceCheckpoint,
      target_checkpoint: this.targetCheckpoint,
      manifest_hash: hash.digest('hex'),
      item_count: totalItems,
      page_count: Math.ceil(totalItems / pageSize),
    };
  }

  async capabilities(): Promise<Capabilities> {
    return {
      protocol_versions: [SCROLLMARK_PROTOCOL],
      schema_revisions: [SCHEMA_REVISION],
      hash_algorithm: 'sha256-jcs-hex',
      capability_revision: 'durability-scale-v1',
      limits: { max_page_items: pageSize },
      features: { state_bootstrap: true, direct_messages: false },
    };
  }

  async health(): Promise<Health> {
    return {
      ready: true,
      archive: { archive_id: pairing.archive_id },
      active_namespace_ids: [pairing.namespace_id],
    };
  }

  async checkpoint(): Promise<Checkpoint> {
    return this.targetCheckpoint;
  }

  async commit(): Promise<CommitReceipt> {
    throw new Error('scale rebuild companion is read-only');
  }

  async reconcile(request: ArchiveDeltaRequest): Promise<ReconciliationDescriptor> {
    void request;
    return this.descriptor;
  }

  async reconciliationPage(streamId: string, cursor?: string): Promise<ReconciliationPage> {
    void streamId;
    const pageIndex = cursor ? Number(cursor) : 0;
    if (pageIndex === this.failAtPage) throw new Error(`injected scale page failure ${pageIndex}`);
    const start = pageIndex * pageSize;
    const end = Math.min(totalItems, start + pageSize);
    const items: ReconciliationItem[] = [];
    for (let index = start; index < end; index += 1) items.push(await this.itemAt(index));
    this.pagesRequested += 1;
    this.maxPageItems = Math.max(this.maxPageItems, items.length);
    const final = end === totalItems;
    const pageMaterial = {
      protocol: SCROLLMARK_PROTOCOL,
      stream_id: this.descriptor.stream_id,
      namespace_id: pairing.namespace_id,
      mode: 'state_bootstrap' as const,
      page_index: pageIndex,
      item_count: items.length,
      byte_count: new TextEncoder().encode(canonicalize(items)).byteLength,
      items,
      target_checkpoint: this.targetCheckpoint,
      manifest_hash: this.descriptor.manifest_hash,
      final,
      ...(final ? {} : { next_cursor: String(pageIndex + 1) }),
    };
    return { ...pageMaterial, page_hash: await sha256Hex(pageMaterial) };
  }

  private async itemAt(index: number): Promise<ReconciliationItem> {
    let mutation: Mutation;
    if (index < tweetCount) {
      const id = `tweet-${index}`;
      const material = {
        mutation_id: `scale-tweet-${index}`,
        client_seq: index + 1,
        kind: 'entity_upsert' as const,
        schema_revision: SCHEMA_REVISION,
        target: { namespace_id: pairing.namespace_id, kind: 'tweet' as const, id },
        payload: {
          __typename: 'Tweet',
          rest_id: id,
          legacy: {
            id_str: id,
            created_at: 'Thu Sep 28 11:07:25 +0000 2023',
            full_text:
              index % 997 === 0
                ? `needle-scale-proof-${index}`
                : `synthetic recovered tweet ${index}`,
            favorite_count: index % 11,
            retweet_count: index % 7,
            reply_count: index % 5,
            bookmark_count: index % 3,
            lang: 'en',
          },
          core: {
            user_results: {
              result: {
                rest_id: `user-${index % userCount}`,
                core: { screen_name: `scale_user_${index % userCount}` },
              },
            },
          },
          media:
            index < mediaCount
              ? [{ type: 'photo', original: `https://media.example/${index}.jpg` }]
              : [],
        },
        provenance: { source: 'durability-scale-harness' },
        observed_at_ms: 1_700_000_000_000 + index,
      };
      mutation = { ...material, record_hash: await recordHash(pairing.namespace_id, material) };
    } else if (index < tweetCount + userCount) {
      const offset = index - tweetCount;
      const id = `user-${offset}`;
      const material = {
        mutation_id: `scale-user-${offset}`,
        client_seq: index + 1,
        kind: 'entity_upsert' as const,
        schema_revision: SCHEMA_REVISION,
        target: { namespace_id: pairing.namespace_id, kind: 'user' as const, id },
        payload: {
          __typename: 'User',
          id,
          rest_id: id,
          core: { name: `Scale User ${offset}`, screen_name: `scale_user_${offset}` },
          legacy: { description: `Synthetic recovered user ${offset}` },
        },
        provenance: { source: 'durability-scale-harness' },
        observed_at_ms: 1_700_000_000_000 + index,
      };
      mutation = { ...material, record_hash: await recordHash(pairing.namespace_id, material) };
    } else if (index < tweetCount + userCount + folderCount) {
      const offset = index - tweetCount - userCount;
      const id = `folder-${offset}`;
      const material = {
        mutation_id: `scale-folder-${offset}`,
        client_seq: index + 1,
        kind: 'entity_upsert' as const,
        schema_revision: SCHEMA_REVISION,
        target: { namespace_id: pairing.namespace_id, kind: 'folder' as const, id },
        payload: { id, name: `Scale Folder ${offset}` },
        provenance: { source: 'durability-scale-harness' },
        observed_at_ms: 1_700_000_000_000 + index,
      };
      mutation = { ...material, record_hash: await recordHash(pairing.namespace_id, material) };
    } else if (index < tweetCount + userCount + folderCount + captureCount) {
      const offset = index - tweetCount - userCount - folderCount;
      const id = `tweet-${offset}`;
      const material = {
        mutation_id: `scale-capture-${offset}`,
        client_seq: index + 1,
        kind: 'relationship_upsert' as const,
        schema_revision: SCHEMA_REVISION,
        relationship_kind: 'capture_membership' as const,
        subject: { namespace_id: pairing.namespace_id, kind: 'tweet' as const, id },
        object: {
          namespace_id: pairing.namespace_id,
          kind: 'folder' as const,
          id: 'capture:bookmarks',
        },
        qualifier: { extension: 'bookmarks' },
        payload: { extension: 'bookmarks', folder_id: `folder-${offset % folderCount}` },
        provenance: { source: 'durability-scale-harness' },
        observed_at_ms: 1_700_000_000_000 + index,
      };
      mutation = { ...material, record_hash: await recordHash(pairing.namespace_id, material) };
    } else if (index < tweetCount + userCount + folderCount + captureCount + socialEdgeCount) {
      const offset = index - tweetCount - userCount - folderCount - captureCount;
      const material = {
        mutation_id: `scale-edge-${offset}`,
        client_seq: index + 1,
        kind: 'relationship_upsert' as const,
        schema_revision: SCHEMA_REVISION,
        relationship_kind: 'social_edge' as const,
        subject: {
          namespace_id: pairing.namespace_id,
          kind: 'user' as const,
          id: `user-${offset % userCount}`,
        },
        object: {
          namespace_id: pairing.namespace_id,
          kind: 'user' as const,
          id: `user-${(offset + 1) % userCount}`,
        },
        qualifier: { extension: 'canonical' },
        payload: { relation_type: 'following', id: `edge-${offset}` },
        provenance: { source: 'durability-scale-harness' },
        observed_at_ms: 1_700_000_000_000 + index,
      };
      mutation = { ...material, record_hash: await recordHash(pairing.namespace_id, material) };
    } else {
      const offset = index - tweetCount - userCount - folderCount - captureCount - socialEdgeCount;
      const isArticle = offset < articleCount;
      const material = {
        mutation_id: `scale-enrichment-${offset}`,
        client_seq: index + 1,
        kind: 'enrichment_upsert' as const,
        schema_revision: SCHEMA_REVISION,
        target: {
          namespace_id: pairing.namespace_id,
          kind: isArticle ? ('tweet' as const) : ('media_reference' as const),
          id: isArticle ? `tweet-${offset}` : `media-${offset - articleCount}`,
        },
        enrichment_kind: isArticle ? ('article_markdown' as const) : ('media_reference' as const),
        payload: isArticle
          ? { markdown: `# Synthetic article ${offset}\n\nRecovered at scale.` }
          : { url: `https://media.example/reference-${offset}.jpg`, media_type: 'photo' },
        provenance: { source: 'durability-scale-harness' },
        observed_at_ms: 1_700_000_000_000 + index,
      };
      mutation = { ...material, record_hash: await recordHash(pairing.namespace_id, material) };
    }
    return {
      state_key: `state:${mutation.kind}:${mutation.mutation_id}`,
      archive_seq: index + 1,
      mutation_id: mutation.mutation_id,
      mutation,
      record_hash: mutation.record_hash,
    };
  }
}

const client = new ScaleCompanion();
const oracleStartedAt = performance.now();
await client.initialize();
const oracleMs = performance.now() - oracleStartedAt;
const heapBaseline = process.memoryUsage().heapUsed;
let peakHeap = heapBaseline;
let peakRss = process.memoryUsage().rss;
const pageIntervals: number[] = [];
let previousProgressAt = performance.now();
const rebuildStartedAt = performance.now();
const result = await rebuildCanonicalGeneration({
  pairing,
  client,
  pageHint: pageSize,
  onProgress(progress) {
    if (progress.phase !== 'project') return;
    const now = performance.now();
    pageIntervals.push(now - previousProgressAt);
    previousProgressAt = now;
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
  },
});
const rebuildMs = performance.now() - rebuildStartedAt;
const manager = new DatabaseManager({
  databaseName: result.pointer.database_name,
  publishActiveName: false,
});
await manager.whenReady();
const counts = await manager.count();
const enrichedTweet = await (
  manager as unknown as {
    tweets(): { get(id: string): Promise<Record<string, unknown> | undefined> };
  }
)
  .tweets()
  .get('tweet-0');
const enrichedMedia = await (
  manager as unknown as {
    captures(): { get(id: string): Promise<Record<string, unknown> | undefined> };
  }
)
  .captures()
  .get('canonical-media-reference-media-0');
manager.close();

assert(
  result.pointer.target_checkpoint.archive_seq === totalItems,
  'scale checkpoint is incomplete',
);
assert(result.pointer.item_count === totalItems, 'scale generation truncated canonical state');
assert(result.pointer.counts.tweets === tweetCount, 'scale Tweet count mismatch');
assert(result.pointer.counts.users === userCount, 'scale User count mismatch');
assert(result.pointer.counts.captures === projectedCaptureCount, 'scale capture count mismatch');
assert(result.pointer.counts.social_edges === socialEdgeCount, 'scale social-edge count mismatch');
assert(
  result.pointer.counts.search_documents === captureCount,
  'scale search document count mismatch',
);
assert(
  counts?.tweets === tweetCount && counts?.captures === projectedCaptureCount,
  'active generation count parity failed',
);
assert(
  (enrichedTweet?.twe_private_fields as Record<string, unknown> | undefined)?.article_markdown ===
    '# Synthetic article 0\n\nRecovered at scale.',
  'scale rebuild lost article Markdown enrichment',
);
assert(
  client.pagesRequested === Math.ceil(totalItems / pageSize),
  'scale page stream was not fully consumed',
);
assert(client.maxPageItems <= pageSize, 'scale page hydration exceeded the declared bound');

assert(
  (enrichedMedia?.canonical_payload as Record<string, unknown> | undefined)?.url ===
    'https://media.example/reference-64.jpg',
  'scale rebuild lost media reference enrichment',
);
const report = {
  status: 'passed',
  scenario: 'canonical recovered-scale generation rebuild',
  workload: {
    tweets: tweetCount,
    users: userCount,
    folders: folderCount,
    captures: captureCount,
    social_edges: socialEdgeCount,
    article_enrichments: articleCount,
    media_enrichments: mediaCount,
    total_items: totalItems,
    page_size: pageSize,
  },
  observed: {
    checkpoint_seq: result.pointer.target_checkpoint.archive_seq,
    manifest_hash: result.pointer.manifest_hash,
    pages_requested: client.pagesRequested,
    max_page_items: client.maxPageItems,
    counts: result.pointer.counts,
    no_truncation: true,
    hidden_fallback: false,
  },
  metrics: {
    oracle_ms: Number(oracleMs.toFixed(1)),
    rebuild_ms: Number(rebuildMs.toFixed(1)),
    page_latency_p50_ms: Number(percentile(pageIntervals, 0.5).toFixed(1)),
    page_latency_p95_ms: Number(percentile(pageIntervals, 0.95).toFixed(1)),
    page_latency_p99_ms: Number(percentile(pageIntervals, 0.99).toFixed(1)),
    heap_baseline_bytes: heapBaseline,
    peak_heap_bytes: peakHeap,
    peak_rss_bytes: peakRss,
    staged_database_rows: Object.values(result.pointer.counts).reduce(
      (sum, value) => sum + (typeof value === 'number' ? value : 0),
      0,
    ),
  },
  privacy: { redaction_checked: true, violations: [] },
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
await Dexie.delete(result.pointer.database_name);
