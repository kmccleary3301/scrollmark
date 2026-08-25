import Dexie from 'dexie';

import type { Capture, SocialEdge, Tweet, User } from '@/types';

import { DatabaseManager } from '../database/manager';
import { ExtensionType } from '../extensions/extension';
import {
  ZERO_HASH,
  canonicalize,
  isCheckpoint,
  isHash,
  recordHash,
  sha256Hex,
  SCHEMA_REVISION,
  SCROLLMARK_PROTOCOL,
  type EntityKind,
  type Mutation,
  type ReconciliationDescriptor,
  type ReconciliationItem,
  type ReconciliationPage,
} from './contracts';
import type { CompanionClientLike } from './companion-client';
import type { PairingContext } from './identity';
import { StateBootstrapManifestHasher } from './reconciliation-manifest';
import {
  clearGenerationJournal,
  publishActiveDatabaseName,
  randomGenerationId,
  readActiveGenerationPointer,
  readBoundActiveGenerationPointer,
  readGenerationJournal,
  writeActiveGenerationPointer,
  writeGenerationJournal,
  type ActiveGenerationPointer,
  type GenerationCounts,
  type GenerationJournal,
} from './generation-state';

const DEFAULT_DATABASE_NAME = 'twitter-web-exporter';
const DEFAULT_PAGE_HINT = 256;

type GenerationProgress = {
  phase: 'reconcile' | 'project' | 'derive' | 'activate';
  page_index?: number;
  page_count?: number;
  item_count?: number;
};

export type GenerationOptions = {
  pairing: PairingContext;
  client: CompanionClientLike;
  pageHint?: number;
  onProgress?: (progress: GenerationProgress) => void;
  databaseFactory?: (databaseName: string) => DatabaseManager;
};

export type GenerationResult = {
  pointer: ActiveGenerationPointer;
  counts: GenerationCounts;
  previous_database_name: string | null;
};

export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationError';
  }
}

