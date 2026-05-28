import assert from 'node:assert/strict';
import {
  applyMetadataToRecord,
  buildCustomMetadata,
  getAccessorPathValue,
  normalizeMetadataFields,
} from '@/utils/export-metadata';
import type { DataType } from '@/utils/exporter';

const original = {
  rest_id: 'tweet-1',
  legacy: {
    created_at: 'Thu May 28 12:00:00 +0000 2026',
    full_text: 'hello world',
    lang: 'en',
  },
  core: {
    user_results: {
      result: {
        rest_id: 'user-1',
        legacy: {
          screen_name: 'scrollmark',
          name: 'Scrollmark',
        },
      },
    },
  },
  twe_private_fields: {
    created_at: 1779979200000,
  },
};

assert.equal(getAccessorPathValue(original, 'legacy.full_text'), 'hello world');
assert.equal(getAccessorPathValue(original, 'core.user_results.result.legacy.name'), 'Scrollmark');
assert.equal(getAccessorPathValue(original, 'legacy.missing'), undefined);

assert.deepEqual(normalizeMetadataFields([' legacy.full_text ', '', 'legacy.full_text', 42]), [
  'legacy.full_text',
]);

assert.deepEqual(
  buildCustomMetadata(original, [
    'rest_id',
    'legacy.full_text',
    'core.user_results.result.legacy.screen_name',
    'missing.path',
  ]),
  {
    rest_id: 'tweet-1',
    'legacy.full_text': 'hello world',
    'core.user_results.result.legacy.screen_name': 'scrollmark',
  },
);

const noneRecord: DataType = { id: 'tweet-1' };
applyMetadataToRecord(noneRecord, original, 'none', ['legacy.full_text']);
assert.deepEqual(noneRecord, { id: 'tweet-1' });

const customRecord: DataType = { id: 'tweet-1' };
applyMetadataToRecord(customRecord, original, 'custom', ['legacy.full_text']);
assert.deepEqual(customRecord, {
  id: 'tweet-1',
  metadata: {
    'legacy.full_text': 'hello world',
  },
});

const allRecord: DataType = { id: 'tweet-1' };
applyMetadataToRecord(allRecord, original, 'all', []);
assert.deepEqual(allRecord.metadata, original);
assert.notEqual(allRecord.metadata, original);

console.log('export metadata harness passed');
