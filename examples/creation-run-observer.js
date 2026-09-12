import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CreationFabric } from '../src/index.js';
import { renderCreationObserverHtml } from '../experience/creation-run-observer.js';

const outputPath = resolve(process.argv[2] ?? 'creation-run-observer.html');
const protectedBody = {
  engine: { cacheMB: 64, batchSize: 8 },
  ui: { compact: false },
  metrics: { runtimeMs: 20 }
};
const stableNow = () => '2026-09-09T00:00:00.000Z';
const fabric = new CreationFabric({ limits: { workers: 3 }, now: stableNow });
const session = fabric.start({
  runId: 'experience-observer-demo-v1',
  goal: 'Explore compatible bounded improvements while keeping the protected body outside automatic authority',
  state: protectedBody,
  stateRef: 'demo-body:v1',
  rollbackRef: 'demo-body:v0',
  candidates: [
    {
      id: 'performance',
      role: 'PERFORMANCE',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['benchmark:performance'],
      tests: [{ id: 'runtime-target', test: ({ state }) => state.metrics.runtimeMs <= 12 }],
      work: ({ state }) => { state.engine.cacheMB = 128; state.metrics.runtimeMs = 12; }
    },
    {
      id: 'memory',
      role: 'MEMORY',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['inspection:memory'],
      tests: [{ id: 'batch-bounded', test: ({ state }) => state.engine.batchSize <= 8 }],
      work: ({ state }) => { state.engine.batchSize = 4; }
    },
    {
      id: 'usability',
      role: 'USABILITY',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['inspection:ui'],
      tests: [{ id: 'compact-enabled', test: ({ state }) => state.ui.compact === true }],
      work: ({ state }) => { state.ui.compact = true; }
    }
  ],
  integration: {
    id: 'experience-observer-integration',
    evidenceRefs: ['integration:harness'],
    tests: [
      { id: 'combined-runtime', test: ({ state }) => state.metrics.runtimeMs <= 12 },
      { id: 'combined-memory', test: ({ state }) => state.engine.batchSize === 4 },
      { id: 'combined-ui', test: ({ state }) => state.ui.compact === true }
    ]
  }
});

const receipt = await session.result;
const html = renderCreationObserverHtml(receipt);
await writeFile(outputPath, html, 'utf8');
console.log(JSON.stringify({
  outputPath,
  status: receipt.status,
  protectedStateDrifted: receipt.protectedStateDrifted,
  commitAllowed: receipt.bodyPlan?.mergePlan?.commitAllowed === true
}, null, 2));
