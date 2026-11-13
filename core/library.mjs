import fs from 'node:fs';
import path from 'node:path';
import { isPaused } from './pause.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';

/**
 * 书库管理。
 *
 * 一本书一个目录，目录里除了分析产物还有一个 meta.json 记录来源、模型、时间。
 * 书多了以后，光靠目录名分不清谁是谁，所以列表要带上：
 * 完成度、场景数、动作链数、体积、最后更新时间。
 */

const META = 'meta.json';

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch { /* 忽略 */ } }
    }
  }
  return total;
}

export function readMeta(dir) {
  return readJson(path.join(dir, META), null) || {};
}

export function writeMeta(dir, patch) {
  const current = readMeta(dir);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  writeJsonAtomic(path.join(dir, META), next, 2);
  return next;
}

/** 分析进度：按场景统计完成/失败/未做。 */
export function analyzeState(dir) {
  const index = readJson(path.join(dir, 'l3', 'scene-index.json'));
  const scenesFile = readJson(path.join(dir, 'l2', 'scenes.json'));
  const scenes = scenesFile?.scenes || [];
  const total = scenes.length || index?.scenes?.length || 0;
  let done = 0;
  let failed = 0;
  try {
    for (const name of fs.readdirSync(path.join(dir, 'l2', 'analysis'))) {
      if (name.endsWith('.json')) done += 1;
    }
  } catch { /* 目录不存在 */ }
  for (const scene of scenes) {
    if (scene.状态 === 'failed') failed += 1;
    else if (scene.状态 === 'done') { /* 已计入 done */ }
  }
  return {
    total,
    done,
    failed,
    pending: Math.max(0, total - done),
    hasProject: Boolean(scenes.length),
    hasBriefs: scenes.filter((scene) => scene.简述).length,
  };
}

/** 列表：每本书一行，带完成度和体积。 */
export function listLibrary(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const book = readJson(path.join(dir, 'book.json'));
      if (!book) return null;

      const meta = readMeta(dir);
      const github = meta.github || null;
      const index = readJson(path.join(dir, 'l3', 'scene-index.json'));
      const scenes = index?.scenes?.length ?? 0;
      const l4 = countFiles(path.join(dir, 'l4'));
      const chains = Object.keys(readJson(path.join(dir, 'l2', 'chains.json'), { scenes: {} }).scenes || {}).length;
      const summaries = Object.keys(readJson(path.join(dir, 'l2', 'summaries.json'), { scenes: {} }).scenes || {}).length;
      const events = (readJson(path.join(dir, 'l3', 'events.json'), { events: [] }).events || []).length;

      const steps = [
        { key: '段落索引', done: countFiles(path.join(dir, 'l1')) >= (book.chapterCount || 1) },
        { key: '场景分析', done: scenes > 0 && l4 >= scenes },
        { key: '场景摘要', done: summaries >= scenes && scenes > 0 },
        { key: '动作链', done: chains > 0 },
        { key: '关键事件', done: events > 0 },
      ];

      return {
        id: entry.name, github,
        title: book.title || entry.name,
        paragraphs: book.paragraphCount || 0,
        chapters: book.chapterCount || 0,
        scenes,
        chains,
        summaries,
        events,
        l4,
        analyze: analyzeState(dir),
        paused: isPaused({ root: dir }),
        size: dirSize(dir),
        addedAt: meta.addedAt || fs.statSync(dir).birthtimeMs || 0,
        updatedAt: meta.updatedAt || fs.statSync(dir).mtimeMs || 0,
        model: meta.model || '',
        complete: steps.every((step) => step.done),
        steps,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length; } catch { return 0; }
}

/** 重命名：只改显示名，目录名不动，避免影响已有索引和路径。 */
export function renameBook(root, id, title) {
  const dir = path.join(root, id);
  const book = readJson(path.join(dir, 'book.json'), null);
  if (!book) throw new Error('找不到这本书');
  const clean = String(title || '').trim();
  if (!clean) throw new Error('书名不能为空');
  book.title = clean;
  writeJsonAtomic(path.join(dir, 'book.json'), book, 2);
  writeMeta(dir, { title: clean });
  return { id, title: clean };
}

/** 删除：整目录移除。调用方必须确认过路径在工作根目录下。 */
export function deleteBook(root, id) {
  const base = path.resolve(root);
  const dir = path.resolve(path.join(root, id));
  if (!dir.startsWith(base + path.sep)) throw new Error('非法路径');
  if (!fs.existsSync(dir)) throw new Error('找不到这本书');
  fs.rmSync(dir, { recursive: true, force: true });
  return { id };
}

export function ensureMeta(root, id, patch = {}) {
  const dir = path.join(root, id);
  if (!fs.existsSync(path.join(dir, 'book.json'))) return null;
  const meta = readMeta(dir);
  if (!meta.addedAt) return writeMeta(dir, { addedAt: Date.now(), ...patch });
  return meta;
}
