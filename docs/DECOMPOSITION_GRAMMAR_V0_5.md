# Deterministic Decomposition Grammar v0.5

## Status

**IMPLEMENTED / TESTED IN THE CURRENT NODE HARNESS**

v0.5 adds a deterministic compiler between an explicit creation goal and the v0.4 `CreationFabric` runtime.

It does **not** claim general natural-language understanding, autonomous planning, arbitrary capability discovery, or universally correct task decomposition.

The executable decomposition grammar is deliberately explicit.

## Flow

`explicit goal grammar + body map + capability catalog + constraints`

`-> deterministic eligibility pass`

`-> required-token coverage`

`-> optional explicit diversity slots`

`-> dependency closure`

`-> authority/resource/body-scope checks`

`-> deterministic candidate order`

`-> CreationFabric spec`

`-> bounded clone execution / integration / protected-body plan`

`-> explicit commit only`

## Goal grammar

A v0.5 goal contains:

- `id`
- human-readable `summary`
- explicit requirement records `{ id, token, required }`
- optional exploration records `{ token, extraProviders, distinctPressure }`
- explicit integration tests

The summary is descriptive. Requirement tokens drive executable decomposition.

An arbitrary free-text sentence is not silently converted into executable requirements by this deterministic layer.

## Capability catalog contract

A capability descriptor declares:

- `id`
- `executorRef`
- `role`
- `pressure`
- `provides` requirement tokens
- explicit capability dependencies
- target body-area ids
- requested authority classes
- resource requirements
- evidence refs
- domain tests
- priority
- executable `work(context)`

`executorRef` is included in structural plan lineage. It is a declared executor/version reference, not cryptographic proof of code identity.

Capabilities missing evidence or domain tests are not eligible for v0.5 executable creation plans.

## Body-map contract

Each body area declares:

- `id`
- dotted state `path`
- explicit `allowedCapabilities`
- allowed authority classes

No wildcard body permission is assumed.

Effective candidate authority is the intersection of:

1. capability-requested authority
2. body-area authority for every target area
3. global allowed authority constraints

The compiler never widens authority to make a graph executable.

By default, an executable merge candidate must retain both `WRITE-SANDBOX` and `COMMIT-CANDIDATE` through that intersection.

## Deterministic coverage rule

Required goal tokens are covered using a deterministic greedy rule:

1. prefer the eligible capability covering the most currently uncovered required tokens
2. tie-break by higher declared priority
3. final tie-break by capability id

This is a reproducible heuristic, not a proof of globally minimal or optimal decomposition.

## Explicit diversity

Diversity is opt-in through goal exploration records.

Example:

`{ token: 'performance', extraProviders: 1, distinctPressure: true }`

This may add another eligible provider with a different declared solution pressure.

v0.5 does not invent exploration pressure on its own.

## Dependencies

Selected capability dependencies are closed recursively.

The resulting candidate graph is topologically ordered when acyclic.

CreationFabric v0.4 was extended so generated candidate dependencies become scheduler dependencies. A downstream capability receives completed dependency candidate receipts in:

`dependencyCandidates`

Dependency clone state is **not automatically applied** to the downstream clone. The downstream capability receives the receipt/evidence and still works from the protected source snapshot. Final compatible state changes meet later in the integration clone.

A dependency cycle becomes an unresolved decomposition hold instead of reaching the scheduler.

## Scope enforcement

The compiler generates a `decomposition-scope-boundary` test for every selected capability.

After clone work, the source-to-clone diff must remain inside one of the capability's body-map target paths.

A callback can still attempt an out-of-scope mutation inside its disposable copy, but that candidate fails the generated scope test and cannot survive the normal merge predicates.

This is a candidate gate, not hostile-code sandboxing.

## Resource policy

The decomposition constraints declare the scheduler resource budget.

A capability is ineligible when it requests:

- more of a declared resource than the run allows; or
- a resource class not declared in the budget.

The compiler does not silently increase the budget to fit a desired capability.

## Holds before execution

The compiler can return `HOLD_UNRESOLVED` before any CreationFabric run for conditions including:

- uncovered required token
- unavailable selected dependency
- dependency cycle
- maximum candidate count exceeded
- missing integration tests

Rejected capability reasons are preserved in the plan.

## Structural plan identity

The plan receives a deterministic SHA-256 `planId` over structural metadata including:

- goal grammar
- body-map permissions
- non-executable constraints
- selected capability metadata
- declared `executorRef` values
- coverage
- rejection reasons
- unresolved items

Executable JavaScript functions are not hashed as code identity.

Therefore the v0.5 `planId` is a deterministic structural lineage identifier, not authentication and not a cryptographic guarantee that callback implementation bytes match `executorRef`.

## What the current tests demonstrate

The v0.5 test set demonstrates:

- plan identity/order remains deterministic across reordered capability and body-area input
- a multi-token provider can satisfy multiple uncovered requirements in one selected candidate
- explicit diversity can add a distinct solution pressure
- dependency closure produces a scheduler-compatible topological graph
- downstream candidate work can inspect dependency candidate receipts
- uncovered requirements hold before execution
- body authority cannot be widened by decomposition
- undeclared/over-budget resources reject a capability before scheduling
- generated scope tests reject out-of-scope clone mutations
- dependency cycles hold before scheduling
- candidate-count limits include dependencies and exploration additions
- missing integration verification holds before execution
- a successful decomposed creation still stops at the explicit protected-body merge gate

## Truth limits

v0.5 does not yet provide:

- free-text goal parsing into trusted executable requirements
- semantic inference of which capability should exist
- automatic invention of missing capabilities
- discovery of arbitrary installed tools/functions
- learned capability ranking
- optimal set-cover proof
- semantic source-code decomposition
- filesystem or database mutation adapters
- hostile-code sandboxing
- autonomous deployment or merge authority

## Next grounded seam

The next strong direction is a **capability registry / body-map intake protocol** so external AXM organs, Discovery Buddy, Grammar Glass, local pages, and later Walmi can advertise capabilities through a common deterministic descriptor instead of hand-building one catalog per run.

A later model or Grammar Glass layer may propose goal requirements or novel candidate structures, but those proposals should enter this deterministic compiler as explicit inputs rather than bypassing its authority, scope, resource, test, and merge gates.
