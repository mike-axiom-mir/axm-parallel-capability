import {
  CapabilityRegistry,
  commitMerge,
  createExternalSourceReceipt,
  createVerifiedExternalRegistryBundle,
  getExternalClaim,
  runRegisteredCreation
} from '../src/index.js';

const repository = 'mike-axiom-mir/axm-discovery-buddy';
const ref = 'axm/chat-agent-lane-rule-v1';
const headSha = '826d9a2b4e4003e45825a5fce4e08619677489d5';
const observerId = 'discovery-buddy.import-status-observer';

// These are a frozen fixture of the GitHub evidence inspected for v0.7.
// The demo does not fetch or execute Discovery Buddy code.
const receipt = createExternalSourceReceipt({
  adapterId: 'discovery-buddy-github-readonly/v0.7',
  source: {
    repository,
    ref,
    headSha,
    metadata: { access: 'read-only', fixture: '2026-08-31-v0.7' }
  },
  observations: [
    {
      id: 'branch-head',
      kind: 'GIT_REF',
      subject: ref,
      status: 'PRESENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:${repository}@${headSha}:branch`,
      details: { headSha }
    },
    {
      id: 'import-status-file',
      kind: 'FILE',
      subject: 'IMPORT_STATUS.json',
      status: 'PRESENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:${repository}@${headSha}:IMPORT_STATUS.json:1994c2eb72f68aedd0581dcc0ea997cd811c3270`,
      details: { required: 32, recovered: 5, missing: 27 }
    },
    {
      id: 'main-materialized-source',
      kind: 'SOURCE_TREE',
      subject: 'main',
      status: 'ABSENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:${repository}@main:root:license-readme-only`,
      details: { topLevelFiles: ['LICENSE', 'README.md'] }
    },
    {
      id: 'materialized-source-tree',
      kind: 'SOURCE_TREE',
      subject: `${ref}:source/`,
      status: 'ABSENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:${repository}@${headSha}:root:staged-import`,
      details: { stagedImport: true }
    },
    {
      id: 'materializer-contract',
      kind: 'WORKFLOW_DECLARATION',
      subject: '.github/workflows/materialize-v114-import.yml',
      status: 'DECLARED',
      basis: 'DECLARED',
      evidenceRef: `github:${repository}@${headSha}:workflow:2119f49f60025fa72c68b4f10fbfb83778a7fd3b`,
      details: {
        expectedChunks: 21,
        archiveSha256: '6e86a0867f5f3e50d150870bafaef066ee6d99482d32d326e7df29ab6c71eac3',
        declaredTestCommand: 'npm test'
      }
    },
    {
      id: 'recovery-run',
      kind: 'WORKFLOW_RUN',
      subject: 'Recover and materialize Discovery Buddy v1.14',
      status: 'FAILURE',
      basis: 'EXECUTION_EVIDENCE',
      evidenceRef: 'github-actions:mike-axiom-mir/axm-discovery-buddy:33348471725',
      details: { conclusion: 'failure' }
    }
  ],
  claims: [
    {
      id: 'import-status-observer-claim',
      capabilityId: observerId,
      requirements: [
        { observationId: 'branch-head', acceptedStatuses: ['PRESENT'] },
        { observationId: 'import-status-file', acceptedStatuses: ['PRESENT'] },
        { observationId: 'main-materialized-source', acceptedStatuses: ['ABSENT'] },
        { observationId: 'recovery-run', acceptedStatuses: ['FAILURE', 'SUCCESS'] }
      ]
    },
    {
      id: 'scanner-claim',
      capabilityId: 'discovery-buddy.scanner',
      requirements: [
        { observationId: 'materialized-source-tree', acceptedStatuses: ['PRESENT'] },
        { observationId: 'recovery-run', acceptedStatuses: ['SUCCESS'] }
      ]
    }
  ],
  now: () => '2026-08-31T03:30:00.000Z'
});

const scannerClaim = getExternalClaim(receipt, 'scanner-claim');
const observerClaim = getExternalClaim(receipt, 'import-status-observer-claim');

const registry = new CapabilityRegistry();
registry.ingestBundle(createVerifiedExternalRegistryBundle({
  receipt,
  capabilities: [{
    claimId: 'import-status-observer-claim',
    manifest: {
      id: observerId,
      version: '0.7',
      executorRef: 'local-adapter:discovery-buddy/import-status-observer/v0.7',
      role: 'SCOUT',
      pressure: 'source-integrity',
      provides: ['external-discovery-import-status'],
      targetAreas: ['discoveryStatus'],
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      resources: { workers: 1 },
      inputRefs: [`github:${repository}@${headSha}`],
      testRefs: ['local-test:discovery-buddy/import-status-shape/v0.7'],
      priority: 10,
      metadata: { foreignExecution: false, observationOnly: true }
    }
  }],
  bodyMaps: [{
    id: 'external-observer-body/v0.7',
    version: '0.7',
    sourceRef: 'local:demo:external-observer-body/v0.7',
    areas: [{
      id: 'discoveryStatus',
      path: 'external.discoveryBuddy',
      allowedCapabilities: [observerId],
      authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
    }]
  }]
}));

registry.bindExecutor('local-adapter:discovery-buddy/import-status-observer/v0.7', ({ state }) => {
  state.external.discoveryBuddy = {
    repository,
    ref,
    headSha,
    importRecovered: 5,
    importRequired: 32,
    recoveryRunConclusion: 'failure',
    scannerCapabilityStatus: scannerClaim.status,
    importObserverStatus: observerClaim.status,
    foreignExecution: false
  };
});
registry.bindTest('local-test:discovery-buddy/import-status-shape/v0.7', ({ state }) =>
  state.external.discoveryBuddy.repository === repository &&
  state.external.discoveryBuddy.foreignExecution === false
);

const protectedBody = { external: { discoveryBuddy: {} } };
const result = await runRegisteredCreation(registry, {
  runId: 'external-discovery-cycle-v07',
  state: protectedBody,
  stateRef: 'external-status:v1',
  rollbackRef: 'external-status:v0',
  bodyMapId: 'external-observer-body/v0.7',
  goal: {
    id: 'observe-discovery-import',
    summary: 'Project verified Discovery Buddy repository import status into local state',
    requirements: [{ id: 'status', token: 'external-discovery-import-status' }],
    integrationTests: [{
      id: 'external-status-grounded',
      test: ({ state }) =>
        state.external.discoveryBuddy.scannerCapabilityStatus === 'HOLD_SOURCE_INCOMPLETE' &&
        state.external.discoveryBuddy.importObserverStatus === 'SOURCE_VERIFIED' &&
        state.external.discoveryBuddy.foreignExecution === false
    }]
  },
  constraints: { resourceBudget: { limits: { workers: 2 } } }
}, { fabricOptions: { limits: { workers: 2 } } });

console.log('External source receipt:', receipt.receiptId);
console.log('Discovery scanner claim:', scannerClaim.status);
console.log('Discovery import observer claim:', observerClaim.status);
console.log('Creation status:', result.creation.status);
console.log('Protected body before explicit commit:', JSON.stringify(protectedBody));

if (result.creation.status === 'READY_FOR_EXPLICIT_COMMIT') {
  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'external-status:v1',
    plan: result.creation.bodyPlan.mergePlan
  });
  console.log('Returned committed body:', JSON.stringify(committed.state));
  console.log('Original protected body remains:', JSON.stringify(protectedBody));
}
