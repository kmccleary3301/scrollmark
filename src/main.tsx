import { render } from 'preact';
import { App } from './core/app';
import extensions from './core/extensions';
import type { ExtensionConstructor } from './core/extensions';
import { getExtensionManager } from './core/extensions';
import { options } from './core/options';
import { initializePerformanceMonitoring } from './core/perf/metrics';

import BookmarksModule from './modules/bookmarks';
import CommunityMembersModule from './modules/community-members';
import CommunityTimelineModule from './modules/community-timeline';
import DirectMessagesModule from './modules/direct-messages';
import FollowersModule from './modules/followers';
import FollowingModule from './modules/following';
import HomeTimelineModule from './modules/home-timeline';
import InteractionEventsModule from './modules/interaction-events';
import LikesModule from './modules/likes';
import ListMembersModule from './modules/list-members';
import ListSubscribersModule from './modules/list-subscribers';
import ListTimelineModule from './modules/list-timeline';
import LocalSearchModule from './modules/local-search';
import RetweetersModule from './modules/retweeters';
import RuntimeLogsModule from './modules/runtime-logs';
import RawCaptureModule from './modules/raw-capture';
import QuotesModule from './modules/quotes';
import SearchTimelineModule from './modules/search-timeline';
import TweetIndexModule from './modules/tweet-index';
import TweetDetailModule from './modules/tweet-detail';
import UserDetailModule from './modules/user-detail';
import UserMediaModule from './modules/user-media';
import UserTweetsModule from './modules/user-tweets';

import './index.css';

const APP_ROOT_ID = 'twe-root';
const APP_ROOT_MOUNTED_FLAG = '__twe_root_mounted_v1';
const windowScope = globalThis as unknown as Record<string, unknown>;

function isUserscriptOrigin(value: unknown): boolean {
  const text = String(value ?? '');
  return (
    text.includes('Twitter Web Exporter') ||
    text.includes('Twitter%20Web%20Exporter') ||
    text.includes('Scrollmark') ||
    text.includes('twitter-web-exporter') ||
    text.includes('moz-extension://')
  );
}

function installUserscriptErrorGuard() {
  try {
    window.addEventListener(
      'error',
      (event) => {
        try {
          const fromUserscript =
            isUserscriptOrigin(event.filename) ||
            isUserscriptOrigin(event.message) ||
            isUserscriptOrigin((event.error as { stack?: unknown } | null)?.stack);
          if (!fromUserscript) return;
          console.error(
            '[twitter-web-exporter] suppressed global error',
            event.error || event.message,
          );
          event.preventDefault();
          event.stopImmediatePropagation();
        } catch {
          // ignore
        }
      },
      true,
    );
  } catch {
    // ignore
  }

  try {
    window.addEventListener(
      'unhandledrejection',
      (event) => {
        try {
          const reason = event.reason as { stack?: unknown; message?: unknown } | null;
          const fromUserscript =
            isUserscriptOrigin(reason?.stack) ||
            isUserscriptOrigin(reason?.message) ||
            isUserscriptOrigin(reason);
          if (!fromUserscript) return;
          console.error('[twitter-web-exporter] suppressed rejection', reason);
          event.preventDefault();
          event.stopImmediatePropagation();
        } catch {
          // ignore
        }
      },
      true,
    );
  } catch {
    // ignore
  }
}

function safeAddExtension(
  manager: { add: (ctor: ExtensionConstructor) => void },
  ctor: ExtensionConstructor,
) {
  try {
    manager.add(ctor);
  } catch (err) {
    // Never let extension registration throw and break X's app bootstrap.
    console.error('[twitter-web-exporter] Failed to add extension', ctor?.name, err);
  }
}

function mountApp() {
  try {
    const existingRoot = document.getElementById(APP_ROOT_ID) as HTMLDivElement | null;
    if (windowScope[APP_ROOT_MOUNTED_FLAG]) {
      if (existingRoot) {
        return;
      }
      windowScope[APP_ROOT_MOUNTED_FLAG] = false;
    }

    const root = existingRoot ?? document.createElement('div');
    if (!existingRoot) {
      root.id = APP_ROOT_ID;
      document.body.append(root);
    }

    windowScope[APP_ROOT_MOUNTED_FLAG] = true;

    render(<App />, root);
  } catch (err) {
    console.error('[twitter-web-exporter] mountApp failed', err);
  }
}

function bootstrap() {
  installUserscriptErrorGuard();
  initializePerformanceMonitoring();

  try {
    const manager = getExtensionManager();
    safeAddExtension(manager, FollowersModule);
    safeAddExtension(manager, FollowingModule);
    safeAddExtension(manager, UserDetailModule);
    safeAddExtension(manager, ListMembersModule);
    safeAddExtension(manager, ListSubscribersModule);
    safeAddExtension(manager, CommunityMembersModule);
    safeAddExtension(manager, RetweetersModule);
    safeAddExtension(manager, HomeTimelineModule);
    safeAddExtension(manager, ListTimelineModule);
    safeAddExtension(manager, CommunityTimelineModule);
    safeAddExtension(manager, BookmarksModule);
    safeAddExtension(manager, QuotesModule);
    safeAddExtension(manager, LikesModule);
    safeAddExtension(manager, TweetIndexModule);
    safeAddExtension(manager, UserTweetsModule);
    safeAddExtension(manager, UserMediaModule);
    safeAddExtension(manager, TweetDetailModule);
    safeAddExtension(manager, SearchTimelineModule);
    safeAddExtension(manager, InteractionEventsModule);
    if (options.get('directMessagesCaptureEnabled', false)) {
      safeAddExtension(manager, DirectMessagesModule);
    }
    safeAddExtension(manager, LocalSearchModule);
    safeAddExtension(manager, RuntimeLogsModule);
    if (options.get('rawCaptureEnabled', true)) {
      safeAddExtension(manager, RawCaptureModule);
    }
    extensions.start();
  } catch (err) {
    console.error('[twitter-web-exporter] bootstrap failed', err);
    // X can still be initializing while userscript manager injects;
    // retry once shortly before giving up.
    setTimeout(() => {
      try {
        const manager = getExtensionManager();
        safeAddExtension(manager, BookmarksModule);
        extensions.start();
      } catch (retryErr) {
        console.error('[twitter-web-exporter] bootstrap retry failed', retryErr);
      }
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountApp);
  } else {
    mountApp();
  }
}

bootstrap();
