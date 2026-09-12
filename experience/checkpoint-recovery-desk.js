const CHECKPOINT_SCHEMA = 'axm.parallel-capability-checkpoint/v0.2';
const CHECKPOINT_ID_RE = /^parallel-checkpoint:sha256:[0-9a-f]{64}$/;

export function buildCheckpointRecoveryModel(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new TypeError('checkpoint must be an object admitted by LocalCheckpointFileStore');
  }
  if (checkpoint.schema !== CHECKPOINT_SCHEMA) {
    throw new Error(`Unsupported checkpoint schema: ${checkpoint.schema ?? '<missing>'}`);
  }
  if (!CHECKPOINT_ID_RE.test(checkpoint.checkpointId ?? '')) {
    throw new Error('checkpointId must be parallel-checkpoint:sha256:<64 lowercase hex>');
  }
  if (!Array.isArray(checkpoint.completed)) {
    throw new TypeError('checkpoint.completed must be an array');
  }

  const tasks = checkpoint.completed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`checkpoint.completed[${index}] must be an object`);
    }
    const receipt = item.receipt && typeof item.receipt === 'object' && !Array.isArray(item.receipt)
      ? item.receipt
      : {};
    const attention = [];
    const failures = arrayOf(receipt.failures);
    const contradictions = arrayOf(receipt.contradictions);
    const unknowns = arrayOf(receipt.unknowns);
    const assumptions = arrayOf(receipt.assumptions);
    if (failures.length) attention.push(`${failures.length} failure${failures.length === 1 ? '' : 's'}`);
    if (contradictions.length) attention.push(`${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'}`);
    if (unknowns.length) attention.push(`${unknowns.length} unknown${unknowns.length === 1 ? '' : 's'}`);
    if (assumptions.length) attention.push(`${assumptions.length} assumption${assumptions.length === 1 ? '' : 's'}`);

    return Object.freeze({
      taskId: text(item.taskId, `task-${index + 1}`),
      laneId: text(receipt.laneId, 'lane not recorded'),
      capabilityId: text(receipt.capabilityId, 'capability not recorded'),
      state: text(item.state, 'UNKNOWN'),
      evidenceCount: arrayOf(receipt.evidenceRefs).length,
      testCount: arrayOf(receipt.testResults).length,
      proposedChangeCount: arrayOf(receipt.proposedChanges).length,
      attention,
      needsAttention: attention.length > 0
    });
  });

  const stateCounts = {};
  for (const task of tasks) stateCounts[task.state] = (stateCounts[task.state] ?? 0) + 1;
  const attentionCount = tasks.filter((task) => task.needsAttention).length;
  const checkpointRef = checkpoint.checkpointRef == null ? null : String(checkpoint.checkpointRef);

  return Object.freeze({
    schema: 'axm.parallel-capability-checkpoint-recovery-view/v0.1',
    sourceSchema: checkpoint.schema,
    checkpointId: checkpoint.checkpointId,
    runId: text(checkpoint.runId, 'run not recorded'),
    stateRef: text(checkpoint.stateRef, 'state not recorded'),
    checkpointRef,
    specFingerprint: text(checkpoint.specFingerprint, 'fingerprint not recorded'),
    createdAt: text(checkpoint.createdAt, 'time not recorded'),
    completedCount: tasks.length,
    attentionCount,
    stateCounts: Object.freeze(stateCounts),
    tasks: Object.freeze(tasks),
    resumeGuidance: checkpointRef
      ? 'Use this exact checkpoint ID only with a matching run specification and checkpointRef. The scheduler must revalidate it before reuse.'
      : 'Do not resume from this checkpoint. Rerun with an explicit checkpointRef so execution semantics are named before reuse.',
    resumeState: checkpointRef ? 'EXACT ID REQUIRED' : 'RERUN REQUIRED',
    authority: 'DISPLAY_ONLY'
  });
}

