import { createHash } from 'node:crypto';
import { createExternalSourceReceipt } from './external-source.js';

const COLLECTION_SCHEMA = 'axm.parallel-capability-github-evidence-collection/v0.8';
const DEFAULT_REF_OBSERVATION_ID = 'github.ref-stability';

export async function collectGitHubEvidence({
  client,
  repository,
  ref,
  files = [],
  workflows = [],
  now = () => new Date().toISOString()
}) {
  assertClient(client);
  if (!repository) throw new TypeError('repository is required');
  if (!ref) throw new TypeError('ref is required');
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  if (!Array.isArray(workflows)) throw new TypeError('workflows must be an array');

  const normalizedFiles = normalizeFileChecks(files);
  const normalizedWorkflows = normalizeWorkflowChecks(workflows);
  const start = normalizeResolvedRef(await client.resolveRef({ repository: String(repository), ref: String(ref) }), 'start');
  const observations = [];

  for (const check of normalizedFiles) {
    observations.push(await collectFileObservation({
      client,
      repository: String(repository),
      headSha: start.sha,
      check
    }));
  }

  let workflowRuns = [];
  let workflowListError = null;
  if (normalizedWorkflows.length > 0) {
    try {
      workflowRuns = normalizeWorkflowRuns(await client.listWorkflowRuns({
        repository: String(repository),
        ref: String(ref)
      }));
    } catch (error) {
      workflowListError = serializeError(error);
    }
  }

  for (const check of normalizedWorkflows) {
    observations.push(collectWorkflowObservation({
      repository: String(repository),
      ref: String(ref),
      pinnedHeadSha: start.sha,
      check,
      runs: workflowRuns,
      listError: workflowListError
    }));
  }

  let end = null;
  let endError = null;
  try {
    end = normalizeResolvedRef(await client.resolveRef({ repository: String(repository), ref: String(ref) }), 'end');
  } catch (error) {
    endError = serializeError(error);
  }

  const freshnessStatus = endError
    ? 'UNKNOWN'
    : (end.sha === start.sha ? 'STABLE' : 'MOVED');
  observations.push({
    id: DEFAULT_REF_OBSERVATION_ID,
    kind: 'GITHUB_REF_STABILITY',
    subject: String(ref),
    status: freshnessStatus,
    basis: 'OBSERVED_SOURCE',
    evidenceRef: endError
      ? `github:ref:${repository}:${ref}:end-error`
      : `github:ref:${repository}:${ref}:${start.sha}:${end.sha}`,
    details: {
      startHeadSha: start.sha,
      endHeadSha: end?.sha ?? null,
      endError
    }
  });

  const core = {
    schema: COLLECTION_SCHEMA,
    source: {
      repository: String(repository),
      ref: String(ref),
      pinnedHeadSha: start.sha,
      sourceRef: `github:${repository}@${start.sha}`
    },
    freshness: {
      status: freshnessStatus,
      startHeadSha: start.sha,
      endHeadSha: end?.sha ?? null,
      endError
    },
    observations: observations.sort((a, b) => a.id.localeCompare(b.id))
  };
  const collectionId = `github-evidence-collection:sha256:${sha256(stableStringify(core))}`;
  const status = core.observations.some((item) => item.status === 'ERROR') || freshnessStatus === 'UNKNOWN'
    ? 'PARTIAL'
    : (freshnessStatus === 'MOVED' ? 'PINNED_COMPLETE_REF_MOVED' : 'PINNED_COMPLETE');

  return {
    ...core,
    collectionId,
    status,
    completedAt: now()
  };
}

export function createExternalSourceReceiptFromGitHubCollection(collection, {
  adapterId,
  claims = [],
  requireStableRef = true,
  now = () => new Date().toISOString()
} = {}) {
  assertGitHubEvidenceCollection(collection);
  if (!adapterId) throw new TypeError('adapterId is required');
  if (!Array.isArray(claims)) throw new TypeError('claims must be an array');

  const normalizedClaims = requireStableRef
    ? claims.map((claim) => addRefStabilityRequirement(claim))
    : claims;

  return createExternalSourceReceipt({
    adapterId,
    source: {
      repository: collection.source.repository,
      ref: collection.source.ref,
      headSha: collection.source.pinnedHeadSha,
      sourceRef: collection.source.sourceRef,
      metadata: {
        githubEvidenceCollectionId: collection.collectionId,
        collectionStatus: collection.status,
        freshness: collection.freshness,
        stableRefRequiredForClaims: Boolean(requireStableRef)
      }
    },
    observations: collection.observations,
    claims: normalizedClaims,
    now
  });
}

