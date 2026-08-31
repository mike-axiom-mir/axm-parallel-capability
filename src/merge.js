import { createHash } from 'node:crypto';

const MERGE_PLAN_SCHEMA = 'axm.parallel-capability-merge-plan/v0.2';
const MERGE_RECEIPT_SCHEMA = 'axm.parallel-capability-merge-receipt/v0.2';
const ROLLBACK_TOKEN_SCHEMA = 'axm.parallel-capability-rollback-token/v0.2';
const ROLLBACK_RECEIPT_SCHEMA = 'axm.parallel-capability-rollback-receipt/v0.2';
const DEFAULT_MERGE_AUTHORITY = 'COMMIT-CANDIDATE';
const DEFAULT_MERGEABLE_STATUSES = Object.freeze([
  'COMPLETED',
  'SELECTED',
  'MEASURED',
  'VALID_IN_HARNESS',
  'SOURCE_SUPPORTED'
]);
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function createMergePlan({
  runId,
  stateRef,
  rollbackRef,
  candidates,
  requirements = {},
  conflictPolicy = 'hold-run',
  predicates = [],
  now = () => new Date().toISOString()
}) {
  if (!runId) throw new TypeError('runId is required');
  if (!stateRef) throw new TypeError('stateRef is required');
  if (!rollbackRef) throw new TypeError('rollbackRef is required');
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError('candidates must be a non-empty array');
  }
  if (!['hold-run', 'merge-nonconflicting'].includes(conflictPolicy)) {
    throw new TypeError(`Unsupported conflictPolicy: ${conflictPolicy}`);
  }
  for (const predicate of predicates) {
    if (!predicate?.id || typeof predicate.test !== 'function') {
      throw new TypeError('Each custom predicate requires id and test(candidate)');
    }
  }

  const policy = normalizeRequirements(requirements);
  const normalized = normalizeCandidates(candidates);
  const evaluations = normalized.map((candidate) => evaluateCandidate({
    candidate,
    stateRef: String(stateRef),
    policy,
    predicates
  }));

  const eligible = evaluations.filter((item) => item.accepted).map((item) => item.candidate);
  const conflicts = detectMergeConflicts(eligible);
  const conflictedIds = new Set(conflicts.flatMap((conflict) => conflict.candidates.map((item) => item.id)));

  const decisions = evaluations.map((evaluation) => {
    if (!evaluation.accepted) {
      return {
        id: evaluation.candidate.id,
        status: 'REJECTED_PREDICATE',
        tests: evaluation.tests
      };
    }
    if (conflictedIds.has(evaluation.candidate.id)) {
      return {
        id: evaluation.candidate.id,
        status: 'HELD_CONFLICT',
        tests: evaluation.tests
      };
    }
    return {
      id: evaluation.candidate.id,
      status: 'ACCEPTED',
      tests: evaluation.tests
    };
  });

  const acceptedIds = decisions.filter((item) => item.status === 'ACCEPTED').map((item) => item.id);
  const acceptedSet = new Set(acceptedIds);
  const operations = collectOperations(normalized.filter((candidate) => acceptedSet.has(candidate.id)));
  const unresolved = conflicts.map((conflict) => ({
    type: conflict.type,
    pathA: conflict.pathA,
    pathB: conflict.pathB,
    candidates: conflict.candidates.map((candidate) => candidate.id)
  }));

  const hasConflicts = conflicts.length > 0;
  const commitAllowed = operations.length > 0 && (!hasConflicts || conflictPolicy === 'merge-nonconflicting');
  const status = planStatus({ operations, hasConflicts, conflictPolicy, decisions });
  const planCore = {
    schema: MERGE_PLAN_SCHEMA,
    runId: String(runId),
    stateRef: String(stateRef),
    rollbackRef: String(rollbackRef),
    conflictPolicy,
    requirements: policy,
    decisions,
    operations,
    conflicts,
    unresolved,
    commitAllowed,
    status
  };
  const planId = `merge-plan:sha256:${sha256(stableStringify(planCore))}`;

  return {
    ...planCore,
    planId,
    createdAt: now()
  };
}

