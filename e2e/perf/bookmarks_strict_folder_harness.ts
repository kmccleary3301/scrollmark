import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

type TweetRecord = {
  __typename: 'Tweet';
  rest_id: string;
  legacy: {
    id_str: string;
    created_at: string;
    full_text: string;
    favorite_count: number;
    retweet_count: number;
    reply_count: number;
    bookmark_count: number;
    lang: string;
    entities: {
      hashtags: unknown[];
      symbols: unknown[];
      timestamps: unknown[];
      urls: unknown[];
      user_mentions: unknown[];
    };
  };
  core: {
    user_results: {
      result: {
        __typename: 'User';
        rest_id: string;
        core: {
          screen_name: string;
          name: string;
          created_at: string;
        };
        legacy: {
          description: string;
        };
        avatar: {
          image_url: string;
        };
      };
    };
  };
  twe_private_fields?: {
    created_at: number;
    updated_at: number;
    media_count: number;
  };
  __bookmark_folder_id?: string;
  __bookmark_folder_name?: string;
  __bookmark_folder_name_source?: string;
  __bookmark_folder_url?: string;
};

const localStorage = new MemoryStorage();
const hookStats: Record<string, number> = {};
const hookRuntime: Record<string, number> = {};
const locationState = {
  href: 'https://x.com/i/bookmarks',
};
const windowMock = {
  localStorage,
  setTimeout,
  clearTimeout,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  __META_DATA__: { userId: 'bookmarks-strict-folder-harness' },
  location: locationState,
};

Object.assign(globalThis, {
  indexedDB,
  IDBKeyRange,
  localStorage,
  location: locationState,
  self: globalThis,
  window: windowMock,
  unsafeWindow: windowMock,
  __twe_hook_stats_v1: hookStats,
  __twe_runtime_v1: hookRuntime,
});

localStorage.setItem(
  'twe_bookmark_folder_name_cache_v1',
  JSON.stringify([
    ['111', 'Strict Folder'],
    ['222', 'Other Folder'],
  ]),
);
localStorage.setItem('twe_bookmark_strict_folder_id_v1', '111');

const { BookmarksInterceptor } = await import('@/modules/bookmarks/api');
const { ExtensionType } = await import('@/core/extensions/extension');
const { getDatabaseManager } = await import('@/core/database');

const manager = getDatabaseManager();
await manager.whenReady();
await manager.clear();

function makeTweet(id: string): TweetRecord {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      created_at: 'Thu Sep 28 11:07:25 +0000 2023',
      full_text: `Strict folder test tweet ${id}`,
      favorite_count: 1,
      retweet_count: 2,
      reply_count: 3,
      bookmark_count: 4,
      lang: 'en',
      entities: {
        hashtags: [],
        symbols: [],
        timestamps: [],
        urls: [],
        user_mentions: [],
      },
    },
    core: {
      user_results: {
        result: {
          __typename: 'User',
          rest_id: `user-${id}`,
          core: {
            screen_name: `author_${id}`,
            name: `Author ${id}`,
            created_at: 'Thu Sep 28 11:07:25 +0000 2023',
          },
          legacy: {
            description: '',
          },
          avatar: {
            image_url: `https://example.invalid/${id}.jpg`,
          },
        },
      },
    },
  };
}

function makeTimelineResponse(tweet: TweetRecord) {
  return {
    responseText: JSON.stringify({
      data: {
        bookmark_collection_timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    entryId: `tweet-${tweet.rest_id}`,
                    sortIndex: '1',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      __typename: 'TimelineTimelineItem',
                      itemContent: {
                        __typename: 'TimelineTweet',
                        tweet_results: {
                          result: tweet,
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    }),
  } as XMLHttpRequest;
}

function makeRequest(folderId: string | null, tweetId: string) {
  const variables = folderId
    ? encodeURIComponent(JSON.stringify({ bookmark_collection_id: folderId }))
    : '';
  return {
    method: 'GET',
    url: folderId
      ? `https://x.com/i/api/graphql/test/BookmarkFolderTimeline?variables=${variables}`
      : `https://x.com/i/api/graphql/test/Bookmarks`,
    requestId: `request-${tweetId}`,
  };
}

async function waitForCaptureCount(expected: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const count = await manager.extGetCaptureCount('BookmarksModule', ExtensionType.TWEET);
    if (count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for capture count ${expected}`);
}

const extension = { name: 'BookmarksModule' } as never;

locationState.href = 'https://x.com/i/bookmarks';
BookmarksInterceptor(
  makeRequest('222', 'mismatch') as never,
  makeTimelineResponse(makeTweet('mismatch')),
  extension,
);
await waitForCaptureCount(0);

BookmarksInterceptor(
  makeRequest(null, 'missing') as never,
  makeTimelineResponse(makeTweet('missing')),
  extension,
);
await waitForCaptureCount(0);

BookmarksInterceptor(
  makeRequest('111', 'matched') as never,
  makeTimelineResponse(makeTweet('matched')),
  extension,
);
await waitForCaptureCount(1);

const captured = (await manager.extGetTweetsByIds(['matched']))?.[0] as TweetRecord | undefined;
const mismatch = (await manager.extGetTweetsByIds(['mismatch']))?.[0] as TweetRecord | undefined;
const missing = (await manager.extGetTweetsByIds(['missing']))?.[0] as TweetRecord | undefined;
const searchDocs = await manager.extGetSearchDocumentFolderCursorPage('BookmarksModule', {
  type: ExtensionType.TWEET,
  folderId: '111',
  limit: 10,
});

const checks = [
  {
    name: 'strict folder drops mismatched explicit folder request',
    ok:
      !mismatch &&
      hookStats.bookmarkDropsStrictFolderMismatch === 1 &&
      hookRuntime.bookmarkDropsStrictFolderMismatch === 1,
    details: { mismatch: Boolean(mismatch), hookStats, hookRuntime },
  },
  {
    name: 'strict folder drops requests without folder evidence',
    ok:
      !missing &&
      hookStats.bookmarkDropsStrictNoExplicitFolder === 1 &&
      hookRuntime.bookmarkDropsStrictNoExplicitFolder === 1,
    details: { missing: Boolean(missing), hookStats, hookRuntime },
  },
  {
    name: 'strict folder accepts matching request and stamps trusted folder metadata',
    ok:
      captured?.__bookmark_folder_id === '111' &&
      captured?.__bookmark_folder_name === 'Strict Folder' &&
      captured?.__bookmark_folder_name_source === 'api' &&
      captured?.__bookmark_folder_url === 'https://x.com/i/bookmarks/111' &&
      searchDocs.documents.length === 1 &&
      searchDocs.documents[0]?.folder_id === '111' &&
      searchDocs.documents[0]?.folder_name === 'Strict Folder',
    details: { captured, searchDocument: searchDocs.documents[0] },
  },
];

const payload = {
  ok: checks.every((check) => check.ok),
  checks,
};

console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
