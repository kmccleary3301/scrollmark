import {
  SEARCH_FIELD_PATH_PATTERN,
  SEARCH_FUZZY,
  SEARCH_FREE_TEXT,
  SEARCH_FREE_TEXT_STOP_TERMS,
  SEARCH_KNOWN_FILTER_KEYS,
  SEARCH_NON_HIGHLIGHT_FILTERS,
  SEARCH_PREFIX,
} from '@/contracts/search-contract';

export type SearchQueryWarningCode =
  | 'boolean_syntax'
  | 'unsupported_filter'
  | 'unsupported_token'
  | 'invalid_filter_value';

export type SearchQueryWarning = {
  code: SearchQueryWarningCode;
  message: string;
  token?: string;
  severity: 'info' | 'warn';
};

export type SearchOperatorHelpEntry = {
  category: 'lexical' | 'identity' | 'metadata' | 'presence' | 'numeric_date' | 'compatibility';
  syntax: string;
  description: string;
  examples: string[];
  aliases?: string[];
};

export type SearchLexicalToken = {
  kind: 'term' | 'phrase';
  value: string;
  boost: number;
  slop: number;
  field?: string;
  quoted?: boolean;
  prefix?: boolean;
  fuzzy?: boolean;
};

export type SearchLexicalNode =
  | SearchLexicalToken
  | {
      kind: 'op';
      op: 'AND' | 'OR';
      left: SearchLexicalNode;
      right: SearchLexicalNode;
    }
  | {
      kind: 'op';
      op: 'NOT';
      child: SearchLexicalNode;
    };

export type SearchQueryFilter = {
  name: string;
  value: string;
  negated: boolean;
};

export type ParsedSearchQuery = {
  query: string;
  lexicalTokens: Array<
    SearchLexicalToken | { kind: 'op'; op: 'AND' | 'OR' | 'NOT' } | { kind: 'lparen' | 'rparen' }
  >;
  lexicalAst: SearchLexicalNode | null;
  lexicalExpression: string;
  positiveLexicalTokens: SearchLexicalToken[];
  negativeLexicalTokens: SearchLexicalToken[];
  positiveTerms: string[];
  filters: SearchQueryFilter[];
  unsupported: string[];
  orderedTerms: string[];
  highlightTerms: string[];
  warnings: SearchQueryWarning[];
  hasPositiveLexical: boolean;
  filterBooleanSemantics: 'global_and';
};

type RawQueryToken =
  | (SearchLexicalToken & { negated: boolean })
  | { kind: 'op'; op: 'AND' | 'OR' | 'NOT' }
  | { kind: 'lparen' | 'rparen' };

function isRawLexicalToken(
  token: RawQueryToken,
): token is SearchLexicalToken & { negated: boolean } {
  return token.kind === 'term' || token.kind === 'phrase';
}

