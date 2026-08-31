import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityRegistry,
  commitMerge,
  createExternalSourceReceipt,
  createVerifiedExternalCapabilityManifest,
  createVerifiedExternalRegistryBundle,
  getExternalClaim,
  runRegisteredCreation
} from '../src/index.js';

const DISCOVERY_REPO = 'mike-axiom-mir/axm-discovery-buddy';
const DISCOVERY_REF = 'axm/chat-agent-lane-rule-v1';
const DISCOVERY_HEAD = '826d9a2b4e4003e45825a5fce4e08619677489d5';
const OBSERVER_ID = 'discovery-buddy.import-status-observer';
const SCANNER_ID = 'discovery-buddy.scanner';

function buildDiscoveryReceipt({ reverse = false } = {}) {
  const observations = [
    {
      id: 'branch-head',
      kind: 'GIT_REF',
      subject: DISCOVERY_REF,
      status: 'PRESENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:${DISCOVERY_REPO}@${DISCOVERY_HEAD}:branch`,
      details: { headSha: DISCOVERY_HEAD }
    },
    {
      id: 'import-status-file',
      kind: 'FILE',
      subject: 'IMPORT_STATUS.json',
      status: 'PRESENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:${DISCOVERY_REPO}@${DISCOVERY_HEAD}:IMPORT_STATUS.json:1994c2eb72f68aedd0581dcc0ea997cd811c3270`,
      details: { required: 32, recovered: 5, missing: 27 }
    },
    {
      id: 'main-materialized-source',
      kind: 'SOURCE_TREE',
      subject: 'main',
      status: 'ABSENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:${DISCOVERY_REPO}@main:root:license-readme-only`,
      details: { topLevelFiles: ['LICENSE', 'README.md'] }
    },
    {
      id: 'materialized-source-tree',
      kind: 'SOURCE_TREE',
      subject: `${DISCOVERY_REF}:source/`,
      status: 'ABSENT',
      basis: 'OBSERVED_SOURCE',
      evidenceRef: `github:${DISCOVERY_REPO}@${DISCOVERY_HEAD}:root:staged-import`,
      details: { stagedImport: true }
    },
    {
      id: 'materializer-contract',
      kind: 'WORKFLOW_DECLARATION',
      subject: '.github/workflows/materialize-v114-import.yml',
      status: 'DECLARED',
      basis: 'DECLARED',
      evidenceRef: `github:${DISCOVERY_REPO}@${DISCOVERY_HEAD}:workflow:2119f49f60025fa72c68b4f10fbfb83778a7fd3b`,
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
      details: { conclusion: 'failure', headSha: '334c9760acca451ae33cb748abf1e21ac429c5ff' }
    }
  ];
  const claims = [
    {
      id: 'import-status-observer-claim',
      capabilityId: OBSERVER_ID,
      requirements: [
        { observationId: 'branch-head', acceptedStatuses: ['PRESENT'] },
        { observationId: 'import-status-file', acceptedStatuses: ['PRESENT'] },
        { observationId: 'main-materialized-source', acceptedStatuses: ['ABSENT'] },
        { observationId: 'recovery-run', acceptedStatuses: ['FAILURE', 'SUCCESS'] }
      ],
      metadata: { scope: 'repository/import status only' }
    },
    {
      id: 'scanner-claim',
      capabilityId: SCANNER_ID,
      requirements: [
        { observationId: 'materialized-source-tree', acceptedStatuses: ['PRESENT'] },
        { observationId: 'recovery-run', acceptedStatuses: ['SUCCESS'] }
      ],
      metadata: { scope: 'scanner implementation and tested materialized body' }
    }
  ];
  return createExternalSourceReceipt({
    adapterId: 'discovery-buddy-github-readonly/v0.7',
    source: {
      repository: DISCOVERY_REPO,
      ref: DISCOVERY_REF,
      headSha: DISCOVERY_HEAD,
      metadata: { access: 'read-only', inspectedAt: '2026-08-31' }
    },
    observations: reverse ? [...observations].reverse() : observations,
    claims: reverse ? [...claims].reverse() : claims,
    now: () => '2026-08-31T03:30:00.000Z'
  });
}

