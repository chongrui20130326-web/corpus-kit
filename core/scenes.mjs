import { readJson, writeJson } from './store.mjs';
import { parseJsonObject } from './llm.mjs';
import { SYSTEM, COMMON } from './prompts.mjs';

/**
 * 语义场景切分（流式）。
 *
 * 为什么不用纯代码：按"情色段落是否连续"合并，只认类型，不认地点/时间/人物/动作的连续性。
 * 结果就是同一场戏被一句话打断就切成两半，一句话描述的戏又单独成场。
 *
 * 为什么不用"整本书喂给模型"：会爆上下文，也不可控。
 *
 * 这里用滑动窗口：每次只看最近 2 段 + 待判的 6 段，并带上一句"当前场景状态"，
 * 让模型判断这 6 段里从第几段开始是新场景。窗口大小恒定，书多长都不爆。
 */

const BLOCK = 6;

function prompt({ prevState, lastLines, block, currentLength }) {
  return `【任务】你在给小说切分场景。判断待判段落里，从哪里开始是新的一场戏。
【当前场景】${prevState || '（这是全书开头，还没有场景）'}
【当前场景已有段落数】${currentLength}
【当前场景最后几段】
${lastLines.map((line) => line).join('\n') || '（无）'}

【待判段落】
${block.map((row) => `${row.id}｜${row.text}`).join('\n')}

【输出】
{"切分点":[2],"本场状态":"40 字以内：地点 + 在场人物 + 动作进行到哪一步 + 被动方的状态"}
或
{"切分点":[],"本场状态":"..."}

【规则】
- 切分点是**待判段落里的下标**（从 0 开始）。如果这几段都属于当前场景，输出空数组。
- 判断依据是场景三要素变没变：**地点、时间、在场人物**，以及动作是否还在同一条线上。
- 以下情况要切：
  · 换了地方（西屋 → 厨房）
  · 时间跳了（"第二天""几年后""打那以后"）
  · 人物进出导致局面变了（第三者加入、某人离开）
  · 一件事做完，开始另一件事
  · 一场已经讲了很久：当前段落数加这批段落数**超过 15 段时，必须切一次**，找这批里最像新起点的位置
- 以下情况**不要切**：
  · 只是中间插了一句对话、一句心理、一句交代，主线没断
  · 同一个动作的继续（他抽送 → 她呻吟 → 他加快）
- "本场状态"要写具体：**地点 + 人物 + 动作到了哪一步 + 被动方此刻的状态**。
  反例（太笼统，不合格）："表哥与母亲发生亲密之事"
  正例："西屋床上，表哥按住母亲双手，刚插入，母亲咬着枕巾不出声"
- 只输出 JSON。

${COMMON}`;
}

export function validateSegmentation(value, blockSize) {
  const errors = [];
  if (!value || typeof value !== 'object') return { ok: false, errors: ['不是对象'] };
  const cuts = value.切分点;
  if (!Array.isArray(cuts)) errors.push('切分点 必须是数组');
  else {
    for (const cut of cuts) {
      if (!Number.isInteger(cut) || cut < 0 || cut >= blockSize) errors.push(`切分点 ${cut} 越界（0..${blockSize - 1}）`);
    }
    if (cuts.some((cut, index) => index > 0 && cut <= cuts[index - 1])) errors.push('切分点必须递增');
  }
  if (typeof value.本场状态 !== 'string' || !value.本场状态.trim()) errors.push('本场状态 不能为空');
  return { ok: errors.length === 0, errors };
}

/** 对一批段落做语义切分，返回场景数组（每个场景是段落 id 列表）。 */
export async function segmentScenes(ctx, rows, options = {}) {
  const block = options.blockSize ?? BLOCK;
  const scenes = [];
  let current = null;
  let prevState = '';
  let failed = 0;

  for (let offset = 0; offset < rows.length; offset += block) {
    const slice = rows.slice(offset, offset + block);
    const lastLines = current
      ? rows.slice(Math.max(0, offset - 2), offset).map((row) => `${row.id}｜${row.text.slice(0, 40)}`)
      : [];

    let value = null;
    let feedback = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await ctx.llm.chat({
          system: SYSTEM,
          prompt: prompt({ prevState, lastLines, block: slice, currentLength: current?.ids.length ?? 0 }) + feedback,
          step: 'P2',
          meta: { label: `blk${offset}` },
          maxTokens: 1024,
        });
        const parsed = parseJsonObject(response.text);
        const result = validateSegmentation(parsed, slice.length);
        if (result.ok) { value = parsed; break; }
        feedback = `\n\n上次输出不合格：${result.errors.join('；')}`;
      } catch (error) {
        feedback = `\n\n上次输出无法解析：${error.message}`;
      }
    }

    if (!value) {
      failed += 1;
      // 兜底：整块并入当前场景，绝不丢段落。
      if (!current) { current = { ids: [], state: '' }; scenes.push(current); }
      for (const row of slice) current.ids.push(row.id);
      continue;
    }

    const cuts = [...new Set(value.切分点)].sort((a, b) => a - b);
    let start = 0;
    for (const cut of cuts) {
      // cut 之前的段落归当前场景
      if (!current) { current = { ids: [], state: '' }; scenes.push(current); }
      for (let index = start; index < cut; index += 1) current.ids.push(slice[index].id);
      current.state = value.本场状态;
      current = { ids: [], state: '' };
      scenes.push(current);
      start = cut;
    }
    if (!current) { current = { ids: [], state: '' }; scenes.push(current); }
    for (let index = start; index < slice.length; index += 1) current.ids.push(slice[index].id);
    current.state = value.本场状态;
    prevState = value.本场状态;
  }

  // 去掉空场景
  return { scenes: scenes.filter((scene) => scene.ids.length), failed };
}

/** 把段落 id 列表转成场景记录。 */
export function toSceneRecords(sceneList, rows) {
  const order = new Map(rows.map((row, index) => [row.id, index]));
  const textOf = (id) => rows[order.get(id)]?.text || '';
  return sceneList.map((scene, index) => {
    const first = scene.ids[0];
    const last = scene.ids[scene.ids.length - 1];
    return {
      sceneId: `S${String(index + 1).padStart(2, '0')}`,
      序号: index + 1,
      从: first,
      到: last,
      段落数: scene.ids.length,
      摘要: scene.state || textOf(first).slice(0, 30),
      段落: scene.ids,
    };
  });
}
