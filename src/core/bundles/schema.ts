export type BundleEntityKind = 'tweet' | 'user' | 'social_edge' | 'capture' | 'media' | 'unknown';
export type BundleVisibility = 'private' | 'shared_safe' | 'public';
export type BundleImportStatus = 'draft' | 'importing' | 'ready' | 'failed';
export type BundleRecordSensitivity = 'low' | 'medium' | 'high';

export interface BundleProducerInfo {
  app: 'twitter-web-exporter';
  appVersion: string;
  schemaVersion: number;
  exportedAt: number;
}

export interface BundlePrivacyOptions {
  includeViewerAccountId: boolean;
  includeSourceCaptureTimes: boolean;
  includeRawGraphQL: boolean;
  includePrivateNotes: boolean;
  includeMediaBlobs: boolean;
  visibility: BundleVisibility;
}

export interface BundlePrivacySummary {
  visibility: BundleVisibility;
  includesViewerAccountId: boolean;
  includesSourceCaptureTimes: boolean;
  includesRawGraphQL: boolean;
  includesPrivateNotes: boolean;
  includesMediaBlobs: boolean;
  warnings: string[];
}

export interface BundleManifestCounts {
  records: number;
  tweets: number;
  users: number;
  socialEdges: number;
  captures: number;
  mediaBlobs: number;
}

export interface BundleManifest {
  id: string;
  title: string;
  description?: string;
  producer: BundleProducerInfo;
  privacy: BundlePrivacySummary;
  counts: BundleManifestCounts;
  files: BundleFileManifestEntry[];
}

export interface BundleFileManifestEntry {
  path: string;
  contentType: string;
  role: 'manifest' | 'records' | 'media' | 'preview' | 'metadata';
  bytes?: number;
  sha256?: string;
}

export interface BundleRecordEnvelope<T = unknown> {
  id: string;
  kind: BundleEntityKind;
  sourceId?: string;
  sourceExtension?: string;
  observedAt?: number;
  sensitivity: BundleRecordSensitivity;
  data: T;
  mediaRefs?: BundleMediaRef[];
  tags?: string[];
}

export interface BundleMediaRef {
  id: string;
  type: 'photo' | 'video' | 'animated_gif' | 'thumbnail' | 'unknown';
  url?: string;
  previewUrl?: string;
  blobPath?: string;
  altText?: string;
  width?: number;
  height?: number;
}

export interface ImportedBundle {
  id: string;
  title: string;
  description?: string;
  status: BundleImportStatus;
  visibility: BundleVisibility;
  importedAt: number;
  updatedAt: number;
  schemaVersion: number;
  appVersion?: string;
  recordCount: number;
  mediaBlobCount: number;
  manifest: BundleManifest;
  error?: string;
}

export interface ImportedBundleCollection {
  id: string;
  bundle_id: string;
  name: string;
  kind: BundleEntityKind | 'mixed';
  record_count: number;
  created_at: number;
  updated_at: number;
}

export interface ImportedBundleItem {
  id: string;
  bundle_id: string;
  collection_id: string;
  record_id: string;
  kind: BundleEntityKind;
  source_id?: string;
  sort_time?: number;
  created_at: number;
}

export interface ImportedEntitySnapshot<T = unknown> {
  id: string;
  bundle_id: string;
  kind: BundleEntityKind;
  source_id?: string;
  source_extension?: string;
  observed_at?: number;
  sensitivity: BundleRecordSensitivity;
  data: T;
  media_refs?: BundleMediaRef[];
  search_text?: string;
  created_at: number;
  updated_at: number;
}

export interface ImportedBundleImportReport {
  id: string;
  bundle_id: string;
  started_at: number;
  finished_at?: number;
  status: 'ok' | 'failed';
  records_seen: number;
  records_imported: number;
  records_skipped: number;
  warnings: string[];
  error?: string;
}
