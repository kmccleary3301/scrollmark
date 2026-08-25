import { signal } from '@preact/signals';

import {
  collectIndexedDbInventory,
  type IndexedDbInventory,
  type IndexedDbInventoryRow,
} from '@/core/database/inventory';

export const CONTINUITY_SENTINEL_KEY = '__twe_continuity_sentinel_v1';
export const PERSISTENCE_REPORT_KEY = '__twe_persistence_report_v1';
export const CONTINUITY_LOCAL_FALLBACK_FLAG = '__twe_allow_continuity_local_fallback_v1';
export const CONTINUITY_SENTINEL_SCHEMA_VERSION = 1;

type ContinuityStorageBackend = 'userscript' | 'test-local' | 'unavailable';

type ContinuityStorage = {
  backend: Exclude<ContinuityStorageBackend, 'unavailable'>;
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => void;
};

export type PersistenceState = 'granted' | 'denied' | 'unsupported' | 'error';

export type PersistenceReport = {
  schema_version: 1;
  state: PersistenceState;
  requested_at_ms: number;
  observed_at_ms: number;
  origin: string;
  error_code?: string;
};

export type ContinuityCounts = {
  captures: number;
  tweets: number;
  users: number;
  social_edges: number;
  search_documents: number;
  total: number;
};

export type ContinuitySentinel = {
  schema_version: typeof CONTINUITY_SENTINEL_SCHEMA_VERSION;
  archive_uuid: string | null;
  companion_protocol_version: string | null;
  account_ids: string[];
  namespace_ids: string[];
  active_db_name: string | null;
  approximate_counts: ContinuityCounts;
  last_acknowledged_durable_seq: number | null;
  last_verified_backup_at_ms: number | null;
  updated_at_ms: number;
  checksum: string;
};

export type BrowserSafetyPhase = 'checking' | 'healthy' | 'warning' | 'recovery_required';

export type ContinuityAssessment = {
  phase: Exclude<BrowserSafetyPhase, 'checking'>;
  reason: string;
  current_counts: ContinuityCounts;
  current_db_name: string | null;
};

export type BrowserSafetySnapshot = {
  phase: BrowserSafetyPhase;
  reason: string;
  checked_at_ms: number | null;
  storage_backend: ContinuityStorageBackend;
  sentinel: ContinuitySentinel | null;
  sentinel_present: boolean;
  sentinel_valid: boolean;
  inventory: IndexedDbInventory | null;
  current_counts: ContinuityCounts | null;
  error: string | null;
  persistence: PersistenceReport | null;
};

const ZERO_COUNTS: ContinuityCounts = {
  captures: 0,
  tweets: 0,
  users: 0,
  social_edges: 0,
  search_documents: 0,
  total: 0,
};

const INITIAL_SNAPSHOT: BrowserSafetySnapshot = {
  phase: 'checking',
  reason: 'startup-check',
  checked_at_ms: null,
  storage_backend: 'unavailable',
  sentinel: null,
  sentinel_present: false,
  sentinel_valid: false,
  inventory: null,
  current_counts: null,
  error: null,
  persistence: null,
};

export const browserSafetyState = signal<BrowserSafetySnapshot>(INITIAL_SNAPSHOT);

const globalScope = globalThis as unknown as Record<string, unknown>;

function finiteCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeCounts(value: unknown): ContinuityCounts {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const captures = finiteCount(source.captures);
  const tweets = finiteCount(source.tweets);
  const users = finiteCount(source.users);
  const socialEdges = finiteCount(source.social_edges);
  const searchDocuments = finiteCount(source.search_documents);
  const suppliedTotal = finiteCount(source.total);
  const total = suppliedTotal || Math.max(captures, tweets, users, searchDocuments);
  return {
    captures,
    tweets,
    users,
    social_edges: socialEdges,
    search_documents: searchDocuments,
    total,
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ).sort();
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sentinelPayload(sentinel: Omit<ContinuitySentinel, 'checksum'>) {
  return {
    schema_version: sentinel.schema_version,
    archive_uuid: sentinel.archive_uuid,
    companion_protocol_version: sentinel.companion_protocol_version,
    account_ids: sentinel.account_ids,
    namespace_ids: sentinel.namespace_ids,
    active_db_name: sentinel.active_db_name,
    approximate_counts: sentinel.approximate_counts,
    last_acknowledged_durable_seq: sentinel.last_acknowledged_durable_seq,
    last_verified_backup_at_ms: sentinel.last_verified_backup_at_ms,
    updated_at_ms: sentinel.updated_at_ms,
  };
}

function payloadText(sentinel: Omit<ContinuitySentinel, 'checksum'>): string {
  return JSON.stringify(sentinelPayload(sentinel));
}

async function sha256Hex(value: string): Promise<string> {
  const cryptoApi = globalScope.crypto as Crypto | undefined;
  if (!cryptoApi?.subtle) {
    throw new Error('Web Crypto is unavailable for continuity checksum verification');
  }
  const encoded = new TextEncoder().encode(value);
  const digest = await cryptoApi.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getContinuityStorage(): ContinuityStorage | null {
  const getValue = globalScope.GM_getValue;
  const setValue = globalScope.GM_setValue;
  if (typeof getValue === 'function' && typeof setValue === 'function') {
    return {
      backend: 'userscript',
      read: (key) => (getValue as (key: string) => unknown)(key),
      write: (key, value) => (setValue as (key: string, nextValue: unknown) => void)(key, value),
    };
  }

  if (globalScope[CONTINUITY_LOCAL_FALLBACK_FLAG] !== true) {
    return null;
  }

  const localStorageValue = globalScope.localStorage as
    | {
        getItem?: (key: string) => string | null;
        setItem?: (key: string, value: string) => void;
      }
    | undefined;
  if (!localStorageValue?.getItem || !localStorageValue.setItem) {
    return null;
  }
  return {
    backend: 'test-local',
    read: (key) => localStorageValue.getItem?.(key),
    write: (key, value) => localStorageValue.setItem?.(key, JSON.stringify(value)),
  };
}

function normalizePersistenceReport(value: unknown): PersistenceReport | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const state = source.state;
  if (state !== 'granted' && state !== 'denied' && state !== 'unsupported' && state !== 'error') {
    return null;
  }
  const requestedAt = finiteCount(source.requested_at_ms);
  const observedAt = finiteCount(source.observed_at_ms);
  if (!requestedAt || !observedAt || typeof source.origin !== 'string') return null;
  return {
    schema_version: 1,
    state,
    requested_at_ms: requestedAt,
    observed_at_ms: observedAt,
    origin: source.origin || 'unknown',
    ...(typeof source.error_code === 'string' && source.error_code
      ? { error_code: source.error_code }
      : {}),
  };
}

function persistenceOrigin(): string {
  const locationValue = globalScope.location as { origin?: unknown } | undefined;
  return typeof locationValue?.origin === 'string' && locationValue.origin
    ? locationValue.origin
    : 'unknown';
}

function persistenceErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const name = (error as Record<string, unknown>).name;
    if (typeof name === 'string' && name) return name;
  }
  return 'request-error';
}

