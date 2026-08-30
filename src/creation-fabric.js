import { ParallelCapabilityFabric } from './fabric.js';
import {
  buildIntegrationClone,
  createBodyCommitPlan,
  diffJsonState,
  runCloneCandidate
} from './clone-body.js';
import { hashState } from './merge.js';

const CREATION_RECEIPT_SCHEMA = 'axm.parallel-capability-creation-cycle-receipt/v0.4';

export class CreationFabric {
  constructor({ limits = {}, now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.parallel = new ParallelCapabilityFabric({ limits, now });
  }

  start(spec, { checkpoint = null } = {}) {
    const normalized = normalizeCreationSpec(spec);
    const protectedState = spec.state;
    const sourceState = structuredClone(spec.state);
    const sourceStateHash = hashState(sourceState);
    const candidateTaskIds = normalized.candidates.map((candidate) => `candidate:${candidate.id}`);
    const taskIdByCandidateId = new Map(normalized.candidates.map((candidate, index) => [candidate.id, candidateTaskIds[index]]));
    const integrationTaskId = `integration:${normalized.integration.id}`;

    const tasks = normalized.candidates.map((candidate, index) => {
      const dependencyTaskIds = candidate.dependsOn.map((id) => taskIdByCandidateId.get(id));
      return {
        taskId: candidateTaskIds[index],
        laneId: candidate.laneId,
        capabilityId: candidate.capabilityId,
        dependencies: dependencyTaskIds,
        authority: candidate.authority,
        resources: candidate.resources,
        inputRefs: [`state:${normalized.stateRef}`, ...candidate.inputRefs, ...dependencyTaskIds],
        run: async ({ dependencyOutputs, signal }) => {
          throwIfAborted(signal);
          const dependencyCandidates = Object.fromEntries(
            candidate.dependsOn.map((id) => [id, structuredClone(dependencyOutputs[taskIdByCandidateId.get(id)] ?? null)])
          );
          const cloneCandidate = await runCloneCandidate({
            id: candidate.id,
            laneId: candidate.laneId,
            taskId: candidateTaskIds[index],
            state: sourceState,
            stateRef: normalized.stateRef,
            authority: candidate.authority,
            evidenceRefs: candidate.evidenceRefs,
            tests: candidate.tests,
            now: this.now,
            work: async (cloneContext) => {
              throwIfAborted(signal);
              const result = await candidate.work(Object.freeze({
                ...cloneContext,
                signal,
                goal: normalized.goal,
                role: candidate.role,
                dependencyCandidates: Object.freeze(dependencyCandidates)
              }));
              throwIfAborted(signal);
              return result;
            }
          });
          throwIfAborted(signal);

          // Candidate failure is domain evidence, not scheduler failure. The merge
          // predicates decide whether the candidate may survive into integration.
          return {
            output: cloneCandidate,
            evidenceRefs: cloneCandidate.evidenceRefs,
            assumptions: cloneCandidate.assumptions,
            unknowns: cloneCandidate.unknowns,
            contradictions: cloneCandidate.contradictions,
            testResults: cloneCandidate.testResults,
            proposedChanges: cloneCandidate.changes,
            metadata: {
              creationCandidate: true,
              candidateId: candidate.id,
              candidateStatus: cloneCandidate.status,
              role: candidate.role,
              dependsOn: [...candidate.dependsOn]
            }
          };
        }
      };
    });

    tasks.push({
      taskId: integrationTaskId,
      laneId: 'integration-clone',
      capabilityId: 'axm.creation.integration-clone',
      dependencies: candidateTaskIds,
      authority: ['WRITE-SANDBOX', 'PROPOSE'],
      resources: normalized.integration.resources,
      inputRefs: [`state:${normalized.stateRef}`, ...candidateTaskIds],
      run: async ({ dependencyOutputs, signal }) => {
        throwIfAborted(signal);
        const candidates = candidateTaskIds
          .map((taskId) => dependencyOutputs[taskId])
          .filter(Boolean);
        const integration = await buildIntegrationClone({
          integrationId: normalized.integration.id,
          runId: `${normalized.runId}:integration`,
          state: sourceState,
          stateRef: normalized.stateRef,
          rollbackRef: normalized.rollbackRef,
          candidates,
          requirements: normalized.integration.requirements,
          conflictPolicy: normalized.integration.conflictPolicy,
          tests: normalized.integration.tests,
          evidenceRefs: normalized.integration.evidenceRefs,
          authority: normalized.integration.authority,
          now: this.now
        });
        throwIfAborted(signal);
        return {
          output: integration,
          evidenceRefs: normalized.integration.evidenceRefs,
          contradictions: integration.receipt?.unresolved ?? [],
          testResults: integration.receipt?.testResults ?? [],
          proposedChanges: integration.candidate?.changes ?? [],
          metadata: {
            creationIntegration: true,
            integrationId: normalized.integration.id,
            integrationStatus: integration.receipt?.status ?? null
          }
        };
      }
    });

    const schedulerSession = this.parallel.start({
      runId: normalized.runId,
      goal: normalized.goal,
      stateRef: normalized.stateRef,
      rollbackRef: normalized.rollbackRef,
      resourceBudget: normalized.resourceBudget,
      tasks
    }, { checkpoint });

    return new CreationCycleSession({
      schedulerSession,
      normalized,
      protectedState,
      sourceStateHash,
      candidateTaskIds,
      integrationTaskId,
      now: this.now
    });
  }
}

export async function runCreationCycle(spec, options = {}) {
  const fabric = new CreationFabric(options);
  return fabric.start(spec).result;
}

class CreationCycleSession {
  constructor({
    schedulerSession,
    normalized,
    protectedState,
    sourceStateHash,
    candidateTaskIds,
    integrationTaskId,
    now
  }) {
    this.schedulerSession = schedulerSession;
    this.normalized = normalized;
    this.candidateTaskIds = candidateTaskIds;
    this.integrationTaskId = integrationTaskId;
    this.result = schedulerSession.result.then((schedulerReceipt) => finalizeCreationCycle({
      schedulerReceipt,
      normalized,
      protectedState,
      sourceStateHash,
      candidateTaskIds,
      integrationTaskId,
      now
    }));
  }

