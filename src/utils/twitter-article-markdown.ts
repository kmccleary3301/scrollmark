import type { TweetArticleResult } from '@/types';

type JsonRecord = Record<string, unknown>;

type ArticleEntity = {
  type: string;
  data: JsonRecord;
};

type ArticleMedia = {
  kind: 'image' | 'video';
  url: string;
  altText?: string;
};

type ArticleRange = {
  offset: number;
  length: number;
  key?: string;
  style?: string;
};

export const TWITTER_ARTICLE_MARKDOWN_VERSION = 1;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const normalized: string[] = [];
  let fence: { character: string; length: number } | null = null;

  for (const sourceLine of lines) {
    const fenceMatch = sourceLine.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      normalized.push(sourceLine);
      if (
        fenceMatch &&
        fenceMatch[1]?.startsWith(fence.character) &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    const line = sourceLine.trimEnd();
    if (fenceMatch?.[1]) {
      fence = { character: fenceMatch[1][0] || '`', length: fenceMatch[1].length };
      normalized.push(line);
      continue;
    }
    if (!line.trim() && !normalized.at(-1)?.trim()) continue;
    normalized.push(line);
  }

  while (normalized.length && !normalized[0]?.trim()) normalized.shift();
  while (normalized.length && !normalized.at(-1)?.trim()) normalized.pop();
  return normalized.join('\n');
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function escapeMarkdownTableCell(text: string): string {
  return normalizeInlineText(text).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function escapeLinkDestination(url: string): string {
  return url.replace(/\\/g, '%5C').replace(/\)/g, '\\)');
}

function wrapInlineCode(text: string): string {
  const longestTicks = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longestTicks + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function wrapDomDelimiter(text: string, delimiter: string): string {
  const normalized = normalizeInlineText(text);
  if (!normalized) return '';
  return normalized.startsWith(delimiter) && normalized.endsWith(delimiter)
    ? normalized
    : `${delimiter}${normalized}${delimiter}`;
}

function wrapStyle(text: string, style: string): string {
  if (!text) return '';
  switch (style.toUpperCase()) {
    case 'BOLD':
      return `**${text}**`;
    case 'ITALIC':
      return `*${text}*`;
    case 'STRIKETHROUGH':
    case 'STRIKE':
      return `~~${text}~~`;
    case 'UNDERLINE':
      return `<u>${text}</u>`;
    case 'CODE':
    case 'MONOSPACE':
      return wrapInlineCode(text.replace(/\\([\\`*_[\]<>])/g, '$1'));
    default:
      return text;
  }
}

function normalizeEntityMap(value: unknown): Map<string, ArticleEntity> {
  const entities = new Map<string, ArticleEntity>();

  const add = (key: unknown, rawEntity: unknown) => {
    if ((typeof key !== 'string' && typeof key !== 'number') || !isRecord(rawEntity)) return;
    const type = asString(rawEntity.type).toUpperCase();
    if (!type) return;
    entities.set(String(key), {
      type,
      data: isRecord(rawEntity.data) ? rawEntity.data : {},
    });
  };

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      add(entry.key, entry.value);
    }
    return entities;
  }

  if (isRecord(value)) {
    for (const [key, entity] of Object.entries(value)) {
      add(key, entity);
    }
  }

  return entities;
}

function normalizeRanges(value: unknown, kind: 'entity' | 'style'): ArticleRange[] {
  if (!Array.isArray(value)) return [];
  const ranges: ArticleRange[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const offset = asFiniteNumber(item.offset ?? item.from_index);
    const lengthValue = asFiniteNumber(item.length);
    const toIndex = asFiniteNumber(item.to_index);
    const length = lengthValue ?? (offset !== null && toIndex !== null ? toIndex - offset : null);
    if (offset === null || length === null || offset < 0 || length <= 0) continue;

    if (kind === 'entity') {
      const key = item.key;
      if (typeof key !== 'string' && typeof key !== 'number') continue;
      ranges.push({ offset, length, key: String(key) });
      continue;
    }

    const style = asString(item.style);
    if (!style) continue;
    ranges.push({ offset, length, style });
  }
  return ranges;
}

function readEntityUrl(entity: ArticleEntity | undefined): string {
  if (!entity || entity.type !== 'LINK') return '';
  for (const key of [
    'expanded_url',
    'expandedUrl',
    'original_url',
    'originalUrl',
    'url',
    'display_url',
    'displayUrl',
  ]) {
    const value = asString(entity.data[key]).trim();
    if (value) return value;
  }
  return '';
}

function readEntityMath(entity: ArticleEntity | undefined): string {
  if (!entity || !['MATH', 'LATEX', 'KATEX', 'FORMULA'].includes(entity.type)) return '';
  for (const key of ['latex', 'tex', 'expression', 'formula', 'value', 'text']) {
    const value = asString(entity.data[key]).trim();
    if (value) return value;
  }
  return '';
}

function readEntityMarkdown(entity: ArticleEntity | undefined): string {
  if (!entity || entity.type !== 'MARKDOWN') return '';
  return normalizeMarkdown(asString(entity.data.markdown));
}

function renderInlineText(block: JsonRecord, entities: Map<string, ArticleEntity>): string {
  const text = asString(block.text);
  if (!text) return '';

  const entityRanges = normalizeRanges(block.entityRanges, 'entity');
  const styleRanges = normalizeRanges(block.inlineStyleRanges, 'style');
  const boundaries = new Set<number>([0, text.length]);
  for (const range of [...entityRanges, ...styleRanges]) {
    boundaries.add(Math.min(text.length, range.offset));
    boundaries.add(Math.min(text.length, range.offset + range.length));
  }
  const points = [...boundaries].filter((point) => point >= 0).sort((a, b) => a - b);
  const segments: string[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index] ?? 0;
    const end = points[index + 1] ?? start;
    if (end <= start) continue;
    const source = text.slice(start, end);
    const activeEntityRange = entityRanges.find(
      (range) => range.offset <= start && range.offset + range.length >= end,
    );
    const entity = activeEntityRange?.key ? entities.get(activeEntityRange.key) : undefined;
    const rawMarkdown = readEntityMarkdown(entity);
    if (rawMarkdown) {
      segments.push(rawMarkdown);
      continue;
    }

    const math = readEntityMath(entity);
    if (math) {
      segments.push(`$${math.replace(/\$/g, '\\$')}$`);
      continue;
    }

    let rendered = escapeMarkdownText(source);
    const activeStyles = styleRanges
      .filter((range) => range.offset <= start && range.offset + range.length >= end)
      .map((range) => range.style || '')
      .filter(Boolean)
      .sort();
    for (const style of activeStyles) {
      rendered = wrapStyle(rendered, style);
    }

    const url = readEntityUrl(entity);
    if (url) {
      rendered = `[${rendered || escapeMarkdownText(url)}](${escapeLinkDestination(url)})`;
    }
    segments.push(rendered);
  }

  return segments.join('').trim();
}

function bestVideoUrl(mediaInfo: JsonRecord): string {
  const variants = Array.isArray(mediaInfo.variants) ? mediaInfo.variants : [];
  return (
    variants
      .filter((variant): variant is JsonRecord => isRecord(variant))
      .filter((variant) => asString(variant.content_type).toLowerCase() === 'video/mp4')
      .map((variant) => ({
        url: asString(variant.url).trim(),
        bitrate: Number(variant.bit_rate ?? variant.bitrate ?? 0) || 0,
      }))
      .filter((variant) => !!variant.url)
      .sort((left, right) => right.bitrate - left.bitrate)[0]?.url ?? ''
  );
}

function resolveArticleMedia(rawMedia: unknown): ArticleMedia | null {
  if (!isRecord(rawMedia)) return null;
  const mediaInfo = isRecord(rawMedia.media_info) ? rawMedia.media_info : rawMedia;
  const videoUrl = bestVideoUrl(mediaInfo);
  if (videoUrl) {
    return {
      kind: 'video',
      url: videoUrl,
      altText: asString(rawMedia.alt_text).trim() || undefined,
    };
  }

  const imageUrl = [mediaInfo.original_img_url, mediaInfo.url, rawMedia.media_url_https]
    .map((value) => asString(value).trim())
    .find(Boolean);
  if (!imageUrl) return null;
  return {
    kind: 'image',
    url: imageUrl,
    altText:
      asString(rawMedia.alt_text).trim() || asString(rawMedia.ext_alt_text).trim() || undefined,
  };
}

function renderResolvedMedia(media: ArticleMedia): string {
  const label = escapeMarkdownText(media.altText || '');
  return media.kind === 'image'
    ? `![${label}](${escapeLinkDestination(media.url)})`
    : `[${label || 'video'}](${escapeLinkDestination(media.url)})`;
}

function buildMediaMap(article: TweetArticleResult): Map<string, ArticleMedia> {
  const media = new Map<string, ArticleMedia>();
  const add = (raw: unknown) => {
    if (!isRecord(raw)) return;
    const id = String(raw.media_id ?? raw.id ?? raw.media_key ?? '').trim();
    const resolved = resolveArticleMedia(raw);
    if (id && resolved) media.set(id, resolved);
  };
  for (const item of article.media_entities ?? []) add(item);
  add(article.cover_media);
  return media;
}

function renderMediaEntity(
  entity: ArticleEntity | undefined,
  media: Map<string, ArticleMedia>,
): string {
  if (!entity || entity.type !== 'MEDIA') return '';
  const mediaItems = Array.isArray(entity.data.mediaItems)
    ? entity.data.mediaItems
    : Array.isArray(entity.data.media_items)
      ? entity.data.media_items
      : [];
  const rendered: string[] = [];
  const seen = new Set<string>();
  for (const item of mediaItems) {
    if (!isRecord(item)) continue;
    const id = String(item.mediaId ?? item.media_id ?? item.id ?? '').trim();
    const resolved = media.get(id);
    if (!resolved || seen.has(resolved.url)) continue;
    seen.add(resolved.url);
    rendered.push(renderResolvedMedia(resolved));
  }
  return rendered.join('\n\n');
}

function renderAtomicBlock(
  block: JsonRecord,
  entities: Map<string, ArticleEntity>,
  media: Map<string, ArticleMedia>,
): string {
  const ranges = Array.isArray(block.entityRanges) ? block.entityRanges : [];
  const parts: string[] = [];
  for (const range of ranges) {
    if (!isRecord(range)) continue;
    const key = range.key;
    if (typeof key !== 'string' && typeof key !== 'number') continue;
    const entity = entities.get(String(key));
    const markdown = readEntityMarkdown(entity);
    if (markdown) {
      parts.push(markdown);
      continue;
    }
    const math = readEntityMath(entity);
    if (math) {
      parts.push(`$$\n${math}\n$$`);
      continue;
    }
    const mediaMarkdown = renderMediaEntity(entity, media);
    if (mediaMarkdown) {
      parts.push(mediaMarkdown);
      continue;
    }
    if (entity?.type === 'TWEET') {
      const tweetId = String(entity.data.tweetId ?? entity.data.tweet_id ?? '').trim();
      if (tweetId) {
        parts.push(`> Embedded post: https://x.com/i/status/${tweetId}`);
      }
    }
  }
  return parts.join('\n\n');
}

function codeLanguage(block: JsonRecord): string {
  const data = isRecord(block.data) ? block.data : {};
  return asString(data.language ?? data.lang ?? data.codeLanguage)
    .trim()
    .replace(/[^a-zA-Z0-9_+-]/g, '');
}

function renderArticleBlocks(article: TweetArticleResult): string {
  const contentState = article.content_state;
  const blocks = Array.isArray(contentState?.blocks) ? contentState.blocks : [];
  const entities = normalizeEntityMap(contentState?.entityMap);
  const media = buildMediaMap(article);
  const chunks: string[] = [];
  let listChunk: string[] = [];
  let codeLines: string[] = [];
  let codeLang = '';
  const orderedCounters = new Map<number, number>();

  const flushList = () => {
    if (listChunk.length) chunks.push(listChunk.join('\n'));
    listChunk = [];
    orderedCounters.clear();
  };
  const flushCode = () => {
    if (codeLines.length) chunks.push(`\`\`\`${codeLang}\n${codeLines.join('\n')}\n\`\`\``);
    codeLines = [];
    codeLang = '';
  };

  for (const rawBlock of blocks) {
    if (!isRecord(rawBlock)) continue;
    const type = asString(rawBlock.type).toLowerCase() || 'unstyled';

    if (type === 'code-block') {
      flushList();
      const nextLanguage = codeLanguage(rawBlock);
      if (codeLines.length && nextLanguage && codeLang && nextLanguage !== codeLang) flushCode();
      codeLang ||= nextLanguage;
      codeLines.push(asString(rawBlock.text));
      continue;
    }
    flushCode();

    const isList = type === 'unordered-list-item' || type === 'ordered-list-item';
    if (!isList) flushList();

    if (type === 'atomic') {
      const atomic = renderAtomicBlock(rawBlock, entities, media);
      if (atomic) chunks.push(atomic);
      continue;
    }

    const text = renderInlineText(rawBlock, entities);
    if (!text && !['divider', 'horizontal-rule', 'separator'].includes(type)) continue;

    if (isList) {
      const depth = Math.max(0, Math.floor(Number(rawBlock.depth || 0)));
      const indent = '  '.repeat(depth);
      if (type === 'ordered-list-item') {
        const counter = (orderedCounters.get(depth) || 0) + 1;
        orderedCounters.set(depth, counter);
        listChunk.push(`${indent}${counter}. ${text}`);
      } else {
        listChunk.push(`${indent}- ${text}`);
      }
      continue;
    }

    switch (type) {
      case 'header-one':
        chunks.push(`# ${text}`);
        break;
      case 'header-two':
        chunks.push(`## ${text}`);
        break;
      case 'header-three':
        chunks.push(`### ${text}`);
        break;
      case 'header-four':
        chunks.push(`#### ${text}`);
        break;
      case 'header-five':
        chunks.push(`##### ${text}`);
        break;
      case 'header-six':
        chunks.push(`###### ${text}`);
        break;
      case 'blockquote':
      case 'pullquote':
        chunks.push(
          text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        );
        break;
      case 'divider':
      case 'horizontal-rule':
      case 'separator':
        chunks.push('---');
        break;
      default:
        chunks.push(text);
        break;
    }
  }

  flushCode();
  flushList();
  return normalizeMarkdown(chunks.join('\n\n'));
}

export function extractTwitterArticleMarkdown(article: TweetArticleResult | null): string {
  if (!article) return '';
  const title = normalizeInlineText(asString(article.title));
  const body = renderArticleBlocks(article);
  const cover = resolveArticleMedia(article.cover_media);
  const plainText = normalizeMarkdown(asString(article.plain_text));
  const preview = normalizeMarkdown(asString(article.preview_text));
  const parts: string[] = [];
  if (cover && !body.includes(cover.url)) parts.push(renderResolvedMedia(cover));
  if (title && !body.startsWith(`# ${title}`)) parts.push(`# ${escapeMarkdownText(title)}`);
  if (body) parts.push(body);
  else if (plainText) parts.push(plainText);
  else if (preview && preview !== title) parts.push(preview);
  return normalizeMarkdown(parts.join('\n\n'));
}

function getMathSource(element: Element): string {
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  const candidates = [
    annotation?.textContent,
    element.getAttribute('data-tex'),
    element.getAttribute('data-latex'),
    element.getAttribute('data-math'),
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function isDisplayMath(element: Element): boolean {
  return element.classList.contains('katex-display') || element.getAttribute('display') === 'block';
}

function directChild(element: Element, tagName: string): Element | undefined {
  return [...element.children].find((child) => child.tagName.toLowerCase() === tagName);
}

function renderDomCodeBlock(element: Element): string {
  const pre = element.tagName.toLowerCase() === 'pre' ? element : directChild(element, 'pre');
  if (!pre) return '';
  let language = '';
  if (pre !== element) {
    const candidates = [...element.querySelectorAll('span')]
      .map((span) => normalizeInlineText(span.textContent || ''))
      .filter((value) => /^[a-zA-Z0-9_+-]{1,24}$/.test(value));
    language = candidates[0] || '';
  }
  const code = (pre.textContent || '').replace(/^\n|\n$/g, '');
  const longestFence = Math.max(2, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longestFence + 1);
  return `${fence}${language}\n${code}\n${fence}`;
}

function renderDomTable(table: Element): string {
  const rows = [...table.querySelectorAll('tr')].map((row) =>
    [...row.querySelectorAll(':scope > th, :scope > td')].map((cell) =>
      escapeMarkdownTableCell(renderDomChildren(cell, true)),
    ),
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  if (!width) return '';
  const normalizedRows = rows.map((row) => [
    ...row,
    ...Array.from({ length: Math.max(0, width - row.length) }, () => ''),
  ]);
  const header = normalizedRows[0] || [];
  const body = normalizedRows.slice(1);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function renderDomList(list: Element, depth = 0): string {
  const ordered = list.tagName.toLowerCase() === 'ol';
  const items = [...list.children].filter((child) => child.tagName.toLowerCase() === 'li');
  const lines: string[] = [];
  items.forEach((item, index) => {
    const childLists = [...item.children].filter((child) =>
      ['ul', 'ol'].includes(child.tagName.toLowerCase()),
    );
    const content = [...item.childNodes]
      .filter(
        (node) => !(node instanceof Element && ['ul', 'ol'].includes(node.tagName.toLowerCase())),
      )
      .map((node) => renderDomNode(node, true))
      .join('');
    lines.push(
      `${'  '.repeat(depth)}${ordered ? `${index + 1}.` : '-'} ${normalizeInlineText(content)}`,
    );
    for (const childList of childLists) {
      lines.push(renderDomList(childList, depth + 1));
    }
  });
  return lines.join('\n');
}

function renderDomChildren(element: Element, inline: boolean): string {
  return [...element.childNodes].map((child) => renderDomNode(child, inline)).join('');
}

function renderDomNode(node: Node, inline = false): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    if (!inline && !text.trim()) return '';
    return escapeMarkdownText(text);
  }
  if (!(node instanceof Element)) return '';
  if (node.getAttribute('aria-hidden') === 'true') return '';

  const tag = node.tagName.toLowerCase();
  if (['button', 'script', 'style', 'meta', 'svg', 'noscript'].includes(tag)) return '';

  const math = getMathSource(node);
  if (
    math &&
    (node.classList.contains('katex') || node.classList.contains('katex-display') || tag === 'math')
  ) {
    return isDisplayMath(node) ? `\n\n$$\n${math}\n$$\n\n` : `$${math}$`;
  }

  if (tag === 'div' && directChild(node, 'pre')) return `\n\n${renderDomCodeBlock(node)}\n\n`;
  if (tag === 'pre') return `\n\n${renderDomCodeBlock(node)}\n\n`;
  if (tag === 'table') return `\n\n${renderDomTable(node)}\n\n`;
  if (tag === 'ul' || tag === 'ol') return `\n\n${renderDomList(node)}\n\n`;

  if (tag === 'img') {
    const src = asString(node.getAttribute('src')).trim();
    if (!src || /profile_images|emoji/.test(src)) return '';
    return `![${escapeMarkdownText(node.getAttribute('alt') || '')}](${escapeLinkDestination(src)})`;
  }
  if (tag === 'video') {
    const src = node.getAttribute('src') || node.querySelector('source')?.getAttribute('src') || '';
    return src ? `[video](${escapeLinkDestination(src)})` : '';
  }
  if (tag === 'a') {
    const label = normalizeInlineText(renderDomChildren(node, true));
    const href = asString(node.getAttribute('href')).trim();
    return href ? `[${label || escapeMarkdownText(href)}](${escapeLinkDestination(href)})` : label;
  }
  if (tag === 'code') return wrapInlineCode(normalizeInlineText(node.textContent || ''));
  if (tag === 'strong' || tag === 'b') return wrapDomDelimiter(renderDomChildren(node, true), '**');
  if (tag === 'em' || tag === 'i') return wrapDomDelimiter(renderDomChildren(node, true), '*');
  if (tag === 'del' || tag === 's') return wrapDomDelimiter(renderDomChildren(node, true), '~~');
  if (tag === 'u') return `<u>${normalizeInlineText(renderDomChildren(node, true))}</u>`;
  if (tag === 'mark') return `==${normalizeInlineText(renderDomChildren(node, true))}==`;
  if (tag === 'sup') return `<sup>${normalizeInlineText(renderDomChildren(node, true))}</sup>`;
  if (tag === 'sub') return `<sub>${normalizeInlineText(renderDomChildren(node, true))}</sub>`;
  if (tag === 'br') return inline ? '  \n' : '\n';
  if (tag === 'hr') return '\n\n---\n\n';

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return `\n\n${'#'.repeat(level)} ${normalizeInlineText(renderDomChildren(node, true))}\n\n`;
  }
  if (tag === 'blockquote') {
    const content = normalizeMarkdown(renderDomChildren(node, false));
    return `\n\n${content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\n`;
  }
  if (tag === 'p' || tag === 'figcaption') {
    return `\n\n${normalizeInlineText(renderDomChildren(node, true))}\n\n`;
  }
  if (tag === 'figure') return `\n\n${normalizeMarkdown(renderDomChildren(node, false))}\n\n`;
  if (tag === 'article' && node.hasAttribute('data-tweet-id')) {
    const tweetId = node.getAttribute('data-tweet-id') || '';
    const text = normalizeInlineText(node.textContent || '');
    const lines = text ? text.split('\n').map((line) => `> ${line}`) : [];
    if (tweetId) lines.push(`> https://x.com/i/status/${tweetId}`);
    return `\n\n${lines.join('\n')}\n\n`;
  }

  const content = renderDomChildren(node, inline);
  return inline ? content : `\n\n${content}\n\n`;
}

export function extractTwitterArticleMarkdownFromElement(tweetRoot: HTMLElement): string {
  const heading = tweetRoot.matches('h1') ? tweetRoot : tweetRoot.querySelector('h1');
  const body = heading?.parentElement;
  if (!heading || !body || !tweetRoot.contains(body)) return '';
  const markdown = normalizeMarkdown(renderDomChildren(body, false));
  return markdown;
}
