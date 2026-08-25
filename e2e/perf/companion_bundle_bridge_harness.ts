import fs from 'node:fs';
import path from 'node:path';

import { createCompanionNamespaceBundle } from '../../src/core/bundles/companion-bridge';
import { importBundleZip, type BundleImportDatabase } from '../../src/core/bundles/importer';
import type { ImportedBundle } from '../../src/core/bundles/schema';
import { decodeBundleTextEntry, readBundleZip } from '../../src/core/bundles/zip';
import type { CompanionClientLike } from '../../src/core/durability/companion-client';
import {
  canonicalize,
  recordHash,
  SCHEMA_REVISION,
  SCROLLMARK_PROTOCOL,
  sha256Hex,
  ZERO_HASH,
  type Capabilities,
  type Checkpoint,
  type CommitReceipt,
  type Health,
  type Mutation,
  type ReconciliationDescriptor,
  type ReconciliationItem,
  type ReconciliationPage,
} from '../../src/core/durability/contracts';
import type { PairingContext } from '../../src/core/durability/identity';

const [, , outPathArg = 'e2e/perf/out/companion-bundle-bridge.json'] = process.argv;
const outPath = path.resolve(outPathArg);

const pairing: PairingContext = {
  base_url: 'http://127.0.0.1:8755',
  token: 'bridge-token-never-emitted',
  archive_id: 'archive-bridge-proof',
  namespace_id: 'namespace-bridge-proof',
  client_id: 'client-bridge-proof',
  client_epoch: 'epoch-bridge-proof',
  viewer_id: 'viewer-bridge-proof',
  origin: 'https://x.com',
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function entityMutation(
  kind: 'tweet' | 'user',
  id: string,
  sequence: number,
  payload: Record<string, unknown>,
): Promise<Mutation> {
  const material = {
    mutation_id: `bridge-mutation-${sequence}`,
    client_seq: sequence,
    kind: 'entity_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    target: { namespace_id: pairing.namespace_id, kind, id },
    payload,
    provenance: { source: 'companion-bundle-bridge-harness' },
    observed_at_ms: 1_700_000_000_000 + sequence,
  };
  return { ...material, record_hash: await recordHash(pairing.namespace_id, material) };
}

async function captureMutation(sequence: number): Promise<Mutation> {
  const material = {
    mutation_id: `bridge-mutation-${sequence}`,
    client_seq: sequence,
    kind: 'relationship_upsert' as const,
    schema_revision: SCHEMA_REVISION,
    relationship_kind: 'capture_membership' as const,
    subject: { namespace_id: pairing.namespace_id, kind: 'tweet' as const, id: 'tweet-bridge-1' },
    object: {
      namespace_id: pairing.namespace_id,
      kind: 'folder' as const,
      id: 'capture:bookmarks',
    },
    qualifier: { extension: 'bookmarks' },
    payload: { extension: 'bookmarks' },
    provenance: { source: 'companion-bundle-bridge-harness' },
    observed_at_ms: 1_700_000_000_003,
  };
  return { ...material, record_hash: await recordHash(pairing.namespace_id, material) };
}

async function proofs(mutations: Mutation[]) {
  const targetCheckpoint: Checkpoint = {
    namespace_id: pairing.namespace_id,
    archive_seq: mutations.length,
    chain_hash: await sha256Hex({ mutations: mutations.map((mutation) => mutation.record_hash) }),
    schema_revision: SCHEMA_REVISION,
  };
  const sourceCheckpoint: Checkpoint = {
    namespace_id: pairing.namespace_id,
    archive_seq: 0,
    chain_hash: ZERO_HASH,
    schema_revision: SCHEMA_REVISION,
  };
  const items: ReconciliationItem[] = mutations.map((mutation, index) => ({
    state_key: `state:${index}`,
    archive_seq: index + 1,
    mutation_id: mutation.mutation_id,
    mutation,
    record_hash: mutation.record_hash,
  }));
  const manifestHash = await sha256Hex({
    mode: 'state_bootstrap',
    namespace_id: pairing.namespace_id,
    source_checkpoint: sourceCheckpoint,
    target_checkpoint: targetCheckpoint,
    items,
  });
  const pageMaterial = {
    protocol: SCROLLMARK_PROTOCOL,
    stream_id: 'stream-bridge-proof',
    namespace_id: pairing.namespace_id,
    mode: 'state_bootstrap' as const,
    page_index: 0,
    item_count: items.length,
    byte_count: new TextEncoder().encode(canonicalize(items)).byteLength,
    items,
    target_checkpoint: targetCheckpoint,
    manifest_hash: manifestHash,
    final: true,
  };
  const page: ReconciliationPage = {
    ...pageMaterial,
    page_hash: await sha256Hex(pageMaterial),
  };
  const descriptor: ReconciliationDescriptor = {
    protocol: SCROLLMARK_PROTOCOL,
    stream_id: page.stream_id,
    namespace_id: pairing.namespace_id,
    mode: 'state_bootstrap',
    source_checkpoint: sourceCheckpoint,
    target_checkpoint: targetCheckpoint,
    manifest_hash: manifestHash,
    item_count: items.length,
    page_count: 1,
  };
  return { descriptor, page };
}

class FakeCompanion implements CompanionClientLike {
  constructor(
    private readonly descriptor: ReconciliationDescriptor,
    private readonly page: ReconciliationPage,
  ) {}

  async capabilities(): Promise<Capabilities> {
    return {
      protocol_versions: [SCROLLMARK_PROTOCOL],
      schema_revisions: [SCHEMA_REVISION],
      hash_algorithm: 'sha256-jcs-hex',
      capability_revision: 'bridge-proof',
      limits: {},
      features: { state_bootstrap: true, canonical_bundle_bridge: true, direct_messages: false },
    };
  }

  async health(): Promise<Health> {
    return {
      ready: true,
      archive: { archive_id: pairing.archive_id },
      active_namespace_ids: [pairing.namespace_id],
    };
  }

  async checkpoint(): Promise<Checkpoint> {
    return this.descriptor.target_checkpoint;
  }

  async commit(): Promise<CommitReceipt> {
    throw new Error('bundle bridge is read-only');
  }

  async reconcile(): Promise<ReconciliationDescriptor> {
    return this.descriptor;
  }

  async reconciliationPage(): Promise<ReconciliationPage> {
    return this.page;
  }
}

class CaptureImportDatabase implements BundleImportDatabase {
  bundle: ImportedBundle | null = null;

  async bundlePutImportBatch(args: { bundle: ImportedBundle }): Promise<void> {
    this.bundle = args.bundle;
  }

  async bundleMarkReady(): Promise<void> {}

  async bundleMarkFailed(): Promise<void> {}
}

async function expectRejected(action: () => Promise<unknown>, text: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes(text),
      `unexpected rejection: ${String(error)}`,
    );
    return;
  }
  throw new Error(`expected rejection containing: ${text}`);
}

