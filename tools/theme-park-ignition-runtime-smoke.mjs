import assert from 'node:assert/strict';
import * as ignition from 'axm-ignition-fabric';
import {
  HeadlessSimulator,
  describeCapability as describeThemeParkCapability
} from 'axm-theme-park-simulator-local';
import {
  CapabilityRegistry,
  runRegisteredCreation
} from '@axm/parallel-capability';
import {
  bindIgnitionExecutorSet,
  verifyIgnitionExecutionEvidence
} from '@axm/parallel-capability/ignition-runtime';

const IGNITION_SOURCE_REF = process.env.IGNITION_SOURCE_REF ?? null;
const THEME_PARK_SOURCE_REF = process.env.THEME_PARK_SOURCE_REF ?? null;
const THEME_PARK_CAPABILITY_ID = 'axm.theme-park.headless-simulator';
const THEME_PARK_CAPABILITY_VERSION = '1.0.0';
const THEME_PARK_IMPLEMENTATION_VERSION = '0.4.6';
const SUMMARY_SCHEMA = 'axm.theme-park.headless-summary/v1';
const PROJECTION_SCHEMA = 'axm.parallel-theme-park-runtime-projection/v0.1';
const RUNTIME_ESTIMATE_BYTES = 2 * 1024 * 1024;
const ADVANCE_MINUTES = 60;

const themeParkCapability = describeThemeParkCapability();
assertThemeParkCapability(themeParkCapability);

const first = await runProof();
const second = await runProof();

assert.deepEqual(second.summary, first.summary, 'same seeded Theme Park runtime must project the same bounded summary');
assert.equal(second.execution.resultHash, first.execution.resultHash, 'Ignition result hash drifted across equivalent real-runtime runs');
assert.equal(first.protectedBodyUnchanged, true);
assert.equal(second.protectedBodyUnchanged, true);

console.log(JSON.stringify({
  status: 'PASS',
  bridge: 'Parallel selection -> Ignition materialization -> real Theme Park headless runtime -> Parallel clone candidate',
  ignitionSourceRef: IGNITION_SOURCE_REF,
  themeParkSourceRef: THEME_PARK_SOURCE_REF,
  themeParkCapability: {
    id: themeParkCapability.id,
    version: themeParkCapability.version,
    implementationVersion: themeParkCapability.implementationVersion,
    summaryContract: themeParkCapability.contracts.summary,
    networkRequired: themeParkCapability.runtime.networkRequired,
    canonicalAuthority: themeParkCapability.authority.canonical
  },
  selectedParallelCapability: first.selectedParallelCapability,
  ignitionCapability: first.execution.capabilityId,
  selectedMaterialized: first.tally.selected.materialize,
  idleMaterialized: first.tally.idle.materialize,
  selectedReleased: first.tally.selected.release,
  actualMaterializedBytes: first.execution.actualMaterializedBytes,
  deterministicThemeParkStateHash: first.summary.after.stateHash,
  deterministicIgnitionResultHash: first.execution.resultHash,
  protectedBodyUnchanged: first.protectedBodyUnchanged,
  commitCalled: false,
  authority: first.execution.authority
}, null, 2));

