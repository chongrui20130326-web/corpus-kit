import fs from 'node:fs';
import { logPrompt } from '../core/prompt-log.mjs';
import path from 'node:path';
import { chatViaConsole, parseJsonLoose } from '../core/console-client.mjs';
import { renderTemplate } from '../core/prompt-templates.mjs';
import { resolvePrompt } from '../core/tab-config.mjs';
import { resolveModel } from '../core/tab-config.mjs';
import { buildMentionIndex, resolveName as resolveMentionName } from '../core/mention-check.mjs';

/**
 * 6.4 角色色情描写：按场景用模型抽取色情描写，编号并映射到一个或多个角色
 *
 * 用法：node tools/build-erotic-table.mjs <work> [extract] [fromScene] [toScene]
 */

const work = process.argv[2] || 'work/母亲任玲';
const step = process.argv[3] || 'extract';
const fromArg = process.argv[4] || '';
const toArg = process.argv[5] || '';
const MODEL = resolveModel('erotic', 'qwen3.5:9b-uncensored-q8_0_64K', process.env.EROTIC_MODEL);

const l2 = path.join(work, 'l2');
const outFile = path.join(l2, 'erotic-table.json');
const progressFile = path.join(l2, 'erotic-progress.json');
const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const saveJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');

const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const chars = readJ(path.join(l2, 'characters.json'), { characters: [] }).characters || [];
const mentions = readJ(path.join(l2, 'mention-table.json'), { mentions: [] }).mentions || [];
const scenes = readJ(path.join(l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
const nameById = new Map(chars.map((c) => [c.id, c.name]));
const idByName = new Map(chars.map((c) => [c.name, c.id]));
const aliasToName = new Map();
for (const c of chars) { aliasToName.set(c.name, c.name); for (const a of c.aliases || []) aliasToName.set(a, c.name); }

const sentenceText = new Map();
for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const s of p.sentences || []) {
  const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
  if (n) sentenceText.set(n, String(s.text || ''));
}

// 模型有时给的是「场景内相对序号」，需要换算成全书句子号
function normSentence(raw, a, b) {
  const n = Number(String(raw ?? '').replace(/[^0-9]/g, '')) || 0;
  if (!n) return 0;
  if (n >= a && n <= b) return n;
  const byOffset = a + n - 1;      // 1 相对场景首句
  if (byOffset >= a && byOffset <= b) return byOffset;
  const byZero = a + n;            // 0 基
  if (byZero >= a && byZero <= b) return byZero;
  return 0;
}

const mentionIndex = buildMentionIndex(mentions, nameById);
const rangeOf = (sc) => [Number(String(sc.from).slice(1)), Number(String(sc.to).slice(1))];
const targets = scenes.filter((sc) => (!fromArg || sc.sceneId >= fromArg) && (!toArg || sc.sceneId <= toArg));

if (step === 'rebuild') { saveJ(outFile, { items: [] }); saveJ(progressFile, { done: [] }); }
const doc = readJ(outFile, { items: [] });
const progress = readJ(progressFile, { done: [] });
const done = new Set(progress.done || []);

console.log('待抽取场景', targets.length, '| 已完成', done.size, '| 模型', MODEL);

for (const sc of targets) {
  if (done.has(sc.sceneId)) continue;
  const [a, b] = rangeOf(sc);
  const lines = [];
  for (let n = a; n <= b; n += 1) if (sentenceText.has(n)) lines.push('S' + n + ' ' + sentenceText.get(n));
  if (!lines.length) { done.add(sc.sceneId); saveJ(progressFile, { done: [...done] }); continue; }

  const sm = mentions.filter((m) => Number(m.sentence) >= a && Number(m.sentence) <= b && m.characterId);
  const names = [...new Set(sm.map((m) => nameById.get(m.characterId)).filter(Boolean))];
  const mapping = sm.slice(0, 100).map((m) => 'S' + m.sentence + ':' + m.surface + '→' + (nameById.get(m.characterId) || ''));

  const prompt = renderTemplate('erotic', {
    场景角色: names.join('、'),
    人称映射: mapping.join('；'),
    原文: lines.join('\n').slice(0, 5000),
    补充要求: resolvePrompt('erotic') ? ('【补充要求】' + resolvePrompt('erotic')) : '',
  });

  logPrompt(work, 'erotic', prompt);

  const res = await chatViaConsole({ prompt, source: 'erotic-extract', model: MODEL, maxTokens: 4000, reasoningEffort: 'none' });
  if (!res.ok) { console.log(sc.sceneId, '失败', res.error); continue; }
  const data = parseJsonLoose(String(res.content || '').replace(/^```(json)?/i, '').replace(/```\s*$/, ''));
  if (!data || !Array.isArray(data['描写'])) { console.log(sc.sceneId, '解析失败'); continue; }

  doc.items = doc.items.filter((it) => it.sceneId !== sc.sceneId);
  let added = 0;
  for (const item of data['描写']) {
    const sentence = normSentence(item['句'], a, b);
    if (!sentence) continue;
    const rawList = Array.isArray(item['参与者']) ? item['参与者'] : [];
    const people = [];
    for (const raw of rawList) {
      const r = String(raw || '').trim();
      const nm = names.includes(r) ? r : (aliasToName.get(r) || '');
      if (!nm || !names.includes(nm)) continue;
      // 人称校验：该句只有一个人称时以人称为准
      const checked = resolveMentionName(mentionIndex, sentence, 0, nm) || nm;
      const finalName = names.includes(checked) ? checked : nm;
      if (!people.some((p) => p.姓名 === finalName)) people.push({ 姓名: finalName, characterId: idByName.get(finalName) || '' });
    }
    if (!people.length) {
      const single = [...new Set((sm.filter((m) => Number(m.sentence) === sentence).map((m) => nameById.get(m.characterId)) || []).filter(Boolean))];
      if (single.length === 1) people.push({ 姓名: single[0], characterId: idByName.get(single[0]) || '' });
    }
    doc.items.push({
      id: '',
      sceneId: sc.sceneId,
      chapterId: (book.chapters.find((c) => (c.paragraphs || []).some((p) => (p.sentences || []).some((s) => Number(String(s.sid || s.id || '').replace(/^.*S/, '')) === sentence))) || {}).id || '',
      sentence,
      类型: String(item['类型'] || '其他').slice(0, 8),
      角色: people,
      原文: String(item['原文'] || '').slice(0, 200),
    });
    added += 1;
  }

  doc.items.sort((x, y) => (x.sentence - y.sentence));
  doc.items.forEach((it, i) => { it.id = 'X' + String(i + 1).padStart(6, '0'); });
  done.add(sc.sceneId);
  saveJ(outFile, doc);
  saveJ(progressFile, { done: [...done] });
  console.log(sc.sceneId, '完成 | 新增', added, '| 累计', doc.items.length);
}

doc.totals = { items: doc.items.length, mapped: doc.items.filter((x) => (x.角色 || []).length).length, byType: {} };
for (const it of doc.items) doc.totals.byType[it.类型] = (doc.totals.byType[it.类型] || 0) + 1;
saveJ(outFile, doc);
console.log('结束 | 条目', doc.totals.items, '| 已映射', doc.totals.mapped, '| 类型', JSON.stringify(doc.totals.byType));
