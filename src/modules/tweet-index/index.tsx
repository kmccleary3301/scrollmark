import { CommonModuleUI } from '@/components/module-ui';
import { db } from '@/core/database';
import { Extension, ExtensionType } from '@/core/extensions';

export const TWEET_INDEX_MODULE_NAME = 'TweetIndexModule';

/**
 * Aggregate tweet index. Tweets are mirrored into this module from the shared
 * projection layer so source-specific modules keep their original semantics.
 */
export default class TweetIndexModule extends Extension {
  name = TWEET_INDEX_MODULE_NAME;

  type = ExtensionType.TWEET;

  setup() {
    void db.extBackfillTweetCapturesFromAllTweets(this.name);
  }

  render() {
    return CommonModuleUI;
  }
}
