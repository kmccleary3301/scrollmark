import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { useTranslation } from '@/i18n';
import { Tweet, Media } from '@/types';
import {
  extractRetweetedTweet,
  extractTweetMedia,
  extractTweetCreatedAtMs,
  extractTweetFullText,
  extractTweetUserScreenName,
  formatTwitterImage,
  getMediaOriginalUrl,
  getTweetURL,
} from '@/utils/api';
import { formatDateTime, formatVideoDuration } from '@/utils/common';
import { options } from '@/core/options';
import {
  IconBookmark,
  IconExternalLink,
  IconHeart,
  IconLayoutColumns,
  IconPlayerPlayFilled,
  IconPhoto,
  IconRepeat,
  IconTable,
} from '@tabler/icons-preact';

type TweetMediaMasonryProps = {
  records: Tweet[];
  scrollParentRef: { current: HTMLElement | null };
  onOpenMedia: (url: string) => void;
  storageKey?: string;
  fullscreen?: boolean;
};

type MasonryItem = {
  id: string;
  tweet: Tweet;
  media: Media;
  screenName: string;
  fullText: string;
  createdAtLabel: string;
  tweetUrl: string;
  previewUrl: string;
  originalUrl: string;
  aspectRatio: number;
  bookmarkFolderName: string;
  favoriteCount: number;
  retweetCount: number;
  bookmarkCount: number;
  replyCount: number;
  durationLabel: string;
};

type MasonryColumn = {
  items: MasonryItem[];
  estimatedHeight: number;
};

const INITIAL_BATCH = 42;
const BATCH_SIZE = 24;
const SCROLL_THRESHOLD_PX = 900;
const COMFORTABLE_CARD_WIDTH = 320;
const COMPACT_CARD_WIDTH = 264;
const NARROW_COMFORTABLE_CARD_WIDTH = 228;
const NARROW_COMPACT_CARD_WIDTH = 196;
const COMFORTABLE_GAP = 16;
const COMPACT_GAP = 14;

function extractOriginalTweetMedia(tweet: Tweet): Media[] {
  if (extractRetweetedTweet(tweet)) {
    return [];
  }
  const media = extractTweetMedia(tweet);
  return media.filter(
    (item) => item.type === 'photo' || item.type === 'video' || item.type === 'animated_gif',
  );
}

function bookmarkFolderName(tweet: Tweet): string {
  const row = tweet as unknown as Record<string, unknown>;
  return row.__bookmark_folder_name_source === 'api' &&
    typeof row.__bookmark_folder_name === 'string'
    ? row.__bookmark_folder_name.trim()
    : '';
}

function mediaPreviewUrl(media: Media): string {
  if (media.type === 'photo') {
    return formatTwitterImage(media.media_url_https, 'large');
  }
  return formatTwitterImage(media.media_url_https, 'medium');
}

function mediaAspectRatio(media: Media): number {
  const width = media.original_info?.width || media.sizes?.large?.w || media.sizes?.medium?.w || 1;
  const height =
    media.original_info?.height || media.sizes?.large?.h || media.sizes?.medium?.h || 1;
  if (!width || !height) return 1;
  return Math.max(0.56, Math.min(1.8, width / height));
}

function clampLineEstimate(text: string, density: 'comfortable' | 'compact'): number {
  if (!text.trim()) return 0;
  const charsPerLine = density === 'compact' ? 34 : 42;
  const maxLines = density === 'compact' ? 3 : 4;
  return Math.max(1, Math.min(maxLines, Math.ceil(text.trim().length / charsPerLine)));
}

function estimateItemHeight(
  item: MasonryItem,
  columnWidth: number,
  density: 'comfortable' | 'compact',
): number {
  const mediaHeight = columnWidth / Math.max(0.56, item.aspectRatio || 1);
  const textLines = clampLineEstimate(item.fullText, density);
  const textHeight = textLines * 20;
  const headerHeight = density === 'compact' ? 96 : 108;
  const footerHeight = 34;
  const badgeHeight = item.bookmarkFolderName ? 22 : 0;
  const durationHeight = item.durationLabel ? 4 : 0;
  const spacing = density === 'compact' ? 24 : 30;
  return (
    mediaHeight + headerHeight + footerHeight + badgeHeight + textHeight + durationHeight + spacing
  );
}

function buildStableColumns(
  items: MasonryItem[],
  columnCount: number,
  columnWidth: number,
  density: 'comfortable' | 'compact',
): MasonryColumn[] {
  const normalizedCount = Math.max(1, columnCount);
  const columns: MasonryColumn[] = Array.from({ length: normalizedCount }, () => ({
    items: [],
    estimatedHeight: 0,
  }));

  for (const item of items) {
    let targetIndex = 0;
    for (let index = 1; index < columns.length; index += 1) {
      if (columns[index]!.estimatedHeight < columns[targetIndex]!.estimatedHeight) {
        targetIndex = index;
      }
    }

    columns[targetIndex]!.items.push(item);
    columns[targetIndex]!.estimatedHeight += estimateItemHeight(item, columnWidth, density);
  }

  return columns;
}

