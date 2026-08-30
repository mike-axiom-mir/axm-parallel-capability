import { createMergePlan, commitMerge, rollbackMerge } from '../src/index.js';

const state = {
  config: { cacheMB: 64 },
  ui: { compact: false }
};

const candidates = [
  {
    id: 'cache-safe',
    laneId: 'performance',
    taskId: 'cache-safe',
    stateRef: 'state:v1',
    status: 'COMPLETED',
    authorityUsed: ['COMMIT-CANDIDATE'],
    evidenceRefs: ['benchmark:cache-safe'],
    testResults: [{ id: 'behavior-equivalence', passed: true }],
    proposedChanges: [
      {
        path: 'config.cacheMB',
        op: 'set',
        value: 128,
        precondition: { value: 64 }
      }
    ]
  },
  {
    id: 'compact-ui',
    laneId: 'ui',
    taskId: 'compact-ui',
    stateRef: 'state:v1',
    status: 'COMPLETED',
    authorityUsed: ['COMMIT-CANDIDATE'],
    evidenceRefs: ['test:compact-ui'],
    testResults: [{ id: 'ui-contract', passed: true }],
    proposedChanges: [
      { path: 'ui.compact', op: 'set', value: true }
    ]
  }
];

const plan = createMergePlan({
  runId: 'demo-merge-v2',
  stateRef: 'state:v1',
  rollbackRef: 'state:v0',
  candidates
});

const committed = commitMerge({
  state,
  currentStateRef: 'state:v1',
  plan,
  resultingStateRef: 'state:v2'
});

const rolledBack = rollbackMerge({
  state: committed.state,
  currentStateRef: committed.stateRef,
  rollbackToken: committed.rollbackToken
});

console.log(JSON.stringify({ plan, committed, rolledBack }, null, 2));
