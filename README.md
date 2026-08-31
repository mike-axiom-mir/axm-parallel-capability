# AXM Parallel Capability Fabric

A focused experimental repository for extracting the bounded parallel-work pattern discovered in Discovery Buddy into a reusable AXM capability fabric.

The objective is **not more agents**. It is more grounded capability per unit of time while preserving truth, control, attribution, bounded authority, deterministic handling, and reversibility.

## Truth status

### Observed in the source handoff

Discovery Buddy v1.12 demonstrated bounded concurrent worker scheduling, checkpointing, pause/resume/cancel, deterministic scan handling, source-integrity hashing, and bounded read authority. The source handoff records a synthetic 80-job scheduler test with four concurrent slots and explicitly limits that evidence to the synthetic scheduler harness.

See `docs/FOUNDING_DIRECTION.md` for the source-grounded repository intake. The complete handoff remains the authoritative source used to bootstrap this lane.

### Implemented in this repository, Lane 1

#### v0.1 bounded orchestration

- bounded capability lanes;
- dependency-aware task graph;
- declared resource-token limits;
- explicit run/task/lane identifiers;
- lane receipts;
- deterministic output ordering by declared task plan;
- pause/resume/cancel;
- checkpoint export and exact `runId` + `stateRef` binding;
- failed-dependency propagation;
- contradiction preservation;
- proposed-change conflict reporting;
- deterministic candidate selection against explicit predicates.

#### v0.2 deterministic JSON-state merge contract

- explicit merge planning separate from commit authority;
- state-version, authority, evidence, failure, status, and test predicates;
- exact-path and parent/child-path conflict detection;
- deterministic operation ordering and identical-proposal coalescing;
- JSON-compatible in-memory `set` / `delete` commits;
- optional operation preconditions;
- merge receipts with source/result hashes;
- merge-plan integrity checking;
- rollback tokens with exact source snapshots;
- rollback-token integrity checking;
- rollback refusal after committed-state drift.

#### v0.3 disposable clone bodies + integration clone

- candidate work receives a writable disposable copy rather than the protected body;
- independent clones can diverge without sharing mutations;
- source-to-clone diffs are generated deterministically;
- generated operations carry source-value/existence preconditions;
- clone candidates bind to an exact source-state content hash;
- failed clone work remains a failed candidate;
- compatible candidates can merge into a disposable integration clone;
- conflicts can hold the integration run instead of touching protected state;
- integration tests gate `VALID_IN_HARNESS` status;
- an integration result is only a new `COMMIT-CANDIDATE`, not a protected-state mutation;
- protected-body planning adds exact source-content binding even when an external `stateRef` is reused;
- a separate explicit public merge commit is still required to cross the protected boundary.

#### v0.4 scheduler-native Creation Fabric cycle

- declared candidate work contracts are converted into scheduler tasks automatically;
- clone candidate tasks use the same bounded worker/resource scheduling layer as v0.1;
- candidate-to-candidate dependencies are supported without auto-applying dependency clone state;
- completed dependency candidate receipts are available to downstream work as `dependencyCandidates`;
- the integration task is generated automatically and depends on all candidate tasks;
- candidate failures remain candidate evidence rather than automatically becoming scheduler failures;
- successful independent candidates may continue into integration when another experiment fails;
- candidate order remains tied to declared/topological order rather than completion timing;
- candidate work receives the scheduler `AbortSignal` for cooperative cancellation;
- creation sessions expose pause/resume/cancel/snapshot/checkpoint behavior through the scheduler;
- checkpoint reuse can avoid rerunning completed candidate and integration work;
- candidate authority defaults to `WRITE-SANDBOX`, not `COMMIT-CANDIDATE`;
- protected-body content is hashed at cycle start and checked again at completion for drift;
- an integration candidate is converted into a protected-body plan only after integration tests;
- a ready Creation Fabric cycle still requires the separate public `commitMerge(...)` call;
- the creation receipt keeps source lineage through hashes rather than silently duplicating another full source-body snapshot.

#### v0.5 deterministic decomposition grammar

