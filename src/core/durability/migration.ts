import {
  batchHash,
  recordHash,
  SCHEMA_REVISION,
  SCROLLMARK_PROTOCOL,
  type ArchiveDeltaRequest,
  type Checkpoint,
  type CommitReceipt,
  type EntityKind,
  type Mutation,
  type RelationshipUpsert,
} from './contracts';
import type { CompanionClientLike } from './companion-client';
import {
  BROWSER_COMPATIBILITY_MATRIX,
  evaluateBrowserCompatibility,
  type CompatibilityReport,
  type CompatibilityVersion,
} from './compatibility';
import { rebuildCanonicalGeneration, type GenerationResult } from './generation';
import {
  clearMigrationJournal,
  randomGenerationId,
  readActiveGenerationPointer,
  readBoundActiveGenerationPointer,
  readMigrationJournal,
  writeMigrationJournal,
  type MigrationJournal,
  type MigrationPhase,
} from './generation-state';
import type { IdentityController, IdentityEvidence, PairingContext } from './identity';
import type { DatabaseManager } from '../database/manager';
import type { Capture, SocialEdge, Tweet, User } from '@/types';

const DEFAULT_BOOTSTRAP_BATCH_SIZE = 512;
const IDENTITY_TRANSFORM_ID = 'identity-v1';
const IDENTITY_TRANSFORM_HASH = '0'.repeat(64);
const BROWSER_BOOTSTRAP_TRANSFORM_HASH = 'b'.repeat(64);

export class MigrationError extends Error {
  readonly report?: CompatibilityReport;

  constructor(message: string, report?: CompatibilityReport) {
    super(message);
    this.name = 'MigrationError';
    this.report = report;
  }
}

function fail(message: string, report?: CompatibilityReport): never {
  throw new MigrationError(message, report);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function hasPrivateData(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  const object = value as object;
  if (seen.has(object)) return false;
  seen.add(object);
  if (Array.isArray(value)) return value.some((item) => hasPrivateData(item, seen));
  const privateKeys = new Set([
    'dm',
    'direct_message',
    'direct_messages',
    'conversation_id',
    'recipient_ids',
    'private_message',
    'private_messages',
  ]);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.trim().toLowerCase().replace(/-/g, '_');
    return privateKeys.has(normalized) || hasPrivateData(child, seen);
  });
}

function sourceId(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const normalized = String(candidate).trim();
      if (normalized) return normalized;
    }
  }
  return '';
}

function randomRequestId(prefix: string): string {
  return `${prefix}-${randomGenerationId()}`;
}

function provenance(source: string, eventId: string) {
  return { source, source_event_id: eventId, extractor_rev: 'browser-bootstrap-v1' };
}

