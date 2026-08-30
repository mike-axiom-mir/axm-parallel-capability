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
