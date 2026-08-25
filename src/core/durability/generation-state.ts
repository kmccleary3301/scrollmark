import type { Checkpoint } from './contracts';

export const GENERATION_POINTER_KEY = '__twe_generation_pointer_v1';
export const GENERATION_JOURNAL_KEY = '__twe_generation_journal_v1';
export const ACTIVE_DB_NAME_KEY = '__twe_active_db_name_v1';
export const CONTINUITY_LOCAL_FALLBACK_FLAG = '__twe_allow_continuity_local_fallback_v1';
export const GENERATION_STATE_SCHEMA_VERSION = 1 as const;

export type GenerationCounts = {
  captures: number;
  tweets: number;
  users: number;
  social_edges: number;
  search_documents: number;
  total: number;
};

export type ActiveGenerationPointer = {
  schema_version: typeof GENERATION_STATE_SCHEMA_VERSION;
  state: 'active';
  verification: 'verified';
  protocol_version: { major: number; minor: number };
  archive_schema_revision: number;
  browser_generation_revision: number;
  generation_id: string;
  database_name: string;
  previous_database_name: string | null;
  archive_id: string;
  namespace_id: string;
  target_checkpoint: Checkpoint;
  manifest_hash: string;
  projection_hash: string;
  item_count: number;
  page_count: number;
  counts: GenerationCounts;
  verified_at_ms: number;
  activated_at_ms: number;
};

export type GenerationJournal = {
  schema_version: typeof GENERATION_STATE_SCHEMA_VERSION;
  state: 'staging' | 'failed';
  generation_id: string;
  database_name: string;
  previous_database_name: string | null;
  archive_id: string;
  namespace_id: string;
  started_at_ms: number;
  updated_at_ms: number;
  error?: string;
};

type Storage = {
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => void;
  remove: (key: string) => void;
};

const globalScope = globalThis as unknown as Record<string, unknown>;

function storage(): Storage | null {
  const getValue = globalScope.GM_getValue;
  const setValue = globalScope.GM_setValue;
  const deleteValue = globalScope.GM_deleteValue;
  if (typeof getValue === 'function' && typeof setValue === 'function') {
    return {
      read: (key) => (getValue as (name: string) => unknown)(key),
      write: (key, value) => (setValue as (name: string, next: unknown) => void)(key, value),
      remove: (key) => {
        if (typeof deleteValue === 'function') {
          (deleteValue as (name: string) => void)(key);
        } else {
          (setValue as (name: string, next: unknown) => void)(key, undefined);
        }
      },
    };
  }

  if (globalScope[CONTINUITY_LOCAL_FALLBACK_FLAG] !== true) return null;
  const local = globalScope.localStorage as
    | {
        getItem?: (key: string) => string | null;
        setItem?: (key: string, value: string) => void;
        removeItem?: (key: string) => void;
      }
    | undefined;
  if (!local?.getItem || !local.setItem) return null;
  return {
    read: (key) => {
      const raw = local.getItem?.(key);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    write: (key, value) => local.setItem?.(key, JSON.stringify(value)),
    remove: (key) => local.removeItem?.(key),
  };
}

function readRecord<T>(key: string): T | null {
  try {
    const value = storage()?.read(key);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

function validCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Record<string, unknown>;
  return (
    typeof checkpoint.namespace_id === 'string' &&
    Number.isInteger(checkpoint.archive_seq) &&
    Number(checkpoint.archive_seq) >= 0 &&
    typeof checkpoint.chain_hash === 'string' &&
    /^[0-9a-f]{64}$/.test(checkpoint.chain_hash) &&
    checkpoint.schema_revision === 1
  );
}

function validCounts(value: unknown): value is GenerationCounts {
  if (!value || typeof value !== 'object') return false;
  const counts = value as Record<string, unknown>;
  return ['captures', 'tweets', 'users', 'social_edges', 'search_documents', 'total'].every(
    (key) => Number.isInteger(counts[key]) && Number(counts[key]) >= 0,
  );
}

export function readActiveGenerationPointer(): ActiveGenerationPointer | null {
  const value = readRecord<Partial<ActiveGenerationPointer>>(GENERATION_POINTER_KEY);
  if (
    !value ||
    value.schema_version !== GENERATION_STATE_SCHEMA_VERSION ||
    value.state !== 'active' ||
    value.verification !== 'verified' ||
    !value.protocol_version ||
    value.protocol_version.major !== 1 ||
    value.protocol_version.minor !== 0 ||
    value.archive_schema_revision !== 1 ||
    value.browser_generation_revision !== 1 ||
    typeof value.generation_id !== 'string' ||
    typeof value.database_name !== 'string' ||
    !value.database_name.trim() ||
    typeof value.archive_id !== 'string' ||
    !value.archive_id.trim() ||
    typeof value.namespace_id !== 'string' ||
    !value.namespace_id.trim() ||
    !validCheckpoint(value.target_checkpoint) ||
    value.target_checkpoint.namespace_id !== value.namespace_id ||
    typeof value.manifest_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.manifest_hash) ||
    typeof value.projection_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.projection_hash) ||
    !Number.isInteger(value.item_count) ||
    Number(value.item_count) < 0 ||
    !Number.isInteger(value.page_count) ||
    Number(value.page_count) < 1 ||
    !validCounts(value.counts) ||
    !Number.isFinite(value.verified_at_ms) ||
    !Number.isFinite(value.activated_at_ms)
  ) {
    return null;
  }
  return value as ActiveGenerationPointer;
}

