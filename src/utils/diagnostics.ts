const DIAGNOSTIC_CAPTURE_ENABLED_STORAGE_KEY = 'twe_diagnostic_capture_enabled_v1';
const DIAGNOSTIC_PARSER_BUFFER_KEY = '__twe_diagnostic_parser_events_v1';
const DIAGNOSTIC_DB_BUFFER_KEY = '__twe_diagnostic_db_events_v1';
const DIAGNOSTIC_INTERACTION_BUFFER_KEY = '__twe_diagnostic_interaction_events_v1';
const DIAGNOSTIC_EVENT_NAME = 'twe:diagnostic-event-v1';
const DIAGNOSTIC_BUFFER_LIMIT = 500;

export type DiagnosticParserEvent = {
  ts: number;
  extension: string;
  phase: 'claimed' | 'completed' | 'error';
  request_id?: string;
  method?: string;
  url?: string;
  status?: number;
  duration_ms?: number;
  error?: string;
};

export type DiagnosticDbEvent = {
  ts: number;
  extension?: string;
  operation?: string;
  count?: number;
  keys?: string[];
};

export type DiagnosticInteractionEvent = {
  ts: number;
  extension: string;
  kind: string;
  target_type: string;
  operation?: string;
  request_id?: string;
  tweet_ids?: string[];
  user_ids?: string[];
  folder_ids?: string[];
  targets?: string[];
  mirror_task_count?: number;
};

type DiagnosticBufferMap = {
  parser: DiagnosticParserEvent[];
  db: DiagnosticDbEvent[];
  interaction: DiagnosticInteractionEvent[];
};

function getWindowRecord(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function readStorageFlag(key: string, fallback = false): boolean {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1' || raw === 'true';
  } catch {
    return fallback;
  }
}

function writeStorageFlag(key: string, value: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore
  }
}

function pushBufferedEvent<T>(key: string, event: T): void {
  const g = getWindowRecord();
  const current = Array.isArray(g[key]) ? (g[key] as T[]) : [];
  current.push(event);
  if (current.length > DIAGNOSTIC_BUFFER_LIMIT) {
    current.splice(0, current.length - DIAGNOSTIC_BUFFER_LIMIT);
  }
  g[key] = current;

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(DIAGNOSTIC_EVENT_NAME, { detail: { key } }));
    } catch {
      // ignore
    }
  }
}

export function isDiagnosticCaptureEnabled(): boolean {
  const g = getWindowRecord();
  const globalFlag = g.__twe_diagnostic_capture_enabled_v1;
  if (typeof globalFlag === 'boolean') {
    return globalFlag;
  }
  const enabled = readStorageFlag(DIAGNOSTIC_CAPTURE_ENABLED_STORAGE_KEY, false);
  g.__twe_diagnostic_capture_enabled_v1 = enabled;
  return enabled;
}

export function setDiagnosticCaptureEnabled(value: boolean): void {
  const g = getWindowRecord();
  g.__twe_diagnostic_capture_enabled_v1 = value;
  writeStorageFlag(DIAGNOSTIC_CAPTURE_ENABLED_STORAGE_KEY, value);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent(DIAGNOSTIC_EVENT_NAME, {
          detail: { key: DIAGNOSTIC_CAPTURE_ENABLED_STORAGE_KEY, enabled: value },
        }),
      );
    } catch {
      // ignore
    }
  }
}

export function recordDiagnosticParserEvent(event: DiagnosticParserEvent): void {
  if (!isDiagnosticCaptureEnabled()) return;
  pushBufferedEvent(DIAGNOSTIC_PARSER_BUFFER_KEY, event);
}

export function recordDiagnosticDbEvent(event: DiagnosticDbEvent): void {
  if (!isDiagnosticCaptureEnabled()) return;
  pushBufferedEvent(DIAGNOSTIC_DB_BUFFER_KEY, event);
}

export function recordDiagnosticInteractionEvent(event: DiagnosticInteractionEvent): void {
  if (!isDiagnosticCaptureEnabled()) return;
  pushBufferedEvent(DIAGNOSTIC_INTERACTION_BUFFER_KEY, event);
}

export function readDiagnosticBuffers(): DiagnosticBufferMap {
  const g = getWindowRecord();
  return {
    parser: Array.isArray(g[DIAGNOSTIC_PARSER_BUFFER_KEY])
      ? ([
          ...(g[DIAGNOSTIC_PARSER_BUFFER_KEY] as DiagnosticParserEvent[]),
        ] as DiagnosticParserEvent[])
      : [],
    db: Array.isArray(g[DIAGNOSTIC_DB_BUFFER_KEY])
      ? ([...(g[DIAGNOSTIC_DB_BUFFER_KEY] as DiagnosticDbEvent[])] as DiagnosticDbEvent[])
      : [],
    interaction: Array.isArray(g[DIAGNOSTIC_INTERACTION_BUFFER_KEY])
      ? ([
          ...(g[DIAGNOSTIC_INTERACTION_BUFFER_KEY] as DiagnosticInteractionEvent[]),
        ] as DiagnosticInteractionEvent[])
      : [],
  };
}

export function clearDiagnosticBuffers(): void {
  const g = getWindowRecord();
  g[DIAGNOSTIC_PARSER_BUFFER_KEY] = [];
  g[DIAGNOSTIC_DB_BUFFER_KEY] = [];
  g[DIAGNOSTIC_INTERACTION_BUFFER_KEY] = [];
}

export const diagnosticKeys = {
  enabledStorageKey: DIAGNOSTIC_CAPTURE_ENABLED_STORAGE_KEY,
  parserBufferKey: DIAGNOSTIC_PARSER_BUFFER_KEY,
  dbBufferKey: DIAGNOSTIC_DB_BUFFER_KEY,
  interactionBufferKey: DIAGNOSTIC_INTERACTION_BUFFER_KEY,
  eventName: DIAGNOSTIC_EVENT_NAME,
};
