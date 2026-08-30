# AXM Parallel Capability Fabric

A focused experimental repository for extracting the bounded parallel-work pattern discovered in Discovery Buddy into a reusable AXM capability fabric.

The objective is **not more agents**. It is more grounded capability per unit of time while preserving truth, control, attribution, bounded authority, deterministic handling, and reversibility.

## Truth status

### Observed in the source handoff

Discovery Buddy v1.12 demonstrated bounded concurrent worker scheduling, checkpointing, pause/resume/cancel, deterministic scan handling, source-integrity hashing, and bounded read authority. The source handoff records a synthetic 80-job scheduler test with four concurrent slots and explicitly limits that evidence to the synthetic scheduler harness.

See `docs/FOUNDING_DIRECTION.md` for the source-grounded repository intake. The complete handoff remains the authoritative source used to bootstrap this lane.

### Implemented in this repository, Lane 1

#### v0.1 bounded orchestration

- bounded capability lanes;
- dependency-aware task graph;
- declared resource-token limits;
- explicit run/task/lane identifiers;
- lane receipts;
- deterministic output ordering by declared task plan;
- pause/resume/cancel;
- checkpoint export and exact `runId` + `stateRef` binding;
- failed-dependency propagation;
- contradiction preservation;
- proposed-change conflict reporting;
- deterministic candidate selection against explicit predicates.

#### v0.2 deterministic JSON-state merge contract

- explicit merge planning separate from commit authority;
- state-version, authority, evidence, failure, status, and test predicates;
- exact-path and parent/child-path conflict detection;
- deterministic operation ordering and identical-proposal coalescing;
- JSON-compatible in-memory `set` / `delete` commits;
- optional operation preconditions;
- merge receipts with source/result hashes;
- merge-plan integrity checking;
- rollback tokens with exact source snapshots;
- rollback-token integrity checking;
- rollback refusal after committed-state drift.

#### v0.3 disposable clone bodies + integration clone

- candidate work receives a writable disposable copy rather than the protected body;
- independent clones can diverge without sharing mutations;
- source-to-clone diffs are generated deterministically;
- generated operations carry source-value/existence preconditions;
- clone candidates bind to an exact source-state content hash;
- failed clone work remains a failed candidate;
- compatible candidates can merge into a disposable integration clone;
- conflicts can hold the integration run instead of touching protected state;
- integration tests gate `VALID_IN_HARNESS` status;
- an integration result is only a new `COMMIT-CANDIDATE`, not a protected-state mutation;
- protected-body planning adds exact source-content binding even when an external `stateRef` is reused;
- a separate explicit public merge commit is still required to cross the protected boundary.

#### v0.4 scheduler-native Creation Fabric cycle

- declared candidate work contracts are converted into scheduler tasks automatically;
- clone candidate tasks use the same bounded worker/resource scheduling layer as v0.1;
- the integration task is generated automatically and depends on all declared candidate tasks;
- candidate failures remain candidate evidence rather than automatically becoming scheduler failures;
- successful independent candidates may continue into integration when another experiment fails;
- candidate order remains tied to declared order rather than completion timing;
- candidate work receives the scheduler `AbortSignal` for cooperative cancellation;
- creation sessions expose pause/resume/cancel/snapshot/checkpoint behavior through the scheduler;
- checkpoint reuse can avoid rerunning completed candidate and integration work;
- candidate authority defaults to `WRITE-SANDBOX`, not `COMMIT-CANDIDATE`;
- protected-body content is hashed at cycle start and checked again at completion for drift;
- an integration candidate is converted into a protected-body plan only after integration tests;
- a ready Creation Fabric cycle still requires the separate public `commitMerge(...)` call;
- the creation receipt keeps source lineage through hashes rather than silently duplicating another full source-body snapshot.

These claims are scoped to the Node harness and the documented state grammar. v0.3/v0.4 clone isolation currently means **independent in-memory JSON-compatible plain-object copies inside one JavaScript process**. It is not a claim of hostile-code sandboxing, VM/container isolation, filesystem cloning, source-tree cloning, databases, binary assets, or game/world engines.

See `docs/MERGE_CONTRACT_V0_2.md`, `docs/CLONE_BODY_CONTRACT_V0_3.md`, and `docs/CREATION_FABRIC_CONTRACT_V0_4.md` for the narrower contracts and limitations.

### Still proposal / not yet proven here

- arbitrary capability discovery/spawning;
- deterministic generation/decomposition of candidate work contracts from a higher-level creation goal;
- adaptive CPU/disk/event-loop backoff;
- persistent checkpoint storage;
- durable external clone/rollback storage;
- generic source-code / filesystem / database merge adapters;
- automatic repair of held merge conflicts;
- Grammar Glass survivor loops;
- Walmi temporary specialist spawning;
- game/world-state orchestration;
- measured real-workload improvement over sequential execution.

## One chat = one lane

Repository work follows `AGENTS.md`. This bootstrap conversation owns:

`chat/1-parallel-fabric-bootstrap`

One chat keeps one branch and one primary PR. It does not spread work across sibling PRs as the task evolves.

## Install / test

No runtime dependencies are required.

```bash
npm test
```

Requires Node.js 20 or newer.

## Demos

```bash
npm run demo:calculation
npm run demo:inspection
npm run demo:selection
npm run demo:merge
npm run demo:clone
npm run demo:creation
```

