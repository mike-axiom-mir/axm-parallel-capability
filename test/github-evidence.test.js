import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertGitHubEvidenceCollection,
  collectGitHubEvidence,
  createExternalSourceReceiptFromGitHubCollection,
  createMemoryGitHubEvidenceClient
} from '../src/github-evidence.js';

const REPO = 'mike-axiom-mir/axm-discovery-buddy';
const REF = 'axm/chat-agent-lane-rule-v1';
const HEAD = '1411d0666a1e2fbfe5f697df8b0bb4b72f31dbf2';
const MATERIALIZER_HEAD = 'fbab0ae42b06146a3b9c514ec3aaad152909f406';
const WORKFLOW_PATH = '.github/workflows/materialize-v114-import.yml';

function fileKey(head, path) {
  return `${REPO}@${head}:${path}`;
}

function stableClient({
  files = {},
  workflowRuns = [],
  errors = {}
} = {}) {
  return createMemoryGitHubEvidenceClient({
    refs: { [`${REPO}@${REF}`]: HEAD },
    files,
    workflowRuns,
    errors
  });
}

function basicClaim(observationId = 'file.ready') {
  return {
    id: 'claim.basic',
    capabilityId: 'external.basic',
    requirements: [{
      observationId,
      acceptedStatuses: ['PRESENT'],
      acceptedBases: ['OBSERVED_SOURCE']
    }]
  };
}

function observation(collection, id) {
  return collection.observations.find((item) => item.id === id);
}

test('collection identity is deterministic across file/workflow check and run ordering', async () => {
  const files = {
    [fileKey(HEAD, '.repo-import/READY')]: { sha: 'ready-sha', size: 54 },
    [fileKey(HEAD, WORKFLOW_PATH)]: { sha: 'workflow-sha', size: 2009 }
  };
  const runsA = [
    { id: 2, name: 'Materialize', path: WORKFLOW_PATH, headSha: HEAD, conclusion: 'success', createdAt: '2026-08-31T08:00:00Z' },
    { id: 1, name: 'Materialize', path: WORKFLOW_PATH, headSha: HEAD, conclusion: 'failure', createdAt: '2026-08-31T07:00:00Z' }
  ];
  const inputA = {
    repository: REPO,
    ref: REF,
    files: [
      { id: 'file.workflow', path: WORKFLOW_PATH },
      { id: 'file.ready', path: '.repo-import/READY' }
    ],
    workflows: [{ id: 'run.materialize', path: WORKFLOW_PATH }],
    now: () => '2026-08-31T00:00:00Z'
  };
  const inputB = {
    ...inputA,
    files: [...inputA.files].reverse()
  };
  const a = await collectGitHubEvidence({ ...inputA, client: stableClient({ files, workflowRuns: runsA }) });
  const b = await collectGitHubEvidence({ ...inputB, client: stableClient({ files, workflowRuns: [...runsA].reverse() }) });
  assert.equal(a.collectionId, b.collectionId);
  assert.deepEqual(a.observations, b.observations);
});

test('file reads are pinned to the starting head even if the named ref moves during collection', async () => {
  const nextHead = '2222222222222222222222222222222222222222';
  const client = createMemoryGitHubEvidenceClient({
    resolveSequence: [HEAD, nextHead],
    files: {
      [fileKey(HEAD, '.repo-import/READY')]: { sha: 'ready-on-start', size: 54 },
      [fileKey(nextHead, '.repo-import/READY')]: { sha: 'ready-on-end', size: 55 }
    }
  });
  const collection = await collectGitHubEvidence({
    client,
    repository: REPO,
    ref: REF,
    files: [{ id: 'file.ready', path: '.repo-import/READY' }]
  });
  assert.equal(observation(collection, 'file.ready').details.blobSha, 'ready-on-start');
  assert.equal(collection.freshness.status, 'MOVED');
  assert.equal(collection.status, 'PINNED_COMPLETE_REF_MOVED');
});

test('stable-ref requirement is added to real claims and a moved ref keeps the claim on hold', async () => {
  const client = createMemoryGitHubEvidenceClient({
    resolveSequence: [HEAD, '3333333333333333333333333333333333333333'],
    files: { [fileKey(HEAD, '.repo-import/READY')]: { sha: 'ready', size: 54 } }
  });
  const collection = await collectGitHubEvidence({
    client,
    repository: REPO,
    ref: REF,
    files: [{ id: 'file.ready', path: '.repo-import/READY' }]
  });
  const receipt = createExternalSourceReceiptFromGitHubCollection(collection, {
    adapterId: 'github-collector-test',
    claims: [basicClaim()]
  });
  assert.equal(receipt.claims[0].status, 'HOLD_SOURCE_INCOMPLETE');
  assert.ok(receipt.claims[0].blockers.some((item) => item.observationId === 'github.ref-stability'));
});

