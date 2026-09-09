import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const CAPABILITY_ID = 'axm.causal-loop.train-platform.process/v1';
const PROVIDER_REPOSITORY = 'mike-axiom-mir/axm-casual-loop';
const REQUEST_SCHEMA = 'axm.causal-loop.process-request/v1';
const RESPONSE_SCHEMA = 'axm.causal-loop.process-response/v1';
const CAPABILITY_SCHEMA = 'axm.capability/v1';
const OBSERVATION_SCHEMA = 'axm.parallel-capability-runtime-observation/v0.1';
const ENTRYPOINT = 'scripts/causal_loop_ndjson.py';
const DESCRIPTOR_PATH = 'capabilities/causal-loop-process-v1.json';
const ALLOWED_ACTIONS = new Set(['WAIT', 'BLOCK_DOOR', 'TRIGGER_ALARM', 'TALK_TO_PASSENGER']);
const MAX_WAVES_LIMIT = 256;
const MAX_TIMED_INFLUENCES = 64;
const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function observeCausalLoopProvider({
  providerRoot,
  timedInfluences = [],
  maxWaves = 64,
  requestId = 'parallel-capability-observation',
  pythonExecutable = process.env.PYTHON || 'python3',
  providerSourceRef = null,
  timeoutMs = 15_000
} = {}) {
  const requested = normalizeInputs({ providerRoot, timedInfluences, maxWaves, requestId, providerSourceRef, timeoutMs });
  try {
    const files = resolveProviderFiles(requested.providerRoot);
    const descriptorText = readFileSync(files.descriptorPath, 'utf8');
    const descriptor = JSON.parse(descriptorText);
    validateDescriptor(descriptor);

    const requests = [
      { schema: REQUEST_SCHEMA, requestId: `${requested.requestId}:describe`, op: 'describe' },
      {
        schema: REQUEST_SCHEMA,
        requestId: `${requested.requestId}:run`,
        op: 'run',
        timedInfluences: requested.timedInfluences,
        maxWaves: requested.maxWaves
      }
    ];
    const input = `${requests.map((item) => JSON.stringify(item)).join('\n')}\n`;
    const completed = spawnSync(pythonExecutable, [files.entrypointPath], {
      cwd: process.cwd(),
      input,
      encoding: 'utf8',
      timeout: requested.timeoutMs,
      maxBuffer: MAX_PROVIDER_OUTPUT_BYTES,
      windowsHide: true
    });

    if (completed.error) return hold(requested, 'PROVIDER_EXECUTION_UNAVAILABLE', completed.error.message);
    if (completed.signal) return hold(requested, 'PROVIDER_EXECUTION_INTERRUPTED', `provider exited via signal ${completed.signal}`);
    if (completed.status !== 0) return hold(requested, 'PROVIDER_EXECUTION_HELD', bounded(completed.stderr || `provider exited ${completed.status}`));
    if (completed.stderr) return hold(requested, 'PROVIDER_STDERR_NOT_EMPTY', bounded(completed.stderr));

    const lines = completed.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length !== 2) return hold(requested, 'PROVIDER_RESPONSE_COUNT_MISMATCH', `expected 2 NDJSON responses, received ${lines.length}`);

    let describeResponse;
    let runResponse;
    try {
      describeResponse = JSON.parse(lines[0]);
      runResponse = JSON.parse(lines[1]);
    } catch (error) {
      return hold(requested, 'PROVIDER_RESPONSE_INVALID_JSON', error.message);
    }

    return createCausalLoopRuntimeObservation({
      timedInfluences: requested.timedInfluences,
      maxWaves: requested.maxWaves,
      requestId: requested.requestId,
      providerSourceRef: requested.providerSourceRef,
      providerEntrypointSha256: sha256(readFileSync(files.entrypointPath)),
      providerDescriptorSha256: sha256(Buffer.from(descriptorText, 'utf8')),
      descriptor,
      describeResponse,
      runResponse
    });
  } catch (error) {
    return hold(requested, error.axmCode || (error instanceof SyntaxError ? 'PROVIDER_DESCRIPTOR_INVALID_JSON' : 'PROVIDER_CONTRACT_REJECTED'), error.message);
  }
}

