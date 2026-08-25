import Dexie, { type Table } from 'dexie';

import type { ArchiveDeltaRequest, Batch } from './contracts';

export const OUTBOX_DB_NAME = 'twitter-web-exporter-scrollmark-outbox-v1';
export const OUTBOX_SCHEMA_VERSION = 1;
export const OUTBOX_MAX_MUTATIONS = 50_000;
export const OUTBOX_MAX_BYTES = 512 * 1024 * 1024;
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_WARNING_RATIO = 0.8;

export type OutboxStatus = 'pending' | 'quarantined' | 'acknowledged';

export type OutboxRow = {
  batch_id: string;
  namespace_id: string;
  archive_id: string;
  client_id: string;
  client_epoch: string;
  client_sequence_from: number;
  client_sequence_to: number;
  mutation_count: number;
  canonical_bytes: number;
  request: ArchiveDeltaRequest;
  created_at_ms: number;
  last_attempt_at_ms: number | null;
  attempt_count: number;
  next_retry_at_ms: number;
  status: OutboxStatus;
  last_error_code: string | null;
  quarantine_id: string | null;
};

export type QuarantineRow = {
  quarantine_id: string;
  namespace_id: string | null;
  archive_id: string | null;
  client_id: string | null;
  client_epoch: string | null;
  batch_id: string | null;
  mutation_ids: string[];
  canonical_hashes: string[];
  operation: string;
  reason_code: string;
  observed_at_ms: number;
  evidence: Record<string, unknown>;
  disposition: 'noncanonical';
};

type MetadataRow = { key: string; value: unknown; updated_at_ms: number };

export type OutboxLimits = {
  max_mutations?: number;
  max_bytes?: number;
  max_age_ms?: number;
};

export type OutboxUsage = {
  pending_batches: number;
  pending_mutations: number;
  pending_bytes: number;
  quarantined_batches: number;
  quarantined_mutations: number;
  quarantined_bytes: number;
  oldest_age_ms: number | null;
  warning: boolean;
  stopped: boolean;
  stop_reason: string | null;
};

function emptyUsage(reason: string): OutboxUsage {
  return {
    pending_batches: 0,
    pending_mutations: 0,
    pending_bytes: 0,
    quarantined_batches: 0,
    quarantined_mutations: 0,
    quarantined_bytes: 0,
    oldest_age_ms: null,
    warning: false,
    stopped: true,
    stop_reason: reason,
  };
}

export class OutboxBoundError extends Error {
  readonly code = 'outbox_bound_exceeded';
  readonly dimension: 'mutations' | 'bytes' | 'age' | 'persistence';
  readonly usage: OutboxUsage;

  constructor(
    dimension: 'mutations' | 'bytes' | 'age' | 'persistence',
    message: string,
    usage: OutboxUsage,
  ) {
    super(message);
    this.name = 'OutboxBoundError';
    this.dimension = dimension;
    this.usage = usage;
  }
}

export class OutboxStore {
  private readonly db: Dexie;
  private readonly outbox: Table<OutboxRow>;
  private readonly quarantine: Table<QuarantineRow>;
  private readonly metadata: Table<MetadataRow>;
  private readonly limits: Required<OutboxLimits>;
  private readonly now: () => number;
  private ready: Promise<void>;

