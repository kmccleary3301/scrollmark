import { unsafeWindow } from '$';
import { options } from '@/core/options';
import logger from '@/utils/logger';
import { Signal } from '@preact/signals';
import { Extension, ExtensionConstructor } from './extension';
import { ExtensionInterceptorDispatcher } from './interceptor-dispatcher';
import {
  HookDebugConfig,
  HookMode,
  RepairMode,
  RuntimeControlPlane,
  RuntimeModes,
} from './runtime-control-plane';

/**
 * Global object reference. In some cases, the `unsafeWindow` is not available.
 */
type HookGlobal = Window & typeof globalThis & Record<string, unknown>;

function getUnsafeWindowCandidate(): unknown {
  try {
    return unsafeWindow ?? null;
  } catch {
    return null;
  }
}

function getWrappedPageWindowCandidate(unsafeCandidate: unknown): HookGlobal | null {
  try {
    const unsafeObject = unsafeCandidate as { wrappedJSObject?: unknown } | null;
    if (!unsafeObject?.wrappedJSObject || typeof unsafeObject.wrappedJSObject !== 'object') {
      return null;
    }
    return unsafeObject.wrappedJSObject as HookGlobal;
  } catch {
    return null;
  }
}

let cachedHookGlobalObject: HookGlobal | null = null;
function getHookGlobalObject(): HookGlobal {
  if (cachedHookGlobalObject) {
    return cachedHookGlobalObject;
  }
  const unsafeCandidate = getUnsafeWindowCandidate();
  const wrappedCandidate = getWrappedPageWindowCandidate(unsafeCandidate);
  const windowCandidate = typeof window !== 'undefined' ? (window as unknown as HookGlobal) : null;
  const globalCandidate = globalThis as HookGlobal;
  cachedHookGlobalObject = (wrappedCandidate ??
    (unsafeCandidate as HookGlobal | null) ??
    windowCandidate ??
    globalCandidate) as HookGlobal;
  return cachedHookGlobalObject;
}

const hookGlobalObject = new Proxy({} as HookGlobal, {
  get(_target, prop) {
    const globalObject = getHookGlobalObject();
    return Reflect.get(globalObject, prop, globalObject);
  },
  set(_target, prop, value) {
    const globalObject = getHookGlobalObject();
    return Reflect.set(globalObject, prop, value, globalObject);
  },
});

type HookCallable = (...args: unknown[]) => unknown;
type ExportFunction = (
  fn: HookCallable,
  target: object,
  options?: { defineAs?: string },
) => unknown;
// Firefox-only: `exportFunction` makes functions callable from the page realm.
function getExportFunctionMaybe(): ExportFunction | undefined {
  try {
    return (globalThis as unknown as { exportFunction?: unknown }).exportFunction as
      | ExportFunction
      | undefined;
  } catch {
    return undefined;
  }
}

const HOOK_MESSAGE_FLAG = '__twe_mcp_hook_v1';
const ORIG_XHR_OPEN_KEY = '__twe_orig_xhr_open_v1';
const ORIG_XHR_SEND_KEY = '__twe_orig_xhr_send_v1';
const ORIG_FETCH_KEY = '__twe_orig_fetch_v1';
const HOOK_BOOTSTRAP_ERROR_KEY = '__twe_bootstrap_error_v1';
const BOOKMARK_CONTEXT_BOOKMARKS_ONLY_STALE_MS = 45000;
const BOOKMARK_CONTEXT_LOCK_TTL_MS = 180000;
const BOOKMARK_CONTEXT_SCAN_DEPTH = 6;
const BOOKMARK_CONTEXT_MIN_CONFIDENCE = 12;
const BOOKMARK_CONTEXT_DUMP_LIMIT = 200;
const HOOK_REVISION = 3;
const EXTENSION_MANAGER_SIGNATURE = 'twitter-web-exporter-extension-manager-v1';
const EXTENSION_MANAGER_REVISION = 3;
const RESPONSE_DEDUPE_WINDOW_MS = 2600;
const RESPONSE_DEDUPE_MAX_ENTRIES = 500;
const RESPONSE_DEDUPE_CLEANUP_COUNT = 120;

export { EXTENSION_MANAGER_SIGNATURE, EXTENSION_MANAGER_REVISION };

type EndpointHookMetrics = {
  received: number;
  processed: number;
  skippedDuplicate: number;
  newUniqueTweets: number;
  legacyShape: number;
  missingContext: number;
  lastAt: number;
  lastStatus: number;
  lastUrl: string;
};

type HookStats = {
  xhrMessages: number;
  fetchMessages: number;
  lastUrl: string;
  lastAt: number;
  loggedUrls: number;
  messagesTotal: number;
  messagesLegacyShape: number;
  messagesMissingContext: number;
  messagesRepairedAtBridge: number;
  messagesMissingBody: number;
  responsesProcessed: number;
  responsesSkippedDuplicate: number;
  lastMessageAt: number;
  activeInstanceId: string;
  rev: number;
  repairCount: number;
  endpointStats: Record<string, EndpointHookMetrics>;
};

type RecentSig = { sig: string; at: number };

function getRuntimeCapabilities(): {
  hasUnsafeWindow: boolean;
  hasWrappedJSObject: boolean;
  hasExportFunction: boolean;
} {
  const unsafeCandidate = getUnsafeWindowCandidate();
  return {
    hasUnsafeWindow: !!unsafeCandidate,
    hasWrappedJSObject: !!getWrappedPageWindowCandidate(unsafeCandidate),
    hasExportFunction: !!getExportFunctionMaybe(),
  };
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function createRequestSignature(
  method: string,
  url: string,
  status: number,
  responseText: string,
): string {
  return `${method.toUpperCase()} ${url} ${status} ${hashText(responseText)}`;
}

function cleanupSignatureCache(map: Map<string, RecentSig>) {
  const now = Date.now();
  if (map.size <= RESPONSE_DEDUPE_MAX_ENTRIES) return;

  const entries = [...map.entries()]
    .filter(([, value]) => now - value.at > RESPONSE_DEDUPE_WINDOW_MS)
    .sort((a, b) => a[1].at - b[1].at);
  for (const [key] of entries.slice(0, RESPONSE_DEDUPE_CLEANUP_COUNT)) {
    map.delete(key);
  }
}

function createHookStats(instanceId: string): HookStats {
  return {
    xhrMessages: 0,
    fetchMessages: 0,
    lastUrl: '',
    lastAt: 0,
    loggedUrls: 0,
    messagesTotal: 0,
    messagesLegacyShape: 0,
    messagesMissingContext: 0,
    messagesRepairedAtBridge: 0,
    messagesMissingBody: 0,
    responsesProcessed: 0,
    responsesSkippedDuplicate: 0,
    lastMessageAt: 0,
    activeInstanceId: instanceId,
    rev: HOOK_REVISION,
    repairCount: 0,
    endpointStats: Object.create(null),
  };
}

type BookmarkContextPayload = {
  folderId: string | null;
  pageUrl: string;
  source: string;
  capturedAt: number;
  requestId?: string;
  routeSource?: string;
  pageRouteUrl?: string;
};

let activeBookmarkContext: BookmarkContextPayload = {
  folderId: null,
  pageUrl: '',
  source: 'startup',
  capturedAt: 0,
};

let bookmarkContextLock: BookmarkContextPayload | null = null;
let bookmarkContextDumpState: BookmarkContextDumpEntry[] = [];

type BookmarkContextDumpEntry = {
  requestId: string;
  ts: number;
  method: string;
  url: string;
  hasBody: boolean;
  confidenceSource: string;
  context: BookmarkContextPayload;
  normalizedRoute: string;
};

type BookmarkRequestSource = {
  method: string;
  url: string;
  requestId?: string;
  body?: string;
};

type HookedXhr = XMLHttpRequest & {
  __twe_req_method_v1?: string;
  __twe_req_url_v1?: string;
  __twe_req_body_v1?: string;
  __twe_req_id_v1?: string;
  __twe_req_bookmark_context_v1?: BookmarkContextPayload | null;
  __twe_hooked_v1?: boolean;
};

type XhrRequestMeta = {
  method: string;
  url: string;
  body: string;
  requestId: string;
  bookmarkContext: BookmarkContextPayload | null;
  hooked: boolean;
};

const xhrRequestMetaMap = new WeakMap<XMLHttpRequest, XhrRequestMeta>();

function createDefaultXhrRequestMeta(): XhrRequestMeta {
  return {
    method: 'GET',
    url: '',
    body: '',
    requestId: '',
    bookmarkContext: null,
    hooked: false,
  };
}

function ensureXhrRequestMeta(xhr: XMLHttpRequest): XhrRequestMeta {
  const existing = xhrRequestMetaMap.get(xhr);
  if (existing) return existing;
  const next = createDefaultXhrRequestMeta();
  xhrRequestMetaMap.set(xhr, next);
  return next;
}

function loadXhrRequestMeta(xhr: HookedXhr, debugConfig: HookDebugConfig): XhrRequestMeta {
  if (debugConfig.disableExpandoMeta) {
    return ensureXhrRequestMeta(xhr);
  }
  const method = typeof xhr.__twe_req_method_v1 === 'string' ? xhr.__twe_req_method_v1 : 'GET';
  const url = typeof xhr.__twe_req_url_v1 === 'string' ? xhr.__twe_req_url_v1 : '';
  const body = typeof xhr.__twe_req_body_v1 === 'string' ? xhr.__twe_req_body_v1 : '';
  const requestId = typeof xhr.__twe_req_id_v1 === 'string' ? xhr.__twe_req_id_v1 : '';
  const bookmarkContext =
    xhr.__twe_req_bookmark_context_v1 && typeof xhr.__twe_req_bookmark_context_v1 === 'object'
      ? xhr.__twe_req_bookmark_context_v1
      : null;
  const hooked = !!xhr.__twe_hooked_v1;
  return {
    method,
    url,
    body,
    requestId,
    bookmarkContext,
    hooked,
  };
}

function storeXhrRequestMeta(
  xhr: HookedXhr,
  debugConfig: HookDebugConfig,
  meta: XhrRequestMeta,
): void {
  if (debugConfig.disableExpandoMeta) {
    xhrRequestMetaMap.set(xhr, meta);
    return;
  }
  xhr.__twe_req_method_v1 = meta.method;
  xhr.__twe_req_url_v1 = meta.url;
  xhr.__twe_req_body_v1 = meta.body;
  xhr.__twe_req_id_v1 = meta.requestId;
  xhr.__twe_req_bookmark_context_v1 = meta.bookmarkContext;
  xhr.__twe_hooked_v1 = meta.hooked;
}

function callFunctionWithArgs(
  fn: (...args: unknown[]) => unknown,
  thisArg: unknown,
  args: unknown[],
): unknown {
  switch (args.length) {
    case 0:
      return fn.call(thisArg);
    case 1:
      return fn.call(thisArg, args[0]);
    case 2:
      return fn.call(thisArg, args[0], args[1]);
    case 3:
      return fn.call(thisArg, args[0], args[1], args[2]);
    case 4:
      return fn.call(thisArg, args[0], args[1], args[2], args[3]);
    default:
      return fn.call(thisArg, args[0], args[1], args[2], args[3], args[4]);
  }
}

type InterceptedRequest = {
  method: string;
  url: string;
  body?: string;
  bookmarkContext?: unknown;
  requestId?: string;

  __twe_hook_revision_v1?: number;
  hookRevision?: number;
};

type BootstrapErrorReport = {
  message: string;
  stack?: string;
  phase: string;
  instanceId: string;
  at: number;
};

function recordBootstrapError(
  phase: string,
  instanceId: string,
  error: unknown,
): BootstrapErrorReport {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const report: BootstrapErrorReport = {
    message,
    stack,
    phase,
    instanceId,
    at: Date.now(),
  };

  return report;
}

function clearBootstrapErrorMarker(): void {
  try {
    const deleted = (obj: unknown, key: string) => {
      if (obj && typeof obj === 'object') {
        delete (obj as Record<string, unknown>)[key];
      }
    };

    deleted(globalThis, HOOK_BOOTSTRAP_ERROR_KEY);
  } catch {
    // ignore
  }
}

function normalizeRuntimeForRead(value: unknown, fallback: HookStats): HookStats {
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const candidate = value as Partial<HookStats>;
  return {
    ...candidate,
    xhrMessages: Number(candidate.xhrMessages) || 0,
    fetchMessages: Number(candidate.fetchMessages) || 0,
    lastUrl: typeof candidate.lastUrl === 'string' ? candidate.lastUrl : '',
    lastAt: Number(candidate.lastAt) || 0,
    loggedUrls: Number(candidate.loggedUrls) || 0,
    messagesTotal: Number(candidate.messagesTotal) || 0,
    messagesLegacyShape: Number(candidate.messagesLegacyShape) || 0,
    messagesMissingContext: Number(candidate.messagesMissingContext) || 0,
    messagesRepairedAtBridge: Number(candidate.messagesRepairedAtBridge) || 0,
    messagesMissingBody: Number(candidate.messagesMissingBody) || 0,
    responsesProcessed: Number(candidate.responsesProcessed) || 0,
    responsesSkippedDuplicate: Number(candidate.responsesSkippedDuplicate) || 0,
    lastMessageAt: Number(candidate.lastMessageAt) || 0,
    activeInstanceId:
      typeof candidate.activeInstanceId === 'string'
        ? candidate.activeInstanceId
        : fallback.activeInstanceId,
    rev: Number(candidate.rev) || HOOK_REVISION,
    repairCount: Number(candidate.repairCount) || 0,
    endpointStats:
      (candidate.endpointStats as Record<string, EndpointHookMetrics> | undefined) ||
      Object.create(null),
  };
}

function toPlainFunctionSource(value: unknown): string {
  if (typeof value !== 'function') return '';
  try {
    return Function.prototype.toString.call(value);
  } catch {
    return '';
  }
}

function hasHookVersion(
  target: unknown,
  marker: '__twe_is_hook_open_v1' | '__twe_is_hook_send_v1' | '__twe_is_hook_fetch_v1',
): boolean {
  if (!target || typeof target !== 'function') return false;
  const candidate = target as {
    __twe_is_hook_open_v1?: boolean;
    __twe_is_hook_send_v1?: boolean;
    __twe_is_hook_fetch_v1?: boolean;
    __twe_is_hook_revision_v1?: number;
  };
  const markerMap = candidate as { [key: string]: unknown };
  if (!markerMap[marker]) return false;
  return candidate.__twe_is_hook_revision_v1 === HOOK_REVISION;
}

function hasHookShape(
  target: unknown,
  marker?: '__twe_is_hook_open_v1' | '__twe_is_hook_send_v1' | '__twe_is_hook_fetch_v1',
): boolean {
  if (!target || typeof target !== 'function') return false;
  const candidate = target as {
    __twe_is_hook_open_v1?: boolean;
    __twe_is_hook_send_v1?: boolean;
    __twe_is_hook_fetch_v1?: boolean;
    __twe_orig_xhr_open_v1?: unknown;
    __twe_orig_xhr_send_v1?: unknown;
    __twe_orig_fetch_v1?: unknown;
  };
  if (
    candidate.__twe_is_hook_open_v1 ||
    candidate.__twe_is_hook_send_v1 ||
    candidate.__twe_is_hook_fetch_v1 ||
    candidate.__twe_orig_xhr_open_v1 ||
    candidate.__twe_orig_xhr_send_v1 ||
    candidate.__twe_orig_fetch_v1
  ) {
    return true;
  }

  if (marker && candidate[marker]) {
    return true;
  }

  const source = toPlainFunctionSource(target);
  if (!source) return false;
  return (
    source.includes('__twe_mcp_hook_v1') ||
    source.includes('__twe_is_hook_open_v1') ||
    source.includes('__twe_is_hook_send_v1') ||
    source.includes('__twe_is_hook_fetch_v1') ||
    source.includes('__twe_is_hook_revision_v1') ||
    source.includes('__twe_orig_xhr_open_v1') ||
    source.includes('__twe_orig_xhr_send_v1') ||
    source.includes('__twe_orig_fetch_v1') ||
    source.includes('__twe_req_body_v1') ||
    source.includes('__twe_req_url_v1') ||
    source.includes('__twe_req_bookmark_context_v1')
  );
}

const BOOKMARK_CONTEXT_REQUEST_ID_PREFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let bookmarkRequestCounter = 0;

function nextBookmarkRequestId(): string {
  bookmarkRequestCounter += 1;
  return `${BOOKMARK_CONTEXT_REQUEST_ID_PREFIX}-${bookmarkRequestCounter}`;
}

function normalizeContextDumpList(current: unknown): BookmarkContextDumpEntry[] {
  if (!Array.isArray(current)) return [];
  const out: BookmarkContextDumpEntry[] = [];

  for (const item of current) {
    const candidate = item as Partial<BookmarkContextDumpEntry>;
    if (
      candidate &&
      typeof candidate.requestId === 'string' &&
      typeof candidate.ts === 'number' &&
      typeof candidate.url === 'string'
    ) {
      out.push({
        requestId: candidate.requestId,
        ts: candidate.ts,
        method: typeof candidate.method === 'string' ? candidate.method : 'GET',
        url: candidate.url,
        hasBody: !!candidate.hasBody,
        confidenceSource:
          typeof candidate.confidenceSource === 'string' && candidate.confidenceSource
            ? candidate.confidenceSource
            : typeof candidate.context?.source === 'string'
              ? candidate.context.source
              : 'unknown',
        context: {
          folderId:
            typeof candidate.context?.folderId === 'string' ? candidate.context.folderId : null,
          pageUrl: typeof candidate.context?.pageUrl === 'string' ? candidate.context.pageUrl : '',
          source:
            typeof candidate.context?.source === 'string' ? candidate.context.source : 'unknown',
          capturedAt:
            typeof candidate.context?.capturedAt === 'number'
              ? candidate.context.capturedAt
              : Date.now(),
          requestId:
            typeof candidate.context?.requestId === 'string'
              ? candidate.context.requestId
              : undefined,
          routeSource:
            typeof candidate.context?.routeSource === 'string'
              ? candidate.context.routeSource
              : undefined,
          pageRouteUrl:
            typeof candidate.context?.pageRouteUrl === 'string'
              ? candidate.context.pageRouteUrl
              : undefined,
        },
        normalizedRoute:
          typeof candidate.normalizedRoute === 'string' ? candidate.normalizedRoute : '',
      });
    }
  }

  return out.sort((a, b) => b.ts - a.ts).slice(0, BOOKMARK_CONTEXT_DUMP_LIMIT);
}

function appendBookmarkContextDump(entry: BookmarkContextDumpEntry) {
  const now = Date.now();
  const safeEntry: BookmarkContextDumpEntry = {
    requestId: entry.requestId || `${BOOKMARK_CONTEXT_REQUEST_ID_PREFIX}-${now}`,
    ts: Number.isFinite(entry.ts) ? entry.ts : now,
    method: entry.method || 'GET',
    url: entry.url || '',
    hasBody: !!entry.hasBody,
    confidenceSource:
      typeof entry.confidenceSource === 'string' && entry.confidenceSource
        ? entry.confidenceSource
        : entry.context?.source || 'unknown',
    context: {
      folderId: entry.context?.folderId ?? null,
      pageUrl: entry.context?.pageUrl || '',
      source: entry.context?.source || 'unknown',
      capturedAt: Number.isFinite(entry.context?.capturedAt) ? entry.context.capturedAt : now,
      requestId: entry.context?.requestId,
      routeSource: entry.context?.routeSource,
      pageRouteUrl: entry.context?.pageRouteUrl,
    },
    normalizedRoute: entry.normalizedRoute || '',
  };

  const current = normalizeContextDumpList(bookmarkContextDumpState);
  current.unshift(safeEntry);
  const deduped = new Map<string, BookmarkContextDumpEntry>();
  for (const candidate of current) {
    if (!deduped.has(candidate.requestId)) {
      deduped.set(candidate.requestId, candidate);
    }
  }
  const next = Array.from(deduped.values())
    .slice(0, BOOKMARK_CONTEXT_DUMP_LIMIT)
    .sort((a, b) => b.ts - a.ts);
  const staleCutoff = Date.now() - BOOKMARK_CONTEXT_BOOKMARKS_ONLY_STALE_MS * 6;
  bookmarkContextDumpState = next.filter(
    (candidate) => !staleCutoff || candidate.ts >= staleCutoff,
  );
}

function setBookmarkContextLock(value: BookmarkContextPayload): void {
  const payload: BookmarkContextPayload = {
    folderId: value.folderId,
    pageUrl: value.pageUrl || '',
    source: value.source || 'lock',
    capturedAt: value.capturedAt || Date.now(),
    requestId: value.requestId,
    routeSource: value.routeSource,
    pageRouteUrl: value.pageRouteUrl,
  };

  if (!payload.folderId) {
    return;
  }

  bookmarkContextLock = payload;
}

function getBookmarkContextLock(now = Date.now()): BookmarkContextPayload | null {
  const candidates = [bookmarkContextLock] as Array<unknown>;

  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<BookmarkContextPayload>;
    if (typeof candidate.folderId !== 'string' || !candidate.folderId) continue;
    const capturedAt =
      typeof candidate.capturedAt === 'number' && Number.isFinite(candidate.capturedAt)
        ? candidate.capturedAt
        : 0;
    if (!capturedAt || now - capturedAt > BOOKMARK_CONTEXT_LOCK_TTL_MS) {
      continue;
    }

    return {
      folderId: candidate.folderId,
      pageUrl: typeof candidate.pageUrl === 'string' ? candidate.pageUrl : '',
      source: typeof candidate.source === 'string' ? candidate.source : 'lock',
      capturedAt,
      requestId: typeof candidate.requestId === 'string' ? candidate.requestId : undefined,
      routeSource: typeof candidate.routeSource === 'string' ? candidate.routeSource : undefined,
      pageRouteUrl: typeof candidate.pageRouteUrl === 'string' ? candidate.pageRouteUrl : undefined,
    };
  }

  return null;
}

