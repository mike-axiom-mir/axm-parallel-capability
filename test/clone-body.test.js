import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntegrationClone,
  commitMerge,
  createBodyCommitPlan,
  diffJsonState,
  runCloneCandidate
} from '../src/index.js';

const mergeAuthority = ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'];

function sourceBody() {
  return {
    config: { cacheMB: 64, mode: 'safe' },
    meta: { name: 'demo', revision: 1 }
  };
}

function passingTest(id, predicate) {
  return { id, test: ({ state }) => predicate(state) };
}

async function cacheCandidate(state, value, id = `cache-${value}`) {
  return runCloneCandidate({
    id,
    state,
    stateRef: 'body:v1',
    authority: mergeAuthority,
    evidenceRefs: [`measurement:${id}`],
    tests: [passingTest('cache-value', (clone) => clone.config.cacheMB === value)],
    work: ({ state: clone }) => {
      clone.config.cacheMB = value;
    }
  });
}

test('clone work mutates only its disposable body and emits a preconditioned deterministic diff', async () => {
  const protectedBody = sourceBody();
  const candidate = await cacheCandidate(protectedBody, 128);

  assert.equal(protectedBody.config.cacheMB, 64);
  assert.equal(candidate.status, 'COMPLETED');
  assert.equal(candidate.changes.length, 1);
  assert.deepEqual(candidate.changes[0], {
    path: 'config.cacheMB',
    op: 'set',
    value: 128,
    precondition: { exists: true, value: 64 }
  });
});

test('independent clone bodies can diverge without seeing or mutating each other', async () => {
  const protectedBody = sourceBody();
  const [performance, minimal] = await Promise.all([
    cacheCandidate(protectedBody, 256, 'performance'),
    runCloneCandidate({
      id: 'minimal',
      state: protectedBody,
      stateRef: 'body:v1',
      authority: mergeAuthority,
      evidenceRefs: ['inspection:minimal'],
      tests: [passingTest('name-removed', (clone) => !Object.hasOwn(clone.meta, 'name'))],
      work: ({ state: clone }) => {
        delete clone.meta.name;
      }
    })
  ]);

  assert.equal(protectedBody.config.cacheMB, 64);
  assert.equal(protectedBody.meta.name, 'demo');
  assert.equal(performance.changes[0].path, 'config.cacheMB');
  assert.equal(minimal.changes[0].path, 'meta.name');
});

test('failed clone work remains evidence and cannot enter the integration clone', async () => {
  const protectedBody = sourceBody();
  const failed = await runCloneCandidate({
    id: 'broken',
    state: protectedBody,
    stateRef: 'body:v1',
    authority: mergeAuthority,
    evidenceRefs: ['attempt:broken'],
    tests: [passingTest('body-still-readable', (clone) => clone.config.cacheMB === 64)],
    work: () => {
      throw new Error('candidate exploded');
    }
  });

  assert.equal(failed.status, 'FAILED');
  assert.match(failed.failures[0], /candidate exploded/);

  const integration = await buildIntegrationClone({
    integrationId: 'integration-failed',
    runId: 'integration-failed-run',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [failed],
    tests: [passingTest('unchanged', (clone) => clone.config.cacheMB === 64)]
  });

  assert.equal(integration.receipt.status, 'HELD_MERGE_PLAN');
  assert.equal(integration.candidate, null);
  assert.deepEqual(integration.state, protectedBody);
});

test('integration clone combines compatible candidate diffs without touching protected state', async () => {
  const protectedBody = sourceBody();
  const cache = await cacheCandidate(protectedBody, 128, 'cache');
  const mode = await runCloneCandidate({
    id: 'mode',
    state: protectedBody,
    stateRef: 'body:v1',
    authority: mergeAuthority,
    evidenceRefs: ['measurement:mode'],
    tests: [passingTest('mode-fast', (clone) => clone.config.mode === 'fast')],
    work: ({ state: clone }) => {
      clone.config.mode = 'fast';
    }
  });

  const integration = await buildIntegrationClone({
    integrationId: 'integration-compatible',
    runId: 'integration-compatible-run',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [cache, mode],
    evidenceRefs: ['integration:harness'],
    tests: [
      passingTest('cache-integrated', (clone) => clone.config.cacheMB === 128),
      passingTest('mode-integrated', (clone) => clone.config.mode === 'fast')
    ]
  });

  assert.deepEqual(protectedBody, sourceBody());
  assert.equal(integration.receipt.status, 'VALID_IN_HARNESS');
  assert.equal(integration.candidate.status, 'VALID_IN_HARNESS');
  assert.equal(integration.state.config.cacheMB, 128);
  assert.equal(integration.state.config.mode, 'fast');
  assert.deepEqual(integration.candidate.changes.map((change) => change.path), [
    'config.cacheMB',
    'config.mode'
  ]);
});

