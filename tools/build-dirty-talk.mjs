import fs from 'node:fs';
import { logPrompt } from '../core/prompt-log.mjs';
import path from 'node:path';
import { chatViaConsole, parseJsonLoose } from '../core/console-client.mjs';
import { renderTemplate } from '../core/prompt-templates.mjs';
import { resolvePrompt } from '../core/tab-config.mjs';
import { resolveModel } from '../core/tab-config.mjs';

/**
 * 6.2.1 淫言浪语：从 6.2 的对话表里筛出色情相关的台词
 *
 * 用法：node tools/build-dirty-talk.mjs <work> [extract] [fromScene] [toScene]
 */

const work = process.argv[2] || 'work/母亲任玲';
const step = process.argv[3] || 'extract';
const fromArg = process.argv[4] || '';
const toArg = process.argv[5] || '';
const MODEL = resolveModel('dirty', 'qwen3.5:9b-uncensored-q8_0_64K', process.env.DIRTY_MODEL);

const l2 = path.join(work, 'l2');
const dialogFile = path.join(l2, 'dialogue-table.json');
const outFile = path.join(l2, 'dirty-talk.json');
const progressFile = path.join(l2, 'dirty-progress.json');
const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const saveJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');

const dialog = readJ(dialogFile, { dialog: [] }).dialog || [];
const scenes = readJ(path.join(l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
const chars = readJ(path.join(l2, 'characters.json'), { characters: [] }).characters || [];

if (step === 'rebuild') { saveJ(outFile, { items: [] }); saveJ(progressFile, { done: [] }); }
const doc = readJ(outFile, { items: [] });
const progress = readJ(progressFile, { done: [] });
const done = new Set(progress.done || []);

const rangeOf = (sc) => [Number(String(sc.from).slice(1)), Number(String(sc.to).slice(1))];
const targets = scenes.filter((sc) => (!fromArg || sc.sceneId >= fromArg) && (!toArg || sc.sceneId <= toArg));

console.log('待处理场景', targets.length, '| 已完成', done.size, '| 模型', MODEL);

for (const sc of targets) {
  if (done.has(sc.sceneId)) continue;
  const [a, b] = rangeOf(sc);
  const rows = dialog.filter((d) => d.sentence >= a && d.sentence <= b);
  if (!rows.length) { done.add(sc.sceneId); saveJ(progressFile, { done: [...done] }); continue; }

  const names = [...new Set(rows.map((r) => r.说话人).filter(Boolean))];
  const prompt = renderTemplate('dirty', {
    场景角色: names.join('、'),
    台词列表: rows.map((r) => `${r.id}｜${r.说话人 || '未知'}｜${r.原文}`).join('\n'),
    补充要求: resolvePrompt('dirty') ? ('【补充要求】' + resolvePrompt('dirty')) : '',
  });

  logPrompt(work, 'dirty', prompt);

  const res = await chatViaConsole({ prompt, source: 'dirty-talk', model: MODEL, maxTokens: 3000, reasoningEffort: 'none' });
  if (!res.ok) { console.log(sc.sceneId, '失败', res.error); continue; }
  const data = parseJsonLoose(String(res.content || '').replace(/^```(json)?/i, '').replace(/```\s*$/, ''));
  if (!data || !Array.isArray(data['淫语'])) { console.log(sc.sceneId, '解析失败'); continue; }

  doc.items = doc.items.filter((it) => it.sceneId !== sc.sceneId);
  let added = 0;
  for (const item of data['淫语']) {
    const d = rows.find((x) => x.id === item['编号']);
    if (!d) continue;
    const targetsList = Array.isArray(item['对象']) ? item['对象'] : (item['对象'] ? [item['对象']] : []);
    doc.items.push({
      id: d.id,
      sceneId: sc.sceneId,
      chapterId: d.chapterId,
      sentence: d.sentence,
      说话人: d.说话人 || '',
      类型: String(item['类型'] || '其他').slice(0, 6),
      对象: targetsList.map((x) => String(x || '').trim()).filter(Boolean),
      原文: d.原文,
    });
    added += 1;
  }
  done.add(sc.sceneId);
  saveJ(outFile, doc);
  saveJ(progressFile, { done: [...done] });
  console.log(sc.sceneId, '完成 | 淫语', added, '| 台词', rows.length);
}

doc.items.sort((x, y) => x.sentence - y.sentence);
doc.totals = { items: doc.items.length, byType: {} };
for (const it of doc.items) doc.totals.byType[it.类型] = (doc.totals.byType[it.类型] || 0) + 1;
saveJ(outFile, doc);
console.log('结束 | 淫语', doc.totals.items, '| 类型', JSON.stringify(doc.totals.byType));
