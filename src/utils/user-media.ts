import { hasOwnTweetMedia } from '@/utils/api';

const USER_MEDIA_EXTENSION_NAME = 'UserMediaModule';

export function getUserMediaMirrorTweetIds(extName: string, tweets: unknown[]): string[] {
  if (extName === USER_MEDIA_EXTENSION_NAME || !Array.isArray(tweets) || !tweets.length) {
    return [];
  }

  return tweets
    .filter((tweet) => hasOwnTweetMedia(tweet as never))
    .map((tweet) => String((tweet as { rest_id?: unknown }).rest_id || '').trim())
    .filter(Boolean);
}
