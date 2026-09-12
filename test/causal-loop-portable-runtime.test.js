import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { observePortableCausalLoopProvider } from '../src/causal-loop-portable-runtime.js';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'axm-parallel-portable-causal-loop-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function observe(portablePath, expectedArtifactSha256) {
  return observePortableCausalLoopProvider({
    portablePath: resolve(portablePath),
    expectedArtifactSha256,
    providerSourceRef: 'test-provider-head',
    timedInfluences: [{ atWave: 2, action: 'BLOCK_DOOR' }],
    maxWaves: 64,
    requestId: 'portable-admission-test',
    pythonExecutable: 'python3'
  });
}

test('missing portable provider holds before execution', () => withTempDir((root) => {
  const receipt = observe(join(root, 'missing.pyz'), '0'.repeat(64));
  assert.equal(receipt.observation.status, 'HOLD');
  assert.equal(receipt.observation.reason.code, 'PORTABLE_ARTIFACT_UNAVAILABLE');
  assert.equal(receipt.authority.kind, 'RUNTIME_EVIDENCE_ONLY');
  assert.equal(receipt.authority.automaticExecution, false);
  assert.equal(receipt.authority.merge, false);
  assert.equal(receipt.authority.canon, false);
}));

test('caller-pinned digest mismatch refuses artifact before executing it', () => withTempDir((root) => {
  const marker = join(root, 'EXECUTED');
  const portablePath = join(root, 'provider.pyz');
  const body = Buffer.from(`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ran', encoding='utf-8')\n`, 'utf8');
  writeFileSync(portablePath, body);
  const before = readFileSync(portablePath);

  const receipt = observe(portablePath, '0'.repeat(64));

  assert.equal(receipt.observation.status, 'HOLD');
  assert.equal(receipt.observation.reason.code, 'PORTABLE_ARTIFACT_DIGEST_MISMATCH');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readFileSync(portablePath), before);
}));

test('non-file artifact path fails closed', () => withTempDir((root) => {
  const portablePath = join(root, 'provider.pyz');
  mkdirSync(portablePath);

  const receipt = observe(portablePath, '0'.repeat(64));

  assert.equal(receipt.observation.status, 'HOLD');
  assert.equal(receipt.observation.reason.code, 'PORTABLE_ARTIFACT_PATH_UNSAFE');
}));

test('artifact larger than the portable ceiling is rejected without execution', () => withTempDir((root) => {
  const portablePath = join(root, 'provider.pyz');
  const bytes = Buffer.alloc((4 * 1024 * 1024) + 1, 0x41);
  writeFileSync(portablePath, bytes);

  const receipt = observe(portablePath, sha256(bytes));

  assert.equal(receipt.observation.status, 'HOLD');
  assert.equal(receipt.observation.reason.code, 'PORTABLE_ARTIFACT_SIZE_INVALID');
}));
