import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitBodyPlan,
  commitMerge,
  createBodyCommitPlan,
  hashState
} from '../src/index.js';

function sourceBody() {
  return {
    config: { cacheMB: 64, mode: 'safe' },
    meta: { revision: 1 }
  };
}

function candidateFor(state) {
  return {
    id: 'cache-upgrade',
    stateRef: 'body:v1',
    sourceStateHash: hashState(state),
    status: 'COMPLETED',
    authorityUsed: ['COMMIT-CANDIDATE'],
    evidenceRefs: ['evidence:cache-upgrade'],
    testResults: [{ id: 'cache-target', passed: true }],
    proposedChanges: [{
      path: 'config.cacheMB',
      op: 'set',
      value: 128,
      precondition: { exists: true, value: 64 }
    }]
  };
}

function planFor(state) {
  return createBodyCommitPlan({
    runId: 'body-content-gate',
    state,
    stateRef: 'body:v1',
    rollbackRef: 'body:v0',
    candidates: [candidateFor(state)]
  });
}

test('commitBodyPlan commits when ref and canonical source content both match', () => {
  const state = sourceBody();
  const bodyPlan = planFor(state);

  const committed = commitBodyPlan({
    state,
    currentStateRef: 'body:v1',
    bodyPlan,
    resultingStateRef: 'body:v2'
  });

  assert.equal(state.config.cacheMB, 64);
  assert.equal(committed.state.config.cacheMB, 128);
  assert.equal(committed.stateRef, 'body:v2');
  assert.equal(committed.receipt.status, 'COMMITTED');
});

test('commitBodyPlan refuses same-ref protected-body drift that generic merge would otherwise preserve', () => {
  const plannedState = sourceBody();
  const bodyPlan = planFor(plannedState);
  const driftedState = sourceBody();
  driftedState.meta.revision = 2;

  const generic = commitMerge({
    state: driftedState,
    currentStateRef: 'body:v1',
    plan: bodyPlan.mergePlan,
    resultingStateRef: 'body:v2'
  });
  assert.equal(generic.state.meta.revision, 2);
  assert.equal(generic.state.config.cacheMB, 128);

  assert.throws(() => commitBodyPlan({
    state: driftedState,
    currentStateRef: 'body:v1',
    bodyPlan,
    resultingStateRef: 'body:v2'
  }), /Stale body plan: current state content hash/);
});

test('commitBodyPlan refuses wrapper and merge-plan lineage disagreement', () => {
  const state = sourceBody();
  const bodyPlan = planFor(state);
  const mismatched = structuredClone(bodyPlan);
  mismatched.sourceStateRef = 'body:other';

  assert.throws(() => commitBodyPlan({
    state,
    currentStateRef: 'body:other',
    bodyPlan: mismatched
  }), /Body plan lineage mismatch/);
});
