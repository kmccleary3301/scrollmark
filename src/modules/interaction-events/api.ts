import { Interceptor } from '@/core/extensions';
import { db } from '@/core/database';
import { Tweet, User } from '@/types';
import { recordDiagnosticInteractionEvent } from '@/utils/diagnostics';
import { buildSyntheticTweetFromDomSnapshot } from '@/utils/dom-tweet-snapshot';
import logger from '@/utils/logger';

type InteractionKind =
  | 'bookmark_add'
  | 'bookmark_remove'
  | 'bookmark_folder_add'
  | 'like_add'
  | 'like_remove'
  | 'follow_add'
  | 'follow_remove'
  | 'retweet_add'
  | 'retweet_remove';

type TargetType = 'tweet' | 'user' | 'folder' | 'unknown';

type InteractionMatch = {
  kind: InteractionKind;
  targetType: TargetType;
};

const GRAPHQL_OP_RE = /\/graphql\/[^/]+\/([^/?#]+)/i;
const ID_VALUE_RE = /^\d{5,25}$/;

const TWEET_ID_KEYS = new Set(['tweetid', 'tweetidstr', 'statusid', 'statusidstr', 'id', 'restid']);
const USER_ID_KEYS = new Set(['userid', 'targetuserid', 'useridstr', 'sourceuserid']);
const FOLDER_ID_KEYS = new Set([
  'bookmarkcollectionid',
  'bookmarkfolderid',
  'bookmarkcollection',
  'bookmarkfolder',
  'folderid',
  'collectionid',
]);

const BOOKMARKS_EXTENSION_NAME = 'BookmarksModule';
const LIKES_EXTENSION_NAME = 'LikesModule';
const FOLLOWING_EXTENSION_NAME = 'FollowingModule';
const BOOKMARK_FOLDER_CACHE_STORAGE_KEY = 'twe_bookmark_folder_name_cache_v1';

function normalizeKey(key: string): string {
  return String(key || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function toId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = String(Math.trunc(value));
    return ID_VALUE_RE.test(normalized) ? normalized : null;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  return ID_VALUE_RE.test(text) ? text : null;
}

function extractOperationName(url: string): string {
  const match = String(url || '').match(GRAPHQL_OP_RE);
  return match?.[1] || '';
}

function detectInteraction(url: string): InteractionMatch | null {
  const path = String(url || '').toLowerCase();
  const op = extractOperationName(url).toLowerCase();

  const source = `${path} ${op}`;

  if (
    /(bookmarktweettofolder|addbookmarktofolder|createbookmarktofolder|bookmarktofolder)/.test(
      source,
    )
  ) {
    return { kind: 'bookmark_folder_add', targetType: 'folder' };
  }
  if (/(createbookmark|addbookmark|bookmarkcreate|bookmark\/entries\/add)/.test(source)) {
    return { kind: 'bookmark_add', targetType: 'tweet' };
  }
  if (
    /(deletebookmark|removebookmark|destroybookmark|bookmark\/entries\/(remove|delete|destroy))/.test(
      source,
    )
  ) {
    return { kind: 'bookmark_remove', targetType: 'tweet' };
  }

  if (/(favoritetweet|createfavorite|like(add|tweet)?\b)/.test(source)) {
    return { kind: 'like_add', targetType: 'tweet' };
  }
  if (/(unfavoritetweet|deletefavorite|destroyfavorite|unlike(tweet)?\b)/.test(source)) {
    return { kind: 'like_remove', targetType: 'tweet' };
  }

  if (/(followuser|createfollow|friendships\/create(\.json)?\b)/.test(source)) {
    return { kind: 'follow_add', targetType: 'user' };
  }
  if (/(unfollowuser|destroyfollow|friendships\/destroy(\.json)?\b)/.test(source)) {
    return { kind: 'follow_remove', targetType: 'user' };
  }

  if (/(createretweet|statuses\/retweet\/)/.test(source)) {
    return { kind: 'retweet_add', targetType: 'tweet' };
  }
  if (/(deleteretweet|unretweet|statuses\/unretweet\/)/.test(source)) {
    return { kind: 'retweet_remove', targetType: 'tweet' };
  }

  return null;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function parseRequestBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};

  const trimmed = body.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = safeJsonParse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return {};
  }

  const out: Record<string, unknown> = {};
  try {
    const params = new URLSearchParams(trimmed);
    for (const [key, value] of params.entries()) {
      const parsedValue =
        value.startsWith('{') || value.startsWith('[') ? (safeJsonParse(value) ?? value) : value;
      if (key in out) {
        const existing = out[key];
        if (Array.isArray(existing)) {
          existing.push(parsedValue);
        } else {
          out[key] = [existing, parsedValue];
        }
      } else {
        out[key] = parsedValue;
      }
    }
  } catch {
    return {};
  }
  return out;
}

function collectIdsByKeys(
  node: unknown,
  matcher: (normalizedKey: string) => boolean,
  out: Set<string>,
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > 8 || !node) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectIdsByKeys(item, matcher, out, depth + 1, seen);
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const obj = node as Record<string, unknown>;
  if (seen.has(obj)) return;
  seen.add(obj);

  for (const [key, value] of Object.entries(obj)) {
    const normalized = normalizeKey(key);

    if (matcher(normalized)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const id = toId(item);
          if (id) out.add(id);
        }
      } else {
        const id = toId(value);
        if (id) out.add(id);
      }
    }

    collectIdsByKeys(value, matcher, out, depth + 1, seen);
  }
}

