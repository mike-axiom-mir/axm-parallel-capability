import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCheckpointFileStore } from '../src/checkpoint-file-store.js';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function makeCheckpoint(createdAt) {
  const core = {
    schema: 'axm.parallel-capability-checkpoint/v0.2',
    runId: 'ancestor-symlink-run',
    stateRef: 'state:v1',
    checkpointRef: 'impl:v1',
    specFingerprint: 'ancestor-symlink-fixture',
    createdAt,
    completed: []
  };
  return {
    ...core,
    checkpointId: `parallel-checkpoint:sha256:${createHash('sha256').update(stableStringify(core)).digest('hex')}`
  };
}

test('put refuses a checkpoint root reached through a symlinked ancestor', async () => {
  const base = await mkdtemp(join(tmpdir(), 'axm-checkpoint-ancestor-put-'));
  const realParent = join(base, 'real-parent');
  const linkedParent = join(base, 'linked-parent');
  const configuredRoot = join(linkedParent, 'store');
  const redirectedRoot = join(realParent, 'store');
  const checkpoint = makeCheckpoint('2026-09-11T07:00:00.000Z');

  try {
    await mkdir(realParent);
    await symlink(realParent, linkedParent, 'dir');
    const store = new LocalCheckpointFileStore({ root: configuredRoot });

    let observedError = null;
    try {
      await store.put(checkpoint);
    } catch (error) {
      observedError = error;
    }

    const redirectedPath = join(redirectedRoot, `${checkpoint.checkpointId.slice(-64)}.checkpoint.json`);
    const redirected = await readFile(redirectedPath, 'utf8').then(() => true, () => false);
    assert.equal(observedError?.code, 'AXM_CHECKPOINT_STORE_ROOT_UNSAFE', `expected unsafe-root rejection; redirected=${redirected}`);
    assert.equal(redirected, false, 'checkpoint bytes escaped through a symlinked ancestor of the configured root');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('get refuses a checkpoint root reached through a symlinked ancestor', async () => {
  const base = await mkdtemp(join(tmpdir(), 'axm-checkpoint-ancestor-get-'));
  const realParent = join(base, 'real-parent');
  const linkedParent = join(base, 'linked-parent');
  const realRoot = join(realParent, 'store');
  const configuredRoot = join(linkedParent, 'store');
  const checkpoint = makeCheckpoint('2026-09-11T07:01:00.000Z');

  try {
    await mkdir(realParent);
    const directStore = new LocalCheckpointFileStore({ root: realRoot });
    await directStore.put(checkpoint);
    await symlink(realParent, linkedParent, 'dir');

    const linkedStore = new LocalCheckpointFileStore({ root: configuredRoot });
    await assert.rejects(
      linkedStore.get(checkpoint.checkpointId),
      (error) => error?.code === 'AXM_CHECKPOINT_STORE_ROOT_UNSAFE'
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
