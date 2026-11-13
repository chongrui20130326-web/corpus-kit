import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';

/**
 * 导出书籍工程。
 *
 * 产物是一个**文件夹**，不是单个 JSON：
 *   <书名>.project/
 *     ├── project.json      原文 + 全部分析结果
 *     └── logs/             每次分析的对话日志与运行日志（独立文件，原样带上）
 *
 * 日志本身就是独立文件，硬塞进 JSON 会变成一大坨转义字符串，既不好读也不好转存。
 */
export const PROJECT_FORMAT = 'corpus-kit-project';
export const PROJECT_VERSION = 2;

export function buildProject(dirs, book) {
  const scenesDoc = readJson(dirs.l2Scenes, null);
  const scenes = scenesDoc?.scenes || [];
  const summaries = readJson(dirs.l2Summaries, null)?.scenes || {};
  const chains = readJson(dirs.l2Chains, null)?.scenes || {};
  const index = readJson(dirs.l3SceneIndex, null);
  const events = readJson(dirs.l3Events, null)?.events || [];
  const breakthrough = readJson(dirs.l3Breakthrough, null);
  const stages = readJson(dirs.l3Stages, null);

  const paragraphOf = new Map();
  for (const chapter of book.chapters) {
    for (const paragraph of chapter.paragraphs) paragraphOf.set(paragraph.id, paragraph);
  }

  const sceneRows = scenes.map((scene) => {
    const l4 = readJson(dirs.l4File(scene.sceneId), null);
    const analysis = readJson(dirs.l2File(scene.sceneId), null);
    const indexed = (index?.scenes || []).find((item) => item.sceneId === scene.sceneId) || {};

    // 场景覆盖到的段落，带原文和 sourceId，方便外部按 id 对齐。
    const start = paragraphOf.get(scene.从);
    const end = paragraphOf.get(scene.到);
    const ids = [];
    let cursor = false;
    for (const chapter of book.chapters) {
      for (const paragraph of chapter.paragraphs) {
        if (paragraph.id === scene.从) cursor = true;
        if (cursor) ids.push(paragraph.id);
        if (cursor && paragraph.id === scene.到) cursor = false;
      }
    }

    return {
      sceneId: scene.sceneId,
      从: scene.从,
      到: scene.到,
      段落: ids,
      段落数: ids.length,
      是否含情色: scene.是否含情色 !== false,
      阶段: indexed.阶段类型 || scene.阶段 || '',
      弧阶段: indexed.弧阶段 || '',
      权力: indexed.权力 || analysis?.权力 || '',
      轨迹: indexed.轨迹 || analysis?.轨迹 || null,
      摘要: summaries[scene.sceneId] || null,
      分析: analysis || null,
      动作链: chains[scene.sceneId] || null,
      承载句: l4?.承载句 || [],
      描写摘录: l4?.描写摘录 || [],
      转折句: l4?.转折句 || '',
    };
  });

  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    exportedAt: new Date().toISOString(),
    tool: 'corpus-kit',
    book: {
      title: book.title,
      source: book.source || '',
      chapterCount: book.chapterCount,
      paragraphCount: book.paragraphCount,
      charCount: book.charCount || 0,
    },
    chapters: book.chapters.map((chapter) => ({
      id: `ch-${String(chapter.index).padStart(4, '0')}`,
      index: chapter.index,
      title: chapter.title,
      paragraphs: chapter.paragraphs.map((paragraph) => ({
        id: paragraph.id,
        text: paragraph.text,
        sourceId: paragraph.sourceId || null,
      })),
    })),
    scenes: sceneRows,
    stages: stages?.stages || stages || [],
    breakthrough: breakthrough || null,
    events,
    stats: {
      scenes: sceneRows.length,
      scenesWithChain: sceneRows.filter((scene) => scene.动作链).length,
      excerpts: sceneRows.reduce((sum, scene) => sum + scene.描写摘录.length, 0),
      events: events.length,
    },
    logs: listLogs(dirs),
  };
}

/** 日志清单：工程里记录有哪些日志，实际文件放在 logs/ 子目录。 */
function listLogs(dirs) {
  try {
    return fs.readdirSync(dirs.logs)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const full = path.join(dirs.logs, name);
        const stat = fs.statSync(full);
        return {
          file: `logs/${name}`,
          kind: name.startsWith('session-') ? '对话' : name.startsWith('advise-') ? '顾问' : '运行',
          size: stat.size,
          at: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export function exportProject(dirs, book, outDir) {
  const project = buildProject(dirs, book);
  const target = outDir || path.join(dirs.root, `${sanitize(book.title)}.project`);

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  writeJson(path.join(target, 'project.json'), project);

  // 日志原样拷过去，不改内容。
  const logsDir = path.join(target, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  for (const item of project.logs) {
    try { fs.copyFileSync(path.join(dirs.logs, path.basename(item.file)), path.join(logsDir, path.basename(item.file))); } catch { /* 单份日志丢了不影响整体 */ }
  }

  return { path: target, project };
}

function sanitize(name) {
  return String(name || 'book').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

export function isProjectDoc(doc) {
  return doc?.format === PROJECT_FORMAT;
}
