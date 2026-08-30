import { ParallelCapabilityFabric } from '../src/index.js';

const fabric = new ParallelCapabilityFabric({ limits: { workers: 4 } });
const numbers = [2, 3, 5, 7, 11, 13, 17, 19];

const receipt = await fabric.start({
  runId: 'demo-calculation-v1',
  goal: 'Square independent inputs in bounded parallel lanes',
  stateRef: 'numbers:v1',
  rollbackRef: 'numbers:v1',
  tasks: numbers.map((number, index) => ({
    taskId: `square-${index}`,
    capabilityId: 'deterministic.square',
    authority: ['OBSERVE'],
    inputRefs: [`numbers[${index}]`],
    run: () => ({
      output: number * number,
      evidenceRefs: [`input:${number}`],
      testResults: [{ predicate: 'exact-square', passed: Number.isInteger(number * number) }]
    })
  }))
}).result;

console.log(JSON.stringify(receipt, null, 2));
