import test from 'node:test';
import assert from 'node:assert/strict';
import { createMergePlan } from '../src/merge.js';
import { commitMerge, rollbackMerge } from '../src/merge-gate.js';

function plan() {
  return createMergePlan({
    runId: 'gate-test',
    stateRef: 'state:v1',
    rollbackRef: 'state:v0',
    candidates: [{
      id: 'cache',
      stateRef: 'state:v1',
      status: 'COMPLETED',
      authorityUsed: ['COMMIT-CANDIDATE'],
      evidenceRefs: ['evidence:cache'],
      testResults: [{ id: 'unit', passed: true }],
      proposedChanges: [{ path: 'config.cacheMB', op: 'set', value: 128 }]
    }]
  });
}

test('gate refuses a plan changed after planning', () => {
  const tampered = structuredClone(plan());
  tampered.operations[0].value = 999;
  assert.throws(() => commitMerge({
    state: { config: { cacheMB: 64 } },
    currentStateRef: 'state:v1',
    plan: tampered
  }), /Merge plan integrity check failed/);
});

test('gate binds rollback token to exact snapshot content', () => {
  const committed = commitMerge({
    state: { config: { cacheMB: 64 } },
    currentStateRef: 'state:v1',
    plan: plan(),
    resultingStateRef: 'state:v2'
  });
  assert.match(committed.rollbackToken.tokenId, /^rollback-token:sha256:/);

  const tampered = structuredClone(committed.rollbackToken);
  tampered.snapshot.config.cacheMB = 777;
  assert.throws(() => rollbackMerge({
    state: committed.state,
    currentStateRef: committed.stateRef,
    rollbackToken: tampered
  }), /Rollback token integrity check failed/);
});
