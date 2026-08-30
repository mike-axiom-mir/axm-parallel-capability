import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitMerge,
  createDecompositionPlan,
  runDecomposedCreation
} from '../src/index.js';

function baseState() {
  return {
    config: { cacheMB: 64, mode: 'safe' },
    metrics: { runtimeMs: 20, analysisSeen: false },
    notes: { text: '' }
  };
}

const PASS = { id: 'domain-pass', test: () => true };
const AUTHORITIES = ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'];

function capability(id, {
  provides = [id],
  dependsOn = [],
  targetAreas = ['config'],
  pressure = id,
  priority = 0,
  resources = { workers: 1 },
  authority = AUTHORITIES,
  evidenceRefs = [`evidence:${id}`],
  tests = [PASS],
  work = () => ({})
} = {}) {
  return {
    id,
    executorRef: `executor:${id}/v1`,
    role: id,
    pressure,
    provides,
    dependsOn,
    targetAreas,
    authority,
    resources,
    evidenceRefs,
    tests,
    priority,
    work
  };
}

function bodyFor(capabilities, areaOverrides = {}) {
  const ids = capabilities.map((item) => item.id);
  return {
    id: 'body-map:test',
    areas: [
      {
        id: 'config',
        path: 'config',
        allowedCapabilities: ids,
        authorities: AUTHORITIES,
        ...(areaOverrides.config ?? {})
      },
      {
        id: 'metrics',
        path: 'metrics',
        allowedCapabilities: ids,
        authorities: AUTHORITIES,
        ...(areaOverrides.metrics ?? {})
      },
      {
        id: 'notes',
        path: 'notes',
        allowedCapabilities: ids,
        authorities: AUTHORITIES,
        ...(areaOverrides.notes ?? {})
      }
    ]
  };
}

function goal(requirements, overrides = {}) {
  return {
    id: overrides.id ?? 'goal:test',
    summary: overrides.summary ?? 'deterministic test goal',
    requirements: requirements.map((token) => ({ id: token, token })),
    exploration: overrides.exploration ?? [],
    integrationTests: overrides.integrationTests ?? [{ id: 'integration-pass', test: () => true }]
  };
}

function input(capabilities, goalSpec, overrides = {}) {
  return {
    runId: overrides.runId ?? 'decompose-run',
    state: overrides.state ?? baseState(),
    stateRef: overrides.stateRef ?? 'body:v1',
    rollbackRef: overrides.rollbackRef ?? 'body:v0',
    goal: goalSpec,
    bodyMap: overrides.bodyMap ?? bodyFor(capabilities),
    capabilities,
    constraints: {
      resourceBudget: { limits: { workers: 3 } },
      ...(overrides.constraints ?? {})
    }
  };
}

test('decomposition plan is deterministic across capability and body-area input order', () => {
  const caps = [
    capability('alpha', { provides: ['performance'], priority: 5 }),
    capability('beta', { provides: ['safety'], priority: 4 })
  ];
  const body = bodyFor(caps);
  const first = createDecompositionPlan(input(caps, goal(['performance', 'safety']), { bodyMap: body }));
  const second = createDecompositionPlan(input([...caps].reverse(), goal(['safety', 'performance']), {
    bodyMap: { ...body, areas: [...body.areas].reverse() }
  }));

  assert.equal(first.status, 'READY');
  assert.equal(second.status, 'READY');
  assert.equal(first.planId, second.planId);
  assert.deepEqual(first.selectedCapabilities.map((item) => item.id), second.selectedCapabilities.map((item) => item.id));
});

test('greedy coverage selects one capability that covers two uncovered requirements', () => {
  const caps = [
    capability('combo', { provides: ['performance', 'safety'], priority: 0 }),
    capability('performance-only', { provides: ['performance'], priority: 10 }),
    capability('safety-only', { provides: ['safety'], priority: 10 })
  ];
  const plan = createDecompositionPlan(input(caps, goal(['performance', 'safety'])));
  assert.equal(plan.status, 'READY');
  assert.deepEqual(plan.selectedCapabilities.map((item) => item.id), ['combo']);
});

test('explicit exploration adds a different solution pressure without replacing required coverage', () => {
  const caps = [
    capability('conservative', { provides: ['performance'], pressure: 'conservative', priority: 5 }),
    capability('aggressive', { provides: ['performance'], pressure: 'aggressive', priority: 4 }),
    capability('same-pressure', { provides: ['performance'], pressure: 'conservative', priority: 3 })
  ];
  const plan = createDecompositionPlan(input(caps, goal(['performance'], {
    exploration: [{ token: 'performance', extraProviders: 1, distinctPressure: true }]
  })));
  assert.equal(plan.status, 'READY');
  assert.deepEqual(plan.selectedCapabilities.map((item) => item.id), ['conservative', 'aggressive']);
  assert.equal(plan.selectedCapabilities[1].reason.type, 'EXPLORATION_DIVERSITY');
});

