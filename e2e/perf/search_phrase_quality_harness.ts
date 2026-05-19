import fs from 'node:fs';
import path from 'node:path';
import {
  prepareAdvancedTableSearchCorpus,
  runAdvancedTableSearchPrepared,
} from '@/utils/advanced-table-search';

type Row = {
  __typename: 'Tweet';
  rest_id: string;
  legacy: {
    id_str: string;
    full_text: string;
    created_at: string;
    lang: string;
    favorite_count: number;
    retweet_count: number;
    reply_count: number;
    bookmark_count: number;
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
): Row {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      full_text: text,
      created_at: new Date(Date.now() - createdOffsetMinutes * 60_000).toUTCString(),
      lang: 'en',
      favorite_count: engagement,
      retweet_count: engagement,
      reply_count: engagement,
      bookmark_count: engagement,
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
];

const prepared = prepareAdvancedTableSearchCorpus(rows);

function idsFor(query: string): string[] {
  return runAdvancedTableSearchPrepared(prepared, query).records.map((row) => row.rest_id);
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
