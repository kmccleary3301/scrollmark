import { useSignal } from '@preact/signals';

import { clearBrowserCache, type BrowserSafetySnapshot } from '@/core/durability/browser-safety';
import { readPairingContext } from '@/core/durability/identity';
import {
  confirmDurableDestroy,
  createVerifiedSnapshot,
  listVerifiedSnapshots,
  preflightDurableDestroy,
  restoreVerifiedSnapshot,
} from '@/core/durability/recovery';

type BrowserRecoveryGateProps = {
  snapshot: BrowserSafetySnapshot;
  onRetry: () => Promise<void>;
};

const CACHE_CLEAR_CONFIRMATION = 'CLEAR BROWSER CACHE';

export function BrowserRecoveryGate({ snapshot, onRetry }: BrowserRecoveryGateProps) {
  const busy = useSignal(false);
  const actionStatus = useSignal('');
  const companionPaired = readPairingContext() !== null;

  const retry = async () => {
    if (busy.value) return;
    busy.value = true;
    actionStatus.value = 'Rechecking browser persistence…';
    try {
      await onRetry();
      busy.value = false;
      actionStatus.value = 'Recovery remains required; no cache state was activated.';
    } catch (error) {
      actionStatus.value = `Recheck failed: ${error instanceof Error ? error.message : String(error)}`;
      busy.value = false;
    }
  };

  const clearCache = async () => {
    if (busy.value || snapshot.storage_backend === 'unavailable') return;
    const confirmation = window.prompt(
      `This clears the disposable browser cache. Type ${CACHE_CLEAR_CONFIRMATION} to continue.`,
    );
    if (confirmation !== CACHE_CLEAR_CONFIRMATION) return;

    busy.value = true;
    actionStatus.value = 'Clearing browser cache and rebuilding its continuity baseline…';
    try {
      await clearBrowserCache();
      window.location.reload();
    } catch (error) {
      actionStatus.value = `Cache clear failed: ${error instanceof Error ? error.message : String(error)}`;
      busy.value = false;
    }
  };

  const createSnapshot = async () => {
    if (busy.value) return;
    const encrypted = window.confirm(
      'Create an encrypted snapshot? Cancel creates a verified plaintext snapshot.',
    );
    busy.value = true;
    actionStatus.value = 'Creating and verifying canonical snapshot…';
    try {
      const created = await createVerifiedSnapshot(encrypted);
      actionStatus.value = `Verified snapshot created: ${created.snapshot_id}`;
    } catch (error) {
      actionStatus.value = `Snapshot creation failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy.value = false;
    }
  };

  const restoreSnapshot = async () => {
    if (busy.value) return;
    busy.value = true;
    actionStatus.value = 'Loading verified snapshots…';
    try {
      const available = await listVerifiedSnapshots();
      if (!available.length) {
        actionStatus.value = 'No verified snapshots are available.';
        return;
      }
      const defaultSnapshot = available[0]?.snapshot_id ?? '';
      const selected = window.prompt(
        `Restore a canonical snapshot and rebuild the browser cache. Available snapshots:\n${available
          .map((item) => `${item.snapshot_id} (${new Date(item.verified_at_ms).toLocaleString()})`)
          .join('\n')}\n\nEnter a snapshot id:`,
        defaultSnapshot,
      );
      if (!selected || !available.some((item) => item.snapshot_id === selected)) {
        actionStatus.value = 'Snapshot restore cancelled.';
        return;
      }
      const confirmation = window.prompt(
        `This replaces the canonical archive state, retains the previous database for rollback, and preserves the browser outbox. Type RESTORE ${selected} to continue.`,
      );
      if (confirmation !== `RESTORE ${selected}`) {
        actionStatus.value = 'Snapshot restore cancelled.';
        return;
      }
      actionStatus.value = 'Restoring snapshot and rebuilding the browser projection…';
      await restoreVerifiedSnapshot(selected);
      window.location.reload();
    } catch (error) {
      actionStatus.value = `Snapshot restore failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy.value = false;
    }
  };

  const destroyDurableArchive = async () => {
    if (busy.value) return;
    const lossAcknowledged = window.confirm(
      'Destroying the durable archive is irreversible unless a verified snapshot can be restored. Continue to guarded preflight?',
    );
    if (!lossAcknowledged) return;
    const pendingAcknowledged = window.confirm(
      'Any browser outbox mutations not yet acknowledged by the companion may be lost. Acknowledge this risk and continue?',
    );
    if (!pendingAcknowledged) return;
    busy.value = true;
    actionStatus.value = 'Preparing guarded durable archive destruction…';
    try {
      const challenge = await preflightDurableDestroy({
        pendingAcknowledged: true,
        explicitLossAcknowledgement: true,
      });
      const disclosures = challenge.namespace_disclosures
        .map((item) => `${item.namespace_id} (identity ${item.identity_fingerprint})`)
        .join('\n');
      const phrase = window.prompt(
        `Canonical archive: ${challenge.archive_id}\nNamespace/account bindings:\n${disclosures}\nPending mutations disclosed: ${challenge.pending_count}\nVerified snapshot available: ${challenge.recent_verified_snapshot ? 'yes' : 'no'}\n\nType ${challenge.required_phrase} to continue.`,
      );
      if (phrase !== challenge.required_phrase) {
        actionStatus.value = 'Durable archive destruction cancelled.';
        return;
      }
      if (!window.confirm('Final confirmation: permanently destroy the canonical archive now?')) {
        actionStatus.value = 'Durable archive destruction cancelled.';
        return;
      }
      actionStatus.value = 'Destroying canonical archive while preserving verified snapshots…';
      await confirmDurableDestroy(challenge, phrase);
      window.location.reload();
    } catch (error) {
      actionStatus.value = `Durable archive destruction failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy.value = false;
    }
  };

  const counts = snapshot.current_counts;
  return (
    <div class="fixed inset-0 z-[2147483647] flex items-center justify-center bg-base-300/90 p-4">
      <section class="card w-full max-w-xl border border-warning bg-base-100 shadow-2xl">
        <div class="card-body gap-3">
          <h1 class="card-title text-warning">Scrollmark recovery required</h1>
          <p>
            Scrollmark found a browser-cache discontinuity. Capture is blocked until the archive
            state is verified or the disposable cache is explicitly cleared.
          </p>
          <div class="rounded-box bg-base-200 p-3 font-mono text-xs">
            <div>Reason: {snapshot.reason}</div>
            <div>Storage: {snapshot.storage_backend}</div>
            <div>Persistence: {snapshot.persistence?.state || 'unknown'}</div>
            <div>Database: {snapshot.inventory?.active_db_name || 'unknown'}</div>
            <div>Current rows: {counts ? counts.total.toLocaleString() : 'unavailable'}</div>
            {snapshot.error ? <div class="mt-1 text-error">{snapshot.error}</div> : null}
          </div>
          <p class="text-sm opacity-70">
            Browser cache clearing never deletes the companion archive. Snapshot restore changes the
            canonical archive and then rebuilds the disposable browser projection. Durable archive
            destruction uses a separate guarded, double-confirmed path and preserves snapshots.
            {!companionPaired
              ? ' Companion recovery actions remain disabled until a local companion is paired.'
              : ''}
          </p>
          {actionStatus.value ? <p class="text-sm text-warning">{actionStatus.value}</p> : null}
          <div class="card-actions justify-end gap-2">
            <button class="btn btn-outline" disabled={busy.value} onClick={() => void retry()}>
              Recheck and restart
            </button>
            <button
              class="btn btn-outline"
              disabled={busy.value || !companionPaired}
              onClick={() => void createSnapshot()}
            >
              Create snapshot
            </button>
            <button
              class="btn btn-info"
              disabled={busy.value || !companionPaired}
              onClick={() => void restoreSnapshot()}
            >
              Restore snapshot
            </button>
            <button
              class="btn btn-warning"
              disabled={busy.value || snapshot.storage_backend === 'unavailable'}
              onClick={() => void clearCache()}
            >
              Clear browser cache
            </button>
            <button
              class="btn btn-error"
              disabled={busy.value || !companionPaired}
              onClick={() => void destroyDurableArchive()}
            >
              Destroy durable archive
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
