import { db } from '@/core/database';
import { SocialEdge } from '@/types';
import logger from '@/utils/logger';
import { getUserMediaMirrorTweetIds } from '@/utils/user-media';
import type { Extension, Interceptor, InterceptorRequest } from './extension';

export const TWEET_INDEX_MODULE_NAME = 'TweetIndexModule';

export type ModuleProjectionKind = 'tweets' | 'users' | 'custom' | 'none';

export type ModuleProjectionResult = {
  kind: ModuleProjectionKind;
  count: number;
};

export type ModuleProjectFn<T> = (
  extName: string,
  parsed: T,
  req: InterceptorRequest,
  res: XMLHttpRequest,
) => void | ModuleProjectionResult | Promise<void | ModuleProjectionResult>;

export type ModuleInterceptorSpec<T> = {
  moduleName: string;
  match: (req: InterceptorRequest, res: XMLHttpRequest) => boolean;
  parse: (req: InterceptorRequest, res: XMLHttpRequest, ext: Extension) => T;
  project?: ModuleProjectFn<T>;
  count?: (parsed: T) => number;
  onSuccess?: (
    parsed: T,
    context: {
      ext: Extension;
      req: InterceptorRequest;
      res: XMLHttpRequest;
      projection: ModuleProjectionResult;
      count: number;
    },
  ) => void;
};

export async function projectTweets(
  extName: string,
  tweets: unknown[],
): Promise<ModuleProjectionResult> {
  const normalizedTweets = Array.isArray(tweets) ? (tweets as never[]) : [];
  await db.extAddTweets(extName, normalizedTweets);

  const tweetIds = normalizedTweets
    .map((tweet) => String((tweet as { rest_id?: unknown })?.rest_id || '').trim())
    .filter(Boolean);

  if (extName !== TWEET_INDEX_MODULE_NAME && tweetIds.length) {
    await db.extAddTweetCaptureIds(TWEET_INDEX_MODULE_NAME, tweetIds);
  }

  const userMediaTweetIds = getUserMediaMirrorTweetIds(extName, normalizedTweets);
  if (userMediaTweetIds.length) {
    await db.extAddTweetCaptureIds('UserMediaModule', userMediaTweetIds);
  }

  return { kind: 'tweets', count: normalizedTweets.length };
}

export function projectUsers(extName: string, users: unknown[]): ModuleProjectionResult {
  void db.extAddUsers(extName, users as never[]);
  return { kind: 'users', count: Array.isArray(users) ? users.length : 0 };
}

export async function projectUsersWithEdges(
  extName: string,
  users: unknown[],
  edges: SocialEdge[],
): Promise<ModuleProjectionResult> {
  const normalizedUsers = Array.isArray(users) ? users : [];
  await db.extAddUsers(extName, normalizedUsers as never[]);
  if (edges.length) {
    await db.extAddSocialEdges(extName, edges);
  }
  return { kind: 'users', count: normalizedUsers.length };
}

export function projectCustom(extName: string, items: unknown[]): ModuleProjectionResult {
  void db.extAddCustomCaptures(extName, items as never[]);
  return { kind: 'custom', count: Array.isArray(items) ? items.length : 0 };
}

export function logModuleItemsReceived(moduleName: string, count: number): void {
  logger.info(`${moduleName}: ${count} items received`);
}

export function logModuleParseFailure(
  moduleName: string,
  req: InterceptorRequest,
  res: XMLHttpRequest,
  err: Error,
): void {
  logger.debug(req.method, req.url, res.status, res.responseText);
  logger.errorWithBanner(`${moduleName}: Failed to parse API response`, err);
}

export function createModuleInterceptor<T>(spec: ModuleInterceptorSpec<T>): Interceptor {
  return (req, res, ext) => {
    if (!spec.match(req, res)) {
      return;
    }

    try {
      const parsed = spec.parse(req, res, ext);
      const count = spec.count ? spec.count(parsed) : Array.isArray(parsed) ? parsed.length : 0;
      const projection = spec.project
        ? spec.project(ext.name, parsed, req, res)
        : { kind: 'none' as const, count };

      const finish = (resolvedProjection?: void | ModuleProjectionResult) => {
        const normalizedProjection =
          resolvedProjection && typeof resolvedProjection === 'object'
            ? resolvedProjection
            : ({ kind: 'none', count } as ModuleProjectionResult);
        logModuleItemsReceived(spec.moduleName, count);
        spec.onSuccess?.(parsed, {
          ext,
          req,
          res,
          projection: normalizedProjection,
          count,
        });
      };

      if (projection && typeof (projection as Promise<unknown>).then === 'function') {
        void (projection as Promise<void | ModuleProjectionResult>).then((resolved) =>
          finish(resolved),
        );
      } else {
        finish(projection as void | ModuleProjectionResult);
      }
    } catch (err) {
      logModuleParseFailure(
        spec.moduleName,
        req,
        res,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  };
}
