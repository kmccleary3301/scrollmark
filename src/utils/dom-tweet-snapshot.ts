import { Media, Tweet, User } from '@/types';

function isVisibleElement(node: Element | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
}

function uniqStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function selectTweetArticle(tweetId: string): HTMLElement | null {
  if (typeof document === 'undefined' || !tweetId) return null;
  const anchors = [...document.querySelectorAll(`a[href*="/status/${tweetId}"]`)];
  const visibleArticle = anchors
    .map((anchor) => anchor.closest('article'))
    .find((article) => isVisibleElement(article));
  if (visibleArticle instanceof HTMLElement) {
    return visibleArticle;
  }
  const firstArticle = anchors.map((anchor) => anchor.closest('article')).find(Boolean);
  return firstArticle instanceof HTMLElement ? firstArticle : null;
}

function extractScreenName(article: HTMLElement, tweetId: string): string {
  const statusAnchor = article.querySelector(
    `a[href*="/status/${tweetId}"]`,
  ) as HTMLAnchorElement | null;
  const href = statusAnchor?.getAttribute('href') || '';
  const match = href.match(/^\/([^/?#]+)\/status\//);
  return match?.[1] || 'unknown';
}

function extractDisplayName(article: HTMLElement, screenName: string): string {
  const explicit = article.querySelector('[data-testid="User-Name"] span')?.textContent || '';
  const normalized = normalizeText(explicit);
  if (normalized) return normalized.replace(/^@/, '');
  return screenName;
}

function extractTweetText(article: HTMLElement): string {
  const tweetText = uniqStrings(
    [...article.querySelectorAll('[data-testid="tweetText"], div[lang]')].map((node) =>
      normalizeText(node.textContent || ''),
    ),
  );
  if (tweetText.length) {
    return tweetText.join('\n\n');
  }

  const fallback = normalizeText(article.innerText || article.textContent || '');
  return fallback;
}

function toUtcStringFromDatetime(value: string | null): string {
  if (!value) return new Date().toUTCString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return new Date().toUTCString();
  return new Date(parsed).toUTCString();
}

function extractProfileImage(article: HTMLElement): string {
  const candidate = [...article.querySelectorAll('img')].find((img) => {
    const src = img.getAttribute('src') || '';
    return /profile_images/.test(src);
  });
  return candidate?.getAttribute('src') || '';
}

function extractMedia(article: HTMLElement, tweetId: string): Media[] {
  const mediaImages = [...article.querySelectorAll('img')]
    .map((img) => ({
      src: img.getAttribute('src') || '',
      width: img.naturalWidth || img.clientWidth || 0,
      height: img.naturalHeight || img.clientHeight || 0,
      alt: img.getAttribute('alt') || '',
    }))
    .filter(({ src, alt }) => {
      if (!src) return false;
      if (/profile_images/.test(src)) return false;
      if (/emoji/.test(src)) return false;
      if (!/twimg\.com\//.test(src)) return false;
      if (alt === 'Image') return true;
      return /\/media\//.test(src) || /name=/.test(src);
    });

  const uniq = uniqStrings(mediaImages.map((item) => item.src));
  return uniq.slice(0, 8).map((src, index) => {
    const meta = mediaImages.find((item) => item.src === src);
    return {
      type: 'photo',
      media_url_https: src,
      media_url: src,
      id_str: `${tweetId}${index}`,
      media_key: `dom:${tweetId}:${index}`,
      indices: [0, 0],
      url: src,
      display_url: src,
      expanded_url: src,
      sizes: {
        medium: { w: meta?.width || 1200, h: meta?.height || 675, resize: 'fit' },
        large: { w: meta?.width || 1200, h: meta?.height || 675, resize: 'fit' },
        small: { w: meta?.width || 680, h: meta?.height || 382, resize: 'fit' },
        thumb: { w: 150, h: 150, resize: 'crop' },
      },
      original_info: {
        width: meta?.width || 1200,
        height: meta?.height || 675,
      },
      features: {},
    } as unknown as Media;
  });
}

function buildSyntheticUser(
  screenName: string,
  displayName: string,
  profileImageUrl: string,
): User {
  return {
    __typename: 'User',
    id: screenName || 'unknown',
    rest_id: screenName || 'unknown',
    affiliates_highlighted_label: null,
    has_graduated_access: false,
    is_blue_verified: false,
    profile_image_shape: 'Circle',
    legacy: {
      default_profile: false,
      default_profile_image: !profileImageUrl,
      description: '',
      entities: { description: { urls: [] } },
      fast_followers_count: 0,
      favourites_count: 0,
      followers_count: 0,
      friends_count: 0,
      has_custom_timelines: false,
      is_translator: false,
      listed_count: 0,
      media_count: 0,
      normal_followers_count: 0,
      pinned_tweet_ids_str: [],
      possibly_sensitive: false,
      profile_interstitial_type: '',
      statuses_count: 0,
      translator_type: '',
      want_retweets: true,
      withheld_in_countries: [],
    },
    avatar: {
      image_url: profileImageUrl,
    },
    core: {
      name: displayName || screenName || 'unknown',
      screen_name: screenName || 'unknown',
      created_at: new Date(0).toUTCString(),
    },
    dm_permissions: { can_dm: false },
    location: { location: '' },
    media_permissions: { can_media_tag: false },
    privacy: { protected: false },
    verification: { verified: false },
    relationship_perspectives: { following: false, followed_by: false },
    twe_private_fields: {
      created_at: 0,
      updated_at: Date.now(),
    },
  } as User;
}

export function buildSyntheticTweetFromDomSnapshot(input: {
  tweetId: string;
  bookmarked?: boolean;
  bookmarkFolderId?: string | null;
  bookmarkFolderName?: string | null;
}): Tweet | null {
  const tweetId = String(input.tweetId || '').trim();
  if (!tweetId) return null;

  const article = selectTweetArticle(tweetId);
  if (!article) return null;

  const screenName = extractScreenName(article, tweetId);
  const displayName = extractDisplayName(article, screenName);
  const fullText = extractTweetText(article);
  const createdAtIso =
    (article.querySelector('time') as HTMLTimeElement | null)?.getAttribute('datetime') || null;
  const createdAt = toUtcStringFromDatetime(createdAtIso);
  const profileImageUrl = extractProfileImage(article);
  const media = extractMedia(article, tweetId);
  const folderId = input.bookmarkFolderId ? String(input.bookmarkFolderId) : '';
  const folderName = input.bookmarkFolderName ? String(input.bookmarkFolderName).trim() : '';

  const tweet = {
    __typename: 'Tweet',
    rest_id: tweetId,
    core: {
      user_results: {
        result: buildSyntheticUser(screenName, displayName, profileImageUrl),
      },
    },
    edit_control: {
      edit_tweet_ids: [tweetId],
      editable_until_msecs: '0',
      is_edit_eligible: false,
      edits_remaining: '0',
    },
    is_translatable: false,
    views: {
      count: '0',
      state: 'Enabled',
    },
    source: 'dom-snapshot',
    legacy: {
      bookmark_count: 0,
      bookmarked: input.bookmarked === true,
      created_at: createdAt,
      conversation_id_str: tweetId,
      display_text_range: [0, fullText.length],
      entities: {
        media: media.length ? media : undefined,
        user_mentions: [],
        urls: [],
        hashtags: [],
        symbols: [],
        timestamps: [],
      },
      extended_entities: media.length ? ({ media } as never) : undefined,
      favorite_count: 0,
      favorited: false,
      full_text: fullText,
      is_quote_status: false,
      lang: '',
      possibly_sensitive: false,
      possibly_sensitive_editable: false,
      quote_count: 0,
      reply_count: 0,
      retweet_count: 0,
      retweeted: false,
      user_id_str: screenName || 'unknown',
      id_str: tweetId,
    },
    twe_private_fields: {
      created_at: Date.parse(createdAt) || Date.now(),
      updated_at: Date.now(),
      media_count: media.length,
    },
    ...(folderId
      ? {
          __bookmark_folder_id: folderId,
          __bookmark_folder_url: `https://x.com/i/bookmarks/${folderId}`,
          __bookmark_folder_name_source: folderName ? 'api' : 'id-only',
          ...(folderName ? { __bookmark_folder_name: folderName } : {}),
        }
      : {}),
  } as unknown as Tweet;

  return tweet;
}
