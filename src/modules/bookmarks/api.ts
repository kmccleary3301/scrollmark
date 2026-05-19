import { Interceptor } from '@/core/extensions';
import { db } from '@/core/database';
import {
  logModuleItemsReceived,
  logModuleParseFailure,
  projectTweets,
} from '@/core/extensions/module-platform';
import { TimelineInstructions, Tweet } from '@/types';
import { extractDataFromResponse, extractTimelineTweet } from '@/utils/api';
import logger from '@/utils/logger';

const BOOKMARK_FOLDER_CACHE_STORAGE_KEY = 'twe_bookmark_folder_name_cache_v1';
const BOOKMARK_FOLDER_BACKFILL_CANDIDATE_LIMIT = 260;
const BOOKMARK_FOLDER_BACKFILL_SCAN_LIMIT = 1800;
const pendingBookmarkFolderNameBackfills = new Set<string>();
const inFlightBookmarkFolderNameBackfills = new Set<string>();

function loadBookmarkFolderNameCache(): Map<string, string> {
  try {
    if (typeof localStorage === 'undefined') return new Map<string, string>();
    const raw = localStorage.getItem(BOOKMARK_FOLDER_CACHE_STORAGE_KEY);
    if (!raw) return new Map<string, string>();
    const data = JSON.parse(raw) as Array<[unknown, unknown]>;
    if (!Array.isArray(data)) return new Map<string, string>();

    const entries: Array<[string, string]> = [];
    for (const entry of data) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string'
      ) {
        entries.push([entry[0], entry[1]]);
      }
    }
    return new Map(entries);
  } catch {
    return new Map<string, string>();
  }
}

function persistBookmarkFolderNameCache(cache: Map<string, string>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(BOOKMARK_FOLDER_CACHE_STORAGE_KEY, JSON.stringify([...cache.entries()]));
  } catch {
    /* ignore */
  }
}

function extractTweetIdsForBackfill(tweets: Tweet[]): string[] {
  const ids: string[] = [];
  for (const tweet of tweets) {
    if (!tweet || typeof tweet !== 'object') continue;
    const restId = String((tweet as Tweet).rest_id || '').trim();
    if (!restId) continue;
    ids.push(restId);
    if (ids.length >= BOOKMARK_FOLDER_BACKFILL_CANDIDATE_LIMIT) {
      break;
    }
  }
  return ids;
}

function queueFolderNameBackfill(folderIds: Iterable<string>): void {
  for (const folderId of folderIds) {
    const normalized = String(folderId || '').trim();
    if (!normalized) continue;
    pendingBookmarkFolderNameBackfills.add(normalized);
  }
}

function triggerFolderNameBackfillIfNeeded(
  extName: string,
  folderId: string | null,
  tweets: Tweet[],
): void {
  if (!folderId) return;
  if (!pendingBookmarkFolderNameBackfills.has(folderId)) return;
  if (inFlightBookmarkFolderNameBackfills.has(folderId)) return;

  const folderName = bookmarkFolderNameCache.get(folderId);
  if (!folderName) return;

  const candidateTweetIds = extractTweetIdsForBackfill(tweets);
  inFlightBookmarkFolderNameBackfills.add(folderId);
  void db
    .extBackfillRecentBookmarkFolderName(extName, folderId, folderName, {
      candidateTweetIds,
      candidateLimit: BOOKMARK_FOLDER_BACKFILL_CANDIDATE_LIMIT,
      recentCaptureScanLimit: BOOKMARK_FOLDER_BACKFILL_SCAN_LIMIT,
    })
    .then((summary) => {
      if ((summary?.inspected || 0) > 0) {
        pendingBookmarkFolderNameBackfills.delete(folderId);
      }
      if ((summary?.updated || 0) > 0) {
        logger.info(
          `Bookmarks: folder-name backfill updated ${summary.updated} rows for folder ${folderId}`,
        );
      }
    })
    .catch(() => {
      // keep pending state for retry on later requests
    })
    .finally(() => {
      inFlightBookmarkFolderNameBackfills.delete(folderId);
    });
}

/**
 * Cache of folder_id -> folder_name from BookmarkFoldersSlice GraphQL responses.
 * This is the only provable source of folder names (API response). Persisted to
 * localStorage so direct folder opens can still resolve names after one API-backed
 * folder-list load in the same browser profile.
 */