function clearBookmarkContextLock(): void {
  bookmarkContextLock = null;
}

function resolveCanonicalRouteFromUrl(url: string): { folderId: string | null; pageUrl: string } {
  return captureBookmarkRouteFromUrl(url) || { folderId: null, pageUrl: url };
}

function markHookFunction(
  fn: unknown,
  marker: '__twe_is_hook_open_v1' | '__twe_is_hook_send_v1' | '__twe_is_hook_fetch_v1',
) {
  if (typeof fn !== 'function') return;
  try {
    const hookFn = fn as HookCallable & Record<string, unknown>;
    hookFn[marker] = true;
    hookFn.__twe_is_hook_revision_v1 = HOOK_REVISION;
  } catch {
    // ignore
  }
}

function normalizeHookPayloadRequest(rawReq: unknown): InterceptedRequest {
  const req = rawReq as Partial<InterceptedRequest>;

  const normalized: InterceptedRequest = {
    method: typeof req.method === 'string' ? req.method : 'GET',
    url: typeof req.url === 'string' ? req.url : '',
  };

  if (typeof req.body === 'string') {
    normalized.body = req.body;
  }

  if (req.bookmarkContext !== undefined) {
    normalized.bookmarkContext = req.bookmarkContext;
  }

  if (
    normalized.bookmarkContext === undefined &&
    (req as { requestContext?: unknown }).requestContext !== undefined
  ) {
    normalized.bookmarkContext = (req as { requestContext?: unknown }).requestContext;
  }

  if (typeof req.requestId === 'string' && req.requestId) {
    normalized.requestId = req.requestId;
  }

  if (
    typeof req.__twe_hook_revision_v1 === 'number' &&
    Number.isFinite(req.__twe_hook_revision_v1)
  ) {
    normalized.hookRevision = req.__twe_hook_revision_v1;
  }

  return normalized;
}

function buildNormalizedHookMessageRequest(rawReq: unknown): InterceptedRequest {
  const req = normalizeHookPayloadRequest(rawReq);
  const requestId =
    typeof req.requestId === 'string' && req.requestId.trim().length > 0
      ? req.requestId
      : nextBookmarkRequestId();
  const method = typeof req.method === 'string' && req.method ? req.method : 'GET';
  const url = typeof req.url === 'string' ? req.url : '';
  const body = typeof req.body === 'string' ? req.body : '';
  const bookmarkContext = normalizeBookmarkContextValue(req.bookmarkContext, {
    method,
    url,
    body,
    requestId,
    hasBody: body.length > 0,
  });

  return {
    method,
    url,
    body,
    bookmarkContext,
    requestId,
    hookRevision: HOOK_REVISION,
    __twe_hook_revision_v1: HOOK_REVISION,
  };
}

function pickBridgeRequest(rawMessage: unknown): unknown {
  if (!rawMessage || typeof rawMessage !== 'object') return null;
  const envelope = rawMessage as Record<string, unknown>;
  if (envelope.req && typeof envelope.req === 'object') return envelope.req;
  return envelope;
}

function getBridgeMessageRevision(rawMessage: unknown): number | null {
  if (!rawMessage || typeof rawMessage !== 'object') return null;
  const envelope = rawMessage as Record<string, unknown>;
  const req = envelope.req;

  if (typeof envelope.__twe_msg_revision_v1 === 'number') {
    return Number(envelope.__twe_msg_revision_v1);
  }

  if (
    req &&
    typeof req === 'object' &&
    typeof (req as { __twe_hook_revision_v1?: unknown }).__twe_hook_revision_v1 === 'number'
  ) {
    return Number((req as { __twe_hook_revision_v1?: unknown }).__twe_hook_revision_v1);
  }

  return null;
}

function createEndpointMetrics(): EndpointHookMetrics {
  return {
    received: 0,
    processed: 0,
    skippedDuplicate: 0,
    newUniqueTweets: 0,
    legacyShape: 0,
    missingContext: 0,
    lastAt: 0,
    lastStatus: 0,
    lastUrl: '',
  };
}