const TERM_TOKEN_PATTERN = /[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu;
const MAX_HIGHLIGHT_TERMS = 32;
const SEARCH_FREE_TEXT_MIN_CONTENT_TERM_LENGTH = Math.max(
  1,
  Number(SEARCH_FREE_TEXT.min_content_term_length || 2),
);
const SEARCH_FREE_TEXT_FULL_RUN_EXACT_MIN_TERMS = Math.max(
  2,
  Number(SEARCH_FREE_TEXT.full_run_exact_min_terms || 2),
);
const SEARCH_PREFIX_MIN_TERM_LENGTH = Math.max(1, Number(SEARCH_PREFIX.min_term_length || 3));
const SEARCH_FUZZY_MIN_TERM_LENGTH = Math.max(1, Number(SEARCH_FUZZY.min_term_length || 5));

export const SEARCH_OPERATOR_HELP_ENTRIES: SearchOperatorHelpEntry[] = [
  {
    category: 'lexical',
    syntax: 'plain free text',
    description:
      'Unstructured text expands into content-term matches plus boosted adjacent phrase windows; common filler words are deprioritized unless quoted.',
    examples: ['tour guides in France', 'distributed systems design'],
  },
  {
    category: 'lexical',
    syntax: '"exact phrase"~2',
    description: 'Phrase search with optional slop.',
    examples: ['"design system"', '"design system"~2', 'machine^2'],
  },
  {
    category: 'lexical',
    syntax: 'AND / OR / NOT / (...)',
    description: 'Boolean operators with standard precedence and parentheses.',
    examples: [
      'machine OR reliability',
      '(machine OR reliability) AND fragile',
      'machine AND NOT reliability',
    ],
  },
  {
    category: 'identity',
    syntax: 'from: / from_id: / author_id:',
    description: 'Match the author handle or author id.',
    examples: ['from:alice', 'from_id:12345'],
  },
  {
    category: 'identity',
    syntax: '@user',
    description: 'Shorthand for an enforced author constraint, equivalent to from:user.',
    examples: ['@sama', '@openai'],
  },
  {
    category: 'identity',
    syntax: 'to: / to_id: / in_reply_to_id: / id: / conversation_id:',
    description: 'Match reply targets, entity ids, or conversation ids.',
    examples: ['to:alice', 'in_reply_to_id:1888', 'id:1999'],
  },
  {
    category: 'metadata',
    syntax: 'bookmark_folder: / folder:',
    description: 'Match bookmark folder id or folder name.',
    examples: ['bookmark_folder:12345', 'folder:"Design References"'],
  },
  {
    category: 'metadata',
    syntax: 'lang: / route: / source: / card_name:',
    description: 'Match language, route surface, source text, or card name.',
    examples: ['lang:en', 'route:bookmarks', 'source:iphone'],
  },
  {
    category: 'metadata',
    syntax: 'domain: / url:',
    description: 'Match domains or URLs found in tweets.',
    examples: ['domain:github.com', 'url:openai.com'],
  },
  {
    category: 'presence',
    syntax: 'is:',
    description: 'Boolean state filters.',
    examples: ['is:bookmarked', 'is:reply', 'is:verified', 'is:blue_verified'],
  },
  {
    category: 'presence',
    syntax: 'has:',
    description:
      'Presence filters for media, links, mentions, hashtags, cashtags, engagement, and polls.',
    examples: ['has:media', 'has:links', 'has:hashtags', 'has:engagement'],
  },
  {
    category: 'compatibility',
    syntax: 'filter: / include:',
    description: 'Compatibility aliases retained for Twitter-style queries.',
    examples: ['filter:media', 'filter:replies', 'include:nativeretweets'],
  },
  {
    category: 'numeric_date',
    syntax: 'min_likes: / min_retweets: / min_replies: / min_bookmarks:',
    description: 'Numeric threshold filters.',
    examples: ['min_likes:50', 'min_bookmarks:10'],
  },
  {
    category: 'numeric_date',
    syntax: 'since: / until: / since_time: / until_time: / since_id: / max_id:',
    description: 'Date, timestamp, and Snowflake-style boundary filters.',
    examples: ['since:2026-03-01', 'until:2026-03-31', 'since_id:1900'],
  },
  {
    category: 'compatibility',
    syntax: 'mention: / #tag / $symbol',
    description: 'Explicit mention filter plus shorthand hashtag and cashtag filters.',
    examples: ['mention:alice', '#ai', '$tsla'],
  },
  {
    category: 'metadata',
    syntax: 'field:value / field:"quoted phrase"',
    description:
      'Field-scoped lexical search over raw nested paths, including dotted object paths and arrays.',
    examples: [
      'md.collection:B',
      'legacy.entities.hashtags.text:ai',
      'core.user_results.result.legacy.name:"Jane Doe"',
    ],
  },
];

function warning(code: SearchQueryWarningCode, message: string, token = ''): SearchQueryWarning {
  return {
    code,
    message,
    token: token || undefined,
    severity: 'warn',
  };
}

function clampBoost(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.max(0.05, Math.min(100, parsed));
}

function tokenizeText(value: string): string[] {
  if (!value) return [];
  const matches = value.toLowerCase().match(TERM_TOKEN_PATTERN);
  return matches ? matches.map((token) => token.replace(/['’]/g, '')).filter(Boolean) : [];
}

function isLowSignalFreeTextTerm(term: string): boolean {
  const normalized = String(term || '')
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (normalized.length < SEARCH_FREE_TEXT_MIN_CONTENT_TERM_LENGTH) {
    return true;
  }
  return SEARCH_FREE_TEXT_STOP_TERMS.has(normalized);
}

function getFreeTextRunContentTerms(tokens: SearchLexicalToken[]): string[] {
  const allTerms = tokens.flatMap((token) => tokenizeText(token.value));
  const contentTerms = allTerms.filter((term) => !isLowSignalFreeTextTerm(term));
  return contentTerms.length ? contentTerms : allTerms;
}

function getFreeTextRunSingletonTokens(tokens: SearchLexicalToken[]): SearchLexicalToken[] {
  const contentTerms = new Set(getFreeTextRunContentTerms(tokens));
  if (!contentTerms.size) {
    return tokens;
  }
  const filtered = tokens.filter((token) =>
    contentTerms.has(
      String(token.value || '')
        .trim()
        .toLowerCase(),
    ),
  );
  return filtered.length ? filtered : tokens;
}

function countContentTermsInFreeTextWindow(tokens: SearchLexicalToken[]): number {
  let count = 0;
  for (const token of tokens) {
    for (const term of tokenizeText(token.value)) {
      if (!isLowSignalFreeTextTerm(term)) {
        count += 1;
      }
    }
  }
  return count;
}

function normalizeTermValue(value: string): string {
  return tokenizeText(value).join(' ').trim();
}

function roundBoost(value: number): number {
  if (!Number.isFinite(value)) return 1.0;
  return Math.round(value * 100) / 100;
}

function parseNumericSuffix(
  raw: string,
  separator: '^' | '~',
): { base: string; value: string | null } {
  const index = raw.lastIndexOf(separator);
  if (index <= 0) {
    return { base: raw, value: null };
  }
  const candidate = raw.slice(index + 1);
  if (!candidate || !/^\d+(?:\.\d+)?$/.test(candidate)) {
    return { base: raw, value: null };
  }
  return { base: raw.slice(0, index), value: candidate };
}

function tokenizeQuery(query: string): RawQueryToken[] {
  const text = String(query || '');
  const out: RawQueryToken[] = [];
  let index = 0;

  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index] ?? '')) {
      index += 1;
    }
    if (index >= text.length) break;

    const ch = text[index] ?? '';
    if (ch === '(') {
      out.push({ kind: 'lparen' });
      index += 1;
      continue;
    }
    if (ch === ')') {
      out.push({ kind: 'rparen' });
      index += 1;
      continue;
    }

    let negated = false;
    if (ch === '-') {
      negated = true;
      index += 1;
      while (index < text.length && /\s/.test(text[index] ?? '')) {
        index += 1;
      }
      if (index >= text.length) break;
      if ((text[index] ?? '') === '(') {
        out.push({ kind: 'op', op: 'NOT' });
        continue;
      }
    }

    let explicitField: string | undefined;
    const fieldScanStart = index;
    while (index < text.length && /[a-zA-Z0-9_.]/.test(text[index] ?? '')) {
      index += 1;
    }
    if (
      index > fieldScanStart &&
      (text[index] ?? '') === ':' &&
      (text[index + 1] ?? '') === '"' &&
      SEARCH_FIELD_PATH_PATTERN.test(text.slice(fieldScanStart, index))
    ) {
      explicitField = text.slice(fieldScanStart, index);
      index += 1;
    } else {
      index = fieldScanStart;
    }

    if ((text[index] ?? '') === '"') {
      index += 1;
      let buffer = '';
      while (index < text.length) {
        const current = text[index] ?? '';
        if (current === '\\' && index + 1 < text.length) {
          buffer += text[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (current === '"') {
          index += 1;
          break;
        }
        buffer += current;
        index += 1;
      }

      let slop = 0;
      let boost = 1.0;
      if ((text[index] ?? '') === '~') {
        index += 1;
        const start = index;
        while (index < text.length && /\d/.test(text[index] ?? '')) {
          index += 1;
        }
        if (index > start) {
          slop = Math.max(0, Number(text.slice(start, index)) || 0);
        }
      }
      if ((text[index] ?? '') === '^') {
        index += 1;
        const start = index;
        while (index < text.length && /[\d.]/.test(text[index] ?? '')) {
          index += 1;
        }
        if (index > start) {
          boost = clampBoost(text.slice(start, index));
        }
      }

      out.push({
        kind: 'phrase',
        value: buffer.trim(),
        negated,
        boost,
        slop,
        field: explicitField,
        quoted: true,
      });
      continue;
    }

    const start = index;
    while (
      index < text.length &&
      !/\s/.test(text[index] ?? '') &&
      (text[index] ?? '') !== '(' &&
      (text[index] ?? '') !== ')'
    ) {
      index += 1;
    }
    const raw = text.slice(start, index).trim();
    if (!raw) continue;

    const { base: rawBase, value: boostRaw } = parseNumericSuffix(raw, '^');
    const upper = rawBase.toUpperCase();
    if ((upper === 'AND' || upper === 'OR' || upper === 'NOT') && !negated) {
      out.push({ kind: 'op', op: upper });
      continue;
    }

    out.push({
      kind: 'term',
      value: rawBase,
      negated,
      boost: boostRaw ? clampBoost(boostRaw) : 1.0,
      slop: 0,
    });
  }

  return out;
}

function markTerminalLooseQueryToken(query: string, tokens: RawQueryToken[]): void {
  if (!tokens.length) return;
  if (/\s$/.test(String(query || ''))) return;

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token || !isRawLexicalToken(token)) continue;
    if (token.kind !== 'term' || token.field || token.quoted) return;
    const normalized = normalizeTermValue(token.value);
    if (normalized.length >= SEARCH_PREFIX_MIN_TERM_LENGTH) {
      token.prefix = true;
    }
    if (normalized.length >= SEARCH_FUZZY_MIN_TERM_LENGTH) {
      token.fuzzy = true;
    }
    return;
  }
}

