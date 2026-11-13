import { chatViaConsole } from '../core/console-client.mjs';
import fs from 'node:fs';
import path from 'node:path';

// 确保输出目录存在（新书首次运行时 l2 可能还没建）
function ensureOutputDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ } }

/**
 * 角色重构：逐场景对比「原文 / 详述 / 角色表 / 关系表 / 疑问」，
 * 由模型判定正确的角色与关系，产出报告并可应用到角色表与关系表。
 *
 * 用法：
 *   node tools/reconcile-characters.mjs <work> <fromScene> <toScene> [--apply]
 * 输出：
 *   l2/reconcile/<sceneId>.json    单场报告
 *   l2/reconcile-report.json       汇总
 *   加 --apply 时更新 characters.json 与 relations.json
 */

const work = process.argv[2] || 'work/美少妇的哀羞';
const fromScene = process.argv[3] || 'SC001';
const toScene = process.argv[4] || fromScene;
const APPLY = process.argv.includes('--apply');
const skipDone = process.env.SKIP_DONE === '1';   // 只重构未完成的场次
const MODEL = process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K';

const base = path.join(work, 'l2');
ensureOutputDir(base);
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

const book = read(path.join(work, 'book.json'), { chapters: [] });
const scenes = read(path.join(base, 'scenes-llm.json'), { scenes: [] }).scenes;
const charsDoc = read(path.join(base, 'characters.json'), { characters: [] });
const relDoc = read(path.join(base, 'relations.json'), { relations: [] });
const detailDoc = read(path.join(base, 'scene-details.json'), { details: {} });

const textOf = new Map();
for (const c of book.chapters || []) for (const p of c.paragraphs || []) for (const s of p.sentences || []) {
  const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
  if (n) textOf.set(n, String(s.text || ''));
}

const iFrom = scenes.findIndex((s) => s.sceneId === fromScene);
const iTo = scenes.findIndex((s) => s.sceneId === toScene);
if (iFrom < 0 || iTo < 0) { console.error('场景号不存在'); process.exit(1); }
const range = scenes.slice(Math.min(iFrom, iTo), Math.max(iFrom, iTo) + 1);

const stopFlag = path.join(base, 'reconcile.stop');
if (fs.existsSync(stopFlag)) fs.rmSync(stopFlag, { force: true });   // 新任务开始时清除旧标记
const outDir = path.join(base, 'reconcile');
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(base, 'reconcile-report.json');
const report = read(reportPath, { scenes: {}, totals: {} });

function saveSceneReport(sceneId, entry) {
  const cur = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { scenes: {}, totals: {} };
  cur.scenes = cur.scenes || {};
  cur.scenes[sceneId] = entry;
  cur.totals = {
    scenes: Object.keys(cur.scenes).length,
    newCharacters: Object.values(cur.scenes).reduce((n, s) => n + (s.需新增角色 || []).length, 0),
    confirmed: Object.values(cur.scenes).reduce((n, s) => n + (s.关系确认 || []).length, 0),
    fixed: Object.values(cur.scenes).reduce((n, s) => n + (s.关系修正 || []).length + (s.关系删除 || []).length, 0),
  };
  fs.writeFileSync(reportPath, JSON.stringify(cur, null, 1), 'utf8');
  report.scenes = cur.scenes;
  report.totals = cur.totals;
}

async function callModel(prompt) {
  const result = await chatViaConsole({ prompt, source: 'reconcile-characters.mjs', maxTokens: 0 });
  const reply = { ok: result.ok, status: result.ok ? 200 : 502, json: async () => ({ choices: [{ message: { content: result.content } }], usage: result.usage }) };
  if (!reply.ok) return { error: 'HTTP ' + reply.status };
  const data = await reply.json();
  const raw = String(data.choices?.[0]?.message?.content || '');
  const body = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try { return { data: JSON.parse(body) }; } catch { return { error: 'JSON 解析失败' }; }
}

