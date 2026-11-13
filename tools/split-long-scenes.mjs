import { writeJsonAtomic } from '../core/atomic-json.mjs';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 把超过 MAX 句的场景，在最弱连接处切开。
 * 最弱连接 = 相邻段落之间实词重合度最低的位置（且切完两半都不少于 MIN 句）。
 * 用法：node tools/split-long-scenes.mjs <work> [MAX=120]
 */

const work = process.argv[2] || 'work/美少妇的哀羞';
const MAX = Number(process.argv[3] || 120);
const MIN = 20;

const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const scenesPath = path.join(work, 'l2', 'scenes-llm.json');
const doc = JSON.parse(fs.readFileSync(scenesPath, 'utf8'));

const paras = [];   // {chapterId, id, from, to, text}
const textOf = new Map();
for (const c of book.chapters || []) {
  for (const p of c.paragraphs || []) {
    const list = p.sentences || [];
    if (!list.length) continue;
    const from = Number(String(list[0].sid || list[0].id).replace(/^.*S/, ''));
    const to = Number(String(list[list.length - 1].sid || list[list.length - 1].id).replace(/^.*S/, ''));
    const text = list.map((s) => s.text).join('');
    paras.push({ chapterId: c.id, from, to, text });
    for (const s of list) {
      const n = Number(String(s.sid || s.id).replace(/^.*S/, ''));
      if (n) textOf.set(n, s.text);
    }
  }
}

const STOP = /[的了着是在和就都而及与或一个我们你们他们她们它们这那些什么怎么因为所以但是如果虽然]/g;
const words = (t) => new Set(String(t || '').replace(STOP, ' ').split(/[^\u4e00-\u9fa5]+/).filter((w) => w.length >= 2));
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
};

const result = [];
let splitCount = 0;

for (const scene of doc.scenes) {
  const from = Number(String(scene.from).slice(1));
  const to = Number(String(scene.to).slice(1));
  const total = to - from + 1;
  if (total <= MAX) { result.push({ ...scene }); continue; }

  // 章内段落，落在场景范围内的切点候选
  const inner = paras.filter((p) => p.chapterId === scene.chapterId && p.from >= from && p.to <= to);
  if (inner.length < 2) { result.push({ ...scene }); continue; }

  let pieces = [];
  let startIdx = 0;
  let startSentence = inner[0].from;
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const remaining = to - startSentence + 1;
    if (remaining <= MAX) { pieces.push({ from: startSentence, to }); break; }
    // 在 [startIdx, end] 里找允许范围内连接最弱处
    let best = null;
    for (let i = startIdx; i < inner.length - 1; i += 1) {
      const left = inner[i];
      const right = inner[i + 1];
      const cutLen = left.to - startSentence + 1;
      if (cutLen < MIN) continue;
      if (cutLen > MAX - MIN) break;
      const score = overlap(words(left.text), words(right.text));
      if (!best || score < best.score) best = { i, score, cutAt: left.to };
    }
    if (!best) { pieces.push({ from: startSentence, to }); break; }
    pieces.push({ from: startSentence, to: best.cutAt });
    startSentence = best.cutAt + 1;
    startIdx = best.i + 1;
  }

  if (pieces.length === 1) { result.push({ ...scene }); continue; }
  splitCount += 1;
  pieces.forEach((piece, i) => {
    result.push({
      ...scene,
      from: 'S' + piece.from,
      to: 'S' + piece.to,
      sentences: piece.to - piece.from + 1,
      order: scene.order + (i / 10),
      split: i + 1,
      splitOf: scene.sceneId,
      source: scene.source,
    });
  });
}

// 重新编号
result.sort((a, b) => Number(String(a.from).slice(1)) - Number(String(b.from).slice(1)));
result.forEach((s, i) => {
  s.sceneId = 'SC' + String(i + 1).padStart(3, '0');
  delete s.split;
  delete s.splitOf;
});

const out = {
  ...doc,
  generatedAt: new Date().toISOString(),
  splitRule: '单场不超过 ' + MAX + ' 句，超出在最弱段落连接处切开',
  totals: {
    chapters: doc.totals?.chapters ?? 0,
    scenes: result.length,
    sentences: result.reduce((n, s) => n + s.sentences, 0),
    avgSentences: Number((result.reduce((n, s) => n + s.sentences, 0) / Math.max(1, result.length)).toFixed(1)),
    modelChapters: doc.totals?.modelChapters ?? 0,
    ruleChapters: doc.totals?.ruleChapters ?? 0,
  },
  scenes: result,
};
writeJsonAtomic(scenesPath, out, 1);

const over = result.filter((s) => s.sentences > MAX).length;
console.log(`切分场景 ${splitCount} 个 → 总数 ${doc.scenes.length} → ${result.length}`);
console.log(`平均 ${out.totals.avgSentences} 句 | 仍超过 ${MAX} 句的: ${over} 个`);
console.log(`最大: ${Math.max(...result.map((s) => s.sentences))} 句`);