export function readBoundActiveGenerationPointer(
  archiveId: string,
  namespaceId: string,
): ActiveGenerationPointer | null {
  const pointer = readActiveGenerationPointer();
  return pointer && pointer.archive_id === archiveId && pointer.namespace_id === namespaceId
    ? pointer
    : null;
}

export function writeActiveGenerationPointer(pointer: ActiveGenerationPointer): void {
  const target = storage();
  if (!target) throw new Error('durability storage is unavailable');
  target.write(GENERATION_POINTER_KEY, pointer);
}

export function readGenerationJournal(): GenerationJournal | null {
  const value = readRecord<Partial<GenerationJournal>>(GENERATION_JOURNAL_KEY);
  if (
    !value ||
    value.schema_version !== GENERATION_STATE_SCHEMA_VERSION ||
    (value.state !== 'staging' && value.state !== 'failed') ||
    typeof value.generation_id !== 'string' ||
    typeof value.database_name !== 'string' ||
    !value.database_name.trim() ||
    typeof value.archive_id !== 'string' ||
    typeof value.namespace_id !== 'string' ||
    !Number.isFinite(value.started_at_ms) ||
    !Number.isFinite(value.updated_at_ms)
  ) {
    return null;
  }
  return value as GenerationJournal;
}

export function writeGenerationJournal(journal: GenerationJournal): void {
  const target = storage();
  if (!target) throw new Error('durability storage is unavailable');
  target.write(GENERATION_JOURNAL_KEY, journal);
}

export function clearGenerationJournal(): void {
  storage()?.remove(GENERATION_JOURNAL_KEY);
}

export function readActiveGenerationDatabaseName(): string | null {
  return readActiveGenerationPointer()?.database_name ?? null;
}

export function publishActiveDatabaseName(databaseName: string): void {
  const normalized = databaseName.trim();
  if (!normalized) return;
  try {
    globalScope[ACTIVE_DB_NAME_KEY] = normalized;
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>)[ACTIVE_DB_NAME_KEY] = normalized;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ACTIVE_DB_NAME_KEY, normalized);
    }
  } catch {
    // The userscript storage pointer remains authoritative.
  }
}

export function randomGenerationId(): string {
  try {
    const randomUUID = (globalScope.crypto as Crypto | undefined)?.randomUUID;
    if (typeof randomUUID === 'function') return `generation-${randomUUID()}`;
  } catch {
    // Fall through to the timestamp/random fallback.
  }
  return `generation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const MIGRATION_JOURNAL_KEY = '__twe_migration_journal_v1';

export type MigrationPhase =
  | 'planned'
  | 'preflighted'
  | 'staging'
  | 'transformed'
  | 'verifying'
  | 'prepared'
  | 'companion_switched'
  | 'browser_rebuilding'
  | 'browser_verified'
  | 'snapshot_verified'
  | 'committed'
  | 'rollback_required'
  | 'rolled_back'
  | 'failed';

const MIGRATION_PHASES: MigrationPhase[] = [
  'planned',
  'preflighted',
  'staging',
  'transformed',
  'verifying',
  'prepared',
  'companion_switched',
  'browser_rebuilding',
  'browser_verified',
  'snapshot_verified',
  'committed',
  'rollback_required',
  'rolled_back',
  'failed',
];

export type MigrationJournal = {
  schema_version: typeof GENERATION_STATE_SCHEMA_VERSION;
  migration_id: string;
  phase: MigrationPhase;
  archive_id: string;
  namespace_id: string;
  source_generation_id: string | null;
  source_database_name: string | null;
  target_generation_id: string | null;
  target_database_name: string | null;
  source_protocol: { major: number; minor: number };
  target_protocol: { major: number; minor: number };
  source_schema_revision: number;
  target_schema_revision: number;
  transform_id: string;
  transform_hash: string;
  source_checkpoint: Checkpoint | null;
  target_checkpoint: Checkpoint | null;
  event_id: number;
  updated_at_ms: number;
  compatibility: 'compatible' | 'unknown' | 'incompatible' | 'lossy';
  error?: string;
};

export function readMigrationJournal(): MigrationJournal | null {
  const value = readRecord<Partial<MigrationJournal>>(MIGRATION_JOURNAL_KEY);
  if (
    !value ||
    value.schema_version !== GENERATION_STATE_SCHEMA_VERSION ||
    typeof value.migration_id !== 'string' ||
    typeof value.phase !== 'string' ||
    !MIGRATION_PHASES.includes(value.phase as MigrationPhase) ||
    typeof value.archive_id !== 'string' ||
    typeof value.namespace_id !== 'string' ||
    !value.source_protocol ||
    !Number.isInteger(value.source_protocol.major) ||
    !Number.isInteger(value.source_protocol.minor) ||
    !value.target_protocol ||
    !Number.isInteger(value.target_protocol.major) ||
    !Number.isInteger(value.target_protocol.minor) ||
    !Number.isInteger(value.source_schema_revision) ||
    !Number.isInteger(value.target_schema_revision) ||
    typeof value.transform_id !== 'string' ||
    !value.transform_id.trim() ||
    typeof value.transform_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.transform_hash) ||
    !Number.isInteger(value.event_id) ||
    Number(value.event_id) < 1 ||
    !Number.isFinite(value.updated_at_ms) ||
    !['compatible', 'unknown', 'incompatible', 'lossy'].includes(String(value.compatibility))
  ) {
    return null;
  }
  return value as MigrationJournal;
}

export function writeMigrationJournal(journal: MigrationJournal): void {
  const target = storage();
  if (!target) throw new Error('durability storage is unavailable');
  target.write(MIGRATION_JOURNAL_KEY, journal);
}

export function clearMigrationJournal(): void {
  storage()?.remove(MIGRATION_JOURNAL_KEY);
}
