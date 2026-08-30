import { createHash } from 'node:crypto';
import {
  commitMerge as commitMergeEngine,
  rollbackMerge as rollbackMergeEngine
} from './merge.js';

const MERGE_PLAN_SCHEMA = 'axm.parallel-capability-merge-plan/v0.2';
const ROLLBACK_TOKEN_SCHEMA = 'axm.parallel-capability-rollback-token/v0.2';

export function commitMerge(args) {
  assertPlanIntegrity(args?.plan);
  const result = commitMergeEngine(args);
  const core = rollbackTokenCore(result.rollbackToken);
  result.rollbackToken.tokenId = `rollback-token:sha256:${sha256(stableStringify(core))}`;
  return result;
}

export function rollbackMerge(args) {
  assertRollbackIntegrity(args?.rollbackToken);
  return rollbackMergeEngine(args);
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

function assertRollbackIntegrity(token) {
  if (!token || token.schema !== ROLLBACK_TOKEN_SCHEMA) {
    throw new Error(`Unsupported rollback token schema: ${token?.schema ?? '<missing>'}`);
  }
  const expected = `rollback-token:sha256:${sha256(stableStringify(rollbackTokenCore(token)))}`;
  if (token.tokenId !== expected) throw new Error('Rollback token integrity check failed');
}

function rollbackTokenCore(token) {
  return {
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
