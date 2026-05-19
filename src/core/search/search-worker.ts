import {
  prepareAdvancedTableSearchCorpus,
  runAdvancedTableSearchPrepared,
  type PreparedAdvancedTableSearchCorpus,
} from '@/utils/advanced-table-search';
import type { SearchWorkerRecord, SearchWorkerRequest, SearchWorkerResponse } from './contracts';
import { nowMs } from '@/core/perf/metrics';

type SearchCorpus = {
  rows: SearchWorkerRecord[];
  prepared: PreparedAdvancedTableSearchCorpus<unknown>;
  idByRecord: Map<unknown, string>;
};

const corpora = new Map<string, SearchCorpus>();
const cancelledRequests = new Set<string>();

function post(message: SearchWorkerResponse): void {
  self.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildCorpus(scopeKey: string, rows: SearchWorkerRecord[]): SearchCorpus {
  const records = rows.map((row) => row.record);
  const idByRecord = new Map<unknown, string>();
  rows.forEach((row, index) => {
    idByRecord.set(row.record, row.id || `row-${index}`);
  });
  return {
    rows,
    prepared: prepareAdvancedTableSearchCorpus(records),
    idByRecord,
  };
}

self.onmessage = (event: MessageEvent<SearchWorkerRequest>) => {
  const request = event.data;
  if (!request || typeof request !== 'object') return;

  if (request.type === 'search:cancel') {
    cancelledRequests.add(request.requestId);
    return;
  }

  if (request.type === 'search:dispose') {
    if (request.scopeKey) {
      corpora.delete(request.scopeKey);
    } else {
      corpora.clear();
    }
    cancelledRequests.delete(request.requestId);
    return;
  }

  const start = nowMs();
  try {
    if (request.type === 'search:set-corpus') {
      const corpus = buildCorpus(request.scopeKey, request.records || []);
      corpora.set(request.scopeKey, corpus);
      post({
        type: 'search:corpus-ready',
        requestId: request.requestId,
        scopeKey: request.scopeKey,
        corpusSize: corpus.rows.length,
        elapsedMs: nowMs() - start,
      });
      return;
    }

    if (request.type === 'search:query') {
      const corpus = corpora.get(request.scopeKey);
      if (!corpus) {
        post({
          type: 'search:error',
          requestId: request.requestId,
          scopeKey: request.scopeKey,
          error: `Search corpus not ready for scope: ${request.scopeKey}`,
          elapsedMs: nowMs() - start,
        });
        return;
      }

      if (cancelledRequests.has(request.requestId)) {
        cancelledRequests.delete(request.requestId);
        return;
      }

      const result = runAdvancedTableSearchPrepared(
        corpus.prepared,
        request.query,
        request.options,
      );
      if (cancelledRequests.has(request.requestId)) {
        cancelledRequests.delete(request.requestId);
        return;
      }

      const ids = result.records.map((record, index) => {
        return corpus.idByRecord.get(record) || corpus.rows[index]?.id || `row-${index}`;
      });
      post({
        type: 'search:result',
        requestId: request.requestId,
        scopeKey: request.scopeKey,
        query: request.query,
        ids,
        elapsedMs: nowMs() - start,
        corpusSize: corpus.rows.length,
        result: {
          highlightTerms: result.highlightTerms,
          totalMatches: result.totalMatches,
          warnings: result.warnings,
          warningObjects: result.warningObjects,
          parsed: result.parsed,
        },
      });
    }
  } catch (error) {
    post({
      type: 'search:error',
      requestId: request.requestId,
      scopeKey: 'scopeKey' in request ? request.scopeKey : undefined,
      error: errorMessage(error),
      elapsedMs: nowMs() - start,
    });
  }
};
