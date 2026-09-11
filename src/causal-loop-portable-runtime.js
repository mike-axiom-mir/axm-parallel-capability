import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const CAPABILITY_ID = 'axm.causal-loop.train-platform.process/v1';
const PROVIDER_REPOSITORY = 'mike-axiom-mir/axm-casual-loop';
const REQUEST_SCHEMA = 'axm.causal-loop.process-request/v1';
const RESPONSE_SCHEMA = 'axm.causal-loop.process-response/v1';
const CAPABILITY_SCHEMA = 'axm.capability/v1';
const PORTABLE_SCHEMA = 'axm.causal-loop.portable-process/v1';
const PORTABLE_VERIFY_SCHEMA = 'axm.causal-loop.portable-process-verification/v1';
const OBSERVATION_SCHEMA = 'axm.parallel-capability-portable-runtime-observation/v0.1';
const DESCRIPTOR_MEMBER = 'capabilities/causal-loop-process-v1.json';
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_WAVES_LIMIT = 256;
const MAX_TIMED_INFLUENCES = 64;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ALLOWED_ACTIONS = new Set(['WAIT', 'BLOCK_DOOR', 'TRIGGER_ALARM', 'TALK_TO_PASSENGER']);

const PORTABLE_AUTHORITY = Object.freeze({
  automaticExecution: false,
  automaticSelection: false,
  installation: false,
  commitsHistory: false,
  writesCanonicalState: false,
  merge: false,
  canon: false
});

const PORTABLE_RUNTIME = Object.freeze({
  python: '>=3.11',
  networkRequired: false,
  thirdPartyDependencies: false
});

const PORTABLE_TRUTH_BOUNDARY = Object.freeze({
  selfVerificationAuthenticatesProducer: false,
  providerVerificationBindsTrustedCheckout: true,
  portableArtifactExecutesOnlyWhenCallerInvokesIt: true,
  processReceiptsRemainUncommitted: true
});

const OBSERVATION_AUTHORITY = Object.freeze({
  kind: 'RUNTIME_EVIDENCE_ONLY',
  automaticExecution: false,
  automaticSelection: false,
  automaticRegistration: false,
  installation: false,
  merge: false,
  canon: false
});

