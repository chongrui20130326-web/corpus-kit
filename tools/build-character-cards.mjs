import fs from 'node:fs';
import { logPrompt } from '../core/prompt-log.mjs';
import path from 'node:path';
import { chatViaConsole, parseJsonLoose } from '../core/console-client.mjs';
import { renderTemplate } from '../core/prompt-templates.mjs';
import { resolvePrompt } from '../core/tab-config.mjs';
import { buildMentionIndex, resolveName as resolveMentionName } from '../core/mention-check.mjs';
import { resolveModel } from '../core/tab-config.mjs';

/**
 * 6.1 角色人物卡：按「场景」生成，输入仅含该场景的信息
 *   场景原文 + 该场景出场角色真名 + 该场景人称编号→真名映射 + 这些角色之间的关系
 *
 * 用法：node tools/build-character-cards.mjs <work> [fromScene] [toScene]
 */

const work = process.argv[2] || 'work/母亲任玲';
const fromArg = process.argv[3] || '';
const toArg = process.argv[4] || '';
const MODEL = resolveModel('cardboard', 'qwen3.5:9b-uncensored-q8_0_64K', process.env.CARDS_MODEL);
const REASONING = process.env.CARDS_REASONING || 'none';

const l2 = path.join(work, 'l2');
const cardsFile = path.join(l2, 'character-cards.json');
const progressFile = path.join(l2, 'cards-progress.json');
const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const saveJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');

