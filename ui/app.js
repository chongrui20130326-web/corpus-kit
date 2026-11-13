function renderAdvice(data) {
  // 新版：基于人物卡与场景分析
  if (Array.isArray(data.人物一致性)) {
    const consistency = data.人物一致性.map((item) => `
      <div class="row"><span class="kv">${esc(item.人物)}</span>${esc(item.怎么写)}<div class="muted" style="font-size:11px;margin-top:2px">依据：${esc(item.依据)}</div></div>`).join('');
    const bridge = (data.场景衔接 || []).map((item) => `<div class="row"><span class="kv">接续</span>${esc(item.怎么过渡)}</div>`).join('');
    const chain = (data.动作链骨架 || []).map((item, index) => `<span class="chip">${index + 1}. ${esc(item)}</span>`).join('');
    const nodes = (data.描写节点 || []).map((node) => `<div class="row"><span class="kv">[${esc(node.位置)}]</span>${esc(node.写什么)}　<span class="kv">${esc(node.技法)}</span></div>`).join('');
    const lines = (data.可用台词 || []).map((item) => `<div class="row"><span class="kv">${esc(item.人物)}</span>「${esc(item.台词)}」</div>`).join('');
    const avoid = (data.应避免 || []).map((item) => `<span class="chip">${esc(item)}</span>`).join('');
    const refs = (data.参考依据 || []).map((item) => `<div class="row"><span class="kv">${esc(item.场次)}</span>${esc(item.为什么 || '')}</div>`).join('');
    const meta = data.数据 ? `<div class="muted" style="font-size:11px;margin-bottom:8px">依据：场景 ${esc(data.数据.场景 || '—')}　人物 ${esc((data.数据.人物 || []).join('、'))}</div>` : '';

    return `
      ${meta}
      <h4>人物一致性</h4>${consistency || '<div class="row">—</div>'}
      <h4>场景衔接</h4>${bridge || '<div class="row">—</div>'}
      <h4>动作链骨架</h4><div class="chips">${chain}</div>
      <h4>描写节点</h4>${nodes || '<div class="row">—</div>'}
      <h4>可用台词</h4>${lines || '<div class="row">—</div>'}
      <h4>应避免</h4><div class="chips">${avoid}</div>
      ${refs ? `<h4>参考依据</h4>${refs}` : ''}`;
  }

  const info = data.情境判断 || {};
  const track = data.推荐轨迹 || {};
  const dims = data.拆解 || {};
  const links = Array.isArray(data.动作链骨架) ? data.动作链骨架.join(' → ') : (data.动作链骨架 || '');
  const nodes = (data.描写节点 || []).map((node) => `<div class="row"><span class="kv">[${esc(node.位置)}]</span>${esc(node.写什么)}　<span class="kv">${esc(node.技法)}</span></div>`).join('');
  const refs = (data.参考 || []).map((item) => `<div class="row"><span class="kv">《${esc(item.book)}》${esc(item.sceneId)}</span>${esc(item.为什么像 || item.summary || '')}</div>`).join('');
  const avoid = (data.应避免 || []).map((item) => `<span class="chip">${esc(item)}</span>`).join('');

  return `
    <h4>大纲拆解</h4>
    <div class="row"><span class="kv">环境</span>${esc(dims.环境?.地点 || '—')} / ${esc(dims.环境?.时间 || '—')} / ${esc(dims.环境?.私密性 || '—')}</div>
    <div class="row"><span class="kv">类型</span>${esc((dims.性爱类型 || []).join('、') || '—')}　<span class="kv">强度</span>${esc(String(dims.强度 ?? '—'))}/5</div>
    <h4>情境</h4>
    <div class="row"><span class="kv">阶段</span>${esc(info.阶段 || '—')}<span class="kv" style="margin-left:14px">权力</span>${esc(info.权力 || '—')}</div>
    <div class="row"><span class="kv">关系</span>${esc(info.关系 || '—')}</div>
    <div class="row"><span class="kv">状态</span>${esc(info.人物状态 || '—')}</div>
    <h4>推荐轨迹</h4>
    <div class="row">${esc(track.起点 || '—')} → ${esc(track.终点 || '—')}</div>
    <h4>动作链骨架</h4><div class="chips">${links}</div>
    <h4>描写节点</h4>${nodes || '<div class="row">—</div>'}
    <h4>应避免</h4><div class="chips">${avoid}</div>
    ${refs ? `<h4>参考场景</h4>${refs}` : ''}`;
}

const state = {
  books: [],
  book: null,
  selected: null,
  page: 0,
  view: 'pipeline',
  filters: { character: '', arcType: '', stage: '', power: '', sceneStage: '', direction: '', erotic: '', near: false, onlyTraj: false, eventsOnly: false, q: '' },
  eventMap: new Map(),
  characters: new Map(),
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pollers = new Map();
const fingerprints = new Map();
const SOURCE_BY_VIEW = {
  scenedetail: 'gen-scene-details.mjs',
  scenesview: 'segment-scenes-llm.mjs',
  cardboard: 'build-character-cards.mjs',
  dialog: 'build-dialogue-table.mjs',
  dirty: 'build-dirty-talk.mjs',
  appear: 'build-appearance-table.mjs',
  erotic: 'build-erotic-table.mjs',
  clean: 'clean-book.mjs',
};


function stepNameOf(prompt) {
  const p = String(prompt || '');
  if (p.includes('请为这一场写一份') || p.includes('本场提要')) return '本场提要';
  if (p.includes('只比对') || p.includes('疑问')) return '疑问';
  if (p.includes('按动作逐步拆解')) return '情节经过';
  if (p.includes('只在本场人物之间建立关系') || p.includes('抽取本场人物之间')) return '人物关系';
  if (p.includes('梳理本场出场角色')) return '出场人物';
  return '其他调用';
}

function updateCacheBadge(cacheN, promptN) {
  const el = $('cacheBadge');
  if (!el) return;
  const hit = Number(cacheN) || 0;
  const rest = Number(promptN) || 0;
  const total = hit + rest;
  if (!total) { el.textContent = '缓存 —'; return; }
  const pct = Math.round((hit / total) * 100);
  el.textContent = '缓存命中 ' + pct + '%（' + hit + '/' + total + '）';
  el.className = 'cache-badge' + (pct >= 50 ? ' good' : pct > 0 ? ' mid' : '');
}

function updateBottomConsole(state) {
  if (!state) return;
  if ($('tcbMax')) $('tcbMax').textContent = state.called && state.lastMaxTokens ? ('max ' + state.lastMaxTokens) : 'max —';
  if ($('tcbCache')) {
    const hit = Number(state.lastCacheN) || 0;
    const rest = Number(state.lastPromptN) || 0;
    const total = hit + rest;
    if (!state.called || !total) { $('tcbCache').textContent = '缓存 —'; }
    else {
      const pct = Math.round((hit / total) * 100);
      $('tcbCache').textContent = '缓存 ' + pct + '%（' + hit + '/' + total + '）';
      $('tcbCache').style.color = pct >= 50 ? '#1a7f37' : pct > 0 ? '#9a6700' : '';
    }
  }
  if (typeof updateCacheBadge === 'function') updateCacheBadge(state.lastCacheN, state.lastPromptN);
}

async function pollBottomConsole() {
  const state = await fetch('/api/console/state').then((r) => r.json()).catch(() => null);
  if (state) updateBottomConsole(state);
}
function startPoll(key, fn, ms = 4000) {
  if (pollers.has(key)) return;
  const poller = { fn, busy: false, timer: null };
  const tick = async () => {
    if (document.visibilityState === 'hidden' || poller.busy || pollers.get(key) !== poller) return;
    poller.busy = true;
    try { await fn(); } finally { poller.busy = false; }
  };
  poller.tick = tick;
  pollers.set(key, poller);
  poller.timer = setInterval(tick, ms);
  tick();
}
function stopPoll(key) {
  const poller = pollers.get(key);
  if (poller) { clearInterval(poller.timer); pollers.delete(key); }
}
function dataChanged(key, data) {
  const next = JSON.stringify(data);
  if (fingerprints.get(key) === next) return false;
  fingerprints.set(key, next);
  return true;
}
setInterval(pollBottomConsole, 5000);
pollBottomConsole();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') for (const poller of pollers.values()) poller.tick();
});

const STAGE_COLORS = ['#007aff', '#af52de', '#ff9500', '#34c759', '#ff375f', '#5e5ce6', '#0a84ff', '#bf5af2'];

function colorForStage(name) {
  const index = Math.max(0, (state.book?.stages || []).findIndex((stage) => stage.名称 === name));
  return STAGE_COLORS[index % STAGE_COLORS.length];
}

/* ------------------------------ 续写顾问 ------------------------------ */

function setupAdvice() {
  const modal = $('adviceModal');
  const run = $('adviceRun');
  const status = $('adviceStatus');
  const result = $('adviceResult');

  $('adviseBtn').onclick = () => {
    modal.hidden = false;
    const scene = state.book?.scenes?.find((item) => item.sceneId === state.selected);
    const sceneInput = $('adviceScene');
    const peopleInput = $('advicePeople');
    if (sceneInput && !sceneInput.value && state.selected) sceneInput.value = state.selected;
    if (peopleInput && !peopleInput.value && scene) peopleInput.value = (scene.参与者 || []).join('、');
    $('adviceOutline').focus();
  };
  $('adviceClose').onclick = () => { modal.hidden = true; };

  run.onclick = async () => {
    const outline = $('adviceOutline').value.trim();
    if (!outline) { status.textContent = '先写大纲'; return; }
    run.disabled = true;
    status.textContent = '检索语料并生成中（约 30 秒）…';
    result.innerHTML = '';
    try {
      const response = await fetch('/api/advise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work: $('book').value,
          outline,
          characters: $('adviceChars')?.value?.trim() || '',
          sceneId: $('adviceScene')?.value?.trim() || '',
          people: $('advicePeople')?.value?.trim() || '',
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成失败');
      state.advice = data;
      state.outline = outline;
      status.textContent = '完成';
      result.innerHTML = renderAdvice(data);
      const adopt = $('adviceAdopt');
      if (adopt) adopt.onclick = () => adoptAdvice();
    } catch (error) {
      status.textContent = `失败：${error.message}`;
    } finally {
      run.disabled = false;
    }
  };
}

async function adoptAdvice() {
  const status = $('adviceStatus');
  const prose = $('adviceProse');
  if (!state.advice) return;
  $('adviceAdopt').disabled = true;
  status.textContent = '按建议写正文中（约 1 分钟）…';
  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work: $('book').value,
        outline: state.outline,
        advice: state.advice,
        characters: $('adviceChars').value.trim(),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '生成失败');
    status.textContent = '正文已生成';
    prose.hidden = false;
    prose.innerHTML = `<h4>生成的正文</h4><div class="prose">${esc(data.text)}</div>`;
  } catch (error) {
    status.textContent = `失败：${error.message}`;
  } finally {
    $('adviceAdopt').disabled = false;
  }
}

function renderCoverage(title, report) {
  const p = report.段落;
  const tone = report.ok ? 'ok' : 'bad';
  const chapterRows = report.章
    .filter((chapter) => !chapter.ok)
    .map((chapter) => `<div class="row"><span class="kv">第 ${chapter.index} 章</span>${chapter.covered}/${chapter.total} 段 ${esc(chapter.title || '')}</div>`)
    .join('') || '<div class="row muted">全部章节完整</div>';

  const missing = p.未覆盖.slice(0, 30).map((item) => `<span class="chip">${esc(item.id)}·${item.字数}字</span>`).join('');

  return `
    <div class="cov-head">
      <strong>${esc(title)}</strong>
      <span class="cov-badge ${tone}">${report.ok ? '✓ 原文全部进入分析' : '✗ 有原文未分析'}</span>
      <button id="libBack" class="ghost" style="margin-left:auto">返回</button>
    </div>
    <div class="cov-grid">
      <div><div class="cov-num">${p.覆盖率}%</div><div class="cov-label">段落覆盖 ${p.已覆盖}/${p.总数}</div></div>
      <div><div class="cov-num">${report.字数.覆盖率}%</div><div class="cov-label">字数覆盖 ${report.字数.已覆盖}/${report.字数.总数}</div></div>
      <div><div class="cov-num">${report.场景.总数}</div><div class="cov-label">场景</div></div>
      <div><div class="cov-num">${report.衔接.断档 + report.衔接.重叠}</div><div class="cov-label">衔接问题（断档 ${report.衔接.断档} / 重叠 ${report.衔接.重叠}）</div></div>
    </div>
    <h4>产物缺口</h4>
    <div class="row"><span class="kv">缺分析</span>${report.场景.缺分析.length} 场　<span class="kv">缺摘要</span>${report.场景.缺摘要.length} 场　<span class="kv">缺句子层</span>${report.场景.缺句子层.length} 场</div>
    <h4>章节</h4>
    ${chapterRows}
    ${p.未覆盖数 ? `<h4>未进入场景的段落（${p.未覆盖数}）</h4><div class="tag-list">${missing}</div>` : ''}
  `;
}