export function createCausalLoopRuntimeObservation({
  timedInfluences = [],
  maxWaves = 64,
  requestId = 'parallel-capability-observation',
  providerSourceRef = null,
  providerEntrypointSha256,
  providerDescriptorSha256,
  descriptor,
  describeResponse,
  runResponse
}) {
  const requested = normalizeInputs({ providerRoot: '/validated-by-caller', timedInfluences, maxWaves, requestId, providerSourceRef, timeoutMs: 15_000 });
  validateSha(providerEntrypointSha256, 'providerEntrypointSha256');
  validateSha(providerDescriptorSha256, 'providerDescriptorSha256');
  validateDescriptor(descriptor);
  validateDescribe(describeResponse, descriptor);
  validateRun(runResponse, requested.maxWaves);

  const core = {
    schema: OBSERVATION_SCHEMA,
    capabilityId: CAPABILITY_ID,
    provider: {
      repository: PROVIDER_REPOSITORY,
      sourceRef: requested.providerSourceRef,
      sourceRefBinding: requested.providerSourceRef ? 'CALLER_DECLARED_NOT_VERIFIED_BY_ADAPTER' : 'UNSPECIFIED',
      entrypoint: ENTRYPOINT,
      entrypointSha256: providerEntrypointSha256,
      descriptorPath: DESCRIPTOR_PATH,
      descriptorSha256: providerDescriptorSha256
    },
    request: {
      timedInfluences: requested.timedInfluences,
      maxWaves: requested.maxWaves,
      requestSha256: hashJson({ timedInfluences: requested.timedInfluences, maxWaves: requested.maxWaves })
    },
    observation: {
      status: 'RUNTIME_OBSERVED',
      providerStatus: runResponse.status,
      executionStatus: runResponse.executionStatus,
      replayMatches: runResponse.replayMatches,
      providerReceiptHash: runResponse.receiptHash,
      providerReceiptCommitted: runResponse.receipt.committed,
      runtimeVerifiedWithinProviderContract: true
    },
    providerEvidence: {
      descriptor: clone(descriptor),
      describeResponse: clone(describeResponse),
      runResponse: clone(runResponse)
    },
    truthBoundary: {
      sourceRefVerifiedByAdapter: false,
      providerReplayWasReportedAndContractChecked: true,
      providerImplementationIndependentlyReplayedByConsumer: false,
      providerReceiptIsCommittedHistory: false
    },
    authority: {
      kind: 'RUNTIME_EVIDENCE_ONLY',
      automaticSelection: false,
      automaticRegistration: false,
      installation: false,
      merge: false,
      canon: false
    }
  };
  return { ...core, receiptSha256: hashJson(core) };
}

