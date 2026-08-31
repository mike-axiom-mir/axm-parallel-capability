# GitHub Evidence Collector Contract v0.8

Status: implemented in Lane 1 Node harness.

## Purpose

v0.7 introduced an external-source truth gate, but its observations were supplied by the caller. v0.8 adds a reusable **read-only GitHub evidence collector** that converts a pinned repository/ref inspection into v0.7 observations without changing the v0.7 trust model.

The collector is not an autonomous GitHub crawler and it does not execute foreign repository code.

## Transport boundary

`collectGitHubEvidence(...)` receives an injected read-only client with three methods:

- `resolveRef({ repository, ref })`
- `getFile({ repository, headSha, path })`
- `listWorkflowRuns({ repository, ref })`

The fabric package does not embed credentials, network access, or a GitHub SDK. A host may implement those three methods with its approved GitHub connector/API boundary. CI uses an in-memory deterministic client.

This keeps network/account authority outside the capability fabric while still making evidence collection grammar reusable.

## Pinned-head collection

The collector resolves the named ref before reading evidence and pins all file reads to that exact starting commit SHA.

After file/action collection it resolves the named ref again.

Freshness states:

- `STABLE`: start and end SHA are identical;
- `MOVED`: the named ref moved while evidence was collected;
- `UNKNOWN`: the closing ref check failed.

Collection states:

- `PINNED_COMPLETE`
- `PINNED_COMPLETE_REF_MOVED`
- `PARTIAL`

A moved ref does not rewrite the pinned source. The collected source remains `github:<repository>@<starting SHA>`.

By default, when a collection is converted to a v0.7 external-source receipt, every claim also requires `github.ref-stability === STABLE`. A caller may explicitly set `requireStableRef: false` when evaluating a historical pinned commit, but the receipt still records that the named ref moved.

Freshness is never allowed to become a claim's only evidence. A claim must already contain at least one source/execution requirement before the collector adds the stability requirement.

## File evidence

Each requested file path becomes a v0.7-compatible observation with basis `OBSERVED_SOURCE`.

Statuses:

- `PRESENT`: file exists at the exact pinned SHA;
- `ABSENT`: the read-only client returned a not-found result;
- `MISMATCH`: file exists but its blob SHA does not match an explicitly supplied expected blob SHA;
- `ERROR`: collection failed for a reason other than not-found.

A transport outage is therefore not silently converted into absence.

The observation records the repository, pinned SHA, path, blob SHA, size, expected blob SHA when supplied, and a deterministic evidence ref.

## GitHub Actions evidence

Workflow selectors may identify a workflow by name and/or path.

Default `headPolicy` is `PINNED_HEAD`.

`PINNED_HEAD` means a workflow run is eligible only when `run.headSha` exactly equals the source SHA pinned at collection start. A successful run from an older commit cannot certify a newer pinned source.

An explicit `REF_HISTORY` selector may retain branch-history context. Its observation records whether the selected run is an exact pinned-head match. History evidence may be useful for claims such as "the latest materializer attempt failed", but it must not be confused with exact-head verification evidence.

Matching runs are ordered deterministically by `createdAt`, then run id, newest first.

Run observation status is the normalized GitHub Actions conclusion/status, for example `SUCCESS`, `FAILURE`, `CANCELLED`, or `MISSING`.

## Integrity

Schema:

`axm.parallel-capability-github-evidence-collection/v0.8`

Each collection gets:

`github-evidence-collection:sha256:<digest>`

The digest binds:

- source repository/ref/pinned SHA;
- freshness result;
- all generated observations.

`completedAt` is not part of the identity.

`assertGitHubEvidenceCollection(...)` recomputes the collection identity. Post-collection tampering is refused before observations can feed the v0.7 claim gate.

These hashes are deterministic content integrity checks, not signatures or repository-owner authentication.

## Discovery Buddy evidence captured during v0.8

Repository:

`mike-axiom-mir/axm-discovery-buddy`

Named work ref:

`axm/chat-agent-lane-rule-v1`

Observed work-PR head during this run:

`1411d0666a1e2fbfe5f697df8b0bb4b72f31dbf2`

At that exact head, the root exposed `.github/` and `.repo-import/` rather than a materialized `source/` tree.

Observed staged artifacts included:

- `.repo-import/READY`, blob `2c61932d7922399f377875ce772489e3e76e7bb5`;
- `.github/workflows/materialize-v114-import.yml`, blob `1f7bf6c4289b63c1feb63a061d90e70265f4d386`.

The materializer contract at this head declared 18 `payload-v114-NNN` parts, reconstructed archive SHA-256 `0dbdd994b90114dd7465954facf1fd6ce7506887165c73544d02ec91ef1dedeb`, and `npm test` plus required source-file checks before replacing the staging tree.

That declaration remains `DECLARED` intent, not successful execution evidence by itself.

The latest observed branch materializer run was GitHub Actions run `33366578085` at head `fbab0ae42b06146a3b9c514ec3aaad152909f406`, with conclusion `failure`.

Because that run is not on the pinned `1411d066...` head, a default exact-head workflow selector returns `MISSING`. A `REF_HISTORY` selector records the older `FAILURE` while keeping `exactPinnedHead: false`.

Therefore the v0.8 replay fixture preserves:

- `discovery-buddy.scanner` -> `HOLD_SOURCE_INCOMPLETE`;
- `discovery-buddy.import-stage-observer` -> `SOURCE_VERIFIED` for the narrow claim that the pinned ref is still a staged import state with a failed materializer attempt in branch history.

No Discovery Buddy code is executed by this collector or its demo.

## Truth limits

v0.8 does not yet:

- ship a credentialed GitHub HTTP client;
- crawl repositories automatically;
- prove repository-owner identity;
- sign evidence collections;
- prove semantic meaning of a source file merely because it exists;
- treat a workflow declaration as a successful run;
- infer ancestry/unchanged-content safety from an older successful workflow run;
- execute foreign code;
- grant runtime authority.

The collector answers: **what did this approved read-only GitHub client observe about this pinned source and its run history?**

The v0.7 claim gate still answers: **is that evidence sufficient for this specific capability claim?**
