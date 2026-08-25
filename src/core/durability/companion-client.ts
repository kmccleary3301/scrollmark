import {
  canonicalize,
  isHash,
  type ReconciliationPage,
  SCROLLMARK_PROTOCOL,
  type ArchiveDeltaRequest,
  type Capabilities,
  chainHash,
  isCheckpoint,
  isCommitReceipt,
  type Checkpoint,
  type CommitReceipt,
  type Health,
  type ReconciliationDescriptor,
  type ReconciliationRequest,
  type SequenceRange,
} from './contracts';
import type { PairingContext } from './identity';
const RECOVERY_TIMEOUT_MS = 120_000;

export type CompanionErrorCode =
  | 'protocol_version_unsupported'
  | 'auth_required'
  | 'origin_denied'
  | 'archive_binding_mismatch'
  | 'namespace_not_active'
  | 'identity_required'
  | 'client_epoch_unknown'
  | 'client_sequence_gap'
  | 'batch_hash_mismatch'
  | 'mutation_hash_conflict'
  | 'validation_failed'
  | 'checkpoint_mismatch'
  | 'checkpoint_expired'
  | 'stream_expired'
  | 'limit_exceeded'
  | 'snapshot_corrupt'
  | 'snapshot_incompatible'
  | 'snapshot_key_unavailable'
  | 'snapshot_rotation_failed'
  | 'restore_failed'
  | 'destroy_guard_failed'
  | 'companion_busy'
  | 'companion_unavailable'
  | 'internal_commit_unknown'
  | 'malformed_response';

export class CompanionClientError extends Error {
  readonly code: CompanionErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly observed: unknown;

  constructor(
    code: CompanionErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number | null;
      status?: number | null;
      requestId?: string | null;
      observed?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'CompanionClientError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.observed = options.observed;
  }
}

export type CompanionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CompanionClientLike = {
  capabilities(): Promise<Capabilities>;
  health(): Promise<Health>;
  checkpoint(namespaceId: string): Promise<Checkpoint>;
  commit(request: ArchiveDeltaRequest): Promise<CommitReceipt>;
  reconcile(request: ReconciliationRequest): Promise<ReconciliationDescriptor>;
  reconciliationPage(streamId: string, cursor?: string): Promise<ReconciliationPage>;
};

export type SnapshotNamespaceProof = {
  namespace_id: string;
  identity_fingerprint: string;
  checkpoint_seq: number;
  checkpoint_chain_hash: string;
  journal_first_seq: number;
  journal_last_seq: number;
};

export type VerifiedSnapshotSummary = {
  format: 'twe.snapshot.v1';
  snapshot_id: string;
  archive_id: string;
  created_at_ms: number;
  verified_at_ms: number;
  namespaces: SnapshotNamespaceProof[];
  image: { path: string; bytes: number; sha256: string; mode: 'plaintext' | 'aes-256-gcm' };
  encryption: {
    mode: 'plaintext' | 'aes-256-gcm';
    algorithm: string | null;
    key_id: string | null;
  };
  verification: {
    state: 'verified';
    verifier_version: string;
    checks: string[];
    failures: unknown[];
  };
  manifest_payload_hash: string;
};

export type DestroyPreflightRequest = {
  archive_id: string;
  namespace_ids: string[];
  migration_active: false;
  pending_count: number;
  pending_acknowledged: boolean;
  explicit_loss_acknowledgement: boolean;
};

export type DestroyChallenge = {
  challenge_id: string;
  archive_id: string;
  namespace_ids: string[];
  namespace_disclosures: Array<{ namespace_id: string; identity_fingerprint: string }>;
  required_phrase: string;
  pending_count: number;
  recent_verified_snapshot: boolean;
  expires_at_ms: number;
  second_confirmation_required: true;
};

export type RecoveryCompanionClientLike = CompanionClientLike & {
  listSnapshots(): Promise<VerifiedSnapshotSummary[]>;
  createSnapshot(encrypted?: boolean): Promise<VerifiedSnapshotSummary>;
  verifySnapshot(
    snapshotId: string,
  ): Promise<{ snapshot_id: string; manifest_payload_hash: string }>;
  restoreSnapshot(
    snapshotId: string,
  ): Promise<{ snapshot_id: string; state: 'restored'; checkpoints: Record<string, Checkpoint> }>;
  rotateSnapshots(options?: {
    hourly?: number;
    daily?: number;
    monthly?: number;
    dryRun?: boolean;
  }): Promise<unknown>;
  destroyPreflight(request: DestroyPreflightRequest): Promise<DestroyChallenge>;
  destroyConfirm(
    challenge: DestroyChallenge,
    phrase: string,
  ): Promise<{ state: 'destroyed'; audit_id: string }>;
};

