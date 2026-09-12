import { createHash } from 'node:crypto';

const PROVIDER_SCHEMA = 'axm.capability/v1';
const PROVIDER_ID = 'axm.ignition.materialization-core';
const PROVIDER_VERSION = '0.6.0';
const PROVIDER_RUN_RECEIPT = 'axm.ignition-run/v0.05';
const BINDING_SCHEMA = 'axm.parallel-capability-ignition-binding/v0.1';
const EXECUTION_SCHEMA = 'axm.parallel-capability-ignition-execution/v0.2';
const REQUEST_SCHEMA = 'axm.parallel-capability-ignition-request/v0.1';
const CLONE_CANDIDATE_SCHEMA = 'axm.parallel-capability-clone-candidate/v0.3';
const AUTHORITY = Object.freeze({
  kind: 'MATERIALIZATION_EVIDENCE_ONLY',
  automaticSelection: false,
  automaticInstall: false,
  canonicalMutation: false,
  merge: false,
  canon: false
});

export function inspectIgnitionProvider(ignition) {
  try {
    const descriptor = readProviderDescriptor(ignition);
    return seal({
      schema: BINDING_SCHEMA,
      status: 'READY',
      provider: providerSummary(descriptor),
      authority: AUTHORITY
    });
  } catch (error) {
    return hold('PROVIDER_CONTRACT_REJECTED', error);
  }
}

export function bindIgnitionExecutorSet(parallelRegistry, {
  ignition = null,
  bindings = [],
  providerSourceRef = null,
  bindingRefPrefix = 'ignition-materialized'
} = {}) {
  assertParallelRegistry(parallelRegistry);
  const normalized = normalizeBindings(bindings);
  if (providerSourceRef != null && (typeof providerSourceRef !== 'string' || providerSourceRef.trim() === '')) {
    throw new TypeError('providerSourceRef must be null or a non-empty string');
  }
  if (typeof bindingRefPrefix !== 'string' || bindingRefPrefix.trim() === '') {
    throw new TypeError('bindingRefPrefix must be a non-empty string');
  }

  let descriptor;
  try {
    descriptor = readProviderDescriptor(ignition);
  } catch (error) {
    return hold('PROVIDER_UNAVAILABLE_OR_INCOMPATIBLE', error, {
      providerSourceRef: providerSourceRef ?? null,
      bindings: normalized.map(publicBinding)
    });
  }

  const existing = normalized.filter((binding) => parallelRegistry.executors?.has?.(binding.executorRef));
  if (existing.length > 0) {
    return hold('EXECUTOR_ALREADY_BOUND', new Error(`Refusing to replace existing executor binding(s): ${existing.map((item) => item.executorRef).join(', ')}`), {
      providerSourceRef: providerSourceRef ?? null,
      provider: providerSummary(descriptor),
      bindings: normalized.map(publicBinding)
    });
  }

  const provider = providerSummary(descriptor);
  const providerDescriptorSha256 = sha256(stableStringify(descriptor));
  const bound = [];
  for (const target of normalized) {
    const work = createWrappedWork({
      ignition,
      provider,
      providerDescriptorSha256,
      providerSourceRef: providerSourceRef ?? null,
      target,
      allBindings: normalized
    });
    const result = parallelRegistry.bindExecutor(target.executorRef, work, {
      bindingRef: `${bindingRefPrefix}:${PROVIDER_VERSION}:${target.executorRef}`
    });
    bound.push({ executorRef: result.executorRef, bindingRef: result.bindingRef, status: result.status });
  }

  return seal({
    schema: BINDING_SCHEMA,
    status: 'BOUND',
    provider,
    providerDescriptorSha256,
    providerSourceRef: providerSourceRef ?? null,
    providerSourceRefBinding: providerSourceRef ? 'CALLER_DECLARED_NOT_AUTHENTICATED_BY_ADAPTER' : 'UNSPECIFIED',
    bindings: normalized.map(publicBinding),
    registryBindings: bound.sort((a, b) => a.executorRef.localeCompare(b.executorRef)),
    authority: AUTHORITY
  });
}

