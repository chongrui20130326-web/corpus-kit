import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execFile, spawn } from 'node:child_process';
import { listBooks, loadBook } from './ui/data.mjs';
import { splitBook } from './core/split.mjs';
import { parseCorpusFile } from './core/corpusImport.mjs';
import { pipelineStatus, writeStepState, STEPS } from './core/pipelineStatus.mjs';
import { layout, ensureDir, writeJson, readJson, createLogger, stamp } from './core/store.mjs';
import { createLlm, createOllamaLlm, createPool } from './core/llm.mjs';
import { runPipeline, ORDER } from './core/pipeline.mjs';
import { advise, writeProse } from './core/advisor.mjs';
import { adviseWithContext, writeFromAdvice } from './core/advisorV2.mjs';
import { listLibrary, renameBook, deleteBook, writeMeta, ensureMeta } from './core/library.mjs';
import { checkCoverage } from './core/coverage.mjs';
import { exportProject } from './core/project.mjs';
import { routeByStep } from './core/llmRouter.mjs';
import { createSession, wrapLlm } from './core/sessionLog.mjs';
import { setPaused, isPaused, unloadModel, forceUnloadModel } from './core/pause.mjs';
import { resolvePrompt, resolveModel as resolveTabModel } from './core/tab-config.mjs';
import { STRATA_MODELS, OLLAMA_FALLBACKS, API_MODELS, findModel, findApiModel, resolveModel, modelLabel } from './core/models.mjs';
import { openReadDb, storageMode } from './core/db.mjs';
import { writeJsonAtomic, withJsonLock } from './core/atomic-json.mjs';

// 场景详述完整性判定：人物/情节/提要 至少要有内容
function detailState(d) {
  if (!d) return { done: false, partial: false, missing: [] };
  const missing = [];
  if (!Array.isArray(d['人物']) || !d['人物'].length) missing.push('人物');
  if (!Array.isArray(d['情节']) || !d['情节'].length) missing.push('情节');
  if (!String(d['提要'] || '').trim()) missing.push('提要');
  return { done: missing.length === 0, partial: true, missing };
}

/** API 模式：key 从 config.json 的 apiKey 或环境变量读，不写进代码。 */
function resolveApiKey(root) {
  const config = readJson(path.join(root, 'config.json'), null) || readJson(path.join(here, 'config.json'), null) || {};
  return process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || config.apiKey || '';
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const jobs = [];
let running = null;
const pipelineJobs = new Map();
let cleanProcess = null;
let cleanModel = '';
// 跑完之后仍要能回看这次对话，所以留一份最后会话的引用。
let lastSession = null;
let lastSessionFile = '';
let lastSessionJobId = '';

/** 中文数字转阿拉伯数字（支持 一..九百九十九） */
function cnNumber(text) {
  const s = String(text || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of s) {
    if (digits[ch] !== undefined) { number = digits[ch]; continue; }
    if (units[ch]) {
      const unit = units[ch];
      section += (number || 1) * unit;
      number = 0;
      continue;
    }
    return null;
  }
  total = section + number;
  return total > 0 ? total : null;
}

const CLEAN_REF_FILE = path.join('work', '.config', 'clean-reference.json');
function readCleanReference() {
  try { return fs.existsSync(CLEAN_REF_FILE) ? (JSON.parse(fs.readFileSync(CLEAN_REF_FILE, 'utf8')).reference || '') : ''; } catch { return ''; }
}
function saveCleanReference(reference) {
  try {
    fs.mkdirSync(path.dirname(CLEAN_REF_FILE), { recursive: true });
    fs.writeFileSync(CLEAN_REF_FILE, JSON.stringify({ reference }, null, 1), 'utf8');
  } catch { /* 忽略 */ }
}

/** 清洗后重新梳理全书：书名 + 目录 + 正文三段式（同时统一括号式章标题）。 */

// 原文每章标题相同（例如都写「第3章」）时，按出现顺序重编号，保证目录不重复
function renumberDuplicateHeadings(text) {
  const lines = String(text || '').split('\n');
  const idx = [];
  const numbers = [];
  lines.forEach((line, i) => {
    const m = line.match(/^《(.+?)》（第([0-9]+)章）\s*(.*)$/);
    if (m) {
      idx.push({ i, book: m[1], title: (m[3] || '').trim() });
      numbers.push(Number(m[2]));
    }
  });
  if (idx.length < 2) return { text, changed: 0 };
  const duplicated = new Set(numbers).size < numbers.length;
  const sameTitle = new Set(idx.map((x) => x.title)).size === 1 && idx.some((x) => x.title);
  if (!duplicated && !sameTitle) return { text, changed: 0 };

  idx.forEach((item, k) => {
    const num = k + 1;
    lines[item.i] = '《' + item.book + '》（第' + num + '章）' + (item.title ? ' ' + item.title : '');
  });
  return { text: lines.join('\n'), changed: idx.length };
}

function buildStructuredBook(body, fallbackName = '') {
  const lines = String(body || '').split('\n');
  const chapters = [];
  let book = '';

  const outLines = [];
  for (const line of lines) {
    // 已统一的格式：《书名》（第N章）标题
    const formatted = line.match(/^《(.+?)》（第([0-9]+)章）\s*(.*)$/);
    if (formatted) {
      if (!book) book = formatted[1].trim();
      chapters.push({ number: Number(formatted[2]), title: (formatted[3] || '').trim(), line });
      outLines.push(line);
      continue;
    }
    // 括号式章标题：标题（一）/（二）/（一百八十）
    const paren = line.trim().match(/^(.{1,20}?)[（(]([一二三四五六七八九十百千零两\d]{1,8})[）)]$/);
    if (paren) {
      const number = cnNumber(paren[2]);
      if (number) {
        if (!book) book = paren[1].trim();
        const unified = `《${book}》（第${number}章）`;
        chapters.push({ number, title: '', line: unified, from: line });
        outLines.push(unified);
        continue;
      }
    }
    outLines.push(line);
  }

  const bookName = book || fallbackName || '未命名';
  const toc = chapters.map((item) => `第${item.number}章 ${item.title || '（无标题）'}`).join('\n');
  const structured = [
    `书名《${bookName}》`,
    '',
    `共 ${chapters.length} 章`,
    '',
    '清洗后目录：',
    toc || '（没有识别到章节）',
    '',
    '清洗正文：',
    '',
    outLines.join('\n'),
  ].join('\n');

  return { structured, bookName, chapterCount: chapters.length, chapters };
}

/** 收集疑似章标题的候选行（短行、无句末标点）。 */
function chapterCandidates(text, limit = 500) {
  const lines = String(text || '').split('\n');
  const NUMBERED = /^(第[一二三四五六七八九十百千零两\d]{1,8}[章节回]|.{0,26}[（(](?:续|之|外|番外|第)?\s*[一二三四五六七八九十百千零两\d]{1,8}[）)](\s*(?:[（(]\s*续\s*[一二三四五六七八九十百千零两\d]{1,8}\s*[）)]|续\s*[（(]\s*[一二三四五六七八九十百千零两\d]{1,8}\s*[）)]))?)/;
  const numbered = [];
  const others = [];
  const seen = new Set();
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.length > 40 || seen.has(t)) continue;
    if (/[。！？!?；;]$/.test(t)) continue;
    seen.add(t);
    if (NUMBERED.test(t)) numbered.push(t);
    else if (others.length < 80) others.push(t);
  }
  return [...numbered, ...others].slice(0, limit);
}


/** 从一行标题里解析章号：第N章 / 第N节 / 第N回 / 标题（一） */
function isXuSeries(line) {
  return /[（(]\s*续\s*[一二三四五六七八九十百千零两\d]{1,8}/.test(String(line || ""));
}

function xuSuffix(line) {
  const s = String(line || '').trim();
  const m = s.match(/[（(]\s*续\s*([一二三四五六七八九十百千零两\d]{1,8})\s*[）)]\s*$/) || s.match(/续\s*[（(]\s*([一二三四五六七八九十百千零两\d]{1,8})\s*[）)]\s*$/);
  if (!m) return null;
  const n = cnNumber(m[1]);
  return n ? { n, text: '续' + n } : null;
}

function numberFromLine(line) {
  let text = String(line || '').trim();
  const suffix = xuSuffix(text);
  if (suffix) {
    text = text.replace(/[（(]\s*续\s*[一二三四五六七八九十百千零两\d]{1,8}\s*[）)]\s*$/, '').trim();
    text = text.replace(/续\s*[（(]\s*[一二三四五六七八九十百千零两\d]{1,8}\s*[）)]\s*$/, '').trim();
  }
  const zhang = text.match(/^第([一二三四五六七八九十百千零两\d]{1,8})[章节回]/);
  if (zhang) { const n = cnNumber(zhang[1]); if (n) return n; }
  // 形如「《书名》（第3章）」，章号在括号里且带「章」字
  const inParen = text.match(/[（(]\s*第?\s*([一二三四五六七八九十百千零两\d]{1,8})\s*[章节回]\s*[）)]/);
  if (inParen) {
    const n = cnNumber(inParen[1]);
    if (n) return n;
  }
  const paren = text.match(/[（(](续|之|外|番外|第)?\s*([一二三四五六七八九十百千零两\d]{1,8})(?:[）)]|[、,，.：:\s][^）)]*[）)])\s*$/);
  if (paren) { const n = cnNumber(paren[2]); if (n) return paren[1] === '续' ? 1000 + n : n; }
  return null;
}

/** 让模型判断哪些行是章节标题：分块送短行，返回 { line, number }。不再用正则预筛。 */
async function pickChapterRows(text, model) {
  const lines = String(text || '').split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw || raw.length > 40) continue;
    if (/[。！？!?；;]$/.test(raw)) continue;
    rows.push({ index: i, line: raw });
  }
  if (!rows.length) return { rows: [] };

  const CHUNK = 60;
  const picked = [];
  let lastNumber = 0;

  for (let start = 0; start < rows.length; start += CHUNK) {
    const part = rows.slice(start, start + CHUNK);
    const prompt = [
      (await import('./core/prompt-templates.mjs')).getTemplate('clean'),
      '下面是小说正文里的短行，每行前面是行号。',
      '请判断哪些行是「章节标题」，并按顺序给出章号。',
      '注意：',
      '· 章节标题通常是「第N章 xxx」「第N回 ...」「标题（一）」「Chapter N」等，也可能是没有编号的独立短标题',
      '· 正文句子、对话、人名、地址、时间不要选',
      '· 章号取标题里写明的数字；标题没写数字就用上一个章号 + 1',
      '· 同一本书的章节标题格式通常一致：找到一种格式后，把全文里同格式的行全部选出',
      '· 宁可多选也不要漏选：漏掉一章比多选一行更糟',
      '· 每条都要给出章号；章号按标题里的数字，没写数字就按出现顺序递增',
      '· 章节标题可能有多种写法：可能是《书名》（第xx章），也可能是「第69章」「69.」「【第N章】」等；不要只看一种格式',
      '',
      (readCleanReference() ? ('【用户提供的章节标题参考】\n' + readCleanReference() + '\n请严格按这个格式，把全文里同格式的行都找出来。') : ''),
      '【上一块最后章号】' + lastNumber,
      '',
      '【短行】',
      part.map((r) => r.index + ' | ' + r.line).join('\n'),
      '',
      '只返回 JSON：{"rows":[{"行号":12,"章号":1}]}',
      resolvePrompt('clean') ? ('【补充要求】' + resolvePrompt('clean')) : '',
    ].join('\n');

    try {
      const response = await fetch('http://127.0.0.1:8090/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
        body: JSON.stringify({
          model: model || resolveTabModel('clean', 'qwen3.5:9b-uncensored-q8_0_64K', process.env.CLEAN_MODEL),
          messages: [{ role: 'user', content: prompt }],
          stream: false, max_tokens: 2000, temperature: 0.1,
          reasoning_effort: 'none', response_format: { type: 'json_object' },
        }),
      });
      if (!response.ok) continue;
      const data = await response.json();
      const raw = String(data.choices?.[0]?.message?.content || '');
      const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json);
      for (const item of Array.isArray(parsed.rows) ? parsed.rows : []) {
        const idx = Number(item['行号'] ?? item.index);
        const n = Number(item['章号'] ?? item.number);
        const row = rows.find((r) => r.index === idx);
        if (!row) continue;
        const number = Number.isFinite(n) && n > 0 ? n : lastNumber + 1;
        if (picked.some((x) => x.line === row.line)) continue;
        picked.push({ line: row.line, number });
        lastNumber = Math.max(lastNumber, number);
      }
    } catch { /* 跳过该块 */ }
  }

  const ref = readCleanReference();
  const tpl = titleTemplate(ref);
  // templateFallback：模型漏掉的同格式标题用参考格式补齐
  if (tpl) {
    for (const row of rows) {
      if (picked.some((x) => x.line === row.line)) continue;
      if (!tpl.test(row.line)) continue;
      const m = row.line.match(tpl);
      const n = m ? cnNumber(m[1]) : null;
      picked.push({ line: row.line, number: n || lastNumber + 1 });
      if (n) lastNumber = Math.max(lastNumber, n);
    }
    picked.sort((a, b) => rows.findIndex((r) => r.line === a.line) - rows.findIndex((r) => r.line === b.line));
  }

  return { rows: picked };
}

/** 从参考标题推导格式：把数字段替换成捕获组，用于补充模型漏掉的标题 */
function titleTemplate(reference) {
  const first = String(reference || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!first) return null;
  let escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  escaped = escaped.replace(/《[^》]*》/g, '《.*》');
  escaped = escaped.replace(/[0-9０-９]+/g, '([0-9０-９]+)');
  escaped = escaped.replace(/[一二三四五六七八九十百千零两]+/g, '([一二三四五六七八九十百千零两]+)');
  try { return new RegExp('^' + escaped + '$'); } catch { return null; }
}

function normTitle(value) {
  return String(value || '')
    .replace(/[《》「」『』（）()\s:：·、,，.。!！?？]/g, '')
    .trim();
}

function unifiedTocTitle(raw, bookName) {
  let text = String(raw || "").trim();
  // 括号里的序号统一成阿拉伯数字：（九十三）→（93）、（续16）保留
  text = text.replace(/[（(](?:续|之|外|番外)?\s*([一二三四五六七八九十百千零两\d]{1,8})([、,，.：:\s][^）)]*)?[）)]/g, (whole, digits, tail) => {
    const n = cnNumber(digits);
    if (!n) return whole;
    const keepXu = /[（(]\s*(续|之|外|番外)/.test(whole);
    return "（" + (keepXu ? "续" : "") + n + (tail || "") + "）";
  });
  text = text.replace(/^第[一二三四五六七八九十百千零两\d]{1,8}[章节回][:：\s]*/, "");
  return text.replace(/\s+/g, " ").trim();
}

async function buildStructuredBookAsync(body, fallbackName, model) {
  const text = String(body || '');
  const lines = text.split('\n');
  const bookName = String(fallbackName || '').trim() || '未命名';

  const { rows: picked } = await pickChapterRows(text, model);

  // 参考格式补全：把与参考标题同格式的行补进章节列表
  {
    const ref = readCleanReference();
    const tpl = titleTemplate(ref);
    if (tpl) {
      let lastNo = picked.reduce((m, x) => Math.max(m, Number(x.number) || 0), 0);
      for (const line of lines) {
        const s = line.trim();
        if (!s || s.length > 60) continue;
        if (picked.some((x) => x.line === s)) continue;
        if (!tpl.test(s)) continue;
        const m = s.match(tpl);
        const n = m ? cnNumber(m[1]) : null;
        picked.push({ line: s, number: n || lastNo + 1 });
        if (n) lastNo = Math.max(lastNo, n);
      }
    }
  }

  const chapters = [];
  let lastNumber = 0;
  for (const item of picked) {
    const line = item.line;
    const number = item.number;
    if (chapters.some((c) => c.number === number)) continue;   // 重复章号只留第一条
    chapters.push({ number, title: line, raw: line });
    lastNumber = Math.max(lastNumber, number);
  }

  const warnings = [];
  const numbers = chapters.map((c) => c.number).filter((n) => n < 1000).sort((a, b) => a - b);
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] !== numbers[i - 1] + 1) warnings.push('缺第' + (numbers[i - 1] + 1) + '章（第' + numbers[i - 1] + '章 → 第' + numbers[i] + '章）');
  }
  if (numbers.length && numbers[0] !== 1) warnings.push('开头不是第1章（从第' + numbers[0] + '章开始）');
  const dupCount = picked.length - chapters.length;
  if (dupCount > 0) warnings.push('有 ' + dupCount + ' 行章号重复，已跳过');

  // 补录裸章号行：形如「第69章」这种没有书名的标题，也要纳入章节并统一格式
  {
    for (const line of lines) {
      const s = line.trim();
      if (!s || s.length > 20) continue;
      if (chapters.some((c) => c.raw === s)) continue;
      const m = s.match(/^第([0-9一二三四五六七八九十百千零两]{1,8})[章回](\s+.+)?$/);
      if (!m) continue;
      const n = cnNumber(m[1]);
      if (!n) continue;
      if (chapters.some((c) => c.number === n)) continue;
      chapters.push({ number: n, title: (m[2] || '').trim(), raw: s });
    }
  }

  // 统一标题：书名 + 章号 + 原标题（去掉书名与编号残留）
  const rawSet = new Map(chapters.map((c) => [c.raw, c]));
  const outLines = lines.map((line) => {
    const hit = rawSet.get(line.trim());
    if (hit && /[。！？!?]/.test(hit.raw)) return line;   // 标题行混了正文，保持原样
    if (!hit) return line;
    let title = '';
    const inner = hit.raw.match(/[（(][一二三四五六七八九十百千零两\d]{1,8}[、,，.：:\s]+([^）)]{1,40})[）)]\s*$/);
    if (inner) title = inner[1].trim();
    else {
      const zhangTitle = hit.raw.match(/^第[一二三四五六七八九十百千零两\d]{1,8}[章节回][:：\s]+(.+)$/);
      if (zhangTitle) title = zhangTitle[1].trim();
    }
    if (normTitle(title) === normTitle(bookName) || !normTitle(title)) title = '';
    const suffix = xuSuffix(hit.raw);
    const label = hit.number >= 1000 ? ('续' + (hit.number - 1000)) : ('第' + hit.number + '章' + (suffix ? ' ' + suffix.text : ''));
    const heading = `《${bookName}》（${label}）${title ? ' ' + title : ''}`;
    hit.heading = heading;
    return heading;
  });

  // 原文标题重复（如每章都写「第3章」）时，按出现顺序重编号，避免目录一串相同标题
  {
    const numbers = chapters.map((c) => Number(c.number));
    const duplicated = new Set(numbers).size < numbers.length;
    const titles = chapters.map((c) => normTitle(c.titleText || ''));
    const sameTitle = titles.length > 1 && new Set(titles).size === 1;
    if (duplicated || sameTitle) {
      chapters.forEach((c, i) => {
        c.number = i + 1;
        const label = '第' + c.number + '章';
        const keepTitle = c.titleText && normTitle(c.titleText) !== normTitle(bookName) && normTitle(c.titleText) !== '第' + (i + 1) + '章';
        c.heading = '《' + bookName + '》（' + label + '）' + (keepTitle ? ' ' + c.titleText : '');
      });
      console.log('标题重复，已按顺序重编号：' + chapters.length + ' 章');
    }
  }

  // 自检：正文里像章节标题却没被纳入的行
  {
    const chapterRaws = new Set(chapters.map((c) => c.raw));
    const leftovers = lines
      .map((l) => l.trim())
      .filter((s) => s && s.length <= 30 && /^(第[0-9一二三四五六七八九十百千零两]{1,8}[章回]|[《【].{0,20}第[0-9一二三四五六七八九十百千零两]{1,8}[章回][》】].*)$/.test(s))
      .filter((s) => !chapterRaws.has(s));
    if (leftovers.length) warnings.push('有 ' + leftovers.length + ' 行像章节标题但未纳入章节：' + leftovers.slice(0, 5).join(' / '));
  }

  const sorted = chapters.slice().sort((a, b) => (a.number >= 1000 ? 1e9 + a.number : a.number) - (b.number >= 1000 ? 1e9 + b.number : b.number));
  const tocLines = [];
  let prev = (sorted[0]?.number || 1) - 1;
  let xuStarted = false;
  for (const c of sorted) {
    if (c.number >= 1000) {
      if (!xuStarted) { tocLines.push(''); tocLines.push('续篇：'); xuStarted = true; }
      tocLines.push(c.heading || ('续' + (c.number - 1000)));
      continue;
    }
    if (prev < 1000) for (let n = prev + 1; n < c.number; n += 1) tocLines.push('（缺第' + n + '章）');
    tocLines.push(c.heading || ('第' + c.number + '章'));
    prev = c.number;
  }
  const toc = tocLines.join('\n');

  const structured = [
    `书名《${bookName}》`,
    '',
    `共 ${chapters.length} 章`,
    '',
    '清洗后目录：',
    toc || '（没有识别到章节）',
    '',
    '清洗正文：',
    '',
    outLines.join('\n'),
  ].join('\n');

  const tocList = chapters.slice().sort((a, b) => a.number - b.number).map((c) => c.heading || ('第' + c.number + '章'));
  const cleanDoc = { 书名: bookName, 目录: tocList, 正文: outLines.join('\n') };
  return { structured, bookName, chapterCount: chapters.length, chapters, warnings: [...new Set(warnings)], cleanDoc };
}

function repairJsonText(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
  // 去掉结尾多余逗号
  text = text.replace(/,\s*([}\]])/g, '$1');
  // 补未闭合的引号与括号
  let inString = false;
  let escaped = false;
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) text += '"';
  while (stack.length) {
    const open = stack.pop();
    text += open === '{' ? '}' : ']';
  }
  return text;
}

function validateDetail(detail, sceneSentences) {
  if (!detail || typeof detail !== 'object') return '返回不是对象';
  const people = detail['人物'];
  const steps = detail['情节'];
  if (!Array.isArray(people) || !people.length) return '缺人物';
  if (!Array.isArray(steps) || !steps.length) return '缺情节';
  const minSteps = Math.max(4, Math.floor((sceneSentences || 40) / 6));
  if (steps.length < minSteps) return '情节过少（' + steps.length + ' < ' + minSteps + '）';
  return '';
}

function parseModelJson(raw) {
  const first = String(raw || '');
  const body = first.slice(first.indexOf('{'), first.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch { /* 继续 */ }
  try { return JSON.parse(repairJsonText(first)); } catch { return null; }
}

function requireUrl(filePath) {
  return new URL('file://' + filePath.replace(/\\/g, '/')).href;
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function scenesFromDb(db, bookId, sourceScenes = []) {
  const original = new Map(sourceScenes.map((scene) => [scene.sceneId, scene]));
  return db.prepare(`SELECT scene_id, chapter_id, title, s_from, s_to, sentences, source
    FROM scene WHERE book_id = ? ORDER BY s_from, scene_id`).all(bookId).map((row) => ({
    ...(original.get(row.scene_id) || {}),
    chapterId: row.chapter_id,
    chapterTitle: row.title || '',
    from: 'S' + row.s_from,
    to: 'S' + row.s_to,
    sentences: row.sentences,
    source: row.source,
    sceneId: row.scene_id,
  }));
}

function hasSqliteBook(storage, dirs) {
  return storage === 'sqlite' && fs.existsSync(path.join(dirs.root, 'corpus.db'));
}

function sendFile(response, file) {
  if (!fs.existsSync(file)) { response.writeHead(404); response.end('not found'); return; }
  response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(response);
}

function readBody(request, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('文件过大（上限 32MB）')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sanitizeId(name) {
  return String(name || 'book')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'book';
}

function uniqueId(root, base) {
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(root, id))) { id = `${base}-${n}`; n += 1; }
  return id;
}

/** 模型配置：优先根目录 config.json，其次项目目录 config.json，最后本地 Ollama。 */
const DEFAULT_MODEL = 'qwen3.5:9b-uncensored-q8_0_64K';

// 去掉清洗结果章节正文里混入的目录条目（保留章节标题本身）
function stripTocFromChapters(structured, bookName) {
  const name = String(bookName || "");
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!safe) return;
  const re = new RegExp("^\\s*《" + safe + "》\\s*[（(]\\s*第\\s*[0-9一二三四五六七八九十百]+\\s*章\\s*[)）]\\s*", "g");
  for (const chapter of structured.chapters || []) {
    for (const para of chapter.paragraphs || []) {
      let text = String(para.text || "");
      let prev;
      do { prev = text; text = text.replace(re, ""); } while (text !== prev);
      if (text.trim()) para.text = text;
    }
  }
}

function resolveLlmConfig(root, mock) {
  if (mock) return { mock: true };
  // 统一走 LocalAI 网关：优先 gateway 配置，其次 config.json
  const candidates = [
    path.join(root, 'config.gateway.json'),
    path.join(here, 'config.gateway.json'),
    path.join(root, 'config.json'),
    path.join(here, 'config.json'),
  ];
  for (const file of candidates) {
    const value = readJson(file, null);
    if (value) return { ...value, model: value.model || DEFAULT_MODEL, source: file };
  }
  return { provider: 'gateway', gatewayBaseUrl: 'http://127.0.0.1:8090/v1', apiKey: 'local', model: DEFAULT_MODEL, timeoutMs: 900000, concurrency: 1, source: '默认网关' };
}

