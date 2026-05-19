import { Interceptor } from '@/core/extensions';
import { options } from '@/core/options';
import { RawCaptureStats, RawEventEnvelopeV1 } from '@/types/raw-event';
import { isDiagnosticCaptureEnabled } from '@/utils/diagnostics';
import { getPolicyClass, shouldCaptureByPolicy } from './privacy-policy';

const RAW_SCHEMA = 'twe.raw.v1';
const RAW_EVENT_BUFFER_KEY = '__twe_raw_events_v1';
const RAW_EVENT_EMIT_NAME = 'twe:raw-event-v1';
const RAW_CAPTURE_STATS_KEY = '__twe_raw_capture_stats_v1';
const ROUTE_EPOCH_KEY = '__twe_route_epoch_v1';
const RAW_CAPTURE_SESSION_KEY = '__twe_raw_capture_session_id_v1';
const RAW_CAPTURE_TAB_KEY = '__twe_raw_capture_tab_id_v1';
const RAW_CAPTURE_EVENT_REV = 1;
const RAW_EVENT_BUFFER_LIMIT_DEFAULT = 48;
const RAW_EVENT_BUFFER_LIMIT_DIAGNOSTIC = 160;
const RESPONSE_SAMPLE_MAX_CHARS = 4096;
const RESPONSE_SAMPLE_MAX_CHARS_DIAGNOSTIC = 32768;

const RAW_SPOOL_DB_NAME = 'twitter-web-exporter-raw-spool-v1';
const RAW_SPOOL_STORE_NAME = 'events';
const RAW_SPOOL_MAX_ROWS = 5000;
const RAW_SPOOL_FLUSH_BATCH_SIZE = 50;
const RAW_SPOOL_FLUSH_INTERVAL_MS = 2500;
const RAW_SPOOL_MAINTENANCE_EVERY_TICKS = 8;
const RAW_SPOOL_FLUSH_TIMER_KEY = '__twe_raw_spool_flush_timer_v1';
const RAW_SPOOL_STATE_EVENT_NAME = 'twe:raw-spool-state-v1';
const RAW_SPOOL_DEV_CLEAR_KEY = '__twe_raw_spool_clear_v1';
const RAW_ROUTE_MONITOR_TIMER_KEY = '__twe_raw_route_monitor_timer_v1';
const RAW_VIEWPORT_MONITOR_TIMER_KEY = '__twe_raw_viewport_monitor_timer_v1';
const RAW_MONITOR_COORD_TIMER_KEY = '__twe_raw_monitor_coord_timer_v1';
const RAW_MONITOR_COORDINATION_KEY = '__twe_raw_monitor_coordination_v1';
const RAW_MONITOR_METRICS_KEY = '__twe_raw_monitor_metrics_v1';
const RAW_MONITOR_STORAGE_LISTENER_KEY = '__twe_raw_monitor_storage_listener_v1';
const RAW_MONITOR_BEFOREUNLOAD_KEY = '__twe_raw_monitor_beforeunload_v1';
const RAW_MONITOR_DEV_TICK_KEY = '__twe_raw_monitor_tick_v1';
const RAW_MONITOR_ROLE_EVENT_NAME = 'twe:raw-monitor-role-v1';
const RAW_ROUTE_MONITOR_INTERVAL_MS = 2500;
const RAW_VIEWPORT_MONITOR_INTERVAL_MS = 4000;
const RAW_VIEWPORT_SEEN_WINDOW_MS = 60000;
const RAW_VIEWPORT_SCAN_LIMIT = 40;
const RAW_VIEWPORT_MIN_VISIBLE_PX = 48;
const RAW_MONITOR_HEARTBEAT_MS = 5000;
const RAW_MONITOR_STALE_MS = 20000;

const RAW_DAEMON_BASE_URL_STORAGE_KEY = 'twe_raw_capture_daemon_url_v1';
const RAW_DAEMON_STREAM_ENABLED_STORAGE_KEY = 'twe_raw_capture_stream_enabled_v1';
const RAW_CAPTURE_ENABLED_STORAGE_KEY = 'twe_raw_capture_enabled_v1';
const RAW_CAPTURE_ENCRYPTION_READY_STORAGE_KEY = 'twe_raw_capture_encryption_ready_v1';
const RAW_CAPTURE_DM_SESSION_ARMED_UNTIL_STORAGE_KEY =
  'twe_raw_capture_dm_session_armed_until_ms_v1';
const RAW_CAPTURE_DM_SESSION_DEFAULT_ARM_MS = 15 * 60 * 1000;
const RAW_MONITOR_LEADER_STORAGE_KEY = 'twe_raw_monitor_leader_v1';

const VOLATILE_QUERY_KEYS = new Set([
  's',
  't',
  'cn',
  'ref_src',
  'ref_url',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
]);

const REDACT_QUERY_KEY_REGEX =
  /(token|auth|authorization|cookie|csrf|sig|signature|bearer|session|oauth)/i;

interface RawSpoolRecord {
  event_id: string;
  wall_time_ms: number;
  created_at: number;
  attempts: number;
  next_retry_at: number;
  payload: RawEventEnvelopeV1;
}

interface RawMonitorLeaderLease {
  tab_id: string;
  session_id?: string;
  heartbeat_ms: number;
  acquired_ms: number;
}

let sequence = 0;
let lastEventHash = '';
let spoolDbPromise: Promise<IDBDatabase> | null = null;
let flushInFlight = false;
let spoolMaintenanceTick = 0;
let spoolUnavailableUntil = 0;
let lastSpoolStateSignature = '';
let lastMonitorRoleSignature = '';
let lastObservedRouteUrl = '';
const viewportSeenAt = new Map<string, number>();

function getWindowRecord(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function clearWindowTimer(key: string): void {
  const g = getWindowRecord();
  const timer = g[key];
  if (!(typeof timer === 'number' || typeof timer === 'object')) {
    return;
  }
  try {
    clearInterval(timer as ReturnType<typeof setInterval>);
  } catch {
    // ignore
  }
  delete g[key];
}

function readMonitorMetrics(): Record<string, number> {
  const g = getWindowRecord();
  const raw = g[RAW_MONITOR_METRICS_KEY];
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = toNumber(value, 0);
  }
  return out;
}

