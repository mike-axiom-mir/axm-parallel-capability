import test from 'node:test';
import assert from 'node:assert/strict';
import { createMergePlan } from '../src/merge.js';
import { commitMerge, verifyMergeReceipt } from '../src/merge-gate.js';

const SOURCE = Object.freeze({ config: { cacheMB: 64 }, ui: { compact: false } });

function createPlan({ value = 128, candidateId = 'cache' } = {}) {
  return createMergePlan({
    runId: 'merge-receipt-integrity',
    stateRef: 'state:v1',
    rollbackRef: 'state:v0',
    candidates: [{
      id: candidateId,
      laneId: candidateId,
      taskId: `task-${candidateId}`,
      stateRef: 'state:v1',
      status: 'COMPLETED',
      authorityUsed: ['COMMIT-CANDIDATE'],
      evidenceRefs: [`evidence:${candidateId}`],
      testResults: [{ id: 'unit', passed: true }],
      proposedChanges: [{
        path: 'config.cacheMB',
        op: 'set',
        value,
        precondition: { value: 64 }
      }]
    }],
    now: () => '2026-09-09T10:00:00.000Z'
  });
}

function commit(options = {}) {
  return commitMerge({
    state: structuredClone(SOURCE),
    currentStateRef: 'state:v1',
    plan: createPlan(options),
    resultingStateRef: 'state:v2',
    now: () => '2026-09-09T10:00:01.000Z'
  });
}

test('commit binds the complete merge receipt to a deterministic identity', () => {
  const committed = commit();

  assert.match(committed.receipt.receiptId, /^merge-receipt:sha256:[0-9a-f]{64}$/);
  assert.equal(committed.rollbackToken.mergeReceiptId, committed.receipt.receiptId);

  const verified = verifyMergeReceipt({
    receipt: committed.receipt,
    expectedReceiptId: committed.receipt.receiptId,
    sourceState: SOURCE,
    resultingState: committed.state,
    rollbackToken: committed.rollbackToken
  });

  assert.equal(verified.valid, true);
  assert.equal(verified.receiptId, committed.receipt.receiptId);
  assert.equal(verified.sourceStateHash, committed.receipt.sourceStateHash);
  assert.equal(verified.resultingStateHash, committed.receipt.resultingStateHash);
});

test('receipt mutation is rejected instead of remaining plausible audit evidence', () => {
  const committed = commit();
  const tampered = structuredClone(committed.receipt);
  tampered.accepted = ['forged-candidate'];

  assert.throws(
    () => verifyMergeReceipt({ receipt: tampered }),
    /Merge receipt integrity check failed/
  );
});

test('unsealed fields cannot be injected into a valid merge receipt', () => {
  const committed = commit();
  const tampered = structuredClone(committed.receipt);
  tampered.canonAuthority = 'FORGED';

  assert.throws(
    () => verifyMergeReceipt({ receipt: tampered }),
    /Merge receipt contains unsupported fields: canonAuthority/
  );
});

test('new rollback tokens bind their exact creation time', () => {
  const committed = commit();
  const tampered = structuredClone(committed.rollbackToken);
  tampered.createdAt = '2099-01-01T00:00:00.000Z';

  assert.throws(
    () => verifyMergeReceipt({ receipt: committed.receipt, rollbackToken: tampered }),
    /Rollback token integrity check failed/
  );
});

test('caller-pinned receipt identity rejects a different self-consistent merge receipt', () => {
  const original = commit({ value: 128, candidateId: 'cache-128' });
  const substitute = commit({ value: 256, candidateId: 'cache-256' });

  assert.notEqual(substitute.receipt.receiptId, original.receipt.receiptId);
  assert.throws(
    () => verifyMergeReceipt({
      receipt: substitute.receipt,
      expectedReceiptId: original.receipt.receiptId
    }),
    /does not match expected receipt identity/
  );
});

test('receipt verification binds the exact source and resulting canonical state bytes', () => {
  const committed = commit();
  const wrongSource = structuredClone(SOURCE);
  wrongSource.ui.compact = true;
  const wrongResult = structuredClone(committed.state);
  wrongResult.ui.compact = true;

  assert.throws(
    () => verifyMergeReceipt({ receipt: committed.receipt, sourceState: wrongSource }),
    /source state hash mismatch/
  );
  assert.throws(
    () => verifyMergeReceipt({ receipt: committed.receipt, resultingState: wrongResult }),
    /resulting state hash mismatch/
  );
});

test('receipt verification rejects a valid rollback token from a different merge', () => {
  const original = commit({ value: 128, candidateId: 'cache-128' });
  const other = commit({ value: 256, candidateId: 'cache-256' });

  assert.throws(
    () => verifyMergeReceipt({
      receipt: original.receipt,
      rollbackToken: other.rollbackToken
    }),
    /does not match rollback token identity/
  );
});
