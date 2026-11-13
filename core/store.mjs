import fs from 'node:fs';
import path from 'node:path';
import { withJsonLock, writeJsonAtomic } from './atomic-json.mjs';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, indent = 2) {
  return writeJsonAtomic(file, value, indent);
}

export function withFileLock(file, fn) {
  return withJsonLock(file, fn);
}

export function exists(file) {
  return fs.existsSync(file);
}

export function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** 工作目录布局。所有中间产物都以文件为检查点，改哪层只重跑哪层。 */
export function layout(work) {
  const root = path.resolve(work);
  return {
    root,
    book: path.join(root, 'book.json'),
    l1: path.join(root, 'l1'),
    l2: path.join(root, 'l2'),
    l2Scenes: path.join(root, 'l2', 'scenes.json'),
    l2Analysis: path.join(root, 'l2', 'analysis'),
    l2Summaries: path.join(root, 'l2', 'summaries.json'),
    l2Chains: path.join(root, 'l2', 'chains.json'),
    l3: path.join(root, 'l3'),
    l3Coarse: path.join(root, 'l3', 'stages-coarse.json'),
    l3Stages: path.join(root, 'l3', 'stages.json'),
    l3SceneIndex: path.join(root, 'l3', 'scene-index.json'),
    l3Breakthrough: path.join(root, 'l3', 'breakthrough.json'),
    l3Events: path.join(root, 'l3', 'events.json'),
    l4: path.join(root, 'l4'),
    stats: path.join(root, 'stats'),
    logs: path.join(root, 'logs'),
    l1File: (chapter) => path.join(root, 'l1', `ch-${String(chapter).padStart(4, '0')}.json`),
    l2File: (sceneId) => path.join(root, 'l2', 'analysis', `${sceneId}.json`),
    l4File: (sceneId) => path.join(root, 'l4', `${sceneId}.json`),
  };
}

/** 追加式运行日志：每次请求一行，便于事后核对模型到底返回了什么。 */
export function createLogger(logFile) {
  ensureDir(path.dirname(logFile));
  return (event) => {
    try {
      fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf-8');
    } catch {
      /* 日志失败不能影响主流程 */
    }
  };
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
