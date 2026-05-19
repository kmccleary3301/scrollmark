import { createModuleInterceptor, projectTweets } from '@/core/extensions/module-platform';
import {
  TimelineAddEntriesInstruction,
  TimelineAddToModuleInstruction,
  TimelineInstructions,
  TimelineTweet,
  Tweet,
} from '@/types';
import { extractTimelineTweet, isTimelineEntryProfileGrid } from '@/utils/api';

interface UserMediaResponse {
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

// https://twitter.com/i/api/graphql/oMVVrI5kt3kOpyHHTTKf5Q/UserMedia
export const UserMediaInterceptor = createModuleInterceptor<Tweet[]>({
  moduleName: 'UserMedia',
  match: (req) => /\/graphql\/.+\/UserMedia/.test(req.url),
  parse: (_req, res) => {
    const json: UserMediaResponse = JSON.parse(res.responseText);
    const instructions = json.data.user.result.timeline.timeline.instructions;

    const newData: Tweet[] = [];
    const timelineAddEntriesInstruction = instructions.find(
      (i) => i.type === 'TimelineAddEntries',
    ) as TimelineAddEntriesInstruction<TimelineTweet>;
    const timelineAddEntriesInstructionEntries = timelineAddEntriesInstruction?.entries ?? [];

    for (const entry of timelineAddEntriesInstructionEntries) {
      if (isTimelineEntryProfileGrid(entry)) {
        const tweetsInSearchGrid = entry.content.items
          .map((i) => extractTimelineTweet(i.item.itemContent))
          .filter((t): t is Tweet => !!t);

        newData.push(...tweetsInSearchGrid);
      }
    }

    const timelineAddToModuleInstruction = instructions.find(
      (i) => i.type === 'TimelineAddToModule',
    ) as TimelineAddToModuleInstruction<TimelineTweet>;

    if (timelineAddToModuleInstruction) {
      const tweetsInProfileGrid = timelineAddToModuleInstruction.moduleItems
        .map((i) => extractTimelineTweet(i.item.itemContent))
        .filter((t): t is Tweet => !!t);

      newData.push(...tweetsInProfileGrid);
    }

    return newData;
  },
  project: (extName, tweets) => projectTweets(extName, tweets),
});
