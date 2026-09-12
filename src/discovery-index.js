import { createHash } from 'node:crypto';

const DISCOVERY_SCHEMA = 'axm.discovery-index/v0.1';
const CAPABILITY_SCHEMA = 'axm.discovery-capability/v0.1';
const RECEIPT_SCHEMA = 'axm.parallel-capability-discovery-receipt/v0.1';
const SHA256_RE = /^[0-9a-f]{64}$/;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function validateDiscoveryIndex(index) {
  assertPlainObject(index, 'discovery index');
  if (index.schema !== DISCOVERY_SCHEMA) {
    throw new Error(`Unsupported discovery index schema: ${index.schema ?? '<missing>'}`);
  }
  if (!['LOCAL_ONLY', 'PUBLIC_SAFE_DECLARED_ONLY'].includes(index.visibility)) {
    throw new Error(`Unsupported discovery index visibility: ${index.visibility ?? '<missing>'}`);
  }
  assertPlainObject(index.policy, 'discovery index.policy');
  assertPlainObject(index.summary, 'discovery index.summary');
  if (!Array.isArray(index.repositories)) throw new TypeError('discovery index.repositories must be an array');
  if (!SHA256_RE.test(String(index.content_sha256 ?? ''))) {
    throw new TypeError('discovery index.content_sha256 must be a lowercase SHA-256');
  }

  const repositories = index.repositories.map((repo, repoIndex) => normalizeRepository(repo, index.visibility, repoIndex));
  const expectedSummary = {
    repositories: repositories.length,
    capability_records: repositories.reduce((total, repo) => total + repo.capabilities.records.length, 0),
    beacons: repositories.reduce((total, repo) => total + (repo.beacon?.present ? 1 : 0), 0)
  };
  for (const [key, expected] of Object.entries(expectedSummary)) {
    if (index.summary[key] !== expected) {
      throw new Error(`discovery index.summary.${key} mismatch: ${index.summary[key]} !== ${expected}`);
    }
  }

  const digestPayload = {
    schema: index.schema,
    policy: index.policy,
    repositories: index.repositories
  };
  const actualDigest = sha256(stableStringify(digestPayload));
  if (actualDigest !== index.content_sha256) {
    throw new Error(`discovery index content_sha256 mismatch: ${index.content_sha256} !== ${actualDigest}`);
  }

  return {
    schema: index.schema,
    visibility: index.visibility,
    contentSha256: index.content_sha256,
    repositories
  };
}

export function createDiscoveryRequirementReceipt(index, { requirements = [] } = {}) {
  const verified = validateDiscoveryIndex(index);
  const capabilityIds = normalizeRequirements(requirements);
  const declarations = verified.repositories.flatMap((repo) =>
    repo.capabilities.records.map((record) => ({ repo, record }))
  );

  const resolved = capabilityIds.map((capabilityId) => {
    const candidates = declarations
      .filter(({ record }) => record.id === capabilityId)
      .map(({ repo, record }) => ({
        capabilityId,
        repository: repo.identity,
        displayName: repo.displayName,
        providers: [...record.providers],
        consumers: [...record.consumers],
        declaredStatus: record.status,
        source: record.source,
        line: record.line,
        evidenceRef: `discovery-index:sha256:${verified.contentSha256}:${encodeURIComponent(repo.identity)}:${encodeURIComponent(record.source)}:${record.line}`,
        declarationOnly: true,
        runtimeVerified: false,
        executionAuthority: 'NONE'
      }))
      .sort(compareCandidates);
    return {
      capabilityId,
      status: candidates.length > 0 ? 'DISCOVERED_DECLARATION' : 'NOT_DISCOVERED',
      candidates
    };
  });

  const core = {
    schema: RECEIPT_SCHEMA,
    discoverySchema: verified.schema,
    discoveryVisibility: verified.visibility,
    discoveryContentSha256: verified.contentSha256,
    requirements: resolved,
    summary: {
      requested: capabilityIds.length,
      matched: resolved.filter((item) => item.candidates.length > 0).length,
      candidateDeclarations: resolved.reduce((total, item) => total + item.candidates.length, 0),
      declaredProviders: new Set(resolved.flatMap((item) => item.candidates.flatMap((candidate) => candidate.providers))).size
    },
    authority: {
      kind: 'DISCOVERY_EVIDENCE_ONLY',
      execution: false,
      selection: false,
      install: false,
      merge: false,
      canon: false
    }
  };
  return {
    ...core,
    receiptSha256: sha256(stableStringify(core))
  };
}

