import { createModuleInterceptor, projectTweets } from '@/core/extensions/module-platform';
import { Tweet } from '@/types';
import logger from '@/utils/logger';
import {
  isQuoteTweetSearchTimelineRequest,
  parseSearchTimelineResponse,
} from '@/modules/search-timeline/api';

type QuotesParsed = {
  tweets: Tweet[];
};

export const QuotesInterceptor = createModuleInterceptor<QuotesParsed>({
  moduleName: 'Quotes',
  match: (req) =>
    /\/graphql\/.+\/SearchTimeline/.test(req.url) && isQuoteTweetSearchTimelineRequest(req),
  parse: (_req, res) => {
    const parsed = parseSearchTimelineResponse(res);
    return { tweets: parsed.tweets };
  },
  count: (parsed) => parsed.tweets.length,
  project: (extName, parsed) => projectTweets(extName, parsed.tweets),
  onSuccess: (parsed) => {
    logger.debug(`Quotes: projected ${parsed.tweets.length} quote-tweet rows`);
  },
});