export function verifyIgnitionExecutionEvidence(receipt, candidate) {
  object(receipt, 'Ignition execution evidence');
  if (receipt.schema !== EXECUTION_SCHEMA) throw new Error(`Unsupported Ignition execution schema: ${receipt.schema ?? '<missing>'}`);
  if (!/^[0-9a-f]{64}$/.test(receipt.receiptSha256 ?? '')) throw new Error('Ignition execution receiptSha256 is invalid');
  const core = { ...receipt };
  delete core.receiptSha256;
  if (receipt.receiptSha256 !== sha256(stableStringify(core))) throw new Error('Ignition execution receiptSha256 mismatch');
  if (receipt.provider?.id !== PROVIDER_ID || receipt.provider?.version !== PROVIDER_VERSION) throw new Error('Ignition execution provider identity mismatch');
  if (receipt.provider?.runReceipt !== PROVIDER_RUN_RECEIPT) throw new Error('Ignition execution provider run contract mismatch');
  if (receipt.mode !== 'ignition') throw new Error('Ignition execution mode must be ignition');
  for (const key of ['matchedCapabilityIds', 'materializedCapabilityIds', 'executedCapabilityIds', 'releasedCapabilityIds']) {
    if (!Array.isArray(receipt[key]) || receipt[key].length !== 1 || receipt[key][0] !== receipt.capabilityId) {
      throw new Error(`Ignition execution ${key} must contain only the selected capability`);
    }
  }
  verifyAuthority(receipt.authority);
  verifyExecutionCandidate(receipt, candidate);
  return {
    status: 'PASS',
    receiptSha256: receipt.receiptSha256,
    executorRef: receipt.executorRef,
    capabilityId: receipt.capabilityId,
    providerResultHash: receipt.providerResultHash,
    cloneStateSha256: receipt.cloneStateSha256,
    workOutputSha256: receipt.workOutputSha256,
    authority: receipt.authority.kind
  };
}

function createWrappedWork({ ignition, provider, providerDescriptorSha256, providerSourceRef, target, allBindings }) {
  return async function ignitionMaterializedParallelWork(context) {
    object(context, 'Parallel executor context');

    const providerRegistry = new ignition.CapabilityRegistry(allBindings.map((binding) => ({
      id: binding.capabilityId,
      match: (request) => request?.executorRef === binding.executorRef,
      dependencies: [],
      resourceEstimateBytes: binding.resourceEstimateBytes,
      materialize: binding.materialize == null ? undefined : async () => binding.materialize(Object.freeze({
        parallelContext: context,
        provider,
        executorRef: binding.executorRef,
        capabilityId: binding.capabilityId
      })),
      release: binding.release == null ? undefined : async ({ runtime }) => binding.release(Object.freeze({
        parallelContext: context,
        provider,
        executorRef: binding.executorRef,
        capabilityId: binding.capabilityId,
        runtime
      })),
      run: async ({ runtime }) => {
        const value = await binding.work(Object.freeze({
          ...context,
          ignitionRuntime: runtime,
          ignitionProvider: provider
        }));
        return value == null ? {} : value;
      }
    })));

    const request = {
      schema: REQUEST_SCHEMA,
      executorRef: target.executorRef,
      capabilityId: target.capabilityId,
      candidateId: nullableString(context.id),
      laneId: nullableString(context.laneId),
      taskId: nullableString(context.taskId),
      stateRef: nullableString(context.stateRef),
      sourceStateHash: nullableString(context.sourceStateHash)
    };
    const stateFingerprint = request.sourceStateHash ?? sha256(stableStringify({ stateRef: request.stateRef }));
    const run = await ignition.executeIgnitionRun({
      registry: providerRegistry,
      request,
      state: { stateRef: request.stateRef, sourceStateHash: request.sourceStateHash },
      stateFingerprint,
      mode: 'ignition'
    });
    const workOutput = validateProviderRun(run, target);
    object(workOutput, `Parallel work output for ${target.executorRef}`);
    if (Array.isArray(workOutput)) throw new TypeError('Parallel work output must not be an array');

    const metadata = workOutput.metadata == null ? {} : workOutput.metadata;
    object(metadata, 'Parallel work output metadata');
    if (Array.isArray(metadata)) throw new TypeError('Parallel work output metadata must not be an array');
    if (Object.prototype.hasOwnProperty.call(metadata, 'ignitionExecution')) {
      throw new Error('metadata.ignitionExecution is reserved by the Ignition adapter');
    }

    const execution = createExecutionEvidence({
      provider,
      providerDescriptorSha256,
      providerSourceRef,
      target,
      request,
      runReceipt: run.receipt,
      workOutput,
      metadata,
      cloneStateSha256: sha256(stableStringify(context.state))
    });
    const evidenceRef = `ignition-execution:sha256:${execution.receiptSha256}`;

    return {
      ...workOutput,
      evidenceRefs: uniqueStrings([...(workOutput.evidenceRefs ?? []), evidenceRef]),
      metadata: {
        ...metadata,
        ignitionExecution: execution
      }
    };
  };
}