  pause() {
    return this.schedulerSession.pause();
  }

  resume() {
    return this.schedulerSession.resume();
  }

  cancel() {
    return this.schedulerSession.cancel();
  }

  getCheckpoint() {
    return this.schedulerSession.getCheckpoint();
  }

  snapshot() {
    return {
      schema: 'axm.parallel-capability-creation-cycle-snapshot/v0.4',
      ...this.schedulerSession.snapshot(),
      candidateTaskIds: [...this.candidateTaskIds],
      integrationTaskId: this.integrationTaskId
    };
  }
}

function finalizeCreationCycle({
  schedulerReceipt,
  normalized,
  protectedState,
  sourceStateHash,
  candidateTaskIds,
  integrationTaskId,
  now
}) {
  const outputByTask = new Map(schedulerReceipt.outputs.map((item) => [item.taskId, item]));
  const candidates = candidateTaskIds.map((taskId) => ({
    taskId,
    schedulerStatus: outputByTask.get(taskId)?.status ?? null,
    candidate: outputByTask.get(taskId)?.output ?? null
  }));
  const integration = outputByTask.get(integrationTaskId)?.output ?? null;
  const completionHash = safeHashState(protectedState);
  const protectedStateDrifted = completionHash.hash == null || completionHash.hash !== sourceStateHash;

  let bodyPlan = null;
  let bodyPlanError = null;
  if (integration?.candidate) {
    try {
      bodyPlan = createBodyCommitPlan({
        runId: `${normalized.runId}:protected-body`,
        state: protectedState,
        stateRef: normalized.stateRef,
        rollbackRef: normalized.rollbackRef,
        candidates: [integration.candidate],
        requirements: normalized.body.requirements,
        conflictPolicy: normalized.body.conflictPolicy,
        predicates: normalized.body.predicates,
        now
      });
    } catch (error) {
      bodyPlanError = serializeError(error);
    }
  }

  return {
    schema: CREATION_RECEIPT_SCHEMA,
    runId: normalized.runId,
    goal: normalized.goal,
    sourceStateRef: normalized.stateRef,
    rollbackRef: normalized.rollbackRef,
    sourceStateHash,
    protectedStateHashAtCompletion: completionHash.hash,
    protectedStateHashError: completionHash.error,
    protectedStateDrifted,
    status: creationStatus({ schedulerReceipt, integration, bodyPlan, bodyPlanError, protectedStateDrifted }),
    candidateOrder: normalized.candidates.map((candidate) => candidate.id),
    candidates,
    integration,
    bodyPlan,
    bodyPlanError,
    schedulerReceipt,
    completedAt: now()
  };
}

function creationStatus({ schedulerReceipt, integration, bodyPlan, bodyPlanError, protectedStateDrifted }) {
  if (schedulerReceipt.status === 'CANCELLED') return 'CANCELLED';
  if (schedulerReceipt.status === 'COMPLETED_WITH_FAILURES') return 'ORCHESTRATION_FAILURES';
  if (!integration) return 'NO_INTEGRATION_RESULT';
  if (!integration.candidate) return 'HELD_INTEGRATION';
  if (integration.candidate.status !== 'VALID_IN_HARNESS') return 'INTEGRATION_TEST_FAIL';
  if (bodyPlanError) return 'HOLD_BODY_PLAN_ERROR';
  if (protectedStateDrifted) return 'HOLD_PROTECTED_STATE_DRIFT';
  if (bodyPlan?.mergePlan?.commitAllowed) return 'READY_FOR_EXPLICIT_COMMIT';
  return 'HOLD_BODY_PLAN';
}

function normalizeCreationSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('creation spec is required');
  if (!spec.runId) throw new TypeError('runId is required');
  if (!spec.stateRef) throw new TypeError('stateRef is required');
  if (!spec.rollbackRef) throw new TypeError('rollbackRef is required');
  if (!Array.isArray(spec.candidates) || spec.candidates.length === 0) {
    throw new TypeError('candidates must be a non-empty array');
  }

