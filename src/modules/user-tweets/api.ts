import { createModuleInterceptor, projectTweets } from '@/core/extensions/module-platform';
import {
  TimelineAddEntriesInstruction,
  TimelineInstructions,
  TimelinePinEntryInstruction,
  TimelineTweet,
  Tweet,
} from '@/types';
import {
  extractTimelineTweet,
  isTimelineEntryProfileConversation,
  isTimelineEntryTweet,
} from '@/utils/api';

interface UserTweetsResponse {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: TimelineInstructions;
            metadata: unknown;
          };
        };
        __typename: 'User';
      };
    };
  };
}

// https://twitter.com/i/api/graphql/H8OOoI-5ZE4NxgRr8lfyWg/UserTweets
// https://twitter.com/i/api/graphql/Q6aAvPw7azXZbqXzuqTALA/UserTweetsAndReplies
export const UserTweetsInterceptor = createModuleInterceptor<Tweet[]>({
  moduleName: 'UserTweets',
  match: (req) => /\/graphql\/.+\/UserTweets/.test(req.url),
  parse: (_req, res) => {
    const json: UserTweetsResponse = JSON.parse(res.responseText);
    const instructions = json.data.user.result.timeline.timeline.instructions;

    const newData: Tweet[] = [];
    const timelinePinEntryInstruction = instructions.find(
      (i) => i.type === 'TimelinePinEntry',
    ) as TimelinePinEntryInstruction;

    if (timelinePinEntryInstruction) {
      const tweet = extractTimelineTweet(timelinePinEntryInstruction.entry.content.itemContent);
      if (tweet) {
        newData.push(tweet);
      }
    }

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

      if (isTimelineEntryProfileConversation(entry)) {
        const tweetsInConversation = entry.content.items
          .map((i) => extractTimelineTweet(i.item.itemContent))
          .filter((t): t is Tweet => !!t);

        newData.push(...tweetsInConversation);
      }
    }

    return newData;
  },
  project: (extName, tweets) => projectTweets(extName, tweets),
});
