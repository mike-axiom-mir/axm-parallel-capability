import { createHash } from 'node:crypto';
import {
  assertGitHubEvidenceCollection,
  createExternalSourceReceiptFromGitHubCollection
} from './github-evidence.js';

const REFRESH_SCHEMA = 'axm.parallel-capability-evidence-refresh-receipt/v0.9';

export function createEvidenceRefreshReceipt({
  previousCollection,
  nextCollection,
  adapterId,
  claims,
  requireStableRef = true,
  now = () => new Date().toISOString()
}) {
  assertGitHubEvidenceCollection(previousCollection);
  assertGitHubEvidenceCollection(nextCollection);
  if (!adapterId) throw new TypeError('adapterId is required');
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new TypeError('claims must be a non-empty array');
  }

  assertSameSource(previousCollection, nextCollection);

  const previousReceipt = createExternalSourceReceiptFromGitHubCollection(previousCollection, {
    adapterId,
    claims,
    requireStableRef,
    now
  });
  const nextReceipt = createExternalSourceReceiptFromGitHubCollection(nextCollection, {
    adapterId,
    claims,
    requireStableRef,
    now
  });

  const observationTransitions = compareObservations(
    previousCollection.observations,
    nextCollection.observations
  );
  const claimTransitions = compareClaims(previousReceipt.claims, nextReceipt.claims);

  const core = {
    schema: REFRESH_SCHEMA,
    adapterId: String(adapterId),
    source: {
      repository: previousCollection.source.repository,
      ref: previousCollection.source.ref
    },
    policy: {
      requireStableRef: Boolean(requireStableRef)
    },
    previous: lineage(previousCollection, previousReceipt),
    next: lineage(nextCollection, nextReceipt),
    headChanged: previousCollection.source.pinnedHeadSha !== nextCollection.source.pinnedHeadSha,
    collectionChanged: previousCollection.collectionId !== nextCollection.collectionId,
    observationTransitions,
    claimTransitions,
    summary: summarizeTransitions(observationTransitions, claimTransitions)
  };

  const refreshId = `evidence-refresh:sha256:${sha256(stableStringify(core))}`;
  return {
    ...core,
    refreshId,
    completedAt: now()
  };
}

export function assertEvidenceRefreshReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new TypeError('evidence refresh receipt must be an object');
  }
  if (receipt.schema !== REFRESH_SCHEMA) {
    throw new Error(`Unsupported evidence refresh schema: ${receipt.schema ?? '<missing>'}`);
  }
  if (!receipt.refreshId) throw new Error('evidence refresh id is missing');
  const core = {
    schema: receipt.schema,
    adapterId: receipt.adapterId,
    source: receipt.source,
    policy: receipt.policy,
    previous: receipt.previous,
    next: receipt.next,
    headChanged: receipt.headChanged,
    collectionChanged: receipt.collectionChanged,
    observationTransitions: receipt.observationTransitions,
    claimTransitions: receipt.claimTransitions,
    summary: receipt.summary
  };
  const expected = `evidence-refresh:sha256:${sha256(stableStringify(core))}`;
  if (expected !== receipt.refreshId) {
    throw new Error('evidence refresh integrity check failed');
  }
  return true;
}

export function getClaimTransition(refreshReceipt, claimId) {
  assertEvidenceRefreshReceipt(refreshReceipt);
  const transition = refreshReceipt.claimTransitions.find((item) => item.claimId === String(claimId));
  return transition ? cloneJson(transition) : null;
}

function assertSameSource(previousCollection, nextCollection) {
  if (previousCollection.source.repository !== nextCollection.source.repository) {
    throw new Error('evidence refresh requires the same repository');
  }
  if (previousCollection.source.ref !== nextCollection.source.ref) {
    throw new Error('evidence refresh requires the same named ref');
  }
}

function lineage(collection, receipt) {
  return {
    collectionId: collection.collectionId,
    collectionStatus: collection.status,
    pinnedHeadSha: collection.source.pinnedHeadSha,
    sourceRef: collection.source.sourceRef,
    freshness: cloneJson(collection.freshness),
    externalReceiptId: receipt.receiptId
  };
}