test('historical pinned verification can be explicitly requested without pretending the named ref is still current', async () => {
  const client = createMemoryGitHubEvidenceClient({
    resolveSequence: [HEAD, '4444444444444444444444444444444444444444'],
    files: { [fileKey(HEAD, '.repo-import/READY')]: { sha: 'ready', size: 54 } }
  });
  const collection = await collectGitHubEvidence({
    client,
    repository: REPO,
    ref: REF,
    files: [{ id: 'file.ready', path: '.repo-import/READY' }]
  });
  const receipt = createExternalSourceReceiptFromGitHubCollection(collection, {
    adapterId: 'github-collector-history',
    requireStableRef: false,
    claims: [basicClaim()]
  });
  assert.equal(receipt.claims[0].status, 'SOURCE_VERIFIED');
  assert.equal(receipt.source.headSha, HEAD);
  assert.equal(receipt.source.metadata.freshness.status, 'MOVED');
});

test('freshness cannot become the only evidence for a claim', async () => {
  const collection = await collectGitHubEvidence({ client: stableClient(), repository: REPO, ref: REF });
  assert.throws(() => createExternalSourceReceiptFromGitHubCollection(collection, {
    adapterId: 'github-collector-empty',
    claims: [{ id: 'empty', capabilityId: 'empty', requirements: [] }]
  }), /source\/execution evidence/);
});

test('404 file response becomes ABSENT while transport failure remains ERROR', async () => {
  const transportError = Object.assign(new Error('upstream unavailable'), { status: 503 });
  const collection = await collectGitHubEvidence({
    client: stableClient({ errors: { [`file:${REPO}@${HEAD}:broken.txt`]: transportError } }),
    repository: REPO,
    ref: REF,
    files: [
      { id: 'file.missing', path: 'missing.txt' },
      { id: 'file.error', path: 'broken.txt' }
    ]
  });
  assert.equal(observation(collection, 'file.missing').status, 'ABSENT');
  assert.equal(observation(collection, 'file.error').status, 'ERROR');
  assert.equal(collection.status, 'PARTIAL');
});

test('expected blob SHA mismatch is explicit contradiction-grade evidence', async () => {
  const collection = await collectGitHubEvidence({
    client: stableClient({ files: { [fileKey(HEAD, '.repo-import/READY')]: { sha: 'actual', size: 54 } } }),
    repository: REPO,
    ref: REF,
    files: [{ id: 'file.ready', path: '.repo-import/READY', expectedBlobSha: 'expected' }]
  });
  assert.equal(observation(collection, 'file.ready').status, 'MISMATCH');
  const receipt = createExternalSourceReceiptFromGitHubCollection(collection, {
    adapterId: 'github-collector-mismatch',
    claims: [basicClaim()]
  });
  assert.equal(receipt.claims[0].status, 'SOURCE_CONTRADICTED');
});

test('PINNED_HEAD workflow checks ignore successful runs from older commits', async () => {
  const collection = await collectGitHubEvidence({
    client: stableClient({ workflowRuns: [{
      id: 10,
      name: 'Materialize Discovery Buddy v1.14 import',
      path: WORKFLOW_PATH,
      headSha: MATERIALIZER_HEAD,
      conclusion: 'success',
      createdAt: '2026-08-31T07:01:39Z'
    }] }),
    repository: REPO,
    ref: REF,
    workflows: [{ id: 'run.exact', path: WORKFLOW_PATH }]
  });
  assert.equal(observation(collection, 'run.exact').status, 'MISSING');
});

test('REF_HISTORY can retain older branch-run context without marking it as exact-head evidence', async () => {
  const collection = await collectGitHubEvidence({
    client: stableClient({ workflowRuns: [{
      id: 10,
      name: 'Materialize Discovery Buddy v1.14 import',
      path: WORKFLOW_PATH,
      headSha: MATERIALIZER_HEAD,
      conclusion: 'failure',
      createdAt: '2026-08-31T07:01:39Z'
    }] }),
    repository: REPO,
    ref: REF,
    workflows: [{ id: 'run.history', path: WORKFLOW_PATH, headPolicy: 'REF_HISTORY' }]
  });
  const run = observation(collection, 'run.history');
  assert.equal(run.status, 'FAILURE');
  assert.equal(run.details.exactPinnedHead, false);
  assert.equal(run.details.run.headSha, MATERIALIZER_HEAD);
});

