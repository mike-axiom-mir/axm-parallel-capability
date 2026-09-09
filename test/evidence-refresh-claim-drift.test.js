import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectGitHubEvidence,
  createMemoryGitHubEvidenceClient
} from '../src/github-evidence.js';
import {
  createEvidenceRefreshReceipt,
  getClaimTransition
} from '../src/evidence-refresh.js';

const REPOSITORY = 'mike-axiom-mir/axm-discovery-buddy';
const REF = 'main';
const CLAIM = {
  id: 'reader-claim',
  capabilityId: 'discovery-buddy.reader',
  requirements: [
    { observationId: 'reader-source', acceptedStatuses: ['PRESENT'] }
  ]
};

async function collection(head, blobSha) {
  return collectGitHubEvidence({
    client: createMemoryGitHubEvidenceClient({
      resolveSequence: [head, head],
      files: {
        [`${REPOSITORY}@${head}:source/reader-organs.js`]: {
          sha: blobSha,
          size: 1200
        }
      }
    }),
    repository: REPOSITORY,
    ref: REF,
    files: [
      { id: 'reader-source', path: 'source/reader-organs.js' }
    ],
    workflows: [],
    now: () => '2026-09-09T06:45:00Z'
  });
}

test('same-status claim records evidence drift as changed', async () => {
  const previous = await collection('head-a', 'blob-a');
  const next = await collection('head-b', 'blob-b');

  const receipt = createEvidenceRefreshReceipt({
    previousCollection: previous,
    nextCollection: next,
    adapterId: 'github-evidence-refresh/v0.9',
    claims: [CLAIM],
    requireStableRef: true,
    now: () => '2026-09-09T06:46:00Z'
  });

  const transition = getClaimTransition(receipt, 'reader-claim');
  assert.equal(transition.transition, 'SOURCE_VERIFIED->SOURCE_VERIFIED');
  assert.notDeepEqual(
    transition.previousPassedEvidenceRefs,
    transition.nextPassedEvidenceRefs
  );
  assert.equal(transition.change, 'CHANGED');
  assert.equal(receipt.summary.claims.CHANGED, 1);
  assert.equal(receipt.summary.claims.UNCHANGED, 0);
});
