import { resolve } from 'node:path';
import {
  observePortableCausalLoopProvider,
  verifyPortableCausalLoopRuntimeObservation
} from '../src/causal-loop-portable-runtime.js';

const portablePath = process.argv[2] ? resolve(process.argv[2]) : null;
const expectedArtifactSha256 = process.argv[3] ?? null;
const providerSourceRef = process.argv[4] ?? null;

if (!portablePath || !expectedArtifactSha256) {
  console.error('usage: node examples/causal-loop-portable-runtime-observation.js <portable-pyz> <expected-sha256> [provider-source-ref]');
  process.exit(2);
}

const receipt = observePortableCausalLoopProvider({
  portablePath,
  expectedArtifactSha256,
  providerSourceRef,
  requestId: 'causal-loop-portable-runtime-example',
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

verifyPortableCausalLoopRuntimeObservation(receipt);
console.log(JSON.stringify(receipt, null, 2));
