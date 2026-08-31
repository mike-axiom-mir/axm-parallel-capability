import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectGitHubEvidence,
  createMemoryGitHubEvidenceClient
} from '../src/github-evidence.js';
import {
  assertEvidenceRefreshReceipt,
  createEvidenceRefreshReceipt,
  getClaimTransition
} from '../src/evidence-refresh.js';

const REPOSITORY = 'mike-axiom-mir/axm-discovery-buddy';
const REF = 'axm/chat-agent-lane-rule-v1';
const WORKFLOW = 'Materialize Discovery Buddy v1.14 import';

const scannerClaim = {
  id: 'scanner-claim',
  capabilityId: 'discovery-buddy.scanner',
  requirements: [
    { observationId: 'reader-source', acceptedStatuses: ['PRESENT'] },
    { observationId: 'graph-source', acceptedStatuses: ['PRESENT'] },
    { observationId: 'materializer-exact', acceptedStatuses: ['SUCCESS'] }
  ]
};

const readerClaim = {
  id: 'reader-claim',
  capabilityId: 'discovery-buddy.reader',
  requirements: [
    { observationId: 'reader-source', acceptedStatuses: ['PRESENT'] }
  ]
};

async function collection({
  head,
  endHead = head,
  sourcePresent = false,
  workflowConclusion = 'failure',
  workflowHead = head,
  expectedReaderBlobSha = null,
  readerBlobSha = `blob-reader-${head}`,
  extraFiles = [],
  workflowRuns = null
}) {
  const files = {};
  if (sourcePresent) {
    files[`${REPOSITORY}@${head}:source/reader-organs.js`] = { sha: readerBlobSha, size: 1200 };
    files[`${REPOSITORY}@${head}:source/software-graph.js`] = { sha: `blob-graph-${head}`, size: 900 };
  }
  for (const extra of extraFiles) {
    files[`${REPOSITORY}@${head}:${extra.path}`] = { sha: extra.sha, size: extra.size ?? 1 };
  }

  const runs = workflowRuns ?? [{
    id: `run-${head}`,
    name: WORKFLOW,
    path: '.github/workflows/materialize-v114-import.yml',
    headSha: workflowHead,
    status: 'completed',
    conclusion: workflowConclusion,
    createdAt: '2026-08-31T12:00:00Z'
  }];

  return collectGitHubEvidence({
    client: createMemoryGitHubEvidenceClient({
      resolveSequence: [head, endHead],
      files,
      workflowRuns: runs
    }),
    repository: REPOSITORY,
    ref: REF,
    files: [
      { id: 'reader-source', path: 'source/reader-organs.js', expectedBlobSha: expectedReaderBlobSha },
      { id: 'graph-source', path: 'source/software-graph.js' },
      ...extraFiles.map((extra) => ({ id: extra.id, path: extra.path }))
    ],
    workflows: [{
      id: 'materializer-exact',
      name: WORKFLOW,
      path: '.github/workflows/materialize-v114-import.yml',
      headPolicy: 'PINNED_HEAD'
    }],
    now: () => '2026-08-31T12:01:00Z'
  });
}

function refresh(previousCollection, nextCollection, options = {}) {
  return createEvidenceRefreshReceipt({
    previousCollection,
    nextCollection,
    adapterId: 'github-evidence-refresh/v0.9',
    claims: options.claims ?? [scannerClaim],
    requireStableRef: options.requireStableRef ?? true,
    now: () => '2026-08-31T12:02:00Z'
  });
}

test('refresh identity is deterministic across claim ordering', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: false });
  const next = await collection({ head: 'h2', sourcePresent: true, workflowConclusion: 'success' });
  const a = refresh(previous, next, { claims: [scannerClaim, readerClaim] });
  const b = refresh(previous, next, { claims: [readerClaim, scannerClaim] });
  assert.equal(a.refreshId, b.refreshId);
  assert.deepEqual(a.claimTransitions, b.claimTransitions);
});

test('refresh receipt preserves both collection and external-receipt lineage endpoints', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: false });
  const next = await collection({ head: 'h2', sourcePresent: true, workflowConclusion: 'success' });
  const receipt = refresh(previous, next);
  assert.equal(receipt.previous.collectionId, previous.collectionId);
  assert.equal(receipt.next.collectionId, next.collectionId);
  assert.equal(receipt.previous.pinnedHeadSha, 'h1');
  assert.equal(receipt.next.pinnedHeadSha, 'h2');
  assert.match(receipt.previous.externalReceiptId, /^external-source-receipt:sha256:/);
  assert.match(receipt.next.externalReceiptId, /^external-source-receipt:sha256:/);
  assert.equal(receipt.headChanged, true);
});

test('HOLD_SOURCE_INCOMPLETE to SOURCE_VERIFIED is recorded as an explicit promotion', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: false, workflowConclusion: 'failure' });
  const next = await collection({ head: 'h2', sourcePresent: true, workflowConclusion: 'success' });
  const receipt = refresh(previous, next);
  const transition = getClaimTransition(receipt, 'scanner-claim');
  assert.equal(transition.transition, 'HOLD_SOURCE_INCOMPLETE->SOURCE_VERIFIED');
  assert.deepEqual(receipt.summary.verifiedPromotions, ['scanner-claim']);
  assert.deepEqual(receipt.summary.verifiedDemotions, []);
});

