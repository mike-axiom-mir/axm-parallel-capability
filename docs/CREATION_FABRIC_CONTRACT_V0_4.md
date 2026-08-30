# Creation Fabric Contract v0.4

## Status

**IMPLEMENTED / TESTED IN THE CURRENT NODE HARNESS**

This document scopes the first Creation Fabric use of the Parallel Capability Fabric.

It does not claim autonomous general software creation, arbitrary capability discovery, source-code semantic merging, hostile-code sandboxing, or production-scale performance.

The current proof remains bounded to the existing JSON-compatible in-memory body grammar.

## Purpose

v0.4 connects three previously separate tested layers:

1. the v0.1 bounded task scheduler;
2. the v0.3 disposable clone-body primitive;
3. the v0.2/v0.3 integration and protected-body merge gates.

The resulting flow is:

`creation request -> declared candidate work contracts -> scheduler-generated clone tasks -> bounded parallel clone work -> candidate receipts -> integration dependency -> integration clone -> integration tests -> protected-body plan -> explicit commit gate`

The caller no longer has to manually call every clone and then manually gather each candidate before integration.

## CreationFabric

`CreationFabric` owns a `ParallelCapabilityFabric` scheduler.

A creation spec declares:

- `runId`;
- goal;
- protected source body;
- source `stateRef`;
- rollback reference;
- candidate work contracts;
- resource budget;
- integration contract;
- optional protected-body predicates.

The fabric deterministically creates one scheduler task per declared candidate plus a final integration task that depends on all candidate tasks.

Candidate output order remains tied to the declared candidate order rather than completion timing.

## Temporary clone hands

Each candidate specification may declare:

- id;
- role / solution pressure;
- lane id;
- capability id;
- authority;
- resource request;
- input references;
- evidence references;
- candidate tests;
- `work(context)`.

The scheduler supplies a bounded lane slot and an `AbortSignal`.

The clone layer supplies a disposable writable body copy.

This is a temporary work contract, not a required persistent agent.

## Authority boundary

Creation candidates default to:

`WRITE-SANDBOX`

They do **not** receive `COMMIT-CANDIDATE` by default.

A caller that wants a candidate to be eligible for integration must explicitly grant the needed proposal authority, for example:

`['WRITE-SANDBOX', 'COMMIT-CANDIDATE']`

Even `COMMIT-CANDIDATE` does not mutate protected state. It only allows the candidate to pass the merge-authority predicate.

The integration output is still only another candidate.

Protected state requires the separate public `commitMerge(...)` call.

## Candidate failure versus orchestration failure

v0.4 intentionally separates two kinds of failure.

### Candidate failure

An experimental clone may:

- throw inside its work contract;
- fail its declared tests;
- report failures;
- lack evidence;
- lack merge authority.

When the clone framework successfully records that result, the scheduler task itself may still be `COMPLETED`.

The candidate receipt carries its own `FAILED` / `TEST_FAIL` state and the integration predicates reject it.

This lets independent successful experiments continue instead of one weak candidate collapsing the whole creation graph.

### Orchestration failure

A scheduler/invariant failure means the work contract itself could not be safely represented or executed as a creation task. Examples include broken task dependencies, invalid resource declarations, cancellation, or invalid body grammar escaping the clone contract.

Those remain scheduler-level failures.

## Automatic integration dependency

The final integration task depends on all declared candidate tasks.

After candidate task completion it:

1. gathers candidate receipts from dependency outputs;
2. applies the existing merge predicates;
3. preserves candidate failures and conflicts;
4. builds only a disposable integration body;
5. runs integration tests;
6. emits a `VALID_IN_HARNESS` integration candidate only when those tests pass.

`hold-run` remains the default conflict policy.

`merge-nonconflicting` may be chosen explicitly to integrate independent accepted wins while conflicting candidates remain held and traceable.

## Resource orchestration

Candidate clone tasks participate in the same scheduler resource budget as any other Parallel Capability Fabric task.

The current tests demonstrate bounded worker concurrency for automatically spawned creation candidates.

Other declared resource classes can use the existing scheduler token mechanism when corresponding limits are configured.

v0.4 does not yet provide adaptive CPU/disk/event-loop backoff.

## Pause / resume / cancel / checkpoint

The creation session delegates:

- `pause()`;
- `resume()`;
- `cancel()`;
- `snapshot()`;
- `getCheckpoint()`.

Checkpoint reuse can restore completed candidate and integration task outputs without re-running completed work, under the existing exact `runId` + `stateRef` binding.

Cancellation propagates the scheduler `AbortSignal` into candidate work. Cooperative work can therefore stop and integration will not start after the run is cancelled.

## Protected-body drift check

The creation cycle hashes the protected body at cycle start.

At completion it hashes the protected body again.

If the body changed while clone work was running, the receipt records:

- `protectedStateDrifted: true`;
- the completion hash where available;
- a hold status rather than readiness for commit.

The protected-body plan also retains the v0.3 exact source-content predicate, so reusing the same textual `stateRef` does not hide different source content.

## Receipt privacy / size boundary

The v0.4 creation receipt preserves source content lineage through hashes and existing candidate/integration receipts.

It does **not** add another full copy of the original source body merely for logging.

This avoids needless receipt growth and reduces accidental duplication if receipts are later persisted.

Existing clone/integration outputs may still contain their own bounded state/candidate data according to those contracts.

## What the v0.4 harness demonstrates

The added Creation Fabric tests demonstrate that:

- declared clone hands are generated as scheduler tasks;
- multiple clone hands actually overlap under the worker cap;
- candidate output ordering remains deterministic;
- a failed experimental clone remains evidence without blocking an independent survivor;
- exact conflicts hold integration;
- `merge-nonconflicting` can preserve disputes while integrating an independent win;
- failed integration verification produces a non-committable result;
- protected-body drift is detected even if the same `stateRef` is reused;
- creation checkpoint reuse does not rerun completed work;
- cancellation prevents integration and propagates into cooperative clone work;
- candidates do not gain `COMMIT-CANDIDATE` authority by default;
- a ready cycle still does not mutate protected state until a separate explicit commit call.

## Truth limits

v0.4 is not yet:

- autonomous task decomposition from an arbitrary natural-language goal;
- arbitrary capability discovery or spawning;
- a model/agent router;
- hostile-code isolation;
- filesystem or Git-worktree candidate cloning;
- semantic source-code merging;
- database transaction orchestration;
- asset/binary creation merging;
- automatic conflict repair;
- adaptive resource pressure control;
- durable distributed checkpoints;
- Grammar Glass candidate generation;
- Walmi specialist spawning;
- game/world engine orchestration;
- proof that parallel creation improves real production workloads.

## Next grounded seam

The next useful experiment is **candidate contract generation / decomposition**.

Today v0.4 automatically schedules and integrates candidate work contracts, but the candidate contracts themselves are still declared by the caller.

A later layer could take a bounded creation goal plus known capability/body-map information and deterministically produce the task/candidate graph required by `CreationFabric`.

That should remain a proposal until the decomposition contract, authority rules, and comparative tests exist.