export function assertGitHubEvidenceCollection(collection) {
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
    throw new TypeError('GitHub evidence collection must be an object');
  }
  if (collection.schema !== COLLECTION_SCHEMA) {
    throw new Error(`Unsupported GitHub evidence collection schema: ${collection.schema ?? '<missing>'}`);
  }
  if (!collection.collectionId) throw new Error('GitHub evidence collection id is missing');
  const core = {
    schema: collection.schema,
    source: collection.source,
    freshness: collection.freshness,
    observations: collection.observations
  };
  const expected = `github-evidence-collection:sha256:${sha256(stableStringify(core))}`;
  if (expected !== collection.collectionId) {
    throw new Error('GitHub evidence collection integrity check failed');
  }
  return true;
}

export function createMemoryGitHubEvidenceClient({
  refs = {},
  files = {},
  workflowRuns = [],
  resolveSequence = null,
  errors = {}
} = {}) {
  let resolveIndex = 0;
  return {
    async resolveRef({ repository, ref }) {
      const errorKey = `resolve:${repository}:${ref}:${resolveIndex}`;
      if (errors[errorKey]) throw errors[errorKey];
      if (Array.isArray(resolveSequence)) {
        const value = resolveSequence[Math.min(resolveIndex, resolveSequence.length - 1)];
        resolveIndex += 1;
        if (!value) throw Object.assign(new Error(`Unknown ref ${repository}@${ref}`), { status: 404 });
        return typeof value === 'string' ? { sha: value } : cloneJson(value);
      }
      const value = refs[`${repository}@${ref}`];
      resolveIndex += 1;
      if (!value) throw Object.assign(new Error(`Unknown ref ${repository}@${ref}`), { status: 404 });
      return typeof value === 'string' ? { sha: value } : cloneJson(value);
    },
    async getFile({ repository, headSha, path }) {
      const errorKey = `file:${repository}@${headSha}:${path}`;
      if (errors[errorKey]) throw errors[errorKey];
      const value = files[`${repository}@${headSha}:${path}`];
      if (value == null) throw Object.assign(new Error(`Not found: ${path}`), { status: 404 });
      return cloneJson(value);
    },
    async listWorkflowRuns({ repository, ref }) {
      const errorKey = `workflows:${repository}:${ref}`;
      if (errors[errorKey]) throw errors[errorKey];
      return cloneJson(workflowRuns);
    }
  };
}