test('SOURCE_VERIFIED to HOLD_SOURCE_INCOMPLETE is preserved as a demotion rather than overwritten', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: true, workflowConclusion: 'success' });
  const next = await collection({ head: 'h2', sourcePresent: false, workflowConclusion: 'failure' });
  const receipt = refresh(previous, next);
  assert.equal(getClaimTransition(receipt, 'scanner-claim').transition, 'SOURCE_VERIFIED->HOLD_SOURCE_INCOMPLETE');
  assert.deepEqual(receipt.summary.verifiedDemotions, ['scanner-claim']);
});

test('new contradiction-grade source evidence changes a verified claim to SOURCE_CONTRADICTED', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: true, workflowConclusion: 'success' });
  const next = await collection({
    head: 'h2',
    sourcePresent: true,
    workflowConclusion: 'success',
    expectedReaderBlobSha: 'expected-reader',
    readerBlobSha: 'different-reader'
  });
  const receipt = refresh(previous, next);
  assert.equal(getClaimTransition(receipt, 'scanner-claim').transition, 'SOURCE_VERIFIED->SOURCE_CONTRADICTED');
  assert.deepEqual(receipt.summary.contradictionsIntroduced, ['scanner-claim']);
});

test('refreshing the same collection produces explicit unchanged observations and claim state', async () => {
  const current = await collection({ head: 'h1', sourcePresent: true, workflowConclusion: 'success' });
  const receipt = refresh(current, current);
  assert.equal(receipt.collectionChanged, false);
  assert.equal(receipt.headChanged, false);
  assert.equal(receipt.summary.observations.CHANGED, 0);
  assert.equal(receipt.summary.claims.CHANGED, 0);
  assert.equal(getClaimTransition(receipt, 'scanner-claim').transition, 'SOURCE_VERIFIED->SOURCE_VERIFIED');
});

test('irrelevant new evidence can change the collection without changing the scanner claim', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: true, workflowConclusion: 'success' });
  const next = await collection({
    head: 'h2',
    sourcePresent: true,
    workflowConclusion: 'success',
    extraFiles: [{ id: 'readme', path: 'README.md', sha: 'readme-h2' }]
  });
  const receipt = refresh(previous, next);
  assert.ok(receipt.summary.observations.ADDED >= 1);
  assert.equal(getClaimTransition(receipt, 'scanner-claim').transition, 'SOURCE_VERIFIED->SOURCE_VERIFIED');
});

test('a ref that moves during the fresh collection keeps an otherwise passing claim on hold by default', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: false });
  const next = await collection({
    head: 'h2',
    endHead: 'h3',
    sourcePresent: true,
    workflowConclusion: 'success'
  });
  const receipt = refresh(previous, next);
  assert.equal(receipt.next.freshness.status, 'MOVED');
  assert.equal(getClaimTransition(receipt, 'scanner-claim').nextStatus, 'HOLD_SOURCE_INCOMPLETE');
});

test('historical pinned refresh can explicitly disable stable-ref policy while preserving moved freshness', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: false });
  const next = await collection({
    head: 'h2',
    endHead: 'h3',
    sourcePresent: true,
    workflowConclusion: 'success'
  });
  const receipt = refresh(previous, next, { requireStableRef: false });
  assert.equal(receipt.policy.requireStableRef, false);
  assert.equal(receipt.next.freshness.status, 'MOVED');
  assert.equal(getClaimTransition(receipt, 'scanner-claim').transition, 'HOLD_SOURCE_INCOMPLETE->SOURCE_VERIFIED');
});

test('tampering with a refresh receipt is rejected before consumers read transitions', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: false });
  const next = await collection({ head: 'h2', sourcePresent: true, workflowConclusion: 'success' });
  const receipt = refresh(previous, next);
  receipt.next.pinnedHeadSha = 'tampered';
  assert.throws(() => assertEvidenceRefreshReceipt(receipt), /integrity check failed/);
});

test('refresh comparison refuses cross-repository or cross-ref lineage', async () => {
  const previous = await collection({ head: 'h1', sourcePresent: false });
  const next = await collection({ head: 'h2', sourcePresent: false });
  const otherRepo = structuredClone(next);
  otherRepo.source.repository = 'other/repo';
  assert.throws(() => refresh(previous, otherRepo), /same repository/);

  const otherRef = structuredClone(next);
  otherRef.source.ref = 'other-ref';
  assert.throws(() => refresh(previous, otherRef), /same named ref/);
});

test('Discovery Buddy staged-import refresh remains HOLD to HOLD instead of treating READY as scanner proof', async () => {
  const previous = await collection({
    head: '826d9a2b4e4003e45825a5fce4e08619677489d5',
    sourcePresent: false,
    workflowConclusion: 'failure'
  });
  const next = await collection({
    head: '1411d0666a1e2fbfe5f697df8b0bb4b72f31dbf2',
    sourcePresent: false,
    workflowRuns: [{
      id: '33366578085',
      name: WORKFLOW,
      path: '.github/workflows/materialize-v114-import.yml',
      headSha: 'fbab0ae42b06146a3b9c514ec3aaad152909f406',
      status: 'completed',
      conclusion: 'failure',
      createdAt: '2026-08-31T07:01:39Z'
    }],
    extraFiles: [{ id: 'ready', path: '.repo-import/READY', sha: '2c61932d7922399f377875ce772489e3e76e7bb5' }]
  });
  const receipt = refresh(previous, next);
  const transition = getClaimTransition(receipt, 'scanner-claim');
  assert.equal(transition.transition, 'HOLD_SOURCE_INCOMPLETE->HOLD_SOURCE_INCOMPLETE');
  assert.ok(receipt.observationTransitions.some((item) => item.observationId === 'ready' && item.change === 'ADDED'));
  assert.equal(receipt.summary.verifiedPromotions.length, 0);
});
