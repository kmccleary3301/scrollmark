import { CompanionClient } from '../durability/companion-client';
import { DURABLE_OPERATIONS, DurabilityCoordinator } from '../durability/coordinator';
import { readPairingContext } from '../durability/identity';
import {
  readActiveGenerationDatabaseName,
  readActiveGenerationPointer,
  readBoundActiveGenerationPointer,
} from '../durability/generation-state';
import { DatabaseManager } from './manager';

export * from './manager';
export * from './result-source';
export * from './result-source-diagnostics';
export * from './id-result-sources';
export * from './result-sources';

/**
 * Global database manager singleton instance.
 */
let databaseManager: DatabaseManager | null = null;
let durabilityCoordinator: DurabilityCoordinator | null = null;

export function getDatabaseManager(): DatabaseManager {
  if (databaseManager) {
    return databaseManager;
  }
  const pairing = readPairingContext();
  const activePointer = readActiveGenerationPointer();
  const boundPointer = pairing
    ? readBoundActiveGenerationPointer(pairing.archive_id, pairing.namespace_id)
    : null;
  const databaseName = pairing
    ? activePointer && !boundPointer
      ? `twitter-web-exporter-quarantine-${pairing.namespace_id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      : boundPointer?.database_name
    : readActiveGenerationDatabaseName();
  databaseManager = new DatabaseManager({ databaseName: databaseName ?? undefined });
  return databaseManager;
}

export function resetDatabaseManager(): void {
  const manager = databaseManager;
  databaseManager = null;
  try {
    manager?.close();
  } catch {
    // A closed or faulted source manager must not block target generation activation.
  }
}

export function getDurabilityCoordinator(): DurabilityCoordinator {
  if (durabilityCoordinator) return durabilityCoordinator;
  const pairing = readPairingContext();
  durabilityCoordinator = new DurabilityCoordinator({
    pairing,
    client: pairing ? new CompanionClient(pairing) : null,
  });
  return durabilityCoordinator;
}

export function getDurabilityStatus() {
  return getDurabilityCoordinator().getStatus();
}

const dbProxy = new Proxy({} as DatabaseManager, {
  get(_target, prop, receiver) {
    const manager = getDatabaseManager();
    const value = Reflect.get(manager, prop, receiver);
    if (typeof value !== 'function') return value;
    if (typeof prop !== 'string' || !DURABLE_OPERATIONS.has(prop)) {
      return value.bind(manager);
    }
    return (...args: unknown[]) =>
      getDurabilityCoordinator().route(prop, args, () => value.apply(manager, args));
  },
  set(_target, prop, value, receiver) {
    const manager = getDatabaseManager();
    return Reflect.set(manager, prop, value, receiver);
  },
});

export { dbProxy as db };
