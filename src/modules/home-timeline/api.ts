import { createModuleInterceptor, projectTweets } from '@/core/extensions/module-platform';
import { TimelineInstructions, Tweet } from '@/types';
import { extractDataFromResponse, extractTimelineTweet } from '@/utils/api';

interface HomeTimelineResponse {
  data: {
    home: {
      home_timeline_urt: {
        instructions: TimelineInstructions;
        metadata: unknown;
        responseObjects: unknown;
      };
    };
  };
}

// https://twitter.com/i/api/graphql/uPv755D929tshj6KsxkSZg/HomeTimeline
// https://twitter.com/i/api/graphql/70b_oNkcK9IEN13WNZv8xA/HomeLatestTimeline
export const HomeTimelineInterceptor = createModuleInterceptor<Tweet[]>({
  moduleName: 'HomeTimeline',
  match: (req) => /\/graphql\/.+\/Home(Latest)?Timeline/.test(req.url),
  parse: (_req, res) =>
    extractDataFromResponse<HomeTimelineResponse, Tweet>(
      res,
      (json) => json.data.home.home_timeline_urt.instructions,
      (entry) => extractTimelineTweet(entry.content.itemContent),
    ),
  project: (extName, tweets) => projectTweets(extName, tweets),
});
