import { options } from '@/core/options';
import logger from '@/utils/logger';

export type HookMode = 'both' | 'xhr' | 'fetch' | 'off';
export type RepairMode = 'watchdog' | 'off';
export type RuntimeModes = {
  safeMode: boolean;
  hookMode: HookMode;
  repairMode: RepairMode;
};

export type HookStatsSnapshot = {
  xhrMessages: number;
  fetchMessages: number;
  lastUrl: string;
  lastAt: number;
};

const LOCAL_STORAGE_SAFE_MODE_KEY = 'twe_safe_mode_v1';
const LOCAL_STORAGE_HOOK_MODE_KEY = 'twe_hook_mode_v1';
const LOCAL_STORAGE_REPAIR_MODE_KEY = 'twe_repair_mode_v1';
const DEBUG_DISABLE_XHR_OPEN_WRAP_KEY = 'twe_debug_disable_xhr_open_wrap_v1';
const DEBUG_DISABLE_XHR_SEND_WRAP_KEY = 'twe_debug_disable_xhr_send_wrap_v1';
const DEBUG_DISABLE_XHR_LOAD_LISTENER_KEY = 'twe_debug_disable_xhr_load_listener_v1';
const DEBUG_DISABLE_FETCH_WRAP_KEY = 'twe_debug_disable_fetch_wrap_v1';
const DEBUG_DISABLE_EXPANDO_META_KEY = 'twe_debug_disable_expando_meta_v1';
const DEBUG_FORCE_CALL_NOT_APPLY_KEY = 'twe_debug_force_call_not_apply_v1';
const DEBUG_HOOK_DIAG_KEY = 'twe_debug_hook_diag_v1';
const DEBUG_CONSOLE_VERBOSE_KEY = 'twe_console_verbose_v1';
const DEBUG_HOOK_DIAG_MAX_PER_PHASE = 6;
const HOOK_REPAIR_INTERVAL_MS = 1100;
const HOOK_REPAIR_BACKOFF_MAX_MS = 60000;
const HOOK_REPAIR_FAILURE_LIMIT = 5;

export type HookDebugConfig = {
  disableXhrOpenWrap: boolean;
  disableXhrSendWrap: boolean;
  disableXhrLoadListener: boolean;
  disableFetchWrap: boolean;
  disableExpandoMeta: boolean;
  forceCallNotApply: boolean;
  hookDiag: boolean;
};

function normalizeHookMode(value: unknown): HookMode {
  return value === 'xhr' || value === 'fetch' || value === 'off' ? value : 'both';
}

function normalizeRepairMode(value: unknown): RepairMode {
  return value === 'off' ? 'off' : 'watchdog';
}

