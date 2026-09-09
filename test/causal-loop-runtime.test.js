import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createCausalLoopRuntimeObservation,
  observeCausalLoopProvider,
  verifyCausalLoopRuntimeObservation
} from '../src/causal-loop-runtime.js';

const CAPABILITY_ID = 'axm.causal-loop.train-platform.process/v1';
const RESPONSE_SCHEMA = 'axm.causal-loop.process-response/v1';

function stable(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
function sha(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}
function descriptor() {
  return {
    schema: 'axm.capability/v1',
    capabilityId: CAPABILITY_ID,
    provider: {
      repository: 'mike-axiom-mir/axm-casual-loop',
      module: 'causal_loop.process_adapter',
      entrypoint: 'scripts/causal_loop_ndjson.py',
      licenseFile: 'LICENSE'
    },
    protocol: {
      transport: 'ndjson-stdio',
      requestSchema: 'axm.causal-loop.process-request/v1',
      responseSchema: RESPONSE_SCHEMA,
      operations: ['describe', 'run', 'verify']
    },
    engine: {
      loopId: 'axm.train-platform-loop/v0.01',
      loopVersion: '0.08',
      receiptSchema: 'axm.causal-loop.run-receipt/v0.08',
      engineSignature: 'f'.repeat(64),
      allowedActions: ['WAIT', 'BLOCK_DOOR', 'TRIGGER_ALARM', 'TALK_TO_PASSENGER'],
      maxTimedInfluences: 64,
      maxWavesLimit: 256
    },
    properties: { deterministic: true, headless: true, offline: true, thirdPartyDependencies: false },
    authority: { commitsHistory: false, writesCanonicalState: false, merges: false, declaresCanon: false }
  };
}
function evidence() {
  const cap = descriptor();
  const authority = cap.authority;
  const receiptCore = {
    schema: 'axm.causal-loop.run-receipt/v0.08',
    loopId: 'axm.train-platform-loop/v0.01',
    loopVersion: '0.08',
    status: 'converged',
    committed: false,
    endState: { 'train.status': 'departed' },
    timedExternalInfluences: []
  };
  const receipt = { ...receiptCore, receiptHash: sha(receiptCore) };
  return {
    cap,
    describeResponse: {
      schema: RESPONSE_SCHEMA,
      requestId: 'x:describe',
      status: 'PASS',
      capabilityId: CAPABILITY_ID,
      authority,
      capability: cap
    },
    runResponse: {
      schema: RESPONSE_SCHEMA,
      requestId: 'x:run',
      status: 'PASS',
      capabilityId: CAPABILITY_ID,
      authority,
      inputHash: '1'.repeat(64),
      receiptHash: receipt.receiptHash,
      executionMaxWaves: 64,
      executionStatus: 'converged',
      replayMatches: true,
      receipt
    }
  };
}

test('turns bounded provider execution into integrity-bound runtime evidence only', () => {
  const { cap, describeResponse, runResponse } = evidence();
  const receipt = createCausalLoopRuntimeObservation({
    timedInfluences: [],
    maxWaves: 64,
    requestId: 'x',
    providerSourceRef: 'cb2793fbb48efd750670bd9d08abe5a0bfa233df',
    providerEntrypointSha256: 'a'.repeat(64),
    providerDescriptorSha256: 'b'.repeat(64),
    descriptor: cap,
    describeResponse,
    runResponse
  });
  const verified = verifyCausalLoopRuntimeObservation(receipt);
  assert.equal(verified.status, 'PASS');
  assert.equal(verified.runtimeObserved, true);
  assert.equal(receipt.observation.providerReceiptCommitted, false);
  assert.equal(receipt.authority.automaticRegistration, false);
  assert.equal(receipt.authority.merge, false);
  assert.equal(receipt.truthBoundary.providerImplementationIndependentlyReplayedByConsumer, false);
});

test('rejects a provider receipt promoted to committed history', () => {
  const { cap, describeResponse, runResponse } = evidence();
  runResponse.receipt.committed = true;
  const inner = { ...runResponse.receipt };
  delete inner.receiptHash;
  runResponse.receiptHash = sha(inner);
  runResponse.receipt.receiptHash = runResponse.receiptHash;
  assert.throws(() => createCausalLoopRuntimeObservation({
    providerEntrypointSha256: 'a'.repeat(64),
    providerDescriptorSha256: 'b'.repeat(64),
    descriptor: cap,
    describeResponse,
    runResponse
  }), /committed history/);
});

test('detects inner provider evidence drift even when the outer observation is resealed', () => {
  const { cap, describeResponse, runResponse } = evidence();
  const receipt = createCausalLoopRuntimeObservation({
    providerEntrypointSha256: 'a'.repeat(64),
    providerDescriptorSha256: 'b'.repeat(64),
    descriptor: cap,
    describeResponse,
    runResponse
  });
  receipt.providerEvidence.runResponse.receipt.endState['train.status'] = 'forged';
  const core = { ...receipt };
  delete core.receiptSha256;
  receipt.receiptSha256 = sha(core);
  assert.throws(() => verifyCausalLoopRuntimeObservation(receipt), /Provider receipt integrity mismatch/);
});

test('rejects a descriptor that grants provider authority', () => {
  const { cap, describeResponse, runResponse } = evidence();
  cap.authority.commitsHistory = true;
  describeResponse.authority.commitsHistory = true;
  describeResponse.capability = cap;
  assert.throws(() => createCausalLoopRuntimeObservation({
    providerEntrypointSha256: 'a'.repeat(64),
    providerDescriptorSha256: 'b'.repeat(64),
    descriptor: cap,
    describeResponse,
    runResponse
  }), /commitsHistory must be false/);
});

test('missing optional provider fails cleanly without selection or merge authority', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'axm-pcf-')), 'missing-provider');
  const receipt = observeCausalLoopProvider({
    providerRoot: missing,
    timedInfluences: [{ atWave: 2, action: 'BLOCK_DOOR' }],
    providerSourceRef: 'cb2793fbb48efd750670bd9d08abe5a0bfa233df'
  });
  assert.equal(receipt.observation.status, 'HOLD');
  assert.equal(receipt.observation.runtimeVerifiedWithinProviderContract, false);
  assert.equal(receipt.observation.reason.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(receipt.authority.automaticSelection, false);
  assert.equal(receipt.authority.merge, false);
  assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/);
});
