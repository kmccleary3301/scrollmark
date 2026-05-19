import { parseTwitterDateTime } from '@/utils/common';
import { SEARCH_FUZZY, SEARCH_PREFIX } from '@/contracts/search-contract';
import {
  ParsedSearchQuery,
  SearchLexicalNode,
  SearchLexicalToken,
  SearchQueryFilter,
  SearchQueryWarning,
  parseSearchQuery,
} from '@/utils/search-query';

type SearchOperator = {
  key: string;
  value: string;
  negated: boolean;
};

type SearchTermToken = {
  value: string;
  boost: number;
};

type SearchPhrase = {
  text: string;
  tokens: string[];
  slop: number;
  boost: number;
};

type SearchClause = {
  terms: SearchTermToken[];
  phrases: SearchPhrase[];
};

type SearchPlan = {
  clauses: SearchClause[];
  operators: SearchOperator[];
  negativeTerms: string[];
  negativePhrases: SearchPhrase[];
  highlightTerms: string[];
  orderedTerms: string[];
  hasPositiveLexical: boolean;
};

type SearchDoc<T> = {
  raw: T;
  id: string;
  text: string;
  primaryText: string;
  quotedText: string;
  tokens: string[];
  primaryTokens: string[];
  quotedTokens: string[];
  tokenFreq: Map<string, number>;
  primaryTokenFreq: Map<string, number>;
  quotedTokenFreq: Map<string, number>;
  createdAtMs: number;
  authorScreenName: string;
  authorId: string;
  toUser: string;
  toUserId: string;
  inReplyToId: string;
  conversationId: string;
  lang: string;
  routeType: string;
  sourceText: string;
  cardName: string;
  bookmarkFolderId: string;
  bookmarkFolderName: string;
  mentions: string[];
  hashtags: string[];
  cashtags: string[];
  urls: string[];
  domains: string[];
  favoriteCount: number;
  retweetCount: number;
  replyCount: number;
  bookmarkCount: number;
  favorited: boolean;
  retweeted: boolean;
  bookmarked: boolean;
  hasMedia: boolean;
  hasImages: boolean;
  hasVideo: boolean;
  hasLinks: boolean;
  isReply: boolean;
  isRetweet: boolean;
  isQuote: boolean;
  isVerified: boolean;
  isBlueVerified: boolean;
  fieldSearchCache: Map<string, FieldSearchData>;
};

type FieldSearchData = {
  text: string;
  tokens: string[];
  tokenFreq: Map<string, number>;
};

export type PreparedAdvancedTableSearchCorpus<T> = {
  records: T[];
  docs: SearchDoc<T>[];
  rankingContext: RankingContext;
  indexes: SearchCorpusIndexes;
};

export type AdvancedTableSearchResult<T> = {
  records: T[];
  highlightTerms: string[];
  totalMatches: number;
  warnings: string[];
  warningObjects: SearchQueryWarning[];
  parsed: {
    query: string;
    lexicalExpression: string;
    filterBooleanSemantics: 'global_and';
  };
};

type AdvancedTableSearchOptions = {
  bookmarkFolderIds?: string[];
  limit?: number;
};

type RankingContext = {
  docCount: number;
  avgDocLength: number;
  termDocFreq: Map<string, number>;
};

type SearchCorpusIndexes = {
  tokenDocs: Map<string, number[]>;
  exactFilterDocs: Map<string, number[]>;
  tokenVocabulary: string[];
};

type RankingValues = {
  bm25: number;
  lexical: number;
  cover_density: number;
  recency: number;
  term_match: number;
  phrase_match: number;
  quoted_phrase_match: number;
  cover_bigram: number;
  cover_trigram: number;
};

type ScoredMatch<T> = {
  doc: SearchDoc<T>;
  score: number;
  weightedBm25: number;
  weightedLexical: number;
  weightedDensity: number;
  exactPhraseTerms: number;
  exactQuotedPhraseTerms: number;
  exactPrimaryPhraseTerms: number;
  exactPrimaryQuotedPhraseTerms: number;
};

const TERM_TOKEN_PATTERN = /[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu;
const QUERY_TOKEN_PATTERN = /"(?:[^"\\]|\\.)*"(?:~\d+)?(?:\^\d+(?:\.\d+)?)?|\(|\)|\S+/g;
const MAX_HIGHLIGHT_TERMS = 32;
const SEARCH_RANKING_DEFAULTS: RankingValues = {
  bm25: 1.0,
  lexical: 1.0,
  cover_density: 1.0,
  recency: 0.0,
  term_match: 1.0,
  phrase_match: 8.0,
  quoted_phrase_match: 256.0,
  cover_bigram: 10.0,
  cover_trigram: 30.0,
};
const SEARCH_RANKING_STORAGE_KEY = 'twe_raw_search_ranking_v1';
const SEARCH_QUERY_PARSE_CACHE_LIMIT = 128;
const SEARCH_PREFIX_MIN_TERM_LENGTH = Math.max(1, Number(SEARCH_PREFIX.min_term_length || 3));
const SEARCH_PREFIX_MAX_EXPANSIONS = Math.max(8, Number(SEARCH_PREFIX.max_expansions || 128));
const SEARCH_FUZZY_MIN_TERM_LENGTH = Math.max(1, Number(SEARCH_FUZZY.min_term_length || 5));
const SEARCH_FUZZY_MAX_EDIT_DISTANCE = Math.max(0, Number(SEARCH_FUZZY.max_edit_distance || 1));
const SEARCH_FUZZY_PREFIX_ROOT_LENGTH = Math.max(1, Number(SEARCH_FUZZY.prefix_root_length || 4));
const SEARCH_FUZZY_MAX_EXPANSIONS = Math.max(8, Number(SEARCH_FUZZY.max_expansions || 64));
const SEARCH_ANCHOR_MIN_TERMS = 3;
const SEARCH_ANCHOR_MAX_TERMS = 4;
const SEARCH_ANCHOR_COMMON_DOC_FRACTION = 0.65;
const SEARCH_ANCHOR_MAX_RELATIVE_DOC_FREQ = 1.5;
const parsedQueryCache = new Map<string, ParsedSearchQuery>();
const searchDocCache = new WeakMap<object, SearchDoc<object>>();

function readPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeTextToken(value: string): string {
  return value.trim().toLowerCase();
}

function tokenizeText(value: string): string[] {
  if (!value) return [];
  const matches = value.toLowerCase().match(TERM_TOKEN_PATTERN);
  return matches ? matches.map((token) => token.replace(/['’]/g, '')).filter(Boolean) : [];
}

function buildTokenFrequency(tokens: string[]): Map<string, number> {
  const tokenFreq = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
  }
  return tokenFreq;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j] ?? 0;
    }
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}

function parseDateToMs(value: string, endOfDay = false): number {
  if (!value) return 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const parsed = Date.parse(`${value}${suffix}`);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSourceText(sourceHtml: string): string {
  if (!sourceHtml) return '';
  return sourceHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUrls(obj: Record<string, unknown>): string[] {
  const out = new Set<string>();

  const collectUrlObjects = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const expanded = asString(row.expanded_url).trim();
      const display = asString(row.display_url).trim();
      const raw = asString(row.url).trim();
      if (expanded) out.add(expanded);
      if (display) out.add(display);
      if (raw) out.add(raw);
    }
  };

  collectUrlObjects(readPath(obj, 'legacy.entities.urls'));
  collectUrlObjects(readPath(obj, 'legacy.entities.media'));
  collectUrlObjects(readPath(obj, 'legacy.entities.description.urls'));
  collectUrlObjects(readPath(obj, 'legacy.entities.url.urls'));

  return [...out];
}

function extractEntityValues(obj: Record<string, unknown>, path: string, key = 'text'): string[] {
  const value = readPath(obj, path);
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const candidate = normalizeTextToken(asString(row[key]).trim());
    if (candidate) {
      out.add(candidate);
    }
  }
  return [...out];
}

function extractMediaTypes(obj: Record<string, unknown>): string[] {
  const media =
    (Array.isArray(readPath(obj, 'legacy.extended_entities.media'))
      ? readPath(obj, 'legacy.extended_entities.media')
      : readPath(obj, 'legacy.entities.media')) || [];
  if (!Array.isArray(media)) return [];

  const out = new Set<string>();
  for (const item of media) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const candidate = normalizeTextToken(asString(row.type).trim());
    if (candidate) {
      out.add(candidate);
    }
  }
  return [...out];
}

