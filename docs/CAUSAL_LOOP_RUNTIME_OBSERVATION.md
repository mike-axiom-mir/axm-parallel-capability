# Causal Loop runtime observation bridge

Status: bounded interoperability experiment. No automatic selection, registration, install, merge, or CANON authority.

## Why this exists

`axm-casual-loop` now has a strict offline NDJSON process contract for its bounded train-platform loop. Parallel Capability Fabric already has source/discovery evidence boundaries, but a discovered or known provider still needed a real consumer-side runtime observation before its existence could be distinguished from actual execution.

This adapter closes one narrow seam:

```text
explicit provider checkout/path
  -> read capability descriptor
  -> invoke describe + run over NDJSON stdio
  -> independently check descriptor/response authority and receipt SHA-256
  -> preserve the provider's own replay result
  -> emit axm.parallel-capability-runtime-observation/v0.1
```

The provider is never auto-discovered or auto-executed. Calling `observeCausalLoopProvider(...)` is the explicit execution decision.

## Truth boundary

The runtime observation proves only the bounded call that actually happened against the supplied local provider bytes:

- the declared capability/protocol matched the expected Causal Loop v1 contract;
- the provider returned a converged `PASS`;
- the provider reported deterministic replay success;
- the consumer independently recomputed the embedded provider receipt SHA-256;
- the provider receipt remained explicitly `committed: false`;
- the resulting observation is integrity-sealed and carries `RUNTIME_EVIDENCE_ONLY` authority.

It does **not** prove authorship, trust the caller-declared Git ref, independently replay the Python engine inside the JavaScript consumer, register/select the capability, install anything, write canonical state, commit history, merge, or declare CANON.

A caller-supplied `providerSourceRef` is retained as `CALLER_DECLARED_NOT_VERIFIED_BY_ADAPTER`. CI can pin the checkout and verify that head separately.

## Optional-provider failure

A missing provider, missing descriptor/entrypoint, path escape/symlink substitution, process failure, stderr output, protocol drift, authority drift, non-converged run, replay failure, committed-history claim, or receipt-integrity mismatch produces a `HOLD` or verifier failure. There is no silent fallback.

## Run

Requires Node 20+ and a local checkout of the provider implementation:

```bash
node examples/causal-loop-runtime-observation.js /absolute/path/to/axm-casual-loop <exact-provider-ref>
```

The cross-repository CI gate pins the provider to the exact open process-adapter head used by this lane and executes the bridge on Python 3.11 and 3.13.

## Continuation

This is deliberately a concrete provider bridge rather than a generic external-process SDK. If several unrelated providers later prove the same transport shape useful, a shared process-capability abstraction can be extracted from evidence rather than invented first.
