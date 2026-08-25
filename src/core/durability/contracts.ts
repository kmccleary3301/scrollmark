export const SCROLLMARK_PROTOCOL = { major: 1, minor: 0 } as const;
export const SCHEMA_REVISION = 1 as const;
export const ZERO_HASH = '0'.repeat(64);

export type EntityKind = 'tweet' | 'user' | 'folder' | 'media_reference';
export type Endpoint = {
  namespace_id: string;
  kind: EntityKind;
  id: string;
};
export type Checkpoint = {
  namespace_id: string;
  archive_seq: number;
  chain_hash: string;
  schema_revision: typeof SCHEMA_REVISION;
};
export type SequenceRange = { from: number; to: number };
export type Provenance = {
  source: string;
  source_event_id?: string;
  extract_path?: string;
  extractor_rev?: string;
  source_hash?: string;
  [key: string]: unknown;
};

export type EntityUpsert = {
  mutation_id: string;
  client_seq: number;
  kind: 'entity_upsert';
  schema_revision: typeof SCHEMA_REVISION;
  target: Endpoint;
  payload: Record<string, unknown>;
  record_hash: string;
  provenance: Provenance;
  observed_at_ms: number;
};

export type RelationshipKind =
  | 'capture_membership'
  | 'bookmark_folder_membership'
  | 'social_edge'
  | 'tweet_reference'
  | 'interaction_state'
  | 'article_media_association';

export type RelationshipUpsert = {
  mutation_id: string;
  client_seq: number;
  kind: 'relationship_upsert';
  schema_revision: typeof SCHEMA_REVISION;
  relationship_kind: RelationshipKind;
  subject: Endpoint;
  object: Endpoint;
  qualifier: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  record_hash: string;
  provenance: Provenance;
  observed_at_ms: number;
};

export type EnrichmentUpsert = {
  mutation_id: string;
  client_seq: number;
  kind: 'enrichment_upsert';
  schema_revision: typeof SCHEMA_REVISION;
  target: Endpoint;
  enrichment_kind: 'article_markdown' | 'media_reference';
  payload: Record<string, unknown>;
  record_hash: string;
  provenance: Provenance;
  observed_at_ms: number;
};

export type Tombstone = {
  mutation_id: string;
  client_seq: number;
  kind: 'tombstone';
  schema_revision: typeof SCHEMA_REVISION;
  target_kind: 'tweet' | 'user' | 'folder' | 'media_reference' | 'relationship' | 'enrichment';
  target_id: string;
  relationship_kind?: string;
  deletion_id: string;
  record_hash: string;
  provenance: Provenance;
  observed_at_ms: number;
};

export type Mutation = EntityUpsert | RelationshipUpsert | EnrichmentUpsert | Tombstone;
export type MutationInput =
  | Omit<EntityUpsert, 'record_hash'>
  | Omit<RelationshipUpsert, 'record_hash'>
  | Omit<EnrichmentUpsert, 'record_hash'>
  | Omit<Tombstone, 'record_hash'>;

export type Batch = {
  batch_id: string;
  mutation_count: number;
  mutations: Mutation[];
  batch_hash: string;
};

export type ArchiveDeltaRequest = {
  protocol: typeof SCROLLMARK_PROTOCOL;
  request_id: string;
  archive_id: string;
  namespace_id: string;
  client_id: string;
  client_epoch: string;
  sent_at_ms: number;
  client_sequence: SequenceRange;
  batch: Batch;
  known_checkpoint: Checkpoint | null;
};

export type CommitReceipt = {
  protocol: typeof SCROLLMARK_PROTOCOL;
  request_id: string;
  archive_id: string;
  namespace_id: string;
  client_id: string;
  client_epoch: string;
  batch_id: string;
  result: 'committed' | 'duplicate';
  client_sequence: SequenceRange;
  archive_sequence: SequenceRange;
  mutation_count: number;
  batch_hash: string;
  prior_chain_hash: string;
  chain_hash: string;
  checkpoint: Checkpoint;
  capability_revision: string;
};

export type Capabilities = {
  protocol_versions: Array<{ major: number; minor: number }>;
  schema_revisions: number[];
  hash_algorithm: string;
  capability_revision: string;
  limits: Record<string, number>;
  features: Record<string, boolean>;
};

export type Health = {
  protocol?: { major: number; minor: number };
  ready?: boolean;
  archive?: { archive_id?: string; namespaces?: Array<Record<string, unknown>> };
  active_namespace_ids?: string[];
  capabilities?: Capabilities;
  [key: string]: unknown;
};

export type ReconciliationRequest = {
  protocol: typeof SCROLLMARK_PROTOCOL;
  request_id: string;
  archive_id: string;
  namespace_id: string;
  client_id: string;
  client_epoch: string;
  sent_at_ms: number;
  mode: 'deltas' | 'state_bootstrap';
  after_checkpoint: Checkpoint | null;
  known_checkpoint: Checkpoint | null;
  page_hint: number;
};

export type ReconciliationDescriptor = {
  protocol: typeof SCROLLMARK_PROTOCOL;
  stream_id: string;
  namespace_id: string;
  mode: 'deltas' | 'state_bootstrap';
  source_checkpoint: Checkpoint;
  target_checkpoint: Checkpoint;
  manifest_hash: string;
  item_count: number;
  page_count: number;
  [key: string]: unknown;
};

export type ReconciliationItem = {
  state_key?: string;
  archive_seq: number;
  batch_id?: string;
  mutation_id: string;
  mutation: Mutation;
  record_hash: string;
  chain_hash?: string;
};