async function ensurePersistenceReport(storage: ContinuityStorage): Promise<PersistenceReport> {
  const now = Date.now();
  let raw: unknown;
  try {
    raw = await storage.read(PERSISTENCE_REPORT_KEY);
    if (typeof raw === 'string') raw = JSON.parse(raw);
  } catch {
    return {
      schema_version: 1,
      state: 'error',
      requested_at_ms: now,
      observed_at_ms: now,
      origin: persistenceOrigin(),
      error_code: 'report-read-failed',
    };
  }

  if (raw !== undefined && raw !== null && raw !== '') {
    const existing = normalizePersistenceReport(raw);
    if (existing) return existing;
    return {
      schema_version: 1,
      state: 'error',
      requested_at_ms: now,
      observed_at_ms: now,
      origin: persistenceOrigin(),
      error_code: 'invalid-report',
    };
  }

  const navigatorValue = globalScope.navigator as
    | { storage?: { persist?: () => Promise<boolean> } }
    | undefined;
  const browserStorage = navigatorValue?.storage;
  const persist = browserStorage?.persist;
  let report: PersistenceReport;
  if (typeof persist !== 'function' || !browserStorage) {
    report = {
      schema_version: 1,
      state: 'unsupported',
      requested_at_ms: now,
      observed_at_ms: Date.now(),
      origin: persistenceOrigin(),
    };
  } else {
    try {
      const granted = Boolean(await persist.call(browserStorage));
      report = {
        schema_version: 1,
        state: granted ? 'granted' : 'denied',
        requested_at_ms: now,
        observed_at_ms: Date.now(),
        origin: persistenceOrigin(),
      };
    } catch (error) {
      report = {
        schema_version: 1,
        state: 'error',
        requested_at_ms: now,
        observed_at_ms: Date.now(),
        origin: persistenceOrigin(),
        error_code: persistenceErrorCode(error),
      };
    }
  }

  try {
    await storage.write(PERSISTENCE_REPORT_KEY, report);
  } catch {
    return { ...report, state: 'error', error_code: 'report-write-failed' };
  }
  return report;
}

function normalizeSentinel(value: unknown): ContinuitySentinel | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const payload =
    source.payload && typeof source.payload === 'object'
      ? (source.payload as Record<string, unknown>)
      : source;
  const checksum = typeof source.checksum === 'string' ? source.checksum.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(checksum)) return null;
  if (Number(payload.schema_version) !== CONTINUITY_SENTINEL_SCHEMA_VERSION) return null;
  const updatedAt = finiteCount(payload.updated_at_ms);
  if (!updatedAt) return null;
  return {
    schema_version: CONTINUITY_SENTINEL_SCHEMA_VERSION,
    archive_uuid: normalizeNullableString(payload.archive_uuid),
    companion_protocol_version: normalizeNullableString(payload.companion_protocol_version),
    account_ids: normalizeStringList(payload.account_ids),
    namespace_ids: normalizeStringList(payload.namespace_ids),
    active_db_name: normalizeNullableString(payload.active_db_name),
    approximate_counts: normalizeCounts(payload.approximate_counts),
    last_acknowledged_durable_seq: normalizeNullableNumber(payload.last_acknowledged_durable_seq),
    last_verified_backup_at_ms: normalizeNullableNumber(payload.last_verified_backup_at_ms),
    updated_at_ms: updatedAt,
    checksum,
  };
}

export async function readContinuitySentinel(): Promise<{
  backend: ContinuityStorageBackend;
  present: boolean;
  valid: boolean;
  sentinel: ContinuitySentinel | null;
}> {
  const storage = getContinuityStorage();
  if (!storage) {
    return { backend: 'unavailable', present: false, valid: false, sentinel: null };
  }

  let raw: unknown;
  try {
    raw = await storage.read(CONTINUITY_SENTINEL_KEY);
    if (typeof raw === 'string') {
      raw = JSON.parse(raw);
    }
  } catch {
    return { backend: storage.backend, present: true, valid: false, sentinel: null };
  }

  if (raw === undefined || raw === null || raw === '') {
    return { backend: storage.backend, present: false, valid: false, sentinel: null };
  }

  const sentinel = normalizeSentinel(raw);
  if (!sentinel) {
    return { backend: storage.backend, present: true, valid: false, sentinel: null };
  }

  try {
    const payload = sentinelPayload({
      schema_version: sentinel.schema_version,
      archive_uuid: sentinel.archive_uuid,
      companion_protocol_version: sentinel.companion_protocol_version,
      account_ids: sentinel.account_ids,
      namespace_ids: sentinel.namespace_ids,
      active_db_name: sentinel.active_db_name,
      approximate_counts: sentinel.approximate_counts,
      last_acknowledged_durable_seq: sentinel.last_acknowledged_durable_seq,
      last_verified_backup_at_ms: sentinel.last_verified_backup_at_ms,
      updated_at_ms: sentinel.updated_at_ms,
    });
    const expected = await sha256Hex(payloadText(payload));
    return {
      backend: storage.backend,
      present: true,
      valid: expected === sentinel.checksum,
      sentinel: expected === sentinel.checksum ? sentinel : null,
    };
  } catch {
    return { backend: storage.backend, present: true, valid: false, sentinel: null };
  }
}