- an explicit goal grammar uses exact requirement tokens rather than pretending arbitrary prose is deterministically understood;
- body maps declare addressable state areas, explicit capability allowlists, and allowed authority classes;
- capability descriptors declare provided tokens, dependencies, target body areas, authority, resources, evidence, tests, priority, solution pressure, and an `executorRef`;
- required tokens are covered by a deterministic greedy rule: most uncovered tokens, then priority, then capability id;
- optional exploration slots add explicitly requested alternative solution pressures;
- capability dependencies are closed recursively and emitted as a topological candidate graph;
- unresolved dependency cycles are held before scheduling;
- effective authority is the intersection of capability request, body-area permission, and global constraints;
- authority is never widened to make a graph executable;
- undeclared or over-budget resource classes reject a capability before scheduling;
- selected candidates receive a generated `decomposition-scope-boundary` test so out-of-scope clone writes fail the candidate gate;
- missing evidence, domain tests, required-token coverage, integration tests, or candidate-count bounds can hold decomposition before any creation work starts;
- a deterministic structural `planId` binds goal/body-map/constraint/selected-capability metadata and declared `executorRef` values;
- executable functions are not treated as cryptographically identified by that plan hash;
- a ready decomposition compiles directly into the v0.4 `CreationFabric` format;
- a successful decomposed creation still stops at the protected-body plan and separate explicit `commitMerge(...)` gate.

#### v0.6 capability registry + body-map intake protocol

- portable JSON-compatible capability and body-map manifests can be ingested without executing foreign code;
- normalized capability and body-map manifests receive deterministic SHA-256 content identities;
- portable registry snapshots receive deterministic structural snapshot identities;
- runtime executor/test bindings are local process state and do not alter the portable registry snapshot;
- exact manifest re-intake is idempotent;
- same id with different manifest content is rejected instead of latest-writer-wins replacement;
- mixed bundles preserve valid entries while malformed advertisements receive rejection receipts;
- declared `manifestId` values are recomputed and mismatches are rejected;
- runtime `executorRef` and `testRef` bindings are explicit and silent rebinding to different functions is refused;
- unbound advertisements remain inert and are reported as unavailable during resolution;
- body-map references to missing capabilities remain visible in resolution receipts;
- registry resolution closes capability dependencies before handing executable descriptors to decomposition;
- registry snapshot and capability manifest refs flow into Creation Fabric input lineage;
- `createRegisteredDecompositionPlan(...)` resolves a registry catalog before invoking the v0.5 deterministic compiler;
- `runRegisteredCreation(...)` resolves -> decomposes -> runs Creation Fabric while still stopping at the normal explicit protected merge gate;
- imported manifests do not grant authority. v0.5 still intersects capability request, body-map permission, and global constraints.

These claims are scoped to the Node harness and the documented JSON-state grammar. Clone isolation currently means **independent in-memory JSON-compatible plain-object copies inside one JavaScript process**. It is not a claim of hostile-code sandboxing, VM/container isolation, filesystem cloning, source-tree cloning, databases, binary assets, or game/world engines.

See `docs/MERGE_CONTRACT_V0_2.md`, `docs/CLONE_BODY_CONTRACT_V0_3.md`, `docs/CREATION_FABRIC_CONTRACT_V0_4.md`, `docs/DECOMPOSITION_GRAMMAR_V0_5.md`, and `docs/CAPABILITY_REGISTRY_PROTOCOL_V0_6.md` for narrower contracts and limitations.

### Still proposal / not yet proven here

- free-text goal parsing into trusted executable requirement tokens;
- automatic repository crawling / manifest discovery;
- cryptographic author authentication or signed capability manifests;
- automatic verification that a declared `sourceRef` is truthful;
- arbitrary capability discovery/spawning beyond explicitly supplied registry advertisements;
- adaptive CPU/disk/event-loop backoff;
- persistent checkpoint storage;
- durable external clone/rollback storage;
- generic source-code / filesystem / database merge adapters;
- automatic repair of held merge conflicts;
- Grammar Glass survivor loops;
- Walmi temporary specialist spawning;
- game/world-state orchestration;
- measured real-workload improvement over sequential execution.

## One chat = one lane

Repository work follows `AGENTS.md`. This bootstrap conversation owns:

`chat/1-parallel-fabric-bootstrap`

One chat keeps one branch and one primary PR. It does not spread work across sibling PRs as the task evolves.

## Install / test

No runtime dependencies are required.

```bash
npm test
```

Requires Node.js 20 or newer.

## Demos

```bash
npm run demo:calculation
npm run demo:inspection
npm run demo:selection
npm run demo:merge
npm run demo:clone
npm run demo:creation
npm run demo:decomposition
npm run demo:registry
```

The first three demos cover the founding builder-handoff targets. `demo:merge` demonstrates the v0.2 plan -> commit -> receipt -> rollback gate. `demo:clone` demonstrates candidate clones -> integration clone -> protected-body plan -> explicit commit. `demo:creation` demonstrates scheduler-generated clone tasks -> integration dependency -> protected-body plan -> explicit commit. `demo:decomposition` demonstrates explicit goal/body/capability descriptors -> deterministic candidate graph -> Creation Fabric -> explicit commit. `demo:registry` demonstrates portable manifest intake -> local runtime binding -> registry resolution -> decomposition -> Creation Fabric -> explicit commit.

