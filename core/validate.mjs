/**
 * 逐层校验器。
 *
 * 这一层是「prompt 不够用」的那部分：模型会改写编号、漏字段、把整段原文当证据、
 * 编造不存在的句子。每一条都要在落盘前拦下，否则错误会顺着 L1→L4 一路放大。
 *
 * 约定：validateXxx(value, ctx) 返回 { ok, errors: string[], value }。
 * errors 非空时由调用方带反馈重试；重试后仍不合格就记录并跳过，绝不写入脏数据。
 */

export const SEGMENT_TYPES = ['情色', '过场', '概括', '对话'];
export const POWER_TYPES = ['自愿', '半推半就', '胁迫', '强迫', '交易', '无意识'];
export const STAGE_TYPES = ['前戏', '进入', '过程', '换位', '高潮', '事后'];
export const FUNCTION_TYPES = ['触觉起', '部位特写', '反应', '对话', '心理侧写', '留白', '收束'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const chars = (value) => (typeof value === 'string' ? value.length : 0);

export function p1ChapterIndex(value, ctx) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  if (Number(value.chapter) !== ctx.chapter) errors.push(`chapter 应为 ${ctx.chapter}`);

  const rows = Array.isArray(value.paragraphs) ? value.paragraphs : null;
  if (!rows) errors.push('paragraphs 必须是数组');
  else {
    if (rows.length !== ctx.paragraphs.length) {
      errors.push(`paragraphs 有 ${rows.length} 项，输入是 ${ctx.paragraphs.length} 段，必须一一对应`);
    }
    rows.forEach((row, index) => {
      const at = `paragraphs[${index}]`;
      const expected = ctx.paragraphs[index]?.id;
      if (!isObject(row)) { errors.push(`${at} 不是对象`); return; }
      if (row.id !== expected) errors.push(`${at}.id 应为 ${expected}，实际 ${row.id}`);
      if (!SEGMENT_TYPES.includes(row.类型)) errors.push(`${at}.类型 非法：${row.类型}`);
      if (!isText(row.概括)) errors.push(`${at}.概括 为空`);
      else if (chars(row.概括) > 60) errors.push(`${at}.概括 超过 60 字`);
    });
  }

  const state = value.章末状态;
  if (!isObject(state)) errors.push('章末状态 缺失');
  else for (const key of ['关系', '心理', '权力', '身体熟悉度']) {
    if (typeof state[key] !== 'string') errors.push(`章末状态.${key} 必须是字符串`);
  }

  return { ok: errors.length === 0, errors, value };
}

export function p2Scenes(value, ctx) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  const scenes = Array.isArray(value.scenes) ? value.scenes : null;
  if (!scenes || scenes.length === 0) return { ok: false, errors: ['scenes 必须是非空数组'], value: null };

  const paragraphChapter = ctx.paragraphChapter;
  let expectedNumber = 1;
  let previousEnd = 0;

  scenes.forEach((scene, index) => {
    const at = `scenes[${index}]`;
    if (!isObject(scene)) { errors.push(`${at} 不是对象`); return; }
    const match = /^S(\d{2,})$/.exec(String(scene.sceneId || ''));
    if (!match) errors.push(`${at}.sceneId 必须形如 S01`);
    else if (Number(match[1]) !== expectedNumber) errors.push(`${at}.sceneId 应为 S${String(expectedNumber).padStart(2, '0')}，实际 ${scene.sceneId}`);
    expectedNumber += 1;

    const from = ctx.paragraphOrder.get(scene.从);
    const to = ctx.paragraphOrder.get(scene.到);
    if (from === undefined) errors.push(`${at}.从 不存在：${scene.从}`);
    if (to === undefined) errors.push(`${at}.到 不存在：${scene.到}`);
    if (from !== undefined && to !== undefined) {
      if (from > to) errors.push(`${at} 起止颠倒`);
      if (from <= previousEnd) errors.push(`${at} 与上一场景重叠`);
      previousEnd = to;
      const chapterOfFrom = paragraphChapter.get(scene.从);
      if (chapterOfFrom !== Number(scene.章)) errors.push(`${at}.章 与段号不符（${chapterOfFrom}）`);
      if (paragraphChapter.get(scene.到) !== chapterOfFrom) errors.push(`${at} 跨章`);
    }
    if (!Array.isArray(scene.参与者)) errors.push(`${at}.参与者 必须是数组`);
    if (typeof scene.场所 !== 'string') errors.push(`${at}.场所 必须是字符串`);
    if (typeof scene.是否含情色 !== 'boolean') errors.push(`${at}.是否含情色 必须是布尔值`);
  });

  return { ok: errors.length === 0, errors, value };
}