const bookmarkFolderNameCache = loadBookmarkFolderNameCache();

interface BookmarksResponse {
  data: {
    bookmark_timeline_v2?: {
      timeline: {
        instructions?: TimelineInstructions;
        responseObjects?: unknown;
      };
    };
    bookmark_timeline?: {
      timeline: {
        instructions?: TimelineInstructions;
        responseObjects?: unknown;
      };
    };
    bookmark_collection_timeline?: {
      timeline: {
        instructions?: TimelineInstructions;
        responseObjects?: unknown;
      };
    };
  };
}

type TimelineContainer = {
  timeline?: {
    instructions?: TimelineInstructions;
    responseObjects?: unknown;
  };
};

function isTimelineContainer(value: unknown): value is TimelineContainer {
  if (!value || typeof value !== 'object') return false;
  const timeline = (value as { timeline?: unknown }).timeline;
  if (!timeline || typeof timeline !== 'object') return false;
  const inst = (timeline as { instructions?: unknown }).instructions;
  return Array.isArray(inst);
}

function findTimelineInstructionsFromObject(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): TimelineInstructions | null {
  if (!value || typeof value !== 'object') return null;
  if (depth > 5) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTimelineInstructionsFromObject(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  if (isTimelineContainer(value)) {
    return value.timeline?.instructions || null;
  }

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return null;
  seen.add(obj);

  for (const key of Object.keys(obj)) {
    const nested = findTimelineInstructionsFromObject(obj[key], depth + 1, seen);
    if (nested) return nested;
  }

  return null;
}

function coerceFolderId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = String(Math.trunc(value));
    return /^\d+$/.test(normalized) ? normalized : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function isFolderOrCollectionKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^(bookmarkcollectionid|bookmarkfolderid|bookmarkcollection|folderid|collectionid|folder)$/.test(
    normalized,
  );
}

function findFolderId(value: unknown): string | null {
  const seen = new Set<object>();

  function walk(node: unknown, currentKey?: string): string | null {
    const byKey = currentKey && isFolderOrCollectionKey(currentKey) ? coerceFolderId(node) : null;
    if (byKey) return byKey;

    if (!node || typeof node !== 'object') {
      return null;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const nested = walk(item);
        if (nested) return nested;
      }
      return null;
    }

    const obj = node as Record<string, unknown>;
    if (seen.has(obj)) return null;
    seen.add(obj);

    for (const [key, nested] of Object.entries(obj)) {
      const found = walk(nested, key);
      if (found) return found;
    }

    return null;
  }

  return walk(value);
}

function extractTimelineInstructions(json: BookmarksResponse): TimelineInstructions {
  const timeline =
    json.data?.bookmark_timeline_v2?.timeline ||
    json.data?.bookmark_timeline?.timeline ||
    json.data?.bookmark_collection_timeline?.timeline ||
    (json as unknown as { timeline?: { instructions?: TimelineInstructions } }).timeline;

  if (
    timeline &&
    Array.isArray((timeline as { instructions?: TimelineInstructions }).instructions)
  ) {
    return (timeline as { instructions: TimelineInstructions }).instructions;
  }

  const found = findTimelineInstructionsFromObject(json.data, 0, new Set<object>());
  if (found) {
    return found;
  }

  throw new Error('Bookmarks response missing timeline instructions');
}

interface BookmarkFolderContext {
  folder_id: string | null;
  folder_name: string | null;
  folder_url: string;
}

interface BookmarkRequest {
  url: string;
  body?: string;
  bookmarkContext?: unknown;
  responseText?: string;
}

const BOOKMARK_CONTEXT_GLOBAL_KEY = '__twe_bookmark_context_v1';
const BOOKMARK_STRICT_FOLDER_GLOBAL_KEY = '__twe_bookmark_strict_folder_id_v1';
const BOOKMARK_STRICT_FOLDER_STORAGE_KEY = 'twe_bookmark_strict_folder_id_v1';
const BOOKMARK_STRICT_MODE_GLOBAL_KEY = '__twe_bookmark_strict_mode_v1';
const BOOKMARK_STRICT_MODE_STORAGE_KEY = 'twe_bookmark_strict_mode_v1';
const HOOK_STATS_GLOBAL_KEY = '__twe_hook_stats_v1';
const HOOK_RUNTIME_GLOBAL_KEY = '__twe_runtime_v1';

