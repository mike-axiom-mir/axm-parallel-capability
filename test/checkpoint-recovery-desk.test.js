import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCheckpointFileStore } from '../src/checkpoint-file-store.js';
import { buildCheckpointRecoveryModel, renderCheckpointRecoveryDesk } from '../experience/checkpoint-recovery-desk.js';

const execFileAsync = promisify(execFile);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function makeCheckpoint({ checkpointRef = 'commit:experience-v1' } = {}) {
  const core = {
    schema: 'axm.parallel-capability-checkpoint/v0.2',
    runId: 'experience-recovery-run',
    stateRef: 'state:experience-v1',
    checkpointRef,
    specFingerprint: 'fixture-fingerprint',
    createdAt: '2026-09-10T06:00:00.000Z',
    completed: [
      {
        taskId: 'clear-task',
        state: 'COMPLETED',
        output: { privateFixture: 'must-not-be-rendered' },
        receipt: {
          runId: 'experience-recovery-run',
          laneId: 'lane-clear',
          taskId: 'clear-task',
          capabilityId: 'fixture.clear',
          stateRef: 'state:experience-v1',
          evidenceRefs: ['evidence:clear'],
          testResults: [{ status: 'PASS' }],
          proposedChanges: [],
          assumptions: [],
          unknowns: [],
          contradictions: [],
          failures: []
        }
      },
      {
        taskId: 'attention-task',
        state: 'COMPLETED',
        output: { privateFixture: 'also-not-rendered' },
        receipt: {
          runId: 'experience-recovery-run',
          laneId: 'lane-attention',
          taskId: 'attention-task',
          capabilityId: 'fixture.review',
          stateRef: 'state:experience-v1',
          evidenceRefs: ['evidence:frame'],
          testResults: [{ status: 'PASS' }],
          proposedChanges: [{ path: 'candidate.js' }],
          assumptions: [],
          unknowns: ['physical device behavior not observed'],
          contradictions: [],
          failures: []
        }
      }
    ]
  };
  return {
    ...core,
    checkpointId: `parallel-checkpoint:sha256:${createHash('sha256').update(stableStringify(core)).digest('hex')}`
  };
}

async function withTempRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'axm-checkpoint-recovery-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('recovery model exposes exact identity, attention and bounded next action', () => {
  const model = buildCheckpointRecoveryModel(makeCheckpoint());
  assert.equal(model.completedCount, 2);
  assert.equal(model.attentionCount, 1);
  assert.equal(model.resumeState, 'EXACT ID REQUIRED');
  assert.equal(model.authority, 'DISPLAY_ONLY');
  assert.equal(model.tasks[1].needsAttention, true);

  const html = renderCheckpointRecoveryDesk(model);
  assert.match(html, /DISPLAY ≠ RESUME AUTHORITY/);
  assert.match(html, /ATTENTION ONLY/);
  assert.match(html, /EXACT ID REQUIRED/);
  assert.doesNotMatch(html, /must-not-be-rendered|also-not-rendered/);
});

test('checkpoint without checkpointRef is rendered as rerun-required rather than resumable', () => {
  const model = buildCheckpointRecoveryModel(makeCheckpoint({ checkpointRef: null }));
  assert.equal(model.resumeState, 'RERUN REQUIRED');
  assert.match(model.resumeGuidance, /Do not resume/);
});

test('CLI reads only the caller-named checkpoint through LocalCheckpointFileStore before rendering', async () => withTempRoot(async (root) => {
  const checkpoint = makeCheckpoint();
  const store = new LocalCheckpointFileStore({ root });
  await store.put(checkpoint);
  const output = join(root, 'recovery.html');

  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/checkpoint-recovery-desk.mjs',
    '--store', root,
    '--id', checkpoint.checkpointId,
    '--out', output
  ], { cwd: process.cwd() });

  const receipt = JSON.parse(stdout);
  assert.equal(receipt.checkpointId, checkpoint.checkpointId);
  assert.equal(receipt.retainedTasks, 2);
  assert.equal(receipt.attentionTasks, 1);
  assert.equal(receipt.authority, 'DISPLAY_ONLY');

  const html = await readFile(output, 'utf8');
  assert.match(html, new RegExp(checkpoint.checkpointId));
  assert.doesNotMatch(html, /must-not-be-rendered|also-not-rendered/);

  await assert.rejects(
    execFileAsync(process.execPath, [
      'scripts/checkpoint-recovery-desk.mjs', '--store', root, '--id', '../../latest', '--out', output
    ], { cwd: process.cwd() }),
    /checkpointId must be/
  );
}));