export function observePortableCausalLoopProvider({
  portablePath,
  expectedArtifactSha256,
  timedInfluences = [],
  maxWaves = 64,
  requestId = 'parallel-capability-portable-observation',
  pythonExecutable = process.env.PYTHON || 'python3',
  providerSourceRef = null,
  timeoutMs = 15_000
} = {}) {
  const requested = normalizeInputs({
    portablePath,
    expectedArtifactSha256,
    timedInfluences,
    maxWaves,
    requestId,
    pythonExecutable,
    providerSourceRef,
    timeoutMs
  });

  try {
    const artifact = admitArtifact(requested.portablePath, requested.expectedArtifactSha256);

    const portableVerification = runPortableJson({
      requested,
      args: ['portable-verify'],
      label: 'portable verification'
    });
    validatePortableVerification(portableVerification, artifact.sha256);

    const portableMetadata = runPortableJson({
      requested,
      args: ['portable-describe'],
      label: 'portable description'
    });
    validatePortableMetadata(portableMetadata);

    const describeRequest = {
      schema: REQUEST_SCHEMA,
      requestId: `${requested.requestId}:describe`,
      op: 'describe'
    };
    const runRequest = {
      schema: REQUEST_SCHEMA,
      requestId: `${requested.requestId}:run`,
      op: 'run',
      timedInfluences: requested.timedInfluences,
      maxWaves: requested.maxWaves
    };
    const processResponses = runPortableNdjson({
      requested,
      requests: [describeRequest, runRequest],
      expectedResponses: 2,
      label: 'portable process'
    });
    const [describeResponse, runResponse] = processResponses;
    const descriptor = describeResponse?.capability;
    validateDescriptor(descriptor);
    validateDescribe(describeResponse, descriptor);
    validateRun(runResponse, requested.maxWaves);

    const verifyRequest = {
      schema: REQUEST_SCHEMA,
      requestId: `${requested.requestId}:verify`,
      op: 'verify',
      maxWaves: requested.maxWaves,
      receipt: runResponse.receipt
    };
    const [verifyResponse] = runPortableNdjson({
      requested,
      requests: [verifyRequest],
      expectedResponses: 1,
      label: 'portable receipt replay verification'
    });
    validateVerify(verifyResponse, runResponse.receiptHash, requested.maxWaves);

    const core = {
      schema: OBSERVATION_SCHEMA,
      capabilityId: CAPABILITY_ID,
      provider: {
        repository: PROVIDER_REPOSITORY,
        sourceRef: requested.providerSourceRef,
        sourceRefBinding: requested.providerSourceRef ? 'CALLER_DECLARED_NOT_VERIFIED_BY_ADAPTER' : 'UNSPECIFIED',
        transport: 'python-zipapp',
        portableSchema: PORTABLE_SCHEMA,
        artifactSha256: artifact.sha256,
        artifactBytes: artifact.bytes,
        artifactIdentityBinding: 'CALLER_PINNED_SHA256_VERIFIED_BEFORE_EXECUTION',
        processDescriptorSha256: portableMetadata.processDescriptorSha256
      },
      request: {
        timedInfluences: requested.timedInfluences,
        maxWaves: requested.maxWaves,
        requestSha256: hashJson({
          timedInfluences: requested.timedInfluences,
          maxWaves: requested.maxWaves
        })
      },
      observation: {
        status: 'RUNTIME_OBSERVED',
        providerStatus: runResponse.status,
        executionStatus: runResponse.executionStatus,
        replayMatches: runResponse.replayMatches,
        providerReceiptHash: runResponse.receiptHash,
        providerReceiptCommitted: runResponse.receipt.committed,
        runtimeVerifiedWithinProviderContract: true,
        portableReceiptReverified: true
      },
      providerEvidence: {
        portableVerification: clone(portableVerification),
        portableMetadata: clone(portableMetadata),
        describeResponse: clone(describeResponse),
        runResponse: clone(runResponse),
        verifyResponse: clone(verifyResponse)
      },
      truthBoundary: {
        artifactSha256VerifiedBeforeExecution: true,
        selfVerificationAuthenticatesProducer: false,
        providerSourceRefVerifiedByAdapter: false,
        providerReplayWasReportedAndReverified: true,
        providerImplementationIndependentlyReplayedByConsumer: false,
        providerReceiptIsCommittedHistory: false,
        portableArtifactInvokedOnlyByExplicitCallerAction: true
      },
      authority: clone(OBSERVATION_AUTHORITY)
    };

    return { ...core, receiptSha256: hashJson(core) };
  } catch (error) {
    return hold(requested, error.axmCode || 'PORTABLE_PROVIDER_HELD', error.message);
  }
}

