import { ParallelCapabilityFabric } from '../src/index.js';

const source = `
export function total(values) {
  // TODO: validate input
  return values.reduce((sum, value) => sum + value, 0);
}
`;

const fabric = new ParallelCapabilityFabric({ limits: { workers: 3 } });
const receipt = await fabric.start({
  runId: 'demo-inspection-v1',
  goal: 'Inspect one bounded source snapshot from different deterministic lenses',
  stateRef: 'source:sha256-demo',
  tasks: [
    {
      taskId: 'todo-scan',
      capabilityId: 'inspection.todo-count',
      authority: ['READ', 'OBSERVE'],
      run: () => ({ output: { todoCount: (source.match(/TODO/g) ?? []).length } })
    },
    {
      taskId: 'eval-scan',
      capabilityId: 'inspection.eval-detection',
      authority: ['READ', 'OBSERVE'],
      run: () => ({ output: { usesEval: /\beval\s*\(/.test(source) } })
    },
    {
      taskId: 'export-scan',
      capabilityId: 'inspection.exports',
      authority: ['READ', 'OBSERVE'],
      run: () => ({ output: { exportsFunction: /export\s+function\s+total/.test(source) } })
    }
  ]
}).result;

console.log(JSON.stringify(receipt, null, 2));