/** 书籍工程的历史日志：列出这本书跑过的每次对话/运行。 */
async function openLogs(id, title) {
  const list = $('libraryList');
  list.innerHTML = '<div class="empty" style="padding:20px">读取日志…</div>';
  const data = await fetch(`/api/logs?work=${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => null);
  if (!data?.files?.length) {
    list.innerHTML = `<div class="cov-head"><strong>${esc(title)} · 日志</strong><button id="libBack" class="ghost" style="margin-left:auto">返回</button></div><div class="empty" style="padding:20px">这本书还没有日志</div>`;
    $('libBack').onclick = openLibrary;
    return;
  }

  list.innerHTML = `
    <div class="cov-head">
      <strong>${esc(title)} · 日志</strong>
      <span class="cov-badge">${data.files.length} 份</span>
      <button id="libBack" class="ghost" style="margin-left:auto">返回</button>
    </div>
    ${data.files.map((file) => `
      <div class="log-row" data-file="${esc(file.name)}">
        <span class="sess-tag ${file.kind === '对话' ? 'req' : ''}">${esc(file.kind)}</span>
        <span class="log-name">${esc(file.name)}</span>
        <span class="log-meta">${file.lines} 条 · ${(file.size / 1024).toFixed(1)} KB · ${new Date(file.at).toLocaleString('zh-CN')}</span>
      </div>`).join('')}
  `;

  $('libBack').onclick = openLibrary;
  for (const row of list.querySelectorAll('[data-file]')) {
    row.onclick = () => viewLog(id, title, row.dataset.file);
  }
}

async function viewLog(id, title, file) {
  const list = $('libraryList');
  list.innerHTML = '<div class="empty" style="padding:20px">读取中…</div>';
  const data = await fetch(`/api/logs?work=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`).then((r) => r.json()).catch(() => null);
  if (!data?.entries) {
    list.innerHTML = `<div class="empty" style="padding:20px">${esc(data?.error || '读取失败')}</div>`;
    return;
  }

  const isSession = file.startsWith('session-');
  const body = isSession
    ? `<div class="session-list" style="max-height:62vh">${data.entries.map(renderSessionMessage).join('')}</div>`
    : `<div class="session-list" style="max-height:62vh">${data.entries.map((entry) => `
        <div class="sess"><div class="sess-head"><span class="sess-tag">#${esc(String(entry.at || '').slice(11, 19))}</span>
        ${entry.step ? `<span class="sess-tag">${esc(entry.step)}</span>` : ''}
        ${entry.target ? `<span>${esc(entry.target)}</span>` : ''}
        ${entry.status ? `<span>${esc(entry.status)}</span>` : ''}</div>
        <div class="sess-body">${esc(JSON.stringify(entry.raw ?? entry, null, 1))}</div></div>`).join('')}</div>`;

  list.innerHTML = `
    <div class="cov-head">
      <strong>${esc(title)}</strong>
      <span class="sess-tag ${isSession ? 'req' : ''}">${esc(file)}</span>
      <span class="modal-status">${data.entries.length} 条</span>
      <button id="libBack" class="ghost" style="margin-left:auto">返回</button>
    </div>
    ${body}
  `;
  $('libBack').onclick = () => openLogs(id, title);
}

/** 书籍工程的进度描述与按钮文案。 */
function analyzeLine(book) {
  const state = book.analyze || {};
  if (!state.hasProject) return '<span class="warn">工程未建立，需要重新导入</span>';
  const parts = [`已分析 ${state.done}/${state.total}`];
  if (state.failed) parts.push(`<span class="warn">失败 ${state.failed}</span>`);
  if (!state.hasBriefs && state.done === 0) parts.push('待建简述');

  return parts.join(' · ');
}

function analyzeButtonText(book) {
  const state = book.analyze || {};
  if (!state.hasProject) return '重新导入';
  if (state.done === 0) return '开始分析';
  if (state.pending > 0) return '继续分析';
  return '重新分析';
}

async function startAnalyze(id, mode) {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ work: id, mode, model: $('importModel')?.value || '' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { alert(data.error || '启动失败'); return; }
  showProgress({ title: id, message: '逐场分析中…', percent: 1 });
  pollJobs();
}

/* ------------------------------ 人物卡 ------------------------------ */


/* ───────── 工作流水线 ───────── */

const PIPELINE_STATE_LABEL = { idle: '未开始', partial: '未完成', running: '进行中', done: '完成', failed: '失败' };

function toast(message, warn = false) {
  const old = document.querySelector('.pipeline-toast');
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'pipeline-toast' + (warn ? ' warn' : '');
  box.textContent = message;
  document.body.appendChild(box);
  setTimeout(() => box.remove(), warn ? 6000 : 3200);
}


async function loadGatewayModels() {
  if ($('pcPause')) $('pcPause').onclick = () => pipelineControl('pause');
  if ($('pcResume')) $('pcResume').onclick = () => pipelineControl('resume');
  if ($('pcStop')) $('pcStop').onclick = () => pipelineControl('stop');
  const select = $('pipeModel');
  if (!select) return;
  const saved = localStorage.getItem('corpus.pipeline.model') || '';  // 只有手动切换过才有值
  try {
    const response = await fetch('/api/gateway/models');
    const data = await response.json();
    const models = data.models || [];
    if (!models.length) {
      select.innerHTML = `<option value="">（读不到网关模型）</option>`;
      return;
    }
    if (data.note) select.title = data.note;
    select.innerHTML = models.map((id) => `<option value="${esc(id)}">${esc(id)}${id === 'qwen3.5:9b-uncensored-q8_0_64K' ? '（默认）' : ''}</option>`).join('');
    // 默认 9B；只有用户手动选过别的模型才用记忆值
    const DEFAULT_MODEL = 'qwen3.5:9b-uncensored-q8_0_64K';
    const preferred = saved && models.includes(saved) ? saved : (models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]);
    select.value = preferred;
  } catch (error) {
    select.innerHTML = `<option value="">（网关未连接）</option>`;
  }
}

async function pipelineControl(action) {
  const book = $('book')?.value;
  if (!book) return;
  const labels = { pause: '暂停', resume: '启动', stop: '停止' };
  try {
    const response = await fetch('/api/pipeline/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book, action }),
    });
    const data = await response.json();
    toast(data.message || data.error || (labels[action] + '已提交'));
    // 启动：直接重启被暂停的那一步
    if (action === 'resume' && data.resumeStep) {
      const model = $('pipeModel')?.value || '';
      const run = await fetch('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book, step: data.resumeStep, model }),
      }).then((r) => r.json()).catch(() => ({}));
      toast(run.started ? ('已继续：' + data.resumeStep) : (run.error || '启动失败'));
    }
    await loadWorkflow();
  } catch (error) {
    toast('操作失败：' + error.message);
  }
}

function renderPipelineBanner(steps) {
  const running = steps.filter((step) => step.status === 'running');
  const box = $('pipelineRunning');
  if (!box) return;
  if (!running.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = running.map((step) => {
    const seconds = step.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(step.startedAt)) / 1000)) : 0;
    const time = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
    return `<span class="run-chip">▶ ${esc(step.label)}　已跑 ${time}${step.total > 1 ? `　${step.done}/${step.total}` : ''}</span>`;
  }).join('');
}

function renderPipeline(data) {
  const groups = new Map();
  for (const step of data.steps) {
    if (!groups.has(step.group)) groups.set(step.group, []);
    groups.get(step.group).push(step);
  }

  const doneCount = data.steps.filter((step) => step.status === 'done').length;
  $('pipelineSub').textContent = `已完成 ${doneCount} / ${data.steps.length} 步　·　点击节点开始分析`;

  renderPipelineBanner(data.steps);
  reportStepResults(data.steps);
  requestAnimationFrame(() => drawPipelineArrows(data.steps));
  renderCurrentTask(data.steps, data.paused, data.externalRunning, data.externalStep, data.lastActivity, data.externalCount, data.externalCountTotal, data.modelBusy);

  $('pipelineGroups').innerHTML = [...groups.entries()].map(([group, steps]) => `
    <div class="pg-group">
      <div class="pg-title">${esc(group)}<span class="pg-count">${steps.filter((step) => step.status === 'done').length}/${steps.length}</span></div>
      <div class="pg-nodes">
        ${steps.map((step) => `
          <div class="pg-node ${step.status}" data-step="${esc(step.id)}" title="${esc(step.label)}">
            <div class="pg-name"><span class="pg-no">#${step.order}</span>${esc(step.label)}</div>
            <div class="pg-meta">${PIPELINE_STATE_LABEL[step.status] || step.status}${step.total > 1 ? `　${step.done}/${step.total}` : ''}</div>
            <div class="pg-bar"><i style="width:${step.percent}%"></i></div>
            ${step.error ? `<div class="pg-err">${esc(step.error)}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`).join('');

  for (const node of $('pipelineGroups').querySelectorAll('[data-step]')) {
    node.onclick = () => runPipelineStep(node.dataset.step, data);
  }
}

async function runPipelineStep(stepId, data) {
  const step = data.steps.find((item) => item.id === stepId);
  if (!step) return;
  if (step.status === 'running') { toast('这一步正在跑，等它结束', true); return; }

  const missing = step.deps
    .map((dep) => data.steps.find((item) => item.id === dep))
    .filter((dep) => dep && dep.status !== 'done');
  if (missing.length) {
    toast(`无法开始：需要先完成 ${missing.map((dep) => dep.label).join('、')}`, true);
    return;
  }

  const book = $('book')?.value || '';
  const node = document.querySelector(`.pg-node[data-step="${stepId}"]`);
  if (node) { node.classList.remove('idle', 'partial', 'done', 'failed'); node.classList.add('running'); const meta = node.querySelector('.pg-meta'); if (meta) meta.textContent = '正在启动…'; }
  toast(`已开始：${step.label}`);
  try {
    const response = await fetch('/api/pipeline/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book, step: stepId, model: $('pipeModel')?.value || '' }),
    });
    const result = await response.json();
    if (result.error) { toast(result.error, true); return; }
    setTimeout(() => { if (typeof loadWorkflow === 'function') loadWorkflow(); }, 1200);
  } catch (error) {
    toast('启动失败：' + error.message, true);
  }
}


const numberState = { file: null, numbered: '', busy: false };
let numberDoc = null;

function setupNumbering() {
  if (setupNumbering.done) return;
  setupNumbering.done = true;

  document.querySelectorAll('#numberFileInput').forEach((el) => el.remove());
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md';
  input.id = 'numberFileInput';
  input.style.display = 'none';
  document.body.appendChild(input);

  const log = (text) => { const box = $('numberLog'); if (box) box.textContent = text; };

  // 从书库打开已有书籍的编号结构
  (async () => {
    const list = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('numberBookSel');
    if (sel) sel.innerHTML = (list || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
  })();

  $('numberOpenBook').addEventListener('click', async () => {
    const id = $('numberBookSel')?.value;
    if (!id) return;
    $('numberLog').textContent = '读取 ' + id + ' …';
    const data = await fetch('/api/book/numbered?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => ({}));
    if (!data.chapters) { $('numberLog').textContent = data.error || '读取失败'; return; }
    $('numberFile').textContent = id;
    $('numberImport').disabled = false;
    numberState.numbered = '';
    numberDoc = data;
    $('numberLog').textContent = ['已打开：' + (data.bookName || id), '章 ' + data.chapters.length + ' · 段 ' + data.paragraphs.length + ' · 句 ' + data.sentences.length].join('\n');
    renderNumberView(data);
  });

  $('numberPick').addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    numberState.file = file;
    numberState.numbered = '';
    $('numberFile').textContent = file.name;
    $('numberRun').disabled = false;
    $('numberImport').disabled = true;
    log('已选择：' + file.name);
  });

  $('numberRun').addEventListener('click', async () => {
    if (!numberState.file || numberState.busy) return;
    numberState.busy = true;
    $('numberRun').disabled = true;
    log('编号中…');
    try {
      const content = await numberState.file.text();
      const examples = [];
      const response = await fetch('/api/number/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: numberState.file.name, content, examples }),
      });
      const data = await response.json().catch(() => ({}));
      if (!data.ok) { log('失败：' + (data.error || '未知错误')); return; }
      numberState.numbered = data.numbered;
      $('numberImport').disabled = false;
      const ratio = data.coverage ? (data.coverage.ratio * 100).toFixed(2) + '%' : '—';
      log([
        '章 ' + data.chapters + ' · 段 ' + data.paragraphs + ' · 句 ' + data.sentences,
        '原文覆盖率 ' + ratio,
        (data.warnings && data.warnings.length) ? '⚠ ' + data.warnings.join('\n⚠ ') : '✓ 未发现遗漏或重复',
      ].join('\n'));
      numberDoc = data.doc;
      renderNumberView(data.doc);
    } catch (error) {
      log('失败：' + error.message);
    } finally {
      numberState.busy = false;
      $('numberRun').disabled = false;
    }
  });

  $('numberImport').addEventListener('click', async () => {
    if (!numberState.numbered || numberState.busy) return;
    numberState.busy = true;
    $('numberImport').disabled = true;
    log('导入中…');
    try {
      const response = await fetch('/api/number/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numbered: numberState.numbered, title: (numberDoc && numberDoc.bookName) || '' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!data.ok) { log('导入失败：' + (data.error || '未知错误')); return; }
      log(['已导入：' + data.work, '', ...(data.log || [])].join('\n'));
      await refreshBooks();
    } catch (error) {
      log('导入失败：' + error.message);
    } finally {
      numberState.busy = false;
      $('numberImport').disabled = false;
    }
  });
}

async function showSentenceMentions(node) {
  const sId = node.dataset.s;
  const no = Number(String(sId).replace(/^S/, ""));
  const book = $("book")?.value;
  if (!book) return;
  let box = node.nextElementSibling;
  if (!box || !box.classList.contains("nt-mbox")) {
    box = document.createElement("div");
    box.className = "nt-mbox";
    node.after(box);
  }
  if (box.dataset.open === "1") { box.dataset.open = "0"; box.innerHTML = ""; box.hidden = true; return; }
  box.dataset.open = "1";
  box.hidden = false;
  box.innerHTML = "<div class=\"nt-mtext\">加载中…</div>";
  const d = await fetch("/api/mention/sentence?id=" + encodeURIComponent(book) + "&s=" + no).then((r) => r.json()).catch(() => null);
  if (!d) { box.innerHTML = "<div class=\"nt-mtext\">读取失败</div>"; return; }
  if (d.missing) { box.innerHTML = "<div class=\"nt-mtext\">这本书没有代词编号表（需要重新导入编号）</div>"; return; }
  const text = String(d.text || "");
  const chips = (d.mentions || []).map((m) => '<button class="nt-mchip" data-off="' + m.offset + '" data-len="' + String(m.text).length + '">' + esc(m.id) + " · " + esc(m.text) + "</button>").join("");
  const paint = (offset, len) => {
    if (!text) return "";
    if (offset < 0) return esc(text);
    return esc(text.slice(0, offset)) + '<mark class="nt-mmark">' + esc(text.slice(offset, offset + len)) + "</mark>" + esc(text.slice(offset + len));
  };
  box.innerHTML = '<div class="nt-mchips">' + (chips || '<span class="ch-meta">本句没有代词</span>') + '</div><div class="nt-mtext" id="ntmText">' + paint(-1, 0) + "</div>";
  box.querySelectorAll(".nt-mchip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const off = Number(chip.dataset.off);
      const len = Number(chip.dataset.len);
      const target = box.querySelector("#ntmText");
      if (target) target.innerHTML = paint(off, len);
      box.querySelectorAll(".nt-mchip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
    });
  });
}
function renderNumberView(doc) {
  if (!doc) return;
  const sentenceMap = new Map((doc.sentences || []).map((s) => [s.id, s]));
  const paragraphMap = new Map((doc.paragraphs || []).map((p) => [p.id, p]));
  let chapters = doc.chapters || [];
  // 没有识别到章节时，整篇作为一章显示，避免一片空白
  if (!chapters.length) {
    chapters = [{ id: 'C1', title: doc.bookName || '全文', paragraphs: (doc.paragraphs || []).map((p) => p.id) }];
    if (doc.sentences && doc.sentences.length && !(doc.paragraphs || []).length) {
      chapters[0].paragraphs = [];
    }
  }

  // ── 左侧：折叠树，默认只显示章节 ──
  const tree = [];
  for (const chapter of chapters) {
    tree.push(`<div class="nt-ch" data-ch="${chapter.id}"><span class="nt-caret">▸</span>${chapter.id} · ${esc(chapter.title)}</div>`);
    tree.push(`<div class="nt-group" data-group="${chapter.id}" hidden></div>`);
  }
  $('numberTree').innerHTML = tree.join('') || '<div class="number-empty">没有结构</div>';

  // 章节 → 段落（点击时才生成）
  const renderParagraphs = (chapterId) => {
    const chapter = chapters.find((c) => c.id === chapterId);
    if (!chapter) return '';
    return (chapter.paragraphs || []).map((pid) => {
      const para = paragraphMap.get(pid);
      if (!para) return '';
      const preview = previewOfParagraph(para, sentenceMap);
      return `<div class="nt-p" data-p="${pid}" data-ch="${chapterId}" title="${esc(preview)}"><span class="nt-tip">ⓘ</span>${pid} · ${para.chars} 字</div>`
        + `<div class="nt-group" data-group="${pid}" hidden></div>`;
    }).join('');
  };

  const renderSentences = (paragraphId) => {
    const para = paragraphMap.get(paragraphId);
    if (!para) return '';
    const from = Number(para.from.slice(1));
    const to = Number(para.to.slice(1));
    const rows = [];
    for (let i = from; i <= to; i += 1) {
      const sentence = sentenceMap.get('S' + i);
      if (!sentence) continue;
      const preview = sentence.text.length > 24 ? sentence.text.slice(0, 24) + '…' : sentence.text;
      rows.push(`<div class="nt-s" data-s="S${i}" title="${esc(preview)}"><span class="nt-tip">ⓘ</span>S${i}</div>`);
    }
    return rows.join('');
  };

  $('numberTree').onclick = (event) => {
    const node = event.target.closest('.nt-ch, .nt-p, .nt-s');
    if (!node) return;

    // 章节：展开段落
    if (node.classList.contains('nt-ch')) {
      const group = $('numberTree').querySelector(`[data-group="${node.dataset.ch}"]`);
      if (!group) return;
      if (!group.innerHTML) group.innerHTML = renderParagraphs(node.dataset.ch);
      group.hidden = !group.hidden;
      node.querySelector('.nt-caret').textContent = group.hidden ? '▸' : '▾';
      // 跳到该章起始处
      const anchor = document.getElementById('jump-' + node.dataset.ch);
      if (anchor) {
        anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('numberContent').querySelectorAll('.nb-ch.active').forEach((el) => el.classList.remove('active'));
        anchor.classList.add('active');
      }
      return;
    }

    // 段落：展开句子 + 高亮段落
    if (node.classList.contains('nt-p')) {
      const group = $('numberTree').querySelector(`[data-group="${node.dataset.p}"]`);
      if (group) {
        if (!group.innerHTML) group.innerHTML = renderSentences(node.dataset.p);
        group.hidden = !group.hidden;
      }
      highlightRange(node.dataset.p, null);
      return;
    }

    // 句子：高亮句子
    if (node.classList.contains('nt-s')) {
      showSentenceMentions(node);
    }
    if (node.classList.contains('nt-s')) {
      highlightRange(null, node.dataset.s);
    }
  };

  // ── 右侧：带编号正文 ──
  const view = [];
  for (const chapter of chapters) {
    view.push(`<div class="nb-ch" id="jump-${chapter.id}">${chapter.id} · ${esc(chapter.title)}</div>`);
    for (const pid of chapter.paragraphs || []) {
      const para = paragraphMap.get(pid);
      if (!para) continue;
      const from = Number(para.from.slice(1));
      const to = Number(para.to.slice(1));
      const parts = [];
      for (let i = from; i <= to; i += 1) {
        const sentence = sentenceMap.get('S' + i);
        if (!sentence) continue;
        parts.push(`<span class="nb-s" id="jump-S${i}"><span class="nb-id">S${i}</span>${esc(sentence.text)}</span>`);
      }
      view.push(`<div class="nb-p" id="jump-${para.id}">${parts.join('')}</div>`);
    }
  }
  $('numberContent').innerHTML = view.join('') || '<div class="number-empty">没有内容</div>';

  function highlightRange(paragraphId, sentenceId) {
    $('numberContent').querySelectorAll('.nb-p.hl, .nb-s.hl').forEach((el) => el.classList.remove('hl'));
    $('numberTree').querySelectorAll('.active').forEach((el) => el.classList.remove('active'));
    if (sentenceId) {
      const target = document.getElementById('jump-' + sentenceId);
      if (target) { target.classList.add('hl'); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      const node = $('numberTree').querySelector(`[data-s="${sentenceId}"]`);
      if (node) node.classList.add('active');
      return;
    }
    if (paragraphId) {
      const target = document.getElementById('jump-' + paragraphId);
      if (target) { target.classList.add('hl'); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      const node = $('numberTree').querySelector(`[data-p="${paragraphId}"]`);
      if (node) node.classList.add('active');
    }
  }
}

function previewOfParagraph(para, sentenceMap) {
  const from = Number(para.from.slice(1));
  const to = Math.min(Number(para.to.slice(1)), from + 2);
  const parts = [];
  for (let i = from; i <= to; i += 1) {
    const sentence = sentenceMap.get('S' + i);
    if (sentence) parts.push(sentence.text);
  }
  const text = parts.join('');
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

function setupClean() {
  if (setupClean.done) return;
  setupClean.done = true;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md';
  input.id = 'cleanFileInput';
  input.style.display = 'none';
  document.body.appendChild(input);

  let fileText = '';
  let fileName = '';
  let cleaned = '';
  let cleanDoc = null;

  const status = (text) => { $('cleanStatus').textContent = text; };

  $('cleanPick').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    fileName = file.name;
    fileText = await file.text();
    $('cleanFileName').textContent = file.name + '（' + fileText.length + ' 字）';
    // 书名自动带出：去掉扩展名和常见的清洗/日期后缀
    const defaultTitle = file.name
      .replace(/\.[^.]+$/, '')
      .replace(/[_\-\s]*(清洗后|清洗|校对|整理|副本)[_\-\s]*\d{6,8}$/, '')
      .replace(/[_\-\s]*\d{8}$/, '')
      .trim();
    if (!$('cleanBookName').value.trim()) $('cleanBookName').value = defaultTitle;
    $('cleanRun').disabled = false;
    status('已选择：' + file.name);
  });


  $('cleanRun').addEventListener('click', async () => {
    if (!fileText) return;
    $('cleanRun').disabled = true;
    status('清洗中…');
    try {
      const response = await fetch('/api/clean/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName || '未命名.txt', content: fileText, ai: $('cleanAi').checked, bookName: $('cleanBookName').value.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!data.ok) { status('失败：' + (data.error || '未知错误')); return; }
      cleaned = data.structuredText || data.text || '';
      cleanDoc = data.cleanDoc || null;
      const s = data.summary?.stats || data.summary || {};
      const doc = data.cleanDoc || {};
      $('cleanBookNameOut').textContent = doc['书名'] || data.bookName || '—';
      const toc = doc['目录'] || [];
      $('cleanTocOut').textContent = toc.length ? toc.join('\n') : '（没有识别到章节）';
      $('cleanTocCount').textContent = toc.length ? '(' + toc.length + ' 章)' : '';
      $('cleanBodyOut').textContent = String(doc['正文'] || cleaned || '').slice(0, 40000) || '（空）';
      $('cleanBodyCount').textContent = doc['正文'] ? '(' + doc['正文'].length + ' 字)' : '';
      $('cleanStats').textContent = [
        '字数 ' + (s.charsBefore ?? '?') + ' → ' + (s.charsAfter ?? '?') + '（删 ' + (s.removedChars ?? 0) + '）',
        '段落 ' + (s.paragraphsIn ?? '?') + ' → ' + (s.paragraphsOut ?? '?'),
        '章 ' + (s.chapters ?? 0),
        '规则修复 ' + (s.ruleApplied ?? 0) + ' 处，模型复核 ' + (s.aiApplied ?? 0) + ' 处',
        '问题 ' + (data.issueCount ?? 0) + ' 条',
        '章节 ' + (data.chapterCount ?? 0) + ' 个（已生成目录与正文结构）',
      ].join('\n');
      const issues = (data.issues || []).slice(0, 40).map((item) => {
        const title = item.title || item.label || item.kind || '问题';
        const detail = item.detail || item.message || '';
        return '<div class="clean-issue"><strong>' + esc(String(title)) + '</strong> ' + esc(String(detail).slice(0, 80)) + '</div>';
      }).join('');
      const chapterWarn = (data.chapterWarnings || []).map((w) => '<div class="clean-issue clean-warn"><strong>章节</strong> ' + esc(w) + '</div>').join('');
      $('cleanIssues').innerHTML = chapterWarn + (issues || '<div>没有发现问题</div>');
      $('cleanNumber').disabled = false;
      status('清洗完成 · ' + (data.issueCount ?? 0) + ' 条问题（左侧前 4 万字预览）');
    } catch (error) {
      status('失败：' + error.message);
    } finally {
      $('cleanRun').disabled = false;
    }
  });

  $('cleanNumber').addEventListener('click', async () => {
    if (!cleaned) return;
    const bookTitleInput = ($('cleanBookName')?.value || '').trim();
    if (!bookTitleInput) { status('请先填写书名（将成为书库中的书籍名）'); return; }
    status('送去编号…');
    try {
      const response = await fetch('/api/number/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: bookTitleInput + '.txt', content: cleaned, cleanDoc: cleanDoc ? { ...cleanDoc, '书名': bookTitleInput } : null }),
      });
      const data = await response.json().catch(() => ({}));
      if (!data.ok) { status('编号失败：' + (data.error || '未知错误')); return; }
      switchView('number');
      numberState.numbered = data.numbered;
      $('numberFile').textContent = '清洗结果';
      $('numberImport').disabled = false;
      const ratio = data.coverage ? (data.coverage.ratio * 100).toFixed(2) + '%' : '—';
      $('numberLog').textContent = [
        '来自清洗结果',
        '章 ' + data.chapters + ' · 段 ' + data.paragraphs + ' · 句 ' + data.sentences,
        '原文覆盖率 ' + ratio,
        (data.warnings && data.warnings.length) ? '⚠ ' + data.warnings.join('\n⚠ ') : '✓ 未发现遗漏或重复',
      ].join('\n');
      renderNumberView(data.doc);
      // 编号完直接导入书库
      status('已编号，正在加入书库…');
      const imp = await fetch('/api/number/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numbered: data.numbered, title: (cleanDoc && cleanDoc['书名']) || (data.doc && data.doc.bookName) || '' }),
      }).then((r) => r.json()).catch(() => ({}));
      if (imp.ok) {
        status('已更新书籍：' + (imp.work || '').split(/[\\/]/).pop());
        await refreshBooks(imp.work ? (imp.work.split(/[\\/]/).pop()) : null);
      } else {
        status('编号成功，但更新书籍失败：' + (imp.error || '未知错误'));
      }
    } catch (error) {
      status('编号失败：' + error.message);
    }
  });
}




function setupCharacters() {
  if (setupCharacters.done) return;
  setupCharacters.done = true;
  (async () => {
    const list = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('chBookSel');
    if (sel) sel.innerHTML = (list || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    if (state.view === 'characters') loadCharacters();
  })();
  $('chReload').addEventListener('click', () => loadCharacters());
  $('chBookSel').addEventListener('change', () => {
    fingerprints.delete('characters:' + $('chBookSel').value);
    fingerprints.delete('characters-totals:' + $('chBookSel').value);
    loadCharacters();
  });
  const runStep = async (url, running, doneMsg) => {
    if ($('chStepLog')) $('chStepLog').textContent = running;
    const id = $('chBookSel')?.value;
    const started = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      .then((r) => r.json()).catch(() => ({}));
    if (!started.ok && started.error) {
      if ($('chStepLog')) $('chStepLog').textContent = '失败：' + started.error;
      return;
    }
    // 轮询进度直到后台任务结束
    for (let i = 0; i < 3600; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      const p2 = await fetch('/api/characters/progress?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
      if (!p2) continue;
      if ($('chStepLog')) $('chStepLog').textContent = running + '（' + new Date().toLocaleTimeString() + '）';
      if (!p2.running) {
        if ($('chStepLog')) $('chStepLog').textContent = doneMsg({ totals: p2.totals, ok: p2.code === 0 }) + '（' + new Date().toLocaleTimeString() + '）';
        break;
      }
    }
    await loadCharacters();
  };
  $('chTable').addEventListener('click', async () => {
    $('chTable').disabled = true;
    try { await runStep('/api/characters/table', '生成角色真名表中…', (d) => '角色表完成：' + (d.totals?.characters || 0) + ' 个'); }
    finally { $('chTable').disabled = false; }
  });
  $('chMentionsBtn').addEventListener('click', async () => {
    $('chMentionsBtn').disabled = true;
    try { await runStep('/api/mentions/table', '扫描人称中…', (d) => '人称表完成：' + (d.totals?.mentions || 0) + ' 条'); }
    finally { $('chMentionsBtn').disabled = false; }
  });
  $('chBuild').addEventListener('click', async () => {
    const id = $('chBookSel')?.value;
    if (!id) return;
    if (chState.running) {
      $('chMeta').textContent = '停止中…';
      await fetch('/api/characters/stop', { method: 'POST' });
      chState.running = false;
      $('chBuild').textContent = '开始生成';
      $('chBuild').classList.remove('danger');
      await loadCharacters();
      return;
    }
    chState.running = true;
    $('chBuild').textContent = '停止';
    $('chBuild').classList.add('danger');
    $('chMeta').textContent = '生成中…';
    try {
      const data = await fetch('/api/characters/map', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then((r) => r.json()).catch(() => ({}));
      if (!data.ok) { $('chMeta').textContent = '已停止或失败：' + (data.error || ''); }
    } finally {
      chState.running = false;
      $('chBuild').textContent = '开始生成';
      $('chBuild').classList.remove('danger');
      await loadCharacters();
    }
  });
}

let chState = { data: null, scene: null };

async function loadCharacters({ totalsOnly = false } = {}) {
  const id = $('chBookSel')?.value || $('book')?.value;
  if (!id) return;
  const data = await fetch('/api/characters?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => ({}));
  if (state.view !== 'characters' || ($('chBookSel')?.value || $('book')?.value) !== id) return;
  if (!data.mentions) { $('chMeta').textContent = data.error || '没有结果'; $('chMentions').innerHTML = '<div class="number-empty">还没有结果</div>'; return; }
  const totalsKey = 'characters-totals:' + id;
  const totalsChanged = dataChanged(totalsKey, { totals: data.totals, scenesTotal: data.scenesTotal, current: data.current });
  if (totalsOnly && !totalsChanged) return;
  const total = data.scenesTotal || (data.scenes || []).length || 1;
  const doneCount = data.totals.scenes || 0;
  const percent = Math.min(100, Math.round((doneCount / Math.max(1, total)) * 100));
  if ($('chBar')) $('chBar').querySelector('i').style.width = percent + '%';
  $('chMeta').textContent = percent + '%（' + doneCount + '/' + total + ' 场）· 人称 ' + data.totals.mentions + ' · 已对应 ' + data.totals.resolved + ' · 待定 ' + data.totals.unresolved + ' · 角色 ' + data.totals.characters;
  if (totalsOnly || !dataChanged('characters:' + id, data)) return;
  chState.data = data;

  const scenes = data.scenes || [];
  const doneSet = new Set(data.doneScenes || []);
  const failSet = new Set(data.failedScenes || []);
  $('chScenes').innerHTML = scenes.map((s) => {
    const count = (data.mentions || []).filter((m) => m.sceneId === s.sceneId).length;
    let status = '未分析';
    let cls = 'todo';
    if (data.current === s.sceneId) { status = '分析中'; cls = 'running'; }
    else if (doneSet.has(s.sceneId)) { status = '分析完成'; cls = 'done'; }
    else if (failSet.has(s.sceneId)) { status = '分析失败'; cls = 'fail'; }
    return '<div class="ch-scene" data-scene="' + s.sceneId + '">'
      + '<div class="ch-scene-top">' + s.sceneId + ' · ' + esc(s.chapterTitle || s.chapterId)
      + '<span class="ch-status ' + cls + '">' + status + '</span></div>'
      + '<small>' + s.from + '~' + s.to + '（' + s.sentences + ' 句）· 人称 ' + count + '</small></div>';
  }).join('') || '<div class="number-empty">还没有场景</div>';

  if ($('chRelations')) {
    const rels = data.relations || [];
    $('chRelCount').textContent = rels.length ? '(' + rels.length + ')' : '';
    $('chRelations').innerHTML = rels.map((r) => '<div class="ch-rel"><b>' + esc(r.fromName) + '</b> <i>' + esc(r.type) + '</i> → <b>' + esc(r.toName) + '</b></div>').join('') || '—';
  }
  $('chCharacters').innerHTML = (data.characters || []).map((c) => {
    const count = (data.mentions || []).filter((m) => m.characterId === c.id).length;
    return '<div class="ch-char ' + (chState.character === c.id ? 'active' : '') + '" data-ch="' + c.id + '"><b>' + c.id + '</b><span>' + esc(c.name) + '</span><small style="color:#9aa1b8">' + count + ' 条</small></div>';
  }).join('') || '—';
  $('chCharacters').onclick = (event) => {
    const row = event.target.closest('[data-ch]');
    if (!row) return;
    chState.character = chState.character === row.dataset.ch ? '' : row.dataset.ch;
    renderSceneMentions();
    $('chCharacters').querySelectorAll('.ch-char.active').forEach((el) => el.classList.remove('active'));
    if (chState.character) row.classList.add('active');
  };

  $('chScenes').onclick = (event) => {
    const row = event.target.closest('[data-scene]');
    if (!row) return;
    chState.scene = row.dataset.scene;
    $('chScenes').querySelectorAll('.ch-scene.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    renderSceneMentions();
    renderSceneText();
  };

  if (!chState.scene && scenes.length) chState.scene = scenes[0].sceneId;
  const activeRow = $('chScenes').querySelector('[data-scene="' + chState.scene + '"]');
  if (activeRow) activeRow.classList.add('active');
  renderSceneMentions();
  renderSceneText();
}

function renderSceneText() {
  const data = chState.data;
  const box = $('chSceneText');
  if (!data || !box) return;
  const scene = (data.scenes || []).find((s) => s.sceneId === chState.scene);
  if (!scene) { box.innerHTML = '<div class="number-empty">没有这个场景</div>'; return; }
  const list = (data.mentions || []).filter((m) => m.sceneId === scene.sceneId);
  const bySentence = new Map();
  for (const m of list) {
    const n = m.sentence;
    if (!bySentence.has(n)) bySentence.set(n, []);
    bySentence.get(n).push(m);
  }
  const lines = (scene.text || []).map((item) => {
    const hits = (bySentence.get(item.n) || []).sort((a, b) => (a.start || 0) - (b.start || 0));
    let html = '';
    let cursor = 0;
    for (const m of hits) {
      const start = Number(m.start || 0);
      const end = Number(m.end || start + String(m.surface).length);
      if (start < cursor) continue;
      html += esc(item.text.slice(cursor, start));
      const mark = (m.characterId ? esc(m.name) : '未对应');
      html += '<span class="ch-hl' + (m.inDialog ? ' dialog' : '') + '" title="' + m.id + ' → ' + mark + '">' + esc(item.text.slice(start, end))
        + '<sup class="ch-sup">' + String(m.id).replace(/^M0*/, '') + '</sup></span>';
      cursor = end;
    }
    html += esc(item.text.slice(cursor));
    return '<span class="ch-sent ' + (hits.length ? 'marked' : '') + '" id="chs-' + item.n + '"><span style="color:#9aa1b8;font-size:11px">S' + item.n + '</span> ' + html + '</span>';
  }).join('');
  box.innerHTML = lines || '<div class="number-empty">这个场景没有正文</div>';
}

function renderSceneMentions() {
  const data = chState.data;
  if (!data) return;
  const filterName = chState.character || '';
  const list = filterName
    ? (data.mentions || []).filter((m) => m.characterId === filterName).slice(0, 300)
    : (data.mentions || []).filter((m) => m.sceneId === chState.scene);
  if (!list.length) { $('chMentions').innerHTML = '<div class="number-empty">' + (filterName ? '这个角色还没有人称' : '这个场景还没有人称') + '</div>'; return; }
  const head = filterName
    ? '<div class="ch-filter">筛选：' + esc(filterName) + '（' + list.length + ' 条）<button class="ghost" id="chClear" type="button">清除</button></div>'
    : '';
  $('chMentions').innerHTML = head + list.map((m) =>
    '<div class="ch-mrow ' + (m.inDialog ? 'dialog' : (m.characterId ? '' : 'unresolved')) + '" data-mid="' + m.id + '" data-sent="' + m.sentence + '" data-scene="' + (m.sceneId || '') + '">'
    + '<span>' + m.id + '</span>'
    + '<span class="ch-surface">' + esc(m.surface) + ' <small style="color:#9aa1b8">' + (filterName ? esc(m.sceneId) + ' · ' : '') + 'S' + m.sentence + '</small></span>'
    + '<span class="ch-link">' + (m.inDialog ? '<span class="ch-dialog-tag">对白</span>' : (m.characterId ? (m.characterId + ' ' + esc(m.name)) : '未对应')) + '</span>'
    + '</div>'
  ).join('');
  const clearBtn = document.getElementById('chClear');
  if (clearBtn) clearBtn.onclick = () => { chState.character = ''; loadCharacters(); };
  $('chMentions').onclick = (event) => {
    const row = event.target.closest('[data-mid]');
    if (!row) return;
    const sceneId = row.dataset.scene;
    if (sceneId && sceneId !== chState.scene) {
      chState.scene = sceneId;
      $('chScenes').querySelectorAll('.ch-scene.active').forEach((el) => el.classList.remove('active'));
      const sceneRow = $('chScenes').querySelector('[data-scene="' + sceneId + '"]');
      if (sceneRow) sceneRow.classList.add('active');
      renderSceneText();
      if (chState.character) renderSceneMentions();
    }
    const target = document.getElementById('chs-' + row.dataset.sent);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('chSceneText').querySelectorAll('.ch-sent.flash').forEach((el) => el.classList.remove('flash'));
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1600);
  };
}



function setupTaskCard() {
  if (setupTaskCard.done) return;
  setupTaskCard.done = true;
  (async () => {
    const list = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('tcBook');
    if (sel) sel.innerHTML = (list || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadTaskCard();
  })();
  $('tcBook').addEventListener('change', () => loadTaskCard());
  $('tcRefresh').addEventListener('click', () => loadTaskCard());
}

async function loadTaskCard() {
  const id = $('tcBook')?.value || $('book')?.value;
  if (!id) return;
  const data = await fetch('/api/taskcard?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => ({}));
  if (!data.book) { $('tcBody').innerHTML = '<div class="number-empty">' + (data.error || '读取失败') + '</div>'; return; }
  const b = data.book;
  $('tcMeta').textContent = b.chapters + ' 章 · ' + b.sentences + ' 句 · ' + b.scenes + ' 场';
  const head = '<div class="tc-book"><h3>《' + esc(b.title) + '》</h3>'
    + '<div class="tc-stats">'
    + '<span>章节 <b>' + b.chapters + '</b></span>'
    + '<span>句子 <b>' + b.sentences + '</b></span>'
    + '<span>场景 <b>' + b.scenes + '</b></span>'
    + '<span>角色 <b>' + b.characters + '</b></span>'
    + '<span>关系 <b>' + b.relations + '</b></span>'
    + '<span>详述 <b>' + b.details + '</b></span>'
    + '<span>疑问 <b>' + b.questions + '</b></span>'
    + '</div></div>';
  const rows = (data.tasks || []).map((t) => {
    const pct = t.total ? Math.round((t.done / t.total) * 100) : (t.done ? 100 : 0);
    const badge = t.running ? '<span class="tc-badge run">进行中</span>'
      : (t.total && t.done >= t.total ? '<span class="tc-badge done">已完成</span>'
        : (t.done ? '<span class="tc-badge todo">部分完成</span>' : '<span class="tc-badge todo">未开始</span>'));
    const acts = '<button class="ghost" data-goto="' + t.key + '" type="button">前往</button>';
    return '<div class="tc-task"><span class="name">' + esc(t.label) + '</span>'
      + '<div><div class="bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="num">' + esc(t.detail || '') + (t.total ? '　' + t.done + '/' + t.total : '') + '</div></div>'
      + '<span>' + badge + '</span><div class="acts">' + acts + '</div></div>';
  }).join('');
  $('tcBody').innerHTML = head + '<div class="tc-tasks">' + rows + '</div>';
  $('tcBody').querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const map = { scenes: 'scenesview', characters: 'characters', details: 'scenedetail', relations: 'characters' };
      switchView(map[btn.dataset.goto] || 'scenesview');
    });
  });
}




function setupConsole() {
  if (setupConsole.done) return;
  setupConsole.done = true;
  let tab = 'live';
  const render = (data) => {
    const live = data.inflight || [];
    const logs = (data.logs || []).slice().reverse();
    $('clLiveCount').textContent = live.length;
    $('clHistCount').textContent = logs.length;
    const list = tab === 'live' ? live : logs;
    if (!list.length) { $('clMessages').innerHTML = '<div class="number-empty">' + (tab === 'live' ? '当前没有正在运行的对话' : '暂无历史记录') + '</div>'; return; }
    $('clMessages').innerHTML = list.map((m) => {
      const err = m.status === 'error';
      const head = (m.source || 'unknown') + ' · ' + (m.model || '') + ' · 上限 ' + (m.maxTokens || '') + ' · ' + (m.startedAt || '').replace('T', ' ').slice(0, 19);
      const body = tab === 'live'
        ? '<div class="mod">正在生成… 提示词 ' + (m.promptLen || 0) + ' 字符（显示前 2000）</div><pre class="cl-pre">' + esc(m.promptHead || '') + '</pre>'
        : (err ? '错误：' + esc(m.error || '')
          : ('<div class="mod">' + (m.chars || 0) + ' 字符 · ' + Math.round((m.ms || 0) / 1000) + ' 秒</div>'
             + '<pre class="cl-pre">' + esc(m.contentHead || '（未保存原文，旧记录）') + '</pre>'));
      return '<div class="cl-msg' + (err ? ' err' : '') + '"><div class="head">' + esc(head) + '</div><div class="body">' + body + '</div></div>';
    }).join('');
  };
  const load = async () => {
    const state = await fetch('/api/console/state').then((r) => r.json()).catch(() => ({}));
    // 只显示真实用过的模型；没调用过就写「未调用」
    $('clModel').textContent = state.called ? (state.lastModel || '未调用') : '未调用';
    $('clMax').textContent = state.called && state.lastMaxTokens ? state.lastMaxTokens + ' tokens' : '—';
    if (typeof updateCacheBadge === 'function' && state.called) updateCacheBadge(state.lastCacheN, state.lastPromptN);
    $('clStatus').textContent = state.called
      ? (state.inflight ? '调用中' : '空闲（最近调用 ' + String(state.lastAt || '').replace('T', ' ').slice(0, 19) + '）')
      : '未调用';
    const logs = await fetch('/api/console/logs?limit=100').then((r) => r.json()).catch(() => ({ logs: [], inflight: [] }));
    render(logs);
  };
  $('clStart').addEventListener('click', async () => { $('clStatus').textContent = '启动中…'; await fetch('/api/console/start', { method: 'POST' }); await load(); });
  $('clStop').addEventListener('click', async () => { $('clStatus').textContent = '关闭中…'; await fetch('/api/console/stop', { method: 'POST' }); await load(); });
  document.querySelectorAll('.cl-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cl-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      tab = btn.dataset.tab;
      load();
    });
  });
  load();
  startPoll('console', load, 3000);
}

function setupWorkflow() {
  if (setupWorkflow.done) return;
  setupWorkflow.done = true;
  (async () => {
    const list = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('wfBook');
    if (sel) sel.innerHTML = (list || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    const names = ['1 小说清洗', '2 内容编号', '4 生成角色', '5 场景详述', '6 角色重构'];
    if ($('wfFrom') && !$('wfFrom').options.length) {
      const steps = [1, 2, 4, 5, 6];
      const opts = names.map((n, i) => '<option value="' + steps[i] + '">' + n + '</option>').join('');
      $('wfFrom').innerHTML = opts;
      $('wfTo').innerHTML = opts;
      $('wfFrom').value = '4';
      $('wfTo').value = '6';
    }
    await loadWorkflow();
  })();
  $('wfBook').addEventListener('change', () => loadWorkflow());
  $('wfMode').addEventListener('change', () => {
    const scheduled = $('wfMode').value === 'schedule';
    $('wfWhen').hidden = !scheduled;
    $('wfRun').textContent = scheduled ? '定时执行' : '执行';
    if (scheduled && !$('wfWhen').value) {
      const d = new Date(Date.now() + 10 * 60 * 1000);
      d.setSeconds(0, 0);
      const pad = (n) => String(n).padStart(2, '0');
      $('wfWhen').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
  });
  $('wfRun').addEventListener('click', async () => {
    const from = Number($('wfFrom').value);
    const to = Number($('wfTo').value);
    if ($('wfMode').value === 'schedule') {
      const at = $('wfWhen').value;
      if (!at) { $('wfMeta').textContent = '请选择时间'; return; }
      const r = await fetch('/api/workflow/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: $('wfBook')?.value, from, to, at: new Date(at).toISOString() }) });
      const d = await r.json().catch(() => ({}));
      $('wfMeta').textContent = d.ok ? ('已定时：' + new Date(d.scheduledAt).toLocaleString() + ' 执行第 ' + from + '–' + to + ' 步') : (d.error || '定时失败');
      return;
    }
    await runWorkflow(from, to);
  });
  $('wfStop').addEventListener('click', async () => {
    $('wfStop').disabled = true;
    await fetch('/api/workflow/stop?id=' + encodeURIComponent($('wfBook')?.value || ''), { method: 'POST' });
    $('wfStop').hidden = true;          // 立即隐藏，不等后台
    $('wfStop').disabled = false;
    $('wfMeta').textContent = '已请求停止（当前步骤结束后退出）';
    loadWorkflow();
  });
}

function showWfToast(text, isError) {
  const el = $('wfToast');
  if (!el) return;
  el.hidden = false;
  el.className = 'wf-toast' + (isError ? ' err' : '');
  el.textContent = text;
  clearTimeout(showWfToast.timer);
  showWfToast.timer = setTimeout(() => { el.hidden = true; }, 8000);
}

async function loadWorkflow() {
  const id = $('wfBook')?.value;
  if (!id) return;
  const data = await fetch('/api/workflow?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => ({}));
  if (!data.steps) { $('wfSteps').innerHTML = '<div class="number-empty">' + (data.error || '读取失败') + '</div>'; return; }
  const fmt = (sec) => {
    if (!sec || sec < 60) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h > 0 ? (h + ' 小时 ' + m + ' 分') : (m + ' 分钟');
  };
  const eta = fmt(data.etaSeconds);
  $('wfMeta').textContent = '《' + (data.book?.title || id) + '》' + (data.book?.exists ? '' : '（无正文）') + (eta ? '　预计剩余 ' + eta : '');
  window.__wfEta = data.etaSeconds || 0;
  const wf = data.workflow || {};
  // 顶部提示：当前正在运行的节点
  if ($('wfNow')) {
    const cur = wf.current ? data.steps.find((s) => s.no === Number(wf.current)) : null;
    const elapsed = wf.steps?.[String(wf.current)]?.startedAt ? Math.round((Date.now() - Number(wf.steps[String(wf.current)].startedAt)) / 1000) : 0;
    const mm = Math.floor(elapsed / 60);
    const ss = String(elapsed % 60).padStart(2, '0');
    if (data.running && cur) {
      $('wfNow').hidden = false;
      $('wfNow').innerHTML = '<span class="dot"></span> 正在运行：第 ' + cur.no + ' 步「' + esc(cur.name) + '」　' + cur.detail + '　已用时 ' + mm + ':' + ss;
    } else {
      $('wfNow').hidden = true;
      $('wfNow').innerHTML = '';
    }
  }
  const subs4 = wf.steps?.['4']?.subs || [];
  $('wfSteps').innerHTML = data.steps.map((s) => {
    const wfStep = wf.steps?.[String(s.no)];
    let status = s.done ? 'done' : 'pending';
    if (wfStep) status = wfStep.status === 'manual' ? 'manual' : wfStep.status;
    if (data.running && wf.current === s.no) status = 'running';
    const label = { done: '已完成', running: '进行中', pending: '未开始', manual: '需手动', failed: '失败' }[status] || status;
    const pct = Number(s.percent || 0);
    const bar = (status === 'running' || (pct > 0 && pct < 100))
      ? '<div class="wf-bar"><i style="width:' + pct + '%"></i></div>' : '';
    return '<div class="wf-step ' + status + (s.manual ? ' wf-manual' : '') + '"><span class="wf-no">' + s.no + '</span>'
      + '<div><div class="wf-name">' + esc(s.name) + (s.manual ? '　<span class="ch-meta">（需人工在对应标签完成）</span>' : '') + '</div>'
      + '<div class="wf-detail">' + esc(s.detail || '') + (pct ? '　' + pct + '%' : '') + '</div>' + bar + '</div>'
      + '<span class="wf-badge ' + status + '">' + label + '</span>'
      + '<span class="ch-meta">' + (wfStep?.seconds ? wfStep.seconds + 's' : '') + '</span>'
      + ([4, 5, 6].includes(s.no) ? '<button class="ghost wf-clear" type="button" data-clear-step="' + s.no + '">清除数据</button>' : '')
      + (s.no === 4 && subs4.length ? '<div class="wf-subs">' + subs4.map((sub) => {
          const st = ['done', 'running', 'failed'].includes(sub.status) ? sub.status : 'pending';
          const txt = { done: '已完成', running: '进行中', failed: '失败', pending: '未开始' }[st];
          return '<div class="wf-sub ' + st + '"><b>' + esc(sub.key) + '</b> ' + esc(sub.name)
            + '<span class="wf-badge ' + st + '">' + txt + '</span>'
            + (sub.progressText ? '<span class="ch-meta">' + esc(sub.progressText) + '</span>' : '')
            + (sub.seconds ? '<span class="ch-meta">' + sub.seconds + 's</span>' : '') + '</div>';
        }).join('') + '</div>' : '') + '</div>';
  }).join('');
  $('wfSteps').querySelectorAll('[data-clear-step]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const step = Number(btn.dataset.clearStep);
      const names = { 4: '角色/关系/人称/映射', 5: '场景详述', 6: '角色重构' };
      if (!confirm('清除第 ' + step + ' 步数据（' + names[step] + '）？会先自动备份。')) return;
      btn.disabled = true;
      const r = await fetch('/api/workflow/clear-step', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: $('wfBook')?.value, step }) });
      const d = await r.json().catch(() => ({}));
      btn.disabled = false;
      showWfToast(d.ok ? ('第 ' + step + ' 步已清除：' + ((d.removed || []).join('、') || '无文件')) : ('清除失败：' + (d.error || '未知')), !d.ok);
      // 清除后重新加载对应标签页的数据（读不到就显示 0 / 未开始）
      try {
        if (step === 4) { if (typeof loadCharacters === 'function') await loadCharacters(); }
        if (step === 5) { if (typeof loadSdList === 'function') await loadSdList(); if (typeof loadSdProgress === 'function') await loadSdProgress(); }
        if (step === 6) { if (typeof loadReconcileList === 'function') await loadReconcileList(); }
      } catch { /* 忽略 */ }
      await loadWorkflow();
    });
  });

  if ($('wfStop')) $('wfStop').hidden = !data.running;
}

async function runWorkflow(from, to) {
  const id = $('wfBook')?.value;
  if (!id) return;
  $('wfMeta').textContent = '启动中…';
  const r = await fetch('/api/workflow/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, from, to, model: window.__tabConfig?.model || '' }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('wfMeta').textContent = d.error || '启动失败'; return; }
  $('wfMeta').textContent = '第 ' + from + '–' + to + ' 步执行中…';
  if ($('wfStop')) $('wfStop').hidden = false;
  const timer = setInterval(async () => {
    await loadWorkflow();
    const p2 = await fetch('/api/workflow?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!p2 || !p2.running) { clearInterval(timer); }
  }, 5000);
}







async function loadTabModelOptions() {
  const sel = $('tcbModelSel');
  if (!sel || sel.dataset.ready) return;
  const state = await fetch('/api/gateway-models').then((r) => r.json()).catch(() => null);
  const models = (state && state.models) || [];
  sel.innerHTML = models.map((m) => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
  sel.dataset.ready = '1';
}

async function loadActualPrompt(view) {
  const id = $('book')?.value || '';
  const target = view || window.__tabConfig?.view || 'pipeline';
  let d = await fetch('/api/prompt/last?id=' + encodeURIComponent(id) + '&view=' + encodeURIComponent(target)).then((r) => r.json()).catch(() => null);
  if (!$('tcbActualText')) return;
  if (!d || !d.exists) {
    // 没有日志就现场生成一份预览（不调用模型）
    const scene = $('sdFrom')?.value || 'SC001';
    d = await fetch('/api/prompt/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, view: target, scene }) }).then((r) => r.json()).catch(() => null);
  }
  $('tcbActualText').textContent = d && d.exists
    ? d.text
    : '这个标签页还没有调用过模型，且暂不支持预览。';
}

async function loadCleanReference() {
  const data = await fetch('/api/clean/reference').then((r) => r.json()).catch(() => null);
  if (data && $('tcbRefText')) $('tcbRefText').value = data.reference || '';
}

async function loadTabConfig(view) {
  let target = view || state.view || 'pipeline';
  if (target === 'scenes' || target === 'cards') target = 'pipeline';
  const data = await fetch('/api/tab-config?view=' + encodeURIComponent(target)).then((r) => r.json()).catch(() => null);
  if (!data) return;
  window.__tabConfig = data;
  $('tcbView').textContent = data.label || target;
  const modeMap = { model: '模型处理', regex: '正则处理', hybrid: '混合处理' };
  $('tcbMode').textContent = modeMap[data.mode] || data.mode;
  $('tcbModel').textContent = data.model ? ('模型：' + data.model) : '无模型调用';
  $('tcbState').textContent = data.overridden ? '提示词已自定义' : '';
  $('tcbPromptText').value = data.prompt || '';
  const sel = $('tcbModelSel');
  if (sel) {
    sel.disabled = false;
    loadTabModelOptions().then(() => {
      if (!data.model) {
        // 无默认模型：显示 NA，但仍可展开选择
        sel.insertAdjacentHTML('afterbegin', '<option value="">NA</option>');
        sel.value = '';
        return;
      }
      if (![...sel.options].some((o) => o.value === data.model)) {
        sel.insertAdjacentHTML('afterbegin', '<option value="' + esc(data.model) + '">' + esc(data.model) + '</option>');
      }
      sel.value = data.model;
    });
  }
  $('tcbToggle').textContent = data.prompt ? '系统提示词' : '无提示词';
  const isClean = target === 'clean';
  if ($('tcbRefBtn')) $('tcbRefBtn').hidden = !isClean;
  if (!isClean && $('tcbRef')) $('tcbRef').hidden = true;
  if (isClean) loadCleanReference();
  $('tcbToggle').disabled = !data.prompt && !data.overridden;
  if (!data.prompt) { $('tcbPrompt').hidden = true; }
}




function setupDirty() {
  if (setupDirty.done) return;
  setupDirty.done = true;
  (async () => {
    const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('dtBook');
    if (sel) sel.innerHTML = (books || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadDirty();
  })();
  $('dtBook')?.addEventListener('change', () => loadDirty());
  $('dtRun')?.addEventListener('click', () => runDirty());
}

async function loadDirty() {
  const id = $('dtBook')?.value || $('book')?.value;
  if (!id || !$('dtChars')) return;
  const data = await fetch('/api/dirty/list?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data) return;
  window.__dtItems = data.items || [];
  const t = data.totals || {};
  if ($('dtStatus')) {
    $('dtStatus').textContent = '淫语 ' + (t.items || 0)
      + (t.byType ? '　' + Object.entries(t.byType).map(([k, v]) => k + ' ' + v).join(' · ') : '')
  }
  const counts = new Map();
  for (const it of window.__dtItems) {
    const who = it.说话人 || '未知';
    counts.set(who, (counts.get(who) || 0) + 1);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  $('dtChars').innerHTML = '<div class="ct-h">说话人（' + list.length + '）</div>'
    + list.map(([who, n]) => '<div class="dt-row" data-who="' + esc(who) + '">' + esc(who) + '<small style="display:block;color:#8a91ab">' + n + ' 句</small></div>').join('');
  $('dtChars').onclick = (ev) => {
    const row = ev.target.closest('[data-who]');
    if (!row) return;
    $('dtChars').querySelectorAll('.dt-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    renderDirtyPerson(row.dataset.who);
  };
}

function renderDirtyPerson(who) {
  const items = (window.__dtItems || []).filter((it) => (it.说话人 || '未知') === who);
  const byChapter = new Map();
  for (const it of items) {
    if (!byChapter.has(it.chapterId)) byChapter.set(it.chapterId, []);
    byChapter.get(it.chapterId).push(it);
  }
  const keys = [...byChapter.keys()].sort((a, b) => Number(String(a).replace(/\D/g, '')) - Number(String(b).replace(/\D/g, '')));
  $('dtBody').innerHTML = '<div class="ct-h" style="font-size:15px">' + esc(who) + '　<span class="ch-meta">' + items.length + ' 句</span></div>'
    + (items.length ? keys.map((ch) => '<div class="ct-h">' + esc(ch) + '</div>'
      + byChapter.get(ch).map((it) => '<div class="dt-line"><span class="dt-id">' + esc(it.id) + '</span>'
        + '<span class="lk-s">S' + it.sentence + '</span> <span class="dt-type">' + esc(it.类型) + '</span> '
        + '<span class="dt-quote">「' + esc(it.原文) + '」</span>'
        + '<div class="dt-meta">对象：' + esc((it.对象 || []).join(' + ') || '未知') + '</div></div>').join('')).join('')
      : '<div class="number-empty">没有淫语</div>');
}

async function runDirty() {
  const id = $('dtBook')?.value || $('book')?.value;
  if (!id) return;
  $('dtStatus').textContent = '梳理中…';
  const r = await fetch('/api/dirty/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, step: 'rebuild' }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('dtStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadDirty();
    const cur = await fetch('/api/dirty/list?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!cur || !cur.running) clearInterval(timer);
  }, 5000);
}

function setupErotic() {
  if (setupErotic.done) return;
  setupErotic.done = true;
  (async () => {
    const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('erBook');
    if (sel) sel.innerHTML = (books || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadErotic();
  })();
  $('erBook')?.addEventListener('change', () => loadErotic());
  $('erRebuild')?.addEventListener('click', () => runErotic());
}

async function loadErotic() {
  const id = $('erBook')?.value || $('book')?.value;
  if (!id || !$('erChars')) return;
  const data = await fetch('/api/erotic/list?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data) return;
  window.__erItems = data.items || [];
  const t = data.totals || {};
  if ($('erStatus')) {
    $('erStatus').textContent = '描写 ' + t.all + ' · 已映射 ' + t.mapped
      + (t.byType ? '　' + Object.entries(t.byType).map(([k, v]) => k + ' ' + v).join(' · ') : '')
    if ($('erBar')) $('erBar').querySelector('i').style.width = (t.all ? Math.round(t.mapped / t.all * 100) : 0) + '%';
  }
  const counts = new Map();
  for (const it of window.__erItems) {
    const people = (it.角色 || []);
    if (!people.length) counts.set('未映射', (counts.get('未映射') || 0) + 1);
    for (const p of people) counts.set(p.姓名, (counts.get(p.姓名) || 0) + 1);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  $('erChars').innerHTML = '<div class="ct-h">角色（' + list.length + '）</div>'
    + list.map(([who, n]) => '<div class="er-row" data-who="' + esc(who) + '">' + esc(who) + '<small style="display:block;color:#8a91ab">' + n + ' 条</small></div>').join('');
  $('erChars').onclick = (ev) => {
    const row = ev.target.closest('[data-who]');
    if (!row) return;
    $('erChars').querySelectorAll('.er-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    renderEroticPerson(row.dataset.who);
  };
}

function renderEroticPerson(who) {
  const items = (window.__erItems || []).filter((it) => {
    const people = (it.角色 || []).map((p) => p.姓名);
    return who === '未映射' ? people.length === 0 : people.includes(who);
  });
  const byChapter = new Map();
  for (const it of items) {
    if (!byChapter.has(it.chapterId)) byChapter.set(it.chapterId, []);
    byChapter.get(it.chapterId).push(it);
  }
  const keys = [...byChapter.keys()].sort((a, b) => Number(String(a).replace(/\D/g, '')) - Number(String(b).replace(/\D/g, '')));
  $('erBody').innerHTML = '<div class="ct-h" style="font-size:15px">' + esc(who) + '　<span class="ch-meta">' + items.length + ' 条</span></div>'
    + (items.length ? keys.map((ch) => '<div class="ct-h">' + esc(ch) + '</div>'
      + byChapter.get(ch).map((it) => '<div class="er-line"><span class="er-id">' + esc(it.id) + '</span>'
        + '<span class="lk-s">S' + it.sentence + '</span> <span class="er-type">' + esc(it.类型) + '</span> '
        + '<span class="er-quote">' + esc(it.原文) + '</span>'
        + '<div class="er-sent">参与者：' + esc((it.角色 || []).map((p) => p.姓名).join(' + ') || '未映射') + '</div></div>').join('')).join('')
      : '<div class="number-empty">没有描写</div>');
}

async function runErotic() {
  const id = $('erBook')?.value || $('book')?.value;
  if (!id) return;
  $('erStatus').textContent = '抽取中…';
  const r = await fetch('/api/erotic/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, step: 'rebuild' }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('erStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadErotic();
    const cur = await fetch('/api/erotic/list?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!cur || !cur.running) clearInterval(timer);
  }, 5000);
}

function setupAppear() {
  if (setupAppear.done) return;
  setupAppear.done = true;
  (async () => {
    const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('apBook');
    if (sel) sel.innerHTML = (books || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadAppear();
  })();
  $('apBook')?.addEventListener('change', () => loadAppear());
  $('apNumber')?.addEventListener('click', () => runAppear('rebuild'));
  $('apMap')?.addEventListener('click', () => runAppear('map'));
}

async function loadAppear() {
  const id = $('apBook')?.value || $('book')?.value;
  if (!id || !$('apChars')) return;
  const data = await fetch('/api/appear/list?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data) return;
  window.__apItems = data.items || [];
  const t = data.totals || {};
  if ($('apStatus')) {
    const pct = t.all ? Math.round((t.assigned / t.all) * 100) : 0;
    $('apStatus').textContent = '描写 ' + t.all + ' · 已映射 ' + t.assigned + '（' + pct + '%）'
      + (t.byCls ? '　身体 ' + (t.byCls['身体'] || 0) + ' · 衣着 ' + (t.byCls['衣着'] || 0) + ' · 配饰 ' + (t.byCls['配饰'] || 0) : '')
    if ($('apBar')) $('apBar').querySelector('i').style.width = pct + '%';
  }
  const counts = new Map();
  for (const it of window.__apItems) {
    const who = it.角色 || '未映射';
    counts.set(who, (counts.get(who) || 0) + 1);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  $('apChars').innerHTML = '<div class="ct-h">角色（' + list.length + '）</div>'
    + list.map(([who, n]) => '<div class="ap-row" data-who="' + esc(who) + '">' + esc(who) + '<small style="display:block;color:#8a91ab">' + n + ' 条</small></div>').join('');
  $('apChars').onclick = (ev) => {
    const row = ev.target.closest('[data-who]');
    if (!row) return;
    $('apChars').querySelectorAll('.ap-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    renderAppearPerson(row.dataset.who);
  };
}

function renderAppearPerson(who) {
  const items = (window.__apItems || []).filter((it) => (it.角色 || '未映射') === who);
  const byChapter = new Map();
  for (const it of items) {
    if (!byChapter.has(it.chapterId)) byChapter.set(it.chapterId, []);
    byChapter.get(it.chapterId).push(it);
  }
  const keys = [...byChapter.keys()].sort((a, b) => Number(String(a).replace(/\D/g, '')) - Number(String(b).replace(/\D/g, '')));
  $('apBody').innerHTML = '<div class="ct-h" style="font-size:15px">' + esc(who) + '　<span class="ch-meta">' + items.length + ' 条</span></div>'
    + (items.length ? keys.map((ch) => '<div class="ct-h">' + esc(ch) + '</div>'
      + byChapter.get(ch).map((it) => '<div class="ap-line"><span class="ap-id">' + esc(it.id) + '</span>'
        + '<span class="lk-s">S' + it.sentence + '</span> <span class="ap-cls">' + esc(it.类别) + '</span> '
        + '<span class="ap-quote">' + esc(it.原文) + '</span>'
        + (it.整句 ? '<div class="ap-sent">整句：' + esc(it.整句.slice(0, 120)) + '</div>' : '') + '</div>').join('')).join('')
      : '<div class="number-empty">没有描写</div>');
}

async function runAppear(step) {
  const id = $('apBook')?.value || $('book')?.value;
  if (!id) return;
  $('apStatus').textContent = step === 'number' ? '编号中…' : '映射中…';
  const r = await fetch('/api/appear/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, step, from: $('apFrom')?.value || '', to: $('apTo')?.value || '' }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('apStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadAppear();
    const cur = await fetch('/api/appear/list?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!cur || !cur.running) clearInterval(timer);
  }, 5000);
}

function setupTabConfigBar() {
  if (setupTabConfigBar.done) return;
  setupTabConfigBar.done = true;
  $('tcbActualBtn')?.addEventListener('click', async () => {
    const view = window.__tabConfig?.view || state.view;
    const src = SOURCE_BY_VIEW[view] || '';
    const scene = (state.view === 'scenedetail' || state.view === 'sceneDetail') ? (window.__sdScene || '') : '';
    const qs = [];
    if (src) qs.push('source=' + encodeURIComponent(src));
    if (scene) qs.push('scene=' + encodeURIComponent(scene));
    const d = await fetch('/api/console/conversation' + (qs.length ? '?' + qs.join('&') : '')).then((r) => r.json()).catch(() => null);
    const items = (d && d.items) || [];
    const box = $('convBody');
    if (!items.length) {
      box.innerHTML = '<div class="number-empty">还没有调用记录</div>';
    } else {
      const ms = Number(d.totalMs || 0);
      const sec = Math.round(ms / 1000);
      const dur = sec >= 60 ? (Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒') : (sec ? sec + ' 秒' : '—');
      const head = '<div class="conv-run">本轮：' + esc(d.run || '—') + '　共 ' + items.length + ' 次调用　总耗时 ' + dur + '</div>';
      box.innerHTML = head + items.map((it, idx) => '<div class="conv-item">'
        + '<div class="ct-h">#' + (idx + 1) + '　<b>' + esc(stepNameOf(it.prompt)) + '</b>　' + esc(it.source || '') + '　' + esc(it.status || '') + '　' + esc((it.at || '').slice(0, 19)) + (Number(it.ttftMs) ? '　首token ' + (Math.round(Number(it.ttftMs) / 100) / 10) + 's' : '') + (Number(it.ms) ? '　耗时 ' + (Math.round(Number(it.ms) / 100) / 10) + 's' : '') + (typeof it.hitRate === 'number'
            ? '　缓存 ' + Math.round(it.hitRate * 100) + '%（' + (it.cacheN || 0) + '/' + (Number(it.cacheN || 0) + Number(it.promptN || 0)) + '）'
            : (Number(it.cacheN) || Number(it.promptN) ? '　缓存 ' + Math.round((Number(it.cacheN || 0) / Math.max(1, Number(it.cacheN || 0) + Number(it.promptN || 0))) * 100) + '%（' + (it.cacheN || 0) + '/' + (Number(it.cacheN || 0) + Number(it.promptN || 0)) + '）' : '')) + '</div>'
        + '<details open><summary>提问（' + String(it.prompt || '').length + ' 字）</summary><pre class="conv-pre">' + esc(it.prompt || '') + '</pre></details>'
        + '<details open><summary>回答（' + String(it.content || '').length + ' 字）</summary><pre class="conv-pre">' + esc(it.content || '') + '</pre></details>'
        + '</div>').join('');
    }
    $('convModal').hidden = false;
  });
  $('convClose')?.addEventListener('click', () => { $('convModal').hidden = true; });
  $('tcbRefBtn')?.addEventListener('click', () => {
    const box = $('tcbRef');
    box.hidden = !box.hidden;
  });
  $('tcbRefSave')?.addEventListener('click', async () => {
    const reference = $('tcbRefText').value;
    const r = await fetch('/api/clean/reference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference }) }).then((x) => x.json()).catch(() => null);
    $('tcbState').textContent = r && r.ok ? '参考已保存' : '保存失败';
  });
  $('tcbRefClear')?.addEventListener('click', async () => {
    $('tcbRefText').value = '';
    await fetch('/api/clean/reference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: '' }) });
    $('tcbState').textContent = '参考已清空';
  });
  $('tcbToggle')?.addEventListener('click', () => {
    const viewId = window.__tabConfig?.view || state.view;
    const promptId = {"scenedetail":"scenedetail","correct":"correct","relink":"relink","cardboard":"cardboard","dialog":"dialog","dirty":"dirty","appear":"appear","erotic":"erotic","clean":"clean","scenesview":"segment"}[viewId] || '';
    if (!promptId) { $('tcbState').textContent = '该标签页还没有对应提示词'; return; }
    switchView('prompts');
    window.__pmPending = promptId;
    setTimeout(() => {
      if (typeof loadPromptList === 'function') loadPromptList();
    }, 100);
  });
  $('tcbModelSel')?.addEventListener('change', async (e) => {
    const view = window.__tabConfig?.view;
    if (!view) return;
    const picked = e.target.value;
    await fetch('/api/tab-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view, model: picked }) });
    $('tcbState').textContent = picked
      ? (window.__tabConfig && window.__tabConfig.defaultModel ? '模型已切换' : '已选模型（该标签页默认走正则，未接入模型调用）')
      : '已恢复 NA';
    setTimeout(() => loadTabConfig(view), 200);
  });
  $('tcbSave')?.addEventListener('click', async () => {
    const view = window.__tabConfig?.view;
    if (!view) return;
    const prompt = $('tcbPromptText').value;
    const mode = $('tcbPromptText').dataset.mode;
    const r = mode === 'template'
      ? await fetch('/api/prompt/template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view, template: prompt }) }).then((x) => x.json()).catch(() => null)
      : await fetch('/api/tab-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view, prompt }) }).then((x) => x.json()).catch(() => null);
    $('tcbState').textContent = r && r.ok ? '已保存' : '保存失败';
    setTimeout(loadTabConfig, 300);
  });
  $('tcbReset')?.addEventListener('click', async () => {
    const view = window.__tabConfig?.view;
    if (!view) return;
    await fetch('/api/tab-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view, prompt: '' }) });
    $('tcbState').textContent = '已恢复默认';
    setTimeout(loadTabConfig, 300);
  });
  loadTabConfig();
}


function setupDialog() {
  if (setupDialog.done) return;
  setupDialog.done = true;
  (async () => {
    const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('dlBook');
    if (sel) sel.innerHTML = (books || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadDialogScenes();
  })();
  $('dlBook')?.addEventListener('change', () => loadDialogScenes());
  $('dlFrom')?.addEventListener('change', () => loadDialogScenes());
  $('dlTo')?.addEventListener('change', () => loadDialogScenes());
  $('dlNumber')?.addEventListener('click', () => runDialog('number'));
  $('dlFill')?.addEventListener('click', () => runDialog('map', 'fill'));
  $('dlMap')?.addEventListener('click', () => runDialog('map'));
}

async function loadDialogScenes() {
  const sd = await fetch('/api/scenes/llm?id=' + encodeURIComponent($('dlBook')?.value || $('book')?.value)).then((r) => r.json()).catch(() => null);
  const scs = (sd && sd.scenes) || [];
  window.__dlScenes = scs;
  if ($('dlFrom') && !$('dlFrom').options.length) {
    const opts = scs.map((s) => '<option value="' + esc(s.sceneId) + '">' + esc(s.sceneId) + '</option>').join('');
    $('dlFrom').innerHTML = opts; $('dlTo').innerHTML = opts;
    if (scs.length) { $('dlFrom').value = scs[0].sceneId; $('dlTo').value = scs[scs.length - 1].sceneId; }
  }
  const id = $('dlBook')?.value || $('book')?.value;
  if (!id) return;
  const qs = ['id=' + encodeURIComponent($('dlBook')?.value || $('book')?.value)];
  if ($('dlFrom')?.value) qs.push('from=' + encodeURIComponent($('dlFrom').value));
  if ($('dlTo')?.value) qs.push('to=' + encodeURIComponent($('dlTo').value));
  const data = await fetch('/api/dialog/list?' + qs.join('&')).then((r) => r.json()).catch(() => null);
  if (!data) return;
  const rows = data.rows || [];
  window.__dlRows = rows;
  const t = data.totals || {};
  if ($('dlStatus')) {
    const mappedRows = rows.filter((x) => x.characterId).length;
    $('dlStatus').textContent = '本段对话 ' + rows.length + ' · 已判 ' + mappedRows + '（' + (rows.length ? Math.round((mappedRows / rows.length) * 100) : 0) + '%）' + (data.running ? ('　进行中…' + (data.currentScene ? '（正在 ' + data.currentScene + '）' : '')) : '');
    if ($('dlBar')) $('dlBar').querySelector('i').style.width = (t.all ? Math.round((t.mapped / t.all * 100)) : 0) + '%';
  }

  const counts = new Map();
  for (const r of rows) {
    const who = r.说话人 || '未知';
    counts.set(who, (counts.get(who) || 0) + 1);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  $('dlChars').innerHTML = '<div class="ct-h">说话人（' + list.length + '）</div>'
    + list.map(([who, n]) => '<div class="dl-row" data-who="' + esc(who) + '">' + esc(who) + '<small style="display:block;color:#8a91ab">' + n + ' 句</small></div>').join('');
  $('dlChars').onclick = (ev) => {
    const row = ev.target.closest('[data-who]');
    if (!row) return;
    $('dlChars').querySelectorAll('.dl-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    window.__dlActive = row.dataset.who;
    renderDialogPerson(row.dataset.who);
  };

  // 区间/数据刷新后：保持当前选中角色，否则回到提示态
  const keep = window.__dlActive && counts.has(window.__dlActive) ? window.__dlActive : (list.length ? list[0][0] : '');
  if (keep) {
    window.__dlActive = keep;
    const row = [...$('dlChars').querySelectorAll('.dl-row')].find((el) => el.dataset.who === keep);
    if (row) row.classList.add('active');
    renderDialogPerson(keep);
  } else {
    window.__dlActive = '';
    $('dlBody').innerHTML = '<div class="number-empty">左边选一个角色</div>';
  }
}

function renderDialogPerson(who) {
  const rows = (window.__dlRows || []).filter((r) => (r.说话人 || '未知') === who);
  const scenes = window.__dlScenes || [];
  const sceneOf = (n) => scenes.find((s) => n >= Number(String(s.from).slice(1)) && n <= Number(String(s.to).slice(1)));
  const groups = new Map();
  for (const r of rows) {
    const sc = sceneOf(Number(r.sentence));
    const key = sc ? (sc.sceneId + '（' + sc.from + '~' + sc.to + '）') : (r.chapterId || '未分场');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const keys = [...groups.keys()];
  $('dlBody').innerHTML = '<div class="ct-h" style="font-size:15px">' + esc(who) + '　<span class="ch-meta">' + rows.length + ' 句</span></div>'
    + (rows.length ? keys.map((ch) => '<div class="ct-h">' + esc(ch) + '</div>'
      + groups.get(ch).map((r) => '<div class="dl-line"><span class="dl-id">' + esc(r.id) + '</span>'
        + '<span class="lk-s">S' + r.sentence + '</span>　「' + esc(r.原文) + '」'
        + (r.来源 ? ' <span class="lk-s">' + esc(r.来源) + '</span>' : '')
        + (r.整句 ? '<div class="dl-ctx">整句：' + esc(r.整句) + '</div>' : '') + '</div>').join('')).join('')
      : '<div class="number-empty">没有台词</div>');
}

async function runDialog(step, mode) {
  const id = $('dlBook')?.value || $('book')?.value;
  if (!id) return;
  $('dlStatus').textContent = step === 'number' ? '编号中…' : '映射中…';
  const r = await fetch('/api/dialog/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, step, mode: mode || '', from: $('dlFrom')?.value || '', to: $('dlTo')?.value || '', model: window.__tabConfig?.model || '' }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('dlStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadDialogScenes();
    const cur = await fetch('/api/dialog/list?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!cur || !cur.running) clearInterval(timer);
  }, 5000);
}



const TABLE_FILE = {"cardboard":"character-cards.json","dialog":"dialogue-table.json","dirty":"dirty-talk.json","appear":"appearance-table.json","erotic":"erotic-table.json"};

async function loadTableVersions(view) {
  const name = TABLE_FILE[view];
  const sel = $('tblVersion');
  if (!name || !sel) return;
  const id = $('book')?.value;
  if (!id) return;
  sel.dataset.name = name;
  const d = await fetch('/api/table/versions?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name)).then((r) => r.json()).catch(() => null);
  const list = (d && d.versions) || [];
  if ($('tblVersionHint')) $('tblVersionHint').textContent = list.length ? '共 ' + list.length + ' 个版本' : '还没有版本记录（重新生成一次后才有）';
  if (!list.length) { sel.hidden = true; sel.innerHTML = ''; return; }
  sel.hidden = false;
  sel.innerHTML = list.map((v) => '<option value="' + v.version + '">v' + v.version + (d.current === v.version ? '（当前）' : '') + '</option>').join('');
  sel.value = String(d.current || list[list.length - 1].version);
}

async function previewTableVersion() {
  const sel = $('tblVersion');
  if (!sel || !sel.dataset.name) return;
  const id = $('book')?.value;
  const v = sel.value;
  const d = await fetch('/api/table/version?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(sel.dataset.name) + '&v=' + encodeURIComponent(v)).then((r) => r.json()).catch(() => null);
  if (!d || d.error) return;
  const boxes = $('tblVersionBody');
  if (!boxes) return;
  const keys = Object.keys(d).filter((k) => Array.isArray(d[k]));
  const summary = keys.map((k) => k + '：' + d[k].length + ' 条').join('　');
  const sample = keys.length ? JSON.stringify(d[keys[0]].slice(0, 3), null, 1) : JSON.stringify(d, null, 1).slice(0, 2000);
  boxes.textContent = '版本 v' + v + '　' + summary + '\n\n' + sample;
  boxes.hidden = false;
}

function paintZones(text) {
  const esc2 = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const lines = String(text || '').split('\n');
  let zone = '';
  const out = [];
  for (const line of lines) {
    if (line.startsWith('【固化区')) zone = 'fixed';
    else if (line.startsWith('【半固化区')) zone = 'semi';
    else if (line.startsWith('【问题区')) zone = 'question';
    const cls = zone ? 'pz pz-' + zone : 'pz';
    out.push('<span class="' + cls + '">' + esc2(line) + '</span>');
  }
  return out.join('\n');
}

function renderPromptPreview(text) {
  const box = $('pmPreview');
  if (!box) return;
  box.innerHTML = paintZones(text);
  box.hidden = false;
}

function setupPrompts() {
  if (setupPrompts.done) return;
  setupPrompts.done = true;
  loadPromptList();
  $('pmSave')?.addEventListener('click', async () => {
    const id = window.__pmId;
    if (!id) return;
    const text = $('pmText').value;
    const r = await fetch('/api/prompts/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) }).then((x) => x.json()).catch(() => null);
    $('pmHint').textContent = r && r.ok ? '已保存' : '保存失败';
    loadPromptList();
  });
  $('pmReset')?.addEventListener('click', async () => {
    const id = window.__pmId;
    if (!id) return;
    await fetch('/api/prompts/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    $('pmHint').textContent = '已恢复默认';
    loadPromptList();
    loadPromptItem(id);
  });
}

async function loadPromptList() {
  const data = await fetch('/api/prompts/list').then((r) => r.json()).catch(() => null);
  if (!data) return;
  const prompts = data.prompts || [];
  window.__pmPrompts = prompts;
  const groups = new Map();
  for (const p of prompts) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  const html = [];
  for (const [group, list] of groups) {
    const ordered = list.slice().sort((a, b) => (a.order || 1) - (b.order || 1));
    const flowList = ordered.filter((p) => !String(p.note || '').includes('参考版'));
    const flow = flowList.map((p) => (p.order || 1) + '. ' + p.title.replace(/^.*· ?/, '')).join(' → ');
    html.push('<div class="pm-group">' + esc(group) + '　<span class="pm-flow">' + esc(flow) + '</span></div>');
    for (const p of ordered) {
      const badge = (p.order && p.order > 0)
        ? '<span class="pm-order">' + p.order + '</span> '
        : '<span class="pm-order ref">参考</span> ';
      html.push('<div class="pm-item" data-id="' + esc(p.id) + '">' + badge + esc(p.title)
        + (p.customized ? ' <span class="tc-badge done">已改</span>' : '')
        + '<small>' + esc(p.note || '') + '　' + p.length + ' 字</small></div>');
    }
  }
  $('pmList').innerHTML = html.join('') || '<div class="number-empty">没有提示词</div>';
  $('pmStatus').textContent = '共 ' + prompts.length + ' 条提示词';
  $('pmList').onclick = (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    $('pmList').querySelectorAll('.pm-item.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    loadPromptItem(row.dataset.id);
  };
  const pending = window.__pmPending;
  if (pending) {
    window.__pmPending = '';
    const row = $('pmList').querySelector('[data-id="' + pending + '"]');
    if (row) { row.click(); row.scrollIntoView({ block: 'center' }); return; }
  }
  if (prompts.length && !window.__pmId) {
    const first = $('pmList').querySelector('[data-id]');
    if (first) first.click();
  }
}

async function loadPromptItem(id) {
  const data = await fetch('/api/prompts/item?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data) return;
  window.__pmId = id;
  $('pmText').value = data.text || '';
  if (typeof renderPromptPreview === 'function') renderPromptPreview(data.text || '');
  const ph = (data.meta && data.meta.placeholders) ? data.meta.placeholders : [];
  $('pmMeta').textContent = (data.meta?.title || id) + '　占位符：' + (ph.length ? ph.map((x) => '{{' + x + '}}').join(' ') : '无');
  $('pmHint').textContent = '';
}

function setupCardBoard() {
  if (setupCardBoard.done) return;
  setupCardBoard.done = true;
  (async () => {
    const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('cdBook');
    if (sel) sel.innerHTML = (books || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadCardBoardChapters();
  })();
  $('cdBook')?.addEventListener('change', () => loadCardBoardChapters());
  $('cdRun')?.addEventListener('click', () => runCardBoard());
}

async function loadCardBoardChapters() {
  // 统一跟随顶部书籍；区间用场景号
  const id = $('book')?.value || $('cdBook')?.value;
  if (!id) return;
  const data = await fetch('/api/scenes/llm?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  const scenes = (data && data.scenes) || [];
  const opts = scenes.map((s) => '<option value="' + esc(s.sceneId) + '">' + esc(s.sceneId) + '</option>').join('');
  if ($('cdFrom')) { $('cdFrom').innerHTML = opts; if (scenes.length) $('cdFrom').value = scenes[0].sceneId; }
  if ($('cdTo')) { $('cdTo').innerHTML = opts; if (scenes.length) $('cdTo').value = scenes[scenes.length - 1].sceneId; }
  await loadCards();
}
async function loadCards() {
  const id = $('cdBook')?.value || $('book')?.value;
  if (!id || !$('cdChars')) return;
  // 显示当前标签页实际使用的模型
  try {
    const cfg = await fetch('/api/tab-config?view=cardboard').then((r) => r.json()).catch(() => null);
    if ($('cdModel')) $('cdModel').textContent = '模型：' + ((cfg && (cfg.model || cfg.defaultModel)) || '—');
  } catch { /* 忽略 */ }
  const data = await fetch('/api/cards/list?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  const p = await fetch('/api/cards/progress?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (p && $('cdStatus')) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('cdStatus').textContent = pct + '%　已梳理 ' + p.done + '/' + p.total + (p.running ? '　进行中…' : '');
    if ($('cdBar')) $('cdBar').querySelector('i').style.width = pct + '%';
  }
  const cards = (data && data.cards) || {};
  window.__cards = cards;
  const names = Object.keys(cards);
  $('cdChars').innerHTML = names.length ? names.map((n) =>
    '<div class="cd-row" data-name="' + esc(n) + '">' + esc(n) + '<small style="display:block;color:#8a91ab">' + Object.keys(cards[n].scenes || cards[n].chapters || {}).length + ' 场</small></div>',
  ).join('') : '<div class="number-empty">还没有人物卡</div>';
  $('cdChars').onclick = (e) => {
    const row = e.target.closest('[data-name]');
    if (!row) return;
    $('cdChars').querySelectorAll('.cd-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    renderCard(row.dataset.name);
  };
}

function renderCard(name) {
  const card = (window.__cards || {})[name];
  if (!card) return;
  const SCALARS = ['身份', '年龄', '外貌', '衣着', '身体', '性格', '语言风格', '能力与弱点', '情欲偏好', '变化轨迹', '矛盾点'];
  const LISTS = [
    ['外貌档案', '描写'], ['衣着档案', '描写'], ['身体档案', '描写'], ['性格档案', '表现'],
    ['语言档案', '原话'], ['习惯动作', '动作'], ['关系网', '对象'], ['重要经历', '事件'],
    ['性爱姿势', '姿势'], ['淫语言录', '原话'], ['性反应', '反应'], ['敏感点', '部位'], ['性爱描写', '原文'],
  ];
  const blocks = card.scenes || card.chapters || {};
  const keys = Object.keys(blocks).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  const line = (item) => {
    if (typeof item === 'string') return esc(item);
    const head = Object.entries(item).filter(([k]) => k !== '句' && k !== '原文').map(([, v]) => esc(String(v))).join(' ｜ ');
    const quote = item['原文'] ? '<div class="cd-quote">「' + esc(String(item['原文'])) + '」' + (item['句'] ? ' <span class="lk-s">S' + esc(String(item['句'])) + '</span>' : '') + '</div>' : (item['句'] ? ' <span class="lk-s">S' + esc(String(item['句'])) + '</span>' : '');
    return head + quote;
  };
  const rows = (key) => {
    const v = blocks[key] || {};
    let html = '<div class="ct-h">' + esc(key) + '</div>';
    for (const k of SCALARS) if (v[k]) html += '<div class="cd-field"><span class="k">' + k + '</span><span>' + esc(v[k]) + '</span></div>';
    for (const [k] of LISTS) {
      const list = v[k] || [];
      if (!list.length) continue;
      html += '<details class="ct-fold" open><summary>' + k + '（' + list.length + '）</summary>'
        + list.map((x) => '<div class="cd-field"><span class="k"></span><span>' + line(x) + '</span></div>').join('')
        + '</details>';
    }
    return html;
  };
  $('cdBody').innerHTML = '<div class="ct-h" style="font-size:15px">' + esc(name) + '</div>' + keys.map(rows).join('');
}




async function runCardBoard() {
  const id = $('cdBook')?.value || $('book')?.value;
  const from = $('cdFrom')?.value;
  const to = $('cdTo')?.value;
  if (!id || !from) return;
  $('cdStatus').textContent = '启动中…';
  const r = await fetch('/api/cards/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, from, to }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('cdStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadCards();
    const p = await fetch('/api/cards/progress?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!p || !p.running) clearInterval(timer);
  }, 5000);
}

function setupRelink() {
  if (setupRelink.done) return;
  setupRelink.done = true;
  (async () => {
    const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('rlBook');
    if (sel) sel.innerHTML = (books || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadRelinkChapters();
  })();
  $('rlBook')?.addEventListener('change', () => loadRelinkChapters());
  $('rlRun')?.addEventListener('click', () => runRelink());
}

async function loadRelinkChapters() {
  const id = $('rlBook')?.value;
  if (!id) return;
  const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
  const n = (books || []).find((b) => b.id === id)?.chapters || 0;
  const opts = Array.from({ length: n }, (_, i) => '<option value="C' + (i + 1) + '">C' + (i + 1) + '</option>').join('');
  if ($('rlFrom')) $('rlFrom').innerHTML = opts;
  if ($('rlTo')) { $('rlTo').innerHTML = opts; $('rlTo').value = 'C' + n; }
  await loadRelinkReport();
}

async function loadRelinkReport() {
  const id = $('rlBook')?.value;
  if (!id) return;
  const data = await fetch('/api/relink/report?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  const p = await fetch('/api/relink/progress?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (p && $('rlStatus')) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('rlStatus').textContent = pct + '%　已重构 ' + p.done + '/' + p.total + (p.running ? '　进行中…' : '');
    if ($('rlBar')) $('rlBar').querySelector('i').style.width = pct + '%';
  }
  const chapters = data?.chapters || {};
  const keys = Object.keys(chapters).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  $('rlList').innerHTML = keys.length ? keys.map((k) => {
    const v = chapters[k] || {};
    return '<div class="rl-row" data-ch="' + k + '">' + k
      + (v.error ? '　<span class="tc-badge todo">失败</span>' : '　<span class="tc-badge done">完成</span>')
      + '<small style="display:block;color:#8a91ab">修改 ' + ((v['修改'] || []).length) + ' · 存疑 ' + ((v['存疑'] || []).length) + '</small></div>';
  }).join('') : '<div class="number-empty">还没有结果</div>';
  $('rlList').onclick = (e) => {
    const row = e.target.closest('[data-ch]');
    if (!row) return;
    $('rlList').querySelectorAll('.rl-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    renderRelinkChapter(chapters[row.dataset.ch] || {}, row.dataset.ch);
  };
}



function charOptions(current) {
  const list = window.__rlChars || [];
  const opts = ['<option value="">（未映射）</option>']
    .concat(list.map((c) => '<option value="' + esc(c.name) + '"' + (c.name === current ? ' selected' : '') + '>' + esc(c.name) + '</option>'));
  return opts.join('');
}

async function renderRelinkChars(mentions) {
  const counts = new Map();
  for (const m of mentions) {
    if (!m.characterName) continue;
    counts.set(m.characterName, (counts.get(m.characterName) || 0) + 1);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const charDoc = await fetch('/api/detail-characters?id=' + encodeURIComponent($('rlBook')?.value || '')).then((r) => r.json()).catch(() => null);
  window.__rlChars = (charDoc && charDoc.characters) || [];
  $('rlChars').innerHTML = '<div class="ct-h">本章角色（' + list.length + '）</div>'
    + (list.length ? list.map(([name, n]) =>
      '<div class="rl-char" data-who="' + esc(name) + '">' + esc(name) + ' <span class="lk-s">' + n + '</span></div>',
    ).join('') : '<div class="number-empty">本章没有人称映射</div>');

  $('rlChars').querySelectorAll('.rl-char').forEach((el) => {
    el.onclick = () => {
      const who = el.dataset.who;
      const on = el.classList.contains('active');
      $('rlChars').querySelectorAll('.rl-char.active').forEach((x) => x.classList.remove('active'));
      $('rlText').querySelectorAll('.lk-hl-on').forEach((x) => x.classList.remove('lk-hl-on'));
      if (on) return;
      el.classList.add('active');
      const spans = [...$('rlText').querySelectorAll('[data-who]')].filter((s) => s.dataset.who === who);
      for (const s of spans) s.classList.add('lk-hl-on');
      if (spans[0]) spans[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
  });
}

async function renderRelinkChapter(v, ch) {
  // 上层：本章原文
  const id = $('rlBook')?.value;
  const text = await fetch('/api/chapter/text?id=' + encodeURIComponent(id) + '&chapterId=' + encodeURIComponent(ch)).then((r) => r.json()).catch(() => null);
  const surfaceOf = new Map(((text || {}).mentions || []).map((m) => [m.id, m.surface]));
  const metaOf = new Map(((text || {}).mentions || []).map((m) => [m.id, m]));
  const changesOf = new Map(((v || {})['修改'] || []).map((x) => [x['编号'], x]));
  if (text && text.lines) {
    const bySentence = new Map();
    for (const m of text.mentions || []) {
      if (!bySentence.has(m.sentence)) bySentence.set(m.sentence, []);
      bySentence.get(m.sentence).push(m);
    }
    $('rlText').innerHTML = '<div class="ct-h">' + esc(ch) + ' ' + esc(text.title || '') + '</div>'
      + text.lines.map((l) => {
        const list = (bySentence.get(l.n) || []).slice().sort((x, y) => x.start - y.start);
        let html = '';
        let cursor = 0;
        const raw = String(l.text || '');
        for (const m of list) {
          const from = Math.max(0, Math.min(m.start ?? 0, raw.length));
          const to = Math.max(from, Math.min(m.end ?? from, raw.length));
          html += esc(raw.slice(cursor, from));
          html += '<span class="lk-hl lk-jump' + (m.characterName ? '' : ' none') + '" data-mid="' + esc(m.id) + '" data-who="' + esc(m.characterName || '') + '" title="' + esc(m.id + ' → ' + (m.characterName || '未映射')) + '">'
            + esc(raw.slice(from, to)) + '<i class="lk-id">' + esc(m.id.replace(/^M0*/, 'M')) + '</i></span>';
          cursor = to;
        }
        html += esc(raw.slice(cursor));
        return '<div class="sv-line"><span class="lk-s">S' + l.n + '</span> ' + html + '</div>';
      }).join('');
  } else {
    $('rlText').innerHTML = '<div class="number-empty">读不到本章原文</div>';
  }

  // 下层：改动记录
  const parts = [];
  if (v.error) parts.push('<div class="number-empty">失败：' + esc(v.error) + '</div>');
  if (v['结论']) parts.push('<div class="ct-h">结论</div><div>' + esc(v['结论']) + '</div>');
  parts.push('<div class="ch-meta">人称 ' + (v['人称总数'] || 0) + ' · 修改 ' + ((v['修改'] || []).length) + ' · 存疑 ' + ((v['存疑'] || []).length) + '</div>');
  if ((v['修改'] || []).length) {
    parts.push('<div class="ct-h">映射修改</div>');
    parts.push('<table class="rc-table"><thead><tr><th>人称编号</th><th>人称</th><th>句</th><th>原来</th><th>改为</th></tr></thead><tbody>'
      + v['修改'].map((x) => '<tr class="lk-jump-row" data-mid="' + esc(x['编号']) + '"><td>' + esc(x['编号']) + '</td><td>' + esc(x['词'] || surfaceOf.get(x['编号']) || '—') + '</td><td>S' + (x['句子'] || '') + '</td><td>' + esc(x['从']) + '</td><td class="changed">' + esc(x['到']) + '</td></tr>').join('')
      + '</tbody></table>');
  }
  if ((v['存疑'] || []).length) {
    parts.push('<div class="ct-h">存疑</div>');
    parts.push(v['存疑'].map((x) => '<div>' + esc(x['编号'] || '') + '　' + esc(x['原因'] || '') + '</div>').join(''));
  }
  $('rlLog').innerHTML = parts.join('');
  await renderRelinkChars(text && text.mentions ? text.mentions : []);

  // 双向追溯：点正文编号 → 高亮下方对应行；点下方行 → 跳到正文并闪烁
  const flash = (el) => { if (!el) return; el.classList.add('lk-flash'); setTimeout(() => el.classList.remove('lk-flash'), 1500); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  $('rlText').querySelectorAll('[data-mid]').forEach((el) => {
    el.addEventListener('click', () => {
      const mid = el.dataset.mid;
      const meta = metaOf.get(mid) || { id: mid, surface: el.textContent, sentence: '', sceneId: '', characterName: el.dataset.who || '' };
      const change = changesOf.get(mid);
      const rowText = ($('rlText').querySelector('[data-mid="' + mid + '"]')?.closest('.sv-line')?.innerText || '').slice(0, 160);
      $('rlInfo').innerHTML =
        '<div class="rl-info-line">'
        + '<span class="rl-chip id">' + esc(meta.id) + '</span>'
        + '<span class="rl-chip">' + esc(meta.surface || '') + '</span>'
        + '<span class="rl-chip dim">S' + esc(meta.sentence || '') + ' · ' + esc(meta.sceneId || '') + '</span>'
        + '<span class="rl-chip who">' + esc(meta.characterName || '未映射') + '</span>'
        + '<span class="rl-chip dim" title="' + esc(rowText) + '">' + (change ? ('改动 ' + esc(change['从']) + '→' + esc(change['到'])) : '未被 5.3 修改') + '</span>'
        + '</div>'
        + '<div class="rl-edit"><span class="ch-meta">改为</span>'
        + '<select id="rlEditSel" class="number-booksel">' + charOptions(meta.characterName || '') + '</select>'
        + '<button id="rlEditSave" class="primary" type="button">保存</button>'
        + '<span id="rlEditMsg" class="ch-meta"></span></div>';
      const row = $('rlLog').querySelector('tr[data-mid="' + mid + '"]');
      if (row) flash(row);
    });
  });
  $('rlLog').querySelectorAll('tr[data-mid]').forEach((row) => {
    row.addEventListener('click', () => {
      const span = $('rlText').querySelector('[data-mid="' + row.dataset.mid + '"]');
      if (span) flash(span);
    });
  });
}

async function runRelink() {
  const id = $('rlBook')?.value;
  const from = $('rlFrom')?.value;
  const to = $('rlTo')?.value;
  if (!id || !from) return;
  $('rlStatus').textContent = '启动中…';
  const r = await fetch('/api/relink/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, from, to }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('rlStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadRelinkReport();
    const p = await fetch('/api/relink/progress?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!p || !p.running) clearInterval(timer);
  }, 5000);
}

function setupLink() {
  if (setupLink.done) return;
  setupLink.done = true;
  (async () => {
    const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('lkBook');
    if (sel) sel.innerHTML = (books || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadLinkScenes();
  })();
  $('lkBook')?.addEventListener('change', () => loadLinkScenes());
  $('lkNumber')?.addEventListener('click', () => runLink('number'));
  $('lkMap')?.addEventListener('click', () => runLinkMap('fill'));
  $('lkMapFresh')?.addEventListener('click', () => runLinkMap('fresh'));
}

async function runLinkMap(mode) {
  const id = $('lkBook')?.value || $('book')?.value;
  if (!id) return;
  $('lkStatus').textContent = mode === 'fresh' ? '全量重跑中…' : '继续未完成…';
  const res = await fetch('/api/link/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, step: 'map', mode }),
  }).then((r) => r.json()).catch(() => null);
  if (!res || res.error) { $('lkStatus').textContent = (res && res.error) || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadLinkScenes();
    const cur = await fetch('/api/link/progress?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
    if (!cur || !cur.running) clearInterval(timer);
  }, 5000);
}

async function loadLinkScenes() {
  const id = $('lkBook')?.value;
  if (!id) return;
  const data = await fetch('/api/scenes/llm?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  const scenes = data?.scenes || [];
  window.__lkScenes = scenes;
  const p = await fetch('/api/link/progress?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (p && $('lkStatus')) {
    const pct = p.mentions ? Math.round((p.mapped / p.mentions) * 100) : 0;
    $('lkStatus').textContent = '人称 ' + p.mentions + ' · 已映射 ' + p.mapped + '（' + pct + '%）' + (p.running ? '　进行中…' : '');
    if ($('lkBar')) $('lkBar').querySelector('i').style.width = pct + '%';
  }
  $('lkScenes').innerHTML = scenes.length ? scenes.map((s) =>
    '<div class="ch-scene-row" data-scene="' + s.sceneId + '"><b>' + s.sceneId + '</b> <small>' + esc(s.from) + '~' + esc(s.to) + '（' + s.sentences + ' 句）</small></div>',
  ).join('') : '<div class="number-empty">还没有场景切分</div>';
  $('lkScenes').onclick = (ev) => {
    const row = ev.target.closest('[data-scene]');
    if (!row) return;
    $('lkScenes').querySelectorAll('.ch-scene-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    showLinkScene(row.dataset.scene);
  };
  await loadLinkChars();
}

async function showLinkScene(sceneId) {
  const id = $('lkBook')?.value;
  const data = await fetch('/api/link/scene?id=' + encodeURIComponent(id) + '&sceneId=' + encodeURIComponent(sceneId)).then((r) => r.json()).catch(() => null);
  if (!data || !data.rows) { $('lkText').innerHTML = '<div class="number-empty">读取失败</div>'; return; }
  const rows = data.rows;

  // 左：人称列表
  $('lkMentions').innerHTML = rows.length ? rows.map((r) =>
    '<div class="lk-mrow" data-m="' + esc(r.id) + '"><span class="lk-m">' + esc(r.id) + '</span>'
    + '<span class="lk-s">S' + r.sentence + '</span> '
    + '<span>' + esc(r.text) + '</span> '
    + '<span class="lk-who' + (r.characterName ? '' : ' none') + '">' + esc(r.characterName || '未映射') + '</span></div>',
  ).join('') : '<div class="number-empty">这一场没有人称</div>';

  // 中：原文（按句渲染，人称高亮）
  const scene = (window.__lkScenes || []).find((s) => s.sceneId === sceneId);
  const bySentence = new Map();
  for (const r of rows) {
    if (!bySentence.has(r.sentence)) bySentence.set(r.sentence, []);
    bySentence.get(r.sentence).push(r);
  }
  const lines = scene?.lines || [];
  $('lkText').innerHTML = lines.map((line) => {
    const list = (bySentence.get(line.n) || []).slice().sort((a, b) => a.start - b.start);
    let html = '';
    let cursor = 0;
    const text = String(line.text || '');
    for (const m of list) {
      const from = Math.max(0, Math.min(m.start ?? 0, text.length));
      const to = Math.max(from, Math.min(m.end ?? from, text.length));
      html += esc(text.slice(cursor, from));
      html += '<span class="lk-hl' + (m.characterName ? '' : ' none') + '" title="' + esc(m.id + ' → ' + (m.characterName || '未映射')) + '">' + esc(text.slice(from, to)) + '</span>';
      cursor = to;
    }
    html += esc(text.slice(cursor));
    return '<div class="sv-line"><span class="lk-s">S' + line.n + '</span> ' + html + '</div>';
  }).join('') || '<div class="number-empty">没有正文</div>';
}

async function loadLinkChars() {
  const id = $('lkBook')?.value;
  if (!id || !$('lkChars')) return;
  const data = await fetch('/api/detail-characters?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data) return;
  if ($('lkCharCount')) $('lkCharCount').textContent = '(' + (data.characters || []).length + ')';
  $('lkChars').innerHTML = (data.characters || []).map((c) =>
    '<div class="lk-char"><b>' + esc(c.id) + '</b> ' + esc(c.name)
    + (c.aliases?.length ? ' <span class="lk-s">（' + esc(c.aliases.slice(0, 3).join('/')) + '）</span>' : '')
    + ' <span class="lk-s">' + (c.scenes || []).length + ' 场</span></div>',
  ).join('') || '<div class="number-empty">还没有角色</div>';
}

async function runLink(step) {
  const id = $('lkBook')?.value;
  if (!id) return;
  $('lkStatus').textContent = (step === 'number' ? '编号中…' : '映射中…');
  const r = await fetch('/api/link/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, step }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('lkStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadLinkScenes();
    const p = await fetch('/api/link/progress?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!p || !p.running) clearInterval(timer);
  }, 5000);
}


function setupCorrect() {
  if (setupCorrect.done) return;
  setupCorrect.done = true;
  (async () => {
    const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('ctBook');
    if (sel) sel.innerHTML = (books || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadCorrectChapters();
  })();
  $('ctBook').addEventListener('change', () => loadCorrectChapters());
  $('ctRun').addEventListener('click', () => runCorrect());
}

async function loadCorrectChapters() {
  const id = $('ctBook')?.value;
  if (!id) return;
  const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
  const book = (books || []).find((b) => b.id === id);
  const n = book?.chapters || 0;
  const opts = Array.from({ length: n }, (_, i) => '<option value="C' + (i + 1) + '">C' + (i + 1) + '</option>').join('');
  if ($('ctFrom')) $('ctFrom').innerHTML = opts;
  if ($('ctTo')) { $('ctTo').innerHTML = opts; $('ctTo').value = 'C' + n; }
  await loadCorrectReport();
}

async function loadCorrectReport() {
  const id = $('ctBook')?.value;
  if (!id) return;
  const data = await fetch('/api/correct/report?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data) return;
  const chapters = data.chapters || {};
  const keys = Object.keys(chapters).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  const p = await fetch('/api/correct/progress?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if ($('ctStatus') && p) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('ctStatus').textContent = pct + '%　已纠错 ' + p.done + '/' + p.total + (p.running ? '　进行中…' : '');
    if ($('ctBar')) $('ctBar').querySelector('i').style.width = pct + '%';
  }
  $('ctList').innerHTML = keys.length ? keys.map((k) => {
    const v = chapters[k] || {};
    return '<div class="ct-row" data-ch="' + k + '">' + k
      + (v.error ? '　<span class="tc-badge todo">失败</span>' : '　<span class="tc-badge done">已纠错</span>')
      + '<small style="display:block;color:#8a91ab">角色 ' + ((v['角色'] || []).length) + ' · 关系 ' + ((v['关系'] || []).length) + ' · 存疑 ' + ((v['存疑'] || []).length) + '</small></div>';
  }).join('') : '<div class="number-empty">还没有纠错结果</div>';

  $('ctList').onclick = (e) => {
    const row = e.target.closest('[data-ch]');
    if (!row) return;
    $('ctList').querySelectorAll('.ct-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    renderCorrectChapter(chapters[row.dataset.ch] || {}, row.dataset.ch);
  };
  renderCorrectChars(data.characters || [], data.relations || []);
}

function renderCorrectChapter(v, ch) {
  const parts = ['<div class="ct-h">' + esc(ch) + ' 纠错结果</div>'];
  if (v.error) parts.push('<div class="number-empty">失败：' + esc(v.error) + '</div>');
  if (v['结论']) parts.push('<div>' + esc(v['结论']) + '</div>');
  const list = (title, arr, fn) => {
    if (!Array.isArray(arr) || !arr.length) return;
    parts.push('<div class="ct-h">' + title + '（' + arr.length + '）</div>');
    for (const x of arr) parts.push('<div>' + fn(x) + '</div>');
  };
  list('角色', v['角色'], (x) => '<b>' + esc(x['姓名'] || '') + '</b>　代称：' + esc((x['代称'] || []).join('/')) + (x['改动'] ? '　' + esc(x['改动']) : ''));
  list('关系', v['关系'], (x) => esc(x['甲'] || '') + ' 是 ' + esc(x['乙'] || '') + ' 的 ' + esc(x['甲角色'] || '') + ' ／ ' + esc(x['乙角色'] || '') + (x['证据句']?.length ? '　S' + x['证据句'].join(',S') : ''));
  list('存疑', v['存疑'], (x) => '· ' + esc(x['内容'] || '') + '（' + esc(x['原因'] || '') + '）');
  $('ctDetail').innerHTML = parts.join('');
}

function renderCorrectChars(chars, rels) {
  const iden = (rels || []).filter((r) => (r.kind || 'identity') === 'identity');
  const ref = (rels || []).filter((r) => r.kind === 'reference');
  const byName = new Map();
  for (const r of iden) {
    for (const side of ['a', 'b']) {
      const name = r[side];
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ ...r, other: side === 'a' ? r.b : r.a, myRole: side === 'a' ? r.aRole : r.bRole, otherRole: side === 'a' ? r.bRole : r.aRole });
    }
  }
  const refByName = new Map();
  for (const r of ref) {
    for (const side of ['a', 'b']) {
      const name = r[side];
      if (!refByName.has(name)) refByName.set(name, []);
      refByName.get(name).push({ ...r, other: side === 'a' ? r.b : r.a, myRole: side === 'a' ? r.aRole : r.bRole, otherRole: side === 'a' ? r.bRole : r.aRole });
    }
  }

  const html = chars.map((c) => {
    const list = byName.get(c.name) || [];
    const refList = refByName.get(c.name) || [];
    const ok = list.filter((x) => x.verified !== false);
    const pending = list.filter((x) => x.verified === false);
    const line = (x, cls) => '<div class="sd-field"><span class="k">' + cls + '</span><span class="v">'
      + esc(x.other) + ' ｜ ' + esc(x.myRole || '—') + ' ↔ ' + esc(x.otherRole || '—')
      + (x.scenes && x.scenes.length ? ' ｜ ' + esc(x.scenes.slice(0, 3).join(' ')) : '') + '</span></div>';
    return '<div class="sd-charbox"><div class="sd-cid">' + esc(c.id) + '</div>'
      + '<div class="sd-field"><span class="k">姓名</span><span class="v">' + esc(c.name) + '</span></div>'
      + '<div class="sd-field"><span class="k">代称</span><span class="v">' + ((c.aliases || []).length ? esc(c.aliases.join(' / ')) : '—') + '</span></div>'
      + (ok.length ? ok.map((x) => line(x, '关系')).join('') : '<div class="sd-field"><span class="k">关系</span><span class="v">—</span></div>')
      + (pending.length ? '<details class="ct-fold"><summary>待核关系（' + pending.length + '）</summary>' + pending.map((x) => line(x, '待核')).join('') + '</details>' : '')
      + (refList.length ? '<details class="ct-fold"><summary>参考关系（' + refList.length + '）</summary>' + refList.map((x) => line(x, '参考')).join('') + '</details>' : '')
      + '</div>';
  }).join('');

  $('ctChars').innerHTML = '<div class="ct-h">角色真名表（' + chars.length + '）</div>' + (html || '<div class="number-empty">还没有角色</div>')
    + '<div class="ch-meta" style="margin-top:8px">关系 ' + iden.length + ' 条（已验证 ' + iden.filter((x) => x.verified !== false).length + '）· 参考 ' + ref.length + ' 条</div>';
}


async function runCorrect() {
  const id = $('ctBook')?.value;
  const from = $('ctFrom')?.value;
  const to = $('ctTo')?.value;
  if (!id || !from) return;
  $('ctStatus').textContent = '启动中…';
  const r = await fetch('/api/correct/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, from, to }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('ctStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    await loadCorrectReport();
    const p = await fetch('/api/correct/progress?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!p || !p.running) { clearInterval(timer); await loadCorrectReport(); }
  }, 5000);
}

function setupReconcile() {
  if (setupReconcile.done) return;
  setupReconcile.done = true;
  (async () => {
    const list = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('rcBook');
    if (sel) sel.innerHTML = (list || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadReconcileList();
  })();
  $('rcBook').addEventListener('change', () => loadReconcileList());
  $('rcRun').addEventListener('click', () => runReconcile(false, false));
  $('rcRunMissing').addEventListener('click', () => runReconcile(false, true));
  $('rcStop').addEventListener('click', async () => {
    $('rcStop').disabled = true;
    $('rcStatus').textContent = '正在停止…';
    await fetch('/api/reconcile/stop?id=' + encodeURIComponent($('rcBook')?.value || ''), { method: 'POST' });
    setTimeout(async () => { $('rcStop').hidden = true; $('rcStop').disabled = false; await loadReconcileList(); }, 1500);
  });
  $('rcApply').addEventListener('click', () => runReconcile(true));
}

async function loadReconcileList() {
  const id = $('rcBook')?.value;
  if (!id) return;
  const data = await fetch('/api/reconcile/list?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => ({}));
  if (!data.scenes) { $('rcList').innerHTML = '<div class="number-empty">' + (data.error || '读取失败') + '</div>'; return; }
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
  if ($('rcBar')) $('rcBar').querySelector('i').style.width = pct + '%';
  $('rcStatus').textContent = pct + '%　已重构 ' + data.done + '/' + data.total;
  const opts = (data.scenes || []).map((s) => '<option value="' + s.sceneId + '">' + s.sceneId + '</option>').join('');
  if ($('rcFrom') && !$('rcFrom').options.length && data.scenes.length) { $('rcFrom').innerHTML = opts; $('rcTo').innerHTML = opts; $('rcTo').value = data.scenes[data.scenes.length - 1].sceneId; }
  $('rcList').innerHTML = data.scenes.map((s) =>
    '<div class="rc-row" data-scene="' + s.sceneId + '">'
    + '<span class="rc-badge ' + (s.done ? 'done' : 'todo') + '">' + (s.done ? '已重构' : '未重构') + '</span>'
    + s.sceneId + '<small>' + s.from + '~' + s.to + '（' + s.sentences + ' 句）'
    + (s.done ? ' · 修正 ' + s.fixes + ' · 新增 ' + s.newChars : '') + '</small></div>'
  ).join('');
  // 列表加载后即填充右侧角色表（不需要先选场景）
  fetch('/api/characters?id=' + encodeURIComponent(id)).then((r) => r.json()).then((c) => {
    renderReconcileChars(c.characters || [], c.relations || []);
  }).catch(() => {});

  $('rcList').onclick = (event) => {
    const row = event.target.closest('[data-scene]');
    if (!row) return;
    $('rcList').querySelectorAll('.rc-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    loadReconcileScene(row.dataset.scene);
  };
}

async function loadReconcileScene(sceneId) {
  const id = $('rcBook')?.value;
  const [rep, chars] = await Promise.all([
    fetch('/api/reconcile/scene?id=' + encodeURIComponent(id) + '&sceneId=' + encodeURIComponent(sceneId)).then((r) => r.json()).catch(() => ({})),
    fetch('/api/characters?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => ({})),
  ]);
  renderReconcileChars(chars.characters || [], chars.relations || []);
  if (!rep.ok) { $('rcReport').innerHTML = '<div class="number-empty">' + sceneId + ' 还没有重构报告</div>'; return; }
  const r = rep.report || {};
  const parts = ['<div class="rc-h">' + sceneId + ' 重构报告</div>'];
  if (r['结论']) parts.push('<div class="rc-item">' + esc(r['结论']) + '</div>');
  const sec = (title, list, renderer) => {
    if (!Array.isArray(list) || !list.length) return;
    parts.push('<div class="rc-h">' + title + '（' + list.length + '）</div>');
    for (const x of list) parts.push('<div class="rc-item">' + renderer(x) + '</div>');
  };
  sec('需新增角色', r['需新增角色'], (x) => '<span class="rc-tag">新增</span><b>' + esc(x['姓名'] || '') + '</b>　' + esc(x['依据'] || ''));
  if (Array.isArray(r['关系确认']) && r['关系确认'].length) {
    parts.push('<div class="rc-h">关系确认（' + r['关系确认'].length + '）</div>');
    parts.push('<table class="rc-table"><thead><tr><th>确认前</th><th>确认后</th></tr></thead><tbody>'
      + r['关系确认'].map((x) => {
        const line = esc(x['甲'] || '') + ' -' + esc(x['关系'] || '') + '-> ' + esc(x['乙'] || '');
        return '<tr><td>' + line + '</td><td class="same">未改变</td></tr>';
      }).join('') + '</tbody></table>');
  }
  if (Array.isArray(r['关系修正']) && r['关系修正'].length) {
    parts.push('<div class="rc-h">关系修正（' + r['关系修正'].length + '）</div>');
    parts.push('<table class="rc-table"><thead><tr><th>修正前</th><th>修正后</th></tr></thead><tbody>'
      + r['关系修正'].map((x) => {
        const before = esc(x['原'] || '');
        const after = esc(x['改为'] || '');
        const same = String(x['原'] || '') === String(x['改为'] || '');
        return '<tr><td>' + before + '</td><td class="' + (same ? 'same' : 'changed') + '">' + (same ? '未改变' : after) + '</td></tr>'
          + (x['理由'] ? '<tr><td colspan="2" class="reason"><small>' + esc(x['理由']) + '</small></td></tr>' : '');
      }).join('') + '</tbody></table>');
  }
  sec('关系删除', r['关系删除'], (x) => '<span class="rc-tag del">删除</span>' + esc(x['关系'] || '') + '<br><small>' + esc(x['理由'] || '') + '</small>');
  sec('疑问裁决', r['疑问裁决'], (x) => '<span class="rc-tag">' + esc(x['判定'] || '') + '</span>' + esc(x['编号'] || '') + ' ' + esc(x['说明'] || ''));
  $('rcReport').innerHTML = parts.join('');
}

async function runReconcile(apply, onlyMissing) {
  const id = $('rcBook')?.value;
  const from = $('rcFrom')?.value;
  const to = $('rcTo')?.value;
  if (!id || !from) { $('rcStatus').textContent = '先选择起始场景'; return; }
  if ($('rcStop')) $('rcStop').hidden = false;
  $('rcStatus').textContent = (apply ? '应用结论 ' : (onlyMissing ? '重构未完成 ' : '全部重构 ')) + from + '~' + to + ' 启动中…';
  const r = await fetch('/api/reconcile/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, from, to, apply, onlyMissing: Boolean(onlyMissing) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { $('rcStatus').textContent = d.error || '启动失败'; return; }
  const timer = setInterval(async () => {
    const p2 = await fetch('/api/reconcile/progress?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (!p2) return;
    const pp = p2.total ? Math.round((p2.done / p2.total) * 100) : 0;
    if ($('rcBar')) $('rcBar').querySelector('i').style.width = pp + '%';
    $('rcStatus').textContent = pp + '%　已重构 ' + p2.done + '/' + p2.total + (p2.running ? '　进行中…' : '');
    fetch('/api/characters?id=' + encodeURIComponent(id)).then((r) => r.json()).then((c) => renderReconcileChars(c.characters || [], c.relations || [])).catch(() => {});
    if ($('rcStop')) $('rcStop').hidden = !p2.running;
    if (!p2.running) { clearInterval(timer); await loadReconcileList(); }
  }, 5000);
}

function renderReconcileChars(chars, relations) {
  // 记住展开状态：轮询重渲染时不能把用户展开的角色收起来
  const openNames = new Set();
  for (const d of document.querySelectorAll('#rcChars details[open]')) {
    const b = d.querySelector('summary b');
    const nameEl = d.querySelector('summary');
    const label = (nameEl?.textContent || '').replace(/^\S+\s*/, '').replace(/\d+$/, '').trim();
    if (label) openNames.add(label);
  }
  const rels = relations || [];
  const byChar = new Map();
  for (const r of rels) {
    for (const side of ['fromName', 'toName']) {
      const name = r[side];
      if (!name) continue;
      if (!byChar.has(name)) byChar.set(name, []);
      byChar.get(name).push({ ...r, direction: side === 'fromName' ? 'out' : 'in' });
    }
  }
  $('rcChars').innerHTML = '<div class="rc-h">角色真名表（' + chars.length + '）</div>'
    + chars.map((c) => {
      const list = byChar.get(c.name) || [];
      const rows = list.map((r) => {
        const other = r.direction === 'out' ? r.toName : r.fromName;
        const arrow = r.direction === 'out' ? '→' : '←';
        return '<div class="rc-rel"><a href="#" class="rc-scene" data-scene="' + esc(r.sceneId || '') + '">' + esc(r.sceneId || '—') + '</a>'
          + '<span class="rc-rel-type">' + esc(r.type) + '</span>'
          + arrow + '<b>' + esc(other) + '</b></div>';
      }).join('') || '<div class="rc-rel none">暂无关系</div>';
      return '<details class="rc-char-item"><summary><b>' + esc(c.id) + '</b> ' + esc(c.name)
        + '<span class="rc-count">' + list.length + '</span></summary>' + rows + '</details>';
    }).join('');
  for (const d of $('rcChars').querySelectorAll('details')) {
    const label = (d.querySelector('summary')?.textContent || '').replace(/^\S+\s*/, '').replace(/\d+$/, '').trim();
    if (openNames.has(label)) d.open = true;
  }
  $('rcChars').querySelectorAll('.rc-scene').forEach((a2) => {
    a2.addEventListener('click', (ev) => {
      ev.preventDefault();
      const sid = a2.dataset.scene;
      if (!sid) return;
      const row = $('rcList').querySelector('[data-scene="' + sid + '"]');
      if (row) row.click();
    });
  });
}

async function loadDetailCharacters() {
  const id = $('sdBook')?.value || $('book')?.value;
  if (!id || !$('sdChars')) return;
  const data = await fetch('/api/detail-characters?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data) { $('sdChars').innerHTML = '<div class="number-empty">角色读取失败</div>'; return; }

  const chars = data.characters || [];
  const rels = data.relations || [];
  const byName = new Map();
  for (const rel of rels) {
    for (const side of ['a', 'b']) {
      const name = rel[side];
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ ...rel, other: side === 'a' ? rel.b : rel.a, myRole: side === 'a' ? rel.aRole : rel.bRole, otherRole: side === 'a' ? rel.bRole : rel.aRole });
    }
  }

  const block = chars.map((c) => {
    const list = byName.get(c.name) || [];
    const iden = list.filter((x) => x.kind !== 'reference');
    const ref = list.filter((x) => x.kind === 'reference');
    const row = (label, value) => '<div class="sd-field"><span class="k">' + label + '</span><span class="v">' + value + '</span></div>';
    const relRow = (x, cls) => '<div class="sd-field"><span class="k">' + cls + '</span><span class="v">'
      + esc(x.other) + ' ｜ ' + esc(x.myRole || '—') + ' ↔ ' + esc(x.otherRole || '—')
      + (x.scenes && x.scenes.length ? ' ｜ ' + esc(x.scenes.slice(0, 3).join(' ')) : '')
      + '</span></div>';
    return '<div class="sd-charbox"><div class="sd-cid">' + esc(c.id) + '</div>'
      + row('姓名', esc(c.name))
      + row('社会身份', c.socialRole ? esc(c.socialRole) : '—')
      + row('性别', c.gender ? esc(c.gender) : '—')
      + row('年龄', Array.isArray(c.ages) && c.ages.length
          ? c.ages.map((a) => esc(String(a.age || a)) + (a.evidence && a.evidence.length ? '（S' + a.evidence.slice(0, 3).join(',S') + '）' : '')).join('、')
          : '—')
      + row('代称', (c.aliases || []).length ? esc(c.aliases.join(' / ')) : '—')
      + (iden.length ? iden.map((x) => relRow(x, '人物关系')).join('') : row('人物关系', '—'))
      + (ref.length ? ref.map((x) => relRow(x, '参考关系')).join('') : '')
      + row('出场', (c.scenes || []).length ? esc(c.scenes.slice(0, 5).join(' ')) : '—')
      + '</div>';
  }).join('') || '<div class="number-empty">还没有角色</div>';

  $('sdChars').innerHTML = '<h4>角色真名表（' + chars.length + '）</h4>' + block;
}
function setupSceneDetail() {
  if (setupSceneDetail.done) return;
  setupSceneDetail.done = true;
  (async () => {
    const list = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('sdBook');
    if (sel) sel.innerHTML = (list || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const cur = $('book')?.value;
    if (sel && cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    await loadSdList();
    if (state.view === 'scenedetail') await loadSdProgress();
  })();
  $('sdBook').addEventListener('change', () => { loadDetailCharacters();
    fingerprints.delete('sd-list:' + $('sdBook').value);
    fingerprints.delete('sd-progress:' + $('sdBook').value);
    fingerprints.delete('sd-selected:' + $('sdBook').value);
    loadSdList(); loadSdProgress();
  });

  $('sdVersion')?.addEventListener('change', async () => {
    const v = $('sdVersion').value;
    const id = $('sdBook')?.value || $('book')?.value;
    const scene = $('sdFrom')?.value || state.sdScene || '';
    if (!v || !id || !scene) return;
    const d = await fetch('/api/scenes/detail/version?id=' + encodeURIComponent(id) + '&scene=' + encodeURIComponent(scene) + '&v=' + encodeURIComponent(v)).then((r) => r.json()).catch(() => null);
    if (!d || d.error) return;
    if ($('sdBody')) $('sdBody').innerHTML = renderDetail(d);
  });

  $('sdRestore')?.addEventListener('click', async () => {
    const v = $('sdVersion')?.value;
    const id = $('sdBook')?.value || $('book')?.value;
    const scene = $('sdFrom')?.value || state.sdScene || '';
    if (!v || !id || !scene) return;
    const r = await fetch('/api/scenes/detail/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, scene, v: Number(v) }),
    }).then((x) => x.json()).catch(() => null);
    if (r && r.ok) {
      $('sdStatus').textContent = '已把 v' + v + ' 恢复为当前（新版本 v' + r.version + '）';
      loadSdVersions(scene);
      const d = await fetch('/api/scenes/detail/version?id=' + encodeURIComponent(id) + '&scene=' + encodeURIComponent(scene) + '&v=' + r.version).then((x) => x.json()).catch(() => null);
      if (d && !d.error && $('sdBody')) $('sdBody').innerHTML = renderDetail(d);
    }
  });

  $('sdRange').addEventListener('click', async () => {
    if ($('sdRange').dataset.mode === 'stop') {
      $('sdRange').disabled = true;
      $('sdStatus').textContent = '正在停止…';
      await fetch('/api/scenes/detail/stop', { method: 'POST' });
      // 等任务真正结束再恢复按钮
      const id = $('sdBook')?.value || $('book')?.value;
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const d = await fetch('/api/scenes/detail/progress?id=' + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
        if (!d || !d.running) break;
      }
      setSdRunning(false);
      $('sdStatus').textContent = '已停止';
      return;
    }
    runDetailRange(false);
  });
  $('sdAll').addEventListener('click', () => runDetailRange(true));
  if ($('sdRun')) $('sdRun').addEventListener('click', () => runSdGenerate());
}

function setSdRunning(running) {
  const btn = $('sdRange');
  if (!btn) return;
  if (running) {
    btn.dataset.mode = 'stop';
    btn.textContent = '停止';
    btn.classList.add('danger');
    btn.disabled = false;
  } else {
    btn.dataset.mode = '';
    btn.textContent = '生成所选范围';
    btn.classList.remove('danger');
    btn.disabled = false;
  }
}

async function runDetailRange(all) {
  const id = $('sdBook')?.value || $('book')?.value;
  if (!id) return;
  const globalBook = $('book')?.value;
  if (globalBook && globalBook !== id) {
    $('sdStatus').textContent = '注意：详情页选的是「' + id + '」，顶部全局书目是「' + globalBook + '」，本次按「' + id + '」生成';
  }
  const opts = [...($('sdFrom')?.options || [])].map((o) => o.value).filter(Boolean);
  const fromVal = $('sdFrom')?.value || opts[0] || '';
  const toVal = $('sdTo')?.value || opts[opts.length - 1] || fromVal;
  const force = !($('sdSkipDone')?.checked);
  const body = all
    ? { id, force, from: $('sdFrom')?.options[0]?.value, to: ($('sdFrom')?.options[($('sdFrom')?.options.length || 1) - 1])?.value }
    : { id, force, from: fromVal, to: toVal };
  setSdRunning(true);
  fingerprints.delete('sd-list:' + id);
  fingerprints.delete('sd-progress:' + id);
  $('sdStatus').textContent = '已开始生成…';
  const r = await fetch('/api/scenes/detail/range', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { setSdRunning(false); $('sdStatus').textContent = d.error || '启动失败'; return; }
  if (d.willRun === 0) {
    setSdRunning(false);
    $('sdStatus').textContent = '所选 ' + d.count + ' 场都已完成，本次没有生成。取消勾选「跳过已完成」可强制重生成';
    return;
  }
  $('sdStatus').textContent = '已开始（' + id + ' · ' + (d.range || '') + '，共 ' + (d.count || 0) + ' 场），正在生成 ' + d.range + '（共 ' + d.count + ' 场）';
  stopPoll('sd-progress');
  startPoll('sd-progress', loadSdProgress, 4000);
}

let lastSdDone = -1;

async function loadSdProgress() {
  const id = $('sdBook')?.value;
  if (!id) return;
  const data = await fetch('/api/scenes/detail/progress?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data || state.view !== 'scenedetail' || $('sdBook')?.value !== id) return;
  setSdRunning(Boolean(data.running));
  if (!dataChanged('sd-progress:' + id, data)) return;
  /* 进度条已移除 */
  // 每完成一场就刷新左侧列表（实时）
  if (data.done !== lastSdDone) { lastSdDone = data.done; loadSdList().catch(() => {}); loadDetailCharacters().catch(() => {}); }
  if (data.running && data.runningScene) {
    if (data.jobInfo && data.jobInfo.running) {
    $('sdStatus').textContent = '正在生成 ' + (data.jobInfo.range || '') + '　全书已生成 ' + (data.done || 0) + '/' + (data.total || 0);
  } else {
    $('sdStatus').textContent = (data.percent || 0) + '%　场景 ' + (data.done || 0) + '/' + (data.total || 0);
  }
  } else {
    $('sdStatus').textContent = data.percent + '%　' + (data.percent === 100 ? '已完成' : '未运行')
      + '　场景 ' + data.done + '/' + data.total;
  }
  if (!data.running && data.percent === 100) { stopPoll('sd-progress'); await loadSdList(); }
}

async function loadSdVersions(sceneId) {
  const sel = $('sdVersion');
  if (!sel) return;
  const id = $('sdBook')?.value || $('book')?.value;
  if (!id || !sceneId) { sel.innerHTML = ''; sel.hidden = true; return; }
  const d = await fetch('/api/scenes/detail/versions?id=' + encodeURIComponent(id) + '&scene=' + encodeURIComponent(sceneId)).then((r) => r.json()).catch(() => null);
  const list = (d && d.versions) || [];
  if (list.length <= 1) { sel.hidden = true; sel.innerHTML = ''; if ($('sdRestore')) $('sdRestore').hidden = true; return; }
  sel.hidden = false;
  if ($('sdRestore')) $('sdRestore').hidden = false;
  sel.innerHTML = list.map((v) => '<option value="' + v.version + '">v' + v.version + '（情节 ' + v.steps + '）</option>').join('');
  sel.value = String(list[list.length - 1].version);
}

async function loadSdList() {
  const id = $('sdBook')?.value;
  if (!id) return;
  const data = await fetch('/api/scenes/detail/list?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => ({}));
  if (state.view !== 'scenedetail' || $('sdBook')?.value !== id) return;
  if (!data || !data.scenes || !data.scenes.length) { $('sdList').innerHTML = '<div class="number-empty">' + ((data && data.error) || '没有场景切分') + '</div>'; return; }
  if (!dataChanged('sd-list:' + id, data)) return;
  if (window.__sdBook !== id) {
    window.__sdBook = id;
    window.__sdScene = null;
    if ($('sdFrom')) $('sdFrom').innerHTML = '';
    if ($('sdTo')) $('sdTo').innerHTML = '';
  }
  const fromSel = $('sdFrom'), toSel = $('sdTo');
  if (fromSel && toSel && !fromSel.options.length) {
    const opts = data.scenes.map((s) => '<option value="' + s.sceneId + '">' + s.sceneId + '</option>').join('');
    fromSel.innerHTML = opts; toSel.innerHTML = opts;
    toSel.value = (data.scenes[data.scenes.length - 1] || {}).sceneId || '';
  }
  $('sdList').innerHTML = data.scenes.map((s) => {
    const state = s.done ? 'done' : (s.partial ? 'partial' : (s.failed ? 'fail' : 'todo'));
    const label = s.done ? (s.detailId || '已生成') : (s.partial ? '不完整' : (s.failed ? '失败' : '未生成'));
    const tip = s.failed ? ' title="' + esc(s.problem || '生成失败') + '"' : '';
    return '<div class="sd-row' + (s.failed ? ' sd-row-failed' : '') + '" data-scene="' + s.sceneId + '"' + tip + '>'
      + '<span class="sd-id">' + s.sceneId + '</span>'
      + '<span class="sd-main"><span class="t">' + esc(s.chapterTitle || '') + '</span>'
      + '<small>' + s.from + '~' + s.to + '（' + s.sentences + ' 句 ' + (s.chars ? '· ' + s.chars + ' 字' : '') + '）' + (s.done ? ' · 人物 ' + s.characters + ' · 情节 ' + s.beats : (s.failed ? ' · ' + esc(s.problem || '生成失败') : '')) + '</small></span>'
      + '<span class="sd-badge ' + state + '">' + label + '</span>'
      + '</div>';
  }).join('');
  $('sdList').onclick = (event) => {
    const row = event.target.closest('[data-scene]');
    if (!row) return;
    $('sdList').querySelectorAll('.sd-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    window.__sdScene = row.dataset.scene;
    loadSdDetail(row.dataset.scene);
  };
  if (!window.__sdScene) {
    const first = data.scenes.find((s) => s.done) || data.scenes[0];
    if (first) window.__sdScene = first.sceneId;
  }
  const row = $('sdList').querySelector('[data-scene="' + window.__sdScene + '"]');
  if (row) row.classList.add('active');
  if (dataChanged('sd-selected:' + id, data.scenes.find((s) => s.sceneId === window.__sdScene))) loadSdDetail(window.__sdScene);
}

async function loadSdDetail(sceneId) {
  const id = $('sdBook')?.value;
  const sid = sceneId || window.__sdScene;
  if (!id || !sid) return;
  const data = await fetch('/api/scenes/detail?id=' + encodeURIComponent(id) + '&sceneId=' + encodeURIComponent(sid)).then((r) => r.json()).catch(() => ({}));
  if (!data.ok) { $('sdBody').innerHTML = '<div class="number-empty">' + sid + ' 还没有详述，点右上角「生成当前场景详述」</div>'; return; }
  renderSceneDetail(data.detail, sid);
}

async function runSdGenerate() {
  const id = $('sdBook')?.value;
  const sid = window.__sdScene;
  if (!id || !sid) return;
  $('sdStatus').textContent = '生成 ' + sid + ' 中…（约 30–60 秒）';
  $('sdRun').disabled = true;
  try {
    const data = await fetch('/api/scenes/detail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, sceneId: sid }) }).then((r) => r.json()).catch(() => ({}));
    if (!data.ok) { $('sdStatus').textContent = data.error || '失败'; return; }
    renderSceneDetail(data.detail, sid);
    $('sdStatus').textContent = '已生成 ' + (data.detailId || '') + '（' + sid + '）';
    await loadSdList();
  } finally {
    $('sdRun').disabled = false;
  }
}

function renderSceneDetail(detail, sceneId) {

  const parts = [];
  parts.push('<div class="sd-h">' + esc(detail.detailId || '') + ' · ' + esc(sceneId) + ' 场景详述'
    + ' <a href="#" class="sd-jump" data-scene="' + sceneId + '">查看原文 ↗</a>'
    + ' <a href="#" class="sd-log" data-scene="' + sceneId + '">日志</a></div>');
  if (Array.isArray(detail['人物']) && detail['人物'].length) {
    // 按在情节里出现的次数排序，只展示前 10 人，其余折叠
    const stepsText = (detail['情节'] || []).map((x) => String(x['内容'] || '')).join('\n');
    const scored = detail['人物'].map((p) => {
      const nm = String(p['姓名'] || '');
      const hits = nm ? stepsText.split(nm).length - 1 : 0;
      return { p, hits };
    }).sort((a, b) => b.hits - a.hits);
    const top = scored.slice(0, 10);
    const rest = scored.slice(10);
    const line = ({ p }) => {
      const ev = Array.isArray(p['证据句']) ? p['证据句'] : [];
      const social = p['社会身份'] ? '（' + esc(p['社会身份']) + '）' : '';
      const gender = p['性别'] ? ' <span class="sd-gender">' + esc(p['性别']) + '</span>' : '';
      const ages = Array.isArray(p['年龄'])
        ? p['年龄'].map((a) => {
            const v = typeof a === 'string' ? a : (a && (a['年龄'] || a.age)) || '';
            const ev = (a && (a['证据句'] || a.evidence) || []).slice(0, 3);
            if (!v) return '';
            return '<span class="sd-age" title="证据句 S' + ev.join(',S') + '">' + esc(v) + (ev.length ? '（S' + ev.join(',S') + '）' : '') + '</span>';
          }).filter(Boolean).join(' ')
        : '';
      return '<div class="sd-item"><b>' + esc(p['姓名'] || '') + '</b>' + social + gender + (ages ? ' ' + ages : '') + '：' + esc(p['在本场做的事'] || '')
        + (ev.length ? ' <span class="sd-ev">S' + ev.join(',S') + '</span>' : '') + '</div>';
    };
    parts.push('<div class="sd-h">出场人物（' + detail['人物'].length + '）</div>');
    parts.push(top.map(line).join(''));
    if (rest.length) {
      parts.push('<details class="ct-fold"><summary>其余 ' + rest.length + ' 人（本场戏份少）</summary>'
        + rest.map(line).join('') + '</details>');
    }
  }

  if (Array.isArray(detail['情节']) && detail['情节'].length) {
    parts.push('<div class="sd-h">情节经过</div>');
    for (const step of detail['情节']) {
      const ev = Array.isArray(step['证据句']) ? step['证据句'] : [];
      parts.push('<div class="sd-item">' + esc(step['步骤'] || '') + '. ' + esc(step['内容'] || '')
        + (ev.length ? ' <span class="sd-ev">S' + ev.join(',S') + '</span>' : '') + '</div>');
    }
  }
  if ($('tcbDuration')) {
    const ms = Number(detail['durationMs'] || 0);
    const sec = ms ? Math.round(ms / 1000) : 0;
    const txt = sec >= 60 ? (Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒') : (sec ? sec + ' 秒' : '');
    $('tcbDuration').textContent = txt ? '本场生成耗时 ' + txt : '';
  }
  // 缓存：优先显示本场平均（多步汇总），没有再退回最后一次
  if ($('cacheBadge')) {
    const c = detail['缓存'];
    if (c && c.total) {
      $('cacheBadge').textContent = '缓存 ' + c.pct + '%（本场 ' + c.calls + ' 次）';
      $('cacheBadge').className = 'cache-badge' + (c.pct >= 60 ? ' good' : (c.pct >= 20 ? ' mid' : ''));
    }
  }
  const summary = String(detail['提要'] || '').trim();
  if (summary) {
    parts.push('<div class="sd-h">本场提要</div>');
    parts.push('<div class="sd-summary">' + esc(summary).replace(/\n/g, '<br>') + '</div>');
  }

  const qs = detail['疑问'] || detail['疑点'] || [];
  if (Array.isArray(qs) && qs.length) {
    parts.push('<div class="sd-h">疑问（' + qs.length + '）</div>');
    for (const q of qs) {
      if (typeof q === 'string') { parts.push('<div class="sd-item">· ' + esc(q) + '</div>'); continue; }
      const type = esc((q['编号'] ? q['编号'] + ' · ' : '') + (q['类型'] || '疑问'));
      const ev = Array.isArray(q['证据句']) ? q['证据句'].join('、') : '';
      parts.push('<div class="sd-item"><span class="sd-tag">' + type + '</span>' + esc(q['描述'] || '')
        + (q['预处理'] ? '<br><small>预处理：' + esc(String(q['预处理']).slice(0, 80)) + '</small>' : '')
        + (q['分析'] ? '<br><small>本场：' + esc(String(q['分析']).slice(0, 80)) + '</small>' : '')
        + '<br><small>证据：' + ((Array.isArray(q['证据句']) && q['证据句'].length) ? q['证据句'].map((n) => '<a href="#" class="sd-ev" data-sent="' + esc(String(n)) + '">S' + esc(String(n)) + '</a>').join('、') : '<span style="color:#c0392b">无证据句</span>') + '</small></div>');
    }
  }
  $('sdBody').innerHTML = parts.join('');
  for (const ev of $('sdBody').querySelectorAll('.sd-ev')) {
    ev.addEventListener('click', async (event) => {
      event.preventDefault();
      switchView('scenesview');
      await loadScenesView();
      const row = $('svList').querySelector('[data-scene="' + sceneId + '"]');
      if (row) row.click();
      // 等场景正文渲染出来再定位（最多重试 12 次）
      const mark = async () => {
        for (let i = 0; i < 12; i += 1) {
          const target = document.getElementById('s-' + ev.dataset.sent);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('flash');
            setTimeout(() => target.classList.remove('flash'), 2000);
            return true;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return false;
      };
      await mark();
    });
  }
  const sdLog = $('sdBody').querySelector('.sd-log');
  if (sdLog) {
    sdLog.addEventListener('click', (event) => {
      event.preventDefault();
      // 复用底部日志按钮的逻辑：它已按「当前场景」筛选本轮调用
      document.getElementById('tcbActualBtn')?.click();
    });
  }

  const jump = $('sdBody').querySelector('.sd-jump');
  if (jump) {
    jump.addEventListener('click', async (event) => {
      event.preventDefault();
      switchView('scenesview');
      await loadScenesView();
      const row = $('svList').querySelector('[data-scene="' + jump.dataset.scene + '"]');
      if (row) row.click();
    });
  }
}

async function loadScenesPartial() {
  const id = $('svBookSel')?.value || $('book')?.value;
  const box = $('svMeta') || $('scenesStatus');
  if (!id || !box) return;
  const d = await fetch('/api/scenes/partial?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!d) return;
  if (d.finished) return;
  if (!d.done && !d.partialScenes) return;
  box.textContent = '切分中：已完成 ' + d.done + '/' + d.total + ' 章，暂存场景 ' + d.partialScenes + ' 个'
    + (d.missing && d.missing.length ? '；缺 ' + d.missing.slice(0, 5).join(',') + (d.missing.length > 5 ? ' 等' : '') : '');
}

function setupScenesView() {
  if (setupScenesView.done) return;
  setupScenesView.done = true;
  $('svReload').addEventListener('click', () => loadScenesView());
  $('svBookSel').addEventListener('change', () => {
    fingerprints.delete('scenes-list:' + $('svBookSel').value);
    fingerprints.delete('scenes-progress:' + $('svBookSel').value);
    loadScenesView(); loadScenesProgress();
  });
  window.__svResume = loadScenesProgress;

  (async () => {
    const list = await fetch('/api/books').then((r) => r.json()).catch(() => []);
    const sel = $('svBookSel');
    if (sel) sel.innerHTML = (list || []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>').join('');
    const current = $('book')?.value;
    if (sel && current) sel.value = current;
    if (state.view === 'scenesview') { loadScenesView(); loadScenesProgress(); }
  })();

  $('svImport').addEventListener('click', async () => {
    const id = $('svBookSel')?.value || $('book')?.value;
    if (!id) return;
    $('svMeta').textContent = '重新切分全书（每章一次模型调用，约 10 秒/章）…';
    $('svImport').disabled = true;
    try {
      const r = await fetch('/api/scenes/segment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const data = await r.json().catch(() => ({}));
      if (!data.ok) { $('svMeta').textContent = data.error || '切分失败'; return; }
      stopPoll('scenes-progress');
      startPoll('scenes-progress', loadScenesProgress, 4000);
    } finally {
      $('svImport').disabled = false;
    }
  });
}

async function loadScenesProgress() {
  const id = $('svBookSel')?.value || $('book')?.value;
  if (!id) return;
  const data = await fetch('/api/scenes/progress?id=' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null);
  if (!data || state.view !== 'scenesview' || ($('svBookSel')?.value || $('book')?.value) !== id) return;
  if (!dataChanged('scenes-progress:' + id, data)) return;
  if ($('svBar')) $('svBar').querySelector('i').style.width = data.percent + '%';
  if (data.phase && data.phase.phase === 'refine') {
    $('svMeta').textContent = '100%（已切分 ' + data.done + '/' + data.total + ' 句）· 正在细化切分（模型重新切分超长或过短场景）…';
    if ($('svBar')) $('svBar').querySelector('i').style.width = '100%';
    return;
  }
  $('svMeta').textContent = data.running
    ? data.percent + '%（已切分 ' + data.done + '/' + data.total + ' 句，章 ' + data.chaptersDone + '/' + data.chaptersTotal + '）'
    : (data.percent === 100 ? '切分完成：' : '切分进度：') + data.percent + '%（' + data.done + '/' + data.total + ' 句）';
  window.__svRunning = Boolean(data.running);
  if (!data.running && data.percent === 100) { stopPoll('scenes-progress'); await loadScenesView(); }
}

async function loadScenesView() {
  const bookId = $('svBookSel')?.value || $('book')?.value;
  if (!bookId) return;
  const data = await fetch('/api/scenes/llm?id=' + encodeURIComponent(bookId)).then((r) => r.json()).catch(() => ({}));
  if (state.view !== 'scenesview' || ($('svBookSel')?.value || $('book')?.value) !== bookId) return;
  if (!data.scenes || !data.scenes.length) {
    if (window.__svRunning) return; // 切分进行中，交给进度轮询显示
    $('svMeta').textContent = data.error || '没有场景切分结果';
    $('svList').innerHTML = '';
    $('svDetail').innerHTML = '<div class="number-empty">这本书还没有切分结果</div>';
    return;
  }
  if (!dataChanged('scenes-list:' + bookId, data)) return;
  const selectedScene = window.__svBook === bookId ? $('svList').querySelector('.sv-row.active')?.dataset.scene : null;
  window.__svBook = bookId;
  $('svMeta').textContent = data.totals.chapters + ' 章 · ' + data.totals.scenes + ' 场景 · 平均 ' + data.totals.avgSentences + ' 句';
  $('svList').innerHTML = data.scenes.map((s) =>
    '<div class="sv-row" data-scene="' + s.sceneId + '">' + s.sceneId + ' · ' + s.chapterId + ' <small>' + s.from + '~' + s.to + '（' + s.sentences + ' 句）</small><span class="sv-prev">' + esc(s.preview || '') + '</span></div>'
  ).join('');
  $('svList').onclick = (event) => {
    const row = event.target.closest('[data-scene]');
    if (!row) return;
    const scene = data.scenes.find((s) => s.sceneId === row.dataset.scene);
    if (!scene) return;
    $('svList').querySelectorAll('.sv-row.active').forEach((el) => el.classList.remove('active'));
    row.classList.add('active');
    $('svDetail').innerHTML = '<div class="sv-title2">' + esc(scene.sceneId) + ' · ' + esc(scene.chapterTitle || scene.chapterId) + '</div>'
      + '<div class="sv-range">' + scene.from + ' ~ ' + scene.to + '（' + scene.sentences + ' 句，来源 ' + (scene.source === 'model' ? '模型' : '规则') + '）</div>'
      + '<div class="sv-text">' + ((scene.lines && scene.lines.length)
        ? scene.lines.map((x) => '<span class="sv-line" id="s-' + x.n + '">S' + x.n + ' ' + esc(x.text) + '</span>').join('')
        : esc(scene.preview || '')) + '</div>';
  };
  const selectedRow = selectedScene && $('svList').querySelector('[data-scene="' + selectedScene + '"]');
  if (selectedRow) selectedRow.click();
}

function setupCards() {
  // 顶部「场景 / 人物卡」切换：人物卡单独占一整页，不再塞在小弹窗里。
  document.querySelectorAll('.viewtab').forEach((tab) => {
    tab.onclick = () => switchView(tab.dataset.view);
  });
  const search = $('cardSearch');
  if (search) search.oninput = () => renderCards(search.value.trim());
}


// 全局书目标识：所有标签页必须跟顶部同一个书，避免各页显示不同书的数据
const BOOK_SELECT_IDS = ['book','rcBook','ctBook','lkBook','rlBook','dlBook','apBook','erBook','dtBook','sdBook','chBookSel','svBookSel','numberBookSel','wfBook','cdBook'];

// 书库可能新增书籍：切页时重新拉书目，保证所有下拉框都能看到新书
async function refreshBookSelects() {
  let books = [];
  try { books = await fetch('/api/books').then((r) => r.json()); } catch { return; }
  if (!Array.isArray(books)) return;
  const ids = books.map((b) => b.id).join('|');
  if (refreshBookSelects.cache === ids) return;
  refreshBookSelects.cache = ids;
  for (const sel of BOOK_SELECT_IDS.map((id) => document.getElementById(id)).filter(Boolean)) {
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = books
      .map((b) => '<option value="' + esc(b.id) + '">' + esc(b.title || b.id) + '</option>')
      .join('');
    if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  }
}

function syncBookEverywhere(id) {
  if (!id) return;
  for (const sel of document.querySelectorAll('#book,#rcBook,#sdBook,#chBookSel,#svBookSel,#numberBookSel,#wfBook')) {
    if (!sel) continue;
    if (![...sel.options].some((o) => o.value === id)) continue;
    if (sel.value !== id) sel.value = id;
  }
}

function syncLocalBook(selId) {
  const gb = $('book')?.value;
  const sel = $(selId);
  if (!gb || !sel) return;
  if (sel.value === gb) return;
  if (![...sel.options].some((o) => o.value === gb)) return;
  sel.value = gb;
  sel.dispatchEvent(new Event('change'));
}

function switchView(view) {
  if (view === 'scenes' || view === 'cards') view = 'pipeline';
  for (const key of ['scenes-progress', 'scenes-list', 'sd-progress', 'sd-list', 'characters', 'pipeline']) stopPoll(key);
  refreshBookSelects().then(() => syncBookEverywhere($('book')?.value));
  state.view = view;
  sessionStorage.setItem('corpus.view', view);
  document.querySelectorAll('.viewtab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  if (typeof loadTabConfig === 'function') loadTabConfig(view);
  const isTable = ['cardboard','dialog','dirty','appear','erotic'].includes(view);
  if ($('tblVersionBar')) $('tblVersionBar').hidden = !isTable;
  if ($('tblVersionBody') && !isTable) $('tblVersionBody').hidden = true;
  if (typeof loadTableVersions === 'function' && isTable) loadTableVersions(view);
  if ($('promptsPage')) $('promptsPage').hidden = view !== 'prompts';
  if (view === 'prompts' && typeof loadPromptList === 'function') loadPromptList();
  if (view === 'scenedetail') syncLocalBook('sdBook');
  if (view === 'correct') syncLocalBook('ctBook');
  if (view === 'link') syncLocalBook('lkBook');
  if (view === 'relink') syncLocalBook('rlBook');
  if (view === 'cardboard') syncLocalBook('cdBook');
  if (view === 'cardboard' && typeof loadCardBoardChapters === 'function') setTimeout(() => loadCardBoardChapters().catch((e) => console.error('cards 加载失败', e)), 200);
  if (view === 'dialog') syncLocalBook('dlBook');
  if (view === 'dirty') syncLocalBook('dtBook');
  if (view === 'appear') syncLocalBook('apBook');
  if (view === 'erotic') syncLocalBook('erBook');
  if ($('filters')) $('filters').hidden = view !== 'scenes';
  const layoutEl = document.querySelector('.layout');
  if (layoutEl) layoutEl.hidden = view !== 'scenes';
  $('cardsPage').hidden = view !== 'cardboard';
  if (view === 'cardboard') loadCards();
  if ($('dirtyPage')) $('dirtyPage').hidden = view !== 'dirty';
  if (view === 'dirty') loadDirty();
  if ($('eroticPage')) $('eroticPage').hidden = view !== 'erotic';
  if (view === 'erotic') loadErotic();
  if ($('appearPage')) $('appearPage').hidden = view !== 'appear';
  if (view === 'appear') loadAppear();
  if ($('dialogPage')) $('dialogPage').hidden = view !== 'dialog';
  if (view === 'dialog') loadDialogScenes();
  $('pipelinePage').hidden = view !== 'pipeline';
  if ($('numberPage')) $('numberPage').hidden = view !== 'number';
  if ($('cleanPage')) $('cleanPage').hidden = view !== 'clean';
  if ($('scenesViewPage')) $('scenesViewPage').hidden = view !== 'scenesview';
  if (view === 'scenesview') {
    loadScenesPartial(); loadScenesView(); startPoll('scenes-view', loadScenesView, 6000); }
  if ($('charactersPage')) $('charactersPage').hidden = view !== 'characters';
  if ($('sceneDetailPage')) $('sceneDetailPage').hidden = view !== 'scenedetail';
  if ($('reconcilePage')) $('reconcilePage').hidden = view !== 'reconcile';
  if ($('correctPage')) $('correctPage').hidden = view !== 'correct';
  if ($('linkPage')) $('linkPage').hidden = view !== 'link';
  if ($('relinkPage')) $('relinkPage').hidden = view !== 'relink';
  if (view === 'relink') loadRelinkReport();
  if (view === 'link') loadLinkScenes();
  if (view === 'correct') loadCorrectReport();
  if ($('pipelinePage')) $('pipelinePage').hidden = view !== 'pipeline';
  if (view === 'pipeline') { loadWorkflow(); startPoll('workflow', loadWorkflow, 5000); }
  if (view === 'reconcile') { loadReconcileList(); startPoll('reconcile-list', loadReconcileList, 6000); }
  if (view === 'scenedetail') {
    // sdBook 跟随全局：进入本页时强制对齐，避免用错书生成
    const gb = $('book')?.value;
    if (gb && $('sdBook') && $('sdBook').value !== gb && [...$('sdBook').options].some((o) => o.value === gb)) {
      $('sdBook').value = gb;
      fingerprints.delete('sd-list:' + gb);
    }
    loadSdList(); loadSdProgress(); loadDetailCharacters(); startPoll('sd-list', loadSdList, 6000);
    startPoll('sd-progress', loadSdProgress, 4000);
    startPoll('sd-list', loadSdList, 8000);
  }
  if (view === 'characters') {
    loadCharacters().finally(() => {
      if (state.view === 'characters') startPoll('characters', () => loadCharacters({ totalsOnly: true }), 8000);
    });
  }
  if (view === 'scenesview') {
    startPoll('scenes-progress', loadScenesProgress, 4000);
    startPoll('scenes-list', loadScenesView, 10000);
  }
  if (view === 'cards') renderCards($('cardSearch')?.value.trim() || '');
    else if (view === 'pipeline') { startPoll('workflow', loadWorkflow, 5000); }
  else if (view !== 'number') renderList();
}

const CARD_FIELDS = [
  ['身份', '身份'], ['年龄', '年龄'], ['外貌', '外貌概述'], ['性格', '性格概述'],
  ['语言风格', '语言风格概述'], ['能力与弱点', '能力与弱点'], ['情欲偏好', '情欲偏好'],
  ['变化轨迹', '变化轨迹'], ['矛盾点', '矛盾点'],
];

function renderCards(keyword = '') {
  const cards = state.book?.cards;
  const list = $('cardsList');
  if (!cards || !Object.keys(cards).length) {
    list.innerHTML = '<div class="card-empty">还没有人物卡。<br/>运行 <code>node cli.mjs cards --work "…"</code> 生成。</div>';
    $('cardDetail').innerHTML = '';
    return;
  }
  const query = String(keyword || '').trim();
  const entries = Object.values(cards)
    .filter((card) => !query || String(card.姓名 || '').includes(query) || (card.别名 || []).some((alias) => String(alias).includes(query)))
    .sort((a, b) => (b.出现场次 || 0) - (a.出现场次 || 0));
  if (!entries.length) {
    list.innerHTML = '<div class="card-empty">没有匹配的人物</div>';
    return;
  }
  list.innerHTML = entries.map((card, index) => `
    <button class="card-item${index === 0 ? ' active' : ''}" data-name="${esc(card.姓名)}">
      <span class="card-name">${esc(card.姓名)}</span>
      <span class="card-count">${card.出现场次 || 0} 场</span>
    </button>`).join('');
  list.querySelectorAll('[data-name]').forEach((button) => {
    button.onclick = () => {
      list.querySelectorAll('.card-item').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      renderCardDetail(button.dataset.name);
    };
  });
  renderCardDetail(entries[0].姓名);
}

function renderCardDetail(name) {
  const card = state.book?.cards?.[name];
  if (!card) return;
  const rows = CARD_FIELDS
    .filter(([key]) => card[key])
    .map(([key, label]) => `<div class="card-field"><div class="card-label">${label}</div><div class="card-value">${esc(card[key])}</div></div>`)
    .join('');

  // 台词库：这个人说过的全部原话，按场次排。
  const dialogueBlock = (card.台词库 || []).length
    ? `<div class="card-field"><div class="card-label">台词库（${card.台词条数 || card.台词库.length} 句）</div><div class="card-value"><details class="ero-part"><summary>展开全部 ${card.台词条数 || card.台词库.length} 句</summary><div class="ero-entries">${card.台词库.map((item) =>
      `<div class="tl-node">
        <div class="tl-head"><span class="tag">${esc(item.场合 || '')}</span><span class="muted">${esc(item.场次)}·第${esc(item.章)}章${item.对谁说 ? ' · 对' + esc(item.对谁说) + '说' : ''}</span><a href="#" data-jump="${esc(item.场次)}">跳转</a></div>
        ${item.情境 ? `<div class="tl-text">${esc(item.情境)}</div>` : ''}
        <div class="ero-quote">「${esc(item.台词 || '')}」</div>
      </div>`).join('')}</div></details></div></div>`
    : '';

  // 衣着档案：一条一句情境，说清"为什么穿这身"，再附原文。
  const outfitBlock = (card.衣着档案 || []).length
    ? `<div class="card-field"><div class="card-label">衣着档案（${card.衣着条数 || card.衣着档案.length} 条）</div><div class="card-value"><details class="ero-part" open><summary>展开 / 收起</summary><div class="ero-entries">${card.衣着档案.map((item) =>
      `<div class="tl-node">
        <div class="tl-head"><span class="tag">${esc(item.场合大类 || '其他')}</span><span class="tl-name">${esc(item.描写 || '')}</span><span class="muted">${esc(item.场次)}·第${esc(item.章)}章</span><a href="#" data-jump="${esc(item.场次)}">跳转</a></div>
        <div class="tl-text">${esc(item.情境 || item.背景 || '')}</div>
        ${(item.在场 || []).length ? `<div class="tl-people">在场：${item.在场.map((p) => esc(p)).join('、')}</div>` : ''}
        <div class="ero-quote">${esc(item.引文 || '')}</div>
      </div>`).join('')}</div></details></div></div>`
    : '';

  // 语言档案：在什么情境下怎么说话，每条带一句原文。
  const speechBlock = (card.语言档案 || []).length
    ? `<div class="card-field"><div class="card-label">语言档案（${card.语言条数 || card.语言档案.length} 个情境）</div><div class="card-value"><details class="ero-part" open><summary>展开 / 收起</summary><div class="ero-entries">${card.语言档案.map((item) =>
      `<div class="tl-node"><div class="tl-head"><span class="tl-name">${esc(item.情境 || '')}</span><a href="#" data-jump="${esc(item.场次 || '')}">${esc(item.场次 || '')}</a></div><div class="tl-text">${esc(item.特点 || '')}</div>${item.例句 ? `<div class="ero-quote">「${esc(item.例句)}」</div>` : ''}</div>`).join('')}</div></details></div></div>`
    : '';

  // 性格档案：按情境分开，避免"高冷"和"温顺"互相打架。
  const personalityBlock = (card.性格档案 || []).length
    ? `<div class="card-field"><div class="card-label">性格档案（${card.性格条数 || card.性格档案.length} 个情境）</div><div class="card-value"><details class="ero-part" open><summary>展开 / 收起</summary><div class="ero-entries">${card.性格档案.map((item) =>
      `<div class="tl-node"><div class="tl-head"><span class="tl-name">${esc(item.情境 || '')}</span><a href="#" data-jump="${esc(item.场次 || '')}">${esc(item.场次 || '')}</a></div><div class="tl-text">${esc(item.表现 || '')}</div></div>`).join('')}</div></details></div></div>`
    : '';

  // 外貌档案：原文逐条罗列，不做概括（概括留在「外貌概述」里）。
  const appearanceBlock = (card.外貌档案 || []).length
    ? `<div class="card-field"><div class="card-label">外貌档案（${card.外貌条数 || card.外貌档案.length} 条）</div><div class="card-value"><details class="ero-part" open><summary>展开 / 收起</summary><div class="ero-entries">${card.外貌档案.map((item) =>
      `<div class="ero-entry"><span class="ero-desc">${esc(item.描写 || '')}</span><span class="ero-quote">${esc(item.引文 || '')}　<a href="#" data-jump="${esc(item.场次)}">${esc(item.场次)}</a></span></div>`).join('')}</div></details></div></div>`
    : '';

  const aliases = (card.别名 || []).length
    ? `<div class="card-field"><div class="card-label">别名</div><div class="card-value">${card.别名.map((item) => `<span class="tag">${esc(item)}</span>`).join('')}</div></div>`
    : '';

  const habits = (card.习惯动作 || []).length
    ? `<div class="card-field"><div class="card-label">习惯动作</div><div class="card-value">${card.习惯动作.map((item) => `<span class="tag">${esc(item)}</span>`).join('')}</div></div>`
    : '';

  const relations = (card.关系网 || []).length
    ? `<div class="card-field"><div class="card-label">关系网</div><div class="card-value">${card.关系网.map((item) =>
      `<div class="card-line"><b>${esc(item.对象 || '')}</b>　${esc(item.关系 || '')}　<span class="muted">${esc(item.依据 || '')}</span></div>`).join('')}</div></div>`
    : '';

  // 人生轨迹：详细节点（时间线）。没有生成过就退回旧的「重要经历」。
  const timeline = card.人生轨迹 || [];
  const events = timeline.length
    ? `<div class="card-field"><div class="card-label">人生轨迹（${timeline.length} 个节点）</div><div class="card-value"><details class="ero-part" open><summary>展开 / 收起</summary><div class="ero-entries">${timeline.map((item) => `
      <div class="tl-node">
        <div class="tl-head"><span class="tl-name">${esc(item.节点 || '')}</span>${item.阶段 ? `<span class="tag">${esc(item.阶段)}</span>` : ''}<a href="#" data-jump="${esc(item.场次 || '')}">${esc(item.场次 || '')}</a></div>
        <div class="tl-text">${esc(item.发生了什么 || '')}</div>
        ${item.变化 ? `<div class="tl-change">变化：${esc(item.变化)}</div>` : ''}
        ${(item.涉及人 || []).length ? `<div class="tl-people">涉及：${item.涉及人.map((p) => esc(p)).join('、')}</div>` : ''}
      </div>`).join('')}</div></details></div></div>`
    : (card.重要经历 || []).length
      ? `<div class="card-field"><div class="card-label">人生轨迹</div><div class="card-value">${card.重要经历.map((item) =>
        `<div class="card-line">${esc(item.发生了什么 || '')}　<span class="muted">→ ${esc(item.结果 || '')}</span>　<a href="#" data-jump="${esc(item.场景 || '')}">${esc(item.场景 || '')}</a></div>`).join('')}</div></div>`
      : '';

  const sceneList = (card.场景列表 || []).length
    ? `<div class="card-field"><div class="card-label">出场场景（${card.场景列表.length}）</div><div class="card-value">${card.场景列表.map((id) =>
      `<a href="#" class="scene-link" data-jump="${esc(id)}">${esc(id)}</a>`).join(' ')}</div></div>`
    : '';

  // 身体档案：每个部位一个可折叠块，展开后是全部原文条目（不截断）。
  const bodyBlock = (card.身体档案 || []).length
    ? `<div class="card-field"><div class="card-label">身体档案（${card.身体档案.length} 个部位 · 共 ${card.身体条目总数 || 0} 条）</div><div class="card-value">${card.身体档案.map((item) => {
      const entries = item.条目 || [];
      const rowsHtml = entries.length
        ? entries.map((entry) => `<div class="ero-entry"><span class="ero-desc">${esc(entry.描写 || '')}</span><span class="ero-quote">${esc(entry.引文 || '')}　<a href="#" data-jump="${esc(entry.场次)}">${esc(entry.场次)}</a></span></div>`).join('')
        : '<div class="ero-entry muted">（无条目）</div>';
      return `<details class="ero-part"><summary><b>${esc(item.部位)}</b>　${item.出现场次 || 0} 场 · ${entries.length} 条</summary><div class="ero-entries">${rowsHtml}</div></details>`;
    }).join('')}</div></div>`
    : '';

  const poseBlock = (card.性爱姿势 || []).length
    ? `<div class="card-field"><div class="card-label">性爱姿势</div><div class="card-value">${card.性爱姿势.map((item) =>
      `<span class="tag">${esc(item.姿势)} ×${item.次数}</span>`).join('')}</div></div>`
    : '';

  const talkBlock = (card.淫语言录 || []).length
    ? `<div class="card-field"><div class="card-label">淫语言录（${card.淫语言录.length} 条）</div><div class="card-value"><details class="ero-part"><summary>展开全部 ${card.淫语言录.length} 条</summary><div class="ero-entries">${card.淫语言录.map((item) =>
      `<div class="ero-entry"><span class="ero-quote">「${esc(item.原话)}」　<a href="#" data-jump="${esc(item.场次)}">${esc(item.场次)}</a></span></div>`).join('')}</div></details></div></div>`
    : '';

  // 性反应 / 敏感点：每个词都能展开成它的原文出处，不只是数字。
  const quoteList = (label, items, keyName) => {
    if (!items || !items.length) return '';
    const rowsHtml = items.map((item) => {
      const entries = item.条目 || [];
      const inner = entries.length
        ? entries.map((entry) => `<div class="ero-entry"><span class="ero-quote">${esc(entry.引文 || '')}　<a href="#" data-jump="${esc(entry.场次)}">${esc(entry.场次)}</a></span></div>`).join('')
        : '<div class="ero-entry muted">（无引文）</div>';
      return `<details class="ero-part"><summary><b>${esc(item[keyName])}</b>　×${item.次数 || 0} · 引文 ${entries.length} 条</summary><div class="ero-entries">${inner}</div></details>`;
    }).join('');
    return `<div class="card-field"><div class="card-label">${label}</div><div class="card-value">${rowsHtml}</div></div>`;
  };

  const reactBlock = quoteList('性反应', card.性反应, '反应');
  const sensitiveBlock = quoteList('敏感点', card.敏感点, '部位');

  const passageBlock = (card.性爱描写原文 || []).length
    ? `<div class="card-field"><div class="card-label">性爱描写原文（${card.性爱描写条数 || card.性爱描写原文.length} 句）</div><div class="card-value"><details class="ero-part"><summary>展开全部 ${card.性爱描写条数 || card.性爱描写原文.length} 句</summary><div class="ero-entries">${card.性爱描写原文.map((item) =>
      `<div class="ero-entry"><span class="ero-quote">${esc(item.句)}　<a href="#" data-jump="${esc(item.场次)}">${esc(item.场次)}</a></span></div>`).join('')}</div></details></div></div>`
    : '';

  $('cardDetail').innerHTML = `
    <div class="card-title">${esc(card.姓名)}</div>
    ${aliases}${rows}${dialogueBlock}${outfitBlock}${speechBlock}${personalityBlock}${appearanceBlock}${habits}${relations}${events}${bodyBlock}${poseBlock}${passageBlock}${talkBlock}${reactBlock}${sensitiveBlock}${sceneList}`;

  $('cardDetail').querySelectorAll('[data-jump]').forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault();
      const id = link.dataset.jump;
      if (!id) return;
      goToScene(id);
    };
  });
}


/* ───────── 书库 ───────── */

async function openLibrary() {
  $('libraryModal').hidden = false;
  $('libraryList').innerHTML = '<div class="card-empty">读取中…</div>';
  try {
    const list = await fetch('/api/library').then((response) => response.json());
    renderLibrary(list);
  } catch (error) {
    $('libraryList').innerHTML = `<div class="card-empty">读取失败：${esc(error.message)}</div>`;
  }
}

async function openRemoteLibrary() {
  $('libraryModal').hidden = false;
  $('libraryList').innerHTML = '<div class="card-empty">读取远端仓库…</div>';
  try {
    const list = await fetch('/api/library/remote').then((response) => response.json());
    renderRemoteLibrary(list);
  } catch (error) {
    $('libraryList').innerHTML = '<div class="card-empty">读取失败：' + esc(error.message) + '</div>';
  }
}

function renderRemoteLibrary(list) {
  if (!Array.isArray(list) || !list.length) {
    $('libraryList').innerHTML = '<div class="card-empty">远端还没有 corpus-book-* 仓库</div>';
    return;
  }
  $('libraryList').innerHTML = list.map((r) => (
    '<div class="lib-row">'
      + '<div class="lib-main">'
      + '<div class="lib-title">' + esc(r.repo) + '</div>'
      + '<div class="lib-meta">' + esc(r.description || '') + (r.private ? ' · 私有' : ' · 公开') + ' · 更新 ' + esc(String(r.updatedAt || '').slice(0, 10)) + '</div>'
      + '</div>'
      + '<div class="lib-actions">'
      + '<a class="ghost" href="' + esc(r.url) + '" target="_blank">打开仓库</a>'
      + '<button class="ghost" data-restore="' + esc(r.repo) + '" type="button">恢复到本地</button>'
      + '</div>'
      + '</div>'
  )).join('');

  for (const button of $('libraryList').querySelectorAll('[data-restore]')) {
    button.onclick = async () => {
      const repo = button.dataset.restore;
      if (!confirm('把 ' + repo + ' 恢复到本地书库？同名书籍会先备份再覆盖。')) return;
      button.disabled = true;
      const old = button.textContent;
      button.textContent = '恢复中…';
      try {
        const res = await fetch('/api/library/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
        alert('已恢复：' + data.bookId + (data.backup ? '\n旧目录已备份：' + data.backup : ''));
        await openRemoteLibrary();
      } catch (error) {
        alert('恢复失败：' + error.message);
      } finally {
        button.disabled = false;
        button.textContent = old;
      }
    };
  }
}

function renderLibrary(list) {
  if (!Array.isArray(list) || !list.length) {
    $('libraryList').innerHTML = '<div class="card-empty">书库还是空的，先导入一本书</div>';
    return;
  }
  const uniq = [];
  const seen = new Set();
  for (const book of list) { if (seen.has(book.id)) continue; seen.add(book.id); uniq.push(book); }
  list = uniq;
  $('libraryList').innerHTML = list.map((book) => `
    <div class="lib-row">
      <div class="lib-main">
        <div class="lib-title">${esc(book.title || book.id)}</div>
        <div class="lib-meta">${book.chapters || 0} 章 · ${book.scenes || 0} 场 · ${book.paragraphs || 0} 段${book.github && book.github.url ? ` · <a href="${book.github.url}" target="_blank" data-ghurl="1">已在 GitHub${book.github.private ? '（私有）' : ''}</a>` : ''}</div>
      </div>
      <div class="lib-actions">
        <button class="ghost" data-open="${esc(book.id)}" type="button">打开</button>
        <button class="ghost" data-rename="${esc(book.id)}" type="button">改名</button>
        <button class="ghost" data-github="${esc(book.id)}" type="button">上传 GitHub</button>
        <button class="ghost" data-delete="${esc(book.id)}" type="button">删除</button>
      </div>
    </div>`).join('');

  for (const button of $('libraryList').querySelectorAll('[data-github]')) {
    button.onclick = async () => {
      const id = button.dataset.github;
      const repo = prompt('仓库名（默认 corpus-book-' + id + '）', 'corpus-book-' + id.replace(/[^\p{L}\p{N}._-]+/gu, '-'));
      if (!repo) return;
      const isPrivate = confirm('上传为私有仓库？\n确定=私有，取消=公开');
      button.disabled = true;
      const old = button.textContent;
      button.textContent = '上传中…';
      try {
        const res = await fetch('/api/library/github', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, repo, private: isPrivate }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
        alert('已上传：' + (data.url || data.repo) + '\n文件数：' + (data.files || 0));
      } catch (error) {
        alert('上传失败：' + error.message);
      } finally {
        button.disabled = false;
        button.textContent = old;
      }
    };
  }
  for (const button of $('libraryList').querySelectorAll('[data-open]')) {
    button.onclick = async () => {
      $('libraryModal').hidden = true;
      await refreshBooks(button.dataset.open);
    };
  }

  for (const button of $('libraryList').querySelectorAll('[data-rename]')) {
    button.onclick = async () => {
      const id = button.dataset.rename;
      const current = list.find((book) => book.id === id);
      const title = window.prompt('新书名', current?.title || id);
      if (!title) return;
      await fetch('/api/book/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, title }) });
      await openLibrary();
      await refreshBooks(id);
    };
  }

  for (const button of $('libraryList').querySelectorAll('[data-delete]')) {
    button.onclick = async () => {
      const id = button.dataset.delete;
      // 不用阻塞式 confirm（部分环境会被吞掉）
      const response = await fetch('/api/book/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        window.alert('删除失败：' + (err.error || response.status));
        return;
      }
      const result = await response.json();
      if (result.error) { window.alert(result.error); return; }
      await openLibrary();
      await refreshBooks();
    };
  }
}

function setupLibrary() {
  $('libraryBtn').onclick = openLibrary;
  if ($('libLocalBtn')) $('libLocalBtn').onclick = () => { $('libLocalBtn').classList.add('active'); $('libRemoteBtn')?.classList.remove('active'); openLibrary(); };
  if ($('libRemoteBtn')) $('libRemoteBtn').onclick = () => { $('libRemoteBtn').classList.add('active'); $('libLocalBtn')?.classList.remove('active'); openRemoteLibrary(); };
  $('libraryClose').onclick = () => { $('libraryModal').hidden = true; };
}

/* ------------------------------ 设置 ------------------------------ */

const STEP_LABELS = { P1: 'P1 段落索引（调用最多）', P2: 'P2 场景切分', P4: 'P4 场景分析（质量关键）', PC: 'PC 动作链', PS: 'PS 场景摘要', P7: 'P7 句子层（质量关键）', PE: 'PE 关键事件' };
/** 推荐配置：P1 调用最多但任务简单，用本地省钱；其余步骤决定质量，用云端。 */
function recommendedHybrid() {
  const choices = window.__modelChoices || [];
  const current = window.__defaultModel || '';
  const cloud = current.startsWith('api:') ? current : (choices.find((item) => item.id.startsWith('api:'))?.id || '');
  const local = choices.find((item) => item.id.startsWith('qwen3.5:'))?.id || '';
  return { P1: local, P2: cloud, P4: cloud, PC: cloud, PS: cloud, P7: cloud, PE: cloud };
}

function renderStepModels(container, stepModels, current) {
  const box = typeof container === 'string' ? $(container) : container;
  const choices = window.__modelChoices || [];
  const recommended = recommendedHybrid();
  box.innerHTML = Object.entries(STEP_LABELS).map(([step, label]) => {
    const value = stepModels?.[step] || recommended[step] || '';
    const options = [`<option value="">跟随默认（${esc(current || '—')}）</option>`]
      .concat(choices.map((item) => `<option value="${esc(item.id)}"${item.id === value ? ' selected' : ''}>${esc(item.label)}${item.id === recommended[step] ? '（推荐）' : ''}</option>`));
    return `<div class="step-model-row"><label>${esc(label)}</label><select data-step="${esc(step)}">${options.join('')}</select></div>`;
  }).join('');
}

function collectStepModels(container) {
  const box = typeof container === 'string' ? $(container) : container;
  return Object.fromEntries([...box.querySelectorAll('select')]
    .map((select) => [select.dataset.step, select.value])
    .filter(([, value]) => value));
}

function setupSettings() {
  const modal = $('settingsModal');

  const open = async () => {
    modal.hidden = false;
    $('setStatus').textContent = '读取中…';
    const [data, models] = await Promise.all([
      fetch('/api/settings').then((r) => r.json()).catch(() => null),
      fetch('/api/models').then((r) => r.json()).catch(() => ({ models: [] })),
    ]);
    if (!data) { $('setStatus').textContent = '读取失败'; return; }

    window.__modelChoices = (models.models || []).filter((model) => model.available !== false).map((model) => ({ id: model.id, label: model.short || model.label }));

    $('setApiKey').value = '';
    $('setBaseUrl').value = data.baseUrl || '';
    $('setModel').value = data.model || '';
    $('setConcurrency').value = data.concurrency || 3;
    renderStepModels('setStepModels', data.stepModels || {}, data.model);
    $('setKeyState').textContent = data.hasKey
      ? `已配置：${data.keyHint}（留空则保持不变）`
      : '尚未配置 API Key';
    $('setKeyState').style.color = data.hasKey ? '#1f8f43' : '#b0122f';
    $('setExtra').textContent = `配置文件：${data.file}`;
    $('setStatus').textContent = '';
  };

  $('settingsBtn').onclick = open;
  $('settingsClose').onclick = () => { modal.hidden = true; };

  $('setTest').onclick = async () => {
    $('setTestState').textContent = '连接中…';
    $('setTestState').style.color = '';
    $('setModels').innerHTML = '';
    const response = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: $('setBaseUrl').value.trim(), apiKey: $('setApiKey').value.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      $('setTestState').textContent = `失败：${data.error || response.status}`;
      $('setTestState').style.color = '#b0122f';
      return;
    }
    $('setTestState').textContent = `连接成功，可用模型 ${data.models.length} 个（点一下选用）`;
    $('setTestState').style.color = '#1f8f43';
    $('setModels').innerHTML = data.models.map((name) => `<span class="chip" data-model="${esc(name)}">${esc(name)}</span>`).join('');
    for (const chip of $('setModels').querySelectorAll('[data-model]')) {
      chip.onclick = () => {
        $('setModel').value = chip.dataset.model.startsWith('deepseek') ? `api:${chip.dataset.model}` : chip.dataset.model;
      };
    }
  };

  $('setSave').onclick = async () => {
    $('setStatus').textContent = '保存中…';
    const payload = {
      apiKey: $('setApiKey').value.trim(),
      baseUrl: $('setBaseUrl').value.trim(),
      model: $('setModel').value.trim(),
      concurrency: Number($('setConcurrency').value) || 3,
      stepModels: collectStepModels('setStepModels'),
    };
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { $('setStatus').textContent = `保存失败：${data.error || response.status}`; return; }
    $('setStatus').textContent = '已保存，导入时即可选用';
    $('setKeyState').textContent = data.hasKey ? `已配置：${data.keyHint}` : '尚未配置 API Key';
    $('setKeyState').style.color = data.hasKey ? '#1f8f43' : '#b0122f';
    $('setApiKey').value = '';
  };
}

/* ------------------------------ 会话日志 ------------------------------ */

let sessionCursor = 0;
let sessionTimer = null;

function openSession() {
  $('sessionModal').hidden = false;
  sessionCursor = 0;
  $('sessionList').innerHTML = '';
  $('sessionStatus').textContent = '等待模型响应…';
  if (sessionTimer) clearInterval(sessionTimer);
  pollSession();
  sessionTimer = setInterval(pollSession, 1500);
}

function closeSession() {
  $('sessionModal').hidden = true;
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
}

async function pollSession() {
  if ($('sessionModal').hidden) { closeSession(); return; }
  const data = await fetch(`/api/session?after=${sessionCursor}`).then((r) => r.json()).catch(() => null);
  if (!data) return;

  if (data.file) $('sessionFile').textContent = data.file;
  if (data.messages?.length) {
    const list = $('sessionList');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    for (const message of data.messages) {
      sessionCursor = Math.max(sessionCursor, message.seq || 0);
      list.insertAdjacentHTML('beforeend', renderSessionMessage(message));
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  $('sessionStatus').textContent = data.running
    ? `进行中 · 已记录 ${data.total} 条消息`
    : `已结束 · 共 ${data.total} 条消息，日志已保存`;
  if (!data.running) { clearInterval(sessionTimer); sessionTimer = null; }
}

function renderSessionMessage(message) {
  const kind = message.role === 'request' ? 'request' : message.role === 'response' ? 'response' : 'error';
  const tagClass = { request: 'req', response: 'res', error: 'err' }[kind];
  const tagText = { request: '发送', response: '回复', error: '错误' }[kind];

  const head = `<div class="sess-head">
      <span class="sess-tag ${tagClass}">${tagText}</span>
      <span class="sess-tag">#${message.seq}</span>
      ${message.step ? `<span class="sess-tag">${esc(message.step)}</span>` : ''}
      ${message.target ? `<span>${esc(message.target)}</span>` : ''}
      ${message.model ? `<span>· ${esc(message.model)}</span>` : ''}
      ${message.耗时秒 ? `<span>· ${message.耗时秒}s</span>` : ''}
      <span style="margin-left:auto">${esc(String(message.at || '').slice(11, 19))}</span>
    </div>`;

  if (kind === 'request') {
    return `<div class="sess request">${head}
      <div class="sess-label">系统提示（${esc(String(message.系统提示 || '').length)} 字）</div>
      <div class="sess-body">${esc(message.系统提示 || '')}</div>
      <div class="sess-label">提示词（${esc(String(message.提示词字数 || 0))} 字 · max_tokens ${esc(String(message.maxTokens ?? '—'))}）</div>
      <div class="sess-body">${esc(message.提示词 || '')}</div>
    </div>`;
  }
  if (kind === 'response') {
    return `<div class="sess response">${head}
      <div class="sess-label">模型原始回复（${esc(String(message.回复字数 || 0))} 字）</div>
      <div class="sess-body">${esc(message.回复 || '')}</div>
    </div>`;
  }
  return `<div class="sess error">${head}<div class="sess-body">${esc(message.错误 || '')}</div></div>`;
}

function setupSession() {
  $('sessionClose').onclick = closeSession;
}

async function boot() {
  const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
  state.books = books;
  const select = $('book');
  select.innerHTML = books.map((book) => `<option value="${esc(book.id)}">${esc(book.title)}（${book.scenes} 场景）</option>`).join('');
  select.addEventListener('change', async () => {
    localStorage.setItem('corpus.book', select.value);
    await loadBook(select.value);
    syncBookEverywhere(select.value);
    // 通知各标签页：按新书重新拉数据
    for (const id of BOOK_SELECT_IDS) {
      if (id === 'book') continue;
      const sel = document.getElementById(id);
      if (sel) sel.dispatchEvent(new Event('change'));
    }
  });
  setupImport();
  setupAdvice();
  setupLibrary();
  setupCards();
  setupNumbering();
  setupClean();
  setupScenesView();
  setupCharacters();
  setupSceneDetail();
  setupReconcile();
  setupCorrect();
  setupLink();
  setupRelink();
  setupCardBoard();
  setupPrompts();
  setupDialog();
  setupTabConfigBar();
  setupAppear();
  setupErotic();
  setupDirty();
  setupWorkflow();
  setupConsole();
  loadGatewayModels();
  setupSettings();
  setupSession();
  pollJobs();

  $('revealBtn').onclick = async () => {
    const bookId = $('book').value;
    if (!bookId) return;
    try {
      const response = await fetch('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '打开失败');
    } catch (error) {
      alert(`打不开目录：${error.message}`);
    }
  };

  if (!books.length) {
    $('list').innerHTML = '<div class="empty">还没有语料。<br>点右上角「＋ 导入新书」选一个 txt / md 文件。</div>';
    return;
  }
  const fromUrl = new URLSearchParams(location.search).get('book');
  const saved = fromUrl || localStorage.getItem('corpus.book');
  const target = books.find((book) => book.id === saved) || books[0];
  select.value = target.id;
  await loadBook(target.id);
  const savedView = sessionStorage.getItem('corpus.view');
  if (!savedView || savedView === 'scenes' || savedView === 'cards') switchView('pipeline');
  if (['scenesview', 'scenedetail', 'characters', 'pipeline'].includes(savedView)) switchView(savedView);
}

/* ------------------------------ 导入与进度 ------------------------------ */

let pollTimer = null;

function setupImport() {
  const modal = $('importModal');
  const input = $('fileInput');
  const startBtn = $('importStart');
  let pendingFile = null;

  $('importBtn').onclick = async () => {
    modal.hidden = false;
    pendingFile = null;
    $('importFileName').textContent = '未选择';
    $('importStatus').textContent = '';
    $('importHybrid').checked = false;
    $('importStepModels').hidden = true;
    $('importModel').disabled = false;
    startBtn.disabled = true;
    await loadModels();
    // 混合模式的分步表也在这里准备好，勾上就能直接改。
    const settings = await fetch('/api/settings').then((r) => r.json()).catch(() => null);
    renderStepModels('importStepModels', settings?.stepModels || {}, settings?.model || '');
  };

  $('importClose').onclick = () => { modal.hidden = true; };
  $('importPick').onclick = () => input.click();
  $('importRefresh').onclick = () => loadModels();
  $('importHybrid').onchange = () => {
    const on = $('importHybrid').checked;
    $('importModel').disabled = on;
    $('importStepModels').hidden = !on;
    $('importModelHint').textContent = on
      ? '按上面每步选的模型执行；选「跟随默认」的步骤用设置里的默认模型'
      : ($('importModelHint').dataset.base || '');
  };

  input.onchange = async () => {
    pendingFile = input.files?.[0] || null;
    input.value = '';
    const label = $('importFileName');
    if (!pendingFile) { label.textContent = '未选择'; startBtn.disabled = true; return; }

    const sizeText = `${(pendingFile.size / 1024).toFixed(0)} KB`;
    // JSON 是书籍工程：先在前端拆一遍，让用户在开始前就看到章节数。
    if (/\.json$/i.test(pendingFile.name)) {
      const reject = (reason) => {
        label.textContent = reason;
        startBtn.disabled = true;
      };
      try {
        const doc = JSON.parse(await pendingFile.text());
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { reject('JSON 顶层必须是对象，无法作为书籍工程'); return; }

        const chapters = Array.isArray(doc.chapters) ? doc.chapters : null;
        const paragraphs = Array.isArray(doc.paragraphs) ? doc.paragraphs : null;

        if (doc.format === 'novel-corpus') {
          if (typeof doc.canonicalText !== 'string' || !doc.canonicalText.trim()) { reject('novel-corpus 缺少正文（canonicalText）'); return; }
          if (!chapters || !paragraphs || !paragraphs.length) { reject('novel-corpus 缺少 chapters/paragraphs'); return; }
          const name = doc.name || pendingFile.name;
          label.textContent = `书籍工程 · ${name} · ${chapters.length} 章 / ${paragraphs.length} 段 · ${sizeText}`;
        } else if (chapters && paragraphs) {
          if (!chapters.length || !paragraphs.length) { reject('工程里章节或段落是空的，无法分析'); return; }
          const name = doc.project?.name || pendingFile.name;
          label.textContent = `书籍工程 · ${name} · ${chapters.length} 章 / ${paragraphs.length} 段 · ${sizeText}`;
        } else {
          reject(`认不出这个 JSON 的结构${doc.format ? `（format = "${doc.format}"）` : ''}，无法用来做小说分析`);
          return;
        }
      } catch (error) {
        reject(`JSON 解析失败：${error.message}`);
        return;
      }
    } else {
      label.textContent = `${pendingFile.name}（${sizeText}）`;
    }
    startBtn.disabled = false;
  };

  startBtn.onclick = async () => {
    if (!pendingFile) return;
    const text = await pendingFile.text();
    const model = $('importModel').value;
    const hybrid = $('importHybrid').checked;
    startBtn.disabled = true;
    $('importStatus').textContent = '上传中…';
    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: pendingFile.name,
          text,
          model: hybrid ? '' : model,
          hybrid,
          stepModels: hybrid ? collectStepModels('importStepModels') : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ? `${data.error}\n${data.detail}` : (data.error || '导入失败'));
      modal.hidden = true;
      openSession();
      showProgress({ title: pendingFile.name, message: `已分章：${data.chapters} 章 / ${data.paragraphs} 段　模型 ${data.model || model}`, percent: 3 });
      pollJobs();
    } catch (error) {
      $('importStatus').textContent = `失败：${error.message}`;
      startBtn.disabled = false;
    }
  };
}

async function loadModels() {
  const select = $('importModel');
  const hint = $('importModelHint');
  select.innerHTML = '<option value="">读取中…</option>';
  hint.textContent = '';

  // 只认 LocalAI 网关的模型列表，不回退 Ollama
  const data = await fetch('/api/gateway/models').then((r) => r.json()).catch(() => ({ models: [] }));
  const models = data.models || [];
  if (!models.length) {
    select.innerHTML = '<option value="">（网关不可用）</option>';
    hint.textContent = data.error || '连不上 LocalAI 网关，请切到服务器模式后点「刷新」';
    return;
  }

  const DEFAULT_MODEL = 'qwen3.5:9b-uncensored-q8_0_64K';
  select.innerHTML = models
    .map((id) => '<option value="' + esc(id) + '">' + esc(id) + (id === DEFAULT_MODEL ? '（默认）' : '') + '</option>')
    .join('');
  select.value = models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0];
  hint.dataset.base = '网关 ' + (data.base || '') + ' · ' + models.length + ' 个模型';
  hint.textContent = hint.dataset.base;
}

async function decide(decision) {
  await fetch('/api/analyze/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  $('pgPending')?.remove();
}

function showProgress({ title, message, percent, error = false, logs = [] }) {
  const panel = $('progress');
  panel.hidden = false;
  if (title) $('pgTitle').textContent = title;
  $('pgMsg').textContent = message || '';
  $('pgBar').style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  $('pgBar').style.background = error ? '#ff375f' : '#007aff';
  $('pgLogs').innerHTML = logs.slice(-8).map((line) => `<div>${esc(line)}</div>`).join('');
  $('pgClose').onclick = () => { panel.hidden = true; };
}

/** 顶部小胶囊：面板关掉之后仍能看到进度，点一下重新展开面板。 */
function setChip(text, { visible, error = false } = {}) {
  const chip = $('statusChip');
  chip.hidden = !visible;
  chip.textContent = text || '';
  chip.classList.toggle('is-error', error);
  chip.onclick = () => { if (text) $('progress').hidden = false; };
}

let autoHideTimer = null;

function scheduleAutoHide() {
  if (autoHideTimer) clearTimeout(autoHideTimer);
  autoHideTimer = setTimeout(() => {
    $('progress').hidden = true;
    setChip('', { visible: false });
  }, 6000);
}

const bootAt = Date.now();

function pollJobs() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    let data;
    try { data = await fetch('/api/jobs').then((r) => r.json()); } catch { return; }
    const job = data.jobs?.[0];

    // 页面打开时如果只有历史任务，不要弹出面板——那会一直挡着内容。
    if (!job || (!data.running && job.startedAt < bootAt - 5000)) {
      clearInterval(pollTimer);
      pollTimer = null;
      $('progress').hidden = true;
      setChip('', { visible: false });
      return;
    }

    const elapsed = Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);
    const percent = job.status === 'done' ? 100 : job.percent || 0;
    showProgress({
      title: job.title,
      message: job.status === 'error' ? `失败：${job.error}` : `${job.step} · ${job.message}`,
      percent,
      error: job.status === 'error',
      logs: job.logs || [],
    });
    const chapterText = data.chapters?.total ? `　章 ${data.chapters.done}/${data.chapters.total}` : '';
    $('pgMeta').textContent = `模型 ${job.modelLabel || job.model || '—'}${chapterText}　已用 ${Math.floor(elapsed / 60)}分${elapsed % 60}秒${job.failed?.length ? `　跳过 ${job.failed.length} 项` : ''}`;

    if (data.pending) {
      const left = Math.max(0, Math.ceil(((data.pending.deadline || 0) - Date.now()) / 1000));
      let box = $('pgPending');
      if (!box) {
        box = document.createElement('div');
        box.id = 'pgPending';
        box.className = 'pending-box';
        $('pgMsg').insertAdjacentElement('afterend', box);
      }
      box.innerHTML = `
        <div class="pend-title">${esc(data.pending.sceneId)} 连续三次失败：${esc(data.pending.error)}</div>
        <div class="modal-status">${left} 秒后自动继续；也可以现在决定</div>
        <div class="pend-actions">
          <button class="primary" id="pendStop" type="button" style="background:#ff375f">停止分析</button>
          <button class="ghost" id="pendGo" type="button">继续下一场</button>
        </div>`;
      $('pendStop').onclick = () => decide('stop');
      $('pendGo').onclick = () => decide('continue');
    } else {
      $('pgPending')?.remove();
    }

    if (data.running) {
      setChip(`分析中 ${job.step} ${percent}%`, { visible: true });
    }

    if (!data.running) {
      $('importBtn').disabled = false;
      clearInterval(pollTimer);
      pollTimer = null;
      if (job.status === 'done') {
        setChip('✓ 分析完成', { visible: true });
        scheduleAutoHide();
      } else {
        setChip('分析失败', { visible: true, error: true });
      }
      await refreshBooks(job.status === 'done' ? job.bookId : null);
    }
  }, 1500);
}

async function refreshBooks(selectId) {
  const books = await fetch('/api/books').then((r) => r.json()).catch(() => []);
  state.books = books;
  const select = $('book');
  select.innerHTML = books.map((book) => `<option value="${esc(book.id)}">${esc(book.title)}（${book.scenes} 场景）</option>`).join('');
  // 轮询会频繁调用到这里：没有指定书时保留当前选择，别退回第一本。
  const current = select.value || localStorage.getItem('corpus.book') || '';
  const exists = (id) => books.some((book) => book.id === id);
  const target = exists(selectId) ? selectId : (exists(current) ? current : books[0]?.id);
  if (target) {
    const changed = select.value !== target || !state.book || state.book.bookId !== target;
    select.value = target;
    localStorage.setItem('corpus.book', target);
    if (changed) await loadBook(target);
  }
}

async function loadBook(id) {
  // 写进地址栏：刷新、分享链接、后退都能回到这本书
  try {
    const url = new URL(location.href);
    if (url.searchParams.get('book') !== id) {
      url.searchParams.set('book', id);
      history.replaceState(null, '', url);
    }
  } catch { /* 忽略 */ }
  const book = await fetch(`/api/book/${encodeURIComponent(id)}`).then((r) => r.json());
  state.book = book;
  state.selected = null;
  state.filters.character = '';
  state.characters = collectCharacters(book);
  state.eventMap = new Map((book.events || []).map((event) => [event.sceneId, event]));
  // 场景浏览视图已移除；只有容器存在时才渲染
  if ($('list')) {
    buildFilters();
    renderMeta();
    renderCharacterPanel();
    renderArc();
    renderList();
    renderDetail();
  }
}

function buildFilters() {
  if (!$('character') || !$('filters')) return;
  const book = state.book;
  const uniq = (values) => [...new Set(values.filter(Boolean))];

  // 人物下拉：按出场场景数排序，只列出有名字的参与者。
  const people = [...state.characters.values()].sort((a, b) => b.scenes.length - a.scenes.length);
  const charSelect = $('character');
  charSelect.innerHTML = `<option value="">人物（全部）</option>` + people.map((person) =>
    `<option value="${esc(person.name)}">${esc(person.name)}（${person.scenes.length} 场）</option>`).join('');
  charSelect.onchange = () => {
    state.filters.character = charSelect.value;
    renderCharacterPanel();
    renderArc();
    renderList();
  };
  charSelect.value = state.filters.character;

  const fill = (id, label, values) => {
    if (["stage", "arcType", "sceneStage", "direction"].includes(id)) {
      const node = $(id);
      if (node) { node.innerHTML = '<option value="">（已移除）</option>'; node.disabled = true; const box = node.closest("label"); if (box) box.hidden = true; }
      return;
    }
    const select = $(id);
    select.innerHTML = `<option value="">${label}（全部）</option>` + values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
    select.onchange = () => { state.filters[id] = select.value; state.page = 0; renderList(); };
    state.filters[id] = '';
  };
  fill('arcType', '弧线', uniq(book.scenes.map((s) => s.阶段类型)));
  fill('stage', '阶段', uniq(book.scenes.map((s) => s.弧阶段)));
  fill('power', '权力', uniq(book.scenes.map((s) => s.权力)));
  fill('sceneStage', '场景阶段', uniq(book.scenes.map((s) => s.场景阶段)));
  fill('direction', '位移', uniq(book.scenes.map((s) => s.位移方向)));

  $('erotic').value = state.filters.erotic || '';
  $('erotic').onchange = () => { state.filters.erotic = $('erotic').value; state.page = 0; renderList(); };

  $('nearOnly').checked = state.filters.near;
  $('nearOnly').onchange = () => { state.filters.near = $('nearOnly').checked; state.page = 0; renderList(); };

  $('onlyTraj').checked = state.filters.onlyTraj;
  $('onlyTraj').onchange = () => { state.filters.onlyTraj = $('onlyTraj').checked; state.page = 0; renderList(); };

  $('eventsOnly').checked = state.filters.eventsOnly;
  $('eventsOnly').onchange = () => { state.filters.eventsOnly = $('eventsOnly').checked; state.page = 0; renderList(); };

  const search = $('search');
  search.value = state.filters.q;
  search.oninput = () => { state.filters.q = search.value.trim(); renderList(); };
}

/** 按角色聚合：出场场景、身份、动机、恐惧、阶段分布、权力分布、轨迹。 */
function collectCharacters(book) {
  const map = new Map();
  const touch = (name) => {
    if (!map.has(name)) {
      map.set(name, { name, scenes: [], identities: new Set(), motives: new Set(), fears: new Set(), stages: new Map(), powers: new Map(), trajectories: [] });
    }
    return map.get(name);
  };

  for (const scene of book.scenes) {
    const details = scene.参与者详情 || [];
    const names = details.length ? details.map((item) => item.角色).filter(Boolean) : (scene.参与者 || []);
    for (const name of new Set(names)) {
      const entry = touch(name);
      entry.scenes.push(scene);
      const detail = details.find((item) => item.角色 === name);
      if (detail) {
        if (detail.身份) entry.identities.add(detail.身份);
        if (detail.动机) entry.motives.add(detail.动机);
        if (detail.怕什么) entry.fears.add(detail.怕什么);
      }
      entry.stages.set(scene.弧阶段, (entry.stages.get(scene.弧阶段) || 0) + 1);
      entry.powers.set(scene.权力, (entry.powers.get(scene.权力) || 0) + 1);
      if (scene.轨迹) entry.trajectories.push(`${scene.轨迹.起点}→${scene.轨迹.终点}`);
    }
  }
  for (const entry of map.values()) entry.scenes.sort((a, b) => a.序号 - b.序号);
  return map;
}

function renderCharacterPanel() {
  if (!$('charPanel')) return;
  const panel = $('charPanel');
  const name = state.filters.character;
  if (!name) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
  const person = state.characters.get(name);
  if (!person) { panel.style.display = 'none'; return; }

  const countMap = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`).join('　') || '—';
  const trajCount = person.trajectories.reduce((acc, item) => { acc[item] = (acc[item] || 0) + 1; return acc; }, {});
  const trajText = Object.entries(trajCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([item, n]) => `${item} ×${n}`).join('　') || '—';
  const list = (set, max = 6) => [...set].slice(0, max).join('、') || '—';

  panel.style.display = '';
  panel.innerHTML = `
    <h3>${esc(person.name)}</h3>
    <div class="sub">出场 ${person.scenes.length} 场　${person.scenes.length ? `首场 ${esc(person.scenes[0].sceneId)}` : ''}　${person.scenes.length > 1 ? `末场 ${esc(person.scenes[person.scenes.length - 1].sceneId)}` : ''}</div>
    <div class="char-grid">
      <div class="char-block"><div class="k">身份</div><div class="v">${esc(list(person.identities, 4))}</div></div>
      <div class="char-block"><div class="k">阶段分布</div><div class="v">${esc(countMap(person.stages))}</div></div>
      <div class="char-block"><div class="k">权力分布</div><div class="v">${esc(countMap(person.powers))}</div></div>
      <div class="char-block"><div class="k">常见动机</div><div class="v">${esc(list(person.motives))}</div></div>
      <div class="char-block"><div class="k">在抗拒什么</div><div class="v">${esc(list(person.fears))}</div></div>
      <div class="char-block"><div class="k">状态位移</div><div class="v">${esc(trajText)}</div></div>
    </div>`;
}

function renderMeta() {
  const book = state.book;
  const withTraj = book.scenes.filter((scene) => scene.轨迹).length;
  const chips = [
    `${book.paragraphCount} 段`,
    `${book.chapterCount} ${book.autoUnits ? '个自动单元' : '章'}`,
    `${book.scenes.length} 场景`,
    `有轨迹 ${withTraj}/${book.scenes.length}`,
    `${book.stages.length} 阶段`,
  ];
  $('meta').innerHTML = chips.map((text) => `<span class="chip">${esc(text)}</span>`).join('');
}

/** 色情动作链：主动与被动交替推进的一条流水，不是分步骤表格。 */
function chainBlock(scene) {
  const chain = scene.动作链;
  if (!chain || typeof chain.动作链 !== 'string' || !chain.动作链.trim()) return '';

  const actives = chain.主动者 || [];
  const links = chain.动作链.split('→').map((item) => item.trim()).filter(Boolean);
  const chips = links.map((link) => {
    const isActive = actives.some((name) => link.startsWith(name));
    return `<span class="link${isActive ? ' is-active' : ''}">${esc(link)}</span>`;
  }).join('<span class="link-arrow">→</span>');

  const flow = typeof chain.反应序列 === 'string' && chain.反应序列.trim()
    ? `<div class="chain-flow"><span class="sum-k">反应</span>${chain.反应序列.split('→').map((item) => `<span class="flow-word">${esc(item.trim())}</span>`).join('<span class="link-arrow">→</span>')}</div>`
    : '';

  const template = Array.isArray(chain.模板) && chain.模板.length ? chain.模板.join(' → ') : '';
  const note = chain.来源 === 'beats' ? '<span class="chain-note">（模型未通过校验，由节拍拼接，仅供参考）</span>' : '';

  return `<h3>色情动作链（${links.length} 环）${note}</h3>
    <div class="chain-role">主动：${actives.join('、') || '—'}　→　被动：${(chain.被动者 || []).join('、') || '—'}</div>
    ${template ? `<div class="chain-template">模板 ${esc(template)}</div>` : ''}
    <div class="chain-line">${chips}</div>
    ${flow}`;
}

/** 场景摘要：人物 / 地点 / 情节描述 / 矛盾 / 结果。 */
function summaryBlock(scene, { full = false } = {}) {
  const s = scene.场景摘要;
  if (!s) return scene.摘要 ? `<div class="scene-summary">${esc(scene.摘要)}</div>` : '';
  // 摘要里的「人物」偶尔是空的（模型漏填），退回用场景分析的参与者，避免显示成「—」。
  const summaryPeople = Array.isArray(s.人物) && s.人物.length ? s.人物 : (scene.参与者 || []);
  const people = summaryPeople.length ? summaryPeople.join('、') : '—';
  const plot = s.情节描述 || s.情节 || '—';
  return `<div class="sum">
    <div class="sum-row"><span class="sum-k">人物</span>${esc(people)}<span class="sum-k" style="margin-left:14px">地点</span>${esc(s.地点 || '未明')}</div>
    <div class="sum-plot"><span class="sum-k">情节</span>${esc(full ? plot : plot.slice(0, 120))}${!full && plot.length > 120 ? '…' : ''}</div>
    <div class="sum-row"><span class="sum-k">矛盾</span>${esc(s.矛盾 || '—')}</div>
    <div class="sum-row"><span class="sum-k">结果</span>${esc(s.结果 || '—')}</div>
  </div>`;
}

/** 关键事件不再单独成区，而是嵌进场景卡片里，用样式区分。 */
function eventBlock(event) {
  if (!event) return '';
  return `<div class="event-inline">
    <div class="event-inline-head">
      <span class="event-kicker">关键事件</span>
      <span class="event-type">${esc(event.类型)}</span>
      <span class="event-persist">${event.持续性 === '永久' ? '永久改变' : '一次性'}</span>
    </div>
    <div class="event-name">${esc(event.事件)}</div>
    <div class="event-shift"><span>${esc(event.之前 || '—')}</span><span class="arrow">→</span><span>${esc(event.之后 || '—')}</span></div>
    <div class="event-impact">${esc(event.影响)}</div>
  </div>`;
}

/* 阶段分析已移除 */
function renderArc() {
  // 人物弧已整体移除，这里保留空实现避免旧调用报错
}

function matches(scene) {  const f = state.filters;
  if (f.character) {
    const names = new Set([...(scene.参与者 || []), ...(scene.参与者详情 || []).map((item) => item.角色)]);
    if (!names.has(f.character)) return false;
  }
  if (f.stage && scene.弧阶段 !== f.stage) return false;
  if (f.arcType && scene.阶段类型 !== f.arcType) return false;
  if (f.power && scene.权力 !== f.power) return false;
  if (f.sceneStage && scene.场景阶段 !== f.sceneStage) return false;
  if (f.direction && scene.位移方向 !== f.direction) return false;
  if (f.erotic && (scene.情色分级 || 'none') !== f.erotic) return false;
  if (f.onlyTraj && !scene.轨迹) return false;
  if (f.eventsOnly && !state.eventMap.has(scene.sceneId)) return false;
  if (f.near && scene.距突破 !== null && Math.abs(scene.距突破) > 2) return false;
  if (f.q) {
    const haystack = [scene.原文, scene.转折句, scene.关键句, (scene.金句 || []).join(''), scene.轨迹 ? `${scene.轨迹.起点}${scene.轨迹.终点}${scene.轨迹.触发句}` : '', (scene.承载句 || []).map((item) => item.句).join('')].join('\n');
    if (!haystack.includes(f.q)) return false;
  }
  return true;
}

function renderList() {
  if (!$('count') || !$('list')) return;
  const scenes = state.book.scenes.filter(matches).sort((a, b) => a.序号 - b.序号);
  $('count').textContent = `显示 ${scenes.length} / ${state.book.scenes.length} 个场景`;

  const PAGE_SIZE = 20;
  const totalPages = Math.max(1, Math.ceil(scenes.length / PAGE_SIZE));
  if (state.page > totalPages - 1) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;
  const pageScenes = scenes.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  renderPager(totalPages, scenes.length);

  if (!scenes.length) { $('list').innerHTML = '<div class="empty">没有符合条件的场景。</div>'; return; }

  $('list').innerHTML = pageScenes.map((scene) => {
    const event = state.eventMap.get(scene.sceneId);
    const first = scene.是否首次 ? '<span class="badge first">首次</span>' : '';
    const noMove = scene.轨迹 ? '' : '<span class="badge">无位移</span>';
    const eventBadge = event ? '<span class="badge is-event">关键事件</span>' : '';
    const chain = [
      ...(scene.承载句 || []).map((item) => ({ label: item.功能, text: item.句 })),
      ...(scene.描写摘录 || []).map((quote) => ({ label: '摘录', text: quote })),
    ]
      .filter((item) => item.text)
      .slice(0, 3)
      .map((item) => `<div class="carry-item"><span class="fn">${esc(item.label)}</span><span class="carry-text">${esc(item.text)}</span></div>`)
      .join('');
    return `<article class="card${event ? ' is-event' : ''}${scene.sceneId === state.selected ? ' is-active' : ''}" data-scene="${esc(scene.sceneId)}">
      <div class="card-head">
        <span class="scene-id">${esc(scene.sceneId)}</span>
        <span class="card-sub">第 ${esc(scene.章)} 章 · ${esc(scene.从)}–${esc(scene.到)}</span>
        <span class="spacer"></span>
        ${eventBadge}${first}${noMove}
        <span class="badge stage">${scene.阶段类型 ? `${esc(scene.阶段类型)} · ` : ''}${esc(scene.弧阶段)} #${esc(scene.阶段内序号)}</span>
        <span class="badge power-${esc(scene.权力)}">${esc(scene.权力 || '—')}</span>
        <span class="badge">${esc(scene.场景阶段 || '—')}</span>
        <span class="badge">距突破 ${scene.距突破 === null ? '—' : scene.距突破}</span>
      </div>
      ${summaryBlock(scene)}
      ${eventBlock(event)}
      <div class="traj">
        ${scene.轨迹
          ? `<span class="from">${esc(scene.轨迹.起点)}</span><span class="arrow">→</span><span class="to">${esc(scene.轨迹.终点)}</span>${scene.轨迹.触发类型 ? `<span class="trigger">· ${esc(scene.轨迹.触发类型)}</span>` : ''}`
          : '<span class="trigger">本场景没有完成状态位移</span>'}
      </div>
      ${scene.转折句 ? `<div class="quote break"><span class="quote-label">转折</span>${esc(scene.转折句)}</div>` : ''}
      ${chain ? `<div class="carry">${chain}</div>` : ''}
    </article>`;
  }).join('');

  for (const card of $('list').querySelectorAll('[data-scene]')) {
    card.onclick = () => selectScene(card.dataset.scene);
  }
}

/** 分页条：一页 20 场，避免一次塞几百个卡片导致滚动卡顿。 */
function renderPager(totalPages, totalCount) {
  const pager = $('pager');
  if (!pager) return;
  if (totalPages <= 1) { pager.hidden = true; return; }
  pager.hidden = false;
  const page = state.page;
  const button = (label, target, disabled = false) =>
    `<button class="ghost page-btn" data-page="${target}"${disabled ? ' disabled' : ''}>${label}</button>`;
  pager.innerHTML = `
    ${button('‹ 上一页', page - 1, page === 0)}
    <span class="page-info">第 ${page + 1} / ${totalPages} 页　共 ${totalCount} 场</span>
    ${button('下一页 ›', page + 1, page === totalPages - 1)}
    ${button('跳到末页', totalPages - 1, page === totalPages - 1)}`;
  pager.querySelectorAll('[data-page]').forEach((element) => {
    element.onclick = () => {
      const target = Number(element.dataset.page);
      if (Number.isNaN(target) || target < 0 || target >= totalPages) return;
      state.page = target;
      renderList();
      $('list').scrollTop = 0;
    };
  });
}

function sceneSource(scene) {
  const rows = state.book.paragraphs;
  const start = rows.findIndex((item) => item.id === scene.从);
  const end = rows.findIndex((item) => item.id === scene.到);
  if (start < 0 || end < start) return '';
  return rows.slice(start, end + 1).map((item) => item.text).join('\n');
}


/*** 从人物卡跳到某个场景：必要时清筛选、翻页、切回场景页并滚到卡片。 */
function goToScene(sceneId) {
  if (!state.book) return;
  const all = [...state.book.scenes].sort((a, b) => a.序号 - b.序号);
  const scene = all.find((item) => item.sceneId === sceneId);
  if (!scene) return;

  // 现有筛选如果会把它藏起来，就整体重置
  if (!matches(scene)) {
    state.filters = { q: '', character: '', stage: '', arcType: '', power: '', sceneStage: '', direction: '', erotic: '', onlyTraj: false, eventsOnly: false, near: false };
    for (const id of ['character', 'arcType', 'stage', 'power', 'sceneStage', 'direction', 'erotic']) {
      const select = $(id);
      if (select) select.value = '';
    }
    for (const id of ['nearOnly', 'onlyTraj', 'eventsOnly']) {
      const box = $(id);
      if (box) box.checked = false;
    }
    const search = $('search');
    if (search) search.value = '';
  }

  const filtered = all.filter(matches);
  const index = filtered.findIndex((item) => item.sceneId === sceneId);
  state.page = index >= 0 ? Math.floor(index / 20) : 0;

  switchView('scenes');
  selectScene(sceneId);

  const card = document.querySelector(`#list .card[data-scene="${sceneId}"]`);
  if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function selectScene(sceneId) {
  state.selected = sceneId;
  renderArc();
  renderList();
  renderDetail();
  $('detail').scrollTop = 0;
}

function renderDetail() {
  const scene = state.book.scenes.find((item) => item.sceneId === state.selected);
  if (!scene) {
    $('detail').innerHTML = `<div class="detail-empty">从左侧选择一个场景<br><span style="font-size:12px">关键词：${esc(state.book.title)}</span></div>`;
    return;
  }

  const chain = (scene.反应链 || []).map((item, index) => `
    <div class="chain-row">
      <div class="chain-line"><span class="chain-key">#${index + 1}</span><span class="chain-val"></span></div>
      ${['刺激', '心理', '生理', '神态', '言语'].filter((key) => item[key]).map((key) => `
        <div class="chain-line"><span class="chain-key">${key}</span><span class="chain-val">${esc(item[key])}</span></div>`).join('')}
      ${item.证据 ? `<div class="chain-ev">证据：${esc(item.证据)}</div>` : ''}
    </div>`).join('') || '<div class="empty" style="padding:10px">没有反应链</div>';

  const beats = (scene.节拍 || []).map((beat) => `<span class="beat">${esc(beat.序)}. ${esc(beat.动作)}${beat.谁主动 ? `（${esc(beat.谁主动)}）` : ''}</span>`).join('') || '<span class="chain-key">—</span>';

  const carry = (scene.承载句 || []).map((item) => `
    <div class="carry-item"><span class="fn">${esc(item.功能)}</span><span class="carry-text" style="white-space:normal">${esc(item.句)}　<span style="color:#86868b">← ${esc(item.承担)}</span></span></div>`).join('') || '<span class="chain-key">—</span>';

  const technique = scene.手法
    ? Object.entries(scene.手法).filter(([, value]) => (Array.isArray(value) ? value.length : String(value || '').trim())).map(([key, value]) => `<span class="chip">${esc(key)}：${esc(Array.isArray(value) ? value.join('、') : value)}</span>`).join('')
    : '';

  $('detail').innerHTML = `
    <h2>${esc(scene.sceneId)} <span class="card-sub">第 ${esc(scene.章)} 章 · ${esc(scene.从)}–${esc(scene.到)}</span></h2>
    <div class="tag-list">
      <span class="badge stage">${esc(scene.弧阶段)} #${esc(scene.阶段内序号)}</span>
      <span class="badge power-${esc(scene.权力)}">${esc(scene.权力 || '—')}</span>
      <span class="badge">${esc(scene.场景阶段 || '—')}</span>
      <span class="badge">${esc(scene.位移方向 || '')}</span>
      <span class="badge">距突破 ${scene.距突破 === null ? '—' : scene.距突破}</span>
      ${scene.是否首次 ? '<span class="badge first">首次</span>' : ''}
    </div>

    ${eventBlock(state.eventMap.get(scene.sceneId))}
    ${summaryBlock(scene, { full: true })}
    ${chainBlock(scene)}

    <h3>轨迹</h3>
    ${scene.轨迹
      ? `<dl><dt>起点</dt><dd>${esc(scene.轨迹.起点)}</dd><dt>终点</dt><dd>${esc(scene.轨迹.终点)}</dd><dt>触发</dt><dd>${esc(scene.轨迹.触发类型 || '—')}</dd><dt>触发句</dt><dd>${esc(scene.轨迹.触发句 || '—')}</dd></dl>`
      : '<div class="muted-note">本场景没有完成状态位移</div>'}

    <h3>参与者</h3>
    <div class="tag-list">${(scene.参与者 || []).map((name) => `<span class="chip char-chip" data-char="${esc(name)}" style="cursor:pointer">${esc(name)}</span>`).join('') || '—'}</div>
    ${(scene.场所 || scene.场景阶段) ? `<h3>场景</h3><dl><dt>场所</dt><dd>${esc(scene.场所 || '—')}</dd><dt>阶段</dt><dd>${esc(scene.场景阶段 || '—')}</dd></dl>` : ''}

    ${(scene.反应链 || []).length ? `<details class="raw-chain"><summary>逐句反应（${scene.反应链.length} 条，原始表格）</summary><div class="chain">${chain}</div></details>` : ''}

    <h3>节拍</h3>
    <div class="beats">${beats}</div>

    <h3>承载句</h3>
    <div class="carry">${carry}</div>

    ${scene.功能序列?.length ? `<h3>功能序列</h3><div class="tag-list">${scene.功能序列.map((item, index) => `<span class="chip">${index + 1}. ${esc(item)}</span>`).join('')}</div>` : ''}
    ${technique ? `<h3>手法</h3><div class="tag-list">${technique}</div>` : ''}
    ${scene.描写摘录?.length ? `<h3>描写摘录（${scene.描写摘录.length}）</h3>${scene.描写摘录.map((quote) => `<div class="quote">${esc(quote)}</div>`).join('')}` : ''}
    ${scene.转折句 ? `<h3>转折句</h3><div class="quote break">${esc(scene.转折句)}</div>` : ''}

    <h3>原文</h3>
    <div class="source">${esc(sceneSource(scene))}</div>

    <div style="margin-top:16px; display:flex; gap:8px">
      <button class="ghost" id="copy">复制本场景 JSON</button>
    </div>
  `;

  const copy = $('copy');
  if (copy) copy.onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(scene, null, 2));
    copy.textContent = '已复制';
    setTimeout(() => { copy.textContent = '复制本场景 JSON'; }, 1200);
  };

  for (const chip of $('detail').querySelectorAll('.char-chip')) {
    chip.onclick = () => {
      state.filters.character = chip.dataset.char;
      $('character').value = chip.dataset.char;
      renderCharacterPanel();
      renderArc();
      renderList();
    };
  }
}

boot();