export function verifyPortableCausalLoopRuntimeObservation(receipt) {
  object(receipt, 'portable runtime observation');
  if (receipt.schema !== OBSERVATION_SCHEMA) throw new Error(`Unsupported portable observation schema: ${receipt.schema ?? '<missing>'}`);
  if (receipt.capabilityId !== CAPABILITY_ID) throw new Error('Portable observation capabilityId mismatch');
  validateSha(receipt.receiptSha256, 'receiptSha256');
  const core = { ...receipt };
  delete core.receiptSha256;
  if (receipt.receiptSha256 !== hashJson(core)) throw new Error('Portable observation receiptSha256 mismatch');

  object(receipt.provider, 'portable observation.provider');
  if (receipt.provider.repository !== PROVIDER_REPOSITORY) throw new Error('Portable observation provider repository mismatch');
  if (receipt.provider.transport !== 'python-zipapp' || receipt.provider.portableSchema !== PORTABLE_SCHEMA) throw new Error('Portable observation transport mismatch');
  if (receipt.provider.artifactIdentityBinding !== 'CALLER_PINNED_SHA256_VERIFIED_BEFORE_EXECUTION') throw new Error('Portable observation artifact binding mismatch');
  validateSha(receipt.provider.artifactSha256, 'provider.artifactSha256');
  validateSha(receipt.provider.processDescriptorSha256, 'provider.processDescriptorSha256');
  if (!Number.isInteger(receipt.provider.artifactBytes) || receipt.provider.artifactBytes < 1 || receipt.provider.artifactBytes > MAX_ARTIFACT_BYTES) throw new Error('Portable observation artifactBytes outside contract');

  object(receipt.request, 'portable observation.request');
  const normalized = normalizeInputs({
    portablePath: '/verification-only',
    expectedArtifactSha256: receipt.provider.artifactSha256,
    timedInfluences: receipt.request.timedInfluences,
    maxWaves: receipt.request.maxWaves,
    requestId: 'verification-only',
    pythonExecutable: 'python3',
    providerSourceRef: receipt.provider.sourceRef ?? null,
    timeoutMs: 15_000,
    skipPathValidation: true
  });
  if (receipt.request.requestSha256 !== hashJson({ timedInfluences: normalized.timedInfluences, maxWaves: normalized.maxWaves })) throw new Error('Portable observation requestSha256 mismatch');

  const evidence = receipt.providerEvidence;
  object(evidence, 'portable observation.providerEvidence');
  validatePortableVerification(evidence.portableVerification, receipt.provider.artifactSha256);
  validatePortableMetadata(evidence.portableMetadata);
  if (evidence.portableMetadata.processDescriptorSha256 !== receipt.provider.processDescriptorSha256) throw new Error('Portable observation descriptor lineage mismatch');
  const descriptor = evidence.describeResponse?.capability;
  validateDescriptor(descriptor);
  validateDescribe(evidence.describeResponse, descriptor);
  validateRun(evidence.runResponse, receipt.request.maxWaves);
  validateVerify(evidence.verifyResponse, evidence.runResponse.receiptHash, receipt.request.maxWaves);

  if (receipt.observation?.status !== 'RUNTIME_OBSERVED') throw new Error('Portable observation status mismatch');
  if (receipt.observation.providerStatus !== evidence.runResponse.status || receipt.observation.executionStatus !== evidence.runResponse.executionStatus) throw new Error('Portable observation execution lineage mismatch');
  if (receipt.observation.replayMatches !== true || receipt.observation.portableReceiptReverified !== true) throw new Error('Portable observation replay evidence mismatch');
  if (receipt.observation.providerReceiptHash !== evidence.runResponse.receiptHash) throw new Error('Portable observation provider receipt lineage mismatch');
  if (receipt.observation.providerReceiptCommitted !== false) throw new Error('Portable observation must not promote uncommitted provider evidence');

  const expectedTruth = {
    artifactSha256VerifiedBeforeExecution: true,
    selfVerificationAuthenticatesProducer: false,
    providerSourceRefVerifiedByAdapter: false,
    providerReplayWasReportedAndReverified: true,
    providerImplementationIndependentlyReplayedByConsumer: false,
    providerReceiptIsCommittedHistory: false,
    portableArtifactInvokedOnlyByExplicitCallerAction: true
  };
  if (stable(receipt.truthBoundary) !== stable(expectedTruth)) throw new Error('Portable observation truth boundary drift');
  if (stable(receipt.authority) !== stable(OBSERVATION_AUTHORITY)) throw new Error('Portable observation authority drift');

  return {
    status: 'PASS',
    schema: receipt.schema,
    capabilityId: receipt.capabilityId,
    receiptSha256: receipt.receiptSha256,
    artifactSha256: receipt.provider.artifactSha256,
    providerReceiptHash: evidence.runResponse.receiptHash,
    runtimeObserved: true,
    authority: 'RUNTIME_EVIDENCE_ONLY'
  };
}

