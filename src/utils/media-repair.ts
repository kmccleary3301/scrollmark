import { db } from '@/core/database';
import {
  TimelineAddEntriesInstruction,
  TimelineAddToModuleInstruction,
  TimelineInstructions,
  TimelineTweet,
  Tweet,
  Media,
} from '@/types';
import {
  extractTimelineTweet,
  extractTweetMedia,
  isTimelineEntryConversationThread,
  isTimelineEntryTweet,
} from '@/utils/api';

type RepairStatus = 'pending' | 'active' | 'repaired' | 'skipped' | 'failed';

export type MediaRepairStats = {
  pending: number;
  active: number;
  repaired: number;
  skipped: number;
  failed: number;
  lastStatus?: RepairStatus;
};

type QueueOptions = {
  extensionName?: string;
  limit?: number;
};

type SyndicationMedia = Partial<Media> & {
  media_url?: string;
  media_url_https?: string;
  url?: string;
  expanded_url?: string;
  display_url?: string;
  media_key?: string;
  id_str?: string;
  id?: string | number;
  type?: string;
  ext_alt_text?: string;
  video_info?: Media['video_info'];
};

type SyndicationTweet = {
  mediaDetails?: SyndicationMedia[];
  photos?: Array<{ url?: string; width?: number; height?: number; alt_text?: string }>;
  video?: {
    poster?: string;
    variants?: NonNullable<Media['video_info']>['variants'];
    duration_millis?: number;
  };
};

type TweetDetailResponse = {
  data?: {
    threaded_conversation_with_injections_v2?: {
      instructions?: TimelineInstructions;
    };
  };
};

const REPAIR_CONCURRENCY = 2;
const REPAIR_DELAY_MS = 450;
const ATTEMPT_TTL_MS = 30_000;
const ATTEMPT_CACHE_LIMIT = 4000;
const TWEET_DETAIL_FALLBACK_QUERY_IDS = ['flqCy6kvOMolEquuRpOaHQ', '8sK2MBRZY9z-fgmdNpR3LA'];
const WEB_BEARER_FALLBACK =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCO2QwytGns47xHnR8U%3D' +
  'M6O8xvM0wVbQ8eGMfvKcAKb6T4sYx7Iu6i9iR2YtXQ';
const listeners = new Set<(stats: MediaRepairStats) => void>();
const queuedIds = new Set<string>();
const activeIds = new Set<string>();
const attemptIds: string[] = [];
const attemptTimes = new Map<string, number>();
const stats: MediaRepairStats = {
  pending: 0,
  active: 0,
  repaired: 0,
  skipped: 0,
  failed: 0,
};

let scheduled = false;
let tweetDetailQueryIdPromise: Promise<string | null> | null = null;
let webBearerTokenPromise: Promise<string | null> | null = null;

function isTweetLike(record: unknown): record is Tweet {
  return !!record && typeof record === 'object' && (record as Tweet).__typename === 'Tweet';
}

function recentlyAttempted(id: string): boolean {
  const attemptedAt = attemptTimes.get(id) || 0;
  if (!attemptedAt) return false;
  if (Date.now() - attemptedAt > ATTEMPT_TTL_MS) {
    attemptTimes.delete(id);
    return false;
  }
  return true;
}

function rememberAttempt(id: string) {
  if (!attemptTimes.has(id)) {
    attemptIds.push(id);
  }
  attemptTimes.set(id, Date.now());
  while (attemptIds.length > ATTEMPT_CACHE_LIMIT) {
    const old = attemptIds.shift();
    if (old) attemptTimes.delete(old);
  }
}

function emit(lastStatus?: RepairStatus) {
  stats.pending = queuedIds.size;
  stats.active = activeIds.size;
  stats.lastStatus = lastStatus;
  listeners.forEach((listener) => listener({ ...stats }));
}

export function subscribeMediaRepairStats(listener: (stats: MediaRepairStats) => void) {
  listeners.add(listener);
  listener({ ...stats });
  return () => listeners.delete(listener);
}

