import {
  ItemContentUnion,
  Media,
  Tag,
  TimelineAddToModuleInstruction,
  TimelineAddEntriesInstruction,
  TimelineEntry,
  TimelineInstructions,
  TimelinePinEntryInstruction,
  TimelineTimelineItem,
  TimelineTimelineModule,
  TimelineTweet,
  TimelineTwitterList,
  TimelineUser,
  Tweet,
  TweetArticleResult,
  TweetUnion,
  User,
} from '@/types';
import logger from './logger';
import { parseTwitterDateTime } from './common';

/**
 * A generic function to extract data from the API response.
 *
 * @param response The XHR object.
 * @param extractInstructionsFromJson Get "TimelineAddEntries" instructions from the JSON object.
 * @param extractDataFromTimelineEntry Get user/tweet data from the timeline entry.
 * @param onNewDataReceived Returns the extracted data.
 */
export function extractDataFromResponse<
  R,
  T extends User | Tweet,
  P extends TimelineUser | TimelineTweet = T extends User ? TimelineUser : TimelineTweet,
>(
  response: XMLHttpRequest,
  extractInstructionsFromJson: (json: R) => TimelineInstructions,
  extractDataFromTimelineEntry: (entry: TimelineEntry<P, TimelineTimelineItem<P>>) => T | null,
): T[] {
  const json: R = JSON.parse(response.responseText);
  const instructions = extractInstructionsFromJson(json);
  const timelineEntries = extractTimelineItemEntries<P>(instructions);
  const seenRestIds = new Set<string>();
  const newData: T[] = [];

  for (const entry of timelineEntries) {
    const data = extractDataFromTimelineEntry(entry);
    if (!data || seenRestIds.has(data.rest_id)) continue;
    seenRestIds.add(data.rest_id);
    newData.push(data);
  }

  return newData;
}

function extractTimelineItemEntries<P extends ItemContentUnion>(
  instructions: TimelineInstructions,
): TimelineEntry<P, TimelineTimelineItem<P>>[] {
  const entries: TimelineEntry<P, TimelineTimelineItem<P>>[] = [];

  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddEntries') {
      const addEntriesInstruction = instruction as TimelineAddEntriesInstruction<P>;
      for (const entry of addEntriesInstruction.entries ?? []) {
        if (isTimelineEntryItem<P>(entry)) {
          entries.push(entry);
        }
      }
      continue;
    }

    if (instruction.type === 'TimelinePinEntry') {
      const pinInstruction = instruction as TimelinePinEntryInstruction;
      const entry = pinInstruction.entry as TimelineEntry<P>;
      if (entry && isTimelineEntryItem<P>(entry)) {
        entries.push(entry);
      }
      continue;
    }

    if (instruction.type === 'TimelineAddToModule') {
      const addToModuleInstruction = instruction as TimelineAddToModuleInstruction<P>;
      for (const moduleItem of addToModuleInstruction.moduleItems ?? []) {
        const itemContent = moduleItem?.item?.itemContent as P | undefined;
        if (!itemContent) continue;
        entries.push({
          entryId: moduleItem.entryId ?? '',
          sortIndex: '0',
          content: {
            entryType: 'TimelineTimelineItem',
            __typename: 'TimelineTimelineItem',
            itemContent,
            clientEventInfo: moduleItem?.item?.clientEventInfo ?? null,
          },
        });
      }
      continue;
    }

    // Fallback: X frequently experiments with new instruction types. Many still
    // contain `entries` / `entry` / `moduleItems` payloads. Try to extract those
    // conservatively so we don't miss spliced/inserted timeline items.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instAny = instruction as any;
    if (Array.isArray(instAny?.entries)) {
      for (const entry of instAny.entries) {
        if (entry && isTimelineEntryItem<P>(entry)) {
          entries.push(entry);
        }
      }
      continue;
    }
    if (instAny?.entry && isTimelineEntryItem<P>(instAny.entry)) {
      entries.push(instAny.entry);
      continue;
    }
    if (Array.isArray(instAny?.moduleItems)) {
      for (const moduleItem of instAny.moduleItems ?? []) {
        const itemContent = moduleItem?.item?.itemContent as P | undefined;
        if (!itemContent) continue;
        entries.push({
          entryId: moduleItem.entryId ?? '',
          sortIndex: '0',
          content: {
            entryType: 'TimelineTimelineItem',
            __typename: 'TimelineTimelineItem',
            itemContent,
            clientEventInfo: moduleItem?.item?.clientEventInfo ?? null,
          },
        });
      }
      continue;
    }
  }

  return entries;
}

