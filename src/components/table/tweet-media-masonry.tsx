import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { useTranslation } from '@/i18n';
import { recordPerfMetric } from '@/core/perf/metrics';
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
import type { ResultWindow, SearchDocumentResultCursor } from '@/core/database/result-source';
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
import type { BaseTableAlternateViewDiagnostics } from './base';

type TweetMediaMasonryProps = {
  records: Tweet[];
  scrollParentRef: { current: HTMLElement | null };
  onOpenMedia: (url: string) => void;
  storageKey?: string;
  fullscreen?: boolean;
  sourceMode?: boolean;
  sourceTotalCount?: number;
  streamSourceRows?: () => AsyncIterable<Tweet>;
  mediaSourceKey?: string;
  mediaSourceTotalCount?: number;
  getMediaWindow?: (
    startIndex: number,
    limit: number,
  ) => Promise<ResultWindow<Tweet, SearchDocumentResultCursor>>;
  streamMediaRows?: () => AsyncIterable<Tweet>;
  onDiagnosticsChange?: (diagnostics: BaseTableAlternateViewDiagnostics | null) => void;
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

type MasonryViewportRange = {
  start: number;
  end: number;
  count: number;
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
const SOURCE_SCAN_BATCH_ROWS = 360;
const SOURCE_INITIAL_WINDOW_BATCH_ROWS = 48;
const SOURCE_WINDOW_BATCH_ROWS = 160;
const SOURCE_INITIAL_MEDIA_TARGET = 42;
const SOURCE_PREFETCH_MEDIA_AHEAD = 144;
const MASONRY_SOURCE_CACHE_LIMIT = 8;

type MasonrySourceCache = {
  items: MasonryItem[];
  nextRowIndex: number;
  scannedRows: number;
  exhausted: boolean;
  totalCount: number;
  updatedAt: number;
};

const masonrySourceCache = new Map<string, MasonrySourceCache>();

function readMasonrySourceCache(cacheKey: string): MasonrySourceCache | null {
  return masonrySourceCache.get(cacheKey) ?? null;
}

function writeMasonrySourceCache(cacheKey: string, cache: MasonrySourceCache) {
  cache.updatedAt = Date.now();
  masonrySourceCache.set(cacheKey, cache);
  if (masonrySourceCache.size <= MASONRY_SOURCE_CACHE_LIMIT) return;
  const oldest = [...masonrySourceCache.entries()].sort(
    (left, right) => left[1].updatedAt - right[1].updatedAt,
  )[0]?.[0];
  if (oldest) {
    masonrySourceCache.delete(oldest);
  }
}

function createEmptyMasonrySourceCache(totalCount: number): MasonrySourceCache {
  return {
    items: [],
    nextRowIndex: 0,
    scannedRows: 0,
    exhausted: false,
    totalCount,
    updatedAt: Date.now(),
  };
}

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

function buildMasonryItemsFromTweet(tweet: Tweet): MasonryItem[] {
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
}

export function TweetMediaMasonry({
  records,
  scrollParentRef,
  onOpenMedia,
  storageKey,
  fullscreen,
  sourceMode,
  sourceTotalCount = 0,
  streamSourceRows,
  mediaSourceKey,
  mediaSourceTotalCount,
  getMediaWindow,
  streamMediaRows,
  onDiagnosticsChange,
}: TweetMediaMasonryProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstItemIdRef = useRef('');
  const iteratorRef = useRef<AsyncIterator<Tweet> | null>(null);
  const viewportRafRef = useRef<number | null>(null);
  const sourceGenerationRef = useRef(0);
  const loadingSourceRef = useRef(false);
  const exhaustedSourceRef = useRef(false);
  const scannedSourceRowsRef = useRef(0);
  const sourceItemsRef = useRef<MasonryItem[]>([]);
  const sourceCacheKeyRef = useRef('');
  const [visibleCount, setVisibleCount] = useState(INITIAL_BATCH);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [containerWidth, setContainerWidth] = useState(0);
  const [sourceItems, setSourceItems] = useState<MasonryItem[]>([]);
  const [scannedSourceRows, setScannedSourceRows] = useState(0);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceExhausted, setSourceExhausted] = useState(false);
  const [viewportRange, setViewportRange] = useState<MasonryViewportRange>({
    start: 0,
    end: 0,
    count: 0,
  });
  const activeStreamRows = streamMediaRows ?? streamSourceRows;
  const activeSourceTotalCount = mediaSourceTotalCount ?? sourceTotalCount;
  const sourceCacheKey = useMemo(
    () =>
      [storageKey || 'media-masonry', mediaSourceKey || 'stream-source', sourceTotalCount].join(
        ':',
      ),
    [mediaSourceKey, sourceTotalCount, storageKey],
  );
  const useSourceStream = Boolean(sourceMode && (getMediaWindow || activeStreamRows));

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

  const arrayItems = useMemo<MasonryItem[]>(
    () => records.flatMap((tweet) => buildMasonryItemsFromTweet(tweet)),
    [records],
  );
  const items = useSourceStream ? sourceItems : arrayItems;

  useEffect(() => {
    sourceItemsRef.current = sourceItems;
  }, [sourceItems]);

  const loadSourceUntil = async (targetMediaCount: number) => {
    if (
      !useSourceStream ||
      (!activeStreamRows && !getMediaWindow) ||
      loadingSourceRef.current ||
      exhaustedSourceRef.current
    ) {
      return;
    }
    if (sourceItemsRef.current.length >= targetMediaCount) {
      return;
    }
    loadingSourceRef.current = true;
    setSourceLoading(true);
    const sourceGeneration = sourceGenerationRef.current;
    const beforeRows = scannedSourceRowsRef.current;
    const cacheKey = sourceCacheKeyRef.current || sourceCacheKey;
    const cache =
      readMasonrySourceCache(cacheKey) ?? createEmptyMasonrySourceCache(activeSourceTotalCount);
    let scannedRows = 0;
    let appendedItems = 0;
    try {
      const nextItems: MasonryItem[] = [];

      if (getMediaWindow) {
        while (
          sourceItemsRef.current.length + nextItems.length < targetMediaCount &&
          scannedRows < SOURCE_SCAN_BATCH_ROWS &&
          !cache.exhausted
        ) {
          if (sourceGenerationRef.current !== sourceGeneration) return;
          const windowLimit =
            cache.nextRowIndex <= 0 ? SOURCE_INITIAL_WINDOW_BATCH_ROWS : SOURCE_WINDOW_BATCH_ROWS;
          const window = await getMediaWindow(cache.nextRowIndex, windowLimit);
          if (sourceGenerationRef.current !== sourceGeneration) return;
          scannedRows += window.rows.length;
          cache.nextRowIndex += window.rows.length;
          scannedSourceRowsRef.current = Math.max(scannedSourceRowsRef.current, cache.nextRowIndex);
          setScannedSourceRows(scannedSourceRowsRef.current);
          for (const row of window.rows) {
            const tweetItems = buildMasonryItemsFromTweet(row);
            if (tweetItems.length) {
              nextItems.push(...tweetItems);
              appendedItems += tweetItems.length;
            }
          }
          cache.totalCount = window.totalCount || activeSourceTotalCount;
          if (!window.hasAfter || !window.rows.length) {
            cache.exhausted = true;
            exhaustedSourceRef.current = true;
            setSourceExhausted(true);
            break;
          }
        }
      } else if (activeStreamRows) {
        const iterator = iteratorRef.current ?? activeStreamRows()[Symbol.asyncIterator]();
        iteratorRef.current = iterator;
        while (
          sourceItemsRef.current.length + nextItems.length < targetMediaCount &&
          scannedRows < SOURCE_SCAN_BATCH_ROWS
        ) {
          if (sourceGenerationRef.current !== sourceGeneration) return;
          const next = await iterator.next();
          if (sourceGenerationRef.current !== sourceGeneration) return;
          if (next.done) {
            cache.exhausted = true;
            exhaustedSourceRef.current = true;
            setSourceExhausted(true);
            break;
          }
          scannedRows += 1;
          cache.nextRowIndex += 1;
          scannedSourceRowsRef.current += 1;
          if (scannedRows % 12 === 0) {
            setScannedSourceRows(scannedSourceRowsRef.current);
          }
          const tweetItems = buildMasonryItemsFromTweet(next.value);
          if (tweetItems.length) {
            nextItems.push(...tweetItems);
            appendedItems += tweetItems.length;
          }
        }
      }
      if (nextItems.length) {
        setSourceItems((current) => {
          if (sourceGenerationRef.current !== sourceGeneration) return current;
          const existing = new Set(current.map((item) => item.id));
          const deduped = nextItems.filter((item) => {
            if (existing.has(item.id)) return false;
            existing.add(item.id);
            return true;
          });
          if (!deduped.length) return current;
          const next = [...current, ...deduped];
          cache.items = next;
          cache.scannedRows = scannedSourceRowsRef.current;
          cache.exhausted = exhaustedSourceRef.current;
          writeMasonrySourceCache(cacheKey, cache);
          sourceItemsRef.current = next;
          return next;
        });
      } else {
        cache.items = sourceItemsRef.current;
        cache.scannedRows = scannedSourceRowsRef.current;
        cache.exhausted = exhaustedSourceRef.current;
        writeMasonrySourceCache(cacheKey, cache);
      }
    } finally {
      if (sourceGenerationRef.current === sourceGeneration) {
        loadingSourceRef.current = false;
        setScannedSourceRows(scannedSourceRowsRef.current);
        setSourceLoading(false);
      }
      recordPerfMetric({
        kind: 'viewer',
        name: 'media-source-scan',
        value: appendedItems,
        tags: {
          scannedRows,
          scannedRowsTotal: scannedSourceRowsRef.current,
          scannedRowsBefore: beforeRows,
          mediaItems: sourceItemsRef.current.length + appendedItems,
          targetMediaCount,
          exhausted: exhaustedSourceRef.current,
          sourceTotalCount: activeSourceTotalCount,
          windowBacked: Boolean(getMediaWindow),
        },
      });
    }
  };

  useEffect(() => {
    sourceGenerationRef.current += 1;
    iteratorRef.current = null;
    loadingSourceRef.current = false;
    setSourceLoading(false);
    sourceCacheKeyRef.current = sourceCacheKey;

    if (!useSourceStream) {
      exhaustedSourceRef.current = false;
      scannedSourceRowsRef.current = 0;
      sourceItemsRef.current = [];
      setSourceItems([]);
      setScannedSourceRows(0);
      setSourceExhausted(false);
      return;
    }

    const cached = readMasonrySourceCache(sourceCacheKey);
    if (cached) {
      exhaustedSourceRef.current = cached.exhausted;
      scannedSourceRowsRef.current = cached.scannedRows;
      sourceItemsRef.current = cached.items;
      setSourceItems(cached.items);
      setScannedSourceRows(cached.scannedRows);
      setSourceExhausted(cached.exhausted);
      return;
    }

    const empty = createEmptyMasonrySourceCache(activeSourceTotalCount);
    writeMasonrySourceCache(sourceCacheKey, empty);
    exhaustedSourceRef.current = false;
    scannedSourceRowsRef.current = 0;
    sourceItemsRef.current = [];
    setSourceItems([]);
    setScannedSourceRows(0);
    setSourceExhausted(false);
  }, [activeSourceTotalCount, sourceCacheKey, useSourceStream]);

  useEffect(() => {
    if (!useSourceStream) return;
    void loadSourceUntil(SOURCE_INITIAL_MEDIA_TARGET);
  }, [activeSourceTotalCount, sourceCacheKey, sourceItems.length, useSourceStream]);

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
        const nextVisibleCount = Math.min(items.length, visibleCount + BATCH_SIZE);
        setVisibleCount(nextVisibleCount);
        if (
          useSourceStream &&
          !sourceExhausted &&
          items.length <= nextVisibleCount + SOURCE_PREFETCH_MEDIA_AHEAD
        ) {
          void loadSourceUntil(nextVisibleCount + SOURCE_PREFETCH_MEDIA_AHEAD);
        }
      }
    };

    maybeGrow();
    scrollParent.addEventListener('scroll', maybeGrow, { passive: true });
    return () => scrollParent.removeEventListener('scroll', maybeGrow);
  }, [items.length, scrollParentRef, sourceExhausted, useSourceStream, visibleCount]);

  useEffect(() => {
    if (!useSourceStream || sourceExhausted) return;
    if (items.length <= visibleCount + SOURCE_PREFETCH_MEDIA_AHEAD) {
      void loadSourceUntil(visibleCount + SOURCE_PREFETCH_MEDIA_AHEAD);
    }
  }, [items.length, sourceExhausted, useSourceStream, visibleCount]);

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
  const visibleItemIndexById = useMemo(() => {
    const indexById = new Map<string, number>();
    visibleItems.forEach((item, index) => indexById.set(item.id, index));
    return indexById;
  }, [visibleItems]);
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
  useEffect(() => {
    const root = rootRef.current;
    const scrollParent = scrollParentRef.current;
    if (!root || !scrollParent) return;

    const measure = () => {
      viewportRafRef.current = null;
      const viewportRect = scrollParent.getBoundingClientRect();
      const cards = Array.from(root.querySelectorAll<HTMLElement>('article[data-masonry-index]'));
      let start = Number.POSITIVE_INFINITY;
      let end = -1;
      let count = 0;
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom) continue;
        const index = Number(card.dataset.masonryIndex ?? -1);
        if (!Number.isFinite(index) || index < 0) continue;
        start = Math.min(start, index);
        end = Math.max(end, index);
        count += 1;
      }
      const nextRange =
        count > 0
          ? { start, end, count }
          : {
              start: 0,
              end: Math.max(0, Math.min(visibleItems.length, visibleCount) - 1),
              count: 0,
            };
      setViewportRange((current) =>
        current.start === nextRange.start &&
        current.end === nextRange.end &&
        current.count === nextRange.count
          ? current
          : nextRange,
      );
    };

    const scheduleMeasure = () => {
      if (viewportRafRef.current !== null) return;
      viewportRafRef.current = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    scrollParent.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      scrollParent.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      if (viewportRafRef.current !== null) {
        window.cancelAnimationFrame(viewportRafRef.current);
        viewportRafRef.current = null;
      }
    };
  }, [columnCount, density, scrollParentRef, visibleCount, visibleItems.length]);

  const renderedStart = viewportRange.count ? viewportRange.start + 1 : visibleItems.length ? 1 : 0;
  const renderedEnd = viewportRange.count
    ? viewportRange.end + 1
    : Math.min(visibleItems.length, visibleCount);
  const renderedCount = viewportRange.count || visibleItems.length;
  const sourceStatus = sourceLoading ? 'loading' : sourceExhausted ? 'complete' : 'idle';
  const sourceTotalLabel = activeSourceTotalCount || '?';
  const primaryStatus = useSourceStream
    ? sourceLoading
      ? t('loading source {{scanned}}/{{total}}', {
          scanned: scannedSourceRows,
          total: sourceTotalLabel,
        })
      : t('source {{status}} {{scanned}}/{{total}}', {
          status: t(sourceStatus),
          scanned: scannedSourceRows,
          total: sourceTotalLabel,
        })
    : t('media {{count}}', { count: items.length });
  const diagnosticsActions = useMemo(
    () => (
      <div class="join">
        <button
          class={`btn join-item btn-xs ${density === 'comfortable' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setDensity('comfortable')}
          title={t('Comfortable density')}
        >
          <IconTable size={14} />
        </button>
        <button
          class={`btn join-item btn-xs ${density === 'compact' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setDensity('compact')}
          title={t('Compact density')}
        >
          <IconLayoutColumns size={14} />
        </button>
      </div>
    ),
    [density, t],
  );
  const diagnostics = useMemo<BaseTableAlternateViewDiagnostics>(
    () => ({
      primary: primaryStatus,
      details: [
        {
          key: 'rendered',
          label: t('rendered {{rendered}}/{{total}} (window {{start}}-{{end}})', {
            rendered: renderedCount,
            total: items.length,
            start: renderedStart,
            end: renderedEnd,
          }),
          minWidth: 'sm',
        },
        {
          key: 'loaded-media',
          label: t('loaded media {{count}}', { count: items.length }),
          minWidth: 'md',
        },
        {
          key: 'source-rows',
          label: useSourceStream
            ? t('source rows {{scanned}}/{{total}} {{status}}', {
                scanned: scannedSourceRows,
                total: sourceTotalLabel,
                status: t(sourceStatus),
              })
            : `result rows ${records.length}`,
          minWidth: 'lg',
        },
        {
          key: 'layout',
          label: t('layout {{columns}} cols @ {{width}}px', {
            columns: columnCount,
            width: Math.round(columnWidth),
          }),
          minWidth: 'xl',
        },
        {
          key: 'scope',
          label: t('original tweet attachments only'),
          minWidth: 'xl',
        },
      ],
      actions: diagnosticsActions,
    }),
    [
      columnCount,
      columnWidth,
      diagnosticsActions,
      items.length,
      primaryStatus,
      records.length,
      renderedEnd,
      renderedStart,
      renderedCount,
      scannedSourceRows,
      sourceStatus,
      sourceTotalLabel,
      t,
      useSourceStream,
      viewportRange.count,
    ],
  );

  useEffect(() => {
    onDiagnosticsChange?.(diagnostics);
  }, [diagnostics, onDiagnosticsChange]);

  useEffect(() => {
    return () => onDiagnosticsChange?.(null);
  }, [onDiagnosticsChange]);

  if (!items.length) {
    return (
      <div ref={rootRef} class="w-full min-w-0 px-3 py-3">
        <div class="flex h-[320px] items-center justify-center text-sm opacity-60">
          {sourceLoading ? (
            <span class="inline-flex items-center gap-2">
              <span class="loading loading-spinner loading-sm" />
              {t('Loading media.')}
            </span>
          ) : (
            t('No media available.')
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} class="w-full min-w-0 px-3 py-3">
      <div class="flex items-start" style={{ gap: `${gapPx}px` }}>
        {columns.map((column, columnIndex) => (
          <div key={`column-${columnIndex}`} class="min-w-0 flex-1">
            {column.items.map((item) => (
              <article
                key={item.id}
                data-masonry-index={visibleItemIndexById.get(item.id) ?? 0}
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
                      <span>{item.media.type === 'photo' ? t('Photo') : t('Video')}</span>
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
                      title={t('Open tweet')}
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
