import { signal, type Signal } from '@preact/signals';

import { getUnsafeWindow } from '@/utils/unsafe-window';

export const PAIRING_STORAGE_KEY = '__twe_scrollmark_companion_pairing_v1';
export const IDENTITY_OBSERVATION_WINDOW_MS = 5 * 60 * 1000;

export type PairingContext = {
  base_url: string;
  token: string;
  archive_id: string;
  namespace_id: string;
  client_id: string;
  client_epoch: string;
  viewer_id: string;
  origin?: string;
};

export type IdentitySignalClass = 'metadata' | 'session_state' | 'navigation_state';

export type IdentityEvidence = {
  viewer_id: string;
  source: string;
  signal_class: IdentitySignalClass;
  observed_at_ms: number;
  origin: string;
  confidence: number;
};

export type IdentityState =
  | 'uninitialized'
  | 'unverified'
  | 'candidate'
  | 'active'
  | 'quiescing'
  | 'ambiguous'
  | 'logged_out'
  | 'stopped';

export type IdentitySnapshot = {
  state: IdentityState;
  viewer_id: string | null;
  namespace_id: string | null;
  evidence: IdentityEvidence[];
  reason: string;
  changed_at_ms: number;
};

export type IdentityAssessment = {
  admitted: boolean;
  state: IdentityState;
  viewer_id: string | null;
  reason: string;
  evidence: IdentityEvidence[];
};

const INITIAL_IDENTITY: IdentitySnapshot = {
  state: 'uninitialized',
  viewer_id: null,
  namespace_id: null,
  evidence: [],
  reason: 'identity-not-observed',
  changed_at_ms: 0,
};

function globalRecord(): Record<string, unknown> {
  const value = getUnsafeWindow();
  return value && typeof value === 'object' ? value : {};
}

function normalizeViewerId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const result = String(Math.trunc(value));
    return result || null;
  }
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= 128 ? result : null;
}

function currentOrigin(): string {
  const value = (globalThis as unknown as { location?: Location }).location?.origin;
  return typeof value === 'string' && value ? value : 'unknown';
}

function isXOrigin(origin: string): boolean {
  return (
    origin === 'https://x.com' ||
    origin === 'https://twitter.com' ||
    origin === 'https://mobile.x.com'
  );
}

function evidence(
  viewerId: unknown,
  source: string,
  signalClass: IdentitySignalClass,
  now: number,
  confidence: number,
): IdentityEvidence | null {
  const normalized = normalizeViewerId(viewerId);
  if (!normalized) return null;
  const origin = currentOrigin();
  if (!isXOrigin(origin) && origin !== 'unknown') return null;
  return {
    viewer_id: normalized,
    source,
    signal_class: signalClass,
    observed_at_ms: now,
    origin,
    confidence,
  };
}

function readMetadataEvidence(now: number): IdentityEvidence | null {
  const meta = globalRecord().__META_DATA__;
  if (!meta || typeof meta !== 'object') return null;
  if (!('userId' in meta)) return null;
  return evidence(meta.userId, '__META_DATA__.userId', 'metadata', now, 60);
}

function keyLooksLikeViewer(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'viewerid' ||
    normalized === 'vieweruserid' ||
    normalized === 'currentuserid' ||
    normalized === 'loggedinuserid' ||
    normalized === 'authenticateduserid' ||
    normalized === 'accountuserid'
  );
}