async function collectFileObservation({ client, repository, headSha, check }) {
  try {
    const file = normalizeFileResult(await client.getFile({ repository, headSha, path: check.path }), check.path);
    const shaMatches = check.expectedBlobSha == null ? null : file.sha === check.expectedBlobSha;
    return {
      id: check.id,
      kind: 'GITHUB_FILE',
      subject: check.path,
      status: shaMatches === false ? 'MISMATCH' : 'PRESENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:file:${repository}@${headSha}:${check.path}#${file.sha}`,
      details: {
        path: check.path,
        blobSha: file.sha,
        size: file.size,
        expectedBlobSha: check.expectedBlobSha,
        shaMatches
      }
    };
  } catch (error) {
    if (isNotFound(error)) {
      return {
        id: check.id,
        kind: 'GITHUB_FILE',
        subject: check.path,
        status: 'ABSENT',
        basis: 'OBSERVED_SOURCE',
        evidenceRef: `github:file:${repository}@${headSha}:${check.path}:absent`,
        details: {
          path: check.path,
          expectedBlobSha: check.expectedBlobSha,
          error: serializeError(error)
        }
      };
    }
    return {
      id: check.id,
      kind: 'GITHUB_FILE',
      subject: check.path,
      status: 'ERROR',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:file:${repository}@${headSha}:${check.path}:error`,
      details: {
        path: check.path,
        expectedBlobSha: check.expectedBlobSha,
        error: serializeError(error)
      }
    };
  }
}

function collectWorkflowObservation({ repository, ref, pinnedHeadSha, check, runs, listError }) {
  if (listError) {
    return {
      id: check.id,
      kind: 'GITHUB_ACTIONS_RUN',
      subject: check.path ?? check.name ?? check.id,
      status: 'ERROR',
      basis: 'EXECUTION_EVIDENCE',
      evidenceRef: `github:actions:${repository}:${ref}:${check.id}:error`,
      details: { selector: stripWorkflowCheck(check), error: listError }
    };
  }

  const matching = runs
    .filter((run) => !check.name || run.name === check.name)
    .filter((run) => !check.path || run.path === check.path)
    .filter((run) => check.headPolicy === 'REF_HISTORY' || run.headSha === pinnedHeadSha)
    .sort(compareWorkflowRuns);
  const run = matching[0];
  if (!run) {
    return {
      id: check.id,
      kind: 'GITHUB_ACTIONS_RUN',
      subject: check.path ?? check.name ?? check.id,
      status: 'MISSING',
      basis: 'EXECUTION_EVIDENCE',
      evidenceRef: `github:actions:${repository}:${ref}:${check.id}:missing`,
      details: {
        selector: stripWorkflowCheck(check),
        pinnedHeadSha,
        observedRunCount: runs.length
      }
    };
  }

  return {
    id: check.id,
    kind: 'GITHUB_ACTIONS_RUN',
    subject: check.path ?? check.name ?? check.id,
    status: String(run.conclusion ?? run.status ?? 'UNKNOWN').toUpperCase(),
    basis: 'EXECUTION_EVIDENCE',
    evidenceRef: `github:actions:${repository}:run:${run.id}`,
    details: {
      selector: stripWorkflowCheck(check),
      run,
      pinnedHeadSha,
      exactPinnedHead: run.headSha === pinnedHeadSha
    }
  };
}

function addRefStabilityRequirement(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new TypeError('claim must be an object');
  }
  if (!Array.isArray(claim.requirements) || claim.requirements.length === 0) {
    throw new TypeError('claim.requirements must contain source/execution evidence before freshness is added');
  }
  const requirements = [...claim.requirements];
  if (!requirements.some((item) => item?.observationId === DEFAULT_REF_OBSERVATION_ID)) {
    requirements.push({
      observationId: DEFAULT_REF_OBSERVATION_ID,
      acceptedStatuses: ['STABLE'],
      acceptedBases: ['OBSERVED_SOURCE'],
      rejectStatuses: []
    });
  }
  return { ...claim, requirements };
}

function normalizeFileChecks(files) {
  const seen = new Set();
  return files.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`files[${index}] must be an object`);
    if (!item.path) throw new TypeError(`files[${index}].path is required`);
    const path = String(item.path);
    const id = String(item.id ?? `github.file:${path}`);
    if (seen.has(id)) throw new Error(`Duplicate GitHub file observation id: ${id}`);
    seen.add(id);
    return {
      id,
      path,
      expectedBlobSha: item.expectedBlobSha == null ? null : String(item.expectedBlobSha)
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeWorkflowChecks(workflows) {
  const seen = new Set();
  return workflows.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`workflows[${index}] must be an object`);
    if (!item.id) throw new TypeError(`workflows[${index}].id is required`);
    if (!item.name && !item.path) throw new TypeError(`workflow ${item.id} requires name or path`);
    const id = String(item.id);
    if (seen.has(id)) throw new Error(`Duplicate GitHub workflow observation id: ${id}`);
    seen.add(id);
    const headPolicy = String(item.headPolicy ?? 'PINNED_HEAD');
    if (!['PINNED_HEAD', 'REF_HISTORY'].includes(headPolicy)) throw new Error(`Unsupported headPolicy: ${headPolicy}`);
    return {
      id,
      name: item.name == null ? null : String(item.name),
      path: item.path == null ? null : String(item.path),
      headPolicy
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeWorkflowRuns(runs) {
  if (!Array.isArray(runs)) throw new TypeError('listWorkflowRuns must return an array');
  return runs.map((run, index) => {
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new TypeError(`workflowRuns[${index}] must be an object`);
    if (run.id == null) throw new TypeError(`workflowRuns[${index}].id is required`);
    return {
      id: String(run.id),
      name: run.name == null ? null : String(run.name),
      path: run.path == null ? null : String(run.path),
      headSha: String(run.headSha ?? run.head_sha ?? ''),
      status: run.status == null ? null : String(run.status),
      conclusion: run.conclusion == null ? null : String(run.conclusion),
      createdAt: run.createdAt == null && run.created_at == null ? null : String(run.createdAt ?? run.created_at),
      updatedAt: run.updatedAt == null && run.updated_at == null ? null : String(run.updatedAt ?? run.updated_at)
    };
  });
}

function normalizeResolvedRef(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.sha) {
    throw new TypeError(`${label} resolveRef result requires sha`);
  }
  return { sha: String(value.sha) };
}

function normalizeFileResult(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.sha) {
    throw new TypeError(`getFile result for ${path} requires sha`);
  }
  const size = Number(value.size ?? 0);
  if (!Number.isFinite(size) || size < 0) throw new TypeError(`getFile result for ${path} has invalid size`);
  return { sha: String(value.sha), size };
}

function compareWorkflowRuns(a, b) {
  const timeA = a.createdAt == null ? '' : a.createdAt;
  const timeB = b.createdAt == null ? '' : b.createdAt;
  return timeB.localeCompare(timeA) || b.id.localeCompare(a.id);
}

function stripWorkflowCheck(check) {
  return { id: check.id, name: check.name, path: check.path, headPolicy: check.headPolicy };
}

function assertClient(client) {
  if (!client || typeof client !== 'object') throw new TypeError('client is required');
  for (const method of ['resolveRef', 'getFile', 'listWorkflowRuns']) {
    if (typeof client[method] !== 'function') throw new TypeError(`client.${method} must be a function`);
  }
}

function isNotFound(error) {
  return error?.status === 404 || error?.statusCode === 404 || error?.code === 'NOT_FOUND';
}

function serializeError(error) {
  return {
    name: String(error?.name ?? 'Error'),
    message: String(error?.message ?? error ?? 'Unknown error'),
    status: error?.status == null ? null : Number(error.status),
    code: error?.code == null ? null : String(error.code)
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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
  throw new TypeError('Cannot canonicalize non-JSON value');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
