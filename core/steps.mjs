import path from 'node:path';
import * as P from './prompts.mjs';
import * as V from './validate.mjs';
import { parseJsonObject } from './llm.mjs';
import { SYSTEM } from './prompts.mjs';
import { repairSceneAnalysis, repairSentences } from './repair.mjs';
import { listJson, readJson, writeJson, exists } from './store.mjs';
import { flatten } from './split.mjs';
import { segmentScenes } from './scenes.mjs';
import { segmentByChapters } from './scenesByChapter.mjs';

/** 段落属于哪一章（清洗阶段导入场景时用）。 */
function chapterIndexFromParagraph(book, paragraphId) {
  for (const chapter of book.chapters) {
    if (chapter.paragraphs.some((paragraph) => paragraph.id === paragraphId)) return chapter.index;
  }
  return 0;
}
import { classifyExcerpts } from './eroticFilter.mjs';

/**
 * 流水线各步。每一步都是「读上游文件 → 组 prompt → 调用 → 校验 → 落盘」，
 * 没有内存里的隐式状态，所以任意一步都可以单独重跑。
 */

const MAX_ATTEMPTS = 3;

/** 调用 + 解析 + 校验 + 带反馈重试。三次不过就返回 null，由调用方记录并跳过。 */
async function callJson(ctx, { step, meta, prompt, validate, normalize, maxTokens }) {
  let feedback = '';
  let lastErrors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let text = '';
    try {
      const response = await ctx.llm.chat({ system: SYSTEM, prompt: `${prompt}${feedback}`, step, meta, ...(maxTokens ? { maxTokens } : {}) });
      text = response.text;
      ctx.log({ step, attempt, target: meta?.label || '', status: 'response', raw: text.slice(0, 4000) });
    } catch (error) {
      lastErrors = [String(error.message || error)];
      ctx.log({ step, attempt, target: meta?.label || '', status: 'error', error: lastErrors[0] });
      if (attempt === MAX_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      continue;
    }

    let value;
    try {
      value = parseJsonObject(text);
    } catch (error) {
      lastErrors = [`返回内容不是 JSON：${error.message}`];
      feedback = '\n\n上次返回无法解析为 JSON。请只输出一个 JSON 对象，不要任何解释或代码围栏。';
      continue;
    }

    if (normalize) {
      try {
        value = normalize(value, meta);
      } catch (error) {
        ctx.log({ step, attempt, target: meta?.label || '', status: 'normalize-error', error: String(error) });
      }
    }

    const result = validate(value, meta);
    if (result.ok) return result.value;
    lastErrors = result.errors;
    ctx.log({ step, attempt, target: meta?.label || '', status: 'invalid', errors: result.errors.slice(0, 8) });
    feedback = `\n\n上次输出未通过校验，请修正后重新输出完整 JSON。问题清单：\n- ${result.errors.slice(0, 8).join('\n- ')}`;
  }
  ctx.log({ step, target: meta?.label || '', status: 'failed', errors: lastErrors.slice(0, 8) });
  return null;
}

/* ------------------------------ P1 章节索引 ------------------------------ */

/**
 * 把「逐段标注」合并成「连续区段」。
 *
 * 合并由代码做，不让模型直接输出区段范围——模型会为了省 token 把 29 段压成 1 段，
 * 而逐段输出 + 代码合并把失败模式变成「数量不对」，这在校验层一眼可见。
 */
function mergeSegments(rows) {
  const segments = [];
  for (const row of rows || []) {
    const last = segments[segments.length - 1];
    if (last && last.类型 === row.类型) {
      last.到 = row.id;
      if (last.概括.length < 120) last.概括 = `${last.概括}；${row.概括}`.slice(0, 120);
      continue;
    }
    segments.push({ 从: row.id, 到: row.id, 类型: row.类型, 概括: row.概括, 关键句: '' });
  }
  return segments;
}

