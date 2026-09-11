import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, runRegisteredCreation } from '../src/registry.js';
import {
  bindIgnitionExecutorSet,
  inspectIgnitionProvider,
  verifyIgnitionExecutionEvidence
} from '../src/ignition-runtime.js';

const CAPABILITY_SCHEMA = 'axm.parallel-capability-manifest/v0.6';
const BODY_MAP_SCHEMA = 'axm.parallel-capability-body-map-manifest/v0.6';
const BUNDLE_SCHEMA = 'axm.parallel-capability-registry-bundle/v0.6';

function providerDescriptor(overrides = {}) {
  return {
    schema: 'axm.capability/v1',
    id: 'axm.ignition.materialization-core',
    version: '0.6.0',
    status: 'EXPERIMENTAL',
    runtime: {
      kind: 'node',
      minimumVersion: '18',
      networkRequired: false,
      dependencies: [],
      ...(overrides.runtime ?? {})
    },
    contracts: { runReceipt: 'axm.ignition-run/v0.05' },
    authority: {
      canonical: false,
      automaticMerge: false,
      ...(overrides.authority ?? {})
    }
  };
}

function fakeIgnition(overrides = {}) {
  const descriptor = providerDescriptor(overrides);
  class FakeCapabilityRegistry {
    constructor(capabilities = []) { this.capabilities = [...capabilities]; }
  }
  return {
    describeCapability: () => structuredClone(descriptor),
    CapabilityRegistry: FakeCapabilityRegistry,
    executeIgnitionRun: async ({ registry, request, mode, stateFingerprint }) => {
      const matched = registry.capabilities.filter((capability) => capability.match(request));
      const outputs = {};
      const materialized = [];
      let actualMaterializedBytes = 0;
      try {
        for (const capability of matched) {
          const runtime = capability.materialize ? await capability.materialize({ request }) : { instance: null, allocatedBytes: 0 };
          const normalized = runtime ?? { instance: null, allocatedBytes: 0 };
          actualMaterializedBytes += Number(normalized.allocatedBytes ?? 0);
          materialized.push({ capability, runtime: normalized.instance ?? null });
        }
        for (const { capability, runtime } of materialized) {
          outputs[capability.id] = await capability.run({ request, runtime });
        }
      } finally {
        for (const { capability, runtime } of [...materialized].reverse()) {
          if (capability.release) await capability.release({ request, runtime });
        }
      }
      const ids = matched.map((item) => item.id).sort();
      return {
        result: outputs,
        receipt: {
          schema: 'axm.ignition-run/v0.05',
          runId: `fake:${request.executorRef}`,
          mode,
          requestHash: `request:${request.executorRef}`,
          stateHash: stateFingerprint,
          matchedCapabilityIds: ids,
          materializedCapabilityIds: ids,
          executedCapabilityIds: ids,
          releasedCapabilityIds: ids,
          estimatedWorkingSetBytes: matched.reduce((sum, item) => sum + item.resourceEstimateBytes, 0),
          actualMaterializedBytes,
          resultHash: `result:${request.executorRef}`
        }
      };
    }
  };
}

function capability(id, token) {
  return {
    schema: CAPABILITY_SCHEMA,
    id,
    version: '1',
    sourceRef: `repo:test@v1:${id}`,
    executorRef: `executor:${id}`,
    role: id.toUpperCase(),
    pressure: 'bounded',
    provides: [token],
    dependsOn: [],
    targetAreas: ['config'],
    authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: { workers: 1 },
    inputRefs: ['input:test'],
    evidenceRefs: [`evidence:${id}`],
    testRefs: [`test:${id}`],
    priority: 0,
    metadata: { test: true }
  };
}

function bodyMap() {
  return {
    schema: BODY_MAP_SCHEMA,
    id: 'demo-body',
    version: '1',
    sourceRef: 'repo:test@v1:body',
    areas: [{
      id: 'config',
      path: 'config',
      allowedCapabilities: ['alpha', 'beta'],
      authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
    }],
    metadata: { test: true }
  };
}

function fixtureRegistry() {
  const registry = new CapabilityRegistry();
  registry.ingestBundle({
    schema: BUNDLE_SCHEMA,
    capabilities: [capability('alpha', 'config.alpha'), capability('beta', 'config.beta')],
    bodyMaps: [bodyMap()]
  });
  registry.bindTest('test:alpha', ({ state }) => state.config.alpha === true);
  registry.bindTest('test:beta', ({ state }) => state.config.beta === true);
  return registry;
}