export function verifyCausalLoopRuntimeObservation(receipt) {
  object(receipt, 'runtime observation');
  if (receipt.schema !== OBSERVATION_SCHEMA) throw new Error(`Unsupported runtime observation schema: ${receipt.schema ?? '<missing>'}`);
  if (receipt.capabilityId !== CAPABILITY_ID) throw new Error('Runtime observation capabilityId mismatch');
  validateSha(receipt.receiptSha256, 'receiptSha256');
  const core = { ...receipt };
  delete core.receiptSha256;
  if (receipt.receiptSha256 !== hashJson(core)) throw new Error('Runtime observation receiptSha256 mismatch');

  object(receipt.provider, 'runtime observation.provider');
  if (receipt.provider.repository !== PROVIDER_REPOSITORY) throw new Error('Runtime observation provider repository mismatch');
  if (receipt.provider.entrypoint !== ENTRYPOINT || receipt.provider.descriptorPath !== DESCRIPTOR_PATH) throw new Error('Runtime observation provider path mismatch');
  validateSha(receipt.provider.entrypointSha256, 'provider.entrypointSha256');
  validateSha(receipt.provider.descriptorSha256, 'provider.descriptorSha256');

  validateDescriptor(receipt.providerEvidence?.descriptor);
  validateDescribe(receipt.providerEvidence?.describeResponse, receipt.providerEvidence.descriptor);
  validateRun(receipt.providerEvidence?.runResponse, receipt.request?.maxWaves);
  const runResponse = receipt.providerEvidence.runResponse;
  if (receipt.observation?.status !== 'RUNTIME_OBSERVED') throw new Error('Runtime observation status mismatch');
  if (receipt.observation.providerReceiptHash !== runResponse.receiptHash) throw new Error('Runtime observation provider receipt lineage mismatch');
  if (receipt.observation.providerReceiptCommitted !== false) throw new Error('Runtime observation must not promote uncommitted provider evidence');
  if (receipt.authority?.kind !== 'RUNTIME_EVIDENCE_ONLY') throw new Error('Runtime observation authority kind mismatch');
  for (const key of ['automaticSelection', 'automaticRegistration', 'installation', 'merge', 'canon']) {
    if (receipt.authority[key] !== false) throw new Error(`Runtime observation authority.${key} must remain false`);
  }
  return {
    status: 'PASS',
    schema: receipt.schema,
    capabilityId: receipt.capabilityId,
    receiptSha256: receipt.receiptSha256,
    providerReceiptHash: runResponse.receiptHash,
    runtimeObserved: true,
    authority: 'RUNTIME_EVIDENCE_ONLY'
  };
}

function validateDescriptor(descriptor) {
  object(descriptor, 'provider descriptor');
  if (descriptor.schema !== CAPABILITY_SCHEMA || descriptor.capabilityId !== CAPABILITY_ID) throw new Error('Provider capability identity mismatch');
  if (descriptor.provider?.repository !== PROVIDER_REPOSITORY || descriptor.provider?.entrypoint !== ENTRYPOINT) throw new Error('Provider source boundary mismatch');
  if (descriptor.protocol?.transport !== 'ndjson-stdio' || descriptor.protocol?.requestSchema !== REQUEST_SCHEMA || descriptor.protocol?.responseSchema !== RESPONSE_SCHEMA) throw new Error('Provider protocol mismatch');
  const operations = descriptor.protocol?.operations;
  if (!Array.isArray(operations) || stable([...operations].sort()) !== stable(['describe', 'run', 'verify'])) throw new Error('Provider operation set mismatch');
  if (descriptor.properties?.deterministic !== true || descriptor.properties?.headless !== true || descriptor.properties?.offline !== true || descriptor.properties?.thirdPartyDependencies !== false) throw new Error('Provider execution-property contract mismatch');
  noAuthority(descriptor.authority, 'provider descriptor.authority');
  const actions = descriptor.engine?.allowedActions;
  if (!Array.isArray(actions) || stable([...actions].sort()) !== stable([...ALLOWED_ACTIONS].sort())) throw new Error('Provider allowed action set mismatch');
  if (descriptor.engine?.maxTimedInfluences !== MAX_TIMED_INFLUENCES || descriptor.engine?.maxWavesLimit !== MAX_WAVES_LIMIT) throw new Error('Provider bounded input contract mismatch');
}

