import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityRegistry,
  commitMerge,
  createRegisteredDecompositionPlan,
  createRegistryBundle,
  runRegisteredCreation,
  validateCapabilityManifest
} from '../src/index.js';

const CAPABILITY_SCHEMA = 'axm.parallel-capability-manifest/v0.6';
const BODY_MAP_SCHEMA = 'axm.parallel-capability-body-map-manifest/v0.6';
const BUNDLE_SCHEMA = 'axm.parallel-capability-registry-bundle/v0.6';

function capability(overrides = {}) {
  return {
    schema: CAPABILITY_SCHEMA,
    id: overrides.id ?? 'config-fast',
    version: overrides.version ?? '1',
    sourceRef: overrides.sourceRef ?? 'repo:demo@v1:capabilities/config-fast',
    executorRef: overrides.executorRef ?? 'executor:config-fast/v1',
    role: overrides.role ?? 'CONFIG',
    pressure: overrides.pressure ?? 'balanced',
    provides: overrides.provides ?? ['config.fast'],
    dependsOn: overrides.dependsOn ?? [],
    targetAreas: overrides.targetAreas ?? ['config'],
    authority: overrides.authority ?? ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: overrides.resources ?? { workers: 1 },
    inputRefs: overrides.inputRefs ?? ['input:demo'],
    evidenceRefs: overrides.evidenceRefs ?? ['evidence:demo'],
    testRefs: overrides.testRefs ?? ['test:config-fast/v1'],
    priority: overrides.priority ?? 0,
    metadata: overrides.metadata ?? { kind: 'demo' }
  };
}

function bodyMap(overrides = {}) {
  return {
    schema: BODY_MAP_SCHEMA,
    id: overrides.id ?? 'demo-body',
    version: overrides.version ?? '1',
    sourceRef: overrides.sourceRef ?? 'repo:demo@v1:body-map',
    areas: overrides.areas ?? [
      {
        id: 'config',
        path: 'config',
        allowedCapabilities: overrides.allowedCapabilities ?? ['config-fast'],
        authorities: overrides.authorities ?? ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
      }
    ],
    metadata: overrides.metadata ?? { owner: 'demo' }
  };
}

function rawBundle(capabilities = [], bodyMaps = []) {
  return { schema: BUNDLE_SCHEMA, capabilities, bodyMaps };
}

function bindFast(registry, {
  executorRef = 'executor:config-fast/v1',
  testRef = 'test:config-fast/v1'
} = {}) {
  registry.bindExecutor(executorRef, ({ state }) => {
    state.config.fast = true;
  });
  registry.bindTest(testRef, ({ state }) => state.config.fast === true);
}

test('registry snapshot is deterministic across manifest input ordering', () => {
  const analyzer = capability({
    id: 'analyzer',
    executorRef: 'executor:analyzer/v1',
    provides: ['config.analyzed'],
    testRefs: ['test:analyzer/v1']
  });
  const fast = capability();
  const map = bodyMap({ allowedCapabilities: ['config-fast', 'analyzer'] });

  const left = new CapabilityRegistry();
  const right = new CapabilityRegistry();
  left.ingestBundle(rawBundle([fast, analyzer], [map]));
  right.ingestBundle(rawBundle([analyzer, fast], [map]));

  assert.equal(left.snapshot().snapshotId, right.snapshot().snapshotId);
  assert.deepEqual(left.snapshot().capabilities, right.snapshot().capabilities);
});

test('runtime bindings do not change the portable structural registry snapshot', () => {
  const registry = new CapabilityRegistry();
  registry.ingestBundle(rawBundle([capability()], [bodyMap()]));
  const before = registry.snapshot();
  bindFast(registry);
  const after = registry.snapshot();

  assert.equal(after.snapshotId, before.snapshotId);
  assert.deepEqual(after, before);
  assert.equal(registry.runtimeAvailability().capabilities[0].executorBound, true);
});

test('exact re-intake is idempotent while conflicting same-id manifests cannot overwrite registry state', () => {
  const registry = new CapabilityRegistry();
  const original = capability();
  const first = registry.ingestBundle(rawBundle([original], [bodyMap()]));
  const snapshotAfterFirst = registry.snapshot().snapshotId;
  const second = registry.ingestBundle(rawBundle([original]));
  const conflict = registry.ingestBundle(rawBundle([capability({ version: '2', sourceRef: 'repo:demo@v2:config-fast' })]));

  assert.equal(first.accepted.some((item) => item.id === 'config-fast'), true);
  assert.equal(second.idempotent.some((item) => item.id === 'config-fast'), true);
  assert.equal(conflict.rejected[0].reason, 'REGISTRY_ID_CONFLICT');
  assert.equal(registry.snapshot().snapshotId, snapshotAfterFirst);
});