function extractArticleBlockTexts(obj: Record<string, unknown>): string[] {
  const blocks = readPath(obj, 'article.article_results.result.content_state.blocks');
  if (!Array.isArray(blocks)) return [];

  const out: string[] = [];
  for (const item of blocks) {
    if (!item || typeof item !== 'object') continue;
    const text = asString((item as Record<string, unknown>).text).trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function extractDomains(urls: string[]): string[] {
  const out = new Set<string>();
  for (const value of urls) {
    try {
      const normalized = value.startsWith('http') ? value : `https://${value}`;
      const domain = new URL(normalized).hostname.replace(/^www\./, '').toLowerCase();
      if (domain) out.add(domain);
    } catch {
      // ignore invalid URL input
    }
  }
  return [...out];
}

function clampBoost(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.05, Math.min(100, parsed));
}

function parseBoostedTerm(rawToken: string): SearchTermToken | null {
  const match = rawToken.match(/^(.*?)(?:\^([0-9]+(?:\.[0-9]+)?))?$/);
  if (!match) return null;
  const token = normalizeTextToken(match[1] || '');
  if (!token) return null;
  const boost = match[2] ? clampBoost(match[2]) : 1.0;
  return { value: token, boost };
}

function parseQuotedPhrase(rawToken: string): SearchPhrase | null {
  const match = rawToken.match(/^"((?:[^"\\]|\\.)*)"(?:~(\d+))?(?:\^([0-9]+(?:\.[0-9]+)?))?$/);
  if (!match) return null;

  const inner = String(match[1] || '')
    .replace(/\\"/g, '"')
    .trim();
  if (!inner) return null;

  const tokens = tokenizeText(inner);
  if (!tokens.length) return null;

  const slop = Math.max(0, Number(match[2] || '0'));
  const boost = match[3] ? clampBoost(match[3]) : 1.0;
  return { text: inner, tokens, slop, boost };
}

export function parseSearchPlan(query: string): SearchPlan {
  const source = String(query || '').trim();
  if (!source) {
    return {
      clauses: [{ terms: [], phrases: [] }],
      operators: [],
      negativeTerms: [],
      negativePhrases: [],
      highlightTerms: [],
      orderedTerms: [],
      hasPositiveLexical: false,
    };
  }

  const rawTokens = source.match(QUERY_TOKEN_PATTERN) || [];
  const operators: SearchOperator[] = [];
  const clauses: SearchClause[] = [{ terms: [], phrases: [] }];
  const negativeTerms = new Set<string>();
  const negativePhrases: SearchPhrase[] = [];
  const highlightTerms = new Set<string>();
  const orderedTerms: string[] = [];
  let negateNext = false;

  const currentClause = () => clauses[clauses.length - 1];

  for (const token of rawTokens) {
    const upper = token.toUpperCase();
    if (upper === 'AND' || token === '(' || token === ')') {
      continue;
    }
    if (upper === 'OR') {
      const clause = currentClause();
      if (clause && (clause.terms.length || clause.phrases.length)) {
        clauses.push({ terms: [], phrases: [] });
      }
      continue;
    }
    if (upper === 'NOT') {
      negateNext = true;
      continue;
    }

    let negated = negateNext;
    negateNext = false;

    let value = token;
    if (value.startsWith('-') && value.length > 1) {
      negated = true;
      value = value.slice(1);
    }

    const phrase = parseQuotedPhrase(value);
    if (phrase) {
      if (negated) {
        negativePhrases.push(phrase);
      } else {
        const clause = currentClause();
        if (!clause) continue;
        clause.phrases.push(phrase);
        orderedTerms.push(...phrase.tokens);
        for (const phraseToken of phrase.tokens) {
          highlightTerms.add(phraseToken);
        }
      }
      continue;
    }

    const operatorIndex = value.indexOf(':');
    if (operatorIndex > 0) {
      const key = normalizeTextToken(value.slice(0, operatorIndex));
      const rawOperatorValue = value.slice(operatorIndex + 1).trim();
      if (key && rawOperatorValue) {
        operators.push({ key, value: rawOperatorValue, negated });
        if (
          !negated &&
          ![
            'since',
            'until',
            'min_faves',
            'min_likes',
            'min_retweets',
            'min_replies',
            'min_bookmarks',
          ].includes(key)
        ) {
          for (const part of tokenizeText(rawOperatorValue)) {
            highlightTerms.add(part);
          }
        }
        continue;
      }
    }

    const boostedTerm = parseBoostedTerm(value);
    if (!boostedTerm) continue;

    if (negated) {
      negativeTerms.add(boostedTerm.value);
    } else {
      const clause = currentClause();
      if (!clause) continue;
      clause.terms.push(boostedTerm);
      orderedTerms.push(boostedTerm.value);
      highlightTerms.add(boostedTerm.value);
    }
  }

  const compactClauses = clauses.filter((clause) => clause.terms.length || clause.phrases.length);
  return {
    clauses: compactClauses.length ? compactClauses : [{ terms: [], phrases: [] }],
    operators,
    negativeTerms: [...negativeTerms],
    negativePhrases,
    highlightTerms: [...highlightTerms].slice(0, MAX_HIGHLIGHT_TERMS),
    orderedTerms,
    hasPositiveLexical: compactClauses.length > 0,
  };
}

function phraseSlop(
  tokens: string[],
  phraseTerms: string[],
  prefixLastTerm = false,
): number | null {
  if (!phraseTerms.length) return 0;

  const first = phraseTerms[0];
  const firstPositions: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === first) firstPositions.push(i);
  }
  if (!firstPositions.length) return null;

  let best: number | null = null;

  for (const startPos of firstPositions) {
    let prev = startPos;
    let ok = true;

    for (let termIndex = 1; termIndex < phraseTerms.length; termIndex += 1) {
      const needle = phraseTerms[termIndex];
      const isLastNeedle = prefixLastTerm && termIndex === phraseTerms.length - 1;
      let nextPos = -1;
      for (let cursor = prev + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if ((isLastNeedle && needle && candidate?.startsWith(needle)) || candidate === needle) {
          nextPos = cursor;
          break;
        }
      }
      if (nextPos < 0) {
        ok = false;
        break;
      }
      prev = nextPos;
    }

    if (!ok) continue;
    const span = prev - startPos;
    const baseSpan = Math.max(0, phraseTerms.length - 1);
    const slop = Math.max(0, span - baseSpan);
    if (best === null || slop < best) best = slop;
  }

  return best;
}

export function phraseMatch(
  tokens: string[],
  phrase: SearchPhrase,
): { matched: boolean; slopUsed: number } {
  const slop = phraseSlop(tokens, phrase.tokens, false);
  if (slop === null) return { matched: false, slopUsed: Number.POSITIVE_INFINITY };
  if (slop > phrase.slop) return { matched: false, slopUsed: slop };
  return { matched: true, slopUsed: slop };
}