const RETRYABLE_CODES = new Set<CompanionErrorCode>([
  'companion_busy',
  'companion_unavailable',
  'internal_commit_unknown',
]);

function protocolMatches(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const protocol = value as Record<string, unknown>;
  return (
    protocol.major === SCROLLMARK_PROTOCOL.major && protocol.minor === SCROLLMARK_PROTOCOL.minor
  );
}

function asErrorCode(value: unknown): CompanionErrorCode {
  const known: CompanionErrorCode[] = [
    'protocol_version_unsupported',
    'auth_required',
    'origin_denied',
    'archive_binding_mismatch',
    'namespace_not_active',
    'identity_required',
    'client_epoch_unknown',
    'client_sequence_gap',
    'batch_hash_mismatch',
    'mutation_hash_conflict',
    'validation_failed',
    'checkpoint_mismatch',
    'checkpoint_expired',
    'stream_expired',
    'limit_exceeded',
    'snapshot_corrupt',
    'snapshot_incompatible',
    'snapshot_key_unavailable',
    'snapshot_rotation_failed',
    'restore_failed',
    'destroy_guard_failed',
    'companion_busy',
    'companion_unavailable',
    'internal_commit_unknown',
  ];
  return typeof value === 'string' && known.includes(value as CompanionErrorCode)
    ? (value as CompanionErrorCode)
    : 'malformed_response';
}

function isAllowedOrigin(origin: string): boolean {
  return (
    origin === 'https://x.com' ||
    origin === 'https://twitter.com' ||
    origin === 'https://mobile.x.com'
  );
}

function boundedUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function responseRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const requestId = (value as Record<string, unknown>).request_id;
  return typeof requestId === 'string' ? requestId : null;
}

export class CompanionClient implements CompanionClientLike {
  private readonly pairing: PairingContext;
  private readonly fetchImpl: CompanionFetch;
  private readonly timeoutMs: number;

