const CREATION_SCHEMA = 'axm.parallel-capability-creation-cycle-receipt/v0.4';

export function buildCreationObserverModel(receipt) {
  assertRecord(receipt, 'receipt');
  if (receipt.schema !== CREATION_SCHEMA) {
    throw new Error(`Unsupported creation receipt schema: ${String(receipt.schema ?? 'missing')}`);
  }
  if (!Array.isArray(receipt.candidates)) throw new Error('receipt.candidates must be an array');

  const lanes = receipt.candidates.map((entry, index) => {
    assertRecord(entry, `receipt.candidates[${index}]`);
    const candidate = entry.candidate;
    if (candidate == null) {
      return {
        id: String(entry.taskId ?? `candidate-${index + 1}`),
        taskId: String(entry.taskId ?? ''),
        laneId: null,
        status: 'NO_CANDIDATE_RESULT',
        schedulerStatus: nullableString(entry.schedulerStatus),
        authority: [],
        evidenceRefs: [],
        tests: [],
        changes: [],
        failures: [],
        unknowns: [],
        contradictions: [],
        attention: true
      };
    }
    assertRecord(candidate, `receipt.candidates[${index}].candidate`);
    const tests = arrayOfRecords(candidate.testResults, `${candidate.id ?? index}.testResults`).map((test) => ({
      id: String(test.id ?? 'unnamed-test'),
      passed: test.passed === true,
      error: test.error == null ? null : String(test.error)
    }));
    const changes = arrayOfRecords(candidate.changes, `${candidate.id ?? index}.changes`).map((change) => ({
      path: String(change.path ?? ''),
      op: String(change.op ?? 'unknown'),
      before: change.precondition?.exists === true ? cloneJson(change.precondition.value) : undefined,
      after: change.op === 'delete' ? undefined : cloneJson(change.value)
    }));
    const failures = stringArray(candidate.failures);
    const unknowns = cloneJsonArray(candidate.unknowns);
    const contradictions = cloneJsonArray(candidate.contradictions);
    const status = String(candidate.status ?? 'UNKNOWN');
    return {
      id: String(candidate.id ?? entry.taskId ?? `candidate-${index + 1}`),
      taskId: String(entry.taskId ?? candidate.taskId ?? ''),
      laneId: candidate.laneId == null ? null : String(candidate.laneId),
      status,
      schedulerStatus: nullableString(entry.schedulerStatus),
      authority: stringArray(candidate.authority),
      evidenceRefs: stringArray(candidate.evidenceRefs),
      tests,
      changes,
      failures,
      unknowns,
      contradictions,
      attention: status !== 'COMPLETED' || failures.length > 0 || unknowns.length > 0 || contradictions.length > 0 || tests.some((test) => !test.passed)
    };
  });

  const integrationReceipt = receipt.integration?.receipt ?? null;
  const integrationCandidate = receipt.integration?.candidate ?? null;
  const integrationTests = arrayOfRecords(integrationReceipt?.testResults ?? integrationCandidate?.testResults ?? [], 'integration.testResults').map((test) => ({
    id: String(test.id ?? 'unnamed-test'),
    passed: test.passed === true,
    error: test.error == null ? null : String(test.error)
  }));
  const integrationChanges = arrayOfRecords(integrationCandidate?.changes ?? [], 'integration.changes').map((change) => ({
    path: String(change.path ?? ''),
    op: String(change.op ?? 'unknown')
  }));
  const mergePlan = receipt.bodyPlan?.mergePlan ?? null;
  const mergeDecisions = arrayOfRecords(mergePlan?.decisions ?? [], 'mergePlan.decisions').map((decision) => ({
    id: String(decision.id ?? ''),
    status: String(decision.status ?? 'UNKNOWN'),
    reasons: stringArray(decision.reasons)
  }));
  const conflicts = arrayOfRecords(mergePlan?.conflicts ?? integrationReceipt?.conflicts ?? [], 'conflicts').map((conflict) => cloneJson(conflict));
  const unresolved = cloneJsonArray(mergePlan?.unresolved ?? integrationReceipt?.unresolved ?? []);
  const protectedStatePreserved = receipt.protectedStateDrifted === false
    && typeof receipt.sourceStateHash === 'string'
    && receipt.sourceStateHash === receipt.protectedStateHashAtCompletion;
  const commitAllowed = mergePlan?.commitAllowed === true;

  const testSummary = summarizeTests([
    ...lanes.flatMap((lane) => lane.tests),
    ...integrationTests
  ]);
  const changeCount = lanes.reduce((sum, lane) => sum + lane.changes.length, 0);
  const attentionCount = lanes.filter((lane) => lane.attention).length;

  return {
    schema: CREATION_SCHEMA,
    runId: String(receipt.runId ?? ''),
    goal: String(receipt.goal ?? ''),
    status: String(receipt.status ?? 'UNKNOWN'),
    sourceStateRef: String(receipt.sourceStateRef ?? ''),
    rollbackRef: String(receipt.rollbackRef ?? ''),
    sourceStateHash: nullableString(receipt.sourceStateHash),
    protectedStateHashAtCompletion: nullableString(receipt.protectedStateHashAtCompletion),
    protectedStateDrifted: receipt.protectedStateDrifted === true,
    protectedStatePreserved,
    lanes,
    integration: {
      status: String(integrationReceipt?.status ?? integrationCandidate?.status ?? 'NO_INTEGRATION_RESULT'),
      tests: integrationTests,
      changes: integrationChanges,
      accepted: stringArray(integrationReceipt?.accepted),
      rejected: stringArray(integrationReceipt?.rejected),
      heldConflicts: stringArray(integrationReceipt?.heldConflicts)
    },
    mergeGate: {
      commitAllowed,
      label: commitAllowed ? 'READY FOR EXPLICIT COMMIT' : 'HOLD — EXPLICIT COMMIT NOT ADMITTED',
      planId: nullableString(mergePlan?.planId),
      decisions: mergeDecisions,
      conflicts,
      unresolved
    },
    summary: {
      laneCount: lanes.length,
      attentionCount,
      changeCount,
      testPassed: testSummary.passed,
      testTotal: testSummary.total,
      conflictCount: conflicts.length,
      unresolvedCount: unresolved.length
    }
  };
}

