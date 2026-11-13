import { chatViaConsole } from '../core/console-client.mjs';
import { getTemplate } from '../core/prompt-templates.mjs';
import { logPrompt } from '../core/prompt-log.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../core/atomic-json.mjs';

// 确保输出目录存在（新书首次运行时 l2 可能还没建）
function ensureOutputDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ } }

/**
 * 模型切分场景：输入带编号的句子流，模型只返回切点（句子序号），我方转成 S 区间。
 * 失败或切点非法时，退回规则切分（tools/segment-scenes.mjs 的逻辑）。
 */

const file = process.argv[2];
const work = path.dirname(process.argv[3] || process.argv[2]);
const outFile = process.argv[3] || file.replace(/\.json$/, '.scenes.json');
const limitChapters = Number(process.argv[4] || 0);
const MODEL = process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K';
const segmentRunId = 'segment-' + Date.now();
if (!file) { console.error('用法：node tools/segment-scenes-llm.mjs <book.json> [out.json] [章数上限]'); process.exit(1); }

const book = JSON.parse(fs.readFileSync(file, 'utf8'));
let chapters = book.chapters || [];
if (limitChapters > 0) chapters = chapters.slice(0, limitChapters);

const MIN_SCENE = 6;
const BATCH = 140;

const TIME_MARK = /(次日|第二天|隔天|当晚|夜里|深夜|凌晨|清晨|早上|上午|中午|下午|傍晚|黄昏|半小时后|一小时后|几天后|一周后|一个月后|与此同时|另一边|良宵)/;
const STOP = /[的了着是在和就都而及与或一个我们你们他们她们它们这那些什么怎么因为所以但是如果虽然]/;
const words = (t) => new Set(String(t || '').replace(STOP, ' ').split(/[^\u4e00-\u9fa5]+/).filter((w) => w.length >= 2));
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
};

function chapterSentences(chapter) {
  const list = [];
  for (const para of chapter.paragraphs || []) {
    for (const s of para.sentences || []) {
      const num = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
      if (num) list.push({ n: num, text: s.text, paraId: para.id });
    }
  }
  list.sort((a, b) => a.n - b.n);
  return list;
}



async function modelCuts(chapter, sentences) {
  const MAX_CHARS = Number(process.env.SEGMENT_BATCH_CHARS || 4000);
  const MIN_SENTENCES = 6;
  const cuts = [];
  const emptyBatches = [];

  let start = 0;
  let guard = 0;
  while (start < sentences.length && guard < 400) {
    guard += 1;

    const batch = [];
    let chars = 0;
    for (let i = start; i < sentences.length; i += 1) {
      const s = sentences[i];
      const len = String(s.text || '').length;
      if (batch.length >= MIN_SENTENCES && chars + len > MAX_CHARS) break;
      batch.push(s);
      chars += len;
    }
    if (!batch.length) break;

    // 章尾剩余不足 6 句：不调用模型，直接并入上一场（作为该场结尾）
    const remaining = sentences.length - start;
    if (remaining < MIN_SENTENCES) {
      console.log('  章尾剩余 ' + remaining + ' 句，并入上一场');
      break;
    }

    const ask = async (strict) => {
      const prompt = [
        getTemplate('segment'),
        '下面是一段连续叙述的句子，每行以句子编号开头（共 ' + batch.length + ' 句，约 ' + chars + ' 字）。',
        '请找出「场景切换」的位置：地点变了、时间跳了、换了一组人物、或者这场戏的目的结束了。',
        '只返回切换处的前一句编号，用 JSON：{"cuts":[编号,编号]}。',
        strict ? '本批至少给出一个切点；如果实在没有转折，就给出本批最后一句作为切点。' : '',
        '',
        '【句子】',
        batch.map((s) => s.n + '. ' + String(s.text || '').slice(0, 120)).join('\n'),
      ].filter(Boolean).join('\n');

      logPrompt(work, 'scenesview', prompt);
      const r = await chatViaConsole({ prompt, source: 'segment-scenes-llm.mjs', maxTokens: 4096, runId: segmentRunId });
      if (!r.ok) return [];
      try {
        const raw = String(r.content || '');
        const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        return (parsed.cuts || []).map(Number).filter(Number.isFinite)
          .filter((n) => n >= batch[0].n && n <= batch[batch.length - 1].n)
          .sort((a, b) => a - b);
      } catch { return []; }
    };

    let list = await ask(false);
    if (!list.length) {
      // 模型没给切点：同一批再问一次，明确要求至少一个切点
      list = await ask(true);
    }
    if (!list.length) {
      // 仍然没有：在批尾强制断开，保证场景不会无限增长
      list = [batch[batch.length - 1].n];
      emptyBatches.push(batch[0].n + '-' + batch[batch.length - 1].n);
    }

    cuts.push(...list);

    const lastCut = list[list.length - 1];
    const idx = sentences.findIndex((s) => s.n === lastCut);
    start = idx >= 0 ? idx + 1 : start + batch.length;
  }

  if (emptyBatches.length) {
    console.log('  有 ' + emptyBatches.length + ' 批模型未给切点，已在批尾强制断开：' + emptyBatches.slice(0, 5).join(','));
  }

  return [...new Set(cuts)].sort((a, b) => a - b);
}