export function p3Stages(value, ctx) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  const stages = Array.isArray(value.阶段) ? value.阶段 : null;
  if (!stages || stages.length === 0) return { ok: false, errors: ['阶段 必须是非空数组'], value: null };

  const batchStart = Number(ctx?.startChapter) || 1;
  const batchEnd = Number(ctx?.chapterCount) || batchStart;

  // 清洗：丢掉非法项、名称截断到 8 字、按起点排序
  const cleaned = stages
    .filter((stage) => isObject(stage) && Array.isArray(stage.章范围) && Number.isInteger(Number(stage.章范围[0])))
    .map((stage) => ({
      ...stage,
      名称: isText(stage.名称) ? String(stage.名称).slice(0, 8) : '阶段' + (stage.章范围?.[0] ?? ''),
      章范围: [Number(stage.章范围[0]), Number(stage.章范围[1])],
    }))
    .sort((a, b) => a.章范围[0] - b.章范围[0]);

  if (!cleaned.length) return { ok: false, errors: ['阶段 全部不合法'], value: null };

  // 修补 1：第一段从批起点开始
  cleaned[0].章范围[0] = batchStart;
  // 修补 2：段间首尾相接
  for (let index = 1; index < cleaned.length; index += 1) {
    const previousEnd = cleaned[index - 1].章范围[1];
    if (cleaned[index].章范围[0] !== previousEnd + 1) cleaned[index].章范围[0] = previousEnd + 1;
    if (cleaned[index].章范围[1] < cleaned[index].章范围[0]) cleaned[index].章范围[1] = cleaned[index].章范围[0];
  }
  // 修补 3：最后一段覆盖到批末
  cleaned[cleaned.length - 1].章范围[1] = Math.max(cleaned[cleaned.length - 1].章范围[1], batchEnd);

  // 修补 4：段数不足时按章数均分补足（不整步失败）
  const total = batchEnd - batchStart + 1;
  const minimum = Math.min(3, Math.max(1, total));
  if (cleaned.length < minimum) {
    const baseSize = Math.floor(total / minimum);
    const pieces = [];
    let cursor = batchStart;
    for (let index = 0; index < minimum; index += 1) {
      const size = index === minimum - 1 ? batchEnd - cursor + 1 : baseSize;
      pieces.push({
        名称: index === 0 && cleaned[0]?.名称 ? cleaned[0].名称 : '阶段' + (index + 1),
        起始状态: index === 0 ? (cleaned[0]?.起始状态 ?? '') : '',
        结束状态: index === minimum - 1 ? (cleaned[cleaned.length - 1]?.结束状态 ?? '') : '',
        核心矛盾: '',
        章范围: [cursor, cursor + size - 1],
      });
      cursor += size;
    }
    cleaned.length = 0;
    cleaned.push(...pieces);
    errors.push('阶段段数不足，已按章数均分为 ' + minimum + ' 段');
  }

  // 修补 5：段数过多时合并尾部
  if (cleaned.length > 8) {
    const head = cleaned.slice(0, 7);
    const tail = cleaned.slice(7);
    head.push({
      名称: tail[0].名称,
      起始状态: tail[0].起始状态,
      结束状态: tail[tail.length - 1].结束状态,
      核心矛盾: '',
      章范围: [tail[0].章范围[0], batchEnd],
    });
    cleaned.length = 0;
    cleaned.push(...head);
    errors.push('阶段超过 8 段，已合并为 8 段');
  }

  // 修补后校验覆盖
  let expected = batchStart;
  for (const [index, stage] of cleaned.entries()) {
    if (stage.章范围[0] !== expected) errors.push('阶段[' + index + '].章范围 起点应为 ' + expected + '，实际 ' + stage.章范围[0]);
    expected = stage.章范围[1] + 1;
  }
  if (expected !== batchEnd + 1) errors.push('阶段未覆盖到第 ' + batchEnd + ' 章');

  const repaired = { ...value, 阶段: cleaned };
  const fatal = errors.filter((item) => item.includes('未覆盖') || item.includes('起点应为') || item.includes('全部不合法'));
  return { ok: fatal.length === 0, errors, value: repaired };
}