/**
 * Tweets with visibility limitation have an additional layer of nesting.
 * Extract the real tweet object from the wrapper.
 */
export function extractTimelineTweet(itemContent: TimelineTweet): Tweet | null {
  const tweetUnion = itemContent.tweet_results.result;

  if (!tweetUnion) {
    logger.warn(
      "TimelineTweet is empty. This could happen when the tweet's visibility is limited by Twitter.",
      itemContent,
    );
    return null;
  }

  return extractTweetUnion(tweetUnion);
}

/**
 * Extract the user object from the timeline entry, ignoring unavailable users.
 */
export function extractTimelineUser(itemContent: TimelineUser): User | null {
  const user = itemContent.user_results.result;

  if (!user || user.__typename !== 'User') {
    logger.warn(
      "TimelineUser is empty. This could happen when the user's account is suspended or deleted.",
      itemContent,
    );
    return null;
  }

  return user;
}

/*
|--------------------------------------------------------------------------
| Type predicates.
|
| Use these functions to narrow down the type of timeline entries.
|--------------------------------------------------------------------------
*/

export function isTimelineEntryItem<T extends ItemContentUnion>(
  entry: TimelineEntry,
): entry is TimelineEntry<T, TimelineTimelineItem<T>> {
  return entry.content.entryType === 'TimelineTimelineItem';
}

export function isTimelineEntryTweet(
  entry: TimelineEntry,
): entry is TimelineEntry<TimelineTweet, TimelineTimelineItem<TimelineTweet>> {
  return (
    isTimelineEntryItem<TimelineTweet>(entry) &&
    entry.entryId.startsWith('tweet-') &&
    entry.content.itemContent.__typename === 'TimelineTweet'
  );
}

export function isTimelineEntryUser(
  entry: TimelineEntry,
): entry is TimelineEntry<TimelineUser, TimelineTimelineItem<TimelineUser>> {
  return (
    isTimelineEntryItem<TimelineUser>(entry) &&
    entry.entryId.startsWith('user-') &&
    entry.content.itemContent.__typename === 'TimelineUser'
  );
}

export function isTimelineEntryModule<T extends ItemContentUnion>(
  entry: TimelineEntry,
): entry is TimelineEntry<T, TimelineTimelineModule<T>> {
  return entry.content.entryType === 'TimelineTimelineModule';
}

export function isTimelineEntryConversationThread(
  entry: TimelineEntry,
): entry is TimelineEntry<TimelineTweet, TimelineTimelineModule<TimelineTweet>> {
  return (
    isTimelineEntryModule<TimelineTweet>(entry) &&
    entry.entryId.startsWith('conversationthread-') &&
    Array.isArray(entry.content.items)
  );
}

export function isTimelineEntryProfileConversation(
  entry: TimelineEntry,
): entry is TimelineEntry<TimelineTweet, TimelineTimelineModule<TimelineTweet>> {
  return (
    isTimelineEntryModule<TimelineTweet>(entry) &&
    entry.entryId.startsWith('profile-conversation-') &&
    Array.isArray(entry.content.items)
  );
}

export function isTimelineEntryProfileGrid(
  entry: TimelineEntry,
): entry is TimelineEntry<TimelineTweet, TimelineTimelineModule<TimelineTweet>> {
  return (
    isTimelineEntryModule<TimelineTweet>(entry) &&
    entry.entryId.startsWith('profile-grid-') &&
    Array.isArray(entry.content.items)
  );
}

