import contract from './search-contract.v1.json';

export const SEARCH_CONTRACT = contract;
export const SEARCH_FIELD_PATH_PATTERN = new RegExp(contract.field_path_pattern);
export const SEARCH_KNOWN_FILTER_KEYS = new Set(contract.known_filter_keys);
export const SEARCH_NON_HIGHLIGHT_FILTERS = new Set(contract.non_highlight_filters);
export const SEARCH_FREE_TEXT = contract.free_text;
export const SEARCH_PREFIX = contract.prefix;
export const SEARCH_FUZZY = contract.fuzzy;
export const SEARCH_FREE_TEXT_STOP_TERMS = new Set(
  (contract.free_text.stop_terms || [])
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean),
);
export const SEARCH_RANKING_DEFAULTS = contract.ranking_defaults;
