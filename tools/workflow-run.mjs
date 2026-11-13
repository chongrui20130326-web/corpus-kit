import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

function httpRequestJson(method, pathName, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({
      host: '127.0.0.1', port: 4173, path: pathName, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 0,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* 保留原文本 */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed, raw: body });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * 工作流执行器：按顺序跑「场景切分 → 生成角色 → 场景详述 → 角色重构」
 * 用法：node tools/workflow-run.mjs <work> [fromStep] [toStep]
 * 进度写入 l2/workflow.json
 */

const work = process.argv[2] || 'work/美少妇的哀羞';
const from = Number(process.argv[3] || 3);
const to = Number(process.argv[4] || 6);
const base = path.join(work, 'l2');
const progressFile = path.join(base, 'workflow.json');
const stopFlag = path.join(base, 'workflow.stop');

// 读取真实场景号范围（可被 WF_LIMIT 限制，便于小范围验证）
const scenesDoc = (() => { try { return JSON.parse(fs.readFileSync(path.join(base, 'scenes-llm.json'), 'utf8')); } catch { return { scenes: [] }; } })();
let sceneList = scenesDoc.scenes || [];
const limit = Number(process.env.WF_LIMIT || 0);
if (limit > 0) sceneList = sceneList.slice(0, limit);
const firstScene = sceneList[0]?.sceneId || 'SC001';
const lastScene = sceneList[sceneList.length - 1]?.sceneId || firstScene;

const STEPS = {
  1: { name: '小说清洗', manual: true },
  2: { name: '内容编号', manual: true },
  3: {
    name: '场景切分',
    // 等价于「3. 场景切分」的 开始切分
    http: { path: '/api/scenes/segment', body: {}, async: true, progress: '/api/scenes/progress' },
  },
  4: {
    name: '生成角色',
    // 等价于「4. 生成角色」的三个按钮，按顺序执行
    subs: [
      { key: '4.1', name: '真名表', http: { path: '/api/characters/table', body: {} } },
      { key: '4.2', name: '人称', http: { path: '/api/mentions/table', body: {} } },
      { key: '4.3', name: '映射', http: { path: '/api/characters/map', body: {} } },
    ],
  },
  5: {
    name: '场景详述',
    // 等价于「5. 场景详述」的 生成全部
    http: { path: '/api/scenes/detail/range', body: { all: true, from: firstScene, to: lastScene }, async: true, progress: '/api/scenes/detail/progress' },
  },
  6: {
    name: '角色重构',
    // 等价于「6. 角色重构」的 开始重构
    http: { path: '/api/reconcile/run', body: {}, async: true, progress: '/api/reconcile/progress' },
  },
};

function save(state) {
  fs.writeFileSync(progressFile, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 1), 'utf8');
}

const state = {
  running: true,
  from, to,
  current: from,
  steps: Object.fromEntries(Object.entries(STEPS).map(([k, v]) => [k, { name: v.name, status: 'pending' }])),
};
if (fs.existsSync(stopFlag)) fs.rmSync(stopFlag, { force: true });

// 重置本轮步骤状态，避免沿用上一轮的结果
for (let i = from; i <= to; i += 1) {
  if (state.steps[i]) { state.steps[i].status = 'pending'; delete state.steps[i].seconds; delete state.steps[i].log; }
}
delete state.stopped; delete state.failed;

for (let i = from; i <= to; i += 1) {
  const step = STEPS[i];
  if (!step) continue;
  if (fs.existsSync(stopFlag)) { state.stopped = true; break; }
  state.current = i;

  if (step.manual) {
    state.steps[i].status = 'manual';
    save(state);
    console.log(`第 ${i} 步「${step.name}」需在界面手动完成，跳过`);
    continue;
  }

  state.steps[i].status = 'running';
  state.steps[i].startedAt = Date.now();
  state.steps[i].subs = (step.subs || []).map((sub) => ({ key: sub.key, name: sub.name, status: 'pending' }));
  save(state);
  console.log(`▶ 第 ${i} 步：${step.name}`);

  const t0 = Date.now();
  let ok = true;
  const bookId = path.basename(work);
  const callApi = async (pathName, body) => {
    try {
      return await httpRequestJson('POST', pathName, { id: bookId, ...(body || {}) });
    } catch (error) {
      return { ok: false, status: 0, data: { error: error.message } };
    }
  };
  const waitDone = async (progressPath) => {
    for (let n = 0; n < 4320; n += 1) {          // 最长等 12 小时
      await new Promise((r) => setTimeout(r, 10000));
      try {
        const p = await httpRequestJson('GET', progressPath + '?id=' + encodeURIComponent(bookId), {}).then((r) => r.data);
        if (!p || p.running === false) return true;
      } catch { /* 服务忙时重试 */ }
      if (fs.existsSync(stopFlag)) return false;
    }
    return false;
  };

  if (step.http) {
    const res = await callApi(step.http.path, step.http.body);
    ok = res.ok && res.data.ok !== false;
    if (!ok) state.steps[i].log = [String(res.data.error || res.status)];
    if (ok && step.http.async && step.http.progress) ok = await waitDone(step.http.progress);
  } else if (step.subs && step.subs.length) {
    for (let si = 0; si < step.subs.length; si += 1) {
      const sub = step.subs[si];
      state.steps[i].subs[si].status = 'running';
      state.steps[i].subs[si].startedAt = Date.now();
      save(state);
      console.log(`   ▶ ${sub.key} ${sub.name}`);
      const res = await callApi(sub.http.path, sub.http.body);
      let okSub = res.ok && res.data.ok !== false;
      // 生成角色三个接口是异步的：等它真正跑完再判成功
      if (okSub && sub.http.async !== false && sub.http.path.startsWith('/api/characters')) {
        for (let n = 0; n < 4320; n += 1) {
          await new Promise((r) => setTimeout(r, 5000));
          const pr = await httpRequestJson('GET', '/api/characters/progress?id=' + encodeURIComponent(path.basename(work)), {}).catch(() => null);
          if (!pr) continue;
          if (!pr.data.running) { okSub = pr.data.code === 0 || pr.data.code === null; break; }
          if (fs.existsSync(stopFlag)) { okSub = false; break; }
        }
      }
      state.steps[i].subs[si].status = okSub ? 'done' : 'failed';
      state.steps[i].subs[si].seconds = Math.round((Date.now() - state.steps[i].subs[si].startedAt) / 1000);
      state.steps[i].subs[si].log = JSON.stringify(res.data.totals || res.data.error || '').slice(0, 160);
      save(state);
      if (!okSub) { ok = false; break; }
      if (fs.existsSync(stopFlag)) break;
    }
  } else {
    const res = await callApi(step.httpPath || '/api/workflow/noop');
    ok = res.ok;
  }
  state.steps[i].status = ok ? 'done' : 'failed';
  state.steps[i].seconds = Math.round((Date.now() - t0) / 1000);
  save(state);
  console.log(`   ${ok ? '✓' : '✗'} ${step.name}（${state.steps[i].seconds}s）`);
  if (!ok) { state.failed = i; break; }
}

state.running = false;
save(state);
console.log('工作流结束');
