import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HASH_RE = /^[0-9a-f]{64}$/;

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function canonicalize(value) {
  const encoded = JSON.stringify(sortKeys(value));
  if (encoded === undefined) throw new Error('unsupported undefined JSON value');
  return encoded;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonicalize(value), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function recordMaterial(namespaceId, mutation) {
  const material = {
    namespace_id: namespaceId,
    kind: mutation.kind,
    schema_revision: mutation.schema_revision,
    provenance: mutation.provenance,
    observed_at_ms: mutation.observed_at_ms,
  };
  if (mutation.kind === 'entity_upsert') {
    material.target = mutation.target;
    material.payload = mutation.payload;
  } else if (mutation.kind === 'relationship_upsert') {
    material.relationship_kind = mutation.relationship_kind;
    material.subject = mutation.subject;
    material.object = mutation.object;
    material.qualifier = mutation.qualifier;
    material.payload = mutation.payload;
  } else if (mutation.kind === 'enrichment_upsert') {
    material.target = mutation.target;
    material.enrichment_kind = mutation.enrichment_kind;
    material.payload = mutation.payload;
  } else if (mutation.kind === 'tombstone') {
    material.target_kind = mutation.target_kind;
    material.target_id = mutation.target_id;
    material.relationship_kind = mutation.relationship_kind;
    material.deletion_id = mutation.deletion_id;
  } else {
    throw new Error(`unknown mutation kind: ${mutation.kind}`);
  }
  return material;
}

function recordHash(namespaceId, mutation) {
  return sha256(recordMaterial(namespaceId, mutation));
}

function batchHash(namespaceId, batch) {
  return sha256({
    namespace_id: namespaceId,
    schema_revisions: [...new Set(batch.mutations.map((mutation) => mutation.schema_revision))].sort((a, b) => a - b),
    mutations: batch.mutations.map((mutation) => ({
      client_seq: mutation.client_seq,
      mutation_id: mutation.mutation_id,
      kind: mutation.kind,
      record_hash: mutation.record_hash,
    })),
  });
}

function validateEndpoint(endpoint, namespaceId, errors, pathName) {
  if (!endpoint || typeof endpoint !== 'object') {
    errors.push(`missing:${pathName}`);
    return;
  }
  if (endpoint.namespace_id !== namespaceId) errors.push('relationship_namespace_context_required');
}

function validateRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object') return ['type'];
  for (const field of ['protocol', 'request_id', 'archive_id', 'namespace_id', 'client_id', 'client_epoch', 'sent_at_ms', 'client_sequence', 'batch', 'known_checkpoint']) {
    if (!(field in request)) errors.push(`missing:${field}`);
  }
  const protocolKeys = Object.keys(request.protocol ?? {});
  if (protocolKeys.some((key) => !['major', 'minor', 'extensions'].includes(key))) errors.push('unknown_required_field');
  if (request.protocol?.major !== 1 || request.protocol?.minor !== 0) errors.push('protocol_version_unsupported');
  for (const field of ['request_id', 'archive_id', 'namespace_id', 'client_id', 'client_epoch']) {
    if (typeof request[field] !== 'string' || request[field].length === 0) errors.push(`missing:${field}`);
  }
  const sequence = request.client_sequence;
  const mutations = request.batch?.mutations;
  if (!Array.isArray(mutations) || mutations.length === 0) {
    errors.push('empty_batch');
    return errors;
  }
  if (request.batch.mutation_count !== mutations.length) errors.push('mutation_count_mismatch');
  const values = mutations.map((mutation) => mutation.client_seq);
  const expected = Array.from({ length: sequence.to - sequence.from + 1 }, (_, index) => sequence.from + index);
  if (JSON.stringify(values) !== JSON.stringify(expected)) errors.push('client_sequence_not_contiguous');
  for (const mutation of mutations) {
    for (const endpointName of ['target', 'subject', 'object']) {
      if (mutation[endpointName]) validateEndpoint(mutation[endpointName], request.namespace_id, errors, endpointName);
    }
    if (!HASH_RE.test(mutation.record_hash) || mutation.record_hash !== recordHash(request.namespace_id, mutation)) {
      errors.push('record_hash_mismatch');
    }
  }
  if (!HASH_RE.test(request.batch.batch_hash) || request.batch.batch_hash !== batchHash(request.namespace_id, request.batch)) {
    errors.push('batch_hash_mismatch');
  }
  return [...new Set(errors)];
}

function validateValue(value) {
  if (value?.format === 'scrollmark.compatibility-matrix.v1') {
    return value.features?.direct_messages === true ? ['privacy_dm_enabled'] : [];
  }
  return validateRequest(value);
}

function main() {
  const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/canonicalization.json'), 'utf8')).vectors;
  const positive = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/archive-delta-request.json'), 'utf8'));
  const negative = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/negative.json'), 'utf8'));
  const vectorResults = vectors.map((vector) => {
    const canonical = canonicalize(vector.input);
    return {
      name: vector.name,
      canonical,
      sha256: sha256(canonical),
      expected_sha256: vector.sha256,
      matches: canonical === vector.canonical && sha256(canonical) === vector.sha256,
    };
  });
  const negativeResults = negative.map((fixture) => ({
    name: fixture.name,
    expected_code: fixture.expected_code,
    codes: validateValue(fixture.value),
  }));
  const output = {
    ok: vectorResults.every((result) => result.matches) && validateValue(positive).length === 0,
    vectorResults,
    positiveValid: validateValue(positive).length === 0,
    negativeResults,
    canonicalization_impl: 'javascript-json-stringify-sorted-utf16',
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main();
