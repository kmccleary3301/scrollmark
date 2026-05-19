import { Fragment } from 'preact';
import { Signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { options } from '@/core/options';
import { useTranslation } from '@/i18n';
import { LogLine, logLinesSignal } from '@/utils/logger';
import {
  clearDiagnosticBuffers,
  diagnosticKeys,
  isDiagnosticCaptureEnabled,
  setDiagnosticCaptureEnabled,
} from '@/utils/diagnostics';
import { downloadJson, exportDiagnosticsBundleZip, readRawStats } from './diagnostics-bundle';

const colors = {
  info: 'text-base-content',
  warn: 'text-warning',
  error: 'text-error',
};

type LogsProps = {
  lines: Signal<LogLine[]>;
};

const RAW_DAEMON_BASE_URL_STORAGE_KEY = 'twe_raw_capture_daemon_url_v1';
const RAW_SEARCH_QUERY_STORAGE_KEY = 'twe_raw_search_query_v1';
const RAW_SEARCH_SORT_STORAGE_KEY = 'twe_raw_search_sort_v1';
const RAW_SEARCH_LIMIT_STORAGE_KEY = 'twe_raw_search_limit_v1';
const RAW_SEARCH_SAVED_STORAGE_KEY = 'twe_raw_search_saved_v1';
const RAW_SEARCH_RANKING_STORAGE_KEY = 'twe_raw_search_ranking_v1';

function Logs({ lines }: LogsProps) {
  const reversed = lines.value.slice().reverse();

  return (
    <pre class="leading-none text-xs max-h-48 bg-base-200 overflow-y-scroll m-0 px-1 py-2.5 no-scrollbar rounded-box-half">
      {reversed.map((line) => (
        <span class={colors[line.type]} key={line.index}>
          #{line.index} {line.line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

type RawCaptureStatsView = {
  total?: number;
  dropped?: number;
  spool_count?: number;
  spool_enqueued?: number;
  spool_flushed?: number;
  spool_failed?: number;
  spool_drop_overflow?: number;
  spool_unavailable?: number;
  oldest_pending_age_ms?: number;
  daemon_online?: boolean;
  daemon_last_error?: string;
  monitor_role?: string;
  monitor_leader_tab_id?: string;
  monitor_last_heartbeat_ms?: number;
  monitor_ticks_route?: number;
  monitor_ticks_viewport?: number;
  monitor_suppressed_route?: number;
  monitor_suppressed_viewport?: number;
};

function RawCaptureHealth() {
  const [stats, setStats] = useState<RawCaptureStatsView>(() => readRawStats());

  useEffect(() => {
    const refresh = () => setStats(readRawStats());

    refresh();
    let timer: number | null = null;
    const schedule = () => {
      const delay = document.hidden ? 9000 : 2500;
      timer = window.setTimeout(() => {
        refresh();
        schedule();
      }, delay);
    };
    schedule();
    window.addEventListener('twe:raw-event-v1', refresh as EventListener);
    window.addEventListener('twe:raw-spool-state-v1', refresh as EventListener);
    window.addEventListener('twe:raw-monitor-role-v1', refresh as EventListener);

    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      window.removeEventListener('twe:raw-event-v1', refresh as EventListener);
      window.removeEventListener('twe:raw-spool-state-v1', refresh as EventListener);
      window.removeEventListener('twe:raw-monitor-role-v1', refresh as EventListener);
    };
  }, []);

  return (
    <div class="text-[11px] leading-tight bg-base-200 rounded-box-half px-2 py-1.5 mb-1">
      <div>
        raw events: {Number(stats.total || 0)} | dropped: {Number(stats.dropped || 0)}
      </div>
      <div>
        spool: {Number(stats.spool_count || 0)} queued / {Number(stats.spool_enqueued || 0)} enq /{' '}
        {Number(stats.spool_flushed || 0)} flushed / {Number(stats.spool_failed || 0)} failed
      </div>
      <div>
        spool overflow drops: {Number(stats.spool_drop_overflow || 0)} | unavailable:{' '}
        {Number(stats.spool_unavailable || 0)} | oldest pending:{' '}
        {Number(stats.oldest_pending_age_ms || 0)}ms
      </div>
      <div>
        daemon: {stats.daemon_online ? 'online' : 'offline'}
        {stats.daemon_last_error ? ` | last error: ${stats.daemon_last_error}` : ''}
      </div>
      <div>
        monitor: {stats.monitor_role || 'unknown'} | leader: {stats.monitor_leader_tab_id || '-'} |
        lease: {Number(stats.monitor_last_heartbeat_ms || 0)}
      </div>
      <div>
        monitor ticks route/viewport: {Number(stats.monitor_ticks_route || 0)}/
        {Number(stats.monitor_ticks_viewport || 0)} | suppressed route/viewport:{' '}
        {Number(stats.monitor_suppressed_route || 0)}/
        {Number(stats.monitor_suppressed_viewport || 0)}
      </div>
    </div>
  );
}

function DiagnosticsExport() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean>(() => isDiagnosticCaptureEnabled());

  useEffect(() => {
    const refresh = () => setEnabled(isDiagnosticCaptureEnabled());
    window.addEventListener(diagnosticKeys.eventName, refresh as EventListener);
    return () => window.removeEventListener(diagnosticKeys.eventName, refresh as EventListener);
  }, []);

  const onExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await exportDiagnosticsBundleZip();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mb-1 grid min-w-0 grid-cols-2 items-center gap-2">
      <label class="label min-w-0 cursor-pointer gap-2 py-0">
        <span class="text-[11px]">{t('Diagnostic capture')}</span>
        <input
          type="checkbox"
          class="toggle toggle-xs"
          checked={enabled}
          onChange={(event) => {
            const next = (event.target as HTMLInputElement).checked;
            setDiagnosticCaptureEnabled(next);
            setEnabled(next);
          }}
        />
      </label>
      <button
        class="btn btn-xs h-auto min-h-6 max-w-full whitespace-normal break-words text-center leading-tight"
        onClick={() => {
          clearDiagnosticBuffers();
        }}
      >
        {t('Clear Buffers')}
      </button>
      <button
        class="btn btn-xs col-span-2 h-auto min-h-6 max-w-full whitespace-normal break-words text-center leading-tight"
        disabled={busy}
        onClick={onExport}
      >
        {busy ? t('Preparing diagnostics...') : t('Export Diagnostics Bundle')}
      </button>
    </div>
  );
}

type RecorderSearchSort = 'relevance' | 'newest' | 'oldest';

type RecorderSearchRow = {
  entity_id: string;
  observed_at_ms: number;
  route_type: string;
  text: string;
  author_screen_name: string;
  author_verified?: number;
  author_blue_verified?: number;
  source_text?: string;
  card_name?: string;
  score: number;
  score_components?: {
    bm25?: number;
    lexical?: number;
    cover_density?: number;
  };
  has_media?: number;
  has_links?: number;
  is_reply?: number;
  is_retweet?: number;
  is_quote?: number;
  favorited?: number;
  bookmarked?: number;
  favorite_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  bookmark_folder_id?: string;
  bookmark_folder_name?: string;
};

type RecorderSearchParsed = {
  has_positive_lexical?: boolean;
  positive_group_count?: number;
  positive_lexical_count?: number;
  negative_lexical_count?: number;
  filter_count?: number;
  positive_terms?: string[];
  lexical_expression?: string | null;
  filter_boolean_semantics?: string;
  fts_expression?: string | null;
};

type RecorderSearchPayload = {
  count: number;
  total_matches: number;
  limit: number;
  offset: number;
  sort: RecorderSearchSort;
  warnings?: string[];
  ranking?: Record<string, number>;
  parsed?: RecorderSearchParsed;
  warning_objects?: Array<{
    code?: string;
    message?: string;
    token?: string;
  }>;
  rows: RecorderSearchRow[];
};

type SavedSearchEntry = {
  id: string;
  name: string;
  query: string;
};

type FacetCount = {
  value: string;
  count: number;
};

type SearchRankingOverrides = {
  bm25: string;
  lexical: string;
  cover_density: string;
  recency: string;
  term_match: string;
  phrase_match: string;
  cover_bigram: string;
  cover_trigram: string;
};

const DEFAULT_SEARCH_RANKING_OVERRIDES: SearchRankingOverrides = {
  bm25: '',
  lexical: '',
  cover_density: '',
  recency: '',
  term_match: '',
  phrase_match: '',
  cover_bigram: '',
  cover_trigram: '',
};

function readLocalStorageString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorageString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function readSavedSearches(): SavedSearchEntry[] {
  try {
    const raw = readLocalStorageString(RAW_SEARCH_SAVED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SavedSearchEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const id = String(row.id || '').trim();
      const name = String(row.name || '').trim();
      const query = String(row.query || '').trim();
      if (!id || !name) continue;
      out.push({ id, name, query });
    }
    return out.slice(0, 30);
  } catch {
    return [];
  }
}

function writeSavedSearches(entries: SavedSearchEntry[]) {
  try {
    const payload = JSON.stringify(entries.slice(0, 30));
    writeLocalStorageString(RAW_SEARCH_SAVED_STORAGE_KEY, payload);
  } catch {
    // ignore
  }
}

function readSearchRankingOverrides(): SearchRankingOverrides {
  try {
    const raw = readLocalStorageString(RAW_SEARCH_RANKING_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SEARCH_RANKING_OVERRIDES };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SEARCH_RANKING_OVERRIDES };
    const value = parsed as Record<string, unknown>;
    return {
      bm25: String(value.bm25 || '').trim(),
      lexical: String(value.lexical || '').trim(),
      cover_density: String(value.cover_density || '').trim(),
      recency: String(value.recency || '').trim(),
      term_match: String(value.term_match || '').trim(),
      phrase_match: String(value.phrase_match || '').trim(),
      cover_bigram: String(value.cover_bigram || '').trim(),
      cover_trigram: String(value.cover_trigram || '').trim(),
    };
  } catch {
    return { ...DEFAULT_SEARCH_RANKING_OVERRIDES };
  }
}

function writeSearchRankingOverrides(value: SearchRankingOverrides) {
  try {
    writeLocalStorageString(
      RAW_SEARCH_RANKING_STORAGE_KEY,
      JSON.stringify({
        bm25: String(value.bm25 || '').trim(),
        lexical: String(value.lexical || '').trim(),
        cover_density: String(value.cover_density || '').trim(),
        recency: String(value.recency || '').trim(),
        term_match: String(value.term_match || '').trim(),
        phrase_match: String(value.phrase_match || '').trim(),
        cover_bigram: String(value.cover_bigram || '').trim(),
        cover_trigram: String(value.cover_trigram || '').trim(),
      }),
    );
  } catch {
    // ignore
  }
}

function normalizeRankValue(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return '';
  return String(numeric);
}

function resolveSearchRankingOverrides(raw: SearchRankingOverrides): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const key of Object.keys(DEFAULT_SEARCH_RANKING_OVERRIDES)) {
    const normalized = normalizeRankValue(raw[key as keyof SearchRankingOverrides]);
    if (!normalized) continue;
    resolved[key] = Number(normalized);
  }
  return resolved;
}