function isLexicalOperand(
  token: RawQueryToken | SearchLexicalNode | null | undefined,
): token is SearchLexicalToken {
  if (!token) return false;
  return token.kind === 'term' || token.kind === 'phrase';
}

function buildLexicalAst(
  tokens: Array<
    SearchLexicalToken | { kind: 'op'; op: 'AND' | 'OR' | 'NOT' } | { kind: 'lparen' | 'rparen' }
  >,
): { ast: SearchLexicalNode | null; warnings: SearchQueryWarning[] } {
  const warnings: SearchQueryWarning[] = [];
  if (!tokens.length) {
    return { ast: null, warnings };
  }

  const infix: typeof tokens = [];
  let previous: (typeof tokens)[number] | null = null;
  for (const token of tokens) {
    let needsAnd = false;
    if (previous) {
      const previousIsValue = isLexicalOperand(previous) || previous.kind === 'rparen';
      const currentStartsValue =
        isLexicalOperand(token) ||
        token.kind === 'lparen' ||
        (token.kind === 'op' && token.op === 'NOT');
      if (previousIsValue && currentStartsValue) {
        needsAnd = true;
      }
    }
    if (needsAnd) {
      infix.push({ kind: 'op', op: 'AND' });
    }
    infix.push(token);
    previous = token;
  }

  const precedence = { OR: 1, AND: 2, NOT: 3 } as const;
  const output: typeof tokens = [];
  const stack: Array<(typeof tokens)[number]> = [];

  for (const token of infix) {
    if (isLexicalOperand(token)) {
      output.push(token);
      continue;
    }
    if (token.kind === 'lparen') {
      stack.push(token);
      continue;
    }
    if (token.kind === 'rparen') {
      let foundLParen = false;
      while (stack.length) {
        const top = stack.pop();
        if (!top) break;
        if (top.kind === 'lparen') {
          foundLParen = true;
          break;
        }
        output.push(top);
      }
      if (!foundLParen) {
        warnings.push(warning('boolean_syntax', 'unmatched closing parenthesis in query'));
      }
      continue;
    }
    if (token.kind !== 'op') {
      continue;
    }

    while (stack.length) {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'op') break;
      const shouldPop =
        token.op === 'NOT'
          ? precedence[token.op] < precedence[top.op]
          : precedence[token.op] <= precedence[top.op];
      if (!shouldPop) break;
      output.push(stack.pop() as (typeof tokens)[number]);
    }
    stack.push(token);
  }

  while (stack.length) {
    const top = stack.pop();
    if (!top) break;
    if (top.kind === 'lparen') {
      warnings.push(warning('boolean_syntax', 'unmatched opening parenthesis in query'));
      continue;
    }
    output.push(top);
  }

  const astStack: SearchLexicalNode[] = [];
  for (const token of output) {
    if (isLexicalOperand(token)) {
      astStack.push(token);
      continue;
    }
    if (token.kind !== 'op') continue;

    if (token.op === 'NOT') {
      const child = astStack.pop();
      if (!child) {
        warnings.push(warning('boolean_syntax', 'dangling NOT operator in query', 'NOT'));
        continue;
      }
      astStack.push({ kind: 'op', op: 'NOT', child });
      continue;
    }

    const right = astStack.pop();
    const left = astStack.pop();
    if (!left || !right) {
      warnings.push(warning('boolean_syntax', `dangling ${token.op} operator in query`, token.op));
      continue;
    }
    astStack.push({ kind: 'op', op: token.op, left, right });
  }

  if (astStack.length === 1) {
    return { ast: astStack[0] ?? null, warnings };
  }

  const operands = tokens.filter(isLexicalOperand);
  if (!operands.length) {
    return { ast: null, warnings };
  }

  const firstOperand = operands[0];
  if (!firstOperand) {
    return { ast: null, warnings };
  }
  let fallback: SearchLexicalNode = firstOperand;
  for (let index = 1; index < operands.length; index += 1) {
    const operand = operands[index];
    if (!operand) continue;
    fallback = { kind: 'op', op: 'AND', left: fallback, right: operand };
  }
  warnings.push(
    warning(
      'boolean_syntax',
      'query boolean expression was malformed; fell back to implicit AND between lexical terms',
    ),
  );
  return { ast: fallback, warnings };
}