function observerManifest() {
  return {
    id: OBSERVER_ID,
    version: '0.7',
    executorRef: 'local-adapter:discovery-buddy/import-status-observer/v0.7',
    role: 'SCOUT',
    pressure: 'source-integrity',
    provides: ['external-discovery-import-status'],
    targetAreas: ['discoveryStatus'],
    authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: { workers: 1 },
    inputRefs: [`github:${DISCOVERY_REPO}@${DISCOVERY_HEAD}`],
    testRefs: ['local-test:discovery-buddy/import-status-shape/v0.7'],
    priority: 10,
    metadata: { foreignExecution: false, observationOnly: true }
  };
}

function observerBodyMap() {
  return {
    id: 'external-observer-body/v0.7',
    version: '0.7',
    sourceRef: 'local:harness:external-observer-body/v0.7',
    areas: [{
      id: 'discoveryStatus',
      path: 'external.discoveryBuddy',
      allowedCapabilities: [OBSERVER_ID],
      authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
    }],
    metadata: { protectedBody: 'local status projection' }
  };
}

test('external source receipt is deterministic across observation and claim ordering', () => {
  const a = buildDiscoveryReceipt();
  const b = buildDiscoveryReceipt({ reverse: true });
  assert.equal(a.receiptId, b.receiptId);
  assert.deepEqual(a.observations, b.observations);
  assert.deepEqual(a.claims, b.claims);
});

test('Discovery Buddy scanner claim is held while staged source is absent and recovery run failed', () => {
  const receipt = buildDiscoveryReceipt();
  const scanner = getExternalClaim(receipt, 'scanner-claim');
  assert.equal(scanner.status, 'HOLD_SOURCE_INCOMPLETE');
  assert.deepEqual(scanner.blockers.map((item) => item.observationId), [
    'materialized-source-tree',
    'recovery-run'
  ]);
});

test('Discovery Buddy import-status observer is source verified from observed/execution evidence', () => {
  const observer = getExternalClaim(buildDiscoveryReceipt(), 'import-status-observer-claim');
  assert.equal(observer.status, 'SOURCE_VERIFIED');
  assert.equal(observer.blockers.length, 0);
  assert.equal(observer.passedEvidenceRefs.length, 4);
});

test('declared workflow intent cannot satisfy verification by default', () => {
  const receipt = createExternalSourceReceipt({
    adapterId: 'declared-only',
    source: { repository: 'example/repo', ref: 'main', headSha: 'abc' },
    observations: [{
      id: 'declared-test',
      kind: 'WORKFLOW_DECLARATION',
      status: 'DECLARED',
      basis: 'DECLARED',
      evidenceRef: 'workflow:file'
    }],
    claims: [{
      id: 'claim',
      capabilityId: 'capability',
      requirements: [{ observationId: 'declared-test', acceptedStatuses: ['DECLARED'] }]
    }]
  });
  const claim = getExternalClaim(receipt, 'claim');
  assert.equal(claim.status, 'HOLD_SOURCE_INCOMPLETE');
  assert.equal(claim.blockers[0].reason, 'EVIDENCE_BASIS_NOT_ACCEPTED');
});

test('explicit contradictory source evidence produces SOURCE_CONTRADICTED', () => {
  const receipt = createExternalSourceReceipt({
    adapterId: 'contradiction',
    source: { repository: 'example/repo', ref: 'main', headSha: 'abc' },
    observations: [{
      id: 'hash', kind: 'HASH', status: 'MISMATCH', basis: 'OBSERVED_SOURCE', evidenceRef: 'hash:evidence'
    }],
    claims: [{
      id: 'claim', capabilityId: 'capability', requirements: [{ observationId: 'hash', acceptedStatuses: ['MATCH'] }]
    }]
  });
  assert.equal(getExternalClaim(receipt, 'claim').status, 'SOURCE_CONTRADICTED');
});

test('only SOURCE_VERIFIED external claims may become registry manifests', () => {
  const receipt = buildDiscoveryReceipt();
  assert.throws(() => createVerifiedExternalCapabilityManifest(receipt, {
    claimId: 'scanner-claim',
    manifest: { ...observerManifest(), id: SCANNER_ID }
  }), /not source verified/);

  const manifest = createVerifiedExternalCapabilityManifest(receipt, {
    claimId: 'import-status-observer-claim',
    manifest: observerManifest()
  });
  assert.equal(manifest.id, OBSERVER_ID);
  assert.equal(manifest.sourceRef, `github:${DISCOVERY_REPO}@${DISCOVERY_HEAD}`);
  assert.equal(manifest.metadata.externalAdapter.verificationStatus, 'SOURCE_VERIFIED');
  assert.equal(manifest.metadata.foreignExecution, false);
  assert.ok(manifest.evidenceRefs.includes(receipt.receiptId));
});

