import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { GM_registerMenuCommand } from '$';

import logger from '@/utils/logger';

import extensionManager, { Extension } from './extensions';
import { options } from './options';

export function useWorkspaceShellState(openControlPanelLabel: string) {
  const extensions = useSignal<Extension[]>(extensionManager.getExtensions());
  const currentTheme = useSignal(options.get('theme'));
  const showControlPanel = useSignal(options.get('showControlPanel'));
  const hookStats = useSignal<{
    xhrMessages: number;
    fetchMessages: number;
    lastUrl: string;
    lastAt: number;
  } | null>(null);
  const runtimeModes = useSignal<{
    safeMode?: boolean;
    hookMode?: string;
    repairMode?: string;
    reason?: string;
  } | null>(null);
  const rawCaptureStats = useSignal<{
    total?: number;
    last_at?: number;
    spool_count?: number;
    daemon_online?: boolean;
    monitor_role?: string;
    monitor_leader_tab_id?: string;
  } | null>(null);

  const toggleControlPanel = () => {
    showControlPanel.value = !showControlPanel.value;
    options.set('showControlPanel', showControlPanel.value);
  };

  useEffect(() => {
    extensions.value = extensionManager.getExtensions();
    currentTheme.value = options.get('theme');
    showControlPanel.value = options.get('showControlPanel');

    extensionManager.signal.subscribe(() => {
      extensions.value = extensionManager.getExtensions();
    });

    options.signal.subscribe(() => {
      currentTheme.value = options.get('theme');
      try {
        extensionManager.applyRuntimeModesFromOptions();
        runtimeModes.value = extensionManager.getRuntimeModesSnapshot();
      } catch {
        runtimeModes.value = null;
      }
    });

    try {
      extensionManager.applyRuntimeModesFromOptions();
    } catch {
      // Ignore startup reconfigure failures here; polling will surface state.
    }

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand(openControlPanelLabel, toggleControlPanel);
    }

    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const refresh = () => {
      try {
        hookStats.value = extensionManager.getHookStatsSnapshot();
      } catch {
        hookStats.value = null;
      }
      try {
        runtimeModes.value = extensionManager.getRuntimeModesSnapshot();
      } catch {
        runtimeModes.value = null;
      }
      try {
        rawCaptureStats.value = (globalThis as { __twe_raw_capture_stats_v1?: unknown })
          .__twe_raw_capture_stats_v1 as {
          total?: number;
          last_at?: number;
          spool_count?: number;
          daemon_online?: boolean;
          monitor_role?: string;
          monitor_leader_tab_id?: string;
        } | null;
      } catch {
        rawCaptureStats.value = null;
      }
    };
    const schedule = () => {
      const delay = typeof document !== 'undefined' && document.hidden ? 8000 : 2000;
      timer = globalThis.setTimeout(() => {
        refresh();
        schedule();
      }, delay);
    };
    refresh();
    schedule();

    logger.debug('Workspace shell state effect executed');
    return () => {
      if (timer !== null) {
        globalThis.clearTimeout(timer);
      }
    };
  }, []);

  return {
    extensions,
    currentTheme,
    showControlPanel,
    hookStats,
    runtimeModes,
    rawCaptureStats,
    toggleControlPanel,
  };
}
