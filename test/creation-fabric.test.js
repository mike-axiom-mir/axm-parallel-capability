import test from 'node:test';
import assert from 'node:assert/strict';
import { CreationFabric, commitMerge } from '../src/index.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (!signal) return;
  if (signal.aborted) {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('aborted'));
    return;
  }
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('aborted'));
  }, { once: true });
});

function candidate(id, work, overrides = {}) {
  return {
    id,
    role: overrides.role ?? id,
    authority: overrides.authority ?? ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: overrides.resources,
    evidenceRefs: overrides.evidenceRefs ?? [`evidence:${id}`],
    tests: overrides.tests ?? [{ id: `test:${id}`, test: () => true }],
    work
  };
}

function makeSpec(state, candidates, overrides = {}) {
  return {
    runId: overrides.runId ?? 'creation-test',
    goal: overrides.goal ?? 'test scheduler-native clone creation',
    state,
    stateRef: overrides.stateRef ?? 'body:v1',
    rollbackRef: overrides.rollbackRef ?? 'body:v0',
    candidates,
    resourceBudget: overrides.resourceBudget,
    integration: {
      id: overrides.integrationId ?? 'integration-test',
      conflictPolicy: overrides.conflictPolicy ?? 'hold-run',
      tests: overrides.integrationTests ?? [{ id: 'integration-pass', test: () => true }],
      evidenceRefs: overrides.integrationEvidenceRefs ?? ['evidence:integration'],
      resources: overrides.integrationResources
    }
  };
}