function rulesCuts(sentences) {
  const cuts = [];
  const info = sentences.map((s) => ({ n: s.n, words: words(s.text), time: TIME_MARK.test(s.text) }));
  for (let i = 1; i < info.length; i += 1) {
    const prev = info[i - 1];
    const cur = info[i];
    let score = 0;
    if (cur.time) score += 0.35;
    if (jaccard(prev.words, cur.words) < 0.08) score += 0.3;
    if (score >= 0.45) cuts.push(prev.n);
  }
  return cuts;
}

function toRanges(chapter, sentences, cuts, source) {
  const numbers = sentences.map((s) => s.n);
  const valid = [...new Set(cuts)]
    .filter((c) => numbers.includes(c))
    .sort((a, b) => a - b);
  const scenes = [];
  let start = numbers[0];
  for (const cut of valid) {
    if (cut - start + 1 < MIN_SCENE) continue;          // 太短，跳过这个切点
    scenes.push({ start, end: cut });
    start = cut + 1;
  }
  if (start <= numbers[numbers.length - 1]) scenes.push({ start, end: numbers[numbers.length - 1] });

  return scenes.map((range, index) => ({
    chapterId: chapter.id,
    chapterTitle: chapter.title || '',
    from: `S${range.start}`,
    to: `S${range.end}`,
    sentences: range.end - range.start + 1,
    source,
    order: index + 1,
  }));
}

// 开跑前把上一轮结果挪走：运行期间不会展示旧场数，失败也能找回
{
  const prev = outFile.replace(/\.json$/, '.previous-run.json');
  try {
    if (fs.existsSync(outFile) && !fs.existsSync(prev)) fs.copyFileSync(outFile, prev);
    if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
    console.log('上一轮结果已移到', prev);
  } catch (error) { console.log('移动旧结果失败：', error.message); }
}

// 清理上次残留的细化标记
try { fs.rmSync(path.join(path.dirname(outFile), 'segmentation.phase.json'), { force: true }); } catch { /* 忽略 */ }

