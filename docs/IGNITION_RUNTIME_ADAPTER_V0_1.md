# Ignition runtime realization adapter v0.1

This optional adapter connects two existing AXM boundaries without making either
repository own the other:

`Parallel capability selection -> explicit executor binding -> Ignition materialization -> existing Parallel clone work`

Parallel Capability remains responsible for capability manifests, requirement
selection, dependency planning, clone-state work, tests, integration, and the
separate explicit protected-body commit gate. Ignition is used only to realize
and release the already selected local executor body.

## Why this seam exists

Ignition PR #7 exposes `axm.ignition.materialization-core` as a dependency-free
local npm tarball. Parallel Capability already has explicit runtime executor
bindings, but before this adapter an executor binding was only a direct function.
There was no executable proof that the fabric could keep multiple local runtime
bodies available while asking Ignition to materialize only the executor that
Parallel actually selected.

The adapter is therefore intentionally narrow. It does not replace the Parallel
registry, discover providers, translate Parallel dependency semantics into
Ignition dependencies, or make Ignition a mandatory runtime.

## Consumption

The adapter is an optional package subpath:

```js
import * as ignition from 'axm-ignition-fabric';
import { CapabilityRegistry } from '@axm/parallel-capability';
import { bindIgnitionExecutorSet } from '@axm/parallel-capability/ignition-runtime';

const registry = new CapabilityRegistry();
// Ingest reviewed Parallel manifests/body maps and bind tests first.

const receipt = bindIgnitionExecutorSet(registry, {
  ignition,
  providerSourceRef: 'reviewed-local-source-ref',
  bindings: [{
    executorRef: 'executor:terrain/v1',
    capabilityId: 'parallel.runtime.terrain',
    resourceEstimateBytes: 4096,
    materialize: async () => ({
      instance: { /* local runtime body */ },
      allocatedBytes: 1024
    }),
    release: async ({ runtime }) => {
      // bounded local cleanup
    },
    work: async ({ state, ignitionRuntime }) => {
      // This remains ordinary Parallel clone-state work.
      state.terrain.ready = Boolean(ignitionRuntime);
      return {};
    }
  }]
});
```

A missing or incompatible provider returns a bounded `HOLD` receipt and leaves
all executor refs unbound. An already occupied Parallel executor ref also causes
a preflight HOLD before any member of the requested set is bound, preventing a
partial mixed realization.

## Provider contract pinned by the adapter

The current adapter deliberately admits only the reviewed experimental package
contract from `mike-axiom-mir/axm-ignition-fabric` PR #7, exact head
`6defd4182a41fa226b4d8352d9186d5431634573`:

- capability id `axm.ignition.materialization-core`;
- capability version `0.6.0`;
- run receipt `axm.ignition-run/v0.05`;
- Node runtime, minimum version 18;
- no runtime network requirement;
- no runtime dependencies;
- no canonical or automatic-merge authority.

`providerSourceRef` is caller-declared lineage. The adapter records it but does
not authenticate authorship. Hosted interoperability CI separately checks out
the exact provider head before packaging it.

## Execution evidence

Every successful wrapped invocation requires the Ignition receipt to show one
and only one selected capability in all four sets: matched, materialized,
executed, and released. The adapter then attaches an
`axm.parallel-capability-ignition-execution/v0.1` receipt to the clone
candidate's metadata/evidence refs. Its deterministic SHA-256 binds the provider
contract, selected executor/capability identity, Parallel state identity,
materialized byte count, and provider result hash while omitting provider timing
observations.

That evidence means the declared runtime body crossed the reviewed local
materialization boundary for this invocation. It is not proof of authorship,
semantic correctness, safety, performance, or permission to commit protected
state.

## Authority boundary

The adapter grants **materialization evidence only**.

It does not automatically discover, install, select, execute, merge, publish,
release, or declare CANON. Parallel still executes only after its existing goal,
body-map, authority, resource, test, and scheduler paths admit the capability.
The protected body remains unchanged until the repository's separate explicit
commit path is called.

The integration intentionally does not add `axm-ignition-fabric` to package
dependencies. A caller must explicitly provide the local provider module.