export async function runP1(ctx) {
  const { book, dirs } = ctx;
  const chapters = ctx.maxUnits ? book.chapters.slice(0, ctx.maxUnits) : book.chapters;
  let done = 0;

  for (const chapter of chapters) {
    const file = dirs.l1File(chapter.index);
    if (!ctx.force && exists(file)) { done += 1; continue; }

    // 一次输出几十条概括时，小模型会退化成复读：后面的段落照抄前面的概括。
    // 切成小块分别请求，宁可多几次调用，也不要把重复写进语料。
    // 切块同时受「段数」和「字数」两个上限约束：长段落的小说按 15 段切会撑爆上下文。
    const chunkSize = ctx.p1Chunk ?? 15;
    const charBudget = ctx.p1Chars ?? 3500;
    const chunks = [];
    let current = [];
    let currentChars = 0;
    for (const paragraph of chapter.paragraphs) {
      const size = paragraph.text.length;
      if (current.length && (current.length >= chunkSize || currentChars + size > charBudget)) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(paragraph);
      currentChars += size;
      // 单段就超过预算的，自己独占一块，交给模型硬啃。
      if (size >= charBudget) { chunks.push(current); current = []; currentChars = 0; }
    }
    if (current.length) chunks.push(current);

    const rows = [];
    let state = null;
    let ok = true;

    /**
     * 单块失败时对半拆开重试。
     *
     * 实测最常见的失败是「模型少输出一条」，14 段只回 13 条。整章丢弃代价太大，
     * 拆成 7+7 通常就能过；拆到 4 段还失败才认输。
     */
    const analyzeChunk = async (chunk, label, depth = 0) => {
      const meta = { step: 'P1', chapter: chapter.index, title: chapter.title, paragraphs: chunk, label };
      const value = await callJson(ctx, {
        step: 'P1',
        meta,
        maxTokens: 6144,
        prompt: P.p1ChapterIndex({
          chapter: chapter.index,
          title: chapter.title,
          paragraphs: chunk.map((item) => `${item.id}｜${item.text}`).join('\n'),
          count: chunk.length,
          part: chunks.length > 1 ? label.split('.')[1] || '' : '',
        }),
        validate: V.p1ChapterIndex,
      });
      if (value) return value;

      if (depth >= 2 || chunk.length <= 4) return null;
      const half = Math.ceil(chunk.length / 2);
      ctx.progress(`P1 ${label} 拆成 ${half}+${chunk.length - half} 段重试`);
      const left = await analyzeChunk(chunk.slice(0, half), `${label}a`, depth + 1);
      if (!left) return null;
      const right = await analyzeChunk(chunk.slice(half), `${label}b`, depth + 1);
      if (!right) return null;
      return { paragraphs: [...left.paragraphs, ...right.paragraphs], 章末状态: right.章末状态 };
    };

    for (let index = 0; index < chunks.length; index += 1) {
      const value = await analyzeChunk(chunks[index], `ch${chapter.index}.${index + 1}`);
      if (!value) { ok = false; break; }
      rows.push(...value.paragraphs);
      state = value.章末状态;
    }

    if (!ok || rows.length !== chapter.paragraphs.length) {
      ctx.failed.push(`P1 第 ${chapter.index} 章`);
      continue;
    }
    writeJson(file, {
      chapter: chapter.index,
      title: chapter.title,
      paragraphs: rows,
      章末状态: state,
      segments: mergeSegments(rows),
    });
    done += 1;
    ctx.progress(`P1 ${done}/${chapters.length} 章`);
  }
  return done;
}

/* ------------------------------ P2 场景切分 ------------------------------ */

export function loadL1(ctx) {
  return ctx.book.chapters
    .map((chapter) => readJson(ctx.dirs.l1File(chapter.index), null))
    .filter(Boolean);
}

/**
 * P2 场景切分：由代码从 L1 的情色段落推出，不交给模型。
 *
 * 原因：让模型输出「段号区间」，它最省事的做法是整本给一个场景——而且这种输出能通过
 * 结构校验，错误会一路带到 P4/P6。改成代码按「连续情色段 + 少量喘息段」切分，
 * 模型只在 P4 里负责语义（参与者、动机、轨迹）。结构归代码，语义归模型。
 */
const SCENE_GAP_TOLERANCE = 1;
const MAX_SCENE_PARAGRAPHS = 12;

/**
 * P2 · 场景切分。
 *
 * 旧实现按「情色段落是否连续」合并，只认类型不认语义：一句对话插进来就切成两半，
 * 一段话概括完的强奸又单独成场。现在改成流式语义切分（见 core/scenes.mjs）：
 * 每次只看 6 段 + 一句场景状态，判断边界落在哪，上下文恒定不随书长增长。
 */