test('conflicting clone candidates remain held instead of mutating an integration clone', async () => {
  const protectedBody = sourceBody();
  const low = await cacheCandidate(protectedBody, 96, 'low');
  const high = await cacheCandidate(protectedBody, 512, 'high');

  const integration = await buildIntegrationClone({
    integrationId: 'integration-conflict',
    runId: 'integration-conflict-run',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [low, high],
    tests: [passingTest('not-run', () => true)]
  });

  assert.equal(integration.receipt.status, 'HELD_MERGE_PLAN');
  assert.equal(integration.receipt.heldConflicts.length, 2);
  assert.equal(integration.state.config.cacheMB, 64);
  assert.deepEqual(protectedBody, sourceBody());
});

test('failed integration verification produces a non-mergeable integration candidate', async () => {
  const protectedBody = sourceBody();
  const cache = await cacheCandidate(protectedBody, 128, 'cache');
  const integration = await buildIntegrationClone({
    integrationId: 'integration-test-fail',
    runId: 'integration-test-fail-run',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [cache],
    tests: [passingTest('impossible-budget', (clone) => clone.config.cacheMB < 100)]
  });

  assert.equal(integration.candidate.status, 'TEST_FAIL');
  const bodyPlan = createBodyCommitPlan({
    runId: 'protected-plan-fail',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [integration.candidate]
  });
  assert.equal(bodyPlan.mergePlan.commitAllowed, false);
  assert.equal(bodyPlan.mergePlan.decisions[0].status, 'REJECTED_PREDICATE');
});

test('protected-body planning binds candidate lineage to exact source content even if stateRef is reused', async () => {
  const protectedBody = sourceBody();
  const candidate = await cacheCandidate(protectedBody, 128, 'cache');
  const driftedBody = sourceBody();
  driftedBody.meta.revision = 2;

  const bodyPlan = createBodyCommitPlan({
    runId: 'stale-content-plan',
    state: driftedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [candidate]
  });

  assert.equal(bodyPlan.mergePlan.commitAllowed, false);
  const sourceHashTest = bodyPlan.mergePlan.decisions[0].tests.find((item) => item.id === 'body-source-state-hash');
  assert.equal(sourceHashTest.passed, false);
});

test('protected main remains unchanged until an explicit public merge commit returns a new state', async () => {
  const protectedBody = sourceBody();
  const candidate = await cacheCandidate(protectedBody, 128, 'cache');
  const integration = await buildIntegrationClone({
    integrationId: 'integration-final',
    runId: 'integration-final-run',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [candidate],
    tests: [passingTest('integration-cache', (clone) => clone.config.cacheMB === 128)]
  });

  const bodyPlan = createBodyCommitPlan({
    runId: 'protected-final-plan',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [integration.candidate]
  });

  assert.equal(protectedBody.config.cacheMB, 64);
  assert.equal(bodyPlan.mergePlan.commitAllowed, true);

  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'body:v1',
    plan: bodyPlan.mergePlan
  });

  assert.equal(protectedBody.config.cacheMB, 64);
  assert.equal(committed.state.config.cacheMB, 128);
  assert.equal(committed.receipt.status, 'COMMITTED');
});

test('merge-nonconflicting integration can keep a dispute while integrating independent wins', async () => {
  const protectedBody = sourceBody();
  const low = await cacheCandidate(protectedBody, 96, 'low');
  const high = await cacheCandidate(protectedBody, 512, 'high');
  const mode = await runCloneCandidate({
    id: 'mode',
    state: protectedBody,
    stateRef: 'body:v1',
    authority: mergeAuthority,
    evidenceRefs: ['measurement:mode'],
    tests: [passingTest('mode-fast', (clone) => clone.config.mode === 'fast')],
    work: ({ state: clone }) => {
      clone.config.mode = 'fast';
    }
  });

  const integration = await buildIntegrationClone({
    integrationId: 'integration-partial',
    runId: 'integration-partial-run',
    state: protectedBody,
    stateRef: 'body:v1',
    rollbackRef: 'body:v1',
    candidates: [low, high, mode],
    conflictPolicy: 'merge-nonconflicting',
    tests: [
      passingTest('mode-integrated', (clone) => clone.config.mode === 'fast'),
      passingTest('cache-held', (clone) => clone.config.cacheMB === 64)
    ]
  });

  assert.equal(integration.receipt.status, 'VALID_IN_HARNESS');
  assert.equal(integration.state.config.mode, 'fast');
  assert.equal(integration.state.config.cacheMB, 64);
  assert.deepEqual(integration.receipt.heldConflicts.sort(), ['high', 'low']);
  assert.deepEqual(integration.candidate.changes.map((change) => change.path), ['config.mode']);
});

test('v0.3 diff rejects dotted object keys that cannot be represented by the merge path grammar', () => {
  assert.throws(() => diffJsonState(
    { config: { safe: true } },
    { config: { safe: true }, 'bad.key': 1 }
  ), /dot/);
});
