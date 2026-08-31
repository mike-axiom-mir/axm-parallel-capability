import {
  CapabilityRegistry,
  commitMerge,
  createRegistryBundle,
  runRegisteredCreation
} from '../src/index.js';

const CAPABILITY_SCHEMA = 'axm.parallel-capability-manifest/v0.6';
const BODY_MAP_SCHEMA = 'axm.parallel-capability-body-map-manifest/v0.6';

const registry = new CapabilityRegistry();
const bundle = createRegistryBundle({
  capabilities: [
    {
      schema: CAPABILITY_SCHEMA,
      id: 'demo.config-fast',
      version: '1',
      sourceRef: 'repo:demo@v1:capabilities/config-fast',
      executorRef: 'executor:demo.config-fast/v1',
      role: 'CONFIG',
      pressure: 'balanced',
      provides: ['config.fast'],
      dependsOn: [],
      targetAreas: ['config'],
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      resources: { workers: 1 },
      inputRefs: ['demo:input'],
      evidenceRefs: ['demo:capability-contract'],
      testRefs: ['test:demo.config-fast/v1'],
      priority: 10,
      metadata: { demo: true }
    }
  ],
  bodyMaps: [
    {
      schema: BODY_MAP_SCHEMA,
      id: 'demo.body',
      version: '1',
      sourceRef: 'repo:demo@v1:body-map',
      areas: [
        {
          id: 'config',
          path: 'config',
          allowedCapabilities: ['demo.config-fast'],
          authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
        }
      ],
      metadata: { demo: true }
    }
  ]
});

const intake = registry.ingestBundle(bundle);
const portableSnapshot = registry.snapshot();

// Imported manifests are inert. Execution is bound locally and separately.
registry.bindExecutor('executor:demo.config-fast/v1', ({ state }) => {
  state.config.fast = true;
});
registry.bindTest('test:demo.config-fast/v1', ({ state }) => state.config.fast === true);

const protectedBody = { config: { fast: false } };
const result = await runRegisteredCreation(registry, {
  bodyMapId: 'demo.body',
  runId: 'registry-demo-run',
  state: protectedBody,
  stateRef: 'demo-body:v1',
  rollbackRef: 'demo-body:v0',
  goal: {
    id: 'make-config-fast',
    summary: 'Demonstrate registry-fed deterministic creation',
    requirements: [{ id: 'fast', token: 'config.fast' }],
    integrationTests: [
      { id: 'integration-fast', test: ({ state }) => state.config.fast === true }
    ]
  },
  constraints: {
    resourceBudget: { limits: { workers: 2 } }
  }
});

let committed = null;
if (result.creation?.status === 'READY_FOR_EXPLICIT_COMMIT') {
  committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'demo-body:v1',
    plan: result.creation.bodyPlan.mergePlan
  });
}

console.log(JSON.stringify({
  intake,
  portableSnapshot,
  runtimeAvailability: registry.runtimeAvailability(),
  resolution: result.resolution,
  decompositionStatus: result.plan.status,
  creationStatus: result.creation?.status ?? null,
  protectedBodyBeforeAdoption: protectedBody,
  committedState: committed?.state ?? null
}, null, 2));