function normalizeDaemonBaseUrl(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/g, '');
}

function resolveDaemonBaseUrl(): string {
  const optionValue = options.get('rawCaptureDaemonUrl', '');
  const fromOption = normalizeDaemonBaseUrl(String(optionValue || ''));
  if (fromOption) return fromOption;
  const fromStorage = normalizeDaemonBaseUrl(
    readLocalStorageString(RAW_DAEMON_BASE_URL_STORAGE_KEY) || '',
  );
  if (fromStorage) return fromStorage;
  return 'http://127.0.0.1:8754';
}

function appendOperator(query: string, operator: string): string {
  const base = String(query || '').trim();
  const next = String(operator || '').trim();
  if (!next) return base;
  if (!base) return next;
  return `${base} ${next}`;
}

function makeSearchId(): string {
  return `saved-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function computeTopFacets(rows: RecorderSearchRow[]) {
  const makeCounts = (values: string[]): FacetCount[] => {
    const counter = new Map<string, number>();
    for (const value of values) {
      const normalized = String(value || '').trim();
      if (!normalized) continue;
      counter.set(normalized, (counter.get(normalized) || 0) + 1);
    }
    return [...counter.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 6)
      .map(([value, count]) => ({ value, count }));
  };

  return {
    authors: makeCounts(rows.map((row) => row.author_screen_name || '')),
    routes: makeCounts(rows.map((row) => row.route_type || '')),
    folders: makeCounts(rows.map((row) => row.bookmark_folder_id || '')),
  };
}

type StructuredSearchFilters = {
  fromUser: string;
  toUser: string;
  folderIdOrName: string;
  sourceContains: string;
  cardName: string;
  bookmarkedOnly: boolean;
  likedOnly: boolean;
  mediaOnly: boolean;
  repliesOnly: boolean;
  excludeRetweets: boolean;
  verifiedOnly: boolean;
  blueVerifiedOnly: boolean;
};

function buildStructuredSearchQuery(baseQuery: string, filters: StructuredSearchFilters): string {
  const tokens: string[] = [];
  const normalizedBase = String(baseQuery || '').trim();
  if (normalizedBase) tokens.push(normalizedBase);
  if (filters.fromUser.trim()) tokens.push(`from:${filters.fromUser.trim().replace(/^@+/, '')}`);
  if (filters.toUser.trim()) tokens.push(`to:${filters.toUser.trim().replace(/^@+/, '')}`);
  if (filters.folderIdOrName.trim())
    tokens.push(`bookmark_folder:${filters.folderIdOrName.trim()}`);
  if (filters.sourceContains.trim()) tokens.push(`source:${filters.sourceContains.trim()}`);
  if (filters.cardName.trim()) tokens.push(`card_name:${filters.cardName.trim()}`);
  if (filters.bookmarkedOnly) tokens.push('is:bookmarked');
  if (filters.likedOnly) tokens.push('is:liked');
  if (filters.mediaOnly) tokens.push('filter:media');
  if (filters.repliesOnly) tokens.push('filter:replies');
  if (filters.excludeRetweets) tokens.push('-filter:retweets');
  if (filters.verifiedOnly) tokens.push('filter:verified');
  if (filters.blueVerifiedOnly) tokens.push('filter:blue_verified');
  return tokens.join(' ').trim();
}

const SEARCH_OPERATOR_CHIPS = [
  'filter:replies',
  '-filter:replies',
  'filter:media',
  '-filter:retweets',
  'id:',
  'from_id:',
  'in_reply_to_id:',
  'domain:x.com',
  'is:bookmarked',
  'is:liked',
  'filter:verified',
  'filter:blue_verified',
  'source:iphone',
  'card_name:summary_large_image',
  'min_faves:100',
  'lang:en',
  'since:2026-01-01',
  'until:2026-12-31',
  'OR',
];

const SEARCH_OPERATOR_AUTOCOMPLETE = [
  'AND',
  'OR',
  'NOT',
  'from:',
  'from_id:',
  'author_id:',
  'to:',
  'to_id:',
  'in_reply_to_id:',
  'id:',
  'lang:',
  'route:',
  'bookmark_folder:',
  'conversation_id:',
  'source:',
  'card_name:',
  'url:',
  'domain:',
  'filter:replies',
  'filter:retweets',
  '-filter:retweets',
  'filter:media',
  'filter:links',
  'filter:verified',
  'filter:blue_verified',
  'is:bookmarked',
  'is:liked',
  'is:verified',
  'is:blue_verified',
  'has:links',
  'has:hashtags',
  'has:mentions',
  'has:cashtags',
  'min_faves:',
  'min_likes:',
  'min_retweets:',
  'min_replies:',
  'min_bookmarks:',
  'since:',
  'until:',
];

const SEARCH_EXPORT_SCHEMA_VERSION = 'search.export.v1';

function extractAutocompleteSeed(query: string): string {
  const value = String(query || '');
  if (!value.trim()) return '';
  const parts = value.split(/\s+/g);
  return String(parts[parts.length - 1] || '').trim();
}

function applyAutocompleteSuggestion(query: string, suggestion: string): string {
  const next = String(suggestion || '').trim();
  if (!next) return String(query || '');
  const source = String(query || '');
  if (!source.trim()) return next;
  if (/\s$/.test(source)) return `${source}${next}`;
  const replaced = source.replace(/\S+$/, next);
  return replaced.trim();
}

function computeAutocompleteSuggestions(query: string): string[] {
  const seed = extractAutocompleteSeed(query).toLowerCase();
  if (!seed) return SEARCH_OPERATOR_AUTOCOMPLETE.slice(0, 10);
  return SEARCH_OPERATOR_AUTOCOMPLETE.filter(
    (value) => value.toLowerCase().startsWith(seed) || value.toLowerCase().includes(seed),
  ).slice(0, 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMatchedText(text: string, terms: string[]) {
  const source = String(text || '');
  const normalizedTerms = [
    ...new Set(
      terms.map((term) =>
        String(term || '')
          .trim()
          .toLowerCase(),
      ),
    ),
  ]
    .filter((term) => term.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 24);
  if (!source || !normalizedTerms.length) return <Fragment>{source}</Fragment>;

  const pattern = new RegExp(
    `(${normalizedTerms.map((term) => escapeRegExp(term)).join('|')})`,
    'ig',
  );
  const chunks = source.split(pattern);
  return (
    <Fragment>
      {chunks.map((chunk, index) => {
        const lower = chunk.toLowerCase();
        const matched = normalizedTerms.includes(lower);
        if (!matched) return <Fragment key={`txt-${index}`}>{chunk}</Fragment>;
        return (
          <mark key={`hl-${index}`} class="bg-warning/30 px-[1px] rounded-[2px]">
            {chunk}
          </mark>
        );
      })}
    </Fragment>
  );
}

function buildRowNarrowingOperators(row: RecorderSearchRow): string[] {
  const out: string[] = [];
  if (row.author_screen_name) out.push(`from:${row.author_screen_name}`);
  if (row.route_type) out.push(`route:${row.route_type}`);
  if (row.bookmark_folder_id) out.push(`bookmark_folder:${row.bookmark_folder_id}`);
  if (row.has_media) out.push('filter:media');
  if (row.has_links) out.push('has:links');
  if (row.bookmarked) out.push('is:bookmarked');
  if (row.favorited) out.push('is:liked');
  if (row.author_verified) out.push('is:verified');
  if (row.author_blue_verified) out.push('is:blue_verified');
  return [...new Set(out)].slice(0, 8);
}

function buildSearchExportBlob(args: {
  daemonBaseUrl: string;
  effectiveQuery: string;
  payload: RecorderSearchPayload;
  sort: RecorderSearchSort;
  limit: number;
  offset: number;
  ranking: Record<string, number>;
}) {
  const now = Date.now();
  return {
    schema_version: SEARCH_EXPORT_SCHEMA_VERSION,
    generated_at_ms: now,
    generated_at_iso: new Date(now).toISOString(),
    producer: {
      name: 'twitter-web-exporter.local-search',
      version: '1',
    },
    source: {
      daemon_base_url: args.daemonBaseUrl,
      page_url: typeof location !== 'undefined' ? location.href : '',
    },
    request: {
      query: args.effectiveQuery,
      sort: args.sort,
      limit: args.limit,
      offset: args.offset,
      ranking: args.ranking,
    },
    response: args.payload,
  };
}

export function RawRecorderSearchPanel() {
  const [daemonBaseUrl, setDaemonBaseUrl] = useState<string>(() => resolveDaemonBaseUrl());
  const [query, setQuery] = useState<string>(
    () => readLocalStorageString(RAW_SEARCH_QUERY_STORAGE_KEY) || '',
  );
  const [sort, setSort] = useState<RecorderSearchSort>(() => {
    const candidate = readLocalStorageString(RAW_SEARCH_SORT_STORAGE_KEY);
    if (candidate === 'newest' || candidate === 'oldest' || candidate === 'relevance') {
      return candidate;
    }
    return 'relevance';
  });
  const [limit, setLimit] = useState<number>(() => {
    const candidate = Number(readLocalStorageString(RAW_SEARCH_LIMIT_STORAGE_KEY) || '50');
    if (Number.isFinite(candidate) && candidate > 0 && candidate <= 500)
      return Math.floor(candidate);
    return 50;
  });
  const [offset, setOffset] = useState<number>(0);
  const [savedSearches, setSavedSearches] = useState<SavedSearchEntry[]>(() => readSavedSearches());
  const [saveName, setSaveName] = useState('');
  const [selectedSavedId, setSelectedSavedId] = useState('');
  const [fromUser, setFromUser] = useState('');
  const [toUser, setToUser] = useState('');
  const [folderIdOrName, setFolderIdOrName] = useState('');
  const [sourceContains, setSourceContains] = useState('');
  const [cardName, setCardName] = useState('');
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [likedOnly, setLikedOnly] = useState(false);
  const [mediaOnly, setMediaOnly] = useState(false);
  const [repliesOnly, setRepliesOnly] = useState(false);
  const [excludeRetweets, setExcludeRetweets] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [blueVerifiedOnly, setBlueVerifiedOnly] = useState(false);
  const [rankBm25, setRankBm25] = useState('');
  const [rankLexical, setRankLexical] = useState('');
  const [rankCoverDensity, setRankCoverDensity] = useState('');
  const [rankRecency, setRankRecency] = useState('');
  const [rankTermMatch, setRankTermMatch] = useState('');
  const [rankPhraseMatch, setRankPhraseMatch] = useState('');
  const [rankCoverBigram, setRankCoverBigram] = useState('');
  const [rankCoverTrigram, setRankCoverTrigram] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState<RecorderSearchPayload | null>(null);
  const [lastEffectiveQuery, setLastEffectiveQuery] = useState('');

  useEffect(() => {
    const initial = readSearchRankingOverrides();
    setRankBm25(initial.bm25);
    setRankLexical(initial.lexical);
    setRankCoverDensity(initial.cover_density);
    setRankRecency(initial.recency);
    setRankTermMatch(initial.term_match);
    setRankPhraseMatch(initial.phrase_match);
    setRankCoverBigram(initial.cover_bigram);
    setRankCoverTrigram(initial.cover_trigram);
  }, []);

  useEffect(() => {
    writeLocalStorageString(RAW_SEARCH_QUERY_STORAGE_KEY, query);
  }, [query]);

  useEffect(() => {
    writeLocalStorageString(RAW_SEARCH_SORT_STORAGE_KEY, sort);
  }, [sort]);

  useEffect(() => {
    writeLocalStorageString(RAW_SEARCH_LIMIT_STORAGE_KEY, String(limit));
  }, [limit]);

  useEffect(() => {
    writeSavedSearches(savedSearches);
  }, [savedSearches]);

  useEffect(() => {
    writeSearchRankingOverrides({
      bm25: rankBm25,
      lexical: rankLexical,
      cover_density: rankCoverDensity,
      recency: rankRecency,
      term_match: rankTermMatch,
      phrase_match: rankPhraseMatch,
      cover_bigram: rankCoverBigram,
      cover_trigram: rankCoverTrigram,
    });
  }, [
    rankBm25,
    rankLexical,
    rankCoverDensity,
    rankRecency,
    rankTermMatch,
    rankPhraseMatch,
    rankCoverBigram,
    rankCoverTrigram,
  ]);

  const runSearch = async (nextOffset = offset) => {
    if (busy) return;
    const baseUrl = normalizeDaemonBaseUrl(daemonBaseUrl || resolveDaemonBaseUrl());
    if (!baseUrl) {
      setError('Missing recorder daemon URL.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const effectiveQuery = buildStructuredSearchQuery(query, {
        fromUser,
        toUser,
        folderIdOrName,
        sourceContains,
        cardName,
        bookmarkedOnly,
        likedOnly,
        mediaOnly,
        repliesOnly,
        excludeRetweets,
        verifiedOnly,
        blueVerifiedOnly,
      });
      const params = new URLSearchParams();
      if (effectiveQuery.trim()) params.set('q', effectiveQuery.trim());
      params.set('sort', sort);
      params.set('limit', String(limit));
      params.set('offset', String(Math.max(0, nextOffset)));
      const rankingOverrides = resolveSearchRankingOverrides({
        bm25: rankBm25,
        lexical: rankLexical,
        cover_density: rankCoverDensity,
        recency: rankRecency,
        term_match: rankTermMatch,
        phrase_match: rankPhraseMatch,
        cover_bigram: rankCoverBigram,
        cover_trigram: rankCoverTrigram,
      });
      for (const [key, value] of Object.entries(rankingOverrides)) {
        params.set(`rank_${key}`, String(value));
      }

      const response = await fetch(`${baseUrl}/query/search?${params.toString()}`);
      const parsed = (await response.json()) as {
        ok?: boolean;
        error?: string;
        query?: RecorderSearchPayload;
      };
      if (!response.ok || !parsed?.ok || !parsed.query) {
        throw new Error(parsed?.error || `HTTP ${response.status}`);
      }
      setPayload(parsed.query);
      setOffset(Math.max(0, nextOffset));
      setLastEffectiveQuery(effectiveQuery);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPayload(null);
    } finally {
      setBusy(false);
    }
  };

  const onOpenTweet = (tweetId: string) => {
    const id = String(tweetId || '').trim();
    if (!id) return;
    const url = `https://x.com/i/web/status/${id}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const onPrevPage = () => {
    const next = Math.max(0, offset - limit);
    void runSearch(next);
  };

  const onNextPage = () => {
    const next = offset + limit;
    void runSearch(next);
  };

  const canPageForward = !!payload && offset + limit < payload.total_matches;
  const facets = computeTopFacets(payload?.rows || []);

  const onSaveSearch = () => {
    const effectiveQuery = buildStructuredSearchQuery(query, {
      fromUser,
      toUser,
      folderIdOrName,
      sourceContains,
      cardName,
      bookmarkedOnly,
      likedOnly,
      mediaOnly,
      repliesOnly,
      excludeRetweets,
      verifiedOnly,
      blueVerifiedOnly,
    }).trim();
    if (!effectiveQuery) return;
    const name = saveName.trim() || `Saved ${new Date().toLocaleString()}`;
    setSavedSearches((current) => {
      const next: SavedSearchEntry[] = [
        { id: makeSearchId(), name, query: effectiveQuery },
        ...current.filter((entry) => entry.query !== effectiveQuery),
      ];
      return next.slice(0, 30);
    });
    setSaveName('');
  };

  const onLoadSavedSearch = (id: string) => {
    const found = savedSearches.find((entry) => entry.id === id);
    if (!found) return;
    setQuery(found.query);
    setSelectedSavedId(id);
  };

  const onDeleteSavedSearch = () => {
    const id = selectedSavedId.trim();
    if (!id) return;
    setSavedSearches((current) => current.filter((entry) => entry.id !== id));
    setSelectedSavedId('');
  };

  const onExportSearchBlob = () => {
    if (!payload) return;
    const blob = buildSearchExportBlob({
      daemonBaseUrl: normalizeDaemonBaseUrl(daemonBaseUrl || resolveDaemonBaseUrl()),
      effectiveQuery:
        lastEffectiveQuery ||
        buildStructuredSearchQuery(query, {
          fromUser,
          toUser,
          folderIdOrName,
          sourceContains,
          cardName,
          bookmarkedOnly,
          likedOnly,
          mediaOnly,
          repliesOnly,
          excludeRetweets,
          verifiedOnly,
          blueVerifiedOnly,
        }),
      payload,
      sort,
      limit,
      offset,
      ranking: resolveSearchRankingOverrides({
        bm25: rankBm25,
        lexical: rankLexical,
        cover_density: rankCoverDensity,
        recency: rankRecency,
        term_match: rankTermMatch,
        phrase_match: rankPhraseMatch,
        cover_bigram: rankCoverBigram,
        cover_trigram: rankCoverTrigram,
      }),
    });
    downloadJson(blob, `twe-search-export-${Date.now()}.json`);
  };

  const autocompleteSuggestions = computeAutocompleteSuggestions(query);
  const highlightedTerms = payload?.parsed?.positive_terms || [];

  return (
    <div class="text-[11px] leading-tight bg-base-200 rounded-box-half px-2 py-1.5 mb-1">
      <div class="font-semibold mb-1">Local Recorder Search</div>
      <div class="mb-1">
        <label class="text-[10px] opacity-70">Daemon URL</label>
        <input
          type="text"
          class="input input-bordered input-xs w-full font-mono mt-0.5"
          value={daemonBaseUrl}
          onInput={(event) => {
            const value = (event.target as HTMLInputElement).value;
            setDaemonBaseUrl(value);
            writeLocalStorageString(RAW_DAEMON_BASE_URL_STORAGE_KEY, value);
            options.set('rawCaptureDaemonUrl', value);
          }}
        />
      </div>
      <div class="mb-1">
        <label class="text-[10px] opacity-70">Query (Twitter-style operators)</label>
        <textarea
          class="textarea textarea-bordered w-full min-h-16 mt-0.5 font-mono text-[11px]"
          value={query}
          onInput={(event) => setQuery((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void runSearch(0);
            }
          }}
        />
      </div>
      <div class="flex flex-wrap gap-1 mb-1">
        {autocompleteSuggestions.map((suggestion) => (
          <button
            key={`suggest-${suggestion}`}
            class="btn btn-ghost btn-xs h-5 min-h-0 px-1 font-mono opacity-80"
            onClick={() => setQuery((current) => applyAutocompleteSuggestion(current, suggestion))}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <details class="mb-1">
        <summary class="cursor-pointer text-[10px] opacity-70">operator quick reference</summary>
        <div class="text-[10px] font-mono mt-0.5 opacity-80 leading-tight">
          boolean: `AND` `OR` `NOT` `(...)` | filters: global `AND` semantics
        </div>
        <div class="text-[10px] font-mono opacity-80 leading-tight">
          core: `from:` `from_id:` `to:` `to_id:` `id:` `domain:` `filter:*` `is:*` `has:*` `lang:`
          `since:` `until:`
        </div>
        <div class="text-[10px] font-mono opacity-80 leading-tight">
          ranking params: `rank_bm25` `rank_lexical` `rank_cover_density` `rank_recency`
        </div>
        <div class="text-[10px] font-mono opacity-80 leading-tight">
          phrase/density: `rank_term_match` `rank_phrase_match` `rank_cover_bigram`
          `rank_cover_trigram`
        </div>
      </details>
      <div class="flex flex-wrap gap-1 mb-1">
        {SEARCH_OPERATOR_CHIPS.map((chip) => (
          <button
            key={chip}
            class="btn btn-ghost btn-xs h-5 min-h-0 px-1 font-mono"
            onClick={() => setQuery((current) => appendOperator(current, chip))}
          >
            {chip}
          </button>
        ))}
      </div>
      <div class="flex flex-wrap items-center gap-1 mb-1">
        <select
          class="select select-bordered select-xs flex-1 min-w-44"
          value={selectedSavedId}
          onChange={(event) => onLoadSavedSearch((event.target as HTMLSelectElement).value)}
        >
          <option value="">saved searches</option>
          {savedSearches.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          class="input input-bordered input-xs w-32"
          placeholder="save name"
          value={saveName}
          onInput={(event) => setSaveName((event.target as HTMLInputElement).value)}
        />
        <button class="btn btn-ghost btn-xs" onClick={onSaveSearch}>
          Save
        </button>
        <button
          class="btn btn-ghost btn-xs"
          disabled={!selectedSavedId}
          onClick={onDeleteSavedSearch}
        >
          Delete
        </button>
      </div>
      <div class="grid grid-cols-2 gap-1 mb-1">
        <input
          type="text"
          class="input input-bordered input-xs w-full font-mono"
          placeholder="from user (alice)"
          value={fromUser}
          onInput={(event) => setFromUser((event.target as HTMLInputElement).value)}
        />
        <input
          type="text"
          class="input input-bordered input-xs w-full font-mono"
          placeholder="to user (bob)"
          value={toUser}
          onInput={(event) => setToUser((event.target as HTMLInputElement).value)}
        />
        <input
          type="text"
          class="input input-bordered input-xs w-full font-mono col-span-2"
          placeholder="bookmark folder id/name"
          value={folderIdOrName}
          onInput={(event) => setFolderIdOrName((event.target as HTMLInputElement).value)}
        />
        <input
          type="text"
          class="input input-bordered input-xs w-full font-mono"
          placeholder="source contains (iphone)"
          value={sourceContains}
          onInput={(event) => setSourceContains((event.target as HTMLInputElement).value)}
        />
        <input
          type="text"
          class="input input-bordered input-xs w-full font-mono"
          placeholder="card name (summary_large_image)"
          value={cardName}
          onInput={(event) => setCardName((event.target as HTMLInputElement).value)}
        />
      </div>
      <div class="flex flex-wrap items-center gap-2 mb-1">
        <label class="label cursor-pointer p-0 gap-1">
          <input
            type="checkbox"
            class="checkbox checkbox-xs"
            checked={bookmarkedOnly}
            onChange={(event) => setBookmarkedOnly((event.target as HTMLInputElement).checked)}
          />
          <span class="label-text text-[10px]">bookmarked</span>
        </label>
        <label class="label cursor-pointer p-0 gap-1">
          <input
            type="checkbox"
            class="checkbox checkbox-xs"
            checked={likedOnly}
            onChange={(event) => setLikedOnly((event.target as HTMLInputElement).checked)}
          />
          <span class="label-text text-[10px]">liked</span>
        </label>
        <label class="label cursor-pointer p-0 gap-1">
          <input
            type="checkbox"
            class="checkbox checkbox-xs"
            checked={mediaOnly}
            onChange={(event) => setMediaOnly((event.target as HTMLInputElement).checked)}
          />
          <span class="label-text text-[10px]">media</span>
        </label>
        <label class="label cursor-pointer p-0 gap-1">
          <input
            type="checkbox"
            class="checkbox checkbox-xs"
            checked={repliesOnly}
            onChange={(event) => setRepliesOnly((event.target as HTMLInputElement).checked)}
          />
          <span class="label-text text-[10px]">replies</span>
        </label>
        <label class="label cursor-pointer p-0 gap-1">
          <input
            type="checkbox"
            class="checkbox checkbox-xs"
            checked={excludeRetweets}
            onChange={(event) => setExcludeRetweets((event.target as HTMLInputElement).checked)}
          />
          <span class="label-text text-[10px]">exclude retweets</span>
        </label>
        <label class="label cursor-pointer p-0 gap-1">
          <input
            type="checkbox"
            class="checkbox checkbox-xs"
            checked={verifiedOnly}
            onChange={(event) => setVerifiedOnly((event.target as HTMLInputElement).checked)}
          />
          <span class="label-text text-[10px]">verified</span>
        </label>
        <label class="label cursor-pointer p-0 gap-1">
          <input
            type="checkbox"
            class="checkbox checkbox-xs"
            checked={blueVerifiedOnly}
            onChange={(event) => setBlueVerifiedOnly((event.target as HTMLInputElement).checked)}
          />
          <span class="label-text text-[10px]">blue verified</span>
        </label>
      </div>
      <div class="flex flex-wrap items-center gap-1 mb-1">
        <select
          class="select select-bordered select-xs w-24"
          value={sort}
          onChange={(event) =>
            setSort((event.target as HTMLSelectElement).value as RecorderSearchSort)
          }
        >
          <option value="relevance">relevance</option>
          <option value="newest">newest</option>
          <option value="oldest">oldest</option>
        </select>
        <select
          class="select select-bordered select-xs w-20"
          value={String(limit)}
          onChange={(event) => setLimit(Number((event.target as HTMLSelectElement).value))}
        >
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200">200</option>
        </select>
        <button class="btn btn-primary btn-xs" disabled={busy} onClick={() => void runSearch(0)}>
          {busy ? 'Searching...' : 'Search'}
        </button>
        <button class="btn btn-ghost btn-xs" disabled={!payload} onClick={onExportSearchBlob}>
          Export Blob
        </button>
        <button class="btn btn-ghost btn-xs" disabled={busy} onClick={onPrevPage}>
          Prev
        </button>
        <button
          class="btn btn-ghost btn-xs"
          disabled={busy || !canPageForward}
          onClick={onNextPage}
        >
          Next
        </button>
      </div>
      <details class="mb-1">
        <summary class="cursor-pointer text-[10px] opacity-70">
          ranking overrides (blank = daemon defaults)
        </summary>
        <div class="grid grid-cols-2 gap-1 mt-1">
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            placeholder="bm25"
            value={rankBm25}
            onInput={(event) => setRankBm25((event.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            placeholder="lexical"
            value={rankLexical}
            onInput={(event) => setRankLexical((event.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            placeholder="cover_density"
            value={rankCoverDensity}
            onInput={(event) => setRankCoverDensity((event.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            placeholder="recency"
            value={rankRecency}
            onInput={(event) => setRankRecency((event.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            placeholder="term_match"
            value={rankTermMatch}
            onInput={(event) => setRankTermMatch((event.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            placeholder="phrase_match"
            value={rankPhraseMatch}
            onInput={(event) => setRankPhraseMatch((event.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            placeholder="cover_bigram"
            value={rankCoverBigram}
            onInput={(event) => setRankCoverBigram((event.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            class="input input-bordered input-xs w-full font-mono"
            placeholder="cover_trigram"
            value={rankCoverTrigram}
            onInput={(event) => setRankCoverTrigram((event.target as HTMLInputElement).value)}
          />
        </div>
      </details>
      <div class="text-[10px] opacity-70 mb-1">
        {payload
          ? `rows ${payload.count} / total ${payload.total_matches} (offset ${payload.offset}, sort ${payload.sort})`
          : 'No results yet.'}
      </div>
      {lastEffectiveQuery ? (
        <div class="text-[10px] font-mono opacity-70 mb-1">effective: {lastEffectiveQuery}</div>
      ) : null}
      {payload?.parsed?.lexical_expression ? (
        <div class="text-[10px] font-mono opacity-70 mb-1">
          parse: {payload.parsed.lexical_expression}
          {payload.parsed.filter_boolean_semantics
            ? ` | filters=${payload.parsed.filter_boolean_semantics}`
            : ''}
        </div>
      ) : null}
      {payload?.ranking ? (
        <div class="text-[10px] font-mono opacity-70 mb-1 leading-tight">
          weights bm25={Number(payload.ranking.bm25 || 0).toFixed(2)} lexical=
          {Number(payload.ranking.lexical || 0).toFixed(2)} density=
          {Number(payload.ranking.cover_density || 0).toFixed(2)} recency=
          {Number(payload.ranking.recency || 0).toFixed(2)}
          <br />
          term={Number(payload.ranking.term_match || 0).toFixed(2)} phrase=
          {Number(payload.ranking.phrase_match || 0).toFixed(2)} bigram=
          {Number(payload.ranking.cover_bigram || 0).toFixed(2)} trigram=
          {Number(payload.ranking.cover_trigram || 0).toFixed(2)}
        </div>
      ) : null}
      {error ? <div class="text-error mb-1">search error: {error}</div> : null}
      {payload?.warning_objects?.length ? (
        <div class="text-warning mb-1 space-y-0.5">
          {payload.warning_objects.map((warning, index) => (
            <div key={`warn-${index}`}>
              [{warning.code || 'search_warning'}] {warning.message || 'search warning'}
              {warning.token ? ` (${warning.token})` : ''}
            </div>
          ))}
        </div>
      ) : payload?.warnings?.length ? (
        <div class="text-warning mb-1">warnings: {payload.warnings.join(' | ')}</div>
      ) : null}
      {payload?.rows?.length ? (
        <div class="mb-1">
          <div class="text-[10px] opacity-70 mb-0.5">facets</div>
          <div class="flex flex-wrap gap-1 mb-0.5">
            {facets.authors.map((entry) => (
              <button
                key={`author-${entry.value}`}
                class="btn btn-ghost btn-xs h-5 min-h-0 px-1 font-mono"
                onClick={() =>
                  setQuery((current) => appendOperator(current, `from:${entry.value}`))
                }
              >
                @{entry.value} ({entry.count})
              </button>
            ))}
          </div>
          <div class="flex flex-wrap gap-1 mb-0.5">
            {facets.routes.map((entry) => (
              <button
                key={`route-${entry.value}`}
                class="btn btn-ghost btn-xs h-5 min-h-0 px-1 font-mono"
                onClick={() =>
                  setQuery((current) => appendOperator(current, `route:${entry.value}`))
                }
              >
                route:{entry.value} ({entry.count})
              </button>
            ))}
          </div>
          <div class="flex flex-wrap gap-1">
            {facets.folders.map((entry) => (
              <button
                key={`folder-${entry.value}`}
                class="btn btn-ghost btn-xs h-5 min-h-0 px-1 font-mono"
                onClick={() =>
                  setQuery((current) => appendOperator(current, `bookmark_folder:${entry.value}`))
                }
              >
                folder:{entry.value} ({entry.count})
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div class="max-h-56 overflow-y-auto space-y-1">
        {payload?.rows?.length ? (
          payload.rows.map((row) => (
            <div key={row.entity_id} class="bg-base-100 rounded px-1.5 py-1">
              <div class="flex items-center justify-between gap-1">
                <div class="font-mono text-[10px]">
                  @{row.author_screen_name || 'unknown'} · {row.entity_id} · {row.route_type}
                </div>
                <button
                  class="btn btn-ghost btn-xs h-5 min-h-0 px-1"
                  onClick={() => onOpenTweet(row.entity_id)}
                >
                  Open
                </button>
              </div>
              <div class="text-[11px] whitespace-pre-line break-words">
                {highlightMatchedText(
                  row.text || '[no text available in snapshot]',
                  highlightedTerms,
                )}
              </div>
              <div class="font-mono text-[10px] opacity-70 mt-0.5">
                score={Number(row.score || 0).toFixed(3)} | fav={Number(row.favorite_count || 0)}{' '}
                rt=
                {Number(row.retweet_count || 0)} rep={Number(row.reply_count || 0)} q=
                {Number(row.quote_count || 0)}
                {row.bookmark_folder_id ? ` | folder=${row.bookmark_folder_id}` : ''}
                {row.source_text ? ` | src=${row.source_text}` : ''}
                {row.card_name ? ` | card=${row.card_name}` : ''}
                {row.author_verified ? ' | verified' : ''}
                {row.author_blue_verified ? ' | blue' : ''}
                {row.has_media ? ' | media' : ''}
                {row.has_links ? ' | links' : ''}
                {row.is_reply ? ' | reply' : ''}
                {row.is_retweet ? ' | retweet' : ''}
                {row.is_quote ? ' | quote' : ''}
                {row.bookmarked ? ' | bookmarked' : ''}
                {row.favorited ? ' | liked' : ''}
              </div>
              <div class="flex flex-wrap gap-1 mt-0.5">
                {buildRowNarrowingOperators(row).map((operator) => (
                  <button
                    key={`${row.entity_id}-${operator}`}
                    class="btn btn-ghost btn-xs h-5 min-h-0 px-1 font-mono"
                    onClick={() => setQuery((current) => appendOperator(current, operator))}
                  >
                    {operator}
                  </button>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div class="text-[10px] opacity-70">Run a query to load rows.</div>
        )}
      </div>
    </div>
  );
}

export function RuntimeLogsPanel() {
  return (
    <Fragment>
      <div class="divider mt-0 mb-1"></div>
      <DiagnosticsExport />
      <RawCaptureHealth />
      <Logs lines={logLinesSignal} />
    </Fragment>
  );
}