function binding(id, counters) {
  return {
    executorRef: `executor:${id}`,
    capabilityId: `parallel.runtime.${id}`,
    resourceEstimateBytes: id === 'alpha' ? 4096 : 8192,
    materialize: async () => {
      counters[id].materialize += 1;
      return { instance: { id: `${id}-runtime` }, allocatedBytes: id === 'alpha' ? 1024 : 2048 };
    },
    release: async ({ runtime }) => {
      assert.equal(runtime.id, `${id}-runtime`);
      counters[id].release += 1;
    },
    work: async ({ state, ignitionRuntime }) => {
      counters[id].work += 1;
      assert.equal(ignitionRuntime.id, `${id}-runtime`);
      state.config[id] = true;
      return { metadata: { runtimeId: ignitionRuntime.id } };
    }
  };
}

function counters() {
  return { alpha: { materialize: 0, release: 0, work: 0 }, beta: { materialize: 0, release: 0, work: 0 } };
}

test('provider inspection is evidence-only and rejects widened runtime authority', () => {
  const ready = inspectIgnitionProvider(fakeIgnition());
  assert.equal(ready.status, 'READY');
  assert.equal(ready.provider.id, 'axm.ignition.materialization-core');
  assert.equal(ready.authority.kind, 'MATERIALIZATION_EVIDENCE_ONLY');
  assert.equal(ready.authority.canon, false);

  const widened = inspectIgnitionProvider(fakeIgnition({ runtime: { networkRequired: true } }));
  assert.equal(widened.status, 'HOLD');
  assert.equal(widened.reason.code, 'PROVIDER_CONTRACT_REJECTED');
});

test('missing optional provider leaves Parallel executor refs unbound', () => {
  const registry = fixtureRegistry();
  const tally = counters();
  const receipt = bindIgnitionExecutorSet(registry, {
    ignition: null,
    bindings: [binding('alpha', tally), binding('beta', tally)]
  });
  assert.equal(receipt.status, 'HOLD');
  assert.equal(receipt.reason.code, 'PROVIDER_UNAVAILABLE_OR_INCOMPATIBLE');
  assert.equal(registry.runtimeAvailability().capabilities.every((item) => item.executorBound === false), true);
});

test('preflight refuses partial rebinding when one executor ref is already occupied', () => {
  const registry = fixtureRegistry();
  registry.bindExecutor('executor:alpha', () => {});
  const tally = counters();
  const receipt = bindIgnitionExecutorSet(registry, {
    ignition: fakeIgnition(),
    bindings: [binding('alpha', tally), binding('beta', tally)]
  });
  assert.equal(receipt.status, 'HOLD');
  assert.equal(receipt.reason.code, 'EXECUTOR_ALREADY_BOUND');
  const availability = registry.runtimeAvailability().capabilities;
  assert.equal(availability.find((item) => item.id === 'alpha').executorBound, true);
  assert.equal(availability.find((item) => item.id === 'beta').executorBound, false);
});

