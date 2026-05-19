import { ExtensionPanel, Modal } from '@/components/common';
import { TableView } from '@/components/table/table-view';
import { useCaptureCount } from '@/core/database/hooks';
import { Extension, ExtensionType } from '@/core/extensions';
import { getWidgetPresentation } from '@/core/widget-presentation';
import { TranslationKey, useTranslation } from '@/i18n';
import { useToggle } from '@/utils/common';
import { useState } from 'preact/hooks';

export type CommonModuleUIProps = {
  extension: Extension;
};

/**
 * A common UI boilerplate for modules.
 */
export function CommonModuleUI({ extension }: CommonModuleUIProps) {
  const { t } = useTranslation();
  const [showModal, toggleShowModal] = useToggle();
  const [isViewerFullscreen, setIsViewerFullscreen] = useState(false);

  const count = useCaptureCount(extension.name);

  if (extension.type !== ExtensionType.TWEET && extension.type !== ExtensionType.USER) {
    throw new Error('Incorrect use of CommonModuleUI component.');
  }

  const presentation = getWidgetPresentation(extension);
  const titleKey =
    presentation.titleKey ?? (extension.name.replace('Module', '') as TranslationKey);
  const title = t(titleKey);

  return (
    <ExtensionPanel
      title={title}
      description={`${t('Captured:')} ${count}`}
      active={!!count && count > 0}
      onClick={toggleShowModal}
      indicatorColor={presentation.indicatorColor}
      panelClass={presentation.panelClass}
    >
      <Modal
        class={
          isViewerFullscreen
            ? 'h-screen max-h-screen max-w-none'
            : 'max-w-4xl md:max-w-screen-md sm:max-w-screen-sm h-[82vh] max-h-[calc(100vh-4rem)]'
        }
        title={title}
        show={showModal}
        fullscreen={isViewerFullscreen}
        onClose={() => {
          setIsViewerFullscreen(false);
          toggleShowModal();
        }}
      >
        <TableView
          title={title}
          extension={extension}
          fullscreen={isViewerFullscreen}
          onFullscreenChange={setIsViewerFullscreen}
        />
      </Modal>
    </ExtensionPanel>
  );
}
