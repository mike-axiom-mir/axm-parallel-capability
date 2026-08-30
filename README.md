# AXM Parallel Capability Fabric

A focused experimental repository for extracting the bounded parallel-work pattern discovered in Discovery Buddy into a reusable AXM capability fabric.

The objective is **not more agents**. It is more grounded capability per unit of time while preserving truth, control, attribution, bounded authority, deterministic handling, and reversibility.

## Truth status

### Observed in the source handoff

Discovery Buddy v1.12 demonstrated bounded concurrent worker scheduling, checkpointing, pause/resume/cancel, deterministic scan handling, source-integrity hashing, and bounded read authority. The source handoff records a synthetic 80-job scheduler test with four concurrent slots and explicitly limits that evidence to the synthetic scheduler harness.

See `docs/FOUNDING_DIRECTION.md` for the source-grounded repository intake. The complete handoff remains the authoritative source used to bootstrap this lane.

### Implemented in this repository, Lane 1

The generic JavaScript fabric now provides:

- bounded capability lanes;
- a dependency-aware task graph;
- declared resource-token limits;
- explicit run/task/lane identifiers;
- lane receipts;
- deterministic output ordering by declared task plan;
- pause/resume;
- cancel with `AbortSignal` propagation;
- checkpoint export and exact `runId` + `stateRef` binding on reuse;
- failed-dependency propagation;
- contradiction preservation;
- proposed-change conflict detection;
- deterministic candidate selection against explicit predicates;
- explicit merge planning separate from commit authority;
- state-version, authority, evidence, failure, status, and test predicates for merge candidates;
- exact-path and parent/child-path conflict detection;
- deterministic operation ordering and identical-proposal coalescing;
- JSON-compatible in-memory `set` / `delete` state commits;
- optional operation preconditions;
- merge receipts with source/result state hashes;
- rollback tokens with exact source snapshots;
- rollback refusal when the committed state has drifted since the merge.

These claims are scoped to this implementation and its Node test harness. The merge layer is a **generic JSON-state merge prototype under a deliberately small operation grammar**, not a claim that arbitrary source trees, databases, binaries, worlds, or filesystems can already be merged generically.

### Still proposal / not yet proven here

- arbitrary capability discovery/spawning;
- adaptive CPU/disk/event-loop backoff;
- persistent filesystem checkpoint storage;
- external/persistent rollback snapshot storage;
- generic source-code / filesystem / database merge adapters;
- disposable clone-body integration;
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
```

The first three demos cover the founding builder-handoff targets. `demo:merge` demonstrates the v0.2 explicit plan -> commit -> receipt -> rollback flow.

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

## Design boundary

A lane is a bounded work contract, not automatically a persistent agent. Same-body coordination never implies unlimited write or merge authority.

No silent merge means more than producing a receipt after mutation. The v0.2 API first produces an inspectable merge plan, and only a separate explicit commit call may cross the state boundary.