function extractSearchDoc<T>(record: T): SearchDoc<T> {
  const obj = (record || {}) as Record<string, unknown>;

  const id =
    asString(readPath(obj, 'rest_id')) ||
    asString(readPath(obj, 'legacy.id_str')) ||
    asString(readPath(obj, 'id_str')) ||
    `${Math.random().toString(36).slice(2)}`;

  const fullText =
    asString(readPath(obj, 'note_tweet.note_tweet_results.result.text')) ||
    [
      asString(readPath(obj, 'article.article_results.result.title')),
      asString(readPath(obj, 'article.article_results.result.preview_text')),
      ...extractArticleBlockTexts(obj),
    ]
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .join('\n\n') ||
    asString(readPath(obj, 'legacy.full_text')) ||
    asString(readPath(obj, 'legacy.text')) ||
    asString(readPath(obj, 'legacy.description'));
  const quotedText =
    asString(
      readPath(obj, 'quoted_status_result.result.note_tweet.note_tweet_results.result.text'),
    ) ||
    asString(readPath(obj, 'quoted_status_result.result.legacy.full_text')) ||
    asString(readPath(obj, 'quoted_status_result.result.legacy.text')) ||
    asString(readPath(obj, 'quoted_status_result.result.article.article_results.result.title')) ||
    asString(
      readPath(obj, 'quoted_status_result.result.article.article_results.result.preview_text'),
    );
  const quotedAuthorScreenName = normalizeTextToken(
    asString(
      readPath(obj, 'quoted_status_result.result.core.user_results.result.core.screen_name'),
    ),
  );
  const quotedAuthorName = asString(
    readPath(obj, 'quoted_status_result.result.core.user_results.result.core.name'),
  );

  const authorScreenName = normalizeTextToken(
    asString(readPath(obj, 'core.user_results.result.core.screen_name')) ||
      asString(readPath(obj, 'core.screen_name')),
  );

  const authorName =
    asString(readPath(obj, 'core.user_results.result.core.name')) ||
    asString(readPath(obj, 'core.name'));

  const authorId =
    asString(readPath(obj, 'core.user_results.result.rest_id')) ||
    asString(readPath(obj, 'rest_id'));

  const createdAtRaw =
    asString(readPath(obj, 'legacy.created_at')) || asString(readPath(obj, 'core.created_at'));
  const createdAtMs = createdAtRaw
    ? Number(parseTwitterDateTime(createdAtRaw) || 0)
    : Number(
        readPath(obj, 'article.article_results.result.metadata.first_published_at_secs') || 0,
      ) * 1000;

  const sourceText = parseSourceText(asString(readPath(obj, 'legacy.source')));

  const cardName = normalizeTextToken(
    asString(readPath(obj, 'card.card_platform.card_name')) ||
      asString(readPath(obj, 'card.name')) ||
      asString(readPath(obj, '__card_name')),
  );

  const bookmarkFolderId = asString(readPath(obj, '__bookmark_folder_id')).trim();
  const bookmarkFolderName = asString(readPath(obj, '__bookmark_folder_name')).trim();

  const urls = extractUrls(obj);
  const domains = extractDomains(urls);
  const mentions = extractEntityValues(obj, 'legacy.entities.user_mentions', 'screen_name');
  const hashtags = extractEntityValues(obj, 'legacy.entities.hashtags');
  const cashtags = extractEntityValues(obj, 'legacy.entities.symbols');
  const mediaTypes = extractMediaTypes(obj);
  const relationshipSubjectScreenNames = flattenFieldValues(
    readPath(obj, 'twe_relationship_fields.subject_screen_names'),
  ).map((value) => normalizeTextToken(value));
  const relationshipSubjectUserIds = flattenFieldValues(
    readPath(obj, 'twe_relationship_fields.subject_user_ids'),
  ).map((value) => String(value).trim());
  const relationshipTypes = flattenFieldValues(
    readPath(obj, 'twe_relationship_fields.relation_types'),
  ).map((value) => normalizeTextToken(value));

  const toUser = normalizeTextToken(asString(readPath(obj, 'legacy.in_reply_to_screen_name')));
  const toUserId = asString(readPath(obj, 'legacy.in_reply_to_user_id_str')).trim();
  const inReplyToId = asString(readPath(obj, 'legacy.in_reply_to_status_id_str')).trim();
  const conversationId =
    asString(readPath(obj, 'legacy.conversation_id_str')) ||
    asString(readPath(obj, 'conversation_id_str'));

  const lang = normalizeTextToken(asString(readPath(obj, 'legacy.lang')));
  const routeType = normalizeTextToken(asString(readPath(obj, '__route_type')));

  const hasMedia = mediaTypes.length > 0;
  const hasImages = mediaTypes.includes('photo');
  const hasVideo = mediaTypes.includes('video') || mediaTypes.includes('animated_gif');
  const hasLinks = urls.length > 0;

  const isRetweet =
    !!readPath(obj, 'legacy.retweeted_status_result') ||
    asString(readPath(obj, 'legacy.full_text')).startsWith('RT @');
  const isQuote = !!readPath(obj, 'quoted_status_result');
  const isReply = !!inReplyToId;

  const isVerified =
    normalizeTextToken(
      asString(readPath(obj, 'core.user_results.result.verification.verified_type')),
    ) === 'verified' ||
    normalizeTextToken(asString(readPath(obj, 'verification.verified_type'))) === 'verified';

  const isBlueVerified =
    toBool(readPath(obj, 'core.user_results.result.is_blue_verified')) ||
    toBool(readPath(obj, 'is_blue_verified'));

  const favorited = toBool(readPath(obj, 'legacy.favorited'));
  const retweeted = toBool(readPath(obj, 'legacy.retweeted'));
  const bookmarked = toBool(readPath(obj, 'legacy.bookmarked'));

  const favoriteCount = toNumber(readPath(obj, 'legacy.favorite_count'));
  const retweetCount = toNumber(readPath(obj, 'legacy.retweet_count'));
  const replyCount = toNumber(readPath(obj, 'legacy.reply_count'));
  const bookmarkCount = toNumber(readPath(obj, 'legacy.bookmark_count'));

  const searchText = [
    fullText,
    quotedText,
    sourceText,
    authorScreenName,
    authorName,
    quotedAuthorScreenName,
    quotedAuthorName,
    toUser,
    bookmarkFolderId,
    bookmarkFolderName,
    cardName,
    ...relationshipSubjectScreenNames,
    ...relationshipSubjectUserIds,
    ...relationshipTypes,
    ...mentions,
    ...hashtags,
    ...cashtags,
    ...urls,
    ...domains,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  const primaryText = [
    fullText,
    sourceText,
    authorScreenName,
    authorName,
    toUser,
    bookmarkFolderId,
    bookmarkFolderName,
    cardName,
    ...relationshipSubjectScreenNames,
    ...relationshipSubjectUserIds,
    ...relationshipTypes,
    ...mentions,
    ...hashtags,
    ...cashtags,
    ...urls,
    ...domains,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  const quoteAuxText = [quotedText, quotedAuthorScreenName, quotedAuthorName]
    .filter(Boolean)
    .join(' ')
    .trim();

  const tokens = tokenizeText(searchText);
  const primaryTokens = tokenizeText(primaryText);
  const quotedTokens = tokenizeText(quoteAuxText);
  const tokenFreq = buildTokenFrequency(tokens);
  const primaryTokenFreq = buildTokenFrequency(primaryTokens);
  const quotedTokenFreq = buildTokenFrequency(quotedTokens);

  return {
    raw: record,
    id,
    text: searchText,
    primaryText,
    quotedText: quoteAuxText,
    tokens,
    primaryTokens,
    quotedTokens,
    tokenFreq,
    primaryTokenFreq,
    quotedTokenFreq,
    createdAtMs,
    authorScreenName,
    authorId,
    toUser,
    toUserId,
    inReplyToId,
    conversationId,
    lang,
    routeType,
    sourceText: normalizeTextToken(sourceText),
    cardName,
    bookmarkFolderId,
    bookmarkFolderName: normalizeTextToken(bookmarkFolderName),
    mentions,
    hashtags,
    cashtags,
    urls: urls.map((value) => value.toLowerCase()),
    domains,
    favoriteCount,
    retweetCount,
    replyCount,
    bookmarkCount,
    favorited,
    retweeted,
    bookmarked,
    hasMedia,
    hasImages,
    hasVideo,
    hasLinks,
    isReply,
    isRetweet,
    isQuote,
    isVerified,
    isBlueVerified,
    fieldSearchCache: new Map<string, FieldSearchData>(),
  };
}

function getCachedSearchDoc<T>(record: T): SearchDoc<T> {
  if (!record || typeof record !== 'object') {
    return extractSearchDoc(record);
  }

  const cached = searchDocCache.get(record as object) as SearchDoc<T> | undefined;
  if (cached) {
    return cached;
  }

  const built = extractSearchDoc(record);
  searchDocCache.set(record as object, built as SearchDoc<object>);
  return built;
}

function flattenFieldValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenFieldValues(item));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      flattenFieldValues(item),
    );
  }
  return [];
}

function resolveFieldValue<T>(doc: SearchDoc<T>, fieldPath: string): unknown {
  switch (fieldPath) {
    case 'text':
      return doc.text;
    case 'id':
      return doc.id;
    case 'author_screen_name':
      return doc.authorScreenName;
    case 'author_id':
      return doc.authorId;
    case 'to_user':
      return doc.toUser;
    case 'to_user_id':
      return doc.toUserId;
    case 'conversation_id':
      return doc.conversationId;
    case 'lang':
      return doc.lang;
    case 'route':
    case 'route_type':
      return doc.routeType;
    case 'source':
    case 'source_text':
      return doc.sourceText;
    case 'card_name':
      return doc.cardName;
    case 'bookmark_folder_id':
      return doc.bookmarkFolderId;
    case 'bookmark_folder_name':
      return doc.bookmarkFolderName;
    case 'subject_screen_names':
      return flattenFieldValues(
        readPath(
          (doc.raw || {}) as Record<string, unknown>,
          'twe_relationship_fields.subject_screen_names',
        ),
      );
    case 'subject_user_ids':
      return flattenFieldValues(
        readPath(
          (doc.raw || {}) as Record<string, unknown>,
          'twe_relationship_fields.subject_user_ids',
        ),
      );
    case 'relation_types':
      return flattenFieldValues(
        readPath(
          (doc.raw || {}) as Record<string, unknown>,
          'twe_relationship_fields.relation_types',
        ),
      );
    case 'mentions':
      return doc.mentions;
    case 'hashtags':
      return doc.hashtags;
    case 'cashtags':
      return doc.cashtags;
    case 'urls':
      return doc.urls;
    case 'domains':
      return doc.domains;
    default:
      return readPath((doc.raw || {}) as Record<string, unknown>, fieldPath);
  }
}