function extractBookmarksEndpoint(url: string): string {
  try {
    const parsed = new URL(url, 'https://x.com');
    const path = parsed.pathname.toLowerCase();
    const graphqlMatch = path.match(/\/graphql\/[^/]+\/([^/?#]+)/);
    if (graphqlMatch?.[1]) {
      return `graphql:${graphqlMatch[1]}`;
    }
    const apiMatch = path.match(/\/i\/api\/1\.1\/([^/?#]+)/);
    if (apiMatch?.[1]) {
      return `api:${apiMatch[1]}`;
    }
  } catch {
    // ignore
  }
  return 'other';
}

function countUniqueTweetIds(responseText: string): number {
  const found = new Set<string>();
  const regex = /"rest_id"\s*:\s*"(\d{10,})"/g;
  for (;;) {
    const match = regex.exec(responseText);
    if (!match) break;
    if (match[1]) {
      found.add(match[1]);
    }
  }
  return found.size;
}

function serializeRequestBodyText(body: unknown): string | undefined {
  try {
    if (!body) return undefined;

    if (typeof body === 'string') {
      return body;
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return body.toString();
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      try {
        const entries = [...body.entries()]
          .map(([name, value]) => `${name}=${String(value).slice(0, 200)}`)
          .join('&');
        return entries;
      } catch {
        return undefined;
      }
    }

    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return `blob:${body.type || 'application/octet-stream'}:${body.size}`;
    }

    return undefined;
  } catch {
    // Cross-compartment objects in Firefox can throw on instanceof checks.
    return undefined;
  }
}

function captureBookmarkRouteFromUrl(
  url: string,
): { folderId: string | null; pageUrl: string } | null {
  try {
    const u = new URL(url, 'https://x.com');
    const match = u.pathname.match(/\/bookmarks\/(\d+)/);
    return { folderId: match?.[1] ?? null, pageUrl: u.href };
  } catch {
    return null;
  }
}

function coerceBookmarkFolderId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = String(Math.trunc(value));
    return /^\d+$/.test(normalized) ? normalized : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function isLikelyBookmarkFolderKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^(bookmarkcollectionid|bookmarkfolderid|bookmarkcollection|folderid|collectionid|bookmarkfolder|bookmarkcollectionid)/.test(
    normalized,
  );
}

function findFolderIdInUnknownValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): { folderId: string; pageUrl?: string } | null {
  if (!value || depth > BOOKMARK_CONTEXT_SCAN_DEPTH) return null;

  if (typeof value === 'string') {
    const fromUrl = captureBookmarkRouteFromUrl(value);
    if (fromUrl?.folderId) return { folderId: fromUrl.folderId, pageUrl: fromUrl.pageUrl };
    const fallback = value.match(
      /(?:bookmark|folder|collection)[^\w]{0,20}(?:id|_id|Id|_Id)\W*[:=]\W*["']?(\d{5,})["']?/i,
    );
    if (fallback?.[1]) return { folderId: fallback[1] };
    return null;
  }

  if (typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFolderIdInUnknownValue(item, depth + 1, seen);
      if (found?.folderId) return found;
    }
    return null;
  }

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return null;
  seen.add(obj);

  for (const [key, nested] of Object.entries(obj)) {
    const fromKey = isLikelyBookmarkFolderKey(key) ? coerceBookmarkFolderId(nested) : null;
    if (fromKey) {
      const asText = typeof nested === 'string' ? nested : '';
      const fromText = asText ? captureBookmarkRouteFromUrl(asText) : null;
      if (fromText?.folderId) return { folderId: fromText.folderId, pageUrl: fromText.pageUrl };
      return { folderId: fromKey };
    }

    const found = findFolderIdInUnknownValue(nested, depth + 1, seen);
    if (found?.folderId) return found;
  }

  return null;
}

type BookmarkRouteCandidate = {
  folderId: string | null;
  pageUrl: string;
  source: string;
  confidence: number;
};

const BOOKMARK_QUERY_FOLDER_KEYS = [
  'bookmark_collection_id',
  'bookmarkcollectionid',
  'bookmarkCollectionId',
  'folder_id',
  'folderid',
  'folderId',
  'collection_id',
  'collectionid',
  'collectionId',
];

function extractFolderIdFromRequestVariables(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const found = findFolderIdInUnknownValue(parsed);
  if (found?.folderId) return found.folderId;

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of BOOKMARK_QUERY_FOLDER_KEYS) {
      const value = obj[key];
      const folderId = coerceBookmarkFolderId(value);
      if (folderId) return folderId;
    }
  }

  return null;
}

function extractFolderIdFromBookmarkRequestUrl(url: string): string | null {
  try {
    const u = new URL(url, 'https://x.com');
    const directQueryId = BOOKMARK_QUERY_FOLDER_KEYS.map((key) => u.searchParams.get(key)).find(
      (value) => !!value && /^\d+$/.test(value),
    );
    if (directQueryId) {
      return directQueryId;
    }

    const fromVariables = extractFolderIdFromRequestVariables(u.searchParams.get('variables'));
    if (fromVariables) {
      return fromVariables;
    }

    return null;
  } catch {
    return null;
  }
}

function extractFolderIdFromBookmarkRequestBody(body: string | null | undefined): string | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      const form = new URLSearchParams(body);
      const formVariables = form.get('variables');
      if (formVariables) {
        parsed = JSON.parse(formVariables);
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  const found = findFolderIdInUnknownValue(parsed);
  if (found?.folderId) return found.folderId;
  return null;
}

function extractBookmarkFolderIdFromPath(pathOrUrl: string): string | null {
  try {
    const path = new URL(pathOrUrl, location.href).pathname;
    const match = path.match(/\/bookmarks\/(\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeBookmarkTabCandidateSource(value: string | null): string {
  if (!value) return 'bookmark-tab';
  return value;
}

function captureBookmarkRouteFromPerformanceNavigation(): BookmarkRouteCandidate | null {
  try {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
      return null;
    }

    const entries = performance.getEntriesByType('navigation') as PerformanceEntry[];
    const candidateEntry = entries[entries.length - 1];
    if (!candidateEntry || !candidateEntry.name) return null;
    const parsed = captureBookmarkRouteFromUrl(candidateEntry.name);
    if (!parsed?.folderId) return null;
    return {
      folderId: parsed.folderId,
      pageUrl: parsed.pageUrl,
      source: 'performance',
      confidence: 88,
    };
  } catch {
    return null;
  }
}

function captureBookmarkRouteFromBookmarkTabs(): BookmarkRouteCandidate | null {
  if (typeof document === 'undefined') return null;

  const selectors = [
    '[role="tab"] a[href*="/i/bookmarks/"]',
    'a[role="tab"][href*="/i/bookmarks/"]',
    '[role="tablist"] a[href*="/i/bookmarks/"]',
    'a[href*="/i/bookmarks/"]',
    // Additional selectors for X's current DOM structure
    'nav a[href*="/bookmarks/"]',
    '[data-testid="primaryColumn"] a[href*="/bookmarks/"]',
    'a[href*="/bookmarks/"]',
  ];
  const activeTabs: Array<{ folderId: string; pageUrl: string; source: string; score: number }> =
    [];
  const allTabs: Array<{ folderId: string; pageUrl: string; source: string; score: number }> = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector)) as Element[];
    for (const node of nodes) {
      if (!(node instanceof HTMLAnchorElement)) continue;
      const rawHref = node.getAttribute('href');
      if (!rawHref) continue;

      const folderId = extractBookmarkFolderIdFromPath(rawHref);
      if (!folderId) {
        continue;
      }
      const safeFolderId = folderId;
      if (seen.has(safeFolderId)) continue;
      seen.add(safeFolderId);

      const hrefUrl = (() => {
        try {
          return new URL(rawHref, location.href).href;
        } catch {
          return rawHref;
        }
      })();
      const anchorOrFallback = node.closest('a[href]') || node;

      const attr = (el: Element | null, name: string) => el?.getAttribute(name);
      const attrBool = (el: Element | null, name: string) => attr(el, name) === 'true';

      const isActive =
        attrBool(anchorOrFallback, 'aria-selected') ||
        attrBool(anchorOrFallback, 'aria-current') ||
        attrBool(anchorOrFallback, 'data-selected') ||
        attrBool(anchorOrFallback, 'data-state');
      const isInsideTabList = !!anchorOrFallback.closest('[role="tablist"]');
      const isAnchorTab =
        anchorOrFallback instanceof HTMLAnchorElement &&
        (anchorOrFallback.role === 'tab' || !!anchorOrFallback.closest('[role="tab"]'));

      let style: CSSStyleDeclaration | null = null;
      try {
        style = window.getComputedStyle(anchorOrFallback);
      } catch {
        // ignore
      }
      const isVisible = style
        ? style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        : true;

      let score = 0;
      if (isActive) score += 20;
      if (isInsideTabList) score += 5;
      if (isAnchorTab) score += 3;
      if (isVisible) score += 2;

      const tabInfo = {
        folderId: safeFolderId,
        pageUrl: hrefUrl,
        source: normalizeBookmarkTabCandidateSource(
          anchorOrFallback.getAttribute('data-testid') ?? (isAnchorTab ? 'bookmark-tab' : null),
        ),
        score,
      };

      allTabs.push(tabInfo);
      if (isActive) {
        activeTabs.push(tabInfo);
      }
    }
  }

  // Prefer explicitly active tabs, but fall back to all tabs with scoring
  const picked = activeTabs.length > 0 ? activeTabs : allTabs;
  if (!picked.length) return null;

  picked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.folderId.localeCompare(b.folderId);
  });

  const top = picked[0];
  if (!top) return null;
  return {
    folderId: top.folderId,
    pageUrl: top.pageUrl,
    source: top.source,
    confidence: Math.max(
      activeTabs.length > 0 ? 45 : 25,
      top.score + (activeTabs.length > 0 ? 45 : 25),
    ),
  };
}

function captureBookmarkRouteFromHistoryState(): BookmarkRouteCandidate | null {
  try {
    const state = hookGlobalObject.history?.state;
    if (!state) return null;
    const found = findFolderIdInUnknownValue(state);
    if (!found?.folderId) return null;
    const pageUrl = found.pageUrl || (typeof location !== 'undefined' ? location.href : '');
    return { folderId: found.folderId, pageUrl, source: 'history-state', confidence: 86 };
  } catch {
    return null;
  }
}

function captureBookmarkRouteFromGlobalState(): BookmarkRouteCandidate | null {
  const stateSources = [
    '__INITIAL_STATE__',
    '__NEXT_DATA__',
    '__INITIAL_PROPS__',
    '__NEXT_REDUX_STATE__',
    '__META_DATA__',
  ];
  const candidates: Array<{ source: string; value: unknown }> = [];
  const globalObj = hookGlobalObject as Record<string, unknown>;

  for (const key of stateSources) {
    const value = globalObj[key];
    if (!value) continue;
    candidates.push({ source: key, value });
  }

  for (const { source, value } of candidates) {
    const found = findFolderIdInUnknownValue(value);
    if (!found?.folderId) continue;
    return {
      folderId: found.folderId,
      pageUrl: found.pageUrl || (typeof location !== 'undefined' ? location.href : ''),
      source,
      confidence: 82,
    };
  }

  return null;
}

