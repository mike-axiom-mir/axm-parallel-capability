# AXM Parallel Capability Fabric

A focused experimental repository for extracting the bounded parallel-work pattern discovered in Discovery Buddy into a reusable AXM capability fabric.

The objective is **not more agents**. It is more grounded capability per unit of time while preserving truth, control, attribution, bounded authority, deterministic handling, and reversibility.

## Truth status

### Observed in the source handoff

Discovery Buddy v1.12 demonstrated bounded concurrent worker scheduling, checkpointing, pause/resume/cancel, deterministic scan handling, source-integrity hashing, and bounded read authority. The source handoff records a synthetic 80-job scheduler test with four concurrent slots and explicitly limits that evidence to the synthetic scheduler harness.

See `docs/FOUNDING_DIRECTION.md` for the source-grounded repository intake. The complete handoff remains the authoritative source used to bootstrap this lane.

### Implemented in this repository, Lane 1

The initial generic JavaScript fabric now provides:

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
- rollback references in run receipts.

These claims are scoped to this implementation and its test harness. They are **not** claims of production-scale performance or a completed generic merge fabric.

### Still proposal / not yet proven here

- arbitrary capability discovery/spawning;
- adaptive CPU/disk/event-loop backoff;
- persistent filesystem checkpoint storage;
- generic state mutation/merge;
- disposable clone-body integration;
- automatic rollback execution;
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
```

The demos cover the three initial builder-handoff targets:

1. deterministic parallel calculation;
2. parallel software inspection;
3. candidate generation plus deterministic selection.

## Minimal API

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
      run: async ({ signal }) => ({
        output: { ok: true },
        evidenceRefs: ['input:a'],
        proposedChanges: []
      })
    }
  ]
});

session.pause();
session.resume();
const receipt = await session.result;
```

## Design boundary

A lane is a bounded work contract, not automatically a persistent agent. Same-body coordination never implies unlimited write or merge authority.

The first implementation intentionally stops before generic state merge. Conflict detection and candidate selection exist so later merge work begins from explicit evidence instead of silently choosing a winner.