  constructor(options: { dbName?: string; limits?: OutboxLimits; now?: () => number } = {}) {
    this.db = new Dexie(options.dbName ?? OUTBOX_DB_NAME);
    this.limits = {
      max_mutations: options.limits?.max_mutations ?? OUTBOX_MAX_MUTATIONS,
      max_bytes: options.limits?.max_bytes ?? OUTBOX_MAX_BYTES,
      max_age_ms: options.limits?.max_age_ms ?? OUTBOX_MAX_AGE_MS,
    };
    this.now = options.now ?? (() => Date.now());
    this.db.version(OUTBOX_SCHEMA_VERSION).stores({
      outbox:
        'batch_id, namespace_id, archive_id, client_id, client_epoch, client_sequence_from, created_at_ms, next_retry_at_ms, status',
      quarantine: 'quarantine_id, namespace_id, archive_id, batch_id, observed_at_ms, disposition',
      metadata: 'key, updated_at_ms',
    });
    this.outbox = this.db.table<OutboxRow>('outbox');
    this.quarantine = this.db.table<QuarantineRow>('quarantine');
    this.metadata = this.db.table<MetadataRow>('metadata');
    this.ready = this.db.open().then(() => undefined);
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  async usage(): Promise<OutboxUsage> {
    await this.whenReady();
    const rows = await this.outbox.where('status').anyOf('pending', 'quarantined').toArray();
    const pending = rows.filter((row) => row.status === 'pending');
    const quarantined = rows.filter((row) => row.status === 'quarantined');
    const oldest = rows.reduce<number | null>(
      (current, row) =>
        current === null || row.created_at_ms < current ? row.created_at_ms : current,
      null,
    );
    const now = this.now();
    const pendingMutations = pending.reduce((sum, row) => sum + row.mutation_count, 0);
    const pendingBytes = pending.reduce((sum, row) => sum + row.canonical_bytes, 0);
    const quarantinedMutations = quarantined.reduce((sum, row) => sum + row.mutation_count, 0);
    const quarantinedBytes = quarantined.reduce((sum, row) => sum + row.canonical_bytes, 0);
    const totalMutations = pendingMutations + quarantinedMutations;
    const totalBytes = pendingBytes + quarantinedBytes;
    const oldestAge = oldest === null ? null : Math.max(0, now - oldest);
    const stopped = (await this.getMetadata<boolean>('stopped')) ?? false;
    const stopReason = (await this.getMetadata<string>('stop_reason')) ?? null;
    return {
      pending_batches: pending.length,
      pending_mutations: pendingMutations,
      pending_bytes: pendingBytes,
      quarantined_batches: quarantined.length,
      quarantined_mutations: quarantinedMutations,
      quarantined_bytes: quarantinedBytes,
      oldest_age_ms: oldestAge,
      warning:
        totalMutations >= this.limits.max_mutations * OUTBOX_WARNING_RATIO ||
        totalBytes >= this.limits.max_bytes * OUTBOX_WARNING_RATIO ||
        (oldestAge !== null && oldestAge >= this.limits.max_age_ms * OUTBOX_WARNING_RATIO),
      stopped,
      stop_reason: stopReason,
    };
  }

  async admit(request: ArchiveDeltaRequest, canonicalBytes: number): Promise<OutboxRow> {
    let usage: OutboxUsage;
    try {
      await this.whenReady();
      usage = await this.usage();
    } catch (error) {
      throw new OutboxBoundError(
        'persistence',
        `outbox persistence is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        emptyUsage('persistence'),
      );
    }
    const now = this.now();
    if (usage.stopped) {
      throw new OutboxBoundError('persistence', 'the outbox is stopped pending recovery', usage);
    }
    const existingAge = usage.oldest_age_ms;
    if (existingAge !== null && existingAge >= this.limits.max_age_ms) {
      await this.stop('age_bound');
      throw new OutboxBoundError(
        'age',
        'the oldest pending or quarantined item reached the age bound',
        usage,
      );
    }
    const totalMutations = usage.pending_mutations + usage.quarantined_mutations;
    const totalBytes = usage.pending_bytes + usage.quarantined_bytes;
    const mutationCount = request.batch.mutation_count;
    if (totalMutations + mutationCount > this.limits.max_mutations) {
      await this.stop('mutation_bound');
      throw new OutboxBoundError('mutations', 'the outbox mutation bound would be exceeded', usage);
    }
    if (totalBytes + canonicalBytes > this.limits.max_bytes) {
      await this.stop('byte_bound');
      throw new OutboxBoundError('bytes', 'the outbox byte bound would be exceeded', usage);
    }
    const row: OutboxRow = {
      batch_id: request.batch.batch_id,
      namespace_id: request.namespace_id,
      archive_id: request.archive_id,
      client_id: request.client_id,
      client_epoch: request.client_epoch,
      client_sequence_from: request.client_sequence.from,
      client_sequence_to: request.client_sequence.to,
      mutation_count: mutationCount,
      canonical_bytes: canonicalBytes,
      request,
      created_at_ms: now,
      last_attempt_at_ms: null,
      attempt_count: 0,
      next_retry_at_ms: now,
      status: 'pending',
      last_error_code: null,
      quarantine_id: null,
    };
    try {
      await this.db.transaction('rw', this.outbox, this.metadata, async () => {
        const existing = await this.outbox.get(row.batch_id);
        if (existing) return;
        await this.outbox.add(row);
      });
    } catch (error) {
      let current: OutboxUsage;
      try {
        current = await this.usage();
      } catch {
        current = emptyUsage('persistence');
      }
      try {
        await this.stop('persistence');
      } catch {
        // The typed error below is the durable signal when the database itself is unavailable.
      }
      throw new OutboxBoundError(
        'persistence',
        `outbox persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        current,
      );
    }
    return row;
  }

  async listPending(now = this.now()): Promise<OutboxRow[]> {
    await this.whenReady();
    return this.outbox
      .where('status')
      .equals('pending')
      .filter((row) => row.next_retry_at_ms <= now)
      .sortBy('client_sequence_from');
  }

  async listAllPending(): Promise<OutboxRow[]> {
    await this.whenReady();
    return this.outbox.where('status').equals('pending').sortBy('client_sequence_from');
  }

  async markAttempt(
    batchId: string,
    args: { nextRetryAtMs: number; errorCode: string | null; attemptedAtMs?: number } = {
      nextRetryAtMs: this.now(),
      errorCode: null,
    },
  ): Promise<void> {
    await this.whenReady();
    const row = await this.outbox.get(batchId);
    if (!row || row.status !== 'pending') return;
    await this.outbox.update(batchId, {
      last_attempt_at_ms: args.attemptedAtMs ?? this.now(),
      attempt_count: row.attempt_count + 1,
      next_retry_at_ms: args.nextRetryAtMs,
      last_error_code: args.errorCode,
    });
  }

  async acknowledge(batchId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.whenReady();
    await this.db.transaction('rw', this.outbox, this.metadata, async () => {
      for (const [key, value] of Object.entries(metadata)) {
        await this.metadata.put({ key, value, updated_at_ms: this.now() });
      }
      await this.outbox.delete(batchId);
    });
  }

  async quarantinePending(
    batchId: string,
    args: {
      quarantineId: string;
      operation: string;
      reasonCode: string;
      evidence?: Record<string, unknown>;
      observedAtMs?: number;
    },
  ): Promise<QuarantineRow | null> {
    await this.whenReady();
    const row = await this.outbox.get(batchId);
    if (!row) return null;
    const quarantine: QuarantineRow = {
      quarantine_id: args.quarantineId,
      namespace_id: row.namespace_id,
      archive_id: row.archive_id,
      client_id: row.client_id,
      client_epoch: row.client_epoch,
      batch_id: row.batch_id,
      mutation_ids: row.request.batch.mutations.map((mutation) => mutation.mutation_id),
      canonical_hashes: row.request.batch.mutations.map((mutation) => mutation.record_hash),
      operation: args.operation,
      reason_code: args.reasonCode,
      observed_at_ms: args.observedAtMs ?? this.now(),
      evidence: args.evidence ?? {},
      disposition: 'noncanonical',
    };
    await this.db.transaction('rw', this.outbox, this.quarantine, async () => {
      await this.quarantine.put(quarantine);
      await this.outbox.update(batchId, {
        status: 'quarantined',
        quarantine_id: quarantine.quarantine_id,
        last_error_code: args.reasonCode,
        next_retry_at_ms: Number.MAX_SAFE_INTEGER,
      });
    });
    return quarantine;
  }

  async listQuarantine(): Promise<QuarantineRow[]> {
    await this.whenReady();
    return this.quarantine.orderBy('observed_at_ms').toArray();
  }

  async getMetadata<T>(key: string): Promise<T | null> {
    await this.whenReady();
    const row = await this.metadata.get(key);
    return row ? (row.value as T) : null;
  }

  async setMetadata(key: string, value: unknown): Promise<void> {
    await this.whenReady();
    await this.metadata.put({ key, value, updated_at_ms: this.now() });
  }

  async stop(reason: string): Promise<void> {
    await this.setMetadata('stopped', true);
    await this.setMetadata('stop_reason', reason);
  }

  async clearStop(): Promise<void> {
    await this.setMetadata('stopped', false);
    await this.setMetadata('stop_reason', null);
  }

  async close(): Promise<void> {
    await this.whenReady();
    this.db.close();
  }

  async deleteDatabase(): Promise<void> {
    this.db.close();
    await Dexie.delete(this.db.name);
  }
}

export function batchCanonicalByteLength(batch: Batch): number {
  return new TextEncoder().encode(JSON.stringify(batch)).byteLength;
}
