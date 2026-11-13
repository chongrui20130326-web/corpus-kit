import { readJson, writeJson, exists } from './store.mjs';
import { p9Events, pEventTypes } from './eventPrompt.mjs';
import { parseJsonObject } from './llm.mjs';
import { SYSTEM } from './prompts.mjs';
import { validateEvents, EVENT_TYPES } from './validate.mjs';

/**
 * 关键事件层。
 *
 * 场景里的「触发句」是微观支点（哪句话让人变了），但用户真正要找的是
 * 「哪件事改变了人物轨迹」——这是事件级的判断，一场戏里可能没有，也可能一场就是全部。
 *
 * 做法：代码先选候选（阶段转换 / 权力跃变 / 初次突破 / 状态大跳），
 * 模型只负责在候选里挑真正成立的，并写清「之前 / 之后 / 影响」。
 */

const STRONG_ENDINGS = /沉迷|沉溺|主动|失控|屈服|妥协|顺从|依赖|决裂|放下|接受/;

export function selectCandidates(scenes, breakthroughId) {
  const candidates = [];
  let previous = null;

  for (const scene of scenes) {
    const reasons = [];
    if (scene.sceneId === breakthroughId) reasons.push('初次突破');
    if (scene.是否阶段转换) reasons.push('阶段转换');
    if (scene.是否首次) reasons.push('首次发生');

    if (previous) {
      if (previous.权力 && scene.权力 && previous.权力 !== scene.权力) reasons.push('权力关系改变');
      if (previous.场景阶段 !== scene.场景阶段 && scene.场景阶段 === '事后') reasons.push('进入事后');
    }
    if (scene.轨迹 && STRONG_ENDINGS.test(String(scene.轨迹.终点 || ''))) reasons.push('状态强变化');

    if (reasons.length) {
      candidates.push({
        sceneId: scene.sceneId,
        stage: `${scene.阶段类型}·${scene.弧阶段}`,
        power: scene.权力,
        participants: scene.参与者,
        place: scene.场所,
        beats: (scene.节拍 || []).slice(0, 5).map((beat) => beat.动作).filter(Boolean),
        trajectory: scene.轨迹 ? { from: scene.轨迹.起点, to: scene.轨迹.终点, trigger: scene.轨迹.触发类型, triggerText: scene.轨迹.触发句 } : null,
        turnText: scene.转折句,
        motive: (scene.参与者详情 || []).map((person) => `${person.角色}：${person.动机 || '—'}`).join('；'),
        _reasons: reasons,
      });
    }
    previous = scene;
  }

  return candidates;
}

export async function runEvents(ctx, scenes, breakthroughId) {
  const { dirs } = ctx;
  if (!ctx.force && exists(dirs.l3Events)) return readJson(dirs.l3Events);

  // 传进来的 scenes 只有段号范围；阶段、权力、轨迹在回填后的 scene-index 里，
  // 节拍和参与者动机在 l2/analysis 里。这里合并成一份，否则候选几乎选不出来。
  const index = readJson(dirs.l3SceneIndex, null);
  const base = index?.scenes?.length ? index.scenes : scenes;
  const enriched = base.map((scene) => {
    const analysis = readJson(dirs.l2File(scene.sceneId), null);
    return {
      ...scene,
      节拍: analysis?.节拍 ?? [],
      参与者详情: analysis?.参与者 ?? [],
    };
  });

  const candidates = selectCandidates(enriched, breakthroughId).slice(0, 28);
  if (!candidates.length) {
    writeJson(dirs.l3Events, { events: [], generatedAt: new Date().toISOString() });
    return { events: [] };
  }

  // 候选一次全塞给模型，它会漏或糊；按 8 条一批分开问，失败的批次单独退化成候选。
  const BATCH = 8;
  const events = [];
  for (let offset = 0; offset < candidates.length; offset += BATCH) {
    const chunk = candidates.slice(offset, offset + BATCH);
    const batchEvents = await analyzeBatch(ctx, chunk);
    events.push(...batchEvents);
  }

  const order = new Map(enriched.map((scene, position) => [scene.sceneId, position]));
  events.sort((a, b) => (order.get(a.sceneId) ?? 0) - (order.get(b.sceneId) ?? 0));

  const finalized = await finalizeEvents(ctx, events, enlargedMap(enriched), breakthroughId);

  const document = {
    generatedAt: new Date().toISOString(),
    来源: finalized.some((event) => event.来源 === 'model') ? 'model' : 'fallback',
    events: finalized,
  };
  writeJson(dirs.l3Events, document);
  return document;
}

function enlargedMap(scenes) {
  return new Map(scenes.map((scene) => [scene.sceneId, scene]));
}