test('dependency closure creates a topological creation graph and passes dependency candidate receipts', async () => {
  const caps = [
    capability('analyzer', {
      provides: ['analysis'],
      targetAreas: ['metrics'],
      priority: 1,
      work: () => ({ metadata: { recommendation: 128 } })
    }),
    capability('builder', {
      provides: ['implementation'],
      dependsOn: ['analyzer'],
      targetAreas: ['config'],
      priority: 5,
      work: ({ state, dependencyCandidates }) => {
        state.config.cacheMB = dependencyCandidates.analyzer.metadata.recommendation;
      }
    })
  ];
  const result = await runDecomposedCreation(input(caps, goal(['implementation'], {
    integrationTests: [{ id: 'cache-target', test: ({ state }) => state.config.cacheMB === 128 }]
  })));

  assert.equal(result.plan.status, 'READY');
  assert.deepEqual(result.plan.selectedCapabilities.map((item) => item.id), ['analyzer', 'builder']);
  assert.deepEqual(result.plan.creationSpec.candidates.find((item) => item.id === 'builder').dependsOn, ['analyzer']);
  assert.equal(result.creation.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.equal(result.creation.integration.state.config.cacheMB, 128);
});

test('uncovered required token produces a hold before Creation Fabric runs', async () => {
  const caps = [capability('known', { provides: ['known'] })];
  const result = await runDecomposedCreation(input(caps, goal(['unknown'])));
  assert.equal(result.plan.status, 'HOLD_UNRESOLVED');
  assert.equal(result.creation, null);
  assert.deepEqual(result.plan.unresolved, [{ type: 'UNCOVERED_REQUIREMENT', token: 'unknown' }]);
});

test('body authority intersection can make a capability ineligible without widening authority', () => {
  const cap = capability('writer', { provides: ['write'] });
  const body = bodyFor([cap], {
    config: { authorities: ['WRITE-SANDBOX'] }
  });
  const plan = createDecompositionPlan(input([cap], goal(['write']), { bodyMap: body }));
  assert.equal(plan.status, 'HOLD_UNRESOLVED');
  assert.deepEqual(plan.rejectedCapabilities[0], {
    id: 'writer',
    reasons: ['MISSING_COMMIT_CANDIDATE_AUTHORITY']
  });
});

test('undeclared resource class or over-budget capability is rejected before scheduling', () => {
  const cap = capability('heavy', {
    provides: ['heavy'],
    resources: { workers: 1, memoryMB: 512 }
  });
  const plan = createDecompositionPlan(input([cap], goal(['heavy']), {
    constraints: { resourceBudget: { limits: { workers: 2 } } }
  }));
  assert.equal(plan.status, 'HOLD_UNRESOLVED');
  assert.equal(plan.rejectedCapabilities[0].reasons.includes('RESOURCE_BUDGET_EXCEEDED_OR_UNDECLARED'), true);
});

test('generated scope test prevents a capability from surviving when it writes outside its declared body area', async () => {
  const cap = capability('scoped', {
    provides: ['config-change'],
    targetAreas: ['config'],
    work: ({ state }) => {
      state.metrics.runtimeMs = 1;
    }
  });
  const result = await runDecomposedCreation(input([cap], goal(['config-change'])));
  assert.equal(result.plan.status, 'READY');
  assert.equal(result.creation.candidates[0].candidate.status, 'TEST_FAIL');
  assert.equal(result.creation.candidates[0].candidate.testResults.find((item) => item.id === 'decomposition-scope-boundary').passed, false);
  assert.equal(result.creation.status, 'HELD_INTEGRATION');
});

test('dependency cycle is preserved as an unresolved graph instead of reaching the scheduler', async () => {
  const caps = [
    capability('a', { provides: ['target'], dependsOn: ['b'] }),
    capability('b', { provides: ['helper'], dependsOn: ['a'] })
  ];
  const result = await runDecomposedCreation(input(caps, goal(['target'])));
  assert.equal(result.plan.status, 'HOLD_UNRESOLVED');
  assert.equal(result.creation, null);
  assert.equal(result.plan.unresolved.some((item) => item.type === 'DEPENDENCY_CYCLE'), true);
});

test('maxCandidates limit includes dependencies and exploration additions', () => {
  const caps = [
    capability('root', { provides: ['target'], dependsOn: ['helper'], pressure: 'root' }),
    capability('helper', { provides: ['helper'], pressure: 'helper' }),
    capability('alternate', { provides: ['target'], pressure: 'alternate' })
  ];
  const plan = createDecompositionPlan(input(caps, goal(['target'], {
    exploration: [{ token: 'target', extraProviders: 1 }]
  }), {
    constraints: { maxCandidates: 2 }
  }));
  assert.equal(plan.status, 'HOLD_UNRESOLVED');
  assert.equal(plan.unresolved.some((item) => item.type === 'MAX_CANDIDATES_EXCEEDED' && item.selected === 3), true);
});

test('missing integration tests blocks executable decomposition rather than treating no tests as proof', async () => {
  const cap = capability('writer', { provides: ['write'] });
  const result = await runDecomposedCreation(input([cap], goal(['write'], { integrationTests: [] })));
  assert.equal(result.plan.status, 'HOLD_UNRESOLVED');
  assert.equal(result.plan.unresolved.some((item) => item.type === 'MISSING_INTEGRATION_TESTS'), true);
  assert.equal(result.creation, null);
});

test('ready decomposed creation still stops at an explicit protected-body commit gate', async () => {
  const protectedBody = baseState();
  const cap = capability('cache-builder', {
    provides: ['performance'],
    work: ({ state }) => {
      state.config.cacheMB = 128;
    }
  });
  const result = await runDecomposedCreation(input([cap], goal(['performance'], {
    integrationTests: [{ id: 'cache-128', test: ({ state }) => state.config.cacheMB === 128 }]
  }), { state: protectedBody }));

  assert.equal(result.plan.status, 'READY');
  assert.equal(result.creation.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.equal(protectedBody.config.cacheMB, 64);

  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'body:v1',
    plan: result.creation.bodyPlan.mergePlan
  });
  assert.equal(committed.state.config.cacheMB, 128);
  assert.equal(protectedBody.config.cacheMB, 64);
});