test('creation fabric spawns bounded clone hands concurrently and integrates them automatically', async () => {
  const protectedBody = { flags: { a: false, b: false, c: false, d: false } };
  let active = 0;
  let maxActive = 0;
  const fabric = new CreationFabric({ limits: { workers: 2 } });
  const candidates = ['a', 'b', 'c', 'd'].map((key) => candidate(key, async ({ state, signal }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(15, signal);
    state.flags[key] = true;
    active -= 1;
  }));

  const receipt = await fabric.start(makeSpec(protectedBody, candidates, {
    integrationTests: [{
      id: 'all-flags',
      test: ({ state }) => Object.values(state.flags).every(Boolean)
    }]
  })).result;

  assert.equal(maxActive, 2);
  assert.equal(receipt.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.deepEqual(receipt.candidateOrder, ['a', 'b', 'c', 'd']);
  assert.deepEqual(protectedBody, { flags: { a: false, b: false, c: false, d: false } });
  assert.deepEqual(receipt.integration.state, { flags: { a: true, b: true, c: true, d: true } });
  assert.equal(receipt.bodyPlan.mergePlan.commitAllowed, true);
});

test('failed experimental clone remains evidence without blocking an independent survivor', async () => {
  const protectedBody = { value: 0 };
  const fabric = new CreationFabric({ limits: { workers: 2 } });
  const receipt = await fabric.start(makeSpec(protectedBody, [
    candidate('bad', () => { throw new Error('candidate exploded'); }),
    candidate('good', ({ state }) => { state.value = 1; })
  ])).result;

  const bad = receipt.candidates.find((item) => item.candidate?.id === 'bad');
  assert.equal(bad.schedulerStatus, 'COMPLETED');
  assert.equal(bad.candidate.status, 'FAILED');
  assert.equal(receipt.integration.state.value, 1);
  assert.deepEqual(receipt.integration.receipt.rejected, ['bad']);
  assert.equal(receipt.status, 'READY_FOR_EXPLICIT_COMMIT');
});

test('conflicting clone hands hold integration and never touch protected state', async () => {
  const protectedBody = { config: { cacheMB: 64 } };
  const fabric = new CreationFabric({ limits: { workers: 2 } });
  const receipt = await fabric.start(makeSpec(protectedBody, [
    candidate('memory', ({ state }) => { state.config.cacheMB = 96; }),
    candidate('performance', ({ state }) => { state.config.cacheMB = 256; })
  ])).result;

  assert.equal(receipt.status, 'HELD_INTEGRATION');
  assert.equal(receipt.integration.candidate, null);
  assert.equal(receipt.integration.receipt.heldConflicts.length, 2);
  assert.equal(receipt.bodyPlan, null);
  assert.deepEqual(protectedBody, { config: { cacheMB: 64 } });
});

test('merge-nonconflicting creation cycle integrates independent wins while preserving disputes', async () => {
  const protectedBody = { config: { cacheMB: 64 }, feature: { enabled: false } };
  const fabric = new CreationFabric({ limits: { workers: 3 } });
  const receipt = await fabric.start(makeSpec(protectedBody, [
    candidate('small-cache', ({ state }) => { state.config.cacheMB = 96; }),
    candidate('large-cache', ({ state }) => { state.config.cacheMB = 256; }),
    candidate('feature', ({ state }) => { state.feature.enabled = true; })
  ], { conflictPolicy: 'merge-nonconflicting' })).result;

  assert.equal(receipt.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.equal(receipt.integration.state.config.cacheMB, 64);
  assert.equal(receipt.integration.state.feature.enabled, true);
  assert.deepEqual(receipt.integration.receipt.heldConflicts.sort(), ['large-cache', 'small-cache']);
  assert.ok(receipt.integration.receipt.unresolved.length > 0);
});

test('failed integration verification produces a non-committable creation result', async () => {
  const protectedBody = { value: 0 };
  const fabric = new CreationFabric({ limits: { workers: 1 } });
  const receipt = await fabric.start(makeSpec(protectedBody, [
    candidate('change', ({ state }) => { state.value = 1; })
  ], {
    integrationTests: [{ id: 'must-be-two', test: ({ state }) => state.value === 2 }]
  })).result;

  assert.equal(receipt.integration.candidate.status, 'TEST_FAIL');
  assert.equal(receipt.status, 'INTEGRATION_TEST_FAIL');
  assert.equal(receipt.bodyPlan.mergePlan.commitAllowed, false);
  assert.deepEqual(protectedBody, { value: 0 });
});

test('protected body drift during a creation cycle is detected even when stateRef is reused', async () => {
  const protectedBody = { value: 0, external: false };
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const fabric = new CreationFabric({ limits: { workers: 1 } });
  const session = fabric.start(makeSpec(protectedBody, [
    candidate('slow', async ({ state, signal }) => {
      started();
      await sleep(20, signal);
      state.value = 1;
    })
  ]));

  await startedPromise;
  protectedBody.external = true;
  const receipt = await session.result;

  assert.equal(receipt.protectedStateDrifted, true);
  assert.equal(receipt.status, 'HOLD_PROTECTED_STATE_DRIFT');
  assert.equal(receipt.bodyPlan.mergePlan.commitAllowed, false);
  assert.deepEqual(protectedBody, { value: 0, external: true });
});

test('creation checkpoint reuse does not rerun completed clone or integration work', async () => {
  const protectedBody = { value: 0 };
  let runs = 0;
  const spec = makeSpec(protectedBody, [
    candidate('once', ({ state }) => { runs += 1; state.value = 1; })
  ], { runId: 'creation-checkpoint', stateRef: 'body:checkpoint' });
  const fabric = new CreationFabric({ limits: { workers: 1 } });

  const firstSession = fabric.start(spec);
  const first = await firstSession.result;
  const checkpoint = firstSession.getCheckpoint();
  assert.equal(first.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.equal(runs, 1);

  const second = await fabric.start(spec, { checkpoint }).result;
  assert.equal(second.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.equal(runs, 1);
});

test('creation cancellation propagates into active clone work and prevents integration', async () => {
  const protectedBody = { value: 0 };
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const fabric = new CreationFabric({ limits: { workers: 1 } });
  const session = fabric.start(makeSpec(protectedBody, [
    candidate('active', async ({ state, signal }) => {
      started();
      await sleep(1000, signal);
      state.value = 1;
    }),
    candidate('pending', ({ state }) => { state.value = 2; })
  ], { runId: 'creation-cancel' }));

  await startedPromise;
  session.cancel();
  const receipt = await session.result;

  assert.equal(receipt.status, 'CANCELLED');
  assert.equal(receipt.integration, null);
  assert.deepEqual(protectedBody, { value: 0 });
});

test('creation candidates do not receive COMMIT-CANDIDATE authority by default', async () => {
  const protectedBody = { value: 0 };
  const fabric = new CreationFabric({ limits: { workers: 1 } });
  const receipt = await fabric.start(makeSpec(protectedBody, [
    {
      id: 'sandbox-only',
      evidenceRefs: ['evidence:sandbox'],
      tests: [{ id: 'candidate-pass', test: () => true }],
      work: ({ state }) => { state.value = 1; }
    }
  ])).result;

  assert.deepEqual(receipt.candidates[0].candidate.authority, ['WRITE-SANDBOX']);
  assert.equal(receipt.status, 'HELD_INTEGRATION');
  assert.equal(receipt.integration.candidate, null);
});

test('ready creation cycle still requires a separate explicit commit and returns a new body', async () => {
  const protectedBody = { value: 0 };
  const fabric = new CreationFabric({ limits: { workers: 1 } });
  const receipt = await fabric.start(makeSpec(protectedBody, [
    candidate('approved', ({ state }) => { state.value = 7; })
  ])).result;

  assert.equal(receipt.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.deepEqual(protectedBody, { value: 0 });

  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'body:v1',
    plan: receipt.bodyPlan.mergePlan
  });

  assert.deepEqual(committed.state, { value: 7 });
  assert.deepEqual(protectedBody, { value: 0 });
});