export async function runP2(ctx) {
  const { dirs } = ctx;
  if (!ctx.force && exists(dirs.l2Scenes)) return readJson(dirs.l2Scenes);

  // 清洗阶段已经切好场景的话，直接采用，不再调模型。
  const corpusFile = path.join(dirs.root, 'corpus.json');
  if (exists(corpusFile)) {
    const corpus = readJson(corpusFile, null);
    if (corpus?.scenes?.length) {
      const scenes = corpus.scenes.map((scene, index) => ({
        sceneId: scene.sceneId || `S${String(index + 1).padStart(2, '0')}`,
        序号: index + 1,
        章: chapterIndexFromParagraph(ctx.book, scene.从),
        跨章: scene.跨章,
        从: scene.从,
        到: scene.到,
        段落数: scene.paragraphIds?.length || 0,
        是否含情色: scene.是否含情色 !== false,
        参与者: [],
        场所: '',
        摘要: scene.摘要 || '',
      }));
      ctx.progress?.(`P2 采用清洗阶段的 ${scenes.length} 场（未调用模型）`);
      writeJson(dirs.l2Scenes, { scenes });
      writeJson(dirs.l3SceneIndex, provisionalIndex(scenes));
      return { scenes };
    }
  }

  const l1 = loadL1(ctx);
  if (l1.length !== ctx.book.chapters.length) throw new Error('P1 尚未完成，先跑 P1。');

  const rows = flatten(ctx.book);
  if (!rows.length) throw new Error('P2 没有拿到任何段落。');
  const order = new Map(rows.map((item, index) => [item.id, index]));

  // 段落 → 类型（用来标记这一场有没有情色内容）
  const typeOf = new Map();
  for (const chapter of l1) {
    for (const segment of chapter.segments || []) {
      const start = order.get(segment.从);
      const end = order.get(segment.到);
      if (start === undefined || end === undefined) continue;
      for (let index = start; index <= end; index += 1) typeOf.set(rows[index].id, segment.类型);
    }
  }

  const chapterOf = new Map();
  for (const chapter of ctx.book.chapters) {
    for (const paragraph of chapter.paragraphs) chapterOf.set(paragraph.id, chapter.index);
  }

  const chapters = ctx.book.chapters.map((chapter) => ({ index: chapter.index, title: chapter.title, paragraphs: chapter.paragraphs }));
  const { scenes: raw, open } = await segmentByChapters(ctx, chapters, {
    blockSize: ctx.p2Block ?? 6,
    onChapter: (index, total) => ctx.progress?.(`P2 场景切分 ${index}/${total} 章`),
  });
  if (!raw.length) throw new Error('P2 没有切出任何场景。');

  const scenes = raw.map((scene, index) => {
    const ids = scene.ids;
    return {
      sceneId: `S${String(index + 1).padStart(2, '0')}`,
      序号: index + 1,
      章: chapterOf.get(ids[0]) ?? 0,
      跨章: scene.chapters?.length > 1 ? scene.chapters : undefined,
      从: ids[0],
      到: ids[ids.length - 1],
      段落数: ids.length,
      是否含情色: ids.some((id) => typeOf.get(id) === '情色'),
      参与者: [],
      场所: '',
      摘要: scene.state || '',
    };
  });

  if (open) ctx.progress?.('P2 最后一场延续到书末，已保留');
  const value = { scenes };
  writeJson(dirs.l2Scenes, value);
  // 先落一份临时场景索引：P5 要等人物弧算完才回填，但不该让界面在这之前一场都看不到。
  writeJson(dirs.l3SceneIndex, provisionalIndex(scenes));
  return value;
}

/** 没有阶段信息时的场景索引：字段齐全，只是弧线留空。 */
export function provisionalIndex(scenes) {
  return {
    preliminary: true,
    scenes: scenes.map((scene, index) => ({
      sceneId: scene.sceneId,
      序号: index + 1,
      章: scene.章 ?? 0,
      跨章: scene.跨章,
      从: scene.从,
      到: scene.到,
      段落数: scene.段落数 ?? 0,
      弧阶段: '待分阶段',
      阶段类型: '',
      阶段内序号: index + 1,
      距突破: null,
      是否阶段转换: false,
      位移方向: '原地',
      场景阶段: '',
      权力: '',
      参与者: [],
      场所: '',
      是否首次: false,
      轨迹: null,
      有位移: false,
      转折句: '',
      是否含情色: scene.是否含情色 !== false,
      摘要: scene.摘要 || '',
    })),
    breakthrough: null,
    stages: [],
  };
}

