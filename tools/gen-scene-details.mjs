import { chatViaConsole } from '../core/console-client.mjs';
import { logPrompt } from '../core/prompt-log.mjs';
import { loadKnowledge, promptContext, upsertPerson, upsertRelation, isRoleOnly } from '../core/knowledge.mjs';
import { resolvePrompt } from '../core/tab-config.mjs';
import { renderTemplate } from '../core/prompt-templates.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, storageMode, upsertSceneDetails, withTransaction } from '../core/db.mjs';
import { withJsonLock, writeJsonAtomic } from '../core/atomic-json.mjs';
import { assertNotShrinking, countOf } from '../core/guard.mjs';

// 确保输出目录存在（新书首次运行时 l2 可能还没建）
function ensureOutputDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ } }

/**
 * 场景详述（命令行版，避免 HTTP 超时）：逐场生成、逐场落盘。
 * 用法：node tools/gen-scene-details.mjs <work> [数量] [起始场景号]
 */

const work = process.argv[2] || 'work/美少妇的哀羞';
const fromScene = process.argv[3] || '';
const toScene = process.argv[4] || fromScene;
const count = 0;         // 兼容旧参数，按场景号范围时不用
const startIndex = 0;
const FORCE = process.env.FORCE === '1';
const MODEL = process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K';
let currentRunId = '';
let lastSystemHash = '';
const mode = storageMode();
const dbFile = path.join(work, 'corpus.db');
// 新书还没入库时退回 JSON 模式：详情照常生成，入库等迁移后再做
let activeMode = mode;
if (mode === 'sqlite' && !fs.existsSync(dbFile)) {
  console.log('这本书还没有数据库，先按 JSON 模式生成（稍后可迁移入库）');
  activeMode = 'json';
}

const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const scenes = JSON.parse(fs.readFileSync(path.join(work, 'l2', 'scenes-llm.json'), 'utf8')).scenes;
const detailsPath = path.join(work, 'l2', 'scene-details.json');
function readStore() {
  const current = fs.existsSync(detailsPath) ? JSON.parse(fs.readFileSync(detailsPath, 'utf8')) : { details: {}, index: {}, failed: {} };
  current.details = current.details || {};
  current.index = current.index || {};
  current.failed = current.failed || {};
  return current;
}
const store = readStore();

const charFile = path.join(work, 'l2', 'characters.json');
const characters = fs.existsSync(charFile) ? JSON.parse(fs.readFileSync(charFile, 'utf8')).characters || [] : [];
const relFile = path.join(work, 'l2', 'relations.json');
const relations = fs.existsSync(relFile) ? JSON.parse(fs.readFileSync(relFile, 'utf8')).relations || [] : [];

const textOf = new Map();
for (const c of book.chapters || []) for (const p of c.paragraphs || []) for (const s of p.sentences || []) {
  const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
  if (n) textOf.set(n, String(s.text || ''));
}

async function waitGateway(maxMs = 900000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch('http://127.0.0.1:8090/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '好' }], max_tokens: 2, stream: false, reasoning_effort: 'none' }),
      });
      if (r.ok) return true;
      if (r.status === 503) { console.log('网关 503（手动模式），等待'); }
    } catch { /* 忽略 */ }
    await new Promise((res) => setTimeout(res, 15000));
  }
  return false;
}

let lastRaw = '';

function normalizeDetailShape(detail) {
  if (!detail || typeof detail !== 'object') return detail;
  // 情节：兼容不同键名与字符串数组
  const plot = detail['情节'] ?? detail['情节经过'] ?? detail['steps'] ?? detail['plot'];
  if (Array.isArray(plot)) {
    detail['情节'] = plot.map((s, i) => (typeof s === 'string'
      ? { 步骤: i + 1, 内容: s }
      : { 步骤: Number(s['步骤'] || i + 1), 内容: String(s['内容'] || s['文本'] || ''), ...(Array.isArray(s['证据句']) ? { 证据句: s['证据句'] } : {}) }));
  } else {
    detail['情节'] = [];
  }
  // 人物：兼容对象字典
  if (!Array.isArray(detail['人物'])) {
    const people = detail['人物'] || detail['人物表'] || detail['characters'] || detail['角色'] || detail['出场人物'] || detail['people'];
    detail['人物'] = people && typeof people === 'object'
      ? Object.entries(people).map(([name, v]) => ({ 姓名: name, ...(v || {}) }))
      : [];
  }
  if (!Array.isArray(detail['关系'])) detail['关系'] = [];
  return detail;
}