export function commitMerge({
  state,
  currentStateRef,
  plan,
  resultingStateRef = null,
  now = () => new Date().toISOString()
}) {
  assertMergePlan(plan);
  assertJsonValue(state, 'state');
  if (currentStateRef !== plan.stateRef) {
    throw new Error(`Stale merge plan: currentStateRef ${currentStateRef} !== plan stateRef ${plan.stateRef}`);
  }
  if (!plan.commitAllowed) {
    throw new Error(`Merge plan is not commit-eligible: ${plan.status}`);
  }

  const beforeState = cloneJson(state);
  const working = cloneJson(state);
  const beforeStateHash = hashState(beforeState);
  const appliedOperations = [];

  for (const operation of plan.operations) {
    applyOperation(working, operation);
    appliedOperations.push(cloneJson(operation));
  }

  const afterStateHash = hashState(working);
  const finalStateRef = resultingStateRef == null ? `sha256:${afterStateHash}` : String(resultingStateRef);
  const committedAt = now();
  const rollbackToken = {
    schema: ROLLBACK_TOKEN_SCHEMA,
    runId: plan.runId,
    planId: plan.planId,
    sourceStateRef: plan.stateRef,
    resultingStateRef: finalStateRef,
    rollbackRef: plan.rollbackRef,
    sourceStateHash: beforeStateHash,
    resultingStateHash: afterStateHash,
    snapshot: beforeState,
    createdAt: committedAt
  };

  return {
    state: working,
    stateRef: finalStateRef,
    receipt: {
      schema: MERGE_RECEIPT_SCHEMA,
      runId: plan.runId,
      planId: plan.planId,
      sourceStateRef: plan.stateRef,
      resultingStateRef: finalStateRef,
      rollbackRef: plan.rollbackRef,
      status: 'COMMITTED',
      accepted: plan.decisions.filter((item) => item.status === 'ACCEPTED').map((item) => item.id),
      rejected: plan.decisions.filter((item) => item.status === 'REJECTED_PREDICATE').map((item) => item.id),
      heldConflicts: plan.decisions.filter((item) => item.status === 'HELD_CONFLICT').map((item) => item.id),
      conflicts: cloneJson(plan.conflicts),
      unresolved: cloneJson(plan.unresolved),
      appliedOperations,
      sourceStateHash: beforeStateHash,
      resultingStateHash: afterStateHash,
      committedAt
    },
    rollbackToken
  };
}

export function rollbackMerge({
  state,
  currentStateRef,
  rollbackToken,
  now = () => new Date().toISOString()
}) {
  assertJsonValue(state, 'state');
  if (!rollbackToken || rollbackToken.schema !== ROLLBACK_TOKEN_SCHEMA) {
    throw new Error(`Unsupported rollback token schema: ${rollbackToken?.schema ?? '<missing>'}`);
  }
  if (currentStateRef !== rollbackToken.resultingStateRef) {
    throw new Error(`Rollback stateRef mismatch: ${currentStateRef} !== ${rollbackToken.resultingStateRef}`);
  }
  const currentHash = hashState(state);
  if (currentHash !== rollbackToken.resultingStateHash) {
    throw new Error('Rollback refused: current state content no longer matches committed result');
  }
  assertJsonValue(rollbackToken.snapshot, 'rollbackToken.snapshot');
  const restored = cloneJson(rollbackToken.snapshot);
  const restoredHash = hashState(restored);
  if (restoredHash !== rollbackToken.sourceStateHash) {
    throw new Error('Rollback token snapshot hash mismatch');
  }

  return {
    state: restored,
    stateRef: rollbackToken.sourceStateRef,
    receipt: {
      schema: ROLLBACK_RECEIPT_SCHEMA,
      runId: rollbackToken.runId,
      planId: rollbackToken.planId,
      fromStateRef: rollbackToken.resultingStateRef,
      restoredStateRef: rollbackToken.sourceStateRef,
      rollbackRef: rollbackToken.rollbackRef,
      fromStateHash: currentHash,
      restoredStateHash: restoredHash,
      status: 'ROLLED_BACK',
      completedAt: now()
    }
  };
}

