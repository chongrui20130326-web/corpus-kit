import fs from 'node:fs';
import { logPrompt } from '../core/prompt-log.mjs';
import path from 'node:path';
import { chatViaConsole, parseJsonLoose } from '../core/console-client.mjs';
import { renderTemplate } from '../core/prompt-templates.mjs';
import { resolvePrompt } from '../core/tab-config.mjs';
import { resolveModel } from '../core/tab-config.mjs';

/**
 * 6.3 角色外观：按场景用模型抽取外观/身体/衣着/配饰描写，编号并映射到角色
 *
 * 用法：node tools/build-appearance-table.mjs <work> [build] [fromScene] [toScene]
 */

const work = process.argv[2] || 'work/母亲任玲';
const step = process.argv[3] || 'build';
const fromArg = process.argv[4] || '';
const toArg = process.argv[5] || '';
const MODEL = resolveModel('appear', 'qwen3.5:9b-uncensored-q8_0_64K', process.env.APPEAR_MODEL);

const l2 = path.join(work, 'l2');
const outFile = path.join(l2, 'appearance-table.json');
const progressFile = path.join(l2, 'appearance-map-progress.json');

const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const saveJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');

const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const chars = readJ(path.join(l2, 'characters.json'), { characters: [] }).characters || [];
const mentions = readJ(path.join(l2, 'mention-table.json'), { mentions: [] }).mentions || [];
const scenes = readJ(path.join(l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
const nameById = new Map(chars.map((c) => [c.id, c.name]));
const aliasToName = new Map();
for (const c of chars) { aliasToName.set(c.name, c.name); for (const a of c.aliases || []) aliasToName.set(a, c.name); }

// 人称映射校验：优先信任人称表，模型给的名字若与该句人称不符则纠正
const mentionsBySentence = new Map();
for (const m of mentions) {
  if (!m.characterId) continue;
  const n = Number(m.sentence);
  if (!mentionsBySentence.has(n)) mentionsBySentence.set(n, []);
  mentionsBySentence.get(n).push(m);
}

function resolveByMentions(sentence, start, modelName) {
  const list = (mentionsBySentence.get(Number(sentence)) || []).slice().sort((a, b) => (a.start || 0) - (b.start || 0));
  const names = list.map((m) => nameById.get(m.characterId)).filter(Boolean);
  const uniq = [...new Set(names)];

  // 句中只有一个人 → 直接采用
  if (uniq.length === 1) return uniq[0];

  // 模型给的名字在句中出现过 → 可信
  if (modelName && uniq.includes(modelName)) return modelName;

  // 否则取该位置之前最近的人称；没有则取上一句最后一个人称
  const before = list.filter((m) => (m.start || 0) <= (start || 0));
  if (before.length) {
    const nm = nameById.get(before[before.length - 1].characterId);
    if (nm) return nm;
  }
  if (list.length) {
    const nm = nameById.get(list[list.length - 1].characterId);
    if (nm) return nm;
  }
  return modelName || '';
}

const sentenceText = new Map();
for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const s of p.sentences || []) {
  const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
  if (n) sentenceText.set(n, String(s.text || ''));
}

const rangeOf = (sc) => [Number(String(sc.from).slice(1)), Number(String(sc.to).slice(1))];
const targets = scenes.filter((sc) => (!fromArg || sc.sceneId >= fromArg) && (!toArg || sc.sceneId <= toArg));

if (step === 'rebuild') { saveJ(outFile, { items: [] }); saveJ(progressFile, { done: [] }); }
const doc = readJ(outFile, { items: [] });
const progress = readJ(progressFile, { done: [] });
const done = new Set(progress.done || []);

if (step === 'renumber') {
  // 只重排编号，不改内容
  doc.items.sort((a, b) => (a.sentence - b.sentence) || (a.start - b.start));
  doc.items.forEach((it, i) => { it.id = 'E' + String(i + 1).padStart(6, '0'); });
  saveJ(outFile, doc);
  console.log('重新编号', doc.items.length, '条');
  process.exit(0);
}


// ===== 仅重判角色（不重新抽取） =====
if (step === 'map') {
  const doc2 = readJ(outFile, { items: [] });
  const prog2 = readJ(path.join(l2, 'appearance-role-progress.json'), { done: [] });
  const done2 = new Set(prog2.done || []);
  const aliases = new Map();
  for (const c of chars) { aliases.set(c.name, c.name); for (const a of c.aliases || []) aliases.set(a, c.name); }

  console.log('待重判场景', targets.length, '| 已完成', done2.size, '| 模型', MODEL);

  for (const sc of targets) {
    if (done2.has(sc.sceneId)) continue;
    const [a, b] = rangeOf(sc);
    const rows = doc2.items.filter((it) => it.sentence >= a && it.sentence <= b);
    if (!rows.length) { done2.add(sc.sceneId); saveJ(path.join(l2, 'appearance-role-progress.json'), { done: [...done2] }); continue; }

    const sm = mentions.filter((m) => Number(m.sentence) >= a && Number(m.sentence) <= b && m.characterId);
    const names = [...new Set(sm.map((m) => nameById.get(m.characterId)).filter(Boolean))];
    const mapping = sm.slice(0, 100).map((m) => 'S' + m.sentence + ':' + m.surface + '→' + (nameById.get(m.characterId) || ''));

    const prompt = renderTemplate('appear', {
    场景角色: names.join('、'),
    人称映射: mapping.join('；'),
    描写列表: rows.slice(0, 80).map((it) => it.id + '｜S' + it.sentence + '｜' + it.类别 + '｜' + (it.原文 || '')).join('\n'),
    补充要求: resolvePrompt('appear') ? ('【补充要求】' + resolvePrompt('appear')) : '',
  });

    logPrompt(work, 'appear', prompt);

    const r = await chatViaConsole({ prompt, source: 'appear-map', model: MODEL, maxTokens: 4000, reasoningEffort: 'none' });
    if (!r.ok) { console.log(sc.sceneId, '失败', r.error); continue; }
    const d = parseJsonLoose(String(r.content || '').replace(/^```(json)?/i, '').replace(/```\s*$/, ''));
    if (!d || !Array.isArray(d['描写'])) { console.log(sc.sceneId, '解析失败'); continue; }

    let changed = 0;
    for (const item of d['描写']) {
      const it = rows.find((x) => x.id === item['编号']);
      if (!it) continue;
      const raw = String(item['角色'] || '').trim();
      const name = names.includes(raw) ? raw : (aliases.get(raw) || '');
      if (!name || !names.includes(name)) continue;
      const checked = resolveByMentions(it.sentence, it.start || 8, name);
      if (it.角色 !== checked) { it.角色 = checked; it.characterId = chars.find((c) => c.name === checked)?.id || ''; changed += 1; }
    }
    done2.add(sc.sceneId);
    saveJ(outFile, doc2);
    saveJ(path.join(l2, 'appearance-role-progress.json'), { done: [...done2] });
    console.log(sc.sceneId, '重判完成 | 条目', rows.length, '| 变更', changed);
  }
  doc2.totals = { items: doc2.items.length, assigned: doc2.items.filter((x) => x.角色).length, byCls: {} };
  for (const it of doc2.items) doc2.totals.byCls[it.类别] = (doc2.totals.byCls[it.类别] || 0) + 1;
  saveJ(outFile, doc2);
  console.log('结束 | 已映射', doc2.totals.assigned, '/', doc2.totals.items);
  process.exit(0);
}

console.log('待抽取场景', targets.length, '| 已完成', done.size, '| 模型', MODEL);

for (const sc of targets) {
  if (done.has(sc.sceneId)) continue;
  const [a, b] = rangeOf(sc);
  const lines = [];
  for (let n = a; n <= b; n += 1) if (sentenceText.has(n)) lines.push('S' + n + ' ' + sentenceText.get(n));
  if (!lines.length) { done.add(sc.sceneId); saveJ(progressFile, { done: [...done] }); continue; }

  const sceneMentions = mentions.filter((m) => Number(m.sentence) >= a && Number(m.sentence) <= b && m.characterId);
  const names = [...new Set(sceneMentions.map((m) => nameById.get(m.characterId)).filter(Boolean))];
  const mapping = sceneMentions.slice(0, 100).map((m) => 'S' + m.sentence + ':' + m.surface + '→' + (nameById.get(m.characterId) || ''));

  const prompt = [
    '从这段小说原文里抽取「外观描写」：外貌、身体部位、器官、衣着、配饰。',
    '只抽取确实在描写某人外观/穿着的句子，不要抽比喻、习语、动作短语。',
    '例如「哪是农村15岁小伙子的对手」不是外貌描写，不要抽。',
    '',
    '【本场景角色】' + names.join('、'),
    '【本场景人称映射】' + mapping.join('；'),
    '',
    '【原文】',
    lines.join('\n').slice(0, 6000),
    '',
    '要求：',
    '1. 一条只写一个部位或一件衣物，并摘 8–30 字原句',
    '2. 类别只能是：外貌 / 身体 / 衣着 / 配饰',
    '3. 角色必须是本场景角色之一，写的是谁就给谁；判不出来写「未知」',
    '4. 每条给句子号',
    '',
    '只返回 JSON：',
    '{"描写":[{"类别":"身体","角色":"任玲","描写":"脸色微红","原文":"只看到母亲脸色微红","句":4}]}',
  ].join('\n');

  const runOnce = async (text) => {
    const p2 = prompt.replace(lines.join('\n').slice(0, 6000), text);
    const r = await chatViaConsole({ prompt: p2, source: 'appear-extract', model: MODEL, maxTokens: 4000, reasoningEffort: 'none' });
    if (!r.ok) return { error: r.error };
    const d = parseJsonLoose(String(r.content || '').replace(/^```(json)?/i, '').replace(/```\s*$/, ''));
    if (!d || !Array.isArray(d['描写'])) return { error: '解析失败', raw: String(r.content || '').slice(0, 200) };
    return { data: d };
  };
  let out = await runOnce(lines.join('\n').slice(0, 6000));
  // retryShort：空结果时用前 2500 字重试
  if (!out.error && out.data['描写'].length === 0) out = await runOnce(lines.join('\n').slice(0, 2500));
  if (out.error) { console.log(sc.sceneId, out.error, (out.raw || '').slice(0, 80)); continue; }
  const data = out.data;

  // 清掉本场旧条目，写入新条目
  doc.items = doc.items.filter((it) => it.sceneId !== sc.sceneId);
  let added = 0;
  for (const item of data['描写']) {
    const sentence = Number(String(item['句'] ?? '').replace(/[^0-9]/g, '')) || 0;
    if (!sentence) continue;
    const raw = String(item['角色'] || '').trim();
    const name = names.includes(raw) ? raw : (aliasToName.get(raw) || '');
    const cls = String(item['类别'] || '').trim();
    if (!['外貌', '身体', '衣着', '配饰'].includes(cls)) continue;
    const modelName = names.includes(name) ? name : '';
    const checked = resolveByMentions(sentence, 8, modelName);
    doc.items.push({
      id: '',
      sceneId: sc.sceneId,
      chapterId: (book.chapters.find((c) => (c.paragraphs || []).some((p) => (p.sentences || []).some((s) => Number(String(s.sid || s.id || '').replace(/^.*S/, '')) === sentence))) || {}).id || '',
      sentence,
      类别: cls,
      角色: checked,
      characterId: checked ? (chars.find((c) => c.name === checked)?.id || '') : '',
      描写: String(item['描写'] || '').slice(0, 60),
      原文: String(item['原文'] || '').slice(0, 160),
    });
    added += 1;
  }

  done.add(sc.sceneId);
  // 全书按句子号排序后统一编号
  doc.items.sort((x, y) => (x.sentence - y.sentence) || String(x.描写).localeCompare(String(y.描写)));
  doc.items.forEach((it, i) => { it.id = 'E' + String(i + 1).padStart(6, '0'); });
  saveJ(outFile, doc);
  saveJ(progressFile, { done: [...done] });
  console.log(sc.sceneId, '完成 | 新增', added, '| 累计', doc.items.length);
}

doc.totals = { items: doc.items.length, assigned: doc.items.filter((x) => x.角色).length, byCls: {} };
for (const it of doc.items) doc.totals.byCls[it.类别] = (doc.totals.byCls[it.类别] || 0) + 1;
saveJ(outFile, doc);
console.log('结束 | 条目', doc.totals.items, '| 已映射', doc.totals.assigned, '| 类别', JSON.stringify(doc.totals.byCls));