/** 按模型名造客户端：api:xxx / qwen3.8(Strata) / qwen3.5(Ollama) / 其它 OpenAI 兼容。 */
function clientForModel(modelName, config = {}) {
  const name = String(modelName || config.model || '');

  // 本地模型网关（LocalAI）：OpenAI 兼容，一次只处理一个请求，
  // 思考型模型必须显式 reasoning_effort:none，否则 content 会是空的。
  if (config.provider === 'gateway') {
    return createLlm({
      baseUrl: config.gatewayBaseUrl || config.apiBaseUrl || 'http://127.0.0.1:8090/v1',
      apiKey: config.apiKey || 'local',
      model: name || config.model || 'qwen3.5:9b-uncensored-q8_0_64K',
      timeoutMs: config.timeoutMs ?? 900_000,
      reasoningEffort: 'none',
      jsonMode: config.jsonMode,
    });
  }

  const apiPrefix = name.startsWith('api:');
  const api = findApiModel(name);
  if (api || apiPrefix) {
    const settings = readJson(settingsFile(), null) || {};
    return createLlm({
      baseUrl: api?.baseUrl || config.apiBaseUrl || settings.apiBaseUrl || 'https://api.deepseek.com/v1',
      apiKey: config.apiKey || resolveApiKey(root),
      model: api?.apiName || name.slice(4),
      timeoutMs: config.timeoutMs ?? 180_000,
      extraBody: { thinking: { type: 'disabled' } },
    });
  }

  const strata = findModel(name);
  if (strata) {
    return createLlm({
      baseUrl: strata.baseUrl,
      apiKey: 'local',
      model: strata.id,
      timeoutMs: config.timeoutMs ?? 300_000,
      extraBody: { thinking: { type: 'disabled' } },
    });
  }

  if (config.provider === 'ollama' || /^qwen3\.5:/.test(name)) {
    return createOllamaLlm({
      baseUrl: config.baseUrl || 'http://127.0.0.1:11434',
      model: name || 'qwen3.5:9b-uncensored-q8_0_64K',
      timeoutMs: config.timeoutMs,
      think: config.think,
    });
  }

  return createLlm({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: name, jsonMode: config.jsonMode, timeoutMs: config.timeoutMs });
}

function buildLlm(config) {
  if (config.mock) return { llm: { model: 'mock', chat: async ({ prompt, step, meta }) => {
    const { mockResponse } = await import('./core/mock.mjs');
    return { text: JSON.stringify(mockResponse(step, meta, prompt)) };
  } } };

  const base = clientForModel(config.model, config);
  const stepModels = config.stepModels && typeof config.stepModels === 'object' ? config.stepModels : {};
  const map = {};
  for (const [step, model] of Object.entries(stepModels)) {
    if (!model) continue;
    map[step] = model === config.model ? base : clientForModel(model, config);
  }
  return { llm: routeByStep(base, map), base, map };
}

/** 逐场顺序分析任务：可中断、可续跑、失败可单场修复。 */
/** 找出并杀掉这本书的所有 node 子进程（界面启动的 + 命令行启动的）。 */
function killBookProcesses(bookId) {
  let killed = 0;
  for (const [key, child] of pipelineJobs.entries()) {
    if (!key.startsWith(bookId + ':')) continue;
    try { child.kill('SIGKILL'); killed += 1; } catch { /* 忽略 */ }
    pipelineJobs.delete(key);
  }
  try {
    const { execSync } = require('node:child_process');
    const list = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { \$_.CommandLine -like '*${bookId}*' -and \$_.CommandLine -notlike '*app.mjs*' } | Select-Object -ExpandProperty ProcessId"`,
      { encoding: 'utf8', timeout: 20000 }
    );
    for (const line of list.split('\n')) {
      const pid = Number(line.trim());
      if (!pid) continue;
      try { process.kill(pid); killed += 1; } catch { /* 忽略 */ }
    }
  } catch { /* PowerShell 不可用就算了 */ }
  return killed;
}

async function startAnalyzeJob({ root, bookId, book, dirs, scenes, mode, model }) {
  const baseConfig = resolveLlmConfig(root, false);
  // 导入时选的模型优先：写成这本书自己的运行配置
  let config = baseConfig;
  if (model && model !== baseConfig.model) {
    const override = {
      ...baseConfig,
      provider: 'gateway',
      gatewayBaseUrl: baseConfig.gatewayBaseUrl || 'http://127.0.0.1:8090/v1',
      apiKey: baseConfig.apiKey || 'local',
      model,
      concurrency: 1,
    };
    writeJsonAtomic(path.join(dirs.root, 'config.run.json'), override, 2);
    config = override;
  }
  const job = {
    id: `job-${Date.now()}`,
    kind: 'analyze',
    bookId,
    title: book.title,
    status: 'running',
    step: 'ANALYZE',
    message: mode === 'repair' ? '修复失败场景' : '逐场分析',
    percent: 0,
    doneSteps: 0,
    totalSteps: 1,
    startedAt: Date.now(),
    done: 0,
    failed: [],
    total: scenes.length,
    current: '',
    pending: null,
  };
  jobs.unshift(job);
  if (jobs.length > 20) jobs.pop();
  running = job;
  const logger = createLogger(path.join(dirs.logs, `analyze-${stamp()}.jsonl`));
  const { llm } = buildLlm(config);
  job.model = llm.model;
  job.modelLabel = modelLabel(config.model || llm.model);
  const session = createSession(dirs.logs, job.id);
  job.sessionFile = session.file;
  lastSession = session;
  lastSessionFile = session.file;
  lastSessionJobId = job.id;

  const ctx = {
    book, dirs, force: true, failed: [], mock: false,
    llm: wrapLlm(llm, session),
    progress: (message) => { job.message = message; },
    log: logger,
  };

  const { sequentialAnalyze } = await import('./core/sequential.mjs');

  try {
    const result = await sequentialAnalyze(ctx, scenes, {
      repair: mode === 'repair',
      force: mode === 'fresh',
      stageOf: (scene) => scene.场景阶段 || '未分阶段',
      // 暂停标记一出现，这场跑完就停。
      shouldStop: () => job.stopRequested || isPaused(dirs),
      onFailure: async ({ scene, error }) => {
        job.pending = { sceneId: scene.sceneId, error, deadline: Date.now() + 60_000 };
        job.message = `${scene.sceneId} 失败：${error}`;
        const answer = await new Promise((resolve) => {
          job.pendingResolve = resolve;
          // 等用户决定的同时，也在盯暂停：一按暂停就当作「停」，不再干等 60 秒。
          const timer = setInterval(() => {
            if (job.stopRequested || isPaused(dirs)) {
              clearInterval(timer);
              resolve('stop');
            }
          }, 1000);
          setTimeout(() => { clearInterval(timer); resolve('continue'); }, 60_000);
        });
        job.pending = null;
        job.pendingResolve = null;
        return answer;
      },
    });
    job.done = result.done;
    job.failed = result.failed;
    if (result.paused) {
      job.status = 'paused';
      job.message = `已暂停，共完成 ${result.done} 场，可随时继续`;
    } else {
      job.status = 'done';
      job.percent = 100;
      job.message = `完成 ${result.done} 场，失败 ${result.failed.length} 场`;
    }
  } catch (error) {
    job.status = 'error';
    job.error = error.message;
    job.message = error.message;
  } finally {
    job.finishedAt = Date.now();
    running = null;
    // 暂停收尾：确认任务停下来后强制释放显存，释放不掉就结束 runner 进程。
    if (job.status === 'paused' || isPaused(dirs)) {
      const config = readSettings(root);
      const released = await forceUnloadModel({ baseUrl: config.baseUrl, model: config.model });
      job.message = released.ok
        ? `已暂停，显存已释放（${released.mode}）`
        : `已暂停，显存没释放干净，可手动执行：ollama stop ${config.model || ''}`;
    }
  }
}

async function startJob({ root, bookId, book, mock, limitScenes, model, hybrid, stepModels }) {
  const dirs = layout(path.join(root, bookId));
  const config = resolveLlmConfig(root, mock);
  if (model) config.model = model;
  // 不勾混合模式时，绝不使用配置里残留的云端默认值。
  if (!hybrid && !model) config.model = 'qwen3.5:9b-uncensored-q8_0_64K';
  if (hybrid && stepModels && typeof stepModels === 'object') {
    // 导入时现场改的分步配置优先于设置里的默认值。
    config.stepModels = stepModels;
  }
  // 不勾混合模式：全程只用选中的那个模型，忽略设置里的分步配置。
  if (!hybrid) delete config.stepModels;
  writeMeta(dirs.root, { title: book.title, model: mock ? 'mock' : (config.model || ''), status: 'running' });
  const job = {
    id: `job-${Date.now()}`,
    bookId,
    title: book.title,
    status: 'running',
    step: 'P0',
    message: '准备中',
    percent: 0,
    doneSteps: 0,
    totalSteps: ORDER.length,
    startedAt: Date.now(),
    chapterTotal: book.chapterCount || (book.chapters || []).length || 0,
    finishedAt: null,
    error: null,
    failed: [],
    logs: [],
  };
  jobs.unshift(job);
  if (jobs.length > 20) jobs.pop();
  running = job;

  const logFile = path.join(dirs.logs, `run-${stamp()}.jsonl`);
  const logger = createLogger(logFile);
  const ctx = {
    book,
    dirs,
    force: false,
    failed: [],
    mock,
    // 云端 API 上下文大得多，每块可以塞更多字，调用次数少一个数量级。
    p1Chars: findApiModel(config.model)?.chunkChars || (String(config.model || '').startsWith('api:') ? 12000 : (config.chunkChars || 3500)),
    p2Block: findApiModel(config.model) || String(config.model || '').startsWith('api:') ? 10 : 6,
    log: (event) => {
      logger(event);
      if (event.status === 'failed') job.logs.push(`✗ ${event.step} ${event.target || ''}`);
      else if (event.status === 'invalid') job.logs.push(`… ${event.step} ${event.target || ''} 校验未过，重试`);
      if (job.logs.length > 40) job.logs.shift();
    },
    progress: (message) => { job.message = message; },
    pool: (items, worker) => createPool(config.concurrency || 3, items.map((item) => () => worker(item))),
    onStep: (event) => {
      if (event.status === 'start') {
        job.step = event.step;
        job.message = event.message;
      } else if (event.status === 'done') {
        job.doneSteps = Math.min(job.totalSteps, job.doneSteps + 1);
        job.percent = Math.round((job.doneSteps / job.totalSteps) * 100);
      } else if (event.status === 'error') {
        job.message = `${event.step} 失败`;
      }
    },
  };

  const { llm } = buildLlm(config);
  // 会话日志：请求、响应、报错全记下来，界面实时可见，最后落在本书 logs 目录。
  const session = createSession(dirs.logs, job.id);
  job.sessionId = job.id;
  job.sessionFile = session.file;
  lastSession = session;
  lastSessionFile = session.file;
  lastSessionJobId = job.id;
  ctx.llm = wrapLlm(llm, session);
  ctx.session = session;
  job.model = llm.model;
  job.modelLabel = modelLabel(config.model || llm.model);
  job.configSource = config.source || '';

  try {
    await runPipeline(ctx, { limitScenes });
    job.status = 'done';
    job.percent = 100;
    job.message = '完成';
    job.failed = ctx.failed.slice(0, 50);
  } catch (error) {
    job.status = 'error';
    job.error = error.message;
    job.message = error.message;
    job.failed = ctx.failed.slice(0, 50);
  } finally {
    job.finishedAt = Date.now();
    running = null;
    writeMeta(dirs.root, { status: job.status, model: job.model || '' });
  }
  return job;
}