function getFieldSearchData<T>(doc: SearchDoc<T>, fieldPath: string): FieldSearchData {
  const key = String(fieldPath || '').trim();
  if (!key) {
    return {
      text: doc.text,
      tokens: doc.tokens,
      tokenFreq: doc.tokenFreq,
    };
  }
  const cached = doc.fieldSearchCache.get(key);
  if (cached) return cached;

  const values = flattenFieldValues(resolveFieldValue(doc, key));
  const text = values.join(' ').trim();
  const tokens = tokenizeText(text);
  const tokenFreq = new Map<string, number>();
  for (const token of tokens) {
    tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
  }

  const built = { text, tokens, tokenFreq };
  doc.fieldSearchCache.set(key, built);
  return built;
}

function buildRankingContext<T>(docs: SearchDoc<T>[]): RankingContext {
  const termDocFreq = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    totalLength += doc.tokens.length;
    for (const token of doc.tokenFreq.keys()) {
      termDocFreq.set(token, (termDocFreq.get(token) || 0) + 1);
    }
  }

  return {
    docCount: docs.length,
    avgDocLength: docs.length ? totalLength / docs.length : 1,
    termDocFreq,
  };
}

function pushIndexedValue(index: Map<string, number[]>, key: string, docIndex: number) {
  if (!key) return;
  const existing = index.get(key);
  if (existing) {
    existing.push(docIndex);
    return;
  }
  index.set(key, [docIndex]);
}

function buildExactFilterKey(name: string, value: string): string {
  return `${name}:${value}`;
}

function buildSearchCorpusIndexes<T>(docs: SearchDoc<T>[]): SearchCorpusIndexes {
  const tokenDocs = new Map<string, number[]>();
  const exactFilterDocs = new Map<string, number[]>();

  for (let docIndex = 0; docIndex < docs.length; docIndex += 1) {
    const doc = docs[docIndex];
    if (!doc) continue;

    for (const token of doc.tokenFreq.keys()) {
      pushIndexedValue(tokenDocs, token, docIndex);
    }

    pushIndexedValue(exactFilterDocs, buildExactFilterKey('id', doc.id), docIndex);
    pushIndexedValue(exactFilterDocs, buildExactFilterKey('from', doc.authorScreenName), docIndex);
    pushIndexedValue(exactFilterDocs, buildExactFilterKey('from_id', doc.authorId), docIndex);
    pushIndexedValue(exactFilterDocs, buildExactFilterKey('author_id', doc.authorId), docIndex);
    pushIndexedValue(exactFilterDocs, buildExactFilterKey('to', doc.toUser), docIndex);
    pushIndexedValue(exactFilterDocs, buildExactFilterKey('to_id', doc.toUserId), docIndex);
    pushIndexedValue(
      exactFilterDocs,
      buildExactFilterKey('in_reply_to_id', doc.inReplyToId),
      docIndex,
    );
    pushIndexedValue(
      exactFilterDocs,
      buildExactFilterKey('conversation_id', doc.conversationId),
      docIndex,
    );
    pushIndexedValue(exactFilterDocs, buildExactFilterKey('lang', doc.lang), docIndex);
    pushIndexedValue(exactFilterDocs, buildExactFilterKey('route', doc.routeType), docIndex);
    pushIndexedValue(
      exactFilterDocs,
      buildExactFilterKey('bookmark_folder', doc.bookmarkFolderId),
      docIndex,
    );

    for (const value of doc.mentions) {
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('mention', value), docIndex);
    }
    for (const value of doc.hashtags) {
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('hashtag', value), docIndex);
    }
    for (const value of doc.cashtags) {
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('cashtag', value), docIndex);
    }

    if (doc.hasMedia)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'media'), docIndex);
    if (doc.hasImages)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'images'), docIndex);
    if (doc.hasVideo)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'videos'), docIndex);
    if (doc.hasLinks)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'links'), docIndex);
    if (doc.bookmarked)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'bookmarked'), docIndex);
    if (doc.favorited)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'liked'), docIndex);
    if (doc.retweeted)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'retweeted'), docIndex);
    if (doc.isReply)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'reply'), docIndex);
    if (doc.isRetweet)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'retweet'), docIndex);
    if (doc.isQuote)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'quote'), docIndex);
    if (doc.isVerified)
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'verified'), docIndex);
    if (doc.isBlueVerified) {
      pushIndexedValue(exactFilterDocs, buildExactFilterKey('is', 'blue_verified'), docIndex);
    }
  }

  return {
    tokenDocs,
    exactFilterDocs,
    tokenVocabulary: [...tokenDocs.keys()].sort(),
  };
}

function intersectDocSets(current: Set<number> | null, next: Iterable<number>): Set<number> {
  const nextSet = next instanceof Set ? next : new Set(next);
  if (!current) {
    return new Set(nextSet);
  }

  const out = new Set<number>();
  for (const value of current) {
    if (nextSet.has(value)) {
      out.add(value);
    }
  }
  return out;
}

function unionDocSets(groups: Iterable<Iterable<number>>): Set<number> {
  const out = new Set<number>();
  for (const group of groups) {
    for (const value of group) {
      out.add(value);
    }
  }
  return out;
}

function intersectDocArrays(left: readonly number[], right: readonly number[]): number[] {
  if (!left.length || !right.length) return [];
  const smaller = left.length <= right.length ? left : right;
  const larger = left.length <= right.length ? right : left;
  const largerSet = new Set(larger);
  const out: number[] = [];
  for (const value of smaller) {
    if (largerSet.has(value)) {
      out.push(value);
    }
  }
  return out;
}

function buildAdjacentTermAnchorCandidates<T>(
  prepared: PreparedAdvancedTableSearchCorpus<T>,
  parsed: ParsedSearchQuery,
): Set<number> | null {
  const orderedTerms = parsed.orderedTerms.filter(Boolean);
  if (orderedTerms.length < SEARCH_ANCHOR_MIN_TERMS) return null;

  const windowGroups: number[][] = [];
  for (let index = 0; index < orderedTerms.length - 1; index += 1) {
    const leftDocs = prepared.indexes.tokenDocs.get(orderedTerms[index] || '') || [];
    const rightDocs = prepared.indexes.tokenDocs.get(orderedTerms[index + 1] || '') || [];
    const windowDocs = intersectDocArrays(leftDocs, rightDocs);
    if (windowDocs.length) {
      windowGroups.push(windowDocs);
    }
  }

  if (!windowGroups.length) return null;

  const candidateSet = unionDocSets(windowGroups);
  if (!candidateSet.size || candidateSet.size >= prepared.docs.length) {
    return null;
  }

  return candidateSet;
}

function buildRareTermAnchorCandidates<T>(
  prepared: PreparedAdvancedTableSearchCorpus<T>,
  parsed: ParsedSearchQuery,
): Set<number> | null {
  const positiveTerms = parsed.positiveTerms.filter(Boolean);
  if (positiveTerms.length < SEARCH_ANCHOR_MIN_TERMS) return null;

  const docCount = Math.max(1, prepared.rankingContext.docCount);
  const rankedTerms = positiveTerms
    .map((term) => ({
      term,
      docFreq: prepared.rankingContext.termDocFreq.get(term) || 0,
    }))
    .filter((entry) => entry.docFreq > 0)
    .sort((left, right) => {
      if (left.docFreq !== right.docFreq) return left.docFreq - right.docFreq;
      return left.term.localeCompare(right.term);
    });

  if (!rankedTerms.length) return null;

  const nonCommon = rankedTerms.filter(
    (entry) => entry.docFreq / docCount <= SEARCH_ANCHOR_COMMON_DOC_FRACTION,
  );
  const anchorPool = nonCommon.length ? nonCommon : rankedTerms;
  const rarestDocFreq = anchorPool[0]?.docFreq || 0;
  const comparableRarity =
    rarestDocFreq > 0
      ? anchorPool.filter(
          (entry) => entry.docFreq <= rarestDocFreq * SEARCH_ANCHOR_MAX_RELATIVE_DOC_FREQ,
        )
      : anchorPool;
  const anchorTerms = (comparableRarity.length ? comparableRarity : anchorPool).slice(
    0,
    SEARCH_ANCHOR_MAX_TERMS,
  );
  if (!anchorTerms.length) return null;

  const candidateSet = unionDocSets(
    anchorTerms.map((entry) => prepared.indexes.tokenDocs.get(entry.term) || []),
  );

  if (!candidateSet.size || candidateSet.size >= prepared.docs.length) {
    return null;
  }

  return candidateSet;
}