async function runProof() {
  const tally = {
    selected: { materialize: 0, release: 0, work: 0 },
    idle: { materialize: 0, release: 0, work: 0 }
  };
  const registry = new CapabilityRegistry();
  registry.ingestBundle({
    schema: 'axm.parallel-capability-registry-bundle/v0.6',
    capabilities: [
      parallelCapability('theme-park-selected', 'integration.theme-park.selected'),
      parallelCapability('theme-park-idle', 'integration.theme-park.idle')
    ],
    bodyMaps: [{
      schema: 'axm.parallel-capability-body-map-manifest/v0.6',
      id: 'theme-park-runtime-proof-body',
      version: '1',
      sourceRef: `theme-park-runtime-proof:${THEME_PARK_SOURCE_REF ?? 'unbound'}`,
      areas: [{
        id: 'integrations',
        path: 'integrations',
        allowedCapabilities: ['theme-park-selected', 'theme-park-idle'],
        authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
      }],
      metadata: { interoperabilityProof: true }
    }]
  });

  registry.bindTest('test:theme-park-selected', ({ state }) => {
    const projection = state.integrations?.themePark;
    return projection?.schema === PROJECTION_SCHEMA
      && projection.provider?.id === THEME_PARK_CAPABILITY_ID
      && projection.after?.schema === SUMMARY_SCHEMA
      && projection.minutesAdvanced === ADVANCE_MINUTES;
  });
  registry.bindTest('test:theme-park-idle', ({ state }) => state.integrations?.idleThemePark?.schema === PROJECTION_SCHEMA);

  const bindingReceipt = bindIgnitionExecutorSet(registry, {
    ignition,
    providerSourceRef: IGNITION_SOURCE_REF,
    bindings: [
      themeParkBinding({
        id: 'selected',
        executorRef: 'executor:theme-park-selected',
        capabilityId: 'parallel.runtime.theme-park-selected',
        stateKey: 'themePark',
        seed: 'AXM-PARALLEL-THEME-PARK-SELECTED',
        parkName: 'Parallel Selected Park',
        tally
      }),
      themeParkBinding({
        id: 'idle',
        executorRef: 'executor:theme-park-idle',
        capabilityId: 'parallel.runtime.theme-park-idle',
        stateKey: 'idleThemePark',
        seed: 'AXM-PARALLEL-THEME-PARK-IDLE',
        parkName: 'Parallel Idle Park',
        tally
      })
    ]
  });

  assert.equal(bindingReceipt.status, 'BOUND');
  assert.equal(bindingReceipt.provider.id, 'axm.ignition.materialization-core');
  assert.equal(bindingReceipt.authority.kind, 'MATERIALIZATION_EVIDENCE_ONLY');
  assert.equal(bindingReceipt.authority.canon, false);

  const protectedBody = {
    integrations: {
      themePark: null,
      idleThemePark: null
    }
  };
  const protectedSnapshot = structuredClone(protectedBody);

  const result = await runRegisteredCreation(registry, {
    bodyMapId: 'theme-park-runtime-proof-body',
    runId: 'real-theme-park-ignition-runtime',
    state: protectedBody,
    stateRef: 'body:theme-park-runtime-proof-v1',
    rollbackRef: 'body:theme-park-runtime-proof-v0',
    goal: {
      id: 'realize-one-theme-park-runtime',
      requirements: [{ id: 'theme-park-selected', token: 'integration.theme-park.selected' }],
      integrationTests: [{
        id: 'only-selected-theme-park-projected',
        test: ({ state }) => state.integrations.themePark?.schema === PROJECTION_SCHEMA
          && state.integrations.idleThemePark === null
      }]
    },
    constraints: { resourceBudget: { limits: { workers: 2 } } }
  });

  assert.equal(result.plan.status, 'READY');
  assert.equal(result.creation.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.deepEqual(protectedBody, protectedSnapshot, 'real runtime work must remain on the disposable clone');
  assert.deepEqual(tally, {
    selected: { materialize: 1, release: 1, work: 1 },
    idle: { materialize: 0, release: 0, work: 0 }
  });
  assert.deepEqual(result.creation.candidateOrder, ['theme-park-selected']);

  const candidate = result.creation.candidates[0].candidate;
  const execution = candidate.metadata.ignitionExecution;
  const summary = candidate.metadata.themeParkRuntimeProjection;
  assert.equal(verifyIgnitionExecutionEvidence(execution).status, 'PASS');
  assert.deepEqual(execution.materializedCapabilityIds, ['parallel.runtime.theme-park-selected']);
  assert.deepEqual(execution.executedCapabilityIds, ['parallel.runtime.theme-park-selected']);
  assert.deepEqual(execution.releasedCapabilityIds, ['parallel.runtime.theme-park-selected']);
  assert.equal(execution.actualMaterializedBytes, candidate.metadata.themeParkInitialSerializedBytes);
  assert.equal(candidate.evidenceRefs.includes(`ignition-execution:sha256:${execution.receiptSha256}`), true);
  assert.equal(candidate.evidenceRefs.includes(`theme-park-state:${summary.after.stateHash}`), true);
  assert.equal(result.creation.bodyPlan.mergePlan.commitAllowed, true);

  return {
    selectedParallelCapability: result.creation.candidateOrder[0],
    execution,
    summary,
    tally,
    protectedBodyUnchanged: JSON.stringify(protectedBody) === JSON.stringify(protectedSnapshot)
  };
}

function parallelCapability(id, token) {
  return {
    schema: 'axm.parallel-capability-manifest/v0.6',
    id,
    version: '1',
    sourceRef: `mike-axiom-mir/axm-theme-park-simulator@${THEME_PARK_SOURCE_REF ?? 'unbound'}:${id}`,
    executorRef: `executor:${id}`,
    role: 'RUNTIME_INTEGRATION',
    pressure: 'bounded-real-provider',
    provides: [token],
    dependsOn: [],
    targetAreas: ['integrations'],
    authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: { workers: 1 },
    inputRefs: [`theme-park-provider:${THEME_PARK_SOURCE_REF ?? 'unbound'}`],
    evidenceRefs: [`theme-park-capability:${THEME_PARK_CAPABILITY_ID}@${THEME_PARK_CAPABILITY_VERSION}`],
    testRefs: [`test:${id}`],
    priority: 0,
    metadata: {
      providerCapabilityId: THEME_PARK_CAPABILITY_ID,
      providerCapabilityVersion: THEME_PARK_CAPABILITY_VERSION,
      providerImplementationVersion: THEME_PARK_IMPLEMENTATION_VERSION
    }
  };
}

function themeParkBinding({ id, executorRef, capabilityId, stateKey, seed, parkName, tally }) {
  return {
    executorRef,
    capabilityId,
    resourceEstimateBytes: RUNTIME_ESTIMATE_BYTES,
    materialize: async () => {
      tally[id].materialize += 1;
      const simulator = HeadlessSimulator.create({ seed, parkName, mode: 'campaign' });
      const initialSerializedBytes = Buffer.byteLength(simulator.serialize(), 'utf8');
      return {
        instance: { simulator, initialSerializedBytes },
        allocatedBytes: initialSerializedBytes
      };
    },
    release: async ({ runtime }) => {
      assert.equal(typeof runtime?.simulator?.summary, 'function');
      tally[id].release += 1;
    },
    work: async ({ state, ignitionRuntime }) => {
      tally[id].work += 1;
      const before = projectSummary(ignitionRuntime.simulator.summary());
      const after = projectSummary(ignitionRuntime.simulator.advance(ADVANCE_MINUTES));
      const projection = {
        schema: PROJECTION_SCHEMA,
        provider: {
          id: themeParkCapability.id,
          version: themeParkCapability.version,
          implementationVersion: themeParkCapability.implementationVersion,
          sourceRef: THEME_PARK_SOURCE_REF,
          sourceRefBinding: THEME_PARK_SOURCE_REF ? 'CALLER_DECLARED_AND_CI_PINNED_EXTERNALLY' : 'UNSPECIFIED'
        },
        seed,
        parkName,
        minutesAdvanced: ADVANCE_MINUTES,
        before,
        after,
        authority: {
          kind: 'CLONE_PROJECTION_ONLY',
          canonicalMutation: false,
          merge: false,
          canon: false
        }
      };
      state.integrations[stateKey] = projection;
      return {
        evidenceRefs: [`theme-park-state:${after.stateHash}`],
        metadata: {
          themeParkRuntimeProjection: projection,
          themeParkInitialSerializedBytes: ignitionRuntime.initialSerializedBytes
        }
      };
    }
  };
}

function projectSummary(summary) {
  assert.equal(summary?.schema, SUMMARY_SCHEMA);
  return {
    schema: summary.schema,
    playableVersion: summary.playableVersion,
    parkName: summary.parkName,
    mode: summary.mode,
    tick: summary.tick,
    day: summary.day,
    minute: summary.minute,
    stateHash: summary.stateHash,
    cash: summary.cash,
    visitorsPresent: summary.visitorsPresent,
    lifetimeVisitors: summary.lifetimeVisitors,
    entities: summary.entities,
    paths: summary.paths
  };
}

function assertThemeParkCapability(capability) {
  assert.equal(capability?.schema, 'axm.capability/v1');
  assert.equal(capability.id, THEME_PARK_CAPABILITY_ID);
  assert.equal(capability.version, THEME_PARK_CAPABILITY_VERSION);
  assert.equal(capability.status, 'WORKING');
  assert.equal(capability.implementationVersion, THEME_PARK_IMPLEMENTATION_VERSION);
  assert.equal(capability.runtime?.kind, 'node');
  assert.equal(String(capability.runtime?.minimumVersion), '18');
  assert.equal(capability.runtime?.networkRequired, false);
  assert.equal(capability.contracts?.summary, SUMMARY_SCHEMA);
  assert.equal(capability.authority?.canonical, false);
}
