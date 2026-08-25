import type { DataType } from '@/utils/exporter';

import {
  canonicalize,
  recordHash,
  SCHEMA_REVISION,
  SCROLLMARK_PROTOCOL,
  sha256Hex,
  type Mutation,
  type ReconciliationDescriptor,
  type ReconciliationItem,
  type ReconciliationPage,
} from '@/core/durability/contracts';
import type { CompanionClientLike } from '@/core/durability/companion-client';
import type { PairingContext } from '@/core/durability/identity';

import { createCanonicalBundleZipFromRows, type BundleExportSourceRow } from './exporter';
import type { BundleEntityKind, CompanionSourceMetadata } from './schema';

export class CompanionBundleBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanionBundleBridgeError';
  }
}

export type CompanionBundleBridgeOptions = {
  pairing: PairingContext;
  client: CompanionClientLike;
  title: string;
  description?: string;
  compressionLevel?: 0 | 1 | 6;
  pageHint?: number;
  signal?: AbortSignal;
};

type BridgeProjection = {
  rows: BundleExportSourceRow[];
  warnings: string[];
  counts: CompanionSourceMetadata['records'];
};

function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CompanionBundleBridgeError(message);
}

function endpointNamespaces(mutation: Mutation): string[] {
  if (mutation.kind === 'entity_upsert' || mutation.kind === 'enrichment_upsert') {
    return [mutation.target.namespace_id];
  }
  if (mutation.kind === 'relationship_upsert') {
    return [mutation.subject.namespace_id, mutation.object.namespace_id];
  }
  return [];
}

function containsPrivateMessageMaterial(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some((item) => containsPrivateMessageMaterial(item, seen));
  const privateKeys: Record<string, true> = {
    dm: true,
    direct_message: true,
    direct_messages: true,
    conversation_id: true,
    recipient_ids: true,
    private_message: true,
    private_messages: true,
  };
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.trim().toLowerCase().replace(/-/g, '_');
    return privateKeys[normalized] === true || containsPrivateMessageMaterial(child, seen);
  });
}

async function validateItem(namespaceId: string, item: ReconciliationItem): Promise<void> {
  const mutation = item.mutation;
  requireProof(
    mutation.schema_revision === SCHEMA_REVISION,
    'unsupported canonical schema revision',
  );
  requireProof(item.mutation_id === mutation.mutation_id, 'canonical mutation identity mismatch');
  requireProof(item.record_hash === mutation.record_hash, 'canonical record hash is not bound');
  requireProof(
    endpointNamespaces(mutation).every((value) => value === namespaceId),
    'canonical mutation crosses the requested namespace',
  );
  const { record_hash: _recordHash, ...material } = mutation;
  void _recordHash;
  requireProof(
    (await recordHash(namespaceId, material)) === item.record_hash,
    'canonical record hash mismatch',
  );
  requireProof(
    !containsPrivateMessageMaterial(mutation),
    'private-message material is not eligible for shared-safe bundle export',
  );
}

