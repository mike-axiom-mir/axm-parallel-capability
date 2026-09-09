# Discovery Index Consumer Contract v0.1

## Purpose

The Parallel Capability Fabric can now consume the deterministic `axm.discovery-index/v0.1` output produced by AXM Discovery Buddy as **planning evidence** without turning discovery metadata into executable capability authority.

The bridge is intentionally one-way and static:

`repo capability declarations -> Discovery Buddy index -> Parallel Capability discovery receipt`

It does not import provider code, bind an executor, install a package, select a winner, mutate protected state, merge anything, or make Discovery Buddy a runtime dependency.

## API

The package exposes a narrow optional subpath:

```js
import {
  createDiscoveryRequirementReceipt,
  validateDiscoveryIndex
} from '@axm/parallel-capability/discovery-index';
```

`validateDiscoveryIndex(index)` independently recomputes Discovery Buddy's content SHA-256 over its schema, scan policy, and repository records. It also verifies retained capability records still point to an indexed source ledger and that source record counts match the retained rows.

`createDiscoveryRequirementReceipt(index, { requirements })` matches exact capability IDs and returns deterministic candidate declarations. Each candidate retains repository identity, provider/consumer declarations, declared status, source path, line number, and a digest-bound evidence reference.

## Authority boundary

A match means only **a declaration was discovered**.

Every candidate is emitted with:

- `declarationOnly: true`
- `runtimeVerified: false`
- `executionAuthority: "NONE"`

The receipt-level authority also explicitly denies execution, selection, installation, merge, and CANON authority. A later caller must separately verify provider/runtime compatibility and bind any executable capability through the fabric's existing registry/evidence gates.

This prevents the cross-repo index from becoming a hidden scheduler or a new central authority.

## Compatibility evidence

The dedicated CI lane pins AXM Discovery Buddy at commit `1a94fc2481d1cfc9234dea7c86af4777126d3924`, creates two disposable Git repositories with a shared capability declaration, runs the real Python scanner to produce `local-discovery.json`, then feeds that exact output into this JavaScript adapter.

The smoke test asserts that the declared provider is discoverable while execution authority remains absent. Unit tests additionally cover public and local indexes, digest tampering, detached source lineage, and source-record count drift.

The pinned Discovery Buddy commit is a tested contract reference, not a package dependency. Updating that pin should be an explicit compatibility decision with evidence.
