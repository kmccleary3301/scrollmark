import { BundlePrivacyOptions, BundlePrivacySummary } from './schema';

export const SAFE_SHARED_DEFAULT_PRIVACY: BundlePrivacyOptions = {
  includeViewerAccountId: false,
  includeSourceCaptureTimes: false,
  includeRawGraphQL: false,
  includePrivateNotes: false,
  includeMediaBlobs: false,
  visibility: 'shared_safe',
};

export function buildBundlePrivacySummary(options: BundlePrivacyOptions): BundlePrivacySummary {
  return {
    visibility: options.visibility,
    includesViewerAccountId: options.includeViewerAccountId,
    includesSourceCaptureTimes: options.includeSourceCaptureTimes,
    includesRawGraphQL: options.includeRawGraphQL,
    includesPrivateNotes: options.includePrivateNotes,
    includesMediaBlobs: options.includeMediaBlobs,
    warnings: describeBundlePrivacyWarnings(options),
  };
}

export function describeBundlePrivacyWarnings(options: BundlePrivacyOptions): string[] {
  const warnings: string[] = [];
  if (options.includeViewerAccountId) warnings.push('Includes the exporting account identifier.');
  if (options.includeSourceCaptureTimes) warnings.push('Includes local capture/import timestamps.');
  if (options.includeRawGraphQL)
    warnings.push('Includes raw API payloads that may contain unrelated account context.');
  if (options.includePrivateNotes) warnings.push('Includes user-authored local notes or labels.');
  if (options.includeMediaBlobs)
    warnings.push('Includes downloaded media files, increasing size and redistribution risk.');
  if (options.visibility === 'public' && warnings.length) {
    warnings.unshift('Public bundle includes fields that should be reviewed before sharing.');
  }
  return warnings;
}