function extractIds(
  body: Record<string, unknown>,
  url: string,
): {
  tweetIds: string[];
  userIds: string[];
  folderIds: string[];
} {
  const tweetIds = new Set<string>();
  const userIds = new Set<string>();
  const folderIds = new Set<string>();

  collectIdsByKeys(body, (k) => TWEET_ID_KEYS.has(k), tweetIds);
  collectIdsByKeys(body, (k) => USER_ID_KEYS.has(k), userIds);
  collectIdsByKeys(body, (k) => FOLDER_ID_KEYS.has(k), folderIds);

  const path = String(url || '');
  const retweetPathMatch = path.match(/\/(?:retweet|unretweet)\/(\d{5,25})/i);
  if (retweetPathMatch?.[1]) {
    tweetIds.add(retweetPathMatch[1]);
  }

  return {
    tweetIds: [...tweetIds],
    userIds: [...userIds],
    folderIds: [...folderIds],
  };
}

function pickTargets(match: InteractionMatch, ids: ReturnType<typeof extractIds>): string[] {
  if (match.targetType === 'tweet' && ids.tweetIds.length) return ids.tweetIds;
  if (match.targetType === 'user' && ids.userIds.length) return ids.userIds;
  if (match.targetType === 'folder' && ids.folderIds.length) return ids.folderIds;

  if (ids.tweetIds.length) return ids.tweetIds;
  if (ids.userIds.length) return ids.userIds;
  if (ids.folderIds.length) return ids.folderIds;
  return ['unknown'];
}

function toSafeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 128);
}

