import {
  ZERO_HASH,
  sha256Hex,
  type Checkpoint,
  type ReconciliationItem,
} from '../../src/core/durability/contracts';
import { IncrementalSha256 } from '../../src/core/durability/incremental-sha256';
import { StateBootstrapManifestHasher } from '../../src/core/durability/reconciliation-manifest';

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const vectors = [
  {
    parts: [''],
    expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    parts: ['a', 'bc'],
    expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
] as const;
for (const vector of vectors) {
  const hasher = new IncrementalSha256();
  for (const part of vector.parts) hasher.update(part);
  requireCondition(hasher.digestHex() === vector.expected, 'incremental SHA-256 vector mismatch');
}

const namespaceId = 'namespace-manifest-harness';
const sourceCheckpoint: Checkpoint = {
  namespace_id: namespaceId,
  archive_seq: 0,
  chain_hash: ZERO_HASH,
  schema_revision: 1,
};
const targetCheckpoint: Checkpoint = {
  namespace_id: namespaceId,
  archive_seq: 2,
  chain_hash: '1'.repeat(64),
  schema_revision: 1,
};
const items = [
  {
    state_key: 'tweet:1',
    archive_seq: 1,
    mutation_id: 'mutation-1',
    mutation: { kind: 'upsert_tweet', tweet: { rest_id: '1', text: 'one' } },
    record_hash: '2'.repeat(64),
    chain_hash: '3'.repeat(64),
  },
  {
    state_key: 'tweet:2',
    archive_seq: 2,
    mutation_id: 'mutation-2',
    mutation: { kind: 'upsert_tweet', tweet: { rest_id: '2', text: 'two' } },
    record_hash: '4'.repeat(64),
    chain_hash: '1'.repeat(64),
  },
] as unknown as ReconciliationItem[];
const incremental = new StateBootstrapManifestHasher(
  namespaceId,
  sourceCheckpoint,
  targetCheckpoint,
);
incremental.add(items.slice(0, 1));
incremental.add(items.slice(1));
const expected = await sha256Hex({
  mode: 'state_bootstrap',
  namespace_id: namespaceId,
  source_checkpoint: sourceCheckpoint,
  target_checkpoint: targetCheckpoint,
  items,
});
requireCondition(incremental.count === items.length, 'manifest item count mismatch');
requireCondition(incremental.digestHex() === expected, 'incremental manifest hash mismatch');

console.log(
  JSON.stringify({
    card_version: 1,
    card_id: 't7-reconciliation-manifest-parity',
    scenario: 'bounded state-bootstrap manifest hashing preserves canonical contract hashes',
    status: 'passed',
    observed: { vector_count: vectors.length, item_count: items.length, manifest_hash: expected },
  }),
);
