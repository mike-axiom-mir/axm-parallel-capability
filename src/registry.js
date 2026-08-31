import { createHash } from 'node:crypto';
import { createDecompositionPlan } from './decomposition.js';
import { CreationFabric } from './creation-fabric.js';

const CAPABILITY_SCHEMA = 'axm.parallel-capability-manifest/v0.6';
const BODY_MAP_SCHEMA = 'axm.parallel-capability-body-map-manifest/v0.6';
const BUNDLE_SCHEMA = 'axm.parallel-capability-registry-bundle/v0.6';
const SNAPSHOT_SCHEMA = 'axm.parallel-capability-registry-snapshot/v0.6';
const INTAKE_RECEIPT_SCHEMA = 'axm.parallel-capability-registry-intake-receipt/v0.6';
const RESOLUTION_RECEIPT_SCHEMA = 'axm.parallel-capability-registry-resolution-receipt/v0.6';
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export class CapabilityRegistry {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.capabilities = new Map();
    this.bodyMaps = new Map();
    this.executors = new Map();
    this.tests = new Map();
  }

  ingestBundle(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw new TypeError('registry bundle must be an object');
    }
    if (bundle.schema !== BUNDLE_SCHEMA) {
      throw new Error(`Unsupported registry bundle schema: ${bundle.schema ?? '<missing>'}`);
    }
    if (!Array.isArray(bundle.capabilities ?? [])) throw new TypeError('bundle.capabilities must be an array');
    if (!Array.isArray(bundle.bodyMaps ?? [])) throw new TypeError('bundle.bodyMaps must be an array');

    const beforeSnapshotId = this.snapshot().snapshotId;
    const accepted = [];
    const idempotent = [];
    const rejected = [];

    ingestManifestSet({
      rawItems: bundle.capabilities ?? [],
      kind: 'CAPABILITY',
      normalize: normalizeCapabilityManifest,
      store: this.capabilities,
      accepted,
      idempotent,
      rejected
    });
    ingestManifestSet({
      rawItems: bundle.bodyMaps ?? [],
      kind: 'BODY_MAP',
      normalize: normalizeBodyMapManifest,
      store: this.bodyMaps,
      accepted,
      idempotent,
      rejected
    });

    const after = this.snapshot();
    return {
      schema: INTAKE_RECEIPT_SCHEMA,
      beforeSnapshotId,
      afterSnapshotId: after.snapshotId,
      accepted: accepted.sort(compareReceiptItems),
      idempotent: idempotent.sort(compareReceiptItems),
      rejected: rejected.sort(compareRejectedItems),
      completedAt: this.now()
    };
  }

  bindExecutor(executorRef, work, { bindingRef = null } = {}) {
    if (!executorRef) throw new TypeError('executorRef is required');
    if (typeof work !== 'function') throw new TypeError('executor binding must be a function');
    const ref = String(executorRef);
    const existing = this.executors.get(ref);
    if (existing && existing.work !== work) {
      throw new Error(`Executor ${ref} is already bound; silent rebinding is forbidden`);
    }
    this.executors.set(ref, { work, bindingRef: String(bindingRef ?? ref) });
    return { executorRef: ref, bindingRef: this.executors.get(ref).bindingRef, status: existing ? 'IDEMPOTENT' : 'BOUND' };
  }

  bindTest(testRef, test, { bindingRef = null } = {}) {
    if (!testRef) throw new TypeError('testRef is required');
    if (typeof test !== 'function') throw new TypeError('test binding must be a function');
    const ref = String(testRef);
    const existing = this.tests.get(ref);
    if (existing && existing.test !== test) {
      throw new Error(`Test ${ref} is already bound; silent rebinding is forbidden`);
    }
    this.tests.set(ref, { test, bindingRef: String(bindingRef ?? ref) });
    return { testRef: ref, bindingRef: this.tests.get(ref).bindingRef, status: existing ? 'IDEMPOTENT' : 'BOUND' };
  }

  snapshot() {
    const core = {
      schema: SNAPSHOT_SCHEMA,
      capabilities: [...this.capabilities.values()]
        .map((entry) => cloneJson(entry))
        .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)),
      bodyMaps: [...this.bodyMaps.values()]
        .map((entry) => cloneJson(entry))
        .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
    };
    return {
      ...core,
      snapshotId: `registry-snapshot:sha256:${sha256(stableStringify(core))}`
    };
  }

  toBundle() {
    return {
      schema: BUNDLE_SCHEMA,
      capabilities: [...this.capabilities.values()]
        .map((entry) => cloneJson(entry))
        .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)),
      bodyMaps: [...this.bodyMaps.values()]
        .map((entry) => cloneJson(entry))
        .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
    };
  }

  runtimeAvailability() {
    const capabilities = [...this.capabilities.values()]
      .map(({ manifest, manifestId }) => ({
        id: manifest.id,
        manifestId,
        executorRef: manifest.executorRef,
        executorBound: this.executors.has(manifest.executorRef),
        tests: manifest.testRefs.map((testRef) => ({ testRef, bound: this.tests.has(testRef) }))
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { snapshotId: this.snapshot().snapshotId, capabilities };
  }

  resolve({ bodyMapId, capabilityIds = null } = {}) {
    if (!bodyMapId) throw new TypeError('bodyMapId is required');
    const bodyEntry = this.bodyMaps.get(String(bodyMapId));
    if (!bodyEntry) throw new Error(`Unknown body map: ${bodyMapId}`);
    const snapshot = this.snapshot();
    const bodyManifest = bodyEntry.manifest;
    const requested = capabilityIds == null
      ? uniqueStrings(bodyManifest.areas.flatMap((area) => area.allowedCapabilities))
      : uniqueStrings(capabilityIds);
    const closureIds = dependencyClosureIds(requested, this.capabilities);
    const unavailable = [];
    const locallyBindable = new Set();

    for (const id of closureIds) {
      const entry = this.capabilities.get(id);
      if (!entry) {
        unavailable.push({ id, reasons: ['MISSING_CAPABILITY_MANIFEST'] });
        continue;
      }
      const reasons = [];
      if (!this.executors.has(entry.manifest.executorRef)) reasons.push(`MISSING_EXECUTOR_BINDING:${entry.manifest.executorRef}`);
      for (const testRef of entry.manifest.testRefs) {
        if (!this.tests.has(testRef)) reasons.push(`MISSING_TEST_BINDING:${testRef}`);
      }
      if (reasons.length === 0) locallyBindable.add(id);
      else unavailable.push({ id, reasons: reasons.sort() });
    }

    // If a capability's dependency is unavailable, the dependent is unavailable too.
    let changed;
    do {
      changed = false;
      for (const id of [...locallyBindable].sort()) {
        const manifest = this.capabilities.get(id).manifest;
        const missingDependency = manifest.dependsOn.find((dependencyId) => !locallyBindable.has(dependencyId));
        if (!missingDependency) continue;
        locallyBindable.delete(id);
        unavailable.push({ id, reasons: [`DEPENDENCY_UNAVAILABLE:${missingDependency}`] });
        changed = true;
      }
    } while (changed);

    const capabilities = [...locallyBindable]
      .sort()
      .map((id) => materializeCapability({
        entry: this.capabilities.get(id),
        snapshotId: snapshot.snapshotId,
        executors: this.executors,
        tests: this.tests
      }));

    const unavailableCapabilities = mergeUnavailable(unavailable);
    const registryContext = {
      snapshotId: snapshot.snapshotId,
      bodyMapManifestId: bodyEntry.manifestId,
      capabilityManifestIds: capabilities.map((capability) => capability.descriptorRef).sort(),
      unavailableCapabilities
    };

    return {
      receipt: {
        schema: RESOLUTION_RECEIPT_SCHEMA,
        snapshotId: snapshot.snapshotId,
        bodyMapId: bodyManifest.id,
        bodyMapManifestId: bodyEntry.manifestId,
        requestedCapabilityIds: requested,
        resolvedCapabilityIds: capabilities.map((capability) => capability.id),
        unavailableCapabilities,
        completedAt: this.now()
      },
      registryContext,
      bodyMap: {
        id: bodyManifest.id,
        areas: cloneJson(bodyManifest.areas)
      },
      capabilities
    };
  }
}

export function createRegistryBundle({ capabilities = [], bodyMaps = [] } = {}) {
  if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array');
  if (!Array.isArray(bodyMaps)) throw new TypeError('bodyMaps must be an array');
  return {
    schema: BUNDLE_SCHEMA,
    capabilities: capabilities.map(normalizeCapabilityManifest).sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)),
    bodyMaps: bodyMaps.map(normalizeBodyMapManifest).sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  };
}

