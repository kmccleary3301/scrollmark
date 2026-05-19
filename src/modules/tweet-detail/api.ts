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
  isTimelineEntryConversationThread,
  isTimelineEntryTweet,
} from '@/utils/api';

interface TweetDetailResponse {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: TimelineInstructions;
    };
  };
}

interface ModeratedTimelineResponse {
  data: {
    tweet: {
      result: {
        timeline_response: {
          timeline: {
            instructions: TimelineInstructions;
          };
        };
      };
    };
  };
}

// https://twitter.com/i/api/graphql/8sK2MBRZY9z-fgmdNpR3LA/TweetDetail
// https://twitter.com/i/api/graphql/a8M2LqEB5TwbW_eDrsmcDA/ModeratedTimeline
export const TweetDetailInterceptor = createModuleInterceptor<Tweet[]>({
  moduleName: 'TweetDetail',
  match: (req) =>
    /\/graphql\/.+\/TweetDetail/.test(req.url) || /\/graphql\/.+\/ModeratedTimeline/.test(req.url),
  parse: (req, res) => {
    const isTweetDetail = /\/graphql\/.+\/TweetDetail/.test(req.url);
    const isModeratedTimeline = /\/graphql\/.+\/ModeratedTimeline/.test(req.url);
    const json: TweetDetailResponse | ModeratedTimelineResponse = JSON.parse(res.responseText);
    let instructions: TimelineInstructions = [];

    if (isTweetDetail) {
      instructions = (json as TweetDetailResponse).data.threaded_conversation_with_injections_v2
        .instructions;
    } else if (isModeratedTimeline) {
      instructions = (json as ModeratedTimelineResponse).data.tweet.result.timeline_response
        .timeline.instructions;
    }

    const newData: Tweet[] = [];
    const timelineAddEntriesInstruction = instructions.find(
      (i) => i.type === 'TimelineAddEntries',
    ) as TimelineAddEntriesInstruction<TimelineTweet>;
    const timelineAddEntriesInstructionEntries = timelineAddEntriesInstruction?.entries ?? [];

    for (const entry of timelineAddEntriesInstructionEntries) {
      if (isTimelineEntryTweet(entry)) {
        const tweet = extractTimelineTweet(entry.content.itemContent);
        if (tweet) {
          newData.push(tweet);
        }
      }

      if (isTweetDetail && isTimelineEntryConversationThread(entry)) {
        const tweetsInConversation = entry.content.items.map((i) => {
          if (i.entryId.includes('-tweet-')) {
            return extractTimelineTweet(i.item.itemContent);
          }
        });

        newData.push(...tweetsInConversation.filter((t): t is Tweet => !!t));
      }
    }

    const timelineAddToModuleInstruction = instructions.find(
      (i) => i.type === 'TimelineAddToModule',
    ) as TimelineAddToModuleInstruction<TimelineTweet>;

    if (timelineAddToModuleInstruction) {
      const tweetsInConversation = timelineAddToModuleInstruction.moduleItems
        .map((i) => extractTimelineTweet(i.item.itemContent))
        .filter((t): t is Tweet => !!t);

      newData.push(...tweetsInConversation);
    }

    return newData;
  },
  project: (extName, tweets) => projectTweets(extName, tweets),
});