export function isTimelineEntrySearchGrid(
  entry: TimelineEntry,
): entry is TimelineEntry<TimelineTweet, TimelineTimelineModule<TimelineTweet>> {
  return (
    isTimelineEntryModule<TimelineTweet>(entry) &&
    entry.entryId.startsWith('search-grid-') &&
    Array.isArray(entry.content.items)
  );
}

export function isTimelineEntryListSearch(
  entry: TimelineEntry,
): entry is TimelineEntry<TimelineTwitterList, TimelineTimelineModule<TimelineTwitterList>> {
  return (
    isTimelineEntryModule<TimelineTwitterList>(entry) &&
    entry.entryId.startsWith('list-search-') &&
    Array.isArray(entry.content.items)
  );
}

export function isTimelineEntryCommunitiesGrid(
  entry: TimelineEntry,
): entry is TimelineEntry<TimelineTwitterList, TimelineTimelineModule<TimelineTwitterList>> {
  return (
    isTimelineEntryModule<TimelineTwitterList>(entry) &&
    entry.entryId.startsWith('communities-grid-') &&
    Array.isArray(entry.content.items)
  );
}

/*
|--------------------------------------------------------------------------
| Object extractors.
|
| Use these functions to extract data from the API response.
|--------------------------------------------------------------------------
*/

export function extractTweetUnion(tweet: TweetUnion): Tweet | null {
  try {
    if (tweet.__typename === 'Tweet') {
      return filterEmptyTweet(tweet);
    }

    if (tweet.__typename === 'TweetWithVisibilityResults') {
      return filterEmptyTweet(tweet.tweet);
    }

    if (tweet.__typename === 'TweetTombstone') {
      logger.warn(`TweetTombstone received (Reason: ${tweet.tombstone?.text?.text})`, tweet);
      return null;
    }

    if (tweet.__typename === 'TweetUnavailable') {
      logger.warn('TweetUnavailable received (Reason: unknown)', tweet);
      return null;
    }

    logger.debug(tweet);
    logger.errorWithBanner('Unknown tweet type received');
  } catch (err) {
    logger.debug(tweet);
    logger.errorWithBanner('Failed to extract tweet', err as Error);
  }

  return null;
}

export function extractRetweetedTweet(tweet: Tweet): Tweet | null {
  if (tweet.legacy.retweeted_status_result?.result) {
    return extractTweetUnion(tweet.legacy.retweeted_status_result.result);
  }

  return null;
}

export function extractQuotedTweet(tweet: Tweet): Tweet | null {
  if (tweet.quoted_status_result?.result) {
    return extractTweetUnion(tweet.quoted_status_result.result);
  }

  return null;
}

export function extractTweetArticle(tweet: Tweet): TweetArticleResult | null {
  const article = tweet.article?.article_results?.result;
  return article && typeof article === 'object' ? article : null;
}

function extractArticleBlockText(article: TweetArticleResult | null): string[] {
  const blocks = article?.content_state?.blocks;
  if (!Array.isArray(blocks)) return [];

  const parts: string[] = [];
  for (const block of blocks) {
    const text = typeof block?.text === 'string' ? block.text.trim() : '';
    if (!text) continue;
    parts.push(text);
  }
  return parts;
}

function normalizeSyntheticImageUrl(url: string): string {
  const value = String(url || '').trim();
  if (!value) return '';
  return value.replace(/\?(?:format|name)=[^&]+(?:&name=[^&]+)?$/i, '');
}

