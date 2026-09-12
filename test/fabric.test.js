import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ParallelCapabilityFabric,
  detectProposedChangeConflicts,
  selectCandidate
} from '../src/index.js';

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

function makeSpec(tasks, overrides = {}) {
  return {
    runId: overrides.runId ?? 'run-test',
    goal: overrides.goal ?? 'test bounded orchestration',
    stateRef: overrides.stateRef ?? 'state:v1',
    rollbackRef: overrides.rollbackRef ?? 'state:v0',
    checkpointRef: overrides.checkpointRef,
    resourceBudget: overrides.resourceBudget,
    tasks
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function resignCheckpoint(checkpoint) {
  const { checkpointId, ...core } = checkpoint;
  checkpoint.checkpointId = `parallel-checkpoint:sha256:${createHash('sha256').update(stableStringify(core)).digest('hex')}`;
  return checkpoint;
}

test('bounded scheduler uses multiple slots without exceeding worker cap', async () => {
  let active = 0;
  let maxActive = 0;
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 2 } });
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    taskId: `t${index}`,
    run: async ({ signal }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20, signal);
      active -= 1;
      return { output: index };
    }
  }));

  const receipt = await fabric.start(makeSpec(tasks)).result;
  assert.equal(receipt.status, 'COMPLETED');
  assert.equal(maxActive, 2);
  assert.deepEqual(receipt.outputs.map((item) => item.taskId), ['t0', 't1', 't2', 't3', 't4', 't5']);
});

test('resource tokens can constrain concurrency beyond worker count', async () => {
  let active = 0;
  let maxActive = 0;
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 4, memoryMB: 100 } });
  const tasks = Array.from({ length: 3 }, (_, index) => ({
    taskId: `memory-${index}`,
    resources: { workers: 1, memoryMB: 70 },
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      active -= 1;
      return { output: index };
    }
  }));

  const receipt = await fabric.start(makeSpec(tasks)).result;
  assert.equal(receipt.status, 'COMPLETED');
  assert.equal(maxActive, 1);
});

test('task graph waits for dependencies but runs independent roots together', async () => {
  const events = [];
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 2 } });
  const session = fabric.start(makeSpec([
    { taskId: 'a', run: async () => { events.push('a:start'); await sleep(15); events.push('a:end'); return { output: 2 }; } },
    { taskId: 'b', run: async () => { events.push('b:start'); await sleep(15); events.push('b:end'); return { output: 3 }; } },
    { taskId: 'sum', dependencies: ['a', 'b'], run: ({ dependencyOutputs }) => ({ output: dependencyOutputs.a + dependencyOutputs.b }) }
  ]));

  const receipt = await session.result;
  assert.equal(receipt.outputs.find((item) => item.taskId === 'sum').output, 5);
  const sumIndex = events.findIndex((event) => event.startsWith('sum'));
  assert.equal(sumIndex, -1);
  assert.deepEqual(receipt.outputs.map((item) => item.taskId), ['a', 'b', 'sum']);
});

test('pause stops new lanes and resume continues without duplicating completed work', async () => {
  const starts = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 1 } });
  const session = fabric.start(makeSpec([
    { taskId: 'one', run: async () => { starts.push('one'); firstStarted(); await firstGate; return { output: 1 }; } },
    { taskId: 'two', run: async () => { starts.push('two'); return { output: 2 }; } },
    { taskId: 'three', run: async () => { starts.push('three'); return { output: 3 }; } }
  ]));

  await firstStartedPromise;
  session.pause();
  releaseFirst();
  await sleep(10);
  assert.deepEqual(starts, ['one']);
  session.resume();
  const receipt = await session.result;
  assert.equal(receipt.status, 'COMPLETED');
  assert.deepEqual(starts, ['one', 'two', 'three']);
});

test('cancel aborts active work and prevents pending lanes from starting', async () => {
  const starts = [];
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 1 } });
  const session = fabric.start(makeSpec([
    { taskId: 'active', run: async ({ signal }) => { starts.push('active'); started(); await sleep(1000, signal); return { output: 1 }; } },
    { taskId: 'pending', run: async () => { starts.push('pending'); return { output: 2 }; } }
  ]));

  await startedPromise;
  session.cancel();
  const receipt = await session.result;
  assert.equal(receipt.status, 'CANCELLED');
  assert.deepEqual(starts, ['active']);
  assert.equal(receipt.outputs.find((item) => item.taskId === 'pending').status, 'CANCELLED');
});

test('checkpoint reuse skips completed lanes and binds to exact stateRef', async () => {
  const counts = { a: 0, b: 0 };
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 1 } });
  const spec = makeSpec([
    { taskId: 'a', run: () => { counts.a += 1; return { output: 'A' }; } },
    { taskId: 'b', dependencies: ['a'], run: () => { counts.b += 1; return { output: 'B' }; } }
  ], { runId: 'checkpoint-run', stateRef: 'state:exact', checkpointRef: 'checkpoint-plan:v1' });

  const first = await fabric.start(spec).result;
  assert.deepEqual(counts, { a: 1, b: 1 });

  const resumed = await fabric.start(spec, { checkpoint: first.checkpoint }).result;
  assert.deepEqual(counts, { a: 1, b: 1 });
  assert.equal(resumed.status, 'COMPLETED');

  assert.throws(() => fabric.start({ ...spec, stateRef: 'state:stale' }, { checkpoint: first.checkpoint }), /stateRef mismatch/);
});

