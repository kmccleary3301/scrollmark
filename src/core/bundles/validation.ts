import { BundleManifest, BundleRecordEnvelope } from './schema';

export interface BundleValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface BundleValidationResult {
  ok: boolean;
  issues: BundleValidationIssue[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pushError(issues: BundleValidationIssue[], path: string, message: string) {
  issues.push({ path, message, severity: 'error' });
}

export function validateBundleManifest(value: unknown): BundleValidationResult {
  const issues: BundleValidationIssue[] = [];
  if (!isObject(value)) {
    pushError(issues, '$', 'Manifest must be an object.');
    return { ok: false, issues };
  }

  const manifest = value as Partial<BundleManifest>;
  if (!manifest.id || typeof manifest.id !== 'string')
    pushError(issues, '$.id', 'Missing bundle id.');
  if (!manifest.title || typeof manifest.title !== 'string')
    pushError(issues, '$.title', 'Missing title.');
  if (!isObject(manifest.producer)) pushError(issues, '$.producer', 'Missing producer block.');
  if (!isObject(manifest.privacy)) pushError(issues, '$.privacy', 'Missing privacy block.');
  if (!isObject(manifest.counts)) pushError(issues, '$.counts', 'Missing counts block.');
  if (!Array.isArray(manifest.files)) pushError(issues, '$.files', 'Files must be an array.');

  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

export function validateBundleRecordEnvelope(value: unknown): BundleValidationResult {
  const issues: BundleValidationIssue[] = [];
  if (!isObject(value)) {
    pushError(issues, '$', 'Record envelope must be an object.');
    return { ok: false, issues };
  }

  const record = value as Partial<BundleRecordEnvelope>;
  if (!record.id || typeof record.id !== 'string') pushError(issues, '$.id', 'Missing record id.');
  if (!record.kind || typeof record.kind !== 'string')
    pushError(issues, '$.kind', 'Missing record kind.');
  if (!record.sensitivity || typeof record.sensitivity !== 'string') {
    pushError(issues, '$.sensitivity', 'Missing sensitivity.');
  }
  if (!('data' in record)) pushError(issues, '$.data', 'Missing data payload.');

  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}
