import {
  commitMerge,
  runDecomposedCreation
} from '../src/index.js';

const protectedBody = {
  config: { cacheMB: 64, mode: 'safe' },
  metrics: { runtimeMs: 20 }
};

const capabilities = [
  {
    id: 'cache-analyzer',
    executorRef: 'demo:cache-analyzer/v1',
    role: 'analyzer',
    pressure: 'evidence',
    provides: ['analysis'],
    targetAreas: ['metrics'],
    authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: { workers: 1 },
    evidenceRefs: ['demo:baseline-metrics'],
    tests: [{ id: 'runtime-observed', test: ({ sourceState }) => sourceState.metrics.runtimeMs === 20 }],
    work: () => ({ metadata: { recommendedCacheMB: 128 } })
  },
  {
    id: 'cache-builder',
    executorRef: 'demo:cache-builder/v1',
    role: 'builder',
    pressure: 'balanced',
    provides: ['cache-upgrade'],
    dependsOn: ['cache-analyzer'],
    targetAreas: ['config'],
    authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: { workers: 1 },
    evidenceRefs: ['demo:cache-policy'],
    tests: [{ id: 'cache-bounded', test: ({ state }) => state.config.cacheMB <= 256 }],
    work: ({ state, dependencyCandidates }) => {
      state.config.cacheMB = dependencyCandidates['cache-analyzer'].metadata.recommendedCacheMB;
    }
  }
];

const bodyMap = {
  id: 'demo-body-map',
  areas: [
    {
      id: 'config',
      path: 'config',
      allowedCapabilities: ['cache-builder'],
      authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
    },
    {
      id: 'metrics',
      path: 'metrics',
      allowedCapabilities: ['cache-analyzer'],
      authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
    }
  ]
};

const { plan, creation } = await runDecomposedCreation({
  runId: 'demo-decomposition-v1',
  state: protectedBody,
  stateRef: 'demo-body:v1',
  rollbackRef: 'demo-body:v0',
  goal: {
    id: 'upgrade-cache',
    summary: 'Upgrade cache using an evidence dependency',
    requirements: [{ id: 'cache', token: 'cache-upgrade' }],
    integrationTests: [{ id: 'cache-128', test: ({ state }) => state.config.cacheMB === 128 }]
  },
  bodyMap,
  capabilities,
  constraints: {
    resourceBudget: { limits: { workers: 2 } }
  }
});

console.log(JSON.stringify({
  planId: plan.planId,
  planStatus: plan.status,
  selected: plan.selectedCapabilities.map(({ id, dependsOn, reason }) => ({ id, dependsOn, reason })),
  creationStatus: creation?.status ?? null,
  protectedBodyBeforeCommit: protectedBody
}, null, 2));

if (creation?.status === 'READY_FOR_EXPLICIT_COMMIT') {
  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'demo-body:v1',
    plan: creation.bodyPlan.mergePlan
  });
  console.log(JSON.stringify({
    committedBody: committed.state,
    originalProtectedBodyStillUnchanged: protectedBody
  }, null, 2));
}
