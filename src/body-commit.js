import { hashState } from './merge.js';
import { commitMerge } from './merge-gate.js';

const BODY_PLAN_SCHEMA = 'axm.parallel-capability-body-plan/v0.3';

export function commitBodyPlan({
  state,
  currentStateRef,
  bodyPlan,
  resultingStateRef = null,
  now = () => new Date().toISOString()
}) {
  if (!bodyPlan || bodyPlan.schema !== BODY_PLAN_SCHEMA) {
    throw new Error(`Unsupported body plan schema: ${bodyPlan?.schema ?? '<missing>'}`);
  }
  if (!bodyPlan.mergePlan || typeof bodyPlan.mergePlan !== 'object' || Array.isArray(bodyPlan.mergePlan)) {
    throw new TypeError('bodyPlan.mergePlan is required');
  }
  if (currentStateRef == null) throw new TypeError('currentStateRef is required');

  const currentRef = String(currentStateRef);
  const sourceRef = String(bodyPlan.sourceStateRef);

  if (currentRef !== sourceRef) {
    throw new Error(`Stale body plan: currentStateRef ${currentRef} !== body plan sourceStateRef ${sourceRef}`);
  }
  if (bodyPlan.mergePlan.stateRef !== sourceRef) {
    throw new Error(
      `Body plan lineage mismatch: merge plan stateRef ${bodyPlan.mergePlan.stateRef ?? '<missing>'} !== body plan sourceStateRef ${sourceRef}`
    );
  }

  const currentStateHash = hashState(state);
  if (currentStateHash !== bodyPlan.sourceStateHash) {
    throw new Error(
      `Stale body plan: current state content hash ${currentStateHash} !== body plan sourceStateHash ${bodyPlan.sourceStateHash ?? '<missing>'}`
    );
  }

  return commitMerge({
    state,
    currentStateRef: currentRef,
    plan: bodyPlan.mergePlan,
    resultingStateRef,
    now
  });
}
