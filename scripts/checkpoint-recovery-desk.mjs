#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalCheckpointFileStore } from '../src/checkpoint-file-store.js';
import { buildCheckpointRecoveryModel, renderCheckpointRecoveryDesk } from '../experience/checkpoint-recovery-desk.js';

const args = parseArgs(process.argv.slice(2));
if (!args.store || !args.id) {
  process.stderr.write('Usage: node scripts/checkpoint-recovery-desk.mjs --store <directory> --id <parallel-checkpoint:sha256:...> [--out checkpoint-recovery.html]\n');
  process.exitCode = 2;
} else {
  const store = new LocalCheckpointFileStore({ root: args.store });
  const checkpoint = await store.get(args.id);
  const model = buildCheckpointRecoveryModel(checkpoint);
  const html = renderCheckpointRecoveryDesk(model);
  const output = resolve(args.out ?? 'checkpoint-recovery.html');
  await writeFile(output, html, 'utf8');
  process.stdout.write(`${JSON.stringify({ output, checkpointId: model.checkpointId, retainedTasks: model.completedCount, attentionTasks: model.attentionCount, authority: model.authority })}\n`);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--store', '--id', '--out'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${key}`);
    result[key.slice(2)] = argv[++i];
  }
  return result;
}