async function readVerifiedState(
  options: CompanionBundleBridgeOptions,
): Promise<{ descriptor: ReconciliationDescriptor; items: ReconciliationItem[] }> {
  const request = {
    protocol: SCROLLMARK_PROTOCOL,
    request_id: `bundle-bridge-${Date.now().toString(36)}`,
    archive_id: options.pairing.archive_id,
    namespace_id: options.pairing.namespace_id,
    client_id: options.pairing.client_id,
    client_epoch: options.pairing.client_epoch,
    sent_at_ms: Date.now(),
    mode: 'state_bootstrap' as const,
    after_checkpoint: null,
    known_checkpoint: null,
    page_hint: Math.max(1, Math.min(10_000, options.pageHint ?? 512)),
  };
  if (options.signal?.aborted) throw new CompanionBundleBridgeError('bundle bridge cancelled');
  const descriptor = await options.client.reconcile(request);
  requireProof(
    canonicalize(descriptor.protocol) === canonicalize(SCROLLMARK_PROTOCOL),
    'canonical stream protocol mismatch',
  );
  requireProof(
    descriptor.namespace_id === options.pairing.namespace_id,
    'canonical namespace mismatch',
  );
  requireProof(descriptor.mode === 'state_bootstrap', 'bundle bridge requires a state bootstrap');
  requireProof(descriptor.page_count > 0, 'canonical stream page count is invalid');

  const items: ReconciliationItem[] = [];
  const mutationIds = new Set<string>();
  const stateKeys = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < descriptor.page_count; pageIndex += 1) {
    if (options.signal?.aborted) throw new CompanionBundleBridgeError('bundle bridge cancelled');
    const page: ReconciliationPage = await options.client.reconciliationPage(
      descriptor.stream_id,
      cursor,
    );
    requireProof(page.page_index === pageIndex, 'canonical page sequence is not contiguous');
    requireProof(page.stream_id === descriptor.stream_id, 'canonical page stream mismatch');
    requireProof(
      page.namespace_id === descriptor.namespace_id,
      'canonical page namespace mismatch',
    );
    requireProof(page.mode === 'state_bootstrap', 'canonical page mode mismatch');
    requireProof(
      page.manifest_hash === descriptor.manifest_hash,
      'canonical page manifest mismatch',
    );
    requireProof(
      canonicalize(page.target_checkpoint) === canonicalize(descriptor.target_checkpoint),
      'canonical page checkpoint mismatch',
    );
    requireProof(page.item_count === page.items.length, 'canonical page item count mismatch');
    requireProof(
      new TextEncoder().encode(canonicalize(page.items)).byteLength === page.byte_count,
      'canonical page byte proof mismatch',
    );
    const { page_hash: _pageHash, ...pageMaterial } = page;
    void _pageHash;
    requireProof(
      (await sha256Hex(pageMaterial)) === page.page_hash,
      'canonical page hash mismatch',
    );
    for (const item of page.items) {
      requireProof(!mutationIds.has(item.mutation_id), 'duplicate canonical mutation identity');
      requireProof(
        typeof item.state_key === 'string' && !stateKeys.has(item.state_key),
        'canonical state key is missing or duplicated',
      );
      mutationIds.add(item.mutation_id);
      stateKeys.add(item.state_key);
      await validateItem(options.pairing.namespace_id, item);
      items.push(item);
    }
    requireProof(
      page.final === (pageIndex === descriptor.page_count - 1),
      'canonical final-page proof mismatch',
    );
    cursor = page.next_cursor;
  }
  requireProof(items.length === descriptor.item_count, 'canonical stream item count mismatch');
  requireProof(
    (await sha256Hex({
      mode: descriptor.mode,
      namespace_id: descriptor.namespace_id,
      source_checkpoint: descriptor.source_checkpoint,
      target_checkpoint: descriptor.target_checkpoint,
      items,
    })) === descriptor.manifest_hash,
    'canonical state manifest mismatch',
  );
  return { descriptor, items };
}