test('tampering with an external receipt is detected before capability promotion', () => {
  const receipt = buildDiscoveryReceipt();
  receipt.source.headSha = 'tampered';
  assert.throws(() => createVerifiedExternalCapabilityManifest(receipt, {
    claimId: 'import-status-observer-claim',
    manifest: observerManifest()
  }), /integrity check failed/);
});

test('verified external bundle remains inert until local executor and tests are explicitly bound', () => {
  const receipt = buildDiscoveryReceipt();
  const bundle = createVerifiedExternalRegistryBundle({
    receipt,
    capabilities: [{ claimId: 'import-status-observer-claim', manifest: observerManifest() }],
    bodyMaps: [observerBodyMap()]
  });
  const registry = new CapabilityRegistry();
  const intake = registry.ingestBundle(bundle);
  assert.equal(intake.rejected.length, 0);
  const resolution = registry.resolve({ bodyMapId: 'external-observer-body/v0.7' });
  assert.deepEqual(resolution.receipt.resolvedCapabilityIds, []);
  assert.match(resolution.receipt.unavailableCapabilities[0].reasons.join(','), /MISSING_EXECUTOR_BINDING/);
});

test('local binding of a verified external observer resolves without executing foreign repository code', () => {
  const receipt = buildDiscoveryReceipt();
  const registry = new CapabilityRegistry();
  registry.ingestBundle(createVerifiedExternalRegistryBundle({
    receipt,
    capabilities: [{ claimId: 'import-status-observer-claim', manifest: observerManifest() }],
    bodyMaps: [observerBodyMap()]
  }));
  const localExecutor = ({ state }) => {
    state.external.discoveryBuddy = { adapter: 'local', scannerStatus: 'HOLD_SOURCE_INCOMPLETE' };
  };
  const localTest = ({ state }) => state.external.discoveryBuddy.adapter === 'local';
  registry.bindExecutor(observerManifest().executorRef, localExecutor, { bindingRef: 'test-local-executor' });
  registry.bindTest(observerManifest().testRefs[0], localTest, { bindingRef: 'test-local-verifier' });
  const resolution = registry.resolve({ bodyMapId: 'external-observer-body/v0.7' });
  assert.deepEqual(resolution.receipt.resolvedCapabilityIds, [OBSERVER_ID]);
  assert.equal(resolution.capabilities[0].work, localExecutor);
});

test('real Discovery Buddy evidence can flow through registry/decomposition/creation and still stop at explicit commit', async () => {
  const receipt = buildDiscoveryReceipt();
  const scanner = getExternalClaim(receipt, 'scanner-claim');
  const importStatus = getExternalClaim(receipt, 'import-status-observer-claim');
  const registry = new CapabilityRegistry();
  registry.ingestBundle(createVerifiedExternalRegistryBundle({
    receipt,
    capabilities: [{ claimId: 'import-status-observer-claim', manifest: observerManifest() }],
    bodyMaps: [observerBodyMap()]
  }));

  registry.bindExecutor(observerManifest().executorRef, ({ state }) => {
    state.external.discoveryBuddy = {
      repository: DISCOVERY_REPO,
      ref: DISCOVERY_REF,
      headSha: DISCOVERY_HEAD,
      importRecovered: 5,
      importRequired: 32,
      recoveryRunConclusion: 'failure',
      scannerCapabilityStatus: scanner.status,
      importObserverStatus: importStatus.status,
      foreignExecution: false
    };
  });
  registry.bindTest(observerManifest().testRefs[0], ({ state }) =>
    state.external.discoveryBuddy.repository === DISCOVERY_REPO &&
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

  assert.equal(result.plan.status, 'READY');
  assert.equal(result.creation.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.deepEqual(protectedBody, { external: { discoveryBuddy: {} } });

  const committed = commitMerge({
    state: protectedBody,
    currentStateRef: 'external-status:v1',
    plan: result.creation.bodyPlan.mergePlan
  });
  assert.equal(committed.state.external.discoveryBuddy.scannerCapabilityStatus, 'HOLD_SOURCE_INCOMPLETE');
  assert.equal(committed.state.external.discoveryBuddy.importObserverStatus, 'SOURCE_VERIFIED');
  assert.equal(committed.state.external.discoveryBuddy.foreignExecution, false);
});