function readBookmarkFolderNameFromCache(folderId: string | null): string | null {
  if (!folderId) return null;

  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(BOOKMARK_FOLDER_CACHE_STORAGE_KEY);
    if (!raw) return null;

    const entries = JSON.parse(raw) as Array<[unknown, unknown]>;
    if (!Array.isArray(entries)) return null;

    for (const entry of entries) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        String(entry[0] || '').trim() === folderId &&
        typeof entry[1] === 'string'
      ) {
        return entry[1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function patchTweetFlags(
  tweet: Tweet,
  state: {
    bookmarked?: boolean;
    favorited?: boolean;
    retweeted?: boolean;
    bookmarkFolderId?: string | null;
    bookmarkFolderName?: string | null;
  },
): Tweet {
  const next = {
    ...tweet,
    legacy: {
      ...tweet.legacy,
    },
  } as Tweet & Record<string, unknown>;

  if (typeof state.bookmarked === 'boolean') {
    next.legacy.bookmarked = state.bookmarked;
  }
  if (typeof state.favorited === 'boolean') {
    next.legacy.favorited = state.favorited;
  }
  if (typeof state.retweeted === 'boolean') {
    next.legacy.retweeted = state.retweeted;
  }

  if (state.bookmarkFolderId !== undefined) {
    if (state.bookmarkFolderId) {
      next.__bookmark_folder_id = state.bookmarkFolderId;
      next.__bookmark_folder_url = `https://x.com/i/bookmarks/${state.bookmarkFolderId}`;
      next.__bookmark_folder_name_source = state.bookmarkFolderName ? 'api' : 'id-only';
      if (state.bookmarkFolderName) {
        next.__bookmark_folder_name = state.bookmarkFolderName;
      } else {
        delete next.__bookmark_folder_name;
      }
    } else {
      delete next.__bookmark_folder_id;
      delete next.__bookmark_folder_name;
      delete next.__bookmark_folder_name_source;
      delete next.__bookmark_folder_url;
    }
  }

  return next as Tweet;
}

function patchUserFollowing(user: User, following: boolean): User {
  return {
    ...user,
    relationship_perspectives: {
      ...(user.relationship_perspectives || {}),
      following,
    },
  };
}

async function buildBookmarkHydrationTasks(
  tweetIds: string[],
  state: {
    bookmarked: boolean;
    bookmarkFolderId?: string | null;
    bookmarkFolderName?: string | null;
  },
): Promise<{ hydratedIds: string[]; tasks: Promise<unknown>[] }> {
  const ids = tweetIds.filter(Boolean);
  if (!ids.length) {
    return { hydratedIds: [], tasks: [] };
  }

  const hydratedTweets: Tweet[] = [];
  for (const tweetId of ids) {
    const synthetic = buildSyntheticTweetFromDomSnapshot({
      tweetId,
      bookmarked: state.bookmarked,
      bookmarkFolderId: state.bookmarkFolderId,
      bookmarkFolderName: state.bookmarkFolderName,
    });
    if (synthetic) {
      hydratedTweets.push(synthetic);
    }
  }

  if (!hydratedTweets.length) {
    return { hydratedIds: [], tasks: [] };
  }

  await db.extAddTweets(BOOKMARKS_EXTENSION_NAME, hydratedTweets);
  return {
    hydratedIds: hydratedTweets.map((tweet) => tweet.rest_id),
    tasks: [],
  };
}

async function buildMirrorTasks(
  interaction: InteractionMatch,
  ids: ReturnType<typeof extractIds>,
): Promise<Promise<unknown>[]> {
  const folderId = ids.folderIds[0] ?? null;
  const folderName = readBookmarkFolderNameFromCache(folderId);

  switch (interaction.kind) {
    case 'bookmark_add':
      if (!ids.tweetIds.length) return [];
      {
        const hydrated = await buildBookmarkHydrationTasks(ids.tweetIds, {
          bookmarked: true,
        });
        const remainingIds = ids.tweetIds.filter(
          (tweetId) => !hydrated.hydratedIds.includes(tweetId),
        );
        return [
          ...hydrated.tasks,
          ...(remainingIds.length
            ? [
                db.extAddTweetCaptureIds(BOOKMARKS_EXTENSION_NAME, remainingIds, (tweet) =>
                  patchTweetFlags(tweet, {
                    bookmarked: true,
                  }),
                ),
              ]
            : []),
        ];
      }
    case 'bookmark_folder_add':
      if (!ids.tweetIds.length) return [];
      {
        const hydrated = await buildBookmarkHydrationTasks(ids.tweetIds, {
          bookmarked: true,
          bookmarkFolderId: folderId ?? undefined,
          bookmarkFolderName: folderName,
        });
        const hydratedSet = new Set(hydrated.hydratedIds);
        const remainingIds = ids.tweetIds.filter((tweetId) => !hydratedSet.has(tweetId));
        return [
          ...hydrated.tasks,
          ...(remainingIds.length
            ? [
                db.extAddTweetCaptureIds(BOOKMARKS_EXTENSION_NAME, remainingIds, (tweet) =>
                  patchTweetFlags(tweet, {
                    bookmarked: true,
                    bookmarkFolderId: folderId ?? undefined,
                    bookmarkFolderName: folderName,
                  }),
                ),
              ]
            : []),
        ];
      }
    case 'bookmark_remove':
      if (!ids.tweetIds.length) return [];
      return [
        db.extRemoveTweetCaptureIds(BOOKMARKS_EXTENSION_NAME, ids.tweetIds, (tweet) =>
          patchTweetFlags(tweet, {
            bookmarked: false,
            bookmarkFolderId: null,
          }),
        ),
      ];
    case 'like_add':
      if (!ids.tweetIds.length) return [];
      return [
        db.extAddTweetCaptureIds(LIKES_EXTENSION_NAME, ids.tweetIds, (tweet) =>
          patchTweetFlags(tweet, {
            favorited: true,
          }),
        ),
      ];
    case 'like_remove':
      if (!ids.tweetIds.length) return [];
      return [
        db.extRemoveTweetCaptureIds(LIKES_EXTENSION_NAME, ids.tweetIds, (tweet) =>
          patchTweetFlags(tweet, {
            favorited: false,
          }),
        ),
      ];
    case 'follow_add':
      if (!ids.userIds.length) return [];
      return [
        db.extAddUserCaptureIds(FOLLOWING_EXTENSION_NAME, ids.userIds, (user) =>
          patchUserFollowing(user, true),
        ),
      ];
    case 'follow_remove':
      if (!ids.userIds.length) return [];
      return [
        db.extRemoveUserCaptureIds(FOLLOWING_EXTENSION_NAME, ids.userIds, (user) =>
          patchUserFollowing(user, false),
        ),
      ];
    default:
      return [];
  }
}

export const InteractionEventsInterceptor: Interceptor = (req, res, ext) => {
  const interaction = detectInteraction(req.url);
  if (!interaction) return;

  if (res.status < 200 || res.status >= 300) {
    return;
  }

  const body = parseRequestBody(req.body);
  const ids = extractIds(body, req.url);
  const targets = pickTargets(interaction, ids);
  const operation = extractOperationName(req.url) || 'none';

  const requestId = toSafeKeyPart(
    req.requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  );
  const now = Date.now();

  const items = targets.map((target, index) => {
    const targetSafe = toSafeKeyPart(target || 'unknown');
    const id = `${requestId}-${interaction.kind}-${index}`;
    const data_key = `${interaction.kind}|target:${targetSafe}|type:${interaction.targetType}|op:${toSafeKeyPart(operation)}`;
    return {
      id,
      data_key,
      created_at: now,
    };
  });

  const baseTasks = [db.extAddCustomCaptures(ext.name, items)];
  recordDiagnosticInteractionEvent({
    ts: now,
    extension: ext.name,
    kind: interaction.kind,
    target_type: interaction.targetType,
    operation,
    request_id: req.requestId,
    tweet_ids: ids.tweetIds,
    user_ids: ids.userIds,
    folder_ids: ids.folderIds,
    targets,
    mirror_task_count: baseTasks.length,
  });
  void buildMirrorTasks(interaction, ids)
    .then((mirrorTasks) => Promise.allSettled([...baseTasks, ...mirrorTasks]))
    .then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn('InteractionEvents: failed to mirror interaction state', result.reason);
        }
      }
    });

  logger.info(`InteractionEvents: ${items.length} items received`);
  logger.debug(
    `InteractionEvents: kind=${interaction.kind} targetType=${interaction.targetType} op=${operation}`,
  );
};
