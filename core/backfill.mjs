import { readJson, writeJson } from './store.mjs';
import { flatten } from './split.mjs';
import { annotateStages } from './stageTypes.mjs';
import { isEroticScene } from './chains.mjs';

/** 场景覆盖几段：按起止段号在全书里的位置算。 */
function textParagraphCount(ctx, scene) {
  const rows = flatten(ctx.book);
  const from = rows.findIndex((row) => row.id === scene.从);
  const to = rows.findIndex((row) => row.id === scene.到);
  return from >= 0 && to >= from ? to - from + 1 : 0;
}

/**
 * P5 · 回填（纯代码，不经模型）。
 *
 * 这是把四层「串起来」的那一步：模型只回答「这个场景属于哪个阶段」，
 * 「第几次」「离突破还有多远」这类序数必须由程序算——模型数不准。
 */
export function backfill(ctx, scenes, stages) {
  const typedStages = annotateStages(stages?.阶段 || []);
  const typeOfStage = new Map(typedStages.map((stage) => [stage.名称, stage.类型]));
  const positions = new Map((stages?.场景定位 || []).map((item) => [item.sceneId, item]));
  const breakthroughId = stages?.初次突破?.sceneId ?? null;
  const breakthroughIndex = breakthroughId ? scenes.findIndex((scene) => scene.sceneId === breakthroughId) : -1;
  const counters = new Map();
  const rows = flatten(ctx.book);

  const entries = scenes.map((scene, index) => {
    const analysis = readJson(ctx.dirs.l2File(scene.sceneId), null);
    const position = positions.get(scene.sceneId) || {};
    const stageName = position.所属阶段 || '未分阶段';
    const ordinal = (counters.get(stageName) || 0) + 1;
    counters.set(stageName, ordinal);

    const from = rows.findIndex((item) => item.id === scene.从);
    const to = rows.findIndex((item) => item.id === scene.到);
    const text = from >= 0 && to >= from ? rows.slice(from, to + 1).map((item) => item.text).join('\n') : '';

    return {
      sceneId: scene.sceneId,
      序号: index + 1,
      章: scene.章,
      跨章: scene.跨章 && scene.跨章.length > 1 ? scene.跨章 : undefined,
      从: scene.从,
      到: scene.到,
      段落数: scene.段落数 ?? (scene.从 === scene.到 ? 1 : textParagraphCount(ctx, scene)),
      // 是否含情色 以 P4 的分析为准（阶段 + 权力 + 关键词），比清洗期的粗判准。
      是否含情色: analysis ? isEroticScene(text, analysis) : scene.是否含情色 !== false,
      弧阶段: stageName,
      阶段类型: typeOfStage.get(stageName) || '',
      阶段内序号: ordinal,
      距突破: breakthroughIndex >= 0 ? index - breakthroughIndex : null,
      是否阶段转换: Boolean(position.是否阶段转换),
      位移方向: position.位移方向 || '原地',
      场景阶段: analysis?.阶段 ?? '',
      权力: analysis?.权力 ?? '',
      参与者: (analysis?.参与者 || []).map((person) => person.角色),
      场所: analysis?.场所 ?? scene.场所 ?? '',
      是否首次: Boolean(analysis?.是否首次),
      轨迹: analysis?.轨迹 ?? null,
      有位移: Boolean(analysis?.轨迹),
      转折句: analysis?.转折句 ?? '',
      原文: text,
    };
  });

  const document = {
    generatedAt: new Date().toISOString(),
    breakthrough: breakthroughId
      ? { sceneId: breakthroughId, 序号: breakthroughIndex + 1, 距突破: 0 }
      : null,
    stages: typedStages.map((stage) => ({
      名称: stage.名称,
      类型: stage.类型,
      场景: stage.场景,
      起始状态: stage.起始状态,
      结束状态: stage.结束状态,
      核心矛盾: stage.核心矛盾,
      场景数: stage.场景.length,
    })),
    scenes: entries,
  };

  writeJson(ctx.dirs.l3SceneIndex, document);
  return document;
}
