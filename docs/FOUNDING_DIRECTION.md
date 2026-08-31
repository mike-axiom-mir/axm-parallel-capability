# Founding Direction

**Source:** `AXM_PARALLEL_CAPABILITY_FABRIC_NEW_FINDING_BUILDER_HANDOFF.txt`, supplied 2026-08-30.

This file is a source-grounded intake summary for repository work. It does not replace the complete handoff and does not promote proposals into observed capabilities.

## Observed before this repository

The handoff records that Discovery Buddy v1.12 already demonstrated a bounded parallel scanner with:

- multiple bounded Worker lanes;
- concurrent independent file jobs;
- read-only target authority;
- deterministic scan outputs;
- checkpointing;
- pause/resume/cancel;
- checkpoint reuse;
- source-integrity hashing;
- fallback when Worker execution fails;
- target memory/history.

The handoff also records a **synthetic** scheduler test of 80 mock file jobs:

- one lane: about 980 ms;
- four lanes: about 245 ms;
- max observed active workers: 4;
- synthetic speedup: about 4.01x.

The source explicitly limits this claim: it demonstrates bounded concurrent scheduling in that implementation, not 4x production performance on real disks, browsers, AXM trees, CPUs, or arbitrary workloads.

## Architectural finding

The general pattern exposed by Discovery Buddy is:

`split work -> run independent bounded lanes -> bind lanes to explicit inputs/state -> produce receipts -> merge only through explicit rules -> checkpoint/rollback`

Parallelism itself is not intelligence. The reusable capability is the coordination grammar around parallel work.

## Proposed reusable technology

Working name:

**AXM Parallel Capability Fabric**

Proposed generic flow:

`request/state -> decompose -> assign lanes -> bounded parallel work -> lane receipts -> verify -> contradiction/conflict pass -> deterministic merge -> checkpoint -> result/next cycle`

The scanner is intended to become the first organ using the reusable pattern, not the permanent location of the generic implementation.

## Required run concepts

The source proposes that generic runs should preserve:

- run ID;
- request/goal;
- exact shared-state snapshot/reference;
- lane plan and responsibilities;
- allowed inputs and outputs;
- resource budget;
- authority boundary;
- lane receipts;
- evidence, assumptions, unknowns, contradictions, failures;
- test results;
- proposed changes;
- merge receipt;
- resulting state/version;
- rollback target.

**No silent merge.**

## Authority classes proposed by the handoff

- `READ`
- `PROPOSE`
- `WRITE_SANDBOX`
- `COMMIT_CANDIDATE`
- `OBSERVE`
- `EXECUTE_TOOL`

Same body does not mean unlimited write authority.

## Important selection / merge boundary

The source rejects default merge strategies such as:

- concatenate everything;
- majority vote by default;
- latest writer wins;
- average contradictions;
- let the strongest model decide without evidence-bound predicates.

Candidate selection and future merge should instead be governed by explicit predicates such as schema, tests, state version, conflict, dependencies, evidence, authority, rollback, quality metrics, and human gates when decisions are explicitly human-governed.

## Temporary hands, not agent inflation

A lane may simply be:

`work contract + capability + input state + output receipt`

The system should spawn only what the task needs. Persistent agents are not required for every parallel capability.

## Source build order

1. extract generic scheduler/resource/receipt/checkpoint behavior;
2. generic dependency task graph;
3. merge fabric;
4. clone-body candidates and integration clone;
5. Creation Fabric use;
6. Grammar Glass candidate generation/survivor testing;
7. Walmi temporary specialists/hands;
8. software/game/world engines.

## Truth boundary at repository birth

The handoff marks these as **not yet proven as a generic fabric** at the time this repository starts:

- generic arbitrary capability spawning;
- general task graph;
- generic deterministic merge fabric;
- parallel code creation;
- parallel asset creation;
- Walmi autonomous specialist spawning through this fabric;
- game/world-engine orchestration through this fabric;
- innovation improvement from Grammar Glass parallel candidates;
- production-scale performance across AXM software.

Repository tests may move individual items into an implementation-observed category, but only under the exact predicates those tests demonstrate.

## Initial builder target

The founding handoff asks the first generic implementation to include:

- bounded parallel lanes;
- task IDs/run IDs;
- dependencies;
- resource budgets;
- lane receipts;
- checkpoints;
- pause/resume/cancel;
- deterministic result ordering;
- contradiction/conflict reporting;
- merge candidates;
- rollback references;
- temporary work contracts/hands rather than mandatory persistent agents.

It also asks for at least three demonstrations:

1. parallel deterministic calculation;
2. parallel software inspection;
3. candidate generation plus deterministic selection.

Failures and contradictions must remain first-class outputs.