function readLocalStorageValue(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorageValue(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function isTruthyStorageValue(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveHookDebugConfig(): HookDebugConfig {
  const hookDiagRequested = isTruthyStorageValue(readLocalStorageValue(DEBUG_HOOK_DIAG_KEY));
  const consoleVerbose = isTruthyStorageValue(readLocalStorageValue(DEBUG_CONSOLE_VERBOSE_KEY));
  return {
    disableXhrOpenWrap: isTruthyStorageValue(
      readLocalStorageValue(DEBUG_DISABLE_XHR_OPEN_WRAP_KEY),
    ),
    disableXhrSendWrap: isTruthyStorageValue(
      readLocalStorageValue(DEBUG_DISABLE_XHR_SEND_WRAP_KEY),
    ),
    disableXhrLoadListener: isTruthyStorageValue(
      readLocalStorageValue(DEBUG_DISABLE_XHR_LOAD_LISTENER_KEY),
    ),
    disableFetchWrap: isTruthyStorageValue(readLocalStorageValue(DEBUG_DISABLE_FETCH_WRAP_KEY)),
    disableExpandoMeta: isTruthyStorageValue(readLocalStorageValue(DEBUG_DISABLE_EXPANDO_META_KEY)),
    forceCallNotApply: isTruthyStorageValue(readLocalStorageValue(DEBUG_FORCE_CALL_NOT_APPLY_KEY)),
    hookDiag: hookDiagRequested && consoleVerbose,
  };
}

function resolveRuntimeModes(): RuntimeModes {
  const optionSafeMode = !!options.get('safeMode', false);
  const optionHookMode = normalizeHookMode(options.get('hookMode', 'both'));
  const optionRepairMode = normalizeRepairMode(options.get('repairMode', 'watchdog'));

  return {
    safeMode: optionSafeMode,
    hookMode: optionHookMode,
    repairMode: optionRepairMode,
  };
}

export interface RuntimeControlPlaneHost {
  installPageMessageBridge(): void;
  installBookmarkContextTracking(): void;
  installHttpHooks(force?: boolean): void;
  installFetchHooks(force?: boolean): void;
  uninstallHooks(): void;
  runHookSelfTest(): { ok: boolean; error?: string };
  runFetchHookBootProbePass(): void;
  runHookRepairPass(): { ok: boolean; error?: string };
  readHookStatsSnapshot(): HookStatsSnapshot | null;
}

export class RuntimeControlPlane {
  private runtimeModes: RuntimeModes = resolveRuntimeModes();
  private hookDebugConfig: HookDebugConfig = resolveHookDebugConfig();
  private hookDiagCounters: Record<string, number> = Object.create(null);
  private runtimeModeReason = '';
  private hookRepairInterval: ReturnType<typeof setTimeout> | null = null;
  private hookBootProbeTimeout: ReturnType<typeof setTimeout> | null = null;
  private hookRepairBackoffMs = HOOK_REPAIR_INTERVAL_MS;
  private hookRepairFailures = 0;

  constructor(private readonly host: RuntimeControlPlaneHost) {}

  public initialize(): void {
    this.refreshRuntimeModes();
    if (this.runtimeModes.hookMode !== 'off') {
      try {
        this.host.installPageMessageBridge();
      } catch (err) {
        this.enableSafeMode('install-page-message-bridge-failed', err);
      }
    }
    if (!this.runtimeModes.safeMode && this.runtimeModes.hookMode !== 'off') {
      try {
        this.host.installBookmarkContextTracking();
      } catch (err) {
        const details =
          err instanceof Error ? `${err.name}: ${err.message}` : `unknown error: ${String(err)}`;
        logger.warn(
          `Bookmark context tracking install failed; continuing without tracker (${details})`,
        );
      }
    }
    try {
      if (this.isHookModeEnabled('xhr')) {
        this.host.installHttpHooks();
      }
      if (this.isHookModeEnabled('fetch')) {
        this.host.installFetchHooks();
      }
      const hookSelfTest = this.host.runHookSelfTest();
      if (!hookSelfTest.ok) {
        this.enableSafeMode('hook-self-test-failed', hookSelfTest.error);
      } else if (!this.runtimeModes.safeMode && this.runtimeModes.repairMode !== 'off') {
        this.startHookRepairLoop();
      }
      if (!this.runtimeModes.safeMode) {
        this.startFetchHookBootProbe();
      }
    } catch (err) {
      this.enableSafeMode('hook-install-failed', err);
    }
  }

  public dispose(): void {
    this.clearHookRepairLoop();
    this.clearFetchHookBootProbe();
    this.host.uninstallHooks();
  }

  public applyRuntimeModesFromOptions(): void {
    const previous = { ...this.runtimeModes };
    this.refreshRuntimeModes();

    const next = this.runtimeModes;
    if (
      previous.safeMode === next.safeMode &&
      previous.hookMode === next.hookMode &&
      previous.repairMode === next.repairMode
    ) {
      return;
    }

    if (!next.safeMode) {
      this.runtimeModeReason = '';
    }

    if (next.hookMode === 'off') {
      this.host.uninstallHooks();
      this.clearHookRepairLoop();
      this.clearFetchHookBootProbe();
      return;
    }

    if (next.safeMode) {
      this.host.uninstallHooks();
      this.clearHookRepairLoop();
      this.clearFetchHookBootProbe();

      try {
        this.host.installPageMessageBridge();
        if (this.isHookModeEnabled('xhr')) {
          this.host.installHttpHooks(true);
        }
        if (this.isHookModeEnabled('fetch')) {
          this.host.installFetchHooks(true);
        }
      } catch (err) {
        logger.warn('Failed to reconfigure lightweight safe mode hooks', err ?? '');
      }
      return;
    }

    try {
      this.host.installPageMessageBridge();
      this.host.installBookmarkContextTracking();

      if (this.isHookModeEnabled('xhr')) {
        this.host.installHttpHooks(true);
      }
      if (this.isHookModeEnabled('fetch')) {
        this.host.installFetchHooks(true);
      }

      const hookSelfTest = this.host.runHookSelfTest();
      if (!hookSelfTest.ok) {
        this.runtimeModeReason = 'hook-self-test-failed';
        logger.warn('Hook self-test failed after runtime reconfigure', hookSelfTest.error ?? '');
        this.publishRuntimeModes({
          enabledAt: Date.now(),
          error: hookSelfTest.error ? String(hookSelfTest.error) : undefined,
        });
        return;
      }

      if (this.runtimeModes.repairMode !== 'off') {
        this.startHookRepairLoop();
      } else {
        this.clearHookRepairLoop();
      }

      this.startFetchHookBootProbe();
    } catch (err) {
      this.enableSafeMode('hook-reconfigure-failed', err);
    }
  }

  public getRuntimeModesSnapshot(): {
    safeMode: boolean;
    hookMode: HookMode;
    repairMode: RepairMode;
    reason?: string;
  } {
    return {
      safeMode: this.runtimeModes.safeMode,
      hookMode: this.runtimeModes.hookMode,
      repairMode: this.runtimeModes.repairMode,
      reason: this.runtimeModeReason || undefined,
    };
  }

  public getHookStatsSnapshot(): HookStatsSnapshot | null {
    return this.host.readHookStatsSnapshot();
  }

  public getRuntimeModes(): RuntimeModes {
    return this.runtimeModes;
  }

  public getHookDebugConfig(): HookDebugConfig {
    return this.hookDebugConfig;
  }

  public refreshHookDebugConfig(): void {
    this.hookDebugConfig = resolveHookDebugConfig();
  }

  public isHookModeEnabled(target: 'xhr' | 'fetch'): boolean {
    if (this.runtimeModes.hookMode === 'off') {
      return false;
    }
    if (this.runtimeModes.hookMode === 'both') {
      return true;
    }
    return this.runtimeModes.hookMode === target;
  }

  public emitHookDiag(
    phase: string,
    payload: Record<string, unknown>,
    options?: { force?: boolean },
  ): void {
    const force = !!options?.force;
    if (!this.hookDebugConfig.hookDiag) return;

    const count = (this.hookDiagCounters[phase] ?? 0) + 1;
    this.hookDiagCounters[phase] = count;
    if (!force && count > DEBUG_HOOK_DIAG_MAX_PER_PHASE) {
      return;
    }

    logger.info(`TWE_DIAG ${phase}`, {
      ...payload,
      count,
      safeMode: this.runtimeModes.safeMode,
      hookMode: this.runtimeModes.hookMode,
      repairMode: this.runtimeModes.repairMode,
      forceCallNotApply: this.hookDebugConfig.forceCallNotApply,
      disableExpandoMeta: this.hookDebugConfig.disableExpandoMeta,
      ts: Date.now(),
    });
  }

  public enableSafeMode(reason: string, error?: unknown): void {
    this.clearFetchHookBootProbe();
    this.runtimeModes.safeMode = true;
    this.runtimeModeReason = reason;
    this.persistRuntimeModes();
    this.publishRuntimeModes({
      enabledAt: Date.now(),
      error: error ? String(error) : undefined,
    });
    this.host.uninstallHooks();
    this.clearHookRepairLoop();
    logger.error(`Hook safe mode enabled (${reason})`, error ?? '');
  }

  public startFetchHookBootProbe(delayMs = 1200): void {
    if (this.runtimeModes.safeMode || !this.isHookModeEnabled('fetch')) {
      return;
    }
    this.clearFetchHookBootProbe();

    this.hookBootProbeTimeout = setTimeout(() => {
      this.hookBootProbeTimeout = null;
      if (this.runtimeModes.safeMode || !this.isHookModeEnabled('fetch')) {
        return;
      }
      this.host.runFetchHookBootProbePass();
    }, delayMs);
  }

  public startHookRepairLoop(): void {
    if (this.runtimeModes.safeMode || this.runtimeModes.repairMode === 'off') {
      return;
    }

    if (this.hookRepairInterval !== null) {
      return;
    }

    const schedule = (delayMs: number) => {
      this.hookRepairInterval = setTimeout(() => {
        this.hookRepairInterval = null;
        repair();
      }, delayMs);
    };

    const repair = () => {
      if (this.runtimeModes.safeMode || this.runtimeModes.repairMode === 'off') {
        return;
      }

      try {
        const result = this.host.runHookRepairPass();
        if (!result.ok) {
          this.enableSafeMode('hook-repair-self-test-failed', result.error);
          return;
        }
        this.hookRepairFailures = 0;
        this.hookRepairBackoffMs = HOOK_REPAIR_INTERVAL_MS;
      } catch (err) {
        this.hookRepairFailures += 1;
        this.hookRepairBackoffMs = Math.min(
          this.hookRepairBackoffMs * 2,
          HOOK_REPAIR_BACKOFF_MAX_MS,
        );
        logger.warn(
          `Hook repair failed (${this.hookRepairFailures}/${HOOK_REPAIR_FAILURE_LIMIT})`,
          err,
        );
        if (this.hookRepairFailures >= HOOK_REPAIR_FAILURE_LIMIT) {
          this.enableSafeMode('hook-repair-failure-limit', err);
          return;
        }
      }

      schedule(this.hookRepairBackoffMs);
    };

    schedule(0);
  }

  public clearHookRepairLoop(): void {
    if (this.hookRepairInterval !== null) {
      clearTimeout(this.hookRepairInterval);
      this.hookRepairInterval = null;
    }
  }

  public clearFetchHookBootProbe(): void {
    if (this.hookBootProbeTimeout !== null) {
      clearTimeout(this.hookBootProbeTimeout);
      this.hookBootProbeTimeout = null;
    }
  }

  private persistRuntimeModes(): void {
    writeLocalStorageValue(LOCAL_STORAGE_SAFE_MODE_KEY, this.runtimeModes.safeMode ? '1' : '0');
    writeLocalStorageValue(LOCAL_STORAGE_HOOK_MODE_KEY, this.runtimeModes.hookMode);
    writeLocalStorageValue(LOCAL_STORAGE_REPAIR_MODE_KEY, this.runtimeModes.repairMode);
    try {
      options.set('safeMode', this.runtimeModes.safeMode);
      options.set('hookMode', this.runtimeModes.hookMode);
      options.set('repairMode', this.runtimeModes.repairMode);
    } catch {
      // ignore
    }
  }

  private publishRuntimeModes(extra?: Record<string, unknown>): void {
    void extra;
  }

  private refreshRuntimeModes(): void {
    this.runtimeModes = resolveRuntimeModes();
    this.refreshHookDebugConfig();
    this.persistRuntimeModes();
    this.publishRuntimeModes();
  }
}