test('mixed intake keeps valid manifests and records malformed advertisements as rejections', () => {
  const registry = new CapabilityRegistry();
  const invalid = { ...capability({ id: 'bad' }), testRefs: [] };
  const receipt = registry.ingestBundle(rawBundle([capability(), invalid], [bodyMap()]));

  assert.deepEqual(receipt.accepted.map((item) => item.id).sort(), ['config-fast', 'demo-body']);
  assert.equal(receipt.rejected.length, 1);
  assert.equal(receipt.rejected[0].id, 'bad');
  assert.match(receipt.rejected[0].reason, /testRefs must be non-empty/);
});

test('registry bundle round-trip preserves structural snapshot identity', () => {
  const first = new CapabilityRegistry();
  first.ingestBundle(rawBundle([capability()], [bodyMap()]));
  const bundle = first.toBundle();
  const second = new CapabilityRegistry();
  const receipt = second.ingestBundle(bundle);

  assert.equal(receipt.rejected.length, 0);
  assert.equal(second.snapshot().snapshotId, first.snapshot().snapshotId);
  assert.deepEqual(second.toBundle(), bundle);
});

test('declared manifest hash is checked so a tampered portable entry is rejected', () => {
  const normalized = validateCapabilityManifest(capability());
  const tampered = {
    manifestId: normalized.manifestId,
    manifest: { ...normalized.manifest, version: 'tampered' }
  };
  const registry = new CapabilityRegistry();
  const receipt = registry.ingestBundle(rawBundle([tampered]));

  assert.equal(receipt.accepted.length, 0);
  assert.equal(receipt.rejected.length, 1);
  assert.match(receipt.rejected[0].reason, /Declared manifestId mismatch/);
});

test('resolution closes declared dependencies and carries manifest and registry lineage into runtime descriptors', () => {
  const registry = new CapabilityRegistry();
  const analyzer = capability({
    id: 'analyzer',
    executorRef: 'executor:analyzer/v1',
    provides: ['config.analyzed'],
    testRefs: ['test:analyzer/v1']
  });
  const builder = capability({
    id: 'builder',
    executorRef: 'executor:builder/v1',
    provides: ['config.fast'],
    dependsOn: ['analyzer'],
    testRefs: ['test:builder/v1']
  });
  registry.ingestBundle(rawBundle([builder, analyzer], [bodyMap({ allowedCapabilities: ['analyzer', 'builder'] })]));
  registry.bindExecutor('executor:analyzer/v1', () => {});
  registry.bindExecutor('executor:builder/v1', () => {});
  registry.bindTest('test:analyzer/v1', () => true);
  registry.bindTest('test:builder/v1', () => true);

  const resolved = registry.resolve({ bodyMapId: 'demo-body', capabilityIds: ['builder'] });
  assert.deepEqual(resolved.receipt.resolvedCapabilityIds, ['analyzer', 'builder']);
  assert.equal(resolved.capabilities.every((item) => item.descriptorRef.startsWith('capability-manifest:sha256:')), true);
  assert.equal(resolved.capabilities.every((item) => item.registryRef === resolved.receipt.snapshotId), true);
  assert.deepEqual(resolved.capabilities.find((item) => item.id === 'builder').dependsOn, ['analyzer']);
});

test('missing runtime bindings are reported as unavailable without executing advertised code', () => {
  const registry = new CapabilityRegistry();
  registry.ingestBundle(rawBundle([capability()], [bodyMap()]));
  const resolved = registry.resolve({ bodyMapId: 'demo-body' });

  assert.equal(resolved.capabilities.length, 0);
  assert.deepEqual(resolved.receipt.unavailableCapabilities[0].id, 'config-fast');
  assert.equal(resolved.receipt.unavailableCapabilities[0].reasons.some((reason) => reason.startsWith('MISSING_EXECUTOR_BINDING:')), true);
  assert.equal(resolved.receipt.unavailableCapabilities[0].reasons.some((reason) => reason.startsWith('MISSING_TEST_BINDING:')), true);
});

test('body-map references to unknown capability ids are visible in resolution receipts', () => {
  const registry = new CapabilityRegistry();
  registry.ingestBundle(rawBundle([], [bodyMap({ allowedCapabilities: ['ghost'] })]));
  const resolved = registry.resolve({ bodyMapId: 'demo-body' });

  assert.deepEqual(resolved.receipt.resolvedCapabilityIds, []);
  assert.deepEqual(resolved.receipt.unavailableCapabilities, [
    { id: 'ghost', reasons: ['MISSING_CAPABILITY_MANIFEST'] }
  ]);
});

