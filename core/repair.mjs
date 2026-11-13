/**
 * 输出修复层（在 validate 之前跑）。
 * 依据是真实跑出来的失败分布：大部分「不合格」不是模型答错，而是答成了近似形状——
 * 枚举被写成 "进入|过程|高潮"、证据被改写了一个字、可选字段给了 null。
 * 这类问题整条丢弃代价太大（一场戏几分钟），能修就修，修不了再交给校验器拒绝。
 *
 * 原则：只做**无歧义的机械修复**。改字、编造、补全语义，一律不做。
 */

import { isStateTrajectory } from './stateLexicon.mjs';
import { trimToErotic } from './eroticFilter.mjs';

/** 从 "进入|过程|高潮" / "前戏,进入" / "前戏、进入" 里挑出第一个合法值。 */
export function pickEnum(value, allowed) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (allowed.includes(text)) return text;
  for (const token of text.split(/[|｜、,，/／;；\s]+/u)) {
    const candidate = token.trim();
    if (allowed.includes(candidate)) return candidate;
  }
  return text;
}

/** 把 null / undefined / 数字 统一成字符串，避免因为一个 null 丢掉整条记录。 */
export function coerceStrings(object, keys) {
  if (!object || typeof object !== 'object') return object;
  for (const key of keys) {
    const value = object[key];
    if (value === null || value === undefined) object[key] = '';
    else if (typeof value !== 'string') object[key] = String(value);
  }
  return object;
}

/**
 * 把被改写的引文修回原文：找引文与原文的最长公共子串。
 * 找不到足够长的匹配就返回空字符串——空字符串是诚实结果，改过的引文不是。
 */
export function repairQuote(text, quote, minLength = 6) {
  if (typeof quote !== 'string' || !quote.trim()) return '';
  const source = String(text || '');
  const trimmed = quote.trim();
  if (source.includes(trimmed)) return trimmed;
  if (!source) return '';

  let best = '';
  for (let start = 0; start < trimmed.length; start += 1) {
    for (let end = trimmed.length; end > start; end -= 1) {
      const candidate = trimmed.slice(start, end);
      if (candidate.length <= best.length) break;
      if (candidate.length < minLength) break;
      if (source.includes(candidate)) { best = candidate; break; }
    }
  }
  return best;
}

/** P4 的针对性修复：枚举、可选字符串、所有引文。 */
export function repairSceneAnalysis(value, ctx) {
  if (!value || typeof value !== 'object') return value;
  const stageList = ['前戏', '进入', '过程', '换位', '高潮', '事后'];
  const powerList = ['自愿', '半推半就', '胁迫', '强迫', '交易', '无意识'];

  // 模型爱自由发挥（"沉溺""缠绵"），按语义映射回闭集，映射不上再退回"过程"。
  const stageMap = {
    前戏: ['前戏', '开场', '挑逗', '预热', '暗示'],
    进入: ['进入', '插入', '开始', '初次', '破处'],
    过程: ['过程', '沉溺', '缠绵', '交合', '正戏', '持续', '进行'],
    换位: ['换位', '换姿势', '体位', '转换'],
    高潮: ['高潮', '射精', '爆发', '顶点', '泄'],
    事后: ['事后', '余韵', '收束', '结束', '事后清理'],
  };
  const rawStage = String(value.阶段 || '').trim();
  const mapped = Object.entries(stageMap).find(([, words]) => words.some((word) => rawStage.includes(word)));
  value.阶段 = mapped ? mapped[0] : pickEnum(value.阶段, stageList);
  value.权力 = pickEnum(value.权力, powerList);
  // sceneId 一律以调用方为准，模型写错也不影响落盘文件名。
  if (ctx?.sceneId) value.sceneId = ctx.sceneId;
  coerceStrings(value, ['场所', '转折句']);
  if (typeof value.是否首次 !== 'boolean') value.是否首次 = value.是否首次 === '是' || value.是否首次 === true;

  if (Array.isArray(value.参与者)) {
    for (const person of value.参与者) coerceStrings(person, ['角色', '身份', '初始状态', '动机', '怕什么']);
  }

  if (Array.isArray(value.节拍)) {
    value.节拍 = value.节拍.filter((beat) => beat && typeof beat === 'object' && !Array.isArray(beat));
    for (const beat of value.节拍) {
      coerceStrings(beat, ['动作', '谁主动']);
      if (beat.序 === undefined || beat.序 === null) beat.序 = 0;
      if (typeof beat.序 !== 'number') beat.序 = Number(beat.序) || 0;
    }
  }

  if (value.轨迹 && typeof value.轨迹 === 'object') {
    coerceStrings(value.轨迹, ['起点', '终点', '触发句', '触发类型']);
    value.轨迹.触发句 = repairQuote(ctx.text, value.轨迹.触发句);
    // 起点终点相同说明没有位移，按协议置空整条轨迹。
    if (value.轨迹.起点 && value.轨迹.起点 === value.轨迹.终点) value.轨迹 = null;
    // 两端填不进状态词表，说明写的不是状态（"跟随→相聚"）。宁可判无位移，也不留假轨迹。
    else if (!isStateTrajectory(value.轨迹)) value.轨迹 = null;
  }

  if (Array.isArray(value.反应链)) {
    // 模型偶尔在对象数组里混进字符串；先剔除，否则赋值会抛 TypeError。
    value.反应链 = value.反应链.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    for (const item of value.反应链) {
      coerceStrings(item, ['刺激', '心理', '生理', '神态', '言语', '证据']);
      item.证据 = repairQuote(ctx.text, item.证据);
    }
    value.反应链 = value.反应链.filter((item) => item.刺激 || item.心理 || item.生理 || item.神态 || item.言语);
  }

  value.转折句 = repairQuote(ctx.text, value.转折句);
  return value;
}