function captureBookmarkRouteFromEventTarget(
  target: EventTarget | null,
): BookmarkRouteCandidate | null {
  if (!target || typeof target !== 'object') return null;

  const candidates: Element[] = [];
  const seen = new Set<Element>();
  const push = (candidate: unknown) => {
    if (candidate instanceof Element && !seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };

  push(target);
  const targetWithPath = target as { composedPath?: () => EventTarget[] };
  if (typeof targetWithPath.composedPath === 'function') {
    const path = targetWithPath.composedPath() || [];
    path.forEach((item) => {
      push(item);
    });
  }
  const directTarget = target as { currentTarget?: unknown; target?: unknown };
  push(directTarget.target);
  push(directTarget.currentTarget);

  for (const node of candidates) {
    const anchor = node.closest?.('a[href]');
    const targetNode = (
      node instanceof HTMLAnchorElement ? node : anchor
    ) as HTMLAnchorElement | null;
    if (!targetNode) continue;

    const href = targetNode.getAttribute('href');
    if (!href || !href.includes('/i/bookmarks/')) {
      continue;
    }

    const parsed = captureBookmarkRouteFromUrl(href);
    if (!parsed?.folderId) continue;
    return {
      folderId: parsed.folderId,
      pageUrl: parsed.pageUrl,
      source: 'bookmark-click',
      confidence: 92,
    };
  }

  return null;
}

function isBookmarksApiRequest(url: string): boolean {
  try {
    const path = new URL(url, 'https://x.com').pathname.toLowerCase();
    return /(bookmarks|bookmarkfolderslice|bookmarkfoldertimeline|bookmarkcollectiontimeline|bookmarkcollectionstimeline)/.test(
      path,
    );
  } catch {
    return false;
  }
}

function resolveRequestBookmarkContext(
  url: string,
  bodyText?: string,
  request?: BookmarkRequestSource,
): BookmarkContextPayload {
  const now = Date.now();
  const pageUrl = typeof location !== 'undefined' ? location.href : '';
  const pageCandidate = resolveCanonicalRouteFromUrl(pageUrl);

  if (isBookmarksApiRequest(url)) {
    const fromRequest = extractFolderIdFromBookmarkRequestUrl(url);
    if (fromRequest) {
      return {
        folderId: fromRequest,
        pageUrl,
        source: 'request-url',
        capturedAt: now,
        requestId: request?.requestId,
        routeSource: 'request-url',
        pageRouteUrl: pageCandidate?.pageUrl,
      };
    }

    const fromBody = extractFolderIdFromBookmarkRequestBody(bodyText);
    if (fromBody) {
      return {
        folderId: fromBody,
        pageUrl,
        source: 'request-body',
        capturedAt: now,
        requestId: request?.requestId,
        routeSource: 'request-body',
        pageRouteUrl: pageCandidate?.pageUrl,
      };
    }

    if (pageCandidate?.folderId) {
      return {
        folderId: pageCandidate.folderId,
        pageUrl: pageCandidate.pageUrl || pageUrl,
        source: 'page-route',
        capturedAt: now,
        requestId: request?.requestId,
        routeSource: 'location',
        pageRouteUrl: pageCandidate.pageUrl || pageUrl,
      };
    }

    // Lock is intentionally lower priority than request-derived signals.
    // We only consult it after request URL/body and page route candidates are exhausted.
    const lock = getBookmarkContextLock(now);
    if (lock?.folderId && isBookmarksRoute(pageUrl)) {
      return {
        folderId: lock.folderId,
        pageUrl: lock.pageUrl || pageUrl,
        source: lock.source || 'active-context-lock',
        capturedAt: now,
        requestId: request?.requestId,
        routeSource: 'active-context-lock',
        pageRouteUrl: lock.pageUrl || pageUrl,
      };
    }

    const pageUrlFresh = typeof location !== 'undefined' ? location.href : pageUrl;
    if (
      activeBookmarkContext?.folderId &&
      now - activeBookmarkContext.capturedAt <= BOOKMARK_CONTEXT_BOOKMARKS_ONLY_STALE_MS
    ) {
      return {
        folderId: activeBookmarkContext.folderId,
        pageUrl: activeBookmarkContext.pageUrl || pageUrlFresh,
        source: activeBookmarkContext.source || 'active-context',
        capturedAt: now,
        requestId: request?.requestId,
        routeSource: 'active-context',
        pageRouteUrl: activeBookmarkContext.pageUrl || pageUrlFresh,
      };
    }

    const fromPage = captureBookmarkRouteFromPage();
    if (fromPage?.folderId) {
      return {
        folderId: fromPage.folderId,
        pageUrl: fromPage.pageUrl,
        source: fromPage.source,
        capturedAt: now,
        requestId: request?.requestId,
        routeSource: fromPage.source,
        pageRouteUrl: fromPage.pageUrl,
      };
    }
  }

  return normalizeBookmarkContextValue(activeBookmarkContext, {
    method: request?.method || 'GET',
    url: pageUrl,
    requestId: request?.requestId,
    hasBody: !!request?.body,
  });
}

function normalizeBookmarkContextValue(
  raw: unknown,
  request?: BookmarkRequestSource & { hasBody?: boolean },
): BookmarkContextPayload {
  const fallbackUrl =
    typeof location !== 'undefined'
      ? location.href
      : typeof document !== 'undefined'
        ? document.URL
        : '';
  const fallback = {
    folderId: null as string | null,
    pageUrl: fallbackUrl,
    source: 'fallback',
    capturedAt: Date.now(),
    requestId: request?.requestId,
  };
  if (!raw) {
    const found = captureBookmarkRouteFromPage();
    return {
      folderId: found?.folderId ?? null,
      pageUrl: found?.pageUrl ?? fallback.pageUrl,
      source: found?.source ?? fallback.source,
      requestId: request?.requestId,
      routeSource: found?.source,
      pageRouteUrl: found?.pageUrl,
      capturedAt: Date.now(),
    };
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    if (/^\d+$/.test(trimmed)) {
      return {
        folderId: trimmed,
        pageUrl: fallback.pageUrl,
        source: 'string-id',
        capturedAt: Date.now(),
        requestId: request?.requestId,
      };
    }
    const fromRaw = captureBookmarkRouteFromUrl(trimmed);
    return {
      folderId: fromRaw?.folderId ?? null,
      pageUrl: fromRaw?.pageUrl ?? fallback.pageUrl,
      source: 'raw-string',
      capturedAt: Date.now(),
      requestId: request?.requestId,
      routeSource: fromRaw?.folderId ? 'string-id' : 'fallback',
      pageRouteUrl: fromRaw?.pageUrl,
    };
  }

  if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    const candidates = [
      asObj.folderUrl,
      asObj.pageUrl,
      asObj.url,
      asObj.location,
      asObj.currentUrl,
      asObj.pageUrlBase64,
    ]
      .map((value): unknown => value)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const now = Date.now();
    const candidate = candidates
      .map((value) => captureBookmarkRouteFromUrl(value))
      .find((value): value is { folderId: string | null; pageUrl: string } => !!value?.folderId);
    const directFolderId =
      typeof asObj.folderId === 'string' || typeof asObj.folderId === 'number'
        ? String(asObj.folderId)
        : null;
    const pageUrl =
      typeof asObj.pageUrl === 'string' && asObj.pageUrl.length > 0
        ? asObj.pageUrl
        : typeof asObj.url === 'string' && asObj.url.length > 0
          ? asObj.url
          : fallback.pageUrl;

    if (candidate?.folderId) {
      return {
        folderId: candidate.folderId,
        pageUrl: candidate.pageUrl,
        source:
          typeof asObj.source === 'string' && asObj.source.length > 0 ? asObj.source : 'object',
        capturedAt: typeof asObj.capturedAt === 'number' ? asObj.capturedAt : now,
        requestId: request?.requestId,
        routeSource:
          typeof asObj.source === 'string' && asObj.source.length > 0 ? asObj.source : 'object',
        pageRouteUrl: pageUrl,
      };
    }

    if (directFolderId && /^\d+$/.test(directFolderId)) {
      return {
        folderId: directFolderId,
        pageUrl,
        source:
          typeof asObj.source === 'string' && asObj.source.length > 0 ? asObj.source : 'object',
        capturedAt: typeof asObj.capturedAt === 'number' ? asObj.capturedAt : now,
        requestId: request?.requestId,
        routeSource:
          typeof asObj.source === 'string' && asObj.source.length > 0 ? asObj.source : 'object',
        pageRouteUrl: pageUrl,
      };
    }
  }

  const fromLocation = captureBookmarkRouteFromPage();
  return {
    folderId: fromLocation?.folderId ?? null,
    pageUrl: fromLocation?.pageUrl ?? fallback.pageUrl,
    source: 'fallback',
    capturedAt: Date.now(),
    requestId: request?.requestId,
    routeSource: fromLocation?.source,
    pageRouteUrl: fromLocation?.pageUrl,
  };
}

function captureBookmarkRouteFromPage(): BookmarkRouteCandidate | null {
  const candidates: BookmarkRouteCandidate[] = [];

  const tabCandidate = captureBookmarkRouteFromBookmarkTabs();
  if (tabCandidate) candidates.push(tabCandidate);
  const historyCandidate = captureBookmarkRouteFromHistoryState();
  if (historyCandidate) candidates.push(historyCandidate);
  const navigationCandidate = captureBookmarkRouteFromPerformanceNavigation();
  if (navigationCandidate) candidates.push(navigationCandidate);
  const globalCandidate = captureBookmarkRouteFromGlobalState();
  if (globalCandidate) candidates.push(globalCandidate);

  const bestFolderCandidate = candidates
    .filter((candidate) => !!candidate.folderId)
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (bestFolderCandidate) {
    return {
      folderId: bestFolderCandidate.folderId,
      pageUrl: bestFolderCandidate.pageUrl,
      source: bestFolderCandidate.source,
      confidence: bestFolderCandidate.confidence,
    };
  }

  const urlCandidates: Array<{ source: string; url: string }> = [];
  const locationUrl = typeof location !== 'undefined' ? location.href : '';
  const documentUrl = typeof document !== 'undefined' ? document.URL : '';
  const canonical =
    typeof document !== 'undefined'
      ? (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)
      : null;
  const og =
    typeof document !== 'undefined'
      ? (document.querySelector('meta[property="og:url"]') as HTMLMetaElement | null)
      : null;

  if (locationUrl) urlCandidates.push({ source: 'location', url: locationUrl });
  if (documentUrl && documentUrl !== locationUrl)
    urlCandidates.push({ source: 'document', url: documentUrl });
  if (canonical?.href) urlCandidates.push({ source: 'canonical', url: canonical.href });
  if (og?.content) urlCandidates.push({ source: 'og', url: og.content });

  for (const candidate of urlCandidates) {
    const parsed = captureBookmarkRouteFromUrl(candidate.url);
    if (parsed?.folderId) {
      return { ...parsed, source: candidate.source, confidence: 30 };
    }
  }

  const firstCandidate = urlCandidates[0];
  if (!firstCandidate) return null;
  const firstUrl = firstCandidate.url;
  if (!firstUrl) return null;
  return {
    folderId: null,
    pageUrl: firstUrl,
    source: firstCandidate.source,
    confidence: 14,
  };
}

function isBookmarksRoute(url: string): boolean {
  try {
    return /\/i\/bookmarks(?:\/|$)/.test(new URL(url, 'https://x.com').pathname);
  } catch {
    return false;
  }
}

function setBookmarkContext(value: unknown): void {
  const payload = normalizeBookmarkContextValue(value);
  activeBookmarkContext = payload;
  if (payload.folderId) {
    setBookmarkContextLock(payload);
  } else if (!isBookmarksRoute(payload.pageUrl)) {
    clearBookmarkContextLock();
  }
}

function defineOn(target: object, name: string, fn: unknown): boolean {
  if (typeof fn !== 'function') {
    return false;
  }
  const hookFn = fn as HookCallable;
  const exportFunctionMaybe = getExportFunctionMaybe();
  if (exportFunctionMaybe) {
    try {
      exportFunctionMaybe(hookFn, target, { defineAs: name });
      return true;
    } catch (err) {
      // Do not fall back to direct assignment when exportFunction exists but fails.
      // Assigning content-realm hook functions onto page-realm targets causes Firefox
      // cross-compartment permission faults inside X's runtime.
      logger.error(`Failed to define ${name} hook`, err);
      return false;
    }
  }

  // Only direct-assign in same-realm cases. Cross-realm direct assignment is unsafe.
  if (target !== (globalThis as unknown as object)) {
    logger.error(
      `Failed to define ${name} hook`,
      new Error('exportFunction unavailable for cross-realm target'),
    );
    return false;
  }

  try {
    (target as Record<string, unknown>)[name] = hookFn;
    return true;
  } catch (err) {
    logger.error(`Failed to define ${name} hook`, err);
    return false;
  }
}

function getFunctionFromHookState(
  candidate: unknown,
  marker: '__twe_is_hook_open_v1' | '__twe_is_hook_send_v1' | '__twe_is_hook_fetch_v1',
  originalKey: string,
): unknown {
  if (!candidate || typeof candidate !== 'function') {
    return undefined;
  }

  let current = candidate as unknown as Record<string, unknown>;
  if (!hasHookShape(candidate, marker)) {
    return candidate;
  }

  for (let i = 0; i < 10; i++) {
    const nested = current[originalKey];
    if (!nested || typeof nested !== 'function') {
      return undefined;
    }
    if (!hasHookShape(nested, marker)) {
      return nested;
    }
    current = nested as unknown as Record<string, unknown>;
  }
  return undefined;
}

function isUsableFetchBaseCandidate(candidate: unknown): candidate is typeof fetch {
  if (typeof candidate !== 'function') return false;
  // Never accept a function that looks like one of our wrappers as the "base" fetch.
  if (hasHookShape(candidate, '__twe_is_hook_fetch_v1')) return false;
  return true;
}

function getObjectStringProperty(value: unknown, key: string): string | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? candidate : null;
  } catch {
    return null;
  }
}

function extractFetchLikeMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = typeof init?.method === 'string' && init.method ? init.method : null;
  if (fromInit) return fromInit;

  try {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return input.method || 'GET';
    }
  } catch {
    // ignore
  }

  const fromInput = getObjectStringProperty(input, 'method');
  if (fromInput && fromInput.length > 0) return fromInput;
  return 'GET';
}

function extractFetchLikeUrl(input: RequestInfo | URL): string {
  try {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url || '';
  } catch {
    // ignore
  }

  const fromInput = getObjectStringProperty(input, 'url');
  if (fromInput && fromInput.length > 0) return fromInput;

  try {
    return String(input ?? '');
  } catch {
    return '';
  }
}

function isCaptureCandidateApiUrl(url: string): boolean {
  if (!url) return false;
  return /\/graphql\/|\/i\/api\/|\/api\/1\.1\/|\/api\/2\//.test(url);
}

function getSafeErrorInfo(error: unknown): { name: string; message: string; summary: string } {
  let name: string = typeof error;
  let message = '';

  if (error === null) {
    return { name: 'null', message: 'null', summary: 'null: null' };
  }
  if (typeof error === 'undefined') {
    return { name: 'undefined', message: 'undefined', summary: 'undefined: undefined' };
  }
  if (typeof error === 'string') {
    return { name: 'Error', message: error, summary: `Error: ${error}` };
  }

  try {
    const candidate = error as { name?: unknown; message?: unknown };
    if (typeof candidate.name === 'string' && candidate.name.length > 0) {
      name = candidate.name;
    }
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      message = candidate.message;
    }
  } catch {
    // ignore
  }

  if (!message) {
    try {
      message = String(error);
    } catch {
      message = '[inaccessible error object]';
    }
  }

  return {
    name,
    message,
    summary: `${name}: ${message}`,
  };
}

function isLikelyCrossRealmPermissionError(error: unknown): boolean {
  const info = getSafeErrorInfo(error);
  return /permission denied to access (property|object|then|apply)/i.test(info.summary);
}

function postHookMessage(payload: unknown): void {
  const messageTargetOrigin = '*';
  try {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      (payload as { __twe_mcp_hook_v1?: unknown }).__twe_mcp_hook_v1 !== true
    ) {
      return;
    }

    const data = payload as {
      req?: {
        __twe_hook_revision_v1?: number;
      };
    };
    if (data.req && typeof data.req === 'object') {
      data.req = buildNormalizedHookMessageRequest(data.req);
    }
    payload = {
      ...(payload as Record<string, unknown>),
      __twe_msg_revision_v1: HOOK_REVISION,
    };

    const postMessageOnHookGlobal = (hookGlobalObject as Record<string, unknown>).postMessage as (
      message: unknown,
      targetOrigin: string,
    ) => void | undefined;
    postMessageOnHookGlobal?.(payload, messageTargetOrigin);
    return;
  } catch {
    // ignore
  }

  try {
    const postMessageOnGlobalThis = (globalThis as Record<string, unknown>).postMessage as (
      message: unknown,
      targetOrigin: string,
    ) => void | undefined;
    postMessageOnGlobalThis?.(payload, messageTargetOrigin);
  } catch {
    // ignore
  }
}