function buildSyntheticPhotoMedia(params: {
  tweet: Tweet;
  url: string;
  mediaId?: string | number | null;
  mediaKey?: string | null;
  width?: number | null;
  height?: number | null;
  altText?: string | null;
  idPrefix?: string;
}): Media | null {
  const originalUrl = String(params.url || '').trim();
  if (!originalUrl) return null;

  const tweetUrl = getTweetURL(params.tweet);
  const mediaId = String(
    params.mediaId || `${params.idPrefix || 'synthetic'}_${params.tweet.rest_id}`,
  ).trim();
  const mediaKey = String(params.mediaKey || `${params.idPrefix || 'synthetic'}_${mediaId}`).trim();
  const width = Number(params.width || 0) || 0;
  const height = Number(params.height || 0) || 0;

  return {
    display_url: originalUrl,
    expanded_url: tweetUrl,
    id_str: mediaId || params.tweet.rest_id,
    indices: [0, 0],
    media_url_https: originalUrl,
    type: 'photo',
    url: originalUrl,
    sizes: {
      large: { h: height, w: width, resize: 'fit' },
      medium: { h: height, w: width, resize: 'fit' },
      small: { h: height, w: width, resize: 'fit' },
      thumb: { h: height, w: width, resize: 'fit' },
    },
    original_info: {
      height,
      width,
    },
    media_results: {
      result: {
        media_key: mediaKey || `synthetic_${params.tweet.rest_id}`,
      },
    },
    ext_alt_text: String(params.altText || '').trim() || undefined,
    media_key: mediaKey || `synthetic_${params.tweet.rest_id}`,
  };
}

function buildSyntheticArticleMedia(tweet: Tweet, article: TweetArticleResult | null): Media[] {
  if (!article) return [];

  const deduped = new Map<string, Media>();
  const pushMedia = (media: Media | null) => {
    if (!media) return;
    const key = normalizeSyntheticImageUrl(media.media_url_https);
    if (!key || deduped.has(key)) return;
    deduped.set(key, media);
  };

  for (const entity of article.media_entities ?? []) {
    pushMedia(
      buildSyntheticPhotoMedia({
        tweet,
        url: entity?.media_info?.original_img_url || '',
        mediaId: entity?.media_id || entity?.id || article?.rest_id || tweet.rest_id,
        mediaKey: entity?.media_key || null,
        width: entity?.media_info?.original_img_width || 0,
        height: entity?.media_info?.original_img_height || 0,
        altText: article?.title || article?.preview_text || null,
        idPrefix: 'article',
      }),
    );
  }

  const coverMedia = article.cover_media;
  pushMedia(
    buildSyntheticPhotoMedia({
      tweet,
      url: coverMedia?.media_info?.original_img_url || '',
      mediaId: coverMedia?.media_id || article?.rest_id || tweet.rest_id,
      mediaKey: coverMedia?.media_key || null,
      width: coverMedia?.media_info?.original_img_width || 0,
      height: coverMedia?.media_info?.original_img_height || 0,
      altText: article?.title || article?.preview_text || null,
      idPrefix: 'article',
    }),
  );

  return Array.from(deduped.values());
}

function extractCardImageMedia(tweet: Tweet): Media[] {
  const cardCandidates = [tweet.card, tweet.unified_card];
  const urls = new Map<string, string>();

  const visit = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(obj)) {
      if (
        key === 'url' &&
        typeof nested === 'string' &&
        /https:\/\/pbs\.twimg\.com\/(?:card_img|media)\//.test(nested)
      ) {
        const canonical = normalizeSyntheticImageUrl(nested);
        if (canonical && !urls.has(canonical)) {
          urls.set(canonical, nested);
        }
        continue;
      }
      visit(nested);
    }
  };

  for (const candidate of cardCandidates) {
    visit(candidate);
  }

  let index = 0;
  return Array.from(urls.values())
    .slice(0, 12)
    .map((url) =>
      buildSyntheticPhotoMedia({
        tweet,
        url,
        mediaId: `${tweet.rest_id}_${index++}`,
        mediaKey: `card_${tweet.rest_id}_${index}`,
        altText: extractTweetFullText(tweet),
        idPrefix: 'card',
      }),
    )
    .filter((media): media is Media => !!media);
}

