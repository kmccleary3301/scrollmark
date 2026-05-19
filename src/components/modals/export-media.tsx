import { saveAs } from 'file-saver-es';
import { useSignal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  IconCircleCheck,
  IconCircleDashed,
  IconFileDownload,
  IconHelp,
  IconInfoCircle,
} from '@tabler/icons-preact';

import {
  FileLike,
  ProgressCallback,
  ZipStreamDownloadOptions,
  zipStreamDownload,
} from '@/utils/download';
import { DEFAULT_MEDIA_TYPES, extractMedia, patterns } from '@/utils/media';
import { Modal, MultiSelect } from '@/components/common';
import { options } from '@/core/options';
import { TranslationKey, useTranslation } from '@/i18n';
import { Media, Tweet, User } from '@/types';
import { useSignalState, cx, useToggle } from '@/utils/common';
import logger from '@/utils/logger';
import { ResultSetSnapshot } from '@/utils/result-set';

type ExportMediaModalProps<T> = {
  title: string;
  resultRecords: T[];
  selectedRecords: T[];
  resultSetSnapshot: ResultSetSnapshot;
  selectionMode: 'all' | 'explicit';
  isTweet?: boolean;
  show?: boolean;
  onClose?: () => void;
};

type MediaFilterType = Media['type'] | 'retweet';
type ExportScopeType = 'selected' | 'result_set';

function cloneSnapshotValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON cloning.
    }
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

/**
 * Modal for exporting media.
 */