function admitArtifact(portablePath, expectedArtifactSha256) {
  if (!existsSync(portablePath)) throw tagged('PORTABLE_ARTIFACT_UNAVAILABLE', `portable artifact does not exist: ${portablePath}`);
  const stat = lstatSync(portablePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw tagged('PORTABLE_ARTIFACT_PATH_UNSAFE', 'portable artifact must be a regular non-symlink file');
  if (stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) throw tagged('PORTABLE_ARTIFACT_SIZE_INVALID', `portable artifact must be 1..${MAX_ARTIFACT_BYTES} bytes`);
  const bytes = readFileSync(portablePath);
  if (bytes.length !== stat.size || bytes.length > MAX_ARTIFACT_BYTES) throw tagged('PORTABLE_ARTIFACT_READ_DRIFT', 'portable artifact size changed during admission');
  const observedSha256 = sha256(bytes);
  if (observedSha256 !== expectedArtifactSha256) throw tagged('PORTABLE_ARTIFACT_DIGEST_MISMATCH', 'portable artifact SHA-256 does not match the caller-pinned digest');
  return { sha256: observedSha256, bytes: bytes.length };
}

function runPortableJson({ requested, args, label }) {
  const completed = spawnPortable({ requested, args });
  const lines = completed.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) throw tagged('PORTABLE_PROVIDER_RESPONSE_COUNT_MISMATCH', `${label} expected one JSON response, received ${lines.length}`);
  try {
    return JSON.parse(lines[0]);
  } catch (error) {
    throw tagged('PORTABLE_PROVIDER_INVALID_JSON', `${label} returned invalid JSON: ${error.message}`);
  }
}

function runPortableNdjson({ requested, requests, expectedResponses, label }) {
  const input = `${requests.map((value) => JSON.stringify(value)).join('\n')}\n`;
  const completed = spawnPortable({ requested, args: [], input });
  const lines = completed.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== expectedResponses) throw tagged('PORTABLE_PROVIDER_RESPONSE_COUNT_MISMATCH', `${label} expected ${expectedResponses} NDJSON response(s), received ${lines.length}`);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    throw tagged('PORTABLE_PROVIDER_INVALID_JSON', `${label} returned invalid JSON: ${error.message}`);
  }
}

function spawnPortable({ requested, args, input = '' }) {
  const completed = spawnSync(requested.pythonExecutable, [requested.portablePath, ...args], {
    cwd: process.cwd(),
    input,
    encoding: 'utf8',
    timeout: requested.timeoutMs,
    maxBuffer: MAX_PROVIDER_OUTPUT_BYTES,
    windowsHide: true,
    env: cleanPythonEnv()
  });
  if (completed.error) throw tagged('PORTABLE_PROVIDER_EXECUTION_UNAVAILABLE', completed.error.message);
  if (completed.signal) throw tagged('PORTABLE_PROVIDER_EXECUTION_INTERRUPTED', `portable provider exited via signal ${completed.signal}`);
  if (completed.status !== 0) throw tagged('PORTABLE_PROVIDER_EXECUTION_HELD', bounded(completed.stderr || `portable provider exited ${completed.status}`));
  if (completed.stderr) throw tagged('PORTABLE_PROVIDER_STDERR_NOT_EMPTY', bounded(completed.stderr));
  return completed;
}

function cleanPythonEnv() {
  const env = { ...process.env, PYTHONNOUSERSITE: '1' };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  return env;
}

function validatePortableVerification(value, artifactSha256) {
  object(value, 'portable verification');
  if (value.schema !== PORTABLE_VERIFY_SCHEMA || value.status !== 'PASS' || value.capabilityId !== CAPABILITY_ID) throw new Error('Portable self-verification identity/status mismatch');
  if (value.artifactSha256 !== artifactSha256) throw new Error('Portable self-verification artifact SHA mismatch');
  if (stable(value.authority) !== stable(PORTABLE_AUTHORITY)) throw new Error('Portable self-verification authority drift');
  if (stable(value.truthBoundary) !== stable(PORTABLE_TRUTH_BOUNDARY)) throw new Error('Portable self-verification truth-boundary drift');
}

function validatePortableMetadata(value) {
  object(value, 'portable metadata');
  if (value.schema !== PORTABLE_SCHEMA || value.capabilityId !== CAPABILITY_ID) throw new Error('Portable metadata identity mismatch');
  if (stable(value.runtime) !== stable(PORTABLE_RUNTIME)) throw new Error('Portable runtime contract drift');
  if (stable(value.authority) !== stable(PORTABLE_AUTHORITY)) throw new Error('Portable metadata authority drift');
  if (stable(value.truthBoundary) !== stable(PORTABLE_TRUTH_BOUNDARY)) throw new Error('Portable metadata truth-boundary drift');
  validateSha(value.processDescriptorSha256, 'portable metadata.processDescriptorSha256');
  object(value.members, 'portable metadata.members');
  const descriptorMember = value.members[DESCRIPTOR_MEMBER];
  object(descriptorMember, `portable metadata.members[${DESCRIPTOR_MEMBER}]`);
  if (descriptorMember.sha256 !== value.processDescriptorSha256) throw new Error('Portable process descriptor member digest mismatch');
}

