/**
 * 状态词表。
 *
 * 用途：判断一条「轨迹」的起点/终点是不是真的状态，而不是地点或动作。
 * 模型很爱写「跟随 → 相聚」「等待 → 归来」这种动作对动作的东西，
 * 看起来像轨迹，实际上没有位移，检索时也匹配不到任何写作需求。
 *
 * 这里只做**粗筛**：两端必须至少各命中一个状态词，否则整条轨迹作废。
 */

export const STATE_TOKENS = [
  '抗拒', '排斥', '回避', '逃避', '恐惧', '害怕', '羞耻', '屈辱', '愤怒', '厌恶',
  '冷漠', '麻木', '犹豫', '动摇', '挣扎', '妥协', '默许', '顺从', '配合', '主动',
  '渴望', '期待', '好奇', '兴奋', '沉醉', '沉溺', '沉沦', '依赖', '依恋', '失控',
  '愧疚', '自责', '释然', '放松', '疲惫', '疼痛', '快感', '满足', '空虚', '冷淡',
  '疏离', '亲近', '信任', '戒备', '紧张', '焦虑', '慌乱', '平静', '麻木', '绝望',
  '得意', '算计', '报复', '嫉妒', '占有', '支配', '服从', '羞怯', '大胆', '矛盾',
  '崩溃', '迷茫', '清醒', '醉意', '惊喜', '厌恶感', '安心', '不安', '心动', '动情',
];

const STATE_SET = new Set(STATE_TOKENS);

/** 文本里是否含至少一个状态词。允许「羞耻与抗拒」这种组合。 */
export function looksLikeState(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (STATE_SET.has(text.trim())) return true;
  return STATE_TOKENS.some((token) => text.includes(token));
}

/** 一条轨迹是否成立：两端都像状态，且不同。 */
export function isStateTrajectory(trajectory) {
  if (!trajectory || typeof trajectory !== 'object') return false;
  const from = trajectory.起点;
  const to = trajectory.终点;
  if (!looksLikeState(from) || !looksLikeState(to)) return false;
  return String(from).trim() !== String(to).trim();
}

/** 供 prompt 使用的一段词表文本。 */
export const STATE_HINT = STATE_TOKENS.slice(0, 40).join('/');