export function ExportMediaModal<T>({
  title,
  resultRecords,
  selectedRecords,
  resultSetSnapshot,
  selectionMode,
  isTweet,
  show,
  onClose,
}: ExportMediaModalProps<T>) {
  const { t } = useTranslation('exporter');

  const [loading, setLoading] = useSignalState(false);
  const [copied, setCopied] = useSignalState(false);

  const [useAria2Format, toggleUseAria2Format] = useToggle(false);
  const [rateLimitInput, setRateLimitInput] = useState('75');
  const [globalConcurrencyInput, setGlobalConcurrencyInput] = useState('10');
  const [perHostConcurrencyInput, setPerHostConcurrencyInput] = useState('8');
  const [videoConcurrencyInput, setVideoConcurrencyInput] = useState('3');
  const [maxRetriesInput, setMaxRetriesInput] = useState('3');
  const [filenamePattern, setFilenamePattern] = useSignalState(options.get('filenamePattern'));
  const [currentProgress, setCurrentProgress] = useSignalState(0);
  const [totalProgress, setTotalProgress] = useSignalState(0);
  const [zipProgress, setZipProgress] = useSignalState(0);
  const [exportScope, setExportScope] = useSignalState<ExportScopeType>('result_set');
  const [pinnedResultRecords, setPinnedResultRecords] = useState<T[]>([]);
  const [pinnedSelectedRecords, setPinnedSelectedRecords] = useState<T[]>([]);
  const [pinnedResultSetSnapshot, setPinnedResultSetSnapshot] = useState<ResultSetSnapshot | null>(
    null,
  );
  const taskStatusSignal = useSignal<Record<string, number>>({});
  const wasOpenRef = useRef(false);
  const lastProgressPublishRef = useRef(0);

  // Media type filters.
  const [filters, setFilters] = useSignalState<MediaFilterType[]>([
    ...DEFAULT_MEDIA_TYPES,
    ...(isTweet ? ['retweet' as const] : []),
  ]);

  const includeRetweets = filters.includes('retweet');
  const activeRecords = useMemo(
    () => (exportScope === 'selected' ? pinnedSelectedRecords : pinnedResultRecords),
    [exportScope, pinnedResultRecords, pinnedSelectedRecords],
  );
  const mediaList = useMemo(
    () =>
      extractMedia(
        activeRecords as Tweet[] | User[],
        includeRetweets,
        filenamePattern ?? '',
      ).filter((media) => filters.includes(media.type as MediaFilterType)),
    [activeRecords, filters, filenamePattern, includeRetweets],
  );
  const previewMediaList = useMemo(() => mediaList.slice(0, 250), [mediaList]);
  const previewFilenameSet = useMemo(
    () => new Set(previewMediaList.map((media) => media.filename)),
    [previewMediaList],
  );

  useEffect(() => {
    if (!show) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }

    wasOpenRef.current = true;

    setPinnedResultRecords(resultRecords.map((row) => cloneSnapshotValue(row)));
    setPinnedSelectedRecords(selectedRecords.map((row) => cloneSnapshotValue(row)));
    setPinnedResultSetSnapshot({
      ...resultSetSnapshot,
      ids: [...resultSetSnapshot.ids],
      warnings: [...resultSetSnapshot.warnings],
    });
    setExportScope(
      selectedRecords.length > 0 && selectionMode === 'explicit' ? 'selected' : 'result_set',
    );
    setCurrentProgress(0);
    setTotalProgress(0);
    setZipProgress(0);
    taskStatusSignal.value = {};
  }, [
    resultRecords,
    resultSetSnapshot,
    selectedRecords,
    selectionMode,
    setCurrentProgress,
    setExportScope,
    setTotalProgress,
    setZipProgress,
    show,
    taskStatusSignal,
  ]);

  const onProgress: ProgressCallback<FileLike> = (current, total, value) => {
    const now = Date.now();
    if (current === total || now - lastProgressPublishRef.current > 120) {
      lastProgressPublishRef.current = now;
      setCurrentProgress(current);
      setTotalProgress(total);
    }

    if (value?.filename && previewFilenameSet.has(value.filename)) {
      const updated = { ...taskStatusSignal.value, [value.filename]: 100 };
      taskStatusSignal.value = updated;
    }
  };

  const onExport = async () => {
    try {
      const schedulerOptions: ZipStreamDownloadOptions = {
        minDelayBetweenStartsMs: Math.max(0, parseInt(rateLimitInput, 10) || 0),
        globalConcurrency: Math.max(1, parseInt(globalConcurrencyInput, 10) || 1),
        perHostConcurrency: Math.max(1, parseInt(perHostConcurrencyInput, 10) || 1),
        videoConcurrency: Math.max(1, parseInt(videoConcurrencyInput, 10) || 1),
        maxRetries: Math.max(0, parseInt(maxRetriesInput, 10) || 0),
        onZipProgress: (current) => setZipProgress(current),
      };
      setLoading(true);
      lastProgressPublishRef.current = 0;
      setCurrentProgress(0);
      setTotalProgress(mediaList.length);
      setZipProgress(0);
      await zipStreamDownload(
        `twitter-${title}-${exportScope === 'selected' ? 'selected' : 'results'}-${Date.now()}-media.zip`,
        mediaList,
        onProgress,
        schedulerOptions,
      );
      setLoading(false);
    } catch (err) {
      setLoading(false);
      logger.error(t('Failed to export media. Open DevTools for more details.'), err);
    }
  };

  const onCopy = (saveAsFile = false) => {
    const text = mediaList
      .map((media) => (useAria2Format ? `${media.url}\n  out=${media.filename}` : media.url))
      .join('\n');

    try {
      if (saveAsFile) {
        saveAs(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'media-urls.txt');
        return;
      }

      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      logger.error(t('Failed to copy media URLs. Open DevTools for more details.'), err);
    }
  };

  return (
    <Modal
      class="max-w-sm md:max-w-screen-sm sm:max-w-screen-sm max-h-full"
      title={`${title} ${t('Media')}`}
      show={show}
      onClose={onClose}
    >
      {/* Modal content. */}
      <div class="px-4 text-base overflow-y-scroll overscroll-none">
        <p class="text-base-content text-opacity-60 leading-5 text-sm">
          {t(
            'Download and save media files from captured data. This may take a while depending on the amount of data. Media that will be downloaded includes: profile images, profile banners (for users), images, videos (for tweets).',
          )}
        </p>
        <div role="alert" class="alert text-sm py-2 mt-2 mb-2 grid-cols-[auto_minmax(auto,1fr)]">
          <IconInfoCircle size={24} />
          <span>
            {t(
              'Browser ZIP export now uses bounded parallel downloads. For very large video-heavy jobs, URL or aria2 export is still the safest low-memory path.',
            )}
          </span>
        </div>
        {/* Export options. */}
        <div class="flex items-center gap-4 mb-1">
          <p class="leading-8">{t('Export scope:')}</p>
          <label class="label cursor-pointer gap-2 py-0">
            <input
              type="radio"
              name="media-export-scope"
              class="radio radio-sm"
              checked={exportScope === 'result_set'}
              onChange={() => setExportScope('result_set')}
            />
            <span>{t('All current results')}</span>
            <span class="font-mono opacity-60">({pinnedResultRecords.length})</span>
          </label>
          <label
            class={cx(
              'label cursor-pointer gap-2 py-0',
              !pinnedSelectedRecords.length && 'opacity-50',
            )}
          >
            <input
              type="radio"
              name="media-export-scope"
              class="radio radio-sm"
              checked={exportScope === 'selected'}
              disabled={!pinnedSelectedRecords.length}
              onChange={() => setExportScope('selected')}
            />
            <span>{t('Selected rows')}</span>
            <span class="font-mono opacity-60">({pinnedSelectedRecords.length})</span>
          </label>
        </div>
        {pinnedResultSetSnapshot ? (
          <div class="rounded-box-half border border-base-300 bg-base-200/60 px-3 py-2 text-xs leading-5 mb-2">
            <div class="font-semibold">{t('Pinned result set')}</div>
            <div class="font-mono opacity-70">{pinnedResultSetSnapshot.resultSetId}</div>
            <div>
              {t('Query')}:{' '}
              <span class="font-mono">{pinnedResultSetSnapshot.queryText || '-'}</span>
            </div>
            <div>
              {t('Sort')}: <span class="font-mono">{pinnedResultSetSnapshot.sort}</span>
            </div>
          </div>
        ) : null}
        {isTweet && (
          <div class="flex flex-wrap sm:grid grid-cols-4 sm:gap-2 items-center sm:h-9">
            <p class="leading-8">{t('Filename template:')}</p>
            <div
              class="tooltip tooltip-bottom col-span-3 before:whitespace-pre-line before:max-w-max"
              data-tip={Object.entries(patterns)
                .map(([key, value]) => `{${key}} - ${t(value.description as TranslationKey)}`)
                .reduce((acc, cur) => acc + cur + '\n', '')}
            >
              <input
                type="text"
                class="input input-bordered input-sm w-full"
                value={filenamePattern}
                onChange={(e) => {
                  const value = (e?.target as HTMLInputElement)?.value;
                  setFilenamePattern(value);
                  options.set('filenamePattern', value);
                }}
              />
            </div>
          </div>
        )}
        <div class="rounded-box-half border border-base-300 bg-base-200/60 px-3 py-2 mt-2 mb-2">
          <div class="mb-1 flex items-center justify-between gap-2">
            <p class="font-semibold text-sm">{t('Download scheduler')}</p>
            <span class="font-mono text-[10px] opacity-60">
              {t('Faster defaults are intended for bulk CDN transfer.')}
            </span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <label class="form-control">
              <span class="label-text text-xs">{t('Start delay (ms)')}</span>
              <input
                type="number"
                min="0"
                class="input input-bordered input-sm"
                value={rateLimitInput}
                onInput={(e) => setRateLimitInput((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label class="form-control">
              <span class="label-text text-xs">{t('Global parallel')}</span>
              <input
                type="number"
                min="1"
                max="32"
                class="input input-bordered input-sm"
                value={globalConcurrencyInput}
                onInput={(e) =>
                  setGlobalConcurrencyInput((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
            <label class="form-control">
              <span class="label-text text-xs">{t('Per host')}</span>
              <input
                type="number"
                min="1"
                max="32"
                class="input input-bordered input-sm"
                value={perHostConcurrencyInput}
                onInput={(e) =>
                  setPerHostConcurrencyInput((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
            <label class="form-control">
              <span class="label-text text-xs">{t('Videos')}</span>
              <input
                type="number"
                min="1"
                max="16"
                class="input input-bordered input-sm"
                value={videoConcurrencyInput}
                onInput={(e) =>
                  setVideoConcurrencyInput((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
            <label class="form-control">
              <span class="label-text text-xs">{t('Retries')}</span>
              <input
                type="number"
                min="0"
                max="8"
                class="input input-bordered input-sm"
                value={maxRetriesInput}
                onInput={(e) => setMaxRetriesInput((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
          </div>
        </div>
        <div class="flex flex-wrap sm:grid grid-cols-4 sm:gap-2 items-center sm:h-9">
          <p class="leading-8 col-span-1 whitespace-nowrap sm:pl-2">{t('Use aria2 format:')}</p>
          <div class="col-span-1 flex items-center">
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={useAria2Format}
              onChange={toggleUseAria2Format}
            />
            <a
              href="https://aria2.github.io/manual/en/html/aria2c.html#input-file"
              target="_blank"
              rel="noopener noreferrer"
              class="tooltip tooltip-bottom before:max-w-40 ml-1"
              data-tip={t(
                'Click for more information. Each URL will be on a new line, with its filename on the next line. This format is compatible with aria2.',
              )}
            >
              <IconHelp size={20} />
            </a>
          </div>
        </div>
        <div class="flex flex-wrap sm:grid grid-cols-4 sm:gap-2 items-center sm:h-9">
          <p class="leading-8">{t('Media Filter:')}</p>
          <MultiSelect<MediaFilterType>
            class="col-span-3"
            options={[
              { label: t('filter.photo'), value: 'photo' },
              { label: t('filter.video'), value: 'video' },
              { label: t('filter.animated_gif'), value: 'animated_gif' },
              ...(isTweet ? [{ label: t('filter.retweet'), value: 'retweet' as const }] : []),
            ]}
            selected={filters}
            onChange={setFilters}
          />
        </div>
        {/* Media list preview. */}
        <div class="my-3 overflow-x-scroll">
          <table class="table table-xs table-zebra">
            <thead>
              <tr>
                <th></th>
                <th>#</th>
                <th>{t('File Name')}</th>
                <th>{t('Media Type')}</th>
                <th>{t('Download URL')}</th>
              </tr>
            </thead>
            <tbody>
              {previewMediaList.map((media, index) => (
                <tr>
                  <td>
                    {taskStatusSignal.value[media.filename] ? (
                      <IconCircleCheck class="text-success" size={14} />
                    ) : (
                      <IconCircleDashed size={14} />
                    )}
                  </td>
                  <th>{index + 1}</th>
                  <td>{media.filename}</td>
                  <td>{t(`filter.${media.type}` as TranslationKey)}</td>
                  <td>
                    <a
                      class="link whitespace-nowrap"
                      href={media.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {media.url}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {mediaList.length > 250 ? (
            <div class="px-2 py-1 text-xs opacity-60">
              {t('Preview limited to first 250 media items.')}
            </div>
          ) : null}
          {mediaList.length > 0 ? null : (
            <div class="flex items-center justify-center h-28 w-full">
              <p class="text-base-content text-opacity-50">{t('No media selected.')}</p>
            </div>
          )}
        </div>
        {/* Progress bar. */}
        <div class="flex flex-col mt-6">
          <progress
            class="progress progress-secondary w-full"
            value={(currentProgress / (totalProgress || 1)) * 100}
            max="100"
          />
          <span class="text-sm h-4 leading-none mt-2 text-base-content text-opacity-60">
            {zipProgress
              ? `${t('Zipping')}: ${zipProgress}/${mediaList.length}`
              : `${currentProgress}/${mediaList.length}`}
          </span>
        </div>
      </div>
      {/* Action buttons. */}
      <div class="flex space-x-2 mt-2">
        <span class="flex-grow" />
        <button class="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <div class="join">
          <button class="btn join-item pr-2" onClick={() => onCopy()}>
            {copied ? t('Copied!') : t('Copy URLs')}
          </button>
          <button class="btn join-item pl-2" onClick={() => onCopy(true)}>
            <IconFileDownload />
          </button>
        </div>
        <button
          class={cx('btn btn-secondary', (loading || mediaList.length === 0) && 'btn-disabled')}
          onClick={onExport}
          disabled={loading || mediaList.length === 0}
        >
          {loading && <span class="loading loading-spinner" />}
          {t('Start Export')}
        </button>
      </div>
    </Modal>
  );
}
