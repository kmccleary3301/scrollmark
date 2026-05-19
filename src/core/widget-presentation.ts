import { Extension, ExtensionType } from '@/core/extensions';
import { TranslationKey } from '@/i18n';

type WidgetTone = {
  indicatorColor: string;
  panelClass?: string;
};

type WidgetPresentation = WidgetTone & {
  titleKey?: TranslationKey;
  rank: number;
};

const MODULE_RANKS: Record<string, number> = {
  BookmarksModule: 10,
  TweetIndexModule: 20,
  UserDetailModule: 30,
  UserTweetsModule: 40,
  UserMediaModule: 50,
  LikesModule: 60,
  QuotesModule: 70,
  TweetDetailModule: 80,
  SearchTimelineModule: 90,

  FollowersModule: 120,
  FollowingModule: 130,
  RetweetersModule: 140,

  HomeTimelineModule: 220,
  ListTimelineModule: 230,
  CommunityTimelineModule: 240,

  ListMembersModule: 320,
  ListSubscribersModule: 330,
  CommunityMembersModule: 340,
  DirectMessagesModule: 420,

  LocalSearchModule: 9000,
  InteractionEventsModule: 9010,
  RuntimeLogsModule: 9990,
};

const MODULE_TITLE_KEYS: Partial<Record<string, TranslationKey>> = {
  BookmarksModule: 'Bookmarks',
  TweetIndexModule: 'Tweets',
  UserDetailModule: 'Users',
  UserTweetsModule: 'User Tweets',
  UserMediaModule: 'User Media',
  TweetDetailModule: 'Tweet Details',
  SearchTimelineModule: 'Search Timeline',
  HomeTimelineModule: 'Home Timeline',
  ListTimelineModule: 'List Timeline',
  CommunityTimelineModule: 'Community Timeline',
  CommunityMembersModule: 'Community Members',
  ListMembersModule: 'List Members',
  ListSubscribersModule: 'List Subscribers',
  DirectMessagesModule: 'Direct Messages',
  InteractionEventsModule: 'Interaction Events',
  LocalSearchModule: 'Local Search',
  RuntimeLogsModule: 'Runtime Logs',
};

const MODULE_TONES: Partial<Record<string, WidgetTone>> = {
  BookmarksModule: {
    indicatorColor: 'bg-warning',
    panelClass: 'border-l-2 border-warning/60 pl-2',
  },
  TweetIndexModule: {
    indicatorColor: 'bg-info',
    panelClass: 'border-l-2 border-info/50 pl-2',
  },
  UserDetailModule: {
    indicatorColor: 'bg-success',
    panelClass: 'border-l-2 border-success/50 pl-2',
  },
  UserTweetsModule: { indicatorColor: 'bg-info' },
  UserMediaModule: { indicatorColor: 'bg-info' },
  TweetDetailModule: { indicatorColor: 'bg-info' },
  SearchTimelineModule: { indicatorColor: 'bg-info' },
  LikesModule: { indicatorColor: 'bg-secondary' },
  QuotesModule: { indicatorColor: 'bg-secondary' },
  RetweetersModule: { indicatorColor: 'bg-secondary' },
  FollowersModule: { indicatorColor: 'bg-success' },
  FollowingModule: { indicatorColor: 'bg-success' },
  HomeTimelineModule: { indicatorColor: 'bg-primary' },
  ListTimelineModule: { indicatorColor: 'bg-primary' },
  CommunityTimelineModule: { indicatorColor: 'bg-primary' },
  ListMembersModule: { indicatorColor: 'bg-success' },
  ListSubscribersModule: { indicatorColor: 'bg-success' },
  CommunityMembersModule: { indicatorColor: 'bg-success' },
  DirectMessagesModule: { indicatorColor: 'bg-accent' },
  LocalSearchModule: {
    indicatorColor: 'bg-neutral',
    panelClass: 'opacity-90',
  },
  InteractionEventsModule: {
    indicatorColor: 'bg-neutral',
    panelClass: 'opacity-90',
  },
  RuntimeLogsModule: {
    indicatorColor: 'bg-neutral',
    panelClass: 'opacity-90',
  },
};

function fallbackTone(type: ExtensionType): WidgetTone {
  if (type === ExtensionType.TWEET) return { indicatorColor: 'bg-info' };
  if (type === ExtensionType.USER) return { indicatorColor: 'bg-success' };
  if (type === ExtensionType.CUSTOM) return { indicatorColor: 'bg-accent' };
  return { indicatorColor: 'bg-neutral' };
}

export function getWidgetPresentation(
  extension: Pick<Extension, 'name' | 'type'>,
): WidgetPresentation {
  const tone = MODULE_TONES[extension.name] ?? fallbackTone(extension.type);
  return {
    rank: MODULE_RANKS[extension.name] ?? 5000,
    titleKey: MODULE_TITLE_KEYS[extension.name],
    ...tone,
  };
}

export function compareWidgetExtensions(left: Extension, right: Extension): number {
  const leftRank = getWidgetPresentation(left).rank;
  const rightRank = getWidgetPresentation(right).rank;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left.name.localeCompare(right.name);
}

export function isBottomUtilityWidget(extension: Extension): boolean {
  return getWidgetPresentation(extension).rank >= 9000;
}
