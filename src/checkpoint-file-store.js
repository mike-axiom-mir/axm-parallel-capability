import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const CHECKPOINT_SCHEMA = 'axm.parallel-capability-checkpoint/v0.2';
const CHECKPOINT_ID_RE = /^parallel-checkpoint:sha256:([0-9a-f]{64})$/;
const STORE_RECEIPT_SCHEMA = 'axm.parallel-capability-checkpoint-store-receipt/v0.1';
const STORE_ROOT_UNSAFE = 'AXM_CHECKPOINT_STORE_ROOT_UNSAFE';
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export class LocalCheckpointFileStore {
  constructor({ root, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (typeof root !== 'string' || root.trim() === '') {
      throw new TypeError('checkpoint store root must be a non-empty path');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
      throw new TypeError('checkpoint store maxBytes must be a safe integer >= 1024');
    }
    this.root = resolve(root);
    this.maxBytes = maxBytes;
  }

  async put(checkpoint) {
    const verified = verifyCheckpointForStorage(checkpoint, { maxBytes: this.maxBytes });
    await prepareStoreRoot(this.root);
    const target = this._pathForVerified(verified);

    if (await pathExists(target)) {
      await this.get(verified.checkpointId);
      return storeReceipt({
        operation: 'PUT',
        status: 'EXISTS',
        verified,
        durability: { fileFsync: true, directoryFsync: null }
      });
    }

    const temp = join(this.root, `.${verified.hex}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    let tempExists = false;
    try {
      handle = await open(temp, 'wx', 0o600);
      tempExists = true;
      await handle.writeFile(`${verified.canonical}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;

      try {
        await link(temp, target);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await this.get(verified.checkpointId);
        return storeReceipt({
          operation: 'PUT',
          status: 'EXISTS',
          verified,
          durability: { fileFsync: true, directoryFsync: null }
        });
      }

      await rm(temp, { force: true });
      tempExists = false;
      const directoryFsync = await syncDirectory(this.root);
      return storeReceipt({
        operation: 'PUT',
        status: 'STORED',
        verified,
        durability: { fileFsync: true, directoryFsync }
      });
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (tempExists) await rm(temp, { force: true }).catch(() => {});
    }
  }

  async get(checkpointId) {
    const hex = checkpointIdHex(checkpointId);
    await assertSafeStoreRoot(this.root);
    const target = join(this.root, `${hex}.checkpoint.json`);
    const info = await lstat(target);
    if (!info.isFile()) {
      throw new Error(`Stored checkpoint target is not a regular file: ${checkpointId}`);
    }
    if (info.size > this.maxBytes) {
      throw new Error(`Stored checkpoint exceeds maxBytes: ${info.size} > ${this.maxBytes}`);
    }

    const raw = await readFile(target, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > this.maxBytes) {
      throw new Error(`Stored checkpoint exceeds maxBytes after read: ${checkpointId}`);
    }

    let checkpoint;
    try {
      checkpoint = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Stored checkpoint JSON is invalid: ${checkpointId}`, { cause: error });
    }

    const verified = verifyCheckpointForStorage(checkpoint, { maxBytes: this.maxBytes });
    if (verified.checkpointId !== checkpointId) {
      throw new Error(`Stored checkpoint identity mismatch: ${verified.checkpointId} !== ${checkpointId}`);
    }
    if (raw !== `${verified.canonical}\n`) {
      throw new Error(`Stored checkpoint is not canonical checkpoint storage bytes: ${checkpointId}`);
    }
    return checkpoint;
  }

  pathFor(checkpointId) {
    const hex = checkpointIdHex(checkpointId);
    return join(this.root, `${hex}.checkpoint.json`);
  }

  _pathForVerified(verified) {
    return join(this.root, `${verified.hex}.checkpoint.json`);
  }
}

export function verifyCheckpointForStorage(checkpoint, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
    throw new TypeError('checkpoint store maxBytes must be a safe integer >= 1024');
  }
  validatePortableJson(checkpoint, '$', new Set());
  if (checkpoint.schema !== CHECKPOINT_SCHEMA) {
    throw new Error(`Unsupported checkpoint schema for persistent storage: ${checkpoint.schema ?? '<missing>'}`);
  }

  const hex = checkpointIdHex(checkpoint.checkpointId);
  const { checkpointId, ...core } = checkpoint;
  const expectedId = `parallel-checkpoint:sha256:${sha256(stableStringify(core))}`;
  if (checkpointId !== expectedId) {
    throw new Error('Checkpoint integrity mismatch before persistent storage');
  }

  const canonical = stableStringify(checkpoint);
  const bytes = Buffer.byteLength(`${canonical}\n`, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`Checkpoint exceeds persistent storage maxBytes: ${bytes} > ${maxBytes}`);
  }

  return Object.freeze({ checkpointId, hex, schema: CHECKPOINT_SCHEMA, bytes, canonical });
}

function storeReceipt({ operation, status, verified, durability }) {
  return Object.freeze({
    schema: STORE_RECEIPT_SCHEMA,
    operation,
    status,
    checkpointId: verified.checkpointId,
    bytes: verified.bytes,
    fileName: `${verified.hex}.checkpoint.json`,
    authority: 'STORAGE_ONLY',
    durability: Object.freeze({ ...durability })
  });
}

function checkpointIdHex(checkpointId) {
  if (typeof checkpointId !== 'string') throw new TypeError('checkpointId must be a string');
  const match = CHECKPOINT_ID_RE.exec(checkpointId);
  if (!match) throw new Error('checkpointId must be parallel-checkpoint:sha256:<64 lowercase hex>');
  return match[1];
}

async function prepareStoreRoot(root) {
  try {
    await assertSafeStoreRoot(root);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await mkdir(root, { recursive: true });
  await assertSafeStoreRoot(root);
}

async function assertSafeStoreRoot(root) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) {
    throw unsafeStoreRootError(root, 'symbolic links are forbidden');
  }
  if (!info.isDirectory()) {
    throw unsafeStoreRootError(root, 'expected a directory');
  }
}

function unsafeStoreRootError(root, reason) {
  const error = new Error(`Unsafe checkpoint store root ${JSON.stringify(root)}: ${reason}`);
  error.code = STORE_ROOT_UNSAFE;
  return error;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) return false;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function validatePortableJson(value, path, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains a non-JSON value (${typeof value})`);
  }
  if (seen.has(value)) throw new TypeError(`${path} contains a circular reference`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError(`${path}[${index}] must not be a sparse array hole`);
        }
        validatePortableJson(value[index], `${path}[${index}]`, seen);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError(`${path} contains a symbol key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`);
      }
      validatePortableJson(descriptor.value, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