export function detectMergeConflicts(candidates) {
  const normalized = normalizeCandidates(candidates ?? []);
  const operations = normalized.flatMap((candidate) => candidate.changes.map((change) => ({
    id: candidate.id,
    laneId: candidate.laneId,
    taskId: candidate.taskId,
    change
  })));
  const conflicts = [];

  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const left = operations[leftIndex];
      const right = operations[rightIndex];
      if (!pathsOverlap(left.change.path, right.change.path)) continue;
      if (changesAreIdentical(left.change, right.change)) continue;
      conflicts.push({
        type: left.id === right.id ? 'INTRA_CANDIDATE_CONFLICT' : 'CANDIDATE_PATH_CONFLICT',
        pathA: left.change.path,
        pathB: right.change.path,
        candidates: [
          { id: left.id, laneId: left.laneId, taskId: left.taskId, change: cloneJson(left.change) },
          { id: right.id, laneId: right.laneId, taskId: right.taskId, change: cloneJson(right.change) }
        ].sort((a, b) => `${a.id}:${a.change.path}`.localeCompare(`${b.id}:${b.change.path}`))
      });
    }
  }

  return conflicts.sort((a, b) =>
    `${a.pathA}:${a.pathB}:${a.candidates.map((item) => item.id).join(':')}`
      .localeCompare(`${b.pathA}:${b.pathB}:${b.candidates.map((item) => item.id).join(':')}`)
  );
}

export function hashState(state) {
  assertJsonValue(state, 'state');
  return sha256(stableStringify(state));
}

function evaluateCandidate({ candidate, stateRef, policy, predicates }) {
  const tests = [
    predicateResult('state-version', candidate.stateRef === stateRef,
      candidate.stateRef === stateRef ? null : `${candidate.stateRef ?? '<missing>'} !== ${stateRef}`),
    predicateResult('status-mergeable',
      candidate.status == null || policy.mergeableStatuses.includes(candidate.status),
      candidate.status == null || policy.mergeableStatuses.includes(candidate.status) ? null : `status ${candidate.status} is not mergeable`),
    predicateResult('no-failures', candidate.failures.length === 0,
      candidate.failures.length === 0 ? null : `${candidate.failures.length} failure(s) reported`),
    predicateResult('authority',
      !policy.requireAuthority || candidate.authority.includes(policy.authority),
      !policy.requireAuthority || candidate.authority.includes(policy.authority) ? null : `missing ${policy.authority}`),
    predicateResult('evidence',
      !policy.requireEvidence || candidate.evidenceRefs.length > 0,
      !policy.requireEvidence || candidate.evidenceRefs.length > 0 ? null : 'no evidenceRefs supplied'),
    predicateResult('tests',
      !policy.requireTests || (candidate.testResults.length > 0 && candidate.testResults.every((test) => test?.passed === true)),
      !policy.requireTests || (candidate.testResults.length > 0 && candidate.testResults.every((test) => test?.passed === true))
        ? null
        : 'required tests are missing or not all passed'),
    predicateResult('changes', candidate.changes.length > 0,
      candidate.changes.length > 0 ? null : 'candidate has no proposed changes')
  ];

  for (const predicate of predicates) {
    try {
      const passed = Boolean(predicate.test(candidate.raw));
      tests.push(predicateResult(predicate.id, passed, passed ? null : 'custom predicate returned false'));
    } catch (error) {
      tests.push(predicateResult(predicate.id, false, serializeError(error)));
    }
  }

  return { candidate, tests, accepted: tests.every((test) => test.passed) };
}

function predicateResult(id, passed, detail) {
  return { id, passed: Boolean(passed), detail };
}