function getPrefixExpandedTerms(
  vocabulary: string[],
  prefix: string,
  maxExpansions: number,
): string[] {
  if (!prefix || prefix.length < SEARCH_PREFIX_MIN_TERM_LENGTH) return [];
  const out: string[] = [];
  for (const candidate of vocabulary) {
    if (!candidate.startsWith(prefix)) continue;
    out.push(candidate);
    if (out.length >= maxExpansions) break;
  }
  return out;
}

function getFuzzyExpandedTerms(
  vocabulary: string[],
  value: string,
  maxExpansions: number,
): string[] {
  if (
    !value ||
    value.length < SEARCH_FUZZY_MIN_TERM_LENGTH ||
    SEARCH_FUZZY_MAX_EDIT_DISTANCE <= 0
  ) {
    return [];
  }
  const prefixRoot = value.slice(0, SEARCH_FUZZY_PREFIX_ROOT_LENGTH);
  const out: string[] = [];
  for (const candidate of vocabulary) {
    if (!candidate.startsWith(prefixRoot)) continue;
    if (Math.abs(candidate.length - value.length) > SEARCH_FUZZY_MAX_EDIT_DISTANCE) continue;
    if (levenshteinDistance(candidate, value) > SEARCH_FUZZY_MAX_EDIT_DISTANCE) continue;
    out.push(candidate);
    if (out.length >= maxExpansions) break;
  }
  return out;
}

function getLexicalTokenCandidateDocs<T>(
  prepared: PreparedAdvancedTableSearchCorpus<T>,
  token: SearchLexicalToken,
): number[] {
  const index = prepared.indexes.tokenDocs;
  const vocabulary = prepared.indexes.tokenVocabulary;
  const terms = tokenizeText(token.value);
  if (!terms.length) return [];

  const candidateTerms = new Set<string>();
  for (let idx = 0; idx < terms.length; idx += 1) {
    const term = terms[idx];
    if (!term) continue;
    candidateTerms.add(term);
    const isLast = idx === terms.length - 1;
    if (!isLast) continue;
    if (token.prefix) {
      for (const expanded of getPrefixExpandedTerms(
        vocabulary,
        term,
        SEARCH_PREFIX_MAX_EXPANSIONS,
      )) {
        candidateTerms.add(expanded);
      }
    }
    if (token.fuzzy) {
      for (const expanded of getFuzzyExpandedTerms(vocabulary, term, SEARCH_FUZZY_MAX_EXPANSIONS)) {
        candidateTerms.add(expanded);
      }
    }
  }

  return [...candidateTerms].flatMap((term) => index.get(term) || []);
}

function getIndexedFilterCandidates<T>(
  prepared: PreparedAdvancedTableSearchCorpus<T>,
  filter: SearchQueryFilter,
): Set<number> | null {
  const rawValue = String(filter.value || '').trim();
  const normalized = normalizeTextToken(rawValue);
  if (!rawValue) return null;

  const exactIndex = prepared.indexes.exactFilterDocs;
  switch (filter.name) {
    case 'from':
    case 'to':
    case 'lang':
    case 'route':
    case 'mention':
    case 'hashtag':
    case 'cashtag':
    case 'id':
      return new Set(exactIndex.get(buildExactFilterKey(filter.name, normalized)) || []);
    case 'from_id':
    case 'author_id':
    case 'to_id':
    case 'in_reply_to_id':
    case 'conversation_id':
      return new Set(exactIndex.get(buildExactFilterKey(filter.name, rawValue)) || []);
    case 'bookmark_folder':
      if (/^\d+$/.test(rawValue)) {
        return new Set(exactIndex.get(buildExactFilterKey('bookmark_folder', rawValue)) || []);
      }
      return null;
    case 'folder':
      if (/^\d+$/.test(rawValue)) {
        return new Set(exactIndex.get(buildExactFilterKey('bookmark_folder', rawValue)) || []);
      }
      return null;
    case 'is':
      return new Set(exactIndex.get(buildExactFilterKey('is', normalized)) || []);
    default:
      return null;
  }
}

function buildIndexedCandidateSet<T>(
  prepared: PreparedAdvancedTableSearchCorpus<T>,
  parsed: ParsedSearchQuery,
  scopedFolderIds: Set<string>,
): Set<number> | null {
  let candidateSet: Set<number> | null = null;

  if (scopedFolderIds.size) {
    const folderCandidates = unionDocSets(
      [...scopedFolderIds].map(
        (folderId) =>
          prepared.indexes.exactFilterDocs.get(buildExactFilterKey('bookmark_folder', folderId)) ||
          [],
      ),
    );
    candidateSet = intersectDocSets(candidateSet, folderCandidates);
  }

  for (const filter of parsed.filters) {
    const indexed = getIndexedFilterCandidates(prepared, filter);
    if (!indexed) continue;

    if (filter.negated) {
      if (!candidateSet) continue;
      for (const value of indexed) {
        candidateSet.delete(value);
      }
      continue;
    }

    candidateSet = intersectDocSets(candidateSet, indexed);
  }

  const anchorCandidates =
    buildAdjacentTermAnchorCandidates(prepared, parsed) ||
    buildRareTermAnchorCandidates(prepared, parsed);
  const lexicalTokens = parsed.positiveLexicalTokens.filter((token) => !token.field);
  const lexicalTermCandidates =
    anchorCandidates ||
    unionDocSets(lexicalTokens.map((token) => getLexicalTokenCandidateDocs(prepared, token)));

  if (lexicalTermCandidates.size) {
    candidateSet = intersectDocSets(candidateSet, lexicalTermCandidates);
  }

  return candidateSet;
}

function resolveRankingFromStorage(): RankingValues {
  const ranking: RankingValues = { ...SEARCH_RANKING_DEFAULTS };
  try {
    if (typeof localStorage === 'undefined') return ranking;
    const raw = localStorage.getItem(SEARCH_RANKING_STORAGE_KEY);
    if (!raw) return ranking;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(SEARCH_RANKING_DEFAULTS) as Array<keyof RankingValues>) {
      const value = Number(parsed[key]);
      if (Number.isFinite(value)) ranking[key] = value;
    }
    return ranking;
  } catch {
    return ranking;
  }
}

function getCachedParsedSearchQuery(query: string): ParsedSearchQuery {
  const normalized = String(query || '').trim();
  const cached = parsedQueryCache.get(normalized);
  if (cached) {
    return cached;
  }

  const parsed = parseSearchQuery(normalized);
  parsedQueryCache.set(normalized, parsed);
  if (parsedQueryCache.size > SEARCH_QUERY_PARSE_CACHE_LIMIT) {
    const oldestKey = parsedQueryCache.keys().next().value;
    if (typeof oldestKey === 'string') {
      parsedQueryCache.delete(oldestKey);
    }
  }
  return parsed;
}

function scoreTermBM25<T>(doc: SearchDoc<T>, term: string, rankingContext: RankingContext): number {
  const tf = doc.tokenFreq.get(term) || 0;
  if (!tf) return 0;

  const df = rankingContext.termDocFreq.get(term) || 0;
  const docCount = Math.max(1, rankingContext.docCount);
  const avgDocLength = Math.max(1, rankingContext.avgDocLength);
  const dl = Math.max(1, doc.tokens.length);

  const k1 = 1.2;
  const b = 0.75;
  const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
  const denom = tf + k1 * (1 - b + (b * dl) / avgDocLength);
  return (idf * (tf * (k1 + 1))) / denom;
}