function collectLexicalTokens(
  node: SearchLexicalNode | null,
  polarity: boolean,
): SearchLexicalToken[] {
  const out: SearchLexicalToken[] = [];

  const walk = (current: SearchLexicalNode | null, currentPolarity: boolean) => {
    if (!current) return;
    if (isLexicalOperand(current)) {
      if (currentPolarity === polarity) {
        out.push(current);
      }
      return;
    }
    if (current.op === 'NOT') {
      walk(current.child, !currentPolarity);
      return;
    }
    walk(current.left, currentPolarity);
    walk(current.right, currentPolarity);
  };

  walk(node, true);
  return out;
}

function collectFlatBooleanChain(
  node: SearchLexicalNode | null,
  op: 'AND' | 'OR',
  out: SearchLexicalNode[],
): void {
  if (!node) return;
  if (!isLexicalOperand(node) && node.op === op) {
    collectFlatBooleanChain(node.left, op, out);
    collectFlatBooleanChain(node.right, op, out);
    return;
  }
  out.push(node);
}

function astToString(node: SearchLexicalNode | null): string {
  if (!node) return '';
  if (isLexicalOperand(node)) {
    let out = node.kind === 'phrase' ? `"${node.value}"` : node.value;
    if (node.prefix) {
      out += '*';
    }
    if (node.kind === 'phrase' && node.slop > 0) {
      out += `~${node.slop}`;
    }
    if (Math.abs(node.boost - 1.0) > 1e-9) {
      out += `^${node.boost}`;
    }
    if (node.field) {
      out = `${node.field}:${out}`;
    }
    return out;
  }
  if (node.op === 'NOT') {
    const child = astToString(node.child);
    return child ? `NOT (${child})` : 'NOT (?)';
  }
  const parts: SearchLexicalNode[] = [];
  collectFlatBooleanChain(node, node.op, parts);
  const rendered = parts
    .map((part) => {
      const text = astToString(part);
      if (!text) return '';
      if (!isLexicalOperand(part) && part.op !== node.op) {
        return `(${text})`;
      }
      return text;
    })
    .filter(Boolean);
  return rendered.join(` ${node.op} `);
}

