import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMergePlan,
  commitMerge,
  rollbackMerge,
  detectMergeConflicts,
  hashState
} from '../src/merge.js';

function candidate(id, changes, overrides = {}) {
  return {
    id,
    laneId: overrides.laneId ?? id,
    taskId: overrides.taskId ?? `task-${id}`,
    stateRef: overrides.stateRef ?? 'state:v1',
    status: overrides.status ?? 'COMPLETED',
    authorityUsed: overrides.authorityUsed ?? ['COMMIT-CANDIDATE'],
    evidenceRefs: overrides.evidenceRefs ?? [`evidence:${id}`],
    testResults: overrides.testResults ?? [{ id: 'unit', passed: true }],
    failures: overrides.failures ?? [],
    proposedChanges: changes
  };
}

function plan(candidates, overrides = {}) {
  return createMergePlan({
    runId: overrides.runId ?? 'run-merge',
    stateRef: overrides.stateRef ?? 'state:v1',
    rollbackRef: overrides.rollbackRef ?? 'state:v0',
    candidates,
    conflictPolicy: overrides.conflictPolicy ?? 'hold-run',
    requirements: overrides.requirements,
    predicates: overrides.predicates
  });
}

test('stale candidate is rejected before merge planning', () => {
  const result = plan([
    candidate('stale', [{ path: 'config.cacheMB', op: 'set', value: 128 }], { stateRef: 'state:v0' })
  ]);
  assert.equal(result.commitAllowed, false);
  assert.equal(result.status, 'NO_ELIGIBLE_CANDIDATES');
  assert.equal(result.decisions[0].status, 'REJECTED_PREDICATE');
  assert.equal(result.decisions[0].tests.find((item) => item.id === 'state-version').passed, false);
});

test('failed tests, missing evidence, failures, and missing authority block candidates', () => {
  const result = plan([
    candidate('bad-tests', [{ path: 'a', op: 'set', value: 1 }], { testResults: [{ id: 'unit', passed: false }] }),
    candidate('no-evidence', [{ path: 'b', op: 'set', value: 2 }], { evidenceRefs: [] }),
    candidate('failed-lane', [{ path: 'c', op: 'set', value: 3 }], { failures: ['boom'] }),
    candidate('no-authority', [{ path: 'd', op: 'set', value: 4 }], { authorityUsed: ['PROPOSE'] })
  ]);
  assert.equal(result.commitAllowed, false);
  assert.deepEqual(result.decisions.map((item) => item.status), [
    'REJECTED_PREDICATE', 'REJECTED_PREDICATE', 'REJECTED_PREDICATE', 'REJECTED_PREDICATE'
  ]);
});

test('conflicting exact path is held and hold-run policy blocks the commit', () => {
  const result = plan([
    candidate('memory', [{ path: 'config.cacheMB', op: 'set', value: 128 }]),
    candidate('performance', [{ path: 'config.cacheMB', op: 'set', value: 2048 }])
  ]);
  assert.equal(result.status, 'HOLD_CONFLICTS');
  assert.equal(result.commitAllowed, false);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.decisions.map((item) => item.status), ['HELD_CONFLICT', 'HELD_CONFLICT']);
});

test('parent-child writes conflict because merge order would otherwise matter', () => {
  const conflicts = detectMergeConflicts([
    candidate('whole-config', [{ path: 'config', op: 'set', value: { cacheMB: 64 } }]),
    candidate('cache-only', [{ path: 'config.cacheMB', op: 'set', value: 128 }])
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'CANDIDATE_PATH_CONFLICT');
});

test('identical proposals coalesce and preserve all source candidates', () => {
  const result = plan([
    candidate('a', [{ path: 'config.cacheMB', op: 'set', value: 128 }]),
    candidate('b', [{ path: 'config.cacheMB', op: 'set', value: 128 }])
  ]);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.operations[0].sources.map((source) => source.id), ['a', 'b']);
});

test('nonconflicting accepted candidates commit in deterministic path order with receipt', () => {
  const result = plan([
    candidate('ui', [{ path: 'ui.compact', op: 'set', value: true }]),
    candidate('cache', [{ path: 'config.cacheMB', op: 'set', value: 128 }])
  ]);
  assert.equal(result.status, 'READY');
  assert.equal(result.commitAllowed, true);
  assert.deepEqual(result.operations.map((operation) => operation.path), ['config.cacheMB', 'ui.compact']);

  const source = { config: { cacheMB: 64 }, ui: { compact: false } };
  const committed = commitMerge({
    state: source,
    currentStateRef: 'state:v1',
    plan: result,
    resultingStateRef: 'state:v2'
  });

  assert.deepEqual(source, { config: { cacheMB: 64 }, ui: { compact: false } });
  assert.deepEqual(committed.state, { config: { cacheMB: 128 }, ui: { compact: true } });
  assert.equal(committed.stateRef, 'state:v2');
  assert.equal(committed.receipt.status, 'COMMITTED');
  assert.equal(committed.receipt.appliedOperations.length, 2);
  assert.equal(committed.receipt.sourceStateHash, hashState(source));
  assert.equal(committed.receipt.resultingStateHash, hashState(committed.state));
});

test('operation precondition failure prevents a stale assumption from committing', () => {
  const result = plan([
    candidate('conditional', [{
      path: 'config.cacheMB',
      op: 'set',
      value: 128,
      precondition: { value: 64 }
    }])
  ]);
  const source = { config: { cacheMB: 32 } };
  assert.throws(() => commitMerge({
    state: source,
    currentStateRef: 'state:v1',
    plan: result
  }), /Precondition failed/);
  assert.deepEqual(source, { config: { cacheMB: 32 } });
});

test('rollback restores exact snapshot and rejects rollback after state drift', () => {
  const result = plan([
    candidate('cache', [{ path: 'config.cacheMB', op: 'set', value: 128 }])
  ]);
  const source = { config: { cacheMB: 64 }, label: 'before' };
  const committed = commitMerge({
    state: source,
    currentStateRef: 'state:v1',
    plan: result,
    resultingStateRef: 'state:v2'
  });
  const restored = rollbackMerge({
    state: committed.state,
    currentStateRef: committed.stateRef,
    rollbackToken: committed.rollbackToken
  });
  assert.deepEqual(restored.state, source);
  assert.equal(restored.stateRef, 'state:v1');
  assert.equal(restored.receipt.status, 'ROLLED_BACK');

  const drifted = structuredClone(committed.state);
  drifted.label = 'changed-after-merge';
  assert.throws(() => rollbackMerge({
    state: drifted,
    currentStateRef: committed.stateRef,
    rollbackToken: committed.rollbackToken
  }), /content no longer matches/);
});

test('merge-nonconflicting policy can commit independent wins while preserving conflicts', () => {
  const result = plan([
    candidate('memory', [{ path: 'config.cacheMB', op: 'set', value: 128 }]),
    candidate('performance', [{ path: 'config.cacheMB', op: 'set', value: 2048 }]),
    candidate('ui', [{ path: 'ui.compact', op: 'set', value: true }])
  ], { conflictPolicy: 'merge-nonconflicting' });
  assert.equal(result.status, 'PARTIAL_READY');
  assert.equal(result.commitAllowed, true);
  assert.deepEqual(result.operations.map((operation) => operation.path), ['ui.compact']);
  assert.deepEqual(result.decisions.map((item) => [item.id, item.status]), [
    ['memory', 'HELD_CONFLICT'],
    ['performance', 'HELD_CONFLICT'],
    ['ui', 'ACCEPTED']
  ]);
});