function normalizeRequirements(requirements) {
  const mergeableStatuses = [...(requirements.mergeableStatuses ?? DEFAULT_MERGEABLE_STATUSES)].map(String);
  return {
    requireAuthority: requirements.requireAuthority ?? true,
    authority: String(requirements.authority ?? DEFAULT_MERGE_AUTHORITY),
    requireEvidence: requirements.requireEvidence ?? true,
    requireTests: requirements.requireTests ?? true,
    mergeableStatuses: [...new Set(mergeableStatuses)].sort()
  };
}

function normalizeCandidates(candidates) {
  const seen = new Set();
  return [...candidates].map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`candidates[${index}] must be an object`);
    }
    const fallbackId = [candidate.laneId, candidate.taskId].filter(Boolean).join(':');
    const id = String(candidate.id ?? fallbackId ?? '');
    if (!id) throw new TypeError(`candidates[${index}] requires id or laneId/taskId`);
    if (seen.has(id)) throw new Error(`Duplicate candidate id: ${id}`);
    seen.add(id);
    const changes = cloneJson(candidate.changes ?? candidate.proposedChanges ?? []);
    if (!Array.isArray(changes)) throw new TypeError(`candidate ${id} changes must be an array`);
    const normalizedChanges = changes.map((change, changeIndex) => normalizeChange(change, `${id}.changes[${changeIndex}]`));
    return {
      id,
      laneId: candidate.laneId == null ? null : String(candidate.laneId),
      taskId: candidate.taskId == null ? null : String(candidate.taskId),
      stateRef: candidate.stateRef == null ? null : String(candidate.stateRef),
      status: candidate.status == null ? null : String(candidate.status),
      authority: [...(candidate.authority ?? candidate.authorityUsed ?? [])].map(String),
      evidenceRefs: cloneJson(candidate.evidenceRefs ?? []),
      testResults: cloneJson(candidate.testResults ?? []),
      failures: cloneJson(candidate.failures ?? []),
      changes: normalizedChanges,
      raw: candidate
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeChange(change, label) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    throw new TypeError(`${label} must be an object`);
  }
  const op = String(change.op ?? '');
  if (!['set', 'delete'].includes(op)) throw new TypeError(`${label}.op must be set or delete`);
  const path = normalizePath(change.path, `${label}.path`);
  const normalized = { path, op };
  if (op === 'set') {
    if (!Object.hasOwn(change, 'value')) throw new TypeError(`${label}.value is required for set`);
    assertJsonValue(change.value, `${label}.value`);
    normalized.value = cloneJson(change.value);
  }
  if (change.precondition != null) {
    normalized.precondition = normalizePrecondition(change.precondition, `${label}.precondition`);
  }
  return normalized;
}

function normalizePrecondition(precondition, label) {
  if (!precondition || typeof precondition !== 'object' || Array.isArray(precondition)) {
    throw new TypeError(`${label} must be an object`);
  }
  const normalized = {};
  if (Object.hasOwn(precondition, 'exists')) normalized.exists = Boolean(precondition.exists);
  if (Object.hasOwn(precondition, 'value')) {
    assertJsonValue(precondition.value, `${label}.value`);
    normalized.value = cloneJson(precondition.value);
  }
  if (!Object.hasOwn(normalized, 'exists') && !Object.hasOwn(normalized, 'value')) {
    throw new TypeError(`${label} must declare exists and/or value`);
  }
  return normalized;
}