export function renderCheckpointRecoveryDesk(model, { title = 'Parallel Capability · Checkpoint Recovery Desk' } = {}) {
  if (!model || model.schema !== 'axm.parallel-capability-checkpoint-recovery-view/v0.1') {
    throw new Error('renderCheckpointRecoveryDesk requires a recovery view model');
  }
  const taskJson = JSON.stringify(model.tasks).replace(/</g, '\u003c');
  const stateSummary = Object.entries(model.stateCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, count]) => `<span class="state-chip"><b>${escapeHtml(state)}</b><span>${count}</span></span>`)
    .join('');
  const taskCards = model.tasks.map((task, index) => renderTaskCard(task, index)).join('');
  const resumeTone = model.checkpointRef ? 'ready' : 'hold';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#090c10;--panel:#101720;--panel2:#151f2b;--line:#2b3948;--text:#f4f7fb;--muted:#9eacba;--accent:#8ee4ff;--warm:#ffd17a;--good:#93f5ba;--danger:#ff9a9a;--radius:18px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:radial-gradient(circle at 20% 0,#172330 0,#090c10 44%,#07090c 100%);color:var(--text)}body{padding:clamp(14px,2vw,28px)}button{font:inherit;color:inherit}.shell{max-width:1180px;margin:0 auto}.topline{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.eyebrow{font-size:.75rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}h1{font-size:clamp(1.9rem,4.5vw,3.8rem);line-height:.96;margin:.45rem 0 .65rem;max-width:14ch}.truth{display:flex;gap:8px;flex-wrap:wrap}.truth span,.state-chip{border:1px solid var(--line);background:#0c1219;border-radius:999px;padding:7px 10px;font-size:.72rem;font-weight:750;letter-spacing:.06em}.truth .hard{border-color:#45677a;color:var(--accent)}.lead{max-width:72ch;color:var(--muted);font-size:1rem;line-height:1.5}.grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:16px;margin-top:20px}.panel{background:linear-gradient(180deg,rgba(21,31,43,.94),rgba(13,19,27,.96));border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 18px 60px rgba(0,0,0,.25);padding:18px}.kicker{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:800}.idline{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;margin-top:8px}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;font-size:.83rem;color:#d9e5ee}.copy{min-height:44px;border:1px solid #3f6273;background:#112431;border-radius:12px;padding:0 14px;font-weight:800;cursor:pointer}.copy:hover,.copy:focus-visible{border-color:var(--accent);outline:3px solid rgba(142,228,255,.18);outline-offset:2px}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}.meta div{padding:12px;border:1px solid var(--line);border-radius:12px;background:#0b1118}.meta dt{font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:800}.meta dd{margin:5px 0 0;font-size:.88rem;overflow-wrap:anywhere}.states{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.state-chip{display:flex;gap:8px;align-items:center}.state-chip span{color:var(--muted)}.decision{border-left:3px solid var(--accent)}.decision.hold{border-left-color:var(--warm)}.decision strong{display:block;margin:6px 0;font-size:1.25rem}.decision p{color:var(--muted);line-height:1.45;margin:0}.controls{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:18px 0 10px}.filter{min-height:44px;border:1px solid var(--line);background:#0b1118;border-radius:12px;padding:0 14px;font-weight:750;cursor:pointer}.filter[aria-pressed="true"]{border-color:var(--accent);background:#112633;color:var(--accent)}.filter:focus-visible{outline:3px solid rgba(142,228,255,.18);outline-offset:2px}.count{margin-left:auto;color:var(--muted);font-size:.8rem}.tasks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.task{border:1px solid var(--line);background:#0b1118;border-radius:14px;padding:13px;min-width:0}.task.attention{border-color:#715f3f}.task .row{display:flex;justify-content:space-between;gap:8px}.task h3{font-size:.96rem;margin:0;overflow-wrap:anywhere}.task .state{font-size:.68rem;font-weight:850;letter-spacing:.08em;color:var(--good);white-space:nowrap}.task.attention .state{color:var(--warm)}.task .sub{color:var(--muted);font-size:.76rem;margin-top:5px;overflow-wrap:anywhere}.metrics{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.metrics span{font-size:.68rem;border:1px solid #263545;border-radius:8px;padding:5px 7px;color:#c4d0da}.attention-line{margin-top:9px;color:var(--warm);font-size:.75rem}.footer{margin:18px 0 4px;color:var(--muted);font-size:.78rem;line-height:1.45}.flash{position:fixed;left:50%;bottom:18px;transform:translate(-50%,12px);opacity:0;pointer-events:none;background:#142633;border:1px solid #45677a;border-radius:12px;padding:10px 14px;font-size:.82rem;transition:.18s ease}.flash.show{opacity:1;transform:translate(-50%,0)}