function validateDescriptor(descriptor) {
  object(descriptor, 'provider descriptor');
  if (descriptor.schema !== CAPABILITY_SCHEMA || descriptor.capabilityId !== CAPABILITY_ID) throw new Error('Provider capability identity mismatch');
  if (descriptor.provider?.repository !== PROVIDER_REPOSITORY || descriptor.provider?.entrypoint !== 'scripts/causal_loop_ndjson.py') throw new Error('Provider source boundary mismatch');
  if (descriptor.protocol?.transport !== 'ndjson-stdio' || descriptor.protocol?.requestSchema !== REQUEST_SCHEMA || descriptor.protocol?.responseSchema !== RESPONSE_SCHEMA) throw new Error('Provider protocol mismatch');
  const operations = descriptor.protocol?.operations;
  if (!Array.isArray(operations) || stable([...operations].sort()) !== stable(['describe', 'run', 'verify'])) throw new Error('Provider operation set mismatch');
  if (descriptor.properties?.deterministic !== true || descriptor.properties?.headless !== true || descriptor.properties?.offline !== true || descriptor.properties?.thirdPartyDependencies !== false) throw new Error('Provider execution-property contract mismatch');
  noProcessAuthority(descriptor.authority, 'provider descriptor.authority');
  const actions = descriptor.engine?.allowedActions;
  if (!Array.isArray(actions) || stable([...actions].sort()) !== stable([...ALLOWED_ACTIONS].sort())) throw new Error('Provider allowed action set mismatch');
  if (descriptor.engine?.maxTimedInfluences !== MAX_TIMED_INFLUENCES || descriptor.engine?.maxWavesLimit !== MAX_WAVES_LIMIT) throw new Error('Provider bounded input contract mismatch');
}

function validateDescribe(response, descriptor) {
  baseResponse(response, 'describe response');
  if (response.status !== 'PASS') throw new Error('Provider describe response is not PASS');
  if (stable(response.capability) !== stable(descriptor)) throw new Error('Provider live descriptor differs from descriptor evidence');
}

function validateRun(response, maxWaves) {
  baseResponse(response, 'run response');
  if (response.status !== 'PASS' || response.executionStatus !== 'converged' || response.replayMatches !== true) throw new Error('Provider run did not produce a replay-matching converged PASS');
  if (response.executionMaxWaves !== maxWaves) throw new Error('Provider maxWaves lineage mismatch');
  object(response.receipt, 'run response.receipt');
  if (response.receipt.status !== 'converged') throw new Error('Provider receipt is not converged');
  if (response.receipt.committed !== false) throw new Error('Provider run receipt unexpectedly claims committed history');
  validateSha(response.receiptHash, 'run response.receiptHash');
  if (response.receipt.receiptHash !== response.receiptHash) throw new Error('Provider response/receipt hash mismatch');
  const inner = { ...response.receipt };
  delete inner.receiptHash;
  if (hashJson(inner) !== response.receiptHash) throw new Error('Provider receipt integrity mismatch in consumer');
}

function validateVerify(response, expectedReceiptHash, maxWaves) {
  baseResponse(response, 'verify response');
  if (response.status !== 'PASS' || response.executionStatus !== 'converged' || response.replayMatches !== true) throw new Error('Provider receipt verification did not PASS');
  if (response.executionMaxWaves !== maxWaves) throw new Error('Provider verify maxWaves lineage mismatch');
  if (response.verifiedReceiptHash !== expectedReceiptHash || response.replayedReceiptHash !== expectedReceiptHash) throw new Error('Provider verify receipt lineage mismatch');
}

