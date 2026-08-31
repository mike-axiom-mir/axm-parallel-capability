import {
  collectGitHubEvidence,
  createExternalSourceReceiptFromGitHubCollection,
  createMemoryGitHubEvidenceClient
} from '../src/index.js';

const repository = 'mike-axiom-mir/axm-discovery-buddy';
const ref = 'axm/chat-agent-lane-rule-v1';
const pinnedHead = '1411d0666a1e2fbfe5f697df8b0bb4b72f31dbf2';
const materializerHead = 'fbab0ae42b06146a3b9c514ec3aaad152909f406';
const workflowPath = '.github/workflows/materialize-v114-import.yml';

// This demo replays the exact read-only GitHub facts observed during the v0.8
// build. It does not call GitHub from CI and does not execute Discovery Buddy.
const client = createMemoryGitHubEvidenceClient({
  refs: { [`${repository}@${ref}`]: pinnedHead },
  files: {
    [`${repository}@${pinnedHead}:.repo-import/READY`]: {
      sha: '2c61932d7922399f377875ce772489e3e76e7bb5',
      size: 54
    },
    [`${repository}@${pinnedHead}:${workflowPath}`]: {
      sha: '1f7bf6c4289b63c1feb63a061d90e70265f4d386',
      size: 2009
    }
  },
  workflowRuns: [{
    id: 33366578085,
    name: 'Materialize Discovery Buddy v1.14 import',
    path: workflowPath,
    headSha: materializerHead,
    conclusion: 'failure',
    status: 'completed',
    createdAt: '2026-08-31T07:01:39Z'
  }]
});

const collection = await collectGitHubEvidence({
  client,
  repository,
  ref,
  files: [
    { id: 'discovery.ready', path: '.repo-import/READY', expectedBlobSha: '2c61932d7922399f377875ce772489e3e76e7bb5' },
    { id: 'discovery.materializer-contract', path: workflowPath, expectedBlobSha: '1f7bf6c4289b63c1feb63a061d90e70265f4d386' },
    { id: 'discovery.reader-organs', path: 'source/reader-organs.js' },
    { id: 'discovery.software-graph', path: 'source/software-graph.js' }
  ],
  workflows: [
    { id: 'discovery.materializer-exact', path: workflowPath },
    { id: 'discovery.materializer-history', path: workflowPath, headPolicy: 'REF_HISTORY' }
  ],
  now: () => '2026-08-31T14:05:34Z'
});

const receipt = createExternalSourceReceiptFromGitHubCollection(collection, {
  adapterId: 'discovery-buddy-github-v0.8-demo',
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
  ],
  now: () => '2026-08-31T14:05:34Z'
});

const scanner = receipt.claims.find((claim) => claim.id === 'scanner');
const stageObserver = receipt.claims.find((claim) => claim.id === 'import-stage-observer');

if (scanner.status !== 'HOLD_SOURCE_INCOMPLETE') {
  throw new Error(`Expected scanner HOLD, got ${scanner.status}`);
}
if (stageObserver.status !== 'SOURCE_VERIFIED') {
  throw new Error(`Expected import-stage observer SOURCE_VERIFIED, got ${stageObserver.status}`);
}

console.log(JSON.stringify({
  collectionId: collection.collectionId,
  collectionStatus: collection.status,
  pinnedHead: collection.source.pinnedHeadSha,
  freshness: collection.freshness.status,
  scanner: scanner.status,
  importStageObserver: stageObserver.status,
  exactHeadMaterializer: collection.observations.find((item) => item.id === 'discovery.materializer-exact').status,
  branchHistoryMaterializer: collection.observations.find((item) => item.id === 'discovery.materializer-history').status
}, null, 2));
