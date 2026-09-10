import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { LocalCheckpointFileStore } from '../src/checkpoint-file-store.js';

const execFileAsync = promisify(execFile);
const artifactDir = resolve(process.env.AXM_EXPERIENCE_ARTIFACT_DIR ?? 'artifacts/checkpoint-recovery-experience');
await mkdir(artifactDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'axm-checkpoint-recovery-browser-'));

try {
  const checkpoint = makeCheckpoint();
  const store = new LocalCheckpointFileStore({ root });
  await store.put(checkpoint);
  const output = join(root, 'recovery.html');
  await execFileAsync(process.execPath, [
    'scripts/checkpoint-recovery-desk.mjs', '--store', root, '--id', checkpoint.checkpointId, '--out', output
  ], { cwd: process.cwd() });
  const html = await readFile(output, 'utf8');

  const browser = await chromium.launch({ headless: true });
  const observations = { pageErrors: [], consoleErrors: [] };
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    observe(desktop, observations);
    await desktop.setContent(html, { waitUntil: 'load' });
    await requireTruth(desktop, checkpoint.checkpointId);
    if (await desktop.locator('.task').count() !== 3) throw new Error('expected three retained task cards');
    await desktop.screenshot({ path: join(artifactDir, 'checkpoint-recovery-desktop.png'), fullPage: true });

    await desktop.locator('[data-filter="attention"]').click();
    if (await desktop.locator('.task:not([hidden])').count() !== 1) throw new Error('attention filter did not isolate the one attention task');
    if (await desktop.locator('#visibleCount').innerText() !== '1 shown') throw new Error('attention filter count did not update');
    await desktop.keyboard.press('Tab');

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    observe(mobile, observations);
    await mobile.setContent(html, { waitUntil: 'load' });
    await requireTruth(mobile, checkpoint.checkpointId);
    await mobile.locator('[data-filter="attention"]').click();
    await mobile.waitForTimeout(1600);
    const metrics = await mobile.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      minTarget: Math.min(...[...document.querySelectorAll('button')].map((button) => button.getBoundingClientRect().height)),
      shown: [...document.querySelectorAll('.task')].filter((card) => !card.hidden).length
    }));
    if (metrics.scrollWidth !== metrics.innerWidth) throw new Error(`mobile horizontal overflow: ${JSON.stringify(metrics)}`);
    if (metrics.minTarget < 44) throw new Error(`interactive target below 44px: ${metrics.minTarget}`);
    if (metrics.shown !== 1) throw new Error(`mobile attention filter showed ${metrics.shown} cards`);
    await mobile.screenshot({ path: join(artifactDir, 'checkpoint-recovery-mobile-attention.png'), fullPage: true });

    if (observations.pageErrors.length || observations.consoleErrors.length) {
      throw new Error(`browser errors observed: ${JSON.stringify(observations)}`);
    }
    const receipt = {
      schema: 'axm.parallel-capability-checkpoint-recovery-experience-receipt/v0.1',
      checkpointId: checkpoint.checkpointId,
      exactStoreAdmission: true,
      desktop: { width: 1440, retainedCards: 3, attentionFilterShown: 1 },
      mobile: metrics,
      pageErrors: 0,
      consoleErrors: 0,
      authority: 'DISPLAY_ONLY',
      commit: process.env.GITHUB_SHA ?? null
    };
    await writeFile(join(artifactDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await browser.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function requireTruth(page, checkpointId) {
  const body = await page.locator('body').innerText();
  for (const required of ['LOCAL / OFFLINE', 'EXACT ID ONLY', 'DISPLAY ≠ RESUME AUTHORITY', 'EXACT ID REQUIRED', checkpointId]) {
    if (!body.includes(required)) throw new Error(`missing rendered truth: ${required}`);
  }
}

function observe(page, observations) {
  page.on('pageerror', (error) => observations.pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') observations.consoleErrors.push(message.text()); });
}

function makeCheckpoint() {
  const core = {
    schema: 'axm.parallel-capability-checkpoint/v0.2',
    runId: 'browser-recovery-run',
    stateRef: 'state:browser-v1',
    checkpointRef: 'commit:browser-v1',
    specFingerprint: 'browser-fixture-fingerprint',
    createdAt: '2026-09-10T06:10:00.000Z',
    completed: [
      task('scan', 'lane-scan', 'fixture.scan'),
      task('render', 'lane-render', 'fixture.render', { unknowns: ['physical touch not tested'], proposedChanges: [{ path: 'experience/view' }] }),
      task('verify', 'lane-verify', 'fixture.verify', { testResults: [{ status: 'PASS' }, { status: 'PASS' }] })
    ]
  };
  return { ...core, checkpointId: `parallel-checkpoint:sha256:${createHash('sha256').update(stableStringify(core)).digest('hex')}` };
}

function task(taskId, laneId, capabilityId, overrides = {}) {
  return {
    taskId,
    state: 'COMPLETED',
    output: { privateFixture: `not-rendered:${taskId}` },
    receipt: {
      runId: 'browser-recovery-run', laneId, taskId, capabilityId, stateRef: 'state:browser-v1',
      evidenceRefs: [`evidence:${taskId}`], testResults: [{ status: 'PASS' }], proposedChanges: [],
      assumptions: [], unknowns: [], contradictions: [], failures: [], ...overrides
    }
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
