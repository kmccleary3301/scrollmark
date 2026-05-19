import { Signal, signal } from '@preact/signals';
import { recordDiagnosticDbEvent } from '@/utils/diagnostics';

const DB_MUTATION_STORAGE_KEY = '__twe_db_mutation_v1';
const DB_MUTATION_CHANNEL_NAME = 'twe-db-mutation-v1';

type MutationMessage = {
  extension?: string;
  operation?: string;
  at?: number;
  nonce?: string;
};

export type DatabaseMutationEvent = {
  extension?: string;
  operation?: string;
  count?: number;
  keys?: string[];
};

const globalMutationVersion = signal(0);
const extensionMutationVersions = new Map<string, Signal<number>>();

let bridgeReady = false;
let broadcastChannel: BroadcastChannel | null = null;

function getExtensionSignal(extName: string): Signal<number> {
  let extSignal = extensionMutationVersions.get(extName);
  if (!extSignal) {
    extSignal = signal(0);
    extensionMutationVersions.set(extName, extSignal);
  }
  return extSignal;
}

function bumpMutationVersion(extName?: string): void {
  if (extName) {
    getExtensionSignal(extName).value += 1;
    return;
  }
  globalMutationVersion.value += 1;
}

function parseMutationMessage(value: unknown): MutationMessage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as MutationMessage;
  return {
    extension: typeof candidate.extension === 'string' ? candidate.extension : undefined,
    operation: typeof candidate.operation === 'string' ? candidate.operation : undefined,
  };
}

function handleExternalMutationMessage(raw: unknown): void {
  const parsed = parseMutationMessage(raw);
  if (!parsed) {
    return;
  }
  bumpMutationVersion(parsed?.extension);
}

function ensureMutationBridge(): void {
  if (bridgeReady || typeof window === 'undefined') {
    return;
  }
  bridgeReady = true;

  window.addEventListener('storage', (event) => {
    if (event.key !== DB_MUTATION_STORAGE_KEY || !event.newValue) {
      return;
    }
    try {
      const parsed = JSON.parse(event.newValue) as unknown;
      handleExternalMutationMessage(parsed);
    } catch {
      // ignore malformed data
    }
  });

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      broadcastChannel = new BroadcastChannel(DB_MUTATION_CHANNEL_NAME);
      broadcastChannel.onmessage = (event: MessageEvent<unknown>) => {
        handleExternalMutationMessage(event.data);
      };
    } catch {
      broadcastChannel = null;
    }
  }
}

/**
 * Emit a mutation signal used by capture UI hooks.
 * The signal is bumped locally and broadcasted to sibling tabs/windows.
 */
export function emitDatabaseMutation(event: DatabaseMutationEvent = {}): void {
  ensureMutationBridge();

  const payload: MutationMessage = {
    extension: event.extension,
    operation: event.operation,
    at: Date.now(),
    nonce: Math.random().toString(36).slice(2),
  };

  bumpMutationVersion(payload.extension);

  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(payload);
    } catch {
      // ignore
    }
  }

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DB_MUTATION_STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {
    // ignore storage write failures
  }

  recordDiagnosticDbEvent({
    ts: payload.at || Date.now(),
    extension: event.extension,
    operation: event.operation,
    count: typeof event.count === 'number' ? event.count : undefined,
    keys: Array.isArray(event.keys) ? event.keys.slice(0, 20) : undefined,
  });
}

/**
 * Returns a reactive version number for database mutations.
 * If an extension name is provided, this value is biased toward that extension.
 */
export function useDatabaseMutationVersion(extName?: string): number {
  ensureMutationBridge();
  const globalVersion = globalMutationVersion.value;
  if (!extName) {
    return globalVersion;
  }
  return globalVersion + getExtensionSignal(extName).value;
}
