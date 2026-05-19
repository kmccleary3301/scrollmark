import { logLinesSignal } from '@/utils/logger';
import { isDiagnosticCaptureEnabled, readDiagnosticBuffers } from '@/utils/diagnostics';
import { zipBlobFiles } from '@/utils/download';
import { options } from '@/core/options';
import { db } from '@/core/database';
import { readPerfDiagnostics } from '@/core/perf/metrics';

type DiagnosticsBuffers = {
  parser?: unknown[];
  db?: unknown[];
  interaction?: unknown[];
};

function readUserscriptManagerInfo(): Record<string, unknown> {
  try {
    const info = (globalThis as Record<string, unknown>).GM_info;
    if (!info || typeof info !== 'object') return {};
    const row = info as Record<string, unknown>;
    const script = row.script && typeof row.script === 'object' ? row.script : {};
    return {
      scriptHandler: row.scriptHandler,
      version: row.version,
      platform: row.platform,
      script,
    };
  } catch {
    return {};
  }
}

function readBrowserInfo(): Record<string, unknown> {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  return {
    userAgent: nav?.userAgent ?? '',
    vendor: nav?.vendor ?? '',
    platform: nav?.platform ?? '',
    language: nav?.language ?? '',
    languages: nav?.languages ? [...nav.languages] : [],
    cookieEnabled: nav?.cookieEnabled ?? null,
    webdriver: nav?.webdriver ?? null,
  };
}

async function collectReleaseReadinessReport(): Promise<Record<string, unknown>> {
  const databaseCounts = await db.count().catch(() => null);
  const importedBundles = ((await db.bundleList().catch(() => [])) ?? []).map((bundle) => ({
    id: bundle.id,
    title: bundle.title,
    status: bundle.status,
    recordCount: bundle.recordCount,
    schemaVersion: bundle.schemaVersion,
    importedAt: bundle.importedAt,
    updatedAt: bundle.updatedAt,
  }));

  return {
    generated_at_ms: Date.now(),
    browser: readBrowserInfo(),
    userscript_manager: readUserscriptManagerInfo(),
    runtime_modes: readRuntimeModes(),
    hook_stats: readHookStats(),
    raw_capture_stats: readRawStats(),
    diagnostic_capture_enabled: isDiagnosticCaptureEnabled(),
    database_counts: databaseCounts,
    imported_bundle_count: importedBundles.length,
    imported_bundles: importedBundles,
    checklist: {
      canonical_bundle_export: 'manual-qc-required',
      canonical_bundle_import: 'manual-qc-required',
      legacy_json_import: 'manual-qc-required',
      malicious_import_safety: 'manual-qc-required',
      chrome_parity: 'manual-qc-required',
      firefox_parity: 'manual-qc-required',
    },
  };
}