const tweet = await entityMutation('tweet', 'tweet-bridge-1', 1, {
  __typename: 'Tweet',
  rest_id: 'tweet-bridge-1',
  full_text: 'canonical bridge proof',
});
const user = await entityMutation('user', 'user-bridge-1', 2, {
  __typename: 'User',
  rest_id: 'user-bridge-1',
  screen_name: 'bridge_user',
});
const capture = await captureMutation(3);
const verified = await proofs([tweet, user, capture]);
const bundle = await createCompanionNamespaceBundle({
  pairing,
  client: new FakeCompanion(verified.descriptor, verified.page),
  title: 'Canonical Namespace Proof',
});
assert(bundle.manifest.counts.records === 3, 'typed bundle record count is wrong');
assert(bundle.manifest.counts.tweets === 1, 'tweet projection count is wrong');
assert(bundle.manifest.counts.users === 1, 'user projection count is wrong');
assert(bundle.manifest.counts.captures === 1, 'capture projection count is wrong');

const archive = await readBundleZip(bundle.bytes);
const metadataText = decodeBundleTextEntry(archive.entries, 'metadata/companion-source.json');
assert(!metadataText.includes(pairing.archive_id), 'metadata leaked raw archive identity');
assert(!metadataText.includes(pairing.namespace_id), 'metadata leaked raw namespace identity');
const metadata = JSON.parse(metadataText) as Record<string, unknown>;
assert(metadata.format === 'scrollmark.companion-source.v1', 'companion metadata format is wrong');
assert(
  metadata.canonicalStateManifestHash === verified.descriptor.manifest_hash,
  'metadata is not pinned to canonical state',
);

const importDatabase = new CaptureImportDatabase();
const imported = await importBundleZip(importDatabase, bundle.bytes);
assert(imported.recordsImported === 3, 'bundle import lost companion records');
assert(
  importDatabase.bundle?.companionSource?.checkpoint.archiveSeq === 3,
  'import did not persist companion source status',
);

const tamperedPage = { ...verified.page, page_hash: 'f'.repeat(64) };
await expectRejected(
  () =>
    createCompanionNamespaceBundle({
      pairing,
      client: new FakeCompanion(verified.descriptor, tamperedPage),
      title: 'Tampered Proof',
    }),
  'page hash mismatch',
);

const privateTweet = await entityMutation('tweet', 'tweet-private', 4, {
  rest_id: 'tweet-private',
  conversation_id: 'private-conversation',
});
const privateProof = await proofs([privateTweet]);
await expectRejected(
  () =>
    createCompanionNamespaceBundle({
      pairing,
      client: new FakeCompanion(privateProof.descriptor, privateProof.page),
      title: 'Private Proof',
    }),
  'private-message material',
);

const report = {
  status: 'passed',
  scenario: 'read-only canonical namespace to shared-safe bundle bridge',
  observed: {
    canonical_manifest_verified: true,
    typed_records: bundle.manifest.counts,
    companion_metadata_imported: true,
    raw_archive_identifiers_excluded_from_metadata: true,
    tampered_page_rejected: true,
    private_message_material_rejected: true,
    write_operations: 0,
  },
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