## Bounded scheduler API

```js
import { ParallelCapabilityFabric } from '@axm/parallel-capability';

const fabric = new ParallelCapabilityFabric({
  limits: { workers: 4, memoryMB: 1024 }
});

const session = fabric.start({
  runId: 'run-001',
  goal: 'Inspect independent inputs',
  stateRef: 'snapshot:abc123',
  rollbackRef: 'snapshot:before',
  tasks: [
    {
      taskId: 'lane-a',
      capabilityId: 'example.inspect',
      authority: ['READ', 'OBSERVE'],
      resources: { workers: 1, memoryMB: 128 },
      run: async () => ({
        output: { ok: true },
        evidenceRefs: ['input:a'],
        proposedChanges: []
      })
    }
  ]
});

const receipt = await session.result;
```

## Merge API

Merge planning is intentionally separate from committing:

```js
import { createMergePlan, commitMerge, rollbackMerge } from '@axm/parallel-capability';

const plan = createMergePlan({
  runId: 'run-001',
  stateRef: 'state:v1',
  rollbackRef: 'state:v0',
  candidates: laneReceipts
});

const committed = commitMerge({
  state,
  currentStateRef: 'state:v1',
  plan,
  resultingStateRef: 'state:v2'
});

const restored = rollbackMerge({
  state: committed.state,
  currentStateRef: committed.stateRef,
  rollbackToken: committed.rollbackToken
});
```

By default a candidate must bind to the exact state version, carry `COMMIT-CANDIDATE` authority, provide evidence, report no failures, and have at least one passing test with all declared tests passing. Conflicting candidates are held by default. An explicit `merge-nonconflicting` policy may commit independent accepted candidates while keeping conflicting candidates unresolved and traceable.

## Clone-body API

```js
import {
  runCloneCandidate,
  buildIntegrationClone,
  createBodyCommitPlan,
  commitMerge
} from '@axm/parallel-capability';

const candidate = await runCloneCandidate({
  id: 'performance',
  state: protectedBody,
  stateRef: 'body:v1',
  authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
  evidenceRefs: ['benchmark:1'],
  tests: [{ id: 'target', test: ({ state }) => state.config.cacheMB === 128 }],
  work: ({ state }) => {
    state.config.cacheMB = 128;
  }
});

const integration = await buildIntegrationClone({
  integrationId: 'integration-1',
  runId: 'integration-run-1',
  state: protectedBody,
  stateRef: 'body:v1',
  rollbackRef: 'body:v1',
  candidates: [candidate],
  tests: [{ id: 'integration-target', test: ({ state }) => state.config.cacheMB === 128 }]
});

const bodyPlan = createBodyCommitPlan({
  runId: 'protected-plan-1',
  state: protectedBody,
  stateRef: 'body:v1',
  rollbackRef: 'body:v1',
  candidates: [integration.candidate]
});

const committed = commitMerge({
  state: protectedBody,
  currentStateRef: 'body:v1',
  plan: bodyPlan.mergePlan
});
```

`WRITE-SANDBOX` allows work inside the clone. `COMMIT-CANDIDATE` only allows the result to be considered by merge predicates. Neither is automatic merge authority.

## Creation Fabric API

```js
import { CreationFabric } from '@axm/parallel-capability';

const fabric = new CreationFabric({ limits: { workers: 3 } });
const cycle = fabric.start({
  runId: 'creation-1',
  goal: 'Explore bounded candidate improvements',
  state: protectedBody,
  stateRef: 'body:v1',
  rollbackRef: 'body:v0',
  candidates: [
    {
      id: 'analyzer',
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['inspection:1'],
      tests: [{ id: 'analysis-ok', test: () => true }],
      work: () => ({ metadata: { target: 12 } })
    },
    {
      id: 'performance',
      dependsOn: ['analyzer'],
      authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
      evidenceRefs: ['benchmark:1'],
      tests: [{ id: 'candidate-target', test: ({ state }) => state.metrics.runtimeMs <= 12 }],
      work: ({ state, dependencyCandidates }) => {
        state.metrics.runtimeMs = dependencyCandidates.analyzer.metadata.target;
      }
    }
  ],
  integration: {
    evidenceRefs: ['integration:harness'],
    tests: [{ id: 'combined-target', test: ({ state }) => state.metrics.runtimeMs <= 12 }]
  }
});

const receipt = await cycle.result;
```

A ready Creation Fabric cycle still has not mutated the protected body. Adoption requires the separate public merge call.