export async function collectDiagnosticsBundle() {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const globals = globalThis as Record<string, unknown>;

  const dbNames = await (async () => {
    try {
      if (!indexedDB?.databases) return [];
      const rows = await indexedDB.databases();
      return (Array.isArray(rows) ? rows : [])
        .map((entry) => entry?.name)
        .filter((name): name is string => typeof name === 'string');
    } catch {
      return [];
    }
  })();

  const rawEventsRecent = (() => {
    try {
      const value = globals.__twe_raw_events_v1;
      if (!Array.isArray(value)) return [];
      return value.slice(-10).map((event) => {
        if (!event || typeof event !== 'object') return null;
        const row = event as Record<string, unknown>;
        return {
          event_id: typeof row.event_id === 'string' ? row.event_id : null,
          kind: typeof row.kind === 'string' ? row.kind : null,
          wall_time_ms: typeof row.wall_time_ms === 'number' ? row.wall_time_ms : null,
          route_type: typeof row.route_type === 'string' ? row.route_type : null,
        };
      });
    } catch {
      return [];
    }
  })();
  const rawEventsFull = (() => {
    try {
      const value = globals.__twe_raw_events_v1;
      return Array.isArray(value) ? value.slice() : [];
    } catch {
      return [];
    }
  })();
  const diagnosticBuffers = readDiagnosticBuffers();
  const recentLogs = logLinesSignal.value.slice(-400);

  const storageKeys = [
    'twe_safe_mode_v1',
    'twe_hook_mode_v1',
    'twe_repair_mode_v1',
    'twe_raw_capture_enabled_v1',
    'twe_raw_capture_encryption_ready_v1',
    'twe_raw_capture_dm_session_armed_until_ms_v1',
    'twe_raw_capture_stream_enabled_v1',
    'twe_raw_capture_daemon_url_v1',
  ];
  const storage: Record<string, string | null> = {};
  for (const key of storageKeys) {
    try {
      storage[key] = localStorage.getItem(key);
    } catch {
      storage[key] = null;
    }
  }

  const appOptionsSnapshot = {
    directMessagesCaptureEnabled: options.get('directMessagesCaptureEnabled', false),
    rawCaptureEncryptedStorageReady: options.get('rawCaptureEncryptedStorageReady', false),
    rawCapturePolicyPublicEnabled: options.get('rawCapturePolicyPublicEnabled', true),
    rawCapturePolicySensitiveEnabled: options.get('rawCapturePolicySensitiveEnabled', true),
    rawCapturePolicyDmEnabled: options.get('rawCapturePolicyDmEnabled', true),
  };

  return {
    generated_at_ms: now,
    generated_at_iso: nowIso,
    location: typeof location !== 'undefined' ? location.href : '',
    title: typeof document !== 'undefined' ? document.title : '',
    runtime_modes: readRuntimeModes(),
    hook_stats: readHookStats(),
    browser: readBrowserInfo(),
    userscript_manager: readUserscriptManagerInfo(),
    release_readiness: await collectReleaseReadinessReport(),
    performance: readPerfDiagnostics(),
    raw_capture_stats: readRawStats(),
    raw_events_recent: rawEventsRecent,
    raw_events_count: rawEventsFull.length,
    diagnostic_capture_enabled: isDiagnosticCaptureEnabled(),
    diagnostic_buffer_counts: {
      parser: diagnosticBuffers.parser.length,
      db: diagnosticBuffers.db.length,
      interaction: diagnosticBuffers.interaction.length,
      logs: recentLogs.length,
    },
    indexeddb_names: dbNames,
    local_storage: storage,
    app_options: appOptionsSnapshot,
    raw_events_full: rawEventsFull,
    diagnostic_buffers: diagnosticBuffers,
    recent_logs: recentLogs,
  };
}

export function downloadJson(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportDiagnosticsBundleZip() {
  const bundle = await collectDiagnosticsBundle();
  const now = Date.now();
  const {
    raw_events_full: rawEventsFull = [],
    diagnostic_buffers: diagnosticBuffers = { parser: [], db: [], interaction: [] },
    recent_logs: recentLogs = [],
    ...summary
  } = bundle as {
    raw_events_full?: unknown[];
    diagnostic_buffers?: DiagnosticsBuffers;
    recent_logs?: unknown[];
    [key: string]: unknown;
  };

  const files = [
    {
      filename: 'summary.json',
      blob: new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' }),
    },
    {
      filename: 'raw-events.json',
      blob: new Blob([JSON.stringify(rawEventsFull, null, 2)], { type: 'application/json' }),
    },
    {
      filename: 'parser-events.json',
      blob: new Blob([JSON.stringify(diagnosticBuffers.parser ?? [], null, 2)], {
        type: 'application/json',
      }),
    },
    {
      filename: 'db-events.json',
      blob: new Blob([JSON.stringify(diagnosticBuffers.db ?? [], null, 2)], {
        type: 'application/json',
      }),
    },
    {
      filename: 'interaction-events.json',
      blob: new Blob([JSON.stringify(diagnosticBuffers.interaction ?? [], null, 2)], {
        type: 'application/json',
      }),
    },
    {
      filename: 'recent-logs.json',
      blob: new Blob([JSON.stringify(recentLogs, null, 2)], {
        type: 'application/json',
      }),
    },
    {
      filename: 'release-readiness.json',
      blob: new Blob([JSON.stringify(summary.release_readiness ?? {}, null, 2)], {
        type: 'application/json',
      }),
    },
  ];

  await zipBlobFiles(`twe-diagnostics-${now}.zip`, files);
}

export function readRawStats(): Record<string, unknown> {
  try {
    const value = (globalThis as Record<string, unknown>).__twe_raw_capture_stats_v1;
    if (!value || typeof value !== 'object') return {};
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readRuntimeModes(): Record<string, unknown> {
  try {
    const value = (globalThis as Record<string, unknown>).__twe_runtime_modes_v1;
    if (!value || typeof value !== 'object') return {};
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readHookStats(): Record<string, unknown> {
  try {
    const value = (globalThis as Record<string, unknown>).__twe_hook_stats_v1;
    if (!value || typeof value !== 'object') return {};
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}
