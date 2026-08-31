# External Source Adapter v0.7

## Status

**IMPLEMENTED / TESTED IN THE CURRENT NODE HARNESS**

This contract defines the first read-only external-organ verification layer on top of the v0.6 capability registry.

It deliberately separates:

1. what an external source **declares**;
2. what an adapter **observes** from a pinned source ref;
3. what execution evidence actually **passed or failed**;
4. what capability claim can therefore be promoted into the local registry.

An external repository is never executed merely because it exists or advertises a capability.

## Core flow

`external source -> pinned ref/head -> observations -> evidence bases -> claim predicates -> external-source receipt -> SOURCE_VERIFIED claim only -> portable v0.6 manifest -> local runtime binding -> registry resolution -> decomposition -> Creation Fabric -> explicit protected commit`

The external-source receipt does not grant authority.

## Evidence bases

v0.7 observations carry an explicit `basis`.

Current generic values used by the harness include:

- `OBSERVED_SOURCE`
- `EXECUTION_EVIDENCE`
- `DECLARED`

By default only `OBSERVED_SOURCE` and `EXECUTION_EVIDENCE` satisfy capability verification requirements.

This prevents a workflow file saying `npm test` from being silently treated as proof that the tests ran successfully.

A claim may explicitly allow a different evidence basis, but that exception must be visible in the claim contract.

## Claim states

### `SOURCE_VERIFIED`

Every required observation exists, has an accepted status, and uses an accepted evidence basis.

Only this state is eligible for `createVerifiedExternalCapabilityManifest(...)`.

### `HOLD_SOURCE_INCOMPLETE`

One or more required observations are missing, have a non-accepted status, or use an evidence basis that is not accepted by the claim.

The claim remains evidence. It is not silently rejected or upgraded.

### `SOURCE_CONTRADICTED`

A required observation contains an explicitly rejecting status such as `MISMATCH` or `CONTRADICTED`.

The contradiction is preserved in the receipt.

## Receipt integrity

`createExternalSourceReceipt(...)` produces:

`axm.parallel-capability-external-source-receipt/v0.7`

The receipt is content-bound through a deterministic SHA-256 `receiptId` over:

- adapter id;
- pinned source identity;
- normalized observations;
- evaluated claims.

Changing receipt contents after verification causes capability promotion to fail its integrity gate.

The hash is content integrity, not cryptographic author authentication.

## Advertisement versus execution

`createVerifiedExternalCapabilityManifest(...)` only creates the portable v0.6 capability advertisement.

It does not accept or import an executable callback from the foreign repository.

Executable work and test functions still require explicit local v0.6 registry bindings through:

- `bindExecutor(...)`
- `bindTest(...)`

Therefore:

**SOURCE_VERIFIED does not mean foreign code execution is trusted.**

It means the specific capability claim met its declared source-evidence predicates.

## Discovery Buddy: first real external source

v0.7 used the real public repository:

`mike-axiom-mir/axm-discovery-buddy`

The repository was inspected read-only.

### OBSERVED at the inspected refs

At the time of the v0.7 adapter run:

- `main` exposed only `LICENSE` and a short `README.md` at its root;
- work branch `axm/chat-agent-lane-rule-v1` existed;
- inspected branch head was `826d9a2b4e4003e45825a5fce4e08619677489d5`;
- that head commit message was `import: stage compact v1.14 chunk 011`;
- the branch contained staged import material rather than a normal materialized Discovery Buddy source tree;
- `IMPORT_STATUS.json` reported `required: 32`, `recovered: 5`, and 27 missing recovery items;
- `.repo-import/chunk-020` was not present when queried;
- the materialized `source/` tree required for scanner verification was not present at the inspected head.

### DECLARED by the import workflow

`.github/workflows/materialize-v114-import.yml` declares that materialization should:

- require exactly 21 numbered import chunks;
- reconstruct an archive;
- verify archive SHA-256 `6e86a0867f5f3e50d150870bafaef066ee6d99482d32d326e7df29ab6c71eac3`;
- extract the source;
- rebuild standalone/manifest outputs;
- run `npm test`;
- check expected source and lock files;
- replace the staging import tree with the materialized repository tree.

This is a declared verification procedure, not proof of successful execution.

### EXECUTION EVIDENCE

GitHub Actions run `33348471725`, `Recover and materialize Discovery Buddy v1.14`, completed with conclusion `failure`.

### v0.7 capability decisions

#### `discovery-buddy.scanner`

**`HOLD_SOURCE_INCOMPLETE`**

The scanner claim requires:

- materialized source tree present;
- successful recovery/materialization verification.

Those predicates were not satisfied at the inspected ref.

v0.7 therefore does **not** claim the Discovery Buddy scanner implementation has been source-verified through GitHub yet.

#### `discovery-buddy.import-status-observer`

**`SOURCE_VERIFIED`** for the narrow capability of projecting the observed repository/import state.

The verified evidence covers:

- pinned work branch/head present;
- `IMPORT_STATUS.json` present;
- `main` not containing the materialized source tree;
- the actual recovery Actions conclusion.

The local adapter can therefore expose those facts into local state.

It cannot inherit or claim the scanner implementation from that verification.

## First external-organ Creation Fabric cycle

The v0.7 harness demonstrates:

1. build a receipt from the pinned Discovery Buddy GitHub evidence;
2. keep `discovery-buddy.scanner` on hold;
3. promote only `discovery-buddy.import-status-observer` into a v0.6 manifest;
4. ingest the manifest while it remains inert;
5. bind a local observer executor and local test;
6. resolve through the registry;
7. compile through v0.5 decomposition;
8. run through v0.4 Creation Fabric;
9. receive `READY_FOR_EXPLICIT_COMMIT`;
10. keep the original protected body unchanged until the separate public merge call.

No Discovery Buddy repository code executes in this demonstration.

## Truth limits

v0.7 is not:

- automatic GitHub crawling;
- remote code execution;
- source-code semantic verification;
- cryptographic repository-owner authentication;
- proof that a declared provenance string is truthful;
- proof that a workflow will pass in the future;
- hostile-code sandboxing;
- a general package manager;
- automatic capability trust;
- automatic merge authority.

The current adapter receipt is constructed from evidence supplied by the read-only source adapter. A future GitHub adapter can automate evidence collection while preserving exactly the same separation between observation, declaration, execution evidence, and claim promotion.

## Promotion rule

A foreign capability should not become registry-executable merely because:

- a README names it;
- a workflow intends to test it;
- an archive claims to contain it;
- another AXM component remembers it;
- an AI infers it probably exists.

Promotion requires the capability-specific source predicates to pass, then a separate local runtime binding decision.

## Next grounded seam

When Discovery Buddy finishes materializing its real source tree, re-inspect a new pinned head and create a new external-source receipt.

Only if the real scanner source and execution evidence satisfy the scanner claim should `discovery-buddy.scanner` move from `HOLD_SOURCE_INCOMPLETE` to `SOURCE_VERIFIED`.

Separately, v0.8 can make the evidence collector itself reusable for GitHub repositories so source-file/hash/Actions observations can be populated automatically without changing the v0.7 trust model.
