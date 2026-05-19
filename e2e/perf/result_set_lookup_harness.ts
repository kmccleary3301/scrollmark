import fs from 'node:fs';
import path from 'node:path';
import {
  collectRecordLookupIds,
  extractStableRecordId,
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
];

const payload = {
  ok: checks.every((check) => check.ok),
  checks,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
