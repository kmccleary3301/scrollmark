import { SCHEMA_REVISION, SCROLLMARK_PROTOCOL } from './contracts';

export const BROWSER_COMPATIBILITY_MATRIX = {
  format: 'scrollmark.compatibility-matrix.v1',
  matrix_revision: '1.0.0',
  protocol: {
    major: 1,
    minor_min: 0,
    minor_max: 0,
    required_header: 'X-Scrollmark-Protocol',
    hash_algorithm: 'sha256-jcs-hex',
  },
  canonical_schema: {
    current_revision: 1,
    accepted_revisions: [1],
    unknown_major_action: 'fail_closed',
    unknown_required_field_action: 'fail_closed',
    unknown_optional_field_action: 'ignore',
  },
  browser_projection_schema_revision: 1,
  browser_projection_generation_revision: 1,
  migration_transforms: ['identity-v1'],
} as const;

export type CompatibilityVersion = { major: number; minor: number };

export type CompatibilityReport = {
  status: 'compatible' | 'unknown' | 'incompatible' | 'lossy';
  reason: string;
  matrix_revision: string;
  transform_id: string;
  transform_hash: string;
};

export function evaluateBrowserCompatibility(args: {
  sourceProtocol: CompatibilityVersion;
  targetProtocol: CompatibilityVersion;
  sourceSchemaRevision: number;
  targetSchemaRevision: number;
  transformId: string;
  transformHash: string;
  lossy?: boolean;
}): CompatibilityReport {
  const base = {
    matrix_revision: BROWSER_COMPATIBILITY_MATRIX.matrix_revision,
    transform_id: args.transformId,
    transform_hash: args.transformHash,
  };
  if (args.lossy) {
    return { ...base, status: 'lossy', reason: 'lossy migration transforms are not automatic' };
  }
  if (
    args.sourceProtocol.major !== SCROLLMARK_PROTOCOL.major ||
    args.targetProtocol.major !== SCROLLMARK_PROTOCOL.major
  ) {
    return { ...base, status: 'unknown', reason: 'unknown protocol major is fail-closed' };
  }
  if (
    args.sourceProtocol.minor < BROWSER_COMPATIBILITY_MATRIX.protocol.minor_min ||
    args.sourceProtocol.minor > BROWSER_COMPATIBILITY_MATRIX.protocol.minor_max ||
    args.targetProtocol.minor < BROWSER_COMPATIBILITY_MATRIX.protocol.minor_min ||
    args.targetProtocol.minor > BROWSER_COMPATIBILITY_MATRIX.protocol.minor_max
  ) {
    return { ...base, status: 'unknown', reason: 'protocol minor is outside the declared matrix' };
  }
  if (
    !BROWSER_COMPATIBILITY_MATRIX.canonical_schema.accepted_revisions.includes(
      args.sourceSchemaRevision as 1,
    ) ||
    !BROWSER_COMPATIBILITY_MATRIX.canonical_schema.accepted_revisions.includes(
      args.targetSchemaRevision as 1,
    )
  ) {
    return {
      ...base,
      status: 'incompatible',
      reason: 'canonical schema revision is not declared compatible',
    };
  }
  if (
    !BROWSER_COMPATIBILITY_MATRIX.migration_transforms.includes(args.transformId as 'identity-v1')
  ) {
    return {
      ...base,
      status: 'incompatible',
      reason: 'migration transform is not declared compatible',
    };
  }
  if (args.transformHash !== '0'.repeat(64)) {
    return {
      ...base,
      status: 'incompatible',
      reason: 'transform hash is not the locked identity transform',
    };
  }
  return { ...base, status: 'compatible', reason: 'declared identity migration is lossless' };
}

export function assertBrowserCompatibility(report: CompatibilityReport): void {
  if (report.status !== 'compatible') {
    throw new Error(`${report.status}: ${report.reason}`);
  }
}

export const CURRENT_BROWSER_COMPATIBILITY = {
  protocol: SCROLLMARK_PROTOCOL,
  schema_revision: SCHEMA_REVISION,
  generation_revision: BROWSER_COMPATIBILITY_MATRIX.browser_projection_generation_revision,
};