function normalizeRepository(repo, visibility, repoIndex) {
  assertPlainObject(repo, `repositories[${repoIndex}]`);
  assertPlainObject(repo.capabilities, `repositories[${repoIndex}].capabilities`);
  if (!Array.isArray(repo.capabilities.sources)) throw new TypeError(`repositories[${repoIndex}].capabilities.sources must be an array`);
  if (!Array.isArray(repo.capabilities.records)) throw new TypeError(`repositories[${repoIndex}].capabilities.records must be an array`);

  const identity = visibility === 'PUBLIC_SAFE_DECLARED_ONLY' ? repo.repo : repo.path;
  if (typeof identity !== 'string' || identity.trim() === '') {
    throw new TypeError(`repositories[${repoIndex}] is missing its ${visibility === 'PUBLIC_SAFE_DECLARED_ONLY' ? 'repo' : 'path'} identity`);
  }
  const displayName = visibility === 'PUBLIC_SAFE_DECLARED_ONLY'
    ? (typeof repo.display_name === 'string' && repo.display_name ? repo.display_name : identity)
    : (typeof repo.name === 'string' && repo.name ? repo.name : identity);

  const sources = repo.capabilities.sources.map((source, sourceIndex) => normalizeSource(source, repoIndex, sourceIndex));
  const sourcePaths = new Set(sources.filter((source) => !source.error).map((source) => source.path));
  const records = repo.capabilities.records.map((record, recordIndex) =>
    normalizeCapabilityRecord(record, repoIndex, recordIndex, sourcePaths)
  );

  for (const source of sources) {
    if (source.error) continue;
    const observed = records.filter((record) => record.source === source.path).length;
    if (source.records !== observed) {
      throw new Error(`repository ${identity} source ${source.path} record count mismatch: ${source.records} !== ${observed}`);
    }
  }

  return {
    identity,
    displayName,
    beacon: repo.beacon && typeof repo.beacon === 'object' ? cloneJson(repo.beacon) : null,
    capabilities: { sources, records }
  };
}

function normalizeSource(source, repoIndex, sourceIndex) {
  assertPlainObject(source, `repositories[${repoIndex}].capabilities.sources[${sourceIndex}]`);
  const path = normalizeRelativePath(source.path, `repositories[${repoIndex}].capabilities.sources[${sourceIndex}].path`);
  const error = source.error == null ? null : String(source.error);
  if (error) return { path, error };
  if (!SHA256_RE.test(String(source.sha256 ?? ''))) throw new TypeError(`source ${path}.sha256 must be a lowercase SHA-256`);
  if (!Number.isInteger(source.records) || source.records < 0) throw new TypeError(`source ${path}.records must be a non-negative integer`);
  if (!Number.isInteger(source.errors) || source.errors < 0) throw new TypeError(`source ${path}.errors must be a non-negative integer`);
  return { path, sha256: source.sha256, records: source.records, errors: source.errors };
}

function normalizeCapabilityRecord(record, repoIndex, recordIndex, sourcePaths) {
  assertPlainObject(record, `repositories[${repoIndex}].capabilities.records[${recordIndex}]`);
  if (record.schema !== CAPABILITY_SCHEMA) throw new Error(`Unsupported discovery capability schema: ${record.schema ?? '<missing>'}`);
  if (typeof record.id !== 'string' || record.id.trim() === '') throw new TypeError('discovery capability id is required');
  const source = normalizeRelativePath(record.source, `capability ${record.id}.source`);
  if (!sourcePaths.has(source)) throw new Error(`capability ${record.id} references unknown source ${source}`);
  if (!Number.isInteger(record.line) || record.line < 1) throw new TypeError(`capability ${record.id}.line must be a positive integer`);
  return {
    schema: CAPABILITY_SCHEMA,
    id: record.id,
    providers: uniqueStrings(record.providers ?? [], `capability ${record.id}.providers`),
    consumers: uniqueStrings(record.consumers ?? [], `capability ${record.id}.consumers`),
    status: record.status == null ? null : String(record.status),
    source,
    line: record.line
  };
}

function normalizeRequirements(requirements) {
  if (!Array.isArray(requirements)) throw new TypeError('requirements must be an array');
  const values = requirements.map((item, index) => {
    if (typeof item === 'string') {
      if (!item.trim()) throw new TypeError(`requirements[${index}] must not be empty`);
      return item;
    }
    assertPlainObject(item, `requirements[${index}]`);
    const capabilityId = item.capabilityId ?? item.id;
    if (typeof capabilityId !== 'string' || !capabilityId.trim()) {
      throw new TypeError(`requirements[${index}] requires capabilityId or id`);
    }
    return capabilityId;
  });
  return [...new Set(values)].sort();
}

function normalizeRelativePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty path`);
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value) || value.includes('\\')) {
    throw new TypeError(`${label} must be a portable repository-relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${label} contains an unsafe path segment`);
  }
  return parts.join('/');
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return [...new Set(values.map((value) => {
    if (typeof value !== 'string') throw new TypeError(`${label} must contain strings`);
    return value;
  }))].sort();
}

function compareCandidates(a, b) {
  return `${a.capabilityId}\u0000${a.repository}\u0000${a.source}\u0000${String(a.line).padStart(12, '0')}`
    .localeCompare(`${b.capabilityId}\u0000${b.repository}\u0000${b.source}\u0000${String(b.line).padStart(12, '0')}`);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (BLOCKED_KEYS.has(key)) throw new TypeError(`${label} contains blocked key ${key}`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Cannot canonicalize non-JSON value');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
