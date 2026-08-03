import assert from 'node:assert/strict';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import type Dexie from 'dexie';
import type { Tweet, TweetArticleResult } from '@/types';

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

const localStorage = new MemoryStorage();
const windowMock = {
  localStorage,
  setTimeout,
  clearTimeout,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  __META_DATA__: { userId: 'twitter-article-markdown-harness' },
};

Object.assign(globalThis, {
  indexedDB,
  IDBKeyRange,
  localStorage,
  self: globalThis,
  window: windowMock,
  unsafeWindow: windowMock,
});

const { extractTwitterArticleMarkdown, TWITTER_ARTICLE_MARKDOWN_VERSION } =
  await import('@/utils/twitter-article-markdown');
const { extractTweetFullText, filterEmptyTweet } = await import('@/utils/api');
const { runAdvancedTableSearch } = await import('@/utils/advanced-table-search');
const { DatabaseManager } = await import('@/core/database/manager');
const { ExtensionType } = await import('@/core/extensions/extension');

const article: TweetArticleResult = {
  rest_id: 'article-1',
  title: 'Complete Article Fixture',
  preview_text: 'A short preview that must not replace the complete body.',
  cover_media: {
    media_id: 'cover-1',
    alt_text: 'Article cover',
    media_info: {
      __typename: 'ApiImage',
      original_img_url: 'https://pbs.twimg.com/media/article-cover.jpg',
    },
  },
  media_entities: [
    {
      media_id: 'image-1',
      media_info: {
        __typename: 'ApiImage',
        original_img_url: 'https://pbs.twimg.com/media/article-image.jpg',
      },
    },
    {
      media_id: 'video-1',
      media_info: {
        __typename: 'ApiVideo',
        variants: [
          {
            bit_rate: 256000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/article-low.mp4',
          },
          {
            bit_rate: 2048000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/article-high.mp4',
          },
        ],
      },
    },
  ],
  content_state: {
    blocks: [
      {
        key: 'intro',
        type: 'unstyled',
        text: 'Bold italic linked code and a uniquely searchable tensor phrase.',
        data: {},
        entityRanges: [{ offset: 12, length: 6, key: 0 }],
        inlineStyleRanges: [
          { offset: 0, length: 4, style: 'BOLD' },
          { offset: 5, length: 6, style: 'ITALIC' },
          { offset: 19, length: 4, style: 'CODE' },
        ],
      },
      { key: 'h2', type: 'header-two', text: 'Structured section' },
      { key: 'ul-1', type: 'unordered-list-item', depth: 0, text: 'first bullet' },
      { key: 'ul-2', type: 'unordered-list-item', depth: 1, text: 'nested bullet' },
      { key: 'ol-1', type: 'ordered-list-item', depth: 0, text: 'first ordered item' },
      { key: 'quote', type: 'blockquote', text: 'A quoted warning.' },
      { key: 'code-1', type: 'code-block', text: 'def kernel():', data: { language: 'python' } },
      { key: 'code-2', type: 'code-block', text: '    return 42', data: { language: 'python' } },
      {
        key: 'markdown',
        type: 'atomic',
        text: '',
        entityRanges: [{ offset: 0, length: 0, key: 1 }],
      },
      {
        key: 'media',
        type: 'atomic',
        text: ' ',
        entityRanges: [{ offset: 0, length: 1, key: 2 }],
      },
      {
        key: 'tweet',
        type: 'atomic',
        text: ' ',
        entityRanges: [{ offset: 0, length: 1, key: 3 }],
      },
      { key: 'rule', type: 'horizontal-rule', text: '' },
    ],
    entityMap: [
      {
        key: '0',
        value: {
          type: 'LINK',
          data: { expanded_url: 'https://example.com/reference' },
        },
      },
      {
        key: '1',
        value: {
          type: 'MARKDOWN',
          data: {
            markdown:
              '| Metric | Formula |\n| --- | --- |\n| Energy | $E = mc^2$ |\n\n$$\n\\int_0^1 x^2 dx\n$$',
          },
        },
      },
      {
        key: '2',
        value: {
          type: 'MEDIA',
          data: { mediaItems: [{ mediaId: 'image-1' }, { mediaId: 'video-1' }] },
        },
      },
      {
        key: '3',
        value: { type: 'TWEET', data: { tweetId: '1234567890' } },
      },
    ],
  },
};

