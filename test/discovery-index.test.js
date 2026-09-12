import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDiscoveryRequirementReceipt, validateDiscoveryIndex } from '../src/discovery-index.js';

function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function fixture({ publicMode = true } = {}) {
  const sourceSha = '1'.repeat(64);
  const repository = publicMode ? {
    repo: 'mike-axiom-mir/provider',
    display_name: 'Provider',
    public_marker_sha256: '2'.repeat(64),
    beacon: { present: false },
    capabilities: {
      sources: [{ path: 'registry/capabilities.jsonl', sha256: sourceSha, records: 2, errors: 0 }],
      records: [
        { schema: 'axm.discovery-capability/v0.1', id: 'axm.shared.alpha', providers: ['provider-a'], consumers: [], status: 'IMPLEMENTED_REFERENCE', source: 'registry/capabilities.jsonl', line: 1 },
        { schema: 'axm.discovery-capability/v0.1', id: 'axm.shared.beta', providers: [], consumers: ['consumer-b'], status: 'DECLARED', source: 'registry/capabilities.jsonl', line: 2 }
      ]
    }
  } : {
    path: 'provider',
    name: 'provider',
    git: { present: true, branch: 'main', head: 'a'.repeat(40), detached: false },
    readme: { present: true, sha256: '3'.repeat(64), error: null },
    agents: { present: false, sha256: null },
    beacon: { present: false },
    public_marker: { present: false, eligible: false },
    capabilities: {
      sources: [{ path: 'registry/capabilities.jsonl', sha256: sourceSha, records: 2, errors: 0 }],
      records: [
        { schema: 'axm.discovery-capability/v0.1', id: 'axm.shared.alpha', providers: ['provider-a'], consumers: [], status: 'IMPLEMENTED_REFERENCE', source: 'registry/capabilities.jsonl', line: 1 },
        { schema: 'axm.discovery-capability/v0.1', id: 'axm.shared.beta', providers: [], consumers: ['consumer-b'], status: 'DECLARED', source: 'registry/capabilities.jsonl', line: 2 }
      ]
    }
  };
  const policy = { max_depth: 4, public: publicMode, excluded_directory_names: ['.git'], absolute_paths_exported: false, file_contents_exported: false, public_requires_explicit_marker: true };
  const repositories = [repository];
  const digestPayload = { schema: 'axm.discovery-index/v0.1', policy, repositories };
  return {
    schema: 'axm.discovery-index/v0.1',
    visibility: publicMode ? 'PUBLIC_SAFE_DECLARED_ONLY' : 'LOCAL_ONLY',
    root: '.',
    policy,
    summary: { repositories: 1, capability_records: 2, beacons: 0 },
    repositories,
    content_sha256: createHash('sha256').update(stableStringify(digestPayload)).digest('hex')
  };
}

test('validates Discovery Buddy v0.1 index identity and source lineage', () => {
  const index = fixture();
  const verified = validateDiscoveryIndex(index);
  assert.equal(verified.contentSha256, index.content_sha256);
  assert.equal(verified.repositories[0].capabilities.records.length, 2);
});

test('turns discovered declarations into proposal-only requirement candidates', () => {
  const receipt = createDiscoveryRequirementReceipt(fixture(), {
    requirements: ['axm.shared.missing', 'axm.shared.alpha', { id: 'axm.shared.beta' }]
  });
  assert.deepEqual(receipt.requirements.map((item) => item.capabilityId), ['axm.shared.alpha', 'axm.shared.beta', 'axm.shared.missing']);
  assert.equal(receipt.requirements[0].candidates[0].providers[0], 'provider-a');
  assert.equal(receipt.requirements[0].candidates[0].executionAuthority, 'NONE');
  assert.equal(receipt.requirements[2].status, 'NOT_DISCOVERED');
  assert.deepEqual(receipt.authority, { kind: 'DISCOVERY_EVIDENCE_ONLY', execution: false, selection: false, install: false, merge: false, canon: false });
  assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/);
});

test('supports local indexes without converting workspace paths into public repository claims', () => {
  const receipt = createDiscoveryRequirementReceipt(fixture({ publicMode: false }), { requirements: ['axm.shared.alpha'] });
  assert.equal(receipt.discoveryVisibility, 'LOCAL_ONLY');
  assert.equal(receipt.requirements[0].candidates[0].repository, 'provider');
});

test('fails closed when discovery index content is changed without refreshing its digest', () => {
  const index = fixture();
  index.repositories[0].capabilities.records[0].providers.push('forged-provider');
  assert.throws(() => validateDiscoveryIndex(index), /content_sha256 mismatch/);
});

test('fails closed when a capability record is detached from its source ledger', () => {
  const index = fixture();
  index.repositories[0].capabilities.records[0].source = 'registry/other.jsonl';
  const payload = { schema: index.schema, policy: index.policy, repositories: index.repositories };
  index.content_sha256 = createHash('sha256').update(stableStringify(payload)).digest('hex');
  assert.throws(() => validateDiscoveryIndex(index), /unknown source/);
});

test('fails closed when declared source record counts do not match retained records', () => {
  const index = fixture();
  index.repositories[0].capabilities.sources[0].records = 3;
  const payload = { schema: index.schema, policy: index.policy, repositories: index.repositories };
  index.content_sha256 = createHash('sha256').update(stableStringify(payload)).digest('hex');
  assert.throws(() => validateDiscoveryIndex(index), /record count mismatch/);
});
