export {
  ParallelCapabilityFabric,
  detectProposedChangeConflicts,
  selectCandidate
} from './fabric.js';

export {
  createMergePlan,
  commitMerge,
  rollbackMerge,
  detectMergeConflicts,
  hashState
} from './merge.js';