function buildFilterWarnings(filters: SearchQueryFilter[]): SearchQueryWarning[] {
  const warnings: SearchQueryWarning[] = [];
  const isModes = new Set([
    'bookmarked',
    'liked',
    'retweeted',
    'reply',
    'retweet',
    'quote',
    'media',
    'images',
    'videos',
    'links',
    'verified',
    'blue_verified',
  ]);
  const hasModes = new Set([
    'media',
    'images',
    'videos',
    'links',
    'mentions',
    'hashtags',
    'cashtags',
    'engagement',
    'polls',
  ]);
  const compatibilityModes = new Set([
    'replies',
    'retweets',
    'nativeretweets',
    'quote',
    'media',
    'images',
    'videos',
    'links',
    'mentions',
    'hashtags',
    'verified',
    'blue_verified',
    'twimg',
    'native_video',
    'consumer_video',
    'pro_video',
    'has_engagement',
  ]);

  for (const filter of filters) {
    const token = `${filter.name}:${filter.value}`;
    const value = String(filter.value || '').trim();
    if (!value) continue;

    if (
      ['since', 'until'].includes(filter.name) &&
      !parseDateToMs(value, filter.name === 'until')
    ) {
      warnings.push({
        code: 'invalid_filter_value',
        message: `invalid ${token}`,
        token,
        severity: 'warn',
      });
      continue;
    }

    if (
      [
        'since_time',
        'until_time',
        'since_id',
        'max_id',
        'min_faves',
        'min_likes',
        'min_retweets',
        'min_replies',
        'min_bookmarks',
      ].includes(filter.name) &&
      !Number.isFinite(Number(value))
    ) {
      warnings.push({
        code: 'invalid_filter_value',
        message: `invalid ${token}`,
        token,
        severity: 'warn',
      });
      continue;
    }

    if (filter.name === 'is' && !isModes.has(normalizeTextToken(value))) {
      warnings.push({
        code: 'unsupported_filter',
        message: `unsupported ${token}`,
        token,
        severity: 'warn',
      });
      continue;
    }

    if (filter.name === 'has' && !hasModes.has(normalizeTextToken(value))) {
      warnings.push({
        code: 'unsupported_filter',
        message: `unsupported ${token}`,
        token,
        severity: 'warn',
      });
      continue;
    }

    if (
      ['filter', 'include'].includes(filter.name) &&
      !compatibilityModes.has(normalizeTextToken(value))
    ) {
      warnings.push({
        code: 'unsupported_filter',
        message: `unsupported ${token}`,
        token,
        severity: 'warn',
      });
      continue;
    }
  }

  return warnings;
}

function evaluateFilter<T>(doc: SearchDoc<T>, filter: SearchQueryFilter): boolean {
  const rawValue = String(filter.value || '').trim();
  const value = normalizeTextToken(rawValue);
  if (!rawValue) return true;

  const evaluate = (): boolean => {
    switch (filter.name) {
      case 'from':
        return doc.authorScreenName === value;
      case 'from_id':
      case 'author_id':
        return doc.authorId === rawValue;
      case 'to':
        return doc.toUser === value;
      case 'to_id':
        return doc.toUserId === rawValue;
      case 'in_reply_to_id':
        return doc.inReplyToId === rawValue;
      case 'id':
        return doc.id === rawValue;
      case 'lang':
        return doc.lang === value;
      case 'route':
        return doc.routeType === value;
      case 'conversation_id':
        return doc.conversationId === rawValue;
      case 'bookmark_folder':
      case 'folder':
        if (/^\d+$/.test(rawValue)) {
          return doc.bookmarkFolderId === rawValue;
        }
        return doc.bookmarkFolderName === value || doc.bookmarkFolderName.includes(value);
      case 'mention':
        return doc.mentions.includes(value);
      case 'hashtag':
        return doc.hashtags.includes(value);
      case 'cashtag':
        return doc.cashtags.includes(value);
      case 'source':
        return doc.sourceText.includes(value);
      case 'card_name': {
        const normalizedCard = value.replace(/\s+/g, '_');
        return doc.cardName === normalizedCard || doc.cardName.includes(normalizedCard);
      }
      case 'domain':
        return doc.domains.some((domain) => domain === value || domain.endsWith(`.${value}`));
      case 'url':
        return doc.urls.some((url) => url.includes(value));
      case 'is': {
        if (value === 'bookmarked') return doc.bookmarked;
        if (value === 'liked') return doc.favorited;
        if (value === 'retweeted') return doc.retweeted;
        if (value === 'reply') return doc.isReply;
        if (value === 'retweet') return doc.isRetweet;
        if (value === 'quote') return doc.isQuote;
        if (value === 'media') return doc.hasMedia;
        if (value === 'images') return doc.hasImages;
        if (value === 'videos') return doc.hasVideo;
        if (value === 'links') return doc.hasLinks;
        if (value === 'verified') return doc.isVerified;
        if (value === 'blue_verified') return doc.isBlueVerified;
        return true;
      }
      case 'has': {
        if (value === 'media') return doc.hasMedia;
        if (value === 'images') return doc.hasImages;
        if (value === 'videos') return doc.hasVideo;
        if (value === 'links') return doc.hasLinks;
        if (value === 'mentions') return doc.mentions.length > 0;
        if (value === 'hashtags') return doc.hashtags.length > 0;
        if (value === 'cashtags') return doc.cashtags.length > 0;
        if (value === 'engagement') {
          return doc.favoriteCount + doc.retweetCount + doc.replyCount + doc.bookmarkCount > 0;
        }
        if (value === 'polls') return doc.cardName.includes('poll');
        return true;
      }
      case 'filter':
      case 'include': {
        if (filter.name === 'include' && value === 'nativeretweets' && !filter.negated) return true;
        if (value === 'replies') return doc.isReply;
        if (value === 'retweets') return doc.isRetweet || doc.isQuote;
        if (value === 'nativeretweets') return doc.isRetweet;
        if (value === 'quote') return doc.isQuote;
        if (value === 'media') return doc.hasMedia;
        if (value === 'images') return doc.hasImages;
        if (
          value === 'videos' ||
          value === 'native_video' ||
          value === 'consumer_video' ||
          value === 'pro_video'
        ) {
          return doc.hasVideo;
        }
        if (value === 'links') return doc.hasLinks;
        if (value === 'mentions') return doc.mentions.length > 0;
        if (value === 'hashtags') return doc.hashtags.length > 0;
        if (value === 'verified') return doc.isVerified;
        if (value === 'blue_verified') return doc.isBlueVerified;
        if (value === 'twimg') {
          return doc.urls.some(
            (url) => url.includes('pbs.twimg.com') || url.includes('pic.twitter.com'),
          );
        }
        if (value === 'has_engagement') {
          return doc.favoriteCount + doc.retweetCount + doc.replyCount + doc.bookmarkCount > 0;
        }
        return true;
      }
      case 'since': {
        const minTs = parseDateToMs(rawValue, false);
        if (!minTs || !doc.createdAtMs) return true;
        return doc.createdAtMs >= minTs;
      }
      case 'until': {
        const maxTs = parseDateToMs(rawValue, true);
        if (!maxTs || !doc.createdAtMs) return true;
        return doc.createdAtMs < maxTs;
      }
      case 'since_time': {
        const minTs = Number(rawValue) * 1000;
        if (!Number.isFinite(minTs) || !doc.createdAtMs) return true;
        return doc.createdAtMs >= minTs;
      }
      case 'until_time': {
        const maxTs = Number(rawValue) * 1000;
        if (!Number.isFinite(maxTs) || !doc.createdAtMs) return true;
        return doc.createdAtMs < maxTs;
      }
      case 'since_id':
        return /^\d+$/.test(doc.id) && Number(doc.id) > Number(rawValue);
      case 'max_id':
        return /^\d+$/.test(doc.id) && Number(doc.id) <= Number(rawValue);
      case 'min_faves':
      case 'min_likes':
        return doc.favoriteCount >= Number(rawValue);
      case 'min_retweets':
        return doc.retweetCount >= Number(rawValue);
      case 'min_replies':
        return doc.replyCount >= Number(rawValue);
      case 'min_bookmarks':
        return doc.bookmarkCount >= Number(rawValue);
      default:
        return true;
    }
  };

  const matched = evaluate();
  return filter.negated ? !matched : matched;
}

type TokenMatchResult = {
  matched: boolean;
  slopUsed: number;
  primaryMatched: boolean;
  quotedMatched: boolean;
};

