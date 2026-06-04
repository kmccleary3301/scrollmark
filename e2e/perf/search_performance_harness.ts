import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  prepareAdvancedTableSearchCorpus,
  runAdvancedTableSearchPrepared,
} from '@/utils/advanced-table-search';

type SyntheticTweet = {
  __typename: 'Tweet';
  rest_id: string;
  __bookmark_folder_id: string;
  __bookmark_folder_name: string;
  legacy: {
    id_str: string;
    full_text: string;
    created_at: string;
    lang: string;
    favorite_count: number;
    retweet_count: number;
    reply_count: number;
    bookmark_count: number;
    entities?: {
      hashtags?: Array<{ text: string }>;
      urls?: Array<{ expanded_url: string; display_url: string; url: string }>;
      media?: Array<{ type: string; media_url_https: string; expanded_url: string }>;
    };
    extended_entities?: {
      media?: Array<{ type: string; media_url_https: string; expanded_url: string }>;
    };
  };
  core: {
    user_results: {
      result: {
        rest_id: string;
        core: {
          screen_name: string;
          name: string;
        };
      };
    };
  };
};

type QueryCase = {
  label: string;
  query: string;
  options?: { bookmarkFolderIds?: string[]; limit?: number };
  expect: (result: { totalMatches: number; topIds: string[] }) => boolean;
};

type QueryMeasurement = {
  label: string;
  query: string;
  options?: QueryCase['options'];
  elapsed_ms: number;
  total_matches: number;
  top_ids: string[];
  ok: boolean;
};

const [, , outPathArg = 'e2e/perf/out/search-performance.json'] = process.argv;
const outPath = path.resolve(outPathArg);

const CORPUS_SIZES = [1000, 10_000, 100_000] as const;
const createdAtValues = Array.from({ length: 240 }, (_, index) =>
  new Date(Date.now() - index * 60_000).toUTCString(),
);
const folders = [
  { id: 'folder-0', name: 'Research Revisit 02' },
  { id: 'folder-1', name: 'Design 02' },
  { id: 'folder-2', name: 'AI Lab Rumors' },
  { id: 'folder-3', name: 'Cool Art' },
];
const topics = [
  'autonomous research agents coordinate durable tool calls and memory',
  'masonry layout performance with image thumbnails and video attachments',
  'portable archive bundle export keeps reproducible research data stable',
  'ParadeDB phrase boosting exact snippet ranking natural language search',
  'browser table virtualization with bounded source windows and folder filters',
];

function makeTweet(index: number): SyntheticTweet {
  const id = String(9_000_000_000_000 + index);
  const folder = folders[index % folders.length] || folders[0];
  const topic = topics[index % topics.length] || topics[0];
  const isDeprecated = index % 101 === 0;
  const hasMedia = index % 7 === 0;
  const marker = `Exact phrase checkpoint ${index % 97}`;
  const deprecatedText = isDeprecated ? ' deprecated legacy branch' : '';
  const fullText = `${topic}. ${marker}. Synthetic row ${index}.${deprecatedText}`;

  return {
    __typename: 'Tweet',
    rest_id: id,
    __bookmark_folder_id: folder.id,
    __bookmark_folder_name: folder.name,
    legacy: {
      id_str: id,
      full_text: fullText,
      created_at: createdAtValues[index % createdAtValues.length] || createdAtValues[0],
      lang: 'en',
      favorite_count: index % 10_000,
      retweet_count: index % 500,
      reply_count: index % 80,
      bookmark_count: index % 120,
      entities: {
        hashtags: [{ text: 'research' }, { text: `topic${index % 9}` }],
        urls: [
          {
            expanded_url: `https://example.com/research/${index % 251}`,
            display_url: `example.com/research/${index % 251}`,
            url: `https://t.co/${index}`,
          },
        ],
        media: hasMedia
          ? [
              {
                type: 'photo',
                media_url_https: `https://pbs.twimg.com/media/search_${index}.jpg`,
                expanded_url: `https://x.com/researcher_${index % 40}/status/${id}/photo/1`,
              },
            ]
          : undefined,
      },
      extended_entities: hasMedia
        ? {
            media: [
              {
                type: 'photo',
                media_url_https: `https://pbs.twimg.com/media/search_${index}.jpg`,
                expanded_url: `https://x.com/researcher_${index % 40}/status/${id}/photo/1`,
              },
            ],
          }
        : undefined,
    },
    core: {
      user_results: {
        result: {
          rest_id: String(1000 + (index % 40)),
          core: {
            screen_name: `researcher_${index % 40}`,
            name: `Researcher ${index % 40}`,
          },
        },
      },
    },
  };
}

