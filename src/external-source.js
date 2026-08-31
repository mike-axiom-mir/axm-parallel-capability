import { createHash } from 'node:crypto';
import {
  createRegistryBundle,
  validateCapabilityManifest
} from './registry.js';

const RECEIPT_SCHEMA = 'axm.parallel-capability-external-source-receipt/v0.7';
const CAPABILITY_SCHEMA = 'axm.parallel-capability-manifest/v0.6';
const BODY_MAP_SCHEMA = 'axm.parallel-capability-body-map-manifest/v0.6';
const DEFAULT_VERIFICATION_BASES = Object.freeze([
  'OBSERVED_SOURCE',
  'EXECUTION_EVIDENCE'
]);
const DEFAULT_REJECT_STATUSES = Object.freeze([
  'MISMATCH',
  'CONTRADICTED'
]);

export function createExternalSourceReceipt({
  adapterId,
  source,
  observations = [],
  claims = [],
  now = () => new Date().toISOString()
}) {
  if (!adapterId) throw new TypeError('adapterId is required');
  const normalizedSource = normalizeSource(source);
  const normalizedObservations = normalizeObservations(observations);
  const observationsById = new Map(normalizedObservations.map((item) => [item.id, item]));
  const normalizedClaims = normalizeClaims(claims);
  const evaluatedClaims = normalizedClaims.map((claim) => evaluateClaim(claim, observationsById));

  const core = {
    schema: RECEIPT_SCHEMA,
    adapterId: String(adapterId),
    source: normalizedSource,
    observations: normalizedObservations,
    claims: evaluatedClaims
  };
  const receiptId = `external-source-receipt:sha256:${sha256(stableStringify(core))}`;

  return {
    ...core,
    receiptId,
    completedAt: now()
  };
}

export function createVerifiedExternalCapabilityManifest(receipt, {
  claimId,
  manifest
}) {
  assertReceipt(receipt);
  if (!claimId) throw new TypeError('claimId is required');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('manifest must be a portable object');
  }
  assertJson(manifest, 'manifest');

  const claim = receipt.claims.find((item) => item.id === String(claimId));
  if (!claim) throw new Error(`Unknown external claim: ${claimId}`);
  if (claim.status !== 'SOURCE_VERIFIED') {
    throw new Error(`External claim ${claimId} is not source verified: ${claim.status}`);
  }
  if (String(manifest.id ?? '') !== claim.capabilityId) {
    throw new Error(`Manifest id ${manifest.id ?? '<missing>'} does not match verified capability ${claim.capabilityId}`);
  }

  const enhanced = {
    ...cloneJson(manifest),
    schema: String(manifest.schema ?? CAPABILITY_SCHEMA),
    sourceRef: String(manifest.sourceRef ?? receipt.source.sourceRef),
    evidenceRefs: uniqueStrings([
      ...(manifest.evidenceRefs ?? []),
      receipt.receiptId,
      ...claim.passedEvidenceRefs
    ]),
    metadata: {
      ...(cloneJson(manifest.metadata ?? {})),
      externalAdapter: {
        adapterId: receipt.adapterId,
        receiptId: receipt.receiptId,
        claimId: claim.id,
        verificationStatus: claim.status,
        repository: receipt.source.repository,
        ref: receipt.source.ref,
        headSha: receipt.source.headSha
      }
    }
  };

  // Reuse the v0.6 portable-manifest validator. No executable callback is
  // accepted through this path; runtime binding remains local registry state.
  return validateCapabilityManifest(enhanced).manifest;
}

export function createVerifiedExternalRegistryBundle({
  receipt,
  capabilities = [],
  bodyMaps = []
}) {
  assertReceipt(receipt);
  if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array');
  if (!Array.isArray(bodyMaps)) throw new TypeError('bodyMaps must be an array');
  const verifiedCapabilities = capabilities.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`capabilities[${index}] must be an object`);
    }
    return createVerifiedExternalCapabilityManifest(receipt, item);
  });
  const normalizedBodyMaps = bodyMaps.map((bodyMap, index) => {
    if (!bodyMap || typeof bodyMap !== 'object' || Array.isArray(bodyMap)) {
      throw new TypeError(`bodyMaps[${index}] must be an object`);
    }
    assertJson(bodyMap, `bodyMaps[${index}]`);
    return {
      ...cloneJson(bodyMap),
      schema: String(bodyMap.schema ?? BODY_MAP_SCHEMA)
    };
  });
  return createRegistryBundle({ capabilities: verifiedCapabilities, bodyMaps: normalizedBodyMaps });
}