type BookmarkDropCounterKey =
  | 'bookmarkDropsCrossFolder'
  | 'bookmarkDropsStrictNoExplicitFolder'
  | 'bookmarkDropsStrictFolderMismatch'
  | 'bookmarkContextUnresolved';

type RawBodyLike = string | XMLHttpRequestBodyInit | null | undefined;

function incrementBookmarkDropCounter(counterKey: BookmarkDropCounterKey): void {
  const incrementOn = (target: unknown): void => {
    if (!target || typeof target !== 'object') return;
    const map = target as Record<string, unknown>;
    const current = Number(map[counterKey]);
    map[counterKey] = Number.isFinite(current) ? current + 1 : 1;
  };

  try {
    const root = globalThis as Record<string, unknown>;
    incrementOn(root[HOOK_STATS_GLOBAL_KEY]);
    incrementOn(root[HOOK_RUNTIME_GLOBAL_KEY]);
  } catch {
    /* ignore */
  }
}

function parseJsonLike(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toFormDataBody(value: string): URLSearchParams | null {
  try {
    return new URLSearchParams(value);
  } catch {
    return null;
  }
}

function parseRequestBodyForVariables(rawBody: RawBodyLike): unknown | null {
  if (typeof rawBody === 'undefined' || rawBody === null) return null;

  if (typeof rawBody === 'string') {
    let parsed = parseJsonLike(rawBody);
    if (parsed !== null) return parsed;

    const form = toFormDataBody(rawBody);
    if (form) {
      const variables = form.get('variables');
      if (variables) {
        parsed = parseJsonLike(variables);
        if (parsed !== null) {
          return parsed;
        }
      }

      const fallbackCollection = form.get('bookmark_collection_id') ?? form.get('folder_id');
      if (fallbackCollection) {
        return { bookmark_collection_id: fallbackCollection, folder_id: fallbackCollection };
      }
    }
    return null;
  }

  if (typeof Blob !== 'undefined' && rawBody instanceof Blob) {
    return null;
  }

  if (typeof FormData !== 'undefined' && rawBody instanceof FormData) {
    try {
      const form = new URLSearchParams();
      for (const [name, value] of rawBody.entries()) {
        if (typeof value === 'string') {
          form.set(name, value);
        } else {
          form.set(name, String(value));
        }
      }
      return parseRequestBodyForVariables(form.toString());
    } catch {
      return null;
    }
  }

  return null;
}

function resolveFolderFromContext(rawContext: unknown): string | null {
  if (!rawContext) return null;

  if (typeof rawContext === 'string') {
    const trimmed = rawContext.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return trimmed;
    const byUrl = extractFolderIdFromUrl(trimmed);
    if (byUrl) return byUrl;
    const parsed = parseJsonLike(trimmed);
    if (parsed) {
      return findFolderId(parsed);
    }
    return null;
  }

  // Handle BookmarkContextPayload structure directly
  if (typeof rawContext === 'object' && rawContext !== null) {
    const obj = rawContext as Record<string, unknown>;

    // Direct folderId property (from BookmarkContextPayload)
    if (typeof obj.folderId === 'string' && /^\d+$/.test(obj.folderId)) {
      return obj.folderId;
    }
    if (typeof obj.folderId === 'number' && Number.isFinite(obj.folderId)) {
      return String(Math.trunc(obj.folderId));
    }

    // Direct folder_id property
    if (typeof obj.folder_id === 'string' && /^\d+$/.test(obj.folder_id)) {
      return obj.folder_id;
    }
    if (typeof obj.folder_id === 'number' && Number.isFinite(obj.folder_id)) {
      return String(Math.trunc(obj.folder_id));
    }

    // Try to find folderId using recursive search
    const found = findFolderId(rawContext);
    if (found) return found;

    // Extract from URL properties
    const pageUrl = [obj.pageUrl, obj.url, obj.location, obj.currentUrl, obj.folderUrl].find(
      (value): value is string => typeof value === 'string',
    );

    if (typeof pageUrl === 'string') {
      const byUrl = extractFolderIdFromUrl(pageUrl);
      if (byUrl) return byUrl;
    }
  }

  return null;
}

function resolveBookmarkContextFromGlobal(): unknown | null {
  try {
    return (globalThis as Record<string, unknown>)[BOOKMARK_CONTEXT_GLOBAL_KEY] ?? null;
  } catch {
    return null;
  }
}

function resolveStrictBookmarkFolderId(): string | null {
  try {
    const g = globalThis as Record<string, unknown>;
    if (g[BOOKMARK_STRICT_MODE_GLOBAL_KEY] === false) {
      return null;
    }
    const fromGlobal = coerceFolderId(g[BOOKMARK_STRICT_FOLDER_GLOBAL_KEY]);
    if (fromGlobal) return fromGlobal;
  } catch {
    /* ignore */
  }

  try {
    if (typeof localStorage === 'undefined') return null;
    const modeRaw = localStorage.getItem(BOOKMARK_STRICT_MODE_STORAGE_KEY);
    if (modeRaw && /^(0|false|off|no)$/i.test(modeRaw.trim())) {
      return null;
    }
    const fromStorage = coerceFolderId(localStorage.getItem(BOOKMARK_STRICT_FOLDER_STORAGE_KEY));
    if (fromStorage) return fromStorage;
  } catch {
    /* ignore */
  }

  return null;
}

function resolveExplicitRequestFolderId(req: BookmarkRequest): string | null {
  const fromRequestUrl = resolveFolderFromRequestVariables(req.url);
  if (fromRequestUrl) return fromRequestUrl;

  if (req.body) {
    const parsed = parseRequestBodyForVariables(req.body);
    if (parsed) {
      const fromBody = findFolderId(parsed);
      if (fromBody) return fromBody;
    }
  }

  return null;
}

function resolveFolderFromResponseText(responseText?: string): string | null {
  if (!responseText) return null;
  const parsed = parseJsonLike(responseText);
  if (!parsed) return null;
  return findFolderId(parsed);
}

function extractFolderIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url, 'https://x.com');
    const directKeys = [
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
    // Match patterns like /i/bookmarks/123456 or /bookmarks/123456
    const m =
      u.pathname.match(/\/bookmarks\/(\d+)/) ||
      u.pathname.match(/\/bookmarks\/folders\/(\d+)/) ||
      u.pathname.match(/\/bookmarks\/folder\/(\d+)/) ||
      u.pathname.match(/\/bookmark_folders\/(\d+)/);
    if (m && m[1]) return m[1];
    for (const key of directKeys) {
      const direct = u.searchParams.get(key);
      if (direct && /^\d+$/.test(direct)) {
        return direct;
      }
    }
    for (const [k, v] of u.searchParams.entries()) {
      if (/folder/i.test(k) && /^\d+$/.test(v)) {
        return v;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function resolveFolderFromRequestVariables(url: string): string | null {
  try {
    const u = new URL(url, 'https://x.com');
    const raw = u.searchParams.get('variables');
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

    const directFolderId = findFolderId(parsed);
    if (directFolderId) return directFolderId;

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of [
        'bookmark_collection_id',
        'bookmarkcollectionid',
        'bookmarkCollectionId',
        'folder_id',
        'folderid',
        'folderId',
        'collection_id',
        'collectionid',
        'collectionId',
      ]) {
        const value = obj[key];
        const folderId = coerceFolderId(value);
        if (folderId) return folderId;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Extract bookmark folder context from the current page URL and request.
 * Used to stamp folder metadata onto each captured tweet for folder-aware exports.
 * Resolution order is intentionally deterministic:
 * 1) Request URL variables / explicit request URL folder hints.
 * 2) Request body variables.
 * 3) Request bookmarkContext payload.
 * 4) Global bookmark context lock/state.
 * 5) Current page URL.
 * 6) Response payload fallback.
 * 7) Document URL/canonical/og fallbacks.
 */