function baseResponse(response, label) {
  object(response, label);
  if (response.schema !== RESPONSE_SCHEMA || response.capabilityId !== CAPABILITY_ID) throw new Error(`${label} identity mismatch`);
  noProcessAuthority(response.authority, `${label}.authority`);
}

function noProcessAuthority(authority, label) {
  object(authority, label);
  for (const key of ['commitsHistory', 'writesCanonicalState', 'merges', 'declaresCanon']) {
    if (authority[key] !== false) throw new Error(`${label}.${key} must remain false`);
  }
}

function normalizeInputs({
  portablePath,
  expectedArtifactSha256,
  timedInfluences,
  maxWaves,
  requestId,
  pythonExecutable,
  providerSourceRef,
  timeoutMs,
  skipPathValidation = false
}) {
  if (typeof portablePath !== 'string' || !portablePath || (!skipPathValidation && !isAbsolute(portablePath))) throw new TypeError('portablePath must be an absolute path');
  validateSha(expectedArtifactSha256, 'expectedArtifactSha256');
  if (!Array.isArray(timedInfluences) || timedInfluences.length > MAX_TIMED_INFLUENCES) throw new TypeError(`timedInfluences must be an array of at most ${MAX_TIMED_INFLUENCES} items`);
  const normalizedInfluences = timedInfluences.map((item, index) => {
    object(item, `timedInfluences[${index}]`);
    if (Object.keys(item).sort().join(',') !== 'action,atWave') throw new TypeError(`timedInfluences[${index}] must contain only action and atWave`);
    if (!Number.isInteger(item.atWave) || item.atWave < 0 || item.atWave >= MAX_WAVES_LIMIT) throw new TypeError(`timedInfluences[${index}].atWave is outside the provider contract`);
    if (!ALLOWED_ACTIONS.has(item.action)) throw new TypeError(`timedInfluences[${index}].action is unsupported`);
    return { atWave: item.atWave, action: item.action };
  });
  if (!Number.isInteger(maxWaves) || maxWaves < 1 || maxWaves > MAX_WAVES_LIMIT) throw new TypeError(`maxWaves must be 1..${MAX_WAVES_LIMIT}`);
  if (typeof requestId !== 'string' || !requestId || requestId.length > 96) throw new TypeError('requestId must be 1..96 characters');
  if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim()) throw new TypeError('pythonExecutable must be a non-empty string');
  if (providerSourceRef != null && (typeof providerSourceRef !== 'string' || !providerSourceRef.trim())) throw new TypeError('providerSourceRef must be null or a non-empty string');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be 100..60000 ms');
  return {
    portablePath,
    expectedArtifactSha256,
    timedInfluences: normalizedInfluences,
    maxWaves,
    requestId,
    pythonExecutable,
    providerSourceRef,
    timeoutMs
  };
}

function hold(requested, code, detail) {
  const core = {
    schema: OBSERVATION_SCHEMA,
    capabilityId: CAPABILITY_ID,
    provider: {
      repository: PROVIDER_REPOSITORY,
      sourceRef: requested.providerSourceRef ?? null,
      sourceRefBinding: requested.providerSourceRef ? 'CALLER_DECLARED_NOT_VERIFIED_BY_ADAPTER' : 'UNSPECIFIED',
      transport: 'python-zipapp',
      expectedArtifactSha256: requested.expectedArtifactSha256
    },
    observation: {
      status: 'HOLD',
      runtimeVerifiedWithinProviderContract: false,
      reason: { code, detail: bounded(detail) }
    },
    authority: clone(OBSERVATION_AUTHORITY)
  };
  return { ...core, receiptSha256: hashJson(core) };
}

function tagged(code, message) {
  const error = new Error(message);
  error.axmCode = code;
  return error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function validateSha(value, label) {
  if (!SHA256_RE.test(String(value ?? ''))) throw new TypeError(`${label} must be a lowercase SHA-256`);
}

function bounded(value) {
  return String(value ?? '').trim().slice(0, 512) || 'unspecified portable provider hold';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashJson(value) {
  return sha256(Buffer.from(stable(value), 'utf8'));
}

function stable(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  throw new TypeError('Cannot canonicalize non-JSON value');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