function createExecutionEvidence({ provider, providerDescriptorSha256, providerSourceRef, target, request, runReceipt, workOutput, metadata, cloneStateSha256 }) {
  const workOutputEvidenceRefs = uniqueStrings(workOutput.evidenceRefs ?? []);
  const workOutputSha256 = sha256(stableStringify(workOutputProjection(workOutput, metadata)));
  const core = {
    schema: EXECUTION_SCHEMA,
    provider,
    providerDescriptorSha256,
    providerSourceRef,
    providerSourceRefBinding: providerSourceRef ? 'CALLER_DECLARED_NOT_AUTHENTICATED_BY_ADAPTER' : 'UNSPECIFIED',
    executorRef: target.executorRef,
    capabilityId: target.capabilityId,
    request,
    mode: runReceipt.mode,
    providerRunId: runReceipt.runId,
    providerRequestHash: runReceipt.requestHash,
    providerStateHash: runReceipt.stateHash,
    matchedCapabilityIds: [...runReceipt.matchedCapabilityIds],
    materializedCapabilityIds: [...runReceipt.materializedCapabilityIds],
    executedCapabilityIds: [...runReceipt.executedCapabilityIds],
    releasedCapabilityIds: [...runReceipt.releasedCapabilityIds],
    estimatedWorkingSetBytes: runReceipt.estimatedWorkingSetBytes,
    actualMaterializedBytes: runReceipt.actualMaterializedBytes,
    providerResultHash: runReceipt.resultHash,
    cloneStateSha256,
    workOutputSha256,
    workOutputEvidenceRefs,
    authority: AUTHORITY
  };
  return { ...core, receiptSha256: sha256(stableStringify(core)) };
}

function verifyExecutionCandidate(receipt, candidate) {
  object(candidate, 'Ignition clone candidate');
  if (Array.isArray(candidate) || candidate.schema !== CLONE_CANDIDATE_SCHEMA) {
    throw new Error(`Ignition execution requires ${CLONE_CANDIDATE_SCHEMA}`);
  }
  object(candidate.metadata, 'Ignition clone candidate metadata');
  if (Array.isArray(candidate.metadata)) throw new TypeError('Ignition clone candidate metadata must not be an array');
  const embedded = candidate.metadata.ignitionExecution;
  if (stableStringify(embedded) !== stableStringify(receipt)) {
    throw new Error('Ignition execution receipt is not the candidate embedded receipt');
  }
  const evidenceRef = `ignition-execution:sha256:${receipt.receiptSha256}`;
  if (!Array.isArray(candidate.evidenceRefs) || !candidate.evidenceRefs.includes(evidenceRef)) {
    throw new Error('Ignition execution evidence ref is missing from clone candidate');
  }
  if (!Array.isArray(receipt.workOutputEvidenceRefs)
      || stableStringify(receipt.workOutputEvidenceRefs) !== stableStringify(uniqueStrings(receipt.workOutputEvidenceRefs))) {
    throw new Error('Ignition execution workOutputEvidenceRefs are invalid');
  }
  for (const ref of receipt.workOutputEvidenceRefs) {
    if (!candidate.evidenceRefs.includes(ref)) throw new Error(`Ignition work output evidence ref is missing from clone candidate: ${ref}`);
  }
  object(receipt.request, 'Ignition execution request');
  for (const [candidateKey, requestKey] of [
    ['id', 'candidateId'],
    ['laneId', 'laneId'],
    ['taskId', 'taskId'],
    ['stateRef', 'stateRef'],
    ['sourceStateHash', 'sourceStateHash']
  ]) {
    if (candidate[candidateKey] !== receipt.request[requestKey]) {
      throw new Error(`Ignition clone candidate ${candidateKey} does not match execution request`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.cloneStateSha256 ?? '') || candidate.cloneStateHash !== receipt.cloneStateSha256) {
    throw new Error('Ignition clone state SHA-256 mismatch');
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.workOutputSha256 ?? '')) {
    throw new Error('Ignition execution workOutputSha256 is invalid');
  }
  const metadata = { ...candidate.metadata };
  delete metadata.ignitionExecution;
  const projected = workOutputProjection(candidate, metadata);
  if (sha256(stableStringify(projected)) !== receipt.workOutputSha256) {
    throw new Error('Ignition work output SHA-256 mismatch');
  }
}