  constructor(
    pairing: PairingContext,
    options: { fetchImpl?: CompanionFetch; timeoutMs?: number; origin?: string } = {},
  ) {
    this.pairing = pairing;
    const globalFetch = globalThis.fetch;
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    } else if (typeof globalFetch === 'function') {
      this.fetchImpl = (input, init) => globalFetch.call(globalThis, input, init);
    } else {
      throw new CompanionClientError('companion_unavailable', 'fetch is unavailable');
    }
    this.timeoutMs = Math.max(1000, Math.min(120_000, options.timeoutMs ?? 15_000));
    const origin = options.origin ?? pairing.origin ?? this.readOrigin();
    if (!isAllowedOrigin(origin)) {
      throw new CompanionClientError(
        'origin_denied',
        'the browser origin is not admitted by the companion pairing',
      );
    }
  }

  async capabilities(): Promise<Capabilities> {
    const value = await this.requestJson('/v1/capabilities', { method: 'GET' });
    if (!value || typeof value !== 'object')
      throw this.malformed('capabilities response is not an object', value);
    const capabilities = value as Record<string, unknown>;
    if (
      !Array.isArray(capabilities.protocol_versions) ||
      !Array.isArray(capabilities.schema_revisions) ||
      capabilities.hash_algorithm !== 'sha256-jcs-hex' ||
      typeof capabilities.capability_revision !== 'string' ||
      !capabilities.limits ||
      typeof capabilities.limits !== 'object' ||
      !capabilities.features ||
      typeof capabilities.features !== 'object'
    ) {
      throw this.malformed('capabilities response is incomplete', value);
    }
    const protocolVersions = capabilities.protocol_versions.filter(
      (item): item is { major: number; minor: number } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).major === 'number' &&
        typeof (item as Record<string, unknown>).minor === 'number',
    );
    const schemaRevisions = capabilities.schema_revisions.filter(
      (item): item is number => typeof item === 'number' && Number.isInteger(item),
    );
    if (
      !protocolVersions.some((item) => item.major === 1 && item.minor === 0) ||
      !schemaRevisions.includes(1)
    ) {
      throw new CompanionClientError(
        'protocol_version_unsupported',
        'the companion does not advertise Scrollmark protocol 1.0/schema 1',
      );
    }
    return {
      protocol_versions: protocolVersions,
      schema_revisions: schemaRevisions,
      hash_algorithm: 'sha256-jcs-hex',
      capability_revision: capabilities.capability_revision,
      limits: capabilities.limits as Record<string, number>,
      features: capabilities.features as Record<string, boolean>,
    };
  }

  async health(): Promise<Health> {
    const value = await this.requestJson('/v1/health', { method: 'GET' });
    if (!value || typeof value !== 'object')
      throw this.malformed('health response is not an object', value);
    const health = value as Record<string, unknown>;
    if (!protocolMatches(health.protocol)) {
      throw new CompanionClientError(
        'protocol_version_unsupported',
        'health protocol is unsupported',
      );
    }
    const archive = health.archive;
    if (!archive || typeof archive !== 'object') {
      throw this.malformed('health archive proof is missing', value);
    }
    const archiveRecord = archive as Record<string, unknown>;
    if (archiveRecord.archive_id !== this.pairing.archive_id) {
      throw new CompanionClientError(
        'archive_binding_mismatch',
        'health archive does not match pairing',
      );
    }
    const activeNamespaces = health.active_namespace_ids;
    if (!Array.isArray(activeNamespaces) || !activeNamespaces.includes(this.pairing.namespace_id)) {
      throw new CompanionClientError('namespace_not_active', 'paired namespace is not active');
    }
    return health as Health;
  }

  async checkpoint(namespaceId: string): Promise<Checkpoint> {
    if (namespaceId !== this.pairing.namespace_id) {
      throw new CompanionClientError(
        'archive_binding_mismatch',
        'checkpoint namespace differs from pairing',
      );
    }
    const value = await this.requestJson(
      `/v1/archive/namespaces/${encodeURIComponent(namespaceId)}/checkpoint`,
      {
        method: 'GET',
      },
    );
    if (!value || typeof value !== 'object')
      throw this.malformed('checkpoint response is not an object', value);
    const response = value as Record<string, unknown>;
    if (response.archive_id !== this.pairing.archive_id || response.namespace_id !== namespaceId) {
      throw new CompanionClientError(
        'archive_binding_mismatch',
        'checkpoint binding does not match pairing',
        {
          observed: value,
        },
      );
    }
    if (!isCheckpoint(response.checkpoint))
      throw this.malformed('checkpoint proof is invalid', value);
    if (response.checkpoint.namespace_id !== namespaceId) {
      throw new CompanionClientError(
        'archive_binding_mismatch',
        'checkpoint proof namespace differs from request',
        { observed: value },
      );
    }
    return response.checkpoint;
  }

  async commit(request: ArchiveDeltaRequest): Promise<CommitReceipt> {
    this.assertRequestBinding(request);
    const value = await this.requestJson('/v1/archive/deltas', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!isCommitReceipt(value))
      throw this.malformed('commit response is not a proof receipt', value);
    if (value.archive_id !== request.archive_id || value.namespace_id !== request.namespace_id) {
      throw new CompanionClientError(
        'archive_binding_mismatch',
        'receipt archive or namespace differs from request',
        {
          observed: value,
        },
      );
    }
    if (
      value.request_id !== request.request_id ||
      value.client_id !== request.client_id ||
      value.client_epoch !== request.client_epoch ||
      value.batch_id !== request.batch.batch_id ||
      (value.result !== 'committed' && value.result !== 'duplicate') ||
      !sameRange(value.client_sequence, request.client_sequence) ||
      value.mutation_count !== request.batch.mutation_count ||
      value.batch_hash !== request.batch.batch_hash ||
      value.checkpoint.namespace_id !== request.namespace_id ||
      value.checkpoint.archive_seq !== value.archive_sequence.to ||
      value.checkpoint.chain_hash !== value.chain_hash
    ) {
      throw new CompanionClientError(
        'validation_failed',
        'commit receipt does not bind to the immutable request',
        {
          observed: value,
        },
      );
    }
    // A queued immutable request can carry an older known checkpoint while an
    // earlier FIFO row commits first. The receipt's own prior hash is the
    // authoritative chain link; verify that link instead of rewriting the row.
    const expectedChain = await chainHash(
      request.namespace_id,
      value.prior_chain_hash,
      request.batch.batch_hash,
      value.archive_sequence.from,
      value.archive_sequence.to,
    );
    if (expectedChain !== value.chain_hash) {
      throw new CompanionClientError('validation_failed', 'receipt chain hash is invalid', {
        observed: value,
      });
    }
    return value;
  }

  async reconcile(request: ReconciliationRequest): Promise<ReconciliationDescriptor> {
    this.assertRequestBinding(request);
    const value = await this.requestJson(
      `/v1/archive/namespaces/${encodeURIComponent(request.namespace_id)}/reconciliation`,
      { method: 'POST', body: JSON.stringify(request) },
    );
    if (!value || typeof value !== 'object')
      throw this.malformed('reconciliation response is not an object', value);
    const descriptor = value as Record<string, unknown>;
    if (
      descriptor.namespace_id !== request.namespace_id ||
      typeof descriptor.stream_id !== 'string' ||
      !isCheckpoint(descriptor.source_checkpoint) ||
      !isCheckpoint(descriptor.target_checkpoint) ||
      typeof descriptor.manifest_hash !== 'string'
    ) {
      throw this.malformed('reconciliation descriptor is not bound to the request', value);
    }
    return descriptor as unknown as ReconciliationDescriptor;
  }

  async reconciliationPage(streamId: string, cursor?: string): Promise<ReconciliationPage> {
    const normalizedStreamId = streamId.trim();
    if (!normalizedStreamId) {
      throw new CompanionClientError('validation_failed', 'reconciliation stream id is required');
    }
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const value = await this.requestJson(
      `/v1/archive/reconciliation/${encodeURIComponent(normalizedStreamId)}/pages${query}`,
      { method: 'GET' },
    );
    if (!value || typeof value !== 'object') {
      throw this.malformed('reconciliation page response is not an object', value);
    }
    const page = value as Record<string, unknown>;
    if (
      !protocolMatches(page.protocol) ||
      page.stream_id !== normalizedStreamId ||
      page.namespace_id !== this.pairing.namespace_id ||
      (page.mode !== 'deltas' && page.mode !== 'state_bootstrap') ||
      !Number.isInteger(page.page_index) ||
      !Number.isInteger(page.item_count) ||
      !Number.isInteger(page.byte_count) ||
      !Array.isArray(page.items) ||
      !isHash(page.page_hash) ||
      !isCheckpoint(page.target_checkpoint) ||
      page.target_checkpoint.namespace_id !== this.pairing.namespace_id ||
      !isHash(page.manifest_hash) ||
      typeof page.final !== 'boolean' ||
      (page.next_cursor !== undefined && typeof page.next_cursor !== 'string')
    ) {
      throw this.malformed('reconciliation page proof is invalid', value);
    }
    return page as unknown as ReconciliationPage;
  }

  async listSnapshots(): Promise<VerifiedSnapshotSummary[]> {
    const response = this.recoveryResponse(
      await this.requestJson('/v1/snapshots', { method: 'GET' }),
      'snapshot list',
    );
    if (!Array.isArray(response.snapshots)) {
      throw this.malformed('snapshot list is missing', response);
    }
    return response.snapshots.map((value) => this.snapshotSummary(value));
  }

  async createSnapshot(encrypted = false): Promise<VerifiedSnapshotSummary> {
    const response = this.recoveryResponse(
      await this.requestJson(
        '/v1/snapshots',
        {
          method: 'POST',
          body: JSON.stringify({ request_id: randomId('snapshot'), encrypted }),
        },
        RECOVERY_TIMEOUT_MS,
      ),
      'snapshot creation',
    );
    return this.snapshotSummary(response.snapshot);
  }

  async verifySnapshot(
    snapshotId: string,
  ): Promise<{ snapshot_id: string; manifest_payload_hash: string }> {
    const response = this.recoveryResponse(
      await this.requestJson(
        `/v1/snapshots/${encodeURIComponent(snapshotId)}/verify`,
        {
          method: 'POST',
          body: JSON.stringify({
            request_id: randomId('snapshot-verify'),
            namespace_ids: [this.pairing.namespace_id],
          }),
        },
        RECOVERY_TIMEOUT_MS,
      ),
      'snapshot verification',
    );
    if (response.snapshot_id !== snapshotId || !isHash(response.manifest_payload_hash)) {
      throw this.malformed('snapshot verification proof is invalid', response);
    }
    return response as { snapshot_id: string; manifest_payload_hash: string };
  }

  async restoreSnapshot(
    snapshotId: string,
  ): Promise<{ snapshot_id: string; state: 'restored'; checkpoints: Record<string, Checkpoint> }> {
    const response = this.recoveryResponse(
      await this.requestJson(
        `/v1/snapshots/${encodeURIComponent(snapshotId)}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({
            request_id: randomId('snapshot-restore'),
            namespace_ids: [this.pairing.namespace_id],
          }),
        },
        RECOVERY_TIMEOUT_MS,
      ),
      'snapshot restore',
    );
    const checkpoints = response.checkpoints;
    if (
      response.snapshot_id !== snapshotId ||
      response.state !== 'restored' ||
      !checkpoints ||
      typeof checkpoints !== 'object' ||
      !isCheckpoint((checkpoints as Record<string, unknown>)[this.pairing.namespace_id])
    ) {
      throw this.malformed('snapshot restore proof is invalid', response);
    }
    return response as {
      snapshot_id: string;
      state: 'restored';
      checkpoints: Record<string, Checkpoint>;
    };
  }

  async rotateSnapshots(
    options: { hourly?: number; daily?: number; monthly?: number; dryRun?: boolean } = {},
  ): Promise<unknown> {
    const response = this.recoveryResponse(
      await this.requestJson(
        '/v1/snapshots/rotation',
        {
          method: 'POST',
          body: JSON.stringify({
            request_id: randomId('snapshot-rotation'),
            hourly: options.hourly ?? 24,
            daily: options.daily ?? 30,
            monthly: options.monthly ?? 12,
            dry_run: options.dryRun === true,
          }),
        },
        RECOVERY_TIMEOUT_MS,
      ),
      'snapshot rotation',
    );
    return response.rotation;
  }

  async destroyPreflight(request: DestroyPreflightRequest): Promise<DestroyChallenge> {
    const requestedNamespaces = [...new Set(request.namespace_ids)].sort();
    if (
      request.archive_id !== this.pairing.archive_id ||
      requestedNamespaces.length !== request.namespace_ids.length ||
      !requestedNamespaces.includes(this.pairing.namespace_id)
    ) {
      throw new CompanionClientError(
        'archive_binding_mismatch',
        'durable destroy disclosure differs from pairing',
      );
    }
    const response = this.recoveryResponse(
      await this.requestJson('/v1/archive/destroy/preflight', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
      'durable destroy preflight',
    );
    const responseNamespaces = Array.isArray(response.namespace_ids)
      ? response.namespace_ids.filter((value): value is string => typeof value === 'string').sort()
      : [];
    const disclosures = response.namespace_disclosures;
    if (
      typeof response.challenge_id !== 'string' ||
      response.archive_id !== this.pairing.archive_id ||
      canonicalize(responseNamespaces) !== canonicalize(requestedNamespaces) ||
      !Array.isArray(disclosures) ||
      disclosures.length !== requestedNamespaces.length ||
      !disclosures.every(
        (value) =>
          !!value &&
          typeof value === 'object' &&
          requestedNamespaces.includes(String((value as Record<string, unknown>).namespace_id)) &&
          typeof (value as Record<string, unknown>).identity_fingerprint === 'string',
      ) ||
      typeof response.required_phrase !== 'string' ||
      response.second_confirmation_required !== true
    ) {
      throw this.malformed('durable destroy challenge is invalid', response);
    }
    return response as unknown as DestroyChallenge;
  }

  async destroyConfirm(
    challenge: DestroyChallenge,
    phrase: string,
  ): Promise<{ state: 'destroyed'; audit_id: string }> {
    const response = this.recoveryResponse(
      await this.requestJson(
        '/v1/archive/destroy/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            challenge_id: challenge.challenge_id,
            archive_id: this.pairing.archive_id,
            phrase,
            second_confirmation: true,
          }),
        },
        RECOVERY_TIMEOUT_MS,
      ),
      'durable destroy confirmation',
    );
    if (response.state !== 'destroyed' || typeof response.audit_id !== 'string') {
      throw this.malformed('durable destroy receipt is invalid', response);
    }
    return response as { state: 'destroyed'; audit_id: string };
  }

  private recoveryResponse(value: unknown, operation: string): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
      throw this.malformed(`${operation} response is not an object`, value);
    }
    const response = value as Record<string, unknown>;
    if (!protocolMatches(response.protocol)) {
      throw new CompanionClientError(
        'protocol_version_unsupported',
        `${operation} protocol is unsupported`,
      );
    }
    if (response.archive_id !== this.pairing.archive_id) {
      throw new CompanionClientError(
        'archive_binding_mismatch',
        `${operation} archive differs from pairing`,
      );
    }
    return response;
  }

  private snapshotSummary(value: unknown): VerifiedSnapshotSummary {
    if (!value || typeof value !== 'object') {
      throw this.malformed('snapshot summary is not an object', value);
    }
    const snapshot = value as Record<string, unknown>;
    const image = snapshot.image as Record<string, unknown> | undefined;
    const verification = snapshot.verification as Record<string, unknown> | undefined;
    if (
      snapshot.format !== 'twe.snapshot.v1' ||
      typeof snapshot.snapshot_id !== 'string' ||
      snapshot.archive_id !== this.pairing.archive_id ||
      !Number.isFinite(snapshot.created_at_ms) ||
      !Number.isFinite(snapshot.verified_at_ms) ||
      !Array.isArray(snapshot.namespaces) ||
      !snapshot.namespaces.some(
        (namespace) =>
          !!namespace &&
          typeof namespace === 'object' &&
          (namespace as Record<string, unknown>).namespace_id === this.pairing.namespace_id,
      ) ||
      !image ||
      typeof image.bytes !== 'number' ||
      !isHash(image.sha256) ||
      !verification ||
      verification.state !== 'verified' ||
      !isHash(snapshot.manifest_payload_hash)
    ) {
      throw this.malformed('snapshot summary proof is invalid', value);
    }
    return snapshot as unknown as VerifiedSnapshotSummary;
  }

  private assertRequestBinding(
    request: Pick<
      ArchiveDeltaRequest,
      'archive_id' | 'namespace_id' | 'client_id' | 'client_epoch'
    >,
  ): void {
    if (
      request.archive_id !== this.pairing.archive_id ||
      request.namespace_id !== this.pairing.namespace_id ||
      request.client_id !== this.pairing.client_id ||
      request.client_epoch !== this.pairing.client_epoch
    ) {
      throw new CompanionClientError(
        'archive_binding_mismatch',
        'request binding differs from pairing',
      );
    }
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${this.pairing.token}`);
    headers.set('X-Scrollmark-Protocol', 'v1');
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    try {
      const response = await this.fetchImpl(boundedUrl(this.pairing.base_url, path), {
        ...init,
        headers,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      const text = await response.text();
      let value: unknown = null;
      try {
        value = text ? JSON.parse(text) : null;
      } catch {
        throw this.malformed('companion response is not JSON', text.slice(0, 256), response.status);
      }
      if (!response.ok) {
        throw this.errorFromResponse(response.status, value);
      }
      return value;
    } catch (error) {
      if (error instanceof CompanionClientError) throw error;
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      throw new CompanionClientError(
        'companion_unavailable',
        aborted ? 'companion request timed out' : 'companion request failed',
        {
          retryable: true,
          status: null,
          observed: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private errorFromResponse(status: number, value: unknown): CompanionClientError {
    const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const code = asErrorCode(source.code);
    return new CompanionClientError(
      code,
      typeof source.message === 'string' ? source.message : `companion request failed (${status})`,
      {
        retryable: source.retryable === true || RETRYABLE_CODES.has(code),
        retryAfterMs: typeof source.retry_after_ms === 'number' ? source.retry_after_ms : null,
        status,
        requestId: responseRequestId(value),
        observed: value,
      },
    );
  }

  private malformed(
    message: string,
    observed: unknown,
    status: number | null = null,
  ): CompanionClientError {
    return new CompanionClientError('malformed_response', message, { status, observed });
  }

  private readOrigin(): string {
    const origin = (globalThis as unknown as { location?: Location }).location?.origin;
    return typeof origin === 'string' && origin ? origin : 'https://x.com';
  }
}

function sameRange(left: SequenceRange, right: SequenceRange): boolean {
  return left.from === right.from && left.to === right.to;
}

export function randomId(prefix = 'id'): string {
  const cryptoObject = (globalThis as unknown as { crypto?: Crypto }).crypto;
  const uuid = cryptoObject?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