export /** 列出本机 Ollama 里的模型，供导入时选择。 */
async function listOllamaModels() {
  const base = (process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/api/tags`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const models = (data.models || []).map((model) => ({
      name: model.name,
      size: model.size,
      parameters: model.details?.parameter_size || '',
      quant: model.details?.quantization_level || '',
    })).sort((a, b) => (b.size || 0) - (a.size || 0));
    return { ok: true, models, base };
  } catch (error) {
    return { ok: false, models: [], base, error: error.message };
  }
}

/** 列出可选模型：Qwen3.8 走 Strata（逐个探活），Qwen3.5 从 Ollama 拉。 */
async function listModels(root) {
  const probes = await Promise.all(STRATA_MODELS.map(async (model) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(`${model.baseUrl}/models`, { signal: controller.signal });
      clearTimeout(timer);
      return { ...model, available: response.ok };
    } catch {
      return { ...model, available: false };
    }
  }));

  const ollama = await listOllamaModels();
  const shorten = (name) => (/^qwen3\.5:(.+)$/i.test(name) ? `Qwen3.5-${name.split(':')[1].replace(/^9b-uncensored$/i, '9B 非审查版').toUpperCase()}` : name);
  const ollamaModels = (ollama.models || []).map((item) => ({
    id: item.name,
    label: `${item.name}${item.parameters ? `　${item.parameters}` : ''}${item.quant ? ` · ${item.quant}` : ''} · Ollama`,
    short: `${shorten(item.name)}${item.quant ? ` ${item.quant}` : ''}`,
    group: 'Ollama',
    provider: 'ollama',
    quant: item.quant || '',
    available: true,
  }));

  // 已经登记过的 Ollama 型号不重复出现，但保留不在本机上的兜底项。
  const seen = new Set(ollamaModels.map((item) => item.id));
  const fallbacks = OLLAMA_FALLBACKS.filter((item) => !seen.has(item.id)).map((item) => ({ ...item, group: 'Ollama', provider: 'ollama', available: false }));

  // 云端 API：配了 key 就把对方 /v1/models 里真实可用的型号列出来，而不是写死两项。
  const apiKey = resolveApiKey(root);
  let apiModels = [];
  let apiError = '';
  if (apiKey) {
    try {
      const baseUrl = (readJson(settingsFile(), null)?.apiBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const answer = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
      clearTimeout(timer);
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      const data = await answer.json();
      const ids = (data?.data || []).map((item) => item.id).filter(Boolean);
      if (!ids.length) throw new Error('接口没有返回模型');
      apiModels = ids.map((name) => ({
        id: `api:${name}`,
        label: `${name} · API`,
        short: name,
        group: 'API',
        provider: 'api',
        available: true,
      }));
    } catch (error) {
      apiError = error.message === 'HTTP 401' ? 'API Key 无效或已过期（401）' : `读取云端模型失败：${error.message}`;
      apiModels = API_MODELS.map((model) => ({ id: model.id, label: model.label, short: model.short, group: 'API', provider: 'api', available: false }));
    }
  } else {
    apiModels = API_MODELS.map((model) => ({ id: model.id, label: model.label, short: model.short, group: 'API', provider: 'api', available: false }));
  }

  return {
    models: [
      ...probes.map((item) => ({ ...item, group: 'Strata' })),
      ...apiModels,
      ...ollamaModels,
      ...fallbacks,
    ],
    apiError,
  };
}

export /** 读写入 config.json（设置界面用）。key 只回传掩码，不返回明文。 */
function settingsFile() {
  return path.join(here, 'config.json');
}

function looksLikeKey(key) {
  const value = String(key || '').trim();
  return value.length >= 16 && !/[\u4e00-\u9fa5\s]/.test(value);
}

function readSettings(root) {
  const file = settingsFile();
  const config = readJson(file, null) || {};
  const key = process.env.DEEPSEEK_API_KEY || config.apiKey || '';
  const valid = looksLikeKey(key);
  return {
    file,
    provider: config.provider || 'api',
    baseUrl: config.apiBaseUrl || 'https://api.deepseek.com/v1',
    model: config.model || 'api:deepseek-chat',
    concurrency: Number(config.concurrency) || 3,
    stepModels: config.stepModels && typeof config.stepModels === 'object' ? config.stepModels : {},
    hasKey: valid,
    keyHint: valid ? `${key.slice(0, 3)}…${key.slice(-4)}` : '',
    source: process.env.DEEPSEEK_API_KEY ? '环境变量' : (fs.existsSync(file) ? file : '未配置'),
  };
}

function writeSettings(root, patch) {
  const file = settingsFile();
  const current = readJson(file, null) || {};
  const next = { ...current };
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    if (!looksLikeKey(patch.apiKey)) throw new Error('这个 key 看起来不对（长度不足或含中文/空格）');
    next.apiKey = patch.apiKey.trim();
  }
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim();
  if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
  if (patch.concurrency !== undefined) next.concurrency = Math.max(1, Math.min(8, Number(patch.concurrency) || 3));
  if (patch.stepModels && typeof patch.stepModels === 'object') {
    const clean = {};
    for (const [step, model] of Object.entries(patch.stepModels)) {
      if (typeof model === 'string' && model.trim()) clean[step] = model.trim();
    }
    next.stepModels = clean;
  }
  next.provider = next.baseUrl?.includes('ollama') || next.model?.startsWith('qwen3.5') ? 'ollama' : 'api';
  writeJsonAtomic(file, next, 2);
  return readSettings(root);
}

export function startApp({ root, port = 4173, host = '127.0.0.1', mock = false } = {}) {
  ensureDir(root);
  const storage = storageMode();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);

    try {
      if (url.pathname === '/api/settings/test' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const baseUrl = String(body.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
        const apiKey = String(body.apiKey || '') || resolveApiKey(root);
        if (!apiKey) { sendJson(response, { ok: false, error: '还没填 API Key' }, 400); return; }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const answer = await fetch(`${baseUrl}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!answer.ok) { sendJson(response, { ok: false, error: `HTTP ${answer.status}` }, 400); return; }
          const data = await answer.json();
          const models = (data.data || []).map((item) => item.id).filter(Boolean).sort();
          sendJson(response, { currentScene, ok: true, models, baseUrl });
        } catch (error) {
          sendJson(response, { ok: false, error: error.message }, 400);
        }
        return;
      }

      if (url.pathname === '/api/session') {
        const after = Number(url.searchParams.get('after') || 0);
        const session = running?.session || lastSession;
        if (!session) { sendJson(response, { running: false, messages: [], file: '' }); return; }
        sendJson(response, {
          running: Boolean(running),
          jobId: running?.id || lastSessionJobId,
          file: running?.sessionFile || lastSessionFile,
          total: session.count(),
          messages: session.since(after),
        });
        return;
      }

      if (url.pathname === '/api/settings' && request.method === 'GET') {
        sendJson(response, readSettings(root));
        return;
      }

      if (url.pathname === '/api/settings' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        try { sendJson(response, writeSettings(root, body)); }
        catch (error) { sendJson(response, { error: error.message }, 400); }
        return;
      }

      if (url.pathname === '/api/models') {
        const listed = await listModels(root);
        sendJson(response, { models: listed.models, apiError: listed.apiError, current: resolveLlmConfig(root, false).model || '', ollama: await listOllamaModels() });
        return;
      }

      if (url.pathname === '/api/export') {
        const id = url.searchParams.get('work') || '';
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const book = readJson(dirs.book, null);
        if (!book) { sendJson(response, { error: '找不到这本书' }, 404); return; }

        // 导出成文件夹：project.json + logs/，再压成 zip 供下载。
        const { path: folder } = exportProject(dirs, book);
        const zip = `${folder}.zip`;
        try {
          fs.rmSync(zip, { force: true });
          await new Promise((resolve, reject) => {
            execFile('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${folder}\\*" -DestinationPath "${zip}" -Force`], (error) => (error ? reject(error) : resolve()));
          });
          const data = fs.readFileSync(zip);
          const name = encodeURIComponent(`${book.title}.project.zip`);
          response.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
            'Content-Length': data.length,
          });
          response.end(data);
        } catch (error) {
          sendJson(response, { error: `打包失败：${error.message}` }, 500);
        }
        return;
      }

      if (url.pathname === '/api/check') {
        const id = url.searchParams.get('work') || '';
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const book = readJson(dirs.book, null);
        if (!book) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        sendJson(response, checkCoverage(book, dirs));
        return;
      }

      if (url.pathname === '/api/pause' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const dirs = layout(path.join(root, String(body.work || '')));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const paused = setPaused(dirs, Boolean(body.paused));
        let unload = null;
        if (paused) {
          // 先把正在跑的任务标记为「该停了」，再让模型退出显存。
          if (running?.kind === 'analyze') running.stopRequested = true;
          const config = readSettings(root);
          unload = await unloadModel({ baseUrl: config.baseUrl, model: config.model });
        }
        sendJson(response, { paused, unload });
        return;
      }



      if (url.pathname === '/api/gateway/models' && request.method === 'GET') {
        const base = String(url.searchParams.get('base') || 'http://127.0.0.1:8090/v1');
        // 只认 LocalAI 网关；网关不可用就明确报错，不回退 Ollama
        try {
          const res = await fetch(`${base}/models`, { headers: { Authorization: 'Bearer local' } });
          const text = await res.text();
          if (!res.ok) {
            let message = `网关返回 ${res.status}`;
            try {
              const parsed = JSON.parse(text);
              if (parsed?.error?.type === 'manual_mode') message = 'LocalAI 处于手动模式（暂停），请在窗口左上角切到服务器模式后刷新';
              else if (parsed?.error?.message) message = parsed.error.message;
            } catch { /* 保留状态码提示 */ }
            sendJson(response, { base, models: [], source: 'gateway', error: message }, 200);
            return;
          }
          const data = JSON.parse(text);
          const models = (data.data || data.models || []).map((item) => item.id || item.name).filter(Boolean);
          sendJson(response, { base, models, source: 'gateway' });
        } catch (error) {
          sendJson(response, { base, models: [], source: 'gateway', error: `连不上 LocalAI 网关：${error.message}` }, 200);
        }
        return;
      }

      if (url.pathname === '/api/pipeline' && request.method === 'GET') {
        const bookId = String(url.searchParams.get('book') || '');
        const dirs = layout(path.join(root, bookId));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const status = pipelineStatus(dirs.root);
        // 状态文件里的 running 可能是上次进程残留：没有活进程就按实际完成度改正
        for (const step of status.steps) {
          if (step.status !== 'running') continue;
          if (pipelineJobs.has(`${bookId}:${step.id}`)) continue;
          step.status = step.complete ? 'done' : 'partial';
          step.stale = true;
        }
        status.paused = fs.existsSync(path.join(dirs.root, '.paused'));
        // 网关是否正在生成：单次调用可能几分钟不落盘，靠这个判断"真的在跑"
        try {
          // /v1/models 在生成时仍返回 200，只有真正发一次推理请求才会被 429 拒绝
          const probe = await fetch('http://127.0.0.1:8090/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
            body: JSON.stringify({ model: process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K', messages: [{ role: 'user', content: '1' }], max_tokens: 1, reasoning_effort: 'none' }),
            signal: AbortSignal.timeout(4000),
          });
          status.gatewayStatus = probe.status;
          status.modelBusy = probe.status === 429;
        } catch { status.gatewayStatus = 0; status.modelBusy = false; }
        // 命令行跑的建库（build-all / cli.mjs）不在 pipelineJobs 里，用日志活跃度判断是否在跑
        try {
          let newest = 0;
          const touch = (dirPath) => {
            try {
              for (const name of fs.readdirSync(dirPath)) {
                const full = path.join(dirPath, name);
                let stat;
                try { stat = fs.statSync(full); } catch { continue; }
                if (stat.isDirectory()) { touch(full); continue; }
                newest = Math.max(newest, stat.mtimeMs);
              }
            } catch { /* 目录不存在就算了 */ }
          };
          // 日志、抽取产物、分析产物，任何一个在动都算在跑
          touch(path.join(dirs.root, 'logs'));
          touch(path.join(dirs.root, 'l2', 'facts'));
          touch(path.join(dirs.root, 'l2', 'analysis'));
          touch(path.join(dirs.root, 'l2', 'facts-erotic'));
          status.externalRunning = newest > 0 && Date.now() - newest < 180000;
          status.lastActivity = newest ? new Date(newest).toISOString() : null;
          // 用"哪个目录刚被写过"推断命令行正在跑哪一步
          const WATCH = [
            { dir: 'l2/analysis', step: 'P4 场景分析' },
            { dir: 'l2/facts', step: '人物事实' },
            { dir: 'l2/facts-erotic', step: '色情细节' },
            { dir: 'l2/facts-dialogue', step: '台词归属' },
            { dir: 'l2/facts-appearance', step: '外貌抽取' },
            { dir: 'l2/facts-outfit', step: '衣着抽取' },
            { dir: 'l4', step: 'P7 句子层' },
            { dir: 'l2/cards', step: '人物卡' },
            { dir: 'l1', step: 'P1 段落索引' },
          ];
          let current = null;
          let currentAt = 0;
          for (const item of WATCH) {
            const target = path.join(dirs.root, item.dir);
            try {
              for (const name of fs.readdirSync(target)) {
                const stat = fs.statSync(path.join(target, name));
                if (stat.mtimeMs > currentAt) { currentAt = stat.mtimeMs; current = item.step; }
              }
            } catch { /* 目录不存在 */ }
          }
          status.externalStep = current && Date.now() - currentAt < 180000 ? current : null;
          // 当前目录里的文件数：数字涨了就是真在推进
          try {
            const activeDir = (WATCH.find((item) => item.step === current) || {}).dir;
            status.externalCount = activeDir ? fs.readdirSync(path.join(dirs.root, activeDir)).length : null;
            status.externalCountTotal = scenesDoc?.scenes?.length ?? null;
          } catch { status.externalCount = null; }
        } catch { status.externalRunning = false; }
        sendJson(response, status);
        return;
      }

      // 小说清洗：拉起 novel-clean 自己的服务，前端用 iframe 嵌它的界面
      if (url.pathname === '/api/clean/ensure' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const cleanDir = 'C:\\Users\\win\\Documents\\deepseek-harness\\default-workspace\\novel-clean';
        const cleanUrl = 'http://127.0.0.1:4180';
        const wanted = String(body.model || '').trim() || resolveLlmConfig(root, false).model;
        const alive = async () => {
          try {
            const probe = await fetch(cleanUrl, { signal: AbortSignal.timeout(1500) });
            return probe.ok;
          } catch { return false; }
        };

        // 模型变了：先关掉旧服务
        if (wanted && cleanModel && wanted !== cleanModel && cleanProcess) {
          try { cleanProcess.kill(); } catch { /* 忽略 */ }
          cleanProcess = null;
          cleanModel = '';
          await new Promise((resolve) => setTimeout(resolve, 800));
        }

        if (await alive()) {
          // 服务在跑，但模型和界面选的不一致 → 重启成新模型
          let current = '';
          try {
            const health = await fetch(cleanUrl + '/api/health', { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
            current = String(health.model || '');
          } catch { /* 读不到就按已运行处理 */ }
          if (wanted && current && current !== wanted) {
            try { cleanProcess?.kill(); } catch { /* 忽略 */ }
            try {
              const { execSync } = await import('node:child_process');
              execSync('powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 4180 -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"', { stdio: 'ignore', timeout: 15000 });
            } catch { /* 忽略 */ }
            cleanProcess = null;
            cleanModel = '';
            await new Promise((resolve) => setTimeout(resolve, 1500));
          } else {
            cleanModel = current || cleanModel;
            sendJson(response, { ok: true, url: cleanUrl, started: false, model: cleanModel || null });
            return;
          }
        }
        try {
          const { spawn } = await import('node:child_process');
          const env = { ...process.env, PORT: '4180' };
          if (wanted) { env.MODEL_GATEWAY_MODEL = wanted; env.OLLAMA_MODEL = wanted; }
          cleanProcess = spawn(process.execPath, ['server.mjs'], {
            cwd: cleanDir, env, detached: false, stdio: 'ignore',
          });
          cleanProcess.on('exit', () => { cleanProcess = null; cleanModel = ''; });
          cleanModel = wanted;
        } catch (error) {
          sendJson(response, { ok: false, error: '启动失败：' + error.message }, 500);
          return;
        }
        for (let i = 0; i < 40; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (await alive()) { sendJson(response, { ok: true, url: cleanUrl, started: true, model: cleanModel }); return; }
        }
        sendJson(response, { ok: false, error: '清洗服务启动超时（20 秒）' }, 500);
        return;
      }

      // 强制重启清洗服务：清空卡住的队列
      if (url.pathname === '/api/clean/restart' && request.method === 'POST') {
        const cleanDir = 'C:\\Users\\win\\Documents\\deepseek-harness\\default-workspace\\novel-clean';
        const cleanUrl = 'http://127.0.0.1:4180';
        const { execSync, spawn } = await import('node:child_process');
        try {
          execSync('powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 4180 -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"', { stdio: 'ignore', timeout: 15000 });
        } catch { /* 没在跑 */ }
        try { cleanProcess?.kill(); } catch { /* 忽略 */ }
        cleanProcess = null;
        cleanModel = '';
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const body = JSON.parse(await readBody(request).catch(() => '{}'));
        const wanted = String(body.model || '').trim() || resolveLlmConfig(root, false).model;
        const env = { ...process.env, PORT: '4180' };
        if (wanted) { env.MODEL_GATEWAY_MODEL = wanted; env.OLLAMA_MODEL = wanted; }
        cleanProcess = spawn(process.execPath, ['server.mjs'], { cwd: cleanDir, env, detached: false, stdio: 'ignore' });
        cleanProcess.on('exit', () => { cleanProcess = null; cleanModel = ''; });
        cleanModel = wanted;
        const alive = async () => {
          try { return (await fetch(cleanUrl, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
        };
        for (let i = 0; i < 40; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (await alive()) { sendJson(response, { ok: true, url: cleanUrl, model: cleanModel }); return; }
        }
        sendJson(response, { ok: false, error: '重启超时' }, 500);
        return;
      }

      // 第 1 步：生成角色真名表
      if (url.pathname === '/api/characters/table' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const started = await startCharJob(id, 'table', 'tools/build-character-table.mjs');
        sendJson(response, started);
        return;
      }

      // 第 2 步：生成场景内人称（纯扫描）
      if (url.pathname === '/api/mentions/table' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(path.join(dirs.l2, 'characters.json'))) { sendJson(response, { error: '先生成角色真名表' }, 400); return; }
        const started = await startCharJob(id, 'mentions', 'tools/build-mention-table.mjs');
        sendJson(response, started);
        return;
      }

      // 第 3 步：生成映射关系
      if (url.pathname === '/api/characters/map' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(path.join(dirs.l2, 'mention-table.json'))) { sendJson(response, { error: '先生成人称编号表' }, 400); return; }
        const started = await startCharJob(id, 'map', 'tools/build-scene-map.mjs');
        sendJson(response, started);
        return;
      }


// 生成角色三步（真名表 / 人称 / 映射）都要长时间跑模型，
// 必须异步执行：同步会阻塞事件循环，工具回调控制台时死锁。
function startCharJob(id, step, script, extraEnv = {}) {
  return new Promise(async (resolve) => {
    const { spawn } = await import('node:child_process');
    const dirs = layout(path.join(root, id));
    try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
    if (globalThis.__charJob && globalThis.__charJob.running) {
      resolve({ ok: false, error: '已有生成角色任务在跑' });
      return;
    }
    const job = { running: true, step, bookId: id, startedAt: new Date().toISOString(), code: null };
    globalThis.__charJob = job;
    const child = spawn(process.execPath, [script, path.join(root, id)], {
      cwd: process.cwd(), stdio: 'ignore',
      env: { ...process.env, CORPUS_MODEL: resolveLlmConfig(root, false).model, ...extraEnv },
    });
    child.on('exit', (code) => { job.running = false; job.code = code; });
    resolve({ ok: true, started: true, step });
  });
}

      // 生成角色：进度（供标签页与工作流轮询）
      if (url.pathname === '/api/characters/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } };
        const chars = readJ(path.join(dirs.l2, 'characters.json'));
        const mentions = readJ(path.join(dirs.l2, 'mention-table.json'));
        const map = readJ(path.join(dirs.l2, 'scene-map.json'));
        let mapped = 0;
        for (const arr of Object.values(map?.scenes || {})) for (const m of arr) if (m && m.characterId) mapped += 1;
        const job = globalThis.__charJob && globalThis.__charJob.bookId === id ? globalThis.__charJob : null;
        sendJson(response, {
          running: Boolean(job && job.running),
          step: job?.step || '',
          code: job?.code ?? null,
          totals: {
            characters: (chars?.characters || []).length,
            mentions: (mentions?.mentions || []).length,
            mapped,
          },
        });
        return;
      }

      // 场景详述右侧：角色真名表 + 关系（人物关系唯一 / 参考关系多条）
      if (url.pathname === '/api/detail-characters' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } };
        const charDoc = readJ(path.join(dirs.l2, 'characters.json')) || { characters: [] };
        const relDoc = readJ(path.join(dirs.l2, 'relations.json')) || { relations: [] };

        const { isRoleOnly } = await import('./core/knowledge.mjs');
        sendJson(response, {
          characters: (charDoc.characters || []).filter((c) => !isRoleOnly(c.name)).map((c) => ({
            id: c.id, name: c.name, aliases: c.aliases || [], scenes: c.scenes || [],
            socialRole: c.socialRole || '', gender: c.gender || '', ages: c.ages || [], socialEvidence: c.socialEvidence || [],
          })),
          relations: (relDoc.relations || []).filter((r) => !isRoleOnly(r.a) && !isRoleOnly(r.b)).map((r) => ({
            a: r.a, b: r.b, aRole: r.aRole || '', bRole: r.bRole || '',
            kind: r.kind || 'identity', scenes: r.scenes || [], evidence: r.evidence || [],
          })),
        });
        return;
      }

      // 5.1 角色纠错：按章用高阶模型复核
      if (url.pathname === '/api/correct/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const from = String(body.from || '');
        const to = String(body.to || '');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__correctJob?.running) { sendJson(response, { error: '已有纠错任务在跑' }, 409); return; }
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const args = ['tools/correct-roles-per-chapter.mjs', path.join(root, id)];
        if (from) args.push(from);
        if (to || from) args.push(to || from);
        const job = { running: true, from, to, startedAt: new Date().toISOString() };
        globalThis.__correctJob = job;
        const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env } });
        child.on('error', (error) => { job.running = false; job.error = '启动失败：' + error.message; });
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true, from, to });
        return;
      }

      if (url.pathname === '/api/correct/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const progress = readJ(path.join(dirs.l2, 'correct-progress.json'), { done: [] });
        const book = readJ(dirs.book, { chapters: [] });
        sendJson(response, {
          done: (progress.done || []).length,
          total: (book.chapters || []).length,
          chapters: progress.done || [],
          running: Boolean(globalThis.__correctJob && globalThis.__correctJob.running),
        });
        return;
      }

      if (url.pathname === '/api/correct/report' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const report = readJ(path.join(dirs.l2, 'correct-report.json'), { chapters: {} });
        const chars = readJ(path.join(dirs.l2, 'characters.json'), { characters: [] });
        const rels = readJ(path.join(dirs.l2, 'relations.json'), { relations: [] });
        sendJson(response, { chapters: report.chapters || {}, characters: chars.characters || [], relations: rels.relations || [] });
        return;
      }

      // 5.2 人称关联：编号 + 映射查询
      if (url.pathname === '/api/link/scene' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const sceneId = String(url.searchParams.get('sceneId') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const chars = readJ(path.join(dirs.l2, 'characters.json'), { characters: [] }).characters || [];
        const scenes = readJ(path.join(dirs.l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
        const mentions = readJ(path.join(dirs.l2, 'mention-table.json'), { mentions: [] }).mentions || [];
        const map = readJ(path.join(dirs.l2, 'scene-map.json'), { scenes: {} });
        const scene = scenes.find((s) => s.sceneId === sceneId) || null;
        if (!scene) { sendJson(response, { error: '场景不存在' }, 404); return; }
        const from = Number(String(scene.from).slice(1));
        const to = Number(String(scene.to).slice(1));
        const mapped = new Map();
        for (const m of map.scenes?.[sceneId] || []) mapped.set(m.id || m.mentionId, m.characterId || '');
        const charById = new Map(chars.map((c) => [c.id, c.name]));
        const rows = mentions
          .filter((m) => Number(m.sentence) >= from && Number(m.sentence) <= to)
          .map((m) => ({
            id: m.id, sentence: m.sentence, text: m.surface || m.text || '', cls: m.cls, inDialog: m.inDialog,
            characterId: mapped.get(m.id) || '', characterName: charById.get(mapped.get(m.id) || '') || '',
          }));
        const totals = {
          mentions: rows.length,
          mapped: rows.filter((r) => r.characterId).length,
          chars: chars.length,
          scenes: scenes.length,
          mappedAll: Object.values(map.scenes || {}).reduce((n, arr) => n + arr.filter((x) => x.characterId).length, 0),
          mentionsAll: mentions.length,
        };
        sendJson(response, { scene: { sceneId, from: scene.from, to: scene.to, sentences: scene.sentences }, rows, totals });
        return;
      }

      if (url.pathname === '/api/link/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const step = String(body.step || 'all');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__linkJob?.running) { sendJson(response, { error: '已有任务在跑' }, 409); return; }
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const job = { running: true, step, startedAt: new Date().toISOString() };
        globalThis.__linkJob = job;
        const tool = step === 'number' ? 'tools/build-mention-table.mjs' : 'tools/build-scene-map.mjs';
        const child = spawn(process.execPath, [tool, path.join(root, id)], {
          cwd: process.cwd(), stdio: 'ignore',
          env: { ...process.env, CORPUS_MODEL: (body.model ? String(body.model) : resolveTabModel('link', resolveLlmConfig(root, false).model)), ...(String(body.mode || 'resume') === 'fresh' ? { LINK_FRESH: '1' } : {}), ...(String(body.mode || '') === 'fill' ? { LINK_FILL: '1' } : {}) },
          stdio: (() => { try { const fd = fs.openSync(path.join(dirs.l2, 'link-job.log'), 'a'); return ['ignore', fd, fd]; } catch { return 'ignore'; } })(),
        });
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true, step });
        return;
      }

      if (url.pathname === '/api/link/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const mentions = readJ(path.join(dirs.l2, 'mention-table.json'), { mentions: [] }).mentions || [];
        const map = readJ(path.join(dirs.l2, 'scene-map.json'), { scenes: {} });
        const mapped = Object.values(map.scenes || {}).reduce((n, arr) => n + arr.filter((x) => x.characterId).length, 0);
        sendJson(response, {
          mentions: mentions.length, mapped,
          running: Boolean(globalThis.__linkJob && globalThis.__linkJob.running),
        });
        return;
      }

      // 5.3 关系重构：按章复核人称→角色映射
      if (url.pathname === '/api/relink/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const from = String(body.from || '');
        const to = String(body.to || '');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__relinkJob?.running) { sendJson(response, { error: '已有任务在跑' }, 409); return; }
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const args = ['tools/relink-mentions-per-chapter.mjs', path.join(root, id)];
        if (from) args.push(from);
        if (to || from) args.push(to || from);
        const job = { running: true, from, to, startedAt: new Date().toISOString() };
        globalThis.__relinkJob = job;
        const child = spawn(process.execPath, args, {
          cwd: process.cwd(),
          env: { ...process.env },
          stdio: (() => { try { const fd = fs.openSync(path.join(dirs.l2, 'relink-job.log'), 'a'); return ['ignore', fd, fd]; } catch { return 'ignore'; } })(),
        });
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true, from, to });
        return;
      }

      if (url.pathname === '/api/relink/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const progress = readJ(path.join(dirs.l2, 'link-correct-progress.json'), { done: [] });
        const book = readJ(dirs.book, { chapters: [] });
        sendJson(response, {
          done: (progress.done || []).length,
          total: (book.chapters || []).length,
          running: Boolean(globalThis.__relinkJob && globalThis.__relinkJob.running),
        });
        return;
      }

      if (url.pathname === '/api/relink/report' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const report = readJ(path.join(dirs.l2, 'link-correct-report.json'), { chapters: {} });
        sendJson(response, { chapters: report.chapters || {} });
        return;
      }

      // 章节原文 + 人称编号（5.3 上层面板用）
      if (url.pathname === '/api/chapter/text' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const chapterId = String(url.searchParams.get('chapterId') || '');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const book = JSON.parse(fs.readFileSync(dirs.book, 'utf8'));
        const chapter = (book.chapters || []).find((c) => c.id === chapterId);
        if (!chapter) { sendJson(response, { error: '找不到这一章' }, 404); return; }
        const lines = [];
        for (const p of chapter.paragraphs || []) for (const s of p.sentences || []) {
          lines.push({ n: Number(String(s.sid || s.id || '').replace(/^.*S/, '')), text: String(s.text || '') });
        }
        const chars = readJ(path.join(dirs.l2, 'characters.json'), { characters: [] }).characters || [];
        const nameById = new Map(chars.map((c) => [c.id, c.name]));
        const mentions = (readJ(path.join(dirs.l2, 'mention-table.json'), { mentions: [] }).mentions || [])
          .filter((m) => m.chapterId === chapterId)
          .map((m) => ({
            id: m.id, sentence: m.sentence, start: m.start, end: m.end,
            surface: m.surface, sceneId: m.sceneId || '',
            characterName: nameById.get(m.characterId) || '',
          }));
        sendJson(response, { chapterId, title: chapter.title || '', lines, mentions });
        return;
      }

      // 手工修改单条人称映射（同时更新 mention-table 与 scene-map）
      if (url.pathname === '/api/link/set' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const mentionId = String(body.mentionId || '');
        const characterId = String(body.characterId || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const saveJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');
        const mFile = path.join(dirs.l2, 'mention-table.json');
        const sFile = path.join(dirs.l2, 'scene-map.json');
        if (!fs.existsSync(mFile)) { sendJson(response, { error: '没有人称表' }, 404); return; }
        const mDoc = readJ(mFile, { mentions: [] });
        const hit = (mDoc.mentions || []).find((x) => x.id === mentionId);
        if (!hit) { sendJson(response, { error: '找不到这个人称' }, 404); return; }
        const before = hit.characterId || '';
        hit.characterId = characterId;
        hit.manual = true;
        hit.updatedAt = new Date().toISOString();
        saveJ(mFile, mDoc);

        const sDoc = readJ(sFile, { scenes: {} });
        const arr = sDoc.scenes?.[hit.sceneId] || [];
        const row = arr.find((x) => (x.id || x.mentionId) === mentionId);
        if (row) row.characterId = characterId;
        saveJ(sFile, sDoc);

        sendJson(response, { ok: true, mentionId, before, after: characterId, sceneId: hit.sceneId || '' });
        return;
      }

      // 6.1 角色人物卡
      if (url.pathname === '/api/cards/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const from = String(body.from || '');
        const to = String(body.to || '');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__cardsJob?.running) { sendJson(response, { error: '已有任务在跑' }, 409); return; }
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const args = ['tools/build-character-cards.mjs', path.join(root, id)];
        if (from) args.push(from);
        if (to || from) args.push(to || from);
        const job = { running: true, startedAt: new Date().toISOString() };
        globalThis.__cardsJob = job;
        const child = spawn(process.execPath, args, {
          cwd: process.cwd(),
          env: { ...process.env, CARDS_MODEL: (body.model ? String(body.model) : resolveTabModel('cardboard', resolveLlmConfig(root, false).model)), CARDS_REASONING: 'none' },
          stdio: (() => { try { const fd = fs.openSync(path.join(dirs.l2, 'cards-job.log'), 'a'); return ['ignore', fd, fd]; } catch { return 'ignore'; } })(),
        });
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true });
        return;
      }

      if (url.pathname === '/api/cards/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const progress = readJ(path.join(dirs.l2, 'cards-progress.json'), { done: [] });
        const scenes = readJ(path.join(dirs.l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
        sendJson(response, {
          done: (progress.done || []).length,
          total: (scenes || []).length,
          running: Boolean(globalThis.__cardsJob && globalThis.__cardsJob.running),
        });
        return;
      }

      if (url.pathname === '/api/cards/list' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const doc = readJ(path.join(dirs.l2, 'character-cards.json'), { cards: {} });
        const chars = readJ(path.join(dirs.l2, 'characters.json'), { characters: [] }).characters || [];
        sendJson(response, { cards: doc.cards || {}, characters: chars });
        return;
      }

      // 6.2 人物语言：对话编号与说话人映射
      if (url.pathname === '/api/dialog/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const step = String(body.step || 'number');
        const from = String(body.from || '');
        const to = String(body.to || '');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__dialogJob?.running) { sendJson(response, { error: '已有任务在跑' }, 409); return; }
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const args = ['tools/build-dialogue-table.mjs', path.join(root, id), step];
        if (from) args.push(from);
        if (to || from) args.push(to || from);
        const job = { running: true, step, startedAt: new Date().toISOString() };
        globalThis.__dialogJob = job;
        const child = spawn(process.execPath, args, {
          cwd: process.cwd(), env: { ...process.env, DIALOG_MODEL: (body.model ? String(body.model) : resolveTabModel('dialog', resolveLlmConfig(root, false).model)), ...(String(body.mode || '') === 'fill' ? { DIALOG_FILL: '1' } : {}) },
          stdio: (() => { try { const fd = fs.openSync(path.join(dirs.l2, 'dialog-job.log'), 'a'); return ['ignore', fd, fd]; } catch { return 'ignore'; } })(),
        });
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true, step });
        return;
      }

      if (url.pathname === '/api/dialog/list' && request.method === 'GET') {
        const fromScene = String(url.searchParams.get('from') || '');
        const toScene = String(url.searchParams.get('to') || '');
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const doc = readJ(path.join(dirs.l2, 'dialogue-table.json'), { dialog: [] });
        const book = readJ(dirs.book, { chapters: [] });
        const scenes = readJ(path.join(dirs.l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
        const progress = readJ(path.join(dirs.l2, 'dialogue-map-progress.json'), { done: [] });
        const currentScene = progress.current || '';

        // 句子号 → 整句
        const sentenceText = new Map();
        for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const s of p.sentences || []) {
          const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
          if (n) sentenceText.set(n, String(s.text || ''));
        }

        // 场景区间：SCxxx → 句子号范围
        let dialogRanges = null;
        if (fromScene || toScene) {
          const picked = scenes.filter((s) => (!fromScene || s.sceneId >= fromScene) && (!toScene || s.sceneId <= toScene));
          dialogRanges = picked.map((s) => [Number(String(s.from).slice(1)), Number(String(s.to).slice(1))]);
        }
        const inDialogRange = (n) => !dialogRanges || dialogRanges.some(([x, y]) => n >= x && n <= y);
        const rows = (doc.dialog || []).filter((d) => inDialogRange(Number(d.sentence))).map((d) => ({ ...d, 整句: sentenceText.get(Number(d.sentence)) || '' }));
sendJson(response, {
          rows,
          scenes,
          totals: {
            all: rows.length,
            mapped: rows.filter((x) => x.characterId).length,
            byRule: rows.filter((x) => x.来源 === '规则').length,
            byModel: rows.filter((x) => x.来源 === '模型').length,
            mappedScenes: (progress.done || []).length,
            totalScenes: scenes.length,
          },
          running: Boolean(globalThis.__dialogJob && globalThis.__dialogJob.running),
        });
        return;
      }

      // 底部栏：当前标签页的处理方式 / 模型 / 系统提示词
      if (url.pathname === '/api/tab-config' && request.method === 'GET') {
        const view = String(url.searchParams.get('view') || '');
        const { tabConfig } = await import('./core/tab-config.mjs');
        sendJson(response, tabConfig(view));
        return;
      }

      if (url.pathname === '/api/tab-config' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const view = String(body.view || '');
        const { saveOverride, saveModelOverride } = await import('./core/tab-config.mjs');
        const saved = saveOverride(view, body.prompt || '');
        if (body.model !== undefined) saveModelOverride(view, body.model || '');
        sendJson(response, { ok: true, view, prompt: saved });
        return;
      }

      // 6.3 角色外观
      if (url.pathname === '/api/appear/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const step = String(body.step || 'number');
        const from = String(body.from || '');
        const to = String(body.to || '');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__appearJob?.running) { sendJson(response, { error: '已有任务在跑' }, 409); return; }
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const args = ['tools/build-appearance-table.mjs', path.join(root, id), step];
        if (from) args.push(from);
        if (to || from) args.push(to || from);
        const job = { running: true, step, startedAt: new Date().toISOString() };
        globalThis.__appearJob = job;
        const child = spawn(process.execPath, args, {
          cwd: process.cwd(), env: { ...process.env },
          stdio: (() => { try { const fd = fs.openSync(path.join(dirs.l2, 'appear-job.log'), 'a'); return ['ignore', fd, fd]; } catch { return 'ignore'; } })(),
        });
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true, step });
        return;
      }

      if (url.pathname === '/api/appear/list' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const doc = readJ(path.join(dirs.l2, 'appearance-table.json'), { items: [] });
        const book = readJ(dirs.book, { chapters: [] });
        const sentenceText = new Map();
        for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const s of p.sentences || []) {
          const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
          if (n) sentenceText.set(n, String(s.text || ''));
        }
        const items = (doc.items || []).map((it) => ({ ...it, 整句: sentenceText.get(Number(it.sentence)) || '' }));
        sendJson(response, {
          items,
          totals: {
            all: items.length,
            assigned: items.filter((x) => x.角色).length,
            byCls: doc.totals?.byCls || {},
          },
          running: Boolean(globalThis.__appearJob && globalThis.__appearJob.running),
        });
        return;
      }

      // 网关可用模型列表（底部栏切换模型用）
      if (url.pathname === '/api/gateway-models' && request.method === 'GET') {
        try {
          const res = await fetch('http://127.0.0.1:8090/v1/models', { signal: AbortSignal.timeout(6000) });
          const data = await res.json();
          const ids = (data.data || []).map((m) => m.id);
          sendJson(response, { ok: true, models: ids });
        } catch (error) {
          sendJson(response, { ok: false, models: [], error: error.message });
        }
        return;
      }

      // 6.4 角色色情描写
      if (url.pathname === '/api/erotic/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const step = String(body.step || 'extract');
        const from = String(body.from || '');
        const to = String(body.to || '');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__eroticJob?.running) { sendJson(response, { error: '已有任务在跑' }, 409); return; }
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const args = ['tools/build-erotic-table.mjs', path.join(root, id), step];
        if (from) args.push(from);
        if (to || from) args.push(to || from);
        const job = { running: true, step, startedAt: new Date().toISOString() };
        globalThis.__eroticJob = job;
        const child = spawn(process.execPath, args, {
          cwd: process.cwd(), env: { ...process.env },
          stdio: (() => { try { const fd = fs.openSync(path.join(dirs.l2, 'erotic-job.log'), 'a'); return ['ignore', fd, fd]; } catch { return 'ignore'; } })(),
        });
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true, step });
        return;
      }

      if (url.pathname === '/api/erotic/list' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const doc = readJ(path.join(dirs.l2, 'erotic-table.json'), { items: [] });
        const book = readJ(dirs.book, { chapters: [] });
        const sentenceText = new Map();
        for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const s of p.sentences || []) {
          const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
          if (n) sentenceText.set(n, String(s.text || ''));
        }
        const items = (doc.items || []).map((it) => ({ ...it, 整句: sentenceText.get(Number(it.sentence)) || '' }));
        sendJson(response, {
          items,
          totals: { all: items.length, mapped: items.filter((x) => (x.角色 || []).length).length, byType: doc.totals?.byType || {} },
          running: Boolean(globalThis.__eroticJob && globalThis.__eroticJob.running),
        });
        return;
      }

      // 6.2.1 淫言浪语
      if (url.pathname === '/api/dirty/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const step = String(body.step || 'extract');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__dirtyJob?.running) { sendJson(response, { error: '已有任务在跑' }, 409); return; }
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const job = { running: true, step, startedAt: new Date().toISOString() };
        globalThis.__dirtyJob = job;
        const child = spawn(process.execPath, ['tools/build-dirty-talk.mjs', path.join(root, id), step], {
          cwd: process.cwd(), env: { ...process.env },
          stdio: (() => { try { const fd = fs.openSync(path.join(dirs.l2, 'dirty-job.log'), 'a'); return ['ignore', fd, fd]; } catch { return 'ignore'; } })(),
        });
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true, step });
        return;
      }

      if (url.pathname === '/api/dirty/list' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const doc = readJ(path.join(dirs.l2, 'dirty-talk.json'), { items: [] });
        const book = readJ(dirs.book, { chapters: [] });
        const sentenceText = new Map();
        for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const s of p.sentences || []) {
          const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
          if (n) sentenceText.set(n, String(s.text || ''));
        }
        const items = (doc.items || []).map((it) => ({ ...it, 整句: sentenceText.get(Number(it.sentence)) || '' }));
        sendJson(response, { items, totals: doc.totals || { items: items.length }, running: Boolean(globalThis.__dirtyJob && globalThis.__dirtyJob.running) });
        return;
      }

      // 场景切分中间进度（中断时也能看到已切多少章）
      if (url.pathname === '/api/scenes/partial' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const progress = readJ(path.join(dirs.l2, 'scenes.progress.json'), { chapters: [] });
        const book = readJ(dirs.book, { chapters: [] });
        let partialScenes = 0;
        try {
          const pf = path.join(dirs.l2, 'scenes.partial.jsonl');
          if (fs.existsSync(pf)) partialScenes = fs.readFileSync(pf, 'utf8').split('\n').filter((x) => x.trim()).length;
        } catch { /* 忽略 */ }
        const total = (book.chapters || []).length;
        const done = (progress.chapters || []).length;
        sendJson(response, {
          done, total, partialScenes,
          missing: (book.chapters || []).map((c) => c.id).filter((cid) => !(progress.chapters || []).includes(cid)),
          finished: fs.existsSync(path.join(dirs.l2, 'scenes-llm.json')),
        });
        return;
      }

      // 最近一次实际发送给模型的完整提示词
      if (url.pathname === '/api/prompt/last' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const view = String(url.searchParams.get('view') || '');
        const dirs = layout(path.join(root, id));
        const file = path.join(dirs.l2, 'prompts', view + '.last.txt');
        let text = '';
        if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
        sendJson(response, { view, text, exists: Boolean(text) });
        return;
      }

      if (url.pathname === '/api/prompt/list' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        const dir = path.join(dirs.l2, 'prompts');
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.last.txt')); } catch { /* 无 */ }
        sendJson(response, { views: files.map((f) => f.replace('.last.txt', '')) });
        return;
      }

      // 预览完整提示词（不调用模型）
      if (url.pathname === '/api/prompt/preview' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const view = String(body.view || 'scenedetail');
        const scene = String(body.scene || 'SC001');
        const dirs = layout(path.join(root, id));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const { spawnSync } = await import('node:child_process');
        const toolMap = {
          scenedetail: ['tools/gen-scene-details.mjs', [path.join(root, id), scene, scene]],
        };
        const entry = toolMap[view];
        if (!entry) { sendJson(response, { error: '该标签页暂不支持预览' }, 400); return; }
        spawnSync(process.execPath, entry[0] ? [entry[0], ...entry[1]] : [], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
          env: { ...process.env, DRY_PROMPT: '1', FORCE: '1' },
        });
        const file = path.join(dirs.l2, 'prompts', view + '.last.txt');
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        sendJson(response, { view, scene, text, exists: Boolean(text) });
        return;
      }

      // 提示词模板：读取 / 保存
      if (url.pathname === '/api/prompt/template' && request.method === 'GET') {
        const view = String(url.searchParams.get('view') || 'scenedetail');
        const { getTemplate, TEMPLATES } = await import('./core/prompt-templates.mjs');
        sendJson(response, { view, template: getTemplate(view), defaultTemplate: TEMPLATES[view] || '', editable: Boolean(TEMPLATES[view]) });
        return;
      }

      if (url.pathname === '/api/prompt/template' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const view = String(body.view || 'scenedetail');
        const { saveTemplate } = await import('./core/prompt-templates.mjs');
        saveTemplate(view, body.template || '');
        sendJson(response, { ok: true, view });
        return;
      }


      // 6.x 表格版本：内容变化时自动存档旧版本
      const tableNames = ['character-cards.json', 'dialogue-table.json', 'dirty-talk.json', 'appearance-table.json', 'erotic-table.json'];
      const versionedTable = (id, name) => {
        const dirs = layout(path.join(root, id));
        const file = path.join(dirs.l2, name);
        if (!fs.existsSync(file)) return null;
        const vdir = path.join(dirs.l2, 'versions', name);
        const idxFile = path.join(vdir, 'index.json');
        const buf = fs.readFileSync(file);
        const hash = crypto.createHash('sha1').update(buf).digest('hex');
        let idx = { version: 1, hash: '', at: '' };
        try { idx = Object.assign(idx, JSON.parse(fs.readFileSync(idxFile, 'utf8'))); } catch { /* 忽略 */ }
        if (idx.hash !== hash) {
          try {
            fs.mkdirSync(vdir, { recursive: true });
            const prevVersion = Number(idx.version || 1);
            if (idx.hash && fs.existsSync(file)) {
              // 旧内容在上一次已存过（vPrevVersion），此处只推进版本号
            }
            idx = { version: prevVersion + 1, hash, at: new Date().toISOString() };
            fs.writeFileSync(idxFile, JSON.stringify(idx, null, 1), 'utf8');
            fs.writeFileSync(path.join(vdir, 'v' + idx.version + '.json'), buf, 'utf8');
          } catch { /* 忽略 */ }
        }
        return { file, vdir, idx };
      };

      // 人称代词：按句子查询
      if (url.pathname === '/api/mention/sentence' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const s = Number(url.searchParams.get('s') || 0);
        const dirs = layout(path.join(root, id));
        const file = path.join(dirs.l2, 'mention-table.json');
        if (!fs.existsSync(file)) { sendJson(response, { mentions: [], total: 0, missing: true }); return; }
        try {
          const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
          const list = (doc.mentions || []).filter((m) => Number(m.sentence) === s);
          const bookFile = path.join(dirs.root, 'book.json');
          let text = '';
          if (fs.existsSync(bookFile)) {
            const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
            for (const ch of book.chapters || []) for (const p of ch.paragraphs || []) for (const st of p.sentences || []) {
              if (Number(st.sentenceNo || String(st.sid || '').replace(/^S/, '')) === s) text = String(st.text || '');
            }
          }
          sendJson(response, { sentence: s, text, mentions: list, total: doc.total || 0 });
        } catch (error) {
          sendJson(response, { error: error.message }, 500);
        }
        return;
      }

      // Prompt 控制台
      if (url.pathname === '/api/prompts/list' && request.method === 'GET') {
        const { listPrompts } = await import('./core/prompt-templates.mjs');
        sendJson(response, { prompts: listPrompts() });
        return;
      }

      if (url.pathname === '/api/prompts/item' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const { getTemplate, TEMPLATES, PROMPT_META } = await import('./core/prompt-templates.mjs');
        sendJson(response, {
          id,
          text: getTemplate(id),
          defaultText: TEMPLATES[id] || '',
          meta: PROMPT_META[id] || {},
        });
        return;
      }

      if (url.pathname === '/api/prompts/save' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const { saveTemplate } = await import('./core/prompt-templates.mjs');
        saveTemplate(String(body.id || ''), String(body.text || ''));
        sendJson(response, { ok: true });
        return;
      }

      if (url.pathname === '/api/prompts/reset' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const { saveTemplate } = await import('./core/prompt-templates.mjs');
        saveTemplate(String(body.id || ''), '');
        sendJson(response, { ok: true });
        return;
      }

      // 模型调用日志：默认返回最近一轮，可指定 run
      if (url.pathname === '/api/console/conversation' && request.method === 'GET') {
        const run = String(url.searchParams.get('run') || '');
        const source = String(url.searchParams.get('source') || '');
        const file = 'console-log-full.jsonl';
        let all = [];
        try {
          if (fs.existsSync(file)) {
            all = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
              .map((l) => { try { return JSON.parse(l); } catch { return null; } })
              .filter(Boolean);
          }
        } catch { /* 忽略 */ }

        if (source) all = all.filter((x) => String(x.source || '') === source);
        const scene = String(url.searchParams.get('scene') || '');
        const runsOf = (items) => [...new Set(items.map((x) => x.runId).filter(Boolean))];
        const sceneRun = scene ? (runsOf(all).filter((x) => x.startsWith(scene + '-')).slice(-1)[0] || '') : '';
        const targetRun = run || sceneRun || runsOf(all).slice(-1)[0] || '';
        const items = targetRun ? all.filter((x) => x.runId === targetRun) : all.slice(-5);

        // 本轮总耗时：汇总同 runId 的调用耗时
        let totalMs = 0;
        try {
          const perfFile = path.join(root, '..', 'console-log.jsonl');
          if (fs.existsSync(perfFile)) {
            for (const line of fs.readFileSync(perfFile, 'utf8').trim().split('\n')) {
              if (!line) continue;
              let row; try { row = JSON.parse(line); } catch { continue; }
              if (targetRun && row.runId !== targetRun) continue;
              if (!targetRun && !source) continue;
              if (source && row.source !== source) continue;
              totalMs += Number(row.ms || 0);
            }
          }
        } catch { /* 忽略 */ }

        const spanMs = (() => {
          if (totalMs) return 0;
          const times = items.map((x) => Date.parse(x.at || '')).filter(Number.isFinite).sort((a, b) => a - b);
          if (times.length < 2) return 0;
          return times[times.length - 1] - times[0];
        })();

        // 老记录没有缓存字段：用性能日志按结束时间补齐
        const perfByEnd = new Map();
        try {
          const perfFile = path.join(root, '..', 'console-log.jsonl');
          if (fs.existsSync(perfFile)) {
            for (const line of fs.readFileSync(perfFile, 'utf8').trim().split('\n')) {
              if (!line) continue;
              let row; try { row = JSON.parse(line); } catch { continue; }
              if (row.endedAt) perfByEnd.set(String(row.endedAt).slice(0, 19), row);
            }
          }
        } catch { /* 忽略 */ }
        for (const item of items) {
          if (Number(item.cacheN) || Number(item.promptN)) continue;
          const key = String(item.at || '').slice(0, 19);
          const row = perfByEnd.get(key) || perfByEnd.get(key.replace('T', ' '));
          if (row) {
            item.cacheN = Number(row.cacheN || 0);
            item.promptN = Number(row.promptN || 0);
            item.ms = Number(row.ms || 0);
            item.ttftMs = Number(row.ttftMs || 0);
          }
        }

        sendJson(response, {
          run: targetRun,
          totalMs: totalMs || spanMs,
          runs: runsOf(all).slice(-10),
          items,
        });
        return;
      }

      // ===== 控制台：统一模型入口 =====
      if (url.pathname === '/api/console/state' && request.method === 'GET') {
        const cfg = resolveLlmConfig(root, false);
        const running = globalThis.__consoleState?.running ?? null;
        // 实时信息：以最近一次真实调用为准；没有调用过就说未调用
        const logFile = path.join(root, '..', 'console-log.jsonl');
        let last = null;
        try {
          if (fs.existsSync(logFile)) {
            const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).slice(-1);
            last = lines.length ? JSON.parse(lines[0]) : null;
          }
        } catch { /* 忽略 */ }
        const inflight = globalThis.__consoleInflight || [];
        sendJson(response, {
          called: Boolean(last || inflight.length),
          lastModel: last?.model || inflight[0]?.model || '',
          lastMaxTokens: last?.maxTokens || inflight[0]?.maxTokens || 0,
          lastCacheN: last?.cacheN ?? 0,
          lastPromptN: last?.promptN ?? 0,
          lastAt: last?.endedAt || last?.startedAt || '',
          lastSource: last?.source || inflight[0]?.source || '',
          model: cfg.model,
          maxTokens: Number(process.env.CONSOLE_MAX_TOKENS || 32768),
          running: running === null ? null : running,
          inflight: (globalThis.__consoleInflight || []).length,
          enabled: globalThis.__consoleState?.enabled !== false,
        });
        return;
      }

      if (url.pathname === '/api/console/start' && request.method === 'POST') {
        const { spawn } = await import('node:child_process');
        let ok = false;
        try {
          const probe = await fetch('http://127.0.0.1:8090/v1/models', { signal: AbortSignal.timeout(2000) });
          ok = probe.ok;
        } catch { ok = false; }
        if (!ok) {
          try { spawn('J:\\本地模型服务器\\dist\\LocalAI\\LocalAI.exe', [], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 忽略 */ }
          for (let i = 0; i < 40; i += 1) {
            await new Promise((r) => setTimeout(r, 1000));
            try { if ((await fetch('http://127.0.0.1:8090/v1/models', { signal: AbortSignal.timeout(1500) })).ok) { ok = true; break; } } catch { /* 继续等 */ }
          }
        }
        globalThis.__consoleState = { enabled: true, running: ok, startedAt: new Date().toISOString() };
        sendJson(response, { ok, running: ok });
        return;
      }

      if (url.pathname === '/api/console/stop' && request.method === 'POST') {
        globalThis.__consoleState = { enabled: false, stoppedAt: new Date().toISOString() };
        sendJson(response, { ok: true, running: false, enabled: false, note: '控制台已关闭，所有功能将无法调用模型（LocalAI 不受影响）' });
        return;
      }

      if (url.pathname === '/api/console/logs' && request.method === 'GET') {
        const file = path.join(root, '..', 'console-log.jsonl');
        const limit = Number(url.searchParams.get('limit') || 100);
        let rows = [];
        try {
          if (fs.existsSync(file)) {
            const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-limit);
            rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          }
        } catch { /* 忽略 */ }
        sendJson(response, { logs: rows, inflight: globalThis.__consoleInflight || [] });
        return;
      }

      // 统一对话入口：所有服务应调用这里
      if (url.pathname === '/api/console/chat' && request.method === 'POST') {
        if (globalThis.__consoleState?.enabled === false) {
          sendJson(response, { ok: false, error: '模型服务已关闭：请在控制台点「启动模型服务」' }, 503);
          return;
        }
        const body = JSON.parse(await readBody(request));
        const cfg = resolveLlmConfig(root, false);
        const model = String(body.model || cfg.model);
        const maxTokens = Number(body.maxTokens || process.env.CONSOLE_MAX_TOKENS || 32768);
        const prompt = String(body.prompt || '');
        const systemPrompt = String(body.system || '');
        const cachePrompt = Boolean(body.cachePrompt);
        const runId = String(body.runId || '');
        const source = String(body.source || 'unknown');
        const id = 'C' + Date.now().toString(36);
        const entry = { id, runId, source, model, maxTokens, promptHead: prompt.slice(0, 2000), promptLen: prompt.length, startedAt: new Date().toISOString(), status: 'running' };
        globalThis.__consoleInflight = globalThis.__consoleInflight || [];
        globalThis.__consoleInflight.push(entry);
        const logFile = path.join(root, '..', 'console-log.jsonl');
        const writeLog = (row) => {
          try { fs.appendFileSync(logFile, JSON.stringify(row) + '\n', 'utf8'); } catch { /* 忽略 */ }
          try {
            const fullFile = path.join(root, '..', 'console-log-full.jsonl');
            fs.appendFileSync(fullFile, JSON.stringify({
              at: row.endedAt || new Date().toISOString(),
              runId: row.runId || runId,
              cacheN: Number(row.cacheN || 0), promptN: Number(row.promptN || 0), ms: Number(row.ms || 0), ttftMs: Number(row.ttftMs || 0), hitRate: row.hitRate ?? null,
              source: row.source, model: row.model, status: row.status,
              prompt: String(row.prompt || ''), content: String(row.content || ''),
            }) + '\n', 'utf8');
          } catch { /* 忽略 */ }
        };
        try {
          // 模型忙（429/503）时排队重试：LocalAI 并发为 1
          // 直接走 node:http，避免 undici 默认 300 秒超时
        const upstream = () => new Promise((resolve, reject) => {
          const outputLimit = Number(body.maxOutputTokens || process.env.CONSOLE_MAX_OUTPUT || 0);
          const payloadObj = {
            model,
            cache_prompt: cachePrompt,
            messages: systemPrompt
              ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
              : [{ role: 'user', content: prompt }],
            stream: outputLimit > 0,
            ...(outputLimit > 0 ? { stream_options: { include_usage: true } } : {}),
            temperature: Number(body.temperature ?? 0.1),
            reasoning_effort: String(body.reasoningEffort || process.env.REASONING_EFFORT || 'none'),
            ...(body.json === false ? {} : { response_format: { type: 'json_object' } }),
          };
          if (Number(maxTokens) > 0) payloadObj.max_tokens = Number(maxTokens);
          const payload = JSON.stringify(payloadObj);
          const req = http.request({
            host: '127.0.0.1', port: 8090, path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.LOCALAI_API_KEY || 'local'), 'Content-Length': Buffer.byteLength(payload) },
            timeout: 0,
          }, (res) => {
            if (!payloadObj.stream) {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (c) => { text += c; });
              res.on('end', () => {
                let json = {};
                try { json = JSON.parse(text || '{}'); } catch { /* 忽略 */ }
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: json, raw: text });
              });
              return;
            }
            let buffer = '';
            let content = '';
            let usage = null;
            let aborted = false;
            let firstTokenMs = 0;
            const startedAtMs = Date.now();
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              if (aborted) return;
              buffer += chunk;
              const parts = buffer.split('\n');
              buffer = parts.pop() || '';
              for (const line of parts) {
                const s = line.trim();
                if (!s.startsWith('data:')) continue;
                const dataText = s.slice(5).trim();
                if (!dataText || dataText === '[DONE]') continue;
                let evt = null;
                try { evt = JSON.parse(dataText); } catch { continue; }
                const delta = evt.choices?.[0]?.delta?.content || '';
                if (delta) { content += delta; if (!firstTokenMs) firstTokenMs = Date.now() - startedAtMs; }
                if (evt.usage) usage = evt.usage;
                if (content.length > outputLimit * 1.7) {
                  aborted = true;
                  try { req.destroy(); } catch { /* 忽略 */ }
                  try { res.destroy(); } catch { /* 忽略 */ }
                  resolve({ status: 200, ok: false, tooLong: true, firstTokenMs, body: { error: { message: '输出超限（约 ' + Math.round(content.length / 1.7) + ' token）' } }, raw: content });
                  return;
                }
              }
            });
            res.on('end', () => {
              if (aborted) return;
              resolve({ status: 200, ok: true, firstTokenMs, body: { choices: [{ message: { content } }], usage }, raw: content });
            });
            res.on('error', (error) => { if (!aborted) reject(error); });
          });
          req.setTimeout(0);
          req.on('error', (error) => { if (!error || error.code !== 'ECONNRESET') reject(error); });
          req.end(payload);
        });
        const callUpstream = async () => {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const r = await upstream();
            if (r.status !== 429 && r.status !== 503) return r;
            await new Promise((res) => setTimeout(res, 8000));
          }
          throw new Error('模型持续忙（429/503），已重试 40 次');
        };
          const reply = await callUpstream();
          const data = reply.body || {};
          if (!reply.ok) {
            const msg = data?.error?.message || data?.error || ('HTTP ' + reply.status);
            const doneErr = { ...entry, status: 'error', http: reply.status, error: String(msg).slice(0, 200), endedAt: new Date().toISOString() };
            globalThis.__consoleInflight = globalThis.__consoleInflight.filter((x) => x.id !== id);
            writeLog(doneErr);
            sendJson(response, { ok: false, error: String(msg).slice(0, 200), http: reply.status }, 502);
            return;
          }
          const content = String(data.choices?.[0]?.message?.content || '');
          // 同时保留 usage 与 timings，两者都可能缺失或被显式写 0
          const rawUsage = data.usage || null;
          const rawTimings = data.timings || null;
          const usageCached = Number(rawUsage?.prompt_tokens_details?.cached_tokens ?? rawUsage?.prompt_cache_hit_tokens ?? 0) || 0;
          const timingCached = Number(rawTimings?.cache_n ?? 0) || 0;
          const promptTotal = Number(rawUsage?.prompt_tokens ?? 0) || 0;
          // 网关展示层优先 usage，但显式 0 会盖掉 timings，这里取两者较大的可靠值
          let cacheN = Math.max(usageCached, timingCached);
          let promptN = promptTotal > 0 ? Math.max(0, promptTotal - cacheN) : Number(rawTimings?.prompt_n ?? 0);
          let hitRate = (cacheN + promptN) > 0 ? cacheN / (cacheN + promptN) : null;

          // LocalAI 的缓存统计在生成结束后才写入网关看板：请求完成后向 8091 取最近一条
          try {
            const dashUrl = process.env.LOCALAI_DASHBOARD || 'http://127.0.0.1:8091/api/dashboard';
            const dash = await fetch(dashUrl, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
            const actList = Array.isArray(dash.activity) ? dash.activity : ((dash.activity && (dash.activity.requests || dash.activity.events)) || []);
            const acts = actList.filter((a) => a && a.cache && typeof a.cache.hit_rate === 'number');
            acts.sort((a, b) => (b.started_at_ms || 0) - (a.started_at_ms || 0));
            const last = acts[0];
            if (last) {
              const cached = Number(last.cache.cached_tokens || 0);
              const dashTtft = Number(last.first_token_ms || 0);
              if (dashTtft > 0) reply.firstTokenMs = dashTtft;
              const input = Number(last.usage?.input_tokens || last.cache.input_tokens || 0);
              // 看板可能被显式 0 覆盖，只在它更高时采用
              if (input > 0 && cached > cacheN) {
                cacheN = cached;
                promptN = Math.max(0, input - cached);
                hitRate = last.cache.hit_rate;
              }
            }
          } catch { /* 网关看板不可用时退回 timings */ }
          const done = { ...entry, status: 'ok', http: reply.status, chars: content.length, cacheN, promptN, hitRate, ttftMs: Number(reply.firstTokenMs || 0), usageCached, timingCached, promptTotal, rawUsage, rawTimings, contentHead: content.slice(0, 4000), prompt, content, endedAt: new Date().toISOString(), ms: Date.now() - new Date(entry.startedAt).getTime() };
          globalThis.__consoleInflight = globalThis.__consoleInflight.filter((x) => x.id !== id);
          writeLog(done);
          sendJson(response, { ok: true, content, usage: data.usage || null, model, id });
        } catch (error) {
          const done = { ...entry, status: 'error', error: error.message, endedAt: new Date().toISOString() };
          globalThis.__consoleInflight = globalThis.__consoleInflight.filter((x) => x.id !== id);
          writeLog(done);
          sendJson(response, { ok: false, error: error.message }, 502);
        }
        return;
      }

      // 工作流：状态
      if (url.pathname === '/api/workflow' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const readJson = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
        const book = readJson(dirs.book, null);
        const scenes = readJson(path.join(dirs.l2, 'scenes-llm.json'), { scenes: [] }).scenes || [];
        const chars = readJson(path.join(dirs.l2, 'characters.json'), { characters: [] }).characters || [];
        const details = Object.keys(readJson(path.join(dirs.l2, 'scene-details.json'), { details: {} }).details || {});
        const recon = Object.keys(readJson(path.join(dirs.l2, 'reconcile-report.json'), { scenes: {} }).scenes || {});
        const wf = readJson(path.join(dirs.l2, 'workflow.json'), null);
        // 只有进程真的在跑才算运行中；避免文件里的残留标记让步骤一直显示「进行中」
        const wfRunning = Boolean(globalThis.__workflowJob && globalThis.__workflowJob.running);
        // 计算预计剩余时间：用当前步已完成的量 / 已用时间推算
        let etaSeconds = 0;
        if (wf && wf.running && wf.current) {
          const cur = wf.steps?.[String(wf.current)];
          const startedAt = Number(cur?.startedAt || 0);
          const elapsed = startedAt ? Math.max(1, (Date.now() - startedAt) / 1000) : 0;
          const stepNo = Number(wf.current);
          let doneN = 0;
          let totalN = 0;
          if (stepNo === 5) { doneN = details.length; totalN = scenes.length; }
          else if (stepNo === 6) { doneN = recon.length; totalN = scenes.length; }
          else if (stepNo === 3) { doneN = scenes.length; totalN = scenes.length; }
          if (elapsed > 30 && doneN > 0 && totalN > doneN) {
            const rate = doneN / elapsed;            // 每秒完成场数
            etaSeconds = Math.round((totalN - doneN) / Math.max(rate, 1e-6));
          }
        }
        sendJson(response, {
          book: { id, title: book?.title || id, exists: Boolean(book) },
          steps: [
            { no: 1, name: '小说清洗', manual: true, done: Boolean(book), detail: book ? '已入库' : '需上传原稿' },
            { no: 2, name: '内容编号', manual: true, done: Boolean(book), detail: book ? '书库已有编号正文' : '需先完成清洗与编号' },
            (() => {
              const totalCh = (book?.chapters || []).length;
              let doneCh = 0;
              try {
                const pf = path.join(dirs.l2, 'scenes.progress.json');
                if (fs.existsSync(pf)) doneCh = (JSON.parse(fs.readFileSync(pf, 'utf8')).chapters || []).length;
              } catch { /* 忽略 */ }
              const isRunning = Boolean(wfRunning && Number(wf?.current) === 3);
              const percent = isRunning && totalCh ? Math.round((doneCh / totalCh) * 100) : (scenes.length ? 100 : 0);
              return {
                no: 3, name: '场景切分', manual: true,
                done: scenes.length > 0 && !isRunning,
                detail: isRunning && totalCh
                  ? '已切分 ' + doneCh + '/' + totalCh + ' 章'
                  : (scenes.length ? scenes.length + ' 场' : '未开始'),
                percent, doneCount: isRunning ? doneCh : scenes.length, totalCount: isRunning ? totalCh : scenes.length,
              };
            })(),
            (() => {
              // 与「4. 生成角色」标签页同源：人称表 + 场景映射
              const readJ = (f) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } };
              const mentionDoc = readJ(path.join(dirs.l2, 'mention-table.json'));
              const mapDoc = readJ(path.join(dirs.l2, 'scene-map.json'));
              const mentionTotal = (mentionDoc?.mentions || []).length;
              let mappedTotal = 0;
              for (const arr of Object.values(mapDoc?.scenes || {})) for (const m of arr) if (m && m.characterId) mappedTotal += 1;
              const isRunning = Boolean(wfRunning && Number(wf?.current) === 4);
              const pct = mentionTotal ? Math.round((mappedTotal / mentionTotal) * 100) : (chars.length ? 100 : 0);
              return {
                no: 4, name: '生成角色',
                done: chars.length > 0 && mentionTotal > 0 && mappedTotal > 0 && !isRunning,
                detail: (mappedTotal || mentionTotal)
                  ? ('已对应 ' + mappedTotal + '/' + mentionTotal + ' 人称')
                  : (chars.length ? chars.length + ' 角色' : '未开始'),
                percent: pct,
                doneCount: mappedTotal, totalCount: mentionTotal,
              };
            })(),
            { no: 5, name: '场景详述', done: scenes.length > 0 && details.length >= scenes.length, detail: details.length + '/' + scenes.length + ' 场', percent: scenes.length ? Math.round((details.length / scenes.length) * 100) : 0, doneCount: details.length, totalCount: scenes.length },
            { no: 6, name: '角色重构', done: scenes.length > 0 && recon.length >= scenes.length, detail: recon.length + '/' + scenes.length + ' 场', percent: scenes.length ? Math.round((recon.length / scenes.length) * 100) : 0, doneCount: recon.length, totalCount: scenes.length },
          ],
          workflow: wf,
          subs: (() => {
            const subs = wf?.steps?.[String(wf?.current)]?.subs || [];
            const totalCh = (book?.chapters || []).length;
            let doneCh = 0;
            try {
              const pf = path.join(dirs.l2, 'relations.progress.json');
              if (fs.existsSync(pf)) doneCh = (JSON.parse(fs.readFileSync(pf, 'utf8')).chapters || []).length;
            } catch { /* 忽略 */ }
            return subs.map((sub) => {
              if (sub.key === '4.1') return { ...sub, progressText: doneCh + '/' + totalCh + ' 章' };
              if (sub.key === '4.2') return { ...sub, progressText: sub.status === 'done' ? '已完成' : '一次性执行' };
              return sub;
            });
          })(),
          running: wfRunning,
          etaSeconds,
        });
        return;
      }

      // 按步骤清除数据（第 4/5/6 步）
      if (url.pathname === '/api/workflow/clear-step' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const step = Number(body.step || 0);
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__workflowJob?.running || globalThis.__detailJob?.running || globalThis.__reconcileJob?.running) {
          sendJson(response, { error: '还有任务在跑，先停止再清除' }, 409);
          return;
        }
        const map = {
          4: ['characters.json', 'relations.json', 'relations.progress.json', 'relations.partial.jsonl', 'mention-table.json', 'scene-map.json'],
          5: ['scene-details.json', 'scene-details.partial.json', 'scene-details.progress.json', 'failed-output'],
          6: ['reconcile', 'reconcile-report.json', 'relations.json'],
        };
        const targets = map[step];
        if (!targets) { sendJson(response, { error: '只支持第 4、5、6 步' }, 400); return; }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(dirs.l2, 'backup-step' + step + '-' + stamp);
        fs.mkdirSync(backupDir, { recursive: true });
        const removed = [];
        for (const name of targets) {
          const src = path.join(dirs.l2, name);
          if (!fs.existsSync(src)) continue;
          try {
            fs.cpSync(src, path.join(backupDir, name), { recursive: true });
            fs.rmSync(src, { recursive: true, force: true });
            removed.push(name);
          } catch { /* 跳过 */ }
        }
        // 第 5 步同时清库里详述
        if (step === 5) {
          try {
            const { DatabaseSync } = await import('node:sqlite');
            const db = new DatabaseSync(path.join(dirs.root, 'corpus.db'));
            db.exec('DELETE FROM scene_detail');
            db.close();
          } catch { /* 忽略 */ }
        }
        sendJson(response, { ok: true, step, removed, backupDir });
        return;
      }

      // 工作流：定时执行
      if (url.pathname === '/api/workflow/schedule' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const from = Number(body.from || 4);
        const to = Number(body.to || 6);
        const at = String(body.at || '');
        if (!id || !at) { sendJson(response, { error: '缺少书或时间' }, 400); return; }
        const when = new Date(at).getTime();
        if (!Number.isFinite(when)) { sendJson(response, { error: '时间格式不对' }, 400); return; }
        if (when < Date.now() - 60000) { sendJson(response, { error: '时间已过去' }, 400); return; }
        globalThis.__workflowSchedules = globalThis.__workflowSchedules || [];
        globalThis.__workflowSchedules.push({ id, from, to, at: new Date(when).toISOString(), createdAt: new Date().toISOString() });
        sendJson(response, { ok: true, scheduledAt: new Date(when).toISOString(), from, to });
        return;
      }

      // 工作流：定时任务列表
      if (url.pathname === '/api/workflow/schedules' && request.method === 'GET') {
        sendJson(response, { schedules: globalThis.__workflowSchedules || [] });
        return;
      }
      // 工作流：启动
      if (url.pathname === '/api/workflow/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        let from = Number(body.from || 4);
        if (from < 4) from = 4;   // 场景切分不再通过工作流触发
        const to = Number(body.to || 6);
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '这本书还没有正文，先完成 1-2 步' }, 400); return; }
        if (globalThis.__workflowJob?.running) { sendJson(response, { error: '已有工作流在跑' }, 409); return; }
        const { spawn } = await import('node:child_process');
        const job = { running: true, from, to, startedAt: new Date().toISOString() };
        globalThis.__workflowJob = job;
        const child = spawn(process.execPath, ['tools/workflow-run.mjs', path.join(root, id), String(from), String(to)], { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env, CORPUS_MODEL: resolveLlmConfig(root, false).model, ...(process.env.WF_LIMIT ? { WF_LIMIT: process.env.WF_LIMIT } : {}) } });
        child.on('exit', (code) => { job.running = false; job.code = code; globalThis.__workflowJob = null; });
        sendJson(response, { ok: true, started: true, from, to });
        return;
      }

      // 工作流：停止
      if (url.pathname === '/api/workflow/stop' && request.method === 'POST') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        try { fs.writeFileSync(path.join(dirs.l2, 'workflow.stop'), new Date().toISOString(), 'utf8'); } catch { /* 忽略 */ }
        try {
          const wfFile = path.join(dirs.l2, 'workflow.json');
          if (fs.existsSync(wfFile)) {
            const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
            wf.running = false;
            wf.stopped = true;
            wf.stoppedAt = new Date().toISOString();
            fs.writeFileSync(wfFile, JSON.stringify(wf, null, 1), 'utf8');
          }
        } catch { /* 忽略 */ }
        if (globalThis.__workflowJob) globalThis.__workflowJob.running = false;
        sendJson(response, { ok: true });
        return;
      }

      // 角色重构：列表
      if (url.pathname === '/api/reconcile/list' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
        const scenes = fs.existsSync(scenesFile) ? (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []) : [];
        const repFile = path.join(dirs.l2, 'reconcile-report.json');
        const report = fs.existsSync(repFile) ? JSON.parse(fs.readFileSync(repFile, 'utf8')) : { scenes: {} };
        const detailFile = path.join(dirs.l2, 'scene-details.json');
        const detailStore = fs.existsSync(detailFile) ? JSON.parse(fs.readFileSync(detailFile, 'utf8')) : { details: {}, failed: {} };
        const failedMap = detailStore.failed || {};
        const rows = scenes.map((s) => {
          const r = report.scenes?.[s.sceneId];
          return {
            sceneId: s.sceneId, chapterTitle: s.chapterTitle || '', from: s.from, to: s.to, sentences: s.sentences,
            done: Boolean(r && !r.error),
            error: r?.error || '',
            newChars: (r?.需新增角色 || []).length,
            fixes: (r?.关系修正 || []).length + (r?.关系删除 || []).length,
          };
        });
        sendJson(response, { scenes: rows, done: rows.filter((r) => r.done).length, total: rows.length });
        return;
      }

      // 角色重构：单场报告
      if (url.pathname === '/api/reconcile/scene' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const sceneId = String(url.searchParams.get('sceneId') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const file = path.join(dirs.l2, 'reconcile', sceneId + '.json');
        if (!fs.existsSync(file)) { sendJson(response, { ok: false, error: '该场景还没有重构报告' }, 404); return; }
        sendJson(response, { ok: true, report: JSON.parse(fs.readFileSync(file, 'utf8')) });
        return;
      }

      // 角色重构：执行（后台）
      if (url.pathname === '/api/reconcile/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const from = String(body.from || '');
        const to = String(body.to || from);
        const apply = Boolean(body.apply);
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (globalThis.__reconcileJob?.running) { sendJson(response, { error: '已有重构任务在跑' }, 409); return; }
        const { spawn } = await import('node:child_process');
        const onlyMissing = Boolean(body.onlyMissing);
        const args = ['tools/reconcile-characters.mjs', path.join(root, id), from, to];
        if (apply) args.push('--apply');
        const job = { running: true, from, to, apply, onlyMissing, startedAt: new Date().toISOString() };
        globalThis.__reconcileJob = job;
        const jobLog = path.join(dirs.l2, 'detail-job.log');
        const logFd = (() => { try { return fs.openSync(jobLog, 'a'); } catch { return 'ignore'; } })();
        const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', logFd, logFd], env: { ...process.env, CORPUS_MODEL: resolveLlmConfig(root, false).model, ...(onlyMissing ? { SKIP_DONE: '1' } : {}) } });
        globalThis.__reconcileChild = child;
        try { fs.writeFileSync(path.join(dirs.l2, 'reconcile.pid'), String(child.pid), 'utf8'); } catch { /* 忽略 */ }
        child.on('exit', (code) => {
          job.running = false;
          job.code = code;
          try { fs.rmSync(path.join(dirs.l2, 'reconcile.pid'), { force: true }); } catch { /* 忽略 */ }
        });
        sendJson(response, { ok: true, started: true, from, to, apply });
        return;
      }

      // 角色重构：停止（写标记文件，工具在下一场开始前退出）
      if (url.pathname === '/api/reconcile/stop' && request.method === 'POST') {
        const id = String(url.searchParams.get('id') || '');
        let killed = 0;
        if (id) {
          const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
          try {
            fs.mkdirSync(dirs.l2, { recursive: true });
            fs.writeFileSync(path.join(dirs.l2, 'reconcile.stop'), new Date().toISOString(), 'utf8');
            killed = 1;
          } catch { /* 忽略 */ }
        }
        if (globalThis.__reconcileJob) globalThis.__reconcileJob.running = false;
        sendJson(response, { ok: true, killed, mode: 'flag' });
        return;
      }

      // 角色重构：进度
      if (url.pathname === '/api/reconcile/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const repFile = path.join(dirs.l2, 'reconcile-report.json');
        const report = fs.existsSync(repFile) ? JSON.parse(fs.readFileSync(repFile, 'utf8')) : { scenes: {}, totals: {} };
        const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
        const total = fs.existsSync(scenesFile) ? (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []).length : 0;
        sendJson(response, {
          done: Object.keys(report.scenes || {}).length, total,
          totals: report.totals || {},
          running: Boolean(globalThis.__reconcileJob?.running),
          job: globalThis.__reconcileJob || null,
        });
        return;
      }

      // 任务卡：一本书的全链路状态汇总
      if (url.pathname === '/api/taskcard' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const readJson = (file, fallback) => {
          try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
        };
        const book = readJson(dirs.book, null);
        const scenesDoc = readJson(path.join(dirs.l2, 'scenes-llm.json'), { scenes: [] });
        const charsDoc = readJson(path.join(dirs.l2, 'characters.json'), { characters: [] });
        const mapDoc = readJson(path.join(dirs.l2, 'scene-map.json'), { scenes: {} });
        const detailDoc = readJson(path.join(dirs.l2, 'scene-details.json'), { details: {} });
        const relDoc = readJson(path.join(dirs.l2, 'relations.json'), { relations: [] });

        const sentences = (book?.chapters || []).reduce((n, c) => n + (c.paragraphs || []).reduce((m, p) => m + (p.sentences || []).length, 0), 0);
        const sceneList = scenesDoc.scenes || [];
        const details = detailDoc.details || {};
        const detailList = Object.values(details);
        const questions = detailList.reduce((n, d) => n + (Array.isArray(d['疑问']) ? d['疑问'].length : 0), 0);
        const mappedMentions = Object.values(mapDoc.scenes || {}).flat().filter((x) => x.characterId).length;

        sendJson(response, {
          book: {
            id,
            title: book?.title || id,
            chapters: (book?.chapters || []).length,
            sentences,
            scenes: sceneList.length,
            characters: (charsDoc.characters || []).length,
            relations: (relDoc.relations || []).length,
            details: detailList.length,
            questions,
          },
          tasks: [
            { key: 'scenes', label: '场景切分', done: sceneList.length, total: sceneList.length, percent: sceneList.length ? 100 : 0,
              running: Boolean(globalThis.__sceneJob?.running), detail: sceneList.length + ' 场 · ' + sentences + ' 句' },
            { key: 'characters', label: '生成角色', done: mappedMentions, total: 0,
              running: Boolean(globalThis.__characterJob?.running), detail: (charsDoc.characters || []).length + ' 角色 · 已映射 ' + mappedMentions + ' 人称' },
            { key: 'details', label: '场景详述', done: detailList.length, total: sceneList.length,
              percent: sceneList.length ? Math.round((detailList.length / sceneList.length) * 100) : 0,
              running: Boolean(globalThis.__detailJob?.running), detail: questions + ' 条疑问' },
            { key: 'relations', label: '角色关系', done: (relDoc.relations || []).length, total: 0,
              running: false, detail: (relDoc.relations || []).length + ' 条（待重建）' },
          ],
        });
        return;
      }

      // 角色与人称：读取（三步产物合并）
      if (url.pathname === '/api/characters' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const sqliteReady = hasSqliteBook(storage, dirs);
        const charFile = path.join(dirs.l2, 'characters.json');
        const tableFile = path.join(dirs.l2, 'mention-table.json');
        const mapFile = path.join(dirs.l2, 'scene-map.json');
        if (!fs.existsSync(charFile)) { sendJson(response, { error: '还没有角色真名表' }, 404); return; }
        const characters = JSON.parse(fs.readFileSync(charFile, 'utf8')).characters || [];
        const relFile = path.join(dirs.l2, 'relations.json');
        const relations = fs.existsSync(relFile) ? (JSON.parse(fs.readFileSync(relFile, 'utf8')).relations || []) : [];
        const mapDoc = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : { scenes: {}, doneScenes: [] };
        const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
        const sourceScenes = fs.existsSync(scenesFile) ? (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []) : [];
        let table;
        let scenes;
        if (sqliteReady) {
          const db = openReadDb(dirs.root);
          try {
            table = db.prepare(`SELECT mention_id, surface, cls, sentence, start_off, end_off, in_dialog, scene_id, character_id
              FROM mention WHERE book_id = ? ORDER BY mention_id`).all(id).map((row) => ({
              id: row.mention_id, surface: row.surface, cls: row.cls, sentence: row.sentence,
              start: row.start_off, end: row.end_off, inDialog: Boolean(row.in_dialog),
              sceneId: row.scene_id || '', characterId: row.character_id || '',
            }));
            scenes = scenesFromDb(db, id, sourceScenes);
          } finally { db.close(); }
        } else {
          table = fs.existsSync(tableFile) ? (JSON.parse(fs.readFileSync(tableFile, 'utf8')).mentions || []) : [];
          scenes = sourceScenes;
        }
        const book = fs.existsSync(dirs.book) ? JSON.parse(fs.readFileSync(dirs.book, 'utf8')) : null;
        const textOf = new Map();
        if (book) for (const c of book.chapters || []) for (const pa of c.paragraphs || []) for (const s of pa.sentences || []) {
          const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
          if (n) textOf.set(n, s.text);
        }
        const tableById = new Map(table.map((m) => [m.id, m]));
        const nameOf = new Map(characters.map((c) => [c.id, c.name]));
        const validIds = new Set(characters.map((c) => c.id));
        // 句子号 → 场景号（双向追踪：场景能查人称，人称能回场景）
        const sceneOfSentence = new Map();
        for (const s of scenes) {
          const from = Number(String(s.from).slice(1));
          const to = Number(String(s.to).slice(1));
          for (let n = from; n <= to; n += 1) sceneOfSentence.set(n, s.sceneId);
        }
        const mapped = new Map();
        if (!sqliteReady) for (const [sceneId, list] of Object.entries(mapDoc.scenes || {})) {
          for (const item of list) mapped.set(item.id, item.characterId || '');
        }
        const relFile2 = path.join(dirs.l2, 'relations.json');
        const relDoc2 = fs.existsSync(relFile2) ? JSON.parse(fs.readFileSync(relFile2, 'utf8')) : { relations: [] };
        const relationsV2 = (relDoc2.relations || []).map((r) => ({
          id: r.id, sceneId: r.sceneId || '', fromName: r.fromName, type: r.type, toName: r.toName, evidence: r.evidence || [],
        }));
        const mentions = table.map((m) => {
          const raw = mapped.get(m.id) || m.characterId || '';
          const chId = nameOf.has(raw) ? raw : '';
          return {
            id: m.id, sceneId: sceneOfSentence.get(m.sentence) || '', sentence: m.sentence,
            surface: m.surface, cls: m.cls, inDialog: !!m.inDialog, start: m.start ?? null, end: m.end ?? null,
            characterId: chId, name: nameOf.get(chId) || '',
          };
        });
        const sceneWithText = scenes.map((s) => {
          const from = Number(String(s.from).slice(1));
          const to = Number(String(s.to).slice(1));
          const text = [];
          for (let n = from; n <= to; n += 1) if (textOf.has(n)) text.push({ n, text: textOf.get(n) });
          return { ...s, text };
        });
        sendJson(response, {
          characters, relations: relationsV2, scenes: sceneWithText, mentions,
          doneScenes: mapDoc.doneScenes || [], scenesTotal: scenes.length,
          totals: {
            scenes: (mapDoc.doneScenes || []).length,
            mentions: mentions.length,
            resolved: mentions.filter((m) => m.characterId).length,
            unresolved: mentions.filter((m) => !m.characterId).length,
            characters: characters.length,
          },
        });
        return;
      }

      // 角色与人称：读取
      if (url.pathname === '/api/characters' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const file = path.join(dirs.l2, 'mentions.json');
        if (!fs.existsSync(file)) { sendJson(response, { error: '这本书还没有角色分析结果' }, 404); return; }
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        const book = fs.existsSync(dirs.book) ? JSON.parse(fs.readFileSync(dirs.book, 'utf8')) : null;
        const textOf = new Map();
        if (book) {
          for (const chapter of book.chapters || []) for (const para of chapter.paragraphs || []) for (const s of para.sentences || []) {
            const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
            if (n) textOf.set(n, s.text);
          }
        }
        const mentions = (doc.mentions || []).map((m) => ({
          ...m,
          samples: (m.sentences || []).slice(0, 2).map((n) => 'S' + n + ' ' + (textOf.get(n) || '').slice(0, 40)),
        }));
        const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
        const scenesTotal = fs.existsSync(scenesFile) ? (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []).length : 0;
        const sceneList = fs.existsSync(scenesFile) ? (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []) : [];
        const sceneWithText = sceneList.map((s) => {
          const from = Number(String(s.from).slice(1));
          const to = Number(String(s.to).slice(1));
          const text = [];
          for (let n = from; n <= to; n += 1) if (textOf.has(n)) text.push({ n, text: textOf.get(n) });
          return { ...s, text };
        });
        sendJson(response, { ...doc, scenes: sceneWithText, scenesTotal, mentions });
        return;
      }

      // 角色与人称：生成
      if (url.pathname === '/api/characters/build' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (!fs.existsSync(path.join(dirs.l2, 'scenes-llm.json'))) { sendJson(response, { error: '先做场景切分' }, 400); return; }
        const { spawnSync } = await import('node:child_process');
        const args = ['tools/build-characters.mjs', dirs.root || path.join(root, id)];
        const limit = Number(body.limit || 0);
        if (limit > 0) args.push('--limit', String(limit));
        const result = spawnSync(process.execPath, args, {
          cwd: process.cwd(), encoding: 'utf8', timeout: 6 * 3600 * 1000,
          env: { ...process.env, CORPUS_MODEL: resolveLlmConfig(root, false).model },
        });
        const doc = fs.existsSync(path.join(dirs.l2, 'mentions.json'))
          ? JSON.parse(fs.readFileSync(path.join(dirs.l2, 'mentions.json'), 'utf8')) : null;
        sendJson(response, { ok: result.status === 0, totals: doc?.totals || null, log: (result.stdout || '').trim().split('\n').slice(-2) });
        return;
      }

      // 角色与人称：停止
      if (url.pathname === '/api/characters/stop' && request.method === 'POST') {
        const { execSync } = await import('node:child_process');
        let killed = 0;
        try {
          const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*build-mentions*' -or $_.CommandLine -like '*build-characters*' } | Select-Object -ExpandProperty ProcessId";
          const list = execSync('powershell -NoProfile -Command "' + script + '"', { encoding: 'utf8', timeout: 15000 });
          for (const line of list.split('\n')) {
            const pid = Number(line.trim());
            if (pid) { try { process.kill(pid); killed += 1; } catch { /* 忽略 */ } }
          }
        } catch { /* 忽略 */ }
        sendJson(response, { ok: true, killed });
        return;
      }

      // 角色与人称：手工绑定
      if (url.pathname === '/api/characters/bind' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const mentionId = String(body.mentionId || '');
        const name = String(body.name || '').trim();
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const file = path.join(dirs.l2, 'mentions.json');
        if (!fs.existsSync(file)) { sendJson(response, { error: '没有分析结果' }, 404); return; }
        withJsonLock(file, () => {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        const mention = (doc.mentions || []).find((m) => m.id === mentionId);
        if (!mention) { sendJson(response, { error: '没有人称 ' + mentionId }, 404); return; }
        mention.name = name;
        mention.confidence = 1;
        mention.source = 'manual';
        doc.characters = [...new Set(doc.mentions.map((m) => m.name).filter(Boolean))].map((n, i) => ({ id: 'CH' + String(i + 1).padStart(2, '0'), name: n }));
        doc.totals.characters = doc.characters.length;
        doc.totals.resolved = doc.mentions.filter((m) => m.name).length;
        doc.totals.unresolved = doc.mentions.filter((m) => !m.name).length;
        writeJsonAtomic(file, doc);
        sendJson(response, { ok: true, mention });
        });
        return;
      }

      if (url.pathname === '/api/scenes/detail/list' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        // 每场字数：按 book.json 的句子长度累加
        const sentenceChars = new Map();
        try {
          if (fs.existsSync(dirs.book)) {
            const bk = JSON.parse(fs.readFileSync(dirs.book, 'utf8'));
            for (const ch of bk.chapters || []) {
              for (const para of ch.paragraphs || []) {
                for (const sen of para.sentences || []) {
                  const n = Number(String(sen.sid || sen.id || '').replace(/^.*S/, ''));
                  if (n) sentenceChars.set(n, String(sen.text || '').length);
                }
              }
            }
          }
        } catch { /* 忽略 */ }
        const sceneCharCount = (a, b) => {
          let sum = 0;
          for (let n = Number(a); n <= Number(b); n += 1) sum += sentenceChars.get(n) || 0;
          return sum;
        };

        const failedStore = fs.existsSync(path.join(dirs.l2, 'scene-details.json'))
          ? JSON.parse(fs.readFileSync(path.join(dirs.l2, 'scene-details.json'), 'utf8')).failed || {}
          : {};
        const failedMap = failedStore;
        let rows;
        if (hasSqliteBook(storage, dirs)) {
          const db = openReadDb(dirs.root);
          try {
            rows = db.prepare(`SELECT s.scene_id, s.title, s.s_from, s.s_to, s.sentences, d.detail_id, d.payload
              FROM scene s LEFT JOIN scene_detail d ON d.book_id = s.book_id AND d.scene_id = s.scene_id
              WHERE s.book_id = ? ORDER BY s.s_from, s.scene_id`).all(id).map((row) => {
              const detail = row.payload ? JSON.parse(row.payload) : null;
              return {
                sceneId: row.scene_id, detailId: detail ? 'SD' + String(row.scene_id).replace(/^SC/, '') : '', chapterTitle: row.title || '',
                from: 'S' + row.s_from, to: 'S' + row.s_to, sentences: row.sentences, chars: sceneCharCount(row.s_from, row.s_to),
                done: detailState(detail).done, partial: detailState(detail).partial && !detailState(detail).done,
                missing: detailState(detail).missing,
                failed: Boolean(failedMap[row.scene_id]), problem: failedMap[row.scene_id]?.problem || '', characters: (detail?.['人物'] || []).length, beats: (detail?.['情节'] || []).length,
              };
            });
          } finally { db.close(); }
        } else {
          const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
          const scenes = fs.existsSync(scenesFile) ? (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []) : [];
          const outFile = path.join(dirs.l2, 'scene-details.json');
          const store = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { details: {} };
          rows = scenes.map((s) => {
            const detail = store.details?.[s.sceneId];
            return {
              sceneId: s.sceneId, detailId: detail?.detailId || '', chapterTitle: s.chapterTitle || '',
              from: s.from, to: s.to, sentences: s.sentences, chars: sceneCharCount(Number(String(s.from).slice(1)), Number(String(s.to).slice(1))),
              done: detailState(detail).done,
              partial: detailState(detail).partial && !detailState(detail).done,
              missing: detailState(detail).missing,
              characters: (detail?.['人物'] || []).length,
              beats: (detail?.['情节'] || []).length,
            };
          });
        }
        sendJson(response, { scenes: rows, total: rows.length, done: rows.filter((r) => r.done).length });
        return;
      }

      if (url.pathname === '/api/scenes/detail' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const sceneId = String(url.searchParams.get('sceneId') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const outFile = path.join(dirs.l2, 'scene-details.json');
        let detail;
        let hasDetails;
        if (hasSqliteBook(storage, dirs)) {
          const db = openReadDb(dirs.root);
          try {
            const row = db.prepare('SELECT payload FROM scene_detail WHERE book_id = ? AND scene_id = ?').get(id, sceneId);
            detail = row ? JSON.parse(row.payload) : null;
            hasDetails = Boolean(db.prepare('SELECT 1 AS found FROM scene_detail WHERE book_id = ? LIMIT 1').get(id)) || fs.existsSync(outFile);
          } finally { db.close(); }
        } else {
          hasDetails = fs.existsSync(outFile);
          if (hasDetails) {
            const store = JSON.parse(fs.readFileSync(outFile, 'utf8'));
            detail = store.details?.[sceneId];
          }
        }
        if (!hasDetails) { sendJson(response, { ok: false, error: '还没有生成过详述' }, 404); return; }
        if (!detail) { sendJson(response, { ok: false, error: '这个场景还没有详述' }, 404); return; }
        sendJson(response, { ok: true, sceneId, detailId: detail.detailId, detail });
        return;
      }

      // 场景详述：把某个历史版本恢复为当前
      if (url.pathname === '/api/scenes/detail/restore' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const scene = String(body.scene || '');
        const v = Number(body.v || 0);
        const dirs = layout(path.join(root, id));
        const vfile = path.join(dirs.l2, 'scene-details-versions', scene, 'v' + v + '.json');
        if (!fs.existsSync(vfile)) { sendJson(response, { error: '版本不存在' }, 404); return; }
        const storeFile = path.join(dirs.l2, 'scene-details.json');
        let store = { details: {}, index: {}, failed: {} };
        try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { /* 忽略 */ }
        const restored = JSON.parse(fs.readFileSync(vfile, 'utf8'));
        const prev = store.details[scene];
        const nextVersion = Math.max(Number(prev?.version || 1), v) + 1;
        // 当前内容先存档
        if (prev) {
          try {
            fs.mkdirSync(path.join(dirs.l2, 'scene-details-versions', scene), { recursive: true });
            const f = path.join(dirs.l2, 'scene-details-versions', scene, 'v' + Number(prev.version || 1) + '.json');
            if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(prev, null, 1), 'utf8');
          } catch { /* 忽略 */ }
        }
        const record = { ...restored, version: nextVersion, restoredFrom: v, generatedAt: new Date().toISOString() };
        store.details[scene] = record;
        fs.mkdirSync(path.dirname(storeFile), { recursive: true });
        fs.writeFileSync(storeFile, JSON.stringify(store, null, 1), 'utf8');
        try {
          fs.writeFileSync(path.join(dirs.l2, 'scene-details-versions', scene, 'v' + nextVersion + '.json'), JSON.stringify(record, null, 1), 'utf8');
        } catch { /* 忽略 */ }
        sendJson(response, { ok: true, version: nextVersion, restoredFrom: v });
        return;
      }

      // 场景详述：版本列表 / 读取某版本
      if (url.pathname === '/api/scenes/detail/versions' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const scene = String(url.searchParams.get('scene') || '');
        const dirs = layout(path.join(root, id));
        const vdir = path.join(dirs.l2, 'scene-details-versions', scene);
        const list = [];
        try {
          if (fs.existsSync(vdir)) {
            for (const f of fs.readdirSync(vdir)) {
              const m = f.match(/^v(\d+)\.json$/);
              if (!m) continue;
              const v = Number(m[1]);
              let meta = null;
              try { meta = JSON.parse(fs.readFileSync(path.join(vdir, f), 'utf8')); } catch { /* 忽略 */ }
              list.push({ version: v, generatedAt: meta?.generatedAt || '', steps: (meta?.['情节'] || []).length, people: (meta?.['人物'] || []).length });
            }
          }
        } catch { /* 忽略 */ }
        list.sort((x, y) => x.version - y.version);
        sendJson(response, { scene, versions: list });
        return;
      }

      if (url.pathname === '/api/scenes/detail/version' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const scene = String(url.searchParams.get('scene') || '');
        const v = Number(url.searchParams.get('v') || 0);
        const dirs = layout(path.join(root, id));
        const file = path.join(dirs.l2, 'scene-details-versions', scene, 'v' + v + '.json');
        if (!fs.existsSync(file)) { sendJson(response, { error: '版本不存在' }, 404); return; }
        sendJson(response, JSON.parse(fs.readFileSync(file, 'utf8')));
        return;
      }

      // 场景详述：范围生成（后台）
      if (url.pathname === '/api/scenes/detail/range' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const fromId = String(body.from || '');
        const toId = String(body.to || '');
        const force = Boolean(body.force);
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
        if (!fs.existsSync(scenesFile)) { sendJson(response, { error: '还没有场景切分' }, 400); return; }
        const scenes = JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || [];
        const listOverride = Array.isArray(body.scenes) ? body.scenes.map(String) : null;
        const iFrom = Math.max(0, scenes.findIndex((s) => s.sceneId === fromId));
        const iTo = scenes.findIndex((s) => s.sceneId === (toId || fromId));
        if (iFrom < 0 || iTo < 0) { sendJson(response, { error: '场景号不存在' }, 400); return; }
        if (globalThis.__detailJob?.running) {
          sendJson(response, { error: '已有生成任务在跑：' + globalThis.__detailJob.range }, 409);
          return;
        }
        const count = Math.max(1, iTo - iFrom + 1);
        const rangeIdsAll = listOverride ? scenes.filter((s) => listOverride.includes(s.sceneId)).map((s) => s.sceneId) : scenes.slice(iFrom, iTo + 1).map((s) => s.sceneId);
        let skippedInRange = 0;
        try {
          const storeFile = path.join(dirs.l2, 'scene-details.json');
          if (fs.existsSync(storeFile)) {
            const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
            skippedInRange = rangeIdsAll.filter((sid) => store.details && store.details[sid]).length;
          }
        } catch { /* 忽略 */ }
        const { spawn } = await import('node:child_process');
        const rangeIds = scenes.slice(iFrom, iTo + 1).map((s) => s.sceneId);
        const job = { running: true, bookId: id, range: scenes[iFrom].sceneId + '~' + scenes[iTo].sceneId, rangeIds, startedAt: new Date().toISOString() };
        globalThis.__detailJob = job;
        const child = spawn(process.execPath, ['tools/gen-scene-details.mjs', path.join(root, id), scenes[iFrom].sceneId, scenes[iTo].sceneId], {
          cwd: process.cwd(),
          env: { ...process.env, CORPUS_MODEL: (body.model ? String(body.model) : resolveTabModel('scenedetail', resolveLlmConfig(root, false).model)), ...(force ? { FORCE: '1' } : {}), ...(listOverride ? { DETAIL_ONLY: listOverride.join(',') } : {}) },
          stdio: (() => {
            try {
              const fd = fs.openSync(path.join(dirs.l2, 'detail-job.log'), 'a');
              return ['ignore', fd, fd];
            } catch { return 'ignore'; }
          })(),
        });
        job.pid = child.pid;
        child.on('exit', (code) => { job.running = false; job.code = code; });
        sendJson(response, { ok: true, started: true, range: job.range, count, skipped: skippedInRange, willRun: force ? count : count - skippedInRange });
        return;
      }

      // 场景详述：停止
      if (url.pathname === '/api/scenes/detail/stop' && request.method === 'POST') {
        const { execSync } = await import('node:child_process');
        const job = globalThis.__detailJob;
        if (job) job.running = false;
        let killed = 0;

        // 优先按记录的 pid 杀进程树
        if (job && job.pid) {
          try {
            execSync('taskkill /PID ' + Number(job.pid) + ' /T /F', { stdio: 'ignore', timeout: 10000 });
            killed += 1;
          } catch { /* 忽略 */ }
        }

        // 兜底：按命令行匹配
        try {
          const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*gen-scene-details*' } | Select-Object -ExpandProperty ProcessId";
          const out = execSync('powershell -NoProfile -Command "' + script + '"', { encoding: 'utf8', timeout: 15000 });
          for (const line of out.split('\n')) {
            const pid = Number(line.trim());
            if (!pid) continue;
            try {
              execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore', timeout: 10000 });
              killed += 1;
            } catch { /* 忽略 */ }
          }
        } catch { /* 忽略 */ }

        try { fs.writeFileSync(path.join(layout(path.join(root, String(job?.bookId || ''))).l2, 'detail.stop'), 'stop', 'utf8'); } catch { /* 忽略 */ }
        sendJson(response, { ok: true, killed });
        return;
      }

      // 场景详述：进度
      if (url.pathname === '/api/scenes/detail/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        let scenes;
        let doneCount;
        let sentencesTotal;
        let sentencesDone;
        let current;
        let doneIds = new Set();
        if (hasSqliteBook(storage, dirs)) {
          const db = openReadDb(dirs.root);
          try {
            scenes = db.prepare('SELECT scene_id AS sceneId, sentences FROM scene WHERE book_id = ? ORDER BY s_from, scene_id').all(id);
            const stats = db.prepare(`SELECT COUNT(*) AS total, COUNT(d.scene_id) AS done,
              COALESCE(SUM(s.sentences), 0) AS sentencesTotal,
              COALESCE(SUM(CASE WHEN d.scene_id IS NOT NULL THEN s.sentences ELSE 0 END), 0) AS sentencesDone
              FROM scene s LEFT JOIN scene_detail d ON d.book_id = s.book_id AND d.scene_id = s.scene_id
              WHERE s.book_id = ?`).get(id);
            doneIds = new Set(db.prepare('SELECT scene_id AS sceneId FROM scene_detail WHERE book_id = ?').all(id).map((r) => r.sceneId));
            doneCount = stats.done;
            sentencesTotal = stats.sentencesTotal;
            sentencesDone = stats.sentencesDone;
            current = db.prepare(`SELECT s.scene_id AS sceneId FROM scene s
              JOIN scene_detail d ON d.book_id = s.book_id AND d.scene_id = s.scene_id
              WHERE s.book_id = ? ORDER BY s.s_from DESC, s.scene_id DESC LIMIT 1`).get(id)?.sceneId || '';
          } finally { db.close(); }
        } else {
          const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
          scenes = fs.existsSync(scenesFile) ? (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []) : [];
          const defFile = path.join(dirs.l2, 'scene-details.json');
          const store = fs.existsSync(defFile) ? JSON.parse(fs.readFileSync(defFile, 'utf8')) : { details: {} };
          const doneScenes = scenes.filter((s) => store.details?.[s.sceneId]);
          doneIds = new Set(doneScenes.map((s) => s.sceneId));
          doneCount = doneScenes.length;
          sentencesTotal = scenes.reduce((n, s) => n + (s.sentences || 0), 0);
          sentencesDone = doneScenes.reduce((n, s) => n + (s.sentences || 0), 0);
          current = doneCount ? doneScenes[doneCount - 1].sceneId : '';
        }
        // 当前正在处理的场景（任务进行中时是「已完成场次的下一个」）
        let runningScene = '';
        let runningSentences = 0;
        let runningDone = 0;
        const job = globalThis.__detailJob || null;
        if (job && job.running && Array.isArray(job.rangeIds) && job.rangeIds.length) {
          const doneInRange = job.rangeIds.filter((sid) => doneIds.has(sid)).length;
          const nextId = job.rangeIds[Math.min(doneInRange, job.rangeIds.length - 1)];
          const target = scenes.find((s) => s.sceneId === nextId) || null;
          if (target) {
            runningScene = target.sceneId;
            runningSentences = target.sentences || 0;
            runningDone = doneInRange;
          }
          job.rangeDone = doneInRange;
          job.rangeTotal = job.rangeIds.length;
        }
        const jobInfo = globalThis.__detailJob ? { range: globalThis.__detailJob.range, rangeIds: globalThis.__detailJob.rangeIds, running: globalThis.__detailJob.running } : null;
        sendJson(response, {
          jobInfo,
          done: doneCount,
          total: scenes.length,
          percent: scenes.length ? Math.round((doneCount / scenes.length) * 100) : 0,
          sentencesDone, sentencesTotal,
          currentScene: current,
          runningScene, runningSentences, runningDone,
          running: Boolean(globalThis.__detailJob?.running),
          job: globalThis.__detailJob || null,
        });
        return;
      }

      // 场景详述：状态查询，合并人物与情节，避免长场景被截断
      if (url.pathname === '/api/scenes/detail' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const sceneId = String(body.sceneId || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
        if (!fs.existsSync(scenesFile)) { sendJson(response, { error: '还没有场景切分' }, 400); return; }
        const scene = (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []).find((s) => s.sceneId === sceneId);
        if (!scene) { sendJson(response, { error: '没有这个场景' }, 404); return; }

        const book = JSON.parse(fs.readFileSync(dirs.book, 'utf8'));
        const from = Number(String(scene.from).slice(1));
        const to = Number(String(scene.to).slice(1));
        const lines = [];
        for (const c of book.chapters) for (const p of c.paragraphs || []) for (const s of p.sentences || []) {
          const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
          if (n >= from && n <= to) lines.push(n + '. ' + String(s.text || ''));
        }

        const charFile = path.join(dirs.l2, 'characters.json');
        const characters = fs.existsSync(charFile) ? (JSON.parse(fs.readFileSync(charFile, 'utf8')).characters || []) : [];
        const relFile = path.join(dirs.l2, 'relations.json');
        const relations = fs.existsSync(relFile) ? (JSON.parse(fs.readFileSync(relFile, 'utf8')).relations || []) : [];
        const model = resolveLlmConfig(root, false).model;

        const callModel = async (prompt) => {
          const reply = await fetch('http://127.0.0.1:8090/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
            body: JSON.stringify({
              model, messages: [{ role: 'user', content: prompt }],
              stream: false, max_tokens: 16384, temperature: 0.2,
              reasoning_effort: 'none', response_format: { type: 'json_object' },
              signal: AbortSignal.timeout(1800000),
            }),
          });
          if (!reply.ok) return null;
          const data = await reply.json();
          return parseModelJson(String(data.choices?.[0]?.message?.content || ''));
        };

        // 分段：每段约 3000 字，按句子边界切
        const chunks = [];
        let buffer = [];
        let size = 0;
        for (const line of lines) {
          buffer.push(line);
          size += line.length;
          if (size >= 20000) { chunks.push(buffer); buffer = []; size = 0; }  // 单场景一次给完
        }
        if (buffer.length) chunks.push(buffer);

        const people = new Map();
        const steps = [];
        const doubts = new Set();
        let failed = '';

        for (let ci = 0; ci < chunks.length; ci += 1) {
          const chunk = chunks[ci];
          const prompt = [
            '角色表：', characters.map((c) => c.id + ' ' + c.name).join(' / ') || '（无）',
            '',
            '角色关系（可参考）：', relations.slice(0, 30).map((r) => r.fromName + '-' + r.type + '->' + r.toName).join('；') || '（无）',
            '',
            '这是同一个场景的第 ' + (ci + 1) + '/' + chunks.length + ' 段原文（每行以句子号开头）。',
            '请只针对本段输出：',
            '1. 本段出场人物：真名、衣着容貌、身体部位（按原文顺序）、处境现状、本段做了什么',
            '2. 情节经过：按动作逐步拆解，一步写一个动作变化（谁用哪个部位、碰/插入/揉捏/撕开哪里、体位变化、衣物状态、身体反应、说了什么）',
            '   禁止概括，原文每 2–4 句至少一步',
            '3. 疑点',
            '',
            '硬性要求：',
            '· 不使用人称代词（他/她/其/此人/对方），一律写真名',
            '· 人物身份依据原文，不许预设标签',
            '',
            '只返回 JSON：',
            '{"人物":[{"姓名":"真名","身份":"…","衣着容貌":"…","身体部位":[{"部位":"大腿","状态":"…"}],"处境现状":"…","在本场做的事":"…"}],',
            ' "情节":[{"步骤":1,"内容":"…"}],',
            ' "疑点":["…"]}',
            '',
            '【本段原文】', chunk.join('\n'),
          ].join('\n');

          let part = await callModel(prompt);
          if (!part || !Array.isArray(part['人物']) || !Array.isArray(part['情节'])) {
            const strict = await callModel(prompt + '\n\n上一次输出不合格。必须包含「人物」数组与「情节」数组，只输出合法 JSON。');
            part = strict;
          }
          if (!part || !Array.isArray(part['情节'])) { failed = '第 ' + (ci + 1) + ' 段生成失败'; break; }

          for (const person of part['人物'] || []) {
            const name = String(person['姓名'] || '').trim();
            if (!name) continue;
            if (!people.has(name)) people.set(name, { ...person, 姓名: name });
            else {
              const prev = people.get(name);
              prev['在本场做的事'] = [prev['在本场做的事'], person['在本场做的事']].filter(Boolean).join('；');
              if (!prev['衣着容貌'] && person['衣着容貌']) prev['衣着容貌'] = person['衣着容貌'];
              if (!prev['处境现状'] && person['处境现状']) prev['处境现状'] = person['处境现状'];
              const parts = prev['身体部位'] || [];
              for (const bp of person['身体部位'] || []) {
                if (!parts.some((x) => x['部位'] === bp['部位'])) parts.push(bp);
              }
              prev['身体部位'] = parts;
            }
          }
          for (const step of part['情节'] || []) {
            const content = String(step['内容'] || '').trim();
            if (content) steps.push({ 步骤: steps.length + 1, 内容: content });
          }
          for (const d of part['疑点'] || []) if (d) doubts.add(String(d));
        }

        if (failed) { sendJson(response, { error: failed }, 500); return; }

        const detail = {
          人物: [...people.values()],
          情节: steps,
          疑点: [...doubts],
        };
        const sentenceCount = to - from + 1;
        const problem = validateDetail(detail, sentenceCount);
        const pronounHits = (JSON.stringify(detail).match(/[他她]们?|其|此人|对方|那人/g) || []).length;
        const outFile = path.join(dirs.l2, 'scene-details.json');
        withJsonLock(outFile, () => {
        const store = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { details: {}, index: {} };
        store.index = store.index || {};
        const detailId = store.details[sceneId]?.detailId || 'SD' + String(Object.keys(store.details).length + 1).padStart(3, '0');
        store.details[sceneId] = {
          ...detail, detailId, sceneId,
          chunks: chunks.length,
          clean: pronounHits === 0,
          pronounHits,
          problem,
          generatedAt: new Date().toISOString(),
        };
        store.index[detailId] = sceneId;
        writeJsonAtomic(outFile, store);
        sendJson(response, { ok: true, sceneId, detailId, chunks: chunks.length, problem, detail: store.details[sceneId] });
        });
        return;
      }

      // 场景切分：进度
      if (url.pathname === '/api/scenes/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const book = fs.existsSync(dirs.book) ? JSON.parse(fs.readFileSync(dirs.book, 'utf8')) : null;
        let total = 0;
        if (book) for (const c of book.chapters || []) for (const p of c.paragraphs || []) total += (p.sentences || []).length;

        const readRanges = (file) => {
          const out = [];
          if (!fs.existsSync(file)) return out;
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { const r = JSON.parse(line); out.push([Number(String(r.from).slice(1)), Number(String(r.to).slice(1))]); } catch { /* 忽略 */ }
          }
          return out;
        };
        const partialFile = path.join(dirs.l2, 'scenes.partial.jsonl');
        const finalFile = path.join(dirs.l2, 'scenes-llm.json');
        let ranges = readRanges(partialFile);
        if (!ranges.length && fs.existsSync(finalFile)) {
          ranges = (JSON.parse(fs.readFileSync(finalFile, 'utf8')).scenes || []).map((s) => [Number(String(s.from).slice(1)), Number(String(s.to).slice(1))]);
        }
        const covered = new Set();
        for (const [f, t2] of ranges) for (let n = f; n <= t2; n += 1) covered.add(n);
        const progressFile = path.join(dirs.l2, 'scenes.progress.json');
        const chaptersDone = fs.existsSync(progressFile) ? (JSON.parse(fs.readFileSync(progressFile, 'utf8')).chapters || []).length : 0;
        let phaseInfo = null;
        try {
          const pf = path.join(layout(path.join(root, id)).l2, 'segmentation.phase.json');
          if (fs.existsSync(pf)) phaseInfo = JSON.parse(fs.readFileSync(pf, 'utf8'));
        } catch { /* 忽略 */ }
        sendJson(response, { phase: phaseInfo,
          total, done: covered.size, percent: total ? Math.round((covered.size / total) * 100) : 0,
          chaptersDone, chaptersTotal: (book?.chapters || []).length,
          running: Boolean(globalThis.__sceneJob && globalThis.__sceneJob.running),
          job: globalThis.__sceneJob || null,
          doneFile: fs.existsSync(path.join(dirs.l2, 'scenes.done.json')),
        });
        return;
      }

      // 场景切分：停止
      if (url.pathname === '/api/scenes/stop' && request.method === 'POST') {
        const { execSync } = await import('node:child_process');
        let killed = 0;
        try {
          const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*segment-scenes-llm*' } | Select-Object -ExpandProperty ProcessId";
          const out = execSync('powershell -NoProfile -Command "' + script + '"', { encoding: 'utf8', timeout: 20000 });
          for (const line of out.split('\n')) {
            const pid = Number(line.trim());
            if (!pid) continue;
            try {
              execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore', timeout: 10000 });
              killed += 1;
            } catch { /* 忽略 */ }
          }
        } catch { /* 忽略 */ }
        if (globalThis.__sceneJob) { globalThis.__sceneJob.running = false; globalThis.__sceneJob.phase = 'stopped'; }
        sendJson(response, { ok: true, killed });
        return;
      }

      // 场景切分：后台异步执行，避免阻塞服务（否则进度接口无法响应）
      if (url.pathname === '/api/scenes/segment' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const bookId = String(body.id || '');
        const dirs = layout(path.join(root, bookId));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const target = path.join(dirs.l2, 'scenes-llm.json');
        if (globalThis.__sceneJob && globalThis.__sceneJob.running) {
          sendJson(response, { ok: false, error: '已有切分任务在跑：' + globalThis.__sceneJob.bookId }, 409);
          return;
        }
        // 先备份旧结果，再清空（避免误删无法恢复）
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let backedUp = 0;
        for (const name of ['scenes-llm.json', 'scenes.progress.json', 'scenes.partial.jsonl', 'scenes.done.json']) {
          const f = path.join(dirs.l2, name);
          if (!fs.existsSync(f)) continue;
          try {
            fs.copyFileSync(f, path.join(dirs.l2, name + '.bak-' + stamp));
            backedUp += 1;
          } catch { /* 忽略 */ }
          fs.rmSync(f, { force: true });
        }
        if (backedUp) console.log('[切分] 已备份 ' + backedUp + ' 个旧文件：' + stamp);
        const { spawn } = await import('node:child_process');
        const job = { running: true, bookId, startedAt: new Date().toISOString(), phase: 'segment' };
        globalThis.__sceneJob = job;
        const child = spawn(process.execPath, ['tools/segment-scenes-llm.mjs', dirs.book, target], {
          cwd: process.cwd(),
          env: { ...process.env, CORPUS_MODEL: resolveLlmConfig(root, false).model },
          stdio: 'ignore',
        });
        child.on('exit', (code) => {
          job.phase = code === 0 ? 'split' : 'failed';
          if (code !== 0) {
            job.running = false;
            // 把校验报告里的具体原因带给界面
            let detail = '';
            try {
              const vf = path.join(dirs.l2, 'segmentation.verify.json');
              if (fs.existsSync(vf)) {
                const rep = JSON.parse(fs.readFileSync(vf, 'utf8'));
                if (Array.isArray(rep.errors) && rep.errors.length) detail = rep.errors.slice(0, 3).join('；');
              }
            } catch { /* 忽略 */ }
            job.error = detail ? ('切分校验未通过：' + detail) : ('切分进程退出码 ' + code);
            return;
          }
          const splitter = spawn(process.execPath, ['tools/split-long-scenes.mjs', path.join(root, bookId), '120'], { cwd: process.cwd(), stdio: 'ignore' });
          splitter.on('exit', (code2) => {
            job.running = false;
            job.phase = code2 === 0 ? 'done' : 'failed';
            if (code2 !== 0) job.error = '二次切分退出码 ' + code2;
            try {
              const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
              writeJsonAtomic(path.join(dirs.l2, 'scenes.done.json'), {
                at: new Date().toISOString(), scenes: doc.scenes?.length || 0, totals: doc.totals || {},
              });
            } catch { /* 忽略 */ }
          });
        });
        sendJson(response, { ok: true, started: true, bookId });
        return;
      }

      // 场景详述：分段生成（每段约 3000 字），合并人物与情节，避免长场景被截断
      if (url.pathname === '/api/scenes/detail' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const sceneId = String(body.sceneId || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
        if (!fs.existsSync(scenesFile)) { sendJson(response, { error: '还没有场景切分' }, 400); return; }
        const scene = (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []).find((s) => s.sceneId === sceneId);
        if (!scene) { sendJson(response, { error: '没有这个场景' }, 404); return; }

        const book = JSON.parse(fs.readFileSync(dirs.book, 'utf8'));
        const from = Number(String(scene.from).slice(1));
        const to = Number(String(scene.to).slice(1));
        const lines = [];
        for (const c of book.chapters) for (const p of c.paragraphs || []) for (const s of p.sentences || []) {
          const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
          if (n >= from && n <= to) lines.push(n + '. ' + String(s.text || ''));
        }

        const charFile = path.join(dirs.l2, 'characters.json');
        const characters = fs.existsSync(charFile) ? (JSON.parse(fs.readFileSync(charFile, 'utf8')).characters || []) : [];
        const relFile = path.join(dirs.l2, 'relations.json');
        const relations = fs.existsSync(relFile) ? (JSON.parse(fs.readFileSync(relFile, 'utf8')).relations || []) : [];
        const model = resolveLlmConfig(root, false).model;

        const callModel = async (prompt) => {
          const reply = await fetch('http://127.0.0.1:8090/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
            body: JSON.stringify({
              model, messages: [{ role: 'user', content: prompt }],
              stream: false, max_tokens: 16384, temperature: 0.2,
              reasoning_effort: 'none', response_format: { type: 'json_object' },
              signal: AbortSignal.timeout(1800000),
            }),
          });
          if (!reply.ok) return null;
          const data = await reply.json();
          return parseModelJson(String(data.choices?.[0]?.message?.content || ''));
        };

        // 分段：每段约 3000 字，按句子边界切
        const chunks = [];
        let buffer = [];
        let size = 0;
        for (const line of lines) {
          buffer.push(line);
          size += line.length;
          if (size >= 20000) { chunks.push(buffer); buffer = []; size = 0; }  // 单场景一次给完
        }
        if (buffer.length) chunks.push(buffer);

        const people = new Map();
        const steps = [];
        const doubts = new Set();
        let failed = '';

        for (let ci = 0; ci < chunks.length; ci += 1) {
          const chunk = chunks[ci];
          const prompt = [
            '角色表：', characters.map((c) => c.id + ' ' + c.name).join(' / ') || '（无）',
            '',
            '角色关系（可参考）：', relations.slice(0, 30).map((r) => r.fromName + '-' + r.type + '->' + r.toName).join('；') || '（无）',
            '',
            '这是同一个场景的第 ' + (ci + 1) + '/' + chunks.length + ' 段原文（每行以句子号开头）。',
            '请只针对本段输出：',
            '1. 本段出场人物：真名、衣着容貌、身体部位（按原文顺序）、处境现状、本段做了什么',
            '2. 情节经过：按动作逐步拆解，一步写一个动作变化（谁用哪个部位、碰/插入/揉捏/撕开哪里、体位变化、衣物状态、身体反应、说了什么）',
            '   禁止概括，原文每 2–4 句至少一步',
            '3. 疑问：只列「与预处理信息冲突」或「无法确定」的点，每条必须带证据句子号',
            '',
            '硬性要求：',
            '· 不使用人称代词（他/她/其/此人/对方），一律写真名',
            '· 人物身份依据原文，不许预设标签',
            '',
            '只返回 JSON：',
            '{"人物":[{"姓名":"真名","身份":"…","衣着容貌":"…","身体部位":[{"部位":"大腿","状态":"…"}],"处境现状":"…","在本场做的事":"…"}],',
            ' "情节":[{"步骤":1,"内容":"…"}],',
            ' "疑问":[{"编号":"Q001","类型":"关系冲突","描述":"…","预处理":"真名表里的关系","分析":"本场读到的关系","证据句":[26,27]}]}',
          '',
          '【疑问类型，只能选这几种】',
          '· 关系冲突：本场读到的关系与「角色关系」表不一致（预处理填表里的，分析填本场的）',
          '· 未知人物：出现真名表里没有的人名（描述填该人名）',
          '· 身份冲突：本场身份/性别与真名表矛盾',
          '· 边界可疑：本场开头或结尾明显属于另一场',
          '· 情节矛盾：本场与前情或已知关系无法自洽',
            '',
            '【本段原文】', chunk.join('\n'),
          ].join('\n');

          let part = await callModel(prompt);
          if (!part || !Array.isArray(part['人物']) || !Array.isArray(part['情节'])) {
            const strict = await callModel(prompt + '\n\n上一次输出不合格。必须包含「人物」数组与「情节」数组，只输出合法 JSON。');
            part = strict;
          }
          if (!part || !Array.isArray(part['情节'])) { failed = '第 ' + (ci + 1) + ' 段生成失败'; break; }

          for (const person of part['人物'] || []) {
            const name = String(person['姓名'] || '').trim();
            if (!name) continue;
            if (!people.has(name)) people.set(name, { ...person, 姓名: name });
            else {
              const prev = people.get(name);
              prev['在本场做的事'] = [prev['在本场做的事'], person['在本场做的事']].filter(Boolean).join('；');
              if (!prev['衣着容貌'] && person['衣着容貌']) prev['衣着容貌'] = person['衣着容貌'];
              if (!prev['处境现状'] && person['处境现状']) prev['处境现状'] = person['处境现状'];
              const parts = prev['身体部位'] || [];
              for (const bp of person['身体部位'] || []) {
                if (!parts.some((x) => x['部位'] === bp['部位'])) parts.push(bp);
              }
              prev['身体部位'] = parts;
            }
          }
          for (const step of part['情节'] || []) {
            const content = String(step['内容'] || '').trim();
            if (content) steps.push({ 步骤: steps.length + 1, 内容: content });
          }
          for (const d of part['疑点'] || []) if (d) doubts.add(String(d));
        }

        if (failed) { sendJson(response, { error: failed }, 500); return; }

        const detail = {
          人物: [...people.values()],
          情节: steps,
          疑点: [...doubts],
        };
        const sentenceCount = to - from + 1;
        const problem = validateDetail(detail, sentenceCount);
        const pronounHits = (JSON.stringify(detail).match(/[他她]们?|其|此人|对方|那人/g) || []).length;
        const outFile = path.join(dirs.l2, 'scene-details.json');
        withJsonLock(outFile, () => {
        const store = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { details: {}, index: {} };
        store.index = store.index || {};
        const detailId = store.details[sceneId]?.detailId || 'SD' + String(Object.keys(store.details).length + 1).padStart(3, '0');
        store.details[sceneId] = {
          ...detail, detailId, sceneId,
          chunks: chunks.length,
          clean: pronounHits === 0,
          pronounHits,
          problem,
          generatedAt: new Date().toISOString(),
        };
        store.index[detailId] = sceneId;
        writeJsonAtomic(outFile, store);
        sendJson(response, { ok: true, sceneId, detailId, chunks: chunks.length, problem, detail: store.details[sceneId] });
        });
        return;
      }

      // 场景切分：进度
      if (url.pathname === '/api/scenes/progress' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const book = fs.existsSync(dirs.book) ? JSON.parse(fs.readFileSync(dirs.book, 'utf8')) : null;
        let total = 0;
        if (book) for (const c of book.chapters || []) for (const p of c.paragraphs || []) total += (p.sentences || []).length;

        const readRanges = (file) => {
          const out = [];
          if (!fs.existsSync(file)) return out;
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { const r = JSON.parse(line); out.push([Number(String(r.from).slice(1)), Number(String(r.to).slice(1))]); } catch { /* 忽略 */ }
          }
          return out;
        };
        const partialFile = path.join(dirs.l2, 'scenes.partial.jsonl');
        const finalFile = path.join(dirs.l2, 'scenes-llm.json');
        let ranges = readRanges(partialFile);
        if (!ranges.length && fs.existsSync(finalFile)) {
          ranges = (JSON.parse(fs.readFileSync(finalFile, 'utf8')).scenes || []).map((s) => [Number(String(s.from).slice(1)), Number(String(s.to).slice(1))]);
        }
        const covered = new Set();
        for (const [f, t2] of ranges) for (let n = f; n <= t2; n += 1) covered.add(n);
        const progressFile = path.join(dirs.l2, 'scenes.progress.json');
        const chaptersDone = fs.existsSync(progressFile) ? (JSON.parse(fs.readFileSync(progressFile, 'utf8')).chapters || []).length : 0;
        sendJson(response, {
          total, done: covered.size, percent: total ? Math.round((covered.size / total) * 100) : 0,
          chaptersDone, chaptersTotal: (book?.chapters || []).length,
          running: fs.existsSync(partialFile),
        });
        return;
      }

      // 场景切分：重新切分全书（清空旧结果 → 全量模型切分 → 按 120 句上限再切）
      if (url.pathname === '/api/scenes/segment' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const bookId = String(body.id || '');
        const dirs = layout(path.join(root, bookId));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const target = path.join(dirs.l2, 'scenes-llm.json');
        const { spawnSync } = await import('node:child_process');
        // 清空旧结果与进度，确保全量重切
        for (const name of ['scenes-llm.json', 'scenes.progress.json', 'scenes.partial.jsonl']) {
          const f = path.join(dirs.l2, name);
          if (fs.existsSync(f)) fs.rmSync(f, { force: true });
        }
        const run = spawnSync(process.execPath, ['tools/segment-scenes-llm.mjs', dirs.book, target], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 6 * 3600 * 1000,
          env: { ...process.env, CORPUS_MODEL: resolveLlmConfig(root, false).model },
        });
        if (run.status !== 0) { sendJson(response, { error: (run.stderr || run.stdout || '切分失败').slice(-300) }, 500); return; }
        // 按 120 句上限二次切分
        const split = spawnSync(process.execPath, ['tools/split-long-scenes.mjs', path.join(root, bookId), '120'], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 600 * 1000,
        });
        const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
        sendJson(response, {
          ok: true, added: doc.scenes.length, kept: 0, totals: doc.totals,
          splitLog: (split.stdout || '').trim().split('\n').slice(-2),
        });
        return;
      }

      // 场景详述：分段生成（每段约 3000 字），合并人物与情节，避免长场景被截断
      if (url.pathname === '/api/scenes/detail' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const id = String(body.id || '');
        const sceneId = String(body.sceneId || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const scenesFile = path.join(dirs.l2, 'scenes-llm.json');
        if (!fs.existsSync(scenesFile)) { sendJson(response, { error: '还没有场景切分' }, 400); return; }
        const scene = (JSON.parse(fs.readFileSync(scenesFile, 'utf8')).scenes || []).find((s) => s.sceneId === sceneId);
        if (!scene) { sendJson(response, { error: '没有这个场景' }, 404); return; }

        const book = JSON.parse(fs.readFileSync(dirs.book, 'utf8'));
        const from = Number(String(scene.from).slice(1));
        const to = Number(String(scene.to).slice(1));
        const lines = [];
        for (const c of book.chapters) for (const p of c.paragraphs || []) for (const s of p.sentences || []) {
          const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
          if (n >= from && n <= to) lines.push(n + '. ' + String(s.text || ''));
        }

        const charFile = path.join(dirs.l2, 'characters.json');
        const characters = fs.existsSync(charFile) ? (JSON.parse(fs.readFileSync(charFile, 'utf8')).characters || []) : [];
        const relFile = path.join(dirs.l2, 'relations.json');
        const relations = fs.existsSync(relFile) ? (JSON.parse(fs.readFileSync(relFile, 'utf8')).relations || []) : [];
        const model = resolveLlmConfig(root, false).model;

        const callModel = async (prompt) => {
          const reply = await fetch('http://127.0.0.1:8090/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
            body: JSON.stringify({
              model, messages: [{ role: 'user', content: prompt }],
              stream: false, max_tokens: 16384, temperature: 0.2,
              reasoning_effort: 'none', response_format: { type: 'json_object' },
              signal: AbortSignal.timeout(1800000),
            }),
          });
          if (!reply.ok) return null;
          const data = await reply.json();
          return parseModelJson(String(data.choices?.[0]?.message?.content || ''));
        };

        // 分段：每段约 3000 字，按句子边界切
        const chunks = [];
        let buffer = [];
        let size = 0;
        for (const line of lines) {
          buffer.push(line);
          size += line.length;
          if (size >= 20000) { chunks.push(buffer); buffer = []; size = 0; }  // 单场景一次给完
        }
        if (buffer.length) chunks.push(buffer);

        const people = new Map();
        const steps = [];
        const doubts = new Set();
        let failed = '';

        for (let ci = 0; ci < chunks.length; ci += 1) {
          const chunk = chunks[ci];
          const prompt = [
            '角色表：', characters.map((c) => c.id + ' ' + c.name).join(' / ') || '（无）',
            '',
            '角色关系（可参考）：', relations.slice(0, 30).map((r) => r.fromName + '-' + r.type + '->' + r.toName).join('；') || '（无）',
            '',
            '这是同一个场景的第 ' + (ci + 1) + '/' + chunks.length + ' 段原文（每行以句子号开头）。',
            '请只针对本段输出：',
            '1. 本段出场人物：真名、衣着容貌、身体部位（按原文顺序）、处境现状、本段做了什么',
            '2. 情节经过：按动作逐步拆解，一步写一个动作变化（谁用哪个部位、碰/插入/揉捏/撕开哪里、体位变化、衣物状态、身体反应、说了什么）',
            '   禁止概括，原文每 2–4 句至少一步',
            '3. 疑点',
            '',
            '硬性要求：',
            '· 不使用人称代词（他/她/其/此人/对方），一律写真名',
            '· 人物身份依据原文，不许预设标签',
            '',
            '只返回 JSON：',
            '{"人物":[{"姓名":"真名","身份":"…","衣着容貌":"…","身体部位":[{"部位":"大腿","状态":"…"}],"处境现状":"…","在本场做的事":"…"}],',
            ' "情节":[{"步骤":1,"内容":"…"}],',
            ' "疑点":["…"]}',
            '',
            '【本段原文】', chunk.join('\n'),
          ].join('\n');

          let part = await callModel(prompt);
          if (!part || !Array.isArray(part['人物']) || !Array.isArray(part['情节'])) {
            const strict = await callModel(prompt + '\n\n上一次输出不合格。必须包含「人物」数组与「情节」数组，只输出合法 JSON。');
            part = strict;
          }
          if (!part || !Array.isArray(part['情节'])) { failed = '第 ' + (ci + 1) + ' 段生成失败'; break; }

          for (const person of part['人物'] || []) {
            const name = String(person['姓名'] || '').trim();
            if (!name) continue;
            if (!people.has(name)) people.set(name, { ...person, 姓名: name });
            else {
              const prev = people.get(name);
              prev['在本场做的事'] = [prev['在本场做的事'], person['在本场做的事']].filter(Boolean).join('；');
              if (!prev['衣着容貌'] && person['衣着容貌']) prev['衣着容貌'] = person['衣着容貌'];
              if (!prev['处境现状'] && person['处境现状']) prev['处境现状'] = person['处境现状'];
              const parts = prev['身体部位'] || [];
              for (const bp of person['身体部位'] || []) {
                if (!parts.some((x) => x['部位'] === bp['部位'])) parts.push(bp);
              }
              prev['身体部位'] = parts;
            }
          }
          for (const step of part['情节'] || []) {
            const content = String(step['内容'] || '').trim();
            if (content) steps.push({ 步骤: steps.length + 1, 内容: content });
          }
          for (const d of part['疑点'] || []) if (d) doubts.add(String(d));
        }

        if (failed) { sendJson(response, { error: failed }, 500); return; }

        const detail = {
          人物: [...people.values()],
          情节: steps,
          疑点: [...doubts],
        };
        const sentenceCount = to - from + 1;
        const problem = validateDetail(detail, sentenceCount);
        const pronounHits = (JSON.stringify(detail).match(/[他她]们?|其|此人|对方|那人/g) || []).length;
        const outFile = path.join(dirs.l2, 'scene-details.json');
        withJsonLock(outFile, () => {
        const store = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { details: {}, index: {} };
        store.index = store.index || {};
        const detailId = store.details[sceneId]?.detailId || 'SD' + String(Object.keys(store.details).length + 1).padStart(3, '0');
        store.details[sceneId] = {
          ...detail, detailId, sceneId,
          chunks: chunks.length,
          clean: pronounHits === 0,
          pronounHits,
          problem,
          generatedAt: new Date().toISOString(),
        };
        store.index[detailId] = sceneId;
        writeJsonAtomic(outFile, store);
        sendJson(response, { ok: true, sceneId, detailId, chunks: chunks.length, problem, detail: store.details[sceneId] });
        });
        return;
      }

      // 场景切分：对某本书跑模型切分，结果增量并入工程
      if (url.pathname === '/api/scenes/segment' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const bookId = String(body.id || '');
        const dirs = layout(path.join(root, bookId));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const target = path.join(dirs.l2, 'scenes-llm.json');
        const { spawnSync } = await import('node:child_process');
        const tmp = path.join(process.cwd(), 'out', 'scenes-tmp-' + Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
        const result = spawnSync(process.execPath, ['tools/segment-scenes-llm.mjs', dirs.book, tmp], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 3 * 3600 * 1000,
          env: { ...process.env, CORPUS_MODEL: resolveLlmConfig(root, false).model },
        });
        if (result.status !== 0) { sendJson(response, { error: (result.stderr || result.stdout || '切分失败').slice(-300) }, 500); return; }
        const fresh = JSON.parse(fs.readFileSync(tmp, 'utf8'));
        withJsonLock(target, () => {
        const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
        const done = new Set((existing?.scenes || []).map((s) => s.chapterId));
        const keep = (existing?.scenes || []).filter((s) => done.has(s.chapterId));
        const added = (fresh.scenes || []).filter((s) => !done.has(s.chapterId));
        const scenes = [...keep, ...added];
        scenes.forEach((s, i) => { s.sceneId = 'SC' + String(i + 1).padStart(3, '0'); });
        const doc = {
          generatedAt: new Date().toISOString(),
          source: path.basename(dirs.book),
          mergeRule: '少于 20 句的场景并入同章前一场；增量并入，已有章节不重复切',
          totals: {
            chapters: fresh.totals?.chapters ?? 0,
            scenes: scenes.length,
            sentences: scenes.reduce((n, s) => n + (s.sentences || 0), 0),
            avgSentences: Number((scenes.reduce((n, s) => n + (s.sentences || 0), 0) / Math.max(1, scenes.length)).toFixed(1)),
            modelChapters: fresh.totals?.modelChapters ?? 0,
            ruleChapters: fresh.totals?.ruleChapters ?? 0,
          },
          scenes,
        };
        writeJsonAtomic(target, doc);
        try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
        sendJson(response, { ok: true, added: added.length, kept: keep.length, totals: doc.totals });
        });
        return;
      }

      // 场景切分结果（模型切分，句子号区间）
      if (url.pathname === '/api/scenes/llm' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const file = path.join(dirs.l2, 'scenes-llm.json');
        if (!fs.existsSync(file)) { sendJson(response, { error: '这本书还没有场景切分结果' }, 404); return; }
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        let sourceScenes = doc.scenes || [];
        if (hasSqliteBook(storage, dirs)) {
          const db = openReadDb(dirs.root);
          try { sourceScenes = scenesFromDb(db, id, sourceScenes); }
          finally { db.close(); }
        }
        const book = fs.existsSync(dirs.book) ? JSON.parse(fs.readFileSync(dirs.book, 'utf8')) : null;
        const textOf = {};
        if (book) {
          for (const chapter of book.chapters || []) {
            for (const para of chapter.paragraphs || []) {
              for (const s of para.sentences || []) {
                const num = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
                if (num) textOf['S' + num] = s.text;
              }
            }
          }
        }
        const scenes = sourceScenes.map((scene) => {
          const from = Number(String(scene.from).slice(1));
          const to = Number(String(scene.to).slice(1));
          const parts = [];
          for (let n = from; n <= to; n += 1) { const s = textOf['S' + n]; if (s) parts.push(s); }
          const full = parts.join('\n');
          const lineList = [];
          for (let n = from; n <= to; n += 1) { const t = textOf[n] ?? textOf['S' + n]; if (t) lineList.push({ n, text: t }); }
          return { ...scene, preview: full.slice(0, 60), text: full, chars: full.length, lines: lineList };
        });
        sendJson(response, { ...doc, scenes });
        return;
      }

      // 读取某本书的编号结构（章/段/句）
      if (url.pathname === '/api/book/numbered' && request.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const book = JSON.parse(fs.readFileSync(dirs.book, 'utf8'));
        const chapters = [];
        const paragraphs = [];
        const sentences = [];
        for (const chapter of book.chapters || []) {
          const pids = [];
          for (const para of chapter.paragraphs || []) {
            pids.push(para.id);
            const list = para.sentences || [];
            paragraphs.push({ id: para.id, from: list[0]?.id || para.id, to: list[list.length - 1]?.id || para.id, chars: (para.text || '').length, sentences: list.length });
            for (const s of list) sentences.push({ id: String(s.id || '').replace(/^.*?(S\d+)$/, '$1'), text: s.text, chars: (s.text || '').length });
          }
          chapters.push({ id: chapter.id, title: chapter.title || chapter.id, paragraphs: pids });
        }
        sendJson(response, { bookName: book.title || id, chapters, paragraphs, sentences });
        return;
      }

      // 清洗：用户提供的章节标题参考
      if (url.pathname === '/api/clean/reference' && request.method === 'GET') {
        const ref = readCleanReference();
        sendJson(response, { ok: true, reference: ref });
        return;
      }

      if (url.pathname === '/api/clean/reference' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const ref = String(body.reference || '').slice(0, 2000);
        saveCleanReference(ref);
        sendJson(response, { ok: true, reference: ref });
        return;
      }

      // 小说清洗（直接调用 novel-clean 的核心，不再起独立服务）
      if (url.pathname === '/api/clean/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const name = String(body.name || '未命名.txt');
        const rawContent = typeof body.content === 'string' ? body.content : '';
        // 源稿常见把空格/换行转成 HTML 实体（&#x20; 等），先还原成正常字符
        const unescapeEntities = (text) => String(text || '')
          .replace(/&#x20;/gi, ' ')
          .replace(/&nbsp;|&#160;/gi, ' ')
          .replace(/&#12288;/g, '\u3000')
          .replace(/&#10;|&#xA;/gi, '\n')
          .replace(/&#9;|&#x9;/gi, '\t')
          .replace(/&quot;|&#34;/gi, '"')
          .replace(/&#39;|&apos;/gi, "'")
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&amp;/gi, '&');
        const content = unescapeEntities(rawContent);
        if (!content.trim()) { sendJson(response, { error: '没有收到正文' }, 400); return; }
        const cleanRoot = 'C:\\Users\\win\\Documents\\deepseek-harness\\default-workspace\\novel-clean';
        try {
          const pipelinePath = path.join(cleanRoot, 'core', 'pipeline.mjs');
          const { runClean } = await import(requireUrl(pipelinePath));
          let aiClient = null;
          if (body.ai) {
            try {
              const aiPath = path.join(cleanRoot, 'core', 'ai.mjs');
              const aiMod = await import(requireUrl(aiPath));
              const config = resolveLlmConfig(root, false);
              const Client = aiMod.OllamaClient || aiMod.default;
              if (Client) aiClient = new Client({ baseUrl: 'http://127.0.0.1:8090', model: config.model, timeoutMs: 900000 });
            } catch { aiClient = null; }
          }
          const result = await runClean({
            buffer: Buffer.from(content, 'utf8'),
            name,
            options: { ai: Boolean(aiClient), indent: 5, bookName: String(body.bookName || '').trim() },
            aiClient,
            onProgress: () => {},
          });
          const renumbered = renumberDuplicateHeadings(result.text);
          if (renumbered.changed) console.log('章节标题重复，已重编号 ' + renumbered.changed + ' 章');
          const structured = await buildStructuredBookAsync(renumbered.text, String(body.bookName || name.replace(/\.[^.]+$/, '')), resolveLlmConfig(root, false).model);
          try {
            fs.writeFileSync('work/.config/last-clean.json', JSON.stringify({
              at: new Date().toISOString(), name, bookName: structured.bookName,
              chapterCount: structured.chapterCount, warnings: structured.warnings || [],
              structuredText: structured.structured,
            }, null, 1), 'utf8');
          } catch { /* 忽略 */ }
          sendJson(response, {
            ok: true,
            name,
            bookName: structured.bookName,
            chapterCount: structured.chapterCount,
            chapterWarnings: structured.warnings || [],
            chapters: structured.chapters,
            structuredText: structured.structured,
            cleanDoc: structured.cleanDoc,
            summary: result.summary,
            issues: (result.issues || []).slice(0, 200),
            issueCount: (result.issues || []).length,
            text: result.text,
          });
        } catch (error) {
          sendJson(response, { error: '清洗失败：' + (error.message || error) }, 500);
        }
        return;
      }

      // 把清洗结果直接送去编号
      if (url.pathname === '/api/clean/number' && request.method === 'POST') {
        const cleanJobs = 'C:\\Users\\win\\Documents\\deepseek-harness\\default-workspace\\novel-clean\\.data\\jobs';
        if (!fs.existsSync(cleanJobs)) { sendJson(response, { error: '找不到清洗工程的数据目录' }, 400); return; }
        const files = fs.readdirSync(cleanJobs).filter((name) => name.endsWith('.json'));
        // 优先选"有正文且体量最大"的最近一次清洗，避免误取小测试文件
        const candidates = [];
        for (const name of files) {
          const full = path.join(cleanJobs, name);
          const stat = fs.statSync(full);
          candidates.push({ file: full, mtime: stat.mtimeMs, name, size: stat.size });
        }
        candidates.sort((a, b) => b.mtime - a.mtime);
        // 在最近 6 份里挑正文最长的那份
        let newest = null;
        for (const candidate of candidates.slice(0, 6)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(candidate.file, 'utf8'));
            const text = String(parsed.text || parsed.cleanText || '');
            if (!newest || text.length > newest.textLength) newest = { ...candidate, textLength: text.length, parsed };
          } catch { /* 坏文件跳过 */ }
        }
        newest = newest || candidates[0] || null;
        if (!newest) { sendJson(response, { error: '还没有清洗结果，先在清洗界面跑一次' }, 400); return; }
        const job = newest.parsed || JSON.parse(fs.readFileSync(newest.file, 'utf8'));
        const text = String(job.text || job.cleanText || '');
        if (!text.trim()) { sendJson(response, { error: '这份清洗结果没有正文' }, 400); return; }
        const uploadDir = path.join(process.cwd(), 'out', 'uploads');
        fs.mkdirSync(uploadDir, { recursive: true });
        const name = (job.title || job.name || path.basename(newest.file, '.json')).replace(/[\\/:*?"<>|]/g, '_') + '.txt';
        const file = path.join(uploadDir, name);
        fs.writeFileSync(file, text, 'utf8');
        const outDir = path.join(process.cwd(), 'out');
        const outFile = path.join(outDir, path.basename(file, '.txt') + '.bottomup.json');
        const { spawnSync } = await import('node:child_process');
        const result = spawnSync(process.execPath, ['tools/number-bottomup.mjs', file, '-o', outFile], { cwd: process.cwd(), encoding: 'utf8', timeout: 600000 });
        if (result.status !== 0) { sendJson(response, { error: (result.stderr || result.stdout || '编号失败').slice(-400) }, 500); return; }
        const doc = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        sendJson(response, {
          ok: true,
          name,
          numbered: outFile,
          chapters: doc.totals?.chapters ?? 0,
          paragraphs: doc.totals?.paragraphs ?? 0,
          sentences: doc.totals?.sentences ?? 0,
          coverage: doc.coverage || null,
          warnings: doc.warnings || [],
          doc: {
            bookName: cleanDoc ? String(cleanDoc['书名'] || '') : '',
            toc: cleanDoc ? (cleanDoc['目录'] || []) : [],
            chapters: doc.chapters, paragraphs: doc.paragraphs, sentences: doc.sentences,
          },
        });
        return;
      }

      // 小说内容编号：调用 novel-numerizer（Python，零依赖）
      if (url.pathname === '/api/number/run' && request.method === 'POST') {
        // 清洗 JSON 直接送进来：只对正文编号
        const body = JSON.parse(await readBody(request));
        let file = String(body.file || '');
        const cleanDoc = body.cleanDoc && typeof body.cleanDoc === 'object' ? body.cleanDoc : null;
        const content = cleanDoc ? String(cleanDoc['正文'] || '') : (typeof body.content === 'string' ? body.content : '');
        const name = String(body.name || (cleanDoc && cleanDoc['书名']) || (file ? path.basename(file) : 'upload.txt'));
        if (content) {
          const uploadDir = path.join(process.cwd(), 'out', 'uploads');
          fs.mkdirSync(uploadDir, { recursive: true });
          file = path.join(uploadDir, name);
          fs.writeFileSync(file, content, 'utf8');
        }
        if (!file || !fs.existsSync(file)) { sendJson(response, { error: '没有收到文本内容' }, 400); return; }
        const outDir = path.join(process.cwd(), 'out');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, path.basename(file, path.extname(file)) + '.bottomup.json');
        const examples = Array.isArray(body.examples) ? body.examples.filter(Boolean) : [];
        const { spawnSync } = await import('node:child_process');
        const argv = ['tools/number-bottomup.mjs', file, '-o', outFile];
        if (examples.length) argv.push('--examples', JSON.stringify(examples));
        const result = spawnSync(process.execPath, argv, { cwd: process.cwd(), encoding: 'utf8', timeout: 600000 });
        if (result.status !== 0) { sendJson(response, { error: (result.stderr || result.stdout || '编号失败').slice(-400) }, 500); return; }
        const doc = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        sendJson(response, {
          ok: true,
          numbered: outFile,
          chapters: doc.totals?.chapters ?? 0,
          paragraphs: doc.totals?.paragraphs ?? 0,
          sentences: doc.totals?.sentences ?? 0,
          coverage: doc.coverage || null,
          warnings: doc.warnings || [],
          doc: { chapters: doc.chapters, paragraphs: doc.paragraphs, sentences: doc.sentences },
          log: (result.stdout || '').trim().split('\n').slice(-6),
        });
        return;
      }

      // 把编号 JSON 转成书籍工程
      if (url.pathname === '/api/number/import' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const numbered = String(body.numbered || '');
        const title = String(body.title || '').trim() || path.basename(numbered).replace(/\.(numbered|bottomup)\.json$/i, '').replace(/\.json$/i, '');
        if (!fs.existsSync(numbered)) { sendJson(response, { error: '找不到编号文件' }, 400); return; }
        const workDir = path.join(root, title);
        try {
          const { spawnSync } = await import('node:child_process');
          const result = spawnSync(process.execPath, ['tools/import-bottomup.mjs', numbered, workDir], { cwd: process.cwd(), encoding: 'utf8', timeout: 300000 });
          if (result.status !== 0) { sendJson(response, { error: (result.stderr || result.stdout || '导入失败').slice(-300) }, 500); return; }
          sendJson(response, { ok: true, work: workDir, updated: false, log: (result.stdout || '').trim().split('\n') });
        } catch (error) {
          sendJson(response, { error: error.message }, 500);
        }
        return;
      }

      if (url.pathname === '/api/pipeline/control' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const dirs = layout(path.join(root, String(body.book || '')));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const action = String(body.action || '');
        const pausedFile = path.join(dirs.root, '.paused');
        if (action === 'pause') {
          fs.writeFileSync(pausedFile, new Date().toISOString(), 'utf8');
          const running = pipelineStatus(dirs.root).steps.filter((step) => step.status === 'running');
          const killed = killBookProcesses(String(body.book));
          for (const step of running) {
            writeStepState(dirs.root, step.id, { status: 'paused', finishedAt: new Date().toISOString(), error: null });
          }
          sendJson(response, { ok: true, paused: true, killed, message: killed ? '已暂停，进度已保存' : '已暂停（当前没有在跑的进程）' });
          return;
        }
        if (action === 'resume') {
          try { fs.rmSync(pausedFile, { force: true }); } catch { /* 忽略 */ }
          // 找出被暂停的那一步，直接重启它
          const stateFile = path.join(dirs.root, 'pipeline-state.json');
          let pausedStep = null;
          try {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            for (const [stepId, record] of Object.entries(state.steps || {})) {
              if (record && record.status === 'paused') pausedStep = stepId;
            }
          } catch { /* 没有状态文件 */ }
          if (!pausedStep) {
            sendJson(response, { ok: true, paused: false, message: '已恢复；没有找到被暂停的步骤' });
            return;
          }
          writeStepState(dirs.root, pausedStep, { status: 'idle', error: null });
          sendJson(response, { ok: true, paused: false, resumeStep: pausedStep, message: '已恢复，启动 ' + pausedStep });
          return;
        }
        if (action === 'stop') {
          {
            const running = pipelineStatus(dirs.root).steps.filter((step) => step.status === 'running');
            const killed = killBookProcesses(String(body.book));
            for (const step of running) {
              writeStepState(dirs.root, step.id, { status: 'failed', finishedAt: new Date().toISOString(), error: '用户手动停止' });
            }
            sendJson(response, { ok: true, stopped: killed, message: killed ? '已停止' : '当前没有在跑的步骤' });
            return;
          }
        }
        sendJson(response, { error: 'action 只能是 pause / resume / stop' }, 400);
        return;
      }

      if (url.pathname === '/api/pipeline/run' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const bookId = String(body.book || '');
        const stepId = String(body.step || '');
        const dirs = layout(path.join(root, bookId));
        if (!fs.existsSync(dirs.book)) { sendJson(response, { error: '找不到这本书' }, 404); return; }

        const status = pipelineStatus(dirs.root);
        const step = status.steps.find((item) => item.id === stepId);
        if (!step) { sendJson(response, { error: '没有这一步' }, 404); return; }
        if (pipelineJobs.has(`${bookId}:${stepId}`)) { sendJson(response, { error: '这一步正在跑' }, 409); return; }

        const missing = step.deps
          .map((dep) => status.steps.find((item) => item.id === dep))
          .filter((dep) => dep && dep.status !== 'done');
        if (missing.length) {
          sendJson(response, {
            error: `上游未完成：${missing.map((dep) => dep.label).join('、')}`,
            missing: missing.map((dep) => ({ id: dep.id, label: dep.label, percent: dep.percent })),
          }, 400);
          return;
        }

        const model = String(body.model || '').trim();
        const definition = STEPS.find((item) => item.id === stepId);
        // cli.mjs 用 --work 指定书；tools/*.mjs 把书目录当第一个位置参数
        const args = definition.cmd[0] === 'cli.mjs'
          ? [definition.cmd[0], ...definition.cmd.slice(1), '--work', dirs.root, '--config', 'config.gateway.json']
          : [definition.cmd[0], dirs.root, ...definition.cmd.slice(1)];
        const logFile = path.join(dirs.logs, `pipeline-${stepId}.log`);
        ensureDir(dirs.logs);
        const out = fs.openSync(logFile, 'a');
        // 选中的模型：cli.mjs 写一份临时配置，工具走环境变量
        const env = { ...process.env };
        if (model) {
          env.CORPUS_MODEL = model;
          env.CORPUS_BASE_URL = 'http://127.0.0.1:8090/v1';
          env.CORPUS_API_KEY = 'local';
          if (definition.cmd[0] === 'cli.mjs') {
            const runConfig = {
              provider: 'gateway',
              gatewayBaseUrl: 'http://127.0.0.1:8090/v1',
              apiKey: 'local',
              model,
              timeoutMs: 900000,
              concurrency: 1,
            };
            const configFile = path.join(dirs.root, 'config.run.json');
            writeJsonAtomic(configFile, runConfig, 2);
            const index = args.indexOf('--config');
            if (index >= 0) args[index + 1] = configFile;
          }
        }
        const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', out, out], env });
        pipelineJobs.set(`${bookId}:${stepId}`, child);
        writeStepState(dirs.root, stepId, { status: 'running', startedAt: new Date().toISOString(), error: null, log: logFile, before: step.done });

        child.on('exit', (code) => {
          pipelineJobs.delete(`${bookId}:${stepId}`);
          let error = null;
          if (code !== 0) {
            try {
              const tail = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-6).join(' / ');
              error = `退出码 ${code}：${tail}`.slice(0, 400);
            } catch { error = `退出码 ${code}`; }
          }
          let added = 0;
          if (code === 0) {
            const fresh = pipelineStatus(dirs.root).steps.find((item) => item.id === stepId);
            added = Math.max(0, (fresh?.done ?? 0) - (step.done ?? 0));
          }
          writeStepState(dirs.root, stepId, { status: code === 0 ? 'done' : 'failed', finishedAt: new Date().toISOString(), error, added });
        });

        sendJson(response, { started: true, step: stepId, log: logFile });
        return;
      }

      if (url.pathname === '/api/analyze' && request.method === 'POST') {
        if (running) { sendJson(response, { error: '已有任务在跑' }, 409); return; }
        const body = JSON.parse(await readBody(request));
        const bookId = String(body.work || '');
        const dirs = layout(path.join(root, bookId));
        const book = readJson(dirs.book, null);
        if (!book) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        const scenesDoc = readJson(dirs.l2Scenes, null);
        if (!scenesDoc?.scenes?.length) {
          sendJson(response, { error: '这本书还没有场景，请重新导入', needsImport: true }, 400);
          return;
        }
        // 点「继续分析」意味着恢复：清掉暂停标记，模型会在下一个请求时自动加载。
        setPaused(dirs, false);
        startAnalyzeJob({ root, bookId, book, dirs, scenes: scenesDoc.scenes, mode: String(body.mode || 'resume') });
        sendJson(response, { jobId: running?.id, total: scenesDoc.scenes.length, model: running?.model });
        return;
      }

      if (url.pathname === '/api/analyze/decide' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        if (running?.pendingResolve) {
          running.pendingResolve(String(body.decision) === 'stop' ? 'stop' : 'continue');
          sendJson(response, { ok: true });
        } else {
          sendJson(response, { ok: false, error: '当前没有等待决定的失败' }, 400);
        }
        return;
      }

      if (url.pathname === '/api/logs') {
        const id = url.searchParams.get('work') || '';
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        const file = url.searchParams.get('file');

        // 不带 file：列出这本书的所有日志
        if (!file) {
          let items = [];
          try {
            items = fs.readdirSync(dirs.logs).filter((name) => name.endsWith('.jsonl')).map((name) => {
              const full = path.join(dirs.logs, name);
              const stat = fs.statSync(full);
              const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).length;
              const kind = name.startsWith('session-') ? '对话' : name.startsWith('advise-') ? '顾问' : '运行';
              return { name, kind, size: stat.size, lines, at: stat.mtimeMs };
            }).sort((a, b) => b.at - a.at);
          } catch { items = []; }
          sendJson(response, { files: items });
          return;
        }

        // 带 file：只允许读这本书 logs 目录下的 .jsonl
        const safe = path.basename(String(file));
        const full = path.join(dirs.logs, safe);
        if (!safe.endsWith('.jsonl') || !full.startsWith(dirs.logs) || !fs.existsSync(full)) {
          sendJson(response, { error: '找不到这个日志' }, 404);
          return;
        }
        const raw = fs.readFileSync(full, 'utf8');
        const entries = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } });
        sendJson(response, { name: safe, entries });
        return;
      }

      if (url.pathname === '/api/library') {
        for (const book of listBooks(root)) ensureMeta(root, book.id);
        sendJson(response, listLibrary(root));
        return;
      }

      // 书库：把某本书的工程数据推送到 GitHub
      if (url.pathname === '/api/library/github' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const bookId = String(body.id || '');
        if (!bookId || !fs.existsSync(path.join(root, bookId))) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        try {
          const { execFileSync } = await import('node:child_process');
          const sanitize = (s) => String(s || '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'book';
          const repoName = sanitize(body.repo || ('corpus-book-' + bookId));
          const privateRepo = body.private !== false;
          const outDir = path.join(root, '.github-export', sanitize(bookId) + '-' + Date.now());
          fs.mkdirSync(outDir, { recursive: true });
          for (const f of ['book.json', 'meta.json']) {
            const src = path.join(root, bookId, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
          }
          fs.mkdirSync(path.join(outDir, 'l2'), { recursive: true });
          for (const f of ['scenes-llm.json', 'scene-details.json', 'characters.json', 'relations.json', 'mention-table.json', 'clean.json', 'segmentation.verify.json']) {
            const src = path.join(root, bookId, 'l2', f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, 'l2', f));
          }
          const fileList = fs.readdirSync(outDir, { recursive: true }).map(String).filter((x) => !x.includes('.git'));
          const manifest = { book: bookId, exportedAt: new Date().toISOString(), files: fileList };
          fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
          let scenes = 0;
          try { scenes = (JSON.parse(fs.readFileSync(path.join(outDir, 'l2', 'scenes-llm.json'), 'utf8')).scenes || []).length; } catch { /* 忽略 */ }
          const readme = ['# ' + bookId, '', '本书工程由 corpus-kit 导出。', '', '- 场景数：' + scenes, '- 导出时间：' + new Date().toISOString(), '', '## 目录', '', '- book.json 原文（章/段/句）', '- l2/scenes-llm.json 场景切分', '- l2/scene-details.json 场景详述', '- l2/characters.json 角色真名表', '- l2/relations.json 人物关系', '- manifest.json 文件清单'].join('\n');
          fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');
          const run = (args) => execFileSync('git', args, { cwd: outDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          run(['init']);
          run(['-c', 'user.name=corpus-kit', '-c', 'user.email=corpus-kit@local', 'add', '-A']);
          run(['-c', 'user.name=corpus-kit', '-c', 'user.email=corpus-kit@local', 'commit', '-m', String(body.message || ('导出：' + bookId))]);
          run(['branch', '-M', 'main']);
          if (body.dryRun) {
            sendJson(response, { ok: true, dryRun: true, dir: outDir, files: fileList.length });
            return;
          }
          const ghArgs = ['repo', 'create', repoName, privateRepo ? '--private' : '--public', '--source', '.', '--push', '--description', String(body.description || ('corpus-kit 工程：' + bookId))];
          const ghOut = execFileSync('gh', ghArgs, { cwd: outDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          const urlMatch = String(ghOut || '').match(/https:\/\/github\.com\/[^\s]+/);
          const repoUrl = urlMatch ? urlMatch[0] : '';
          try {
            const metaFile = path.join(root, bookId, 'meta.json');
            const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
            meta.github = { repo: repoName, url: repoUrl, private: privateRepo, at: new Date().toISOString() };
            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1), 'utf8');
          } catch { /* 忽略 */ }
          sendJson(response, { ok: true, repo: repoName, private: privateRepo, url: repoUrl, dir: outDir, files: fileList.length });
        } catch (error) {
          const detail = (error && (error.stderr || error.stdout)) ? String(error.stderr || error.stdout).slice(0, 400) : '';
          sendJson(response, { error: error.message + (detail ? '：' + detail : '') }, 500);
        }
        return;
      }
      // 书库：列出远端 GitHub 上的书籍工程仓库
      if (url.pathname === '/api/library/remote' && request.method === 'GET') {
        try {
          const { execFileSync } = await import('node:child_process');
          const raw = execFileSync('gh', ['repo', 'list', '--limit', '200', '--json', 'name,isPrivate,updatedAt,url,description'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          const list = JSON.parse(raw || '[]')
            .filter((r) => /^corpus-book-/.test(String(r.name || '')))
            .map((r) => ({
              repo: r.name,
              private: Boolean(r.isPrivate),
              url: r.url,
              updatedAt: r.updatedAt,
              description: r.description || '',
              bookId: String(r.name).replace(/^corpus-book-/, ''),
            }));
          sendJson(response, list);
        } catch (error) {
          sendJson(response, { error: '读取远端失败：' + error.message }, 500);
        }
        return;
      }

      // 书库：把远端仓库恢复到本地工程目录
      if (url.pathname === '/api/library/restore' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const repo = String(body.repo || '');
        if (!/^[\w.-]+\/[\w.-]+$|^corpus-book-[\w.-]+$/.test(repo)) { sendJson(response, { error: '仓库名不合法' }, 400); return; }
        try {
          const { execFileSync } = await import('node:child_process');
          const stampStr = Date.now();
          const tmp = path.join(root, '.github-restore', repo.replace(/[\\/]/g, '_') + '-' + stampStr);
          fs.mkdirSync(path.dirname(tmp), { recursive: true });
          execFileSync('gh', ['repo', 'clone', repo, tmp, '--', '--depth', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          const bookJson = path.join(tmp, 'book.json');
          if (!fs.existsSync(bookJson)) { sendJson(response, { error: '该仓库里没有 book.json，不是 corpus-kit 工程' }, 400); return; }
          const book = JSON.parse(fs.readFileSync(bookJson, 'utf8'));
          const bookId = String(body.id || book.title || repo.replace(/^corpus-book-/, '')).trim();
          const target = path.join(root, bookId);
          if (fs.existsSync(target)) {
            execFileSync('powershell', ['-NoProfile', '-Command', "Copy-Item -LiteralPath '" + target + "' -Destination '" + target + ".bak-" + stampStr + "' -Recurse -Force"], { stdio: 'ignore' });
          }
          fs.mkdirSync(path.join(target, 'l2'), { recursive: true });
          for (const f of ['book.json', 'meta.json', 'manifest.json']) {
            const src = path.join(tmp, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
          }
          const l2src = path.join(tmp, 'l2');
          if (fs.existsSync(l2src)) {
            for (const f of fs.readdirSync(l2src)) {
              const src = path.join(l2src, f);
              if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(target, 'l2', f));
            }
          }
          try {
            const metaFile = path.join(target, 'meta.json');
            const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
            meta.github = { repo, url: 'https://github.com/' + repo, at: new Date().toISOString() };
            meta.restoredAt = new Date().toISOString();
            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1), 'utf8');
          } catch { /* 忽略 */ }
          sendJson(response, { ok: true, bookId, dir: target, backup: fs.existsSync(target + '.bak-' + stampStr) ? target + '.bak-' + stampStr : '' });
        } catch (error) {
          const detail = (error && (error.stderr || error.stdout)) ? String(error.stderr || error.stdout).slice(0, 300) : '';
          sendJson(response, { error: error.message + (detail ? '：' + detail : '') }, 500);
        }
        return;
      }
      if (url.pathname === '/api/book/rename' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        try { sendJson(response, renameBook(root, String(body.id), String(body.title))); }
        catch (error) { sendJson(response, { error: error.message }, 400); }
        return;
      }

      if (url.pathname === '/api/book/delete' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        if (running && running.bookId === String(body.id)) { sendJson(response, { error: '这本书正在分析，先停掉再删' }, 409); return; }
        try { sendJson(response, deleteBook(root, String(body.id))); }
        catch (error) { sendJson(response, { error: error.message }, 400); }
        return;
      }

      if (url.pathname === '/api/books') { sendJson(response, listBooks(root)); return; }

      if (url.pathname.startsWith('/api/book/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/book/'.length));
        const book = loadBook(root, id);
        if (!book) { sendJson(response, { error: 'not found' }, 404); return; }
        sendJson(response, book);
        return;
      }

      if (url.pathname === '/api/advise' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const bookId = String(body.work || '');
        const dir = path.join(root, bookId);
        const book = readJson(path.join(dir, 'book.json'), null);
        if (!book) { sendJson(response, { error: '找不到这本书' }, 404); return; }
        if (!String(body.outline || '').trim()) { sendJson(response, { error: '请先写大纲' }, 400); return; }

        const config = resolveLlmConfig(root, false);
        const { llm } = buildLlm(config);
        const dirs = layout(dir);
        const sceneId = String(body.sceneId || '').trim();
        const people = Array.isArray(body.people)
          ? body.people.filter(Boolean)
          : String(body.people || '').split(/[,，、\s]+/).filter(Boolean);
        const result = sceneId
          ? await adviseWithContext({ dirs, llm, root }, { sceneId, outline: String(body.outline), people })
          : await advise({ dirs, llm, root }, { outline: String(body.outline), characters: String(body.characters || '') });
        if (!result) { sendJson(response, { error: '顾问没有给出合格结果，换个说法再试' }, 500); return; }
        if (result.错误) { sendJson(response, { error: result.错误 }, 404); return; }
        sendJson(response, result);
        return;
      }

      if (url.pathname === '/api/generate' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const bookId = String(body.work || '');
        const dir = path.join(root, bookId);
        if (!readJson(path.join(dir, 'book.json'), null)) { sendJson(response, { error: '找不到这本书' }, 404); return; }

        const config = resolveLlmConfig(root, false);
        const { llm } = buildLlm(config);
        const dirs = layout(dir);
        const useAdvice = Boolean(body.sceneId);
        const text = useAdvice
          ? await writeFromAdvice({ dirs, llm, root }, {
              outline: String(body.outline || ''),
              advice: body.advice || {},
              sceneId: String(body.sceneId || ''),
              people: Array.isArray(body.people) ? body.people : String(body.people || '').split(/[,，、\s]+/).filter(Boolean),
              length: Number(body.length || 1200),
            })
          : await writeProse({ dirs, llm, root }, {
          outline: String(body.outline || ''),
          advice: body.advice || {},
          characters: String(body.characters || ''),
          length: Number(body.length) || 900,
        });
        if (!text) { sendJson(response, { error: '生成失败，再试一次' }, 500); return; }
        sendJson(response, { text });
        return;
      }

      if (url.pathname === '/api/jobs') {
        // 章节进度直接从磁盘数：P1 每跑完一章就落一个 l1 文件，断了也能接着数。
        let chapters = null;
        if (running) {
          try {
            const dirs = layout(path.join(root, running.bookId));
            const total = running.chapterTotal || 0;
            const done = fs.readdirSync(dirs.l1).filter((name) => name.endsWith('.json')).length;
            chapters = { done, total };
          } catch { chapters = null; }
        }
        sendJson(response, { running: Boolean(running), jobs, chapters, pending: running?.pending || null });
        return;
      }

      if (url.pathname === '/api/reveal' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const dir = path.resolve(path.join(root, String(body.bookId || '.')));
        if (!dir.startsWith(path.resolve(root))) { sendJson(response, { error: '非法路径' }, 400); return; }
        if (!fs.existsSync(dir)) { sendJson(response, { error: '目录不存在' }, 404); return; }
        if (process.platform === 'win32') execFile('explorer.exe', [dir]);
        else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir]);
        sendJson(response, { ok: true, dir });
        return;
      }

      if (url.pathname === '/api/import' && request.method === 'POST') {
        if (running) { sendJson(response, { error: '已有任务在跑，等它结束再导入。' }, 409); return; }
        const body = JSON.parse(await readBody(request));
        const text = String(body.text || '');

        // 先解析再建目录：格式不合格就不该留下一个空书。
        let book;
        try {
          book = parseCorpusFile(text, body.name || 'book.txt');
        } catch (error) {
          if (error.name === 'CorpusFormatError') {
            sendJson(response, { error: error.message, detail: error.detail || '', format: true }, 400);
            return;
          }
          sendJson(response, { error: `解析失败：${error.message}` }, 400);
          return;
        }

        const base = sanitizeId(body.name);
        const id = uniqueId(root, base);
        const dirs = layout(path.join(root, id));
        try { fs.mkdirSync(dirs.l2, { recursive: true }); } catch { /* 忽略 */ }
        for (const dir of [dirs.l1, dirs.l2Analysis, dirs.l3, dirs.l4, dirs.stats, dirs.logs]) ensureDir(dir);

        const title = String(body.title || '').trim() || base;
        writeJson(dirs.book, book);
        // 清洗语料自带场景：直接落盘，P2 会跳过。
        if (Array.isArray(book.scenes) && book.scenes.length) {
          writeJson(dirs.l2Scenes, { scenes: book.scenes });
        }
        writeMeta(dirs.root, { title, source: body.name || '', addedAt: Date.now(), model: resolveLlmConfig(root, mock || Boolean(body.mock)).model || '' });

        // startJob 在第一个 await 之前就把 job 挂到 running 上，所以这里能同步取到 model。
        // 导入默认用本地 9B；只有明确传了模型或勾了混合模式才会走云端。
        const LOCAL_DEFAULT = 'qwen3.5:9b-uncensored-q8_0_64K';
        const hybrid = Boolean(body.hybrid);
        const chosen = String(body.model || '').trim();
        const model = hybrid ? '' : (chosen || LOCAL_DEFAULT);
        startJob({ root, bookId: id, book, mock: mock || Boolean(body.mock), limitScenes: body.limitScenes, model, hybrid, stepModels: body.stepModels });
        sendJson(response, {
          bookId: id,
          chapters: book.chapterCount,
          paragraphs: book.paragraphCount,
          jobId: running?.id,
          model: running?.model,
          mock: mock || Boolean(body.mock),
        });
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') { sendFile(response, path.join(here, 'ui', 'index.html')); return; }
      const asset = path.join(here, 'ui', path.basename(url.pathname));
      if (fs.existsSync(asset)) { sendFile(response, asset); return; }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
    } catch (error) {
      sendJson(response, { error: error.message || String(error) }, 500);
    }
  });

  return new Promise((resolve) => {
    // 长任务可能超过 Node 默认 5 分钟请求超时，这里放开
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(port, host, () => {
      resolve({ server, url: `http://${host}:${port}`, close: () => server.close() });
    });
  });
}