function findViewerId(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
): { id: unknown; path: string } | null {
  if (depth > 5 || value === null || typeof value !== 'object') return null;
  const object = value as object;
  if (seen.has(object)) return null;
  seen.add(object);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findViewerId(value[index], `${path}[${index}]`, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (keyLooksLikeViewer(key)) {
      const id = normalizeViewerId(child);
      if (id) return { id, path: `${path}.${key}` };
    }
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['viewer', 'currentuser', 'loggedinuser', 'account'].includes(normalizedKey)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const nestedRecord = child as Record<string, unknown>;
        for (const nestedKey of ['id', 'rest_id', 'user_id', 'userId']) {
          const nestedId = normalizeViewerId(nestedRecord[nestedKey]);
          if (nestedId) return { id: nestedId, path: `${path}.${key}.${nestedKey}` };
        }
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    const found = findViewerId(child, `${path}.${key}`, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function readSessionStateEvidence(now: number): IdentityEvidence | null {
  const globalObject = globalRecord();
  for (const key of [
    '__INITIAL_STATE__',
    '__NEXT_DATA__',
    '__NEXT_REDUX_STATE__',
    '__INITIAL_PROPS__',
    '__PRELOADED_STATE__',
  ]) {
    const found = findViewerId(globalObject[key], key, 0, new Set<object>());
    if (found) return evidence(found.id, found.path, 'session_state', now, 70);
  }
  return null;
}

function readNavigationEvidence(now: number): IdentityEvidence | null {
  const historyState = (globalRecord().history as History | undefined)?.state;
  const found = findViewerId(historyState, 'history.state', 0, new Set<object>());
  return found ? evidence(found.id, found.path, 'navigation_state', now, 65) : null;
}

export function collectIdentityEvidence(now = Date.now()): IdentityEvidence[] {
  const values = [
    readMetadataEvidence(now),
    readSessionStateEvidence(now),
    readNavigationEvidence(now),
  ].filter((item): item is IdentityEvidence => item !== null);
  const byClass = new Map<IdentitySignalClass, IdentityEvidence>();
  for (const item of values) {
    if (!byClass.has(item.signal_class)) byClass.set(item.signal_class, item);
  }
  return [...byClass.values()];
}

function parsePairing(value: unknown): PairingContext | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const required = [
    'base_url',
    'token',
    'archive_id',
    'namespace_id',
    'client_id',
    'client_epoch',
    'viewer_id',
  ];
  if (required.some((key) => typeof source[key] !== 'string' || !String(source[key]).trim()))
    return null;
  const baseUrl = String(source.base_url).trim();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return null;
  return {
    base_url: baseUrl.replace(/\/$/, ''),
    token: String(source.token),
    archive_id: String(source.archive_id),
    namespace_id: String(source.namespace_id),
    client_id: String(source.client_id),
    client_epoch: String(source.client_epoch),
    viewer_id: String(source.viewer_id),
    ...(typeof source.origin === 'string' && source.origin ? { origin: source.origin } : {}),
  };
}

export function readPairingContext(): PairingContext | null {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  const getValue = globalObject.GM_getValue;
  if (typeof getValue === 'function') {
    try {
      const raw = (getValue as (key: string) => unknown)(PAIRING_STORAGE_KEY);
      return parsePairing(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {
      return null;
    }
  }
  return null;
}

export function redactPairing(
  context: PairingContext | null,
): Omit<PairingContext, 'token'> | null {
  if (!context) return null;
  const { token, ...safe } = context;
  void token;
  return safe;
}

export class IdentityController {
  readonly state: Signal<IdentitySnapshot> = signal(INITIAL_IDENTITY);
  private readonly pairing: PairingContext | null;
  private readonly now: () => number;
  private readonly suppliedEvidence: IdentityEvidence[] = [];

  constructor(pairing: PairingContext | null, now: () => number = () => Date.now()) {
    this.pairing = pairing;
    this.now = now;
  }

  setEvidence(items: IdentityEvidence[]): void {
    this.suppliedEvidence.splice(0, this.suppliedEvidence.length, ...items);
  }

  observe(
    items: IdentityEvidence[] = this.suppliedEvidence.length
      ? this.suppliedEvidence
      : collectIdentityEvidence(),
  ): IdentityAssessment {
    const now = this.now();
    const fresh = items.filter(
      (item) =>
        item.observed_at_ms >= now - IDENTITY_OBSERVATION_WINDOW_MS &&
        item.observed_at_ms <= now + 30_000 &&
        isXOrigin(item.origin),
    );
    const byViewer = new Map<string, IdentityEvidence[]>();
    for (const item of fresh) {
      const current = byViewer.get(item.viewer_id) ?? [];
      current.push(item);
      byViewer.set(item.viewer_id, current);
    }
    const corroborated = [...byViewer.entries()].filter(
      ([, entries]) => new Set(entries.map((entry) => entry.signal_class)).size >= 2,
    );

    if (!fresh.length) return this.transition('unverified', null, [], 'identity-signal-missing');
    if (new Set(fresh.map((item) => item.viewer_id)).size > 1) {
      return this.transition('ambiguous', null, fresh, 'conflicting-viewer-identities');
    }
    const firstCorroborated = corroborated[0];
    if (corroborated.length !== 1 || !firstCorroborated) {
      return this.transition(
        corroborated.length > 1 ? 'ambiguous' : 'candidate',
        firstCorroborated?.[0] ?? fresh[0]?.viewer_id ?? null,
        fresh,
        corroborated.length > 1 ? 'conflicting-viewer-identities' : 'corroboration-required',
      );
    }

    const [viewerId, matched] = firstCorroborated;
    if (!this.pairing)
      return this.transition('candidate', viewerId, matched, 'companion-pairing-missing');
    if (viewerId !== this.pairing.viewer_id) {
      return this.transition('ambiguous', viewerId, matched, 'viewer-does-not-match-pairing');
    }
    return this.transition('active', viewerId, matched, 'identity-and-pairing-verified');
  }

  private transition(
    state: IdentityState,
    viewerId: string | null,
    evidenceItems: IdentityEvidence[],
    reason: string,
  ): IdentityAssessment {
    const next: IdentitySnapshot = {
      state,
      viewer_id: viewerId,
      namespace_id: state === 'active' ? (this.pairing?.namespace_id ?? null) : null,
      evidence: evidenceItems,
      reason,
      changed_at_ms: this.now(),
    };
    this.state.value = next;
    return {
      admitted: state === 'active',
      state,
      viewer_id: viewerId,
      reason,
      evidence: evidenceItems,
    };
  }
}

export function identityStatusSnapshot(controller: IdentityController): IdentitySnapshot {
  return controller.state.value;
}
