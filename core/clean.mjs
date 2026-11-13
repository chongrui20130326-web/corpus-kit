import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from './store.mjs';

/**
 * 书籍清洗。
 *
 * 把原始小说压成一份**带编号的完整语料**，之后所有分析都只读这一份：
 *
 *   corpus.json
 *     ├── chapters    章（编号 ch-0001）
 *     ├── paragraphs  段（编号 P0001）
 *     ├── sentences   句（编号 s0001，挂在段落下面）
 *     └── scenes      场景（编号 S01，挂在段落区间上）
 *
 * 好处：
 *   - 编号一次性定死，后面每一层都能引用同一套 id；
 *   - 分析阶段不再重新切分，只按场景取原文；
 *   - 清洗结果可以人工检查、手工改（改完再跑分析）；
 *   - 换模型重跑只影响分析，不影响切分。
 */

export const CORPUS_FORMAT = 'corpus-kit-corpus';
export const CORPUS_VERSION = 1;

const SENTENCE_END = /(?<=[。！？…]+)/;

/** 中文断句：按句末标点切，保留标点；过短的并到上一句。 */
export function splitSentences(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  const parts = value.split(SENTENCE_END).map((item) => item.trim()).filter(Boolean);
  const merged = [];
  for (const part of parts) {
    if (merged.length && part.length < 6) merged[merged.length - 1] += part;
    else merged.push(part);
  }
  return merged;
}

/**
 * 从 book.json（章 + 段）构建完整语料。
 * @param scenes 可选：已有的场景（l2/scenes.json），会一起写进语料。
 */
export function buildCorpus(book, scenes = []) {
  const chapters = [];
  const paragraphs = [];
  const sentences = [];
  let sentenceSeq = 0;

  book.chapters.forEach((chapter, chapterIndex) => {
    const chapterId = `ch-${String(chapter.index).padStart(4, '0')}`;
    chapters.push({
      id: chapterId,
      order: chapter.index,
      title: chapter.title || `第 ${chapter.index} 章`,
      paragraphIds: chapter.paragraphs.map((paragraph) => paragraph.id),
    });

    for (const paragraph of chapter.paragraphs) {
      const parts = splitSentences(paragraph.text);
      const sentenceIds = parts.map((text) => {
        sentenceSeq += 1;
        const id = `s${String(sentenceSeq).padStart(4, '0')}`;
        sentences.push({ id, paragraphId: paragraph.id, chapterId, order: sentenceSeq, text });
        return id;
      });

      paragraphs.push({
        id: paragraph.id,
        chapterId,
        order: paragraphs.length + 1,
        text: paragraph.text,
        charCount: paragraph.text.length,
        sentenceIds,
        sourceId: paragraph.sourceId || null,
      });
    }
  });

  const normalizedScenes = scenes.map((scene, index) => ({
    sceneId: scene.sceneId || `S${String(index + 1).padStart(2, '0')}`,
    order: index + 1,
    从: scene.从,
    到: scene.到,
    paragraphIds: paragraphRange(paragraphs, scene.从, scene.到),
    是否含情色: scene.是否含情色 !== false,
    跨章: scene.跨章,
    摘要: scene.摘要 || '',
  }));

  return {
    format: CORPUS_FORMAT,
    version: CORPUS_VERSION,
    builtAt: new Date().toISOString(),
    book: {
      title: book.title,
      source: book.source || '',
      chapterCount: chapters.length,
      paragraphCount: paragraphs.length,
      sentenceCount: sentences.length,
      charCount: paragraphs.reduce((sum, paragraph) => sum + paragraph.charCount, 0),
    },
    chapters,
    paragraphs,
    sentences,
    scenes: normalizedScenes,
  };
}

function paragraphRange(paragraphs, from, to) {
  const start = paragraphs.findIndex((paragraph) => paragraph.id === from);
  const end = paragraphs.findIndex((paragraph) => paragraph.id === to);
  if (start < 0 || end < start) return [];
  return paragraphs.slice(start, end + 1).map((paragraph) => paragraph.id);
}

/** 写语料到 <work>/corpus.json */
export function writeCorpus(dirs, corpus) {
  const file = path.join(dirs.root, 'corpus.json');
  writeJson(file, corpus);
  return file;
}

export function readCorpus(dirs) {
  try { return JSON.parse(fs.readFileSync(path.join(dirs.root, 'corpus.json'), 'utf8')); } catch { return null; }
}

/** 语料自检：编号连续、段落全覆盖、句子非空。 */
export function checkCorpus(corpus) {
  const problems = [];

  const paragraphIds = new Set(corpus.paragraphs.map((paragraph) => paragraph.id));
  const seen = new Map();
  for (const scene of corpus.scenes) {
    for (const id of scene.paragraphIds) {
      if (!paragraphIds.has(id)) problems.push(`${scene.sceneId} 引用了不存在的段落 ${id}`);
      if (seen.has(id)) problems.push(`段落 ${id} 同时属于 ${scene.sceneId} 和 ${seen.get(id)}`);
      seen.set(id, scene.sceneId);
    }
  }
  const uncovered = corpus.paragraphs.filter((paragraph) => !seen.has(paragraph.id));
  // 还没切场景时不报覆盖问题——那是 P2 的事，不是清洗的错。
  if (corpus.scenes.length && uncovered.length) problems.push(`${uncovered.length} 个段落不属于任何场景（首个 ${uncovered[0].id}）`);

  const emptySentences = corpus.sentences.filter((sentence) => !sentence.text.trim());
  if (emptySentences.length) problems.push(`${emptySentences.length} 个句子为空`);

  const badChapter = corpus.chapters.filter((chapter) => !chapter.paragraphIds.length);
  if (badChapter.length) problems.push(`${badChapter.length} 个章节没有段落`);

  return { ok: problems.length === 0, problems };
}