export function validateCapabilityManifest(manifest) {
  return normalizeCapabilityManifest(manifest);
}

export function validateBodyMapManifest(manifest) {
  return normalizeBodyMapManifest(manifest);
}

export function createRegisteredDecompositionPlan(registry, input) {
  assertRegistry(registry);
  const { bodyMapId, capabilityIds = null, ...decompositionInput } = input ?? {};
  const resolution = registry.resolve({ bodyMapId, capabilityIds });
  const plan = createDecompositionPlan({
    ...decompositionInput,
    bodyMap: resolution.bodyMap,
    capabilities: resolution.capabilities,
    registryContext: resolution.registryContext
  });
  return { plan, resolution: resolution.receipt };
}

export async function runRegisteredCreation(registry, input, { fabricOptions = {} } = {}) {
  const compiled = createRegisteredDecompositionPlan(registry, input);
  if (compiled.plan.status !== 'READY') return { ...compiled, creation: null };
  const fabric = new CreationFabric(fabricOptions);
  const creation = await fabric.start(compiled.plan.creationSpec).result;
  return { ...compiled, creation };
}

function ingestManifestSet({ rawItems, kind, normalize, store, accepted, idempotent, rejected }) {
  const valid = [];
  for (const raw of rawItems) {
    try {
      valid.push(normalize(raw));
    } catch (error) {
      rejected.push({ kind, id: raw?.id == null ? null : String(raw.id), reason: serializeError(error) });
    }
  }

  const groups = new Map();
  for (const entry of valid) {
    const id = entry.manifest.id;
    const list = groups.get(id) ?? [];
    list.push(entry);
    groups.set(id, list);
  }

  for (const [id, entries] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const uniqueIds = [...new Set(entries.map((entry) => entry.manifestId))];
    if (uniqueIds.length > 1) {
      rejected.push({ kind, id, reason: 'DUPLICATE_ID_CONFLICT_IN_BUNDLE', manifestIds: uniqueIds.sort() });
      continue;
    }
    const incoming = entries[0];
    const existing = store.get(id);
    if (!existing) {
      store.set(id, incoming);
      accepted.push({ kind, id, manifestId: incoming.manifestId });
      for (let index = 1; index < entries.length; index += 1) {
        idempotent.push({ kind, id, manifestId: incoming.manifestId });
      }
      continue;
    }
    if (existing.manifestId !== incoming.manifestId) {
      rejected.push({
        kind,
        id,
        reason: 'REGISTRY_ID_CONFLICT',
        existingManifestId: existing.manifestId,
        incomingManifestId: incoming.manifestId
      });
      continue;
    }
    for (let index = 0; index < entries.length; index += 1) {
      idempotent.push({ kind, id, manifestId: incoming.manifestId });
    }
  }
}

