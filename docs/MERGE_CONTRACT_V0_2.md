# Deterministic Merge Fabric v0.2

Status: **implemented in Lane 1 test harness**, with the boundaries below.

This document describes the merge capability currently implemented by `src/merge.js` and the public integrity gate in `src/merge-gate.js`.

It does not claim a universal merge algorithm for arbitrary software, filesystems, databases, binary assets, or world states.

## Flow

`lane receipts / candidates -> merge plan -> explicit commit gate -> merge receipt -> optional rollback`

Planning and committing are separate operations.

Creating a merge plan does not mutate state.

## Candidate predicates

The default v0.2 plan requires every candidate to:

- bind to the exact declared `stateRef`;
- have a mergeable status if a status is supplied;
- report no failures;
- carry `COMMIT-CANDIDATE` authority;
- provide at least one evidence reference;
- provide at least one test result and have every declared test pass;
- propose at least one supported state change.

Callers may add explicit custom predicates. Their pass/fail results are recorded in the plan.

A rejected candidate remains visible in the decision receipt.

## Supported change grammar

v0.2 deliberately supports a small JSON-state grammar:

- `set` a value at a dot-separated object path;
- `delete` an existing value at a dot-separated object path;
- optional `precondition.exists`;
- optional `precondition.value`.

Values must be JSON-compatible and finite.

Prototype-sensitive path segments such as `__proto__`, `prototype`, and `constructor` are rejected.

The current path engine descends through plain objects. It can replace an array as a value, but does not treat array indices as a generic mutable path grammar.

## Conflict model

The merge planner detects:

- incompatible writes to the same path;
- parent/child overlap where operation order would affect the result;
- incompatible overlapping operations inside one candidate.

Identical operations against the exact same path may coalesce. Their source candidates remain attached to the single resulting operation.

The default conflict policy is `hold-run`: any eligible conflict prevents a commit.

An explicit `merge-nonconflicting` policy may commit independent accepted candidates while holding conflicting candidates unresolved.

No conflict is resolved by latest-writer-wins, majority vote, averaging, or model rank.

## Deterministic plan

Candidate IDs and resulting operations are ordered deterministically.

The plan receives a content-derived `planId`. The public commit gate recomputes that identity before committing, so accidental or unacknowledged mutation of the plan after planning is refused.

This is an **integrity check, not cryptographic authentication**. It contains no secret and should not be described as protection against an attacker who controls the process and can deliberately recompute hashes.

## Commit

`commitMerge(...)` checks:

1. public plan integrity;
2. exact `currentStateRef === plan.stateRef`;
3. that the plan is commit-eligible;
4. every declared operation precondition while mutating a clone;
5. source and resulting state hashes.

The caller's input state object is not mutated in place.

The commit returns:

- resulting state;
- resulting state reference;
- merge receipt;
- rollback token.

## Rollback

The v0.2 harness stores the complete pre-merge JSON state snapshot inside the rollback token.

Before rollback, the public gate verifies token integrity and the engine verifies that the current state's content hash still matches the exact state produced by the commit.

If later state drift is detected, rollback is refused rather than silently erasing later work.

This proves reversible in-memory JSON-state transitions in the current harness.

It does **not** yet prove persistent rollback for large or external state. Production-scale use should replace inline snapshots with durable content-addressed snapshot references or another explicit rollback store.

## State-reference boundary

`stateRef` is an externally supplied identity.

The merge fabric enforces exact reference equality, but v0.2 does not prove that every caller's `stateRef` is itself content-addressed or impossible to reuse incorrectly.

For stronger bindings, callers should use content-addressed state references and/or operation preconditions. The commit receipt additionally records actual SHA-256 hashes of the source and resulting JSON state.

## Current observed harness predicates

Tests cover:

- stale state candidate rejection;
- failed-test rejection;
- missing-evidence rejection;
- reported-failure rejection;
- missing-authority rejection;
- same-path conflict hold;
- parent/child conflict hold;
- identical proposal coalescing;
- deterministic operation order;
- successful multi-candidate commit;
- operation precondition refusal;
- exact rollback;
- rollback refusal after post-merge drift;
- merge-plan tamper refusal at the public gate;
- rollback-token tamper refusal at the public gate;
- optional nonconflicting partial merge while conflicts remain traceable.

## Still unresolved

- durable checkpoint / rollback storage;
- clone-body integration;
- source-code-aware semantic merge;
- filesystem merge adapters;
- database transaction adapters;
- automatic conflict repair;
- human-gate protocol for value-governed decisions;
- real-workload benchmarks comparing sequential and parallel creation/optimization;
- adversarial authorization/authentication beyond deterministic integrity checks.