function workOutputProjection(source, metadata) {
  return {
    assumptions: source.assumptions ?? [],
    contradictions: source.contradictions ?? [],
    failures: [...(source.failures ?? [])].map(String),
    metadata,
    unknowns: source.unknowns ?? []
  };
}

function validateProviderRun(run, target) {
  object(run, 'Ignition run');
  object(run.receipt, 'Ignition run receipt');
  const receipt = run.receipt;
  if (receipt.schema !== PROVIDER_RUN_RECEIPT) throw new Error(`Unexpected Ignition run receipt schema: ${receipt.schema ?? '<missing>'}`);
  if (receipt.mode !== 'ignition') throw new Error('Ignition adapter requires ignition mode');
  for (const [label, values] of [
    ['matchedCapabilityIds', receipt.matchedCapabilityIds],
    ['materializedCapabilityIds', receipt.materializedCapabilityIds],
    ['executedCapabilityIds', receipt.executedCapabilityIds],
    ['releasedCapabilityIds', receipt.releasedCapabilityIds]
  ]) {
    if (!Array.isArray(values) || values.length !== 1 || values[0] !== target.capabilityId) {
      throw new Error(`Ignition ${label} escaped the selected capability boundary`);
    }
  }
  if (!Number.isSafeInteger(receipt.actualMaterializedBytes) || receipt.actualMaterializedBytes < 0) throw new Error('Ignition actualMaterializedBytes is invalid');
  if (!Number.isFinite(receipt.estimatedWorkingSetBytes) || receipt.estimatedWorkingSetBytes < 0) throw new Error('Ignition estimatedWorkingSetBytes is invalid');
  object(run.result, 'Ignition run result');
  if (!Object.prototype.hasOwnProperty.call(run.result, target.capabilityId)) throw new Error('Ignition run result is missing selected capability output');
  return run.result[target.capabilityId];
}

function readProviderDescriptor(ignition) {
  object(ignition, 'Ignition provider module');
  if (typeof ignition.describeCapability !== 'function') throw new TypeError('Ignition provider must expose describeCapability()');
  if (typeof ignition.CapabilityRegistry !== 'function') throw new TypeError('Ignition provider must expose CapabilityRegistry');
  if (typeof ignition.executeIgnitionRun !== 'function') throw new TypeError('Ignition provider must expose executeIgnitionRun()');
  const descriptor = ignition.describeCapability();
  object(descriptor, 'Ignition capability descriptor');
  if (descriptor.schema !== PROVIDER_SCHEMA || descriptor.id !== PROVIDER_ID || descriptor.version !== PROVIDER_VERSION) {
    throw new Error('Ignition provider capability identity/version mismatch');
  }
  if (descriptor.status !== 'EXPERIMENTAL') throw new Error('Ignition provider status mismatch');
  object(descriptor.runtime, 'Ignition runtime descriptor');
  if (descriptor.runtime.kind !== 'node' || String(descriptor.runtime.minimumVersion) !== '18') throw new Error('Ignition runtime contract mismatch');
  if (descriptor.runtime.networkRequired !== false) throw new Error('Ignition provider must remain network-free at runtime');
  if (!Array.isArray(descriptor.runtime.dependencies) || descriptor.runtime.dependencies.length !== 0) throw new Error('Ignition provider runtime dependencies must remain empty');
  object(descriptor.contracts, 'Ignition contract descriptor');
  if (descriptor.contracts.runReceipt !== PROVIDER_RUN_RECEIPT) throw new Error('Ignition run receipt contract mismatch');
  object(descriptor.authority, 'Ignition authority descriptor');
  if (descriptor.authority.canonical !== false || descriptor.authority.automaticMerge !== false) throw new Error('Ignition provider authority widened beyond adapter contract');
  return structuredClone(descriptor);
}