function bumpMonitorMetric(key: string, by = 1): void {
  if (!key) return;
  const g = getWindowRecord();
  const metrics = readMonitorMetrics();
  metrics[key] = toNumber(metrics[key], 0) + Math.max(1, toNumber(by, 1));
  g[RAW_MONITOR_METRICS_KEY] = metrics;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16)}`;
}

function makeId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function ensureStableId(key: string, prefix: string): string {
  const g = getWindowRecord();
  const existing = g[key];
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const next = makeId(prefix);
  g[key] = next;
  return next;
}

function sanitizeUrl(url: string, stripVolatile: boolean): string {
  try {
    const parsed = new URL(url, location.href);
    const next = new URL(parsed.toString());

    const keys = [...next.searchParams.keys()];
    for (const key of keys) {
      if (REDACT_QUERY_KEY_REGEX.test(key)) {
        next.searchParams.delete(key);
        continue;
      }
      if (stripVolatile && VOLATILE_QUERY_KEYS.has(key.toLowerCase())) {
        next.searchParams.delete(key);
      }
    }

    const sorted = [...next.searchParams.entries()].sort(([ak, av], [bk, bv]) => {
      if (ak === bk) return av.localeCompare(bv);
      return ak.localeCompare(bk);
    });

    next.search = '';
    for (const [key, value] of sorted) {
      next.searchParams.append(key, value);
    }

    return next.toString();
  } catch {
    return url;
  }
}

function parseSearchMode(search: string): string {
  try {
    const params = new URLSearchParams(search || '');
    const raw = (params.get('f') || params.get('src') || '').toLowerCase();
    if (raw.includes('live') || raw.includes('latest')) return 'latest';
    if (raw.includes('user') || raw.includes('people')) return 'people';
    if (raw.includes('image') || raw.includes('media')) return 'media';
    if (raw.includes('top')) return 'top';
  } catch {
    // ignore
  }
  return 'top';
}

function deriveRouteType(pathname: string, search: string = ''): string {
  if (/^\/home\/?$/.test(pathname)) return 'home';
  if (/^\/i\/bookmarks(\/|$)/.test(pathname)) return 'bookmarks';
  if (/\/status\/\d+/.test(pathname)) return 'tweet_detail';
  if (/^\/notifications(\/|$)/.test(pathname)) return 'notifications';
  if (/^\/search\/?$/.test(pathname)) {
    const mode = parseSearchMode(search);
    if (mode === 'latest') return 'search_latest';
    if (mode === 'people') return 'search_people';
    if (mode === 'media') return 'search_media';
    return 'search_top';
  }
  if (/^\/i\/lists\/\d+\/(members)(\/|$)/.test(pathname)) return 'list_members';
  if (/^\/i\/lists\/\d+\/(followers|subscribers)(\/|$)/.test(pathname)) return 'list_subscribers';
  if (/^\/i\/lists\//.test(pathname)) return 'list';
  if (/^\/i\/communities\/\d+\/(members)(\/|$)/.test(pathname)) return 'community_members';
  if (/^\/i\/communities\//.test(pathname)) return 'community';
  if (/^\/[A-Za-z0-9_]+\/(followers)(\/|$)/.test(pathname)) return 'followers';
  if (/^\/[A-Za-z0-9_]+\/(following)(\/|$)/.test(pathname)) return 'following';
  if (/^\/[A-Za-z0-9_]+\/(with_replies)(\/|$)/.test(pathname)) return 'user_profile_replies';
  if (/^\/[A-Za-z0-9_]+\/(media)(\/|$)/.test(pathname)) return 'user_profile_media';
  if (/^\/[A-Za-z0-9_]+\/(likes)(\/|$)/.test(pathname)) return 'user_profile_likes';
  if (/^\/messages(\/|$)/.test(pathname)) return 'messages';
  if (/^\/[A-Za-z0-9_]+\/?$/.test(pathname)) return 'user_profile_tweets';
  return 'unknown';
}

function deriveRouteParams(
  pathname: string,
  search: string = '',
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const reservedProfileRoots = new Set([
    'home',
    'search',
    'notifications',
    'messages',
    'explore',
    'i',
  ]);

  const tweetMatch = pathname.match(/\/status\/(\d+)/);
  if (tweetMatch?.[1]) {
    out.tweetId = tweetMatch[1];
  }

  const bookmarkMatch = pathname.match(/\/i\/bookmarks\/(\d+)/);
  if (bookmarkMatch?.[1]) {
    out.folderId = bookmarkMatch[1];
  }

  const listMatch = pathname.match(/\/i\/lists\/(\d+)/);
  if (listMatch?.[1]) {
    out.listId = listMatch[1];
  }

  const communityMatch = pathname.match(/\/i\/communities\/(\d+)/);
  if (communityMatch?.[1]) {
    out.communityId = communityMatch[1];
  }

  const profileTabMatch = pathname.match(
    /^\/([A-Za-z0-9_]+)\/(with_replies|media|likes|followers|following)(\/|$)/,
  );
  if (profileTabMatch?.[1]) {
    out.screenName = profileTabMatch[1];
  }
  if (profileTabMatch?.[2]) {
    out.profileTab = profileTabMatch[2];
  }

  const profileRootMatch = pathname.match(/^\/([A-Za-z0-9_]+)\/?$/);
  if (
    profileRootMatch?.[1] &&
    !reservedProfileRoots.has(String(profileRootMatch[1]).toLowerCase())
  ) {
    out.screenName = profileRootMatch[1];
  }

  if (/^\/search\/?$/.test(pathname)) {
    out.searchMode = parseSearchMode(search);
  }

  return Object.keys(out).length ? out : undefined;
}

function inferResponseContentType(responseText: string): string {
  const trimmed = responseText.trim();
  if (!trimmed) return 'text/plain';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'application/json';
  return 'text/plain';
}

function readMonitorLeaderLease(): RawMonitorLeaderLease | null {
  const raw = readLocalStorageString(RAW_MONITOR_LEADER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RawMonitorLeaderLease>;
    if (!parsed || typeof parsed !== 'object') return null;
    const tabId = typeof parsed.tab_id === 'string' ? parsed.tab_id : '';
    if (!tabId) return null;
    const heartbeatMs = toNumber(parsed.heartbeat_ms, 0);
    const acquiredMs = toNumber(parsed.acquired_ms, 0);
    return {
      tab_id: tabId,
      session_id: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
      heartbeat_ms: heartbeatMs,
      acquired_ms: acquiredMs,
    };
  } catch {
    return null;
  }
}

function writeMonitorLeaderLease(lease: RawMonitorLeaderLease): RawMonitorLeaderLease | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.setItem(RAW_MONITOR_LEADER_STORAGE_KEY, JSON.stringify(lease));
  } catch {
    return null;
  }
  return readMonitorLeaderLease();
}

function clearMonitorLeaderLeaseIfOwned(tabId: string): void {
  if (!tabId) return;
  try {
    if (typeof localStorage === 'undefined') return;
    const current = readMonitorLeaderLease();
    if (!current || current.tab_id !== tabId) return;
    localStorage.removeItem(RAW_MONITOR_LEADER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function patchMonitorStats(patch: Partial<RawCaptureStats>): void {
  const stats = readStats();
  writeStats({
    ...stats,
    ...patch,
  });
}

function publishMonitorCoordinationState(
  role: 'leader' | 'follower' | 'single',
  leaderTabId: string,
  leaseHeartbeatMs: number,
): void {
  const g = getWindowRecord();
  const state = {
    role,
    tab_id: ensureStableId(RAW_CAPTURE_TAB_KEY, 'tab'),
    leader_tab_id: leaderTabId || undefined,
    lease_heartbeat_ms: leaseHeartbeatMs || 0,
    updated_at_ms: Date.now(),
  };
  g[RAW_MONITOR_COORDINATION_KEY] = state;

  patchMonitorStats({
    monitor_role: role,
    monitor_leader_tab_id: leaderTabId || undefined,
    monitor_last_heartbeat_ms: leaseHeartbeatMs || 0,
  });

  const signature = `${state.role}|${state.tab_id}|${state.leader_tab_id || ''}|${
    state.lease_heartbeat_ms || 0
  }`;
  if (signature !== lastMonitorRoleSignature) {
    lastMonitorRoleSignature = signature;
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent(RAW_MONITOR_ROLE_EVENT_NAME, {
            detail: state,
          }),
        );
      } catch {
        // ignore
      }
    }
  }
}

function refreshMonitorCoordination(forceHeartbeat = false): void {
  const tabId = ensureStableId(RAW_CAPTURE_TAB_KEY, 'tab');
  const sessionId = ensureStableId(RAW_CAPTURE_SESSION_KEY, 'session');
  const now = Date.now();

  let lease = readMonitorLeaderLease();

  // If localStorage is unavailable, degrade to single-tab behavior.
  if (!lease) {
    const fallback: RawMonitorLeaderLease = {
      tab_id: tabId,
      session_id: sessionId,
      heartbeat_ms: now,
      acquired_ms: now,
    };
    const written = writeMonitorLeaderLease(fallback);
    if (!written) {
      publishMonitorCoordinationState('single', tabId, now);
      return;
    }
    lease = written;
  }

  const leaseIsStale =
    toNumber(lease.heartbeat_ms, 0) <= 0 ||
    now - toNumber(lease.heartbeat_ms, 0) > RAW_MONITOR_STALE_MS;
  const weOwnLease = lease.tab_id === tabId;

  if (leaseIsStale || weOwnLease) {
    const shouldHeartbeat =
      forceHeartbeat ||
      !weOwnLease ||
      now - toNumber(lease.heartbeat_ms, 0) >= Math.floor(RAW_MONITOR_HEARTBEAT_MS / 2);

    if (shouldHeartbeat) {
      const renewed: RawMonitorLeaderLease = {
        tab_id: tabId,
        session_id: sessionId,
        acquired_ms: weOwnLease ? toNumber(lease.acquired_ms, now) : now,
        heartbeat_ms: now,
      };
      const written = writeMonitorLeaderLease(renewed);
      if (written?.tab_id === tabId) {
        publishMonitorCoordinationState('leader', tabId, toNumber(written.heartbeat_ms, now));
        return;
      }
      lease = written || lease;
    }
  }

  const leaderTabId = typeof lease.tab_id === 'string' ? lease.tab_id : '';
  publishMonitorCoordinationState('follower', leaderTabId, toNumber(lease.heartbeat_ms, 0));
}

function isPassiveMonitorLeader(): boolean {
  const g = getWindowRecord();
  const forced = g.__twe_raw_monitor_force_leader_v1;
  if (typeof forced === 'boolean') {
    return forced;
  }
  const stateRaw = g[RAW_MONITOR_COORDINATION_KEY];
  const state =
    stateRaw && typeof stateRaw === 'object' ? (stateRaw as Record<string, unknown>) : undefined;
  if (!state || typeof state.role !== 'string') {
    refreshMonitorCoordination(true);
    const next = g[RAW_MONITOR_COORDINATION_KEY];
    const nextState =
      next && typeof next === 'object' ? (next as Record<string, unknown>) : undefined;
    return nextState?.role === 'leader' || nextState?.role === 'single';
  }
  return state.role === 'leader' || state.role === 'single';
}

function getRuntimeModeSnapshot(): RawEventEnvelopeV1['recorder'] {
  const g = getWindowRecord();
  const rawStats = readStats();

  const runtimeModes = g.__twe_runtime_modes_v1;
  const runtime = g.__twe_runtime_v1;

  const modesObject =
    runtimeModes && typeof runtimeModes === 'object'
      ? (runtimeModes as Record<string, unknown>)
      : undefined;

  const runtimeObject =
    runtime && typeof runtime === 'object' ? (runtime as Record<string, unknown>) : undefined;

  const hookRev =
    toNumber(runtimeObject?.revision, 0) || toNumber(runtimeObject?.rev, 0) || undefined;

  const capabilitiesRaw = runtimeObject?.capabilities;
  const capabilitiesObject =
    capabilitiesRaw && typeof capabilitiesRaw === 'object'
      ? (capabilitiesRaw as Record<string, unknown>)
      : undefined;

  return {
    recorder_rev: RAW_CAPTURE_EVENT_REV,
    hook_rev: hookRev,
    modes: {
      safeMode: !!modesObject?.safeMode,
      hookMode: typeof modesObject?.hookMode === 'string' ? modesObject.hookMode : undefined,
      repairMode: typeof modesObject?.repairMode === 'string' ? modesObject.repairMode : undefined,
    },
    capabilities: {
      hasExportFunction: !!capabilitiesObject?.hasExportFunction,
      hasWrappedJSObject: !!capabilitiesObject?.hasWrappedJSObject,
    },
    spool: {
      queued: toNumber(rawStats.spool_count, 0),
      enqueued_total: toNumber(rawStats.spool_enqueued, 0),
      flushed_total: toNumber(rawStats.spool_flushed, 0),
      failed_total: toNumber(rawStats.spool_failed, 0),
      oldest_pending_age_ms: toNumber(rawStats.oldest_pending_age_ms, 0),
    },
    coordination: {
      role:
        rawStats.monitor_role === 'leader' ||
        rawStats.monitor_role === 'follower' ||
        rawStats.monitor_role === 'single'
          ? rawStats.monitor_role
          : undefined,
      leader_tab_id:
        typeof rawStats.monitor_leader_tab_id === 'string'
          ? rawStats.monitor_leader_tab_id
          : undefined,
      lease_heartbeat_ms: toNumber(rawStats.monitor_last_heartbeat_ms, 0) || undefined,
    },
  };
}

function nextRouteEpoch(): number {
  const g = getWindowRecord();
  const next = toNumber(g[ROUTE_EPOCH_KEY], 0) + 1;
  g[ROUTE_EPOCH_KEY] = next;
  return next;
}

function computeLinkedEventHash(
  eventId: string,
  wall: number,
  seed: string,
): {
  prevHash?: string;
  eventHash: string;
} {
  const prevHash = lastEventHash || undefined;
  const eventHash = hashText(`${prevHash || ''}|${eventId}|${wall}|${seed}`);
  lastEventHash = eventHash;
  return {
    prevHash,
    eventHash,
  };
}

function getAccountHint(): RawEventEnvelopeV1['account_hint'] {
  const meta = getWindowRecord().__META_DATA__;
  const metaObj = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined;
  const userRestId = typeof metaObj?.userId === 'string' ? metaObj.userId : undefined;
  return userRestId ? { user_rest_id: userRestId } : undefined;
}

function buildEnvelope(
  req: { method: string; url: string; body?: string; requestId?: string },
  res: {
    status: number;
    responseText: string;
  },
): RawEventEnvelopeV1 {
  const wall = Date.now();
  const mono = typeof performance !== 'undefined' ? Number(performance.now()) : 0;
  const pageUrl = typeof location !== 'undefined' ? location.href : '';
  const pathname = typeof location !== 'undefined' ? location.pathname : '';
  const search = typeof location !== 'undefined' ? location.search : '';

  const reqBodyHash = typeof req.body === 'string' && req.body ? hashText(req.body) : undefined;

  const responseText = typeof res.responseText === 'string' ? res.responseText : '';
  const respHash = hashText(responseText);
  const responseSampleLimit = getResponseSampleLimit();
  const truncated = responseText.length > responseSampleLimit;
  const responseSample = truncated ? responseText.slice(0, responseSampleLimit) : responseText;

  const eventId = req.requestId && req.requestId.length > 0 ? req.requestId : makeId('evt');
  const { prevHash, eventHash } = computeLinkedEventHash(
    eventId,
    wall,
    `${req.method}|${req.url}|${res.status}|${respHash}`,
  );

  return {
    schema: RAW_SCHEMA,
    event_id: eventId,
    prev_event_hash: prevHash,
    event_hash: eventHash,
    wall_time_ms: wall,
    mono_time_ms: mono,
    tz_offset_min: new Date().getTimezoneOffset(),
    page_url: pageUrl,
    route_type: deriveRouteType(pathname, search),
    route_params: deriveRouteParams(pathname, search),
    route_epoch: nextRouteEpoch(),
    kind: 'net',
    session_id: ensureStableId(RAW_CAPTURE_SESSION_KEY, 'session'),
    tab_id: ensureStableId(RAW_CAPTURE_TAB_KEY, 'tab'),
    account_hint: getAccountHint(),
    net: {
      transport: req.method.toUpperCase() === 'GET' ? 'xhr' : 'fetch',
      phase: 'response',
      method: req.method.toUpperCase(),
      url_raw_redacted: sanitizeUrl(req.url, false),
      url_norm: sanitizeUrl(req.url, true),
      status: res.status,
      req_body_hash: reqBodyHash,
      resp_content_type: inferResponseContentType(responseText),
      resp_body_ref: `sha:${respHash}`,
      resp_body_hash: respHash,
      resp_body_size: responseText.length,
      resp_truncated: truncated,
      resp_body_sample: responseSample,
    },
    recorder: getRuntimeModeSnapshot(),
  };
}

function getResponseSampleLimit(): number {
  if (isDiagnosticCaptureEnabled() || isDaemonStreamingEnabled()) {
    return RESPONSE_SAMPLE_MAX_CHARS_DIAGNOSTIC;
  }
  return RESPONSE_SAMPLE_MAX_CHARS;
}

function getRawEventBufferLimit(): number {
  if (isDiagnosticCaptureEnabled() || isDaemonStreamingEnabled()) {
    return RAW_EVENT_BUFFER_LIMIT_DIAGNOSTIC;
  }
  return RAW_EVENT_BUFFER_LIMIT_DEFAULT;
}

function buildRouteEnvelope(source: string): RawEventEnvelopeV1 {
  const wall = Date.now();
  const mono = typeof performance !== 'undefined' ? Number(performance.now()) : 0;
  const pageUrl = typeof location !== 'undefined' ? location.href : '';
  const pathname = typeof location !== 'undefined' ? location.pathname : '';
  const search = typeof location !== 'undefined' ? location.search : '';
  const hash = typeof location !== 'undefined' ? location.hash : '';
  const eventId = makeId('route');
  const { prevHash, eventHash } = computeLinkedEventHash(
    eventId,
    wall,
    `route|${source}|${pageUrl}|${pathname}|${search}|${hash}`,
  );

  return {
    schema: RAW_SCHEMA,
    event_id: eventId,
    prev_event_hash: prevHash,
    event_hash: eventHash,
    wall_time_ms: wall,
    mono_time_ms: mono,
    tz_offset_min: new Date().getTimezoneOffset(),
    page_url: pageUrl,
    route_type: deriveRouteType(pathname, search),
    route_params: deriveRouteParams(pathname, search),
    route_epoch: nextRouteEpoch(),
    kind: 'route',
    session_id: ensureStableId(RAW_CAPTURE_SESSION_KEY, 'session'),
    tab_id: ensureStableId(RAW_CAPTURE_TAB_KEY, 'tab'),
    account_hint: getAccountHint(),
    route: {
      source,
      pathname,
      search,
      hash,
    },
    recorder: getRuntimeModeSnapshot(),
  };
}

function buildViewportEnvelope(tweetId: string, source = 'dom-scan'): RawEventEnvelopeV1 {
  const wall = Date.now();
  const mono = typeof performance !== 'undefined' ? Number(performance.now()) : 0;
  const pageUrl = typeof location !== 'undefined' ? location.href : '';
  const pathname = typeof location !== 'undefined' ? location.pathname : '';
  const search = typeof location !== 'undefined' ? location.search : '';
  const eventId = makeId('vp');
  const { prevHash, eventHash } = computeLinkedEventHash(
    eventId,
    wall,
    `viewport|${source}|${tweetId}|${pageUrl}|${pathname}`,
  );

  return {
    schema: RAW_SCHEMA,
    event_id: eventId,
    prev_event_hash: prevHash,
    event_hash: eventHash,
    wall_time_ms: wall,
    mono_time_ms: mono,
    tz_offset_min: new Date().getTimezoneOffset(),
    page_url: pageUrl,
    route_type: deriveRouteType(pathname, search),
    route_params: deriveRouteParams(pathname, search),
    route_epoch: toNumber(getWindowRecord()[ROUTE_EPOCH_KEY], 0),
    kind: 'viewport',
    session_id: ensureStableId(RAW_CAPTURE_SESSION_KEY, 'session'),
    tab_id: ensureStableId(RAW_CAPTURE_TAB_KEY, 'tab'),
    account_hint: getAccountHint(),
    viewport: {
      tweet_id: tweetId,
      source,
    },
    recorder: getRuntimeModeSnapshot(),
  };
}

function readStats(): RawCaptureStats {
  const g = getWindowRecord();
  const current = g[RAW_CAPTURE_STATS_KEY];
  if (!current || typeof current !== 'object') {
    return {
      total: 0,
      emitted: 0,
      dropped: 0,
      last_at: 0,
      spool_count: 0,
      spool_enqueued: 0,
      spool_flushed: 0,
      spool_failed: 0,
      spool_drop_overflow: 0,
      spool_unavailable: 0,
      oldest_pending_age_ms: 0,
      daemon_online: false,
      monitor_role: 'single',
      monitor_leader_tab_id: undefined,
      monitor_last_heartbeat_ms: 0,
      monitor_ticks_route: 0,
      monitor_ticks_viewport: 0,
      monitor_suppressed_route: 0,
      monitor_suppressed_viewport: 0,
    };
  }

  const c = current as Partial<RawCaptureStats>;
  return {
    total: toNumber(c.total, 0),
    emitted: toNumber(c.emitted, 0),
    dropped: toNumber(c.dropped, 0),
    last_at: toNumber(c.last_at, 0),
    last_event_id: typeof c.last_event_id === 'string' ? c.last_event_id : undefined,
    last_event_hash: typeof c.last_event_hash === 'string' ? c.last_event_hash : undefined,
    spool_count: toNumber(c.spool_count, 0),
    spool_enqueued: toNumber(c.spool_enqueued, 0),
    spool_flushed: toNumber(c.spool_flushed, 0),
    spool_failed: toNumber(c.spool_failed, 0),
    spool_drop_overflow: toNumber(c.spool_drop_overflow, 0),
    spool_unavailable: toNumber(c.spool_unavailable, 0),
    oldest_pending_age_ms: toNumber(c.oldest_pending_age_ms, 0),
    daemon_online: !!c.daemon_online,
    daemon_last_flush_at: toNumber(c.daemon_last_flush_at, 0) || undefined,
    daemon_last_error: typeof c.daemon_last_error === 'string' ? c.daemon_last_error : undefined,
    monitor_role:
      c.monitor_role === 'leader' || c.monitor_role === 'follower' || c.monitor_role === 'single'
        ? c.monitor_role
        : undefined,
    monitor_leader_tab_id:
      typeof c.monitor_leader_tab_id === 'string' ? c.monitor_leader_tab_id : undefined,
    monitor_last_heartbeat_ms: toNumber(c.monitor_last_heartbeat_ms, 0),
    monitor_ticks_route: toNumber(c.monitor_ticks_route, 0),
    monitor_ticks_viewport: toNumber(c.monitor_ticks_viewport, 0),
    monitor_suppressed_route: toNumber(c.monitor_suppressed_route, 0),
    monitor_suppressed_viewport: toNumber(c.monitor_suppressed_viewport, 0),
  };
}

function writeStats(next: RawCaptureStats): void {
  const g = getWindowRecord();
  g[RAW_CAPTURE_STATS_KEY] = next;

  const signature = [
    toNumber(next.spool_count, 0),
    toNumber(next.spool_enqueued, 0),
    toNumber(next.spool_flushed, 0),
    toNumber(next.spool_failed, 0),
    toNumber(next.spool_drop_overflow, 0),
    toNumber(next.spool_unavailable, 0),
    toNumber(next.oldest_pending_age_ms, 0),
    next.daemon_online ? 1 : 0,
  ].join('|');
  if (signature !== lastSpoolStateSignature) {
    lastSpoolStateSignature = signature;
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent(RAW_SPOOL_STATE_EVENT_NAME, {
            detail: {
              stats: next,
            },
          }),
        );
      } catch {
        // ignore
      }
    }
  }
}

function patchStats(patch: Partial<RawCaptureStats>): void {
  const current = readStats();
  writeStats({ ...current, ...patch });
}

function pushToGlobalBuffer(event: RawEventEnvelopeV1): void {
  const g = getWindowRecord();
  const current = g[RAW_EVENT_BUFFER_KEY];
  const events = Array.isArray(current) ? (current as RawEventEnvelopeV1[]) : [];

  events.push(event);

  let dropped = 0;
  const limit = getRawEventBufferLimit();
  if (events.length > limit) {
    dropped = events.length - limit;
  }

  if (dropped > 0) {
    events.splice(0, dropped);
  }
  g[RAW_EVENT_BUFFER_KEY] = events;

  const stats = readStats();
  writeStats({
    ...stats,
    total: stats.total + 1,
    emitted: stats.emitted + 1,
    dropped: stats.dropped + dropped,
    last_at: Date.now(),
    last_event_id: event.event_id,
    last_event_hash: event.event_hash,
  });

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent(RAW_EVENT_EMIT_NAME, {
          detail: event,
        }),
      );
    } catch {
      // ignore
    }
  }
}

function emitSupplementalEvent(event: RawEventEnvelopeV1): void {
  pushToGlobalBuffer(event);
  if (isDaemonStreamingEnabled()) {
    void enqueueSpoolEvent(event);
    void flushSpoolToDaemon();
  }
}

function isSupplementalMonitoringEnabled(): boolean {
  if (!isRawCaptureEnabled()) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return false;
  }
  return isDaemonStreamingEnabled() || isDiagnosticCaptureEnabled() || isRawCaptureDebugEnabled();
}

function monitorRouteChanges(): void {
  if (!isSupplementalMonitoringEnabled()) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!isPassiveMonitorLeader()) {
    bumpMonitorMetric('route_suppressed_checks', 1);
    const stats = readStats();
    writeStats({
      ...stats,
      monitor_suppressed_route: toNumber(stats.monitor_suppressed_route, 0) + 1,
    });
    return;
  }

  const roleStats = readStats();
  writeStats({
    ...roleStats,
    monitor_ticks_route: toNumber(roleStats.monitor_ticks_route, 0) + 1,
  });
  bumpMonitorMetric('route_leader_checks', 1);

  const currentUrl = typeof location !== 'undefined' ? location.href : '';
  if (!currentUrl) return;

  if (!lastObservedRouteUrl) {
    lastObservedRouteUrl = currentUrl;
    emitSupplementalEvent(buildRouteEnvelope('bootstrap'));
    bumpMonitorMetric('route_emits', 1);
    return;
  }

  if (currentUrl !== lastObservedRouteUrl) {
    lastObservedRouteUrl = currentUrl;
    emitSupplementalEvent(buildRouteEnvelope('poll'));
    bumpMonitorMetric('route_emits', 1);
  }
}

function parseTweetIdFromHref(href: string): string | null {
  const match = href.match(/\/status\/(\d+)/);
  if (!match?.[1]) return null;
  return match[1];
}

function isElementMostlyVisible(element: Element): boolean {
  if (!(element instanceof Element)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.bottom < RAW_VIEWPORT_MIN_VISIBLE_PX) return false;
  if (rect.top > window.innerHeight - RAW_VIEWPORT_MIN_VISIBLE_PX) return false;
  return true;
}

function collectVisibleTweetIds(limit = RAW_VIEWPORT_SCAN_LIMIT): string[] {
  if (typeof document === 'undefined') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates = document.querySelectorAll('article a[href*="/status/"]');
  for (const node of candidates) {
    if (out.length >= limit) break;
    if (!(node instanceof HTMLAnchorElement)) continue;
    if (!isElementMostlyVisible(node)) continue;
    const tweetId = parseTweetIdFromHref(node.getAttribute('href') || '');
    if (!tweetId || seen.has(tweetId)) continue;
    seen.add(tweetId);
    out.push(tweetId);
  }
  return out;
}

function cleanupViewportSeen(nowMs: number): void {
  for (const [tweetId, at] of viewportSeenAt.entries()) {
    if (nowMs - at > RAW_VIEWPORT_SEEN_WINDOW_MS) {
      viewportSeenAt.delete(tweetId);
    }
  }
}

function monitorViewportSightings(): void {
  if (!isSupplementalMonitoringEnabled()) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!isPassiveMonitorLeader()) {
    bumpMonitorMetric('viewport_suppressed_checks', 1);
    const stats = readStats();
    writeStats({
      ...stats,
      monitor_suppressed_viewport: toNumber(stats.monitor_suppressed_viewport, 0) + 1,
    });
    return;
  }

  const roleStats = readStats();
  writeStats({
    ...roleStats,
    monitor_ticks_viewport: toNumber(roleStats.monitor_ticks_viewport, 0) + 1,
  });
  bumpMonitorMetric('viewport_leader_checks', 1);

  const now = Date.now();
  cleanupViewportSeen(now);
  const ids = collectVisibleTweetIds();
  for (const tweetId of ids) {
    const seenAt = toNumber(viewportSeenAt.get(tweetId), 0);
    if (seenAt > 0 && now - seenAt < RAW_VIEWPORT_SEEN_WINDOW_MS) {
      continue;
    }
    viewportSeenAt.set(tweetId, now);
    emitSupplementalEvent(buildViewportEnvelope(tweetId));
    bumpMonitorMetric('viewport_emits', 1);
  }
}

function isRawCaptureEnabled(): boolean {
  const g = getWindowRecord();
  const globalFlag = g.__twe_raw_capture_enabled_v1;
  if (typeof globalFlag === 'boolean') {
    return globalFlag;
  }

  const optionFlag = options.get('rawCaptureEnabled', true);
  if (typeof optionFlag === 'boolean') {
    return optionFlag;
  }

  const local = readLocalStorageString(RAW_CAPTURE_ENABLED_STORAGE_KEY);
  if (!local) return true;
  return local !== '0' && local !== 'false';
}

function isRawCaptureDebugEnabled(): boolean {
  const g = getWindowRecord();
  if (g.__twe_raw_capture_dev_utils_v1 === true) {
    return true;
  }
  return !!options.get('debug', false);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return true;
  }
  return host.endsWith('.localhost');
}

function isInternalRecorderTraffic(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url, location.href);
    const daemon = new URL(getDaemonBaseUrl(), location.href);

    if (
      parsed.origin === daemon.origin &&
      /^\/(?:ingest|health|stats|query)(\/|$)/.test(parsed.pathname)
    ) {
      return true;
    }

    return (
      isLoopbackHostname(parsed.hostname) &&
      /^\/(?:ingest|health|stats|query)(\/|$)/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isDirectMessagesCaptureEnabled(): boolean {
  const optionFlag = options.get('directMessagesCaptureEnabled', false);
  return optionFlag === true && isEncryptedStorageReadyForDm() && isDmSessionArmed();
}

function isEncryptedStorageReadyForDm(): boolean {
  const g = getWindowRecord();
  if (g.__twe_raw_capture_encryption_ready_v1 === true) {
    return true;
  }
  const optionFlag = options.get('rawCaptureEncryptedStorageReady', false);
  if (optionFlag === true) {
    return true;
  }
  const local = readLocalStorageString(RAW_CAPTURE_ENCRYPTION_READY_STORAGE_KEY);
  if (!local) return false;
  const value = local.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function isDmSessionArmed(): boolean {
  const g = getWindowRecord();
  const armedUntilGlobal = toNumber(g.__twe_raw_capture_dm_session_armed_until_ms_v1, 0);
  const now = Date.now();
  if (armedUntilGlobal > now) {
    return true;
  }
  const local = readLocalStorageString(RAW_CAPTURE_DM_SESSION_ARMED_UNTIL_STORAGE_KEY);
  const armedUntilLocal = toNumber(local, 0);
  return armedUntilLocal > now;
}

function setDmSessionArmedUntil(armedUntilMs: number): void {
  const g = getWindowRecord();
  g.__twe_raw_capture_dm_session_armed_until_ms_v1 = armedUntilMs;
  try {
    localStorage.setItem(RAW_CAPTURE_DM_SESSION_ARMED_UNTIL_STORAGE_KEY, String(armedUntilMs));
  } catch {
    // ignore
  }
}

function isPolicyClassEnabled(policyClass: string): boolean {
  if (policyClass === 'sensitive') {
    return options.get('rawCapturePolicySensitiveEnabled', true) !== false;
  }
  if (policyClass === 'dm') {
    return options.get('rawCapturePolicyDmEnabled', true) !== false;
  }
  return options.get('rawCapturePolicyPublicEnabled', true) !== false;
}

function shouldBlockCaptureByRoutePolicy(): {
  blocked: boolean;
  routeType: string;
  policyClass: string;
} {
  let routeType = 'unknown';
  if (isDirectMessagesCaptureEnabled()) {
    return { blocked: false, routeType, policyClass: 'dm' };
  }
  try {
    routeType = deriveRouteType(location.pathname || '/', location.search || '');
    const policyClass = getPolicyClass(routeType);
    if (!isPolicyClassEnabled(policyClass)) {
      return { blocked: true, routeType, policyClass };
    }
    const allowed = shouldCaptureByPolicy(routeType, {
      dmCaptureAllowed: isDirectMessagesCaptureEnabled(),
    });
    return { blocked: !allowed, routeType, policyClass };
  } catch {
    return { blocked: false, routeType: 'unknown', policyClass: 'public' };
  }
}

function shouldCapture(req: { url: string }, res: { responseText: string }): boolean {
  if (!req.url) return false;
  if (!isRawCaptureEnabled()) return false;
  if (isInternalRecorderTraffic(req.url)) return false;
  const policyDecision = shouldBlockCaptureByRoutePolicy();
  if (policyDecision.blocked) {
    const stats = readStats();
    const statsRecord = stats as unknown as Record<string, unknown>;
    patchStats({
      dm_policy_blocks: toNumber(statsRecord.dm_policy_blocks, 0) + 1,
      dm_policy_last_route_type: policyDecision.routeType,
      dm_policy_last_policy_class: policyDecision.policyClass,
    });
    return false;
  }

  const isApiRoute = /\/graphql\/|\/api\/1\.1\//.test(req.url);
  if (!isApiRoute) return false;

  const text = String(res.responseText || '');
  if (!text) return false;

  return true;
}

function openSpoolDb(): Promise<IDBDatabase> {
  if (Date.now() < spoolUnavailableUntil) {
    return Promise.reject(new Error('raw spool unavailable'));
  }

  if (typeof indexedDB === 'undefined') {
    spoolUnavailableUntil = Date.now() + 60000;
    patchStats({
      spool_unavailable: toNumber(readStats().spool_unavailable, 0) + 1,
      daemon_last_error: 'raw-spool-indexeddb-unavailable',
    });
    return Promise.reject(new Error('indexeddb unavailable'));
  }

  if (spoolDbPromise) {
    return spoolDbPromise;
  }

  spoolDbPromise = new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(RAW_SPOOL_DB_NAME, 1);
    } catch (err) {
      spoolDbPromise = null;
      spoolUnavailableUntil = Date.now() + 60000;
      patchStats({
        spool_unavailable: toNumber(readStats().spool_unavailable, 0) + 1,
        daemon_last_error: `raw-spool-open-failed:${summarizeError(err)}`,
      });
      reject(err);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RAW_SPOOL_STORE_NAME)) {
        const store = db.createObjectStore(RAW_SPOOL_STORE_NAME, { keyPath: 'event_id' });
        store.createIndex('created_at', 'created_at', { unique: false });
        store.createIndex('next_retry_at', 'next_retry_at', { unique: false });
        store.createIndex('wall_time_ms', 'wall_time_ms', { unique: false });
      }
    };

    request.onsuccess = () => {
      spoolUnavailableUntil = 0;
      resolve(request.result);
    };
    request.onerror = () => {
      spoolDbPromise = null;
      spoolUnavailableUntil = Date.now() + 60000;
      patchStats({
        spool_unavailable: toNumber(readStats().spool_unavailable, 0) + 1,
        daemon_last_error: `raw-spool-open-error:${summarizeError(
          request.error ?? new Error('failed to open raw spool db'),
        )}`,
      });
      reject(request.error ?? new Error('failed to open raw spool db'));
    };
  });

  return spoolDbPromise;
}

function runTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => void,
  onComplete: () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RAW_SPOOL_STORE_NAME], mode);
    const store = tx.objectStore(RAW_SPOOL_STORE_NAME);

    tx.oncomplete = () => {
      try {
        resolve(onComplete());
      } catch (err) {
        reject(err);
      }
    };
    tx.onerror = () => reject(tx.error ?? new Error('raw spool transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('raw spool transaction aborted'));

    handler(store);
  });
}

async function spoolPut(record: RawSpoolRecord): Promise<void> {
  const db = await openSpoolDb();
  await runTx(
    db,
    'readwrite',
    (store) => {
      store.put(record);
    },
    () => undefined,
  );
}

async function spoolCountAccurate(): Promise<number> {
  const db = await openSpoolDb();
  return await new Promise((resolve) => {
    const tx = db.transaction([RAW_SPOOL_STORE_NAME], 'readonly');
    const store = tx.objectStore(RAW_SPOOL_STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => resolve(toNumber(countReq.result, 0));
    countReq.onerror = () => resolve(0);
  });
}

async function spoolOldestCreatedAtMs(): Promise<number> {
  const db = await openSpoolDb();
  return await new Promise((resolve) => {
    const tx = db.transaction([RAW_SPOOL_STORE_NAME], 'readonly');
    const store = tx.objectStore(RAW_SPOOL_STORE_NAME);
    const index = store.index('created_at');
    const req = index.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(0);
        return;
      }
      const value = cursor.value as RawSpoolRecord;
      resolve(toNumber(value.created_at, 0));
    };
    req.onerror = () => resolve(0);
  });
}

async function spoolPruneOldest(maxRows: number): Promise<number> {
  const db = await openSpoolDb();
  const currentCount = await spoolCountAccurate();
  if (currentCount <= maxRows) {
    return 0;
  }

  const toDeleteCount = currentCount - maxRows;

  return await new Promise((resolve, reject) => {
    const tx = db.transaction([RAW_SPOOL_STORE_NAME], 'readwrite');
    const store = tx.objectStore(RAW_SPOOL_STORE_NAME);
    const index = store.index('created_at');
    const keys: IDBValidKey[] = [];

    const cursorReq = index.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || keys.length >= toDeleteCount) {
        for (const key of keys) {
          store.delete(key);
        }
        return;
      }
      keys.push(cursor.primaryKey);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor read failed'));

    tx.oncomplete = () => resolve(keys.length);
    tx.onerror = () => reject(tx.error ?? new Error('prune tx failed'));
    tx.onabort = () => reject(tx.error ?? new Error('prune tx aborted'));
  });
}

async function spoolListFlushBatch(nowMs: number, limit: number): Promise<RawSpoolRecord[]> {
  const db = await openSpoolDb();

  return await new Promise((resolve, reject) => {
    const tx = db.transaction([RAW_SPOOL_STORE_NAME], 'readonly');
    const store = tx.objectStore(RAW_SPOOL_STORE_NAME);
    const index = store.index('created_at');
    const out: RawSpoolRecord[] = [];

    const cursorReq = index.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }

      const value = cursor.value as RawSpoolRecord;
      if (toNumber(value.next_retry_at, 0) <= nowMs) {
        out.push(value);
      }
      cursor.continue();
    };

    cursorReq.onerror = () => reject(cursorReq.error ?? new Error('list batch failed'));
    tx.onerror = () => reject(tx.error ?? new Error('list batch tx failed'));
  });
}

async function spoolDeleteByIds(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openSpoolDb();

  await runTx(
    db,
    'readwrite',
    (store) => {
      for (const id of ids) {
        store.delete(id);
      }
    },
    () => undefined,
  );
}

async function spoolUpdateRecords(records: RawSpoolRecord[]): Promise<void> {
  if (!records.length) return;
  const db = await openSpoolDb();

  await runTx(
    db,
    'readwrite',
    (store) => {
      for (const record of records) {
        store.put(record);
      }
    },
    () => undefined,
  );
}

async function spoolClearAll(): Promise<number> {
  const db = await openSpoolDb();
  await runTx(
    db,
    'readwrite',
    (store) => {
      store.clear();
    },
    () => undefined,
  );
  return await spoolCountAccurate();
}

async function refreshSpoolStats(prunedOverflow = 0): Promise<void> {
  try {
    const count = await spoolCountAccurate();
    const oldestCreatedAt = await spoolOldestCreatedAtMs();
    const oldestPendingAgeMs = oldestCreatedAt ? Math.max(0, Date.now() - oldestCreatedAt) : 0;
    const stats = readStats();
    writeStats({
      ...stats,
      spool_count: count,
      oldest_pending_age_ms: oldestPendingAgeMs,
      dropped: stats.dropped + Math.max(0, prunedOverflow),
      spool_drop_overflow: toNumber(stats.spool_drop_overflow, 0) + Math.max(0, prunedOverflow),
    });
  } catch {
    // keep host-safe/fail-open if spool is not available
  }
}

async function maintainSpoolBounds(): Promise<void> {
  if (Date.now() < spoolUnavailableUntil) {
    patchStats({
      spool_count: 0,
      oldest_pending_age_ms: 0,
    });
    return;
  }

  try {
    const pruned = await spoolPruneOldest(RAW_SPOOL_MAX_ROWS);
    await refreshSpoolStats(pruned);
  } catch {
    // ignore maintenance failures
  }
}

function computeRetryDelayMs(attempts: number): number {
  const exp = Math.max(0, Math.min(6, attempts));
  return Math.min(60000, 1000 * 2 ** exp);
}

function readLocalStorageString(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function isDaemonStreamingEnabled(): boolean {
  const g = getWindowRecord();
  const globalFlag = g.__twe_raw_capture_stream_enabled_v1;
  if (typeof globalFlag === 'boolean') {
    return globalFlag;
  }

  const optionFlag = options.get('rawCaptureStreamEnabled', false);
  if (typeof optionFlag === 'boolean') {
    return optionFlag;
  }

  const local = readLocalStorageString(RAW_DAEMON_STREAM_ENABLED_STORAGE_KEY);
  if (!local) return false;

  return local === '1' || local === 'true';
}

function getDaemonBaseUrl(): string {
  const g = getWindowRecord();
  const globalValue = g.__twe_raw_capture_daemon_url_v1;
  const optionValue = options.get('rawCaptureDaemonUrl', 'http://127.0.0.1:8754');
  const local =
    typeof globalValue === 'string' && globalValue.trim().length > 0
      ? globalValue.trim()
      : typeof optionValue === 'string' && optionValue.trim().length > 0
        ? optionValue.trim()
        : readLocalStorageString(RAW_DAEMON_BASE_URL_STORAGE_KEY) || 'http://127.0.0.1:8754';

  return local.replace(/\/+$/, '');
}

async function enqueueSpoolEvent(event: RawEventEnvelopeV1): Promise<void> {
  if (Date.now() < spoolUnavailableUntil) {
    patchStats({
      spool_unavailable: toNumber(readStats().spool_unavailable, 0) + 1,
    });
    return;
  }

  try {
    const now = Date.now();
    const record: RawSpoolRecord = {
      event_id: event.event_id,
      wall_time_ms: event.wall_time_ms,
      created_at: now,
      attempts: 0,
      next_retry_at: now,
      payload: event,
    };

    await spoolPut(record);
    const pruned = await spoolPruneOldest(RAW_SPOOL_MAX_ROWS);
    const stats = readStats();
    writeStats({
      ...stats,
      spool_enqueued: toNumber(stats.spool_enqueued, 0) + 1,
      dropped: stats.dropped + Math.max(0, pruned),
      spool_drop_overflow: toNumber(stats.spool_drop_overflow, 0) + Math.max(0, pruned),
    });
    await refreshSpoolStats();
  } catch (err) {
    patchStats({
      spool_unavailable: toNumber(readStats().spool_unavailable, 0) + 1,
      daemon_last_error: `spool-enqueue-error:${summarizeError(err)}`,
    });
  }
}

function stopSupplementalMonitoring(): void {
  const g = getWindowRecord();
  clearWindowTimer(RAW_MONITOR_COORD_TIMER_KEY);
  clearWindowTimer(RAW_ROUTE_MONITOR_TIMER_KEY);
  clearWindowTimer(RAW_VIEWPORT_MONITOR_TIMER_KEY);
  viewportSeenAt.clear();

  const storageListener = g[RAW_MONITOR_STORAGE_LISTENER_KEY];
  if (typeof storageListener === 'function' && typeof window !== 'undefined') {
    try {
      window.removeEventListener('storage', storageListener as EventListener);
    } catch {
      // ignore
    }
  }
  delete g[RAW_MONITOR_STORAGE_LISTENER_KEY];

  const beforeUnloadListener = g[RAW_MONITOR_BEFOREUNLOAD_KEY];
  if (typeof beforeUnloadListener === 'function' && typeof window !== 'undefined') {
    try {
      window.removeEventListener('beforeunload', beforeUnloadListener as EventListener);
    } catch {
      // ignore
    }
  }
  delete g[RAW_MONITOR_BEFOREUNLOAD_KEY];

  try {
    const tabId = ensureStableId(RAW_CAPTURE_TAB_KEY, 'tab');
    clearMonitorLeaderLeaseIfOwned(tabId);
  } catch {
    // ignore
  }

  delete g[RAW_MONITOR_COORDINATION_KEY];
  patchMonitorStats({
    monitor_role: undefined,
    monitor_leader_tab_id: undefined,
    monitor_last_heartbeat_ms: 0,
  });
}

function syncSpoolFlushLoop(): void {
  if (isDaemonStreamingEnabled()) {
    const g = getWindowRecord();
    const existing = g[RAW_SPOOL_FLUSH_TIMER_KEY];
    if (!(typeof existing === 'number' || typeof existing === 'object')) {
      const timer = setInterval(() => {
        spoolMaintenanceTick += 1;
        if (spoolMaintenanceTick % RAW_SPOOL_MAINTENANCE_EVERY_TICKS === 0) {
          void maintainSpoolBounds();
        }
        void flushSpoolToDaemon();
      }, RAW_SPOOL_FLUSH_INTERVAL_MS);

      g[RAW_SPOOL_FLUSH_TIMER_KEY] = timer;
    }
    return;
  }

  clearWindowTimer(RAW_SPOOL_FLUSH_TIMER_KEY);
}

function ensureFlushLoopStarted(): void {
  const g = getWindowRecord();

  if (isRawCaptureDebugEnabled() && typeof g[RAW_SPOOL_DEV_CLEAR_KEY] !== 'function') {
    g[RAW_SPOOL_DEV_CLEAR_KEY] = async () => {
      try {
        const remaining = await spoolClearAll();
        const stats = readStats();
        writeStats({
          ...stats,
          spool_count: remaining,
          oldest_pending_age_ms: 0,
        });
        return { ok: true, remaining };
      } catch (err) {
        const message = summarizeError(err);
        patchStats({
          daemon_last_error: `spool-clear-error:${message}`,
        });
        return { ok: false, error: message };
      }
    };
  }

  if (typeof g[RAW_MONITOR_DEV_TICK_KEY] !== 'function') {
    g[RAW_MONITOR_DEV_TICK_KEY] = (mode: string = 'both') => {
      try {
        if (mode === 'both' || mode === 'route') {
          monitorRouteChanges();
        }
        if (mode === 'both' || mode === 'viewport') {
          monitorViewportSightings();
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: summarizeError(err) };
      }
    };
  }

  if (typeof g.__twe_arm_dm_capture_v1 !== 'function') {
    g.__twe_arm_dm_capture_v1 = (durationMs: number = RAW_CAPTURE_DM_SESSION_DEFAULT_ARM_MS) => {
      const now = Date.now();
      const nextUntil =
        now + Math.max(30_000, toNumber(durationMs, RAW_CAPTURE_DM_SESSION_DEFAULT_ARM_MS));
      setDmSessionArmedUntil(nextUntil);
      return { ok: true, armed_until_ms: nextUntil };
    };
  }

  if (typeof g.__twe_disarm_dm_capture_v1 !== 'function') {
    g.__twe_disarm_dm_capture_v1 = () => {
      setDmSessionArmedUntil(0);
      return { ok: true, armed_until_ms: 0 };
    };
  }

  if (isSupplementalMonitoringEnabled()) {
    refreshMonitorCoordination(true);

    if (typeof g[RAW_MONITOR_STORAGE_LISTENER_KEY] !== 'function') {
      const onStorage = (event: StorageEvent) => {
        if (event.key !== RAW_MONITOR_LEADER_STORAGE_KEY) return;
        try {
          refreshMonitorCoordination(true);
        } catch {
          // ignore
        }
      };
      g[RAW_MONITOR_STORAGE_LISTENER_KEY] = onStorage;
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        try {
          window.addEventListener('storage', onStorage);
        } catch {
          // ignore
        }
      }
    }

    if (typeof g[RAW_MONITOR_BEFOREUNLOAD_KEY] !== 'function') {
      const onBeforeUnload = () => {
        try {
          const tabId = ensureStableId(RAW_CAPTURE_TAB_KEY, 'tab');
          clearMonitorLeaderLeaseIfOwned(tabId);
        } catch {
          // ignore
        }
      };
      g[RAW_MONITOR_BEFOREUNLOAD_KEY] = onBeforeUnload;
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        try {
          window.addEventListener('beforeunload', onBeforeUnload);
        } catch {
          // ignore
        }
      }
    }

    const coordTimer = g[RAW_MONITOR_COORD_TIMER_KEY];
    if (!(typeof coordTimer === 'number' || typeof coordTimer === 'object')) {
      const timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          return;
        }
        try {
          refreshMonitorCoordination(true);
        } catch {
          // ignore
        }
      }, RAW_MONITOR_HEARTBEAT_MS);
      g[RAW_MONITOR_COORD_TIMER_KEY] = timer;
    }

    const routeTimer = g[RAW_ROUTE_MONITOR_TIMER_KEY];
    if (!(typeof routeTimer === 'number' || typeof routeTimer === 'object')) {
      const timer = setInterval(() => {
        try {
          monitorRouteChanges();
        } catch {
          // ignore
        }
      }, RAW_ROUTE_MONITOR_INTERVAL_MS);
      g[RAW_ROUTE_MONITOR_TIMER_KEY] = timer;
      try {
        monitorRouteChanges();
      } catch {
        // ignore
      }
    }

    const viewportTimer = g[RAW_VIEWPORT_MONITOR_TIMER_KEY];
    if (!(typeof viewportTimer === 'number' || typeof viewportTimer === 'object')) {
      const timer = setInterval(() => {
        try {
          monitorViewportSightings();
        } catch {
          // ignore
        }
      }, RAW_VIEWPORT_MONITOR_INTERVAL_MS);
      g[RAW_VIEWPORT_MONITOR_TIMER_KEY] = timer;
    }
  } else {
    stopSupplementalMonitoring();
  }

  syncSpoolFlushLoop();
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

async function sendBatchToDaemon(batch: RawSpoolRecord[]): Promise<string[]> {
  const daemonBaseUrl = getDaemonBaseUrl();
  const response = await fetch(`${daemonBaseUrl}/ingest/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      events: batch.map((record) => record.payload),
    }),
  });

  if (!response.ok) {
    throw new Error(`daemon-response-${response.status}`);
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // If daemon returns no JSON, treat as full success.
    return batch.map((record) => record.event_id);
  }

  const accepted =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { accepted_ids?: unknown }).accepted_ids)
      ? ((parsed as { accepted_ids: unknown[] }).accepted_ids
          .map((value) => (typeof value === 'string' ? value : ''))
          .filter((value) => !!value) as string[])
      : null;

  if (!accepted || !accepted.length) {
    return batch.map((record) => record.event_id);
  }

  return accepted;
}

