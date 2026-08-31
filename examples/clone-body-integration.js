import {
  buildIntegrationClone,
  commitMerge,
  createBodyCommitPlan,
  runCloneCandidate
} from '../src/index.js';

const protectedBody = {
  config: { cacheMB: 64, mode: 'safe' },
  metrics: { baselineMs: 20 }
};
const stateRef = 'demo-body:v1';
const authority = ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'];

const performance = await runCloneCandidate({
  id: 'performance',
  state: protectedBody,
  stateRef,
  authority,
  evidenceRefs: ['benchmark:performance'],
  tests: [{ id: 'runtime-target', test: ({ state }) => state.metrics.baselineMs <= 12 }],
  work: ({ state }) => {
    state.config.cacheMB = 128;
    state.metrics.baselineMs = 12;
  }
});

const maintainability = await runCloneCandidate({
  id: 'maintainability',
  state: protectedBody,
  stateRef,
  authority,
  evidenceRefs: ['inspection:maintainability'],
  tests: [{ id: 'strategy-explicit', test: ({ state }) => state.config.strategy === 'bounded' }],
  work: ({ state }) => {
    state.config.strategy = 'bounded';
  }
});

const integration = await buildIntegrationClone({
  integrationId: 'integration-demo',
  runId: 'integration-demo-run',
  state: protectedBody,
  stateRef,
  rollbackRef: stateRef,
  candidates: [performance, maintainability],
  evidenceRefs: ['integration:harness'],
  tests: [
    { id: 'combined-runtime', test: ({ state }) => state.metrics.baselineMs <= 12 },
    { id: 'combined-strategy', test: ({ state }) => state.config.strategy === 'bounded' }
  ]
});

const bodyPlan = createBodyCommitPlan({
  runId: 'protected-body-plan',
  state: protectedBody,
  stateRef,
  rollbackRef: stateRef,
  candidates: [integration.candidate]
});

console.log('Protected body before explicit commit:');
console.log(JSON.stringify(protectedBody, null, 2));
console.log('\nIntegration receipt:');
console.log(JSON.stringify(integration.receipt, null, 2));
console.log('\nProtected-body plan:');
console.log(JSON.stringify(bodyPlan, null, 2));

if (bodyPlan.mergePlan.commitAllowed) {
  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: stateRef,
    plan: bodyPlan.mergePlan
  });
  console.log('\nReturned committed body:');
  console.log(JSON.stringify(committed.state, null, 2));
  console.log('\nOriginal protected object remains unchanged until the caller adopts the returned state:');
  console.log(JSON.stringify(protectedBody, null, 2));
}
