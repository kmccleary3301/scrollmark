import { Fragment } from 'preact';
import { ErrorBoundary } from '@/components/error-boundary';
import { useTranslation } from '@/i18n';
import { useWorkspaceShellState } from './workspace-shell-state';
import { ControlPanelLauncher } from './control-panel-launcher';
import { ControlPanelShell } from './control-panel-shell';
import { BundleViewerPanel } from '@/components/bundles/bundle-viewer-panel';
import { compareWidgetExtensions, isBottomUtilityWidget } from './widget-presentation';

export function App() {
  const { t } = useTranslation();

  const {
    extensions,
    currentTheme,
    showControlPanel,
    hookStats,
    runtimeModes,
    rawCaptureStats,
    toggleControlPanel,
  } = useWorkspaceShellState(t('Open Control Panel'));

  const hookLine = (() => {
    const hs = hookStats.value;
    if (!hs) return 'Hooks: unknown';
    const ageSec = hs.lastAt ? Math.max(0, Math.floor((Date.now() - hs.lastAt) / 1000)) : null;
    let short = hs.lastUrl || '';
    try {
      const u = new URL(short);
      short = `${u.hostname}${u.pathname}`;
    } catch {
      // ignore
    }
    if (short.length > 48) short = short.slice(0, 45) + '...';
    const age = ageSec === null ? '' : ` (${ageSec}s ago)`;
    return (
      `Hooks: xhr ${hs.xhrMessages}, fetch ${hs.fetchMessages}` +
      (hs.lastUrl ? `, last ${short}${age}` : '')
    );
  })();

  const healthLine = (() => {
    const modes = runtimeModes.value;
    const raw = rawCaptureStats.value;
    const safeMode = modes?.safeMode ? 'on' : 'off';
    const hookMode = modes?.hookMode || 'unknown';
    const repairMode = modes?.repairMode || 'unknown';
    const rawTotal = Number(raw?.total || 0);
    const spool = Number(raw?.spool_count || 0);
    const daemon = raw?.daemon_online ? 'on' : 'off';
    const monitorRole = raw?.monitor_role || 'unknown';
    const rawAgeSec = raw?.last_at
      ? Math.max(0, Math.floor((Date.now() - raw.last_at) / 1000))
      : null;
    const age = rawAgeSec === null ? '' : `, raw ${rawAgeSec}s ago`;
    return `Mode: safe ${safeMode}, hook ${hookMode}, repair ${repairMode} | raw ${rawTotal}, spool ${spool}, daemon ${daemon}, monitor ${monitorRole}${age}`;
  })();

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
      <ControlPanelLauncher
        currentTheme={currentTheme.value || 'system'}
        onToggle={toggleControlPanel}
      />
      <ControlPanelShell
        currentTheme={currentTheme.value || 'system'}
        show={!!showControlPanel.value}
        title="Scrollmark"
        byline="By Kyle McCleary"
        description={t('Browse around to capture more data.')}
        hookLine={hookLine}
        healthLine={healthLine}
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
