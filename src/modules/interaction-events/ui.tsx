import { ExtensionPanel, Modal } from '@/components/common';
import { db } from '@/core/database';
import { useCaptureCount } from '@/core/database/hooks';
import { Extension } from '@/core/extensions';
import { useTranslation } from '@/i18n';
import { Capture } from '@/types';
import { useToggle } from '@/utils/common';
import { useLiveQuery } from '@/utils/observable';

type InteractionEventsPanelProps = {
  extension: Extension;
};

function sortByNewest(rows: Capture[]): Capture[] {
  return rows.slice().sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function splitDataKey(dataKey: string): { kind: string; target: string; operation: string } {
  const parts = String(dataKey || '').split('|');
  const kind = parts[0] || 'unknown';
  const target = parts.find((part) => part.startsWith('target:'))?.slice('target:'.length) || '-';
  const operation = parts.find((part) => part.startsWith('op:'))?.slice('op:'.length) || '-';
  return { kind, target, operation };
}

export function InteractionEventsPanel({ extension }: InteractionEventsPanelProps) {
  const { t } = useTranslation();
  const [showModal, toggleShowModal] = useToggle();
  const count = useCaptureCount(extension.name);
  const queryResult = useLiveQuery(() => db.extGetCaptures(extension.name), [extension.name]);
  const rows: Capture[] = Array.isArray(queryResult) ? queryResult : [];
  const recent = sortByNewest(rows).slice(0, 150);

  return (
    <ExtensionPanel
      title={t('Interaction Events')}
      description={`${t('Captured:')} ${count}`}
      active={count > 0}
      onClick={toggleShowModal}
      indicatorColor="bg-neutral"
      panelClass="opacity-90"
    >
      <Modal
        class="max-w-4xl md:max-w-screen-md sm:max-w-screen-sm min-h-[512px]"
        title={t('Interaction Events')}
        show={showModal}
        onClose={toggleShowModal}
      >
        <div class="text-xs text-base-content opacity-70 mb-2">
          Captures request-level actions (like/bookmark/follow/repost). Showing latest{' '}
          {recent.length} events.
        </div>
        <div class="overflow-y-auto max-h-[460px] border rounded-box-half border-base-300">
          <table class="table table-xs w-full">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Target</th>
                <th>Op</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => {
                const parsed = splitDataKey(row.data_key);
                return (
                  <tr key={row.id}>
                    <td class="font-mono">{formatTimestamp(Number(row.created_at || 0))}</td>
                    <td class="font-mono">{parsed.kind}</td>
                    <td class="font-mono break-all">{parsed.target}</td>
                    <td class="font-mono break-all">{parsed.operation}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Modal>
    </ExtensionPanel>
  );
}