function normalizeCapabilityManifest(raw) {
  const source = unwrapManifest(raw, CAPABILITY_SCHEMA, 'capability');
  if (!source.id) throw new TypeError('capability manifest id is required');
  if (!source.executorRef) throw new TypeError(`capability ${source.id} executorRef is required`);
  if (!source.sourceRef) throw new TypeError(`capability ${source.id} sourceRef is required`);
  const provides = uniqueStrings(source.provides ?? []);
  if (provides.length === 0) throw new TypeError(`capability ${source.id} provides must be non-empty`);
  const targetAreas = uniqueStrings(source.targetAreas ?? []);
  if (targetAreas.length === 0) throw new TypeError(`capability ${source.id} targetAreas must be non-empty`);
  const evidenceRefs = uniqueStrings(source.evidenceRefs ?? []);
  if (evidenceRefs.length === 0) throw new TypeError(`capability ${source.id} evidenceRefs must be non-empty`);
  const testRefs = uniqueStrings(source.testRefs ?? []);
  if (testRefs.length === 0) throw new TypeError(`capability ${source.id} testRefs must be non-empty`);
  const resources = { workers: 1, ...(source.resources ?? {}) };
  validateResources(resources, `capability ${source.id}.resources`);
  if (resources.workers < 1) throw new TypeError(`capability ${source.id}.resources.workers must be at least 1`);
  assertJson(source.metadata ?? {}, `capability ${source.id}.metadata`);

  const manifest = {
    schema: CAPABILITY_SCHEMA,
    id: String(source.id),
    version: String(source.version ?? '0'),
    sourceRef: String(source.sourceRef),
    executorRef: String(source.executorRef),
    role: String(source.role ?? source.id),
    pressure: String(source.pressure ?? 'default'),
    provides,
    dependsOn: uniqueStrings(source.dependsOn ?? []),
    targetAreas,
    authority: uniqueStrings(source.authority ?? ['WRITE-SANDBOX']),
    resources,
    inputRefs: uniqueStrings(source.inputRefs ?? []),
    evidenceRefs,
    testRefs,
    priority: finiteNumber(source.priority ?? 0, `capability ${source.id}.priority`),
    metadata: cloneJson(source.metadata ?? {})
  };
  const manifestId = `capability-manifest:sha256:${sha256(stableStringify(manifest))}`;
  verifyDeclaredManifestId(raw, manifestId);
  return { manifest, manifestId };
}

