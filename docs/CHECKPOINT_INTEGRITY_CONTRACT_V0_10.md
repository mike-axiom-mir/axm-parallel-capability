# Checkpoint Integrity Contract v0.10

## Problem

The v0.1 scheduler checkpoint matched only `runId` and `stateRef`. Reusing those labels with a changed task graph, authority, resource contract, input reference, or goal could restore outputs produced by a different plan. The checkpoint also had no content identity binding its completed outputs and receipts.

## v0.2 contract

A checkpoint now carries:

- `runId` and canonical `stateRef`;
- a caller-owned `checkpointRef` identifying the execution/implementation revision;
- `specFingerprint`, a SHA-256 identity for the normalized structural run specification;
- completed task state, output, and receipt payloads;
- `checkpointId`, a SHA-256 integrity identity for all checkpoint content above.

Resume applies no state until every outer binding and the checkpoint integrity identity pass. Restored entries must reference known tasks exactly once, have reusable states, and carry receipts whose run/task/state lineage matches the current run.

`COMPLETED_AFTER_CANCEL` is intentionally not reusable. A non-cooperative task may still return after the caller cancels a run; its late output and receipt remain visible as evidence in that run, but checkpoint export excludes them and checkpoint admission rejects them. A later run must execute that task again under current authority instead of reviving work completed after cancellation.

The structural fingerprint covers task order, ids, lane/capability ids, dependencies, authority, resource declarations, input refs, the goal, state/rollback refs, resource budget, and `checkpointRef`. Executable JavaScript functions are deliberately not serialized or claimed to be cryptographically identified.

## Caller duty

Checkpoint reuse requires an explicit `checkpointRef`. The caller must change it whenever task implementation semantics or hidden inputs change. A state hash, commit SHA, capability manifest id, build id, or similarly exact revision is preferable to a human label.

Runs without a checkpoint remain usable when `checkpointRef` is absent. They still emit v0.2 checkpoint material, but that material cannot be reused until the originating spec has an explicit execution revision.

## Migration

v0.1 checkpoints fail closed. Their missing plan identity cannot be inferred without inventing provenance. Rerun the work once with an explicit `checkpointRef` to produce a v0.2 checkpoint.

## Truth boundary

SHA-256 here provides deterministic content identity and accidental/tamper detection inside the declared process boundary. It is not a signature, author authentication, secure storage, hostile-code isolation, or proof that a caller-supplied `checkpointRef` is truthful.
