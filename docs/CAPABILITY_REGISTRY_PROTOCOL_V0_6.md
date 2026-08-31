# Capability Registry / Body-Map Intake Protocol v0.6

## Status

**IMPLEMENTED / TESTED IN THE CURRENT NODE HARNESS**

This contract defines the first reusable cross-repository intake protocol for the AXM Parallel Capability Fabric.

It is deliberately split into two layers:

1. **portable structural advertisement** using JSON-compatible manifests;
2. **local executable binding** of declared executor/test references to runtime functions.

Importing an advertisement does **not** execute foreign code and does **not** grant authority.

## Why the split exists

A repository may truthfully advertise:

- what capability it claims to provide;
- which body areas it intends to touch;
- which authorities it requests;
- its declared resource cost;
- its dependencies;
- evidence references;
- test references;
- an executor reference;
- source/provenance labels.

Those statements are useful for deterministic planning, but they are not equivalent to trusting executable code.

The v0.6 registry therefore treats a manifest as inert data until the current runtime separately binds the declared `executorRef` and every declared `testRef`.

This prevents the following unsafe shortcut:

`found manifest -> trust repo -> execute code`

The supported flow is instead:

`portable manifest -> validate/hash -> registry receipt -> local binding decision -> resolve -> decomposition -> Creation Fabric -> integration -> explicit protected merge`

## Recommended portable file

An external AXM repository may expose a file named:

`axm-capability-registry.json`

The filename is a convention, not a magic discovery mechanism in v0.6.

The current fabric does **not** crawl repositories or fetch these files automatically. A caller or later adapter must deliberately supply the bundle to the registry.

## Bundle schema

Bundle schema:

`axm.parallel-capability-registry-bundle/v0.6`

Shape:

```json
{
  "schema": "axm.parallel-capability-registry-bundle/v0.6",
  "capabilities": [],
  "bodyMaps": []
}
```

A mixed bundle may contain valid and invalid advertisements.

`CapabilityRegistry.ingestBundle(...)` preserves a receipt with:

- accepted entries;
- exact/idempotent re-intakes;
- rejected entries and reasons;
- registry snapshot before intake;
- registry snapshot after intake.

A malformed advertisement does not silently erase valid entries from the same bundle.

## Capability manifest

Schema:

`axm.parallel-capability-manifest/v0.6`

Required structural concepts:

- `id`: stable capability identity inside a registry;
- `version`: declared capability version;
- `sourceRef`: declared source/provenance label;
- `executorRef`: symbolic reference to the executable implementation;
- `role`: role label used by the Creation Fabric;
- `pressure`: declared solution pressure/direction;
- `provides`: exact requirement tokens supplied to the v0.5 decomposition grammar;
- `dependsOn`: other capability ids required before this capability;
- `targetAreas`: body-map area ids the capability intends to modify;
- `authority`: requested authority classes;
- `resources`: declared scheduler resource requirements;
- `inputRefs`: declared input lineage;
- `evidenceRefs`: evidence/provenance references;
- `testRefs`: symbolic references to required candidate tests;
- `priority`: deterministic decomposition priority;
- `metadata`: optional JSON-compatible metadata.

Example:

```json
{
  "schema": "axm.parallel-capability-manifest/v0.6",
  "id": "example.performance-tune",
  "version": "1",
  "sourceRef": "repo:example@sha256-or-ref:capabilities/performance",
  "executorRef": "executor:example.performance-tune/v1",
  "role": "PERFORMANCE",
  "pressure": "fast",
  "provides": ["runtime.fast"],
  "dependsOn": [],
  "targetAreas": ["runtime-config"],
  "authority": ["WRITE-SANDBOX", "COMMIT-CANDIDATE"],
  "resources": { "workers": 1, "memoryMB": 128 },
  "inputRefs": ["benchmark:baseline"],
  "evidenceRefs": ["contract:performance-v1"],
  "testRefs": ["test:example.performance-tune/v1"],
  "priority": 10,
  "metadata": {}
}
```

## Body-map manifest

Schema:

`axm.parallel-capability-body-map-manifest/v0.6`

A body map defines where capabilities may operate and which authorities are available in each area.

Required concepts:

- `id`;
- `version`;
- `sourceRef`;
- `areas`;
- optional JSON-compatible `metadata`.

Each area declares:

- area `id`;
- dotted JSON-state `path`;
- explicit `allowedCapabilities` list;
- explicit `authorities` list.

Example:

```json
{
  "schema": "axm.parallel-capability-body-map-manifest/v0.6",
  "id": "example.body",
  "version": "1",
  "sourceRef": "repo:example@ref:body-map",
  "areas": [
    {
      "id": "runtime-config",
      "path": "runtime.config",
      "allowedCapabilities": ["example.performance-tune"],
      "authorities": ["WRITE-SANDBOX", "COMMIT-CANDIDATE"]
    }
  ],
  "metadata": {}
}
```

The body map does not grant a capability more authority than the rest of the system permits. v0.5 still computes:

`capability request ∩ body-area permission ∩ global constraints`

Authority is never widened to make a plan succeed.

## Manifest identity

Every normalized manifest receives a deterministic SHA-256 content identity:

- `capability-manifest:sha256:<hash>`;
- `body-map-manifest:sha256:<hash>`.

If a portable entry carries a `manifestId`, v0.6 recomputes the normalized content hash and rejects a mismatch.

This detects accidental or deliberate content drift **inside the supplied manifest object**.

It does not authenticate who authored the manifest.

## Registry snapshot identity

`CapabilityRegistry.snapshot()` returns:

`registry-snapshot:sha256:<hash>`

The snapshot identity depends only on the portable structural manifests and their deterministic manifest ids.

Runtime executor/test bindings do not change the snapshot id.

This is intentional: two runtimes can agree on the advertised structural registry while still having different local executable bindings or trust decisions.

## No silent manifest replacement

Registry ids are stable keys.

- exact same manifest + same id -> idempotent;
- same id + different manifest hash -> rejected `REGISTRY_ID_CONFLICT`;
- two different manifests with the same id inside one bundle -> rejected `DUPLICATE_ID_CONFLICT_IN_BUNDLE`.

There is no latest-writer-wins registry mutation in v0.6.

## Runtime binding

Portable manifests contain symbolic references only.

The current runtime must separately call:

- `registry.bindExecutor(executorRef, work)`;
- `registry.bindTest(testRef, test)`.

Silent rebinding of an existing reference to a different function is refused.

An exact repeat of the same local binding is idempotent.

### Important boundary

A runtime binding is local process state.

It is not exported inside the portable registry snapshot or bundle.

The registry does not serialize functions.

## Resolution

`registry.resolve(...)` chooses one body map and a capability set, closes declared capability dependencies, and produces:

- portable registry snapshot identity;
- body-map manifest identity;
- resolved executable capability descriptors;
- unavailable capability receipts.

Unavailable reasons include cases such as:

- missing capability manifest;
- missing executor binding;
- missing test binding;
- unavailable dependency.

Unknown body-map capability references are visible rather than silently ignored.

Resolution itself does not execute a capability.

## Registry-fed decomposition

`createRegisteredDecompositionPlan(registry, input)`:

1. resolves a body map and executable capability catalog;
2. passes the resolved catalog to the v0.5 deterministic decomposition grammar;
3. returns the normal decomposition plan plus the separate registry-resolution receipt.

The generated Creation Fabric candidate inputs carry:

- registry snapshot ref;
- capability manifest ref;
- existing declared input refs.

The v0.5 decomposition `planId` retains its original meaning as graph identity. v0.6 does not silently redefine that hash. Registry lineage is carried by the separate resolution receipt and task input refs.

## Registered creation

`runRegisteredCreation(...)` performs:

`registry resolve -> deterministic decomposition -> Creation Fabric`

It still stops at the normal protected-body merge gate.

A successful registry-fed creation returns `READY_FOR_EXPLICIT_COMMIT`; it does not modify the supplied protected body.

The caller must still make the separate `commitMerge(...)` call.

## What v0.6 tests demonstrate

The current Node harness tests:

- deterministic registry snapshots independent of manifest input order;
- local runtime binding does not alter portable snapshot identity;
- idempotent re-intake;
- refusal of conflicting same-id manifest replacement;
- partial mixed-bundle intake with rejection receipts;
- bundle round-trip preserving snapshot identity;
- manifest-id tamper detection;
- dependency closure during resolution;
- manifest and registry lineage reaching runtime descriptors;
- missing runtime bindings remain unavailable/inert;
- unknown body-map capability references are visible;
- silent executor/test rebinding is refused;
- registry-fed decomposition carries manifest/snapshot refs into candidate inputs;
- registry-fed Creation Fabric still stops at explicit protected commit;
- body-map authority restrictions still defeat an otherwise registered capability.

## Truth limits

v0.6 does **not** prove or provide:

- cryptographic author authentication;
- signed manifests;
- automatic verification that `sourceRef` points to truthful content;
- automatic GitHub/repository crawling;
- arbitrary capability discovery;
- downloading or executing code based only on a manifest;
- hostile-code sandboxing;
- remote code loading;
- universal package/plugin safety;
- semantic compatibility between independently authored capabilities;
- filesystem/source-tree/database capability execution;
- durable network registry service.

Manifest hashes and snapshot hashes are deterministic content identities, not signatures.

## External-repository adapter rule

A future repository adapter should keep three facts separate:

1. **what the foreign repository advertises**;
2. **what the adapter actually inspected/verified**;
3. **what local executable bindings the current runtime chooses to expose**.

An adapter should never silently transform a foreign advertisement into trusted execution authority.

Discovery Buddy is a natural first real external candidate for this protocol once its GitHub repository contract is available and inspected. No Discovery Buddy integration is claimed by v0.6 itself.

## Next grounded seam

Use one real external AXM repository as a read-only intake target, derive or add a portable registry bundle there, then build a local adapter that:

- verifies the advertised manifest against the repository source;
- records source refs and evidence;
- binds only explicitly approved local executor/test implementations;
- feeds the result through the v0.6 registry and v0.5 compiler;
- demonstrates one end-to-end external-organ creation or inspection cycle without granting the foreign repository hidden authority.