export function renderCreationObserverHtml(receipt, { title = 'Parallel Capability Run Observer' } = {}) {
  const model = buildCreationObserverModel(receipt);
  const safeModel = escapeScriptJson(JSON.stringify(model));
  const safeReceipt = escapeHtml(JSON.stringify(receipt, null, 2));
  const pageTitle = escapeHtml(title);
  const laneButtons = model.lanes.map((lane, index) => `
    <button class="lane-card${lane.attention ? ' lane-attention' : ''}" type="button" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}" data-lane-index="${index}" data-attention="${lane.attention ? 'true' : 'false'}">
      <span class="lane-order">${String(index + 1).padStart(2, '0')}</span>
      <span class="lane-name">${escapeHtml(lane.id)}</span>
      <span class="lane-status">${escapeHtml(lane.status)}</span>
      <span class="lane-count">${lane.changes.length} Δ · ${lane.tests.filter((test) => test.passed).length}/${lane.tests.length} tests</span>
    </button>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<style>
:root{color-scheme:dark;--bg:#071018;--panel:#0d1822;--panel2:#111f2b;--line:#294151;--text:#edf7fb;--muted:#8da5b4;--hot:#ffbd66;--good:#66e0ba;--bad:#ff7f83;--focus:#b7dfff;--shadow:0 18px 60px rgba(0,0,0,.28)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% -10%,#163244 0,transparent 36rem),var(--bg);color:var(--text);font:15px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:100vh}.shell{width:min(1180px,calc(100% - 28px));margin:0 auto;padding:28px 0 48px}.eyebrow,.truth{letter-spacing:.12em;text-transform:uppercase;font-size:12px}.eyebrow{color:var(--good)}h1{font:700 clamp(28px,5vw,54px)/1.02 system-ui,sans-serif;margin:8px 0 10px;max-width:850px}.goal{max-width:850px;color:#c8d8e1;font:500 clamp(16px,2vw,20px)/1.45 system-ui,sans-serif}.truth{display:inline-flex;gap:8px;align-items:center;margin-top:10px;padding:7px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:#09141c}.truth strong{color:var(--text)}.statusbar{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}.chip{border:1px solid var(--line);background:rgba(13,24,34,.9);border-radius:999px;padding:8px 11px}.chip.good{border-color:#2f7866;color:var(--good)}.chip.bad{border-color:#803f46;color:var(--bad)}.chip.hot{border-color:#826136;color:var(--hot)}.grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(290px,.7fr);gap:14px}.panel{background:linear-gradient(180deg,rgba(17,31,43,.97),rgba(10,20,29,.97));border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}.panel-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-end;padding:17px 18px;border-bottom:1px solid var(--line)}.panel h2{font:700 18px/1.2 system-ui,sans-serif;margin:0}.panel-sub{color:var(--muted);font-size:12px}.filters{display:flex;gap:6px;flex-wrap:wrap}.filters button,.tab-button{font:inherit;color:var(--muted);background:#07121a;border:1px solid var(--line);border-radius:10px;padding:7px 9px;cursor:pointer}.filters button[aria-pressed=true],.tab-button[aria-selected=true]{color:var(--text);border-color:#53778b;background:#122936}.lane-rail{display:grid;gap:8px;padding:14px}.lane-card{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:4px 10px;text-align:left;align-items:center;width:100%;padding:12px 13px;color:var(--text);background:#0a151e;border:1px solid var(--line);border-radius:13px;cursor:pointer}.lane-card[aria-selected=true]{background:#132936;border-color:#6d9cb5;box-shadow:inset 3px 0 var(--focus)}.lane-card.lane-attention{border-color:#6e5636}.lane-order{grid-row:1/3;color:#647d8c}.lane-name{font-weight:700}.lane-status{font-size:12px;color:var(--good)}.lane-attention .lane-status{color:var(--hot)}.lane-count{grid-column:2/4;color:var(--muted);font-size:12px}.lane-card[hidden]{display:none}.detail{padding:18px}.detail h3{font:700 22px/1.2 system-ui,sans-serif;margin:0 0 4px}.detail-meta{color:var(--muted);margin-bottom:18px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.metric{padding:11px;border:1px solid var(--line);border-radius:12px;background:#0a151e}.metric b{display:block;font-size:12px;color:var(--muted);font-weight:500;margin-bottom:4px}.section{margin-top:16px}.section h4{font:700 13px/1.2 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:#9fb6c3;margin:0 0 8px}.rows{display:grid;gap:6px}.row{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:10px;background:#08131b;border:1px solid #1e3442}.row span:first-child{min-width:0;overflow-wrap:anywhere}.pass{color:var(--good)}.fail{color:var(--bad)}.muted{color:var(--muted)}.gate{padding:18px}.gate-state{font:800 clamp(20px,3vw,34px)/1.05 system-ui,sans-serif;margin:6px 0 12px}.gate-state.ready{color:var(--good)}.gate-state.hold{color:var(--hot)}.protected{padding:12px;border-radius:12px;border:1px solid #2b6658;background:#0d211d;color:var(--good)}.protected.drift{border-color:#7c3b43;background:#281418;color:var(--bad)}.hash{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.tabbar{display:flex;gap:6px;padding:12px 14px 0}.tab-panel{padding:14px 18px 18px}.tab-panel[hidden]{display:none}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;margin:0;padding:12px;border-radius:12px;background:#061018;border:1px solid #1f3441;color:#bcd0da;font-size:11px}.footer{margin:18px 2px;color:var(--muted);font-size:12px}.kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;padding:1px 5px;color:#d9e8ef;background:#0a151e}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
button:focus-visible{outline:3px solid var(--focus);outline-offset:3px}@media(max-width:800px){.shell{width:min(100% - 18px,1180px);padding-top:18px}.grid{grid-template-columns:1fr}.panel-head{align-items:flex-start;flex-direction:column}.detail-grid{grid-template-columns:1fr}.lane-card{grid-template-columns:32px minmax(0,1fr)}.lane-status{grid-column:2}.lane-count{grid-column:2}.gate{padding:15px}}@media(prefers-reduced-motion:no-preference){.lane-card{transition:transform .12s ease,border-color .12s ease,background-color .12s ease}.lane-card:hover{transform:translateY(-1px)}}
</style>
</head>
<body>
<main class="shell">
  <div class="eyebrow">AXM · Parallel Capability Fabric · Read-only realization</div>
  <h1>${pageTitle}</h1>
  <p class="goal">${escapeHtml(model.goal || 'No goal recorded')}</p>
  <div class="truth"><strong>DISPLAY ≠ AUTHORITY</strong><span>receipt projection only · no merge action exists here</span></div>
  <div class="statusbar" aria-label="Run summary">
    <span class="chip ${statusTone(model.status)}">${escapeHtml(model.status)}</span>
    <span class="chip">${model.summary.laneCount} lanes</span>
    <span class="chip">${model.summary.changeCount} proposed Δ</span>
    <span class="chip">${model.summary.testPassed}/${model.summary.testTotal} tests passed</span>
    <span class="chip ${model.summary.conflictCount || model.summary.unresolvedCount ? 'hot' : 'good'}">${model.summary.conflictCount} conflicts · ${model.summary.unresolvedCount} unresolved</span>
  </div>
  <section class="grid">
    <article class="panel">
      <div class="panel-head"><div><h2>Candidate lanes</h2><div class="panel-sub">Arrow keys move inspection focus. Filtering never changes receipt truth.</div></div><div class="filters" aria-label="Lane filters"><button type="button" data-filter="all" aria-pressed="true">All</button><button type="button" data-filter="attention" aria-pressed="false">Needs attention</button><button type="button" data-filter="clear" aria-pressed="false">Clear</button></div></div>
      <div class="lane-rail" role="tablist" aria-label="Creation candidates">${laneButtons}</div>
      <div class="detail" id="lane-detail" role="tabpanel" aria-live="polite"></div>
    </article>
    <aside class="panel">
      <div class="panel-head"><div><h2>Protected-body gate</h2><div class="panel-sub">Planning evidence only. Explicit commit remains separate.</div></div></div>
      <div class="gate">
        <div class="protected ${model.protectedStatePreserved ? '' : 'drift'}"><strong>${model.protectedStatePreserved ? 'PROTECTED BODY PRESERVED' : 'PROTECTED BODY DRIFT / UNKNOWN'}</strong><br><span class="hash">source ${escapeHtml(model.sourceStateHash ?? 'unknown')}<br>completion ${escapeHtml(model.protectedStateHashAtCompletion ?? 'unknown')}</span></div>
        <div class="gate-state ${model.mergeGate.commitAllowed ? 'ready' : 'hold'}">${escapeHtml(model.mergeGate.label)}</div>
        <p class="muted">${model.mergeGate.commitAllowed ? 'Predicates admit a separate explicit commit call. This observer cannot perform it.' : 'Current receipt does not admit a protected-body commit.'}</p>
        <div class="detail-grid"><div class="metric"><b>Integration</b>${escapeHtml(model.integration.status)}</div><div class="metric"><b>Plan</b><span class="hash">${escapeHtml(model.mergeGate.planId ?? 'none')}</span></div><div class="metric"><b>Accepted</b>${model.integration.accepted.length}</div><div class="metric"><b>Held conflicts</b>${model.integration.heldConflicts.length}</div></div>
      </div>
      <div class="tabbar" role="tablist" aria-label="Evidence views"><button class="tab-button" type="button" role="tab" data-tab="merge" aria-selected="true">Merge evidence</button><button class="tab-button" type="button" role="tab" data-tab="raw" aria-selected="false">Raw receipt</button></div>
      <div class="tab-panel" data-panel="merge"><div id="merge-evidence"></div></div>
      <div class="tab-panel" data-panel="raw" hidden><pre>${safeReceipt}</pre></div>
    </aside>
  </section>
  <p class="footer">Input loop: select a lane → inspect tests / evidence / deltas → inspect integration + protected-body gate → decide the next human action. <span class="kbd">←</span> <span class="kbd">→</span> <span class="kbd">Home</span> <span class="kbd">End</span></p>
  <output id="observer-status" class="sr-only" aria-live="polite"></output>
</main>
<script id="observer-model" type="application/json">${safeModel}</script>
<script>
(() => {
  const model = JSON.parse(document.getElementById('observer-model').textContent);
  const buttons = [...document.querySelectorAll('.lane-card')];
  const detail = document.getElementById('lane-detail');
  const status = document.getElementById('observer-status');
  let activeIndex = 0;
  let filter = 'all';
  const esc = (value) => String(value ?? '').replace(/[&<>\"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
  const pretty = (value) => esc(typeof value === 'string' ? value : JSON.stringify(value));
  const visibleIndexes = () => buttons.map((button, index) => button.hidden ? null : index).filter((index) => index != null);
  const renderRows = (items, empty, render) => items.length ? '<div class="rows">' + items.map(render).join('') + '</div>' : '<div class="muted">' + esc(empty) + '</div>';
  function renderLane(index, announce = true) {
    activeIndex = index;
    buttons.forEach((button, buttonIndex) => { const selected = buttonIndex === index; button.setAttribute('aria-selected', selected ? 'true' : 'false'); button.tabIndex = selected ? 0 : -1; });
    const lane = model.lanes[index];
    if (!lane) { detail.innerHTML = '<div class="muted">No visible lane.</div>'; return; }
    const testRows = renderRows(lane.tests, 'No lane tests recorded.', (test) => '<div class="row"><span>' + esc(test.id) + '</span><strong class="' + (test.passed ? 'pass' : 'fail') + '">' + (test.passed ? 'PASS' : 'FAIL') + '</strong></div>');
    const changeRows = renderRows(lane.changes, 'No state delta proposed.', (change) => '<div class="row"><span>' + esc(change.path || '(root)') + '</span><strong>' + esc(change.op.toUpperCase()) + '</strong></div>');
    const evidenceRows = renderRows(lane.evidenceRefs, 'No evidence refs recorded.', (ref) => '<div class="row"><span>' + esc(ref) + '</span><strong>REF</strong></div>');
    const attention = [...lane.failures, ...lane.unknowns, ...lane.contradictions];
    const attentionRows = renderRows(attention, 'No failures, unknowns, or contradictions recorded.', (item) => '<div class="row"><span>' + pretty(item) + '</span><strong class="fail">ATTN</strong></div>');
    detail.innerHTML = '<h3>' + esc(lane.id) + '</h3><div class="detail-meta">' + esc(lane.taskId) + (lane.laneId ? ' · ' + esc(lane.laneId) : '') + '</div><div class="detail-grid"><div class="metric"><b>Candidate status</b>' + esc(lane.status) + '</div><div class="metric"><b>Scheduler status</b>' + esc(lane.schedulerStatus || 'unknown') + '</div><div class="metric"><b>Authority</b>' + esc(lane.authority.join(' · ') || 'none recorded') + '</div><div class="metric"><b>Evidence</b>' + lane.evidenceRefs.length + ' refs</div></div><div class="section"><h4>Proposed state delta</h4>' + changeRows + '</div><div class="section"><h4>Tests</h4>' + testRows + '</div><div class="section"><h4>Evidence refs</h4>' + evidenceRows + '</div><div class="section"><h4>Failures / unknowns / contradictions</h4>' + attentionRows + '</div>';
    if (announce) status.value = 'Inspecting lane ' + lane.id + ', status ' + lane.status;
  }
  function applyFilter(next) {
    filter = next;
    document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', button.dataset.filter === filter ? 'true' : 'false'));
    buttons.forEach((button, index) => { const lane = model.lanes[index]; button.hidden = filter === 'attention' ? !lane.attention : filter === 'clear' ? lane.attention : false; });
    const visible = visibleIndexes();
    const nextIndex = visible.includes(activeIndex) ? activeIndex : visible[0];
    if (nextIndex == null) detail.innerHTML = '<div class="muted">No lanes match this filter.</div>'; else renderLane(nextIndex, false);
    status.value = filter + ' lane filter, ' + visible.length + ' visible';
  }
  buttons.forEach((button, index) => button.addEventListener('click', () => renderLane(index)));
  document.querySelector('.lane-rail').addEventListener('keydown', (event) => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    const visible = visibleIndexes(); if (!visible.length) return; event.preventDefault();
    let position = Math.max(0, visible.indexOf(activeIndex));
    if (event.key === 'Home') position = 0; else if (event.key === 'End') position = visible.length - 1; else position = (position + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + visible.length) % visible.length;
    const next = visible[position]; renderLane(next); buttons[next].focus();
  });
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => applyFilter(button.dataset.filter)));
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { const name = button.dataset.tab; document.querySelectorAll('[data-tab]').forEach((item) => item.setAttribute('aria-selected', item === button ? 'true' : 'false')); document.querySelectorAll('[data-panel]').forEach((panel) => panel.hidden = panel.dataset.panel !== name); }));
  const decisionRows = model.mergeGate.decisions.length ? model.mergeGate.decisions.map((decision) => '<div class="row"><span>' + esc(decision.id) + '</span><strong>' + esc(decision.status) + '</strong></div>').join('') : '<div class="muted">No body-plan decisions recorded.</div>';
  document.getElementById('merge-evidence').innerHTML = '<div class="section"><h4>Body-plan decisions</h4><div class="rows">' + decisionRows + '</div></div><div class="section"><h4>Conflicts / unresolved</h4><div class="metric">' + model.mergeGate.conflicts.length + ' conflict records · ' + model.mergeGate.unresolved.length + ' unresolved records</div></div>';
  if (buttons.length) renderLane(0, false);
  window.__AXM_OBSERVER__ = { get activeLaneId(){ return model.lanes[activeIndex]?.id ?? null; }, get filter(){ return filter; }, model };
})();
</script>
</body>
</html>`;
}

function summarizeTests(tests) {
  return { total: tests.length, passed: tests.filter((test) => test.passed).length };
}

function statusTone(status) {
  if (status === 'READY_FOR_EXPLICIT_COMMIT') return 'good';
  if (String(status).includes('FAIL') || String(status).includes('CANCEL')) return 'bad';
  return 'hot';
}

function arrayOfRecords(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    assertRecord(item, `${label}[${index}]`);
    return item;
  });
}

function assertRecord(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function stringArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return [String(value)];
  return value.map(String);
}

function cloneJsonArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return [cloneJson(value)];
  return value.map(cloneJson);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function nullableString(value) {
  return value == null ? null : String(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeScriptJson(value) {
  return String(value).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
