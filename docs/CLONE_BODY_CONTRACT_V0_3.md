# Clone Body Contract v0.3

## Status

**IMPLEMENTED / TESTED IN THE CURRENT NODE HARNESS**

This document narrows the Phase 4 clone-body capability implemented in Lane 1. It does not claim generic VM, filesystem, database, source-tree, binary-asset, or world-state cloning.

The current proof is scoped to JSON-compatible in-memory plain-object root state that can be represented by the existing dotted-path merge grammar.

## Purpose

The clone-body layer gives experimental capability lanes broad mutation freedom inside disposable copies while keeping mutation through the supplied work context off the protected source body.

The intended flow is:

`protected body -> disposable candidate clones -> deterministic diffs -> merge predicates/conflicts -> disposable integration clone -> integration tests -> integration COMMIT-CANDIDATE -> protected-body plan -> explicit commit`

A successful experiment does not mutate protected state through the clone API by itself.

## Candidate clone contract

`runCloneCandidate(...)`:

- clones the supplied source body before work starts;
- gives the work function a writable clone instead of the supplied protected object through its context;
- records the exact source-state SHA-256 hash;
- runs declared post-work tests against copies of the clone state;
- preserves work failures instead of hiding them;
- derives a deterministic source-to-clone diff;
- adds operation preconditions from the source snapshot;
- returns a candidate receipt compatible with the v0.2 merge predicates.

Default clone authority is only:

`WRITE-SANDBOX`

A caller must explicitly grant `COMMIT-CANDIDATE` if the clone should be eligible to propose a merge.

Neither authority commits protected state.

## Diff grammar

`diffJsonState(before, after)` currently emits only:

- `set`
- `delete`

Nested plain objects are diffed recursively. Arrays and primitive values are treated as leaf values.

Generated operations carry source preconditions:

- replacing an existing value requires the expected old value;
- deleting an existing value requires the expected old value;
- adding a new value requires the target path not to exist.

This reduces stale-clone risk at commit time.

The v0.3 dotted-path grammar cannot address object keys that themselves contain `.`. Such states are rejected rather than silently encoded incorrectly.

## Integration clone contract

`buildIntegrationClone(...)`:

1. hashes the protected source body;
2. requires candidate `sourceStateHash` values to match that exact content;
3. passes candidates through the v0.2 merge predicates and conflict rules;
4. applies accepted operations only to a disposable integration copy;
5. runs declared integration tests;
6. returns `VALID_IN_HARNESS` only when every declared integration test passes;
7. returns a new integration candidate describing the source-to-integration diff.

If the merge plan is not commit-eligible, the integration clone remains unchanged and no integration candidate is produced.

Under `merge-nonconflicting`, independent accepted wins may be integrated while conflicting candidates remain explicitly held and traceable.

## Protected-body gate

`createBodyCommitPlan(...)` creates a new merge plan for a protected body and automatically adds a content-hash predicate.

This matters because `stateRef` alone may be an externally supplied label. Two different bodies can accidentally or incorrectly reuse the same state reference.

The body plan therefore requires an integration/candidate lineage hash that matches the exact protected source content used for the plan.

Planning still does not mutate the body.

Actual crossing of the protected boundary requires the separate public `commitMerge(...)` call.

That function returns a new state object. The supplied protected object is not mutated in place by the library.

## What v0.3 tests demonstrate

The current harness tests that:

- work using the supplied clone context mutates the disposable copy while the supplied protected source remains unchanged;
- independent clones can diverge without observing each other's clone-context mutations;
- clone diffs are deterministic and source-preconditioned;
- failed clone work remains a failed candidate and cannot enter integration;
- compatible candidates can combine inside an integration clone;
- conflicting candidates are held;
- failed integration verification produces a non-mergeable candidate;
- protected-body planning rejects source-content mismatch even when the same `stateRef` is reused;
- protected state remains unchanged until the caller explicitly adopts a returned commit state;
- `merge-nonconflicting` can preserve disputes while integrating independent wins;
- dotted object keys that the path grammar cannot represent are rejected.

## Truth limits

This is not yet:

- filesystem cloning;
- Git worktree cloning;
- source-code semantic merging;
- database transactions;
- binary or asset cloning;
- process/container/VM isolation;
- world-engine state orchestration;
- durable clone storage;
- automatic conflict repair;
- automatic deployment;
- autonomous merge authority.

Clone isolation here means independent in-memory JSON-compatible copies inside the current JavaScript process.

The work callback is ordinary code in that same process. The library does not provide a security sandbox around hostile or malicious callbacks. If callback code already holds some external reference, global, filesystem capability, or other authority outside the supplied clone context, v0.3 does not prevent that code from using it. The tested boundary is copy isolation and explicit merge authority, not capability containment of arbitrary JavaScript.

## Security / integrity boundary

SHA-256 values in this layer are deterministic integrity/content bindings, not authentication. No secret key is involved.

Clone-body safety currently comes from:

- copy isolation for the state supplied through the clone API;
- content lineage hashes;
- explicit authority labels;
- tests;
- deterministic diffs;
- operation preconditions;
- conflict holds;
- separate integration and protected-body gates;
- reversible merge receipts from v0.2.

## Next grounded seam

The next useful direction is to connect clone-body work to the bounded scheduler so a task graph can spawn multiple disposable candidate bodies as temporary work contracts, then compare and integrate them without manually wiring each clone call.

That would begin Phase 5 Creation Fabric use. It should not be promoted to observed until built and measured.
