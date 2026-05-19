import { ExtensionManager } from './manager';

export * from './manager';
export * from './extension';

/**
 * Global extension manager singleton instance.
 */
let extensionManager: ExtensionManager | null = null;

export function getExtensionManager(): ExtensionManager {
  if (extensionManager && !extensionManager.isDisposed()) {
    return extensionManager;
  }
  extensionManager = new ExtensionManager();
  return extensionManager;
}

const extensionManagerProxy = new Proxy({} as ExtensionManager, {
  get(_target, prop, receiver) {
    const manager = getExtensionManager();
    const value = Reflect.get(manager, prop, receiver);
    return typeof value === 'function' ? value.bind(manager) : value;
  },
  set(_target, prop, value, receiver) {
    const manager = getExtensionManager();
    return Reflect.set(manager, prop, value, receiver);
  },
});

export default extensionManagerProxy;
