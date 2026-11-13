import fs from 'node:fs';
import { logPrompt } from '../core/prompt-log.mjs';
import path from 'node:path';
import { chatViaConsole, parseJsonLoose } from '../core/console-client.mjs';
import { renderTemplate } from '../core/prompt-templates.mjs';
import { resolvePrompt } from '../core/tab-config.mjs';
import { buildMentionIndex, resolveName as resolveMentionName } from '../core/mention-check.mjs';
import { resolveModel } from '../core/tab-config.mjs';

/**
 * 6.2 人物语言
 *  step=number：全文对话编号 D000001…，记录章节、句子号、句内位置、说话人（可空）
 *  step=map   ：按场景用模型把对话映射到角色真名，输入含该场景的人称编号→真名映射
 *
 * 用法：node tools/build-dialogue-table.mjs <work> [number|map] [fromScene] [toScene]
 */

const work = process.argv[2] || 'work/母亲任玲';
const step = process.argv[3] || 'number';
const fromArg = process.argv[4] || '';
const toArg = process.argv[5] || '';
const MODEL = resolveModel('dialog', 'qwen3.5:9b-uncensored-q8_0_64K', process.env.DIALOG_MODEL);

const l2 = path.join(work, 'l2');
const dialogFile = path.join(l2, 'dialogue-table.json');
const mapProgressFile = path.join(l2, 'dialogue-map-progress.json');

const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const saveJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');

const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const chars = readJ(path.join(l2, 'characters.json'), { characters: [] }).characters || [];
const mentions = readJ(path.join(l2, 'mention-table.json'), { mentions: [] }).mentions || [];
const nameById = new Map(chars.map((c) => [c.id, c.name]));
const aliasToName = new Map();
for (const c of chars) { aliasToName.set(c.name, c.name); for (const a of c.aliases || []) aliasToName.set(a, c.name); }

if (step === 'number') {
  const doc = { generatedAt: new Date().toISOString(), dialog: [] };
  let serial = 0;
  const pairs = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"']];

  for (const ch of book.chapters || []) {
    for (const p of ch.paragraphs || []) {
      for (const s of p.sentences || []) {
        const text = String(s.text || '');
        const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
        if (!n) continue;
        let i = 0;
        while (i < text.length) {
          let opened = false;
          for (const [open, close] of pairs) {
            if (text[i] !== open) continue;
            const end = text.indexOf(close, i + 1);
            if (end < 0) continue;
            const body = text.slice(i + 1, end).trim();
            if (!body) { i = end + 1; opened = true; break; }
            serial += 1;
            doc.dialog.push({
              id: 'D' + String(serial).padStart(6, '0'),
              chapterId: ch.id,
              sentence: n,
              start: i + 1,
              end,
              原文: body,
              说话人: '',
              characterId: '',
            });
            i = end + 1;
            opened = true;
            break;
          }
          if (!opened) i += 1;
        }
      }
    }
  }

  // 只做编号：不从人称表推断说话人，说话人留空交给「映射到角色」
  doc.totals = { dialog: doc.dialog.length, mapped: doc.dialog.filter((x) => x.characterId).length };
  saveJ(dialogFile, doc);
  console.log('对话编号', doc.dialog.length, '条（说话人留空，等待映射）');
  process.exit(0);
}

