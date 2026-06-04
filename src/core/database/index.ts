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

export function getDatabaseManager(): DatabaseManager {
  if (databaseManager) {
    return databaseManager;
  }
  databaseManager = new DatabaseManager();
  return databaseManager;
}

const dbProxy = new Proxy({} as DatabaseManager, {
  get(_target, prop, receiver) {
    const manager = getDatabaseManager();
    const value = Reflect.get(manager, prop, receiver);
    return typeof value === 'function' ? value.bind(manager) : value;
  },
  set(_target, prop, value, receiver) {
    const manager = getDatabaseManager();
    return Reflect.set(manager, prop, value, receiver);
  },
});

export { dbProxy as db };