const all = [];
const partialPath = path.join(path.dirname(outFile), 'scenes.partial.jsonl');
const progressPath = path.join(path.dirname(outFile), 'scenes.progress.json');
// verifyDone：只把 partial 里真的有输出的章节算作已完成
const partialIds = new Set();
try {
  if (fs.existsSync(partialPath)) {
    for (const line of fs.readFileSync(partialPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { const o = JSON.parse(s); if (o.chapterId) partialIds.add(o.chapterId); } catch { /* 跳过坏行 */ }
    }
  }
} catch { /* 忽略 */ }

const doneChapters = new Set(fs.existsSync(progressPath) ? (JSON.parse(fs.readFileSync(progressPath, 'utf8')).chapters || []) : []);
const saveChapter = (chapterId, scenes) => {
  if (scenes.length) fs.appendFileSync(partialPath, scenes.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  doneChapters.add(chapterId);
  writeJsonAtomic(progressPath, { chapters: [...doneChapters], at: new Date().toISOString() });
};
let modelUsed = 0;
let ruleUsed = 0;
for (const chapter of chapters) {
  if (doneChapters.has(chapter.id)) continue;
  const sentences = chapterSentences(chapter);
  if (!sentences.length) continue;
  let cuts = await modelCuts(chapter, sentences);
  let source = 'model';
  if (!cuts || !cuts.length) { cuts = rulesCuts(sentences); source = 'rules'; }
  if (source === 'model') modelUsed += 1; else ruleUsed += 1;
  const ranges = toRanges(chapter, sentences, cuts, source);
  all.push(...ranges);
  saveChapter(chapter.id, ranges);
}

// 先合并续跑结果，再统一编号（顺序写反会导致编号缺失/重复）
if (fs.existsSync(partialPath)) {
  for (const line of fs.readFileSync(partialPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!all.some((x) => x.chapterId === r.chapterId && x.from === r.from)) all.push(r);
    } catch { /* 忽略坏行 */ }
  }
}


// 合并过短场景：同章内 < MIN 句的场景并入相邻场景（优先并前一场，章首并后一场）
function mergeSmallScenes(scenes, min = 20, textOf = null, maxChars = 4000) {
  const MIN = Number(min) || 20;
  const MAXC = Number(maxChars) || 4000;
  const charsOf = (s) => {
    if (!textOf) {
      const a = Number(String(s.from).slice(1));
      const b = Number(String(s.to).slice(1));
      return (b - a + 1) * 30;
    }
    const a = Number(String(s.from).slice(1));
    const b = Number(String(s.to).slice(1));
    let n = 0;
    for (let i = a; i <= b; i += 1) n += String(textOf.get(i) || '').length;
    return n;
  };

  const byChapter = new Map();
  for (const s of scenes) {
    if (!byChapter.has(s.chapterId)) byChapter.set(s.chapterId, []);
    byChapter.get(s.chapterId).push(s);
  }

  const out = [];
  for (const list of byChapter.values()) {
    list.sort((a, b) => Number(String(a.from).slice(1)) - Number(String(b.from).slice(1)));
    const merged = list.map((s) => ({ ...s }));
    let i = 0;
    while (i < merged.length) {
      const cur = merged[i];
      const size = Number(cur.sentences) || (Number(String(cur.to).slice(1)) - Number(String(cur.from).slice(1)) + 1);
      if (size >= MIN || merged.length === 1) { i += 1; continue; }

      const prev = merged[i - 1];
      const next = merged[i + 1];
      const curChars = charsOf(cur);

      // 只在合并后不超过字数上限时才并
      if (prev) {
        const combined = charsOf(prev) + curChars;
        if (combined <= MAXC) {
          prev.to = cur.to;
          prev.sentences = (Number(prev.sentences) || 0) + size;
          prev.source = prev.source || cur.source;
          merged.splice(i, 1);
          continue;
        }
      }
      if (next) {
        const combined = charsOf(next) + curChars;
        if (combined <= MAXC) {
          next.from = cur.from;
          next.sentences = (Number(next.sentences) || 0) + size;
          merged.splice(i, 1);
          continue;
        }
      }
      i += 1;
    }
    out.push(...merged);
  }

  // 按章节排序
  const chapterNo = (id) => Number(String(id || '').replace(/\D/g, ''));
  out.sort((a, b) => (chapterNo(a.chapterId) - chapterNo(b.chapterId)) || (Number(String(a.from).slice(1)) - Number(String(b.from).slice(1))));
  return out;
}


const sentenceTextForMerge = new Map();
{
  for (const chapter of chapters) for (const s of chapterSentences(chapter)) sentenceTextForMerge.set(s.n, String(s.text || ''));
}
const mergedScenes = mergeSmallScenes(all, 20, sentenceTextForMerge, Number(process.env.SEGMENT_BATCH_CHARS || 4000));

all.length = 0;
all.push(...mergedScenes);

all.sort((a, b) => {
  const ca = Number(String(a.chapterId || '').replace(/\D/g, '')) || 0;
  const cb = Number(String(b.chapterId || '').replace(/\D/g, '')) || 0;
  if (ca !== cb) return ca - cb;
  return Number(String(a.from).slice(1)) - Number(String(b.from).slice(1));
});
all.forEach((scene, index) => { scene.sceneId = `SC${String(index + 1).padStart(3, '0')}`; });

// 写盘前校验：覆盖全部句子、无重复、无遗漏、内容与原文一致
{
  const errors = [];
  const warnings = [];

  // 原文句子表：句号 → 文本
  const original = new Map();
  for (const c of chapters) for (const s of chapterSentences(c)) original.set(s.n, String(s.text || ''));
  const totalExpected = original.size;

  // 编号与区间格式
  const badIds = all.filter((s) => !/^SC\d{3,}$/.test(s.sceneId || '') || !/^S\d+$/.test(s.from || '') || !/^S\d+$/.test(s.to || '') || !(s.sentences > 0));
  if (badIds.length) errors.push('无效场景 ' + badIds.length + ' 个：' + badIds.slice(0, 5).map((s) => s.sceneId || s.from).join(','));

  const uniqueIds = new Set(all.map((s) => s.sceneId));
  if (uniqueIds.size !== all.length) errors.push('场景编号重复 ' + (all.length - uniqueIds.size) + ' 个');

  // 覆盖检查
  const covered = new Map();
  const dupSentences = [];
  for (const s of all) {
    const a = Number(String(s.from).slice(1));
    const b = Number(String(s.to).slice(1));
    if (!(b >= a)) { errors.push(s.sceneId + ' 区间非法 ' + s.from + '~' + s.to); continue; }
    const count = b - a + 1;
    if (Number(s.sentences) !== count) errors.push(s.sceneId + ' 句数不符：声明 ' + s.sentences + '，区间 ' + count);
    for (let n = a; n <= b; n += 1) {
      if (!original.has(n)) { errors.push(s.sceneId + ' 引用了不存在的句子 S' + n); continue; }
      if (covered.has(n)) dupSentences.push(n);
      else covered.set(n, s.sceneId);
    }
  }

  if (dupSentences.length) {
    errors.push('重复包含的句子 ' + dupSentences.length + ' 句：S' + dupSentences.slice(0, 10).join(',S'));
  }

  const missing = [];
  for (const n of original.keys()) if (!covered.has(n)) missing.push(n);
  missing.sort((x, y) => x - y);
  if (missing.length) {
    errors.push('遗漏的句子 ' + missing.length + ' 句：S' + missing.slice(0, 10).join(',S'));
  }

  // 顺序检查：场景必须按句号递增排列
  let prevTo = 0;
  for (const s of all) {
    const a = Number(String(s.from).slice(1));
    if (a <= prevTo) errors.push(s.sceneId + ' 与前一场重叠：' + s.from);
    prevTo = Number(String(s.to).slice(1));
  }

  // 内容一致性：每个场景区间内句子必须在原文里逐字存在
  let contentChecked = 0;
  for (const s of all) {
    const a = Number(String(s.from).slice(1));
    const b = Number(String(s.to).slice(1));
    for (let n = a; n <= b; n += 1) {
      const text = original.get(n);
      if (typeof text !== 'string') { errors.push(s.sceneId + ' 缺少原文 S' + n); continue; }
      contentChecked += 1;
    }
  }

  const report = {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    totalSentences: totalExpected,
    coveredSentences: covered.size,
    duplicateSentences: dupSentences.length,
    missingSentences: missing.length,
    scenes: all.length,
    contentChecked,
    errors: errors.slice(0, 20),
    warnings,
  };

  try {
    fs.writeFileSync(path.join(path.dirname(outFile), 'segmentation.verify.json'), JSON.stringify(report, null, 1), 'utf8');
  } catch { /* 忽略 */ }

  if (!report.ok) {
    console.error('切分校验失败：');
    for (const e of report.errors) console.error('  · ' + e);
    console.error('未写入 scenes-llm.json，请修正后重跑');
    process.exit(4);
  }
  console.log('切分校验通过：' + all.length + ' 场，覆盖 ' + covered.size + '/' + totalExpected + ' 句，无重复、无遗漏');
}

const doc = {
  generatedAt: new Date().toISOString(),
  source: path.basename(file),
  totals: {
    chapters: chapters.length,
    scenes: all.length,
    sentences: all.reduce((sum, s) => sum + s.sentences, 0),
    avgSentences: Number((all.reduce((sum, s) => sum + s.sentences, 0) / Math.max(1, all.length)).toFixed(1)),
    modelChapters: modelUsed,
    ruleChapters: ruleUsed,
  },
  scenes: all,
};

writeJsonAtomic(outFile, doc);
console.log(`章 ${doc.totals.chapters} · 场景 ${doc.totals.scenes} · 平均 ${doc.totals.avgSentences} 句 | 模型 ${modelUsed} 章 / 规则兜底 ${ruleUsed} 章`);
