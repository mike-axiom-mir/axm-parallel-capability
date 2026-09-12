import test from 'node:test';
import assert from 'node:assert/strict';
import { CreationFabric } from '../src/index.js';
import { buildCreationObserverModel, renderCreationObserverHtml } from '../experience/creation-run-observer.js';

async function makeReadyReceipt({ goal = 'Observer contract proof' } = {}) {
  const state = { engine: { cacheMB: 64 }, ui: { compact: false } };
  const now = () => '2026-09-09T00:00:00.000Z';
  const fabric = new CreationFabric({ limits: { workers: 2 }, now });
  return fabric.start({
    runId: 'observer-test',
    goal,
    state,
    stateRef: 'body:v1',
    rollbackRef: 'body:v0',
    candidates: [
      {
        id: 'performance',
        authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
        evidenceRefs: ['benchmark:one'],
        tests: [{ id: 'cache-raised', test: ({ state: next }) => next.engine.cacheMB === 128 }],
        work: ({ state: next }) => { next.engine.cacheMB = 128; }
      },
      {
        id: 'usability',
        authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
        evidenceRefs: ['inspection:one'],
        tests: [{ id: 'compact', test: ({ state: next }) => next.ui.compact === true }],
        work: ({ state: next }) => { next.ui.compact = true; }
      }
    ],
    integration: {
      id: 'observer-integration',
      evidenceRefs: ['integration:test'],
      tests: [
        { id: 'integrated-cache', test: ({ state: next }) => next.engine.cacheMB === 128 },
        { id: 'integrated-ui', test: ({ state: next }) => next.ui.compact === true }
      ]
    }
  }).result;
}

test('projects a real creation receipt without upgrading observer authority', async () => {
  const receipt = await makeReadyReceipt();
  const model = buildCreationObserverModel(receipt);

  assert.equal(receipt.status, 'READY_FOR_EXPLICIT_COMMIT');
  assert.equal(model.protectedStatePreserved, true);
  assert.equal(model.mergeGate.commitAllowed, true);
  assert.equal(model.mergeGate.label, 'READY FOR EXPLICIT COMMIT');
  assert.equal(model.summary.laneCount, 2);
  assert.equal(model.summary.changeCount, 2);
  assert.equal(model.summary.testPassed, model.summary.testTotal);
  assert.deepEqual(model.lanes.map((lane) => lane.id), ['performance', 'usability']);
});

test('renders deterministic self-contained observer HTML with explicit truth boundary', async () => {
  const receipt = await makeReadyReceipt();
  const first = renderCreationObserverHtml(receipt);
  const second = renderCreationObserverHtml(receipt);

  assert.equal(first, second);
  assert.match(first, /DISPLAY ≠ AUTHORITY/);
  assert.match(first, /PROTECTED BODY PRESERVED/);
  assert.match(first, /READY FOR EXPLICIT COMMIT/);
  assert.match(first, /no merge action exists here/);
  assert.match(first, /performance/);
  assert.match(first, /usability/);
});

test('fails closed on unsupported receipt schema', () => {
  assert.throws(
    () => buildCreationObserverModel({ schema: 'axm.parallel-capability-creation-cycle-receipt/v99', candidates: [] }),
    /Unsupported creation receipt schema/
  );
});

test('escapes receipt content before embedding it in the offline surface', async () => {
  const receipt = await makeReadyReceipt({ goal: '</script><script>globalThis.pwned=true</script>' });
  const html = renderCreationObserverHtml(receipt);
  assert.equal(html.includes('</script><script>globalThis.pwned=true</script>'), false);
  assert.match(html, /&lt;\/script&gt;/);
  assert.match(html, /\\u003c\/script\\u003e/);
});
