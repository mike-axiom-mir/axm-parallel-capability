import { createHash } from 'node:crypto';
import {
  commitMerge as commitMergeEngine,
  rollbackMerge as rollbackMergeEngine,
  hashState
} from './merge.js';

const MERGE_PLAN_SCHEMA = 'axm.parallel-capability-merge-plan/v0.2';
const MERGE_RECEIPT_SCHEMA = 'axm.parallel-capability-merge-receipt/v0.2';
const ROLLBACK_TOKEN_SCHEMA = 'axm.parallel-capability-rollback-token/v0.2';

export function commitMerge(args) {
  assertPlanIntegrity(args?.plan);
  const result = commitMergeEngine(args);

  const receiptCore = mergeReceiptCore(result.receipt);
  result.receipt.receiptId = `merge-receipt:sha256:${sha256(stableStringify(receiptCore))}`;

  result.rollbackToken.mergeReceiptId = result.receipt.receiptId;
  const tokenCore = rollbackTokenCore(result.rollbackToken);
  result.rollbackToken.tokenId = `rollback-token:sha256:${sha256(stableStringify(tokenCore))}`;
  return result;
}

export function rollbackMerge(args) {
  assertRollbackIntegrity(args?.rollbackToken);
  return rollbackMergeEngine(args);
}

export function verifyMergeReceipt({
  receipt,
  expectedReceiptId = null,
  sourceState,
  resultingState,
  rollbackToken = null
} = {}) {
  assertMergeReceiptIntegrity(receipt);

  if (expectedReceiptId != null && receipt.receiptId !== String(expectedReceiptId)) {
    throw new Error('Merge receipt does not match expected receipt identity');
  }

  if (sourceState !== undefined && hashState(sourceState) !== receipt.sourceStateHash) {
    throw new Error('Merge receipt source state hash mismatch');
  }

  if (resultingState !== undefined && hashState(resultingState) !== receipt.resultingStateHash) {
    throw new Error('Merge receipt resulting state hash mismatch');
  }

  if (rollbackToken != null) {
    assertRollbackIntegrity(rollbackToken);
    if (rollbackToken.mergeReceiptId == null) {
      throw new Error('Rollback token does not bind a merge receipt identity');
    }
    if (rollbackToken.mergeReceiptId !== receipt.receiptId) {
      throw new Error('Merge receipt does not match rollback token identity');
    }
    const lineageChecks = [
      ['runId', rollbackToken.runId, receipt.runId],
      ['planId', rollbackToken.planId, receipt.planId],
      ['sourceStateRef', rollbackToken.sourceStateRef, receipt.sourceStateRef],
      ['resultingStateRef', rollbackToken.resultingStateRef, receipt.resultingStateRef],
      ['rollbackRef', rollbackToken.rollbackRef, receipt.rollbackRef],
      ['sourceStateHash', rollbackToken.sourceStateHash, receipt.sourceStateHash],
      ['resultingStateHash', rollbackToken.resultingStateHash, receipt.resultingStateHash]
    ];
    for (const [field, tokenValue, receiptValue] of lineageChecks) {
      if (tokenValue !== receiptValue) {
        throw new Error(`Merge receipt rollback lineage mismatch: ${field}`);
      }
    }
  }

  return {
    valid: true,
    receiptId: receipt.receiptId,
    runId: receipt.runId,
    planId: receipt.planId,
    sourceStateHash: receipt.sourceStateHash,
    resultingStateHash: receipt.resultingStateHash
  };
}

function assertPlanIntegrity(plan) {
  if (!plan || plan.schema !== MERGE_PLAN_SCHEMA) {
    throw new Error(`Unsupported merge plan schema: ${plan?.schema ?? '<missing>'}`);
  }
  const core = {
    schema: plan.schema,
    runId: plan.runId,
    stateRef: plan.stateRef,
    rollbackRef: plan.rollbackRef,
    conflictPolicy: plan.conflictPolicy,
    requirements: plan.requirements,
    decisions: plan.decisions,
    operations: plan.operations,
    conflicts: plan.conflicts,
    unresolved: plan.unresolved,
    commitAllowed: plan.commitAllowed,
    status: plan.status
  };
  const expected = `merge-plan:sha256:${sha256(stableStringify(core))}`;
  if (plan.planId !== expected) throw new Error('Merge plan integrity check failed');
}

function assertMergeReceiptIntegrity(receipt) {
  if (!receipt || receipt.schema !== MERGE_RECEIPT_SCHEMA) {
    throw new Error(`Unsupported merge receipt schema: ${receipt?.schema ?? '<missing>'}`);
  }
  if (typeof receipt.receiptId !== 'string' || !receipt.receiptId.startsWith('merge-receipt:sha256:')) {
    throw new Error('Merge receipt identity is missing or malformed');
  }
  const expected = `merge-receipt:sha256:${sha256(stableStringify(mergeReceiptCore(receipt)))}`;
  if (receipt.receiptId !== expected) throw new Error('Merge receipt integrity check failed');
}

function assertRollbackIntegrity(token) {
  if (!token || token.schema !== ROLLBACK_TOKEN_SCHEMA) {
    throw new Error(`Unsupported rollback token schema: ${token?.schema ?? '<missing>'}`);
  }
  const expected = `rollback-token:sha256:${sha256(stableStringify(rollbackTokenCore(token)))}`;
  if (token.tokenId !== expected) throw new Error('Rollback token integrity check failed');
}

function mergeReceiptCore(receipt) {
  return {
    schema: receipt.schema,
    runId: receipt.runId,
    planId: receipt.planId,
    sourceStateRef: receipt.sourceStateRef,
    resultingStateRef: receipt.resultingStateRef,
    rollbackRef: receipt.rollbackRef,
    status: receipt.status,
    accepted: receipt.accepted,
    rejected: receipt.rejected,
    heldConflicts: receipt.heldConflicts,
    conflicts: receipt.conflicts,
    unresolved: receipt.unresolved,
    appliedOperations: receipt.appliedOperations,
    sourceStateHash: receipt.sourceStateHash,
    resultingStateHash: receipt.resultingStateHash,
    committedAt: receipt.committedAt
  };
}

function rollbackTokenCore(token) {
  const core = {
    schema: token.schema,
    runId: token.runId,
    planId: token.planId,
    sourceStateRef: token.sourceStateRef,
    resultingStateRef: token.resultingStateRef,
    rollbackRef: token.rollbackRef,
    sourceStateHash: token.sourceStateHash,
    resultingStateHash: token.resultingStateHash,
    snapshot: token.snapshot
  };
  if (token.mergeReceiptId != null) core.mergeReceiptId = token.mergeReceiptId;
  return core;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Cannot canonicalize non-JSON value');
}
