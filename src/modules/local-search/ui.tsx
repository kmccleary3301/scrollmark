import { ExtensionPanel, Modal } from '@/components/common';
import { useTranslation } from '@/i18n';
import { useToggle } from '@/utils/common';
import { RawRecorderSearchPanel } from '@/modules/runtime-logs/ui';

export function LocalSearchUI() {
  const { t } = useTranslation();
  const [showModal, toggleShowModal] = useToggle();

  return (
    <ExtensionPanel
      title={t('Local Search')}
      description={t('Search indexed tweets with Twitter-style operators')}
      active
      onClick={toggleShowModal}
      indicatorColor="bg-neutral"
      panelClass="opacity-90"
    >
      <Modal
        class="max-w-4xl md:max-w-screen-md sm:max-w-screen-sm min-h-[560px]"
        title={t('Local Recorder Search')}
        show={showModal}
        onClose={toggleShowModal}
      >
        <RawRecorderSearchPanel />
      </Modal>
    </ExtensionPanel>
  );
}