function projectionFor(items: ReconciliationItem[]): BridgeProjection {
  const rows: BundleExportSourceRow[] = [];
  const warnings = new Set<string>();
  const counts: CompanionSourceMetadata['records'] = {
    total: 0,
    tweets: 0,
    users: 0,
    socialEdges: 0,
    captures: 0,
    media: 0,
    unknown: 0,
  };
  const add = (id: string, kind: BundleEntityKind, data: Record<string, unknown>) => {
    rows.push({ id, kind, original: data, record: data as DataType });
    counts.total += 1;
    if (kind === 'tweet') counts.tweets += 1;
    else if (kind === 'user') counts.users += 1;
    else if (kind === 'social_edge') counts.socialEdges += 1;
    else if (kind === 'capture') counts.captures += 1;
    else if (kind === 'media') counts.media += 1;
    else counts.unknown += 1;
  };

  for (const item of items) {
    const mutation = item.mutation;
    if (mutation.kind === 'entity_upsert') {
      const kind: BundleEntityKind =
        mutation.target.kind === 'tweet' || mutation.target.kind === 'user'
          ? mutation.target.kind
          : mutation.target.kind === 'media_reference'
            ? 'media'
            : 'unknown';
      add(mutation.target.id, kind, { ...mutation.payload, rest_id: mutation.target.id });
    } else if (mutation.kind === 'relationship_upsert') {
      if (mutation.relationship_kind === 'capture_membership') {
        add(item.state_key ?? mutation.mutation_id, 'capture', {
          ...mutation.payload,
          relationship_kind: mutation.relationship_kind,
          subject: mutation.subject,
          object: mutation.object,
          qualifier: mutation.qualifier,
          observed_at_ms: mutation.observed_at_ms,
        });
      } else if (mutation.relationship_kind === 'social_edge') {
        add(item.state_key ?? mutation.mutation_id, 'social_edge', {
          ...mutation.payload,
          subject: mutation.subject,
          object: mutation.object,
          qualifier: mutation.qualifier,
          observed_at_ms: mutation.observed_at_ms,
        });
      } else {
        warnings.add(
          `Exported unsupported relationship kind as unknown: ${mutation.relationship_kind}`,
        );
        add(item.state_key ?? mutation.mutation_id, 'unknown', {
          relationship_kind: mutation.relationship_kind,
          subject: mutation.subject,
          object: mutation.object,
          qualifier: mutation.qualifier,
          payload: mutation.payload,
          observed_at_ms: mutation.observed_at_ms,
        });
      }
    } else if (mutation.kind === 'enrichment_upsert') {
      const kind: BundleEntityKind =
        mutation.enrichment_kind === 'media_reference' ? 'media' : 'unknown';
      if (kind === 'unknown')
        warnings.add(`Exported enrichment as unknown: ${mutation.enrichment_kind}`);
      add(item.state_key ?? mutation.mutation_id, kind, {
        ...mutation.payload,
        enrichment_kind: mutation.enrichment_kind,
        target: mutation.target,
      });
    } else {
      warnings.add('Omitted canonical tombstone from current-state bundle');
    }
  }
  return { rows, warnings: [...warnings].sort(), counts };
}

export async function createCompanionNamespaceBundle(options: CompanionBundleBridgeOptions) {
  const { descriptor, items } = await readVerifiedState(options);
  const projection = projectionFor(items);
  const companionSource: CompanionSourceMetadata = {
    format: 'scrollmark.companion-source.v1',
    protocolVersion: SCROLLMARK_PROTOCOL,
    schemaRevision: SCHEMA_REVISION,
    bridgeRevision: 1,
    archiveFingerprint: await sha256Hex(`archive:${options.pairing.archive_id}`),
    namespaceFingerprint: await sha256Hex(`namespace:${options.pairing.namespace_id}`),
    checkpoint: {
      archiveSeq: descriptor.target_checkpoint.archive_seq,
      chainHash: descriptor.target_checkpoint.chain_hash,
    },
    canonicalStateManifestHash: descriptor.manifest_hash,
    records: projection.counts,
    privacy: {
      visibility: 'shared_safe',
      rawIdentifiersExcludedFromMetadata: true,
      privateMessagesExcluded: true,
    },
    warnings: projection.warnings,
  };
  if (options.signal?.aborted) throw new CompanionBundleBridgeError('bundle bridge cancelled');
  const bundle = await createCanonicalBundleZipFromRows(projection.rows, {
    title: options.title,
    description: options.description,
    scope: 'bundle',
    includeOriginalMetadata: false,
    compressionLevel: options.compressionLevel,
    totalRecords: projection.rows.length,
    companionSource,
  });
  return { ...bundle, companionSource };
}
