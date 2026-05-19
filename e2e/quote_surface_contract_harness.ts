import { isQuoteTweetSearchTimelineRequest } from '../src/modules/search-timeline/api';

const positives = [
  'https://x.com/i/api/graphql/rkp6b4vtR9u7v3naGoOzUQ/SearchTimeline?variables=%7B%22rawQuery%22%3A%22quoted_tweet_id%3A2011441636413522129%22%2C%22count%22%3A20%2C%22querySource%22%3A%22tdqt%22%2C%22product%22%3A%22Top%22%7D',
  'https://x.com/i/api/graphql/rkp6b4vtR9u7v3naGoOzUQ/SearchTimeline?variables=%7B%22rawQuery%22%3A%22hello%22%2C%22querySource%22%3A%22tdqt%22%7D',
];
const negatives = [
  'https://x.com/i/api/graphql/Aj1nGkALq99Xg3XI0OZBtw/SearchTimeline?variables=%7B%22rawQuery%22%3A%22distributed%20systems%22%2C%22querySource%22%3A%22typed_query%22%7D',
  'https://x.com/i/api/graphql/Aj1nGkALq99Xg3XI0OZBtw/SearchTimeline?variables=%7B%22count%22%3A20%7D',
];
for (const url of positives) {
  if (!isQuoteTweetSearchTimelineRequest({ url })) {
    throw new Error(`expected quote route: ${url}`);
  }
}
for (const url of negatives) {
  if (isQuoteTweetSearchTimelineRequest({ url })) {
    throw new Error(`unexpected quote route: ${url}`);
  }
}
console.log(JSON.stringify({ ok: true, positives: positives.length, negatives: negatives.length }));