export function TweetMediaMasonry({
  records,
  scrollParentRef,
  onOpenMedia,
  storageKey,
  fullscreen,
}: TweetMediaMasonryProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstItemIdRef = useRef('');
  const [visibleCount, setVisibleCount] = useState(INITIAL_BATCH);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined' || !storageKey) return;
      const raw = localStorage.getItem(`${storageKey}:density`);
      if (raw === 'compact' || raw === 'comfortable') {
        setDensity(raw);
      }
    } catch {
      // ignore storage failures
    }
  }, [storageKey]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined' || !storageKey) return;
      localStorage.setItem(`${storageKey}:density`, density);
    } catch {
      // ignore storage failures
    }
  }, [density, storageKey]);

  const items = useMemo<MasonryItem[]>(() => {
    return records.flatMap((tweet) => {
      const mediaList = extractOriginalTweetMedia(tweet);
      if (!mediaList.length) return [];

      const screenName = extractTweetUserScreenName(tweet);
      const fullText = extractTweetFullText(tweet).trim();
      const createdAtLabel = formatDateTime(
        extractTweetCreatedAtMs(tweet),
        options.get('dateTimeFormat'),
      );
      const tweetUrl = getTweetURL(tweet);
      const folderName = bookmarkFolderName(tweet);

      return mediaList.map((media, index) => ({
        id: `${tweet.rest_id}:${media.media_key || media.id_str || index}`,
        tweet,
        media,
        screenName,
        fullText,
        createdAtLabel,
        tweetUrl,
        previewUrl: mediaPreviewUrl(media),
        originalUrl: getMediaOriginalUrl(media),
        aspectRatio: mediaAspectRatio(media),
        bookmarkFolderName: folderName,
        favoriteCount: Number(tweet.legacy?.favorite_count || 0),
        retweetCount: Number(tweet.legacy?.retweet_count || 0),
        bookmarkCount: Number(tweet.legacy?.bookmark_count || 0),
        replyCount: Number(tweet.legacy?.reply_count || 0),
        durationLabel:
          media.type === 'photo' ? '' : formatVideoDuration(media.video_info?.duration_millis),
      }));
    });
  }, [records]);

  const firstItemId = items[0]?.id || '';

  useEffect(() => {
    setVisibleCount((current) => {
      if (firstItemIdRef.current !== firstItemId) {
        firstItemIdRef.current = firstItemId;
        return Math.min(INITIAL_BATCH, Math.max(0, items.length));
      }
      if (items.length <= INITIAL_BATCH) {
        return Math.min(INITIAL_BATCH, Math.max(0, items.length));
      }
      if (current > items.length) {
        return items.length;
      }
      return Math.max(current, Math.min(INITIAL_BATCH, items.length));
    });
  }, [firstItemId, items.length]);

  useEffect(() => {
    const scrollParent = scrollParentRef.current;
    if (!scrollParent) return;

    const maybeGrow = () => {
      const remaining =
        scrollParent.scrollHeight - (scrollParent.scrollTop + scrollParent.clientHeight);
      if (remaining <= SCROLL_THRESHOLD_PX) {
        setVisibleCount((current) => Math.min(items.length, current + BATCH_SIZE));
      }
    };

    maybeGrow();
    scrollParent.addEventListener('scroll', maybeGrow, { passive: true });
    return () => scrollParent.removeEventListener('scroll', maybeGrow);
  }, [items.length, scrollParentRef]);

  useLayoutEffect(() => {
    const node = rootRef.current;
    const scrollParent = scrollParentRef.current;
    if (!node && !scrollParent) return;

    const measure = () => {
      const nodeWidth = node?.clientWidth || 0;
      const scrollParentWidth = scrollParent?.clientWidth || 0;
      setContainerWidth(Math.max(nodeWidth, scrollParentWidth, 0));
    };

    measure();
    const observer = new ResizeObserver(() => measure());
    if (node) observer.observe(node);
    if (scrollParent && scrollParent !== node) observer.observe(scrollParent);
    return () => observer.disconnect();
  }, [scrollParentRef]);

  const visibleItems = items.slice(0, visibleCount);
  const gapPx = density === 'compact' ? COMPACT_GAP : COMFORTABLE_GAP;
  const useNarrowCards = !fullscreen;
  const targetCardWidth =
    density === 'compact'
      ? useNarrowCards
        ? NARROW_COMPACT_CARD_WIDTH
        : COMPACT_CARD_WIDTH
      : useNarrowCards
        ? NARROW_COMFORTABLE_CARD_WIDTH
        : COMFORTABLE_CARD_WIDTH;
  const computedColumnCount = Math.max(
    1,
    containerWidth ? Math.floor((containerWidth + gapPx) / (targetCardWidth + gapPx)) : 1,
  );
  const minColumnCount = !fullscreen && containerWidth >= 520 ? 2 : 1;
  const maxColumnCount = fullscreen ? 6 : 4;
  const columnCount = Math.max(minColumnCount, Math.min(maxColumnCount, computedColumnCount));
  const columnWidth =
    containerWidth > 0
      ? (containerWidth - gapPx * Math.max(0, columnCount - 1)) / columnCount
      : targetCardWidth;

  const columns = useMemo(
    () => buildStableColumns(visibleItems, columnCount, columnWidth, density),
    [columnCount, columnWidth, density, visibleItems],
  );

  if (!items.length) {
    return (
      <div class="flex h-[320px] items-center justify-center text-sm opacity-60">
        {t('No media available.')}
      </div>
    );
  }

  return (
    <div ref={rootRef} class="w-full min-w-0 px-3 py-3">
      <div class="mb-3 flex items-center justify-between gap-3 text-[11px] font-mono opacity-70">
        <div class="flex items-center gap-3">
          <span>
            media {visibleItems.length}/{items.length}
          </span>
          <span>original tweet attachments only</span>
        </div>
        <div class="join">
          <button
            class={`btn join-item btn-xs ${density === 'comfortable' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setDensity('comfortable')}
            title="Comfortable density"
          >
            <IconTable size={14} />
          </button>
          <button
            class={`btn join-item btn-xs ${density === 'compact' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setDensity('compact')}
            title="Compact density"
          >
            <IconLayoutColumns size={14} />
          </button>
        </div>
      </div>

      <div class="flex items-start" style={{ gap: `${gapPx}px` }}>
        {columns.map((column, columnIndex) => (
          <div key={`column-${columnIndex}`} class="min-w-0 flex-1">
            {column.items.map((item) => (
              <article
                key={item.id}
                class={`overflow-hidden rounded-[20px] border border-base-300 bg-gradient-to-b from-base-100 to-base-200/80 shadow-md ${
                  density === 'compact' ? 'mb-3' : 'mb-4'
                }`}
              >
                <button
                  class="group relative block w-full bg-base-300 text-left"
                  onClick={() => onOpenMedia(item.originalUrl)}
                >
                  <div
                    class="w-full overflow-hidden"
                    style={{ aspectRatio: `${item.aspectRatio}` }}
                  >
                    <img
                      class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                      src={item.previewUrl}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/70 via-black/20 to-transparent px-3 pb-3 pt-8 text-white">
                    <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em]">
                      {item.media.type === 'photo' ? (
                        <IconPhoto size={14} />
                      ) : (
                        <IconPlayerPlayFilled size={14} />
                      )}
                      <span>{item.media.type === 'photo' ? 'Photo' : 'Video'}</span>
                    </div>
                    {item.durationLabel ? (
                      <div class="rounded-full bg-black/40 px-2 py-1 text-[10px] font-semibold">
                        {item.durationLabel}
                      </div>
                    ) : null}
                  </div>
                </button>

                <div class={`space-y-2 px-3 ${density === 'compact' ? 'py-2.5' : 'py-3'}`}>
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <div class="truncate text-sm font-semibold">@{item.screenName}</div>
                      <div class="text-[11px] opacity-60">{item.createdAtLabel}</div>
                    </div>
                    <a
                      class="btn btn-ghost btn-xs"
                      href={item.tweetUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Open tweet"
                    >
                      <IconExternalLink size={14} />
                    </a>
                  </div>

                  {item.bookmarkFolderName ? (
                    <div class="badge badge-outline badge-sm">{item.bookmarkFolderName}</div>
                  ) : null}

                  {item.fullText ? (
                    <p
                      class={`text-xs leading-5 opacity-80 ${density === 'compact' ? 'line-clamp-3' : 'line-clamp-4'}`}
                    >
                      {item.fullText}
                    </p>
                  ) : null}

                  <div class="flex flex-wrap items-center gap-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] opacity-65">
                    <span class="inline-flex items-center gap-1">
                      <IconHeart size={12} />
                      {item.favoriteCount}
                    </span>
                    <span class="inline-flex items-center gap-1">
                      <IconRepeat size={12} />
                      {item.retweetCount}
                    </span>
                    <span class="inline-flex items-center gap-1">
                      <IconBookmark size={12} />
                      {item.bookmarkCount}
                    </span>
                    <span>Replies {item.replyCount}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