function makeCorpus(count: number): SyntheticTweet[] {
  return Array.from({ length: count }, (_, index) => makeTweet(index));
}

function queryCases(): QueryCase[] {
  return [
    {
      label: 'simple-term',
      query: 'autonomous',
      options: { limit: 1000 },
      expect: (result) => result.totalMatches > 0,
    },
    {
      label: 'phrase',
      query: '"exact phrase checkpoint 42"',
      options: { limit: 1000 },
      expect: (result) => result.totalMatches > 0,
    },
    {
      label: 'boolean',
      query: '(autonomous OR masonry) AND NOT deprecated',
      options: { limit: 1000 },
      expect: (result) => result.totalMatches > 0,
    },
    {
      label: 'folder-scoped-option',
      query: 'autonomous',
      options: { bookmarkFolderIds: ['folder-0'], limit: 1000 },
      expect: (result) => result.totalMatches > 0,
    },
    {
      label: 'folder-filter-query',
      query: 'folder:"Research Revisit 02" autonomous',
      options: { limit: 1000 },
      expect: (result) => result.totalMatches > 0,
    },
    {
      label: 'no-match',
      query: 'zzzz_unreachable_scrollmark_search_token_9238',
      options: { limit: 1000 },
      expect: (result) => result.totalMatches === 0,
    },
  ];
}

function measureCorpus(count: number) {
  const rows = makeCorpus(count);
  const prepareStartedAt = performance.now();
  const prepared = prepareAdvancedTableSearchCorpus(rows);
  const prepareMs = performance.now() - prepareStartedAt;

  const queries: QueryMeasurement[] = queryCases().map((queryCase) => {
    const queryStartedAt = performance.now();
    const result = runAdvancedTableSearchPrepared(prepared, queryCase.query, queryCase.options);
    const elapsedMs = performance.now() - queryStartedAt;
    const topIds = result.records
      .slice(0, 10)
      .map((row) => String((row as SyntheticTweet).rest_id || ''));
    const summary = {
      totalMatches: result.totalMatches,
      topIds,
    };
    return {
      label: queryCase.label,
      query: queryCase.query,
      options: queryCase.options,
      elapsed_ms: Number(elapsedMs.toFixed(3)),
      total_matches: result.totalMatches,
      top_ids: topIds,
      ok: queryCase.expect(summary),
    };
  });

  const maxQueryMs = Math.max(...queries.map((entry) => entry.elapsed_ms));
  return {
    records: count,
    prepare_ms: Number(prepareMs.toFixed(3)),
    max_query_ms: Number(maxQueryMs.toFixed(3)),
    queries,
  };
}

const startedAt = performance.now();
const corpora = CORPUS_SIZES.map((count) => measureCorpus(count));
const elapsedMs = performance.now() - startedAt;
const allQueryChecksPass = corpora.every((corpus) => corpus.queries.every((query) => query.ok));
const allMeasurementsFinite = corpora.every(
  (corpus) =>
    Number.isFinite(corpus.prepare_ms) &&
    corpus.prepare_ms >= 0 &&
    corpus.queries.every((query) => Number.isFinite(query.elapsed_ms) && query.elapsed_ms >= 0),
);

const payload = {
  ok: allQueryChecksPass && allMeasurementsFinite,
  generated_at: new Date().toISOString(),
  elapsed_ms: Number(elapsedMs.toFixed(3)),
  corpora,
  gates: {
    records: [...CORPUS_SIZES],
    query_types: queryCases().map((entry) => entry.label),
    latency_budget_note:
      'This harness records prep/query latency and fails on semantic or measurement errors. Browser worker budget gates remain app-level tests.',
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