/** 把互相重叠的摘录区间合并，避免同一段被摘成好几条近重复。 */
function mergeIntervals(text, quotes) {
  const intervals = quotes
    .map((quote) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length }))
    .filter((item) => item.start >= 0)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const item of intervals) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end + 2) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

/** 合并后的区间如果太长，在句号处切回可读的段落。 */
function blocksToQuotes(text, blocks, max = 140) {
  const quotes = [];
  for (const block of blocks) {
    let start = block.start;
    while (start < block.end) {
      let end = Math.min(start + max, block.end);
      if (end < block.end) {
        const slice = text.slice(start, end);
        const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'));
        if (cut > 20) end = start + cut + 1;
      }
      const quote = text.slice(start, end).trim();
      if (quote) quotes.push(quote);
      start = end;
    }
  }
  return quotes;
}

/** 把碎片扩回所在整句，保证摘出来的是完整句子。 */
function snapToSentence(text, quote, max = 140) {
  const start = text.indexOf(quote);
  if (start < 0) return quote;
  const end = start + quote.length;

  let from = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    if ('。！？'.includes(text[index])) { from = index + 1; break; }
  }
  let to = text.length;
  for (let index = end; index < text.length; index += 1) {
    if ('。！？'.includes(text[index])) { to = index + 1; break; }
  }

  const sentence = text.slice(from, to).trim();
  if (!sentence || sentence.length > max) return quote;
  return sentence;
}

/** P7 的针对性修复：承载句与金句必须是原文。 */
export function repairSentences(value, ctx) {
  if (!value || typeof value !== 'object') return value;
  const functions = ['触觉起', '部位特写', '反应', '对话', '心理侧写', '留白', '收束'];
  if (Array.isArray(value.承载句)) {
    value.承载句 = value.承载句
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        coerceStrings(item, ['句', '承担', '功能']);
        item.句 = repairQuote(ctx.text, item.句, 4);
        item.功能 = pickEnum(item.功能, functions);
        return item;
      })
      .filter((item) => item && item.句);
  }
  // 描写摘录：逐条修回原文，去重，最多 12 条。
  const rawQuotes = Array.isArray(value.描写摘录) ? value.描写摘录    : (Array.isArray(value.金句) ? value.金句 : (typeof value.金句 === 'string' ? [value.金句] : []));
  const repaired = [...new Set(rawQuotes
    .map((quote) => repairQuote(ctx.text, quote, 4))
    .filter(Boolean))]
    .map((quote) => snapToSentence(ctx.text, quote));

  // 先补成整句，再把互相重叠的区间合并，最后按句号切回可读长度。
  const blocks = mergeIntervals(ctx.text, [...new Set(repaired)]);
  // 模型还是会把"母亲酒量不好"这种叙述当描写：剔除整条非色情的，并把开头的交代句切掉。
  value.描写摘录 = blocksToQuotes(ctx.text, blocks)
    .map((quote) => trimToErotic(quote))
    .filter(Boolean)
    .slice(0, 15);
  delete value.金句;
  return value;
}
