import { ParallelCapabilityFabric, selectCandidate } from '../src/index.js';

const fabric = new ParallelCapabilityFabric({ limits: { workers: 3 } });
const buildReceipt = await fabric.start({
  runId: 'demo-candidates-v1',
  goal: 'Generate bounded deterministic cache candidates',
  stateRef: 'cache-policy:v1',
  tasks: [
    { taskId: 'minimal', run: () => ({ output: { id: 'minimal', testsPass: true, memoryMB: 64, runtimeMs: 12 } }) },
    { taskId: 'balanced', run: () => ({ output: { id: 'balanced', testsPass: true, memoryMB: 128, runtimeMs: 7 } }) },
    { taskId: 'aggressive', run: () => ({ output: { id: 'aggressive', testsPass: false, memoryMB: 512, runtimeMs: 4 } }) }
  ]
}).result;

const candidates = buildReceipt.outputs.map((item) => item.output).filter(Boolean);
const selection = selectCandidate(candidates, {
  runId: buildReceipt.runId,
  predicates: [
    { id: 'tests-pass', test: (candidate) => candidate.testsPass === true },
    { id: 'memory-under-256mb', test: (candidate) => candidate.memoryMB <= 256 }
  ],
  compare: (a, b) => a.runtimeMs - b.runtimeMs
});

console.log(JSON.stringify({ buildReceipt, selection }, null, 2));
