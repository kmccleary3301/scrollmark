import type { AdvancedTableSearchResult } from '@/utils/advanced-table-search';

export type SearchWorkerRecord = {
  id: string;
  record: unknown;
};

export type SearchWorkerOptions = {
  bookmarkFolderIds?: string[];
  limit?: number;
};

export type SearchWorkerRequest =
  | {
      type: 'search:set-corpus';
      requestId: string;
      scopeKey: string;
      records: SearchWorkerRecord[];
    }
  | {
      type: 'search:query';
      requestId: string;
      scopeKey: string;
      query: string;
      options?: SearchWorkerOptions;
    }
  | {
      type: 'search:cancel';
      requestId: string;
    }
  | {
      type: 'search:dispose';
      requestId: string;
      scopeKey?: string;
    };

export type SearchWorkerResponse =
  | {
      type: 'search:corpus-ready';
      requestId: string;
      scopeKey: string;
      corpusSize: number;
      elapsedMs: number;
    }
  | {
      type: 'search:result';
      requestId: string;
      scopeKey: string;
      query: string;
      ids: string[];
      elapsedMs: number;
      corpusSize: number;
      result: Omit<AdvancedTableSearchResult<unknown>, 'records'>;
    }
  | {
      type: 'search:error';
      requestId: string;
      scopeKey?: string;
      error: string;
      elapsedMs?: number;
    };