const RULE_PATTERNS = [
  ['关系破裂', /决裂|反目|离婚|分开|断绝|离开|分手/],
  ['权力转变', /强迫|胁迫|被迫|不得不|强行|命令|支配/],
  ['心理突破', /羞耻|屈辱|抗拒|沉溺|渴望|接受|失控|释然|防线/],
];

function ruleType(event) {
  const text = `${event.事件 || ''}${event.影响 || ''}${event.之后 || ''}`;
  for (const [type, pattern] of RULE_PATTERNS) if (pattern.test(text)) return type;
  return '关系转变';
}

/**
 * 收尾两步：
 *   1. 持续性由代码判定——只有「阶段转换」和「初次突破」算永久，其余一次性。
 *      模型对「会不会回到原状态」几乎一律答一次性，这个字段交给它等于没有。
 *   2. 类型做一次全体重标，避免分批之间标准漂移。
 */
export async function finalizeEvents(ctx, events, sceneById, breakthroughId) {
  const stamped = events.map((event) => {
    const scene = sceneById.get(event.sceneId);
    const permanent = Boolean(scene && (scene.sceneId === breakthroughId || scene.是否阶段转换));
    return { ...event, 持续性: permanent ? '永久' : '一次性' };
  });
  return consolidateTypes(ctx, stamped);
}

export async function consolidateTypes(ctx, events) {
  if (!events.length) return events;

  const payload = JSON.stringify(events.map((event) => ({
    sceneId: event.sceneId,
    事件: event.事件,
    之前: event.之前,
    之后: event.之后,
    影响: event.影响,
  })), null, 1);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await ctx.llm.chat({ system: SYSTEM, prompt: pEventTypes({ events: payload }), step: 'PE', meta: { label: 'types' }, maxTokens: 2048 });
      const value = parseJsonObject(response.text);
      const list = Array.isArray(value?.events) ? value.events : [];
      const map = new Map(list.filter((item) => EVENT_TYPES.includes(item?.类型)).map((item) => [item.sceneId, item.类型]));
      if (map.size >= events.length) {
        return events.map((event) => ({ ...event, 类型: map.get(event.sceneId) }));
      }
    } catch (error) {
      ctx.log({ step: 'PE', target: 'types', status: 'error', error: error.message });
    }
  }

  ctx.log({ step: 'PE', target: 'types', status: 'fallback' });
  return events.map((event) => ({ ...event, 类型: EVENT_TYPES.includes(event.类型) ? event.类型 : ruleType(event) }));
}

const IMPACT = {
  初次突破: '越过底线',
  阶段转换: '进入新阶段',
  首次发生: '第一次发生',
  权力关系改变: '权力关系改变',
  进入事后: '转入事后',
  状态强变化: '状态大幅改变',
};

/** 模型失败时的兜底：事件用转折句原文，影响用触发原因映射，不编造。 */
function candidateToEvent(item) {
  const reasons = item._reasons || [];
  const type = reasons.includes('初次突破') ? '身体越界'
    : reasons.includes('权力关系改变') ? '权力转变'
      : '关系转变';
  return {
    sceneId: item.sceneId,
    事件: (item.turnText || item.beats?.[0] || '—').slice(0, 30),
    类型: type,
    影响: reasons.map((reason) => IMPACT[reason] || reason).join('、'),
    之前: item.trajectory?.from ?? '',
    之后: item.trajectory?.to ?? '',
    持续性: '永久',
    来源: 'candidate',
  };
}

async function analyzeBatch(ctx, chunk) {
  const payload = chunk.map(({ _reasons, ...rest }) => rest);
  const prompt = p9Events({ candidates: JSON.stringify(payload, null, 1) });
  let feedback = '';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await ctx.llm.chat({ system: SYSTEM, prompt: prompt + feedback, step: 'PE', meta: { label: chunk.map((item) => item.sceneId).join(',') }, maxTokens: 3072 });
      const value = parseJsonObject(response.text);
      const result = validateEvents(value, { candidateIds: chunk.map((item) => item.sceneId) });
      if (result.ok) return value.events.map((event) => ({ ...event, 来源: 'model' }));
      feedback = `\n\n上次输出未通过校验：\n- ${result.errors.slice(0, 8).join('\n- ')}`;
      ctx.log({ step: 'PE', target: chunk[0]?.sceneId, status: 'invalid', errors: result.errors.slice(0, 5) });
    } catch (error) {
      feedback = `\n\n上次输出无法解析：${error.message}。请只输出 JSON。`;
      ctx.log({ step: 'PE', target: chunk[0]?.sceneId, status: 'error', error: error.message });
    }
  }

  ctx.log({ step: 'PE', target: chunk[0]?.sceneId, status: 'fallback' });
  return chunk.map(candidateToEvent);
}
