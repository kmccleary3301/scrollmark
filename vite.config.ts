import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

import preact from '@preact/preset-vite';
import monkey from 'vite-plugin-monkey';
import i18nextLoader from 'vite-plugin-i18next-loader';

import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import prefixSelector from 'postcss-prefix-selector';
import remToPx from 'postcss-rem-to-pixel-next';

const isE2EBuild =
  process.env.TWE_BUILD_VARIANT === 'e2e' || process.env.TWE_BUILD_STANDALONE === '1';
const isChromeE2EBuild = process.env.TWE_BUILD_VARIANT === 'chrome-e2e';
const isLocalE2EBuild = isE2EBuild || isChromeE2EBuild;
const localDevUserscriptFileName = isChromeE2EBuild
  ? 'twitter-web-exporter-chrome-e2e.user.js'
  : 'twitter-web-exporter-e2e.user.js';
const localDevUserscriptUrl = `http://localhost:8123/greasemonkey_project/twitter-web-exporter/dist/${localDevUserscriptFileName}`;
const twitterIconPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABmklEQVR4Ae3XA4wcARSA4dq2bUQ1g9pRbVtBzai2otpug9pxUttn2753/3m9Ozq/5NsdvvfGM6VKoshE8/ORFbAMbxCGWHzDHjS2sXxPlM0eKYclGoq3w1eIHVGYikaYg6e4ZppgAgQrVBSvDw+IEylIhSAATUyTHIYgFdsUNnAGosAfDMccLMtOchli4g7quFC8FhIhCsRD8Bk1sxMdgVjwxRyUdtDABIgKH9DQNNEkiB1fMB9VbDSwEKLQJ1S1TFQRXhAHYnADy9ETdTEeotAze7tzNJIhCiRBFLpnq/hmzMR65UkVO2WrgaOQPLLW3u6XPDLAVgOl8R5isEhUtHcSdkEoxEBXnN3ZuuMbxCDDnTVQF52xBcEQHX1BaWcNtDLwMpzg6tNtN0RnD5U8XsviGkQnYWih9CWjNBbDHaJBMsZqec8rjV54B1EoFXO0Fh+DrxCFEjBTTdFy6IvNGu4Hf9FXSdGheAUvjZdgLPajqtp3+jl4jVSIAgHYjRZ6fWC0wSpcwScEQZCMUPzEfezEYJQrVRKFOdIAZGq1QBG8EiYAAAAASUVORK5CYII=';

const userscriptRequire = [
  'https://cdn.jsdelivr.net/npm/dayjs@1.11.13/dayjs.min.js',
  'https://cdn.jsdelivr.net/npm/dexie@4.0.11/dist/dexie.min.js',
  'https://cdn.jsdelivr.net/npm/dexie-export-import@4.1.4/dist/dexie-export-import.js',
  'https://cdn.jsdelivr.net/npm/file-saver-es@2.0.5/dist/FileSaver.min.js',
  'https://cdn.jsdelivr.net/npm/i18next@24.2.3/i18next.min.js',
  'https://cdn.jsdelivr.net/npm/preact@10.26.4/dist/preact.min.js',
  'https://cdn.jsdelivr.net/npm/preact@10.26.4/hooks/dist/hooks.umd.js',
  'https://cdn.jsdelivr.net/npm/@preact/signals-core@1.8.0/dist/signals-core.min.js',
  'https://cdn.jsdelivr.net/npm/@preact/signals@2.0.0/dist/signals.min.js',
  'https://cdn.jsdelivr.net/npm/@tanstack/table-core@8.21.2/build/umd/index.production.js',
];

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    minify: false,
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss(),
        autoprefixer(),
        remToPx({ propList: ['*'] }),
        // Use scoped CSS.
        prefixSelector({
          prefix: '#twe-root',
          exclude: [/^#twe-root/], // This may be a bug.
        }),
      ],
    },
  },
  plugins: [
    preact(),
    i18nextLoader({ paths: ['./src/i18n/locales'], namespaceResolution: 'basename' }),
    monkey({
      entry: 'src/main.tsx',
      userscript: {
        name: {
          '': 'Scrollmark',
          'zh-CN': 'Scrollmark',
          'zh-TW': 'Scrollmark',
          ja: 'Scrollmark',
        },
        description: {
          '': 'Local-first X/Twitter research archive, search, bookmark capture, and portable bundle export by Kyle McCleary.',
          'zh-CN': '本地优先的 X/Twitter 研究归档、搜索、书签采集与可移植 Bundle 导出工具。',
          'zh-TW': '本地優先的 X/Twitter 研究歸檔、搜尋、書籤擷取與可攜式 Bundle 匯出工具。',
          ja: 'ローカルファーストの X/Twitter 研究アーカイブ、検索、ブックマーク取得、ポータブル Bundle 出力ツール。',
        },
        namespace: 'https://github.com/kmccleary3301/scrollmark',
        icon: twitterIconPng,
        match: ['*://twitter.com/*', '*://x.com/*', '*://mobile.x.com/*'],
        grant: ['unsafeWindow', 'GM_xmlhttpRequest'],
        connect: ['cdn.syndication.twimg.com'],
        'run-at': 'document-start',
        // NOTE: X.com currently enforces a strict CSP that can block page-context injection
        // by userscript managers (Violentmonkey inject-into=page). Use content injection
        // and rely on unsafeWindow-based patching instead.
        //
        // If we need true page-context execution again, we likely need a dedicated extension
        // or an injection approach that is not subject to page CSP.
        //
        // 2026-02: We need page-context hooks to avoid Firefox cross-compartment errors
        // when monkeypatching fetch/XHR ("Permission denied to access property length").
        // Violentmonkey can inject into page using extension mechanisms; if CSP blocks in
        // some environments, we can re-introduce a content fallback.
        'inject-into': isE2EBuild ? 'content' : 'page',
        updateURL: isLocalE2EBuild
          ? localDevUserscriptUrl
          : 'https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js',
        downloadURL: isLocalE2EBuild
          ? localDevUserscriptUrl
          : 'https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js',
        ...(isLocalE2EBuild ? {} : { require: userscriptRequire }),
      },
      build: {
        ...(isLocalE2EBuild
          ? {
              fileName: localDevUserscriptFileName,
            }
          : {
              fileName: 'scrollmark.user.js',
              externalGlobals: {
                dayjs: 'dayjs',
                dexie: 'Dexie',
                'dexie-export-import': 'DexieExportImport',
                'file-saver-es': 'FileSaver',
                i18next: 'i18next',
                preact: 'preact',
                'preact/hooks': 'preactHooks',
                '@preact/signals': 'preactSignals',
                '@tanstack/table-core': 'TableCore',
              },
            }),
      },
    }),
  ],
});