test('selected Parallel capability alone materializes through Ignition and returns verifiable evidence', async () => {
  const registry = fixtureRegistry();
  const tally = counters();
  const bindReceipt = bindIgnitionExecutorSet(registry, {
    ignition: fakeIgnition(),
    providerSourceRef: 'mike-axiom-mir/axm-ignition-fabric@fixture',
    bindings: [binding('alpha', tally), binding('beta', tally)]
  });
  assert.equal(bindReceipt.status, 'BOUND');
  assert.deepEqual(registry.runtimeAvailability().capabilities.map((item) => item.executorBound), [true, true]);

  const protectedBody = { config: { alpha: false, beta: false } };
  const result = await runRegisteredCreation(registry, {
    bodyMapId: 'demo-body',
    runId: 'ignition-selective-materialization',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v0',
    goal: {
      id: 'enable-alpha',
      requirements: [{ id: 'alpha', token: 'config.alpha' }],
      integrationTests: [{ id: 'only-alpha', test: ({ state }) => state.config.alpha === true && state.config.beta === false }]
    },
    constraints: { resourceBudget: { limits: { workers: 2 } } }
  });

  assert.equal(result.plan.status, 'READY');
  assert.equal(result.creation.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.deepEqual(protectedBody, { config: { alpha: false, beta: false } });
  assert.deepEqual(tally, {
    alpha: { materialize: 1, release: 1, work: 1 },
    beta: { materialize: 0, release: 0, work: 0 }
  });
  assert.deepEqual(result.creation.candidateOrder, ['alpha']);
  const execution = result.creation.candidates[0].candidate.metadata.ignitionExecution;
  assert.equal(execution.actualMaterializedBytes, 1024);
  assert.deepEqual(execution.materializedCapabilityIds, ['parallel.runtime.alpha']);
  assert.equal(verifyIgnitionExecutionEvidence(execution).status, 'PASS');
  assert.equal(result.creation.candidates[0].candidate.evidenceRefs.some((ref) => ref === `ignition-execution:sha256:${execution.receiptSha256}`), true);
});

test('execution evidence fails closed after materialization claim drift', async () => {
  const registry = fixtureRegistry();
  const tally = counters();
  bindIgnitionExecutorSet(registry, { ignition: fakeIgnition(), bindings: [binding('alpha', tally), binding('beta', tally)] });
  const work = registry.executors.get('executor:alpha').work;
  const output = await work({
    id: 'alpha', laneId: 'lane-a', taskId: 'task-a',
    state: { config: { alpha: false, beta: false } },
    sourceState: { config: { alpha: false, beta: false } },
    stateRef: 'body:v1', sourceStateHash: 'source-hash'
  });
  const tampered = structuredClone(output.metadata.ignitionExecution);
  tampered.actualMaterializedBytes += 1;
  assert.throws(() => verifyIgnitionExecutionEvidence(tampered), /receiptSha256 mismatch/);
});

test('execution evidence fails closed when detached from the returned clone output', async () => {
  const registry = fixtureRegistry();
  const tally = counters();
  bindIgnitionExecutorSet(registry, { ignition: fakeIgnition(), bindings: [binding('alpha', tally), binding('beta', tally)] });
  const result = await runRegisteredCreation(registry, {
    bodyMapId: 'demo-body',
    runId: 'ignition-output-binding',
    state: { config: { alpha: false, beta: false } },
    stateRef: 'body:v1',
    rollbackRef: 'body:v0',
    goal: {
      id: 'enable-alpha',
      requirements: [{ id: 'alpha', token: 'config.alpha' }],
      integrationTests: [{ id: 'only-alpha', test: ({ state }) => state.config.alpha === true && state.config.beta === false }]
    },
    constraints: { resourceBudget: { limits: { workers: 2 } } }
  });
  const candidate = result.creation.candidates[0].candidate;
  const receipt = candidate.metadata.ignitionExecution;
  assert.equal(verifyIgnitionExecutionEvidence(receipt, candidate).status, 'PASS');

  const detached = structuredClone(candidate);
  detached.metadata.runtimeId = 'foreign-runtime';
  assert.throws(
    () => verifyIgnitionExecutionEvidence(receipt, detached),
    /work output SHA-256 mismatch/
  );
});

test('reserved evidence namespace cannot be silently overwritten by a wrapped executor', async () => {
  const registry = fixtureRegistry();
  const tally = counters();
  const bad = binding('alpha', tally);
  bad.work = async () => ({ metadata: { ignitionExecution: { forged: true } } });
  bindIgnitionExecutorSet(registry, { ignition: fakeIgnition(), bindings: [bad, binding('beta', tally)] });
  await assert.rejects(() => registry.executors.get('executor:alpha').work({
    id: 'alpha', laneId: 'lane-a', taskId: 'task-a', state: { config: {} }, sourceState: { config: {} }, stateRef: 'body:v1', sourceStateHash: 'source-hash'
  }), /reserved by the Ignition adapter/);
});

test('duplicate executor identities are refused before registry mutation', () => {
  const registry = fixtureRegistry();
  const tally = counters();
  const alpha = binding('alpha', tally);
  const duplicate = { ...binding('beta', tally), executorRef: alpha.executorRef };
  assert.throws(() => bindIgnitionExecutorSet(registry, { ignition: fakeIgnition(), bindings: [alpha, duplicate] }), /Duplicate executorRef/);
  assert.equal(registry.runtimeAvailability().capabilities.every((item) => item.executorBound === false), true);
});
