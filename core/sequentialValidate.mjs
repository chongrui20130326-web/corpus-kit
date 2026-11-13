/**
 * 顺序分析用的校验器：只查 P4 这一层的结构 + 内容下限。
 * 复用 validate.mjs 的规则，但把「阶段/权力」的闭集判断放在这里，
 * 免得顺序流程依赖另一个模块的内部导出。
 */
export const STAGE_SET = new Set(['前戏', '进入', '过程', '换位', '高潮', '事后']);
export const POWER_SET = new Set(['自愿', '半推半就', '胁迫', '强迫', '交易', '无意识']);

export function validateP4(value, ctx = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['返回值不是对象'] };
  if (value.sceneId !== ctx.sceneId) value.sceneId = ctx.sceneId;

  if (!POWER_SET.has(value.权力)) errors.push(`权力 非法：${value.权力}`);
  if (!STAGE_SET.has(value.阶段)) errors.push(`阶段 非法：${value.阶段}`);

  const people = Array.isArray(value.参与者) ? value.参与者 : [];
  if (!people.length) errors.push('参与者 为空：必须写出这场戏里至少一个人');

  const beats = Array.isArray(value.节拍) ? value.节拍 : [];
  const minBeats = ctx.erotic === false ? 1 : 3;
  if (beats.length < minBeats) errors.push(`节拍 只有 ${beats.length} 条，至少要 ${minBeats} 条`);

  for (const [index, beat] of beats.entries()) {
    if (!beat?.动作 || !String(beat.动作).trim()) errors.push(`节拍[${index}].动作 为空`);
  }

  const trajectory = value.轨迹;
  if (trajectory !== null && trajectory !== undefined) {
    if (!trajectory.起点 || !trajectory.终点) errors.push('轨迹 缺少起点或终点');
    else if (trajectory.起点 === trajectory.终点) errors.push('轨迹 起点与终点相同，应置为 null');
    if (trajectory.触发句 && ctx.text && !ctx.text.includes(trajectory.触发句)) errors.push('轨迹.触发句 不是本场景原文子串');
  }

  return { ok: errors.length === 0, errors };
}