// 直接运行：起服务并打开浏览器。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const root = path.resolve(get('--root', 'work'));

  const port = Number(get('--port', 4173));
  const mock = args.includes('--mock');

  startApp({ root, port, mock }).then(({ url }) => {
    const books = listBooks(root);
    console.log(`语料工具已启动：${url}`);
    console.log(`语料目录：${root}`);
    console.log(`已有书目：${books.map((book) => book.title).join('、') || '（空）'}`);
    if (!args.includes('--no-open')) exec(`start "" "${url}"`);
  });
}

// 定时执行调度器：每 20 秒检查一次，到点启动工作流
setInterval(async () => {
  const list = globalThis.__workflowSchedules || [];
  if (!list.length) return;
  const now = Date.now();
  const due = list.filter((s) => new Date(s.at).getTime() <= now);
  if (!due.length) return;
  globalThis.__workflowSchedules = list.filter((s) => new Date(s.at).getTime() > now);
  for (const s of due) {
    try {
      if (globalThis.__workflowJob?.running) { console.log('定时任务跳过（已有任务在跑）:', s.id); continue; }
      const { spawn } = await import('node:child_process');
      const job = { running: true, from: s.from, to: s.to, startedAt: new Date().toISOString(), scheduled: true };
      globalThis.__workflowJob = job;
      const child = spawn(process.execPath, ['tools/workflow-run.mjs', path.join(root, s.id), String(s.from), String(s.to)], { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env } });
      child.on('exit', (code) => { job.running = false; job.code = code; globalThis.__workflowJob = null; });
      console.log('定时任务已启动:', s.id, s.from + '→' + s.to);
    } catch (error) { console.log('定时任务启动失败:', error.message); }
  }
}, 20000).unref();
