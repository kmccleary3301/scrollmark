import { createModuleInterceptor, projectUsers } from '@/core/extensions/module-platform';
import { TimelineInstructions, User } from '@/types';
import { extractDataFromResponse, extractTimelineUser } from '@/utils/api';

interface ListSubscribersResponse {
  data: {
    list: {
      subscribers_timeline: {
        timeline: {
          instructions: TimelineInstructions;
        };
      };
    };
  };
}

// https://twitter.com/i/api/graphql/VRByQj7dPMi0T2p0eXwYJw/ListSubscribers
export const ListSubscribersInterceptor = createModuleInterceptor<User[]>({
  moduleName: 'ListSubscribers',
  match: (req) => /\/graphql\/.+\/ListSubscribers/.test(req.url),
  parse: (_req, res) =>
    extractDataFromResponse<ListSubscribersResponse, User>(
      res,
      (json) => json.data.list.subscribers_timeline.timeline.instructions,
      (entry) => extractTimelineUser(entry.content.itemContent),
    ),
  project: (extName, users) => projectUsers(extName, users),
});