function providerSummary(descriptor) {
  return {
    schema: descriptor.schema,
    id: descriptor.id,
    version: descriptor.version,
    status: descriptor.status,
    runtime: {
      kind: descriptor.runtime.kind,
      minimumVersion: String(descriptor.runtime.minimumVersion),
      networkRequired: false,
      dependencies: []
    },
    runReceipt: descriptor.contracts.runReceipt,
    authority: {
      canonical: false,
      automaticMerge: false
    }
  };
}

function normalizeBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) throw new TypeError('bindings must be a non-empty array');
  const executorRefs = new Set();
  const capabilityIds = new Set();
  const normalized = bindings.map((binding, index) => {
    object(binding, `bindings[${index}]`);
    const executorRef = requiredString(binding.executorRef, `bindings[${index}].executorRef`);
    const capabilityId = requiredString(binding.capabilityId, `bindings[${index}].capabilityId`);
    if (executorRefs.has(executorRef)) throw new Error(`Duplicate executorRef: ${executorRef}`);
    if (capabilityIds.has(capabilityId)) throw new Error(`Duplicate Ignition capabilityId: ${capabilityId}`);
    executorRefs.add(executorRef);
    capabilityIds.add(capabilityId);
    if (typeof binding.work !== 'function') throw new TypeError(`bindings[${index}].work must be a function`);
    if (binding.materialize != null && typeof binding.materialize !== 'function') throw new TypeError(`bindings[${index}].materialize must be a function`);
    if (binding.release != null && typeof binding.release !== 'function') throw new TypeError(`bindings[${index}].release must be a function`);
    const resourceEstimateBytes = Number(binding.resourceEstimateBytes ?? 0);
    if (!Number.isSafeInteger(resourceEstimateBytes) || resourceEstimateBytes < 0) throw new TypeError(`bindings[${index}].resourceEstimateBytes must be a non-negative safe integer`);
    return { executorRef, capabilityId, work: binding.work, materialize: binding.materialize ?? null, release: binding.release ?? null, resourceEstimateBytes };
  });
  return normalized.sort((a, b) => a.executorRef.localeCompare(b.executorRef));
}

function publicBinding(binding) {
  return {
    executorRef: binding.executorRef,
    capabilityId: binding.capabilityId,
    resourceEstimateBytes: binding.resourceEstimateBytes,
    materialize: binding.materialize != null,
    release: binding.release != null
  };
}

function hold(reason, error, extra = {}) {
  return seal({
    schema: BINDING_SCHEMA,
    status: 'HOLD',
    reason: {
      code: reason,
      detail: bounded(error?.message ?? String(error))
    },
    ...extra,
    authority: AUTHORITY
  });
}

function seal(core) {
  return { ...core, receiptSha256: sha256(stableStringify(core)) };
}

function verifyAuthority(authority) {
  object(authority, 'Ignition adapter authority');
  for (const [key, value] of Object.entries(AUTHORITY)) {
    if (authority[key] !== value) throw new Error(`Ignition adapter authority.${key} mismatch`);
  }
}

function assertParallelRegistry(registry) {
  object(registry, 'Parallel Capability registry');
  if (typeof registry.bindExecutor !== 'function') throw new TypeError('parallelRegistry must expose bindExecutor()');
}

function object(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} must be an object`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function nullableString(value) {
  return value == null ? null : String(value);
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) throw new TypeError('evidenceRefs must be an array');
  return [...new Set(values.map(String))].sort();
}

function bounded(value, limit = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}
