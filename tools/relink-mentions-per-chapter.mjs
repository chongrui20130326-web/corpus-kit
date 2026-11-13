import fs from 'node:fs';
import { logPrompt } from '../core/prompt-log.mjs';
import path from 'node:path';
import { chatViaConsole, parseJsonLoose } from '../core/console-client.mjs';
import { renderTemplate } from '../core/prompt-templates.mjs';
import { resolvePrompt } from '../core/tab-config.mjs';
import { resolveModel } from '../core/tab-config.mjs';

/**
 * 5.3 关系重构：按章用 DeepSeek 复核「人称编号 → 角色真名」的映射
 * 输入：本章人称（编号、句子号、原词、当前映射）+ 角色表 + 本章原文
 * 输出：修正后的映射；写入 mention-table.json 与 scene-map.json
 *
 * 用法：node tools/relink-mentions-per-chapter.mjs <work> [fromChapter] [toChapter]
 */

const work = process.argv[2] || 'work/母亲任玲';
const fromArg = process.argv[3] || '';
const toArg = process.argv[4] || '';
const MODEL = resolveModel('relink', 'qwen3.5:9b-uncensored-q8_0_64K', process.env.RELINK_MODEL);
const REASONING = process.env.RELINK_REASONING || 'medium';

const l2 = path.join(work, 'l2');
const reportFile = path.join(l2, 'link-correct-report.json');
const progressFile = path.join(l2, 'link-correct-progress.json');
fs.mkdirSync(l2, { recursive: true });

const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const saveJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');

const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const chapters = book.chapters || [];
const iFrom = fromArg ? chapters.findIndex((c) => c.id === fromArg) : 0;
const iTo = toArg ? chapters.findIndex((c) => c.id === toArg) : chapters.length - 1;
const targets = chapters.slice(Math.max(0, iFrom), Math.max(0, iTo) + 1);

const charDoc = readJ(path.join(l2, 'characters.json'), { characters: [] });
const chars = charDoc.characters || [];
const mentionDoc = readJ(path.join(l2, 'mention-table.json'), { mentions: [] });
const mentions = mentionDoc.mentions || [];
const mapDoc = readJ(path.join(l2, 'scene-map.json'), { scenes: {} });

const progress = readJ(progressFile, { done: [] });
const done = new Set(progress.done || []);
const report = readJ(reportFile, { chapters: {} });

const chapterText = (chapter) => (chapter.paragraphs || []).map((p) => String(p.text || '').trim()).filter(Boolean).join('\n');
const nameById = new Map(chars.map((c) => [c.id, c.name]));
const idByName = new Map(chars.map((c) => [c.name, c.id]));

console.log(`章节 ${targets.length} 个，已处理 ${done.size}，模型 ${MODEL}`);

for (const chapter of targets) {
  if (done.has(chapter.id)) continue;
  const text = chapterText(chapter);
  if (!text) continue;

  const list = mentions.filter((m) => m.chapterId === chapter.id);
  if (!list.length) { done.add(chapter.id); saveJ(progressFile, { done: [...done] }); continue; }

  const rows = list.slice(0, 400).map((m) => {
    const cur = m.characterId ? (nameById.get(m.characterId) || m.characterId) : '未映射';
    return `${m.id}｜S${m.sentence}｜${m.surface}｜${m.cls}｜当前:${cur}`;
  });

  const prompt = renderTemplate('relink', {
    角色表: chars.map((c) => c.name + (c.aliases?.length ? '（' + c.aliases.slice(0, 6).join('/') + '）' : '')).join(' / '),
    原文: text.slice(0, 30000),
    人称列表: rows.join('\n'),
    补充要求: resolvePrompt('relink') ? ('【补充要求】' + resolvePrompt('relink')) : '',
  });

  logPrompt(work, 'relink', prompt);

  const res = await chatViaConsole({ prompt, source: 'relink', model: MODEL, maxTokens: 0, reasoningEffort: REASONING });
  if (!res.ok) {
    report.chapters[chapter.id] = { error: res.error || '调用失败', at: new Date().toISOString() };
    saveJ(reportFile, report);
    console.log(chapter.id, '失败', res.error);
    continue;
  }
  const data = parseJsonLoose(res.content);
  if (!data) {
    report.chapters[chapter.id] = { error: 'JSON 解析失败', raw: String(res.content).slice(0, 300), at: new Date().toISOString() };
    saveJ(reportFile, report);
    console.log(chapter.id, 'JSON 解析失败');
    continue;
  }

  const changes = [];
  for (const item of data['映射'] || []) {
    const mid = String(item['编号'] || '').trim();
    const name = String(item['姓名'] || '').trim();
    if (!mid || !name) continue;
    const cid = idByName.get(name);
    if (!cid) continue;
    const m = mentions.find((x) => x.id === mid);
    if (!m) continue;
    if (m.characterId !== cid) {
      changes.push({ 编号: mid, 词: m.surface, 句子: m.sentence, 从: m.characterId ? (nameById.get(m.characterId) || m.characterId) : '未映射', 到: name });
      m.characterId = cid;
    }
    // 同步 scene-map
    const arr = mapDoc.scenes?.[m.sceneId] || [];
    const hit = arr.find((x) => (x.id || x.mentionId) === mid);
    if (hit) hit.characterId = cid;
  }

  report.chapters[chapter.id] = {
    结论: data['本章结论'] || '',
    修改: changes,
    存疑: data['存疑'] || [],
    人称总数: list.length,
    at: new Date().toISOString(),
  };
  done.add(chapter.id);
  saveJ(progressFile, { done: [...done] });
  saveJ(reportFile, report);
  saveJ(path.join(l2, 'mention-table.json'), mentionDoc);
  saveJ(path.join(l2, 'scene-map.json'), mapDoc);
  console.log(chapter.id, '完成 | 修改', changes.length, '| 存疑', (data['存疑'] || []).length, '| 人称', list.length);
}

console.log('结束');