const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const scenes = readJ(path.join(l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
const chars = readJ(path.join(l2, 'characters.json'), { characters: [] }).characters || [];
const rels = readJ(path.join(l2, 'relations.json'), { relations: [] }).relations || [];
const mentions = readJ(path.join(l2, 'mention-table.json'), { mentions: [] }).mentions || [];

const doc = readJ(cardsFile, { cards: {} });
const progress = readJ(progressFile, { done: [] });
const done = new Set(progress.done || []);

const nameById = new Map(chars.map((c) => [c.id, c.name]));
const aliasOf = new Map(chars.map((c) => [c.name, (c.aliases || []).slice(0, 6)]));

const sentenceText = new Map();
for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const s of p.sentences || []) {
  const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
  if (n) sentenceText.set(n, String(s.text || ''));
}

const rangeOf = (sc) => [Number(String(sc.from).slice(1)), Number(String(sc.to).slice(1))];
const targets = scenes.filter((sc) => {
  if (fromArg && sc.sceneId < fromArg) return false;
  if (toArg && sc.sceneId > toArg) return false;
  return true;
});

function sceneText(sc) {
  const [a, b] = rangeOf(sc);
  const lines = [];
  for (let n = a; n <= b; n += 1) if (sentenceText.has(n)) lines.push('S' + n + ' ' + sentenceText.get(n));
  return lines.join('\n');
}

function scenePeople(sc) {
  const [a, b] = rangeOf(sc);
  const list = mentions.filter((m) => Number(m.sentence) >= a && Number(m.sentence) <= b && m.characterId);
  const map = new Map();
  for (const m of list) map.set(m.id, nameById.get(m.characterId) || '');
  const names = [...new Set([...map.values()].filter(Boolean))];
  return { names, map };
}

function chunkText(text, size = 1800) {
  const parts = [];
  let buf = '';
  for (const seg of String(text).split(/(?<=[。！？\n])/)) {
    if ((buf + seg).length > size && buf) { parts.push(buf); buf = ''; }
    buf += seg;
  }
  if (buf) parts.push(buf);
  return parts;
}

const SCALARS = ['身份', '年龄', '外貌', '衣着', '身体', '性格', '语言风格', '能力与弱点', '情欲偏好', '变化轨迹', '矛盾点'];
const LISTS = ['外貌档案', '衣着档案', '身体档案', '性格档案', '语言档案', '习惯动作', '关系网', '重要经历', '性爱姿势', '淫语言录', '性反应', '敏感点', '性爱描写'];
const mergeField = (x, y) => (!x ? (y || '') : (!y ? x : (String(y).length > String(x).length ? y : x)));
const blank = () => {
  const o = {};
  for (const k of SCALARS) o[k] = '';
  for (const k of LISTS) o[k] = [];
  return o;
};

async function extract(chunk, names, mappingLines, relLines) {
  const prompt = renderTemplate('cardboard', {
    场景角色: names.join('、') || '（未知）',
    人称映射: mappingLines.slice(0, 80).join('；') || '（无）',
    关系: relLines.join('；') || '（无）',
    原文: chunk,
    补充要求: resolvePrompt('cardboard') ? ('【补充要求】' + resolvePrompt('cardboard')) : '',
  });

  logPrompt(work, 'cardboard', prompt);

  const res = await chatViaConsole({ prompt, source: 'cards', model: MODEL, maxTokens: 12000, reasoningEffort: REASONING });
  if (!res.ok) return [];
  const raw = String(res.content || '').replace(/^```(json)?/i, '').replace(/```\s*$/, '');
  let data = parseJsonLoose(raw);
  if (!data) {
    const a = raw.indexOf('{');
    if (a >= 0) {
      let body = raw.slice(a).trim();
      const b = body.lastIndexOf('}');
      if (b > 0) body = body.slice(0, b + 1);
      for (const trim of [0, 1, 2, 4, 6]) {
        const cand = trim ? body.slice(0, -trim) : body;
        for (const suffix of ['', ']}', '}]}', '}]}]}']) {
          try { const p = JSON.parse(cand + suffix); if (p && p['人物']) { data = p; break; } } catch { /* next */ }
        }
        if (data) break;
      }
    }
  }
  return (data && data['人物']) || [];
}

const mergeInto = (cur, p) => {
  for (const k of SCALARS) cur[k] = mergeField(cur[k], p[k] || '');
  for (const k of LISTS) {
    if (!Array.isArray(p[k])) continue;
    for (const it of p[k]) {
      const key = typeof it === 'string' ? it : JSON.stringify(it);
      if (!cur[k].some((x) => (typeof x === 'string' ? x : JSON.stringify(x)) === key)) cur[k].push(it);
    }
    cur[k] = cur[k].slice(0, 60);
  }
};

const mentionIndex = buildMentionIndex(mentions, nameById);

console.log(`场景 ${targets.length} 个，已处理 ${done.size}，模型 ${MODEL}`);

for (const sc of targets) {
  if (done.has(sc.sceneId)) continue;
  const text = sceneText(sc);
  if (!text) continue;

  const { names, map } = scenePeople(sc);
  if (!names.length) { done.add(sc.sceneId); saveJ(progressFile, { done: [...done] }); continue; }

  const mappingLines = [...map.entries()].map(([id, name]) => id + '→' + name);
  const relLines = rels.filter((r) => names.includes(r.a) && names.includes(r.b))
    .map((r) => `${r.a} 是 ${r.b} 的 ${r.aRole || '?'}`);

  const chunks = chunkText(text, 1800);
  const merged = new Map();
  for (const chunk of chunks) {
    for (const p of await extract(chunk, names, mappingLines, relLines)) {
      const raw = String(p['姓名'] || '').trim();
      let name = names.includes(raw) ? raw : (names.find((n) => (aliasOf.get(n) || []).includes(raw)) || '');
      if (!name && names.length === 1) name = names[0];
      if (!name) continue;
      const cur = merged.get(name) || blank();
      mergeInto(cur, p);
      merged.set(name, cur);
    }
  }
  if (!merged.size) { console.log(sc.sceneId, '未抽取到（分块' + chunks.length + '）'); continue; }

  for (const [name, card] of merged) {
    if (!doc.cards[name]) doc.cards[name] = { name, scenes: {} };
    doc.cards[name].scenes = doc.cards[name].scenes || {};
    doc.cards[name].scenes[sc.sceneId] = card;
  }

  done.add(sc.sceneId);
  saveJ(cardsFile, doc);
  saveJ(progressFile, { done: [...done] });
  const items = [...merged.values()].reduce((n, c) => n + LISTS.reduce((m, k) => m + (c[k] || []).length, 0), 0);
  console.log(sc.sceneId, '完成 | 人物', merged.size, '| 条目', items, '| 分块', chunks.length);
}

console.log('结束');
