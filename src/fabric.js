const DEFAULT_LIMITS = Object.freeze({ workers: 4 });

export class ParallelCapabilityFabric {
  constructor({ limits = {}, now = () => new Date().toISOString() } = {}) {
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    this.now = now;
    validateResourceMap(this.limits, 'fabric limits');
  }

  start(spec, { checkpoint = null } = {}) {
    return new RunSession({ spec, checkpoint, fabricLimits: this.limits, now: this.now });
  }
}

class RunSession {
  constructor({ spec, checkpoint, fabricLimits, now }) {
    this.spec = normalizeSpec(spec, fabricLimits);
    this.now = now;
    this.tasks = this.spec.tasks;
    this.taskById = new Map(this.tasks.map((task) => [task.taskId, task]));
    this.indexById = new Map(this.tasks.map((task, index) => [task.taskId, index]));
    this.state = new Map(this.tasks.map((task) => [task.taskId, 'PENDING']));
    this.outputs = new Map();
    this.receipts = new Map();
    this.active = new Map();
    this.currentResources = zeroResourceMap(this.spec.resourceBudget.limits);
    this.paused = false;
    this.cancelled = false;
    this.finalized = false;
    this.startedAt = this.now();
    this.completedAt = null;

    this._applyCheckpoint(checkpoint);

    this.result = new Promise((resolve) => {
      this._resolve = resolve;
    });

    queueMicrotask(() => this._pump());
  }

  pause() {
    if (this.finalized || this.cancelled) return false;
    this.paused = true;
    return true;
  }

  resume() {
    if (this.finalized || this.cancelled) return false;
    if (!this.paused) return true;
    this.paused = false;
    this._pump();
    return true;
  }

  cancel() {
    if (this.finalized || this.cancelled) return false;
    this.cancelled = true;
    this.paused = false;
    for (const active of this.active.values()) {
      active.controller.abort(new Error('AXM parallel capability run cancelled'));
    }
    this._pump();
    return true;
  }

  getCheckpoint() {
    const completed = this.tasks
      .filter((task) => isReusableState(this.state.get(task.taskId)))
      .map((task) => ({
        taskId: task.taskId,
        state: this.state.get(task.taskId),
        output: cloneJsonValue(this.outputs.get(task.taskId)),
        receipt: cloneJsonValue(this.receipts.get(task.taskId))
      }));

    return {
      schema: 'axm.parallel-capability-checkpoint/v0.1',
      runId: this.spec.runId,
      stateRef: this.spec.stateRef,
      createdAt: this.now(),
      completed
    };
  }

  snapshot() {
    return {
      runId: this.spec.runId,
      paused: this.paused,
      cancelled: this.cancelled,
      active: [...this.active.keys()].sort((a, b) => this.indexById.get(a) - this.indexById.get(b)),
      tasks: this.tasks.map((task) => ({ taskId: task.taskId, state: this.state.get(task.taskId) })),
      resourcesInUse: { ...this.currentResources }
    };
  }

  _applyCheckpoint(checkpoint) {
    if (!checkpoint) return;
    if (checkpoint.schema !== 'axm.parallel-capability-checkpoint/v0.1') {
      throw new Error(`Unsupported checkpoint schema: ${checkpoint.schema ?? '<missing>'}`);
    }
    if (checkpoint.runId !== this.spec.runId) {
      throw new Error(`Checkpoint runId mismatch: ${checkpoint.runId} !== ${this.spec.runId}`);
    }
    if (checkpoint.stateRef !== this.spec.stateRef) {
      throw new Error(`Checkpoint stateRef mismatch: ${checkpoint.stateRef} !== ${this.spec.stateRef}`);
    }

    for (const item of checkpoint.completed ?? []) {
      if (!this.taskById.has(item.taskId)) continue;
      if (!isReusableState(item.state)) continue;
      this.state.set(item.taskId, item.state);
      this.outputs.set(item.taskId, cloneJsonValue(item.output));
      this.receipts.set(item.taskId, cloneJsonValue(item.receipt));
    }
  }

