import { readJson, exists } from './store.mjs';

/**
 * 完整性校验。
 *
 * 回答一个问题：**原文是不是每一段都被分析了？**
 *
 * 之前按「情色段落连续」切场景，非情色的段落根本不属于任何场景，
 * 于是那些内容从来没被 P4/P7 看过——结果里就"漏了很多原文"，
 * 但界面上看不出漏了，因为没有对照。
 *
 * 这里逐段核对：段落是否归属于某一场、顺序是否连续、场景有没有分析产物。
 */

export function checkCoverage(book, dirs) {
  const scenesDoc = readJson(dirs.l2Scenes, null);
  const scenes = scenesDoc?.scenes || [];

  const all = [];
  for (const chapter of book.chapters) {
    for (const paragraph of chapter.paragraphs) {
      all.push({ id: paragraph.id, chapter: chapter.index, length: paragraph.text.length, sourceId: paragraph.sourceId || null });
    }
  }
  const order = new Map(all.map((item, index) => [item.id, index]));

  // 段落 → 所属场景
  const owner = new Map();
  const duplicates = [];
  for (const scene of scenes) {
    const start = order.get(scene.从);
    const end = order.get(scene.到);
    if (start === undefined || end === undefined) continue;
    for (let index = start; index <= end; index += 1) {
      const id = all[index].id;
      if (owner.has(id)) duplicates.push(id);
      owner.set(id, scene.sceneId);
    }
  }

  const uncovered = all.filter((item) => !owner.has(item.id));
  const coveredChars = all.filter((item) => owner.has(item.id)).reduce((sum, item) => sum + item.length, 0);
  const totalChars = all.reduce((sum, item) => sum + item.length, 0);

  // 场景产物
  const missingAnalysis = [];
  const missingSummary = [];
  const missingSentences = [];
  const summaries = readJson(dirs.l2Summaries, null)?.scenes || {};
  for (const scene of scenes) {
    if (!exists(dirs.l2File(scene.sceneId))) missingAnalysis.push(scene.sceneId);
    if (!summaries[scene.sceneId]) missingSummary.push(scene.sceneId);
    if (!exists(dirs.l4File(scene.sceneId))) missingSentences.push(scene.sceneId);
  }

  // 章覆盖
  const chapters = book.chapters.map((chapter) => {
    const total = chapter.paragraphs.length;
    const covered = chapter.paragraphs.filter((paragraph) => owner.has(paragraph.id)).length;
    return { index: chapter.index, title: chapter.title, total, covered, ok: covered === total };
  });

  // 顺序检查：场景应当首尾相接、单调递增
  let gaps = 0;
  let overlaps = 0;
  for (let index = 1; index < scenes.length; index += 1) {
    const prevEnd = order.get(scenes[index - 1].到);
    const nextStart = order.get(scenes[index].从);
    if (nextStart > prevEnd + 1) gaps += 1;
    if (nextStart <= prevEnd) overlaps += 1;
  }

  const total = all.length;
  return {
    段落: {
      总数: total,
      已覆盖: total - uncovered.length,
      覆盖率: total ? Math.round(((total - uncovered.length) / total) * 1000) / 10 : 0,
      未覆盖: uncovered.slice(0, 200).map((item) => ({ id: item.id, 章: item.chapter, 字数: item.length })),
      未覆盖数: uncovered.length,
      重复归属: duplicates.slice(0, 50),
    },
    字数: {
      总数: totalChars,
      已覆盖: coveredChars,
      覆盖率: totalChars ? Math.round((coveredChars / totalChars) * 1000) / 10 : 0,
    },
    场景: {
      总数: scenes.length,
      缺分析: missingAnalysis,
      缺摘要: missingSummary,
      缺句子层: missingSentences,
    },
    章: chapters,
    衔接: { 断档: gaps, 重叠: overlaps },
    ok:
      uncovered.length === 0 &&
      duplicates.length === 0 &&
      gaps === 0 &&
      overlaps === 0 &&
      missingAnalysis.length === 0 &&
      missingSummary.length === 0,
  };
}

export function formatReport(report) {
  const lines = [];
  const p = report.段落;
  lines.push(`段落　${p.已覆盖}/${p.总数}（${p.覆盖率}%）`);
  lines.push(`字数　${report.字数.已覆盖}/${report.字数.总数}（${report.字数.覆盖率}%）`);
  lines.push(`场景　${report.场景.总数} 场　缺分析 ${report.场景.缺分析.length}　缺摘要 ${report.场景.缺摘要.length}　缺句子层 ${report.场景.缺句子层.length}`);
  lines.push(`衔接　断档 ${report.衔接.断档}　重叠 ${report.衔接.重叠}`);

  const badChapters = report.章.filter((chapter) => !chapter.ok);
  if (badChapters.length) {
    lines.push('\n有缺口的章节：');
    for (const chapter of badChapters) lines.push(`  第${chapter.index}章　${chapter.covered}/${chapter.total}`);
  }
  if (p.未覆盖数) {
    lines.push(`\n未进入任何场景的段落（前 20）：`);
    for (const item of p.未覆盖.slice(0, 20)) lines.push(`  ${item.id}　第${item.章}章　${item.字数}字`);
  }
  lines.push(`\n结论　${report.ok ? '✓ 全部原文都已进入分析' : '✗ 有内容没被分析'}`);
  return lines.join('\n');
}