export function extractTweetCreatedAtMs(tweet: Tweet): number {
  const legacyCreatedAt = tweet.legacy?.created_at;
  if (typeof legacyCreatedAt === 'string' && legacyCreatedAt.trim()) {
    const parsed = +parseTwitterDateTime(legacyCreatedAt);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const articleCreatedAtSecs = Number(
    extractTweetArticle(tweet)?.metadata?.first_published_at_secs || 0,
  );
  if (Number.isFinite(articleCreatedAtSecs) && articleCreatedAtSecs > 0) {
    return articleCreatedAtSecs * 1000;
  }

  return Date.now();
}

export function extractTweetUserScreenName(tweet: Tweet): string {
  return tweet.core.user_results.result.core.screen_name;
}

export function extractTweetMedia(tweet: Tweet): Media[] {
  // Always use the real tweet object for retweeted tweets
  // since Twitter may truncate the media list for retweets.
  const realTweet = extractRetweetedTweet(tweet) ?? tweet;

  // Prefer `extended_entities` over `entities` for media list.
  if (realTweet.legacy.extended_entities?.media) {
    return realTweet.legacy.extended_entities.media;
  }

  const legacyMedia = realTweet.legacy?.entities?.media ?? [];
  if (legacyMedia.length) {
    return legacyMedia;
  }

  const articleMedia = buildSyntheticArticleMedia(realTweet, extractTweetArticle(realTweet));
  if (articleMedia.length) {
    return articleMedia;
  }

  const expectedMediaCount = Number(realTweet.twe_private_fields?.media_count || 0) || 0;
  if (expectedMediaCount > 0) {
    const cardMedia = extractCardImageMedia(realTweet);
    if (cardMedia.length) {
      return cardMedia;
    }
  }

  return [];
}

export function hasOwnTweetMedia(tweet: Tweet): boolean {
  if (extractRetweetedTweet(tweet)) {
    return false;
  }

  return extractTweetMedia(tweet).length > 0;
}

export function extractTweetMediaTags(tweet: Tweet): Tag[] {
  const media = extractTweetMedia(tweet);
  const dedupedTags: Tag[] = [];

  for (const item of media) {
    const tags = getMediaTags(item);
    for (const tag of tags) {
      if (dedupedTags.some((t) => t.user_id === tag.user_id)) {
        continue;
      }
      dedupedTags.push(tag);
    }
  }

  return dedupedTags;
}

export function extractTweetFullText(tweet: Tweet): string {
  const noteTweetText = tweet.note_tweet?.note_tweet_results.result.text;
  if (noteTweetText && noteTweetText.trim()) {
    return noteTweetText;
  }

  const legacyText = tweet.legacy?.full_text;
  if (legacyText && legacyText.trim()) {
    return legacyText;
  }

  const article = extractTweetArticle(tweet);
  const parts = [article?.title, article?.preview_text, ...extractArticleBlockText(article)]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const deduped = parts.filter((value, index) => parts.indexOf(value) === index);
  return deduped.join('\n\n');
}

export function filterEmptyTweet(tweet: Tweet): Tweet | null {
  if (!tweet.legacy) {
    const article = extractTweetArticle(tweet);
    if (!article || !tweet.core?.user_results?.result) {
      logger.warn('Empty tweet received', tweet);
      return null;
    }

    const createdAtMs = extractTweetCreatedAtMs(tweet);
    const fullText = extractTweetFullText(tweet);
    const syntheticMedia = buildSyntheticArticleMedia(tweet, article);
    const userRestId =
      tweet.core.user_results.result.rest_id ||
      String(tweet.core.user_results.result.id || '')
        .split(':')
        .pop() ||
      '';

    tweet.legacy = {
      bookmark_count: 0,
      bookmarked: false,
      created_at: new Date(createdAtMs).toUTCString(),
      conversation_id_str: tweet.rest_id,
      display_text_range: [0, fullText.length],
      entities: {
        media: syntheticMedia.length ? syntheticMedia : undefined,
        user_mentions: [],
        urls: [],
        hashtags: [],
        symbols: [],
        timestamps: [],
      },
      extended_entities: syntheticMedia.length
        ? {
            media: syntheticMedia,
          }
        : undefined,
      favorite_count: 0,
      favorited: false,
      full_text: fullText,
      is_quote_status: false,
      lang: 'und',
      possibly_sensitive: false,
      possibly_sensitive_editable: false,
      quote_count: 0,
      reply_count: 0,
      retweet_count: 0,
      retweeted: false,
      user_id_str: userRestId,
      id_str: tweet.rest_id,
    };
  }

  return tweet;
}

/*
|--------------------------------------------------------------------------
| Media operations.
|
| Use these functions to manipulate media URLs.
|--------------------------------------------------------------------------
*/

export function getMediaIndex(tweet: Tweet, media: Media): number {
  const key = media.media_key;
  return extractTweetMedia(tweet).findIndex((value) => value.media_key === key);
}

export function getMediaOriginalUrl(media: Media): string {
  // For videos, use the highest bitrate variant.
  if (media.type === 'video' || media.type === 'animated_gif') {
    const variants = media.video_info?.variants ?? [];
    let maxBitrateVariant = variants[0];

    for (const variant of variants) {
      if (variant.bitrate && variant.bitrate > (maxBitrateVariant?.bitrate ?? 0)) {
        maxBitrateVariant = variant;
      }
    }

    return maxBitrateVariant?.url ?? media.media_url_https;
  }

  // For photos, use the original size.
  return formatTwitterImage(media.media_url_https, 'orig');
}

export function getMediaTags(media: Media): Tag[] {
  return media.features?.all?.tags ?? [];
}

export function formatTwitterImage(
  imgUrl: string,
  name: 'thumb' | 'small' | 'medium' | 'large' | 'orig' = 'medium',
): string {
  if (!imgUrl) return '';

  try {
    const parsed = new URL(imgUrl);
    if (parsed.hostname === 'pbs.twimg.com') {
      const format = parsed.searchParams.get('format');
      const pathnameMatch = parsed.pathname.match(/^(\/media\/.+)\.(\w+)$/);
      if (pathnameMatch) {
        const [, pathWithoutExtension, ext] = pathnameMatch;
        parsed.pathname = pathWithoutExtension || parsed.pathname;
        parsed.search = '';
        parsed.searchParams.set('format', ext || format || 'jpg');
        parsed.searchParams.set('name', name);
        return parsed.toString();
      }

      if (format) {
        parsed.searchParams.set('name', name);
        return parsed.toString();
      }

      if (parsed.searchParams.has('name')) {
        parsed.searchParams.set('name', name);
        return parsed.toString();
      }
    }
  } catch {
    // Fall through to legacy formatting.
  }

  const regex = /^(https?:\/\/pbs\.twimg\.com\/media\/.+)\.(\w+)$/;
  const match = imgUrl.match(regex);

  if (!match) {
    const separator = imgUrl.includes('?') ? '&' : '?';
    return `${imgUrl}${separator}name=${name}`;
  }

  const [, url, ext] = match;
  return `${url}?format=${ext}&name=${name}`;
}

export function getProfileImageOriginalUrl(url: string): string {
  return url.replace(/_normal\.(jpe?g|png|gif)$/, '.$1');
}

export function getFileExtensionFromUrl(url: string): string {
  // https://pbs.twimg.com/media/F1aT_M9aAAEgJwi.jpg
  // https://pbs.twimg.com/media/F1aT_M9aAAEgJwi?format=jpg&name=orig
  // https://video.twimg.com/ext_tw_video/1724535034051166208/pu/vid/avc1/1508x1080/xU8GJO6bXmUurBIf.mp4?tag=14
  // https://pbs.twimg.com/card_img/1740118695274536960/Y1NUiWkZ?format=png&name=orig
  // https://pbs.twimg.com/profile_images/1652878800311427073/j0-3owJd_normal.jpg
  // https://pbs.twimg.com/profile_banners/4686835494/1698680296
  const regex = /format=(\w+)|\.(\w+)$|\.(\w+)\?.+$/;
  const match = regex.exec(url);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? 'jpg';
}

export function getTweetURL(tweet: Tweet): string {
  const tweetId = String(tweet.legacy?.id_str || tweet.rest_id || '').trim();
  return `https://twitter.com/${extractTweetUserScreenName(tweet)}/status/${tweetId}`;
}

export function getUserURL(user: User | string): string {
  return `https://twitter.com/${typeof user === 'string' ? user : user.core.screen_name}`;
}

export function getInReplyToTweetURL(tweet: Tweet): string {
  return `https://twitter.com/${tweet.legacy.in_reply_to_screen_name}/status/${tweet.legacy.in_reply_to_status_id_str}`;
}