async function callModel(input, budget = 32768, outputLimit = 0) {
  const systemText = typeof input === 'object' && input ? String(input.system || '') : '';
  const prompt = typeof input === 'object' && input ? String(input.user || '') : String(input || '');
  if (systemText) {
    const hash = crypto.createHash('sha256').update(systemText).digest('hex').slice(0, 12);
    if (lastSystemHash && lastSystemHash !== hash) console.log('  system 哈希变化:', lastSystemHash, '→', hash);
    else if (!lastSystemHash) console.log('  system 哈希:', hash, '长度', systemText.length);
    lastSystemHash = hash;
  }
  logPrompt(work, 'scenedetail', prompt);
  let result = await chatViaConsole({ prompt, system: systemText, source: 'gen-scene-details.mjs', maxTokens: budget, cachePrompt: true, runId: currentRunId, ...(outputLimit ? { maxOutputTokens: outputLimit } : {}), ...(process.env.CORPUS_MODEL ? { model: process.env.CORPUS_MODEL } : {}) });
  if (!result.ok && String(result.error || '').includes('死循环')) {
    console.log('  输出重复，降半预算重试');
    result = await chatViaConsole({ prompt, system: systemText, source: 'gen-scene-details.mjs', maxTokens: Math.max(4096, Math.floor(budget / 2)), cachePrompt: true, runId: currentRunId, ...(outputLimit ? { maxOutputTokens: outputLimit } : {}), ...(process.env.CORPUS_MODEL ? { model: process.env.CORPUS_MODEL } : {}) });
  }
  const reply = { ok: result.ok, status: result.ok ? 200 : 502, json: async () => ({ choices: [{ message: { content: result.content } }], usage: result.usage }) };
  if (!reply.ok) return { error: 'HTTP ' + reply.status };
  const data = await reply.json();
  const raw = String(data.choices?.[0]?.message?.content || '');
  lastRaw = raw;
  const body = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try { return { detail: normalizeDetailShape(JSON.parse(body)) }; } catch {
    const fixed = body.replace(/,\s*([}\]])/g, '$1');
    try { return { detail: normalizeDetailShape(JSON.parse(fixed)) }; } catch { return { error: 'JSON 解析失败' }; }
  }
}

function normalizeQuestions(detail, from, to) {
  const raw = detail['疑问'] || detail['疑点'] || [];
  const out = [];
  let i = 0;
  for (const q of Array.isArray(raw) ? raw : []) {
    i += 1;
    if (typeof q === 'string') {
      const nums = [...q.matchAll(/(?:第\s*)?(\d{1,5})\s*(?:句|、|,)/g)].map((m) => Number(m[1])).filter((n) => n >= from && n <= to);
      out.push({ 编号: 'Q' + String(i).padStart(3, '0'), 类型: '其他', 描述: q, 证据句: [...new Set(nums)] });
      continue;
    }
    const nums = Array.isArray(q['证据句']) ? q['证据句'].map(Number).filter((n) => n >= from && n <= to) : [];
    out.push({
      编号: q['编号'] || 'Q' + String(i).padStart(3, '0'),
      类型: q['类型'] || '其他',
      描述: q['描述'] || '',
      预处理: q['预处理'] || '',
      分析: q['分析'] || '',
      证据句: [...new Set(nums)],
    });
  }
  return out;
}

let promptCtx = { people: [], identity: [] };
function refreshKnowledge() {
  promptCtx = promptContext(work);
  characters.length = 0;
  characters.push(...loadKnowledge(work).characters);
}

function refreshCharacters() {
  const doc = loadCharacters(work);
  characters.length = 0;
  characters.push(...(doc.characters || []));
}


