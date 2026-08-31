export {
  ParallelCapabilityFabric,
  detectProposedChangeConflicts,
  selectCandidate
} from './fabric.js';

export {
  createMergePlan,
  detectMergeConflicts,
  hashState
} from './merge.js';

export {
  commitMerge,
  rollbackMerge
} from './merge-gate.js';

export {
  buildIntegrationClone,
  createBodyCommitPlan,
  diffJsonState,
  runCloneCandidate
} from './clone-body.js';

export {
  CreationFabric,
  runCreationCycle
} from './creation-fabric.js';

export {
  createDecompositionPlan,
  runDecomposedCreation
} from './decomposition.js';

export {
  CapabilityRegistry,
  createRegisteredDecompositionPlan,
  createRegistryBundle,
  runRegisteredCreation,
  validateBodyMapManifest,
  validateCapabilityManifest
} from './registry.js';

export {
  createExternalSourceReceipt,
  createVerifiedExternalCapabilityManifest,
  createVerifiedExternalRegistryBundle,
  getExternalClaim
} from './external-source.js';

export {
  assertGitHubEvidenceCollection,
  collectGitHubEvidence,
  createExternalSourceReceiptFromGitHubCollection,
  createMemoryGitHubEvidenceClient
} from './github-evidence.js';
