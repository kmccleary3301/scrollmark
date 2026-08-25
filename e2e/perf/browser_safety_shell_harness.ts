import { webcrypto } from 'node:crypto';

import {
  assessContinuity,
  createContinuitySentinel,
  readContinuitySentinel,
  type ContinuityCounts,
  type ContinuitySentinel,
} from '../../src/core/durability/browser-safety';
import type { IndexedDbInventory } from '../../src/core/database/inventory';

const globalScope = globalThis as unknown as Record<string, unknown>;
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as Crypto;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const counts = (total: number): ContinuityCounts => ({
  captures: total,
  tweets: total,
  users: 0,
  social_edges: 0,
  search_documents: total,
  total,
});

function inventory(total: number, name = 'twitter-web-exporter_test'): IndexedDbInventory {
  return {
    active_db_name: name,
    enumeration_supported: true,
    databases: [
      {
        name,
        active: true,
        tables: {
          captures: total,
          tweets: total,
          users: 0,
          social_edges: 0,
          search_documents: total,
        },
      },
    ],
  };
}

const previous: ContinuitySentinel = {
  schema_version: 1,
  archive_uuid: null,
  companion_protocol_version: null,
  account_ids: [],
  namespace_ids: [],
  active_db_name: 'twitter-web-exporter_test',
  approximate_counts: counts(100),
  last_acknowledged_durable_seq: null,
  last_verified_backup_at_ms: null,
  updated_at_ms: Date.now(),
  checksum: '0'.repeat(64),
};

const missing = assessContinuity(previous, {
  active_db_name: previous.active_db_name,
  enumeration_supported: true,
  databases: [],
});
assert(missing.phase === 'recovery_required', 'missing active database must block startup');
assert(missing.reason === 'active-database-missing', 'missing database reason must be explicit');

const tiny = assessContinuity(previous, inventory(1));
assert(tiny.phase === 'recovery_required', 'suspiciously tiny cache must block startup');
assert(tiny.reason === 'archive-count-dropped', 'count drop reason must be explicit');

const growth = assessContinuity(previous, inventory(140));
assert(growth.phase === 'healthy', 'normal archive growth must remain healthy');
assert(growth.current_counts.total === 140, 'current inventory count must be reported');

const ambiguous = assessContinuity(null, {
  active_db_name: null,
  enumeration_supported: true,
  databases: [
    { name: 'twitter-web-exporter_a', active: false, tables: {} },
    { name: 'twitter-web-exporter_b', active: false, tables: {} },
  ],
});
assert(ambiguous.phase === 'warning', 'ambiguous account identity must not claim health');
assert(
  ambiguous.reason === 'account-identity-ambiguous',
  'ambiguous identity reason must be explicit',
);

let stored: unknown;
globalScope.GM_getValue = () => stored;
globalScope.GM_setValue = (_key: string, value: unknown) => {
  stored = value;
};
const generated = await createContinuitySentinel(null, inventory(12), counts(12));
globalScope.GM_setValue('ignored', generated);
const validRead = await readContinuitySentinel();
assert(validRead.backend === 'userscript', 'manager storage must be preferred');
assert(
  validRead.valid && validRead.sentinel?.checksum === generated.checksum,
  'checksum must verify',
);

stored = { ...generated, approximate_counts: counts(0) };
const tamperedRead = await readContinuitySentinel();
assert(!tamperedRead.valid && tamperedRead.sentinel === null, 'tampered sentinel must be rejected');

delete globalScope.GM_getValue;
delete globalScope.GM_setValue;
console.log(
  JSON.stringify({
    ok: true,
    checks: ['missing-db', 'tiny-cache', 'healthy-growth', 'ambiguous-identity', 'checksum'],
  }),
);