  _pump() {
    if (this.finalized) return;

    this._propagateBlockedDependencies();

    if (this.cancelled) {
      for (const task of this.tasks) {
        if (this.state.get(task.taskId) === 'PENDING') {
          this.state.set(task.taskId, 'CANCELLED');
          this.receipts.set(task.taskId, this._baseReceipt(task, {
            status: 'CANCELLED',
            startedAt: null,
            completedAt: this.now(),
            failures: ['Run cancelled before lane started']
          }));
        }
      }
      if (this.active.size === 0) this._finalize('CANCELLED');
      return;
    }

    if (!this.paused) {
      let launched;
      do {
        launched = false;
        for (const task of this.tasks) {
          if (this.state.get(task.taskId) !== 'PENDING') continue;
          if (!task.dependencies.every((id) => isDependencySatisfied(this.state.get(id)))) continue;
          if (!resourcesFit(this.currentResources, task.resources, this.spec.resourceBudget.limits)) continue;
          this._launch(task);
          launched = true;
        }
      } while (launched && this._hasImmediatelyRunnableTask());
    }

    if (this.active.size === 0 && !this._hasPendingTasks()) {
      const hasExecutionFailure = [...this.state.values()].some((status) => status === 'FAILED' || status === 'BLOCKED_DEPENDENCY');
      this._finalize(hasExecutionFailure ? 'COMPLETED_WITH_FAILURES' : 'COMPLETED');
    }
  }

  _hasImmediatelyRunnableTask() {
    return this.tasks.some((task) =>
      this.state.get(task.taskId) === 'PENDING' &&
      task.dependencies.every((id) => isDependencySatisfied(this.state.get(id))) &&
      resourcesFit(this.currentResources, task.resources, this.spec.resourceBudget.limits)
    );
  }

  _hasPendingTasks() {
    return this.tasks.some((task) => this.state.get(task.taskId) === 'PENDING');
  }

  _propagateBlockedDependencies() {
    let changed;
    do {
      changed = false;
      for (const task of this.tasks) {
        if (this.state.get(task.taskId) !== 'PENDING') continue;
        const failedDeps = task.dependencies.filter((id) => isDependencyFailed(this.state.get(id)));
        if (failedDeps.length === 0) continue;
        this.state.set(task.taskId, 'BLOCKED_DEPENDENCY');
        this.receipts.set(task.taskId, this._baseReceipt(task, {
          status: 'BLOCKED_DEPENDENCY',
          startedAt: null,
          completedAt: this.now(),
          failures: [`Blocked by failed dependencies: ${failedDeps.join(', ')}`]
        }));
        changed = true;
      }
    } while (changed);
  }

  _launch(task) {
    this.state.set(task.taskId, 'RUNNING');
    addResources(this.currentResources, task.resources);
    const controller = new AbortController();
    const startedAt = this.now();
    this.active.set(task.taskId, { controller, startedAt });

    const dependencyOutputs = Object.fromEntries(
      task.dependencies.map((id) => [id, cloneJsonValue(this.outputs.get(id))])
    );

    const context = Object.freeze({
      runId: this.spec.runId,
      laneId: task.laneId,
      taskId: task.taskId,
      goal: this.spec.goal,
      stateRef: this.spec.stateRef,
      authority: cloneJsonValue(task.authority),
      resources: cloneJsonValue(task.resources),
      dependencyOutputs,
      signal: controller.signal
    });

    Promise.resolve()
      .then(() => task.run(context))
      .then((result) => this._completeTask(task, startedAt, result))
      .catch((error) => this._failTask(task, startedAt, error));
  }

  _completeTask(task, startedAt, rawResult) {
    const active = this.active.get(task.taskId);
    if (!active) return;
    this.active.delete(task.taskId);
    subtractResources(this.currentResources, task.resources);

    const result = normalizeLaneResult(rawResult);
    const status = this.cancelled ? 'COMPLETED_AFTER_CANCEL' : (result.status ?? 'COMPLETED');
    this.state.set(task.taskId, status);
    this.outputs.set(task.taskId, cloneJsonValue(result.output));
    this.receipts.set(task.taskId, this._baseReceipt(task, {
      status,
      startedAt,
      completedAt: this.now(),
      outputRefs: result.outputRefs,
      evidenceRefs: result.evidenceRefs,
      assumptions: result.assumptions,
      unknowns: result.unknowns,
      contradictions: result.contradictions,
      failures: result.failures,
      resourceUsage: result.resourceUsage,
      testResults: result.testResults,
      proposedChanges: result.proposedChanges,
      metadata: result.metadata
    }));
    this._pump();
  }

  _failTask(task, startedAt, error) {
    const active = this.active.get(task.taskId);
    if (!active) return;
    this.active.delete(task.taskId);
    subtractResources(this.currentResources, task.resources);

    const aborted = active.controller.signal.aborted;
    const status = this.cancelled && aborted ? 'CANCELLED' : 'FAILED';
    this.state.set(task.taskId, status);
    this.receipts.set(task.taskId, this._baseReceipt(task, {
      status,
      startedAt,
      completedAt: this.now(),
      failures: [serializeError(error)]
    }));
    this._pump();
  }