function tokenMatchesTokenSet(
  targetTokens: string[],
  targetFreq: Map<string, number>,
  token: SearchLexicalToken,
): { matched: boolean; slopUsed: number } {
  if (token.kind === 'phrase') {
    const phraseTokens = tokenizeText(token.value);
    const slop = phraseSlop(targetTokens, phraseTokens, !!token.prefix);
    if (slop === null) {
      if (token.fuzzy && phraseTokens.length) {
        const fuzzyLast = phraseTokens[phraseTokens.length - 1];
        const fuzzyPrefix =
          fuzzyLast && fuzzyLast.length >= SEARCH_FUZZY_MIN_TERM_LENGTH
            ? getFuzzyExpandedTerms(
                [...new Set(targetTokens)],
                fuzzyLast,
                SEARCH_FUZZY_MAX_EXPANSIONS,
              )
            : [];
        for (const candidate of fuzzyPrefix) {
          const mutated = [...phraseTokens];
          mutated[mutated.length - 1] = candidate;
          const fuzzySlop = phraseSlop(targetTokens, mutated, false);
          if (fuzzySlop !== null && fuzzySlop <= token.slop) {
            return { matched: true, slopUsed: fuzzySlop };
          }
        }
      }
      return { matched: false, slopUsed: Number.POSITIVE_INFINITY };
    }
    if (slop > token.slop) return { matched: false, slopUsed: slop };
    return { matched: true, slopUsed: slop };
  }

  const normalized = tokenizeText(token.value);
  if (!normalized.length) {
    return { matched: false, slopUsed: Number.POSITIVE_INFINITY };
  }
  if (normalized.length === 1) {
    const first = normalized[0];
    if (!first) {
      return { matched: false, slopUsed: Number.POSITIVE_INFINITY };
    }
    let matched = targetFreq.has(first);
    if (!matched && token.prefix && first.length >= SEARCH_PREFIX_MIN_TERM_LENGTH) {
      matched = [...targetFreq.keys()].some((candidate) => candidate.startsWith(first));
    }
    if (!matched && token.fuzzy && first.length >= SEARCH_FUZZY_MIN_TERM_LENGTH) {
      matched = [...targetFreq.keys()].some(
        (candidate) =>
          candidate.startsWith(first.slice(0, SEARCH_FUZZY_PREFIX_ROOT_LENGTH)) &&
          Math.abs(candidate.length - first.length) <= SEARCH_FUZZY_MAX_EDIT_DISTANCE &&
          levenshteinDistance(candidate, first) <= SEARCH_FUZZY_MAX_EDIT_DISTANCE,
      );
    }
    return { matched, slopUsed: matched ? 0 : Number.POSITIVE_INFINITY };
  }

  const slopUsed = phraseSlop(targetTokens, normalized, !!token.prefix);
  return {
    matched: slopUsed !== null && slopUsed <= 0,
    slopUsed: slopUsed ?? Number.POSITIVE_INFINITY,
  };
}

function tokenMatchesDoc<T>(doc: SearchDoc<T>, token: SearchLexicalToken): TokenMatchResult {
  const fieldSearch = token.field ? getFieldSearchData(doc, token.field) : null;
  if (fieldSearch) {
    const match = tokenMatchesTokenSet(fieldSearch.tokens, fieldSearch.tokenFreq, token);
    return {
      matched: match.matched,
      slopUsed: match.slopUsed,
      primaryMatched: match.matched,
      quotedMatched: false,
    };
  }

  const primary = tokenMatchesTokenSet(doc.primaryTokens, doc.primaryTokenFreq, token);
  const quoted =
    doc.quotedTokens.length > 0
      ? tokenMatchesTokenSet(doc.quotedTokens, doc.quotedTokenFreq, token)
      : { matched: false, slopUsed: Number.POSITIVE_INFINITY };

  if (!primary.matched && !quoted.matched) {
    return {
      matched: false,
      slopUsed: Number.POSITIVE_INFINITY,
      primaryMatched: false,
      quotedMatched: false,
    };
  }

  let slopUsed = Number.POSITIVE_INFINITY;
  if (primary.matched) slopUsed = Math.min(slopUsed, primary.slopUsed);
  if (quoted.matched) slopUsed = Math.min(slopUsed, quoted.slopUsed);

  return {
    matched: true,
    slopUsed,
    primaryMatched: primary.matched,
    quotedMatched: quoted.matched,
  };
}

function tokenScore(
  token: SearchLexicalToken,
  slopUsed: number,
  rankingValues: RankingValues,
  quoteOnly = false,
): number {
  if (token.kind === 'phrase') {
    const base =
      token.quoted && token.slop === 0
        ? rankingValues.quoted_phrase_match
        : rankingValues.phrase_match;
    const scaled = (base * token.boost) / (1 + Math.max(0, slopUsed));
    return quoteOnly ? scaled * 0.2 : scaled;
  }
  const scaled = rankingValues.term_match * token.boost;
  return quoteOnly ? scaled * 0.2 : scaled;
}

function computeExactPhraseTieBreak<T>(
  doc: SearchDoc<T>,
  positiveLexicalTokens: SearchLexicalToken[],
): {
  exactPhraseTerms: number;
  exactQuotedPhraseTerms: number;
  exactPrimaryPhraseTerms: number;
  exactPrimaryQuotedPhraseTerms: number;
} {
  let exactPhraseTerms = 0;
  let exactQuotedPhraseTerms = 0;
  let exactPrimaryPhraseTerms = 0;
  let exactPrimaryQuotedPhraseTerms = 0;
  for (const token of positiveLexicalTokens) {
    if (token.kind !== 'phrase') continue;
    const match = tokenMatchesDoc(doc, token);
    if (!match.matched || match.slopUsed !== 0) continue;
    const phraseTerms = tokenizeText(token.value);
    const termCount = phraseTerms.length;
    if (termCount > exactPhraseTerms) {
      exactPhraseTerms = termCount;
    }
    if (match.primaryMatched && termCount > exactPrimaryPhraseTerms) {
      exactPrimaryPhraseTerms = termCount;
    }
    if (token.quoted && token.slop === 0 && termCount > exactQuotedPhraseTerms) {
      exactQuotedPhraseTerms = termCount;
    }
    if (
      token.quoted &&
      token.slop === 0 &&
      match.primaryMatched &&
      termCount > exactPrimaryQuotedPhraseTerms
    ) {
      exactPrimaryQuotedPhraseTerms = termCount;
    }
  }
  return {
    exactPhraseTerms,
    exactQuotedPhraseTerms,
    exactPrimaryPhraseTerms,
    exactPrimaryQuotedPhraseTerms,
  };
}

function evaluateLexicalAst<T>(
  doc: SearchDoc<T>,
  node: SearchLexicalNode,
  rankingValues: RankingValues,
): { matched: boolean; lexicalRaw: number } {
  if (node.kind === 'term' || node.kind === 'phrase') {
    const match = tokenMatchesDoc(doc, node);
    if (!match.matched) {
      return { matched: false, lexicalRaw: 0 };
    }
    return {
      matched: true,
      lexicalRaw: tokenScore(
        node,
        match.slopUsed,
        rankingValues,
        match.quotedMatched && !match.primaryMatched,
      ),
    };
  }

  if (node.kind !== 'op') {
    return { matched: true, lexicalRaw: 0 };
  }

  if (node.op === 'NOT') {
    const child = evaluateLexicalAst(doc, node.child, rankingValues);
    return { matched: !child.matched, lexicalRaw: 0 };
  }

  if (node.op === 'AND') {
    const left = evaluateLexicalAst(doc, node.left, rankingValues);
    if (!left.matched) return { matched: false, lexicalRaw: 0 };
    const right = evaluateLexicalAst(doc, node.right, rankingValues);
    if (!right.matched) return { matched: false, lexicalRaw: 0 };
    return { matched: true, lexicalRaw: left.lexicalRaw + right.lexicalRaw };
  }

  const left = evaluateLexicalAst(doc, node.left, rankingValues);
  const right = evaluateLexicalAst(doc, node.right, rankingValues);
  if (!left.matched && !right.matched) {
    return { matched: false, lexicalRaw: 0 };
  }
  if (left.matched && right.matched) {
    return { matched: true, lexicalRaw: left.lexicalRaw + right.lexicalRaw };
  }
  return left.matched ? left : right;
}