const markdown = extractTwitterArticleMarkdown(article);
assert.match(
  markdown,
  /^!\[Article cover\]\(https:\/\/pbs\.twimg\.com\/media\/article-cover\.jpg\)/m,
);
assert.match(markdown, /^# Complete Article Fixture/m);
assert.match(markdown, /\*\*Bold\*\*/);
assert.match(markdown, /\*italic\*/);
assert.match(markdown, /\[linked\]\(https:\/\/example\.com\/reference\)/);
assert.match(markdown, /`code`/);
assert.match(markdown, /## Structured section/);
assert.match(markdown, /- first bullet\n {2}- nested bullet/);
assert.match(markdown, /1\. first ordered item/);
assert.match(markdown, /> A quoted warning\./);
assert.match(markdown, /```python\ndef kernel\(\):\n {4}return 42\n```/);
assert.match(markdown, /\| Metric \| Formula \|/);
assert.match(markdown, /\$E = mc\^2\$/);
assert.match(markdown, /\\int_0\^1 x\^2 dx/);
assert.match(markdown, /!\[\]\(https:\/\/pbs\.twimg\.com\/media\/article-image\.jpg\)/);
assert.match(markdown, /\[video\]\(https:\/\/video\.twimg\.com\/article-high\.mp4\)/);
assert.match(markdown, /> Embedded post: https:\/\/x\.com\/i\/status\/1234567890/);
assert.match(markdown, /^---$/m);

function makeTweet(articleResult: TweetArticleResult): Tweet {
  return {
    __typename: 'Tweet',
    rest_id: '2082921705941651595',
    article: { article_results: { result: articleResult } },
    core: {
      user_results: {
        result: {
          rest_id: 'author-1',
          core: { screen_name: 'article_author', name: 'Article Author' },
        },
      },
    },
    legacy: {
      id_str: '2082921705941651595',
      full_text: 'https://t.co/shortArticleUrl',
      created_at: 'Thu Jul 30 20:10:00 +0000 2026',
      favorite_count: 1,
      retweet_count: 1,
      reply_count: 1,
      bookmark_count: 1,
      quote_count: 1,
      entities: { urls: [], user_mentions: [], hashtags: [], symbols: [], timestamps: [] },
    },
    twe_private_fields: { created_at: 0, updated_at: 0, media_count: 0 },
  } as unknown as Tweet;
}

const richTweet = filterEmptyTweet(makeTweet(article));
assert.ok(richTweet);
assert.equal(
  richTweet.twe_private_fields.article_markdown_version,
  TWITTER_ARTICLE_MARKDOWN_VERSION,
);
assert.equal(extractTweetFullText(richTweet), markdown);
assert.doesNotMatch(extractTweetFullText(richTweet), /^https:\/\/t\.co/);

const searchResult = runAdvancedTableSearch([richTweet], 'uniquely searchable tensor phrase');
assert.equal(searchResult.totalMatches, 1);

const db = new DatabaseManager();
await db.whenReady();
await db.extAddTweets('BookmarksModule', [richTweet]);

const shallowArticle: TweetArticleResult = {
  rest_id: article.rest_id,
  title: article.title,
  preview_text: 'Shallow timeline preview only.',
  content_state: { blocks: [], entityMap: [] },
};
const shallowTweet = filterEmptyTweet(makeTweet(shallowArticle));
assert.ok(shallowTweet);
shallowTweet.legacy.favorite_count = 99;
await db.extAddTweets('BookmarksModule', [shallowTweet]);

const [storedTweet] = await db.extGetTweetsByIds([richTweet.rest_id]);
assert.ok(storedTweet);
assert.equal(storedTweet.legacy.favorite_count, 99);
assert.match(extractTweetFullText(storedTweet), /uniquely searchable tensor phrase/);

const searchDocuments = await db.extGetSearchDocuments('BookmarksModule', ExtensionType.TWEET);
assert.equal(searchDocuments.length, 1);
assert.match(searchDocuments[0]?.primary_text || '', /uniquely searchable tensor phrase/);

(db as unknown as { db: Dexie }).db.close();
console.log('twitter article markdown harness passed');
process.exit(0);
