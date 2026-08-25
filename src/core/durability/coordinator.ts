import { signal, type Signal } from '@preact/signals';

import {
  batchHash,
  canonicalize,
  recordHash,
  SCHEMA_REVISION,
  SCROLLMARK_PROTOCOL,
  type ArchiveDeltaRequest,
  type Endpoint,
  type EntityKind,
  type EntityUpsert,
  type Mutation,
  type Provenance,
  type RelationshipUpsert,
  type Tombstone,
  type Checkpoint,
  type CommitReceipt,
} from './contracts';
import { CompanionClientError, type CompanionClientLike } from './companion-client';
import {
  IdentityController,
  type IdentityEvidence,
  type IdentitySnapshot,
  type PairingContext,
} from './identity';
import { OutboxBoundError, OutboxStore, type OutboxRow, type OutboxUsage } from './outbox';

export const DURABLE_OPERATIONS = new Set([
  'extAddTweets',
  'extAddUsers',
  'extAddCustomCaptures',
  'extAddSocialEdges',
  'extAddTweetCaptureIds',
  'extRemoveTweetCaptureIds',
  'extAddUserCaptureIds',
  'extRemoveUserCaptureIds',
  'upsertTweets',
  'upsertUsers',
  'upsertCaptures',
  'upsertSocialEdges',
]);

export type DurabilityState =
  | 'disabled'
  | 'initializing'
  | 'ready'
  | 'degraded'
  | 'identity_required'
  | 'quiescing'
  | 'stopped'
  | 'error';

export type DurabilityStatus = {
  state: DurabilityState;
  reason: string;
  archive_id: string | null;
  namespace_id: string | null;
  checkpoint: Checkpoint | null;
  capability_revision: string | null;
  identity: IdentitySnapshot;
  outbox: OutboxUsage | null;
  last_error: { code: string; message: string } | null;
  changed_at_ms: number;
};

export type LocalWrite = () => Promise<unknown> | unknown;

export type DurabilityCoordinatorOptions = {
  pairing?: PairingContext | null;
  identity?: IdentityController;
  identityEvidence?: IdentityEvidence[];
  client?: CompanionClientLike | null;
  outbox?: OutboxStore;
  now?: () => number;
  randomId?: (prefix?: string) => string;
  retryBaseMs?: number;
};

export class DurabilityError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: DurabilityStatus;

  constructor(code: string, message: string, status: DurabilityStatus, retryable = false) {
    super(message);
    this.name = 'DurabilityError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === 'string' || typeof item === 'number' ? String(item).trim() : '',
    )
    .filter(Boolean);
}

function sourceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function valueId(value: unknown, keys: string[]): string | null {
  const source = sourceRecord(value);
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const normalized = String(candidate).trim();
      if (normalized) return normalized;
    }
  }
  return null;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(sourceRecord) : [];
}

function hasPrivateKey(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  const object = value as object;
  if (seen.has(object)) return false;
  seen.add(object);
  if (Array.isArray(value)) return value.some((item) => hasPrivateKey(item, seen));
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
    return privateKeys.has(normalized) || hasPrivateKey(child, seen);
  });
}

function isRetryableCommitError(error: unknown): boolean {
  return (
    error instanceof CompanionClientError &&
    (error.retryable ||
      error.code === 'malformed_response' ||
      error.code === 'companion_unavailable' ||
      error.code === 'internal_commit_unknown')
  );
}