// ===== 模型映射 =====
const doc = readJ(dialogFile, { dialog: [] });
const scenes = readJ(path.join(l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
const progress = readJ(mapProgressFile, { done: [] });
const done = new Set(progress.done || []);
const FILL = process.env.DIALOG_FILL === '1';

const sentenceText = new Map();
for (const ch of book.chapters || []) for (const para of ch.paragraphs || []) for (const s of para.sentences || []) {
  const num = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
  if (num) sentenceText.set(num, String(s.text || ''));
}

const prevText = (n) => String(sentenceText.get(n - 1) || '').slice(-80);
const nextText = (n) => String(sentenceText.get(n + 1) || '').slice(0, 80);

const NARRATOR_PRONOUNS = ['我', '我们', '咱', '咱们', '俺'];
const narratorId = (() => {
  const count = new Map();
  for (const m of mentions) {
    if (!m.characterId) continue;
    if (!NARRATOR_PRONOUNS.includes(String(m.surface || '').trim())) continue;
    count.set(m.characterId, (count.get(m.characterId) || 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 3 ? top[0] : '';
})();
const narratorName = narratorId ? (nameById.get(narratorId) || '') : '';

const charIntro = (names) => names.map((n) => {
  const c = chars.find((x) => x.name === n);
  const alias = c && (c.aliases || []).length ? '（代称：' + c.aliases.slice(0, 5).join('/') + '）' : '';
  return n + alias;
}).join('；');

const rangeOf = (sc) => [Number(String(sc.from).slice(1)), Number(String(sc.to).slice(1))];
const targets = scenes.filter((sc) => (!fromArg || sc.sceneId >= fromArg) && (!toArg || sc.sceneId <= toArg));

const mentionIndex = buildMentionIndex(mentions, nameById);

// 场景详述里的「本场出场人物」，用作说话人候选
const sceneDetails = readJ(path.join(l2, 'scene-details.json'), { details: {} }).details || {};

console.log('待映射场景', targets.length, '| 已处理', done.size, '| 模型', MODEL);

for (const sc of targets) {
  if (!FILL && done.has(sc.sceneId)) continue;
  const [a, b] = rangeOf(sc);
  saveJ(mapProgressFile, { done: [...done], current: sc.sceneId });
  const rows = doc.dialog.filter((d) => d.sentence >= a && d.sentence <= b);
  if (!rows.length) { done.add(sc.sceneId); saveJ(mapProgressFile, { done: [...done] }); continue; }

  const sceneMentions = mentions.filter((m) => Number(m.sentence) >= a && Number(m.sentence) <= b && m.characterId);
  const mapping = sceneMentions.slice(0, 120).map((m) => m.id + '→' + (nameById.get(m.characterId) || ''));
  const detail = sceneDetails[sc.sceneId] || {};
  const detailPeople = (detail['人物'] || []).map((p) => String(p['姓名'] || '').trim()).filter(Boolean);
  const mentionNames = sceneMentions.map((m) => nameById.get(m.characterId)).filter(Boolean);
  const names = [...new Set([...detailPeople, ...mentionNames])];
  const roleOf = new Map((detail['人物'] || []).map((p) => [String(p['姓名'] || '').trim(), String(p['社会身份'] || '').trim()]));
  const introLines = names.map((n) => {
    const c = chars.find((x) => x.name === n);
    const alias = c && (c.aliases || []).length ? '（代称：' + c.aliases.slice(0, 5).join('/') + '）' : '';
    const role = roleOf.get(n) ? '（' + roleOf.get(n) + '）' : '';
    return n + role + alias;
  }).join('；');

  // 分批映射：只处理未映射的对话；某批失败则二分重试
  const pendingRows = FILL ? rows.filter((r) => !r.characterId) : rows;
  let changed = 0;

  const applyItems = (chunk, data) => {
    for (const item of data['对话'] || []) {
      const d = chunk.find((x) => x.id === item['编号']);
      if (!d) continue;
      const raw = String(item['说话人'] || '').trim();
      const name = names.includes(raw) ? raw : (aliasToName.get(raw) || '');
      if (!name || !names.includes(name)) continue;
      const checked = resolveMentionName(mentionIndex, d.sentence, d.start || 0, name) || name;
      const finalName = names.includes(checked) ? checked : name;
      const cid = chars.find((c) => c.name === finalName)?.id || '';
      if (cid && cid !== d.characterId) { d.characterId = cid; d.说话人 = finalName; d.来源 = '模型'; changed += 1; }
    }
    saveJ(dialogFile, doc);
  };

  const mapChunk = async (chunk) => {
    if (!chunk.length) return;
    const prompt = renderTemplate('dialog', {
      场景角色: introLines,
      人称映射: mapping.join('；'),
      叙述者提示: narratorName ? ('· 本书叙述者是 ' + narratorName + '（由「我」的人称映射统计得出）；引号里的「我」通常是 ' + narratorName) : '· 引号里出现「我」时，说话人通常是当前的叙述者',
      对话列表: chunk.map((d) => [d.id, 'S' + d.sentence, '「' + d.原文 + '」', String(sentenceText.get(d.sentence) || '').replace(/\n/g, ' ').slice(0, 120), prevText(d.sentence), nextText(d.sentence), d.说话人 || '未知'].join('｜')).join('\n'),
      补充要求: resolvePrompt('dialog') ? ('【补充要求】' + resolvePrompt('dialog')) : '',
    });
    logPrompt(work, 'dialog', prompt);
    const res = await chatViaConsole({ prompt, source: 'dialog-map', model: MODEL, maxTokens: 8000, reasoningEffort: 'none' });
    if (!res.ok) { console.log(sc.sceneId, '批次失败', res.error); return; }
    const data = parseJsonLoose(String(res.content || '').replace(/^```(json)?/i, '').replace(/```\s*$/, ''));
    if (!data || !Array.isArray(data['对话']) || !data['对话'].length) {
      if (chunk.length > 12) {
        const half = Math.ceil(chunk.length / 2);
        console.log(sc.sceneId, '整批失败，二分重试', chunk.length);
        await mapChunk(chunk.slice(0, half));
        await mapChunk(chunk.slice(half));
      } else {
        console.log(sc.sceneId, '放弃小批', chunk.length);
      }
      return;
    }
    applyItems(chunk, data);
    saveJ(mapProgressFile, { done: [...done], current: sc.sceneId, batch: chunk.length, total: rows.length });
  };

  for (let off = 0; off < pendingRows.length; off += 40) {
    await mapChunk(pendingRows.slice(off, off + 40));
    console.log(sc.sceneId, '批次', Math.min(off + 40, pendingRows.length) + '/' + pendingRows.length, '累计修正', changed);
  }

  done.add(sc.sceneId);
  saveJ(dialogFile, doc);
  saveJ(mapProgressFile, { done: [...done] });
  console.log(sc.sceneId, '完成 | 对话', rows.length, '| 修正', changed);
}

doc.totals = { dialog: doc.dialog.length, mapped: doc.dialog.filter((x) => x.characterId).length };
saveJ(dialogFile, doc);
console.log('结束');