## Decomposition API

v0.5 compiles an explicit deterministic goal grammar into the Creation Fabric format:

```js
import { runDecomposedCreation } from '@axm/parallel-capability';

const { plan, creation } = await runDecomposedCreation({
  runId: 'decompose-1',
  state: protectedBody,
  stateRef: 'body:v1',
  rollbackRef: 'body:v0',
  goal: {
    id: 'cache-upgrade',
    summary: 'Upgrade the cache policy',
    requirements: [{ id: 'cache', token: 'cache-upgrade' }],
    integrationTests: [
      { id: 'cache-target', test: ({ state }) => state.config.cacheMB === 128 }
    ]
  },
  bodyMap: {
    id: 'body-map:cache',
    areas: [{
      id: 'config',
      path: 'config',
      allowedCapabilities: ['cache-builder'],
      authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
    }]
  },
  capabilities: [{
    id: 'cache-builder',
    executorRef: 'cache-builder/v1',
    provides: ['cache-upgrade'],
    targetAreas: ['config'],
    authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: { workers: 1 },
    evidenceRefs: ['benchmark:cache'],
    tests: [{ id: 'bounded-cache', test: ({ state }) => state.config.cacheMB <= 256 }],
    work: ({ state }) => {
      state.config.cacheMB = 128;
    }
  }],
  constraints: {
    resourceBudget: { limits: { workers: 2 } }
  }
});
```

The human-readable `summary` is not executable parser input. Exact requirement tokens, body-map permissions, capability descriptors, dependencies, and constraints drive decomposition.

## Capability Registry API

v0.6 separates portable advertisement from local execution:

```js
import {
  CapabilityRegistry,
  createRegistryBundle,
  runRegisteredCreation
} from '@axm/parallel-capability';

const registry = new CapabilityRegistry();

registry.ingestBundle(createRegistryBundle({
  capabilities: [{
    schema: 'axm.parallel-capability-manifest/v0.6',
    id: 'cache-builder',
    version: '1',
    sourceRef: 'repo:example@ref:cache-builder',
    executorRef: 'executor:cache-builder/v1',
    role: 'CACHE',
    pressure: 'balanced',
    provides: ['cache-upgrade'],
    dependsOn: [],
    targetAreas: ['config'],
    authority: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE'],
    resources: { workers: 1 },
    inputRefs: [],
    evidenceRefs: ['contract:cache-builder'],
    testRefs: ['test:cache-builder/v1'],
    priority: 10,
    metadata: {}
  }],
  bodyMaps: [{
    schema: 'axm.parallel-capability-body-map-manifest/v0.6',
    id: 'example-body',
    version: '1',
    sourceRef: 'repo:example@ref:body-map',
    areas: [{
      id: 'config',
      path: 'config',
      allowedCapabilities: ['cache-builder'],
      authorities: ['WRITE-SANDBOX', 'COMMIT-CANDIDATE']
    }],
    metadata: {}
  }]
}));

// Structural intake above was inert. Bind runtime behavior separately.
registry.bindExecutor('executor:cache-builder/v1', ({ state }) => {
  state.config.cacheMB = 128;
});
registry.bindTest('test:cache-builder/v1', ({ state }) => state.config.cacheMB === 128);

const result = await runRegisteredCreation(registry, {
  bodyMapId: 'example-body',
  runId: 'registry-run',
  state: protectedBody,
  stateRef: 'body:v1',
  rollbackRef: 'body:v0',
  goal: {
    id: 'cache-upgrade',
    requirements: [{ id: 'cache', token: 'cache-upgrade' }],
    integrationTests: [
      { id: 'cache-target', test: ({ state }) => state.config.cacheMB === 128 }
    ]
  },
  constraints: { resourceBudget: { limits: { workers: 2 } } }
});
```

Portable manifest hashes and registry snapshot hashes identify deterministic supplied content. They are not cryptographic signatures and do not prove the truth of `sourceRef`.

## Design boundary

A lane is a bounded work contract, not automatically a persistent agent. Same-body coordination never implies unlimited write or merge authority.

The repository now demonstrates a reversible sequence for its bounded JSON-state harness:

`portable capability advertisement -> inert registry intake -> local runtime binding -> registry resolution -> explicit goal grammar -> deterministic candidate graph -> scheduler-generated clone tasks -> parallel candidate bodies -> receipts/diffs -> conflict/test gate -> integration clone -> integration candidate -> protected-body plan -> explicit commit -> rollback receipt`

That is still a prototype grammar, not universal transaction infrastructure, general-language understanding, arbitrary code trust, or autonomous general creation.
