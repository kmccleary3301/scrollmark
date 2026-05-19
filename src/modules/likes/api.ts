import { createModuleInterceptor, projectTweets } from '@/core/extensions/module-platform';
import { TimelineInstructions, Tweet } from '@/types';
import { extractDataFromResponse, extractTimelineTweet } from '@/utils/api';

interface LikesResponse {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: TimelineInstructions;
            responseObjects: unknown;
          };
        };
        __typename: 'User';
      };
    };
  };
}

// https://twitter.com/i/api/graphql/lVf2NuhLoYVrpN4nO7uw0Q/Likes
export const LikesInterceptor = createModuleInterceptor<Tweet[]>({
  moduleName: 'Likes',
  match: (req) => /\/graphql\/.+\/Likes/.test(req.url),
  parse: (_req, res) =>
    extractDataFromResponse<LikesResponse, Tweet>(
      res,
      (json) => json.data.user.result.timeline.timeline.instructions,
      (entry) => extractTimelineTweet(entry.content.itemContent),
    ),
  project: (extName, tweets) => projectTweets(extName, tweets),
});
