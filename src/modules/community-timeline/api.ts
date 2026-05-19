import { createModuleInterceptor, projectTweets } from '@/core/extensions/module-platform';
import {
  TimelineAddEntriesInstruction,
  TimelineAddToModuleInstruction,
  TimelineInstructions,
  TimelineTweet,
  Tweet,
} from '@/types';
import {
  extractTimelineTweet,
  isTimelineEntryCommunitiesGrid,
  isTimelineEntryItem,
} from '@/utils/api';

interface CommunityTimelineResponse {
  data: {
    communityResults: {
      result: {
        __typename: 'Community';
        ranked_community_timeline: {
          timeline: {
            instructions: TimelineInstructions;
          };
        };
        community_media_timeline: {
          timeline: {
            instructions: TimelineInstructions;
          };
        };
      };
    };
  };
}

// https://twitter.com/i/api/graphql/9guIf-LGAtpDbmM87ErE5A/CommunityTweetsTimeline
// https://twitter.com/i/api/graphql/aCiS_8DM0muPEOJ2s7ZJ0Q/CommunityMediaTimeline
export const CommunityTimelineInterceptor = createModuleInterceptor<Tweet[]>({
  moduleName: 'CommunityTimeline',
  match: (req) => /\/graphql\/.+\/Community(Tweets|Media)Timeline/.test(req.url),
  parse: (_req, res) => {
    const json: CommunityTimelineResponse = JSON.parse(res.responseText);
    const result = json.data.communityResults.result;
    const timeline = result.ranked_community_timeline ?? result.community_media_timeline;
    const instructions = timeline.timeline.instructions;

    const newData: Tweet[] = [];
    const timelineAddEntriesInstruction = instructions.find(
      (i) => i.type === 'TimelineAddEntries',
    ) as TimelineAddEntriesInstruction<TimelineTweet>;
    const timelineAddEntriesInstructionEntries = timelineAddEntriesInstruction?.entries ?? [];

    for (const entry of timelineAddEntriesInstructionEntries) {
      if (isTimelineEntryItem<TimelineTweet>(entry)) {
        const tweet = extractTimelineTweet(entry.content.itemContent);
        if (tweet) {
          newData.push(tweet);
        }
      }
      if (isTimelineEntryCommunitiesGrid(entry)) {
        const tweetsInGrid = entry.content.items
          .map((i) => extractTimelineTweet(i.item.itemContent))
          .filter((t): t is Tweet => !!t);

        newData.push(...tweetsInGrid);
      }
    }

    const timelineAddToModuleInstruction = instructions.find(
      (i) => i.type === 'TimelineAddToModule',
    ) as TimelineAddToModuleInstruction<TimelineTweet>;

    if (timelineAddToModuleInstruction?.moduleItems) {
      const tweets = timelineAddToModuleInstruction.moduleItems
        .map((i) => extractTimelineTweet(i.item.itemContent))
        .filter((t): t is Tweet => !!t);

      newData.push(...tweets);
    }

    return newData;
  },
  project: (extName, tweets) => projectTweets(extName, tweets),
});