function getBookmarkFolderContext(req: BookmarkRequest): BookmarkFolderContext {
  const ctx: BookmarkFolderContext = {
    folder_id: null,
    folder_name: null,
    folder_url: typeof location !== 'undefined' ? location.href : '',
  };

  // 0) Try request URL variables: /graphql/.../Bookmarks?variables=...
  if (!ctx.folder_id) {
    try {
      const u = new URL(req.url, 'https://x.com');
      const fromRequestVariables = resolveFolderFromRequestVariables(req.url);
      if (fromRequestVariables) {
        ctx.folder_id = fromRequestVariables;
      } else {
        const directFromUrl = extractFolderIdFromUrl(u.href);
        if (directFromUrl) {
          ctx.folder_id = directFromUrl;
        } else {
          const raw = u.searchParams.get('variables');
          if (raw) {
            let vars: Record<string, unknown>;
            try {
              vars = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
            } catch {
              vars = JSON.parse(raw) as Record<string, unknown>;
            }
            const found = findFolderId(vars);
            if (found) {
              ctx.folder_id = found;
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 1) Try request body fields for collection/folder context.
  if (!ctx.folder_id && req.body) {
    const parsed = parseRequestBodyForVariables(req.body);
    if (parsed) {
      const found = findFolderId(parsed);
      if (found) {
        ctx.folder_id = found;
      }
    }
  }

  // 2) Fallback to context passed from request interceptor (SPA navigation).
  if (!ctx.folder_id) {
    const contextFolderId = resolveFolderFromContext(req.bookmarkContext);
    if (contextFolderId) {
      ctx.folder_id = contextFolderId;
    }
  }

  if (!ctx.folder_id) {
    const contextFromGlobal = resolveFolderFromContext(resolveBookmarkContextFromGlobal());
    if (contextFromGlobal) {
      ctx.folder_id = contextFromGlobal;
    }
  }

  if (!ctx.folder_id && req.bookmarkContext && typeof req.bookmarkContext === 'object') {
    const rawContext = req.bookmarkContext as Record<string, unknown>;
    const candidateFromContextUrl = [
      rawContext.folderUrl,
      rawContext.pageUrl,
      rawContext.url,
      rawContext.location,
      rawContext.currentUrl,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value) => extractFolderIdFromUrl(value))
      .find((candidate): candidate is string => !!candidate);
    if (candidateFromContextUrl) {
      ctx.folder_id = candidateFromContextUrl;
    }
  }

  if (req.bookmarkContext && typeof req.bookmarkContext === 'object') {
    const rawContext = req.bookmarkContext as Record<string, unknown>;
    if (typeof rawContext.folderUrl === 'string') {
      ctx.folder_url = rawContext.folderUrl;
    } else if (typeof rawContext.pageUrl === 'string') {
      ctx.folder_url = rawContext.pageUrl;
    } else if (typeof rawContext.url === 'string') {
      ctx.folder_url = rawContext.url;
    } else if (typeof rawContext.location === 'string') {
      ctx.folder_url = rawContext.location;
    } else if (typeof rawContext.currentUrl === 'string') {
      ctx.folder_url = rawContext.currentUrl;
    }
  } else {
    const globalContext = resolveBookmarkContextFromGlobal();
    if (globalContext && typeof globalContext === 'object') {
      const rawContext = globalContext as Record<string, unknown>;
      if (typeof rawContext.folderUrl === 'string') {
        ctx.folder_url = rawContext.folderUrl;
      } else if (typeof rawContext.pageUrl === 'string') {
        ctx.folder_url = rawContext.pageUrl;
      } else if (typeof rawContext.url === 'string') {
        ctx.folder_url = rawContext.url;
      } else if (typeof rawContext.location === 'string') {
        ctx.folder_url = rawContext.location;
      } else if (typeof rawContext.currentUrl === 'string') {
        ctx.folder_url = rawContext.currentUrl;
      }
    }
  }

  // 3) Try page URL when explicit request hints are absent.
  // This catches direct navigation to /i/bookmarks/{folder_id}.
  if (!ctx.folder_id) {
    const pageUrl = typeof location !== 'undefined' ? location.href : '';
    if (pageUrl) {
      const fromPageUrl = extractFolderIdFromUrl(pageUrl);
      if (fromPageUrl) {
        ctx.folder_id = fromPageUrl;
        ctx.folder_url = pageUrl;
      }
    }
  }

  // 4) Last resort: inspect response payload for inline folder context.
  if (!ctx.folder_id && req.responseText) {
    const found = resolveFolderFromResponseText(req.responseText);
    if (found) {
      ctx.folder_id = found;
    }
  }

  if (!ctx.folder_id) {
    const contextFromGlobal = resolveFolderFromContext(resolveBookmarkContextFromGlobal());
    if (contextFromGlobal) {
      ctx.folder_id = contextFromGlobal;
    }
  }

  // 2) Additional URL-based fallbacks for SPA routing edge cases.
  // Keep this URL-only (no heading/text scraping) to avoid incorrect names.
  if (!ctx.folder_id && typeof document !== 'undefined') {
    ctx.folder_id = extractFolderIdFromUrl(document.URL);
  }
  if (!ctx.folder_id && typeof document !== 'undefined') {
    const canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (canonical?.href) {
      ctx.folder_id = extractFolderIdFromUrl(canonical.href);
    }
  }
  if (!ctx.folder_id && typeof document !== 'undefined') {
    const ogUrl = document.querySelector('meta[property="og:url"]') as HTMLMetaElement | null;
    const content = ogUrl?.content ?? '';
    if (content) {
      ctx.folder_id = extractFolderIdFromUrl(content);
    }
  }

  // 3) Folder name: only from BookmarkFoldersSlice cache (provable). No DOM fallback.
  if (ctx.folder_id) {
    // If route normalization collapsed to /i/bookmarks, preserve a stable folder URL.
    try {
      const route = new URL(ctx.folder_url || '', 'https://x.com');
      if (/\/i\/bookmarks\/?$/.test(route.pathname)) {
        ctx.folder_url = `https://x.com/i/bookmarks/${ctx.folder_id}`;
      }
    } catch {
      if (!ctx.folder_url || /\/i\/bookmarks\/?$/.test(ctx.folder_url)) {
        ctx.folder_url = `https://x.com/i/bookmarks/${ctx.folder_id}`;
      }
    }

    const cached = bookmarkFolderNameCache.get(ctx.folder_id);
    if (cached) ctx.folder_name = cached;
  }

  return ctx;
}

interface BookmarkFoldersSliceResponse {
  data?: {
    viewer?: {
      user_results?: {
        result?: {
          bookmark_collections_slice?: {
            items?: Array<{ id?: string; name?: string }>;
          };
        };
      };
    };
  };
}

function parseBookmarkFoldersSlice(text: string): Set<string> {
  const changedFolderIds = new Set<string>();
  try {
    const json = JSON.parse(text) as BookmarkFoldersSliceResponse;
    const items = json.data?.viewer?.user_results?.result?.bookmark_collections_slice?.items ?? [];
    let changed = false;
    for (const item of items) {
      if (item.id && typeof item.name === 'string') {
        const old = bookmarkFolderNameCache.get(item.id);
        if (old !== item.name) {
          bookmarkFolderNameCache.set(item.id, item.name);
          changedFolderIds.add(item.id);
          changed = true;
        }
      }
    }
    if (changed) persistBookmarkFolderNameCache(bookmarkFolderNameCache);
  } catch {
    /* ignore */
  }
  return changedFolderIds;
}

function isBookmarksTimelineRequest(url: string): boolean {
  try {
    const path = new URL(url, 'https://x.com').pathname.toLowerCase();
    const graphqlMatch = path.match(/\/graphql\/[^/]+\/([^/?#]+)/);
    const endpoint = String(graphqlMatch?.[1] || '').toLowerCase();
    if (!endpoint) return false;
    return (
      endpoint === 'bookmarks' ||
      endpoint === 'bookmarktimeline' ||
      endpoint === 'bookmarkfoldertimeline' ||
      endpoint === 'bookmarkcollectiontimeline' ||
      endpoint === 'bookmarkcollectionstimeline' ||
      endpoint === 'bookmarkfoldersslice' ||
      endpoint === 'bookmarkfolderslice' ||
      endpoint === 'bookmarkcollectionslice' ||
      endpoint === 'bookmarkslice'
    );
  } catch {
    return false;
  }
}

// https://twitter.com/i/api/graphql/.../BookmarkFoldersSlice - populates folder id->name cache
// https://twitter.com/i/api/graphql/.../Bookmarks and /BookmarkFolderTimeline
// capture tweets and stamps folder metadata
export const BookmarksInterceptor: Interceptor = (req, res, ext) => {
  if (/\/graphql\/.+\/BookmarkFoldersSlice/.test(req.url)) {
    const text = typeof res.responseText === 'string' ? res.responseText : '';
    if (text) {
      const changedFolderIds = parseBookmarkFoldersSlice(text);
      if (changedFolderIds.size > 0) {
        queueFolderNameBackfill(changedFolderIds);
      }
    }
    return;
  }
  if (!isBookmarksTimelineRequest(req.url)) {
    return;
  }

  try {
    const explicitRequestFolderId = resolveExplicitRequestFolderId(req);
    const pageFolderId =
      typeof location !== 'undefined' ? extractFolderIdFromUrl(location.href) : null;
    if (pageFolderId && explicitRequestFolderId && explicitRequestFolderId !== pageFolderId) {
      incrementBookmarkDropCounter('bookmarkDropsCrossFolder');
      logger.debug(
        `Bookmarks: skip cross-folder request pageFolder=${pageFolderId}, requestFolder=${explicitRequestFolderId}`,
      );
      return;
    }

    const folderCtx = getBookmarkFolderContext({ ...req, responseText: res.responseText });
    const strictFolderId = resolveStrictBookmarkFolderId();
    if (strictFolderId) {
      const strictMatchCandidate =
        explicitRequestFolderId || pageFolderId || folderCtx.folder_id || null;
      const strictMatchSource = explicitRequestFolderId
        ? 'request'
        : pageFolderId
          ? 'page'
          : folderCtx.folder_id
            ? 'context'
            : 'none';

      if (!strictMatchCandidate) {
        incrementBookmarkDropCounter('bookmarkDropsStrictNoExplicitFolder');
        logger.debug(`Bookmarks(strict): skip request without folder evidence: ${req.url}`);
        return;
      }
      if (strictMatchCandidate !== strictFolderId) {
        incrementBookmarkDropCounter('bookmarkDropsStrictFolderMismatch');
        logger.debug(
          `Bookmarks(strict): skip folder mismatch source=${strictMatchSource} candidateFolder=${strictMatchCandidate}, strictFolder=${strictFolderId}`,
        );
        return;
      }

      if (!explicitRequestFolderId && strictMatchSource !== 'none') {
        logger.debug(
          `Bookmarks(strict): allowing request without explicit folder id via ${strictMatchSource} context`,
        );
      }

      if (folderCtx.folder_id !== strictFolderId) {
        folderCtx.folder_id = strictFolderId;
        folderCtx.folder_url = `https://x.com/i/bookmarks/${strictFolderId}`;
      }
    }

    if (!folderCtx.folder_id) {
      incrementBookmarkDropCounter('bookmarkContextUnresolved');
    }

    const newData = extractDataFromResponse<BookmarksResponse, Tweet>(
      res,
      extractTimelineInstructions,
      (entry) => extractTimelineTweet(entry.content.itemContent),
    );

    // Stamp folder metadata onto each tweet for folder-aware indexing
    for (const t of newData) {
      if (t && typeof t === 'object') {
        const obj = t as unknown as Record<string, unknown>;
        if (folderCtx.folder_id) {
          obj.__bookmark_folder_id = folderCtx.folder_id;
        }
        if (folderCtx.folder_name) {
          obj.__bookmark_folder_name = folderCtx.folder_name;
        }
        if (folderCtx.folder_id) {
          obj.__bookmark_folder_name_source = folderCtx.folder_name ? 'api' : 'id-only';
        }
        if (folderCtx.folder_url) {
          obj.__bookmark_folder_url = folderCtx.folder_url;
        }
      }
    }

    // Add captured data to the database.
    projectTweets(ext.name, newData);
    triggerFolderNameBackfillIfNeeded(ext.name, folderCtx.folder_id, newData);

    logModuleItemsReceived(
      `Bookmarks${folderCtx.folder_id ? ` (folder: ${folderCtx.folder_name ?? folderCtx.folder_id})` : ''}`,
      newData.length,
    );
  } catch (err) {
    logModuleParseFailure('Bookmarks', req, res, err as Error);
  }
};
