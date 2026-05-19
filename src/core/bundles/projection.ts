import { Tweet, User } from '@/types';
import { ImportedEntitySnapshot } from './schema';

export type ImportedProjectionRecord = (Tweet | User | Record<string, unknown>) & {
  __twe_imported_bundle_id?: string;
  __twe_imported_snapshot_id?: string;
  __twe_imported_source_id?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

function unwrapMetadataRecord(data: unknown): Record<string, unknown> {
  const root = cloneObject(data);
  const metadata = root.metadata;
  if (isObject(metadata)) {
    return cloneObject(metadata);
  }
  return root;
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeExportedTweetData(
  projected: ImportedProjectionRecord,
  snapshot: ImportedEntitySnapshot,
): ImportedProjectionRecord {
  if (projected.legacy && projected.core) {
    return projected;
  }

  const row = projected as Record<string, unknown>;
  const restId = String(projected.rest_id || snapshot.source_id || snapshot.id);
  const screenName = readString(row, 'screen_name') || readString(row, 'author_screen_name');
  const profileName = readString(row, 'name') || readString(row, 'profile_name') || screenName;
  const profileImageUrl = readString(row, 'profile_image_url');
  const createdAt =
    readString(row, 'created_at') ||
    (snapshot.observed_at ? new Date(snapshot.observed_at).toUTCString() : '');
  const fullText =
    readString(row, 'full_text') || readString(row, 'text') || readString(row, 'content');
  const rawMedia = Array.isArray(row.media) ? (row.media as Array<Record<string, unknown>>) : [];
  const media = rawMedia.map((item, index) => {
    const original = readString(item, 'original') || readString(item, 'url');
    const thumbnail = readString(item, 'thumbnail') || readString(item, 'previewUrl') || original;
    return {
      id_str: readString(item, 'id_str') || `${restId}-media-${index}`,
      media_key: readString(item, 'media_key') || `${restId}-media-${index}`,
      type: readString(item, 'type') || 'photo',
      url: thumbnail,
      media_url_https: thumbnail || original,
      expanded_url: original,
      ext_alt_text: readString(item, 'ext_alt_text') || readString(item, 'altText'),
      original_info: {
        width: readNumber(item, 'width') || undefined,
        height: readNumber(item, 'height') || undefined,
      },
      sizes: {
        large: {
          w: readNumber(item, 'width') || 1,
          h: readNumber(item, 'height') || 1,
          resize: 'fit',
        },
      },
    };
  });

  projected.rest_id = restId;
  projected.legacy = {
    id_str: restId,
    full_text: fullText,
    created_at: createdAt,
    favorite_count: readNumber(row, 'favorite_count') || readNumber(row, 'favorites'),
    retweet_count: readNumber(row, 'retweet_count') || readNumber(row, 'retweets'),
    reply_count: readNumber(row, 'reply_count') || readNumber(row, 'replies'),
    bookmark_count: readNumber(row, 'bookmark_count') || readNumber(row, 'bookmarks'),
    quote_count: readNumber(row, 'quote_count') || readNumber(row, 'quotes'),
    entities: {
      urls: [],
      media,
    },
    extended_entities: {
      media,
    },
  };
  projected.core = {
    user_results: {
      result: {
        rest_id: readString(row, 'user_id') || readString(row, 'author_id') || '',
        core: {
          screen_name: screenName,
          name: profileName,
        },
        avatar: {
          image_url: profileImageUrl,
        },
        legacy: {
          screen_name: screenName,
          name: profileName,
          profile_image_url_https: profileImageUrl,
        },
      },
    },
  };

  return projected;
}

export function projectImportedSnapshot(
  snapshot: ImportedEntitySnapshot,
): ImportedProjectionRecord {
  const projected = unwrapMetadataRecord(snapshot.data) as ImportedProjectionRecord;
  projected.__twe_imported_bundle_id = snapshot.bundle_id;
  projected.__twe_imported_snapshot_id = snapshot.id;
  projected.__twe_imported_source_id = snapshot.source_id;

  if (!projected.rest_id && snapshot.source_id) {
    projected.rest_id = snapshot.source_id;
  }

  if (snapshot.kind === 'tweet') {
    normalizeExportedTweetData(projected, snapshot);
  }

  if (!projected.twe_private_fields || typeof projected.twe_private_fields !== 'object') {
    projected.twe_private_fields = {
      created_at: snapshot.observed_at || snapshot.created_at,
      updated_at: snapshot.updated_at,
    };
  }

  return projected;
}

export function projectImportedSnapshots(
  snapshots: ImportedEntitySnapshot[],
  kind?: 'tweet' | 'user',
): ImportedProjectionRecord[] {
  return snapshots
    .filter((snapshot) => !kind || snapshot.kind === kind)
    .map((snapshot) => projectImportedSnapshot(snapshot));
}