function isExpandableFreeTextToken(token: SearchLexicalToken): boolean {
  return !token.field && token.kind === 'term' && tokenizeText(token.value).length === 1;
}

function buildExpandedFreeTextRun(tokens: SearchLexicalToken[]): SearchLexicalToken[] {
  if (tokens.length <= 1) {
    return tokens;
  }

  const out: SearchLexicalToken[] = [];
  const seen = new Set<string>();

  const pushUnique = (token: SearchLexicalToken) => {
    const key = `${token.kind}|${token.field || ''}|${token.value}|${token.slop}|${token.boost}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  };

  const phraseBoostForWindow = (window: SearchLexicalToken[], baseBoost: number): number => {
    const averageBoost = window.reduce((sum, token) => sum + token.boost, 0) / window.length;
    return roundBoost(baseBoost * averageBoost);
  };

  for (const token of getFreeTextRunSingletonTokens(tokens)) {
    pushUnique(token);
  }

  for (let index = 0; index <= tokens.length - 2; index += 1) {
    const window = tokens.slice(index, index + 2);
    if (countContentTermsInFreeTextWindow(window) < 2) {
      continue;
    }
    pushUnique({
      kind: 'phrase',
      value: window.map((token) => token.value).join(' '),
      slop: SEARCH_FREE_TEXT.bigram_slop,
      boost: phraseBoostForWindow(window, SEARCH_FREE_TEXT.bigram_boost),
      prefix: !!window[window.length - 1]?.prefix,
      fuzzy: !!window[window.length - 1]?.fuzzy,
    });
  }

  for (let index = 0; index <= tokens.length - 3; index += 1) {
    const window = tokens.slice(index, index + 3);
    if (countContentTermsInFreeTextWindow(window) < 2) {
      continue;
    }
    pushUnique({
      kind: 'phrase',
      value: window.map((token) => token.value).join(' '),
      slop: SEARCH_FREE_TEXT.trigram_slop,
      boost: phraseBoostForWindow(window, SEARCH_FREE_TEXT.trigram_boost),
      prefix: !!window[window.length - 1]?.prefix,
      fuzzy: !!window[window.length - 1]?.fuzzy,
    });
  }

  for (let index = 0; index <= tokens.length - 4; index += 1) {
    const window = tokens.slice(index, index + 4);
    if (countContentTermsInFreeTextWindow(window) < 2) {
      continue;
    }
    pushUnique({
      kind: 'phrase',
      value: window.map((token) => token.value).join(' '),
      slop: SEARCH_FREE_TEXT.fourgram_slop,
      boost: phraseBoostForWindow(window, SEARCH_FREE_TEXT.fourgram_boost),
      prefix: !!window[window.length - 1]?.prefix,
      fuzzy: !!window[window.length - 1]?.fuzzy,
    });
  }

  if (tokens.length >= SEARCH_FREE_TEXT_FULL_RUN_EXACT_MIN_TERMS) {
    pushUnique({
      kind: 'phrase',
      value: tokens.map((token) => token.value).join(' '),
      slop: 0,
      boost: phraseBoostForWindow(tokens, SEARCH_FREE_TEXT.full_run_exact_boost),
      prefix: !!tokens[tokens.length - 1]?.prefix,
      fuzzy: !!tokens[tokens.length - 1]?.fuzzy,
    });
  }

  return out;
}

function pushLexicalTokenRun(
  destination: ParsedSearchQuery['lexicalTokens'],
  pendingTerms: SearchLexicalToken[],
): void {
  if (!pendingTerms.length) return;
  if (pendingTerms.length === 1) {
    destination.push(pendingTerms[0] as SearchLexicalToken);
    pendingTerms.length = 0;
    return;
  }

  const expanded = buildExpandedFreeTextRun(pendingTerms);
  destination.push({ kind: 'lparen' });
  expanded.forEach((token, index) => {
    if (index > 0) {
      destination.push({ kind: 'op', op: 'OR' });
    }
    destination.push(token);
  });
  destination.push({ kind: 'rparen' });
  pendingTerms.length = 0;
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    for (const term of tokenizeText(value)) {
      if (!term || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
    }
  }
  return out;
}

function collectHighlightTerms(
  positiveLexicalTokens: SearchLexicalToken[],
  filters: SearchQueryFilter[],
): string[] {
  const terms = new Set<string>();

  for (const token of positiveLexicalTokens) {
    for (const term of tokenizeText(token.value)) {
      if (term && !isLowSignalFreeTextTerm(term)) {
        terms.add(term);
      }
    }
  }

  for (const filter of filters) {
    if (filter.negated || SEARCH_NON_HIGHLIGHT_FILTERS.has(filter.name)) continue;
    for (const term of tokenizeText(filter.value)) {
      if (term) {
        terms.add(term);
      }
    }
  }

  return [...terms].slice(0, MAX_HIGHLIGHT_TERMS);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const rawTokens = tokenizeQuery(query);
  markTerminalLooseQueryToken(query, rawTokens);
  const filters: SearchQueryFilter[] = [];
  const unsupported: string[] = [];
  const lexicalTokens: ParsedSearchQuery['lexicalTokens'] = [];
  const pendingFreeTextTerms: SearchLexicalToken[] = [];
  const positiveTermSourceValues: string[] = [];
  const orderedTermSourceValues: string[] = [];

  const flushPendingFreeTextTerms = () => {
    if (pendingFreeTextTerms.length) {
      const runTerms = getFreeTextRunContentTerms(pendingFreeTextTerms);
      orderedTermSourceValues.push(...runTerms);
      positiveTermSourceValues.push(...runTerms);
    }
    pushLexicalTokenRun(lexicalTokens, pendingFreeTextTerms);
  };

  for (const token of rawTokens) {
    if (!isRawLexicalToken(token)) {
      flushPendingFreeTextTerms();
      lexicalTokens.push(token);
      continue;
    }

    const rawValue = String(token.value || '').trim();
    if (!rawValue) continue;

    let lexicalKind: SearchLexicalToken['kind'] = token.kind;
    let lexicalValue = rawValue;
    let lexicalField = token.field?.trim();
    let handledAsFilter = false;

    if (token.kind === 'term' && rawValue.startsWith('@') && rawValue.length > 1) {
      const value = normalizeTermValue(rawValue.slice(1));
      if (value) {
        filters.push({ name: 'from', value, negated: token.negated });
        flushPendingFreeTextTerms();
        continue;
      }
    } else if (token.kind === 'term' && rawValue.startsWith('#') && rawValue.length > 1) {
      const value = normalizeTermValue(rawValue.slice(1));
      if (value) {
        filters.push({ name: 'hashtag', value, negated: token.negated });
        lexicalKind = 'term';
        lexicalValue = value;
        handledAsFilter = true;
      }
    } else if (token.kind === 'term' && rawValue.startsWith('$') && rawValue.length > 1) {
      const value = normalizeTermValue(rawValue.slice(1));
      if (value) {
        filters.push({ name: 'cashtag', value, negated: token.negated });
        lexicalKind = 'term';
        lexicalValue = value;
        handledAsFilter = true;
      }
    } else if (token.kind === 'term' && rawValue.includes(':')) {
      const [rawKey, ...rawRest] = rawValue.split(':');
      const key = String(rawKey || '')
        .trim()
        .toLowerCase();
      const value = rawRest.join(':').trim();
      if (SEARCH_KNOWN_FILTER_KEYS.has(key)) {
        if (!value) {
          unsupported.push(rawValue);
          continue;
        }
        filters.push({ name: key, value, negated: token.negated });
        flushPendingFreeTextTerms();
        continue;
      }
      if (key && value && SEARCH_FIELD_PATH_PATTERN.test(key)) {
        lexicalKind = 'term';
        lexicalValue = value;
        lexicalField = key;
      }
    }

    const lexicalToken: SearchLexicalToken = {
      kind: lexicalKind,
      value: lexicalKind === 'term' ? normalizeTermValue(lexicalValue) : lexicalValue.trim(),
      boost: token.boost,
      slop: token.slop,
      field: lexicalField || undefined,
      quoted: !!token.quoted,
      prefix: !!token.prefix,
      fuzzy: !!token.fuzzy,
    };
    if (!lexicalToken.value) {
      continue;
    }
    if (token.negated) {
      flushPendingFreeTextTerms();
      lexicalTokens.push({ kind: 'op', op: 'NOT' });
      lexicalTokens.push(lexicalToken);
      continue;
    }
    if (!handledAsFilter && isExpandableFreeTextToken(lexicalToken)) {
      pendingFreeTextTerms.push(lexicalToken);
      continue;
    }
    flushPendingFreeTextTerms();
    if (!lexicalToken.field) {
      const tokenTerms = tokenizeText(lexicalToken.value);
      orderedTermSourceValues.push(...tokenTerms);
      positiveTermSourceValues.push(...tokenTerms);
    }
    lexicalTokens.push(lexicalToken);
  }

  flushPendingFreeTextTerms();

  const { ast: lexicalAst, warnings } = buildLexicalAst(lexicalTokens);
  const positiveLexicalTokens = collectLexicalTokens(lexicalAst, true);
  const negativeLexicalTokens = collectLexicalTokens(lexicalAst, false);

  const orderedTerms = orderedTermSourceValues.filter(Boolean);
  const positiveTerms = uniqueTerms(positiveTermSourceValues);
  const highlightTerms = collectHighlightTerms(positiveLexicalTokens, filters);
  const unsupportedWarnings = unsupported.map((tokenValue) =>
    warning('unsupported_token', `unsupported token: ${tokenValue}`, tokenValue),
  );

  return {
    query: String(query || ''),
    lexicalTokens,
    lexicalAst,
    lexicalExpression: astToString(lexicalAst),
    positiveLexicalTokens,
    negativeLexicalTokens,
    positiveTerms,
    filters,
    unsupported,
    orderedTerms,
    highlightTerms,
    warnings: [...warnings, ...unsupportedWarnings],
    hasPositiveLexical: positiveLexicalTokens.length > 0,
    filterBooleanSemantics: 'global_and',
  };
}

export function tokenizeSearchText(value: string): string[] {
  return tokenizeText(value);
}
