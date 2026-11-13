import { writeJsonAtomic } from '../core/atomic-json.mjs';
import { logPrompt } from '../core/prompt-log.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { chatJson, recordFailure } from './lib-llm.mjs';

// 确保输出目录存在（新书首次运行时 l2 可能还没建）
function ensureOutputDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ } }

/**
 * 第 3 步：逐场建立「人称编号 → 角色编号」的映射
 * - 真名类直接按表绑定，不调模型
 * - 集体称呼不映射
 * - 代词/亲属/身份词按批交给模型判断
 * 输出 l2/scene-map.json，可中断续跑（doneScenes）
 */

const work = process.argv[2] || 'work/美少妇的哀羞';
const idx = process.argv.indexOf('--limit');
const limit = idx >= 0 ? Number(process.argv[idx + 1]) : 0;
const MODEL = process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K';
const BATCH = 40;

const characters = JSON.parse(fs.readFileSync(path.join(work, 'l2', 'characters.json'), 'utf8')).characters || [];
const table = JSON.parse(fs.readFileSync(path.join(work, 'l2', 'mention-table.json'), 'utf8')).mentions || [];
const scenes = JSON.parse(fs.readFileSync(path.join(work, 'l2', 'scenes-llm.json'), 'utf8')).scenes || [];
const relPath = path.join(work, 'l2', 'relations.json');
const relations = fs.existsSync(relPath) ? (JSON.parse(fs.readFileSync(relPath, 'utf8')).relations || []) : [];
const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));

const sentenceText = new Map();
for (const c of book.chapters || []) for (const p of c.paragraphs || []) for (const s of p.sentences || []) {
  const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
  if (n) sentenceText.set(n, s.text);
}

const bySentence = new Map();
for (const m of table) {
  if (!bySentence.has(m.sentence)) bySentence.set(m.sentence, []);
  bySentence.get(m.sentence).push(m);
}

const outPath = path.join(work, 'l2', 'scene-map.json');
const FRESH = process.env.LINK_FRESH === '1';
const FILL = process.env.LINK_FILL === '1';
const doc = (!FRESH && fs.existsSync(outPath)) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : { scenes: {}, doneScenes: [], totals: {} };
doc.scenes = doc.scenes || {};
doc.doneScenes = doc.doneScenes || [];
const done = new Set(doc.doneScenes);

async function chat(prompt, _maxTokens) {
  const result = await chatJson(prompt, { maxTokens: 4096, retries: 3 });
  if (result.ok) return result.data;
  recordFailure(path.join(work, 'l2', 'truncation-report.json'), {
    tool: 'build-scene-map.mjs',
    reason: result.truncated ? '输出超过 4096 token，重试 3 次仍超限' : '调用失败',
    attempts: result.attempts,
    promptHead: prompt.slice(0, 300),
  });
  return null;
}

function save() {
  doc.totals = {
    scenes: doc.doneScenes.length,
    mapped: Object.values(doc.scenes).reduce((n, s) => n + s.filter((x) => x.characterId).length, 0),
    mentions: Object.values(doc.scenes).reduce((n, s) => n + s.length, 0),
  };
  writeJsonAtomic(outPath, doc, 1);
}

const selected = limit > 0 ? scenes.slice(0, limit) : scenes;
for (const scene of selected) {
  if (!FILL && done.has(scene.sceneId)) continue;
  const from = Number(String(scene.from).slice(1));
  const to = Number(String(scene.to).slice(1));

  const items = [];
  for (let n = from; n <= to; n += 1) {
    for (const m of bySentence.get(n) || []) {
      if (m.cls === 'collective') continue;                 // 集体不映射
      if (m.inDialog) { items.push({ ...m, characterId: '' }); continue; }  // 对话内不映射
      if (m.cls === 'name') { items.push({ ...m, characterId: m.characterId || '' }); continue; }
      items.push({ ...m, characterId: '' });
    }
  }

  // 主角：被「姓名类」提及最多的角色
const PROTAGONIST = (() => {
  const count = new Map();
  for (const m of table) {
    if (m.cls === 'name' && m.characterId) count.set(m.characterId, (count.get(m.characterId) || 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : '';
})();
const FIRST_PERSON = new Set(['我', '我们', '咱', '咱们', '俺', '俺们']);

if (PROTAGONIST) {
    for (const m of items) {
      if (!m.characterId && FIRST_PERSON.has(String(m.surface || m.text || '').trim())) m.characterId = PROTAGONIST;
    }
  }
  const map = new Map(items.filter((m) => m.characterId).map((m) => [m.id, m.characterId]));
  // 断点续跑：同一场之前已映射的部分先读回来
  for (const prev of doc.scenes[scene.sceneId] || []) {
    if (prev.characterId) map.set(prev.id, prev.characterId);
  }
  const needModel = items.filter((m) => !map.get(m.id));
  const writePartial = () => {
    doc.scenes[scene.sceneId] = items.map((m) => ({ id: m.id, sentence: m.sentence, surface: m.surface, cls: m.cls, characterId: map.get(m.id) || '' }));
    save();
  };

  for (let i = 0; i < needModel.length; i += BATCH) {
    const batch = needModel.slice(i, i + BATCH);
    const lines = batch.map((m) => `${m.id} ${m.surface} ← S${m.sentence} ${(sentenceText.get(m.sentence) || '').slice(0, 60)}`).join('\n');
    const value = await chat([
      '角色表：',
      characters.map((c) => `${c.id} ${c.name}${c.aliases?.length ? '（' + c.aliases.join('/') + '）' : ''}`).join('\n'),
      '',
      relations.length ? '角色关系：' + relations.slice(0, 60).map((r) => `${r.fromName || r.a}-${r.type || r.aRole}->${r.toName || r.b}`).join('；') : '（无关系表）',
      '',
      '下面每行是一个人称（编号 称呼 ← 句子号 原文）。',
      '判断每个编号指的是哪个角色，只能从角色表里选；判断不了就留空。',
      '注意：「丈夫/妻子/岳母/公公/老板」这类是关系称谓，指的是关系里的对方，不是说话人本人；请按上面的关系表判断。',
      '',
      '只返回 JSON：{"map":{"M000001":"CH01"}}',
      '',
      lines,
    ].join('\n'), 16384);
    const part = value?.map || {};
    for (const [mid, chId] of Object.entries(part)) {
      if (/^CH\d+$/.test(String(chId)) && characters.some((c) => c.id === chId)) map.set(mid, chId);
    }
    writePartial();
  }

  doc.scenes[scene.sceneId] = items.map((m) => ({ id: m.id, sentence: m.sentence, surface: m.surface, cls: m.cls, characterId: map.get(m.id) || '' }));
  if (!doc.doneScenes.includes(scene.sceneId)) doc.doneScenes.push(scene.sceneId);
  save();
  const mapped = doc.scenes[scene.sceneId].filter((x) => x.characterId).length;
  console.log(`${scene.sceneId} → ${doc.scenes[scene.sceneId].length} 条，已映射 ${mapped}`);
}

save();
console.log(`完成：场景 ${doc.totals.scenes} · 人称 ${doc.totals.mentions} · 已映射 ${doc.totals.mapped}`);