  _baseReceipt(task, overrides = {}) {
    return {
      schema: 'axm.parallel-capability-lane-receipt/v0.1',
      runId: this.spec.runId,
      laneId: task.laneId,
      taskId: task.taskId,
      capabilityId: task.capabilityId,
      inputRefs: cloneJsonValue(task.inputRefs),
      stateRef: this.spec.stateRef,
      authorityUsed: cloneJsonValue(task.authority),
      declaredResources: cloneJsonValue(task.resources),
      startedAt: null,
      completedAt: null,
      outputRefs: [],
      evidenceRefs: [],
      assumptions: [],
      unknowns: [],
      contradictions: [],
      failures: [],
      resourceUsage: {},
      testResults: [],
      proposedChanges: [],
      metadata: {},
      status: 'PENDING',
      ...overrides
    };
  }

  _finalize(status) {
    if (this.finalized) return;
    this.finalized = true;
    this.completedAt = this.now();
    const receipts = this.tasks.map((task) => this.receipts.get(task.taskId)).filter(Boolean);
    const conflicts = detectProposedChangeConflicts(receipts);
    const contradictions = receipts.flatMap((receipt) =>
      (receipt.contradictions ?? []).map((contradiction) => ({
        laneId: receipt.laneId,
        taskId: receipt.taskId,
        contradiction
      }))
    );

    this._resolve({
      schema: 'axm.parallel-capability-run-receipt/v0.1',
      runId: this.spec.runId,
      goal: this.spec.goal,
      stateRef: this.spec.stateRef,
      rollbackRef: this.spec.rollbackRef,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      status,
      resourceBudget: cloneJsonValue(this.spec.resourceBudget),
      laneReceipts: receipts,
      outputs: this.tasks.map((task) => ({
        taskId: task.taskId,
        laneId: task.laneId,
        status: this.state.get(task.taskId),
        output: cloneJsonValue(this.outputs.get(task.taskId))
      })),
      contradictions,
      conflicts,
      checkpoint: this.getCheckpoint()
    });
  }
}

export function detectProposedChangeConflicts(receipts) {
  const byPath = new Map();
  for (const receipt of receipts ?? []) {
    for (const change of receipt.proposedChanges ?? []) {
      if (!change || typeof change.path !== 'string') continue;
      const item = {
        laneId: receipt.laneId,
        taskId: receipt.taskId,
        change: cloneJsonValue(change)
      };
      const list = byPath.get(change.path) ?? [];
      list.push(item);
      byPath.set(change.path, list);
    }
  }

  const conflicts = [];
  for (const [path, items] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (items.length < 2) continue;
    const signatures = new Set(items.map((item) => stableStringify(item.change)));
    if (signatures.size < 2) continue;
    conflicts.push({
      path,
      type: 'PROPOSED_CHANGE_CONFLICT',
      candidates: items.sort((a, b) => `${a.laneId}:${a.taskId}`.localeCompare(`${b.laneId}:${b.taskId}`))
    });
  }
  return conflicts;
}

export function selectCandidate(candidates, { predicates = [], compare = null, runId = 'selection' } = {}) {
  const ordered = [...candidates].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const evaluations = ordered.map((candidate) => {
    const tests = predicates.map((predicate) => {
      let passed = false;
      let error = null;
      try {
        passed = Boolean(predicate.test(candidate));
      } catch (caught) {
        error = serializeError(caught);
      }
      return { id: predicate.id, passed, error };
    });
    return {
      id: candidate.id,
      candidate,
      tests,
      accepted: tests.every((test) => test.passed)
    };
  });

  const accepted = evaluations.filter((item) => item.accepted);
  if (compare) {
    accepted.sort((a, b) => compare(a.candidate, b.candidate) || String(a.id).localeCompare(String(b.id)));
  }

  const selected = accepted[0] ?? null;
  return {
    schema: 'axm.parallel-capability-selection-receipt/v0.1',
    runId,
    selected: selected?.id ?? null,
    accepted: accepted.map((item) => item.id),
    rejected: evaluations.filter((item) => !item.accepted).map((item) => item.id),
    evaluations: evaluations.map(({ id, tests, accepted }) => ({ id, tests, accepted })),
    unresolved: selected ? [] : ['No candidate satisfied all declared predicates']
  };
}