The first three demos cover the founding builder-handoff targets. `demo:merge` demonstrates the v0.2 plan -> commit -> receipt -> rollback gate. `demo:clone` demonstrates candidate clones -> integration clone -> protected-body plan -> explicit commit. `demo:creation` demonstrates scheduler-generated clone tasks -> automatic integration dependency -> protected-body plan -> explicit commit.

## Bounded scheduler API

```js
import { ParallelCapabilityFabric } from '@axm/parallel-capability';

const fabric = new ParallelCapabilityFabric({
  limits: { workers: 4, memoryMB: 1024 }
});

const session = fabric.start({
  runId: 'run-001',
  goal: 'Inspect independent inputs',
  stateRef: 'snapshot:abc123',
  rollbackRef: 'snapshot:before',
  tasks: [
    {
      taskId: 'lane-a',
      capabilityId: 'example.inspect',
      authority: ['READ', 'OBSERVE'],
      resources: { workers: 1, memoryMB: 128 },
      run: async () => ({
        output: { ok: true },
        evidenceRefs: ['input:a'],
        proposedChanges: []
      })
    }
  ]
});

const receipt = await session.result;
```

## Merge API

Merge planning is intentionally separate from committing:

```js
import { createMergePlan, commitMerge, rollbackMerge } from '@axm/parallel-capability';

const plan = createMergePlan({
  runId: 'run-001',
  stateRef: 'state:v1',
  rollbackRef: 'state:v0',
  candidates: laneReceipts
});

// No state changed merely because a plan exists.
const committed = commitMerge({
  state,
  currentStateRef: 'state:v1',
  plan,
  resultingStateRef: 'state:v2'
});

const restored = rollbackMerge({
  state: committed.state,
  currentStateRef: committed.stateRef,
  rollbackToken: committed.rollbackToken
});
```

By default a candidate must bind to the exact state version, carry `COMMIT-CANDIDATE` authority, provide evidence, report no failures, and have at least one passing test with all declared tests passing. Conflicting candidates are held by default. An explicit `merge-nonconflicting` policy may commit independent accepted candidates while keeping conflicting candidates unresolved and traceable.

## Clone-body API

```js
import {
  runCloneCandidate,
  buildIntegrationClone,
  createBodyCommitPlan,
  commitMerge
} from '@axm/parallel-capability';

const candidate = await runCloneCandidate({
  id: 'performance',
  state: protectedBody,
  stateRef: 'body:v1',
  authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
  evidenceRefs: ['benchmark:1'],
  tests: [{ id: 'target', test: ({ state }) => state.config.cacheMB === 128 }],
  work: ({ state }) => {
    state.config.cacheMB = 128;
  }
});

const integration = await buildIntegrationClone({
  integrationId: 'integration-1',
  runId: 'integration-run-1',
  state: protectedBody,
  stateRef: 'body:v1',
  rollbackRef: 'body:v1',
  candidates: [candidate],
  tests: [{ id: 'integration-target', test: ({ state }) => state.config.cacheMB === 128 }]
});

const bodyPlan = createBodyCommitPlan({
  runId: 'protected-plan-1',
  state: protectedBody,
  stateRef: 'body:v1',
  rollbackRef: 'body:v1',
  candidates: [integration.candidate]
});

// Protected body is still untouched here.
const committed = commitMerge({
  state: protectedBody,
  currentStateRef: 'body:v1',
  plan: bodyPlan.mergePlan
});
```

`WRITE-SANDBOX` allows work inside the clone. `COMMIT-CANDIDATE` only allows the result to be considered by merge predicates. Neither is automatic merge authority.

## Creation Fabric API

```js
import { CreationFabric, commitMerge } from '@axm/parallel-capability';

const fabric = new CreationFabric({ limits: { workers: 3 } });
const cycle = fabric.start({
  runId: 'creation-1',
  goal: 'Explore bounded candidate improvements',
  state: protectedBody,
  stateRef: 'body:v1',
  rollbackRef: 'body:v0',
  candidates: [
    {
      id: 'performance',
      role: 'PERFORMANCE',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['benchmark:1'],
      tests: [{ id: 'candidate-target', test: ({ state }) => state.metrics.runtimeMs <= 12 }],
      work: ({ state }) => {
        state.metrics.runtimeMs = 12;
      }
    },
    {
      id: 'usability',
      role: 'USABILITY',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['inspection:ui'],
      tests: [{ id: 'ui-target', test: ({ state }) => state.ui.compact === true }],
      work: ({ state }) => {
        state.ui.compact = true;
      }
    }
  ],
  integration: {
    evidenceRefs: ['integration:harness'],
    tests: [{ id: 'combined-target', test: ({ state }) => state.metrics.runtimeMs <= 12 && state.ui.compact }]
  }
});

const receipt = await cycle.result;

// Still no protected-state mutation.
if (receipt.status === 'READY_FOR_EXPLICIT_COMMIT') {
  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'body:v1',
    plan: receipt.bodyPlan.mergePlan
  });
}
```

The candidate work contracts are currently caller-declared. v0.4 automatically schedules, bounds, gathers, integrates, verifies, checkpoints and prepares them for the protected merge gate; it does not yet invent the candidate graph from an arbitrary goal.

## Design boundary

A lane is a bounded work contract, not automatically a persistent agent. Same-body coordination never implies unlimited write or merge authority.

The repository now demonstrates a reversible sequence for its bounded JSON-state harness:

`creation request -> scheduler-generated clone tasks -> parallel candidate bodies -> receipts/diffs -> conflict/test gate -> integration clone -> integration candidate -> protected-body plan -> explicit commit -> rollback receipt`

That is still a prototype grammar, not universal transaction or autonomous creation infrastructure.
