import { CreationFabric, commitMerge } from '../src/index.js';

const protectedBody = {
  engine: { cacheMB: 64, batchSize: 8 },
  ui: { compact: false },
  metrics: { runtimeMs: 20 }
};

const fabric = new CreationFabric({ limits: { workers: 3 } });
const session = fabric.start({
  runId: 'demo-creation-v1',
  goal: 'Explore compatible bounded improvements in disposable clone hands',
  state: protectedBody,
  stateRef: 'demo-body:v1',
  rollbackRef: 'demo-body:v0',
  candidates: [
    {
      id: 'performance',
      role: 'PERFORMANCE',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['benchmark:performance'],
      tests: [{ id: 'runtime-target', test: ({ state }) => state.metrics.runtimeMs <= 12 }],
      work: ({ state }) => {
        state.engine.cacheMB = 128;
        state.metrics.runtimeMs = 12;
      }
    },
    {
      id: 'memory',
      role: 'MEMORY',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['inspection:memory'],
      tests: [{ id: 'batch-bounded', test: ({ state }) => state.engine.batchSize <= 8 }],
      work: ({ state }) => {
        state.engine.batchSize = 4;
      }
    },
    {
      id: 'usability',
      role: 'USABILITY',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['inspection:ui'],
      tests: [{ id: 'compact-enabled', test: ({ state }) => state.ui.compact === true }],
      work: ({ state }) => {
        state.ui.compact = true;
      }
    }
  ],
  integration: {
    id: 'demo-integration',
    evidenceRefs: ['integration:harness'],
    tests: [
      { id: 'combined-runtime', test: ({ state }) => state.metrics.runtimeMs <= 12 },
      { id: 'combined-memory', test: ({ state }) => state.engine.batchSize === 4 },
      { id: 'combined-ui', test: ({ state }) => state.ui.compact === true }
    ]
  }
});

const receipt = await session.result;
console.log('Creation status:', receipt.status);
console.log('Protected body before explicit commit:', JSON.stringify(protectedBody));
console.log('Integration body:', JSON.stringify(receipt.integration?.state ?? null));
console.log('Protected-body plan commitAllowed:', receipt.bodyPlan?.mergePlan?.commitAllowed ?? false);

if (receipt.status === 'READY_FOR_EXPLICIT_COMMIT') {
  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'demo-body:v1',
    plan: receipt.bodyPlan.mergePlan
  });
  console.log('Returned committed body:', JSON.stringify(committed.state));
  console.log('Original protected body still unchanged:', JSON.stringify(protectedBody));
}
