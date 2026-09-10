# Local Checkpoint File Store v0.1

Status: **EXPERIMENTAL / HOLD for human review**.

This is a bounded persistence adapter for the scheduler checkpoint contract introduced by the checkpoint v0.2 lane. It does not create a second scheduler truth and it does not grant merge, promotion, deployment, or CANON authority.

## State boundary

Authoritative resume truth remains the existing `axm.parallel-capability-checkpoint/v0.2` object plus the scheduler's own admission checks.

The file store is only a durable local realization of that object:

`validated checkpoint v0.2 -> content-addressed local file -> load exact checkpoint id -> scheduler revalidates on resume`

The store never chooses a checkpoint for the caller. There is no mutable `latest` pointer and no last-writer-wins alias. A caller must supply the exact `parallel-checkpoint:sha256:<64 hex>` identity it intends to load.

## Write contract

`LocalCheckpointFileStore.put(checkpoint)`:

1. requires strict portable JSON values;
2. requires checkpoint schema v0.2;
3. recomputes the existing checkpoint SHA-256 before any write;
4. enforces a caller-configurable byte ceiling (8 MiB default);
5. requires the configured store root itself to be a real directory rather than a symbolic link;
6. writes canonical bytes to a private temporary file in the target directory;
7. fsyncs that file;
8. publishes it under its content hash with an atomic create-only hard link;
9. removes the temporary name;
10. attempts to fsync the directory and reports whether that durability step was available.

The final filename is derived only from the validated lowercase SHA-256 hex. Path-like caller input therefore never becomes a filesystem path.

A pre-existing symbolic link at the configured root path is rejected with `AXM_CHECKPOINT_STORE_ROOT_UNSAFE` before the adapter deliberately opens a checkpoint through that root. This prevents the ordinary configured-root alias case from redirecting checkpoint reads or writes into the symlink target.

If the exact final checkpoint already exists, it is re-read and reverified. A valid identical checkpoint is idempotent (`EXISTS`). A corrupt existing target fails closed and is **not** silently replaced or healed.

Different valid checkpoint identities coexist, so concurrent actors do not overwrite each other through a shared mutable name.

## Read contract

`get(checkpointId)` first requires the configured root itself to remain a real directory rather than a symbolic link, then reads only the exact content-addressed final filename. It rejects non-regular targets, oversized bytes, invalid JSON, unsupported schema, content/hash mismatch, requested/stored identity mismatch, and stored bytes that differ from the store's exact canonical UTF-8 JSON plus one LF terminator.

Semantically equivalent alternate whitespace/key ordering and duplicate-key JSON are held rather than normalized into trusted checkpoint storage. This binds the local storage representation to the same deterministic byte form produced by `put()`; it does not authenticate who wrote those bytes.

Abandoned temporary files are not candidates for resume and are ignored by exact-id reads. The scheduler still performs its existing run/state/checkpoint/spec/receipt-lineage validation when the loaded object is supplied to `start(..., { checkpoint })`.

## Storage receipt

A successful `put` returns `axm.parallel-capability-checkpoint-store-receipt/v0.1` with:

- `STORED` or idempotent `EXISTS` status;
- exact checkpoint identity and stored byte count;
- the content-addressed filename;
- `authority: STORAGE_ONLY`;
- file-fsync and directory-fsync evidence.

The receipt is operational evidence, not canonical scheduler state.

## Deliberate limits

This v0.1 adapter is local filesystem storage only. It does not provide:

- hostile-writer exclusion or cryptographic author authentication;
- ancestor-component no-follow containment, directory-handle/openat-style confinement, or protection against a root being swapped after the explicit root check;
- distributed consensus, shared-network storage, cloud backup, or account sync;
- automatic checkpoint discovery or `latest` selection;
- garbage collection or retention policy;
- repair of corrupt final files;
- cleanup guarantees for abandoned temp names after abrupt process exit;
- a package-root export while the repository's package/index surfaces are occupied by other active lanes;
- proof of power-loss durability on filesystems where directory fsync is unavailable.

The current implementation uses a same-directory hard-link publish step. Root-symlink rejection and the rest of this adapter's filesystem behavior are currently evidenced on the tested Linux/Node environment; portability beyond that remains unproven.

## Dependency

This lane must remain stacked on the exact checkpoint v0.2 head that supplies plan/content-bound scheduler checkpoints. Persisting the older v0.1 checkpoint contract would make stale resume state durable, so legacy checkpoint persistence is intentionally refused rather than migrated by this adapter.