function compareObservations(previousObservations, nextObservations) {
  const previous = new Map(previousObservations.map((item) => [item.id, item]));
  const next = new Map(nextObservations.map((item) => [item.id, item]));
  const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();

  return ids.map((id) => {
    const before = previous.get(id) ?? null;
    const after = next.get(id) ?? null;
    if (!before) return observationTransition('ADDED', id, null, after);
    if (!after) return observationTransition('REMOVED', id, before, null);
    return observationTransition(
      stableStringify(before) === stableStringify(after) ? 'UNCHANGED' : 'CHANGED',
      id,
      before,
      after
    );
  });
}

function observationTransition(change, observationId, before, after) {
  return {
    observationId,
    change,
    kind: after?.kind ?? before?.kind ?? null,
    subject: after?.subject ?? before?.subject ?? null,
    previousStatus: before?.status ?? null,
    nextStatus: after?.status ?? null,
    previousBasis: before?.basis ?? null,
    nextBasis: after?.basis ?? null,
    previousEvidenceRef: before?.evidenceRef ?? null,
    nextEvidenceRef: after?.evidenceRef ?? null,
    previousDetailsHash: before == null ? null : `sha256:${sha256(stableStringify(before.details ?? {}))}`,
    nextDetailsHash: after == null ? null : `sha256:${sha256(stableStringify(after.details ?? {}))}`,
    statusChanged: (before?.status ?? null) !== (after?.status ?? null),
    basisChanged: (before?.basis ?? null) !== (after?.basis ?? null),
    evidenceChanged: (before?.evidenceRef ?? null) !== (after?.evidenceRef ?? null)
  };
}

function compareClaims(previousClaims, nextClaims) {
  const previous = new Map(previousClaims.map((item) => [item.id, item]));
  const next = new Map(nextClaims.map((item) => [item.id, item]));
  const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();

  return ids.map((claimId) => {
    const before = previous.get(claimId) ?? null;
    const after = next.get(claimId) ?? null;
    const previousStatus = before?.status ?? null;
    const nextStatus = after?.status ?? null;
    return {
      claimId,
      capabilityId: after?.capabilityId ?? before?.capabilityId ?? null,
      change: before == null ? 'ADDED' : (after == null ? 'REMOVED' : (previousStatus === nextStatus ? 'UNCHANGED' : 'CHANGED')),
      transition: `${previousStatus ?? '<missing>'}->${nextStatus ?? '<missing>'}`,
      previousStatus,
      nextStatus,
      previousPassedEvidenceRefs: cloneJson(before?.passedEvidenceRefs ?? []),
      nextPassedEvidenceRefs: cloneJson(after?.passedEvidenceRefs ?? []),
      previousBlockers: cloneJson(before?.blockers ?? []),
      nextBlockers: cloneJson(after?.blockers ?? [])
    };
  });
}

function summarizeTransitions(observations, claims) {
  return {
    observations: countChanges(observations),
    claims: countChanges(claims),
    verifiedPromotions: claims
      .filter((item) => item.previousStatus !== 'SOURCE_VERIFIED' && item.nextStatus === 'SOURCE_VERIFIED')
      .map((item) => item.claimId),
    verifiedDemotions: claims
      .filter((item) => item.previousStatus === 'SOURCE_VERIFIED' && item.nextStatus !== 'SOURCE_VERIFIED')
      .map((item) => item.claimId),
    contradictionsIntroduced: claims
      .filter((item) => item.previousStatus !== 'SOURCE_CONTRADICTED' && item.nextStatus === 'SOURCE_CONTRADICTED')
      .map((item) => item.claimId),
    contradictionsCleared: claims
      .filter((item) => item.previousStatus === 'SOURCE_CONTRADICTED' && item.nextStatus !== 'SOURCE_CONTRADICTED')
      .map((item) => item.claimId)
  };
}

function countChanges(items) {
  const counts = { ADDED: 0, REMOVED: 0, CHANGED: 0, UNCHANGED: 0 };
  for (const item of items) counts[item.change] += 1;
  return counts;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