// 每场跑完立刻把该场关系写入 relations.json（场景级替换），并同步新角色
function applySceneNow(sceneId, d, detailId) {
  const relFile = path.join(base, 'relations.json');
  const doc = fs.existsSync(relFile) ? JSON.parse(fs.readFileSync(relFile, 'utf8')) : { relations: [] };
  const rels = doc.relations || [];
  for (let i = rels.length - 1; i >= 0; i -= 1) if (rels[i].sceneId === sceneId) rels.splice(i, 1);
  const push = (fromName, type, toName) => {
    const f = String(fromName || '').trim(); const ty = String(type || '').trim(); const to = String(toName || '').trim();
    if (!f || !ty || !to || f === to) return;
    if (rels.some((r) => r.sceneId === sceneId && r.fromName === f && r.type === ty && r.toName === to)) return;
    rels.push({ id: 'R' + String(rels.length + 1).padStart(5, '0'), sceneId, detailId, fromName: f, type: ty, toName: to, evidence: [], source: 'reconcile' });
  };
  for (const cf of d['关系确认'] || []) push(cf['甲'], cf['关系'], cf['乙']);
  for (const fx of d['关系修正'] || []) {
    const m = String(fx['改为'] || '').match(/^(.+?)\s*-\s*(.+?)\s*->\s*(.+)$/);
    if (m) push(m[1], m[2], m[3]);
  }
  for (const del of d['关系删除'] || []) {
    const m = String(del['关系'] || '').match(/^(.+?)\s*-\s*(.+?)\s*->\s*(.+)$/);
    if (!m) continue;
    for (let i = rels.length - 1; i >= 0; i -= 1) {
      const r = rels[i];
      if (r.sceneId === sceneId && r.fromName === m[1].trim() && r.type === m[2].trim() && r.toName === m[3].trim()) rels.splice(i, 1);
    }
  }
  doc.relations = rels;
  doc.totals = { relations: rels.length };
  doc.schema = 'relations/v2';
  fs.writeFileSync(relFile, JSON.stringify(doc, null, 1), 'utf8');

  // 新角色立即入表
  const charFile = path.join(base, 'characters.json');
  const chars = fs.existsSync(charFile) ? JSON.parse(fs.readFileSync(charFile, 'utf8')) : { characters: [] };
  let added = 0;
  for (const n of d['需新增角色'] || []) {
    const name = String(n['姓名'] || '').trim();
    if (!name || name.length > 8) continue;
    if ((chars.characters || []).some((c) => c.name === name)) continue;
    chars.characters.push({ id: 'CH' + String(chars.characters.length + 1).padStart(2, '0'), name, aliases: [], fromScene: sceneId, basis: n['依据'] || '' });
    added += 1;
  }
  if (added) { chars.totals = { characters: chars.characters.length }; fs.writeFileSync(charFile, JSON.stringify(chars, null, 1), 'utf8'); }
  return { relations: rels.length, added };
}

const charNames = (charsDoc.characters || []).map((c) => c.id + ' ' + c.name).join(' / ');
const relList = relDoc.relations || [];
// 按场景号索引：如果关系带 sceneId，就只在本场使用
const relByScene = new Map();
for (const r of relList) {
  if (!r.sceneId) continue;
  if (!relByScene.has(r.sceneId)) relByScene.set(r.sceneId, []);
  relByScene.get(r.sceneId).push(r);
}

for (const scene of range) {
  if (skipDone) {
    const prev = report.scenes?.[scene.sceneId];
    if (prev && !prev.error) continue;             // 已成功，跳过
  }
  if (fs.existsSync(stopFlag)) {
    console.log('收到停止指令，处理完已开始的场景后退出');
    break;
  }
  const from = Number(String(scene.from).slice(1));
  const to = Number(String(scene.to).slice(1));
  const text = [];
  for (let n = from; n <= to; n += 1) if (textOf.has(n)) text.push(n + '. ' + textOf.get(n));
  const detail = detailDoc.details?.[scene.sceneId] || null;
  const questions = (detail?.['疑问'] || []).map((q) => `${q['编号'] || ''} [${q['类型'] || ''}] ${q['描述'] || ''}`).join('\n');

  // 本场关系：只用与本场有关的部分，避免把全书关系灌给模型
  const sceneText = text.join('\n');
  const sceneRels = relByScene.get(scene.sceneId) || relList.filter((r) =>
    (r.fromName && sceneText.includes(r.fromName)) || (r.toName && sceneText.includes(r.toName)));
  const sceneRelLines = [...new Set(sceneRels.map((r) => r.fromName + ' -' + r.type + '-> ' + r.toName))].slice(0, 15).join('；');

  const prompt = [
    '你在做角色信息的一致性重构。已知四人份材料：原文、场景详述、角色真名表、角色关系表、详述提出的疑问。',
    '',
    '【角色真名表】', charNames || '（空）',
    '',
    '【本场相关关系（来自场景级关系表，没提到的不要自己编）】', sceneRelLines || '（无）',
    '',
    '【场景原文】', text.join('\n').slice(0, 6000),
    '',
    '【场景详述·人物】', JSON.stringify(detail?.['人物'] || []).slice(0, 3000),
    '',
    '【场景详述·情节】', (detail?.['情节'] || []).map((s) => s['内容']).join('；').slice(0, 3000),
    '',
    '【详述提出的疑问】', questions || '（无）',
    '',
    '请逐项判定，只输出 JSON：',
    '{"结论":"一段话总结本场角色情况",',
    ' "需新增角色":[{"姓名":"王叔","依据":"S142 原文称王叔"}],',
    ' "关系确认":[{"甲":"玉彬","关系":"小依的丈夫","乙":"小依"}],',
    ' "关系修正":[{"原":"阿宏 - 小依的老公 -> 小依","改为":"阿宏 - 小依的掳掠者 -> 小依","理由":"原文未称阿宏为丈夫"}],',
    ' "关系删除":[{"关系":"袁爷 - 玉彬的丈夫 -> 玉彬","理由":"玉彬是丈夫，袁爷是债主"}],',
    ' "疑问裁决":[{"编号":"Q001","判定":"表错","说明":"关系表该边应删"}]}',
    '',
    '规则：姓名必须是真名或外号，不要写「他/她/你们」。判不出来的不要写。',
  ].join('\n');

  let result = await callModel(prompt);
  if (result.error) result = await callModel(prompt + '\n\n注意：只输出合法 JSON。');
  if (result.error) {
    saveSceneReport(scene.sceneId, { error: result.error, at: new Date().toISOString() });
    console.log(scene.sceneId, '失败', result.error);
    continue;
  }

  const d = result.data;
  const entry = {
    结论: d['结论'] || '',
    需新增角色: d['需新增角色'] || [],
    关系确认: d['关系确认'] || [],
    关系修正: d['关系修正'] || [],
    关系删除: d['关系删除'] || [],
    疑问裁决: d['疑问裁决'] || [],
    applied: false,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, scene.sceneId + '.json'), JSON.stringify(entry, null, 1), 'utf8');
  saveSceneReport(scene.sceneId, entry);
  const applied = applySceneNow(scene.sceneId, d, detailDoc.details?.[scene.sceneId]?.detailId || '');
  console.log(scene.sceneId, '→ 新增', (d['需新增角色'] || []).length, '确认', (d['关系确认'] || []).length, '修正/删除', (d['关系修正'] || []).length + (d['关系删除'] || []).length);
}

