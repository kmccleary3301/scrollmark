import { createModuleInterceptor, projectUsers } from '@/core/extensions/module-platform';
import { TimelineInstructions, User } from '@/types';
import { extractDataFromResponse, extractTimelineUser } from '@/utils/api';

interface ListMembersResponse {
  data: {
    list: {
      members_timeline: {
        timeline: {
          instructions: TimelineInstructions;
        };
      };
    };
  };
}

// https://twitter.com/i/api/graphql/yvfK4KAOvISiM1POa2mK7A/ListMembers
export const ListMembersInterceptor = createModuleInterceptor<User[]>({
  moduleName: 'ListMembers',
  match: (req) => /\/graphql\/.+\/ListMembers/.test(req.url),
  parse: (_req, res) =>
    extractDataFromResponse<ListMembersResponse, User>(
      res,
      (json) => json.data.list.members_timeline.timeline.instructions,
      (entry) => extractTimelineUser(entry.content.itemContent),
    ),
  project: (extName, users) => projectUsers(extName, users),
});
