# AXM Parallel Capability Fabric — Agent Working Contract

This repository develops the AXM Parallel Capability Fabric as a focused, reusable deterministic infrastructure layer.

## Core working rule: one chat = one lane

Each active AI chat/session gets exactly **one implementation lane** in this repository.

A lane consists of:

- one branch;
- one primary pull request;
- one coherent workstream;
- continued commits to that same branch/PR for the lifetime of the chat.

Do **not** create extra sibling branches or PRs from the same chat merely because the task changes, expands, or enters a new phase.

If the current lane can continue safely, continue it.

A new lane is allowed only when:

1. a genuinely separate chat/session begins;
2. the current lane is explicitly retired/replaced by the human maintainer; or
3. repository state makes continuation impossible and the reason is recorded.

When a lane must be replaced, record the previous branch/PR and why replacement was necessary. Never silently abandon it.

### Lane naming

Prefer:

`chat/<lane-number>-<short-direction>`

Example:

`chat/1-parallel-fabric-bootstrap`

The first working chat for this repository owns **Lane 1**.

## Scope protection

This repository is for the Parallel Capability Fabric itself.

Do not turn it into:

- Discovery Buddy;
- Grammar Glass;
- Walmi;
- a general AXM monorepo;
- a persistent multi-agent framework.

Those systems may later consume this fabric, but their unrelated implementation stays outside this repository.

## Source truth discipline

Keep these categories separate in code, docs, tests, receipts, and PR descriptions:

### OBSERVED
Directly demonstrated by implementation, tests, measurements, or preserved source evidence.

### INTERPRETATION
A reasonable architectural consequence of observed evidence.

### PROPOSAL
A direction to build or test that is not yet demonstrated.

Never silently upgrade a proposal into an observed or verified capability.

Avoid words such as `best`, `verified`, or `complete` unless the exact predicate is defined and satisfied.

`Selected` means selected under declared current metrics, not universally superior.

## Architectural roots

The fabric exists to coordinate bounded independent work while preserving truth, control, attribution, and reversibility.

Default shape:

`request/state -> decompose -> assign bounded lanes -> execute -> lane receipts -> verify -> contradiction/conflict pass -> deterministic merge -> checkpoint -> result/next cycle`

Parallelism alone is not intelligence.

The useful capability is the coordination grammar around parallel work.

## Authority model

Same body does not mean unlimited authority.

Every lane must have an explicit authority class. Preserve the founding source names:

- `READ`
- `PROPOSE`
- `WRITE-SANDBOX`
- `COMMIT-CANDIDATE`
- `OBSERVE`
- `EXECUTE-TOOL`

A lane may never silently gain:

- merge authority;
- wider filesystem authority;
- deployment authority;
- learning-promotion authority;
- hidden state mutation authority;
- permissions inherited from another lane.

Coupled reasoning does not imply shared execution authority.

## Merge rule

No silent merge.

Parallel output must not be merged by:

- latest writer wins;
- majority vote by default;
- averaging contradictions;
- concatenating everything;
- letting the most capable model decide without predicates.

Merge decisions should be evidence-bound and use explicit predicates such as schema compatibility, tests, state version, conflict checks, dependencies, evidence, authority, reversibility, declared quality metrics, and human gates where required.

Preserve rejected or contradictory candidates when they are useful for lineage, diagnosis, learning, or later comparison.

## Failure and contradiction rule

Failures, unknowns, assumptions, and contradictions are first-class outputs.

Do not hide a failed lane by silently substituting another lane or model call.

Do not average contradictions away.

## Resource rule

Do not parallelize automatically.

Use bounded parallel work only when dependencies allow it, shared-state conflicts are controlled, resource budget allows it, outputs have a merge contract, receipts are preserved, and parallel work materially helps speed, coverage, diversity, or verification.

Keep sequential execution when the task is tiny, strictly dependent, atomic, contention-heavy, already solved cheaply by one deterministic calculation, or when merge overhead would exceed the benefit.

## Temporary hands over unnecessary agents

A lane may simply be:

`work contract + capability + input state + output receipt`

Do not turn every lane into a persistent autonomous agent.

Spawn only the temporary capability/hands required by the task.

## Protected-main discipline

Experimental mutation belongs in the chat lane or disposable clones, not directly on protected main after bootstrap governance exists.

Prefer:

`main body protected -> candidate/clone lane -> tests -> receipts -> explicit merge gate`

Safety should come primarily from isolation, reversibility, provenance, tests, and merge authority rather than blocking all useful work.

## Test discipline

Every claimed capability needs a predicate and evidence.

At minimum, tests should eventually cover:

- lane cap enforcement;
- actual concurrent execution;
- deterministic result ordering;
- dependency scheduling;
- pause/resume/cancel behavior;
- no duplicate completed work after resume;
- state-version binding;
- conflict detection;
- resource bounds/backoff;
- failed candidate merge rejection;
- evidence requirement for accepted candidates;
- rollback behavior;
- AI/model lane authority containment;
- interface compatibility for parallel creation outputs;
- traceability of losing candidates;
- no false claim that same-model lanes are independent scientific review.

## Repository continuity

Preserve the active direction. Improve incrementally rather than rebuilding from scratch unless the current design is disproven or the maintainer explicitly requests a reset.

When work stops, leave a concise receipt describing:

- branch/lane;
- current capability status;
- tests run;
- observed evidence;
- unresolved gaps;
- next smallest grounded step.