function hasDisplayableMediaUrl(media: Media): boolean {
  const url = media.media_url_https || '';
  if (/^https:\/\/pbs\.twimg\.com\/(media|card_img)\//.test(url)) return true;
  if (/^https:\/\/video\.twimg\.com\//.test(url)) return true;
  return !!media.video_info?.variants?.some((variant) => /^https?:\/\//.test(variant.url));
}

function expectedMediaCount(tweet: Tweet): number {
  const privateCount = tweet.twe_private_fields?.media_count || 0;
  const legacyExtendedCount = tweet.legacy?.extended_entities?.media?.length || 0;
  const legacyEntityCount = tweet.legacy?.entities?.media?.length || 0;
  return Math.max(privateCount, legacyExtendedCount, legacyEntityCount);
}

export function needsTweetMediaRepair(tweet: Tweet): boolean {
  const media = extractTweetMedia(tweet);
  const expected = expectedMediaCount(tweet);
  if (expected <= 0 && media.length <= 0) return false;
  const displayable = media.filter(hasDisplayableMediaUrl).length;
  return displayable < Math.max(expected, media.length);
}

function defaultSizes(width = 1200, height = 800): Media['sizes'] {
  return {
    large: { w: width, h: height, resize: 'fit' },
    medium: { w: Math.min(width, 1200), h: Math.min(height, 1200), resize: 'fit' },
    small: { w: Math.min(width, 680), h: Math.min(height, 680), resize: 'fit' },
    thumb: { w: 150, h: 150, resize: 'crop' },
  };
}

function normalizePhotoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'pbs.twimg.com') {
      parsed.searchParams.delete('format');
      parsed.searchParams.delete('name');
      return parsed.toString();
    }
  } catch {
    // Keep original URL if it is not parseable as an absolute URL.
  }
  return url;
}

function toMedia(item: SyndicationMedia, index: number): Media | null {
  const url = item.media_url_https || item.media_url || item.url || '';
  if (!/^https?:\/\//.test(url)) return null;
  const type = item.type === 'video' || item.type === 'animated_gif' ? item.type : 'photo';
  const width = item.original_info?.width || item.sizes?.large?.w || 1200;
  const height = item.original_info?.height || item.sizes?.large?.h || 800;
  const id = String(item.id_str || item.id || item.media_key || `repair-${index}`);

  return {
    display_url: item.display_url || '',
    expanded_url: item.expanded_url || item.url || '',
    id_str: id,
    indices: item.indices || [0, 0],
    media_url_https: normalizePhotoUrl(url),
    type,
    url: item.url || '',
    sizes: item.sizes || defaultSizes(width, height),
    original_info: item.original_info || { width, height },
    media_results: item.media_results || {
      result: {
        media_key: item.media_key || id,
      },
    },
    video_info: item.video_info,
    ext_alt_text: item.ext_alt_text,
    media_key: item.media_key,
  };
}

function mediaFromSyndication(json: SyndicationTweet): Media[] {
  const media: Media[] = [];
  const seen = new Set<string>();
  const add = (item: Media | null) => {
    if (!item) return;
    const key = item.media_key || item.id_str || item.media_url_https;
    if (seen.has(key)) return;
    seen.add(key);
    media.push(item);
  };

  json.mediaDetails?.forEach((item, index) => add(toMedia(item, index)));
  json.photos?.forEach((photo, index) => {
    if (!photo.url) return;
    add(
      toMedia(
        {
          media_url_https: photo.url,
          type: 'photo',
          ext_alt_text: photo.alt_text,
          original_info: {
            width: photo.width || 1200,
            height: photo.height || 800,
          },
        },
        media.length + index,
      ),
    );
  });

  if (json.video?.poster) {
    add(
      toMedia(
        {
          media_url_https: json.video.poster,
          type: 'video',
          video_info: {
            aspect_ratio: [16, 9],
            duration_millis: json.video.duration_millis || 0,
            variants: json.video.variants || [],
          },
        },
        media.length,
      ),
    );
  }

  return media;
}

function requestJson(url: string): Promise<unknown> {
  const gmRequest = (globalThis as { GM_xmlhttpRequest?: unknown }).GM_xmlhttpRequest;
  if (typeof gmRequest === 'function') {
    return new Promise((resolve, reject) => {
      gmRequest({
        method: 'GET',
        url,
        responseType: 'json',
        timeout: 15000,
        onload: (response: { status: number; response?: unknown; responseText?: string }) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          if (response.response) {
            resolve(response.response);
            return;
          }
          resolve(JSON.parse(response.responseText || '{}'));
        },
        onerror: () => reject(new Error('Request failed')),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });
  }

  return fetch(url, { credentials: 'omit' }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

function cookieValue(name: string): string {
  if (typeof document === 'undefined') return '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1] || '') : '';
}

function loadedScriptUrls(): string[] {
  if (typeof document === 'undefined') return [];
  return [...document.scripts]
    .map((script) => script.src)
    .filter((src) => /abs\.twimg\.com\/responsive-web\/client-web\/.+\.js/.test(src));
}

async function firstMatchingScriptText(patterns: RegExp[]): Promise<string | null> {
  const urls = loadedScriptUrls();
  for (const url of urls) {
    try {
      const text = await fetch(url, { credentials: 'omit' }).then((response) =>
        response.ok ? response.text() : '',
      );
      if (text && patterns.some((pattern) => pattern.test(text))) {
        return text;
      }
    } catch {
      // Ignore bundle fetch failures; this is a best-effort discovery path.
    }
  }
  return null;
}

async function discoverTweetDetailQueryId(): Promise<string | null> {
  if (!tweetDetailQueryIdPromise) {
    tweetDetailQueryIdPromise = (async () => {
      const text = await firstMatchingScriptText([/TweetDetail/]);
      if (!text) return null;

      const patterns = [
        /queryId:"([^"]+)"[^{}]{0,240}operationName:"TweetDetail"/,
        /operationName:"TweetDetail"[^{}]{0,240}queryId:"([^"]+)"/,
        /queryId:'([^']+)'[^{}]{0,240}operationName:'TweetDetail'/,
        /operationName:'TweetDetail'[^{}]{0,240}queryId:'([^']+)'/,
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return match[1];
      }
      return null;
    })();
  }
  return tweetDetailQueryIdPromise;
}