export function p4Scene(value, ctx) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  if (value.sceneId !== ctx.sceneId) errors.push(`sceneId 应为 ${ctx.sceneId}`);
  if (!POWER_TYPES.includes(value.权力)) errors.push(`权力 非法：${value.权力}`);
  if (!STAGE_TYPES.includes(value.阶段)) errors.push(`阶段 非法：${value.阶段}`);
  if (typeof value.场所 !== 'string') errors.push('场所 必须是字符串');
  if (typeof value.是否首次 !== 'boolean') errors.push('是否首次 必须是布尔值');

  const participants = Array.isArray(value.参与者) ? value.参与者 : null;
  if (!participants) errors.push('参与者 必须是数组');
  // 空壳结果不算通过：一场戏连人都没识别出来，等于没分析。
  else if (participants.length === 0) errors.push('参与者 为空：必须写出这场戏里至少一个人');
  else participants.forEach((person, index) => {
    if (!isObject(person)) { errors.push(`参与者[${index}] 不是对象`); return; }
    for (const key of ['角色', '身份', '初始状态', '动机', '怕什么']) {
      if (typeof person[key] !== 'string') errors.push(`参与者[${index}].${key} 必须是字符串`);
    }
  });

  const trajectory = value.轨迹;
  if (trajectory === null) {
    // 显式声明「本场景没有状态位移」是合法结果。
  } else if (!isObject(trajectory)) {
    errors.push('轨迹 必须是对象或 null');
  } else {
    if (!isText(trajectory.起点)) errors.push('轨迹.起点 为空');
    if (!isText(trajectory.终点)) errors.push('轨迹.终点 为空');
    if (trajectory.起点 && trajectory.起点 === trajectory.终点) errors.push('轨迹.起点 与终点相同，应把轨迹置为 null');
    // 触发句经修复层处理：能逐字对上就保留，对不上会被清空。空是允许的，编造的不允许。
    if (isText(trajectory.触发句) && !ctx.text.includes(trajectory.触发句)) errors.push('轨迹.触发句 不是本场景原文子串');
  }

  const beats = Array.isArray(value.节拍) ? value.节拍 : null;
  const minBeats = ctx?.erotic === false ? 1 : 3;
  if (!beats) errors.push('节拍 必须是数组');
  else if (beats.length < minBeats) {
    errors.push(ctx?.erotic === false
      ? `节拍 为空：至少写出这场戏的 1 个动作`
      : `节拍只有 ${beats.length} 条，至少要 3 条`);
  }
  else if (beats.length > 8) errors.push('节拍 超过 8 条');
  else beats.forEach((beat, index) => {
    if (!isObject(beat)) { errors.push(`节拍[${index}] 不是对象`); return; }
    if (typeof beat.动作 !== 'string' || !beat.动作.trim()) errors.push(`节拍[${index}].动作 为空`);
    if (typeof beat.谁主动 !== 'string') errors.push(`节拍[${index}].谁主动 必须是字符串`);
  });

  const chain = Array.isArray(value.反应链) ? value.反应链 : null;
  if (!chain) errors.push('反应链 必须是数组');
  else chain.forEach((item, index) => {
    if (!isObject(item)) { errors.push(`反应链[${index}] 不是对象`); return; }
    for (const key of ['刺激', '心理', '生理', '神态', '言语']) {
      if (typeof item[key] !== 'string') errors.push(`反应链[${index}].${key} 必须是字符串`);
    }
    if (isText(item.证据) && !ctx.text.includes(item.证据)) errors.push(`反应链[${index}].证据 不是原文子串`);
  });

  if (isText(value.转折句) && !ctx.text.includes(value.转折句)) errors.push('转折句 不是原文子串');
  return { ok: errors.length === 0, errors, value };
}