function normalizeBodyMapManifest(raw) {
  const source = unwrapManifest(raw, BODY_MAP_SCHEMA, 'body map');
  if (!source.id) throw new TypeError('body map manifest id is required');
  if (!source.sourceRef) throw new TypeError(`body map ${source.id} sourceRef is required`);
  if (!Array.isArray(source.areas) || source.areas.length === 0) throw new TypeError(`body map ${source.id} areas must be non-empty`);
  const seen = new Set();
  const areas = source.areas.map((area, index) => {
    if (!area?.id || !area?.path) throw new TypeError(`body map ${source.id} areas[${index}] requires id and path`);
    const id = String(area.id);
    if (seen.has(id)) throw new Error(`Duplicate body area id: ${id}`);
    seen.add(id);
    const allowedCapabilities = uniqueStrings(area.allowedCapabilities ?? []);
    if (allowedCapabilities.length === 0) throw new TypeError(`body area ${id} allowedCapabilities must be non-empty`);
    const authorities = uniqueStrings(area.authorities ?? []);
    if (authorities.length === 0) throw new TypeError(`body area ${id} authorities must be non-empty`);
    return {
      id,
      path: normalizePath(area.path, `body area ${id}.path`),
      allowedCapabilities,
      authorities
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  assertJson(source.metadata ?? {}, `body map ${source.id}.metadata`);
  const manifest = {
    schema: BODY_MAP_SCHEMA,
    id: String(source.id),
    version: String(source.version ?? '0'),
    sourceRef: String(source.sourceRef),
    areas,
    metadata: cloneJson(source.metadata ?? {})
  };
  const manifestId = `body-map-manifest:sha256:${sha256(stableStringify(manifest))}`;
  verifyDeclaredManifestId(raw, manifestId);
  return { manifest, manifestId };
}

function unwrapManifest(raw, schema, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${label} manifest must be an object`);
  if (raw.manifest && raw.manifestId) {
    if (raw.manifest.schema !== schema) throw new Error(`Unsupported ${label} schema: ${raw.manifest.schema ?? '<missing>'}`);
    return raw.manifest;
  }
  if (raw.schema !== schema) throw new Error(`Unsupported ${label} schema: ${raw.schema ?? '<missing>'}`);
  return raw;
}

function verifyDeclaredManifestId(raw, actual) {
  const declared = raw?.manifestId;
  if (declared != null && String(declared) !== actual) {
    throw new Error(`Declared manifestId mismatch: ${declared} !== ${actual}`);
  }
}

function materializeCapability({ entry, snapshotId, executors, tests }) {
  const manifest = entry.manifest;
  return {
    id: manifest.id,
    version: manifest.version,
    sourceRef: manifest.sourceRef,
    descriptorRef: entry.manifestId,
    registryRef: snapshotId,
    executorRef: manifest.executorRef,
    role: manifest.role,
    pressure: manifest.pressure,
    provides: [...manifest.provides],
    dependsOn: [...manifest.dependsOn],
    targetAreas: [...manifest.targetAreas],
    authority: [...manifest.authority],
    resources: cloneJson(manifest.resources),
    inputRefs: uniqueStrings([...manifest.inputRefs, entry.manifestId, snapshotId]),
    evidenceRefs: uniqueStrings([...manifest.evidenceRefs, entry.manifestId]),
    testRefs: [...manifest.testRefs],
    tests: manifest.testRefs.map((testRef) => ({ id: testRef, test: tests.get(testRef).test })),
    priority: manifest.priority,
    work: executors.get(manifest.executorRef).work
  };
}

function dependencyClosureIds(seedIds, capabilityStore) {
  const result = new Set(seedIds.map(String));
  const queue = [...result].sort();
  while (queue.length > 0) {
    const id = queue.shift();
    const entry = capabilityStore.get(id);
    if (!entry) continue;
    for (const dependency of entry.manifest.dependsOn) {
      if (result.has(dependency)) continue;
      result.add(dependency);
      queue.push(dependency);
      queue.sort();
    }
  }
  return [...result].sort();
}

function mergeUnavailable(items) {
  const byId = new Map();
  for (const item of items) {
    const reasons = byId.get(item.id) ?? new Set();
    for (const reason of item.reasons) reasons.add(reason);
    byId.set(item.id, reasons);
  }
  return [...byId.entries()]
    .map(([id, reasons]) => ({ id, reasons: [...reasons].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizePath(path, label) {
  if (typeof path !== 'string' || path.trim() === '') throw new TypeError(`${label} must be a non-empty path`);
  const segments = path.split('.');
  for (const segment of segments) {
    if (!segment) throw new TypeError(`${label} contains an empty segment`);
    if (BLOCKED_PATH_SEGMENTS.has(segment)) throw new TypeError(`${label} contains blocked segment ${segment}`);
  }
  return segments.join('.');
}

function validateResources(resources, label) {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) throw new TypeError(`${label} must be an object`);
  for (const [key, amount] of Object.entries(resources)) {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`${label}.${key} must be finite and non-negative`);
  }
}

function assertRegistry(registry) {
  if (!(registry instanceof CapabilityRegistry)) throw new TypeError('registry must be a CapabilityRegistry');
}

function assertJson(value, label) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${label}[${index}]`));
    return;
  }
  if (type === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain plain JSON objects`);
    for (const [key, item] of Object.entries(value)) {
      if (BLOCKED_PATH_SEGMENTS.has(key)) throw new TypeError(`${label} contains blocked key ${key}`);
      assertJson(item, `${label}.${key}`);
    }
    return;
  }
  throw new TypeError(`${label} must be JSON-compatible`);
}

function cloneJson(value) {
  assertJson(value, 'value');
  return structuredClone(value);
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) throw new TypeError('Expected an array');
  return [...new Set(values.map(String))].sort();
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Cannot canonicalize non-JSON value');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function serializeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function compareReceiptItems(a, b) {
  return `${a.kind}:${a.id}:${a.manifestId}`.localeCompare(`${b.kind}:${b.id}:${b.manifestId}`);
}

function compareRejectedItems(a, b) {
  return `${a.kind}:${a.id ?? ''}:${a.reason}`.localeCompare(`${b.kind}:${b.id ?? ''}:${b.reason}`);
}