async function discoverWebBearerToken(): Promise<string | null> {
  if (!webBearerTokenPromise) {
    webBearerTokenPromise = (async () => {
      const text = await firstMatchingScriptText([/Bearer [A-Za-z0-9%._-]{40,}/, /AAAAAAAA/]);
      const match = text?.match(/Bearer ([A-Za-z0-9%._-]{40,})/);
      return match?.[1] ? decodeURIComponent(match[1]) : WEB_BEARER_FALLBACK;
    })();
  }
  return webBearerTokenPromise;
}

const TWEET_DETAIL_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

function extractTweetsFromTweetDetail(json: TweetDetailResponse): Tweet[] {
  const instructions = json.data?.threaded_conversation_with_injections_v2?.instructions ?? [];
  const tweets: Tweet[] = [];
  const addEntries = instructions.find(
    (instruction) => instruction.type === 'TimelineAddEntries',
  ) as TimelineAddEntriesInstruction<TimelineTweet> | undefined;

  for (const entry of addEntries?.entries ?? []) {
    if (isTimelineEntryTweet(entry)) {
      const tweet = extractTimelineTweet(entry.content.itemContent);
      if (tweet) tweets.push(tweet);
    }

    if (isTimelineEntryConversationThread(entry)) {
      const threadTweets = entry.content.items
        .map((item) => {
          if (!item.entryId.includes('-tweet-')) return null;
          return extractTimelineTweet(item.item.itemContent);
        })
        .filter((tweet): tweet is Tweet => !!tweet);
      tweets.push(...threadTweets);
    }
  }

  const addToModule = instructions.find(
    (instruction) => instruction.type === 'TimelineAddToModule',
  ) as TimelineAddToModuleInstruction<TimelineTweet> | undefined;
  if (addToModule) {
    tweets.push(
      ...addToModule.moduleItems
        .map((item) => extractTimelineTweet(item.item.itemContent))
        .filter((tweet): tweet is Tweet => !!tweet),
    );
  }

  return tweets;
}

function preserveLocalMetadata(original: Tweet, repaired: Tweet, source: string): Tweet {
  const originalExtras = original as unknown as Record<string, unknown>;
  const repairedExtras = repaired as unknown as Record<string, unknown>;
  for (const key of Object.keys(originalExtras)) {
    if (key.startsWith('__bookmark_')) {
      repairedExtras[key] = originalExtras[key];
    }
  }
  return {
    ...repaired,
    twe_private_fields: {
      ...repaired.twe_private_fields,
      media_count: Math.max(
        original.twe_private_fields?.media_count || 0,
        repaired.twe_private_fields?.media_count || 0,
        extractTweetMedia(repaired).length,
      ),
      media_repaired_at: Date.now(),
      media_repair_source: source,
    } as Tweet['twe_private_fields'] & {
      media_repaired_at: number;
      media_repair_source: string;
    },
  };
}

async function fetchTweetDetailTweet(tweetId: string): Promise<Tweet | null> {
  const discovered = await discoverTweetDetailQueryId();
  const queryIds = [
    ...new Set([discovered, ...TWEET_DETAIL_FALLBACK_QUERY_IDS].filter(Boolean)),
  ] as string[];
  const bearer = await discoverWebBearerToken();
  const csrf = cookieValue('ct0');
  const variables = {
    focalTweetId: tweetId,
    with_rux_injections: false,
    rankingMode: 'Relevance',
    includePromotedContent: true,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
  };

  for (const queryId of queryIds) {
    const url = `/i/api/graphql/${queryId}/TweetDetail?variables=${encodeURIComponent(
      JSON.stringify(variables),
    )}&features=${encodeURIComponent(JSON.stringify(TWEET_DETAIL_FEATURES))}`;
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          accept: '*/*',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-client-language': 'en',
        },
      });
      if (!response.ok) continue;
      const json = (await response.json()) as TweetDetailResponse;
      const tweets = extractTweetsFromTweetDetail(json);
      const tweet = tweets.find((candidate) => candidate.rest_id === tweetId);
      if (tweet) return tweet;
    } catch {
      // Try the next known query id.
    }
  }

  return null;
}