  // Reuse the clone-body validator without widening the v0.3 state grammar.
  diffJsonState(spec.state, spec.state);

  const seen = new Set();
  const candidates = spec.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') throw new TypeError(`candidates[${index}] must be an object`);
    if (!candidate.id) throw new TypeError(`candidates[${index}].id is required`);
    if (typeof candidate.work !== 'function') throw new TypeError(`candidate ${candidate.id} requires work(context)`);
    const id = String(candidate.id);
    if (seen.has(id)) throw new Error(`Duplicate creation candidate id: ${id}`);
    seen.add(id);
    return {
      id,
      role: candidate.role == null ? null : String(candidate.role),
      laneId: String(candidate.laneId ?? id),
      capabilityId: String(candidate.capabilityId ?? 'axm.creation.clone-candidate'),
      dependsOn: [...(candidate.dependsOn ?? [])].map(String),
      authority: [...(candidate.authority ?? ['WRITE-SANDBOX'])].map(String),
      resources: { workers: 1, ...(candidate.resources ?? {}) },
      inputRefs: [...(candidate.inputRefs ?? [])].map(String),
      evidenceRefs: [...(candidate.evidenceRefs ?? [])].map(String),
      tests: candidate.tests ?? [],
      work: candidate.work
    };
  });

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    for (const dependency of candidate.dependsOn) {
      if (!candidateIds.has(dependency)) throw new Error(`Creation candidate ${candidate.id} depends on unknown candidate ${dependency}`);
      if (dependency === candidate.id) throw new Error(`Creation candidate ${candidate.id} cannot depend on itself`);
    }
  }

  const integration = spec.integration ?? {};
  const body = spec.body ?? {};
  return {
    runId: String(spec.runId),
    goal: String(spec.goal ?? ''),
    stateRef: String(spec.stateRef),
    rollbackRef: String(spec.rollbackRef),
    resourceBudget: spec.resourceBudget,
    candidates,
    integration: {
      id: String(integration.id ?? `${spec.runId}:integration`),
      resources: { workers: 1, ...(integration.resources ?? {}) },
      requirements: integration.requirements ?? {},
      conflictPolicy: integration.conflictPolicy ?? 'hold-run',
      tests: integration.tests ?? [],
      evidenceRefs: [...(integration.evidenceRefs ?? [])].map(String),
      authority: [...(integration.authority ?? ['COMMIT-CANDIDATE'])].map(String)
    },
    body: {
      requirements: body.requirements ?? {},
      conflictPolicy: body.conflictPolicy ?? 'hold-run',
      predicates: body.predicates ?? []
    }
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error('Creation cycle cancelled');
}

function safeHashState(state) {
  try {
    return { hash: hashState(state), error: null };
  } catch (error) {
    return { hash: null, error: serializeError(error) };
  }
}

function serializeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