export function getExternalClaim(receipt, claimId) {
  assertReceipt(receipt);
  const claim = receipt.claims.find((item) => item.id === String(claimId));
  return claim ? cloneJson(claim) : null;
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('source must be an object');
  }
  if (!source.repository) throw new TypeError('source.repository is required');
  if (!source.ref) throw new TypeError('source.ref is required');
  if (!source.headSha) throw new TypeError('source.headSha is required');
  assertJson(source.metadata ?? {}, 'source.metadata');
  const repository = String(source.repository);
  const ref = String(source.ref);
  const headSha = String(source.headSha);
  return {
    repository,
    ref,
    headSha,
    sourceRef: String(source.sourceRef ?? `github:${repository}@${headSha}`),
    metadata: cloneJson(source.metadata ?? {})
  };
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  const seen = new Set();
  return observations.map((observation, index) => {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new TypeError(`observations[${index}] must be an object`);
    }
    if (!observation.id) throw new TypeError(`observations[${index}].id is required`);
    if (!observation.kind) throw new TypeError(`observation ${observation.id} kind is required`);
    if (!observation.status) throw new TypeError(`observation ${observation.id} status is required`);
    if (!observation.basis) throw new TypeError(`observation ${observation.id} basis is required`);
    if (!observation.evidenceRef) throw new TypeError(`observation ${observation.id} evidenceRef is required`);
    const id = String(observation.id);
    if (seen.has(id)) throw new Error(`Duplicate observation id: ${id}`);
    seen.add(id);
    assertJson(observation.details ?? {}, `observation ${id}.details`);
    return {
      id,
      kind: String(observation.kind),
      subject: observation.subject == null ? null : String(observation.subject),
      status: String(observation.status),
      basis: String(observation.basis),
      evidenceRef: String(observation.evidenceRef),
      details: cloneJson(observation.details ?? {})
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeClaims(claims) {
  if (!Array.isArray(claims)) throw new TypeError('claims must be an array');
  const seen = new Set();
  return claims.map((claim, index) => {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      throw new TypeError(`claims[${index}] must be an object`);
    }
    if (!claim.id) throw new TypeError(`claims[${index}].id is required`);
    if (!claim.capabilityId) throw new TypeError(`claim ${claim.id} capabilityId is required`);
    if (!Array.isArray(claim.requirements) || claim.requirements.length === 0) {
      throw new TypeError(`claim ${claim.id} requirements must be a non-empty array`);
    }
    const id = String(claim.id);
    if (seen.has(id)) throw new Error(`Duplicate external claim id: ${id}`);
    seen.add(id);
    assertJson(claim.metadata ?? {}, `claim ${id}.metadata`);
    return {
      id,
      capabilityId: String(claim.capabilityId),
      requirements: claim.requirements.map((requirement, requirementIndex) =>
        normalizeClaimRequirement(requirement, `${id}.requirements[${requirementIndex}]`)
      ).sort((a, b) => a.observationId.localeCompare(b.observationId)),
      metadata: cloneJson(claim.metadata ?? {})
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeClaimRequirement(requirement, label) {
  if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (!requirement.observationId) throw new TypeError(`${label}.observationId is required`);
  const acceptedStatuses = uniqueStrings(requirement.acceptedStatuses ?? []);
  if (acceptedStatuses.length === 0) throw new TypeError(`${label}.acceptedStatuses must be non-empty`);
  const acceptedBases = uniqueStrings(requirement.acceptedBases ?? DEFAULT_VERIFICATION_BASES);
  if (acceptedBases.length === 0) throw new TypeError(`${label}.acceptedBases must be non-empty`);
  return {
    observationId: String(requirement.observationId),
    acceptedStatuses,
    acceptedBases,
    rejectStatuses: uniqueStrings(requirement.rejectStatuses ?? DEFAULT_REJECT_STATUSES)
  };
}

function evaluateClaim(claim, observationsById) {
  const passed = [];
  const blockers = [];
  let contradicted = false;

  for (const requirement of claim.requirements) {
    const observation = observationsById.get(requirement.observationId);
    if (!observation) {
      blockers.push({
        observationId: requirement.observationId,
        reason: 'MISSING_OBSERVATION'
      });
      continue;
    }
    if (requirement.rejectStatuses.includes(observation.status)) {
      contradicted = true;
      blockers.push({
        observationId: observation.id,
        reason: 'REJECT_STATUS',
        actualStatus: observation.status,
        actualBasis: observation.basis
      });
      continue;
    }
    const statusAccepted = requirement.acceptedStatuses.includes(observation.status);
    const basisAccepted = requirement.acceptedBases.includes(observation.basis);
    if (!statusAccepted || !basisAccepted) {
      blockers.push({
        observationId: observation.id,
        reason: !statusAccepted ? 'STATUS_NOT_ACCEPTED' : 'EVIDENCE_BASIS_NOT_ACCEPTED',
        actualStatus: observation.status,
        actualBasis: observation.basis,
        acceptedStatuses: requirement.acceptedStatuses,
        acceptedBases: requirement.acceptedBases
      });
      continue;
    }
    passed.push({
      observationId: observation.id,
      status: observation.status,
      basis: observation.basis,
      evidenceRef: observation.evidenceRef
    });
  }

  const status = contradicted
    ? 'SOURCE_CONTRADICTED'
    : (blockers.length === 0 ? 'SOURCE_VERIFIED' : 'HOLD_SOURCE_INCOMPLETE');

  return {
    id: claim.id,
    capabilityId: claim.capabilityId,
    status,
    requirements: cloneJson(claim.requirements),
    passedEvidence: passed.sort((a, b) => a.observationId.localeCompare(b.observationId)),
    passedEvidenceRefs: uniqueStrings(passed.map((item) => item.evidenceRef)),
    blockers: blockers.sort((a, b) => a.observationId.localeCompare(b.observationId)),
    metadata: cloneJson(claim.metadata)
  };
}

function assertReceipt(receipt) {
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) {
    throw new Error(`Unsupported external source receipt schema: ${receipt?.schema ?? '<missing>'}`);
  }
  const core = {
    schema: receipt.schema,
    adapterId: receipt.adapterId,
    source: receipt.source,
    observations: receipt.observations,
    claims: receipt.claims
  };
  const expected = `external-source-receipt:sha256:${sha256(stableStringify(core))}`;
  if (receipt.receiptId !== expected) throw new Error('External source receipt integrity check failed');
}

function uniqueStrings(values) {
  return [...new Set(values.map(String))].sort();
}

function cloneJson(value) {
  assertJson(value, 'value');
  return structuredClone(value);
}

function assertJson(value, label) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must be JSON-compatible`);
    }
    for (const [key, item] of Object.entries(value)) assertJson(item, `${label}.${key}`);
    return;
  }
  throw new TypeError(`${label} must be JSON-compatible`);
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
