export type SearchHistoryEntry = {
  id: string;
  scope: string;
  title: string;
  query: string;
  normalized_query: string;
  searched_at_ms: number;
  searched_at_iso: string;
  result_count: number;
  total_records: number;
  selected_folders: string[];
  lexical_expression: string;
  warning_messages: string[];
  repeat_count: number;
};

const SEARCH_HISTORY_STORAGE_KEY = 'twe_search_history_v1';
const SEARCH_HISTORY_MAX_ENTRIES = 4000;

function canUseStorage() {
  return typeof localStorage !== 'undefined';
}

function normalizeFolderIds(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function makeEntryIdentity(scope: string, normalizedQuery: string, folderIds: string[]) {
  return `${scope}::${normalizedQuery}::${normalizeFolderIds(folderIds).join(',')}`;
}

export function readSearchHistory(scope?: string): SearchHistoryEntry[] {
  if (!canUseStorage()) return [];
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows = parsed.filter(
      (item): item is SearchHistoryEntry => !!item && typeof item === 'object',
    );
    if (!scope) {
      return rows;
    }
    return rows.filter((row) => row.scope === scope);
  } catch {
    return [];
  }
}

export function appendSearchHistoryEntry(
  entry: Omit<SearchHistoryEntry, 'id' | 'searched_at_iso' | 'repeat_count'>,
): SearchHistoryEntry[] {
  const now = Date.now();
  const nextEntry: SearchHistoryEntry = {
    ...entry,
    selected_folders: normalizeFolderIds(entry.selected_folders),
    id: `${entry.scope}:${now}:${Math.random().toString(36).slice(2, 8)}`,
    searched_at_iso: new Date(now).toISOString(),
    repeat_count: 1,
  };

  const current = readSearchHistory();
  const next = [...current];
  const identity = makeEntryIdentity(
    nextEntry.scope,
    nextEntry.normalized_query,
    nextEntry.selected_folders,
  );
  const last = next[next.length - 1];

  if (last) {
    const lastIdentity = makeEntryIdentity(
      last.scope,
      last.normalized_query,
      last.selected_folders || [],
    );
    if (lastIdentity === identity) {
      next[next.length - 1] = {
        ...last,
        query: nextEntry.query,
        title: nextEntry.title,
        searched_at_ms: nextEntry.searched_at_ms,
        searched_at_iso: nextEntry.searched_at_iso,
        result_count: nextEntry.result_count,
        total_records: nextEntry.total_records,
        lexical_expression: nextEntry.lexical_expression,
        warning_messages: [...nextEntry.warning_messages],
        repeat_count: (last.repeat_count || 1) + 1,
      };
    } else {
      next.push(nextEntry);
    }
  } else {
    next.push(nextEntry);
  }

  const trimmed = next.slice(-SEARCH_HISTORY_MAX_ENTRIES);
  if (canUseStorage()) {
    try {
      localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // ignore storage quota and serialization errors
    }
  }
  return trimmed;
}

export function clearSearchHistory(scope?: string): SearchHistoryEntry[] {
  if (!canUseStorage()) return [];
  const current = readSearchHistory();
  const next = scope ? current.filter((row) => row.scope !== scope) : [];
  try {
    localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
  return next;
}