// 只保留本场原文里真实出现的角色
function filterPresentPeople(people, text, scene, steps) {
  // 在场判定 + 显示名用本场原文实际使用的称呼
  const knowledge = loadKnowledge(work);
  const aliasOf = new Map((knowledge.characters || []).map((c) => [c.name, [c.name, ...(c.aliases || [])].filter(Boolean)]));
  const aliasToName = new Map();
  for (const c of knowledge.characters || []) {
    aliasToName.set(c.name, c.name);
    for (const al of c.aliases || []) if (al) aliasToName.set(al, c.name);
  }

  const sentenceText = new Map();
  try {
    const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
    for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const s of p.sentences || []) {
      const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
      if (n) sentenceText.set(n, String(s.text || ''));
    }
  } catch { /* 忽略 */ }

  const a = Number(String(scene.from).slice(1));
  const b = Number(String(scene.to).slice(1));
  const sceneSentences = [...sentenceText.keys()].filter((n) => n >= a && n <= b).sort((x, y) => x - y);

  const count = (s) => (s ? text.split(s).length - 1 : 0);
  const kept = [];
  const dropped = [];

  for (const person of people || []) {
    const rawName = String(person['姓名'] || '').trim();
    if (!rawName) continue;
    // 代称一律换成真名；真名表只放真名
    const nm = aliasToName.get(rawName) || rawName;
    if (nm !== rawName) {
      person['代称'] = [...new Set([...(person['代称'] || []), rawName])];
    }
    const forms = (aliasOf.get(nm) || [nm]).filter(Boolean);
    const hits = sceneSentences.filter((n) => {
      const line = sentenceText.get(n) || '';
      return forms.some((f) => line.includes(f));
    });
    // 角色表为空时（新书还没生成角色），只要本场出现过就保留
    const inTable = aliasOf.has(nm);
    const minHits = inTable ? 1 : (aliasOf.size === 0 ? 1 : 2);
    if (hits.length < minHits) { dropped.push(nm); continue; }

    // 显示名：正式名在本场出现过就用正式名
    // 否则只有当最常用代称「像人名」（不是我/你/他/妹妹/爸爸这类）时，才用它
    const KIN = new Set(['我','你','他','她','我们','你们','他们','她们','人家','自己','妹妹','哥哥','姐姐','弟弟','爸爸','妈妈','父亲','母亲','儿子','女儿','公公','婆婆','老公','老婆','丈夫','妻子','叔叔','阿姨','舅舅','爷爷','奶奶','姥姥','孩子','众人']);
    let best = nm;
    if (count(nm) === 0) {
      const KIN_CHARS = /[儿媳妇女男哥姐弟妹爸妈父母公婆叔姨舅爷奶孙媳婿]/;
      const BAD = new Set(['名穴','肉棒','龟头','阴道','子宫','淫水','精液','乳房','屁股','肉穴','阳具','阴蒂','奶子','小穴','屁眼','俏脸','胴体','骚货','荡妇','婊子','淫妇','老东西','烂人','黑熊','土大款','癞蛤蟆','老男人','好儿媳','好爸爸','好爹爹','乖儿媳','老父亲','冰山手术刀']);
      const candidates = forms.filter((f) => !KIN.has(f) && !BAD.has(f) && f.length >= 2 && f.length <= 5 && !KIN_CHARS.test(f)).map((f) => [f, count(f)]).sort((a, b) => b[1] - a[1]);
      if (candidates.length && candidates[0][1] >= 2) best = candidates[0][0];
    }
    person['证据句'] = hits.slice(0, 20);
    if (best !== nm) {
      person['正式名'] = nm;
      person['姓名'] = best;
    }
    kept.push(person);
  }

  if (dropped.length) console.log('  出场人物过滤:', dropped.join('、'));
  return kept;
}


// 上一场提要：人物（含社会身份）、关系、情节前若干步

// 关系去重与角色互校：同一对人只能保留一条身份关系
const RECIPROCAL = {
  丈夫: ['妻子'], 妻子: ['丈夫'], 父亲: ['儿子', '女儿'], 母亲: ['儿子', '女儿'],
  儿子: ['父亲', '母亲'], 女儿: ['父亲', '母亲'], 哥哥: ['弟弟', '妹妹'], 姐姐: ['弟弟', '妹妹'],
  弟弟: ['哥哥', '姐姐'], 妹妹: ['哥哥', '姐姐'], 公公: ['儿媳'], 婆婆: ['儿媳'],
  儿媳: ['公公', '婆婆'], 岳父: ['女婿'], 岳母: ['女婿'], 女婿: ['岳父', '岳母'],
  未婚夫: ['未婚妻'], 未婚妻: ['未婚夫'], 上司: ['下属'], 下属: ['上司'],
};

function normalizeRelationSet(relations, known) {
  const knownKey = new Set();
  for (const k of known || []) {
    const a = String(k.a || '').trim();
    const b = String(k.b || '').trim();
    if (a && b) knownKey.add([a, b].sort().join('|'));
  }

  const groups = new Map();
  for (const r of relations || []) {
    const a = String(r['甲'] || '').trim();
    const b = String(r['乙'] || '').trim();
    if (!a || !b || a === b) continue;
    const key = [a, b].sort().join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, 甲: a, 乙: b });
  }

  const out = [];
  const dropped = [];
  for (const [key, list] of groups) {
    const scored = list.map((r) => {
      let score = 0;
      if (knownKey.has(key)) score += 5;
      score += (r['证据句'] || []).length * 2;
      const allowed = RECIPROCAL[r['甲角色']];
      if (allowed && allowed.includes(r['乙角色'])) score += 3;
      return { r, score };
    }).sort((x, y) => y.score - x.score);

    const best = scored[0].r;
    const allowed = RECIPROCAL[best['甲角色']];
    if (allowed && allowed.length && !allowed.includes(best['乙角色'])) {
      const fixed = allowed[0];
      if (best['乙角色'] !== fixed) {
        console.log('  关系互校:', best['甲'], '→', best['甲角色'], '/', best['乙'], '：', best['乙角色'], '→', fixed);
        best['乙角色'] = fixed;
      }
    }
    out.push(best);
    for (const s of scored.slice(1)) dropped.push(s.r);
  }

  if (dropped.length) {
    console.log('  关系去重：丢弃 ' + dropped.length + ' 条冲突关系');
    for (const d of dropped.slice(0, 5)) console.log('    ×', d['甲'], '→', d['甲角色'], '/', d['乙']);
  }
  return out;
}


