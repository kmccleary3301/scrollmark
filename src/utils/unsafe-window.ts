type GlobalRecord = typeof globalThis & Record<string, unknown>;

export function getUnsafeWindow(): GlobalRecord {
  try {
    const candidate = (globalThis as GlobalRecord).unsafeWindow;
    if (candidate && typeof candidate === 'object') {
      return candidate as GlobalRecord;
    }
  } catch {
    // ignore userscript bridge lookup failures
  }

  try {
    if (typeof window !== 'undefined') {
      return window as unknown as GlobalRecord;
    }
  } catch {
    // ignore window lookup failures
  }

  return globalThis as GlobalRecord;
}
