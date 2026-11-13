/**
 * 人称映射校验：把模型给出的角色名与该句的人称映射对齐
 * 用于 6.1 人物卡、6.2 台词、6.3 外观，避免模型凭片段猜错人
 */

export function buildMentionIndex(mentions, nameById) {
  const bySentence = new Map();
  for (const m of mentions || []) {
    if (!m.characterId) continue;
    const n = Number(m.sentence);
    if (!bySentence.has(n)) bySentence.set(n, []);
    bySentence.get(n).push({ start: Number(m.start) || 0, name: nameById.get(m.characterId) || '' });
  }
  for (const arr of bySentence.values()) arr.sort((a, b) => a.start - b.start);
  return bySentence;
}

/**
 * @param {Map} index  buildMentionIndex 的结果
 * @param {number} sentence 句子号
 * @param {number} pos 句内位置（可省略，默认 0）
 * @param {string} modelName 模型给出的角色名（可为空）
 * @returns {string} 校验后的角色名
 */
export function resolveName(index, sentence, pos, modelName) {
  const list = index.get(Number(sentence)) || [];
  const uniq = [...new Set(list.map((x) => x.name).filter(Boolean))];

  if (uniq.length === 1) return uniq[0];
  if (modelName && uniq.includes(modelName)) return modelName;

  const before = list.filter((x) => x.start <= (Number(pos) || 0));
  if (before.length) {
    const nm = before[before.length - 1].name;
    if (nm) return nm;
  }
  if (list.length) {
    const nm = list[list.length - 1].name;
    if (nm) return nm;
  }
  return modelName || '';
}