if (APPLY) {
  // 角色：新增即入表（附来源场景）
  const chars = charsDoc.characters || [];
  let added = 0;
  for (const [sceneId, sc] of Object.entries(report.scenes)) {
    for (const n of sc.需新增角色 || []) {
      const name = String(n['姓名'] || '').trim();
      if (!name || name.length > 8) continue;
      if (chars.some((c) => c.name === name)) continue;
      chars.push({ id: 'CH' + String(chars.length + 1).padStart(2, '0'), name, aliases: [], fromScene: sceneId, basis: n['依据'] || '' });
      added += 1;
    }
  }
  charsDoc.characters = chars;
  charsDoc.totals = { characters: chars.length };
  fs.writeFileSync(path.join(base, 'characters.json'), JSON.stringify(charsDoc, null, 1), 'utf8');

  // 关系：按场景挂接（同一对角色在不同场景可有不同关系，互不覆盖）
  const rels = relDoc.relations || [];
  const nextId = () => 'R' + String(rels.length + 1).padStart(5, '0');
  let appended = 0;
  let replaced = 0;
  for (const [sceneId, sc] of Object.entries(report.scenes)) {
    const detailId = detailDoc.details?.[sceneId]?.detailId || '';
    // 该场景旧记录先移除（重跑同一场时替换，不影响其它场景）
    const before = rels.length;
    for (let i = rels.length - 1; i >= 0; i -= 1) if (rels[i].sceneId === sceneId) rels.splice(i, 1);
    replaced += before - rels.length;

    const push = (fromName, type, toName, evidence) => {
      const f = String(fromName || '').trim();
      const ty = String(type || '').trim();
      const to = String(toName || '').trim();
      if (!f || !ty || !to || f === to) return;
      if (rels.some((r) => r.sceneId === sceneId && r.fromName === f && r.type === ty && r.toName === to)) return;
      rels.push({ id: nextId(), sceneId, detailId, fromName: f, type: ty, toName: to, evidence: evidence || [], source: 'reconcile' });
      appended += 1;
    };

    for (const cf of sc.关系确认 || []) push(cf['甲'], cf['关系'], cf['乙'], []);
    for (const fx of sc.关系修正 || []) {
      const m = String(fx['改为'] || '').match(/^(.+?)\s*-\s*(.+?)\s*->\s*(.+)$/);
      if (m) push(m[1], m[2], m[3], []);
    }
    // 删除：只删除本场景内的同名边
    for (const del of sc.关系删除 || []) {
      const m = String(del['关系'] || '').match(/^(.+?)\s*-\s*(.+?)\s*->\s*(.+)$/);
      if (!m) continue;
      for (let i = rels.length - 1; i >= 0; i -= 1) {
        const r = rels[i];
        if (r.sceneId === sceneId && r.fromName === m[1].trim() && r.type === m[2].trim() && r.toName === m[3].trim()) rels.splice(i, 1);
      }
    }
  }
  relDoc.relations = rels;
  relDoc.totals = { relations: rels.length };
  relDoc.schema = 'relations/v2';
  fs.writeFileSync(path.join(base, 'relations.json'), JSON.stringify(relDoc, null, 1), 'utf8');
  console.log(`应用：新增角色 ${added}，新增场景关系 ${appended}，替换旧场次 ${replaced}，关系总数 ${rels.length}`);
}

console.log('完成，报告：', reportPath);