function stableObservedAt(payload: Record<string, unknown>): number {
  const legacy = payload.legacy;
  const candidates = [
    payload.created_at_ms,
    payload.created_at,
    legacy && typeof legacy === 'object'
      ? (legacy as Record<string, unknown>).created_at_ms
      : undefined,
    legacy && typeof legacy === 'object'
      ? (legacy as Record<string, unknown>).created_at
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return Math.trunc(candidate);
    if (typeof candidate === 'string' && candidate.trim()) {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

async function entityMutation(
  namespaceId: string,
  kind: 'tweet' | 'user',
  row: Tweet | User,
  index: number,
): Promise<Mutation> {
  const payload = row as unknown as Record<string, unknown>;
  const id = sourceId(payload, ['rest_id', 'id', 'id_str']);
  requireCondition(id, `browser bootstrap ${kind} row has no stable id at index ${index}`);
  requireCondition(
    !hasPrivateData(payload),
    `browser bootstrap rejected private ${kind} payload ${id}`,
  );
  const mutationInput = {
    mutation_id: `bootstrap-entity-${kind}-${id}`,
    client_seq: 0,
    kind: 'entity_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    target: { namespace_id: namespaceId, kind, id },
    payload,
    provenance: provenance('browser-bootstrap-v1', `${kind}:${id}`),
    observed_at_ms: stableObservedAt(payload),
  };
  return { ...mutationInput, record_hash: await recordHash(namespaceId, mutationInput) };
}

async function mediaReferenceMutation(namespaceId: string, capture: Capture): Promise<Mutation> {
  const dataKey = String(capture.data_key || '').trim();
  const extension = String(capture.extension || '').trim();
  requireCondition(dataKey && extension, 'browser bootstrap media reference has no stable key');
  const mutationInput = {
    mutation_id: `bootstrap-media-${extension}-${dataKey}`,
    client_seq: 0,
    kind: 'entity_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    target: { namespace_id: namespaceId, kind: 'media_reference' as const, id: dataKey },
    payload: { data_key: dataKey, extension, type: 'media_reference' },
    provenance: provenance('browser-bootstrap-v1', `media:${extension}:${dataKey}`),
    observed_at_ms: Number(capture.created_at) || 0,
  };
  return { ...mutationInput, record_hash: await recordHash(namespaceId, mutationInput) };
}

async function captureMutation(namespaceId: string, capture: Capture): Promise<Mutation> {
  const dataKey = String(capture.data_key || '').trim();
  const extension = String(capture.extension || '').trim();
  requireCondition(dataKey && extension, 'browser bootstrap capture has no stable key');
  const kind: EntityKind =
    capture.type === 'user' ? 'user' : capture.type === 'tweet' ? 'tweet' : 'media_reference';
  const mutationInput = {
    mutation_id: `bootstrap-capture-${capture.id}`,
    client_seq: 0,
    kind: 'relationship_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    relationship_kind: 'capture_membership' as const,
    subject: { namespace_id: namespaceId, kind, id: dataKey },
    object: { namespace_id: namespaceId, kind: 'folder' as const, id: `capture:${extension}` },
    qualifier: { extension },
    payload: {
      extension,
      data_key: dataKey,
      type: kind,
      created_at: Number(capture.created_at) || 0,
    },
    provenance: provenance('browser-bootstrap-v1', `capture:${capture.id}`),
    observed_at_ms: Number(capture.created_at) || 0,
  };
  return { ...mutationInput, record_hash: await recordHash(namespaceId, mutationInput) };
}

async function socialEdgeMutation(namespaceId: string, edge: SocialEdge): Promise<Mutation> {
  const subjectId = String(edge.subject_user_id || '').trim();
  const objectId = String(edge.related_user_id || '').trim();
  const extension = String(edge.extension || '').trim();
  requireCondition(
    subjectId && objectId && extension,
    'browser bootstrap social edge is incomplete',
  );
  requireCondition(
    edge.relation_type === 'follower' ||
      edge.relation_type === 'following' ||
      edge.relation_type === 'subscription',
    'browser bootstrap social edge relation is unsupported',
  );
  const payload = edge as unknown as Record<string, unknown>;
  requireCondition(
    !hasPrivateData(payload),
    `browser bootstrap rejected private social edge ${edge.id}`,
  );
  const mutationInput = {
    mutation_id: `bootstrap-edge-${edge.id}`,
    client_seq: 0,
    kind: 'relationship_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    relationship_kind: 'social_edge' as const,
    subject: { namespace_id: namespaceId, kind: 'user' as const, id: subjectId },
    object: { namespace_id: namespaceId, kind: 'user' as const, id: objectId },
    qualifier: { extension },
    payload,
    provenance: provenance('browser-bootstrap-v1', `social-edge:${edge.id}`),
    observed_at_ms: Number(edge.observed_at) || 0,
  } satisfies Omit<RelationshipUpsert, 'record_hash'>;
  return { ...mutationInput, record_hash: await recordHash(namespaceId, mutationInput) };
}

async function browserBootstrapMutations(
  namespaceId: string,
  rows: {
    tweets: Tweet[];
    users: User[];
    captures: Capture[];
    socialEdges: SocialEdge[];
  },
): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  for (const [index, row] of rows.tweets.entries()) {
    mutations.push(await entityMutation(namespaceId, 'tweet', row, index));
  }
  for (const [index, row] of rows.users.entries()) {
    mutations.push(await entityMutation(namespaceId, 'user', row, index));
  }
  for (const capture of rows.captures) {
    if (capture.type !== 'tweet' && capture.type !== 'user') {
      mutations.push(await mediaReferenceMutation(namespaceId, capture));
    }
    mutations.push(await captureMutation(namespaceId, capture));
  }
  for (const edge of rows.socialEdges) mutations.push(await socialEdgeMutation(namespaceId, edge));
  return mutations;
}

function applyClientSequence(mutations: Mutation[], firstSequence: number): Mutation[] {
  return mutations.map((mutation, index) => ({ ...mutation, client_seq: firstSequence + index }));
}

async function commitBootstrapBatch(args: {
  pairing: PairingContext;
  client: CompanionClientLike;
  mutations: Mutation[];
  knownCheckpoint: ArchiveDeltaRequest['known_checkpoint'];
}): Promise<CommitReceipt> {
  const batch = {
    batch_id: randomRequestId('bootstrap-batch'),
    mutation_count: args.mutations.length,
    mutations: args.mutations,
    batch_hash: await batchHash(args.pairing.namespace_id, { mutations: args.mutations }),
  };
  const request: ArchiveDeltaRequest = {
    protocol: SCROLLMARK_PROTOCOL,
    request_id: randomRequestId('bootstrap-request'),
    archive_id: args.pairing.archive_id,
    namespace_id: args.pairing.namespace_id,
    client_id: args.pairing.client_id,
    client_epoch: args.pairing.client_epoch,
    sent_at_ms: Date.now(),
    client_sequence: {
      from: args.mutations[0]?.client_seq ?? 1,
      to: args.mutations[args.mutations.length - 1]?.client_seq ?? 1,
    },
    batch,
    known_checkpoint: args.knownCheckpoint,
  };
  return args.client.commit(request);
}

function initialMigrationJournal(args: {
  migrationId: string;
  pairing: PairingContext;
  compatibility: CompatibilityReport;
  sourceGenerationId: string | null;
  sourceDatabaseName: string | null;
  sourceCheckpoint: MigrationJournal['source_checkpoint'];
  phase: MigrationPhase;
}): MigrationJournal {
  return {
    schema_version: 1,
    migration_id: args.migrationId,
    phase: args.phase,
    archive_id: args.pairing.archive_id,
    namespace_id: args.pairing.namespace_id,
    source_generation_id: args.sourceGenerationId,
    source_database_name: args.sourceDatabaseName,
    target_generation_id: null,
    target_database_name: null,
    source_protocol: SCROLLMARK_PROTOCOL,
    target_protocol: SCROLLMARK_PROTOCOL,
    source_schema_revision: SCHEMA_REVISION,
    target_schema_revision: SCHEMA_REVISION,
    transform_id: args.compatibility.transform_id,
    transform_hash: args.compatibility.transform_hash,
    source_checkpoint: args.sourceCheckpoint,
    target_checkpoint: null,
    event_id: 1,
    updated_at_ms: Date.now(),
    compatibility: args.compatibility.status,
  };
}

function advanceMigrationJournal(
  journal: MigrationJournal,
  phase: MigrationPhase,
  patch: Partial<MigrationJournal> = {},
): MigrationJournal {
  return {
    ...journal,
    ...patch,
    phase,
    event_id: journal.event_id + 1,
    updated_at_ms: Date.now(),
  };
}

export type BrowserMigrationOptions = {
  pairing: PairingContext;
  identity: IdentityController;
  identityEvidence?: IdentityEvidence[];
  client: CompanionClientLike;
  sourceProtocol?: CompatibilityVersion;
  targetProtocol?: CompatibilityVersion;
  sourceSchemaRevision?: number;
  targetSchemaRevision?: number;
  transformId?: string;
  transformHash?: string;
  lossy?: boolean;
};

export async function migrateBrowserGeneration(
  options: BrowserMigrationOptions,
): Promise<GenerationResult> {
  const compatibility = evaluateBrowserCompatibility({
    sourceProtocol: options.sourceProtocol ?? SCROLLMARK_PROTOCOL,
    targetProtocol: options.targetProtocol ?? SCROLLMARK_PROTOCOL,
    sourceSchemaRevision: options.sourceSchemaRevision ?? SCHEMA_REVISION,
    targetSchemaRevision: options.targetSchemaRevision ?? SCHEMA_REVISION,
    transformId: options.transformId ?? IDENTITY_TRANSFORM_ID,
    transformHash: options.transformHash ?? IDENTITY_TRANSFORM_HASH,
    lossy: options.lossy,
  });
  const sourcePointer = readBoundActiveGenerationPointer(
    options.pairing.archive_id,
    options.pairing.namespace_id,
  );
  let sourceCheckpoint: Checkpoint | null = null;
  const migrationId = randomRequestId('migration');
  let journal = initialMigrationJournal({
    migrationId,
    pairing: options.pairing,
    compatibility,
    sourceGenerationId: sourcePointer?.generation_id ?? null,
    sourceDatabaseName: sourcePointer?.database_name ?? null,
    sourceCheckpoint,
    phase: 'planned',
  });
  writeMigrationJournal(journal);
  try {
    if (compatibility.status !== 'compatible') {
      fail(`${compatibility.status}: ${compatibility.reason}`, compatibility);
    }
    const assessment = options.identity.observe(options.identityEvidence);
    requireCondition(
      assessment.admitted,
      `browser migration identity is not admitted: ${assessment.reason}`,
    );
    const capabilities = await options.client.capabilities();
    requireCondition(
      capabilities.protocol_versions.some(
        (version) =>
          version.major === SCROLLMARK_PROTOCOL.major &&
          version.minor === SCROLLMARK_PROTOCOL.minor,
      ),
      'companion does not advertise the declared migration protocol',
    );
    const health = await options.client.health();
    requireCondition(
      health.archive?.archive_id === options.pairing.archive_id,
      'migration archive binding is not proven',
    );
    sourceCheckpoint = await options.client.checkpoint(options.pairing.namespace_id);
    journal = advanceMigrationJournal(journal, 'preflighted', {
      source_checkpoint: sourceCheckpoint,
    });
    writeMigrationJournal(journal);
    journal = advanceMigrationJournal(journal, 'staging');
    writeMigrationJournal(journal);
    journal = advanceMigrationJournal(journal, 'browser_rebuilding');
    writeMigrationJournal(journal);
    const result = await rebuildCanonicalGeneration({
      pairing: options.pairing,
      client: options.client,
    });
    journal = advanceMigrationJournal(journal, 'browser_verified', {
      target_generation_id: result.pointer.generation_id,
      target_database_name: result.pointer.database_name,
      target_checkpoint: result.pointer.target_checkpoint,
    });
    writeMigrationJournal(journal);
    journal = advanceMigrationJournal(journal, 'committed');
    writeMigrationJournal(journal);
    return result;
  } catch (error) {
    try {
      writeMigrationJournal(
        advanceMigrationJournal(journal, 'rollback_required', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } catch {
      // Preserve the migration error if storage is unavailable.
    }
    throw error;
  }
}

export type BrowserBootstrapOptions = {
  manager: DatabaseManager;
  identity: IdentityController;
  identityEvidence?: IdentityEvidence[];
  pairing: PairingContext;
  client: CompanionClientLike;
  clientSequenceStart: number;
  batchSize?: number;
};

export type BrowserBootstrapResult = {
  receipts: Array<{ batch_id: string; checkpoint: CommitReceipt['checkpoint'] }>;
  generation: GenerationResult;
  source_counts: { tweets: number; users: number; captures: number; social_edges: number };
};

export async function bootstrapExistingBrowserArchive(
  options: BrowserBootstrapOptions,
): Promise<BrowserBootstrapResult> {
  const assessment = options.identity.observe(options.identityEvidence);
  requireCondition(
    assessment.admitted,
    `browser bootstrap identity is not admitted: ${assessment.reason}`,
  );
  requireCondition(
    Number.isInteger(options.clientSequenceStart) && options.clientSequenceStart >= 1,
    'bootstrap client sequence start is invalid',
  );
  const compatibility: CompatibilityReport = {
    status: 'compatible',
    reason: 'explicit browser-only archive bootstrap',
    matrix_revision: BROWSER_COMPATIBILITY_MATRIX.matrix_revision,
    transform_id: 'browser-bootstrap-v1',
    transform_hash: BROWSER_BOOTSTRAP_TRANSFORM_HASH,
  };
  const sourcePointer = readBoundActiveGenerationPointer(
    options.pairing.archive_id,
    options.pairing.namespace_id,
  );
  let sourceCheckpoint: Checkpoint | null = null;
  let journal = initialMigrationJournal({
    migrationId: randomRequestId('bootstrap-migration'),
    pairing: options.pairing,
    compatibility,
    sourceGenerationId: sourcePointer?.generation_id ?? null,
    sourceDatabaseName: sourcePointer?.database_name ?? null,
    sourceCheckpoint,
    phase: 'planned',
  });
  writeMigrationJournal(journal);
  try {
    const capabilities = await options.client.capabilities();
    requireCondition(
      capabilities.protocol_versions.some(
        (version) =>
          version.major === SCROLLMARK_PROTOCOL.major &&
          version.minor === SCROLLMARK_PROTOCOL.minor,
      ),
      'companion does not advertise the declared bootstrap protocol',
    );
    const health = await options.client.health();
    requireCondition(
      health.archive?.archive_id === options.pairing.archive_id,
      'bootstrap archive binding is not proven',
    );
    sourceCheckpoint = await options.client.checkpoint(options.pairing.namespace_id);
    requireCondition(
      sourceCheckpoint.archive_seq === 0,
      'browser bootstrap requires an empty canonical archive',
    );
    journal = advanceMigrationJournal(journal, 'preflighted', {
      source_checkpoint: sourceCheckpoint,
    });
    writeMigrationJournal(journal);
    const rows = await options.manager.readGenerationSourceRows();
    const mutations = applyClientSequence(
      await browserBootstrapMutations(options.pairing.namespace_id, rows),
      options.clientSequenceStart,
    );
    const batchSize = Math.max(
      1,
      Math.min(4096, Math.floor(Number(options.batchSize) || DEFAULT_BOOTSTRAP_BATCH_SIZE)),
    );
    let checkpoint = sourceCheckpoint;
    journal = advanceMigrationJournal(journal, 'staging');
    writeMigrationJournal(journal);
    const receipts: BrowserBootstrapResult['receipts'] = [];
    for (let offset = 0; offset < mutations.length; offset += batchSize) {
      const batch = mutations.slice(offset, offset + batchSize);
      const receipt = await commitBootstrapBatch({
        pairing: options.pairing,
        client: options.client,
        mutations: batch,
        knownCheckpoint: checkpoint,
      });
      receipts.push({ batch_id: receipt.batch_id, checkpoint: receipt.checkpoint });
      checkpoint = receipt.checkpoint;
      journal = advanceMigrationJournal(journal, 'staging', { target_checkpoint: checkpoint });
      writeMigrationJournal(journal);
    }
    journal = advanceMigrationJournal(journal, 'browser_rebuilding', {
      target_checkpoint: checkpoint,
    });
    writeMigrationJournal(journal);
    const generation = await rebuildCanonicalGeneration({
      pairing: options.pairing,
      client: options.client,
    });
    journal = advanceMigrationJournal(journal, 'browser_verified', {
      target_generation_id: generation.pointer.generation_id,
      target_database_name: generation.pointer.database_name,
      target_checkpoint: generation.pointer.target_checkpoint,
    });
    writeMigrationJournal(journal);
    journal = advanceMigrationJournal(journal, 'committed');
    writeMigrationJournal(journal);
    return {
      receipts,
      generation,
      source_counts: {
        tweets: rows.tweets.length,
        users: rows.users.length,
        captures: rows.captures.length,
        social_edges: rows.socialEdges.length,
      },
    };
  } catch (error) {
    try {
      writeMigrationJournal(
        advanceMigrationJournal(journal, 'rollback_required', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } catch {
      // Preserve the original bootstrap error if journal storage is unavailable.
    }
    throw error;
  }
}

export function readMigrationState(): MigrationJournal | null {
  return readMigrationJournal();
}

export function clearMigrationState(): void {
  clearMigrationJournal();
}

export type BrowserBootstrapInspection = {
  source_present: boolean;
  canonical_present: boolean;
  bootstrapped: boolean;
  result: BrowserBootstrapResult | null;
};

type BrowserSourceCounts = {
  tweets: number;
  users: number;
  captures: number;
  social_edges: number;
} | null;

function sourceHasRows(counts: BrowserSourceCounts): boolean {
  return Boolean(
    counts &&
    (counts.tweets > 0 || counts.users > 0 || counts.captures > 0 || counts.social_edges > 0),
  );
}

export async function bootstrapExistingBrowserArchiveIfNeeded(
  options: BrowserBootstrapOptions,
): Promise<BrowserBootstrapInspection> {
  const activePointer = readActiveGenerationPointer();
  const boundPointer = readBoundActiveGenerationPointer(
    options.pairing.archive_id,
    options.pairing.namespace_id,
  );
  if (activePointer && !boundPointer) {
    return { source_present: false, canonical_present: false, bootstrapped: false, result: null };
  }
  if (boundPointer) {
    return { source_present: false, canonical_present: true, bootstrapped: false, result: null };
  }
  const sourceManager = options.manager;
  await sourceManager.whenReady();
  const counts = await sourceManager.count();
  const sourcePresent = sourceHasRows(counts);
  if (!sourcePresent) {
    return { source_present: false, canonical_present: false, bootstrapped: false, result: null };
  }
  const canonicalCheckpoint = await options.client.checkpoint(options.pairing.namespace_id);
  const canonicalPresent = canonicalCheckpoint.archive_seq > 0;
  if (canonicalPresent) {
    return { source_present: true, canonical_present: true, bootstrapped: false, result: null };
  }
  const result = await bootstrapExistingBrowserArchive(options);
  return { source_present: true, canonical_present: false, bootstrapped: true, result };
}

export type MigrationRecoveryResult = {
  action: 'none' | 'committed' | 'rollback_required' | 'rolled_back';
  migration_id: string | null;
  reason: string;
};

export function recoverInterruptedMigration(): MigrationRecoveryResult {
  const journal = readMigrationJournal();
  if (!journal) return { action: 'none', migration_id: null, reason: 'migration-journal-missing' };
  if (journal.phase === 'committed') {
    return {
      action: 'none',
      migration_id: journal.migration_id,
      reason: 'migration-already-committed',
    };
  }
  if (
    journal.phase === 'rolled_back' ||
    journal.phase === 'rollback_required' ||
    journal.phase === 'failed'
  ) {
    return {
      action: 'rollback_required',
      migration_id: journal.migration_id,
      reason: journal.phase,
    };
  }
  const active = readActiveGenerationPointer();
  const targetIsActive = Boolean(
    active &&
    journal.target_generation_id &&
    active.generation_id === journal.target_generation_id &&
    active.archive_id === journal.archive_id &&
    active.namespace_id === journal.namespace_id,
  );
  if (journal.phase === 'browser_verified' && targetIsActive) {
    const committed = advanceMigrationJournal(journal, 'committed');
    writeMigrationJournal(committed);
    return {
      action: 'committed',
      migration_id: journal.migration_id,
      reason: 'verified-target-pointer-resumed',
    };
  }
  const rollback = advanceMigrationJournal(journal, 'rollback_required', {
    error: 'interrupted migration has no unambiguous verified target pointer',
  });
  writeMigrationJournal(rollback);
  return {
    action: 'rollback_required',
    migration_id: journal.migration_id,
    reason: 'interrupted migration requires explicit recovery',
  };
}