export function p6Arc(value, ctx) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  const stages = Array.isArray(value.阶段) ? value.阶段 : null;
  const positions = Array.isArray(value.场景定位) ? value.场景定位 : null;
  if (!stages || stages.length === 0) errors.push('阶段 必须是非空数组');
  if (!positions) errors.push('场景定位 必须是数组');

  const known = new Set(ctx.sceneIds);
  const seen = new Set();
  if (positions) {
    positions.forEach((item, index) => {
      const at = `场景定位[${index}]`;
      if (!isObject(item)) { errors.push(`${at} 不是对象`); return; }
      if (!known.has(item.sceneId)) errors.push(`${at}.sceneId 不存在：${item.sceneId}`);
      if (seen.has(item.sceneId)) errors.push(`${at}.sceneId 重复：${item.sceneId}`);
      seen.add(item.sceneId);
      if (!isText(item.所属阶段)) errors.push(`${at}.所属阶段 为空`);
      if (typeof item.是否阶段转换 !== 'boolean') errors.push(`${at}.是否阶段转换 必须是布尔值`);
      if (!['前进', '回退', '原地'].includes(item.位移方向)) errors.push(`${at}.位移方向 非法：${item.位移方向}`);
    });
    for (const sceneId of known) if (!seen.has(sceneId)) errors.push(`场景定位 缺少 ${sceneId}`);
  }

  if (stages) {
    const covered = new Set();
    stages.forEach((stage, index) => {
      if (!isObject(stage)) { errors.push(`阶段[${index}] 不是对象`); return; }
      if (!isText(stage.名称)) errors.push(`阶段[${index}].名称 为空`);
      const scenes = Array.isArray(stage.场景) ? stage.场景 : [];
      if (scenes.length === 0) errors.push(`阶段[${index}].场景 为空`);
      scenes.forEach((sceneId) => {
        if (!known.has(sceneId)) errors.push(`阶段[${index}] 含未知场景 ${sceneId}`);
        covered.add(sceneId);
      });
    });
    for (const sceneId of known) if (!covered.has(sceneId)) errors.push(`阶段未包含场景 ${sceneId}`);
    // 人物弧必须是连续的：把各阶段的场景按阶段顺序接起来，应当正好等于原始场景顺序。
    const flattened = stages.flatMap((stage) => (Array.isArray(stage.场景) ? stage.场景 : []));
    if (ctx.sceneIds && flattened.join(',') !== ctx.sceneIds.join(',')) {
      errors.push('阶段的场景必须按时间顺序连续划分，不能把后面的场景塞进前面的阶段；各阶段场景按顺序拼接后应等于全部场景顺序');
    }
    // 全塞进一个阶段等于没分；人物弧这一层就白做了。
    const minimum = Math.min(3, ctx.sceneIds?.length ?? 0);
    if (stages.length < minimum) errors.push(`阶段只有 ${stages.length} 段，至少需要 ${minimum} 段，请按状态变化继续细分`);
    if (stages.length > 8) errors.push(`阶段 ${stages.length} 段，超过 8 段，请合并`);
  }

  const breakthrough = value.初次突破;
  if (breakthrough !== null) {
    if (!isObject(breakthrough)) errors.push('初次突破 必须是对象或 null');
    else if (!known.has(breakthrough.sceneId)) errors.push('初次突破.sceneId 不存在');
  }
  return { ok: errors.length === 0, errors, value };
}