function fail(message: string): never {
  throw new GenerationError(message);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function endpointNamespace(mutation: Mutation): string[] {
  if (mutation.kind === 'entity_upsert' || mutation.kind === 'enrichment_upsert') {
    return [mutation.target.namespace_id];
  }
  if (mutation.kind === 'relationship_upsert') {
    return [mutation.subject.namespace_id, mutation.object.namespace_id];
  }
  return [];
}

async function validateMutation(namespaceId: string, item: ReconciliationItem): Promise<void> {
  const mutation = item.mutation;
  requireCondition(mutation && typeof mutation === 'object', 'reconciliation mutation is missing');
  requireCondition(
    typeof mutation.mutation_id === 'string' && mutation.mutation_id,
    'mutation id is missing',
  );
  requireCondition(
    mutation.schema_revision === SCHEMA_REVISION,
    'mutation schema revision is unsupported',
  );
  requireCondition(isHash(item.record_hash), 'reconciliation item record hash is invalid');
  requireCondition(
    mutation.record_hash === item.record_hash,
    'reconciliation record hash is not bound',
  );
  requireCondition(
    endpointNamespace(mutation).every((value) => value === namespaceId),
    'reconciliation endpoint namespace is not bound',
  );
  const { record_hash: _recordHash, ...mutationInput } = mutation;
  void _recordHash;
  const expectedHash = await recordHash(namespaceId, mutationInput);
  requireCondition(
    expectedHash === item.record_hash,
    'reconciliation mutation record hash mismatch',
  );
  if (mutation.kind === 'entity_upsert' || mutation.kind === 'enrichment_upsert') {
    requireCondition(
      mutation.payload && typeof mutation.payload === 'object',
      'entity payload is invalid',
    );
  }
  if (mutation.kind === 'relationship_upsert') {
    requireCondition(
      mutation.payload && typeof mutation.payload === 'object',
      'relationship payload is invalid',
    );
  }
}

function validateDescriptor(descriptor: ReconciliationDescriptor, pairing: PairingContext): void {
  requireCondition(
    equalJson(descriptor.protocol, SCROLLMARK_PROTOCOL),
    'reconciliation protocol mismatch',
  );
  requireCondition(
    descriptor.namespace_id === pairing.namespace_id,
    'reconciliation namespace mismatch',
  );
  requireCondition(
    descriptor.mode === 'state_bootstrap',
    'generation requires a state bootstrap stream',
  );
  requireCondition(
    isCheckpoint(descriptor.source_checkpoint),
    'reconciliation source checkpoint is invalid',
  );
  requireCondition(
    isCheckpoint(descriptor.target_checkpoint),
    'reconciliation target checkpoint is invalid',
  );
  requireCondition(
    descriptor.source_checkpoint.namespace_id === pairing.namespace_id &&
      descriptor.target_checkpoint.namespace_id === pairing.namespace_id,
    'reconciliation checkpoint namespace mismatch',
  );
  requireCondition(isHash(descriptor.manifest_hash), 'reconciliation manifest hash is invalid');
  requireCondition(
    Number.isInteger(descriptor.item_count) && descriptor.item_count >= 0,
    'reconciliation item count is invalid',
  );
  requireCondition(
    Number.isInteger(descriptor.page_count) && descriptor.page_count > 0,
    'reconciliation page count is invalid',
  );
}

async function validatePage(
  page: ReconciliationPage,
  descriptor: ReconciliationDescriptor,
  expectedPageIndex: number,
  expectedPreviousChainHash: string,
  expectedArchiveSequence: number,
  seenMutationIds: Set<string>,
  seenStateKeys: Set<string>,
): Promise<{ nextChainHash: string; nextArchiveSequence: number }> {
  requireCondition(
    equalJson(page.protocol, SCROLLMARK_PROTOCOL),
    'reconciliation page protocol mismatch',
  );
  requireCondition(page.stream_id === descriptor.stream_id, 'reconciliation page stream mismatch');
  requireCondition(
    page.namespace_id === descriptor.namespace_id,
    'reconciliation page namespace mismatch',
  );
  requireCondition(page.mode === descriptor.mode, 'reconciliation page mode mismatch');
  requireCondition(
    page.page_index === expectedPageIndex,
    'reconciliation page index is not contiguous',
  );
  requireCondition(
    page.manifest_hash === descriptor.manifest_hash,
    'reconciliation page manifest mismatch',
  );
  requireCondition(
    equalJson(page.target_checkpoint, descriptor.target_checkpoint),
    'reconciliation page checkpoint mismatch',
  );
  requireCondition(
    page.item_count === page.items.length,
    'reconciliation page item count mismatch',
  );
  requireCondition(
    page.item_count >= 0 && page.byte_count >= 0,
    'reconciliation page byte count is invalid',
  );
  requireCondition(
    new TextEncoder().encode(canonicalize(page.items)).byteLength === page.byte_count,
    'reconciliation page byte count proof mismatch',
  );
  const { page_hash: _pageHash, ...pageMaterial } = page;
  void _pageHash;
  requireCondition(isHash(page.page_hash), 'reconciliation page hash is invalid');
  requireCondition(
    (await sha256Hex(pageMaterial)) === page.page_hash,
    'reconciliation page hash mismatch',
  );

  let nextChainHash = expectedPreviousChainHash;
  let nextArchiveSequence = expectedArchiveSequence;
  if (page.mode === 'deltas') {
    requireCondition(isHash(page.previous_chain_hash), 'delta page previous chain hash is invalid');
    requireCondition(
      page.previous_chain_hash === expectedPreviousChainHash,
      'delta page chain link mismatch',
    );
  }
  for (const item of page.items) {
    requireCondition(
      Number.isInteger(item.archive_seq) && item.archive_seq >= 0,
      'reconciliation archive sequence is invalid',
    );
    requireCondition(
      typeof item.mutation_id === 'string' && item.mutation_id === item.mutation.mutation_id,
      'reconciliation mutation id mismatch',
    );
    requireCondition(
      !seenMutationIds.has(item.mutation_id),
      'reconciliation mutation id is duplicated',
    );
    seenMutationIds.add(item.mutation_id);
    await validateMutation(descriptor.namespace_id, item);
    if (page.mode === 'deltas') {
      requireCondition(
        item.archive_seq === nextArchiveSequence,
        'delta archive sequence is not contiguous',
      );
      requireCondition(isHash(item.chain_hash), 'delta item chain hash is invalid');
      nextChainHash = item.chain_hash;
      nextArchiveSequence += 1;
    } else {
      requireCondition(
        typeof item.state_key === 'string' && item.state_key,
        'bootstrap state key is missing',
      );
      requireCondition(!seenStateKeys.has(item.state_key), 'bootstrap state key is duplicated');
      seenStateKeys.add(item.state_key);
    }
  }
  if (page.mode === 'deltas') {
    const expectedNextChainHash = page.items.length
      ? page.items[page.items.length - 1]?.chain_hash
      : descriptor.target_checkpoint.chain_hash;
    requireCondition(
      page.next_chain_hash === expectedNextChainHash,
      'delta page next chain hash mismatch',
    );
    if (!page.items.length) nextChainHash = descriptor.target_checkpoint.chain_hash;
  }
  return { nextChainHash, nextArchiveSequence };
}

type Projection = {
  tweets: Tweet[];
  users: User[];
  captures: Capture[];
  tweetPatches: Array<{ id: string; fields: Partial<Tweet> }>;
  socialEdges: SocialEdge[];
  deleteTweets: string[];
  deleteUsers: string[];
  deleteCaptures: string[];
  deleteSocialEdges: string[];
};

function entityPayload(
  mutation: Extract<Mutation, { kind: 'entity_upsert' }>,
): Record<string, unknown> {
  const payload = { ...mutation.payload };
  if (mutation.target.kind === 'tweet' && !normalizeId(payload.rest_id))
    payload.rest_id = mutation.target.id;
  if (mutation.target.kind === 'user' && !normalizeId(payload.rest_id))
    payload.rest_id = mutation.target.id;
  return payload;
}

function relationshipExtension(
  mutation: Extract<Mutation, { kind: 'relationship_upsert' }>,
): string {
  const qualifier = asRecord(mutation.qualifier);
  const payload = asRecord(mutation.payload);
  const fromQualifier = normalizeId(qualifier.extension);
  const fromPayload = normalizeId(payload.extension);
  const fromObject = mutation.object.id.startsWith('capture:')
    ? mutation.object.id.slice('capture:'.length)
    : '';
  return fromQualifier || fromPayload || fromObject;
}

function projectItems(items: ReconciliationItem[]): Projection {
  const tweets = new Map<string, Tweet>();
  const users = new Map<string, User>();
  const captures = new Map<string, Capture>();
  const tweetPatches = new Map<string, Partial<Tweet>>();
  const socialEdges = new Map<string, SocialEdge>();
  const deleteTweets = new Set<string>();
  const deleteUsers = new Set<string>();
  const deleteCaptures = new Set<string>();
  const deleteSocialEdges = new Set<string>();

  for (const item of items) {
    const mutation = item.mutation;
    if (mutation.kind === 'entity_upsert') {
      if (mutation.target.kind === 'tweet') {
        deleteTweets.delete(mutation.target.id);
        tweets.set(mutation.target.id, entityPayload(mutation) as unknown as Tweet);
      } else if (mutation.target.kind === 'user') {
        deleteUsers.delete(mutation.target.id);
        users.set(mutation.target.id, entityPayload(mutation) as unknown as User);
      }
      continue;
    }
    if (mutation.kind === 'enrichment_upsert') {
      if (mutation.enrichment_kind === 'article_markdown' && mutation.target.kind === 'tweet') {
        const payload = asRecord(mutation.payload);
        const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
        requireCondition(markdown, 'article Markdown enrichment is missing');
        const existing = tweetPatches.get(mutation.target.id);
        tweetPatches.set(mutation.target.id, {
          ...existing,
          twe_private_fields: {
            ...existing?.twe_private_fields,
            article_markdown: markdown,
            article_markdown_version:
              typeof payload.version === 'number' && Number.isFinite(payload.version)
                ? payload.version
                : 1,
          },
        } as Partial<Tweet>);
      } else if (
        mutation.enrichment_kind === 'media_reference' &&
        mutation.target.kind === 'media_reference'
      ) {
        const captureId = `canonical-media-reference-${mutation.target.id}`;
        captures.set(captureId, {
          id: captureId,
          extension: 'canonical-media-reference',
          type: ExtensionType.CUSTOM,
          data_key: mutation.target.id,
          created_at: Number(mutation.observed_at_ms) || 0,
          canonical_payload: mutation.payload,
        } as Capture);
      }
      continue;
    }
    if (mutation.kind === 'relationship_upsert') {
      if (mutation.relationship_kind === 'capture_membership') {
        const extension = relationshipExtension(mutation);
        requireCondition(extension, 'capture membership extension is missing');
        requireCondition(
          mutation.subject.kind === 'tweet' ||
            mutation.subject.kind === 'user' ||
            mutation.subject.kind === 'media_reference',
          'capture membership subject kind is unsupported',
        );
        const captureId = `${extension}-${mutation.subject.id}`;
        deleteCaptures.delete(captureId);
        captures.set(captureId, {
          id: captureId,
          extension,
          type:
            mutation.subject.kind === 'user'
              ? ExtensionType.USER
              : mutation.subject.kind === 'tweet'
                ? ExtensionType.TWEET
                : ExtensionType.CUSTOM,
          data_key: mutation.subject.id,
          created_at: Number(mutation.observed_at_ms) || 0,
        });
      } else if (mutation.relationship_kind === 'social_edge') {
        requireCondition(
          mutation.subject.kind === 'user' && mutation.object.kind === 'user',
          'social edge endpoints are invalid',
        );
        const payload = asRecord(mutation.payload);
        const relationType = normalizeId(payload.relation_type || payload.relationType);
        requireCondition(
          relationType === 'follower' ||
            relationType === 'following' ||
            relationType === 'subscription',
          'social edge relation type is unsupported',
        );
        const extension = relationshipExtension(mutation) || 'canonical';
        const id =
          normalizeId(payload.id) ||
          `${extension}-${mutation.subject.id}-${relationType}-${mutation.object.id}`;
        deleteSocialEdges.delete(id);
        socialEdges.set(id, {
          ...payload,
          id,
          extension,
          relation_type: relationType,
          subject_user_id: mutation.subject.id,
          related_user_id: mutation.object.id,
          observed_at: Number(payload.observed_at) || Number(mutation.observed_at_ms) || 0,
        } as SocialEdge);
      } else if (
        mutation.relationship_kind === 'bookmark_folder_membership' &&
        mutation.subject.kind === 'tweet'
      ) {
        const payload = asRecord(mutation.payload);
        const fields: Partial<Tweet> = {};
        const folderId = normalizeId(payload.folder_id);
        const folderName = normalizeId(payload.folder_name);
        if (folderId) {
          (fields as Record<string, unknown>).__bookmark_folder_id = folderId;
        }
        if (folderName) {
          (fields as Record<string, unknown>).__bookmark_folder_name = folderName;
        }
        if (Object.keys(fields).length) {
          tweetPatches.set(mutation.subject.id, {
            ...tweetPatches.get(mutation.subject.id),
            ...fields,
          });
        }
      }
      continue;
    }
    if (mutation.kind === 'tombstone') {
      if (mutation.target_kind === 'tweet') {
        tweets.delete(mutation.target_id);
        deleteTweets.add(mutation.target_id);
      } else if (mutation.target_kind === 'user') {
        users.delete(mutation.target_id);
        deleteUsers.add(mutation.target_id);
      } else if (mutation.target_kind === 'relationship') {
        const captureMatch = /^capture-membership:(tweet|user):([^:]+):(.+)$/.exec(
          mutation.target_id,
        );
        if (mutation.relationship_kind === 'capture_membership' && captureMatch) {
          const captureId = `${captureMatch[2]}-${captureMatch[3]}`;
          captures.delete(captureId);
          deleteCaptures.add(captureId);
        } else {
          socialEdges.delete(mutation.target_id);
          deleteSocialEdges.add(mutation.target_id);
        }
      }
    }
  }

  return {
    tweets: [...tweets.values()],
    tweetPatches: [...tweetPatches].map(([id, fields]) => ({ id, fields })),
    users: [...users.values()],
    captures: [...captures.values()],
    socialEdges: [...socialEdges.values()],
    deleteTweets: [...deleteTweets],
    deleteUsers: [...deleteUsers],
    deleteCaptures: [...deleteCaptures],
    deleteSocialEdges: [...deleteSocialEdges],
  };
}

function countTotal(counts: Omit<GenerationCounts, 'total'>): GenerationCounts {
  const total =
    counts.captures + counts.tweets + counts.users + counts.social_edges + counts.search_documents;
  return { ...counts, total };
}

function generationDatabaseName(generationId: string): string {
  return `${DEFAULT_DATABASE_NAME}-generation-${generationId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-48)}`;
}

function journalFailure(journal: GenerationJournal, error: unknown): GenerationJournal {
  return {
    ...journal,
    state: 'failed',
    updated_at_ms: Date.now(),
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function rebuildCanonicalGeneration(
  options: GenerationOptions,
): Promise<GenerationResult> {
  const generationId = randomGenerationId();
  const databaseName = generationDatabaseName(generationId);
  const previousPointer = readBoundActiveGenerationPointer(
    options.pairing.archive_id,
    options.pairing.namespace_id,
  );
  const previousDatabaseName = previousPointer?.database_name ?? null;
  const journal: GenerationJournal = {
    schema_version: 1,
    state: 'staging',
    generation_id: generationId,
    database_name: databaseName,
    previous_database_name: previousDatabaseName,
    archive_id: options.pairing.archive_id,
    namespace_id: options.pairing.namespace_id,
    started_at_ms: Date.now(),
    updated_at_ms: Date.now(),
  };
  writeGenerationJournal(journal);
  let manager: DatabaseManager | null = null;
  let activated = false;
  try {
    const pageHint = Math.max(
      1,
      Math.min(10_000, Math.floor(Number(options.pageHint) || DEFAULT_PAGE_HINT)),
    );
    const request = {
      protocol: SCROLLMARK_PROTOCOL,
      request_id: `${generationId}-reconcile`,
      archive_id: options.pairing.archive_id,
      namespace_id: options.pairing.namespace_id,
      client_id: options.pairing.client_id,
      client_epoch: options.pairing.client_epoch,
      sent_at_ms: Date.now(),
      mode: 'state_bootstrap' as const,
      after_checkpoint: null,
      known_checkpoint: null,
      page_hint: pageHint,
    };
    options.onProgress?.({ phase: 'reconcile' });
    const descriptor = await options.client.reconcile(request);
    validateDescriptor(descriptor, options.pairing);
    manager =
      options.databaseFactory?.(databaseName) ??
      new DatabaseManager({
        databaseName,
        publishActiveName: false,
      });
    await manager.whenReady();

    const manifest = new StateBootstrapManifestHasher(
      descriptor.namespace_id,
      descriptor.source_checkpoint,
      descriptor.target_checkpoint,
    );
    const seenMutationIds = new Set<string>();
    const seenStateKeys = new Set<string>();
    let pageIndex = 0;
    let cursor: string | undefined;
    let expectedChainHash = descriptor.source_checkpoint.chain_hash;
    let expectedArchiveSequence = descriptor.source_checkpoint.archive_seq + 1;
    let itemCount = 0;
    while (true) {
      const page = await options.client.reconciliationPage(descriptor.stream_id, cursor);
      const state = await validatePage(
        page,
        descriptor,
        pageIndex,
        expectedChainHash,
        expectedArchiveSequence,
        seenMutationIds,
        seenStateKeys,
      );
      manifest.add(page.items);
      itemCount += page.items.length;
      expectedChainHash = state.nextChainHash;
      expectedArchiveSequence = state.nextArchiveSequence;
      await manager.applyGenerationProjection(projectItems(page.items));
      options.onProgress?.({
        phase: 'project',
        page_index: pageIndex,
        page_count: descriptor.page_count,
        item_count: itemCount,
      });
      pageIndex += 1;
      if (page.final) break;
      requireCondition(
        typeof page.next_cursor === 'string' && page.next_cursor,
        'reconciliation page cursor is missing',
      );
      cursor = page.next_cursor;
      requireCondition(
        pageIndex < descriptor.page_count,
        'reconciliation stream exceeded its page count',
      );
    }
    requireCondition(
      pageIndex === descriptor.page_count,
      'reconciliation stream page count mismatch',
    );
    requireCondition(
      itemCount === descriptor.item_count,
      'reconciliation stream item count mismatch',
    );
    const manifestHash = manifest.digestHex();
    requireCondition(
      manifestHash === descriptor.manifest_hash,
      'reconciliation manifest hash mismatch',
    );
    requireCondition(
      descriptor.target_checkpoint.archive_seq >= descriptor.source_checkpoint.archive_seq,
      'reconciliation target checkpoint regressed',
    );

    await manager.deleteGenerationPatchStubs();
    options.onProgress?.({ phase: 'derive', item_count: itemCount });
    await manager.rebuildGenerationSearchDocuments();
    await manager.rebuildGenerationDerivedIndexes();
    const projectionHash = await manager.generationProjectionHash();
    const stats = await manager.count();
    requireCondition(stats !== null, 'staged database statistics are unavailable');
    const counts = countTotal({
      captures: stats.captures,
      tweets: stats.tweets,
      users: stats.users,
      social_edges: stats.social_edges,
      search_documents: stats.search_documents,
    });
    const pointer: ActiveGenerationPointer = {
      schema_version: 1,
      state: 'active',
      verification: 'verified',
      protocol_version: SCROLLMARK_PROTOCOL,
      archive_schema_revision: SCHEMA_REVISION,
      browser_generation_revision: 1,
      generation_id: generationId,
      database_name: databaseName,
      previous_database_name: previousDatabaseName,
      archive_id: options.pairing.archive_id,
      namespace_id: options.pairing.namespace_id,
      target_checkpoint: descriptor.target_checkpoint,
      manifest_hash: descriptor.manifest_hash,
      projection_hash: projectionHash,
      item_count: descriptor.item_count,
      page_count: descriptor.page_count,
      counts,
      verified_at_ms: Date.now(),
      activated_at_ms: Date.now(),
    };
    options.onProgress?.({ phase: 'activate', item_count: itemCount });
    writeActiveGenerationPointer(pointer);
    activated = true;
    publishActiveDatabaseName(databaseName);
    clearGenerationJournal();
    manager.close();
    manager = null;
    return { pointer, counts, previous_database_name: previousDatabaseName };
  } catch (error) {
    try {
      manager?.close();
    } catch {
      // Ignore staged connection cleanup failures.
    }
    if (!activated) {
      try {
        await Dexie.delete(databaseName);
      } catch {
        // The journal retains the staged name for a later cleanup attempt.
      }
    }
    try {
      writeGenerationJournal(journalFailure(journal, error));
    } catch {
      // Preserve the original generation error.
    }
    throw error;
  }
}

export async function recoverInterruptedGeneration(): Promise<{
  recovered: boolean;
  database_name: string | null;
}> {
  const journal = readGenerationJournal();
  if (!journal) return { recovered: false, database_name: null };
  const active = readActiveGenerationPointer();
  if (active?.database_name === journal.database_name) {
    clearGenerationJournal();
    return { recovered: false, database_name: journal.database_name };
  }
  try {
    await Dexie.delete(journal.database_name);
    clearGenerationJournal();
    return { recovered: true, database_name: journal.database_name };
  } catch (error) {
    try {
      writeGenerationJournal(journalFailure(journal, error));
    } catch {
      // Keep the original cleanup error as the observable failure.
    }
    throw error;
  }
}

export async function ensureCanonicalArchiveProjection(
  options: GenerationOptions,
): Promise<GenerationResult | null> {
  await recoverInterruptedGeneration();
  const pointer = readBoundActiveGenerationPointer(
    options.pairing.archive_id,
    options.pairing.namespace_id,
  );
  if (pointer) {
    try {
      const exists = await Dexie.exists(pointer.database_name);
      if (exists) {
        const probe = new DatabaseManager({
          databaseName: pointer.database_name,
          publishActiveName: false,
        });
        await probe.whenReady();
        const stats = await probe.count();
        if (stats) {
          const observedCounts = countTotal({
            captures: stats.captures,
            tweets: stats.tweets,
            users: stats.users,
            social_edges: stats.social_edges,
            search_documents: stats.search_documents,
          });
          const projectionHash = await probe.generationProjectionHash();
          probe.close();
          if (
            canonicalize(observedCounts) === canonicalize(pointer.counts) &&
            projectionHash === pointer.projection_hash
          ) {
            const currentCheckpoint = await options.client.checkpoint(options.pairing.namespace_id);
            if (
              canonicalize(currentCheckpoint) === canonicalize(pointer.target_checkpoint) &&
              isHash(pointer.manifest_hash)
            ) {
              return null;
            }
          }
        } else {
          probe.close();
        }
      }
    } catch {
      // A missing or unreadable generation is rebuilt from the companion below.
    }
  }
  return rebuildCanonicalGeneration(options);
}

export function hasGenerationJournal(): boolean {
  return readGenerationJournal() !== null;
}

export const generationDefaults = {
  zeroHash: ZERO_HASH,
  entityKinds: ['tweet', 'user', 'folder', 'media_reference'] as EntityKind[],
};