@media(max-width:720px){body{padding:12px}.grid{grid-template-columns:1fr}.tasks{grid-template-columns:1fr}.meta{grid-template-columns:1fr}.idline{grid-template-columns:1fr}.copy{width:100%}.count{width:100%;margin-left:0}.panel{padding:15px}h1{font-size:2.25rem}.lead{font-size:.92rem}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
@media(prefers-contrast:more){:root{--line:#6d8193;--muted:#c8d2dc}.panel,.task,.meta div{border-width:2px}}
</style>
</head>
<body>
<main class="shell">
<div class="topline"><div class="eyebrow">Checkpoint Recovery Desk · v0.1</div><div class="truth" aria-label="Truth boundaries"><span>LOCAL / OFFLINE</span><span>EXACT ID ONLY</span><span class="hard">DISPLAY ≠ RESUME AUTHORITY</span></div></div>
<h1>Resume evidence you can actually read.</h1>
<p class="lead">This view was generated only after the local checkpoint store admitted the exact content-addressed checkpoint. It explains the retained work; it does not choose a checkpoint, resume a run, or weaken scheduler revalidation.</p>
<section class="grid" aria-label="Checkpoint summary">
<div class="panel">
<div class="kicker">Exact checkpoint identity</div>
<div class="idline"><div class="mono" id="checkpointId">${escapeHtml(model.checkpointId)}</div><button class="copy" id="copyId" type="button">COPY EXACT ID</button></div>
<dl class="meta"><div><dt>Run</dt><dd>${escapeHtml(model.runId)}</dd></div><div><dt>State reference</dt><dd>${escapeHtml(model.stateRef)}</dd></div><div><dt>Checkpoint reference</dt><dd>${escapeHtml(model.checkpointRef ?? 'NOT RECORDED')}</dd></div><div><dt>Created</dt><dd>${escapeHtml(model.createdAt)}</dd></div></dl>
<div class="states" aria-label="Retained task states">${stateSummary || '<span class="state-chip"><b>NO RETAINED TASKS</b><span>0</span></span>'}</div>
</div>
<div class="panel decision ${resumeTone}"><div class="kicker">Next explicit action</div><strong>${escapeHtml(model.resumeState)}</strong><p>${escapeHtml(model.resumeGuidance)}</p><div class="footer">Storage admission proves deterministic local checkpoint bytes under the file-store contract. It is not authorship, matching-run proof, or permission to apply state.</div></div>
</section>
<section class="panel" style="margin-top:16px" aria-labelledby="retainedTitle">
<div class="topline"><div><div class="kicker">Retained work</div><h2 id="retainedTitle" style="margin:.25rem 0 0">${model.completedCount} checkpointed task${model.completedCount===1?'':'s'}</h2></div><div class="kicker">${model.attentionCount} need attention</div></div>
<div class="controls" role="group" aria-label="Task filter"><button type="button" class="filter" data-filter="all" aria-pressed="true">ALL RETAINED</button><button type="button" class="filter" data-filter="attention" aria-pressed="false">ATTENTION ONLY</button><span class="count" id="visibleCount" aria-live="polite">${model.completedCount} shown</span></div>
<div class="tasks" id="taskList">${taskCards}</div>
</section>
<p class="footer">Canonical scheduler state is not modified by this page. No network, cloud, account, model, merge, promotion, or CANON authority is used.</p>
</main>
<div class="flash" id="flash" role="status" aria-live="polite"></div>
<script type="application/json" id="taskData">${taskJson}</script>
<script>
(()=>{const tasks=JSON.parse(document.getElementById('taskData').textContent);const buttons=[...document.querySelectorAll('[data-filter]')];const cards=[...document.querySelectorAll('.task')];const count=document.getElementById('visibleCount');const flash=document.getElementById('flash');let timer;function announce(message){flash.textContent=message;flash.classList.add('show');clearTimeout(timer);timer=setTimeout(()=>flash.classList.remove('show'),1400)}function apply(mode){let shown=0;cards.forEach((card,index)=>{const visible=mode==='all'||tasks[index].needsAttention;card.hidden=!visible;if(visible)shown++});buttons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.filter===mode)));count.textContent=shown+' shown';announce(mode==='attention'?'Showing tasks that retain assumptions, unknowns, contradictions, or failures.':'Showing all retained tasks.')}buttons.forEach(button=>button.addEventListener('click',()=>apply(button.dataset.filter)));document.getElementById('copyId').addEventListener('click',async()=>{const value=document.getElementById('checkpointId').textContent;try{await navigator.clipboard.writeText(value);announce('Exact checkpoint ID copied.')}catch{announce('Clipboard unavailable. Select the exact ID above manually.')}});})();
</script>
</body>
</html>`;
}

function renderTaskCard(task, index) {
  const attentionText = task.attention.length ? task.attention.join(' · ') : 'No retained attention flags';
  return `<article class="task${task.needsAttention ? ' attention' : ''}" data-task-index="${index}"><div class="row"><h3>${escapeHtml(task.taskId)}</h3><span class="state">${escapeHtml(task.state)}</span></div><div class="sub">${escapeHtml(task.laneId)} · ${escapeHtml(task.capabilityId)}</div><div class="metrics"><span>${task.evidenceCount} evidence</span><span>${task.testCount} tests</span><span>${task.proposedChangeCount} proposed changes</span></div><div class="attention-line">${escapeHtml(attentionText)}</div></article>`;
}

function arrayOf(value) { return Array.isArray(value) ? value : []; }
function text(value, fallback) { return typeof value === 'string' && value.trim() ? value : fallback; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[ch]); }
