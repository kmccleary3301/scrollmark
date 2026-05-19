import { createModuleInterceptor, projectTweets } from '@/core/extensions/module-platform';
import { TimelineInstructions, Tweet } from '@/types';
import { extractDataFromResponse, extractTimelineTweet } from '@/utils/api';

interface ListTimelineResponse {
  data: {
    list: {
      tweets_timeline: {
        timeline: {
          instructions: TimelineInstructions;
          metadata: unknown;
        };
      };
    };
  };
}

// https://twitter.com/i/api/graphql/asz3yj2ZCgJt3pdZEY2zgA/ListLatestTweetsTimeline
export const ListTimelineInterceptor = createModuleInterceptor<Tweet[]>({
  moduleName: 'ListTimeline',
  match: (req) => /\/graphql\/.+\/ListLatestTweetsTimeline/.test(req.url),
  parse: (_req, res) =>
    extractDataFromResponse<ListTimelineResponse, Tweet>(
      res,
      (json) => json.data.list.tweets_timeline.timeline.instructions,
      (entry) => extractTimelineTweet(entry.content.itemContent),
    ),
  project: (extName, tweets) => projectTweets(extName, tweets),
});