test('checkpoint reuse refuses changed task structure under reused run and state labels', async () => {
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 1 } });
  const spec = makeSpec([
    { taskId: 'a', capabilityId: 'cap:a', inputRefs: ['input:v1'], run: () => ({ output: 'A' }) }
  ], { runId: 'checkpoint-structure', stateRef: 'state:same', checkpointRef: 'implementation:v1' });
  const first = await fabric.start(spec).result;
  const changed = {
    ...spec,
    tasks: [{ ...spec.tasks[0], inputRefs: ['input:v2'] }]
  };

  assert.throws(
    () => fabric.start(changed, { checkpoint: first.checkpoint }),
    /spec fingerprint mismatch/
  );
});

test('checkpoint reuse requires an explicit implementation revision ref', async () => {
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 1 } });
  const spec = makeSpec([
    { taskId: 'a', run: () => ({ output: 'A' }) }
  ], { runId: 'checkpoint-no-ref', stateRef: 'state:same' });
  const first = await fabric.start(spec).result;

  assert.throws(
    () => fabric.start(spec, { checkpoint: first.checkpoint }),
    /requires an explicit checkpointRef/
  );
});

test('checkpoint integrity binds restored outputs and receipts', async () => {
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 1 } });
  const spec = makeSpec([
    { taskId: 'a', run: () => ({ output: 'A' }) }
  ], { runId: 'checkpoint-integrity', stateRef: 'state:same', checkpointRef: 'implementation:v1' });
  const first = await fabric.start(spec).result;
  const tampered = structuredClone(first.checkpoint);
  tampered.completed[0].output = 'TAMPERED';

  assert.throws(
    () => fabric.start(spec, { checkpoint: tampered }),
    /Checkpoint integrity mismatch/
  );
});

test('checkpoint receipt lineage is checked after content integrity', async () => {
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 1 } });
  const spec = makeSpec([
    { taskId: 'a', run: () => ({ output: 'A' }) }
  ], { runId: 'checkpoint-lineage', stateRef: 'state:same', checkpointRef: 'implementation:v1' });
  const first = await fabric.start(spec).result;
  const forged = structuredClone(first.checkpoint);
  forged.completed[0].receipt.taskId = 'other-task';
  resignCheckpoint(forged);

  assert.throws(
    () => fabric.start(spec, { checkpoint: forged }),
    /receipt lineage mismatch/
  );
});

test('legacy v0.1 checkpoints fail closed instead of receiving invented plan identity', () => {
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 1 } });
  const spec = makeSpec([
    { taskId: 'a', run: () => ({ output: 'A' }) }
  ], { runId: 'checkpoint-legacy', stateRef: 'state:same', checkpointRef: 'implementation:v1' });
  const legacy = {
    schema: 'axm.parallel-capability-checkpoint/v0.1',
    runId: spec.runId,
    stateRef: spec.stateRef,
    completed: []
  };

  assert.throws(
    () => fabric.start(spec, { checkpoint: legacy }),
    /Legacy checkpoint v0.1/
  );
});

test('failed dependency blocks dependent lane while independent lane survives', async () => {
  const fabric = new ParallelCapabilityFabric({ limits: { workers: 2 } });
  const receipt = await fabric.start(makeSpec([
    { taskId: 'bad', run: () => { throw new Error('boom'); } },
    { taskId: 'blocked', dependencies: ['bad'], run: () => ({ output: 'should not run' }) },
    { taskId: 'independent', run: () => ({ output: 'survived' }) }
  ])).result;

  assert.equal(receipt.status, 'COMPLETED_WITH_FAILURES');
  assert.equal(receipt.outputs.find((item) => item.taskId === 'bad').status, 'FAILED');
  assert.equal(receipt.outputs.find((item) => item.taskId === 'blocked').status, 'BLOCKED_DEPENDENCY');
  assert.equal(receipt.outputs.find((item) => item.taskId === 'independent').output, 'survived');
});

test('conflict detector preserves incompatible proposed changes instead of averaging them', () => {
  const conflicts = detectProposedChangeConflicts([
    { laneId: 'performance', taskId: 'cache', proposedChanges: [{ path: 'config.cacheMB', op: 'set', value: 2048 }] },
    { laneId: 'memory', taskId: 'cache', proposedChanges: [{ path: 'config.cacheMB', op: 'set', value: 128 }] }
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'config.cacheMB');
  assert.equal(conflicts[0].candidates.length, 2);
});

test('candidate selection uses explicit predicates and deterministic metric comparator', () => {
  const receipt = selectCandidate([
    { id: 'fast-risky', testsPass: false, runtimeMs: 2 },
    { id: 'safe-slow', testsPass: true, runtimeMs: 9 },
    { id: 'safe-fast', testsPass: true, runtimeMs: 4 }
  ], {
    runId: 'select-1',
    predicates: [{ id: 'tests-pass', test: (candidate) => candidate.testsPass === true }],
    compare: (a, b) => a.runtimeMs - b.runtimeMs
  });

  assert.equal(receipt.selected, 'safe-fast');
  assert.deepEqual(receipt.accepted, ['safe-fast', 'safe-slow']);
  assert.deepEqual(receipt.rejected, ['fast-risky']);
});

test('cyclic task graph is rejected before execution', () => {
  const fabric = new ParallelCapabilityFabric();
  assert.throws(() => fabric.start(makeSpec([
    { taskId: 'a', dependencies: ['b'], run: () => ({ output: 1 }) },
    { taskId: 'b', dependencies: ['a'], run: () => ({ output: 2 }) }
  ])), /cycle/);
});