/* ------------------------------ P3 阶段粗分 ------------------------------ */

export async function runP3(ctx) {
  const { dirs } = ctx;
  if (!ctx.force && exists(dirs.l3Coarse)) return readJson(dirs.l3Coarse);

  const l1 = loadL1(ctx);
  const states = l1.map((chapter) => ({ 章: chapter.chapter, ...(chapter.章末状态 || {}) }));

  // 章节一多，全部状态塞进一次请求会撑爆本地上下文（215 章约 12k token > 8k）。
  // 按章分批，每批自己划阶段，最后按章范围拼起来。
  const batchSize = ctx.p3Batch ?? 40;
  const stages = [];
  for (let offset = 0; offset < states.length; offset += batchSize) {
    const batch = states.slice(offset, offset + batchSize);
    const startChapter = batch[0].章;
    const meta = { step: 'P3', startChapter, chapterCount: batch[batch.length - 1].章, states: batch, label: `ch${startChapter}-${batch[batch.length - 1].章}` };
    const value = await callJson(ctx, {
      step: 'P3',
      meta,
      prompt: P.p3Stages({
        states: JSON.stringify(batch, null, 1),
        // 把前几批用过的阶段名带上，避免每批各自发明一套叫法。
        previous: [...new Set(stages.map((stage) => stage.名称))],
      }),
      validate: V.p3Stages,
    });
    if (!value) throw new Error(`P3 阶段粗分失败（第 ${startChapter} 章起这一批，已重试三次）。`);
    stages.push(...value.阶段);
  }

  const merged = { 阶段: dedupeStageNames(stages) };
  writeJson(dirs.l3Coarse, merged);
  return merged;
}

