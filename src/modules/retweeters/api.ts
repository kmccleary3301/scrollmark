import { createModuleInterceptor, projectUsers } from '@/core/extensions/module-platform';
import { TimelineInstructions, User } from '@/types';
import { extractDataFromResponse, extractTimelineUser } from '@/utils/api';

interface RetweetersResponse {
  data: {
    retweeters_timeline: {
      timeline: {
        instructions: TimelineInstructions;
      };
    };
  };
}

// https://twitter.com/i/api/graphql/IQ43ps3iEcdrGV_OL1QaRw/Retweeters
export const RetweetersInterceptor = createModuleInterceptor<User[]>({
  moduleName: 'Retweeters',
  match: (req) => /\/graphql\/.+\/Retweeters/.test(req.url),
  parse: (_req, res) =>
    extractDataFromResponse<RetweetersResponse, User>(
      res,
      (json) => json.data.retweeters_timeline.timeline.instructions,
      (entry) => extractTimelineUser(entry.content.itemContent),
    ),
  project: (extName, users) => projectUsers(extName, users),
});
