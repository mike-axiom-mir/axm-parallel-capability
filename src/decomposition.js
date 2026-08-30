import { createHash } from 'node:crypto';
import { CreationFabric } from './creation-fabric.js';
import { diffJsonState } from './clone-body.js';

const PLAN_SCHEMA = 'axm.parallel-capability-decomposition-plan/v0.5';
const DEFAULT_ALLOWED_AUTHORITIES = Object.freeze([
  'READ',
  'PROPOSE',
  'WRITE-SANDBOX',
  'COMMIT-CANDIDATE',
  'OBSERVE',
  'EXECUTE-TOOL'
]);
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function createDecompositionPlan({
  runId,
  state,
  stateRef,
  rollbackRef,
  goal,
  bodyMap,
  capabilities,
  constraints = {},
  now = () => new Date().toISOString()
}) {
  if (!runId) throw new TypeError('runId is required');
  if (!stateRef) throw new TypeError('stateRef is required');
  if (!rollbackRef) throw new TypeError('rollbackRef is required');
  diffJsonState(state, state);

  const normalizedGoal = normalizeGoal(goal);
  const normalizedBodyMap = normalizeBodyMap(bodyMap);
  const normalizedConstraints = normalizeConstraints(constraints);
  const normalizedCapabilities = normalizeCapabilities(capabilities);
  assertDependencyReferences(normalizedCapabilities);

  const eligibility = normalizedCapabilities.map((capability) => evaluateCapabilityEligibility({
    capability,
    bodyMap: normalizedBodyMap,
    constraints: normalizedConstraints
  }));
  const eligible = eligibility.filter((item) => item.eligible).map((item) => item.capability);
  const eligibleById = new Map(eligible.map((capability) => [capability.id, capability]));

  const selectedIds = new Set();
  const selectionReasons = new Map();
  const uncovered = new Set(normalizedGoal.requirements.filter((item) => item.required).map((item) => item.token));

  while (uncovered.size > 0) {
    const ranked = eligible
      .filter((capability) => !selectedIds.has(capability.id))
      .map((capability) => ({
        capability,
        uncoveredCoverage: capability.provides.filter((token) => uncovered.has(token)).length
      }))
      .filter((item) => item.uncoveredCoverage > 0)
      .sort(compareCoverageCandidates);

    if (ranked.length === 0) break;
    const chosen = ranked[0].capability;
    selectedIds.add(chosen.id);
    selectionReasons.set(chosen.id, {
      type: 'REQUIREMENT_COVERAGE',
      tokens: chosen.provides.filter((token) => uncovered.has(token)).sort()
    });
    for (const token of chosen.provides) uncovered.delete(token);
  }

  for (const exploration of normalizedGoal.exploration) {
    const selectedPressures = new Set(
      [...selectedIds]
        .map((id) => eligibleById.get(id)?.pressure)
        .filter(Boolean)
    );
    const alternatives = eligible
      .filter((capability) => !selectedIds.has(capability.id) && capability.provides.includes(exploration.token))
      .filter((capability) => !exploration.distinctPressure || !selectedPressures.has(capability.pressure))
      .sort(compareCapabilities);

    for (const capability of alternatives.slice(0, exploration.extraProviders)) {
      selectedIds.add(capability.id);
      selectedPressures.add(capability.pressure);
      selectionReasons.set(capability.id, {
        type: 'EXPLORATION_DIVERSITY',
        token: exploration.token,
        pressure: capability.pressure
      });
    }
  }

  const unresolved = [];
  for (const token of [...uncovered].sort()) {
    unresolved.push({ type: 'UNCOVERED_REQUIREMENT', token });
  }

  closeDependencies({ selectedIds, selectionReasons, eligibleById, unresolved });
  const selected = [...selectedIds].map((id) => eligibleById.get(id)).filter(Boolean);
  const dependencyCycle = detectDependencyCycle(selected);
  if (dependencyCycle) unresolved.push({ type: 'DEPENDENCY_CYCLE', path: dependencyCycle });

  if (selected.length > normalizedConstraints.maxCandidates) {
    unresolved.push({
      type: 'MAX_CANDIDATES_EXCEEDED',
      selected: selected.length,
      limit: normalizedConstraints.maxCandidates
    });
  }
  if (normalizedGoal.integrationTests.length === 0) {
    unresolved.push({ type: 'MISSING_INTEGRATION_TESTS' });
  }

  const orderedSelected = dependencyCycle ? [...selected].sort(compareCapabilities) : topologicalCapabilityOrder(selected);
  const selectedMetadata = orderedSelected.map((capability) => ({
    id: capability.id,
    role: capability.role,
    pressure: capability.pressure,
    executorRef: capability.executorRef,
    provides: [...capability.provides],
    dependsOn: [...capability.dependsOn],
    targetAreas: [...capability.targetAreas],
    scopePaths: capability.scopePaths,
    effectiveAuthority: capability.effectiveAuthority,
    resources: capability.resources,
    priority: capability.priority,
    reason: selectionReasons.get(capability.id) ?? { type: 'DEPENDENCY' }
  }));

  const coverage = normalizedGoal.requirements.map((requirement) => ({
    id: requirement.id,
    token: requirement.token,
    required: requirement.required,
    providers: orderedSelected
      .filter((capability) => capability.provides.includes(requirement.token))
      .map((capability) => capability.id)
  }));

  const rejectedCapabilities = eligibility
    .filter((item) => !item.eligible)
    .map((item) => ({ id: item.capability.id, reasons: item.reasons }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const structuralCore = {
    schema: PLAN_SCHEMA,
    runId: String(runId),
    stateRef: String(stateRef),
    rollbackRef: String(rollbackRef),
    goal: stripExecutableGoal(normalizedGoal),
    bodyMap: { id: normalizedBodyMap.id, areas: normalizedBodyMap.areas },
    constraints: stripExecutableConstraints(normalizedConstraints),
    selectedCapabilities: selectedMetadata,
    coverage,
    rejectedCapabilities,
    unresolved
  };
  const planId = `decomposition-plan:sha256:${sha256(stableStringify(structuralCore))}`;
  const status = unresolved.length > 0
    ? 'HOLD_UNRESOLVED'
    : (orderedSelected.length === 0 ? 'HOLD_NO_CANDIDATES' : 'READY');

  const creationSpec = status === 'READY'
    ? buildCreationSpec({
        runId: String(runId),
        state,
        stateRef: String(stateRef),
        rollbackRef: String(rollbackRef),
        goal: normalizedGoal,
        selected: orderedSelected,
        constraints: normalizedConstraints,
        planId
      })
    : null;

  return {
    ...structuralCore,
    planId,
    status,
    creationSpec,
    createdAt: now()
  };
}

export async function runDecomposedCreation(input, { fabricOptions = {} } = {}) {
  const plan = createDecompositionPlan(input);
  if (plan.status !== 'READY') return { plan, creation: null };
  const fabric = new CreationFabric(fabricOptions);
  const creation = await fabric.start(plan.creationSpec).result;
  return { plan, creation };
}

function buildCreationSpec({ runId, state, stateRef, rollbackRef, goal, selected, constraints, planId }) {
  return {
    runId,
    goal: goal.summary,
    state,
    stateRef,
    rollbackRef,
    resourceBudget: constraints.resourceBudget,
    candidates: selected.map((capability) => ({
      id: capability.id,
      role: capability.role,
      laneId: capability.id,
      capabilityId: capability.id,
      dependsOn: capability.dependsOn.filter((id) => selected.some((item) => item.id === id)),
      authority: capability.effectiveAuthority,
      resources: capability.resources,
      inputRefs: [...capability.inputRefs, `decomposition:${planId}`, ...capability.targetAreas.map((id) => `body-area:${id}`)],
      evidenceRefs: capability.evidenceRefs,
      tests: [
        ...capability.tests,
        makeScopeTest(capability.scopePaths)
      ],
      work: capability.work
    })),
    integration: {
      id: constraints.integrationId ?? `${runId}:integration`,
      resources: constraints.integrationResources,
      requirements: constraints.integrationRequirements,
      conflictPolicy: constraints.conflictPolicy,
      tests: goal.integrationTests,
      evidenceRefs: [`decomposition:${planId}`, ...constraints.integrationEvidenceRefs],
      authority: constraints.integrationAuthority
    },
    body: {
      requirements: constraints.bodyRequirements,
      conflictPolicy: constraints.bodyConflictPolicy,
      predicates: constraints.bodyPredicates
    }
  };
}

function makeScopeTest(scopePaths) {
  return {
    id: 'decomposition-scope-boundary',
    test: ({ state, sourceState }) => {
      const changes = diffJsonState(sourceState, state);
      return changes.every((change) => scopePaths.some((scope) => pathWithinScope(change.path, scope)));
    }
  };
}

function evaluateCapabilityEligibility({ capability, bodyMap, constraints }) {
  const reasons = [];
  if (constraints.allowedCapabilities && !constraints.allowedCapabilities.includes(capability.id)) {
    reasons.push('CAPABILITY_NOT_ALLOWLISTED');
  }
  if (constraints.deniedCapabilities.includes(capability.id)) reasons.push('CAPABILITY_DENIED');
  if (capability.evidenceRefs.length === 0) reasons.push('MISSING_EVIDENCE_REFS');
  if (capability.tests.length === 0) reasons.push('MISSING_DOMAIN_TESTS');

  const areas = capability.targetAreas.map((id) => bodyMap.areaById.get(id)).filter(Boolean);
  if (areas.length !== capability.targetAreas.length) reasons.push('UNKNOWN_TARGET_AREA');
  for (const area of areas) {
    if (!area.allowedCapabilities.includes(capability.id)) reasons.push(`BODY_AREA_DENIES:${area.id}`);
  }

  const effectiveAuthority = capability.authority.filter((authority) =>
    constraints.allowedAuthorities.includes(authority) && areas.every((area) => area.authorities.includes(authority))
  );
  if (!effectiveAuthority.includes('WRITE-SANDBOX')) reasons.push('MISSING_WRITE_SANDBOX_AUTHORITY');
  if (constraints.requireCommitCandidate && !effectiveAuthority.includes('COMMIT-CANDIDATE')) {
    reasons.push('MISSING_COMMIT_CANDIDATE_AUTHORITY');
  }

  if (!resourcesFitLimits(capability.resources, constraints.resourceBudget.limits)) {
    reasons.push('RESOURCE_BUDGET_EXCEEDED_OR_UNDECLARED');
  }

  capability.effectiveAuthority = effectiveAuthority;
  capability.scopePaths = areas.map((area) => area.path).sort();
  return { capability, eligible: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

function closeDependencies({ selectedIds, selectionReasons, eligibleById, unresolved }) {
  const queue = [...selectedIds].sort();
  const visited = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const capability = eligibleById.get(id);
    if (!capability) continue;
    for (const dependencyId of capability.dependsOn) {
      const dependency = eligibleById.get(dependencyId);
      if (!dependency) {
        unresolved.push({ type: 'UNAVAILABLE_DEPENDENCY', capabilityId: id, dependencyId });
        continue;
      }
      if (!selectedIds.has(dependencyId)) {
        selectedIds.add(dependencyId);
        selectionReasons.set(dependencyId, { type: 'DEPENDENCY', requiredBy: id });
        queue.push(dependencyId);
      }
    }
  }
}

function normalizeGoal(goal) {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) throw new TypeError('goal must be an explicit goal object');
  if (!goal.id) throw new TypeError('goal.id is required');
  if (!Array.isArray(goal.requirements) || goal.requirements.length === 0) {
    throw new TypeError('goal.requirements must be a non-empty array');
  }
  const seen = new Set();
  const requirements = goal.requirements.map((requirement, index) => {
    if (!requirement?.id || !requirement?.token) throw new TypeError(`goal.requirements[${index}] requires id and token`);
    const id = String(requirement.id);
    if (seen.has(id)) throw new Error(`Duplicate goal requirement id: ${id}`);
    seen.add(id);
    return { id, token: String(requirement.token), required: requirement.required ?? true };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const exploration = (goal.exploration ?? []).map((item, index) => {
    if (!item?.token) throw new TypeError(`goal.exploration[${index}].token is required`);
    const extraProviders = Number(item.extraProviders ?? 1);
    if (!Number.isInteger(extraProviders) || extraProviders < 0) throw new TypeError('extraProviders must be a non-negative integer');
    return {
      token: String(item.token),
      extraProviders,
      distinctPressure: item.distinctPressure ?? true
    };
  }).sort((a, b) => a.token.localeCompare(b.token));

  assertTests(goal.integrationTests ?? [], 'goal.integrationTests');
  return {
    id: String(goal.id),
    summary: String(goal.summary ?? goal.id),
    requirements,
    exploration,
    integrationTests: goal.integrationTests ?? []
  };
}

function normalizeBodyMap(bodyMap) {
  if (!bodyMap || typeof bodyMap !== 'object' || Array.isArray(bodyMap)) throw new TypeError('bodyMap is required');
  if (!Array.isArray(bodyMap.areas) || bodyMap.areas.length === 0) throw new TypeError('bodyMap.areas must be non-empty');
  const seen = new Set();
  const areas = bodyMap.areas.map((area, index) => {
    if (!area?.id || !area?.path) throw new TypeError(`bodyMap.areas[${index}] requires id and path`);
    const id = String(area.id);
    if (seen.has(id)) throw new Error(`Duplicate body area id: ${id}`);
    seen.add(id);
    const path = normalizeScopePath(area.path, `bodyMap.areas[${index}].path`);
    const allowedCapabilities = uniqueStrings(area.allowedCapabilities ?? []);
    if (allowedCapabilities.length === 0) throw new TypeError(`body area ${id} must explicitly list allowedCapabilities`);
    const authorities = uniqueStrings(area.authorities ?? []);
    return { id, path, allowedCapabilities, authorities };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    id: String(bodyMap.id ?? 'body-map'),
    areas,
    areaById: new Map(areas.map((area) => [area.id, area]))
  };
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) throw new TypeError('capabilities must be a non-empty array');
  const seen = new Set();
  return capabilities.map((capability, index) => {
    if (!capability?.id) throw new TypeError(`capabilities[${index}].id is required`);
    if (!capability.executorRef) throw new TypeError(`capability ${capability.id} requires executorRef`);
    if (typeof capability.work !== 'function') throw new TypeError(`capability ${capability.id} requires work(context)`);
    const id = String(capability.id);
    if (seen.has(id)) throw new Error(`Duplicate capability id: ${id}`);
    seen.add(id);
    const provides = uniqueStrings(capability.provides ?? []);
    if (provides.length === 0) throw new TypeError(`capability ${id} must provide at least one requirement token`);
    const targetAreas = uniqueStrings(capability.targetAreas ?? []);
    if (targetAreas.length === 0) throw new TypeError(`capability ${id} must declare targetAreas`);
    assertTests(capability.tests ?? [], `capability ${id}.tests`);
    validateResources(capability.resources ?? {}, `capability ${id}.resources`);
    return {
      id,
      role: String(capability.role ?? id),
      pressure: String(capability.pressure ?? 'default'),
      executorRef: String(capability.executorRef),
      provides,
      dependsOn: uniqueStrings(capability.dependsOn ?? []),
      targetAreas,
      authority: uniqueStrings(capability.authority ?? ['WRITE-SANDBOX']),
      resources: { workers: 1, ...(capability.resources ?? {}) },
      inputRefs: uniqueStrings(capability.inputRefs ?? []),
      evidenceRefs: uniqueStrings(capability.evidenceRefs ?? []),
      tests: capability.tests ?? [],
      priority: finiteNumber(capability.priority ?? 0, `capability ${id}.priority`),
      work: capability.work,
      effectiveAuthority: [],
      scopePaths: []
    };
  }).sort(compareCapabilities);
}

function normalizeConstraints(constraints) {
  const resourceBudget = constraints.resourceBudget ?? { limits: { workers: 4 } };
  if (!resourceBudget.limits || typeof resourceBudget.limits !== 'object') throw new TypeError('constraints.resourceBudget.limits is required');
  validateResources(resourceBudget.limits, 'constraints.resourceBudget.limits');
  if ((resourceBudget.limits.workers ?? 0) < 1) throw new TypeError('resourceBudget workers must be at least 1');
  const maxCandidates = Number(constraints.maxCandidates ?? 16);
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new TypeError('maxCandidates must be a positive integer');
  const integrationResources = { workers: 1, ...(constraints.integrationResources ?? {}) };
  validateResources(integrationResources, 'constraints.integrationResources');
  if (!resourcesFitLimits(integrationResources, resourceBudget.limits)) throw new Error('integrationResources exceed or use undeclared resource budget');
  assertTests(constraints.bodyPredicates ?? [], 'constraints.bodyPredicates');
  return {
    maxCandidates,
    requireCommitCandidate: constraints.requireCommitCandidate ?? true,
    allowedAuthorities: uniqueStrings(constraints.allowedAuthorities ?? DEFAULT_ALLOWED_AUTHORITIES),
    allowedCapabilities: constraints.allowedCapabilities == null ? null : uniqueStrings(constraints.allowedCapabilities),
    deniedCapabilities: uniqueStrings(constraints.deniedCapabilities ?? []),
    resourceBudget: { limits: { ...resourceBudget.limits } },
    integrationId: constraints.integrationId == null ? null : String(constraints.integrationId),
    integrationResources,
    integrationRequirements: constraints.integrationRequirements ?? {},
    integrationEvidenceRefs: uniqueStrings(constraints.integrationEvidenceRefs ?? []),
    integrationAuthority: uniqueStrings(constraints.integrationAuthority ?? ['COMMIT-CANDIDATE']),
    conflictPolicy: String(constraints.conflictPolicy ?? 'hold-run'),
    bodyRequirements: constraints.bodyRequirements ?? {},
    bodyConflictPolicy: String(constraints.bodyConflictPolicy ?? 'hold-run'),
    bodyPredicates: constraints.bodyPredicates ?? []
  };
}

function assertDependencyReferences(capabilities) {
  const ids = new Set(capabilities.map((capability) => capability.id));
  for (const capability of capabilities) {
    for (const dependency of capability.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Capability ${capability.id} depends on unknown capability ${dependency}`);
      if (dependency === capability.id) throw new Error(`Capability ${capability.id} cannot depend on itself`);
    }
  }
}

function topologicalCapabilityOrder(capabilities) {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const indegree = new Map(capabilities.map((capability) => [capability.id, 0]));
  const dependents = new Map(capabilities.map((capability) => [capability.id, []]));
  for (const capability of capabilities) {
    for (const dependency of capability.dependsOn) {
      if (!byId.has(dependency)) continue;
      indegree.set(capability.id, indegree.get(capability.id) + 1);
      dependents.get(dependency).push(capability.id);
    }
  }
  const ready = capabilities.filter((capability) => indegree.get(capability.id) === 0).sort(compareCapabilities);
  const result = [];
  while (ready.length > 0) {
    const capability = ready.shift();
    result.push(capability);
    for (const dependentId of dependents.get(capability.id).sort()) {
      indegree.set(dependentId, indegree.get(dependentId) - 1);
      if (indegree.get(dependentId) === 0) {
        ready.push(byId.get(dependentId));
        ready.sort(compareCapabilities);
      }
    }
  }
  return result;
}

function detectDependencyCycle(capabilities) {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const visiting = [];
  const visitingSet = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return null;
    if (visitingSet.has(id)) {
      const start = visiting.indexOf(id);
      return [...visiting.slice(start), id];
    }
    visiting.push(id);
    visitingSet.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    visiting.pop();
    visitingSet.delete(id);
    visited.add(id);
    return null;
  }
  for (const capability of [...capabilities].sort(compareCapabilities)) {
    const cycle = visit(capability.id);
    if (cycle) return cycle;
  }
  return null;
}

function compareCoverageCandidates(a, b) {
  return b.uncoveredCoverage - a.uncoveredCoverage || compareCapabilities(a.capability, b.capability);
}

function compareCapabilities(a, b) {
  return b.priority - a.priority || a.id.localeCompare(b.id);
}

function resourcesFitLimits(resources, limits) {
  return Object.entries(resources).every(([key, amount]) => limits[key] !== undefined && amount <= limits[key]);
}

function validateResources(resources, label) {
  for (const [key, amount] of Object.entries(resources)) {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`${label}.${key} must be finite and non-negative`);
  }
}

function assertTests(tests, label) {
  if (!Array.isArray(tests)) throw new TypeError(`${label} must be an array`);
  for (const test of tests) {
    if (!test?.id || typeof test.test !== 'function') throw new TypeError(`${label} entries require id and test(context)`);
  }
}

function normalizeScopePath(path, label) {
  if (typeof path !== 'string' || path.trim() === '') throw new TypeError(`${label} must be a non-empty path`);
  const segments = path.split('.');
  for (const segment of segments) {
    if (!segment) throw new TypeError(`${label} contains an empty path segment`);
    if (BLOCKED_PATH_SEGMENTS.has(segment)) throw new TypeError(`${label} contains blocked path segment ${segment}`);
  }
  return segments.join('.');
}

function pathWithinScope(path, scope) {
  return path === scope || path.startsWith(`${scope}.`);
}

function stripExecutableGoal(goal) {
  return {
    id: goal.id,
    summary: goal.summary,
    requirements: goal.requirements,
    exploration: goal.exploration,
    integrationTestIds: goal.integrationTests.map((test) => String(test.id)).sort()
  };
}

function stripExecutableConstraints(constraints) {
  return {
    maxCandidates: constraints.maxCandidates,
    requireCommitCandidate: constraints.requireCommitCandidate,
    allowedAuthorities: constraints.allowedAuthorities,
    allowedCapabilities: constraints.allowedCapabilities,
    deniedCapabilities: constraints.deniedCapabilities,
    resourceBudget: constraints.resourceBudget,
    integrationId: constraints.integrationId,
    integrationResources: constraints.integrationResources,
    integrationRequirements: constraints.integrationRequirements,
    integrationEvidenceRefs: constraints.integrationEvidenceRefs,
    integrationAuthority: constraints.integrationAuthority,
    conflictPolicy: constraints.conflictPolicy,
    bodyRequirements: constraints.bodyRequirements,
    bodyConflictPolicy: constraints.bodyConflictPolicy,
    bodyPredicateIds: constraints.bodyPredicates.map((predicate) => String(predicate.id)).sort()
  };
}

function uniqueStrings(values) {
  return [...new Set(values.map(String))].sort();
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
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
  throw new TypeError('Cannot canonicalize executable/non-JSON value');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