function validateDescribe(response, descriptor) {
  baseResponse(response, 'describe response');
  if (response.status !== 'PASS') throw new Error('Provider describe response is not PASS');
  if (stable(response.capability) !== stable(descriptor)) throw new Error('Provider live descriptor differs from descriptor file');
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

function baseResponse(response, label) {
  object(response, label);
  if (response.schema !== RESPONSE_SCHEMA || response.capabilityId !== CAPABILITY_ID) throw new Error(`${label} identity mismatch`);
  noAuthority(response.authority, `${label}.authority`);
}

function noAuthority(authority, label) {
  object(authority, label);
  for (const key of ['commitsHistory', 'writesCanonicalState', 'merges', 'declaresCanon']) if (authority[key] !== false) throw new Error(`${label}.${key} must be false`);
}

function resolveProviderFiles(providerRoot) {
  if (typeof providerRoot !== 'string' || !providerRoot || !isAbsolute(providerRoot)) throw tagged('PROVIDER_ROOT_INVALID', 'providerRoot must be an absolute path');
  if (!existsSync(providerRoot)) throw tagged('PROVIDER_UNAVAILABLE', `providerRoot does not exist: ${providerRoot}`);
  const root = realpathSync(providerRoot);
  const entrypointPath = join(root, ENTRYPOINT);
  const descriptorPath = join(root, DESCRIPTOR_PATH);
  for (const [label, candidate] of [['entrypoint', entrypointPath], ['descriptor', descriptorPath]]) {
    if (!existsSync(candidate)) throw tagged('PROVIDER_UNAVAILABLE', `provider ${label} is missing`);
    if (lstatSync(candidate).isSymbolicLink()) throw tagged('PROVIDER_PATH_UNSAFE', `provider ${label} must not be a symbolic link`);
    const rel = relative(root, realpathSync(candidate));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw tagged('PROVIDER_PATH_UNSAFE', `provider ${label} escapes providerRoot`);
  }
  return { entrypointPath, descriptorPath };
}

function normalizeInputs({ providerRoot, timedInfluences, maxWaves, requestId, providerSourceRef, timeoutMs }) {
  if (!Array.isArray(timedInfluences) || timedInfluences.length > MAX_TIMED_INFLUENCES) throw new TypeError(`timedInfluences must be an array of at most ${MAX_TIMED_INFLUENCES} items`);
  const normalized = timedInfluences.map((item, index) => {
    object(item, `timedInfluences[${index}]`);
    if (Object.keys(item).sort().join(',') !== 'action,atWave') throw new TypeError(`timedInfluences[${index}] must contain only action and atWave`);
    if (!Number.isInteger(item.atWave) || item.atWave < 0 || item.atWave >= MAX_WAVES_LIMIT) throw new TypeError(`timedInfluences[${index}].atWave is outside the provider contract`);
    if (!ALLOWED_ACTIONS.has(item.action)) throw new TypeError(`timedInfluences[${index}].action is unsupported`);
    return { atWave: item.atWave, action: item.action };
  });
  if (!Number.isInteger(maxWaves) || maxWaves < 1 || maxWaves > MAX_WAVES_LIMIT) throw new TypeError(`maxWaves must be 1..${MAX_WAVES_LIMIT}`);
  if (typeof requestId !== 'string' || !requestId || requestId.length > 96) throw new TypeError('requestId must be 1..96 characters');
  if (providerSourceRef != null && (typeof providerSourceRef !== 'string' || !providerSourceRef.trim())) throw new TypeError('providerSourceRef must be null or a non-empty string');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be 100..60000 ms');
  return { providerRoot, timedInfluences: normalized, maxWaves, requestId, providerSourceRef, timeoutMs };
}

function hold(requested, code, detail) {
  const core = {
    schema: OBSERVATION_SCHEMA,
    capabilityId: CAPABILITY_ID,
    provider: {
      repository: PROVIDER_REPOSITORY,
      sourceRef: requested.providerSourceRef ?? null,
      sourceRefBinding: requested.providerSourceRef ? 'CALLER_DECLARED_NOT_VERIFIED_BY_ADAPTER' : 'UNSPECIFIED'
    },
    observation: { status: 'HOLD', runtimeVerifiedWithinProviderContract: false, reason: { code, detail: bounded(detail) } },
    authority: { kind: 'RUNTIME_EVIDENCE_ONLY', automaticSelection: false, automaticRegistration: false, installation: false, merge: false, canon: false }
  };
  return { ...core, receiptSha256: hashJson(core) };
}

function tagged(code, message) { const error = new Error(message); error.axmCode = code; return error; }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`); }
function validateSha(value, label) { if (!SHA256_RE.test(String(value ?? ''))) throw new TypeError(`${label} must be a lowercase SHA-256`); }
function bounded(value) { return String(value ?? '').trim().slice(0, 512) || 'unspecified provider hold'; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hashJson(value) { return sha256(Buffer.from(stable(value), 'utf8')); }
function stable(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  throw new TypeError('Cannot canonicalize non-JSON value');
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