async function flushSpoolToDaemon(): Promise<void> {
  if (flushInFlight) {
    return;
  }

  flushInFlight = true;
  try {
    if (Date.now() < spoolUnavailableUntil) {
      patchStats({
        spool_count: 0,
        oldest_pending_age_ms: 0,
        daemon_online: false,
      });
      return;
    }

    const count = await spoolCountAccurate();
    await refreshSpoolStats();

    if (!isDaemonStreamingEnabled()) {
      patchStats({ daemon_online: false });
      return;
    }

    if (count <= 0) {
      patchStats({
        daemon_online: true,
        daemon_last_flush_at: Date.now(),
        oldest_pending_age_ms: 0,
      });
      return;
    }

    const now = Date.now();
    const batch = await spoolListFlushBatch(now, RAW_SPOOL_FLUSH_BATCH_SIZE);

    if (!batch.length) {
      patchStats({ daemon_online: true });
      await refreshSpoolStats();
      return;
    }

    try {
      const acceptedIds = await sendBatchToDaemon(batch);
      const acceptedSet = new Set(acceptedIds);
      const rejected = batch.filter((record) => !acceptedSet.has(record.event_id));

      if (acceptedIds.length) {
        await spoolDeleteByIds(acceptedIds);
      }

      if (rejected.length) {
        const retryNow = Date.now();
        const next = rejected.map((record) => {
          const attempts = toNumber(record.attempts, 0) + 1;
          return {
            ...record,
            attempts,
            next_retry_at: retryNow + computeRetryDelayMs(attempts),
          };
        });
        await spoolUpdateRecords(next);
      }

      const stats = readStats();
      writeStats({
        ...stats,
        spool_flushed: toNumber(stats.spool_flushed, 0) + acceptedIds.length,
        daemon_online: true,
        daemon_last_flush_at: Date.now(),
        daemon_last_error: undefined,
      });
      await refreshSpoolStats();
    } catch (err) {
      const retryNow = Date.now();
      const next = batch.map((record) => {
        const attempts = toNumber(record.attempts, 0) + 1;
        return {
          ...record,
          attempts,
          next_retry_at: retryNow + computeRetryDelayMs(attempts),
        };
      });
      await spoolUpdateRecords(next);

      const stats = readStats();
      writeStats({
        ...stats,
        spool_failed: toNumber(stats.spool_failed, 0) + batch.length,
        daemon_online: false,
        daemon_last_error: summarizeError(err),
      });
      await refreshSpoolStats();
    }
  } catch (err) {
    patchStats({ daemon_last_error: `flush-error:${summarizeError(err)}` });
  } finally {
    flushInFlight = false;
  }
}

export const RawCaptureInterceptor: Interceptor = (req, res) => {
  try {
    if (!isRawCaptureEnabled()) {
      return;
    }

    const request = {
      method: typeof req.method === 'string' && req.method ? req.method : 'GET',
      url: typeof req.url === 'string' ? req.url : '',
      body: typeof req.body === 'string' ? req.body : undefined,
      requestId: typeof req.requestId === 'string' ? req.requestId : undefined,
    };

    const response = {
      status: Number((res as { status?: number }).status ?? 0),
      responseText: String((res as { responseText?: string }).responseText || ''),
    };

    if (!shouldCapture(request, response)) {
      return;
    }

    ensureFlushLoopStarted();

    const envelope = buildEnvelope(request, response);
    pushToGlobalBuffer(envelope);
    if (isDaemonStreamingEnabled()) {
      void enqueueSpoolEvent(envelope);
      void flushSpoolToDaemon();
    }
  } catch {
    // Never throw in interceptors; host safety first.
  }
};
