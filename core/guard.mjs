import fs from 'node:fs';

/**
 * 防覆盖保护：新结果明显少于已有结果时拒绝写入。
 * 原子写只防损坏，不防「跑完了但写少了」的覆盖。
 *
 * 用法：
 *   assertNotShrinking(file, oldCount, newCount, '场景详述')
 * 环境变量 FORCE=1 时跳过检查（确认要覆盖时使用）。
 */
export function countOf(file, pick) {
  try {
    if (!fs.existsSync(file)) return 0;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pick ? pick(data) : 0;
  } catch {
    return 0;
  }
}

export function assertNotShrinking(file, oldCount, newCount, label) {
  if (process.env.FORCE === '1') return;
  if (!oldCount || oldCount === 0) return;
  const ratio = newCount / oldCount;
  if (ratio >= 0.5) return;
  throw new Error(
    `拒绝写入：${label} 现有 ${oldCount} 条，新结果只有 ${newCount} 条（减少 ${Math.round((1 - ratio) * 100)}%）。\n` +
    `如果确认要覆盖，请加环境变量 FORCE=1 重跑。\n文件：${file}`
  );
}
