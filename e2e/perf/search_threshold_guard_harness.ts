import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const localStorage = new MemoryStorage();
Object.assign(globalThis, {
  indexedDB,
  IDBKeyRange,
  localStorage,
  self: globalThis,
  window: {
    localStorage,
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    __META_DATA__: { userId: 'search-threshold-guard-harness' },
  },
  unsafeWindow: {
    localStorage,
    setTimeout,
    clearTimeout,
    __META_DATA__: { userId: 'search-threshold-guard-harness' },
  },
});

const { createSearchDocumentFullLoadBlockedReason } = await import('@/core/database/hooks');

const belowLimit = createSearchDocumentFullLoadBlockedReason(50_000);
const aboveLimit = createSearchDocumentFullLoadBlockedReason(50_001);
localStorage.setItem('twe_allow_large_search_corpus_v1', '1');
const overrideAllowed = createSearchDocumentFullLoadBlockedReason(250_000);

const checks = [
  {
    name: 'search guard allows documents at the threshold',
    ok: belowLimit === null,
    details: { belowLimit },
  },
  {
    name: 'search guard blocks documents above the threshold',
    ok:
      typeof aboveLimit === 'string' &&
      aboveLimit.includes('50,001') &&
      aboveLimit.includes('blocked above 50,000 documents'),
    details: { aboveLimit },
  },
  {
    name: 'search guard respects local diagnostic override',
    ok: overrideAllowed === null,
    details: { overrideAllowed },
  },
];

const report = { ok: checks.every((check) => check.ok), checks };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
