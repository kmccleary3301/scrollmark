import SearchWorkerCtor from './search-worker?worker&inline';
import {
  incrementPerfCounter,
  nowMs,
  recordPerfMetric,
  setWorkerAvailability,
} from '@/core/perf/metrics';
import type {
  SearchWorkerRecord,
  SearchWorkerRequest,
  SearchWorkerResponse,
  SearchWorkerOptions,
} from './contracts';

export type SearchClientQueryResult = Extract<SearchWorkerResponse, { type: 'search:result' }>;

type PendingRequest = {
  resolve: (value: SearchWorkerResponse) => void;
  reject: (error: Error) => void;
  startedAt: number;
};

const QUERY_REQUEST_DELAY_KEY = 'twe_search_worker_request_delay_ms_v1';
const MAX_DIAGNOSTIC_QUERY_DELAY_MS = 5000;

function createRequestId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readDiagnosticQueryRequestDelayMs(message: SearchWorkerRequest): number {
  if (message.type !== 'search:query') return 0;
  try {
    if (typeof localStorage === 'undefined') return 0;
    const rawValue = localStorage.getItem(QUERY_REQUEST_DELAY_KEY);
    if (!rawValue) return 0;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(MAX_DIAGNOSTIC_QUERY_DELAY_MS, Math.floor(value));
  } catch {
    return 0;
  }
}

export class SearchWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private available = false;

  constructor() {
    try {
      this.worker = new SearchWorkerCtor();
      this.worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) =>
        this.handleMessage(event.data);
      this.worker.onerror = (event) => {
        setWorkerAvailability('search', false);
        incrementPerfCounter('search:worker:error');
        for (const [requestId, pending] of this.pending) {
          pending.reject(new Error(event.message || `Search worker error: ${requestId}`));
        }
        this.pending.clear();
      };
      this.available = true;
      setWorkerAvailability('search', true);
    } catch (error) {
      this.worker = null;
      this.available = false;
      setWorkerAvailability('search', false);
      recordPerfMetric({
        kind: 'worker',
        name: 'search-create-failed',
        tags: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  isAvailable(): boolean {
    return this.available && !!this.worker;
  }

  async setCorpus(scopeKey: string, records: SearchWorkerRecord[]): Promise<SearchWorkerResponse> {
    const requestId = createRequestId('corpus');
    return this.request({ type: 'search:set-corpus', requestId, scopeKey, records });
  }

  beginCorpus(args: { scopeKey: string; requestId: string; expectedCount?: number }): void {
    if (!this.worker) return;
    this.worker.postMessage({
      type: 'search:begin-corpus',
      requestId: args.requestId,
      scopeKey: args.scopeKey,
      expectedCount: args.expectedCount,
    } satisfies SearchWorkerRequest);
  }

  appendCorpus(args: { scopeKey: string; requestId: string; records: SearchWorkerRecord[] }): void {
    if (!this.worker) return;
    this.worker.postMessage({
      type: 'search:append-corpus',
      requestId: args.requestId,
      scopeKey: args.scopeKey,
      records: args.records,
    } satisfies SearchWorkerRequest);
  }

  async commitCorpus(scopeKey: string, requestId: string): Promise<SearchWorkerResponse> {
    return this.request({ type: 'search:commit-corpus', requestId, scopeKey });
  }

  async query(args: {
    scopeKey: string;
    query: string;
    options?: SearchWorkerOptions;
    requestId?: string;
  }): Promise<SearchClientQueryResult> {
    const requestId = args.requestId || createRequestId('query');
    const response = await this.request({
      type: 'search:query',
      requestId,
      scopeKey: args.scopeKey,
      query: args.query,
      options: args.options,
    });
    if (response.type === 'search:result') return response;
    if (response.type === 'search:error') throw new Error(response.error);
    throw new Error(`Unexpected search worker response: ${response.type}`);
  }

  cancel(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending) {
      pending.reject(new Error(`Search request cancelled: ${requestId}`));
      this.pending.delete(requestId);
    }
    if (!this.worker) return;
    this.worker.postMessage({ type: 'search:cancel', requestId } satisfies SearchWorkerRequest);
    incrementPerfCounter('search:cancelled');
    recordPerfMetric({
      kind: 'search',
      name: 'query-cancel',
      tags: { requestId, pending: Boolean(pending) },
    });
  }

  dispose(): void {
    for (const [requestId, pending] of this.pending) {
      pending.reject(new Error(`Search worker disposed: ${requestId}`));
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.available = false;
  }

  private request(message: SearchWorkerRequest): Promise<SearchWorkerResponse> {
    if (!this.worker) {
      return Promise.reject(new Error('Search worker unavailable'));
    }
    const startedAt = nowMs();
    const diagnosticDelayMs = readDiagnosticQueryRequestDelayMs(message);
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, { resolve, reject, startedAt });
      const postRequest = () => {
        if (!this.pending.has(message.requestId)) {
          if (diagnosticDelayMs > 0) {
            recordPerfMetric({
              kind: 'search',
              name: 'delayed-query-cancelled-before-post',
              value: diagnosticDelayMs,
              tags: { requestId: message.requestId, type: message.type },
            });
          }
          return;
        }
        this.worker?.postMessage(message);
      };
      if (diagnosticDelayMs > 0) {
        globalThis.setTimeout(postRequest, diagnosticDelayMs);
      } else {
        postRequest();
      }
    });
  }

  private handleMessage(message: SearchWorkerResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      incrementPerfCounter('search:stale-response');
      return;
    }
    this.pending.delete(message.requestId);
    recordPerfMetric({
      kind: 'search',
      name: message.type === 'search:result' ? 'worker-query' : 'worker-corpus',
      durationMs: nowMs() - pending.startedAt,
      tags: {
        type: message.type,
        corpusSize: 'corpusSize' in message ? message.corpusSize : undefined,
        resultCount: message.type === 'search:result' ? message.ids.length : undefined,
      },
    });
    pending.resolve(message);
  }
}
