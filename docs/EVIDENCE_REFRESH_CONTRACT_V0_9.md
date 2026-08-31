# Evidence Refresh / Reverification Contract v0.9

## Status

Implemented and tested in the Node harness of this repository.

This contract does not replace earlier evidence. It links two already integrity-checked v0.8 GitHub evidence collections and recomputes the same v0.7 claim grammar against both endpoints.

## Purpose

Evidence changes over time. A source tree can appear, disappear, change content, gain or lose a successful exact-head test run, or move while evidence is being collected.

v0.9 records those changes without rewriting yesterday's truth.

Flow:

`previous v0.8 collection -> previous v0.7 claim state`

`next v0.8 collection -> next v0.7 claim state`

`both endpoints -> deterministic observation diff -> explicit claim transitions -> integrity-bound refresh receipt`

## Public API

```js
createEvidenceRefreshReceipt({
  previousCollection,
  nextCollection,
  adapterId,
  claims,
  requireStableRef = true,
  now
})
```

Additional helpers:

- `assertEvidenceRefreshReceipt(receipt)`
- `getClaimTransition(receipt, claimId)`

## Source lineage rules

Both collections must:

- independently pass the v0.8 collection integrity check;
- point to the same repository;
- point to the same named ref.

Different repositories or different named refs are different lineage operations and are rejected by this v0.9 grammar.

The receipt preserves both endpoints:

- collection id;
- collection status;
- pinned head SHA;
- source ref;
- freshness state;
- regenerated v0.7 external-source receipt id.

`previous` and `next` ordering is supplied by the caller. v0.9 does not independently prove wall-clock chronology.

## Claim recomputation

The same claim definitions are applied to both collections through the existing v0.8 -> v0.7 bridge.

v0.9 does not manually assign claim statuses.

Examples of explicit transitions:

- `HOLD_SOURCE_INCOMPLETE->SOURCE_VERIFIED`
- `SOURCE_VERIFIED->HOLD_SOURCE_INCOMPLETE`
- `SOURCE_VERIFIED->SOURCE_CONTRADICTED`
- `SOURCE_VERIFIED->SOURCE_VERIFIED`

A newer collection is not assumed to be better.

## Observation diff

Every observation id in the union of both collections receives one change state:

- `ADDED`
- `REMOVED`
- `CHANGED`
- `UNCHANGED`

The transition records:

- previous / next status;
- previous / next evidence basis;
- previous / next evidence refs;
- hashes of previous / next details objects;
- whether status, basis, or evidence changed.

The full source observations remain recoverable through the preserved collection ids rather than being silently flattened into one replacement snapshot.

## Transition summary

The refresh receipt includes deterministic counts plus convenience sets for:

- newly verified claims;
- previously verified claims that are no longer verified;
- newly introduced contradictions;
- cleared contradictions.

These labels summarize the v0.7 statuses. They do not grant runtime or merge authority.

A next endpoint becoming `SOURCE_VERIFIED` still only means it may pass the v0.7 manifest-promotion gate. Foreign code remains inert until a separate local v0.6 runtime binding decision.

## Stable-ref policy

By default `requireStableRef` is true at both endpoints because the v0.8 bridge adds the ref-stability requirement.

An explicitly historical comparison may set:

```js
requireStableRef: false
```

The moved-ref fact remains present in each endpoint's freshness metadata. Disabling the gate does not erase it.

## Integrity

Refresh receipts use:

`axm.parallel-capability-evidence-refresh-receipt/v0.9`

and deterministic ids:

`evidence-refresh:sha256:<hash>`

The hash covers source identity, policy, both lineage endpoints, observation transitions, claim transitions, and summary. `completedAt` is not part of content identity.

Post-creation mutation causes `assertEvidenceRefreshReceipt(...)` to fail.

## Discovery Buddy evidence boundary

The real Discovery Buddy v0.8 pinned snapshot used in the repository remains:

`1411d0666a1e2fbfe5f697df8b0bb4b72f31dbf2`

At that observed head the required scanner source remained absent and exact-head materializer success evidence was missing, so the real scanner claim remained `HOLD_SOURCE_INCOMPLETE`.

The v0.9 test suite explicitly compares an earlier staged Discovery snapshot with that v0.8 snapshot and records:

`HOLD_SOURCE_INCOMPLETE->HOLD_SOURCE_INCOMPLETE`

The `examples/evidence-refresh.js` demonstration uses that real current staged shape as its previous endpoint but uses a clearly labelled **simulated future materialized endpoint** to demonstrate what a future:

`HOLD_SOURCE_INCOMPLETE->SOURCE_VERIFIED`

transition would look like. The simulated endpoint is not live Discovery Buddy evidence.

## Test evidence

The first v0.9 attempt reached 99/100 tests. The one failure was a test-fixture error: the test mutated a completed v0.8 collection's repository field after hashing, so the lower v0.8 integrity guard correctly rejected it before the v0.9 cross-source predicate ran.

The fixture was repaired to create genuinely valid collections from a different repository/ref.

The corrected code-bearing run reached:

- 100 tests;
- 100 passed;
- 0 failed.

## Non-claims

v0.9 does not provide:

- proof that caller-supplied `previous`/`next` ordering is chronological;
- repository-owner authentication;
- automatic semantic understanding of source files;
- automatic capability promotion without the v0.7 predicates;
- foreign-code execution;
- runtime authority grant;
- protected-state merge authority;
- durable external evidence storage;
- repository crawling.

## Resulting chain

`read-only source collection -> integrity-checked pinned evidence -> claim state -> later pinned evidence -> claim recomputation -> explicit transition receipt -> optional verified manifest promotion -> local runtime binding -> decomposition -> Creation Fabric -> protected merge gate`
