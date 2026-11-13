import { readJson, writeJson, exists } from './store.mjs';
import { parseJsonObject } from './llm.mjs';
import { SYSTEM } from './prompts.mjs';
import { COMMON } from './prompts.mjs';
import { flatten } from './split.mjs';

/**
 * PS · 场景摘要。
 *
 * 之前的摘要是把 L1 的 40 字概括拼起来，机械且容易重复。
 * 这一层改成正经写一条：人物 / 地点 / 情节 / 矛盾 / 结果，五项齐全，
 * 人眼一扫就知道这场戏在干什么、卡在哪、最后变成了什么样。
 */

const BATCH = 6;
const TEXT_LIMIT = 1200;

export const SUMMARY_FIELDS = ['人物', '地点', '情节', '矛盾', '结果'];

export function pSceneSummary({ scenes }) {
  return `【任务】为每个场景写一条摘要，必须覆盖五项：人物、地点、情节、矛盾、结果。
【输入】场景数组（JSON），每项含 sceneId、参与者、场所、阶段、权力、轨迹、触发句、原文摘录：
${scenes}

【输出】
{"scenes":[{"sceneId":"S03","人物":["母亲","表哥"],"地点":"西屋","情节":"不超过40字","情节描述":"80到150字，按时间顺序叙述","矛盾":"不超过30字","结果":"不超过30字"}]}

【规则】
- 每个输入场景都要输出一条，sceneId 逐字照抄，不得新增、遗漏或重复。
- 人物只列在这场戏里有实际动作或言语的人，沿用输入里的称呼。
- 地点写事件实际发生的位置；原文没写就写"未明"。
- 情节：这场戏发生了什么，一句话概括，不评价。
- 情节描述：**按时间顺序把这场戏发生的事叙述一遍**，80 到 150 字。要写出谁先做了什么、对方怎么反应、局面怎么变化。只写事实，不写评价、不写心理分析，不要用"令人震惊"这类词。
- 矛盾：这场戏里谁想要什么、被什么挡住，或者两方的冲突点是什么。
- 结果：这场戏结束时，人物的状态或关系变成了什么样。
- 只能使用输入里的事实，不得补充输入之外的情节。

${COMMON}`;
}

export function validateSummaries(value, ctx) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  const list = Array.isArray(value.scenes) ? value.scenes : null;
  if (!list) return { ok: false, errors: ['scenes 必须是数组'], value: null };

  const allowed = new Set(ctx.sceneIds);
  const seen = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const at = `scenes[${index}]`;
    if (!item || typeof item !== 'object') { errors.push(`${at} 不是对象`); continue; }
    if (!allowed.has(item.sceneId)) errors.push(`${at}.sceneId 不在输入里：${item.sceneId}`);
    if (seen.has(item.sceneId)) errors.push(`${at}.sceneId 重复`);
    seen.add(item.sceneId);
    if (!Array.isArray(item.人物) || !item.人物.length || item.人物.some((name) => typeof name !== 'string' || !name.trim())) {
      errors.push(`${at}.人物 必须是非空字符串数组`);
    }
    if (typeof item.地点 !== 'string' || !item.地点.trim()) errors.push(`${at}.地点 为空`);
    for (const key of ['情节', '情节描述', '矛盾', '结果']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) errors.push(`${at}.${key} 为空`);
      else if (item[key].length > 320) errors.push(`${at}.${key} 超过 320 字`);
    }
    if (typeof item.情节描述 === 'string' && item.情节描述.trim().length < 30) errors.push(`${at}.情节描述 太短（少于 30 字）`);
  }
  for (const sceneId of allowed) if (!seen.has(sceneId)) errors.push(`缺少场景 ${sceneId}`);
  return { ok: errors.length === 0, errors, value };
}

export async function runSummaries(ctx, scenes) {
  const { dirs } = ctx;
  if (!ctx.force && exists(dirs.l2Summaries)) return readJson(dirs.l2Summaries);

  const rows = flatten(ctx.book);
  const textOf = (scene) => {
    const start = rows.findIndex((item) => item.id === scene.从);
    const end = rows.findIndex((item) => item.id === scene.到);
    if (start < 0 || end < start) return '';
    return rows.slice(start, end + 1).map((item) => item.text).join('\n').slice(0, TEXT_LIMIT);
  };

  const collected = [];
  for (let offset = 0; offset < scenes.length; offset += BATCH) {
    const chunk = scenes.slice(offset, offset + BATCH);
    const payload = chunk.map((scene) => {
      const analysis = readJson(dirs.l2File(scene.sceneId), null);
      return {
        sceneId: scene.sceneId,
        参与者: scene.参与者 || [],
        场所: scene.场所 || '',
        阶段: analysis?.阶段 ?? '',
        权力: analysis?.权力 ?? '',
        轨迹: scene.轨迹 ? `${scene.轨迹.起点} → ${scene.轨迹.终点}` : null,
        触发句: scene.轨迹?.触发句 ?? '',
        原文摘录: textOf(scene),
      };
    });

    const summaries = await summarizeBatch(ctx, chunk, payload);
    collected.push(...summaries);
  }

  const map = {};
  for (const item of collected) map[item.sceneId] = item;
  const document = { generatedAt: new Date().toISOString(), scenes: map };
  writeJson(dirs.l2Summaries, document);
  return document;
}

async function summarizeBatch(ctx, chunk, payload) {
  const prompt = pSceneSummary({ scenes: JSON.stringify(payload, null, 1) });
  let feedback = '';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await ctx.llm.chat({
        system: SYSTEM,
        prompt: prompt + feedback,
        step: 'PS',
        meta: { label: chunk.map((item) => item.sceneId).join(',') },
        maxTokens: 6144,
      });
      const value = parseJsonObject(response.text);
      const result = validateSummaries(value, { sceneIds: chunk.map((item) => item.sceneId) });
      if (result.ok) return value.scenes;
      feedback = `\n\n上次输出未通过校验：\n- ${result.errors.slice(0, 8).join('\n- ')}`;
      ctx.log({ step: 'PS', target: chunk[0]?.sceneId, status: 'invalid', errors: result.errors.slice(0, 5) });
    } catch (error) {
      feedback = `\n\n上次输出无法解析：${error.message}。请只输出 JSON。`;
      ctx.log({ step: 'PS', target: chunk[0]?.sceneId, status: 'error', error: error.message });
    }
  }

  // 兜底：用已有字段拼一条，保证每个场景都有摘要。
  ctx.log({ step: 'PS', target: chunk[0]?.sceneId, status: 'fallback' });
  return chunk.map((scene) => {
    const analysis = readJson(ctx.dirs.l2File(scene.sceneId), null);
    const beats = (analysis?.节拍 || []).map((beat) => beat.动作).filter(Boolean);
    return {
      sceneId: scene.sceneId,
      人物: scene.参与者 || [],
      地点: scene.场所 || '未明',
      情节: beats.join('，').slice(0, 40) || '—',
      情节描述: beats.join('，').slice(0, 150) || '—',
      矛盾: analysis?.参与者?.[0]?.怕什么 || '—',
      结果: scene.轨迹 ? `${scene.轨迹.起点} → ${scene.轨迹.终点}` : '状态未改变',
    };
  });
}