export function countsFromInventoryRow(row: IndexedDbInventoryRow | null): ContinuityCounts {
  if (!row) return { ...ZERO_COUNTS };
  const tables = row.tables || {};
  const captures = finiteCount(tables.captures);
  const tweets = finiteCount(tables.tweets);
  const users = finiteCount(tables.users);
  const socialEdges = finiteCount(tables.social_edges);
  const searchDocuments = finiteCount(tables.search_documents);
  return normalizeCounts({
    captures,
    tweets,
    users,
    social_edges: socialEdges,
    search_documents: searchDocuments,
    total: Math.max(captures, tweets, users, searchDocuments),
  });
}

function findCurrentRow(
  sentinel: ContinuitySentinel | null,
  inventory: IndexedDbInventory,
): IndexedDbInventoryRow | null {
  if (sentinel?.active_db_name) {
    return inventory.databases.find((row) => row.name === sentinel.active_db_name) || null;
  }
  return (
    inventory.databases.find((row) => row.active) ||
    (inventory.databases.length === 1 ? inventory.databases[0] : null) ||
    null
  );
}

export function assessContinuity(
  sentinel: ContinuitySentinel | null,
  inventory: IndexedDbInventory,
): ContinuityAssessment {
  const previousCounts = sentinel?.approximate_counts || ZERO_COUNTS;
  const hasPreviousArchive = previousCounts.total > 0;
  if (!inventory.enumeration_supported) {
    return {
      phase: hasPreviousArchive ? 'recovery_required' : 'warning',
      reason: hasPreviousArchive ? 'inventory-unavailable' : 'inventory-unavailable-no-baseline',
      current_counts: { ...ZERO_COUNTS },
      current_db_name: inventory.active_db_name,
    };
  }

  const currentRow = findCurrentRow(sentinel, inventory);
  const currentCounts = countsFromInventoryRow(currentRow);
  const currentDbName = currentRow?.name || inventory.active_db_name || null;

  if (currentRow?.error && hasPreviousArchive) {
    return {
      phase: 'recovery_required',
      reason: 'active-database-unreadable',
      current_counts: currentCounts,
      current_db_name: currentDbName,
    };
  }

  if (hasPreviousArchive && !currentRow) {
    return {
      phase: 'recovery_required',
      reason: 'active-database-missing',
      current_counts: currentCounts,
      current_db_name: currentDbName,
    };
  }

  if (
    hasPreviousArchive &&
    sentinel?.active_db_name &&
    inventory.active_db_name &&
    sentinel.active_db_name !== inventory.active_db_name
  ) {
    return {
      phase: 'recovery_required',
      reason: 'active-database-changed',
      current_counts: currentCounts,
      current_db_name: currentDbName,
    };
  }

  const previousTotal = previousCounts.total;
  const currentTotal = currentCounts.total;
  const suspiciouslySmall =
    hasPreviousArchive && currentTotal < Math.max(1, Math.floor(previousTotal * 0.5));
  if (suspiciouslySmall) {
    return {
      phase: 'recovery_required',
      reason: 'archive-count-dropped',
      current_counts: currentCounts,
      current_db_name: currentDbName,
    };
  }

  if (currentRow?.error) {
    return {
      phase: 'warning',
      reason: 'active-database-unreadable-no-baseline',
      current_counts: currentCounts,
      current_db_name: currentDbName,
    };
  }

  if (!currentRow && inventory.databases.length > 1) {
    return {
      phase: 'warning',
      reason: 'account-identity-ambiguous',
      current_counts: currentCounts,
      current_db_name: currentDbName,
    };
  }

  return {
    phase: 'healthy',
    reason: sentinel ? 'continuity-verified' : 'baseline-created',
    current_counts: currentCounts,
    current_db_name: currentDbName,
  };
}

