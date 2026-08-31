import {
  collectGitHubEvidence,
  createMemoryGitHubEvidenceClient,
  createEvidenceRefreshReceipt,
  getClaimTransition
} from '../src/index.js';

const repository = 'mike-axiom-mir/axm-discovery-buddy';
const ref = 'axm/chat-agent-lane-rule-v1';
const currentHead = '1411d0666a1e2fbfe5f697df8b0bb4b72f31dbf2';
const simulatedFutureHead = 'simulated-materialized-v114-head';
const workflowName = 'Materialize Discovery Buddy v1.14 import';

const scannerClaim = {
  id: 'scanner-claim',
  capabilityId: 'discovery-buddy.scanner',
  requirements: [
    { observationId: 'reader-source', acceptedStatuses: ['PRESENT'] },
    { observationId: 'graph-source', acceptedStatuses: ['PRESENT'] },
    { observationId: 'materializer-exact', acceptedStatuses: ['SUCCESS'] }
  ]
};

const current = await collectGitHubEvidence({
  client: createMemoryGitHubEvidenceClient({
    resolveSequence: [currentHead, currentHead],
    files: {
      [`${repository}@${currentHead}:.repo-import/READY`]: {
        sha: '2c61932d7922399f377875ce772489e3e76e7bb5',
        size: 54
      }
    },
    workflowRuns: [{
      id: '33366578085',
      name: workflowName,
      path: '.github/workflows/materialize-v114-import.yml',
      headSha: 'fbab0ae42b06146a3b9c514ec3aaad152909f406',
      status: 'completed',
      conclusion: 'failure',
      createdAt: '2026-08-31T07:01:39Z'
    }]
  }),
  repository,
  ref,
  files: [
    { id: 'reader-source', path: 'source/reader-organs.js' },
    { id: 'graph-source', path: 'source/software-graph.js' },
    { id: 'ready', path: '.repo-import/READY' }
  ],
  workflows: [{
    id: 'materializer-exact',
    name: workflowName,
    path: '.github/workflows/materialize-v114-import.yml',
    headPolicy: 'PINNED_HEAD'
  }]
});

// This is intentionally synthetic. It demonstrates what v0.9 would record if
// a later pinned Discovery Buddy head actually exposed the required source and
// had a successful exact-head materializer run. It is not a claim about the
// live Discovery Buddy repository.
const simulatedFuture = await collectGitHubEvidence({
  client: createMemoryGitHubEvidenceClient({
    resolveSequence: [simulatedFutureHead, simulatedFutureHead],
    files: {
      [`${repository}@${simulatedFutureHead}:source/reader-organs.js`]: { sha: 'sim-reader', size: 1200 },
      [`${repository}@${simulatedFutureHead}:source/software-graph.js`]: { sha: 'sim-graph', size: 900 }
    },
    workflowRuns: [{
      id: 'simulated-successful-materializer-run',
      name: workflowName,
      path: '.github/workflows/materialize-v114-import.yml',
      headSha: simulatedFutureHead,
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-09-01T00:00:00Z'
    }]
  }),
  repository,
  ref,
  files: [
    { id: 'reader-source', path: 'source/reader-organs.js' },
    { id: 'graph-source', path: 'source/software-graph.js' },
    { id: 'ready', path: '.repo-import/READY' }
  ],
  workflows: [{
    id: 'materializer-exact',
    name: workflowName,
    path: '.github/workflows/materialize-v114-import.yml',
    headPolicy: 'PINNED_HEAD'
  }]
});

const refresh = createEvidenceRefreshReceipt({
  previousCollection: current,
  nextCollection: simulatedFuture,
  adapterId: 'github-evidence-refresh/v0.9',
  claims: [scannerClaim]
});

console.log(JSON.stringify({
  demoTruthBoundary: 'NEXT_COLLECTION_IS_SIMULATED_NOT_LIVE_DISCOVERY_EVIDENCE',
  previousHead: refresh.previous.pinnedHeadSha,
  nextHead: refresh.next.pinnedHeadSha,
  scannerTransition: getClaimTransition(refresh, 'scanner-claim'),
  summary: refresh.summary,
  refreshId: refresh.refreshId
}, null, 2));