function computeCoverDensity<T>(
  doc: SearchDoc<T>,
  orderedTerms: string[],
  rankingValues: RankingValues,
): number {
  const terms = orderedTerms.filter(Boolean);
  if (!terms.length) return 0;

  let density = 0;

  if (terms.length >= 2) {
    for (let index = 0; index < terms.length - 1; index += 1) {
      const phraseTerms = terms.slice(index, index + 2);
      const slop = phraseSlop(doc.tokens, phraseTerms);
      if (slop === null || slop > 2) continue;
      density += rankingValues.cover_bigram / (1 + slop);
    }
  }

  if (terms.length >= 3) {
    for (let index = 0; index < terms.length - 2; index += 1) {
      const phraseTerms = terms.slice(index, index + 3);
      const slop = phraseSlop(doc.tokens, phraseTerms);
      if (slop === null || slop > 3) continue;
      density += rankingValues.cover_trigram / (1 + slop);
    }
  }

  return density;
}

function applyBookmarkFolderFilter<T>(records: T[], folderIds: string[]): T[] {
  if (!folderIds.length) return records;
  const wanted = new Set(folderIds.map((value) => String(value || '').trim()).filter(Boolean));
  if (!wanted.size) return records;

  return records.filter((record) => {
    const row = (record || {}) as Record<string, unknown>;
    const folderId = String(readPath(row, '__bookmark_folder_id') || '').trim();
    return folderId ? wanted.has(folderId) : false;
  });
}

export function prepareAdvancedTableSearchCorpus<T>(
  records: T[],
): PreparedAdvancedTableSearchCorpus<T> {
  const docs = records.map((record) => getCachedSearchDoc(record));
  return {
    records,
    docs,
    rankingContext: buildRankingContext(docs),
    indexes: buildSearchCorpusIndexes(docs),
  };
}

export function runAdvancedTableSearchPrepared<T>(
  prepared: PreparedAdvancedTableSearchCorpus<T>,
  query: string,
  options: AdvancedTableSearchOptions = {},
): AdvancedTableSearchResult<T> {
  const normalizedQuery = String(query || '').trim();
  const scopedFolderIds = new Set(
    (options.bookmarkFolderIds || []).map((value) => String(value || '').trim()).filter(Boolean),
  );
  const hasFolderScope = scopedFolderIds.size > 0;

  if (!normalizedQuery) {
    const records = hasFolderScope
      ? prepared.docs
          .filter((doc) => doc.bookmarkFolderId && scopedFolderIds.has(doc.bookmarkFolderId))
          .map((doc) => doc.raw)
      : prepared.records;

    return {
      records,
      highlightTerms: [],
      totalMatches: records.length,
      warnings: [],
      warningObjects: [],
      parsed: {
        query: '',
        lexicalExpression: '',
        filterBooleanSemantics: 'global_and',
      },
    };
  }

  const rankingValues = resolveRankingFromStorage();
  const parsed = getCachedParsedSearchQuery(normalizedQuery);
  const warningObjects = [...parsed.warnings, ...buildFilterWarnings(parsed.filters)];
  const now = Date.now();
  const candidateSet = buildIndexedCandidateSet(prepared, parsed, scopedFolderIds);
  const candidateDocs =
    candidateSet && candidateSet.size < prepared.docs.length
      ? [...candidateSet]
          .sort((a, b) => a - b)
          .map((index) => prepared.docs[index])
          .filter((doc): doc is SearchDoc<T> => !!doc)
      : prepared.docs;

  const matches: ScoredMatch<T>[] = [];

  for (const doc of candidateDocs) {
    if (hasFolderScope && (!doc.bookmarkFolderId || !scopedFolderIds.has(doc.bookmarkFolderId))) {
      continue;
    }

    let filtersOk = true;
    for (const filter of parsed.filters) {
      if (!evaluateFilter(doc, filter)) {
        filtersOk = false;
        break;
      }
    }
    if (!filtersOk) continue;

    let lexicalMatched = !parsed.hasPositiveLexical;
    let lexicalRaw = 0;
    if (parsed.lexicalAst) {
      const lexical = evaluateLexicalAst(doc, parsed.lexicalAst, rankingValues);
      lexicalMatched = lexical.matched;
      lexicalRaw = lexical.lexicalRaw;
    }
    if (!lexicalMatched) continue;

    let bm25Raw = 0;
    for (const term of parsed.positiveTerms) {
      bm25Raw += scoreTermBM25(doc, term, prepared.rankingContext);
    }

    const coverDensityRaw = computeCoverDensity(doc, parsed.orderedTerms, rankingValues);

    const weightedBm25 = bm25Raw * rankingValues.bm25;
    const weightedLexical = lexicalRaw * rankingValues.lexical;
    const weightedDensity = coverDensityRaw * rankingValues.cover_density;
    const recencyBonus =
      (doc.createdAtMs ? doc.createdAtMs / 1e15 : now / 1e15) * rankingValues.recency;
    const phraseTieBreak = computeExactPhraseTieBreak(doc, parsed.positiveLexicalTokens);

    const score = weightedBm25 + weightedLexical + weightedDensity + recencyBonus;
    matches.push({
      doc,
      score,
      weightedBm25,
      weightedLexical,
      weightedDensity,
      exactPhraseTerms: phraseTieBreak.exactPhraseTerms,
      exactQuotedPhraseTerms: phraseTieBreak.exactQuotedPhraseTerms,
      exactPrimaryPhraseTerms: phraseTieBreak.exactPrimaryPhraseTerms,
      exactPrimaryQuotedPhraseTerms: phraseTieBreak.exactPrimaryQuotedPhraseTerms,
    });
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.exactPrimaryQuotedPhraseTerms !== left.exactPrimaryQuotedPhraseTerms) {
      return right.exactPrimaryQuotedPhraseTerms - left.exactPrimaryQuotedPhraseTerms;
    }
    if (right.exactPrimaryPhraseTerms !== left.exactPrimaryPhraseTerms) {
      return right.exactPrimaryPhraseTerms - left.exactPrimaryPhraseTerms;
    }
    if (right.exactQuotedPhraseTerms !== left.exactQuotedPhraseTerms) {
      return right.exactQuotedPhraseTerms - left.exactQuotedPhraseTerms;
    }
    if (right.exactPhraseTerms !== left.exactPhraseTerms) {
      return right.exactPhraseTerms - left.exactPhraseTerms;
    }
    if (right.weightedLexical !== left.weightedLexical)
      return right.weightedLexical - left.weightedLexical;
    if (right.weightedDensity !== left.weightedDensity)
      return right.weightedDensity - left.weightedDensity;
    if (right.doc.createdAtMs !== left.doc.createdAtMs)
      return right.doc.createdAtMs - left.doc.createdAtMs;
    return right.doc.id.localeCompare(left.doc.id);
  });

  const dedupedMatches: ScoredMatch<T>[] = [];
  const seenSearchSignatures = new Set<string>();
  for (const entry of matches) {
    const signature = [
      entry.doc.authorId || entry.doc.authorScreenName || '',
      entry.doc.text.replace(/\s+/g, ' ').trim().toLowerCase(),
    ].join('::');
    if (signature !== '::' && seenSearchSignatures.has(signature)) {
      continue;
    }
    if (signature !== '::') {
      seenSearchSignatures.add(signature);
    }
    dedupedMatches.push(entry);
  }

  const resultLimit = Number(options.limit || 0);
  const resultMatches =
    Number.isFinite(resultLimit) && resultLimit > 0
      ? dedupedMatches.slice(0, Math.max(1, Math.floor(resultLimit)))
      : dedupedMatches;

  return {
    records: resultMatches.map((entry) => entry.doc.raw),
    highlightTerms: parsed.highlightTerms,
    totalMatches: dedupedMatches.length,
    warnings: warningObjects.map((item) => item.message),
    warningObjects,
    parsed: {
      query: parsed.query,
      lexicalExpression: parsed.lexicalExpression,
      filterBooleanSemantics: parsed.filterBooleanSemantics,
    },
  };
}

export function runAdvancedTableSearch<T>(
  records: T[],
  query: string,
  options: AdvancedTableSearchOptions = {},
): AdvancedTableSearchResult<T> {
  const scoped = applyBookmarkFolderFilter(records, options.bookmarkFolderIds || []);
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    return {
      records: scoped,
      highlightTerms: [],
      totalMatches: scoped.length,
      warnings: [],
      warningObjects: [],
      parsed: {
        query: '',
        lexicalExpression: '',
        filterBooleanSemantics: 'global_and',
      },
    };
  }

  return runAdvancedTableSearchPrepared(prepareAdvancedTableSearchCorpus(scoped), normalizedQuery);
}