function addEventListenerSafe(
  target: unknown,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions | boolean,
): boolean {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    return false;
  }
  const addEventListener = (target as { addEventListener?: unknown }).addEventListener;
  if (typeof addEventListener !== 'function') {
    return false;
  }
  try {
    addEventListener.call(target, type, listener, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * The registry for all extensions.
 */
export class ExtensionManager {
  private extensions: Map<string, Extension> = new Map();
  private disabledExtensions: Set<string> = new Set();
  private debugEnabled = false;
  private hookStats: HookStats | null = null;
  private hookRuntime: HookStats | null = null;
  private recentResponseSigs: Map<string, RecentSig> = new Map();
  private lastStickyBookmarkContext: BookmarkContextPayload | null = null;
  private readonly runtimeControlPlane: RuntimeControlPlane;
  private readonly interceptorDispatcher = new ExtensionInterceptorDispatcher();
  private pageMessageHandler: ((event: MessageEvent<unknown>) => void) | null = null;
  private instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  public readonly __twe_extension_manager_signature_v1 = EXTENSION_MANAGER_SIGNATURE;
  public readonly __twe_extension_manager_revision_v1 = EXTENSION_MANAGER_REVISION;
  public readonly __twe_extension_manager_started_at_v1 = Date.now();
  private disposed = false;
  private endpointMetricLimit = 40;

  /**
   * Signal for subscribing to extension changes.
   */
  public signal = new Signal(1);

  private get runtimeModes(): RuntimeModes {
    return this.runtimeControlPlane.getRuntimeModes();
  }

  private get hookDebugConfig(): HookDebugConfig {
    return this.runtimeControlPlane.getHookDebugConfig();
  }

  private isHookModeEnabled(target: 'xhr' | 'fetch'): boolean {
    return this.runtimeControlPlane.isHookModeEnabled(target);
  }

  private refreshHookDebugConfig() {
    this.runtimeControlPlane.refreshHookDebugConfig();
  }

  private emitHookDiag(
    phase: string,
    payload: Record<string, unknown>,
    options?: { force?: boolean },
  ) {
    this.runtimeControlPlane.emitHookDiag(phase, payload, options);
  }

  private enableSafeMode(reason: string, error?: unknown) {
    this.runtimeControlPlane.enableSafeMode(reason, error);
  }

  public applyRuntimeModesFromOptions() {
    this.runtimeControlPlane.applyRuntimeModesFromOptions();
  }

  public getRuntimeModesSnapshot(): {
    safeMode: boolean;
    hookMode: HookMode;
    repairMode: RepairMode;
    reason?: string;
  } {
    return this.runtimeControlPlane.getRuntimeModesSnapshot();
  }

  public getHookStatsSnapshot(): {
    xhrMessages: number;
    fetchMessages: number;
    lastUrl: string;
    lastAt: number;
  } | null {
    return this.runtimeControlPlane.getHookStatsSnapshot();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    try {
      this.getExtensions().forEach((ext) => {
        try {
          if (ext.enabled) {
            ext.enabled = false;
            ext.dispose();
          }
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }

    if (this.pageMessageHandler) {
      try {
        window.removeEventListener('message', this.pageMessageHandler, false);
      } catch {
        // ignore
      }
      this.pageMessageHandler = null;
    }

    this.runtimeControlPlane.dispose();
  }

  private runHookSelfTest(): { ok: boolean; error?: string } {
    try {
      if (this.runtimeModes.safeMode || this.runtimeModes.hookMode === 'off') {
        return { ok: true };
      }
      const hookTarget = getHookGlobalObject() as unknown as Record<string, unknown>;
      if (this.isHookModeEnabled('xhr')) {
        const xhrCtor = hookTarget.XMLHttpRequest as
          | { prototype?: { open?: unknown; send?: unknown } }
          | undefined;
        if (!xhrCtor?.prototype) {
          return { ok: false, error: 'XMLHttpRequest.prototype unavailable' };
        }
        if (typeof xhrCtor.prototype.open !== 'function') {
          return { ok: false, error: 'XMLHttpRequest.prototype.open unavailable' };
        }
        if (typeof xhrCtor.prototype.send !== 'function') {
          return { ok: false, error: 'XMLHttpRequest.prototype.send unavailable' };
        }
      }
      if (this.isHookModeEnabled('fetch')) {
        const fetchCandidate = hookTarget.fetch;
        if (typeof fetchCandidate !== 'function') {
          return { ok: false, error: 'fetch unavailable' };
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private syncRuntimeStats() {
    if (!this.hookStats || !this.hookRuntime) return;
    this.hookRuntime.messagesTotal = this.hookStats.messagesTotal;
    this.hookRuntime.messagesLegacyShape = this.hookStats.messagesLegacyShape;
    this.hookRuntime.messagesMissingContext = this.hookStats.messagesMissingContext;
    this.hookRuntime.messagesRepairedAtBridge = this.hookStats.messagesRepairedAtBridge;
    this.hookRuntime.messagesMissingBody = this.hookStats.messagesMissingBody;
    this.hookRuntime.responsesProcessed = this.hookStats.responsesProcessed;
    this.hookRuntime.responsesSkippedDuplicate = this.hookStats.responsesSkippedDuplicate;
    this.hookRuntime.lastMessageAt = this.hookStats.lastMessageAt;
    this.hookRuntime.activeInstanceId = this.hookStats.activeInstanceId;
    this.hookRuntime.rev = this.hookStats.rev;
    this.hookRuntime.endpointStats = this.hookStats.endpointStats;
  }

  private readHookStatsSnapshot(): {
    xhrMessages: number;
    fetchMessages: number;
    lastUrl: string;
    lastAt: number;
  } | null {
    if (!this.hookStats) return null;
    return {
      xhrMessages: Number(this.hookStats.xhrMessages || 0),
      fetchMessages: Number(this.hookStats.fetchMessages || 0),
      lastUrl: typeof this.hookStats.lastUrl === 'string' ? this.hookStats.lastUrl : '',
      lastAt: Number(this.hookStats.lastAt || 0),
    };
  }

  private getEndpointStats(key: string): EndpointHookMetrics {
    if (!this.hookStats) return createEndpointMetrics();

    const existing = this.hookStats.endpointStats[key];
    if (existing) return existing;

    if (Object.keys(this.hookStats.endpointStats).length >= this.endpointMetricLimit) {
      const keys = Object.keys(this.hookStats.endpointStats);
      const oldest = keys[0];
      if (oldest) {
        delete this.hookStats.endpointStats[oldest];
      }
    }

    const next = createEndpointMetrics();
    this.hookStats.endpointStats[key] = next;
    return next;
  }

  public uninstallHooks() {
    try {
      const g = hookGlobalObject as Record<string, unknown>;
      const xhrCtor = g.XMLHttpRequest as { prototype?: Record<string, unknown> } | undefined;
      const proto = xhrCtor?.prototype;
      if (proto) {
        if (typeof proto[ORIG_XHR_OPEN_KEY] === 'function') {
          proto.open = proto[ORIG_XHR_OPEN_KEY];
        }
        if (typeof proto[ORIG_XHR_SEND_KEY] === 'function') {
          proto.send = proto[ORIG_XHR_SEND_KEY];
        }
        delete proto.__twe_is_hook_open_v1;
        delete proto.__twe_is_hook_send_v1;
        delete proto.__twe_is_hook_revision_v1;
      }

      if (typeof g[ORIG_FETCH_KEY] === 'function') {
        g.fetch = g[ORIG_FETCH_KEY];
      }
      if (typeof g.fetch === 'object' && g.fetch !== null) {
        const fetchFn = g.fetch as Record<string, unknown>;
        delete fetchFn.__twe_is_hook_fetch_v1;
        delete fetchFn.__twe_is_hook_revision_v1;
      }
    } catch {
      // ignore
    }
  }

  constructor() {
    this.runtimeControlPlane = new RuntimeControlPlane({
      installPageMessageBridge: () => this.installPageMessageBridge(),
      installBookmarkContextTracking: () => this.installBookmarkContextTracking(),
      installHttpHooks: (force?: boolean) => this.installHttpHooks(force),
      installFetchHooks: (force?: boolean) => this.installFetchHooks(force),
      uninstallHooks: () => this.uninstallHooks(),
      runHookSelfTest: () => this.runHookSelfTest(),
      runFetchHookBootProbePass: () => this.runFetchHookBootProbePass(),
      runHookRepairPass: () => this.runHookRepairPass(),
      readHookStatsSnapshot: () => this.readHookStatsSnapshot(),
    });
    this.disabledExtensions = new Set(options.get('disabledExtensions', []));

    if (options.get('debug')) {
      this.debugEnabled = true;
      logger.info('Debug mode enabled');
    }

    clearBootstrapErrorMarker();

    let constructorError: BootstrapErrorReport | null = null;
    try {
      this.hookStats = createHookStats(this.instanceId);
      this.hookRuntime = this.hookStats;
      this.syncRuntimeStats();
    } catch (error) {
      constructorError = recordBootstrapError(
        'ExtensionManager.constructor',
        this.instanceId,
        error,
      );
      logger.error('ExtensionManager constructor bootstrap error', error);
    }

    try {
      const fallbackStats = normalizeRuntimeForRead(
        this.hookStats,
        createHookStats(this.instanceId),
      );
      if (!this.hookStats || this.hookStats.activeInstanceId !== this.instanceId) {
        this.hookStats = fallbackStats;
      }
      this.hookStats.activeInstanceId = this.instanceId;
      this.hookStats.rev = HOOK_REVISION;
      if (constructorError) {
        this.hookStats.repairCount = (this.hookStats.repairCount || 0) + 1;
      }
      this.hookRuntime = this.hookStats;
      this.syncRuntimeStats();
    } catch {
      // ignore
    }

    if (!this.hookRuntime || !this.hookStats) {
      this.hookStats = createHookStats(this.instanceId);
      this.hookRuntime = this.hookStats;
      this.syncRuntimeStats();
    }

    this.runtimeControlPlane.initialize();
  }

  private applyBookmarkRouteCandidate(candidate: BookmarkRouteCandidate | null) {
    const now = Date.now();
    const currentRoute = typeof location !== 'undefined' ? location.href : '';
    const routeIsBookmarks = isBookmarksRoute(currentRoute);
    const candidateIsBookmarks = candidate?.pageUrl
      ? isBookmarksRoute(candidate.pageUrl)
      : routeIsBookmarks;

    if (!candidate) {
      if (routeIsBookmarks && this.lastStickyBookmarkContext?.folderId) {
        const keep = this.lastStickyBookmarkContext;
        if (now - keep.capturedAt <= BOOKMARK_CONTEXT_BOOKMARKS_ONLY_STALE_MS) {
          setBookmarkContext({
            folderId: keep.folderId,
            pageUrl: keep.pageUrl || currentRoute,
            source: keep.source,
            capturedAt: now,
          });
          return;
        }
      }
      this.lastStickyBookmarkContext = null;
      setBookmarkContext({
        folderId: null,
        pageUrl: currentRoute,
        source: 'refresh',
        capturedAt: now,
      });
      return;
    }

    if (!candidateIsBookmarks) {
      this.lastStickyBookmarkContext = null;
      setBookmarkContext({
        folderId: null,
        pageUrl: candidate.pageUrl,
        source: candidate.source,
        capturedAt: now,
      });
      return;
    }

    if (candidate.folderId) {
      const sticky: BookmarkContextPayload = {
        folderId: candidate.folderId,
        pageUrl: candidate.pageUrl,
        source: candidate.source,
        capturedAt: now,
      };
      this.lastStickyBookmarkContext = sticky;
      setBookmarkContext(sticky);
      return;
    }

    const lastSticky = this.lastStickyBookmarkContext;
    const allowFallback =
      lastSticky &&
      !!lastSticky.folderId &&
      candidate.confidence <= BOOKMARK_CONTEXT_MIN_CONFIDENCE &&
      now - lastSticky.capturedAt <= BOOKMARK_CONTEXT_BOOKMARKS_ONLY_STALE_MS;

    if (!candidate.folderId && allowFallback) {
      setBookmarkContext({
        folderId: lastSticky.folderId,
        pageUrl: candidate.pageUrl,
        source: lastSticky.source,
        capturedAt: now,
      });
      return;
    }

    if (
      !candidate.folderId &&
      routeIsBookmarks &&
      lastSticky?.folderId &&
      now - lastSticky.capturedAt <= BOOKMARK_CONTEXT_BOOKMARKS_ONLY_STALE_MS
    ) {
      setBookmarkContext({
        folderId: lastSticky.folderId,
        pageUrl: candidate.pageUrl,
        source: lastSticky.source,
        capturedAt: now,
      });
      return;
    }

    this.lastStickyBookmarkContext = null;
    setBookmarkContext({
      folderId: null,
      pageUrl: candidate.pageUrl,
      source: candidate.source,
      capturedAt: now,
    });
  }

  private updateBookmarkRouteContext() {
    try {
      const pageContext = captureBookmarkRouteFromPage();
      this.applyBookmarkRouteCandidate(pageContext ?? null);
    } catch {
      // ignore
    }
  }

  private installBookmarkContextTracking() {
    if (this.runtimeModes.safeMode || this.runtimeModes.hookMode === 'off') {
      return;
    }

    this.updateBookmarkRouteContext();

    const historyObj = hookGlobalObject.history;
    if (!historyObj) return;
    const refreshContext = () => this.updateBookmarkRouteContext();
    const applyNavigationCandidate = (candidate: BookmarkRouteCandidate | null) => {
      this.applyBookmarkRouteCandidate(candidate);
    };
    // Do not wrap history methods in Firefox content realm. Cross-realm wrappers
    // can trigger "Permission denied to access property 'apply'" in X runtime.
    // Route context is maintained via event listeners + click/DOM observers below.

    if (!hookGlobalObject.__twe_bookmark_context_listeners_v1) {
      hookGlobalObject.__twe_bookmark_context_listeners_v1 = true;
      const listenerTargets = [hookGlobalObject, window, globalThis];
      for (const target of listenerTargets) {
        addEventListenerSafe(target, 'popstate', refreshContext);
        addEventListenerSafe(target, 'hashchange', refreshContext);
      }
    }

    if (!hookGlobalObject.__twe_bookmark_context_bookmark_click_v1 && document?.body) {
      const onClick = (event: Event) => {
        try {
          const target = event.target as EventTarget | null;
          const candidate = captureBookmarkRouteFromEventTarget(target);
          if (candidate) {
            applyNavigationCandidate(candidate);
          }
        } catch {
          // ignore
        }
      };
      hookGlobalObject.__twe_bookmark_context_bookmark_click_v1 = true;
      const clickTargets = [hookGlobalObject, window, document, globalThis];
      let clickListenerInstalled = false;
      for (const target of clickTargets) {
        clickListenerInstalled =
          addEventListenerSafe(target, 'click', onClick, { capture: true }) ||
          clickListenerInstalled;
      }
      if (!clickListenerInstalled && document?.body) {
        addEventListenerSafe(document.body, 'click', onClick, { capture: true });
      }
      hookGlobalObject.__twe_bookmark_context_bookmark_click_handler_v1 = onClick;
    }

    if (!hookGlobalObject.__twe_bookmark_context_interval_v1) {
      // Some execution paths update bookmark page state outside push/replace state hooks.
      hookGlobalObject.__twe_bookmark_context_interval_v1 = setInterval(() => {
        try {
          this.updateBookmarkRouteContext();
        } catch {
          // ignore
        }
      }, 1200);
    }

    if (!hookGlobalObject.__twe_bookmark_context_mutation_v1) {
      const doc = document;
      const hasMutationObserver = typeof MutationObserver !== 'undefined';
      if (doc?.body && hasMutationObserver) {
        const observer = new MutationObserver(() => {
          this.updateBookmarkRouteContext();
        });
        observer.observe(doc.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['href', 'aria-selected', 'data-state', 'class'],
        });
        hookGlobalObject.__twe_bookmark_context_mutation_v1 = observer;
      }
    }
  }

  /**
   * Register and instantiate a new extension.
   *
   * @param ctor Extension constructor.
   */
  public add(ctor: ExtensionConstructor) {
    try {
      logger.debug(`Register new extension: ${ctor.name}`);
      const instance = new ctor(this);
      const previous = this.extensions.get(instance.name);
      if (previous && previous !== instance) {
        try {
          if (previous.enabled) {
            previous.dispose();
          }
        } catch {
          // ignore
        }
      }
      this.extensions.set(instance.name, instance);
    } catch (err) {
      logger.error(`Failed to register extension: ${ctor.name}`, err);
    }
  }

  /**
   * Set up all enabled extensions.
   */
  public start() {
    for (const ext of this.extensions.values()) {
      if (this.disabledExtensions.has(ext.name)) {
        this.disable(ext.name);
      } else {
        this.enable(ext.name);
      }
    }
  }

  public enable(name: string) {
    try {
      this.disabledExtensions.delete(name);
      options.set('disabledExtensions', [...this.disabledExtensions]);

      const ext = this.extensions.get(name)!;
      if (ext.enabled) return;
      ext.enabled = true;
      ext.setup();

      logger.debug(`Enabled extension: ${name}`);
      this.signal.value++;
    } catch (err) {
      logger.error(`Failed to enable extension: ${name}`, err);
    }
  }

  public disable(name: string) {
    try {
      this.disabledExtensions.add(name);
      options.set('disabledExtensions', [...this.disabledExtensions]);

      const ext = this.extensions.get(name)!;
      if (!ext.enabled) return;
      ext.enabled = false;
      ext.dispose();

      logger.debug(`Disabled extension: ${name}`);
      this.signal.value++;
    } catch (err) {
      logger.error(`Failed to disable extension: ${name}`, err);
    }
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getExtensions() {
    return [...this.extensions.values()];
  }

  private installPageMessageBridge() {
    if (this.runtimeModes.hookMode === 'off') {
      return;
    }

    // Listen for page-realm hook events. We keep interceptors in content realm,
    // and only pass serializable data across via postMessage.
    if (this.pageMessageHandler) return;

    this.pageMessageHandler = (event: MessageEvent) => {
      try {
        const origin = event.origin || '';
        if (origin && !/^https:\/\/(x|twitter|mobile\.x)\.com$/.test(origin)) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = event.data as any;
        if (!data || data[HOOK_MESSAGE_FLAG] !== true) return;
        const messageRevision = getBridgeMessageRevision(data);
        const isLegacyMessage = messageRevision === null || messageRevision !== HOOK_REVISION;
        const requestCandidate = pickBridgeRequest(data);
        const bridgeReq = normalizeHookPayloadRequest(requestCandidate);
        const res = data.res as { status: number; responseText: string } | undefined;
        if (!res) return;
        const rawEnvelopeRequest =
          requestCandidate && typeof requestCandidate === 'object'
            ? (requestCandidate as Record<string, unknown>)
            : null;
        const requestId =
          typeof bridgeReq.requestId === 'string' && bridgeReq.requestId.trim().length
            ? bridgeReq.requestId
            : typeof (rawEnvelopeRequest as { requestId?: unknown })?.requestId === 'string' &&
                (rawEnvelopeRequest as { requestId?: string }).requestId?.trim().length
              ? (rawEnvelopeRequest as { requestId: string }).requestId
              : nextBookmarkRequestId();
        const incomingMethod =
          typeof bridgeReq.method === 'string' && bridgeReq.method
            ? bridgeReq.method
            : typeof (rawEnvelopeRequest as { method?: unknown })?.method === 'string'
              ? ((rawEnvelopeRequest as { method?: unknown }).method as string)
              : 'GET';
        const incomingUrl =
          typeof bridgeReq.url === 'string' && bridgeReq.url.length
            ? bridgeReq.url
            : typeof (rawEnvelopeRequest as { url?: unknown })?.url === 'string'
              ? ((rawEnvelopeRequest as { url?: unknown }).url as string)
              : '';
        if (!incomingUrl) return;
        const incomingBody =
          typeof bridgeReq.body === 'string'
            ? bridgeReq.body
            : typeof (rawEnvelopeRequest as { body?: unknown })?.body === 'string'
              ? ((rawEnvelopeRequest as { body?: unknown }).body as string)
              : undefined;

        const requestContextFromLegacyWrapper = rawEnvelopeRequest
          ? (
              rawEnvelopeRequest as Record<string, { bookmarkContext?: unknown }> as {
                bookmarkContext?: unknown;
              }
            ).bookmarkContext
          : undefined;
        const requestContextFromAlternative =
          rawEnvelopeRequest &&
          Object.prototype.hasOwnProperty.call(rawEnvelopeRequest, 'requestContext')
            ? (rawEnvelopeRequest as Record<string, unknown>).requestContext
            : undefined;
        const hasRequestContext =
          (requestContextFromLegacyWrapper !== undefined &&
            requestContextFromLegacyWrapper !== null) ||
          (requestContextFromAlternative !== undefined && requestContextFromAlternative !== null) ||
          bridgeReq.bookmarkContext !== undefined;
        const hasBodyField =
          typeof bridgeReq.body === 'string' ||
          typeof (rawEnvelopeRequest as { body?: unknown })?.body === 'string';
        const hasRequestIdField =
          (typeof bridgeReq.requestId === 'string' && bridgeReq.requestId.trim().length > 0) ||
          (typeof (rawEnvelopeRequest as { requestId?: unknown })?.requestId === 'string' &&
            ((rawEnvelopeRequest as { requestId?: string }).requestId?.trim().length || 0) > 0);
        const req = buildNormalizedHookMessageRequest({
          method: incomingMethod,
          url: incomingUrl,
          body: incomingBody,
          bookmarkContext:
            bridgeReq.bookmarkContext ??
            requestContextFromLegacyWrapper ??
            requestContextFromAlternative,
          requestId,
        });
        const bridgeRepaired =
          isLegacyMessage || !hasRequestContext || !hasBodyField || !hasRequestIdField;
        const isBookmarksMessage = isBookmarksApiRequest(req.url);
        const endpointKey = isBookmarksMessage ? extractBookmarksEndpoint(req.url) : null;
        const endpointStats = endpointKey ? this.getEndpointStats(endpointKey) : null;
        const now = Date.now();
        const responseText = typeof res.responseText === 'string' ? res.responseText : '';

        if (!this.hookStats) return;
        if (bridgeRepaired) {
          this.hookStats.messagesRepairedAtBridge++;
        }
        if (!hasBodyField) {
          this.hookStats.messagesMissingBody++;
        }
        if (isLegacyMessage) {
          this.hookStats.messagesLegacyShape++;
        }

        if (endpointStats) {
          endpointStats.received += 1;
          endpointStats.lastAt = now;
          endpointStats.lastStatus = res.status ?? 0;
          endpointStats.lastUrl = req.url;
        }

        if (!hasRequestContext) {
          this.hookStats.messagesLegacyShape++;
          if (endpointStats) endpointStats.legacyShape += 1;
        }

        if (!hasRequestContext || req.bookmarkContext === null) {
          this.hookStats.messagesMissingContext++;
          if (endpointStats) endpointStats.missingContext += 1;
          req.bookmarkContext = resolveRequestBookmarkContext(req.url, req.body, {
            method: req.method,
            url: req.url,
            body: req.body,
            requestId,
          });
        } else {
          req.bookmarkContext = normalizeBookmarkContextValue(req.bookmarkContext, {
            method: req.method,
            url: req.url,
            body: req.body,
            requestId,
            hasBody: !!req.body,
          });
        }
        setBookmarkContext(req.bookmarkContext);

        appendBookmarkContextDump({
          requestId,
          ts: Date.now(),
          method: req.method,
          url: req.url,
          hasBody: !!req.body,
          confidenceSource:
            typeof (req.bookmarkContext as BookmarkContextPayload | undefined)?.source === 'string'
              ? (req.bookmarkContext as BookmarkContextPayload).source
              : 'unknown',
          context: req.bookmarkContext as BookmarkContextPayload,
          normalizedRoute: resolveCanonicalRouteFromUrl(req.url).pageUrl,
        });

        // Payload-level dedupe/backpressure: Twitter will sometimes re-emit the same
        // timeline payload (and spliced timelines can lead to repeated updates).
        // JSON.parse is expensive; skip identical payloads briefly.
        const method = (req.method || 'GET').toUpperCase();
        const isBookmarkApiRequest = isBookmarksApiRequest(req.url);
        if (!isBookmarkApiRequest) {
          const dedupeKey = createRequestSignature(method, req.url, res.status ?? 0, responseText);
          const prev = this.recentResponseSigs.get(dedupeKey);
          if (prev && now - prev.at < RESPONSE_DEDUPE_WINDOW_MS) {
            this.hookStats.responsesSkippedDuplicate++;
            if (endpointStats) endpointStats.skippedDuplicate += 1;
            this.syncRuntimeStats();
            return;
          }

          this.recentResponseSigs.set(dedupeKey, { sig: dedupeKey, at: now });
          cleanupSignatureCache(this.recentResponseSigs);
        }

        this.hookStats.responsesProcessed++;
        if (endpointStats) {
          endpointStats.processed += 1;
          endpointStats.newUniqueTweets += countUniqueTweetIds(responseText);
        }
        this.hookStats.messagesTotal++;
        this.hookStats.lastMessageAt = now;

        if (this.hookStats) {
          this.hookStats.lastUrl = req.url;
          this.hookStats.lastAt = Date.now();
          // Heuristic: treat non-GET as XHR-ish (GraphQL fetch is often POST).
          if ((req.method || '').toUpperCase() === 'GET') this.hookStats.xhrMessages++;
          else this.hookStats.fetchMessages++;

          if (this.debugEnabled && this.hookStats.loggedUrls < 5) {
            this.hookStats.loggedUrls++;
            logger.debug('Hook saw request', {
              method: req.method,
              url: req.url,
              status: res.status,
            });
          }
          this.syncRuntimeStats();
        }

        const pseudoXhr = {
          status: res.status,
          responseText,
        } as XMLHttpRequest;

        this.runInterceptors(req, pseudoXhr);
      } catch (err) {
        logger.debug('Failed to process hook message', err);
      }
    };

    window.addEventListener('message', this.pageMessageHandler, false);
  }

  /**
   * Here we hooks the browser's XHR method to intercept Twitter's Web API calls.
   * This need to be done before any XHR request is made.
   */
  private installHttpHooks(force = false) {
    if (!this.isHookModeEnabled('xhr')) {
      return;
    }

    this.refreshHookDebugConfig();
    const hookDebug = this.hookDebugConfig;
    this.emitHookDiag('xhr.install.begin', { force, ...hookDebug });
    if (hookDebug.disableXhrLoadListener) {
      this.emitHookDiag('xhr.load.listener.disabled', {}, { force: true });
    }
    let hookInstalled = false;
    let originalOpen: unknown;
    try {
      if (
        !hookGlobalObject.XMLHttpRequest?.prototype ||
        !hookGlobalObject.XMLHttpRequest?.prototype?.open
      ) {
        throw new Error('XMLHttpRequest.prototype.open not available');
      }

      // Stash originals in page-realm so wrappers can call through safely.

      const proto = hookGlobalObject.XMLHttpRequest.prototype as unknown as Record<string, unknown>;
      const currentOpen = proto.open;
      const currentSend = proto.send;
      originalOpen =
        typeof proto[ORIG_XHR_OPEN_KEY] === 'function' ? proto[ORIG_XHR_OPEN_KEY] : currentOpen;
      if (!proto[ORIG_XHR_OPEN_KEY] && typeof currentOpen === 'function') {
        proto[ORIG_XHR_OPEN_KEY] = currentOpen;
      }
      if (!proto[ORIG_XHR_SEND_KEY] && typeof currentSend === 'function') {
        proto[ORIG_XHR_SEND_KEY] = currentSend;
      }

      const wrappedSendFromState = getFunctionFromHookState(
        currentSend,
        '__twe_is_hook_send_v1',
        ORIG_XHR_SEND_KEY,
      );
      const sendBase =
        typeof wrappedSendFromState === 'function'
          ? (wrappedSendFromState as XMLHttpRequest['send'])
          : typeof proto[ORIG_XHR_SEND_KEY] === 'function'
            ? (proto[ORIG_XHR_SEND_KEY] as XMLHttpRequest['send'])
            : (currentSend as XMLHttpRequest['send']);
      if (typeof sendBase !== 'function') {
        throw new Error('XMLHttpRequest.prototype.send not available');
      }

      const sendNeedsRepair =
        !hookDebug.disableXhrSendWrap &&
        (force || !hasHookVersion(currentSend, '__twe_is_hook_send_v1'));
      if (hookDebug.disableXhrSendWrap) {
        if (typeof proto[ORIG_XHR_SEND_KEY] === 'function') {
          proto.send = proto[ORIG_XHR_SEND_KEY] as XMLHttpRequest['send'];
        }
        hookInstalled = true;
        this.emitHookDiag('xhr.send.wrap.disabled', {}, { force: true });
      } else if (sendNeedsRepair) {
        const emitHookDiag = this.emitHookDiag.bind(this);
        const enableSafeMode = this.enableSafeMode.bind(this);
        const sendWrapper = function (
          this: XMLHttpRequest,
          body?: Document | XMLHttpRequestBodyInit | null,
        ): void {
          let reqUrl = '';
          let reqMethod = 'GET';
          let requestId = '';
          try {
            const xhr = this as HookedXhr;
            const meta = loadXhrRequestMeta(xhr, hookDebug);
            reqMethod = String(meta.method || 'GET');
            requestId = meta.requestId || nextBookmarkRequestId();
            meta.requestId = requestId;
            meta.body = serializeRequestBodyText(body as unknown) ?? '';
            reqUrl = String(meta.url || '');
            if (reqUrl) {
              const requestMeta = {
                method: reqMethod,
                url: reqUrl,
                body: meta.body,
                requestId,
              };
              if (isBookmarksApiRequest(reqUrl)) {
                meta.bookmarkContext = resolveRequestBookmarkContext(
                  reqUrl,
                  meta.body,
                  requestMeta,
                );
                setBookmarkContext(meta.bookmarkContext);
              } else {
                meta.bookmarkContext = null;
              }
            }
            storeXhrRequestMeta(xhr, hookDebug, meta);
          } catch {
            // ignore
          }

          try {
            if (hookDebug.forceCallNotApply) {
              (sendBase as typeof sendWrapper).call(this, body as never);
            } else {
              (sendBase as typeof sendWrapper).apply(this, [body as never]);
            }
            emitHookDiag('xhr.send.basecall.ok', {
              method: reqMethod,
              url: reqUrl,
            });
          } catch {
            try {
              const recoveredResult = hookDebug.forceCallNotApply
                ? (sendBase as typeof sendWrapper).apply(this, [body as never])
                : (sendBase as typeof sendWrapper).call(this, body as never);
              emitHookDiag(
                'xhr.send.basecall.recovered',
                {
                  method: reqMethod,
                  url: reqUrl,
                },
                { force: true },
              );
              return recoveredResult;
            } catch (fallbackErr) {
              emitHookDiag(
                'xhr.send.basecall.error',
                {
                  method: reqMethod,
                  url: reqUrl,
                  requestId,
                  errName: fallbackErr instanceof Error ? fallbackErr.name : typeof fallbackErr,
                  errMsg: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
                },
                { force: true },
              );
              logger.error('XHR send hook base invocation failed; enabling safe mode', {
                method: reqMethod,
                url: reqUrl,
                err: fallbackErr,
              });
              try {
                enableSafeMode('xhr-send-basecall-failed', fallbackErr);
              } catch {
                // ignore
              }
              throw fallbackErr;
            }
          }
        };
        markHookFunction(sendWrapper, '__twe_is_hook_send_v1');
        const sendInstalled = defineOn(proto, 'send', sendWrapper);
        if (!sendInstalled) {
          throw new Error('Failed to define XMLHttpRequest.send hook safely');
        }
        markHookFunction((proto as { send?: unknown }).send, '__twe_is_hook_send_v1');
        hookInstalled = true;
      } else {
        hookInstalled = true;
      }

      if (
        !force &&
        !hookDebug.disableXhrOpenWrap &&
        hasHookVersion(currentOpen, '__twe_is_hook_open_v1') &&
        (hookDebug.disableXhrSendWrap || hasHookVersion(currentSend, '__twe_is_hook_send_v1'))
      ) {
        hookInstalled = true;
      } else {
        const wrappedOpenFromState = getFunctionFromHookState(
          currentOpen,
          '__twe_is_hook_open_v1',
          ORIG_XHR_OPEN_KEY,
        );
        const openBase =
          typeof wrappedOpenFromState === 'function'
            ? (wrappedOpenFromState as XMLHttpRequest['open'])
            : typeof proto[ORIG_XHR_OPEN_KEY] === 'function'
              ? (proto[ORIG_XHR_OPEN_KEY] as XMLHttpRequest['open'])
              : (currentOpen as XMLHttpRequest['open']);

        if (typeof openBase !== 'function') {
          throw new Error('XMLHttpRequest.prototype.open base function unavailable');
        }

        if (hookDebug.disableXhrOpenWrap) {
          proto.open = openBase;
          this.emitHookDiag('xhr.open.wrap.disabled', {}, { force: true });
          hookInstalled = true;
        } else {
          const emitHookDiag = this.emitHookDiag.bind(this);
          const enableSafeMode = this.enableSafeMode.bind(this);
          const openWrapper = function (this: XMLHttpRequest, ...args: unknown[]): unknown {
            let reqMethod = '';
            let reqUrl = '';
            let requestId = '';
            try {
              reqMethod = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
              const rawUrl = args[1];
              reqUrl = typeof rawUrl === 'string' ? rawUrl : String(rawUrl ?? '');

              if (isCaptureCandidateApiUrl(reqUrl)) {
                const self = this as HookedXhr;
                const meta = loadXhrRequestMeta(self, hookDebug);
                requestId = meta.requestId || nextBookmarkRequestId();
                meta.requestId = requestId;
                meta.method = reqMethod;
                meta.url = reqUrl;
                meta.body = '';
                if (isBookmarksApiRequest(reqUrl)) {
                  meta.bookmarkContext = resolveRequestBookmarkContext(reqUrl, undefined, {
                    method: reqMethod,
                    url: reqUrl,
                    requestId: meta.requestId,
                  });
                  setBookmarkContext(meta.bookmarkContext);
                } else {
                  meta.bookmarkContext = null;
                }
                if (!hookDebug.disableXhrLoadListener && !meta.hooked) {
                  meta.hooked = true;
                  this.addEventListener('load', function (this: XMLHttpRequest) {
                    try {
                      const xhr = this as HookedXhr;
                      const reqMeta = loadXhrRequestMeta(xhr, hookDebug);
                      const methodFallback = reqMethod || 'GET';
                      const urlFallback = reqUrl;
                      const loadMethod = reqMeta.method || methodFallback;
                      const loadUrl = reqMeta.url || urlFallback;
                      if (!isCaptureCandidateApiUrl(loadUrl)) return;
                      const responseText = String((this as XMLHttpRequest).responseText ?? '');
                      const loadBody = reqMeta.body;
                      const loadRequestId = reqMeta.requestId || nextBookmarkRequestId();
                      reqMeta.requestId = loadRequestId;
                      const bookmarkRequest = isBookmarksApiRequest(loadUrl);
                      const requestContext =
                        reqMeta.bookmarkContext ||
                        (bookmarkRequest
                          ? resolveRequestBookmarkContext(loadUrl, loadBody, {
                              method: loadMethod,
                              url: loadUrl,
                              body: loadBody,
                              requestId: loadRequestId,
                            })
                          : null);
                      if (!reqMeta.bookmarkContext) {
                        reqMeta.bookmarkContext = requestContext;
                      }
                      storeXhrRequestMeta(xhr, hookDebug, reqMeta);
                      if (bookmarkRequest && requestContext) {
                        setBookmarkContext(requestContext);
                      }
                      const normalizedReq = buildNormalizedHookMessageRequest({
                        method: loadMethod,
                        url: loadUrl,
                        body: loadBody || '',
                        bookmarkContext: requestContext ?? null,
                        requestId: loadRequestId,
                      });
                      postHookMessage({
                        __twe_mcp_hook_v1: true,
                        req: normalizedReq,
                        res: { status: (this as XMLHttpRequest).status ?? 0, responseText },
                      });
                    } catch {
                      // Never throw from XHR hooks; it can break the feed.
                    }
                  });
                }
                storeXhrRequestMeta(self, hookDebug, meta);
              }
            } catch {
              // Never throw from XHR hooks; it can break the feed.
            }

            try {
              const result = hookDebug.forceCallNotApply
                ? callFunctionWithArgs(openBase as HookCallable, this, args)
                : (openBase as typeof openWrapper).apply(this, args as never);
              emitHookDiag('xhr.open.basecall.ok', {
                method: reqMethod,
                url: reqUrl,
              });
              return result;
            } catch {
              try {
                const recoveredResult = hookDebug.forceCallNotApply
                  ? (openBase as typeof openWrapper).apply(this, args as never)
                  : callFunctionWithArgs(openBase as HookCallable, this, args);
                emitHookDiag(
                  'xhr.open.basecall.recovered',
                  {
                    method: reqMethod,
                    url: reqUrl,
                  },
                  { force: true },
                );
                return recoveredResult;
              } catch (fallbackErr) {
                emitHookDiag(
                  'xhr.open.basecall.error',
                  {
                    method: reqMethod,
                    url: reqUrl,
                    requestId,
                    errName: fallbackErr instanceof Error ? fallbackErr.name : typeof fallbackErr,
                    errMsg:
                      fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
                  },
                  { force: true },
                );
                logger.error('XHR open hook base invocation failed; enabling safe mode', {
                  method: reqMethod,
                  url: reqUrl,
                  err: fallbackErr,
                });
                try {
                  enableSafeMode('xhr-open-basecall-failed', fallbackErr);
                } catch {
                  // ignore
                }
                throw fallbackErr;
              }
            }
          };
          markHookFunction(openWrapper, '__twe_is_hook_open_v1');
          const openInstalled = defineOn(proto, 'open', openWrapper);
          if (!openInstalled) {
            throw new Error('Failed to define XMLHttpRequest.open hook safely');
          }
          hookInstalled = true;
          markHookFunction((proto as { open?: unknown }).open, '__twe_is_hook_open_v1');
          markHookFunction((proto as { send?: unknown }).send, '__twe_is_hook_send_v1');
        }

        proto[ORIG_XHR_OPEN_KEY] = openBase;
        proto[ORIG_XHR_SEND_KEY] = sendBase;
      }
    } catch (err) {
      logger.error('Failed to hook into XMLHttpRequest', err);
      this.enableSafeMode('xhr-hook-install-failed', err);
    }

    if (this.debugEnabled) {
      logger.info(`Hooked into XMLHttpRequest (installed=${hookInstalled})`);
    }

    // Diagnostics: with @inject-into content, hooks must be installed into the page realm.
    // We log capabilities rather than insisting on page-context injection, since X.com CSP
    // can block some managers' page injection modes.
    setTimeout(() => {
      try {
        const capabilities = getRuntimeCapabilities();
        const openIsPatched =
          hookGlobalObject.XMLHttpRequest?.prototype?.open !==
          (typeof originalOpen === 'function' ? originalOpen : undefined);
        if (!openIsPatched) {
          logger.error(
            `XHR hook not active (unsafeWindow=${capabilities.hasUnsafeWindow}, wrappedJSObject=${capabilities.hasWrappedJSObject}, exportFunction=${capabilities.hasExportFunction}). ` +
              `Bookmark capture will not work.`,
          );
        } else if (this.debugEnabled) {
          logger.debug('XHR hook active', {
            unsafeWindow: capabilities.hasUnsafeWindow,
            wrappedJSObject: capabilities.hasWrappedJSObject,
            exportFunction: capabilities.hasExportFunction,
          });
        }
      } catch (err) {
        logger.debug('XHR hook diagnostics failed', err);
      }
    }, 1000);
  }

  private installFetchHooks(force = false) {
    if (!this.isHookModeEnabled('fetch')) {
      return;
    }

    this.refreshHookDebugConfig();
    const hookDebug = this.hookDebugConfig;
    this.emitHookDiag('fetch.install.begin', { force, ...hookDebug });
    const hookTarget = getHookGlobalObject() as unknown as Record<string, unknown>;
    const fetchNative = hookTarget.fetch;
    if (typeof fetchNative !== 'function') {
      logger.warn('Fetch API not found, skipping fetch hooks');
      return;
    }

    const pageAny = hookTarget;
    const existingFetch = hookTarget.fetch;
    if (!force && hasHookVersion(existingFetch, '__twe_is_hook_fetch_v1')) {
      logger.debug('Fetch hook already installed');
      return;
    }

    const existingStoredBase = pageAny[ORIG_FETCH_KEY];
    const fetchBaseFromState = getFunctionFromHookState(
      existingFetch,
      '__twe_is_hook_fetch_v1',
      ORIG_FETCH_KEY,
    );
    const fetchBaseCandidate =
      [existingStoredBase, fetchBaseFromState, fetchNative].find(isUsableFetchBaseCandidate) ??
      null;
    if (!fetchBaseCandidate) {
      logger.error('Fetch API base function unavailable or unsafe; enabling safe mode');
      this.enableSafeMode('fetch-hook-base-unavailable');
      return;
    }
    const fetchBase = fetchBaseCandidate as typeof fetch;

    if (hookDebug.disableFetchWrap) {
      hookTarget.fetch = fetchBase;
      this.emitHookDiag('fetch.wrap.disabled', {}, { force: true });
      return;
    }

    pageAny[ORIG_FETCH_KEY] = fetchBase;
    const emitHookDiag = this.emitHookDiag.bind(this);
    const enableSafeMode = this.enableSafeMode.bind(this);
    let fetchHookFatal = false;
    let preferredFetchContext: unknown = hookTarget;
    const callNativeFetchFallback = (
      input: RequestInfo | URL,
      init?: RequestInit,
      argCount = 2,
    ): Promise<Response> => {
      try {
        if (argCount <= 1) {
          return fetchBase(input) as Promise<Response>;
        }
        return fetchBase(input, init) as Promise<Response>;
      } catch (fallbackErr) {
        return Promise.reject(fallbackErr);
      }
    };

    const invokeFetchWithContexts = (
      fn: typeof fetch,
      contexts: unknown[],
      input: RequestInfo | URL,
      init?: RequestInit,
      argCount = 2,
    ): Promise<Response> => {
      const args: unknown[] = argCount <= 1 ? [input] : [input, init];
      let lastError: unknown = null;
      for (const ctx of contexts) {
        if (!ctx) continue;
        try {
          const response = callFunctionWithArgs(
            fn as unknown as (...args: unknown[]) => unknown,
            ctx,
            args,
          ) as Promise<Response>;
          preferredFetchContext = ctx;
          return response;
        } catch (err) {
          lastError = err;
        }

        if (!hookDebug.forceCallNotApply) {
          try {
            const response = Reflect.apply(
              fn as unknown as (...args: unknown[]) => Promise<Response>,
              ctx,
              args,
            ) as Promise<Response>;
            preferredFetchContext = ctx;
            return response;
          } catch (err) {
            lastError = err;
          }
        }
      }

      // Direct invocation is last resort because it can create cross-realm
      // Promise objects that page code cannot safely consume in Firefox.
      try {
        if (argCount <= 1) {
          return fn(input) as Promise<Response>;
        }
        return fn(input, init) as Promise<Response>;
      } catch (err) {
        lastError = err;
      }

      if (lastError instanceof Error) {
        throw lastError;
      }
      throw new Error(`fetch invocation failed (${getSafeErrorInfo(lastError).summary})`);
    };

    const fetchWrapper = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const fetchArgCount = arguments.length <= 1 ? 1 : 2;
      let method = 'GET';
      let url = '';
      let serializedBody: string | undefined;
      let requestId = '';
      let requestContext: BookmarkContextPayload | undefined;

      try {
        method = extractFetchLikeMethod(input, init);
      } catch {
        method = init?.method ?? 'GET';
      }

      try {
        url = extractFetchLikeUrl(input);
      } catch {
        url = '';
      }

      try {
        serializedBody = serializeRequestBodyText(init?.body);
      } catch {
        serializedBody = undefined;
      }

      try {
        requestId = nextBookmarkRequestId();
      } catch {
        requestId = '';
      }
      emitHookDiag('fetch.wrapper.enter', { method, url, requestId });

      try {
        if (isBookmarksApiRequest(url)) {
          requestContext = resolveRequestBookmarkContext(url, serializedBody, {
            method,
            url,
            body: serializedBody,
            requestId,
          });
          setBookmarkContext(requestContext);
        } else {
          requestContext = undefined;
        }
      } catch (err) {
        // Never let hook pre-processing break app fetches.
        logger.debug('fetch request context capture failed', { method, url, err });
      }

      const shouldObserveResponse = isCaptureCandidateApiUrl(url);
      if (!shouldObserveResponse) {
        return callNativeFetchFallback(input, init, fetchArgCount);
      }

      let responsePromise: Promise<Response>;
      try {
        const origFetch = pageAny[ORIG_FETCH_KEY] ?? fetchBase;
        if (typeof origFetch !== 'function' || hasHookShape(origFetch, '__twe_is_hook_fetch_v1')) {
          throw new Error('fetch base function unavailable');
        }
        const callContextsRaw: unknown[] = [this, preferredFetchContext, hookTarget];
        if (typeof window !== 'undefined') {
          callContextsRaw.push(window);
        }
        callContextsRaw.push(globalThis);
        const callContexts: unknown[] = [];
        const seenContexts = new Set<unknown>();
        for (const ctx of callContextsRaw) {
          if (!ctx || seenContexts.has(ctx)) continue;
          seenContexts.add(ctx);
          callContexts.push(ctx);
        }

        responsePromise = invokeFetchWithContexts(
          origFetch as typeof fetch,
          callContexts,
          input,
          init,
          fetchArgCount,
        );
      } catch (err) {
        const errInfo = getSafeErrorInfo(err);
        // If hook invocation is unhealthy, fail closed quickly and switch to safe mode.
        emitHookDiag('fetch.basecall.error', {
          method,
          url,
          requestId,
          errName: errInfo.name,
          errMsg: errInfo.message,
        });
        if (!fetchHookFatal) {
          fetchHookFatal = true;
          logger.error('Fetch hook base invocation failed; enabling safe mode', {
            method,
            url,
            err: errInfo.summary,
          });
          try {
            enableSafeMode('fetch-hook-invocation-failed', errInfo.summary);
          } catch {
            // ignore
          }
        }
        return callNativeFetchFallback(input, init, fetchArgCount).catch((fallbackErr) => {
          const fallbackInfo = getSafeErrorInfo(fallbackErr);
          emitHookDiag(
            'fetch.fallback.error',
            {
              method,
              url,
              requestId,
              errName: fallbackInfo.name,
              errMsg: fallbackInfo.message,
            },
            { force: true },
          );
          throw fallbackErr ?? errInfo.summary;
        });
      }

      try {
        void responsePromise
          .then(
            (response) => {
              try {
                emitHookDiag('fetch.basecall.ok', { method, url });

                const contentType = response.headers.get('content-type') ?? '';
                const isTextualResponse =
                  !contentType || contentType.includes('json') || contentType.startsWith('text/');

                if (!isTextualResponse) {
                  return;
                }

                // Read response body from a clone to avoid consuming the original stream.
                void response
                  .clone()
                  .text()
                  .then((responseText: string) => {
                    if (!responseText) return;
                    try {
                      const normalizedReq = buildNormalizedHookMessageRequest({
                        method,
                        url,
                        body: serializedBody || '',
                        bookmarkContext: requestContext ?? null,
                        requestId,
                      });

                      postHookMessage({
                        __twe_mcp_hook_v1: true,
                        req: normalizedReq,
                        res: { status: response.status, responseText },
                      });
                    } catch {
                      // ignore
                    }
                  })
                  .catch((err: unknown) => {
                    const errInfo = getSafeErrorInfo(err);
                    logger.debug('fetch clone.text() failed', {
                      method,
                      url,
                      err: errInfo.summary,
                    });
                  });
              } catch (err) {
                const errInfo = getSafeErrorInfo(err);
                logger.debug('fetch response hook observer callback failed', {
                  method,
                  url,
                  err: errInfo.summary,
                });
              }
            },
            (err) => {
              const errInfo = getSafeErrorInfo(err);
              emitHookDiag('fetch.basecall.error', {
                method,
                url,
                requestId,
                errName: errInfo.name,
                errMsg: errInfo.message,
              });
              if (!fetchHookFatal) {
                fetchHookFatal = true;
                logger.error('Fetch hook base invocation failed; enabling safe mode', {
                  method,
                  url,
                  err: errInfo.summary,
                });
                try {
                  enableSafeMode('fetch-hook-invocation-failed', errInfo.summary);
                } catch {
                  // ignore
                }
              }
            },
          )
          .catch((err: unknown) => {
            const errInfo = getSafeErrorInfo(err);
            logger.debug('fetch response hook observer promise failed', {
              method,
              url,
              err: errInfo.summary,
            });
          });
      } catch (err) {
        const errInfo = getSafeErrorInfo(err);
        // Never throw after native fetch succeeds.
        logger.debug('fetch response hook observer setup failed', {
          method,
          url,
          err: errInfo.summary,
        });
      }

      return responsePromise;
    };
    markHookFunction(fetchWrapper, '__twe_is_hook_fetch_v1');

    const ok = defineOn(pageAny as object, 'fetch', fetchWrapper);
    if (!ok) {
      this.enableSafeMode('fetch-hook-define-failed');
      return;
    }
    markHookFunction((pageAny as { fetch?: unknown }).fetch, '__twe_is_hook_fetch_v1');
    this.emitHookDiag(
      'fetch.install.ok',
      {
        hasHookMarker: hasHookVersion(
          (pageAny as { fetch?: unknown }).fetch,
          '__twe_is_hook_fetch_v1',
        ),
      },
      { force: true },
    );
    if (ok && this.debugEnabled) {
      logger.info('Hooked into fetch');
    }
    if (ok) {
      this.startFetchHookBootProbe(1200);
    }
  }

  private runFetchHookBootProbePass() {
    if (this.runtimeModes.safeMode || !this.isHookModeEnabled('fetch')) {
      return;
    }

    const hookTarget = getHookGlobalObject() as unknown as Record<string, unknown>;
    const fetchCandidate = hookTarget.fetch;
    if (typeof fetchCandidate !== 'function') {
      this.enableSafeMode('fetch-hook-probe-missing-fetch');
      return;
    }
    this.emitHookDiag(
      'fetch.bootprobe.begin',
      {
        hasHookMarker: hasHookVersion(fetchCandidate, '__twe_is_hook_fetch_v1'),
      },
      { force: true },
    );

    const probe = async () => {
      const contexts: unknown[] = [hookTarget];
      if (typeof window !== 'undefined') {
        contexts.push(window);
      }
      contexts.push(globalThis);
      const probeUrl = (
        typeof location !== 'undefined' && location.origin
          ? `${location.origin}/favicon.ico?__twe_fetch_probe=1`
          : 'https://x.com/favicon.ico?__twe_fetch_probe=1'
      ) as RequestInfo | URL;

      let lastError: unknown = null;
      try {
        const response = (await (fetchCandidate as typeof fetch)(probeUrl)) as Response;
        await response.text().catch(() => '');
        if (this.debugEnabled) {
          logger.debug('Fetch hook boot probe passed');
        }
        this.emitHookDiag('fetch.bootprobe.ok', {});
        return;
      } catch (err) {
        lastError = err;
      }

      for (const ctx of contexts) {
        try {
          const response = this.hookDebugConfig.forceCallNotApply
            ? ((await (fetchCandidate as typeof fetch).call(ctx as unknown, probeUrl)) as Response)
            : ((await Reflect.apply(
                fetchCandidate as unknown as (...args: unknown[]) => Promise<Response>,
                ctx,
                [probeUrl],
              )) as Response);
          await response.text().catch(() => '');
          if (this.debugEnabled) {
            logger.debug('Fetch hook boot probe passed');
          }
          this.emitHookDiag('fetch.bootprobe.ok', {});
          return;
        } catch (err) {
          lastError = err;
        }
      }

      const lastErrorInfo = getSafeErrorInfo(lastError);
      this.emitHookDiag(
        'fetch.bootprobe.error',
        {
          errName: lastErrorInfo.name,
          errMsg: lastErrorInfo.message,
        },
        { force: true },
      );
      if (isLikelyCrossRealmPermissionError(lastError)) {
        logger.warn(
          'Fetch boot probe hit cross-realm permission error; keeping fetch hook active',
          lastErrorInfo.summary,
        );
        return;
      }
      this.enableSafeMode('fetch-hook-probe-failed', lastError);
    };

    void probe();
  }

  private startFetchHookBootProbe(delayMs = 1200) {
    this.runtimeControlPlane.startFetchHookBootProbe(delayMs);
  }

  private runHookRepairPass(): { ok: boolean; error?: string } {
    if (this.hookStats) {
      this.hookStats.repairCount += 1;
      this.syncRuntimeStats();
    }

    if (this.isHookModeEnabled('xhr')) {
      this.installHttpHooks(true);
    }
    if (this.isHookModeEnabled('fetch')) {
      this.installFetchHooks(true);
    }

    return this.runHookSelfTest();
  }

  private runInterceptors(req: InterceptedRequest, res: XMLHttpRequest) {
    this.interceptorDispatcher.dispatch(this.getExtensions(), req, res);
  }
}