/** 同名阶段（分批次各自命名会出现）加序号区分：沉溺期 → 沉溺期②。 */
function dedupeStageNames(stages) {
  const seen = new Map();
  return stages.map((stage) => {
    const count = (seen.get(stage.名称) || 0) + 1;
    seen.set(stage.名称, count);
    if (count === 1) return stage;
    const marks = ['', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
    return { ...stage, 名称: `${stage.名称}${marks[count - 1] || `-${count}`}` };
  });
}

/* ------------------------------ P4 场景分析 ------------------------------ */

function sceneText(ctx, scene) {
  const rows = flatten(ctx.book);
  const start = rows.findIndex((item) => item.id === scene.从);
  const end = rows.findIndex((item) => item.id === scene.到);
  if (start < 0 || end < start) return null;
  return rows.slice(start, end + 1).map((item) => item.text).join('\n');
}

function stageForChapter(coarse, chapter) {
  const stage = (coarse?.阶段 || []).find((item) => chapter >= Number(item.章范围[0]) && chapter <= Number(item.章范围[1]));
  return stage?.名称 ?? '未分阶段';
}

export async function runP4(ctx, scenes, coarse) {
  const { dirs } = ctx;
  const targets = scenes.filter((scene) => ctx.force || !exists(dirs.l2File(scene.sceneId)));
  let done = 0;
  await ctx.pool(targets, async (scene) => {
    const text = sceneText(ctx, scene);
    if (!text) { ctx.failed.push(`P4 ${scene.sceneId} 原文范围无效`); return; }
    const meta = { step: 'P4', sceneId: scene.sceneId, text, label: scene.sceneId, erotic: scene.是否含情色 !== false };
    const value = await callJson(ctx, {
      step: 'P4',
      meta,
      prompt: P.p4Scene({ sceneId: scene.sceneId, from: scene.从, to: scene.到, stage: stageForChapter(coarse, scene.章), text }),
      validate: V.p4Scene,
      normalize: repairSceneAnalysis,
      maxTokens: 6144,
    });
    if (!value) { ctx.failed.push(`P4 ${scene.sceneId}`); return; }
    writeJson(dirs.l2File(scene.sceneId), value);
    done += 1;
    ctx.progress(`P4 ${done}/${targets.length} 场景`);
  });
  return done;
}

/* ------------------------------ P6 弧线精修 ------------------------------ */

export async function runP6(ctx, scenes, coarse) {
  const { dirs } = ctx;
  if (!ctx.force && exists(dirs.l3Stages)) return readJson(dirs.l3Stages);

  const summaries = scenes.map((scene) => {
    const analysis = readJson(dirs.l2File(scene.sceneId), null);
    return {
      sceneId: scene.sceneId,
      参与者: (analysis?.参与者 || []).map((person) => person.角色),
      起点: analysis?.轨迹?.起点 ?? null,
      终点: analysis?.轨迹?.终点 ?? null,
      触发类型: analysis?.轨迹?.触发类型 ?? null,
    };
  });

  // P6 的阶段是按「场景」分组的，所以下限看场景数，不看章数。
  const meta = { step: 'P6', sceneIds: scenes.map((scene) => scene.sceneId), coarseStages: coarse?.阶段 || [], chapterCount: scenes.length, label: 'book' };
  const value = await callJson(ctx, {
    step: 'P6',
    meta,
    prompt: P.p6Arc({ stages: JSON.stringify(coarse?.阶段 || []), sceneSummaries: JSON.stringify(summaries) }),
    validate: V.p6Arc,
  });

  // 模型分不出阶段时的兜底：按「场景所在章 → 粗分阶段」做确定性归组。
  // 人物弧是后面所有检索的坐标，宁可机械化，也不能空着。
  const resolved = value ?? fallbackStages(scenes, coarse, dirs);
  if (!value) ctx.log({ step: 'P6', target: 'book', status: 'fallback', note: '模型三次未通过校验，改用按章归组' });

  // 「初次突破」在模型眼里常常等于「第一场戏」。用一条硬规则纠偏：
  // 第一次实质越界，应当是第一次在权力上不再是「自愿」且有状态位移的场景。
  const crossing = scenes
    .map((scene) => ({ scene, analysis: readJson(dirs.l2File(scene.sceneId), null) }))
    .find(({ analysis }) => analysis && analysis.轨迹 && analysis.权力 && analysis.权力 !== '自愿');
  if (crossing && resolved.初次突破?.sceneId !== crossing.scene.sceneId) {
    resolved.初次突破 = {
      sceneId: crossing.scene.sceneId,
      前期铺垫: resolved.初次突破?.前期铺垫 ?? '',
      抵抗方式: resolved.初次突破?.抵抗方式 ?? '',
      突破口: resolved.初次突破?.突破口 ?? '',
      来源: 'heuristic',
    };
  }

  writeJson(dirs.l3Stages, resolved);
  return resolved;
}

/** 按「场景所在章落在哪个粗分阶段」归组，保证每个场景都有阶段、阶段数 ≥ 3。 */
function fallbackStages(scenes, coarse, dirs) {
  const groups = new Map();
  for (const scene of scenes) {
    const name = stageForChapter(coarse, scene.章);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(scene);
  }
  let ordered = [...groups.entries()];

  // 粗分阶段太少时，按场景顺序均分成 3 段。
  if (ordered.length < 3) {
    const per = Math.ceil(scenes.length / 3);
    ordered = [0, 1, 2]
      .map((index) => [`第${index + 1}阶段`, scenes.slice(index * per, (index + 1) * per)])
      .filter(([, list]) => list.length > 0);
  }

  const stages = ordered.map(([name, list]) => {
    const analysis = list.map((scene) => readJson(dirs.l2File(scene.sceneId), null)).filter(Boolean);
    const first = analysis.find((item) => item?.轨迹)?.轨迹?.起点 ?? '';
    const last = [...analysis].reverse().find((item) => item?.轨迹)?.轨迹?.终点 ?? '';
    return {
      名称: name,
      场景: list.map((scene) => scene.sceneId),
      起始状态: first || '—',
      结束状态: last || '—',
      核心矛盾: coarse?.阶段?.find((stage) => stage.名称 === name)?.核心矛盾 ?? '',
    };
  });

  const positions = stages.flatMap((stage) => stage.场景.map((sceneId) => {
    const analysis = readJson(dirs.l2File(sceneId), null);
    return {
      sceneId,
      所属阶段: stage.名称,
      是否阶段转换: sceneId === stage.场景[0],
      位移方向: analysis?.轨迹 ? '前进' : '原地',
    };
  }));

  return { 阶段: stages, 场景定位: positions, 初次突破: { sceneId: stages[0].场景[0] }, 来源: 'fallback' };
}

/* ------------------------------ P7 句子层 ------------------------------ */

export async function runP7(ctx, scenes) {
  const { dirs } = ctx;
  // 这本书的 P7 反复不合格时，放一个 .skip-p7 标记直接跳过。
  if (exists(dirs.root + '/.skip-p7')) { ctx.log({ step: 'P7', target: 'all', status: 'skipped' }); return 0; }
  const targets = scenes.filter((scene) => {
    if (!ctx.force && exists(dirs.l4File(scene.sceneId))) return false;
    return Boolean(readJson(dirs.l2File(scene.sceneId), null));
  });
  let done = 0;
  await ctx.pool(targets, async (scene) => {
    const text = sceneText(ctx, scene);
    const analysis = readJson(dirs.l2File(scene.sceneId), null);
    if (!text || !analysis) return;
    const meta = { step: 'P7', sceneId: scene.sceneId, text, label: scene.sceneId };
    const value = await callJson(ctx, {
      step: 'P7',
      meta,
      prompt: P.p7Sentences({
        sceneId: scene.sceneId,
        from: scene.从,
        to: scene.到,
        trajectory: analysis.轨迹 ? `${analysis.轨迹.起点} → ${analysis.轨迹.终点}` : '无（本场没有状态位移，承载句留空）',
        text,
        erotic: scene.是否含情色 !== false,
      }),
      validate: V.p7Sentences,
      normalize: repairSentences,
    });
    if (!value) { ctx.failed.push(`P7 ${scene.sceneId}`); return; }
    // 没有色情内容的场景，摘录一律清空，只保留承载句。
    if (scene.是否含情色 === false) value.描写摘录 = [];
    // 候选摘录用模型逐条判一次色情，关键词只作兜底。
    else if (value.描写摘录?.length) value.描写摘录 = await classifyExcerpts(ctx, value.描写摘录);
    writeJson(dirs.l4File(scene.sceneId), value);
    done += 1;
    ctx.progress(`P7 ${done}/${targets.length} 场景`);
  });
  return done;
}

/* ------------------------------ P8 初次突破 ------------------------------ */

export async function runP8(ctx, scenes, stages) {
  const { dirs } = ctx;
  if (!ctx.force && exists(dirs.l3Breakthrough)) return readJson(dirs.l3Breakthrough);
  const id = stages?.初次突破?.sceneId;
  if (!id) { writeJson(dirs.l3Breakthrough, null); return null; }

  const index = scenes.findIndex((scene) => scene.sceneId === id);
  if (index < 0) { ctx.failed.push('P8 突破场景不在场景表里'); return null; }

  const scene = scenes[index];
  const text = sceneText(ctx, scene);
  const before = index > 0 ? readJson(dirs.l2File(scenes[index - 1].sceneId), null) : null;
  const after = index + 1 < scenes.length ? readJson(dirs.l2File(scenes[index + 1].sceneId), null) : null;
  const brief = (analysis) => (analysis ? `${analysis.轨迹?.起点 ?? '无轨迹'} → ${analysis.轨迹?.终点 ?? '无轨迹'}；阶段：${analysis.阶段}` : '无');

  const meta = { step: 'P8', sceneId: id, text, label: id };
  const value = await callJson(ctx, {
    step: 'P8',
    meta,
    prompt: P.p8Breakthrough({ sceneId: id, text, before: brief(before), after: brief(after) }),
    validate: V.p8Breakthrough,
  });
  if (!value) { ctx.failed.push('P8'); return null; }
  writeJson(dirs.l3Breakthrough, value);
  return value;
}

export function collectStats(ctx) {
  return listJson(ctx.dirs.l4).map((file) => readJson(file, null)).filter(Boolean);
}

export function fileCounts(ctx) {
  return {
    l1: listJson(ctx.dirs.l1).length,
    scenes: exists(ctx.dirs.l2Scenes) ? (readJson(ctx.dirs.l2Scenes, { scenes: [] }).scenes || []).length : 0,
    analysis: listJson(ctx.dirs.l2Analysis).length,
    l4: listJson(ctx.dirs.l4).length,
    stages: exists(ctx.dirs.l3Stages),
    index: exists(ctx.dirs.l3SceneIndex),
    breakthrough: exists(ctx.dirs.l3Breakthrough),
    work: ctx.dirs.root,
    book: path.basename(ctx.dirs.book),
    paragraphs: ctx.book.paragraphCount,
  };
}
