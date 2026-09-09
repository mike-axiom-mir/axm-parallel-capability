# Merge Receipt Integrity — v0.9 truth gate

## Problem

The protected merge gate already verified a merge plan before commit and issued an integrity-bound rollback token afterwards. The merge receipt between those two boundaries was not itself content-addressed.

That meant a stored or transported receipt could have its accepted/rejected candidate claims, conflicts, applied operations, state hashes, or timestamp changed while still looking like an ordinary `axm.parallel-capability-merge-receipt/v0.2` object. The canonical state was not changed by that receipt mutation, but audit evidence could drift away from what the merge gate actually emitted.

## Repair

`commitMerge()` now:

1. hashes the complete emitted merge receipt body into `receiptId`;
2. records that exact `receiptId` in the rollback token before the rollback token is sealed;
3. leaves merge execution and rollback state semantics unchanged.

`verifyMergeReceipt()` can then fail closed against any combination of:

- the receipt's own deterministic identity;
- a caller-pinned expected receipt identity;
- the exact source canonical state;
- the exact resulting canonical state;
- the integrity-bound rollback token and its merge lineage.

The caller-pinned identity matters when deliberate substitution is in scope: a newly resealed but different receipt is self-consistent, but it is not the receipt identity the caller previously accepted.

## Evidence boundary

This is deterministic integrity and lineage verification. SHA-256 is not a signature and does not authenticate who produced a receipt. A malicious actor who controls both the artifact and every trusted reference can manufacture a different internally consistent artifact. Consumers that need producer authentication must add a separate authenticated trust anchor.

The receipt remains evidence about one merge operation. It does not grant merge authority, promotion authority, deployment authority, or CANON status.

## Compatibility

The merge-plan schema, merge-receipt schema, rollback-token schema, merge execution semantics, and rollback execution semantics remain unchanged. Newly emitted rollback tokens carry the additive `mergeReceiptId` binding. Rollback does not require the receipt to be present, so recovery capability is not weakened if audit evidence is unavailable.

The new verifier is exposed from `src/merge-gate.js`. The repository root export is intentionally left untouched in this lane because an active independent PR owns `src/index.js`; this avoids silently taking over that lane. A later reconciliation may expose the verifier from the package root after that PR settles.
