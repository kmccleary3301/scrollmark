import { Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import {
  IconSettings,
  IconBrandGithubFilled,
  IconHelp,
  IconDatabaseExport,
  IconTrashX,
  IconReportAnalytics,
} from '@tabler/icons-preact';
import { GM_registerMenuCommand } from '$';

import packageJson from '@/../package.json';
import { Modal } from '@/components/common';
import {
  importBundleZip,
  exportCanonicalBundleZip,
  importLegacyBundleFile,
  ImportedBundle,
  ImportedEntitySnapshot,
} from '@/core/bundles';
import { useTranslation, detectBrowserLanguage, LANGUAGES_CONFIG, TranslationKey } from '@/i18n';
import { capitalizeFirstLetter, cx, useToggle } from '@/utils/common';
import { saveFile } from '@/utils/exporter';
import { zipBlobFiles } from '@/utils/download';
import {
  clearDiagnosticBuffers,
  isDiagnosticCaptureEnabled,
  setDiagnosticCaptureEnabled,
} from '@/utils/diagnostics';
import { exportDiagnosticsBundleZip } from '@/modules/runtime-logs/diagnostics-bundle';

import { db } from './database';
import extensionManager, { ExtensionType } from './extensions';
import { DEFAULT_APP_OPTIONS, options, THEMES } from './options';

type BundleModuleManifest = {
  extension: string;
  type: string;
  capture_count: number;
  record_count: number;
  filename: string;
};

function sanitizeFilename(value: string) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

function extractSnapshotText(snapshot: ImportedEntitySnapshot): string {
  const data =
    snapshot.data && typeof snapshot.data === 'object'
      ? (snapshot.data as Record<string, unknown>)
      : {};
  const metadata =
    data.metadata && typeof data.metadata === 'object'
      ? (data.metadata as Record<string, unknown>)
      : {};
  const candidates = [
    data.full_text,
    data.text,
    data.description,
    metadata.legacy && typeof metadata.legacy === 'object'
      ? (metadata.legacy as Record<string, unknown>).full_text
      : undefined,
    data.name,
    data.screen_name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return String(snapshot.search_text || '').slice(0, 240);
}

function safePreviewUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function extractSnapshotMediaUrls(snapshot: ImportedEntitySnapshot): string[] {
  const urls = new Set<string>();
  for (const ref of snapshot.media_refs || []) {
    const preview = safePreviewUrl(ref.previewUrl);
    const url = safePreviewUrl(ref.url);
    if (preview) urls.add(preview);
    if (url) urls.add(url);
  }
  const data =
    snapshot.data && typeof snapshot.data === 'object'
      ? (snapshot.data as Record<string, unknown>)
      : {};
  const media = Array.isArray(data.media) ? data.media : [];
  for (const item of media) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    for (const key of ['thumbnail', 'original', 'url', 'media_url_https']) {
      const value = obj[key];
      const url = safePreviewUrl(value);
      if (url) urls.add(url);
    }
  }
  return [...urls].slice(0, 8);
}

async function yieldToMainThread() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function Settings() {
  const { t, i18n } = useTranslation();

  const currentTheme = useSignal(options.get('theme'));
  const optionsVersion = useSignal(0);
  const [showSettings, toggleSettings] = useToggle(false);
  const [showBundleExport, toggleBundleExport] = useToggle(false);
  const [showBundleLibrary, toggleBundleLibrary] = useToggle(false);
  const [showQcSession, toggleQcSession] = useToggle(false);

  const bundleIncludeDb = useSignal(true);
  const bundleIncludeModules = useSignal(true);
  const bundleBusy = useSignal(false);
  const bundleProgress = useSignal({ current: 0, total: 0 });
  const bundleStatus = useSignal('');
  const bundleResult = useSignal<{
    modules: number;
    files: number;
    skipped: number;
  } | null>(null);
  const bundleLastFilename = useSignal('');
  const bundleLastDownloadUrl = useSignal('');
  const importedBundles = useSignal<ImportedBundle[]>([]);
  const importedBundleSnapshots = useSignal<ImportedEntitySnapshot[]>([]);
  const selectedBundleId = useSignal('');
  const bundleSearchQuery = useSignal('');
  const bundleKindFilter = useSignal<'all' | 'tweet' | 'user' | 'unknown'>('all');
  const bundleLibraryStatus = useSignal('');
  const bundleLibraryBusy = useSignal(false);
  const qcStatus = useSignal('');
  const qcBusy = useSignal(false);
  const qcDiagnosticCaptureEnabled = useSignal(isDiagnosticCaptureEnabled());

  const styles = {
    subtitle: 'mb-2 text-base-content ml-4 opacity-50 font-semibold text-xs',
    block:
      'text-sm mb-2 w-full flex px-4 py-2 text-base-content bg-base-200 rounded-box justify-between',
    item: 'label cursor-pointer flex justify-between h-8 items-center p-0',
    wrapButton:
      'btn btn-xs h-auto min-h-6 max-w-full whitespace-normal break-words text-center leading-tight',
  };

  const onBundleExport = async () => {
    if (bundleBusy.value) {
      return;
    }

    bundleBusy.value = true;
    bundleResult.value = null;
    bundleStatus.value = 'Preparing export...';
    bundleProgress.value = { current: 0, total: 0 };

    const now = Date.now();
    const files: Array<{ filename: string; blob: Blob }> = [];
    const moduleManifest: BundleModuleManifest[] = [];
    let skippedModules = 0;

    try {
      if (bundleIncludeDb.value) {
        bundleStatus.value = 'Exporting DB snapshot...';
        const blob = await db.export();
        if (blob) {
          files.push({
            filename: 'database/twitter-web-exporter-db.json',
            blob,
          });
        }
      }

      if (bundleIncludeModules.value) {
        bundleStatus.value = 'Collecting module exports...';
        const extensions = extensionManager.getExtensions();
        const totalExtensions = extensions.length;

        for (const [index, extension] of extensions.entries()) {
          bundleStatus.value = `Collecting module exports (${index + 1}/${totalExtensions}): ${extension.name}`;
          const captures = (await db.extGetCaptures(extension.name)) ?? [];
          if (!captures.length) {
            skippedModules += 1;
            await yieldToMainThread();
            continue;
          }

          let records: unknown[] = [];
          if (extension.type === ExtensionType.TWEET) {
            records = (await db.extGetCapturedTweets(extension.name, captures)) ?? [];
          } else if (extension.type === ExtensionType.USER) {
            records = (await db.extGetCapturedUsers(extension.name, captures)) ?? [];
          }

          const safeName = sanitizeFilename(extension.name);
          const filename = `modules/${safeName}.json`;
          const payload = {
            extension: extension.name,
            type: extension.type,
            exported_at_ms: now,
            capture_count: captures.length,
            record_count: records.length,
            captures,
            records,
          };

          files.push({
            filename,
            blob: new Blob([JSON.stringify(payload)], {
              type: 'application/json',
            }),
          });

          moduleManifest.push({
            extension: extension.name,
            type: extension.type,
            capture_count: captures.length,
            record_count: records.length,
            filename,
          });

          await yieldToMainThread();
        }
      }

      const manifest = {
        generated_at_ms: now,
        generated_at_iso: new Date(now).toISOString(),
        include_db_snapshot: bundleIncludeDb.value,
        include_module_exports: bundleIncludeModules.value,
        files_total: files.length + 1,
        modules_exported: moduleManifest.length,
        modules_skipped_empty: skippedModules,
        modules: moduleManifest,
      };

      files.unshift({
        filename: 'manifest.json',
        blob: new Blob([JSON.stringify(manifest, undefined, 2)], {
          type: 'application/json',
        }),
      });

      if (!files.length) {
        throw new Error('No files prepared for bundle export.');
      }

      const zipFilename = `twitter-web-exporter-bundle-${now}.zip`;
      bundleStatus.value = 'Creating ZIP...';
      bundleProgress.value = { current: 0, total: files.length };

      const zipBlob = await zipBlobFiles(zipFilename, files, (current, total) => {
        bundleProgress.value = { current, total };
      });

      if (bundleLastDownloadUrl.value) {
        URL.revokeObjectURL(bundleLastDownloadUrl.value);
        bundleLastDownloadUrl.value = '';
      }
      bundleLastFilename.value = zipFilename;
      bundleLastDownloadUrl.value = URL.createObjectURL(zipBlob);

      bundleStatus.value = `Bundle export completed: ${zipFilename}`;
      bundleResult.value = {
        modules: moduleManifest.length,
        files: files.length,
        skipped: skippedModules,
      };
    } catch (err) {
      bundleStatus.value = `Bundle export failed: ${(err as Error)?.message ?? 'Unknown error'}`;
    } finally {
      bundleBusy.value = false;
    }
  };

  const refreshImportedBundles = async () => {
    importedBundles.value = ((await db.bundleList()) ?? []) as ImportedBundle[];
  };

  const onBundleImportFile = async (file: File | null | undefined) => {
    if (!file || bundleLibraryBusy.value) {
      return;
    }
    bundleLibraryBusy.value = true;
    bundleLibraryStatus.value = `Importing ${file.name}...`;
    try {
      const isZip =
        file.name.toLowerCase().endsWith('.zip') ||
        file.type === 'application/zip' ||
        file.type === 'application/x-zip-compressed';
      const result = isZip
        ? await importBundleZip(db, file)
        : await importLegacyBundleFile(db, file);
      bundleLibraryStatus.value = `Imported ${result.recordsImported}/${result.recordsSeen} records from ${file.name}`;
      await refreshImportedBundles();
    } catch (err) {
      bundleLibraryStatus.value = `Import failed: ${(err as Error).message}`;
    } finally {
      bundleLibraryBusy.value = false;
    }
  };

  const loadSelectedBundleSnapshots = async () => {
    if (!selectedBundleId.value) {
      importedBundleSnapshots.value = [];
      return;
    }
    const rows = ((await db.bundleSearchSnapshots(
      selectedBundleId.value,
      bundleSearchQuery.value,
      1000,
    )) ?? []) as ImportedEntitySnapshot[];
    importedBundleSnapshots.value =
      bundleKindFilter.value === 'all'
        ? rows
        : rows.filter((snapshot) => snapshot.kind === bundleKindFilter.value);
  };

  const exportLoadedImportedSnapshots = async () => {
    const bundle = importedBundles.value.find((item) => item.id === selectedBundleId.value);
    if (!bundle || !importedBundleSnapshots.value.length) return;
    await exportCanonicalBundleZip(
      importedBundleSnapshots.value.map((snapshot, index) => ({
        id: snapshot.source_id || snapshot.id || String(index),
        original: snapshot.data,
        record:
          snapshot.data && typeof snapshot.data === 'object'
            ? (snapshot.data as Record<string, unknown>)
            : { value: snapshot.data },
      })),
      {
        title: `${bundle.title}-subset`,
        description: `Re-exported subset from imported bundle ${bundle.id}`,
        scope: 'bundle',
        queryText: bundleSearchQuery.value,
      },
    );
  };

  const exportQcDiagnostics = async () => {
    if (qcBusy.value) return;
    qcBusy.value = true;
    qcStatus.value = 'Preparing QC diagnostics bundle...';
    try {
      await exportDiagnosticsBundleZip();
      qcStatus.value = 'QC diagnostics bundle exported.';
    } catch (err) {
      qcStatus.value = `QC diagnostics export failed: ${(err as Error).message}`;
    } finally {
      qcBusy.value = false;
    }
  };

  useEffect(() => {
    const disposeOptions = options.signal.subscribe(() => {
      optionsVersion.value++;
      currentTheme.value = options.get('theme');
    });

    return () => {
      if (typeof disposeOptions === 'function') {
        disposeOptions();
      }
      if (bundleLastDownloadUrl.value) {
        URL.revokeObjectURL(bundleLastDownloadUrl.value);
      }
    };
  }, []);

  useEffect(() => {
    if (showBundleLibrary) {
      void refreshImportedBundles();
    }
  }, [showBundleLibrary]);

  useEffect(() => {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand(`${t('Version')} ${packageJson.version}`, () => {
        window.open(packageJson.homepage, '_blank');
      });
    }
  }, []);

  return (
    <Fragment>
      {/* Settings button. */}
      <div
        onClick={toggleSettings}
        class="w-9 h-9 mr-2 cursor-pointer flex justify-center items-center transition-colors duration-200 rounded-full hover:bg-base-200"
      >
        <IconSettings />
      </div>
      {/* Settings modal. */}
      <Modal title={t('Settings')} show={showSettings} onClose={toggleSettings} class="max-w-lg">
        {/* Common settings. */}
        <p class={styles.subtitle}>{t('General')}</p>
        <div class={cx(styles.block, 'flex-col')}>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">{t('Theme')}</span>
            <select
              class="select select-xs"
              onChange={(e) => {
                currentTheme.value =
                  (e.target as HTMLSelectElement)?.value ?? DEFAULT_APP_OPTIONS.theme;
                options.set('theme', currentTheme.value);
              }}
            >
              {THEMES.map((theme) => (
                <option key={theme} value={theme} selected={currentTheme.value === theme}>
                  {capitalizeFirstLetter(theme)}
                </option>
              ))}
            </select>
          </label>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">{t('Language')}</span>
            <select
              class="select select-xs"
              onChange={(e) => {
                const language = (e.target as HTMLSelectElement)?.value ?? detectBrowserLanguage();
                i18n.changeLanguage(language);
                options.set('language', language);
              }}
            >
              {Object.entries(LANGUAGES_CONFIG).map(([langTag, langConf]) => (
                <option
                  key={langTag}
                  value={langTag}
                  selected={options.get('language') === langTag}
                >
                  {langConf.nameEn} - {langConf.name}
                </option>
              ))}
            </select>
          </label>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">{t('Debug')}</span>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={options.get('debug')}
              onChange={(e) => {
                options.set('debug', (e.target as HTMLInputElement)?.checked);
              }}
            />
          </label>
          <label class={styles.item}>
            <div class="flex items-center">
              <span class="label-text whitespace-nowrap">Safe mode</span>
              <a
                class="tooltip tooltip-bottom ml-0.5 before:max-w-40"
                data-tip="Disables hook-based capture when enabled. Turn this off for normal browsing and diagnostic capture."
              >
                <IconHelp size={20} />
              </a>
            </div>
            <input
              key={`safe-mode-${optionsVersion.value}`}
              type="checkbox"
              class="toggle toggle-warning"
              checked={options.get('safeMode')}
              onChange={(e) => {
                options.set('safeMode', (e.target as HTMLInputElement)?.checked);
              }}
            />
          </label>
          <label class={styles.item}>
            <div class="flex items-center">
              <span class="label-text whitespace-nowrap">Hook mode</span>
              <a
                class="tooltip tooltip-bottom ml-0.5 before:max-w-40"
                data-tip="Controls whether the userscript hooks XHR, fetch, both, or neither."
              >
                <IconHelp size={20} />
              </a>
            </div>
            <select
              class="select select-xs"
              value={options.get('hookMode')}
              onChange={(e) => {
                options.set(
                  'hookMode',
                  (e.target as HTMLSelectElement)?.value as 'both' | 'xhr' | 'fetch' | 'off',
                );
              }}
            >
              <option value="both">both</option>
              <option value="xhr">xhr</option>
              <option value="fetch">fetch</option>
              <option value="off">off</option>
            </select>
          </label>
          <label class={styles.item}>
            <div class="flex items-center">
              <span class="label-text whitespace-nowrap">Repair mode</span>
              <a
                class="tooltip tooltip-bottom ml-0.5 before:max-w-40"
                data-tip="Controls whether hook repair watchdog behavior is active."
              >
                <IconHelp size={20} />
              </a>
            </div>
            <select
              class="select select-xs"
              value={options.get('repairMode')}
              onChange={(e) => {
                options.set(
                  'repairMode',
                  (e.target as HTMLSelectElement)?.value as 'watchdog' | 'off',
                );
              }}
            >
              <option value="watchdog">watchdog</option>
              <option value="off">off</option>
            </select>
          </label>
          <label class={styles.item}>
            <div class="flex items-center">
              <span class="label-text whitespace-nowrap">{t('Date Time Format')}</span>
              <a
                href="https://day.js.org/docs/en/display/format"
                target="_blank"
                rel="noopener noreferrer"
                class="tooltip tooltip-bottom ml-0.5 before:max-w-40"
                data-tip={t(
                  'Click for more information. This will take effect on both previewer and exported files.',
                )}
              >
                <IconHelp size={20} />
              </a>
            </div>
            <input
              type="text"
              class="input input-bordered input-xs w-48"
              value={options.get('dateTimeFormat')}
              onChange={(e) => {
                options.set('dateTimeFormat', (e.target as HTMLInputElement)?.value);
              }}
            />
          </label>
          {/* Database operations. */}
          <label class={styles.item}>
            <div class="flex items-center">
              <span class="label-text whitespace-nowrap">{t('Use dedicated DB for accounts')}</span>
              <a
                class="tooltip tooltip-bottom ml-0.5 before:max-w-40"
                data-tip={t(
                  'This will create separate database for each Twitter account, which can help reduce the chance of data mixing when you use multiple accounts.',
                )}
              >
                <IconHelp size={20} />
              </a>
            </div>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={options.get('dedicatedDbForAccounts')}
              onChange={(e) => {
                options.set('dedicatedDbForAccounts', (e.target as HTMLInputElement)?.checked);
              }}
            />
          </label>
          <div class="flex w-full flex-col gap-2 py-1">
            <div class="flex items-center justify-between gap-2">
              <span class="label-text whitespace-nowrap">{t('Local Database')}</span>
            </div>
            <div class="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
              <button
                class={cx(styles.wrapButton, 'btn-neutral')}
                onClick={async () => {
                  let storageUsageText = 'Storage usage: N/A';
                  if (typeof navigator.storage.estimate === 'function') {
                    const { quota = 1, usage = 0 } = await navigator.storage.estimate();
                    const usageMB = (usage / 1024 / 1024).toFixed(2);
                    const quotaMB = (quota / 1024 / 1024).toFixed(2);
                    storageUsageText = `Storage usage: ${usageMB}MB / ${quotaMB}MB`;
                  }

                  const count = await db.count();
                  alert(
                    storageUsageText +
                      '\n\nIndexedDB tables count:\n' +
                      JSON.stringify(count, undefined, '  '),
                  );
                }}
              >
                <IconReportAnalytics size={20} />
                {t('Analyze DB')}
              </button>
              <button
                class={cx(styles.wrapButton, 'btn-primary')}
                onClick={async () => {
                  const blob = await db.export();
                  if (blob) {
                    saveFile(`twitter-web-exporter-${Date.now()}.json`, blob);
                  }
                }}
              >
                <IconDatabaseExport size={20} />
                {t('Export DB')}
              </button>
              <button class={cx(styles.wrapButton, 'btn-info')} onClick={toggleBundleExport}>
                <IconDatabaseExport size={20} />
                {t('Bundle Export')}
              </button>
              <button class={cx(styles.wrapButton, 'btn-secondary')} onClick={toggleBundleLibrary}>
                <IconDatabaseExport size={20} />
                {t('Bundle Library')}
              </button>
              <button class={cx(styles.wrapButton, 'btn-accent')} onClick={toggleQcSession}>
                <IconReportAnalytics size={20} />
                {t('QC Session')}
              </button>
              <button
                class={cx(styles.wrapButton, 'btn-warning')}
                onClick={async () => {
                  if (confirm(t('Are you sure to clear all data in the database?'))) {
                    await db.clear();
                  }
                }}
              >
                <IconTrashX size={20} />
                {t('Clear DB')}
              </button>
            </div>
          </div>
        </div>
        {/* Enable or disable modules. */}
        <p class={styles.subtitle}>{t('Modules (Scroll to see more)')}</p>
        <div class={cx(styles.block, 'flex-col', 'max-h-44 overflow-scroll')}>
          {extensionManager.getExtensions().map((extension) => (
            <label class={cx(styles.item, 'flex-shrink-0')} key={extension.name}>
              <span>
                {t(extension.name.replace('Module', '') as TranslationKey)} {t('Module')}
              </span>
              <input
                type="checkbox"
                class="toggle toggle-secondary"
                checked={extension.enabled}
                onChange={() => {
                  if (extension.enabled) {
                    extensionManager.disable(extension.name);
                  } else {
                    extensionManager.enable(extension.name);
                  }
                }}
              />
            </label>
          ))}
        </div>
        {/* Information about this script. */}
        <p class={styles.subtitle}>{t('About')}</p>
        <div class={styles.block}>
          <span class="label-text whitespace-nowrap">
            {t('Version')} {packageJson.version}
          </span>
          <a class="btn btn-xs btn-ghost" target="_blank" href={packageJson.homepage}>
            <IconBrandGithubFilled class="[&>path]:stroke-0" />
            GitHub
          </a>
        </div>
      </Modal>
      <Modal
        title="Bundle Export"
        show={showBundleExport}
        onClose={toggleBundleExport}
        class="max-w-lg"
      >
        <div class="px-4 text-base">
          <p class="text-base-content text-opacity-60 mb-2 leading-5 text-sm">
            Create one ZIP with a DB snapshot and per-module JSON exports.
          </p>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">Include DB snapshot</span>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={bundleIncludeDb.value}
              onChange={(e) => {
                bundleIncludeDb.value = (e.target as HTMLInputElement)?.checked;
              }}
            />
          </label>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">Include module exports</span>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={bundleIncludeModules.value}
              onChange={(e) => {
                bundleIncludeModules.value = (e.target as HTMLInputElement)?.checked;
              }}
            />
          </label>
          <div class="text-xs text-base-content text-opacity-70 mt-2">
            Status: {bundleStatus.value || 'Idle'}
          </div>
          <div class="text-xs text-base-content text-opacity-70">
            Progress: {bundleProgress.value.current}/{bundleProgress.value.total}
          </div>
          {bundleResult.value && (
            <div class="text-xs text-base-content text-opacity-70 mt-1">
              Exported modules: {bundleResult.value.modules} | files: {bundleResult.value.files} |
              skipped empty modules: {bundleResult.value.skipped}
            </div>
          )}
          {bundleLastFilename.value && (
            <div class="text-xs text-base-content text-opacity-70 mt-1 break-all">
              Last ZIP: <code>{bundleLastFilename.value}</code>
            </div>
          )}
          {bundleLastDownloadUrl.value && (
            <div class="text-xs mt-1">
              <a
                class="link link-primary"
                href={bundleLastDownloadUrl.value}
                download={bundleLastFilename.value}
              >
                Download again
              </a>
            </div>
          )}
        </div>
        <div class="flex space-x-2">
          <span class="flex-grow" />
          <button class="btn" onClick={toggleBundleExport}>
            Cancel
          </button>
          <button
            class={cx('btn btn-primary', bundleBusy.value && 'btn-disabled')}
            onClick={onBundleExport}
          >
            {bundleBusy.value && <span class="loading loading-spinner" />}
            Export Bundle ZIP
          </button>
        </div>
      </Modal>
      <Modal
        title="Bundle Library"
        show={showBundleLibrary}
        onClose={toggleBundleLibrary}
        class="max-w-2xl"
      >
        <div class="px-4 text-sm">
          <p class="text-base-content text-opacity-60 mb-3 leading-5">
            Import canonical TWE bundle ZIPs into isolated local bundle tables. Imported bundles do
            not mutate live captures or your X account.
          </p>
          <div class="rounded-box-half border border-base-300 bg-base-200/70 p-3">
            <label class="flex items-center justify-between gap-3">
              <span class="font-semibold">Import bundle ZIP or legacy JSON/JSONL</span>
              <input
                type="file"
                accept=".zip,.json,.jsonl,application/zip,application/json,application/x-ndjson"
                class="file-input file-input-bordered file-input-sm max-w-xs"
                disabled={bundleLibraryBusy.value}
                onChange={(event) => {
                  const input = event.target as HTMLInputElement;
                  void onBundleImportFile(input.files?.[0]);
                  input.value = '';
                }}
              />
            </label>
            <div class="mt-2 font-mono text-xs opacity-70">
              {bundleLibraryBusy.value ? 'busy: ' : ''}
              {bundleLibraryStatus.value || 'Idle'}
            </div>
          </div>
          <div class="mt-3 flex items-center justify-between">
            <h3 class="font-semibold">Imported bundles</h3>
            <button class="btn btn-xs btn-outline" onClick={() => void refreshImportedBundles()}>
              Refresh
            </button>
          </div>
          <div class="mt-2 max-h-80 overflow-y-auto rounded-box-half border border-base-300">
            {importedBundles.value.length ? (
              <table class="table table-sm">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Records</th>
                    <th>Imported</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {importedBundles.value.map((bundle) => (
                    <tr key={bundle.id}>
                      <td>
                        <div class="font-semibold">{bundle.title}</div>
                        <div class="font-mono text-[10px] opacity-60">{bundle.id}</div>
                      </td>
                      <td>
                        <span class="badge badge-sm badge-outline">{bundle.status}</span>
                      </td>
                      <td class="font-mono text-xs">{bundle.recordCount}</td>
                      <td class="font-mono text-xs">
                        {new Date(bundle.importedAt).toLocaleString()}
                      </td>
                      <td>
                        <button
                          class="btn btn-xs btn-primary btn-outline mr-1"
                          onClick={async () => {
                            selectedBundleId.value = bundle.id;
                            bundleSearchQuery.value = '';
                            bundleKindFilter.value = 'all';
                            await loadSelectedBundleSnapshots();
                          }}
                        >
                          View
                        </button>
                        <button
                          class="btn btn-xs btn-error btn-outline"
                          onClick={async () => {
                            if (!confirm(`Delete imported bundle "${bundle.title}"?`)) return;
                            await db.bundleDelete(bundle.id);
                            if (selectedBundleId.value === bundle.id) {
                              selectedBundleId.value = '';
                              importedBundleSnapshots.value = [];
                            }
                            await refreshImportedBundles();
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div class="p-6 text-center text-base-content/50">No imported bundles yet.</div>
            )}
          </div>
          {selectedBundleId.value ? (
            <div class="mt-3 rounded-box-half border border-base-300 bg-base-200/50 p-3">
              <div class="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h3 class="font-semibold">Bundle Viewer</h3>
                  <div class="font-mono text-[10px] opacity-60">{selectedBundleId.value}</div>
                </div>
                <button
                  class="btn btn-xs btn-outline"
                  onClick={() => {
                    selectedBundleId.value = '';
                    importedBundleSnapshots.value = [];
                  }}
                >
                  Close Viewer
                </button>
              </div>
              <label class="input input-bordered input-sm mb-2 flex items-center gap-2">
                <span class="text-xs opacity-60">Search</span>
                <input
                  class="grow bg-transparent"
                  value={bundleSearchQuery.value}
                  onInput={(event) => {
                    bundleSearchQuery.value = (event.target as HTMLInputElement).value;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void loadSelectedBundleSnapshots();
                    }
                  }}
                />
                <button class="btn btn-xs" onClick={() => void loadSelectedBundleSnapshots()}>
                  Run
                </button>
              </label>
              <div class="mb-2 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <select
                    class="select select-bordered select-xs"
                    value={bundleKindFilter.value}
                    onChange={(event) => {
                      bundleKindFilter.value = (event.target as HTMLSelectElement).value as
                        | 'all'
                        | 'tweet'
                        | 'user'
                        | 'unknown';
                      void loadSelectedBundleSnapshots();
                    }}
                  >
                    <option value="all">all kinds</option>
                    <option value="tweet">tweets</option>
                    <option value="user">users</option>
                    <option value="unknown">unknown</option>
                  </select>
                  <span class="font-mono text-xs opacity-70">
                    Showing {importedBundleSnapshots.value.length} snapshots
                  </span>
                </div>
                <button
                  class="btn btn-xs btn-secondary"
                  disabled={!importedBundleSnapshots.value.length}
                  onClick={() => void exportLoadedImportedSnapshots()}
                >
                  Export Loaded Subset
                </button>
              </div>
              <div class="max-h-72 overflow-y-auto rounded-box-half border border-base-300 bg-base-100">
                {importedBundleSnapshots.value.length ? (
                  importedBundleSnapshots.value.map((snapshot) => (
                    <details class="border-b border-base-300 p-2 text-xs" key={snapshot.id}>
                      <summary class="cursor-pointer">
                        <span class="badge badge-xs badge-outline mr-2">{snapshot.kind}</span>
                        <span class="font-mono mr-2">{snapshot.source_id || snapshot.id}</span>
                        <span class="opacity-60">
                          {snapshot.observed_at
                            ? new Date(snapshot.observed_at).toLocaleString()
                            : ''}
                        </span>
                      </summary>
                      <div class="mt-2 rounded bg-base-100 p-2">
                        <p class="whitespace-pre-wrap text-sm leading-5">
                          {extractSnapshotText(snapshot) || '(no text preview)'}
                        </p>
                        {extractSnapshotMediaUrls(snapshot).length ? (
                          <div class="mt-2 grid grid-cols-4 gap-2">
                            {extractSnapshotMediaUrls(snapshot).map((url) => (
                              <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                                {url.includes('.mp4') ? (
                                  <video src={url} class="h-20 w-full rounded object-cover" />
                                ) : (
                                  <img
                                    src={url}
                                    class="h-20 w-full rounded object-cover"
                                    loading="lazy"
                                  />
                                )}
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <pre class="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-base-200 p-2 text-[10px] leading-4">
                        {JSON.stringify(snapshot.data, null, 2)}
                      </pre>
                    </details>
                  ))
                ) : (
                  <div class="p-6 text-center text-base-content/50">No snapshots loaded.</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
        <div class="flex space-x-2">
          <span class="flex-grow" />
          <button class="btn" onClick={toggleBundleLibrary}>
            Close
          </button>
        </div>
      </Modal>
      <Modal
        title="Unified QC Session"
        show={showQcSession}
        onClose={toggleQcSession}
        class="max-w-3xl"
      >
        <div class="px-4 text-sm">
          <p class="mb-3 text-base-content/70">
            Use this single session to QC Bundle Library, core release workflows, and Firefox/Chrome
            parity. Run Firefox first, export diagnostics, then repeat the browser parity subset in
            Chrome and export diagnostics again.
          </p>
          <div class="grid gap-3 md:grid-cols-2">
            <section class="rounded-box-half border border-base-300 bg-base-200/60 p-3">
              <h3 class="mb-2 font-semibold">Preparation</h3>
              <ol class="list-decimal space-y-1 pl-5 text-xs leading-5">
                <li>Install the current local userscript in Firefox.</li>
                <li>Open Settings and set Safe mode off, Hook mode both, Repair mode watchdog.</li>
                <li>Enable Diagnostic capture below.</li>
                <li>Browse X normally long enough to confirm counters increment.</li>
                <li>Repeat the parity subset in Chrome after Firefox is complete.</li>
              </ol>
            </section>
            <section class="rounded-box-half border border-base-300 bg-base-200/60 p-3">
              <h3 class="mb-2 font-semibold">Bundle Library</h3>
              <ol class="list-decimal space-y-1 pl-5 text-xs leading-5">
                <li>Export a filtered result set with Export Data {'->'} Export Bundle ZIP.</li>
                <li>Import that ZIP through Settings {'->'} Bundle Library.</li>
                <li>Search exact text from one imported row.</li>
                <li>Filter by tweets/users, inspect text/media/raw JSON.</li>
                <li>Export Loaded Subset, then import that subset ZIP.</li>
                <li>Import the legacy and malicious fixtures from e2e/fixtures/bundles.</li>
              </ol>
            </section>
            <section class="rounded-box-half border border-base-300 bg-base-200/60 p-3">
              <h3 class="mb-2 font-semibold">Core Release Smoke</h3>
              <ol class="list-decimal space-y-1 pl-5 text-xs leading-5">
                <li>Bookmarks folder scroll indexes rows and folder metadata.</li>
                <li>Bookmark-from-feed increments and later resolves folder details.</li>
                <li>Search exact snippets and phrases rank correctly enough for QC.</li>
                <li>Table fullscreen and masonry scrolling remain stable.</li>
                <li>Export Data and Export Media complete without browser freeze.</li>
              </ol>
            </section>
            <section class="rounded-box-half border border-base-300 bg-base-200/60 p-3">
              <h3 class="mb-2 font-semibold">Chrome Parity</h3>
              <ol class="list-decimal space-y-1 pl-5 text-xs leading-5">
                <li>Install in Chrome userscript manager.</li>
                <li>Confirm widget loads on x.com and settings toggles work.</li>
                <li>Confirm hooks/counters increment with Safe mode off.</li>
                <li>Run Bundle ZIP export/import and legacy import.</li>
                <li>Run one media export and one diagnostics export.</li>
                <li>Record any Chrome-only console errors or CSP differences.</li>
              </ol>
            </section>
          </div>
          <div class="mt-3 rounded-box-half border border-base-300 bg-base-100 p-3">
            <div class="grid min-w-0 grid-cols-2 items-center gap-2">
              <label class="label min-w-0 cursor-pointer gap-2 py-0">
                <span class="text-xs">{t('Diagnostic capture')}</span>
                <input
                  type="checkbox"
                  class="toggle toggle-sm"
                  checked={qcDiagnosticCaptureEnabled.value}
                  onChange={(event) => {
                    const next = (event.target as HTMLInputElement).checked;
                    setDiagnosticCaptureEnabled(next);
                    qcDiagnosticCaptureEnabled.value = next;
                  }}
                />
              </label>
              <button
                class={cx(styles.wrapButton, 'btn-outline')}
                onClick={() => {
                  clearDiagnosticBuffers();
                  qcStatus.value = t('Diagnostic buffers cleared.');
                }}
              >
                {t('Clear Buffers')}
              </button>
              <button
                class={cx(styles.wrapButton, 'btn-primary col-span-2')}
                disabled={qcBusy.value}
                onClick={exportQcDiagnostics}
              >
                {qcBusy.value ? t('Preparing...') : t('Export QC Diagnostics')}
              </button>
            </div>
            <div class="mt-2 font-mono text-xs opacity-70">{qcStatus.value || t('QC idle.')}</div>
            <div class="mt-2 text-xs opacity-70">
              Full runbook: <code>docs/release/unified-qc-session-runbook.md</code>
            </div>
          </div>
        </div>
        <div class="flex space-x-2">
          <span class="flex-grow" />
          <button class="btn" onClick={toggleQcSession}>
            Close
          </button>
        </div>
      </Modal>
    </Fragment>
  );
}