// 从调用日志汇总本场缓存命中（按 runId）
function sceneCacheStats(runId) {
  const file = path.join(process.cwd(), 'console-log.jsonl');
  let hit = 0; let total = 0; let calls = 0;
  try {
    if (fs.existsSync(file) && runId) {
      for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
        if (!line) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.runId !== runId) continue;
        calls += 1;
        hit += Number(row.cacheN || 0);
        total += Number(row.cacheN || 0) + Number(row.promptN || 0);
      }
    }
  } catch { /* 忽略 */ }
  return { calls, hit, total, pct: total ? Math.round((hit / total) * 100) : 0 };
}

function buildPrevSummary(store, scenes, index) {
  const prevScene = index > 0 ? scenes[index - 1] : null;
  if (!prevScene) return '（本场是全书第一场，没有前情）';

  // 每次现场读取，避免用到启动时的旧快照
  let fresh = {};
  try { fresh = readStore(); } catch { fresh = store || {}; }
  const prev = (fresh.details || {})[prevScene.sceneId];
  if (!prev) return '（上一场 ' + prevScene.sceneId + ' 尚未生成，无前情）';

  // 有本场提要就直接用，最贴近上一场实际内容
  const summary = String(prev['提要'] || '').trim();
  if (summary) {
    console.log('  前情来源:', prevScene.sceneId, '提要', summary.length, '字');
    return [
      '上一场：' + prevScene.sceneId + '（' + prevScene.from + '~' + prevScene.to + '）',
      summary,
      '',
      '以上仅为背景。本场分析必须以【本场原文】为准，不要套用上一场的人物或关系。',
    ].join('\n');
  }
  console.log('  前情来源:', prevScene.sceneId, '（无提要，改用人物/关系/情节概要）');

  const people = (prev['人物'] || []).slice(0, 10).map((p) => {
    const role = String(p['社会身份'] || '').trim();
    return String(p['姓名'] || '') + (role ? '（' + role + '）' : '');
  }).join('、') || '（无）';
  const rels = (prev['关系'] || []).slice(0, 12).map((r) => r['甲'] + '→' + (r['甲角色'] || '?') + '/' + r['乙']).join('；') || '（无）';
  const steps = (prev['情节'] || []);
  const tail = steps.slice(-8).map((s) => (s['步骤'] || '') + '. ' + String(s['内容'] || '')).join('\n') || '（无）';
  return [
    '上一场：' + prevScene.sceneId + '（' + prevScene.from + '~' + prevScene.to + '，' + steps.length + ' 步）',
    '出场人物：' + people,
    '人物关系：' + rels,
    '情节末尾：',
    tail,
    '',
    '以上仅为背景。本场分析必须以【本场原文】为准，不要套用上一场的人物或关系。',
  ].join('\n');
}


// 按场景号范围（含端点），已生成的在非 FORCE 模式下跳过
const iFrom = scenes.findIndex((s) => s.sceneId === fromScene);
const iTo = scenes.findIndex((s) => s.sceneId === toScene);
if (iFrom < 0 || iTo < 0) { console.error('场景号不存在:', fromScene, toScene); process.exit(1); }
const rangeScenes = scenes.slice(Math.min(iFrom, iTo), Math.max(iFrom, iTo) + 1);
let todo = FORCE ? rangeScenes : rangeScenes.filter((s) => !store.details[s.sceneId]);
if (process.env.DETAIL_ONLY) {
  const only = new Set(String(process.env.DETAIL_ONLY).split(',').map((x) => x.trim()).filter(Boolean));
  todo = todo.filter((s) => only.has(s.sceneId));
  console.log('指定场景数:', todo.length);
}
console.log('本次生成:', todo.map((s) => s.sceneId).join(', '));

