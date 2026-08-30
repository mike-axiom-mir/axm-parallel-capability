import { createMergePlan, commitMerge, hashState } from './merge.js';

const CLONE_CANDIDATE_SCHEMA = 'axm.parallel-capability-clone-candidate/v0.3';
const INTEGRATION_RECEIPT_SCHEMA = 'axm.parallel-capability-integration-receipt/v0.3';
const BODY_PLAN_SCHEMA = 'axm.parallel-capability-body-plan/v0.3';
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export async function runCloneCandidate({
  id,
  laneId = null,
  taskId = null,
  state,
  stateRef,
  authority = ['WRITE-SANDBOX'],
  evidenceRefs = [],
  tests = [],
  work,
  now = () => new Date().toISOString()
}) {
  if (!id) throw new TypeError('clone candidate id is required');
  if (!stateRef) throw new TypeError('stateRef is required');
  if (typeof work !== 'function') throw new TypeError('work(context) is required');
  assertAddressableRoot(state, 'state');
  assertTestContracts(tests);

  const sourceState = cloneJson(state);
  const workingState = cloneJson(state);
  const sourceStateHash = hashState(sourceState);
  const startedAt = now();
  let workResult = {};
  const failures = [];

  try {
    const returned = await work(Object.freeze({
      id: String(id),
      laneId: laneId == null ? null : String(laneId),
      taskId: taskId == null ? null : String(taskId),
      state: workingState,
      sourceState: cloneJson(sourceState),
      stateRef: String(stateRef),
      sourceStateHash
    }));
    if (returned != null) {
      if (typeof returned !== 'object' || Array.isArray(returned)) {
        throw new TypeError('clone work result must be an object when supplied');
      }
      workResult = returned;
      for (const failure of returned.failures ?? []) failures.push(String(failure));
    }
  } catch (error) {
    failures.push(serializeError(error));
  }

  assertAddressableRoot(workingState, 'clone state');
  const testResults = await runTests(tests, {
    state: workingState,
    sourceState,
    stateRef: String(stateRef),
    sourceStateHash,
    workResult
  });
  const changes = diffJsonState(sourceState, workingState);
  const cloneStateHash = hashState(workingState);
  const status = failures.length > 0
    ? 'FAILED'
    : (testResults.every((test) => test.passed) ? 'COMPLETED' : 'TEST_FAIL');

  return {
    schema: CLONE_CANDIDATE_SCHEMA,
    id: String(id),
    laneId: laneId == null ? null : String(laneId),
    taskId: taskId == null ? null : String(taskId),
    stateRef: String(stateRef),
    sourceStateHash,
    cloneStateHash,
    status,
    authority: normalizeStringList(authority),
    evidenceRefs: normalizeStringList([...(evidenceRefs ?? []), ...(workResult.evidenceRefs ?? [])]),
    testResults,
    failures,
    assumptions: cloneJson(workResult.assumptions ?? []),
    unknowns: cloneJson(workResult.unknowns ?? []),
    contradictions: cloneJson(workResult.contradictions ?? []),
    changes,
    metadata: cloneJson(workResult.metadata ?? {}),
    startedAt,
    completedAt: now()
  };
}

export function diffJsonState(before, after) {
  assertAddressableRoot(before, 'before');
  assertAddressableRoot(after, 'after');
  const changes = [];
  diffObject(before, after, '', changes);
  return changes.sort((a, b) => `${a.path}:${a.op}`.localeCompare(`${b.path}:${b.op}`));
}