test('workflow selection is deterministic and chooses the newest matching run', async () => {
  const runs = [
    { id: 9, name: 'Materialize', path: WORKFLOW_PATH, headSha: HEAD, conclusion: 'failure', createdAt: '2026-08-31T07:00:00Z' },
    { id: 11, name: 'Materialize', path: WORKFLOW_PATH, headSha: HEAD, conclusion: 'success', createdAt: '2026-08-31T08:00:00Z' },
    { id: 10, name: 'Materialize', path: WORKFLOW_PATH, headSha: HEAD, conclusion: 'cancelled', createdAt: '2026-08-31T07:30:00Z' }
  ];
  const collection = await collectGitHubEvidence({
    client: stableClient({ workflowRuns: [runs[1], runs[0], runs[2]] }),
    repository: REPO,
    ref: REF,
    workflows: [{ id: 'run.materialize', path: WORKFLOW_PATH }]
  });
  assert.equal(observation(collection, 'run.materialize').status, 'SUCCESS');
  assert.equal(observation(collection, 'run.materialize').details.run.id, '11');
});

test('collection tampering is refused before it can feed v0.7 claims', async () => {
  const collection = await collectGitHubEvidence({
    client: stableClient({ files: { [fileKey(HEAD, '.repo-import/READY')]: { sha: 'ready', size: 54 } } }),
    repository: REPO,
    ref: REF,
    files: [{ id: 'file.ready', path: '.repo-import/READY' }]
  });
  collection.observations[0].status = 'ABSENT';
  assert.throws(() => assertGitHubEvidenceCollection(collection), /integrity check failed/);
  assert.throws(() => createExternalSourceReceiptFromGitHubCollection(collection, {
    adapterId: 'github-collector-tamper',
    claims: [basicClaim()]
  }), /integrity check failed/);
});

test('current Discovery Buddy snapshot keeps scanner held while source is staged', async () => {
  const files = {
    [fileKey(HEAD, '.repo-import/READY')]: { sha: '2c61932d7922399f377875ce772489e3e76e7bb5', size: 54 },
    [fileKey(HEAD, WORKFLOW_PATH)]: { sha: '1f7bf6c4289b63c1feb63a061d90e70265f4d386', size: 2009 }
  };
  const workflowRuns = [{
    id: 33366578085,
    name: 'Materialize Discovery Buddy v1.14 import',
    path: WORKFLOW_PATH,
    headSha: MATERIALIZER_HEAD,
    conclusion: 'failure',
    status: 'completed',
    createdAt: '2026-08-31T07:01:39Z'
  }];
  const collection = await collectGitHubEvidence({
    client: stableClient({ files, workflowRuns }),
    repository: REPO,
    ref: REF,
    files: [
      { id: 'discovery.ready', path: '.repo-import/READY', expectedBlobSha: '2c61932d7922399f377875ce772489e3e76e7bb5' },
      { id: 'discovery.materializer-contract', path: WORKFLOW_PATH, expectedBlobSha: '1f7bf6c4289b63c1feb63a061d90e70265f4d386' },
      { id: 'discovery.reader-organs', path: 'source/reader-organs.js' },
      { id: 'discovery.software-graph', path: 'source/software-graph.js' }
    ],
    workflows: [
      { id: 'discovery.materializer-exact', path: WORKFLOW_PATH },
      { id: 'discovery.materializer-history', path: WORKFLOW_PATH, headPolicy: 'REF_HISTORY' }
    ]
  });

  const receipt = createExternalSourceReceiptFromGitHubCollection(collection, {
    adapterId: 'discovery-buddy-github-v0.8',
    claims: [
      {
        id: 'scanner',
        capabilityId: 'discovery-buddy.scanner',
        requirements: [
          { observationId: 'discovery.reader-organs', acceptedStatuses: ['PRESENT'], acceptedBases: ['OBSERVED_SOURCE'] },
          { observationId: 'discovery.software-graph', acceptedStatuses: ['PRESENT'], acceptedBases: ['OBSERVED_SOURCE'] },
          { observationId: 'discovery.materializer-exact', acceptedStatuses: ['SUCCESS'], acceptedBases: ['EXECUTION_EVIDENCE'] }
        ]
      },
      {
        id: 'import-stage-observer',
        capabilityId: 'discovery-buddy.import-stage-observer',
        requirements: [
          { observationId: 'discovery.ready', acceptedStatuses: ['PRESENT'], acceptedBases: ['OBSERVED_SOURCE'] },
          { observationId: 'discovery.materializer-contract', acceptedStatuses: ['PRESENT'], acceptedBases: ['OBSERVED_SOURCE'] },
          { observationId: 'discovery.materializer-history', acceptedStatuses: ['FAILURE'], acceptedBases: ['EXECUTION_EVIDENCE'] }
        ]
      }
    ]
  });

  assert.equal(receipt.source.headSha, HEAD);
  assert.equal(receipt.claims.find((item) => item.id === 'scanner').status, 'HOLD_SOURCE_INCOMPLETE');
  assert.equal(receipt.claims.find((item) => item.id === 'import-stage-observer').status, 'SOURCE_VERIFIED');
  assert.equal(observation(collection, 'discovery.materializer-exact').status, 'MISSING');
  assert.equal(observation(collection, 'discovery.materializer-history').status, 'FAILURE');
});