export async function createContinuitySentinel(
  previous: ContinuitySentinel | null,
  inventory: IndexedDbInventory,
  currentCounts: ContinuityCounts,
): Promise<ContinuitySentinel> {
  const payload = {
    schema_version: CONTINUITY_SENTINEL_SCHEMA_VERSION as typeof CONTINUITY_SENTINEL_SCHEMA_VERSION,
    archive_uuid: previous?.archive_uuid || null,
    companion_protocol_version: previous?.companion_protocol_version || null,
    account_ids: previous?.account_ids || [],
    namespace_ids: previous?.namespace_ids || [],
    active_db_name: inventory.active_db_name || previous?.active_db_name || null,
    approximate_counts: currentCounts,
    last_acknowledged_durable_seq: previous?.last_acknowledged_durable_seq ?? null,
    last_verified_backup_at_ms: previous?.last_verified_backup_at_ms ?? null,
    updated_at_ms: Date.now(),
  };
  return {
    ...payload,
    checksum: await sha256Hex(payloadText(payload)),
  };
}

function snapshotWith(
  base: Partial<BrowserSafetySnapshot> & Pick<BrowserSafetySnapshot, 'phase' | 'reason'>,
): BrowserSafetySnapshot {
  return {
    ...INITIAL_SNAPSHOT,
    checked_at_ms: Date.now(),
    ...base,
  };
}

export type InitializeBrowserSafetyOptions = {
  force?: boolean;
  acknowledgeCacheReset?: boolean;
};

let initialization: Promise<BrowserSafetySnapshot> | null = null;

