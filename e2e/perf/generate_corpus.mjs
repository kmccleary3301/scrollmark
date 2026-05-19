/* global process, console */
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'e2e/perf/synthetic-tweets-5000.json';
const count = Number(process.argv[3] || 5000);
const folders = ['Research Revisit 02', 'Design 02', 'AI Lab Rumors', 'Cool Art'];
const topics = [
  'full writeup on how autonomous research agents coordinate tool calls',
  'tour guides in France with visual design systems and reliability notes',
  'article post with embedded media and markdown reasoning details',
  'masonry layout performance with image thumbnails and video attachments',
  'ParadeDB style phrase boosting exact snippet ranking natural language search',
];

const rows = Array.from({ length: count }, (_, index) => {
  const topic = topics[index % topics.length];
  const folder = folders[index % folders.length];
  return {
    __typename: 'Tweet',
    rest_id: String(2000000000000 + index),
    __bookmark_folder_id: `folder-${index % folders.length}`,
    __bookmark_folder_name: folder,
    legacy: {
      id_str: String(2000000000000 + index),
      full_text: `${topic}. Synthetic row ${index}. Exact phrase checkpoint ${index % 97}.`,
      created_at: new Date(Date.now() - index * 60000).toUTCString(),
      lang: 'en',
      favorite_count: index % 10000,
      retweet_count: index % 500,
      reply_count: index % 80,
      bookmark_count: index % 120,
      entities: { hashtags: [{ text: 'research' }, { text: `topic${index % 9}` }] },
    },
    core: {
      user_results: {
        result: {
          rest_id: String(1000 + (index % 40)),
          core: { screen_name: `researcher_${index % 40}`, name: `Researcher ${index % 40}` },
        },
      },
    },
  };
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows));
console.log(JSON.stringify({ ok: true, out, count }, null, 2));
