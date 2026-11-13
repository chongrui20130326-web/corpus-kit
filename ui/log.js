const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const params = new URLSearchParams(location.search);
const work = params.get('work') || '';
let currentFile = params.get('file') || '';
let entries = [];

function renderSessionEntry(message) {
  const kind = message.role === 'request' ? 'request' : message.role === 'response' ? 'response' : 'error';
  const tagClass = { request: 'req', response: 'res', error: 'err' }[kind];
  const tagText = { request: '发送', response: '回复', error: '错误' }[kind];
  const head = `<div class="sess-head">
      <span class="sess-tag ${tagClass}">${tagText}</span>
      <span class="sess-tag">#${esc(message.seq)}</span>
      ${message.step ? `<span class="sess-tag">${esc(message.step)}</span>` : ''}
      ${message.target ? `<span>${esc(message.target)}</span>` : ''}
      ${message.model ? `<span>· ${esc(message.model)}</span>` : ''}
      ${message.耗时秒 ? `<span>· ${message.耗时秒}s</span>` : ''}
      <span style="margin-left:auto">${esc(String(message.at || '').slice(11, 19))}</span>
    </div>`;

  if (kind === 'request') {
    return `<div class="sess request">${head}
      <div class="sess-label">系统提示（${String(message.系统提示 || '').length} 字）</div>
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

function renderRunEntry(entry) {
  const head = `<div class="sess-head">
      <span class="sess-tag">#${esc(entry.seq ?? '')}</span>
      ${entry.step ? `<span class="sess-tag">${esc(entry.step)}</span>` : ''}
      ${entry.target ? `<span>${esc(entry.target)}</span>` : ''}
      ${entry.status ? `<span class="sess-tag">${esc(entry.status)}</span>` : ''}
      <span style="margin-left:auto">${esc(String(entry.at || '').slice(11, 19))}</span>
    </div>`;
  return `<div class="sess">${head}<div class="sess-body">${esc(JSON.stringify(entry.raw ?? entry, null, 1))}</div></div>`;
}

function renderBody() {
  const keyword = $('logFilter').value.trim();
  const isSession = currentFile.startsWith('session-');
  const list = entries.filter((entry) => !keyword || JSON.stringify(entry).includes(keyword));
  $('logBody').innerHTML = list.length
    ? list.map((entry) => (isSession ? renderSessionEntry(entry) : renderRunEntry(entry))).join('')
    : '<div class="log-empty">没有匹配的内容</div>';
}

async function openFile(name) {
  currentFile = name;
  $('logCurrent').textContent = name;
  $('logBody').innerHTML = '<div class="log-empty">读取中…</div>';
  const data = await fetch(`/api/logs?work=${encodeURIComponent(work)}&file=${encodeURIComponent(name)}`).then((r) => r.json()).catch(() => null);
  entries = data?.entries || [];
  history.replaceState(null, '', `?work=${encodeURIComponent(work)}&file=${encodeURIComponent(name)}`);
  renderBody();
}

async function boot() {
  if (!work) { $('logSub').textContent = '缺少书籍参数'; return; }
  const data = await fetch(`/api/logs?work=${encodeURIComponent(work)}`).then((r) => r.json()).catch(() => null);
  const files = data?.files || [];
  $('logTitle').textContent = `${work} · 日志`;
  $('logSub').textContent = `${files.length} 份日志`;

  $('logFiles').innerHTML = files.length
    ? files.map((file) => `<div class="log-row" data-file="${esc(file.name)}">
        <span class="sess-tag ${file.kind === '对话' ? 'req' : ''}">${esc(file.kind)}</span>
        <span class="log-name">${esc(file.name)}</span>
      </div>`).join('')
    : '<div class="log-empty">还没有日志</div>';

  for (const row of document.querySelectorAll('[data-file]')) {
    row.onclick = () => {
      for (const other of document.querySelectorAll('[data-file]')) other.classList.remove('is-current');
      row.classList.add('is-current');
      openFile(row.dataset.file);
    };
  }

  $('logFilter').oninput = renderBody;
  $('logBack').onclick = () => { if (history.length > 1) history.back(); else location.href = '/'; };

  if (currentFile) {
    const row = document.querySelector(`[data-file="${CSS.escape(currentFile)}"]`);
    row?.classList.add('is-current');
    openFile(currentFile);
  }
}

boot();