test('silent runtime rebinding is refused for executor and test references', () => {
  const registry = new CapabilityRegistry();
  const firstExecutor = () => {};
  const secondExecutor = () => {};
  const firstTest = () => true;
  const secondTest = () => true;
  registry.bindExecutor('executor:x', firstExecutor);
  registry.bindTest('test:x', firstTest);

  assert.equal(registry.bindExecutor('executor:x', firstExecutor).status, 'IDEMPOTENT');
  assert.equal(registry.bindTest('test:x', firstTest).status, 'IDEMPOTENT');
  assert.throws(() => registry.bindExecutor('executor:x', secondExecutor), /silent rebinding is forbidden/);
  assert.throws(() => registry.bindTest('test:x', secondTest), /silent rebinding is forbidden/);
});

test('registered decomposition compiles resolved advertisements and preserves registry refs in Creation Fabric inputs', () => {
  const registry = new CapabilityRegistry();
  registry.ingestBundle(createRegistryBundle({ capabilities: [capability()], bodyMaps: [bodyMap()] }));
  bindFast(registry);
  const compiled = createRegisteredDecompositionPlan(registry, {
    bodyMapId: 'demo-body',
    runId: 'registry-plan',
    state: { config: { fast: false } },
    stateRef: 'body:v1',
    rollbackRef: 'body:v0',
    goal: {
      id: 'make-fast',
      requirements: [{ id: 'fast', token: 'config.fast' }],
      integrationTests: [{ id: 'integration-fast', test: ({ state }) => state.config.fast === true }]
    },
    constraints: { resourceBudget: { limits: { workers: 2 } } }
  });

  assert.equal(compiled.plan.status, 'READY');
  assert.equal(compiled.resolution.snapshotId.startsWith('registry-snapshot:sha256:'), true);
  const refs = compiled.plan.creationSpec.candidates[0].inputRefs;
  assert.equal(refs.some((ref) => ref.startsWith('capability-manifest:sha256:')), true);
  assert.equal(refs.some((ref) => ref.startsWith('registry-snapshot:sha256:')), true);
});

test('registered creation executes the resolved catalog but still stops at the explicit protected-body commit gate', async () => {
  const registry = new CapabilityRegistry();
  registry.ingestBundle(rawBundle([capability()], [bodyMap()]));
  bindFast(registry);
  const protectedBody = { config: { fast: false } };
  const result = await runRegisteredCreation(registry, {
    bodyMapId: 'demo-body',
    runId: 'registry-create',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v0',
    goal: {
      id: 'make-fast',
      requirements: [{ id: 'fast', token: 'config.fast' }],
      integrationTests: [{ id: 'integration-fast', test: ({ state }) => state.config.fast === true }]
    },
    constraints: { resourceBudget: { limits: { workers: 2 } } }
  });

  assert.equal(result.plan.status, 'READY');
  assert.equal(result.creation.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.deepEqual(protectedBody, { config: { fast: false } });

  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'body:v1',
    plan: result.creation.bodyPlan.mergePlan
  });
  assert.equal(committed.state.config.fast, true);
  assert.equal(protectedBody.config.fast, false);
});

test('registered capability still loses eligibility when its body map does not grant the requested authority', () => {
  const registry = new CapabilityRegistry();
  registry.ingestBundle(rawBundle([
    capability()
  ], [
    bodyMap({ authorities: ['WRITE-SANDBOX'] })
  ]));
  bindFast(registry);
  const compiled = createRegisteredDecompositionPlan(registry, {
    bodyMapId: 'demo-body',
    runId: 'registry-authority',
    state: { config: { fast: false } },
    stateRef: 'body:v1',
    rollbackRef: 'body:v0',
    goal: {
      id: 'make-fast',
      requirements: [{ id: 'fast', token: 'config.fast' }],
      integrationTests: [{ id: 'integration-fast', test: () => true }]
    },
    constraints: { resourceBudget: { limits: { workers: 2 } } }
  });

  assert.equal(compiled.plan.status, 'HOLD_UNRESOLVED');
  assert.equal(compiled.plan.rejectedCapabilities[0].reasons.includes('MISSING_COMMIT_CANDIDATE_AUTHORITY'), true);
  assert.equal(compiled.plan.unresolved.some((item) => item.type === 'UNCOVERED_REQUIREMENT'), true);
});
