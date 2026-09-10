import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalCheckpointFileStore,
  verifyCheckpointForStorage
} from '../src/checkpoint-file-store.js';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function makeCheckpoint() {
  const core = {
    schema: 'axm.parallel-capability-checkpoint/v0.2',
    runId: 'run',
    stateRef: 'state:v1',
    checkpointRef: 'impl:v1',
    specFingerprint: 'fixture-fingerprint',
    createdAt: '2026-09-10T00:00:00.000Z',
    completed: [{
      taskId: 'a',
      state: 'COMPLETED',
      output: { value: 42 },
      receipt: { runId: 'run', taskId: 'a', stateRef: 'state:v1' }
    }]
  };
  return {
    ...core,
    checkpointId: `parallel-checkpoint:sha256:${createHash('sha256').update(stableStringify(core)).digest('hex')}`
  };
}

async function withStoreRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'axm-checkpoint-canonical-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('semantic-equivalent pretty JSON is not admitted as exact checkpoint storage', async () => withStoreRoot(async (root) => {
  const checkpoint = makeCheckpoint();
  const store = new LocalCheckpointFileStore({ root });
  await store.put(checkpoint);

  await writeFile(store.pathFor(checkpoint.checkpointId), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');

  await assert.rejects(
    store.get(checkpoint.checkpointId),
    /canonical checkpoint storage bytes/
  );
}));

test('duplicate-key bytes that collapse to the same semantic checkpoint are rejected', async () => withStoreRoot(async (root) => {
  const checkpoint = makeCheckpoint();
  const store = new LocalCheckpointFileStore({ root });
  await store.put(checkpoint);

  const { canonical } = verifyCheckpointForStorage(checkpoint);
  const ambiguous = canonical.replace('"runId":"run"', '"runId":"forged","runId":"run"');
  assert.notEqual(ambiguous, canonical);
  await writeFile(store.pathFor(checkpoint.checkpointId), `${ambiguous}\n`, 'utf8');

  await assert.rejects(
    store.get(checkpoint.checkpointId),
    /canonical checkpoint storage bytes/
  );
}));
