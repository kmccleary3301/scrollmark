import {
  getDatabaseManager,
  getDurabilityCoordinator,
  resetDatabaseManager,
} from '@/core/database';

import {
  CompanionClient,
  type DestroyChallenge,
  type VerifiedSnapshotSummary,
} from './companion-client';
import { initializeBrowserSafety, type BrowserSafetySnapshot } from './browser-safety';
import { rebuildCanonicalGeneration, type GenerationResult } from './generation';
import { readPairingContext, type PairingContext } from './identity';
import { readMigrationState } from './migration';

export class RecoveryOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryOperationError';
  }
}

type RecoveryContext = {
  pairing: PairingContext;
  client: CompanionClient;
};

function recoveryContext(requireIdentity: boolean): RecoveryContext {
  const pairing = readPairingContext();
  if (!pairing) throw new RecoveryOperationError('Companion pairing is required');
  if (requireIdentity) {
    const assessment = getDurabilityCoordinator().identity.observe();
    if (!assessment.admitted) {
      throw new RecoveryOperationError(`Active identity proof is required: ${assessment.reason}`);
    }
  }
  return { pairing, client: new CompanionClient(pairing) };
}

export async function listVerifiedSnapshots(): Promise<VerifiedSnapshotSummary[]> {
  return recoveryContext(false).client.listSnapshots();
}

export async function createVerifiedSnapshot(encrypted = false): Promise<VerifiedSnapshotSummary> {
  const { client } = recoveryContext(true);
  const snapshot = await client.createSnapshot(encrypted);
  await client.verifySnapshot(snapshot.snapshot_id);
  return snapshot;
}

export async function restoreVerifiedSnapshot(snapshotId: string): Promise<{
  snapshot: VerifiedSnapshotSummary;
  generation: GenerationResult;
  safety: BrowserSafetySnapshot;
}> {
  const { pairing, client } = recoveryContext(true);
  const snapshots = await client.listSnapshots();
  const snapshot = snapshots.find((candidate) => candidate.snapshot_id === snapshotId);
  if (!snapshot)
    throw new RecoveryOperationError('Selected snapshot is not verified and available');
  await client.verifySnapshot(snapshotId);
  await client.restoreSnapshot(snapshotId);
  const generation = await rebuildCanonicalGeneration({ pairing, client });
  resetDatabaseManager();
  const safety = await initializeBrowserSafety({ force: true, acknowledgeCacheReset: true });
  if (safety.phase === 'recovery_required') {
    throw new RecoveryOperationError(
      `Restored browser projection failed safety checks: ${safety.reason}`,
    );
  }
  return { snapshot, generation, safety };
}

export async function preflightDurableDestroy(options: {
  pendingAcknowledged: boolean;
  explicitLossAcknowledgement: boolean;
}): Promise<DestroyChallenge> {
  const { pairing, client } = recoveryContext(true);
  if (readMigrationState()) {
    throw new RecoveryOperationError('Durable destruction is blocked while migration state exists');
  }
  const coordinator = getDurabilityCoordinator();
  const [usage, health] = await Promise.all([coordinator.outbox.usage(), client.health()]);
  const namespaceIds = Array.isArray(health.active_namespace_ids)
    ? health.active_namespace_ids
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .sort()
    : [];
  if (!namespaceIds.includes(pairing.namespace_id)) {
    throw new RecoveryOperationError('Paired namespace is not active in the canonical archive');
  }
  return client.destroyPreflight({
    archive_id: pairing.archive_id,
    namespace_ids: namespaceIds,
    migration_active: false,
    pending_count: usage.pending_mutations,
    pending_acknowledged: options.pendingAcknowledged,
    explicit_loss_acknowledgement: options.explicitLossAcknowledgement,
  });
}

export async function confirmDurableDestroy(
  challenge: DestroyChallenge,
  phrase: string,
): Promise<{ state: 'destroyed'; audit_id: string; safety: BrowserSafetySnapshot }> {
  const { client } = recoveryContext(true);
  const receipt = await client.destroyConfirm(challenge, phrase);
  await getDatabaseManager().clear();
  const safety = await initializeBrowserSafety({ force: true, acknowledgeCacheReset: true });
  return { ...receipt, safety };
}