export async function buildIntegrationClone({
  integrationId,
  runId,
  state,
  stateRef,
  rollbackRef,
  candidates,
  requirements = {},
  conflictPolicy = 'hold-run',
  tests = [],
  evidenceRefs = [],
  authority = ['COMMIT-CANDIDATE'],
  now = () => new Date().toISOString()
}) {
  if (!integrationId) throw new TypeError('integrationId is required');
  if (!runId) throw new TypeError('runId is required');
  if (!rollbackRef) throw new TypeError('rollbackRef is required');
  assertAddressableRoot(state, 'state');
  assertTestContracts(tests);

  const sourceState = cloneJson(state);
  const sourceStateHash = hashState(sourceState);
  const sourceHashPredicate = {
    id: 'clone-source-state-hash',
    test: (candidate) => candidate?.sourceStateHash === sourceStateHash
  };
  const plan = createMergePlan({
    runId: String(runId),
    stateRef: String(stateRef),
    rollbackRef: String(rollbackRef),
    candidates,
    requirements,
    conflictPolicy,
    predicates: [sourceHashPredicate],
    now
  });

  if (!plan.commitAllowed) {
    return {
      state: cloneJson(sourceState),
      stateRef: String(stateRef),
      candidate: null,
      plan,
      rollbackToken: null,
      receipt: {
        schema: INTEGRATION_RECEIPT_SCHEMA,
        integrationId: String(integrationId),
        runId: String(runId),
        sourceStateRef: String(stateRef),
        sourceStateHash,
        status: 'HELD_MERGE_PLAN',
        planId: plan.planId,
        accepted: decisionIds(plan, 'ACCEPTED'),
        rejected: decisionIds(plan, 'REJECTED_PREDICATE'),
        heldConflicts: decisionIds(plan, 'HELD_CONFLICT'),
        conflicts: cloneJson(plan.conflicts),
        unresolved: cloneJson(plan.unresolved),
        testResults: [],
        completedAt: now()
      }
    };
  }

  const merged = commitMerge({
    state: sourceState,
    currentStateRef: String(stateRef),
    plan,
    resultingStateRef: null,
    now
  });
  const testResults = await runTests(tests, {
    state: merged.state,
    sourceState,
    stateRef: merged.stateRef,
    sourceStateHash,
    mergeReceipt: merged.receipt,
    plan
  });
  const integrationStatus = testResults.every((test) => test.passed)
    ? 'VALID_IN_HARNESS'
    : 'TEST_FAIL';
  const integrationChanges = diffJsonState(sourceState, merged.state);
  const integrationCandidate = {
    schema: CLONE_CANDIDATE_SCHEMA,
    id: String(integrationId),
    laneId: 'integration-clone',
    taskId: String(runId),
    stateRef: String(stateRef),
    sourceStateHash,
    cloneStateHash: hashState(merged.state),
    status: integrationStatus,
    authority: normalizeStringList(authority),
    evidenceRefs: normalizeStringList([...(evidenceRefs ?? []), plan.planId]),
    testResults,
    failures: [],
    assumptions: [],
    unknowns: [],
    contradictions: cloneJson(plan.unresolved),
    changes: integrationChanges,
    metadata: {
      integration: true,
      sourceCandidates: plan.decisions.map((decision) => ({ id: decision.id, status: decision.status })),
      mergePlanId: plan.planId,
      intermediateStateRef: merged.stateRef
    },
    startedAt: plan.createdAt,
    completedAt: now()
  };

  return {
    state: cloneJson(merged.state),
    stateRef: merged.stateRef,
    candidate: integrationCandidate,
    plan,
    rollbackToken: cloneJson(merged.rollbackToken),
    receipt: {
      schema: INTEGRATION_RECEIPT_SCHEMA,
      integrationId: String(integrationId),
      runId: String(runId),
      sourceStateRef: String(stateRef),
      sourceStateHash,
      resultingStateRef: merged.stateRef,
      resultingStateHash: hashState(merged.state),
      status: integrationStatus,
      planId: plan.planId,
      accepted: decisionIds(plan, 'ACCEPTED'),
      rejected: decisionIds(plan, 'REJECTED_PREDICATE'),
      heldConflicts: decisionIds(plan, 'HELD_CONFLICT'),
      conflicts: cloneJson(plan.conflicts),
      unresolved: cloneJson(plan.unresolved),
      testResults: cloneJson(testResults),
      mergeReceipt: cloneJson(merged.receipt),
      completedAt: now()
    }
  };
}

