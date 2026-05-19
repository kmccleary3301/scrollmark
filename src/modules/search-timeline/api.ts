import { createModuleInterceptor, projectTweets } from '@/core/extensions/module-platform';
import {
  ItemContentUnion,
  List,
  TimelineAddEntriesInstruction,
  TimelineAddToModuleInstruction,
  TimelineInstructions,
  TimelineTweet,
  TimelineTwitterList,
  Tweet,
  User,
} from '@/types';
import {
  extractTimelineTweet,
  extractTimelineUser,
  isTimelineEntryListSearch,
  isTimelineEntrySearchGrid,
  isTimelineEntryTweet,
  isTimelineEntryUser,
} from '@/utils/api';
import logger from '@/utils/logger';

interface SearchTimelineResponse {
  data: {
    search_by_raw_query: {
      search_timeline: {
        timeline: {
          instructions: TimelineInstructions;
          responseObjects: unknown;
        };
      };
    };
  };
}

type SearchTimelineParsed = {
  tweets: Tweet[];
  users: User[];
  lists: List[];
};

function getSearchTimelineVariables(req: { url: string }): Record<string, unknown> | null {
  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get('variables');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isQuoteTweetSearchTimelineRequest(req: { url: string }): boolean {
  const variables = getSearchTimelineVariables(req);
  const rawQuery = String(variables?.rawQuery || '')
    .trim()
    .toLowerCase();
  const querySource = String(variables?.querySource || '')
    .trim()
    .toLowerCase();
  return rawQuery.startsWith('quoted_tweet_id:') || querySource === 'tdqt';
}

export function parseSearchTimelineResponse(res: XMLHttpRequest): SearchTimelineParsed {
  const json: SearchTimelineResponse = JSON.parse(res.responseText);
  const instructions = json.data.search_by_raw_query.search_timeline.timeline.instructions;

  const newTweets: Tweet[] = [];
  const newUsers: User[] = [];
  const newLists: List[] = [];
  const timelineAddEntriesInstruction = instructions.find(
    (i) => i.type === 'TimelineAddEntries',
  ) as TimelineAddEntriesInstruction<ItemContentUnion>;
  const timelineAddToModuleInstruction = instructions.find(
    (i) => i.type === 'TimelineAddToModule',
  ) as TimelineAddToModuleInstruction<ItemContentUnion>;
  const timelineAddEntriesInstructionEntries = timelineAddEntriesInstruction?.entries ?? [];

  for (const entry of timelineAddEntriesInstructionEntries) {
    if (isTimelineEntryTweet(entry)) {
      const tweet = extractTimelineTweet(entry.content.itemContent);
      if (tweet) {
        newTweets.push(tweet);
      }
    }

    if (isTimelineEntrySearchGrid(entry)) {
      const tweetsInSearchGrid = entry.content.items
        .map((i) => extractTimelineTweet(i.item.itemContent))
        .filter((t): t is Tweet => !!t);

      newTweets.push(...tweetsInSearchGrid);
    }

    if (isTimelineEntryUser(entry)) {
      const user = extractTimelineUser(entry.content.itemContent);
      if (user) {
        newUsers.push(user);
      }
    }

    if (isTimelineEntryListSearch(entry)) {
      const lists = entry.content.items.map((i) => i.item.itemContent.list);
      newLists.push(...lists);
    }
  }

  if (timelineAddToModuleInstruction) {
    const items = timelineAddToModuleInstruction.moduleItems.map((i) => i.item.itemContent);

    const tweets = items
      .filter((i): i is TimelineTweet => i.__typename === 'TimelineTweet')
      .map((t) => extractTimelineTweet(t))
      .filter((t): t is Tweet => !!t);

    newTweets.push(...tweets);

    const lists = items
      .filter((i): i is TimelineTwitterList => i.__typename === 'TimelineTwitterList')
      .map((i) => i.list);

    newLists.push(...lists);
  }

  return { tweets: newTweets, users: newUsers, lists: newLists };
}

// https://twitter.com/i/api/graphql/Aj1nGkALq99Xg3XI0OZBtw/SearchTimeline
export const SearchTimelineInterceptor = createModuleInterceptor<SearchTimelineParsed>({
  moduleName: 'SearchTimeline',
  match: (req) =>
    /\/graphql\/.+\/SearchTimeline/.test(req.url) && !isQuoteTweetSearchTimelineRequest(req),
  parse: (_req, res) => parseSearchTimelineResponse(res),
  count: (parsed) => parsed.tweets.length,
  project: (extName, parsed) => projectTweets(extName, parsed.tweets),
  onSuccess: (parsed) => {
    if (parsed.lists.length > 0) {
      logger.warn(
        `SearchList: ${parsed.lists.length} lists received but ignored (Reason: not implemented)`,
        parsed.lists,
      );
    }

    if (parsed.users.length > 0) {
      logger.warn(
        `SearchUser: ${parsed.users.length} users received but ignored (Reason: not implemented)`,
        parsed.users,
      );
    }
  },
});
