import { Fragment } from 'preact';
import { ErrorBoundary } from '@/components/error-boundary';
import { TranslationKey, useTranslation } from '@/i18n';
import { useWorkspaceShellState } from './workspace-shell-state';
import { ControlPanelLauncher } from './control-panel-launcher';
import { ControlPanelShell } from './control-panel-shell';
import { BundleViewerPanel } from '@/components/bundles/bundle-viewer-panel';
import { compareWidgetExtensions, isBottomUtilityWidget } from './widget-presentation';
import { BrowserRecoveryGate } from '@/components/durability/browser-recovery-gate';
import { browserSafetyState, initializeBrowserSafety } from './durability/browser-safety';

export function App() {
  const browserSafety = browserSafetyState.value;
  if (browserSafety.phase === 'recovery_required') {
    return (
      <BrowserRecoveryGate
        snapshot={browserSafety}
        onRetry={async () => {
          const next = await initializeBrowserSafety({ force: true });
          if (next.phase !== 'recovery_required') {
            window.location.reload();
          }
        }}
      />
    );
  }
  return <ArchiveApp />;
}

function ArchiveApp() {
  const { t } = useTranslation();
  const persistence = browserSafetyState.value;

  const {
    extensions,
    resolvedTheme,
    showControlPanel,
    hookStats,
    runtimeModes,
    rawCaptureStats,
    toggleControlPanel,
  } = useWorkspaceShellState(t('Open Control Panel'));

  const statusLabel = (value: string | boolean | undefined) => {
    if (typeof value === 'boolean') return value ? t('on') : t('off');
    return t(String(value || 'unknown') as TranslationKey);
  };
  const ageLabel = (seconds: number | null) =>
    seconds === null ? '' : t('{{seconds}}s ago', { seconds });

  const hookLine = (() => {
    const hs = hookStats.value;
    if (!hs) return t('Hooks: {{status}}', { status: t('unknown') });
    const ageSec = hs.lastAt ? Math.max(0, Math.floor((Date.now() - hs.lastAt) / 1000)) : null;
    let short = hs.lastUrl || '';
    try {
      const u = new URL(short);
      short = `${u.hostname}${u.pathname}`;
    } catch {
      // ignore
    }
    if (short.length > 48) short = short.slice(0, 45) + '...';
    const age = ageLabel(ageSec);
    return hs.lastUrl
      ? t('Hooks: xhr {{xhr}}, fetch {{fetch}}, last {{url}} ({{age}})', {
          xhr: hs.xhrMessages,
          fetch: hs.fetchMessages,
          url: short,
          age,
        })
      : t('Hooks: xhr {{xhr}}, fetch {{fetch}}', {
          xhr: hs.xhrMessages,
          fetch: hs.fetchMessages,
        });
  })();

  const healthLine = (() => {
    const modes = runtimeModes.value;
    const raw = rawCaptureStats.value;
    const safeMode = statusLabel(modes?.safeMode);
    const hookMode = statusLabel(modes?.hookMode);
    const repairMode = statusLabel(modes?.repairMode);
    const rawTotal = Number(raw?.total || 0);
    const spool = Number(raw?.spool_count || 0);
    const daemon = statusLabel(raw?.daemon_online);
    const monitorRole = statusLabel(raw?.monitor_role);
    const rawAgeSec = raw?.last_at
      ? Math.max(0, Math.floor((Date.now() - raw.last_at) / 1000))
      : null;
    const age = ageLabel(rawAgeSec);
    return age
      ? t(
          'Mode: safe {{safe}}, hook {{hook}}, repair {{repair}} | raw {{raw}}, spool {{spool}}, daemon {{daemon}}, monitor {{monitor}}, raw {{age}}',
          {
            safe: safeMode,
            hook: hookMode,
            repair: repairMode,
            raw: rawTotal,
            spool,
            daemon,
            monitor: monitorRole,
            age,
          },
        )
      : t(
          'Mode: safe {{safe}}, hook {{hook}}, repair {{repair}} | raw {{raw}}, spool {{spool}}, daemon {{daemon}}, monitor {{monitor}}',
          {
            safe: safeMode,
            hook: hookMode,
            repair: repairMode,
            raw: rawTotal,
            spool,
            daemon,
            monitor: monitorRole,
          },
        );
  })();

  const persistenceLine = `Persistence: ${persistence.persistence?.state || 'unknown'} | continuity: ${persistence.phase} (${persistence.reason})`;
  const sortedExtensions = extensions.value.slice().sort(compareWidgetExtensions);
  const primaryExtensions = sortedExtensions.filter((ext) => !isBottomUtilityWidget(ext));
  const bottomExtensions = sortedExtensions.filter(isBottomUtilityWidget);
  const renderExtension = (ext: (typeof extensions.value)[number]) => {
    const Component = ext.render();
    if (ext.enabled && Component) {
      return (
        <ErrorBoundary key={ext.name}>
          <Component extension={ext} />
        </ErrorBoundary>
      );
    }
    return null;
  };

  return (
    <Fragment>
      <ControlPanelLauncher currentTheme={resolvedTheme.value} onToggle={toggleControlPanel} />
      <ControlPanelShell
        currentTheme={resolvedTheme.value}
        show={!!showControlPanel.value}
        title="Scrollmark"
        byline="By Kyle McCleary"
        description={t('Browse around to capture more data.')}
        hookLine={hookLine}
        healthLine={healthLine}
        persistenceLine={persistenceLine}
        onToggle={toggleControlPanel}
      >
        <ErrorBoundary>
          {primaryExtensions.map(renderExtension)}
          <ErrorBoundary>
            <BundleViewerPanel />
          </ErrorBoundary>
          {bottomExtensions.length ? <div class="divider mb-0 mt-1 opacity-60" /> : null}
          {bottomExtensions.map(renderExtension)}
        </ErrorBoundary>
      </ControlPanelShell>
    </Fragment>
  );
}
