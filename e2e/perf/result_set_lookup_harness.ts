import fs from 'node:fs';
import path from 'node:path';
import {
  collectRecordLookupIds,
  createResultSetSnapshot,
  extractStableRecordId,
  RESULT_SET_SNAPSHOT_ID_LIMIT,
  resolveOrderedAvailableRecords,
} from '@/utils/result-set';

const [, , outPathArg = 'e2e/perf/out/result-set-lookup.json'] = process.argv;
const outPath = path.resolve(outPathArg);

const contextualBookmarkRecord = {
  rest_id: '2050000000000000001',
  id_str: '2050000000000000001',
  __bookmark_folder_id: '2011882873050087801',
  __bookmark_folder_name: 'Design 02',
  legacy: {
    id_str: '2050000000000000001',
    full_text: 'Designer-oriented media example with contextual bookmark folder metadata.',
  },
};

const stableId = extractStableRecordId(contextualBookmarkRecord, 0);
const lookupIds = collectRecordLookupIds(contextualBookmarkRecord, 0);
const recordById = new Map(lookupIds.map((id) => [id, contextualBookmarkRecord]));
const bareSearchDocumentId = '2050000000000000001';
const resolved = recordById.get(bareSearchDocumentId);

const folderRecordsById = new Map<string, { id: string }>([
  ['a', { id: 'a' }],
  ['c', { id: 'c' }],
  ['d', { id: 'd' }],
]);
const folderIds = ['a', 'b', 'c', 'd', 'e'];
const folderBeforeAttempt = resolveOrderedAvailableRecords(folderIds, folderRecordsById);
const folderAfterAttemptedHole = resolveOrderedAvailableRecords(
  folderIds,
  folderRecordsById,
  new Set(['b']),
);
const folderAfterLaterAttempt = resolveOrderedAvailableRecords(
  folderIds,
  folderRecordsById,
  new Set(['b', 'e']),
);

const hugeIds = Array.from({ length: 100_000 }, (_, index) => `tweet-${index}`);
const descriptorBackedSnapshot = createResultSetSnapshot({
  queryText: '',
  sort: 'default',
  ids: hugeIds.slice(0, 160),
  idsTruncated: true,
  sourceDescriptor: {
    schema: 'scrollmark.result_source.v1',
    kind: 'folder',
    extensionName: 'BookmarksModule',
    entityType: 'tweet',
    folderIds: ['folder-large'],
    sort: { kind: 'observed_at', direction: 'desc' },
  },
  totalMatches: 100_000,
  warnings: [],
});
const cappedArraySnapshot = createResultSetSnapshot({
  queryText: 'bounded fallback',
  sort: 'default',
  ids: hugeIds,
  totalMatches: hugeIds.length,
  warnings: ['array fallback was capped'],
});

const checks = [
  {
    name: 'stable id preserves bookmark folder context',
    ok: stableId === '2050000000000000001::2011882873050087801',
    details: { stableId },
  },
  {
    name: 'lookup aliases include bare tweet id',
    ok: lookupIds.includes(bareSearchDocumentId),
    details: { lookupIds },
  },
  {
    name: 'bare search-document id resolves contextual hydrated record',
    ok: resolved === contextualBookmarkRecord,
    details: { bareSearchDocumentId, resolved: !!resolved },
  },
  {
    name: 'ordered folder hydration stops before unattempted missing row',
    ok: folderBeforeAttempt.map((record) => record.id).join(',') === 'a',
    details: { visibleIds: folderBeforeAttempt.map((record) => record.id) },
  },
  {
    name: 'ordered folder hydration skips attempted missing hole',
    ok: folderAfterAttemptedHole.map((record) => record.id).join(',') === 'a,c,d',
    details: { visibleIds: folderAfterAttemptedHole.map((record) => record.id) },
  },
  {
    name: 'ordered folder hydration remains deterministic after later missing row is attempted',
    ok: folderAfterLaterAttempt.map((record) => record.id).join(',') === 'a,c,d',
    details: { visibleIds: folderAfterLaterAttempt.map((record) => record.id) },
  },
  {
    name: 'descriptor-backed all-result snapshot stores no visible-window ids',
    ok:
      descriptorBackedSnapshot.ids.length === 0 &&
      descriptorBackedSnapshot.idsTotalCount === 160 &&
      descriptorBackedSnapshot.idsTruncated === true &&
      descriptorBackedSnapshot.sourceDescriptor?.kind === 'folder' &&
      descriptorBackedSnapshot.totalMatches === 100_000,
    details: descriptorBackedSnapshot,
  },
  {
    name: 'array fallback snapshot caps ids before it can clone an unbounded result set',
    ok:
      cappedArraySnapshot.ids.length === RESULT_SET_SNAPSHOT_ID_LIMIT &&
      cappedArraySnapshot.idsTotalCount === hugeIds.length &&
      cappedArraySnapshot.idsTruncated === true &&
      JSON.stringify(cappedArraySnapshot).length < 200_000,
    details: {
      idLimit: RESULT_SET_SNAPSHOT_ID_LIMIT,
      idsLength: cappedArraySnapshot.ids.length,
      idsTotalCount: cappedArraySnapshot.idsTotalCount,
      jsonBytes: Buffer.byteLength(JSON.stringify(cappedArraySnapshot)),
    },
  },
];

const payload = {
  ok: checks.every((check) => check.ok),
  checks,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
