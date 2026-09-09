import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ParallelCapabilityFabric } from '../src/fabric.js';
import {
  LocalCheckpointFileStore,
  verifyCheckpointForStorage
} from '../src/checkpoint-file-store.js';

const execFileAsync = promisify(execFile);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function makeCheckpoint(overrides = {}) {
  const core = {
    schema: 'axm.parallel-capability-checkpoint/v0.2',
    runId: 'run',
    stateRef: 'state:v1',
    checkpointRef: 'impl:v1',
    specFingerprint: 'fixture-fingerprint',
    createdAt: '2026-09-09T00:00:00.000Z',
    completed: [{
      taskId: 'a',
      state: 'COMPLETED',
      output: { value: 42 },
      receipt: { runId: 'run', taskId: 'a', stateRef: 'state:v1' }
    }],
    ...overrides
  };
  return {
    ...core,
    checkpointId: `parallel-checkpoint:sha256:${createHash('sha256').update(stableStringify(core)).digest('hex')}`
  };
}

async function withStoreRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'axm-checkpoint-store-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('persisted v0.2 checkpoint resumes in a fresh Node process without rerunning completed work', async () => withStoreRoot(async (root) => {
  const spec = {
    runId: 'persistent-restart-run',
    goal: 'resume completed work from local checkpoint storage',
    stateRef: 'state:restart-v1',
    rollbackRef: 'state:restart-v0',
    checkpointRef: 'implementation:restart-v1',
    tasks: [{
      taskId: 'finished',
      capabilityId: 'fixture.finished',
      inputRefs: ['fixture:v1'],
      run: () => ({ output: { value: 42 } })
    }]
  };

  const first = await new ParallelCapabilityFabric({ limits: { workers: 1 } }).start(spec).result;
  const store = new LocalCheckpointFileStore({ root });
  const stored = await store.put(first.checkpoint);
  assert.equal(stored.status, 'STORED');
  assert.equal(stored.authority, 'STORAGE_ONLY');

  const childScript = `
    const { LocalCheckpointFileStore } = await import('./src/checkpoint-file-store.js');
    const { ParallelCapabilityFabric } = await import('./src/fabric.js');
    const checkpoint = await new LocalCheckpointFileStore({ root: process.env.AXM_CHECKPOINT_ROOT }).get(process.env.AXM_CHECKPOINT_ID);
    const spec = {
      runId: 'persistent-restart-run',
      goal: 'resume completed work from local checkpoint storage',
      stateRef: 'state:restart-v1',
      rollbackRef: 'state:restart-v0',
      checkpointRef: 'implementation:restart-v1',
      tasks: [{
        taskId: 'finished',
        capabilityId: 'fixture.finished',
        inputRefs: ['fixture:v1'],
        run: () => { throw new Error('completed task was incorrectly re-executed after restart'); }
      }]
    };
    const receipt = await new ParallelCapabilityFabric({ limits: { workers: 1 } }).start(spec, { checkpoint }).result;
    process.stdout.write(JSON.stringify({ status: receipt.status, output: receipt.outputs[0].output }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AXM_CHECKPOINT_ROOT: root,
      AXM_CHECKPOINT_ID: first.checkpoint.checkpointId
    }
  });
  assert.deepEqual(JSON.parse(stdout), { status: 'COMPLETED', output: { value: 42 } });
}));

test('work completed after cancellation is evidence, not reusable state after restart', async () => withStoreRoot(async (root) => {
  let started;
  let release;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const spec = {
    runId: 'cancelled-restart-run',
    goal: 'do not restore work completed after authority was cancelled',
    stateRef: 'state:cancel-v1',
    rollbackRef: 'state:cancel-v0',
    checkpointRef: 'implementation:cancel-v1',
    tasks: [{
      taskId: 'late',
      capabilityId: 'fixture.late',
      inputRefs: ['fixture:v1'],
      run: async () => {
        started();
        await gate;
        return { output: { source: 'late-after-cancel' } };
      }
    }]
  };

  const firstSession = new ParallelCapabilityFabric({ limits: { workers: 1 } }).start(spec);
  await startedPromise;
  firstSession.cancel();
  release();
  const first = await firstSession.result;

  assert.equal(first.status, 'CANCELLED');
  assert.deepEqual(first.outputs[0], {
    taskId: 'late',
    laneId: 'late',
    status: 'COMPLETED_AFTER_CANCEL',
    output: { source: 'late-after-cancel' }
  });
  assert.equal(first.laneReceipts[0].status, 'COMPLETED_AFTER_CANCEL');
  assert.deepEqual(first.checkpoint.completed, []);

  const store = new LocalCheckpointFileStore({ root });
  await store.put(first.checkpoint);
  const childScript = `
    const { LocalCheckpointFileStore } = await import('./src/checkpoint-file-store.js');
    const { ParallelCapabilityFabric } = await import('./src/fabric.js');
    const checkpoint = await new LocalCheckpointFileStore({ root: process.env.AXM_CHECKPOINT_ROOT }).get(process.env.AXM_CHECKPOINT_ID);
    let executions = 0;
    const spec = {
      runId: 'cancelled-restart-run',
      goal: 'do not restore work completed after authority was cancelled',
      stateRef: 'state:cancel-v1',
      rollbackRef: 'state:cancel-v0',
      checkpointRef: 'implementation:cancel-v1',
      tasks: [{
        taskId: 'late',
        capabilityId: 'fixture.late',
        inputRefs: ['fixture:v1'],
        run: () => {
          executions += 1;
          return { output: { source: 'fresh-reexecution' } };
        }
      }]
    };
    const receipt = await new ParallelCapabilityFabric({ limits: { workers: 1 } }).start(spec, { checkpoint }).result;
    process.stdout.write(JSON.stringify({ executions, output: receipt.outputs[0].output, status: receipt.outputs[0].status }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AXM_CHECKPOINT_ROOT: root,
      AXM_CHECKPOINT_ID: first.checkpoint.checkpointId
    }
  });
  assert.deepEqual(JSON.parse(stdout), {
    executions: 1,
    output: { source: 'fresh-reexecution' },
    status: 'COMPLETED'
  });
}));