for (const scene of todo) {
  const from = Number(String(scene.from).slice(1));
  const to = Number(String(scene.to).slice(1));
  const lines = [];
  for (let n = from; n <= to; n += 1) if (textOf.has(n)) lines.push(n + '. ' + textOf.get(n));
  const t0 = Date.now();
  if (!(await waitGateway())) { console.log(scene.sceneId, '网关长时间不可用，停止'); break; }
  refreshKnowledge();

  const sceneStartedAt = Date.now();
  currentRunId = scene.sceneId + '-' + Date.now();

  // 大场景分块 + 分步生成：先人物，再情节；最后疑问
  const CHUNK_LINES = 30;

  const prevSummary = buildPrevSummary(store, scenes, Math.max(0, scenes.findIndex((s) => s.sceneId === scene.sceneId)));
  const buildPartial = (view, part, extra = {}) => {
    const full = renderTemplate(view, {
    前情提要: prevSummary,
    场景: extra.场景 || scene.sceneId,
    本场人物: extra.本场人物 || '',
    本场关系: extra.本场关系 || '',
    人物表: promptCtx.people.join(' / ') || '（无）',
    关系表: promptCtx.identity.slice(0, 20).join('；') || '（无）',
    补充要求: resolvePrompt('scenedetail') ? ('【补充要求】' + resolvePrompt('scenedetail')) : '',
    原文: '本场：' + scene.sceneId + '（' + scene.from + '~' + scene.to + '）\n' + part.join('\n'),
    });
    // 拆成 system（固化区：固定资料）与 user（半固化区 + 问题区）
    const cut = full.indexOf('【半固化区');
    const systemText = cut > 0 ? full.slice(0, cut).trimEnd() : full;
    const userText = cut > 0 ? full.slice(cut) : '';
    return { system: systemText, user: userText, full };
  };


  if (process.env.DRY_PROMPT === '1') {
    const preview = buildPartial('scenedetailPeople', lines);
    console.log('===== system（固定资料，五步共用）=====');
    console.log(preview.system);
    console.log('');
    console.log('===== user（本步数据与问题）=====');
    console.log(preview.user);
    console.log('');
    console.log('system 哈希:', crypto.createHash('sha256').update(preview.system).digest('hex').slice(0, 16), '| 长度:', preview.system.length);
    process.exit(0);
  }


  const aliasIndex = new Map();
  for (const c of loadKnowledge(work).characters || []) {
    aliasIndex.set(c.name, c.name);
    for (const al of c.aliases || []) aliasIndex.set(al, c.name);
  }
  const BAD_NAME = /[儿媳妇女男哥姐弟妹爸妈父母公婆叔姨舅爷奶孙媳婿]|小骚货|小母狗|骚货|母狗|淫妇|婊子|名穴|肉棒/;
  const normalizePeople = (people) => (people || []).map((person) => {
    const raw = String(person['姓名'] || '').trim();
    const real = aliasIndex.get(raw) || '';
    if (real) {
      // 辱称/亲属称谓就算能映射，也统一显示角色表里的姓名
      const BAD = /[儿媳妇女男哥姐弟妹爸妈父母公婆叔姨舅爷奶孙媳婿]|小骚货|小母狗|骚货|母狗|淫妇|婊子|名穴|肉棒|老子|儿子/;
      return { ...person, 姓名: real, ...(BAD.test(raw) ? { 代称: [...new Set([...(person['代称'] || []), raw])] } : {}) };
    }
    if (raw.length >= 2 && raw.length <= 4 && !BAD_NAME.test(raw)) return person;
    return { ...person, 姓名: '' };
  }).filter((person) => person['姓名']);
  const mergeDetails = (a, b) => {
    const out = {
      人物: [...(a['人物'] || [])],
      关系: [...(a['关系'] || [])],
      情节: [...(a['情节'] || [])],
      疑问: [...(a['疑问'] || [])],
    };
    const byName = new Map();
    for (const person of [...(a['人物'] || []), ...(b['人物'] || [])]) {
      const nm = String(person['姓名'] || '').trim();
      if (!nm) continue;
      if (!byName.has(nm)) { byName.set(nm, { ...person }); continue; }
      const cur = byName.get(nm);
      for (const [k, v] of Object.entries(person)) {
        if (k === '证据句') cur['证据句'] = [...new Set([...(cur['证据句'] || []), ...(v || [])])];
        else if (!cur[k] && v) cur[k] = v;
        else if (typeof v === 'string' && typeof cur[k] === 'string' && v.length > cur[k].length) cur[k] = v;
      }
    }
    out['人物'] = [...byName.values()];
    out['情节'] = out['情节'].map((s, idx) => ({ ...s, 步骤: idx + 1 }));
    return out;
  };

  let merged = { 人物: [], 关系: [], 情节: [], 疑问: [] };
  let failed = null;

  // 整场一次调用：人物 → 关系 → 情节（不再分块）
  const peopleRes = await callModel(buildPartial('scenedetailPeople', lines), 32768, 6000);
  if (peopleRes.error) {
    failed = '人物 ' + peopleRes.error;
  } else {
    merged['人物'] = normalizePeople(peopleRes.detail['人物'] || []).filter((p) => !isRoleOnly(p['姓名']));
    const relFromPeople = (peopleRes.detail['关系'] || []).filter((r) => r && r['甲'] && r['乙'] && r['甲'] !== r['乙']);
    for (const r of relFromPeople) merged['关系'].push({ ...r, 场景: r['场景'] || scene.sceneId });
    console.log('  人物返回:', merged['人物'].length, '人，关系', merged['关系'].length, '条');
  }

  // 本场人物字符串（姓名｜性别｜年龄｜社会身份）
  const chunkNames = [...new Set((merged['人物'] || []).map((x) => {
    const nm = String(x['姓名'] || '').trim();
    if (!nm) return '';
    const g = String(x['性别'] || '').trim();
    const ages = Array.isArray(x['年龄'])
      ? x['年龄'].map((a) => {
          const v = typeof a === 'string' ? a : (a && (a['年龄'] || a.age)) || '';
          const ev = (a && (a['证据句'] || a.evidence) || []).slice(0, 2);
          return v ? (ev.length ? v + '（S' + ev.join(',S') + '）' : v) : '';
        }).filter(Boolean).join('、')
      : '';
    const role = String(x['社会身份'] || '').trim();
    return [nm, g, ages, role].filter(Boolean).join('｜');
  }).filter(Boolean))].join('；');

  if (!failed) {
    const nameList = chunkNames.split('；').map((x) => x.split('｜')[0]).filter(Boolean);
    const knownRels = promptCtx.identity
      .filter((line) => nameList.some((n) => String(line).includes(n)))
      .slice(0, 20)
      .join('；');
    const relRes = await callModel(buildPartial('scenedetailRelations', lines, { 本场人物: chunkNames, 已知关系: knownRels || '（无）' }), 32768, 6000);
    if (relRes.error) {
      console.log('  关系步失败，跳过:', relRes.error);
    } else {
      const seen = new Set(merged['关系'].map((r) => [r['甲'], r['乙']].sort().join('|')));
      for (const r of relRes.detail['关系'] || []) {
        const a = String(r['甲'] || '').trim();
        const b = String(r['乙'] || '').trim();
        if (!a || !b || a === b) continue;
        const key = [a, b].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        merged['关系'].push({ ...r, 场景: scene.sceneId });
      }
      console.log('  关系返回:', merged['关系'].length, '条');
    }
  }

  if (!failed) {
    merged['关系'] = normalizeRelationSet(merged['关系'], loadKnowledge(work).relations.filter((x) => (x.kind || 'identity') === 'identity'));
    const relLines = merged['关系'].map((r) => r['甲'] + ' 是 ' + r['乙'] + ' 的 ' + (r['甲角色'] || '?')).join('；');
    const plotRes = await callModel(buildPartial('scenedetailPlot', lines, { 本场人物: chunkNames, 本场关系: relLines || '（无）' }), 32768, 12000);
    let plotSteps = plotRes.error ? [] : (plotRes.detail['情节'] || plotRes.detail['情节经过'] || []);
    if (!plotSteps.length) {
      console.log('  情节为空，重试一次');
      const retryPrompt = buildPartial('scenedetailPlot', lines, { 本场人物: chunkNames, 本场关系: relLines || '（无）' });
      retryPrompt.user += '\n\n必须输出非空的「情节」数组，每步带证据句。';
      const retry = await callModel(retryPrompt, 32768, 12000);
      plotSteps = retry.error ? [] : (retry.detail['情节'] || []);
    }
    merged['情节'] = plotSteps.map((s, i) => (typeof s === 'string' ? { 步骤: i + 1, 内容: s } : { ...s, 步骤: i + 1 }));
    console.log('  情节返回:', merged['情节'].length, '步');
  }

  // 本场提要：给下一场当前情背景
  let sceneSummary = '';
  if (!failed) {
    try {
      const namesForSummary = merged['人物'].map((x) => {
        const nm = String(x['姓名'] || '').trim();
        const role = String(x['社会身份'] || '').trim();
        return nm ? nm + (role ? '（' + role + '）' : '') : '';
      }).filter(Boolean).join('、');
      const relsForSummary = merged['关系'].map((r) => r['甲'] + '→' + (r['甲角色'] || '?') + '/' + r['乙']).join('；');
      const sRes = await callModel(buildPartial('scenedetailSummary', lines, { 本场人物: namesForSummary, 本场关系: relsForSummary || '（无）' }), 32768, 3000);
      if (!sRes.error) {
        const plain = String(sRes.detail['提要'] || sRes.detail['摘要'] || '').trim();
        const nameMap = new Map();
        for (const c of loadKnowledge(work).characters || []) {
          nameMap.set(c.name, c.name);
          for (const al of c.aliases || []) if (al) nameMap.set(al, c.name);
        }
        const cast = (sRes.detail['出场人物'] || []).map(String).filter(Boolean)
          .map((s) => {
            const m = /^([^（(]+)(.*)$/.exec(s);
            if (!m) return s;
            const nm = m[1].trim();
            if (isRoleOnly(nm)) return '';
            const canon = nameMap.get(nm) || nm;
            return canon + m[2];
          })
          .filter(Boolean);
        const rels = (sRes.detail['人物关系'] || []).map(String).filter(Boolean);
        sceneSummary = [
          plain,
          cast.length ? '出场人物：' + cast.join('、') : '',
          rels.length ? '人物关系：' + rels.join('；') : '',
        ].filter(Boolean).join('\n');
      }
      if (sceneSummary) console.log('  本场提要:', sceneSummary.length, '字');
    } catch { /* 忽略 */ }
  }
  if (sceneSummary) merged['提要'] = sceneSummary;

  let result = failed ? { error: failed } : { detail: merged };
  if (!failed) {
    console.log('  合并结果:', '人物', merged['人物'].length, '情节', merged['情节'].length, '关系', merged['关系'].length, '疑问', merged['疑问'].length);
  }

  // 疑问：整场一次
  if (!failed) {
    try {
      // 疑问步同样使用「姓名｜性别｜年龄｜社会身份」格式
      const allNames = [...new Set((merged['人物'] || []).map((x) => {
        const nm = String(x['姓名'] || '').trim();
        if (!nm) return '';
        const g = String(x['性别'] || '').trim();
        const ages = Array.isArray(x['年龄'])
          ? x['年龄'].map((a) => (typeof a === 'string' ? a : (a && (a['年龄'] || a.age)) || '')).filter(Boolean).join('、')
          : '';
        const role = String(x['社会身份'] || '').trim();
        return [nm, g, ages, role].filter(Boolean).join('｜');
      }).filter(Boolean))].join('；');
      const sceneRels = (merged['关系'] || []).map((r) => r['甲'] + ' 是 ' + r['乙'] + ' 的 ' + (r['甲角色'] || '?')).join('；');
      const qRes = await callModel(buildPartial('scenedetailQuestions', lines, { 本场人物: allNames, 本场关系: sceneRels || '（无）' }), 32768, 3000);
      if (!qRes.error && Array.isArray(qRes.detail?.['疑问'])) {
        const seen = new Set();
        merged['疑问'] = qRes.detail['疑问']
          .map((q) => ({ ...q, 描述: String(q['描述'] || '').replace(/\s+/g, ' ').slice(0, 120) }))
          .filter((q) => {
            const key = String(q['描述'] || '').slice(0, 40);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 5);
      }
    } catch { /* 忽略 */ }
  }

  if (!result.error && result.detail && Array.isArray(result.detail['人物'])) {
    const sceneText = lines.join('\n');
    result.detail['人物'] = filterPresentPeople(result.detail['人物'], sceneText, scene, result.detail['情节']);
  }

  if (result.error || !Array.isArray(result.detail?.['情节']) || !Array.isArray(result.detail?.['人物'])) {
    // 不再回退到旧的整体模板，重跑一次「情节」步
    const againPrompt = buildPartial('scenedetailPlot', lines);
    againPrompt.user += '\n\n注意：只输出合法 JSON，必须包含非空的「情节」数组。';
    const again = await callModel(againPrompt);
    if (!again.error && Array.isArray(again.detail?.['情节']) && again.detail['情节'].length) {
      merged['情节'] = again.detail['情节'].map((s, i) => ({ ...s, 步骤: i + 1 }));
      result = { detail: merged };
    }
  }
  if (result.error || !Array.isArray(result.detail?.['情节']) || !Array.isArray(result.detail?.['人物'])) {
    withJsonLock(detailsPath, () => {
      const latest = readStore();
  latest.failed[scene.sceneId] = { problem: result.error || '缺字段', at: new Date().toISOString(), rawSaved: Boolean(lastRaw) };
    if (lastRaw) {
      const failDir = path.join(work, 'l2', 'failed-output');
      fs.mkdirSync(failDir, { recursive: true });
      fs.writeFileSync(path.join(failDir, scene.sceneId + '.txt'), lastRaw, 'utf8');
    }
      writeJsonAtomic(detailsPath, latest, 1);
    });
    console.log(scene.sceneId, '失败', result.error || '缺字段');
    continue;
  }
  const beforeCount = countOf(detailsPath, (d) => Object.keys(d.details || {}).length);
  const detail = result.detail;
  const missingParts = [];
  if (!Array.isArray(detail['人物']) || !detail['人物'].length) missingParts.push('人物');
  if (!Array.isArray(detail['情节']) || !detail['情节'].length) missingParts.push('情节');
  if (!String(detail['提要'] || '').trim()) missingParts.push('提要');
  if (missingParts.length) console.log('  本场不完整，缺:', missingParts.join('、'));
  console.log('  保存前统计:', '人物', (detail['人物']||[]).length, '情节', (detail['情节']||[]).length, '关系', (detail['关系']||[]).length);
  const fromN = Number(String(scene.from).slice(1));
  const toN = Number(String(scene.to).slice(1));
  detail['疑问'] = normalizeQuestions(detail, fromN, toN);
  delete detail['疑点'];
  const pronounHits = (JSON.stringify(detail).match(/[他她]们?|其|此人|对方|那人/g) || []).length;
  const saved = withJsonLock(detailsPath, () => {
    const latest = readStore();
    if (!FORCE && latest.details[scene.sceneId]) return null;
    const detailId = 'SD' + String(scene.sceneId).replace(/^SC/, '');
    // 版本管理：旧内容存档，新内容版本号 +1
    const versionsDir = path.join(work, 'l2', 'scene-details-versions', scene.sceneId);
    const prev = latest.details[scene.sceneId];
    if (prev) {
      try {
        fs.mkdirSync(versionsDir, { recursive: true });
        const prevVer = Number(prev.version || 1);
        const file = path.join(versionsDir, 'v' + prevVer + '.json');
        if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(prev, null, 1), 'utf8');
      } catch { /* 忽略 */ }
    }
    const newVersion = prev ? Number(prev.version || 1) + 1 : 1;
    const durationMs = Date.now() - sceneStartedAt;
    const record = { ...detail, detailId, sceneId: scene.sceneId, pronounHits, clean: pronounHits === 0, version: newVersion, durationMs, 缓存: sceneCacheStats(currentRunId), generatedAt: new Date().toISOString() };
    if (missingParts.length) latest.failed[scene.sceneId] = { problem: '缺少 ' + missingParts.join('、'), at: new Date().toISOString() };
    else delete latest.failed[scene.sceneId];
    latest.details[scene.sceneId] = record;
    try {
      fs.mkdirSync(versionsDir, { recursive: true });
      fs.writeFileSync(path.join(versionsDir, 'v' + newVersion + '.json'), JSON.stringify(record, null, 1), 'utf8');
    } catch { /* 忽略 */ }
    latest.index[detailId] = scene.sceneId;
    delete latest.failed[scene.sceneId];
    if (fs.existsSync(dbFile)) {
      const db = openDb(work);
      try {
        withTransaction(db, () => {
          upsertSceneDetails(db, path.basename(path.resolve(work)), [{
            sceneId: scene.sceneId, detailId, payload: JSON.stringify(record),
            questions: record['疑问'].length, pronounHits, generatedAt: record.generatedAt,
          }]);
          writeJsonAtomic(detailsPath, latest, 1);
        });
      } finally { db.close(); }
    } else writeJsonAtomic(detailsPath, latest, 1);
    return { detailId };
  });
  if (saved) {
    // 本场结果写入知识库：姓名唯一、代称并入、关系分身份/参考
    try {
      refreshKnowledge();
      for (const person of detail['人物'] || []) {
        const name = String(person['姓名'] || '').trim();
        if (!name) continue;
        upsertPerson(work, {
          name,
          aliases: Array.isArray(person['代称']) ? person['代称'] : [],
          sceneId: scene.sceneId,
          socialRole: person['社会身份'] || '',
          gender: person['性别'] || '',
          evidence: Array.isArray(person['社会身份证据']) ? person['社会身份证据'] : (Array.isArray(person['证据句']) ? person['证据句'] : []),
          ages: Array.isArray(person['年龄']) ? person['年龄'] : [],
        });
      }
      for (const rel of detail['关系'] || []) {
        const kind = String(rel['类型'] || '').includes('参考') ? 'reference' : 'identity';
        const sentences = Array.isArray(rel['证据句']) ? rel['证据句'] : [];
        upsertRelation(work, {
          a: rel['甲'], b: rel['乙'], aRole: rel['甲角色'], bRole: rel['乙角色'], kind,
          sceneId: scene.sceneId, sentence: sentences[0],
        });
      }
    } catch (error) { console.log('  角色表增量写入失败:', error.message); }
  }
  else console.log(scene.sceneId, '已由其他进程写入，跳过覆盖');
}
console.log('完成');
