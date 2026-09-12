import { readFile } from 'node:fs/promises';
import { createDiscoveryRequirementReceipt } from '../src/discovery-index.js';

const [indexPath, capabilityId, expectedProvider] = process.argv.slice(2);
if (!indexPath || !capabilityId || !expectedProvider) {
  console.error('usage: node tools/discovery-index-smoke.js <index.json> <capability-id> <expected-provider>');
  process.exit(2);
}

const index = JSON.parse(await readFile(indexPath, 'utf8'));
const receipt = createDiscoveryRequirementReceipt(index, { requirements: [capabilityId] });
const requirement = receipt.requirements[0];
if (requirement.status !== 'DISCOVERED_DECLARATION') {
  throw new Error(`expected ${capabilityId} to be discovered, got ${requirement.status}`);
}
if (!requirement.candidates.some((candidate) => candidate.providers.includes(expectedProvider))) {
  throw new Error(`expected provider ${expectedProvider} for ${capabilityId}`);
}
if (requirement.candidates.some((candidate) => candidate.runtimeVerified || candidate.executionAuthority !== 'NONE')) {
  throw new Error('discovery declaration was silently upgraded into runtime or execution authority');
}
console.log(JSON.stringify({
  schema: receipt.schema,
  discoveryContentSha256: receipt.discoveryContentSha256,
  capabilityId,
  candidates: requirement.candidates.length,
  authority: receipt.authority.kind
}));