async function runBrowserSafetyCheck(
  options: InitializeBrowserSafetyOptions,
): Promise<BrowserSafetySnapshot> {
  const storage = getContinuityStorage();
  if (!storage) {
    const snapshot = snapshotWith({
      phase: 'recovery_required',
      reason: 'continuity-storage-unavailable',
      error: 'Userscript manager storage is unavailable; the archive cannot be guarded.',
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  }

  const persistence = await ensurePersistenceReport(storage);
  const stored = await readContinuitySentinel();
  if (stored.present && !stored.valid) {
    const snapshot = snapshotWith({
      phase: 'recovery_required',
      reason: 'continuity-sentinel-invalid',
      storage_backend: stored.backend,
      persistence,
      sentinel_present: true,
      error: 'The continuity sentinel failed checksum or schema validation.',
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  }

  let inventory: IndexedDbInventory;
  try {
    inventory = await collectIndexedDbInventory();
  } catch (error) {
    const snapshot = snapshotWith({
      phase: 'recovery_required',
      reason: 'inventory-read-failed',
      storage_backend: stored.backend,
      persistence,
      sentinel: stored.sentinel,
      sentinel_present: stored.present,
      sentinel_valid: stored.valid,
      error: error instanceof Error ? error.message : String(error),
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  }

  const assessment = assessContinuity(stored.sentinel, inventory);
  if (options.acknowledgeCacheReset && inventory.enumeration_supported) {
    let baseline: ContinuitySentinel;
    try {
      baseline = await createContinuitySentinel(
        stored.sentinel,
        inventory,
        assessment.current_counts,
      );
    } catch (error) {
      const snapshot = snapshotWith({
        phase: 'recovery_required',
        reason: 'continuity-checksum-unavailable',
        storage_backend: stored.backend,
        persistence,
        sentinel: stored.sentinel,
        sentinel_present: stored.present,
        sentinel_valid: stored.valid,
        inventory,
        current_counts: assessment.current_counts,
        error: error instanceof Error ? error.message : String(error),
      });
      browserSafetyState.value = snapshot;
      return snapshot;
    }
    try {
      await storage.write(CONTINUITY_SENTINEL_KEY, baseline);
      const snapshot = snapshotWith({
        phase: 'healthy',
        reason: 'cache-clear-acknowledged',
        storage_backend: stored.backend,
        persistence,
        sentinel: baseline,
        sentinel_present: true,
        sentinel_valid: true,
        inventory,
        current_counts: assessment.current_counts,
      });
      browserSafetyState.value = snapshot;
      return snapshot;
    } catch (error) {
      const snapshot = snapshotWith({
        phase: 'recovery_required',
        reason: 'continuity-sentinel-write-failed',
        storage_backend: stored.backend,
        persistence,
        sentinel: stored.sentinel,
        sentinel_present: stored.present,
        sentinel_valid: stored.valid,
        inventory,
        current_counts: assessment.current_counts,
        error: error instanceof Error ? error.message : String(error),
      });
      browserSafetyState.value = snapshot;
      return snapshot;
    }
  }

  if (assessment.phase === 'recovery_required') {
    const snapshot = snapshotWith({
      phase: assessment.phase,
      reason: assessment.reason,
      storage_backend: stored.backend,
      persistence,
      sentinel: stored.sentinel,
      sentinel_present: stored.present,
      sentinel_valid: stored.valid,
      inventory,
      current_counts: assessment.current_counts,
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  }

  if (!inventory.enumeration_supported || assessment.phase === 'warning') {
    const snapshot = snapshotWith({
      phase: assessment.phase,
      reason: assessment.reason,
      storage_backend: stored.backend,
      persistence,
      sentinel: stored.sentinel,
      sentinel_present: stored.present,
      sentinel_valid: stored.valid,
      inventory,
      current_counts: assessment.current_counts,
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  }

  let nextSentinel: ContinuitySentinel;
  try {
    nextSentinel = await createContinuitySentinel(
      stored.sentinel,
      inventory,
      assessment.current_counts,
    );
  } catch (error) {
    const snapshot = snapshotWith({
      phase: 'recovery_required',
      reason: 'continuity-checksum-unavailable',
      storage_backend: stored.backend,
      persistence,
      sentinel: stored.sentinel,
      sentinel_present: stored.present,
      sentinel_valid: stored.valid,
      inventory,
      current_counts: assessment.current_counts,
      error: error instanceof Error ? error.message : String(error),
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  }
  try {
    await storage.write(CONTINUITY_SENTINEL_KEY, nextSentinel);
    const snapshot = snapshotWith({
      phase: assessment.phase,
      reason: assessment.reason,
      storage_backend: stored.backend,
      persistence,
      sentinel: nextSentinel,
      sentinel_present: true,
      sentinel_valid: true,
      inventory,
      current_counts: assessment.current_counts,
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  } catch (error) {
    const snapshot = snapshotWith({
      phase: 'recovery_required',
      reason: 'continuity-sentinel-write-failed',
      storage_backend: stored.backend,
      persistence,
      sentinel: stored.sentinel,
      sentinel_present: stored.present,
      sentinel_valid: stored.valid,
      inventory,
      current_counts: assessment.current_counts,
      error: error instanceof Error ? error.message : String(error),
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  }
}

export function initializeBrowserSafety(
  options: InitializeBrowserSafetyOptions = {},
): Promise<BrowserSafetySnapshot> {
  if (initialization && !options.force) {
    return initialization;
  }
  initialization = runBrowserSafetyCheck(options).catch((error) => {
    const snapshot = snapshotWith({
      phase: 'recovery_required',
      reason: 'startup-check-failed',
      error: error instanceof Error ? error.message : String(error),
    });
    browserSafetyState.value = snapshot;
    return snapshot;
  });
  return initialization;
}

export async function clearBrowserCache(): Promise<BrowserSafetySnapshot> {
  const { db } = await import('@/core/database');
  await db.clear();
  return initializeBrowserSafety({ force: true, acknowledgeCacheReset: true });
}
