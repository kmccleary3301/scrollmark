import logger from '@/utils/logger';
import { recordDiagnosticParserEvent } from '@/utils/diagnostics';
import { Extension } from './extension';

export type DispatchableRequest = {
  method: string;
  url: string;
  body?: string;
  bookmarkContext?: unknown;
  requestId?: string;
  __twe_hook_revision_v1?: number;
  hookRevision?: number;
};

export class ExtensionInterceptorDispatcher {
  public dispatch(extensions: Extension[], req: DispatchableRequest, res: XMLHttpRequest): void {
    extensions
      .filter((ext) => ext.enabled)
      .forEach((ext) => {
        try {
          const func = ext.intercept();
          if (!func) {
            return;
          }

          const startedAt = Date.now();
          recordDiagnosticParserEvent({
            ts: startedAt,
            extension: ext.name,
            phase: 'claimed',
            request_id: req.requestId,
            method: req.method,
            url: req.url,
            status: res.status,
          });
          func(req, res, ext);
          recordDiagnosticParserEvent({
            ts: Date.now(),
            extension: ext.name,
            phase: 'completed',
            request_id: req.requestId,
            method: req.method,
            url: req.url,
            status: res.status,
            duration_ms: Math.max(0, Date.now() - startedAt),
          });
        } catch (err) {
          recordDiagnosticParserEvent({
            ts: Date.now(),
            extension: ext.name,
            phase: 'error',
            request_id: req.requestId,
            method: req.method,
            url: req.url,
            status: res.status,
            error: err instanceof Error ? err.message : String(err),
          });
          logger.error(`Interceptor error (${ext.name}):`, err);
        }
      });
  }
}