export function p7Sentences(value, ctx) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  if (value.sceneId !== ctx.sceneId) errors.push(`sceneId 应为 ${ctx.sceneId}`);
  const lines = Array.isArray(value.承载句) ? value.承载句 : null;
  if (!lines) errors.push('承载句 必须是数组');
  else {
    if (lines.length > 4) errors.push('承载句 超过 4 条');
    lines.forEach((item, index) => {
      const at = `承载句[${index}]`;
      if (!isObject(item)) { errors.push(`${at} 不是对象`); return; }
      if (!isText(item.句)) errors.push(`${at}.句 为空`);
      else if (!ctx.text.includes(item.句)) errors.push(`${at}.句 不是原文子串`);
      if (!isText(item.承担)) errors.push(`${at}.承担 为空`);
      if (!FUNCTION_TYPES.includes(item.功能)) errors.push(`${at}.功能 非法：${item.功能}`);
    });
  }
  if (value.功能序列 !== undefined && !Array.isArray(value.功能序列)) errors.push('功能序列 必须是数组');
  // 描写摘录：这一场里值得留用的原文，条数不设下限，上限 12。
  const quotes = Array.isArray(value.描写摘录) ? value.描写摘录 : null;
  if (!quotes) errors.push('描写摘录 必须是数组');
  else {
    if (quotes.length > 15) errors.push(`描写摘录 有 ${quotes.length} 条，最多 15 条`);
    quotes.forEach((quote, index) => {
      if (typeof quote !== 'string' || !quote.trim()) errors.push(`描写摘录[${index}] 为空`);
      else if (!ctx.text.includes(quote)) errors.push(`描写摘录[${index}] 不是原文子串`);
    });
  }
  if (!isObject(value.手法)) errors.push('手法 必须是对象');
  return { ok: errors.length === 0, errors, value };
}

export function p8Breakthrough(value, ctx) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  if (value.sceneId !== ctx.sceneId) errors.push(`sceneId 应为 ${ctx.sceneId}`);
  if (!isObject(value.突破前)) errors.push('突破前 必须是对象');
  if (!isText(value.触发事件)) errors.push('触发事件 为空');
  if (!Array.isArray(value.抵抗方式)) errors.push('抵抗方式 必须是数组');
  if (!isText(value.抵抗到放弃的转折点)) errors.push('抵抗到放弃的转折点 为空');
  else if (!ctx.text.includes(value.抵抗到放弃的转折点)) errors.push('抵抗到放弃的转折点 不是原文子串');
  if (!isText(value.突破口)) errors.push('突破口 为空');
  if (typeof value.突破后即时反应 !== 'string') errors.push('突破后即时反应 必须是字符串');
  return { ok: errors.length === 0, errors, value };
}

export const EVENT_TYPES = ['关系转变', '权力转变', '心理突破', '身体越界', '关系破裂', '自我认知'];
export const PERSISTENCE = ['一次性', '永久'];

export function validateEvents(value, ctx) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  const events = Array.isArray(value.events) ? value.events : null;
  if (!events) return { ok: false, errors: ['events 必须是数组'], value: null };

  const allowed = new Set(ctx.candidateIds || []);
  const seen = new Set();
  if (events.length > 20) errors.push(`events 有 ${events.length} 条，超过 20 条`);
  const minimum = Math.min(3, allowed.size);
  if (events.length < minimum) errors.push(`events 只有 ${events.length} 条，至少需要 ${minimum} 条：候选已按结构信号筛过，默认成立，只剔除确实没有长期影响的`);

  events.forEach((event, index) => {
    const at = `events[${index}]`;
    if (!isObject(event)) { errors.push(`${at} 不是对象`); return; }
    if (!allowed.has(event.sceneId)) errors.push(`${at}.sceneId 不在候选里：${event.sceneId}`);
    if (seen.has(event.sceneId)) errors.push(`${at}.sceneId 重复：${event.sceneId}`);
    seen.add(event.sceneId);
    if (!isText(event.事件)) errors.push(`${at}.事件 为空`);
    else if (chars(event.事件) > 40) errors.push(`${at}.事件 超过 40 字`);
    if (!EVENT_TYPES.includes(event.类型)) errors.push(`${at}.类型 非法：${event.类型}`);
    if (!isText(event.影响)) errors.push(`${at}.影响 为空`);
    if (!isText(event.之前)) errors.push(`${at}.之前 为空`);
    if (!isText(event.之后)) errors.push(`${at}.之后 为空`);
    if (!PERSISTENCE.includes(event.持续性)) errors.push(`${at}.持续性 非法：${event.持续性}`);
  });

  return { ok: errors.length === 0, errors, value };
}

function nextId(id) {
  const match = /^P(\d+)$/.exec(String(id || ''));
  if (!match) return null;
  return `P${String(Number(match[1]) + 1).padStart(4, '0')}`;
}