function normalizeSpec(spec, fabricLimits) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Run spec is required');
  if (!spec.runId) throw new TypeError('runId is required');
  if (!spec.stateRef) throw new TypeError('stateRef is required');
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) throw new TypeError('tasks must be a non-empty array');

  const limits = { ...fabricLimits, ...(spec.resourceBudget?.limits ?? {}) };
  validateResourceMap(limits, 'run resource limits');

  const seen = new Set();
  const tasks = spec.tasks.map((task, index) => {
    if (!task.taskId) throw new TypeError(`tasks[${index}].taskId is required`);
    if (seen.has(task.taskId)) throw new Error(`Duplicate taskId: ${task.taskId}`);
    seen.add(task.taskId);
    if (typeof task.run !== 'function') throw new TypeError(`Task ${task.taskId} requires a run(context) function`);
    const resources = { workers: 1, ...(task.resources ?? {}) };
    validateResourceMap(resources, `resources for ${task.taskId}`);
    for (const [key, amount] of Object.entries(resources)) {
      const limit = limits[key];
      if (limit === undefined) throw new Error(`Task ${task.taskId} requests undeclared resource class: ${key}`);
      if (amount > limit) throw new Error(`Task ${task.taskId} requires ${key}=${amount}, above run limit ${limit}`);
    }
    return {
      taskId: String(task.taskId),
      laneId: String(task.laneId ?? task.taskId),
      capabilityId: String(task.capabilityId ?? task.taskId),
      dependencies: [...(task.dependencies ?? [])].map(String),
      authority: cloneJsonValue(task.authority ?? ['PROPOSE']),
      resources,
      inputRefs: cloneJsonValue(task.inputRefs ?? []),
      run: task.run
    };
  });

  const ids = new Set(tasks.map((task) => task.taskId));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.taskId} depends on unknown task ${dependency}`);
      if (dependency === task.taskId) throw new Error(`Task ${task.taskId} cannot depend on itself`);
    }
  }
  assertAcyclic(tasks);

  return {
    runId: String(spec.runId),
    goal: String(spec.goal ?? ''),
    stateRef: String(spec.stateRef),
    rollbackRef: spec.rollbackRef == null ? null : String(spec.rollbackRef),
    resourceBudget: { limits },
    tasks
  };
}

function normalizeLaneResult(rawResult) {
  const result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
    ? rawResult
    : { output: rawResult };
  return {
    status: result.status,
    output: result.output,
    outputRefs: cloneJsonValue(result.outputRefs ?? []),
    evidenceRefs: cloneJsonValue(result.evidenceRefs ?? []),
    assumptions: cloneJsonValue(result.assumptions ?? []),
    unknowns: cloneJsonValue(result.unknowns ?? []),
    contradictions: cloneJsonValue(result.contradictions ?? []),
    failures: cloneJsonValue(result.failures ?? []),
    resourceUsage: cloneJsonValue(result.resourceUsage ?? {}),
    testResults: cloneJsonValue(result.testResults ?? []),
    proposedChanges: cloneJsonValue(result.proposedChanges ?? []),
    metadata: cloneJsonValue(result.metadata ?? {})
  };
}

function assertAcyclic(tasks) {
  const deps = new Map(tasks.map((task) => [task.taskId, task.dependencies]));
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Task graph contains a cycle involving ${id}`);
    visiting.add(id);
    for (const dependency of deps.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of tasks) visit(task.taskId);
}

function validateResourceMap(resources, label) {
  for (const [key, amount] of Object.entries(resources)) {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`${label}.${key} must be a finite non-negative number`);
  }
  if ((resources.workers ?? 0) < 1) throw new TypeError(`${label}.workers must be at least 1`);
}

function zeroResourceMap(limits) {
  return Object.fromEntries(Object.keys(limits).map((key) => [key, 0]));
}

function resourcesFit(current, requested, limits) {
  return Object.entries(requested).every(([key, amount]) => (current[key] ?? 0) + amount <= limits[key]);
}

function addResources(current, requested) {
  for (const [key, amount] of Object.entries(requested)) current[key] = (current[key] ?? 0) + amount;
}

function subtractResources(current, requested) {
  for (const [key, amount] of Object.entries(requested)) current[key] = Math.max(0, (current[key] ?? 0) - amount);
}

function isDependencySatisfied(status) {
  return status && !['PENDING', 'RUNNING', 'FAILED', 'BLOCKED_DEPENDENCY', 'CANCELLED'].includes(status);
}

function isDependencyFailed(status) {
  return ['FAILED', 'BLOCKED_DEPENDENCY', 'CANCELLED'].includes(status);
}

function isReusableState(status) {
  return status && !['PENDING', 'RUNNING', 'FAILED', 'BLOCKED_DEPENDENCY', 'CANCELLED'].includes(status);
}

function serializeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function cloneJsonValue(value) {
  if (value === undefined) return null;
  return structuredClone(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
