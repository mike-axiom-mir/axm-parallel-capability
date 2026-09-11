# Causal Loop portable runtime observation

Status: bounded interoperability experiment. No automatic discovery, installation, selection, execution, merge, or CANON authority.

## Why this exists

Parallel Capability PR #10 proves a real consumer-side runtime observation against the Causal Loop **source-directory** process provider. Causal Loop PR #17 adds a separate transfer boundary: the same deterministic process can be packaged as one dependency-free local `causal-loop-process.pyz` and copied away from its repository checkout.

This lane closes only the downstream distribution seam:

```text
trusted provider head
  -> deterministic causal-loop-process.pyz
  -> caller retains exact SHA-256
  -> provider source checkout can disappear
  -> explicit Parallel consumer invocation
  -> portable self-verify + portable describe
  -> real describe/run/verify NDJSON calls
  -> integrity-bound Parallel runtime evidence
```

The portable artifact is not downloaded or installed by Parallel Capability. A caller must supply an absolute local path and an exact SHA-256. The adapter checks that digest before any provider process is started.

## Exact lineage

This work is intentionally stacked on Parallel Capability PR #10 exact head:

`3e7f693d5961cabaac1dfdc1ad797939b21f227d`

The external portable provider is Causal Loop PR #17 exact head:

`b14c4fad2af9f1843394c05d21a78df791c757ef`

PR #10 owns the concrete Causal Loop runtime-observation idea and the source-directory transport. PR #17 owns deterministic one-file packaging. This lane does not copy either implementation into a generic AXM SDK and does not make the provider a package dependency.

## Consumer contract

`observePortableCausalLoopProvider(...)` requires:

- an explicit absolute `portablePath`;
- an exact lowercase caller-pinned artifact SHA-256;
- optional caller-declared provider source ref;
- bounded timed influences and `maxWaves` under the existing Causal Loop contract;
- a caller-triggered invocation.

Before execution the adapter requires the artifact to be a regular non-symlink file, bounded to 4 MiB, reads its bytes, and requires the observed SHA-256 to equal the caller pin.

It then runs the provider's own:

1. `portable-verify` contract;
2. `portable-describe` contract;
3. real NDJSON `describe` + `run` operations; and
4. a second real NDJSON `verify` operation against the just-returned process receipt.

The consumer independently checks the portable schemas/authority, Causal Loop capability descriptor, bounded operation set, deterministic/offline/no-third-party properties, process response authority, receipt SHA-256, converged result, replay claim, uncommitted-history boundary, and the second verification response.

The resulting `axm.parallel-capability-portable-runtime-observation/v0.1` receipt binds the artifact SHA-256, portable descriptor SHA-256, requested influences, provider process evidence, replay-verification evidence, truth boundary, and closed authority.

## Failure behavior

Missing artifact, non-file path, final-path symlink, size violation, caller-pin mismatch, Python execution failure, stderr output, portable-contract drift, process-contract drift, replay failure, committed-history claim, or receipt-integrity mismatch produces `HOLD` rather than fallback to the source checkout or another provider.

Digest mismatch is checked before provider execution. There is no silent source-directory fallback.

## Authority / truth boundary

A PASS means only that the exact caller-pinned local artifact was explicitly invoked, matched the expected portable/process contracts, produced a replay-matching bounded Causal Loop receipt, and then re-verified that receipt through the same exact artifact.

It does **not** prove:

- producer authorship or a signature;
- that the caller-declared Git ref is true;
- hostile-process sandboxing;
- that self-verification authenticates the producer;
- independent reimplementation/replay of the Python causal engine by JavaScript;
- automatic provider discovery, installation, selection, or execution;
- protected-state mutation, merge, release, promotion, or CANON authority.

`artifactSha256VerifiedBeforeExecution: true` is content identity relative to the caller-owned pin, not authorship.

The adapter removes `PYTHONPATH` and `PYTHONHOME` and sets `PYTHONNOUSERSITE=1` for provider subprocesses. That reduces accidental environment coupling; it is not an OS sandbox.

The current file admission rejects the final artifact path when it is a symlink, but it is not descriptor-bound `openat`-style confinement and does not claim protection from a hostile concurrent pathname replacement after admission. CI proves the cooperative local-file path only.

## Verification target

Cross-repository CI must:

- assert the exact Parallel branch ancestry;
- run the complete Parallel suite plus focused portable-admission regressions;
- checkout Causal Loop PR #17 at the exact pinned head;
- run the provider's focused portable tests and complete repository suite;
- build and trusted-checkout-verify `causal-loop-process.pyz`;
- retain its exact SHA-256;
- delete the provider source checkout;
- execute the real Parallel example using only the copied artifact + caller pin;
- independently verify the emitted Parallel receipt;
- retain that receipt as review evidence.

This proves one concrete checkout-independent consumer. It does not justify a generic external-process SDK until more unrelated providers demonstrate the same need.
