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

function createRequestId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, { resolve, reject, startedAt });
      this.worker?.postMessage(message);
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
