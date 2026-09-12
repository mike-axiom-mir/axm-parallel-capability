# Real Theme Park runtime proof through Ignition

Status: **bounded interoperability proof** on the active Ignition runtime realization lane.

This document does not make Theme Park part of Parallel Capability Fabric. It records one concrete consumer proof for the generic optional adapter in `src/ignition-runtime.js`.

## Why this exists

The first Ignition runtime smoke proved selective materialization with small synthetic runtime bodies. That established the adapter contract, but it left one ecosystem question open: can the same boundary realize an existing AXM runtime package without giving that provider hidden authority over Parallel's protected body?

The answer tested here is intentionally narrow.

`tools/theme-park-ignition-runtime-smoke.mjs` binds the existing Theme Park headless package as a caller-supplied runtime body, then runs:

```text
Parallel requirement selection
  -> explicit executor binding
  -> Ignition materialize / execute / release
  -> Theme Park HeadlessSimulator
  -> bounded Theme Park summary projection on a disposable Parallel clone
  -> existing Parallel protected-body plan
  -> STOP before explicit commit
```

No automatic provider discovery, install, selection, execution, merge, release publication, or CANON action is added.

## Pinned provider contracts used by CI

The interoperability workflow pins two external provider heads explicitly:

- Ignition Fabric PR #7 head is supplied by `IGNITION_REF` in the workflow.
- Theme Park Simulator PR #5 head is supplied by `THEME_PARK_REF` in the workflow.

The Theme Park package must describe exactly the narrow contract consumed by this proof:

- capability schema `axm.capability/v1`;
- capability id `axm.theme-park.headless-simulator`;
- capability version `1.0.0`;
- implementation version `0.4.6`;
- Node runtime with minimum version 18;
- `networkRequired: false`;
- summary contract `axm.theme-park.headless-summary/v1`;
- canonical authority `false`.

Those checks are compatibility admission, not producer authentication. The Git ref recorded in output is caller-declared lineage; CI separately checks out that exact ref before packing the provider.

## What the proof does

The clean package-consumer test installs three local tarballs with npm offline mode:

1. `@axm/parallel-capability` from this exact PR head;
2. `axm-ignition-fabric` from its exact pinned provider head;
3. `axm-theme-park-simulator-local` from its exact pinned provider head.

The smoke registers two possible Theme Park runtime bindings but requests only one requirement. It then requires all of the following:

- only the selected Theme Park runtime is materialized;
- the idle Theme Park runtime is never materialized, executed, or released;
- the selected runtime is a real `HeadlessSimulator` created from the installed Theme Park package;
- materialized byte evidence is the byte length of that simulator's initial serialized save;
- the simulator advances exactly 60 deterministic game minutes;
- only a bounded summary projection is written to the disposable Parallel clone;
- the original protected body remains byte-for-byte JSON-equivalent to its starting snapshot;
- Ignition execution evidence passes the adapter's verifier;
- the materialized/executed/released capability sets contain exactly the selected Parallel binding;
- two fresh runs with the same Theme Park seed produce the same bounded Theme Park summary and the same Ignition result hash;
- the resulting creation reaches `READY_FOR_EXPLICIT_COMMIT`, but this proof never calls the public commit operation.

The projection records Theme Park provider identity, the exact CI-supplied source ref, seed, 60-minute before/after summaries, and explicit `CLONE_PROJECTION_ONLY` authority with canonical mutation / merge / CANON all false.

## What this does not prove

This proof does not establish:

- that Parallel makes Theme Park faster;
- that arbitrary AXM runtimes satisfy this adapter;
- Theme Park browser/UI interoperability;
- save-file persistence or filesystem ownership;
- hostile provider-module sandboxing;
- cryptographic provider authorship;
- Windows/macOS behavior unless a future workflow runs those platforms;
- safe automatic discovery or installation;
- permission to commit the resulting candidate;
- merge or CANON authority.

It proves one concrete thing: an already-existing local AXM runtime package can be selected by Parallel, materialized only when selected by Ignition, executed inside the bounded runtime binding, and reduced to evidence plus a disposable clone proposal without mutating the protected source body.

## Continuation boundary

A later consumer can reuse the generic `ignition-runtime` adapter with another real runtime only if its own provider contract and authority boundary are explicitly admitted. Do not turn this example into a mandatory AXM runtime catalog or generic SDK. Concrete integrations should justify each additional binding.
