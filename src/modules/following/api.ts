import { createModuleInterceptor, projectUsersWithEdges } from '@/core/extensions/module-platform';
import { SocialEdge, TimelineInstructions, TimelineUser, User } from '@/types';
import { extractTimelineUser, isTimelineEntryModule, isTimelineEntryUser } from '@/utils/api';

interface FollowingResponse {
  data: {
    user: {
      result: User & {
        timeline?: {
          timeline?: {
            instructions: TimelineInstructions;
          };
        };
      };
    };
  };
}

type FollowingParsed = {
  subject: User | null;
  users: User[];
  edges: SocialEdge[];
};

function parseRequestVariables(url: string): Record<string, unknown> | null {
  try {
    const parsedUrl = new URL(url, 'https://x.com');
    const raw = parsedUrl.searchParams.get('variables');
    if (!raw) return null;
    try {
      return JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
    } catch {
      return JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    return null;
  }
}

function resolveSubjectFallback(req: { url: string }): { rest_id?: string; screen_name?: string } {
  const variables = parseRequestVariables(req.url);
  const subjectUserId = String(
    variables?.userId || variables?.user_id || variables?.rest_id || variables?.profileUserId || '',
  ).trim();
  const subjectScreenName = String(
    variables?.screen_name || variables?.screenName || variables?.userScreenName || '',
  ).trim();
  return {
    rest_id: subjectUserId || undefined,
    screen_name: subjectScreenName || undefined,
  };
}

function parseFollowing(req: { url: string }, res: XMLHttpRequest): FollowingParsed {
  const json: FollowingResponse = JSON.parse(res.responseText);
  const result = json?.data?.user?.result;
  const instructions = result?.timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) {
    throw new Error('Following response missing timeline instructions');
  }

  const users: User[] = [];
  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddEntries') {
      for (const entry of instruction.entries || []) {
        if (isTimelineEntryUser(entry)) {
          const parsed = extractTimelineUser(entry.content.itemContent);
          if (parsed) {
            users.push(parsed);
          }
          continue;
        }
        if (isTimelineEntryModule<TimelineUser>(entry)) {
          for (const item of entry.content.items || []) {
            if (item.item.itemContent.__typename !== 'TimelineUser') continue;
            const parsed = extractTimelineUser(item.item.itemContent);
            if (parsed) {
              users.push(parsed);
            }
          }
        }
      }
    }
    if (instruction.type === 'TimelineAddToModule') {
      for (const item of instruction.moduleItems || []) {
        if (item.item.itemContent.__typename !== 'TimelineUser') continue;
        const parsed = extractTimelineUser(item.item.itemContent);
        if (parsed) {
          users.push(parsed);
        }
      }
    }
  }

  const subjectFallback = resolveSubjectFallback(req);
  const subject =
    result && result.__typename === 'User'
      ? ({
          ...result,
          rest_id: String(result.rest_id || subjectFallback.rest_id || '').trim(),
          core: {
            ...result.core,
            screen_name: String(
              result.core?.screen_name || subjectFallback.screen_name || '',
            ).trim(),
          },
        } as User)
      : null;

  const subjectUserId = String(subject?.rest_id || subjectFallback.rest_id || '').trim();
  const subjectScreenName = String(
    subject?.core?.screen_name || subjectFallback.screen_name || '',
  ).trim();
  const edges: SocialEdge[] = subjectUserId
    ? users.map((user) => ({
        id: `FollowingModule-following-${subjectUserId}-${user.rest_id}`,
        extension: 'FollowingModule',
        relation_type: 'following',
        subject_user_id: subjectUserId,
        subject_screen_name: subjectScreenName || undefined,
        related_user_id: user.rest_id,
        related_screen_name: user.core?.screen_name,
        observed_at: Date.now(),
        provenance_surface: 'following',
      }))
    : [];

  return { subject, users, edges };
}

// https://twitter.com/i/api/graphql/iSicc7LrzWGBgDPL0tM_TQ/Following
export const FollowingInterceptor = createModuleInterceptor<FollowingParsed>({
  moduleName: 'Following',
  match: (req) => /\/graphql\/.+\/Following/.test(req.url),
  parse: (req, res) => parseFollowing(req, res),
  count: (parsed) => parsed.users.length,
  project: (extName, parsed) => projectUsersWithEdges(extName, parsed.users, parsed.edges),
});