export type ReconciliationPage = {
  protocol: typeof SCROLLMARK_PROTOCOL;
  stream_id: string;
  namespace_id: string;
  mode: 'deltas' | 'state_bootstrap';
  page_index: number;
  item_count: number;
  byte_count: number;
  items: ReconciliationItem[];
  page_hash: string;
  target_checkpoint: Checkpoint;
  manifest_hash: string;
  final: boolean;
  next_cursor?: string;
  previous_chain_hash?: string;
  next_chain_hash?: string;
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, sortKeys(source[key])]),
  );
}

/** Locked browser-side canonical JSON behavior from browser-validator.mjs. */
export function canonicalize(value: unknown): string {
  const encoded = JSON.stringify(sortKeys(value));
  if (encoded === undefined) throw new Error('unsupported undefined JSON value');
  return encoded;
}

function cryptoApi(): Crypto {
  const value = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!value?.subtle) throw new Error('Web Crypto is unavailable');
  return value;
}

export async function sha256Hex(value: unknown): Promise<string> {
  const input = typeof value === 'string' ? value : canonicalize(value);
  const bytes = new TextEncoder().encode(input);
  const digest = await cryptoApi().subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function recordMaterial(namespaceId: string, mutation: MutationInput) {
  const material: Record<string, unknown> = {
    namespace_id: namespaceId,
    kind: mutation.kind,
    schema_revision: mutation.schema_revision,
    provenance: mutation.provenance,
    observed_at_ms: mutation.observed_at_ms,
  };
  if (mutation.kind === 'entity_upsert') {
    material.target = mutation.target;
    material.payload = mutation.payload;
  } else if (mutation.kind === 'relationship_upsert') {
    material.relationship_kind = mutation.relationship_kind;
    material.subject = mutation.subject;
    material.object = mutation.object;
    material.qualifier = mutation.qualifier;
    material.payload = mutation.payload;
  } else if (mutation.kind === 'enrichment_upsert') {
    material.target = mutation.target;
    material.enrichment_kind = mutation.enrichment_kind;
    material.payload = mutation.payload;
  } else {
    material.target_kind = mutation.target_kind;
    material.target_id = mutation.target_id;
    material.relationship_kind = mutation.relationship_kind ?? null;
    material.deletion_id = mutation.deletion_id;
  }
  return material;
}

export async function recordHash(namespaceId: string, mutation: MutationInput): Promise<string> {
  return sha256Hex(recordMaterial(namespaceId, mutation));
}

export function batchMaterial(namespaceId: string, batch: Pick<Batch, 'mutations'>) {
  return {
    namespace_id: namespaceId,
    schema_revisions: [
      ...new Set(batch.mutations.map((mutation) => mutation.schema_revision)),
    ].sort((left, right) => left - right),
    mutations: batch.mutations.map((mutation) => ({
      client_seq: mutation.client_seq,
      mutation_id: mutation.mutation_id,
      kind: mutation.kind,
      record_hash: mutation.record_hash,
    })),
  };
}

export async function batchHash(
  namespaceId: string,
  batch: Pick<Batch, 'mutations'>,
): Promise<string> {
  return sha256Hex(batchMaterial(namespaceId, batch));
}

export function chainMaterial(
  namespaceId: string,
  priorChainHash: string,
  committedBatchHash: string,
  archiveFrom: number,
  archiveTo: number,
  schemaRevision = SCHEMA_REVISION,
) {
  return {
    namespace_id: namespaceId,
    schema_revision: schemaRevision,
    prior_chain_hash: priorChainHash,
    batch_hash: committedBatchHash,
    archive_sequence: { from: archiveFrom, to: archiveTo },
  };
}

export async function chainHash(
  namespaceId: string,
  priorChainHash: string,
  committedBatchHash: string,
  archiveFrom: number,
  archiveTo: number,
  schemaRevision = SCHEMA_REVISION,
): Promise<string> {
  return sha256Hex(
    chainMaterial(
      namespaceId,
      priorChainHash,
      committedBatchHash,
      archiveFrom,
      archiveTo,
      schemaRevision,
    ),
  );
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Record<string, unknown>;
  return (
    typeof checkpoint.namespace_id === 'string' &&
    Number.isInteger(checkpoint.archive_seq) &&
    Number(checkpoint.archive_seq) >= 0 &&
    isHash(checkpoint.chain_hash) &&
    checkpoint.schema_revision === SCHEMA_REVISION
  );
}

export function isCommitReceipt(value: unknown): value is CommitReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return (
    !!receipt.protocol &&
    (receipt.protocol as Record<string, unknown>).major === SCROLLMARK_PROTOCOL.major &&
    (receipt.protocol as Record<string, unknown>).minor === SCROLLMARK_PROTOCOL.minor &&
    typeof receipt.request_id === 'string' &&
    typeof receipt.archive_id === 'string' &&
    typeof receipt.namespace_id === 'string' &&
    typeof receipt.client_id === 'string' &&
    typeof receipt.client_epoch === 'string' &&
    typeof receipt.batch_id === 'string' &&
    (receipt.result === 'committed' || receipt.result === 'duplicate') &&
    isSequenceRange(receipt.client_sequence) &&
    isSequenceRange(receipt.archive_sequence) &&
    Number.isInteger(receipt.mutation_count) &&
    isHash(receipt.batch_hash) &&
    isHash(receipt.prior_chain_hash) &&
    isHash(receipt.chain_hash) &&
    isCheckpoint(receipt.checkpoint) &&
    typeof receipt.capability_revision === 'string'
  );
}

export function isSequenceRange(value: unknown): value is SequenceRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as Record<string, unknown>;
  return (
    Number.isInteger(range.from) &&
    Number.isInteger(range.to) &&
    Number(range.from) >= 1 &&
    Number(range.to) >= Number(range.from)
  );
}