function normalizePath(path, label) {
  if (typeof path !== 'string' || path.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  const segments = path.split('.');
  for (const segment of segments) {
    if (!segment) throw new TypeError(`${label} contains an empty segment`);
    if (BLOCKED_PATH_SEGMENTS.has(segment)) throw new TypeError(`${label} contains blocked segment ${segment}`);
  }
  return segments.join('.');
}

function collectOperations(candidates) {
  const bySignature = new Map();
  for (const candidate of candidates) {
    for (const change of candidate.changes) {
      const signature = stableStringify(change);
      const existing = bySignature.get(signature);
      const source = { id: candidate.id, laneId: candidate.laneId, taskId: candidate.taskId };
      if (existing) {
        existing.sources.push(source);
        continue;
      }
      bySignature.set(signature, { ...cloneJson(change), sources: [source] });
    }
  }
  return [...bySignature.values()]
    .map((operation) => ({
      ...operation,
      sources: operation.sources.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    }))
    .sort((a, b) => `${a.path}:${a.op}:${stableStringify(a.value ?? null)}`
      .localeCompare(`${b.path}:${b.op}:${stableStringify(b.value ?? null)}`));
}

function planStatus({ operations, hasConflicts, conflictPolicy, decisions }) {
  if (operations.length === 0) return hasConflicts ? 'HOLD_CONFLICTS' : 'NO_ELIGIBLE_CANDIDATES';
  if (hasConflicts && conflictPolicy === 'hold-run') return 'HOLD_CONFLICTS';
  if (hasConflicts) return 'PARTIAL_READY';
  if (decisions.some((item) => item.status === 'REJECTED_PREDICATE')) return 'READY_WITH_REJECTIONS';
  return 'READY';
}

function applyOperation(state, operation) {
  const info = getPathInfo(state, operation.path);
  assertPrecondition(info, operation);
  if (!info.parentExists || !isPlainObject(info.parent)) {
    throw new Error(`Cannot apply ${operation.op} ${operation.path}: parent path does not resolve to an object`);
  }
  if (operation.op === 'set') {
    info.parent[info.key] = cloneJson(operation.value);
    return;
  }
  if (!info.exists) throw new Error(`Cannot delete ${operation.path}: target does not exist`);
  delete info.parent[info.key];
}

function assertPrecondition(info, operation) {
  const precondition = operation.precondition;
  if (!precondition) return;
  if (Object.hasOwn(precondition, 'exists') && info.exists !== precondition.exists) {
    throw new Error(`Precondition failed for ${operation.path}: exists=${info.exists}, expected ${precondition.exists}`);
  }
  if (Object.hasOwn(precondition, 'value')) {
    if (!info.exists || stableStringify(info.value) !== stableStringify(precondition.value)) {
      throw new Error(`Precondition failed for ${operation.path}: value mismatch`);
    }
  }
}

function getPathInfo(root, path) {
  const segments = path.split('.');
  let parent = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!isPlainObject(parent)) {
      return { parent: null, key: segments.at(-1), exists: false, value: undefined, parentExists: false };
    }
    const segment = segments[index];
    if (!Object.hasOwn(parent, segment)) {
      return { parent: null, key: segments.at(-1), exists: false, value: undefined, parentExists: false };
    }
    parent = parent[segment];
  }
  const key = segments.at(-1);
  if (!isPlainObject(parent)) {
    return { parent, key, exists: false, value: undefined, parentExists: false };
  }
  const exists = Object.hasOwn(parent, key);
  return { parent, key, exists, value: exists ? parent[key] : undefined, parentExists: true };
}

function pathsOverlap(a, b) {
  const left = a.split('.');
  const right = b.split('.');
  const minimum = Math.min(left.length, right.length);
  for (let index = 0; index < minimum; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function changesAreIdentical(a, b) {
  return a.path === b.path && stableStringify(a) === stableStringify(b);
}

function assertMergePlan(plan) {
  if (!plan || plan.schema !== MERGE_PLAN_SCHEMA) {
    throw new Error(`Unsupported merge plan schema: ${plan?.schema ?? '<missing>'}`);
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function cloneJson(value) {
  assertJsonValue(value, 'value');
  return structuredClone(value);
}

function assertJsonValue(value, label) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (BLOCKED_PATH_SEGMENTS.has(key)) throw new TypeError(`${label} contains blocked key ${key}`);
      assertJsonValue(item, `${label}.${key}`);
    }
    return;
  }
  throw new TypeError(`${label} must be JSON-compatible`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Cannot canonicalize non-JSON value');
}

function serializeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
