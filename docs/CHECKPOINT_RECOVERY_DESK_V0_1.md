# Checkpoint Recovery Desk v0.1

Status: **EXPERIMENTAL / HOLD for human review**.

The Checkpoint Recovery Desk is a read-only human realization over the local checkpoint-file-store contract. It exists because an exact content-addressed checkpoint can be technically valid while still being difficult for a person to understand before choosing a deliberate resume path.

The bounded loop is:

`caller names exact checkpoint ID -> LocalCheckpointFileStore admits exact canonical bytes -> desk projects retained task evidence -> human can isolate attention -> caller copies exact ID -> scheduler still revalidates against the matching run specification`

The desk never scans a store, chooses `latest`, resumes a run, mutates scheduler state, exposes task output bodies, or grants merge/promotion/CANON authority. The generated HTML is self-contained and requires no account, network, cloud, or model.

## Command

```text
node scripts/checkpoint-recovery-desk.mjs --store <directory> --id <parallel-checkpoint:sha256:...> --out checkpoint-recovery.html
```

Both `--store` and `--id` are required. The exact ID is passed through `LocalCheckpointFileStore.get()` before any page is written. If storage admission fails, no recovery page is produced by the command.

## What the page exposes

- exact checkpoint, run, state, checkpointRef, and creation identities;
- retained task state plus lane/capability labels from existing receipts;
- counts of evidence references, test results, and proposed changes;
- a bounded attention signal for retained assumptions, unknowns, contradictions, or failures;
- an `ATTENTION ONLY` filter and exact-ID copy affordance;
- `RERUN REQUIRED` when `checkpointRef` is absent instead of implying reusable state;
- persistent `DISPLAY ≠ RESUME AUTHORITY` and local/offline truth boundaries.

Task output payloads are deliberately not rendered. The desk is for understanding recovery evidence, not inspecting arbitrary work products.

## Evidence boundary

A rendered `EXACT ID REQUIRED` state means only that the local file-store contract admitted the named checkpoint and the checkpoint records an explicit `checkpointRef`. It does **not** prove that a future run specification matches, authenticate authorship, grant permission to apply state, or bypass scheduler checkpoint admission.

The scheduler remains authoritative for runId, stateRef, checkpointRef, spec-fingerprint, known-task, reusable-state, and receipt-lineage checks at resume time.
