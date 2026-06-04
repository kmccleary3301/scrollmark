import fs from 'node:fs';
import path from 'node:path';
import {
  prepareAdvancedTableSearchCorpus,
  runAdvancedTableSearchPrepared,
} from '@/utils/advanced-table-search';

type Row = {
  __typename: 'Tweet';
  rest_id: string;
  __bookmark_folder_id?: string;
  __bookmark_folder_name?: string;
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
      urls?: Array<{ expanded_url?: string; display_url?: string; url?: string }>;
      media?: Array<{ type: string; media_url_https?: string; expanded_url?: string }>;
    };
    extended_entities?: {
      media?: Array<{ type: string; media_url_https?: string; expanded_url?: string }>;
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

type Check = {
  name: string;
  ok: boolean;
  details: Record<string, unknown>;
};

const [, , outPath = 'e2e/perf/out/search-phrase-quality.json'] = process.argv;

function tweet(
  id: string,
  screenName: string,
  text: string,
  createdOffsetMinutes: number,
  engagement = 0,
  extras: Partial<Row> = {},
): Row {
  return {
    __typename: 'Tweet',
    rest_id: id,
    __bookmark_folder_id: extras.__bookmark_folder_id,
    __bookmark_folder_name: extras.__bookmark_folder_name,
    legacy: {
      id_str: id,
      full_text: text,
      created_at: new Date(Date.now() - createdOffsetMinutes * 60_000).toUTCString(),
      lang: 'en',
      favorite_count: engagement,
      retweet_count: engagement,
      reply_count: engagement,
      bookmark_count: engagement,
      entities: extras.legacy?.entities,
      extended_entities: extras.legacy?.extended_entities,
    },
    core: {
      user_results: {
        result: {
          rest_id: `user-${screenName}`,
          core: {
            screen_name: screenName,
            name: screenName,
          },
        },
      },
    },
  };
}

const rows: Row[] = [
  tweet(
    'exact-4',
    'alice',
    'Launch note: portable archive bundle export is stable and ready for researchers.',
    10,
    5,
  ),
  tweet(
    'bag-high-engagement',
    'bob',
    'Archive utilities can export bundles. This portable workflow is unrelated and scattered.',
    1,
    5000,
  ),
  tweet(
    'slop-close',
    'carol',
    'A portable archive research bundle export path with one inserted research token.',
    2,
    50,
  ),
  tweet(
    'quoted-only',
    'dave',
    'This row mentions portable archive but does not contain the longer target phrase.',
    3,
    100,
  ),
  tweet('sama-target', 'sama', 'Agents need durable memory and careful tool orchestration.', 4, 1),
  tweet(
    'not-sama',
    'not_sama',
    'Agents need durable memory and careful tool orchestration.',
    5,
    10000,
  ),
  tweet(
    'boolean-durable',
    'erin',
    'Boolean fixture durable memory checkpoint with clean audit notes.',
    6,
  ),
  tweet(
    'boolean-reliability',
    'frank',
    'Boolean fixture reliability checkpoint with clean audit notes.',
    7,
  ),
  tweet(
    'boolean-deprecated',
    'grace',
    'Boolean fixture durable memory checkpoint with deprecated audit notes.',
    8,
  ),
  tweet('folder-target', 'heidi', 'Folder scoped atlas marker with reproducible notes.', 9, 0, {
    __bookmark_folder_id: 'F100',
    __bookmark_folder_name: 'Research Revisit 02',
  }),
  tweet('folder-other', 'ivan', 'Folder scoped atlas marker with unrelated notes.', 10, 0, {
    __bookmark_folder_id: 'F200',
    __bookmark_folder_name: 'Cool Art',
  }),
  tweet('media-filter', 'judy', 'Media fixture shows a rendered chart and linked writeup.', 11, 0, {
    legacy: {
      extended_entities: {
        media: [
          {
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/media/test.jpg',
            expanded_url: 'https://x.com/judy/status/media-filter/photo/1',
          },
        ],
      },
    } as Row['legacy'],
  }),
];

const prepared = prepareAdvancedTableSearchCorpus(rows);

function idsFor(query: string): string[] {
  return runAdvancedTableSearchPrepared(prepared, query).records.map((row) => row.rest_id);
}

function resultFor(query: string) {
  return runAdvancedTableSearchPrepared(prepared, query);
}

const checks: Check[] = [];

{
  const ids = idsFor('portable archive bundle export');
  checks.push({
    name: 'unquoted exact four-term phrase ranks first',
    ok: ids[0] === 'exact-4',
    details: { query: 'portable archive bundle export', ids: ids.slice(0, 5) },
  });
}

{
  const ids = idsFor('"portable archive bundle export"');
  checks.push({
    name: 'quoted exact phrase enforces exact match',
    ok: ids.length === 1 && ids[0] === 'exact-4',
    details: { query: '"portable archive bundle export"', ids },
  });
}

{
  const ids = idsFor('"portable archive bundle export"~2');
  checks.push({
    name: 'slop phrase admits near phrase after exact phrase',
    ok: ids.includes('slop-close') && ids.indexOf('exact-4') < ids.indexOf('slop-close'),
    details: { query: '"portable archive bundle export"~2', ids },
  });
}

{
  const ids = idsFor('@sama durable memory careful');
  checks.push({
    name: '@handle shorthand enforces author constraint',
    ok: ids.length === 1 && ids[0] === 'sama-target',
    details: { query: '@sama durable memory careful', ids },
  });
}

{
  const ids = idsFor('portable archive bundle export');
  checks.push({
    name: 'bag-of-words high engagement does not beat exact phrase',
    ok: ids.indexOf('exact-4') >= 0 && ids.indexOf('exact-4') < ids.indexOf('bag-high-engagement'),
    details: { query: 'portable archive bundle export', ids: ids.slice(0, 5) },
  });
}

{
  const result = resultFor('(durable OR reliability) AND NOT deprecated');
  const ids = result.records.map((row) => row.rest_id);
  checks.push({
    name: 'boolean operators and NOT exclusions preserve expected matches',
    ok:
      ids.includes('boolean-durable') &&
      ids.includes('boolean-reliability') &&
      !ids.includes('boolean-deprecated') &&
      result.parsed.lexicalExpression.includes('NOT'),
    details: {
      query: '(durable OR reliability) AND NOT deprecated',
      ids,
      lexicalExpression: result.parsed.lexicalExpression,
    },
  });
}

{
  const result = resultFor('folder:"Research Revisit 02" atlas');
  const ids = result.records.map((row) => row.rest_id);
  checks.push({
    name: 'quoted folder-name filter scopes results without becoming free text',
    ok:
      ids.length === 1 &&
      ids[0] === 'folder-target' &&
      result.highlightTerms.includes('atlas') &&
      result.highlightTerms.includes('research') &&
      result.highlightTerms.includes('revisit'),
    details: {
      query: 'folder:"Research Revisit 02" atlas',
      ids,
      highlightTerms: result.highlightTerms,
      lexicalExpression: result.parsed.lexicalExpression,
    },
  });
}

{
  const result = runAdvancedTableSearchPrepared(prepared, 'atlas', {
    bookmarkFolderIds: ['F100'],
  });
  const ids = result.records.map((row) => row.rest_id);
  checks.push({
    name: 'worker-backed folder scope option filters the prepared corpus',
    ok: ids.length === 1 && ids[0] === 'folder-target',
    details: { query: 'atlas', bookmarkFolderIds: ['F100'], ids },
  });
}

{
  const result = resultFor('has:media chart');
  const ids = result.records.map((row) => row.rest_id);
  checks.push({
    name: 'presence filters for media remain compatible with lexical terms',
    ok: ids.length === 1 && ids[0] === 'media-filter' && result.highlightTerms.includes('chart'),
    details: { query: 'has:media chart', ids, highlightTerms: result.highlightTerms },
  });
}

{
  const result = resultFor('since:not-a-date durable');
  checks.push({
    name: 'invalid filters surface warnings without dropping lexical highlights',
    ok:
      result.warningObjects.some((warning) => warning.code === 'invalid_filter_value') &&
      result.warnings.some((message) => message.includes('since:not-a-date')) &&
      result.highlightTerms.includes('durable'),
    details: {
      query: 'since:not-a-date durable',
      warnings: result.warnings,
      warningObjects: result.warningObjects,
      highlightTerms: result.highlightTerms,
    },
  });
}

const payload = {
  ok: checks.every((check) => check.ok),
  checks,
};

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));

if (!payload.ok) {
  process.exit(1);
}