async function fetchSyndicationMedia(tweetId: string): Promise<Media[]> {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(
    tweetId,
  )}&lang=en`;
  const json = (await requestJson(url)) as SyndicationTweet;
  return mediaFromSyndication(json);
}

function mergeMedia(tweet: Tweet, media: Media[]): Tweet {
  const existing = extractTweetMedia(tweet).filter(hasDisplayableMediaUrl);
  const merged = media.length >= existing.length ? media : existing;
  return {
    ...tweet,
    legacy: {
      ...tweet.legacy,
      entities: {
        ...tweet.legacy.entities,
        media: merged,
      },
      extended_entities: {
        media: merged,
      },
    },
    twe_private_fields: {
      ...tweet.twe_private_fields,
      media_count: Math.max(tweet.twe_private_fields?.media_count || 0, merged.length),
      media_repaired_at: Date.now(),
      media_repair_source: 'syndication',
    } as Tweet['twe_private_fields'] & {
      media_repaired_at: number;
      media_repair_source: string;
    },
  };
}

async function repairTweet(tweet: Tweet, extensionName?: string): Promise<RepairStatus> {
  if (!needsTweetMediaRepair(tweet)) return 'skipped';
  let repairedTweet: Tweet | null = null;

  try {
    const detailTweet = await fetchTweetDetailTweet(tweet.rest_id);
    if (detailTweet) {
      repairedTweet = preserveLocalMetadata(tweet, detailTweet, 'tweet-detail');
    }
  } catch {
    // Fall back to public syndication below.
  }

  if (!repairedTweet || needsTweetMediaRepair(repairedTweet)) {
    const repairedMedia = await fetchSyndicationMedia(tweet.rest_id).catch(() => []);
    if (repairedMedia.length) {
      repairedTweet = mergeMedia(tweet, repairedMedia);
    }
  }

  if (!repairedTweet) return 'failed';
  if (!needsTweetMediaRepair(repairedTweet)) {
    if (extensionName) {
      await db.extAddTweets(extensionName, [repairedTweet]);
    } else {
      await db.upsertTweets([repairedTweet]);
    }
    return 'repaired';
  }
  return 'failed';
}

function scheduleDrain() {
  if (scheduled) return;
  scheduled = true;
  globalThis.setTimeout(() => {
    scheduled = false;
    void drainQueue();
  }, REPAIR_DELAY_MS);
}

async function drainQueue() {
  while (activeIds.size < REPAIR_CONCURRENCY && queuedIds.size > 0) {
    const id = queuedIds.values().next().value as string | undefined;
    if (!id) break;
    queuedIds.delete(id);
    activeIds.add(id);
    emit('active');
    void (async () => {
      let status: RepairStatus = 'failed';
      try {
        const entry = repairQueueData.get(id);
        if (entry) {
          status = await repairTweet(entry.tweet, entry.extensionName);
        }
      } catch {
        status = 'failed';
      } finally {
        activeIds.delete(id);
        repairQueueData.delete(id);
        if (status === 'repaired') stats.repaired++;
        if (status === 'skipped') stats.skipped++;
        if (status === 'failed') stats.failed++;
        emit(status);
        if (queuedIds.size > 0) scheduleDrain();
      }
    })();
  }
}

const repairQueueData = new Map<string, { tweet: Tweet; extensionName?: string }>();

export function queueTweetMediaRepair(records: unknown[], options: QueueOptions = {}) {
  const limit = Math.max(0, options.limit ?? records.length);
  let queued = 0;

  for (const record of records) {
    if (queued >= limit) break;
    if (!isTweetLike(record)) continue;
    const id = record.rest_id;
    if (!id || recentlyAttempted(id) || queuedIds.has(id) || activeIds.has(id)) continue;
    if (!needsTweetMediaRepair(record)) continue;
    rememberAttempt(id);
    repairQueueData.set(id, { tweet: record, extensionName: options.extensionName });
    queuedIds.add(id);
    queued++;
  }

  if (queued > 0) {
    emit('pending');
    scheduleDrain();
  }

  return queued;
}
