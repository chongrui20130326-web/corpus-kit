import { writeJsonAtomic } from '../core/atomic-json.mjs';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 生成角色（增量版）
 * 逐场景分析：模型输出「称呼 + 句号 + 角色编号」。
 * 角色列表随分析增长：模型可复用已有 CHxx，也可提出新角色。
 * 每次分析完立即落盘，中断可续（doneScenes 记录已完成场景）。
 */

const work = process.argv[2] || 'work/美少妇的哀羞';
const idx = process.argv.indexOf('--limit');
const limit = idx >= 0 ? Number(process.argv[idx + 1]) : 0;
const MODEL = process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K';

const bookPath = path.join(work, 'book.json');
const scenesPath = path.join(work, 'l2', 'scenes-llm.json');
const outPath = path.join(work, 'l2', 'mentions.json');

const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
const sentenceText = new Map();
for (const c of book.chapters || []) for (const p of c.paragraphs || []) for (const s of p.sentences || []) {
  const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
  if (n) sentenceText.set(n, s.text);
}

let scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf8')).scenes || [];
if (limit > 0) scenes = scenes.slice(0, limit);

const doc = fs.existsSync(outPath)
  ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
  : { characters: [], mentions: [], doneScenes: [] };
doc.doneScenes = doc.doneScenes || [];
doc.characters = doc.characters || [];
doc.mentions = doc.mentions || [];
const done = new Set(doc.doneScenes);

async function chat(prompt, maxTokens = 1600) {
  const response = await fetch('http://127.0.0.1:8090/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
    body: JSON.stringify({
      model: MODEL, messages: [{ role: 'user', content: prompt }],
      stream: false, max_tokens: maxTokens, temperature: 0.1,
      reasoning_effort: 'none', response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const raw = String(data.choices?.[0]?.message?.content || '');
  try {
    const body = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '');
    return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
  } catch { return null; }
}

function save() {
  doc.totals = {
    scenes: doc.doneScenes.length,
    mentions: doc.mentions.length,
    resolved: doc.mentions.filter((m) => m.characterId).length,
    unresolved: doc.mentions.filter((m) => !m.characterId).length,
    characters: doc.characters.length,
  };
  writeJsonAtomic(outPath, doc, 1);
}

const mentionId = () => 'M' + String(doc.mentions.length + 1).padStart(4, '0');
const newCharacterId = () => 'CH' + String(doc.characters.length + 1).padStart(2, '0');

// PASS2：用已建立的角色表，逐条校验/补全称呼与角色的对应
const pass2 = process.argv.includes('--pass2');
if (pass2) {
  const pending = doc.mentions.filter((m) => !m.characterId || m.confidence === 0);
  console.log('第二轮校验：待处理 ' + pending.length + ' 条');
  for (const mention of pending) {
    const context = mention.sentences.slice(0, 3).map((n) => 'S' + n + ' ' + (sentenceText.get(n) || '')).join('\n');
    const list = doc.characters.map((c) => c.id + ' ' + c.name).join('\n') || '（无）';
    const value = await chat([
      '已知角色：', list, '',
      '下面是一段原文，其中「' + mention.surface + '」出现了。请判断它指的是哪个角色。',
      '只能从已知角色里选，选不出来就返回空字符串。',
      '只返回 JSON：{"角色编号":"CH01","理由":"简短"}',
      '',
      '【原文】', context,
    ].join('\n'), 16384);
    const chId = String(value?.角色编号 || '').trim();
    if (/^CH\d+$/.test(chId) && doc.characters.some((c) => c.id === chId)) {
      mention.characterId = chId;
      mention.name = doc.characters.find((c) => c.id === chId).name;
      mention.confidence = 0.8;
      mention.source = 'pass2';
    }
    save();
  }
  console.log('第二轮完成：已对应 ' + doc.totals.resolved + ' · 待定 ' + doc.totals.unresolved);
  process.exit(0);
}

// PASS2MARK
for (const scene of scenes) {
  if (done.has(scene.sceneId)) continue;
  const from = Number(String(scene.from).slice(1));
  const to = Number(String(scene.to).slice(1));
  const list = [];
  for (let n = from; n <= to; n += 1) if (sentenceText.has(n)) list.push({ n, text: sentenceText.get(n) });
  if (!list.length) { doc.doneScenes.push(scene.sceneId); save(); continue; }

  const known = doc.characters.length
    ? doc.characters.map((c) => `${c.id} ${c.name}`).join('\n')
    : '（还没有已知角色）';

  const value = await chat([
    '已知角色：',
    known,
    '',
    '下面是本场景的句子（编号. 内容）。',
    '任务：找出指代人物的称呼/代词，并给出对应角色编号。',
    '- 能对上已知角色，用它的编号（CH01…）',
    '- 明显是新角色，写进 newCharacters，编号留空',
    '- 拿不准对应谁，角色编号留空',
    '',
    '只返回 JSON：',
    '{"mentions":[{"称呼":"他","句号":[12,15],"角色编号":"CH01"}],"newCharacters":[{"姓名":"余学君"}]}',
    '',
    '【句子】',
    list.slice(0, 70).map((s) => s.n + '. ' + s.text.slice(0, 50)).join('\n'),
  ].join('\n'), 16384);

  const found = Array.isArray(value?.mentions) ? value.mentions : [];
  for (const item of found) {
    const surface = String(item.称呼 || '').trim();
    if (!surface || surface.length > 10) continue;
    const nums = (Array.isArray(item.句号) ? item.句号 : []).map(Number).filter((n) => sentenceText.has(n));
    if (!nums.length) continue;

    let chId = String(item.角色编号 || '').trim();
    if (!/^CH\d+$/.test(chId) || !doc.characters.some((c) => c.id === chId)) chId = '';
    if (!chId) {
      const byName = doc.characters.find((c) => c.name === surface);
      if (byName) chId = byName.id;
    }

    const existing = doc.mentions.find((m) => m.surface === surface);
    if (existing) {
      for (const n of nums) if (!existing.sentences.includes(n)) existing.sentences.push(n);
      if (!existing.scenes.includes(scene.sceneId)) existing.scenes.push(scene.sceneId);
      if (!existing.characterId && chId) { existing.characterId = chId; existing.name = doc.characters.find((c) => c.id === chId)?.name || ''; }
      continue;
    }
    doc.mentions.push({
      id: mentionId(), surface, sentences: nums, scenes: [scene.sceneId],
      characterId: chId,
      name: chId ? (doc.characters.find((c) => c.id === chId)?.name || '') : '',
      source: 'model',
    });
  }

  for (const item of Array.isArray(value?.newCharacters) ? value.newCharacters : []) {
    const name = String(item.姓名 || item.name || '').trim();
    if (!name || name.length > 10) continue;
    if (doc.characters.some((c) => c.name === name)) continue;
    doc.characters.push({ id: newCharacterId(), name, aliases: [], firstScene: scene.sceneId });
  }

  doc.doneScenes.push(scene.sceneId);
  save();
  console.log(`  ${scene.sceneId} → 人称 ${doc.mentions.length} · 角色 ${doc.characters.length}`);
}

save();
console.log(`完成：场景 ${doc.totals.scenes} · 人称 ${doc.totals.mentions} · 已对应 ${doc.totals.resolved} · 待定 ${doc.totals.unresolved} · 角色 ${doc.totals.characters}`);