test('stored bytes are canonical and reload through a fresh store instance', async () => withStoreRoot(async (root) => {
  const checkpoint = makeCheckpoint();
  const store = new LocalCheckpointFileStore({ root });
  const put = await store.put(checkpoint);
  assert.equal(put.status, 'STORED');
  assert.equal(typeof put.durability.directoryFsync, 'boolean');

  const raw = await readFile(store.pathFor(checkpoint.checkpointId), 'utf8');
  assert.equal(raw.trim(), stableStringify(checkpoint));

  const fresh = new LocalCheckpointFileStore({ root });
  assert.deepEqual(await fresh.get(checkpoint.checkpointId), checkpoint);
}));

test('same checkpoint id is idempotent and different checkpoint ids coexist', async () => withStoreRoot(async (root) => {
  const store = new LocalCheckpointFileStore({ root });
  const first = makeCheckpoint();
  const second = makeCheckpoint({ createdAt: '2026-09-09T01:00:00.000Z' });

  assert.equal((await store.put(first)).status, 'STORED');
  assert.equal((await store.put(first)).status, 'EXISTS');
  assert.equal((await store.put(second)).status, 'STORED');
  assert.deepEqual(await store.get(first.checkpointId), first);
  assert.deepEqual(await store.get(second.checkpointId), second);
}));

test('tampered checkpoint is rejected before it can be persisted', async () => withStoreRoot(async (root) => {
  const store = new LocalCheckpointFileStore({ root });
  const checkpoint = makeCheckpoint();
  checkpoint.completed[0].output.value = 99;

  await assert.rejects(store.put(checkpoint), /integrity mismatch/);
}));

test('corrupt existing content-addressed target is not silently overwritten', async () => withStoreRoot(async (root) => {
  const store = new LocalCheckpointFileStore({ root });
  const checkpoint = makeCheckpoint();
  await mkdir(root, { recursive: true });
  await writeFile(store.pathFor(checkpoint.checkpointId), 'not-json\n');

  await assert.rejects(store.put(checkpoint), /JSON is invalid/);
  assert.equal(await readFile(store.pathFor(checkpoint.checkpointId), 'utf8'), 'not-json\n');
}));

test('abandoned temp files are ignored because reads require the exact checkpoint identity', async () => withStoreRoot(async (root) => {
  const store = new LocalCheckpointFileStore({ root });
  const checkpoint = makeCheckpoint();
  await store.put(checkpoint);
  await writeFile(join(root, '.abandoned.tmp'), 'partial');

  assert.deepEqual(await store.get(checkpoint.checkpointId), checkpoint);
}));

test('path-like ids, non-portable JSON, and oversized checkpoints fail closed', async () => withStoreRoot(async (root) => {
  const store = new LocalCheckpointFileStore({ root, maxBytes: 1400 });
  await assert.rejects(store.get('../../etc/passwd'), /checkpointId must be/);

  const nonFinite = makeCheckpoint();
  nonFinite.completed[0].output.value = Number.NaN;
  assert.throws(() => verifyCheckpointForStorage(nonFinite), /finite JSON numbers/);

  const oversized = makeCheckpoint({ padding: 'x'.repeat(2000) });
  await assert.rejects(store.put(oversized), /maxBytes/);
}));