export function createBodyCommitPlan({
  runId,
  state,
  stateRef,
  rollbackRef,
  candidates,
  requirements = {},
  conflictPolicy = 'hold-run',
  predicates = [],
  now = () => new Date().toISOString()
}) {
  assertAddressableRoot(state, 'state');
  const sourceStateHash = hashState(state);
  const sourceHashPredicate = {
    id: 'body-source-state-hash',
    test: (candidate) => candidate?.sourceStateHash === sourceStateHash
  };
  const plan = createMergePlan({
    runId,
    stateRef,
    rollbackRef,
    candidates,
    requirements,
    conflictPolicy,
    predicates: [sourceHashPredicate, ...predicates],
    now
  });
  return {
    schema: BODY_PLAN_SCHEMA,
    sourceStateRef: String(stateRef),
    sourceStateHash,
    mergePlan: plan
  };
}

function diffObject(before, after, prefix, changes) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    assertPathKey(key, prefix ? `${prefix}.${key}` : key);
    const path = prefix ? `${prefix}.${key}` : key;
    const beforeExists = Object.hasOwn(before, key);
    const afterExists = Object.hasOwn(after, key);

    if (!afterExists) {
      changes.push({
        path,
        op: 'delete',
        precondition: { exists: true, value: cloneJson(before[key]) }
      });
      continue;
    }
    if (!beforeExists) {
      changes.push({
        path,
        op: 'set',
        value: cloneJson(after[key]),
        precondition: { exists: false }
      });
      continue;
    }
    if (sameJson(before[key], after[key])) continue;

    if (isPlainObject(before[key]) && isPlainObject(after[key])) {
      diffObject(before[key], after[key], path, changes);
      continue;
    }

    changes.push({
      path,
      op: 'set',
      value: cloneJson(after[key]),
      precondition: { exists: true, value: cloneJson(before[key]) }
    });
  }
}

async function runTests(tests, context) {
  const results = [];
  for (const test of tests) {
    try {
      const passed = Boolean(await test.test(Object.freeze({
        ...context,
        state: cloneJson(context.state),
        sourceState: cloneJson(context.sourceState)
      })));
      results.push({ id: String(test.id), passed, error: null });
    } catch (error) {
      results.push({ id: String(test.id), passed: false, error: serializeError(error) });
    }
  }
  return results;
}

function assertTestContracts(tests) {
  if (!Array.isArray(tests)) throw new TypeError('tests must be an array');
  for (const test of tests) {
    if (!test?.id || typeof test.test !== 'function') {
      throw new TypeError('Each test requires id and test(context)');
    }
  }
}

function decisionIds(plan, status) {
  return plan.decisions.filter((decision) => decision.status === status).map((decision) => decision.id);
}

function assertAddressableRoot(value, label) {
  hashState(value);
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object root`);
  assertAddressableObject(value, label);
}

function assertAddressableObject(value, label) {
  for (const [key, item] of Object.entries(value)) {
    assertPathKey(key, `${label}.${key}`);
    if (isPlainObject(item)) assertAddressableObject(item, `${label}.${key}`);
  }
}

function assertPathKey(key, label) {
  if (!key) throw new TypeError(`${label} contains an empty key`);
  if (key.includes('.')) throw new TypeError(`${label} contains a dot and cannot be represented by the v0.3 path grammar`);
  if (BLOCKED_PATH_SEGMENTS.has(key)) throw new TypeError(`${label} contains blocked key ${key}`);
}

function normalizeStringList(values) {
  return [...new Set((values ?? []).map(String))].sort();
}

function sameJson(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Cannot canonicalize non-JSON value');
}

function cloneJson(value) {
  hashState(value);
  return structuredClone(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
