import assert from 'node:assert/strict';
import * as ignition from 'axm-ignition-fabric';
import { CapabilityRegistry, runRegisteredCreation } from '@axm/parallel-capability';
import { bindIgnitionExecutorSet, verifyIgnitionExecutionEvidence } from '@axm/parallel-capability/ignition-runtime';

const counters = {
  selected: { materialize: 0, release: 0, work: 0 },
  idle: { materialize: 0, release: 0, work: 0 }
};

function capability(id, token) {
  return {
    schema: 'axm.parallel-capability-manifest/v0.6',
    id,
    version: '1',
    sourceRef: `smoke:${id}`,
    executorRef: `executor:${id}`,
    role: id.toUpperCase(),
    pressure: 'bounded',
    provides: [token],
    dependsOn: [],
    targetAreas: ['config'],
    authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: { workers: 1 },
    inputRefs: ['input:smoke'],
    evidenceRefs: [`evidence:${id}`],
    testRefs: [`test:${id}`],
    priority: 0,
    metadata: { smoke: true }
  };
}

function binding(id, bytes) {
  return {
    executorRef: `executor:${id}`,
    capabilityId: `parallel.smoke.${id}`,
    resourceEstimateBytes: bytes * 4,
    materialize: async () => {
      counters[id].materialize += 1;
      return { instance: { marker: `${id}-runtime` }, allocatedBytes: bytes };
    },
    release: async ({ runtime }) => {
      assert.equal(runtime.marker, `${id}-runtime`);
      counters[id].release += 1;
    },
    work: async ({ state, ignitionRuntime }) => {
      counters[id].work += 1;
      assert.equal(ignitionRuntime.marker, `${id}-runtime`);
      state.config[id] = true;
      return { metadata: { runtimeMarker: ignitionRuntime.marker } };
    }
  };
}

const registry = new CapabilityRegistry();
registry.ingestBundle({
  schema: 'axm.parallel-capability-registry-bundle/v0.6',
  capabilities: [
    capability('selected', 'config.selected'),
    capability('idle', 'config.idle')
  ],
  bodyMaps: [{
    schema: 'axm.parallel-capability-body-map-manifest/v0.6',
    id: 'smoke-body',
    version: '1',
    sourceRef: 'smoke:body',
    areas: [{
      id: 'config',
      path: 'config',
      allowedCapabilities: ['selected', 'idle'],
      authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
    }],
    metadata: { smoke: true }
  }]
});
registry.bindTest('test:selected', ({ state }) => state.config.selected === true);
registry.bindTest('test:idle', ({ state }) => state.config.idle === true);

const bindingReceipt = bindIgnitionExecutorSet(registry, {
  ignition,
  providerSourceRef: process.env.IGNITION_SOURCE_REF ?? null,
  bindings: [binding('selected', 1536), binding('idle', 3072)]
});
assert.equal(bindingReceipt.status, 'BOUND');
assert.equal(bindingReceipt.provider.id, 'axm.ignition.materialization-core');
assert.equal(bindingReceipt.provider.version, '0.6.0');
assert.equal(bindingReceipt.authority.canon, false);

const protectedBody = { config: { selected: false, idle: false } };
const result = await runRegisteredCreation(registry, {
  bodyMapId: 'smoke-body',
  runId: 'real-ignition-package-consumer',
  state: protectedBody,
  stateRef: 'body:smoke-v1',
  rollbackRef: 'body:smoke-v0',
  goal: {
    id: 'materialize-only-selected',
    requirements: [{ id: 'selected', token: 'config.selected' }],
    integrationTests: [{ id: 'selection-kept', test: ({ state }) => state.config.selected === true && state.config.idle === false }]
  },
  constraints: { resourceBudget: { limits: { workers: 2 } } }
});

assert.equal(result.plan.status, 'READY');
assert.equal(result.creation.status, 'READY_FOR_EXPLICIT_COMMIT');
assert.deepEqual(protectedBody, { config: { selected: false, idle: false } });
assert.deepEqual(counters, {
  selected: { materialize: 1, release: 1, work: 1 },
  idle: { materialize: 0, release: 0, work: 0 }
});
assert.deepEqual(result.creation.candidateOrder, ['selected']);
const candidate = result.creation.candidates[0].candidate;
const evidence = candidate.metadata.ignitionExecution;
assert.equal(verifyIgnitionExecutionEvidence(evidence, candidate).status, 'PASS');
assert.deepEqual(evidence.materializedCapabilityIds, ['parallel.smoke.selected']);
assert.deepEqual(evidence.executedCapabilityIds, ['parallel.smoke.selected']);
assert.deepEqual(evidence.releasedCapabilityIds, ['parallel.smoke.selected']);
assert.equal(evidence.actualMaterializedBytes, 1536);
assert.equal(candidate.evidenceRefs.includes(`ignition-execution:sha256:${evidence.receiptSha256}`), true);
assert.equal(result.creation.bodyPlan.mergePlan.commitAllowed, true);

console.log(JSON.stringify({
  status: 'PASS',
  provider: bindingReceipt.provider,
  providerSourceRef: bindingReceipt.providerSourceRef,
  selectedParallelCapability: result.creation.candidateOrder[0],
  ignitionCapability: evidence.capabilityId,
  materializedCapabilityIds: evidence.materializedCapabilityIds,
  idleCapabilityMaterialized: counters.idle.materialize !== 0,
  actualMaterializedBytes: evidence.actualMaterializedBytes,
  protectedBodyUnchanged: protectedBody.config.selected === false && protectedBody.config.idle === false,
  creationStatus: result.creation.status,
  commitCalled: false,
  authority: evidence.authority,
  providerResultHash: evidence.providerResultHash,
  cloneStateSha256: evidence.cloneStateSha256,
  workOutputSha256: evidence.workOutputSha256,
  executionReceiptSha256: evidence.receiptSha256
}, null, 2));