function errorCode(error: unknown): string {
  if (error instanceof CompanionClientError) return error.code;
  if (error instanceof OutboxBoundError) return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DurabilityCoordinator {
  readonly status: Signal<DurabilityStatus>;
  readonly identity: IdentityController;
  readonly outbox: OutboxStore;

  private readonly pairing: PairingContext | null;
  private readonly client: CompanionClientLike | null;
  private readonly now: () => number;
  private readonly randomId: (prefix?: string) => string;
  private readonly retryBaseMs: number;
  private checkpoint: Checkpoint | null = null;
  private capabilityRevision: string | null = null;
  private nextClientSequence = 1;
  private initializePromise: Promise<void> | null = null;
  private replayPromise: Promise<void> | null = null;
  private operationPromise: Promise<void> = Promise.resolve();

  constructor(options: DurabilityCoordinatorOptions = {}) {
    this.pairing = options.pairing ?? null;
    this.identity = options.identity ?? new IdentityController(this.pairing, options.now);
    if (options.identityEvidence) this.identity.setEvidence(options.identityEvidence);
    this.outbox = options.outbox ?? new OutboxStore();
    this.client = options.client ?? null;
    this.now = options.now ?? (() => Date.now());
    this.randomId =
      options.randomId ??
      ((prefix = 'id') =>
        `${prefix}-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    this.retryBaseMs = Math.max(100, options.retryBaseMs ?? 1000);
    this.status = signal({
      state: this.pairing && this.client ? 'initializing' : 'disabled',
      reason: this.pairing && this.client ? 'companion-not-initialized' : 'pairing-not-configured',
      archive_id: this.pairing?.archive_id ?? null,
      namespace_id: this.pairing?.namespace_id ?? null,
      checkpoint: null,
      capability_revision: null,
      identity: this.identity.state.value,
      outbox: null,
      last_error: null,
      changed_at_ms: this.now(),
    });
  }

  isDurableOperation(operation: string): boolean {
    return DURABLE_OPERATIONS.has(operation);
  }

  getStatus(): DurabilityStatus {
    return this.status.value;
  }

  async initialize(): Promise<void> {
    if (!this.pairing || !this.client) {
      this.setStatus('disabled', 'pairing-not-configured');
      return;
    }
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeInternal();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  async route(operation: string, args: unknown[], localWrite: LocalWrite): Promise<unknown> {
    return this.withOperationLease(() => this.routeExclusive(operation, args, localWrite));
  }

  private async routeExclusive(
    operation: string,
    args: unknown[],
    localWrite: LocalWrite,
  ): Promise<unknown> {
    if (!this.isDurableOperation(operation) || !this.pairing || !this.client) return localWrite();
    await this.initialize();
    const assessment = this.identity.observe();
    this.updateIdentity();
    if (!assessment.admitted) {
      this.setStatus('identity_required', assessment.reason, {
        last_error: { code: 'identity_required', message: assessment.reason },
      });
      throw new DurabilityError('identity_required', assessment.reason, this.status.value);
    }
    if (this.status.value.state === 'stopped' || this.status.value.state === 'error') {
      throw new DurabilityError(
        'durability_stream_stopped',
        'durability stream is stopped pending operator recovery',
        this.status.value,
      );
    }
    // Resolve older rows before admitting a new commit attempt. New rows may be
    // queued during an outage, but no later sequence may overtake the oldest.
    await this.replayPendingExclusive();
    if (this.streamStopped()) {
      throw new DurabilityError(
        'durability_stream_stopped',
        'durability stream is stopped pending operator recovery',
        this.status.value,
      );
    }
    const mutations = await this.buildMutations(operation, args);
    if (!mutations.length) return localWrite();
    const request = await this.createRequest(mutations);
    const canonicalBytes = new TextEncoder().encode(canonicalize(request)).byteLength;
    let row: OutboxRow;
    try {
      row = await this.outbox.admit(request, canonicalBytes);
      await this.outbox.setMetadata('next_client_sequence', this.nextClientSequence);
    } catch (error) {
      this.setStatus('stopped', errorMessage(error), {
        last_error: { code: errorCode(error), message: errorMessage(error) },
      });
      throw error;
    }

    const pending = await this.outbox.listAllPending();
    if (pending[0]?.batch_id !== row.batch_id) {
      await this.refreshUsage();
      this.setStatus('degraded', 'older-outbox-row-awaiting-fifo-replay');
      return this.localProjection(localWrite);
    }

    try {
      const receipt = await this.commitExact(row);
      await this.acknowledgeReceipt(row, receipt);
      await this.refreshUsage();
      this.setStatus('ready', 'companion-commit-acknowledged');
      return this.localProjection(localWrite);
    } catch (error) {
      if (error instanceof DurabilityError && error.code === 'outbox_persistence_failed')
        throw error;
      if (isRetryableCommitError(error)) {
        await this.noteRetry(row, error);
        await this.refreshUsage();
        this.setStatus('degraded', errorMessage(error), {
          last_error: { code: errorCode(error), message: errorMessage(error) },
        });
        return this.localProjection(localWrite);
      }
      await this.quarantine(row, error, operation);
      this.setStatus('error', errorMessage(error), {
        last_error: { code: errorCode(error), message: errorMessage(error) },
      });
      throw error;
    }
  }

  async submitTombstone(
    targetKind: Tombstone['target_kind'],
    targetId: string,
    localWrite: LocalWrite,
    options: { relationshipKind?: string; operation?: string } = {},
  ): Promise<unknown> {
    return this.withOperationLease(() =>
      this.submitTombstoneExclusive(targetKind, targetId, localWrite, options),
    );
  }

  private async submitTombstoneExclusive(
    targetKind: Tombstone['target_kind'],
    targetId: string,
    localWrite: LocalWrite,
    options: { relationshipKind?: string; operation?: string } = {},
  ): Promise<unknown> {
    if (!this.pairing || !this.client) return localWrite();
    await this.initialize();
    const assessment = this.identity.observe();
    this.updateIdentity();
    if (!assessment.admitted)
      throw new DurabilityError('identity_required', assessment.reason, this.status.value);
    await this.replayPendingExclusive();
    if (this.status.value.state === 'error' || this.status.value.state === 'stopped') {
      throw new DurabilityError(
        'durability_stream_stopped',
        'durability stream is stopped pending operator recovery',
        this.status.value,
      );
    }
    const mutationWithoutHash: Omit<Tombstone, 'record_hash'> = {
      mutation_id: this.randomId('mutation'),
      client_seq: this.nextClientSequence,
      kind: 'tombstone',
      schema_revision: SCHEMA_REVISION,
      target_kind: targetKind,
      target_id: targetId,
      ...(options.relationshipKind ? { relationship_kind: options.relationshipKind } : {}),
      deletion_id: this.randomId('deletion'),
      provenance: this.provenance(options.operation ?? 'tombstone', targetId),
      observed_at_ms: this.now(),
    };
    const mutation: Tombstone = {
      ...mutationWithoutHash,
      record_hash: await recordHash(this.pairing.namespace_id, mutationWithoutHash),
    };
    const request = await this.createRequest([mutation]);
    const canonicalBytes = new TextEncoder().encode(canonicalize(request)).byteLength;
    let row: OutboxRow;
    try {
      row = await this.outbox.admit(request, canonicalBytes);
      await this.outbox.setMetadata('next_client_sequence', this.nextClientSequence);
    } catch (error) {
      this.setStatus('stopped', errorMessage(error), {
        last_error: { code: errorCode(error), message: errorMessage(error) },
      });
      throw error;
    }
    const pending = await this.outbox.listAllPending();
    if (pending[0]?.batch_id !== row.batch_id) {
      await this.refreshUsage();
      this.setStatus('degraded', 'older-outbox-row-awaiting-fifo-replay');
      return this.localProjection(localWrite);
    }
    try {
      const receipt = await this.commitExact(row);
      await this.acknowledgeReceipt(row, receipt);
      await this.refreshUsage();
      return this.localProjection(localWrite);
    } catch (error) {
      if (error instanceof DurabilityError && error.code === 'outbox_persistence_failed')
        throw error;
      if (isRetryableCommitError(error)) {
        await this.noteRetry(row, error);
        await this.refreshUsage();
        this.setStatus('degraded', errorMessage(error), {
          last_error: { code: errorCode(error), message: errorMessage(error) },
        });
        return this.localProjection(localWrite);
      }
      await this.quarantine(row, error, options.operation ?? 'tombstone');
      this.setStatus('error', errorMessage(error), {
        last_error: { code: errorCode(error), message: errorMessage(error) },
      });
      throw error;
    }
  }

  async replayPending(): Promise<void> {
    return this.withOperationLease(() => this.replayPendingExclusive());
  }

  private async replayPendingExclusive(): Promise<void> {
    if (!this.pairing || !this.client) return;
    if (this.replayPromise) return this.replayPromise;
    this.replayPromise = this.replayInternal();
    try {
      await this.replayPromise;
    } finally {
      this.replayPromise = null;
    }
  }

  async stop(reason: string): Promise<void> {
    await this.outbox.stop(reason);
    this.setStatus('stopped', reason);
  }

  private async withOperationLease<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationPromise;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationPromise = current;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private streamStopped(): boolean {
    const state = this.status.value.state;
    return state === 'error' || state === 'stopped';
  }

  private async initializeInternal(): Promise<void> {
    this.setStatus('initializing', 'companion-capabilities');
    const assessment = this.identity.observe();
    this.updateIdentity();
    if (!assessment.admitted) {
      this.setStatus('identity_required', assessment.reason, {
        last_error: { code: 'identity_required', message: assessment.reason },
      });
      return;
    }
    const existingUsage = await this.outbox.usage();
    if (existingUsage.stopped || existingUsage.quarantined_batches > 0) {
      if (!existingUsage.stopped) await this.outbox.stop('quarantine_pending');
      await this.refreshUsage();
      this.setStatus('stopped', existingUsage.stop_reason ?? 'outbox-recovery-required');
      return;
    }
    const capabilities = await this.client!.capabilities();
    this.capabilityRevision = capabilities.capability_revision;
    const health = await this.client!.health();
    this.assertHealthBinding(health);
    this.checkpoint = await this.client!.checkpoint(this.pairing!.namespace_id);
    if (this.checkpoint.namespace_id !== this.pairing!.namespace_id) {
      throw new DurabilityError(
        'namespace_not_active',
        'checkpoint namespace does not match pairing',
        this.status.value,
      );
    }
    const storedNext = await this.outbox.getMetadata<number>('next_client_sequence');
    const pending = await this.outbox.listAllPending();
    const pendingNext = pending.reduce(
      (current, row) => Math.max(current, row.client_sequence_to + 1),
      1,
    );
    this.nextClientSequence = Math.max(storedNext ?? 1, pendingNext);
    await this.refreshUsage();
    const usage = this.status.value.outbox;
    if (usage?.stopped || usage?.quarantined_batches) {
      this.setStatus('stopped', usage.stop_reason ?? 'outbox-recovery-required');
      return;
    }
    this.setStatus('ready', 'companion-ready');
  }

  private assertHealthBinding(health: Record<string, unknown>): void {
    const archive = health.archive;
    if (archive && typeof archive === 'object') {
      const archiveRecord = archive as Record<string, unknown>;
      if (
        archiveRecord.archive_id !== undefined &&
        archiveRecord.archive_id !== this.pairing!.archive_id
      ) {
        throw new DurabilityError(
          'archive_binding_mismatch',
          'health archive does not match pairing',
          this.status.value,
        );
      }
    }
    const active = health.active_namespace_ids;
    if (Array.isArray(active) && active.length && !active.includes(this.pairing!.namespace_id)) {
      throw new DurabilityError(
        'namespace_not_active',
        'paired namespace is not active',
        this.status.value,
      );
    }
  }

  private async createRequest(mutations: Mutation[]): Promise<ArchiveDeltaRequest> {
    const first = mutations[0]?.client_seq ?? this.nextClientSequence;
    const last = mutations[mutations.length - 1]?.client_seq ?? first;
    const batch = {
      batch_id: this.randomId('batch'),
      mutation_count: mutations.length,
      mutations,
      batch_hash: await batchHash(this.pairing!.namespace_id, { mutations }),
    };
    const request: ArchiveDeltaRequest = {
      protocol: SCROLLMARK_PROTOCOL,
      request_id: this.randomId('request'),
      archive_id: this.pairing!.archive_id,
      namespace_id: this.pairing!.namespace_id,
      client_id: this.pairing!.client_id,
      client_epoch: this.pairing!.client_epoch,
      sent_at_ms: this.now(),
      client_sequence: { from: first, to: last },
      batch,
      known_checkpoint: this.checkpoint,
    };
    this.nextClientSequence = last + 1;
    return request;
  }

  private async commitExact(row: OutboxRow): Promise<CommitReceipt> {
    const receipt = await this.client!.commit(row.request);
    if (receipt.batch_id !== row.batch_id) {
      throw new CompanionClientError(
        'validation_failed',
        'receipt batch differs from outbox batch',
      );
    }
    return receipt;
  }

  private async replayInternal(): Promise<void> {
    const assessment = this.identity.observe();
    this.updateIdentity();
    if (!assessment.admitted) {
      this.setStatus('identity_required', assessment.reason, {
        last_error: { code: 'identity_required', message: assessment.reason },
      });
      return;
    }
    const rows = await this.outbox.listAllPending();
    for (const row of rows) {
      try {
        const receipt = await this.commitExact(row);
        await this.acknowledgeReceipt(row, receipt);
      } catch (error) {
        if (error instanceof DurabilityError && error.code === 'outbox_persistence_failed') break;
        if (isRetryableCommitError(error)) {
          await this.noteRetry(row, error);
          break;
        }
        await this.quarantine(row, error, 'replay');
        this.setStatus('error', errorMessage(error), {
          last_error: { code: errorCode(error), message: errorMessage(error) },
        });
        break;
      }
    }
    await this.refreshUsage();
    if (this.status.value.state !== 'stopped' && this.status.value.state !== 'error') {
      const usage = this.status.value.outbox;
      this.setStatus(usage?.pending_batches ? 'degraded' : 'ready', 'pending-replay-processed');
    }
  }

  private async noteRetry(row: OutboxRow, error: unknown): Promise<void> {
    const attempt = row.attempt_count + 1;
    const retryAfter = error instanceof CompanionClientError ? error.retryAfterMs : null;
    const delay = retryAfter ?? Math.min(60_000, this.retryBaseMs * 2 ** Math.min(attempt, 8));
    await this.outbox.markAttempt(row.batch_id, {
      nextRetryAtMs: this.now() + delay,
      errorCode: errorCode(error),
    });
  }

  private async quarantine(row: OutboxRow, error: unknown, operation: string): Promise<void> {
    await this.outbox.quarantinePending(row.batch_id, {
      quarantineId: this.randomId('quarantine'),
      operation,
      reasonCode: errorCode(error),
      evidence: {
        message: errorMessage(error),
        ...(error instanceof CompanionClientError
          ? { status: error.status, request_id: error.requestId }
          : {}),
      },
    });
    await this.outbox.stop(`quarantine:${errorCode(error)}`);
    await this.refreshUsage();
  }

  private async localProjection(localWrite: LocalWrite): Promise<unknown> {
    try {
      return await localWrite();
    } catch (error) {
      this.setStatus('degraded', 'local-projection-failed-recovery-required', {
        last_error: {
          code: 'local_projection_failed',
          message: errorMessage(error),
        },
      });
      throw error;
    }
  }

  private async acknowledgeReceipt(row: OutboxRow, receipt: CommitReceipt): Promise<void> {
    try {
      await this.outbox.acknowledge(row.batch_id, {
        next_client_sequence: receipt.client_sequence.to + 1,
        checkpoint: receipt.checkpoint,
      });
    } catch (error) {
      try {
        await this.outbox.stop('acknowledgement_persistence');
      } catch {
        // Preserve the stopped status even if the database cannot be updated.
      }
      this.setStatus('stopped', 'acknowledgement-persistence-failed', {
        last_error: {
          code: 'outbox_persistence_failed',
          message: errorMessage(error),
        },
      });
      throw new DurabilityError(
        'outbox_persistence_failed',
        'the committed receipt could not be persisted locally',
        this.status.value,
      );
    }
    this.applyReceipt(receipt);
  }

  private applyReceipt(receipt: CommitReceipt): void {
    this.checkpoint = receipt.checkpoint;
    this.nextClientSequence = Math.max(this.nextClientSequence, receipt.client_sequence.to + 1);
  }

  private updateIdentity(): void {
    this.status.value = {
      ...this.status.value,
      identity: this.identity.state.value,
      changed_at_ms: this.now(),
    };
  }

  private async refreshUsage(): Promise<void> {
    const usage = await this.outbox.usage();
    this.status.value = { ...this.status.value, outbox: usage, changed_at_ms: this.now() };
  }

  private setStatus(
    state: DurabilityState,
    reason: string,
    patch: Partial<DurabilityStatus> = {},
  ): void {
    this.status.value = {
      ...this.status.value,
      ...patch,
      state,
      reason,
      checkpoint: this.checkpoint,
      capability_revision: this.capabilityRevision,
      identity: this.identity.state.value,
      archive_id: this.pairing?.archive_id ?? null,
      namespace_id: this.pairing?.namespace_id ?? null,
      changed_at_ms: this.now(),
    };
  }

  private provenance(operation: string, sourceEventId?: string): Provenance {
    return {
      source: 'x.com',
      source_event_id: sourceEventId ? `${operation}:${sourceEventId}` : operation,
      extract_path: `browser.${operation}`,
      extractor_rev: 'scrollmark-browser-v1',
    };
  }

  private async buildMutations(operation: string, args: unknown[]): Promise<Mutation[]> {
    const extension = typeof args[0] === 'string' ? args[0] : 'unscoped';
    if (operation === 'extAddTweets' || operation === 'extAddUsers') {
      const kind = operation === 'extAddTweets' ? 'tweet' : 'user';
      const idKeys =
        kind === 'tweet' ? ['rest_id', 'id_str', 'id'] : ['rest_id', 'id_str', 'id', 'user_id'];
      const values = recordArray(args[1]);
      const entities = await this.entityMutations(kind, operation, values, idKeys);
      const memberships = await this.captureMutations(
        extension,
        operation,
        values.map((value) => ({
          data_key: valueId(value, idKeys),
          type: kind,
        })),
        entities.length,
      );
      return [...entities, ...memberships];
    }
    if (operation === 'upsertTweets') {
      return this.entityMutations('tweet', operation, recordArray(args[0]), [
        'rest_id',
        'id_str',
        'id',
      ]);
    }
    if (operation === 'upsertUsers') {
      return this.entityMutations('user', operation, recordArray(args[0]), [
        'rest_id',
        'id_str',
        'id',
        'user_id',
      ]);
    }
    if (operation === 'extAddSocialEdges') {
      return this.relationshipMutations(extension, operation, recordArray(args[1]));
    }
    if (operation === 'upsertSocialEdges') {
      const values = recordArray(args[0]);
      const sourceExtension = valueId(values[0], ['extension']) ?? 'unscoped';
      return this.relationshipMutations(sourceExtension, operation, values);
    }
    if (operation === 'extAddCustomCaptures') {
      return this.captureMutations(extension, operation, recordArray(args[1]));
    }
    if (operation === 'upsertCaptures') {
      return this.captureMutations('unscoped', operation, recordArray(args[0]));
    }
    if (operation === 'extAddTweetCaptureIds' || operation === 'extAddUserCaptureIds') {
      const kind = operation.includes('Tweet') ? 'tweet' : 'user';
      return this.membershipMutations(kind, extension, operation, stringIds(args[1]));
    }
    if (operation === 'extRemoveTweetCaptureIds' || operation === 'extRemoveUserCaptureIds') {
      const kind = operation.includes('Tweet') ? 'tweet' : 'user';
      return this.membershipTombstones(kind, extension, operation, stringIds(args[1]));
    }
    return [];
  }

  private async entityMutations(
    kind: EntityKind,
    operation: string,
    values: Record<string, unknown>[],
    idKeys: string[],
    sequenceOffset = 0,
  ): Promise<EntityUpsert[]> {
    const mutations: EntityUpsert[] = [];
    for (const [index, payload] of values.entries()) {
      if (hasPrivateKey(payload)) {
        throw new DurabilityError(
          'private_lane_disabled',
          'private or direct-message payloads are disabled',
          this.status.value,
        );
      }
      const id = valueId(payload, idKeys);
      if (!id) continue;
      const mutationWithoutHash: Omit<EntityUpsert, 'record_hash'> = {
        mutation_id: this.randomId('mutation'),
        client_seq: this.nextClientSequence + sequenceOffset + mutations.length,
        kind: 'entity_upsert',
        schema_revision: SCHEMA_REVISION,
        target: this.endpoint(kind, id),
        payload,
        provenance: this.provenance(operation, `${id}:${index}`),
        observed_at_ms: this.now(),
      };
      mutations.push({
        ...mutationWithoutHash,
        record_hash: await recordHash(this.pairing!.namespace_id, mutationWithoutHash),
      });
    }
    return mutations;
  }

  private async relationshipMutations(
    extension: string,
    operation: string,
    values: Record<string, unknown>[],
  ): Promise<RelationshipUpsert[]> {
    const mutations: RelationshipUpsert[] = [];
    for (const [index, payload] of values.entries()) {
      if (hasPrivateKey(payload)) {
        throw new DurabilityError(
          'private_lane_disabled',
          'private or direct-message payloads are disabled',
          this.status.value,
        );
      }
      const subjectId = valueId(payload, [
        'subject_user_id',
        'source_user_id',
        'user_id',
        'subject_id',
      ]);
      const objectId = valueId(payload, [
        'related_user_id',
        'target_user_id',
        'object_user_id',
        'object_id',
      ]);
      if (!subjectId || !objectId) continue;
      const mutationWithoutHash: Omit<RelationshipUpsert, 'record_hash'> = {
        mutation_id: this.randomId('mutation'),
        client_seq: this.nextClientSequence + mutations.length,
        kind: 'relationship_upsert',
        schema_revision: SCHEMA_REVISION,
        relationship_kind: 'social_edge',
        subject: this.endpoint('user', subjectId),
        object: this.endpoint('user', objectId),
        qualifier: { extension },
        payload,
        provenance: this.provenance(
          `${operation}:${extension}`,
          `${subjectId}:${objectId}:${index}`,
        ),
        observed_at_ms: this.now(),
      };
      mutations.push({
        ...mutationWithoutHash,
        record_hash: await recordHash(this.pairing!.namespace_id, mutationWithoutHash),
      });
    }
    return mutations;
  }

  private async captureMutations(
    extension: string,
    operation: string,
    values: Record<string, unknown>[],
    sequenceOffset = 0,
  ): Promise<RelationshipUpsert[]> {
    const mutations: RelationshipUpsert[] = [];
    for (const [index, payload] of values.entries()) {
      if (hasPrivateKey(payload)) {
        throw new DurabilityError(
          'private_lane_disabled',
          'private or direct-message payloads are disabled',
          this.status.value,
        );
      }
      const captureExtension = valueId(payload, ['extension']) ?? extension;
      const dataKey = valueId(payload, [
        'data_key',
        'dataKey',
        'tweet_id',
        'rest_id',
        'user_id',
        'id_str',
        'id',
      ]);
      if (!dataKey) continue;
      const rawType = valueId(payload, ['type', 'entity_type']);
      const kind: EntityKind =
        rawType === 'user' ? 'user' : rawType === 'tweet' ? 'tweet' : 'media_reference';
      const mutationWithoutHash: Omit<RelationshipUpsert, 'record_hash'> = {
        mutation_id: this.randomId('mutation'),
        client_seq: this.nextClientSequence + sequenceOffset + mutations.length,
        kind: 'relationship_upsert',
        schema_revision: SCHEMA_REVISION,
        relationship_kind: 'capture_membership',
        subject: this.endpoint(kind, dataKey),
        object: this.endpoint('folder', `capture:${captureExtension}`),
        qualifier: { extension: captureExtension },
        payload,
        provenance: this.provenance(`${operation}:${captureExtension}`, `${dataKey}:${index}`),
        observed_at_ms: this.now(),
      };
      mutations.push({
        ...mutationWithoutHash,
        record_hash: await recordHash(this.pairing!.namespace_id, mutationWithoutHash),
      });
    }
    return mutations;
  }

  private async membershipMutations(
    kind: 'tweet' | 'user',
    extension: string,
    operation: string,
    ids: string[],
  ): Promise<RelationshipUpsert[]> {
    const mutations: RelationshipUpsert[] = [];
    for (const [index, id] of ids.entries()) {
      const mutationWithoutHash: Omit<RelationshipUpsert, 'record_hash'> = {
        mutation_id: this.randomId('mutation'),
        client_seq: this.nextClientSequence + mutations.length,
        kind: 'relationship_upsert',
        schema_revision: SCHEMA_REVISION,
        relationship_kind: 'capture_membership',
        subject: this.endpoint(kind, id),
        object: this.endpoint('folder', `capture:${extension}`),
        qualifier: { extension },
        payload: { extension, data_key: id },
        provenance: this.provenance(operation, `${kind}:${extension}:${id}:${index}`),
        observed_at_ms: this.now(),
      };
      mutations.push({
        ...mutationWithoutHash,
        record_hash: await recordHash(this.pairing!.namespace_id, mutationWithoutHash),
      });
    }
    return mutations;
  }

  private async membershipTombstones(
    kind: 'tweet' | 'user',
    extension: string,
    operation: string,
    ids: string[],
  ): Promise<Tombstone[]> {
    const mutations: Tombstone[] = [];
    for (const [index, id] of ids.entries()) {
      const withoutHash: Omit<Tombstone, 'record_hash'> = {
        mutation_id: this.randomId('mutation'),
        client_seq: this.nextClientSequence + index,
        kind: 'tombstone',
        schema_revision: SCHEMA_REVISION,
        target_kind: 'relationship',
        target_id: `capture-membership:${kind}:${extension}:${id}`,
        relationship_kind: 'capture_membership',
        deletion_id: this.randomId('deletion'),
        provenance: this.provenance(operation, `${kind}:${extension}:${id}:${index}`),
        observed_at_ms: this.now(),
      };
      mutations.push({
        ...withoutHash,
        record_hash: await recordHash(this.pairing!.namespace_id, withoutHash),
      });
    }
    return mutations;
  }

  private endpoint(kind: EntityKind, id: string): Endpoint {
    return { namespace_id: this.pairing!.namespace_id, kind, id };
  }
}
