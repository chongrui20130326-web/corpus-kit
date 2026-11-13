import { readJson, listJson } from './store.mjs';

/**
 * 检索层。这是「色情描写专家 agent」真正会调用的接口：
 * 输入情境坐标，返回带轨迹、反应链、承载句和原文的完整记录。
 *
 * 注意：这里不做语义检索，全是结构化过滤。语义相似度是下一步的事，
 * 但结构过滤在情色场景上往往比向量检索更准，因为「阶段」「权力」这些维度是硬约束。
 */
export function loadIndex(dirs) {
  const index = readJson(dirs.l3SceneIndex, null);
  if (!index) throw new Error('scene-index.json 不存在，先跑完 P1–P6。');
  return index;
}

export function attachSentences(dirs, entry) {
  const l4 = readJson(dirs.l4File(entry.sceneId), null);
  return {
    ...entry,
    承载句: l4?.承载句 ?? [],
    功能序列: l4?.功能序列 ?? [],
    手法: l4?.手法 ?? null,
    金句: l4?.金句 ?? '',
  };
}

export function search(dirs, filters = {}) {
  const index = loadIndex(dirs);
  const keyword = (filters.text || '').trim();

  const matched = index.scenes.filter((entry) => {
    if (filters.stage && entry.弧阶段 !== filters.stage) return false;
    if (filters.power && entry.权力 !== filters.power) return false;
    if (filters.sceneStage && entry.场景阶段 !== filters.sceneStage) return false;
    if (filters.direction && entry.位移方向 !== filters.direction) return false;
    if (filters.hasTrajectory && !entry.轨迹) return false;
    if (filters.near !== undefined && entry.距突破 !== null && Math.abs(entry.距突破) > Number(filters.near)) return false;
    if (filters.character && !entry.参与者.some((name) => name.includes(filters.character))) return false;
    if (keyword) {
      const haystack = `${entry.原文}\n${entry.转折句}\n${entry.轨迹 ? `${entry.轨迹.起点}${entry.轨迹.终点}` : ''}`;
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });

  const limit = filters.limit ? Number(filters.limit) : 20;
  return matched.slice(0, limit).map((entry) => attachSentences(dirs, entry));
}

export function formatRecord(entry, options = {}) {
  const width = options.quoteWidth ?? 160;
  const lines = [];
  lines.push(`── ${entry.sceneId}　${entry.章 ? `第${entry.章}章` : ''}　${entry.弧阶段}（第${entry.阶段内序号}次）`);
  lines.push(`   场景阶段：${entry.场景阶段 || '—'}　权力：${entry.权力 || '—'}　场所：${entry.场所 || '—'}`);
  lines.push(`   轨迹：${entry.轨迹 ? `${entry.轨迹.起点} → ${entry.轨迹.终点}（${entry.轨迹.触发类型 || '触发'}）` : '无状态位移'}`);
  lines.push(`   参与者：${entry.参与者.join('、') || '—'}　距突破：${entry.距突破 ?? '—'}`);
  if (entry.转折句) lines.push(`   转折句：${entry.转折句.slice(0, width)}`);
  if (entry.金句) lines.push(`   金句：${entry.金句.slice(0, width)}`);
  if (entry.功能序列?.length) lines.push(`   功能序列：${entry.功能序列.join(' → ')}`);
  if (entry.承载句?.length) {
    lines.push('   承载句：');
    for (const item of entry.承载句) lines.push(`     · [${item.功能}] ${item.句.slice(0, width)}　← ${item.承担}`);
  }
  if (options.withText) lines.push(`   原文：${entry.原文.slice(0, 400)}`);
  return lines.join('\n');
}

export function corpusSummary(dirs) {
  const index = readJson(dirs.l3SceneIndex, null);
  const l4 = listJson(dirs.l4).map((file) => readJson(file, null)).filter(Boolean);
  return { index, l4 };
}
