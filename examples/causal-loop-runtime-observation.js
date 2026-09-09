import { resolve } from 'node:path';
import {
  observeCausalLoopProvider,
  verifyCausalLoopRuntimeObservation
} from '../src/causal-loop-runtime.js';

const providerRoot = process.argv[2] ? resolve(process.argv[2]) : null;
const providerSourceRef = process.argv[3] ?? null;

if (!providerRoot) {
  console.error('usage: node examples/causal-loop-runtime-observation.js <provider-root> [provider-source-ref]');
  process.exit(2);
}

const receipt = observeCausalLoopProvider({
  providerRoot,
  providerSourceRef,
  requestId: 'causal-loop-runtime-example',
  timedInfluences: [
    { atWave: 2, action: 'BLOCK_DOOR' },
    { atWave: 3, action: 'TRIGGER_ALARM' }
  ],
  maxWaves: 64
});

if (receipt.observation.status !== 'RUNTIME_OBSERVED') {
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(1);
}

verifyCausalLoopRuntimeObservation(receipt);
console.log(JSON.stringify(receipt, null, 2));
