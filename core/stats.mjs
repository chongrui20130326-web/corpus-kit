import { listJson, readJson, writeJson } from './store.mjs';

/**
 * P9 · 套话统计（纯代码）。
 *
 * 单本书只能得到「这本书的高频表达」；跨书才有意义。
 * 判据：一个 n-gram 出现在超过 threshold 比例的作品里，就算模板。
 */

const CJK = /[\u4e00-\u9fff]/;

function ngrams(text, min = 4, max = 8) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fff]/g, '');
  const result = new Set();
  for (let size = min; size <= max; size += 1) {
    for (let index = 0; index + size <= clean.length; index += 1) {
      const gram = clean.slice(index, index + size);
      if (!CJK.test(gram)) continue;
      result.add(gram);
    }
  }
  return result;
}

/** 收集一个工作目录里所有 L4 的句子。 */
export function collectSentences(dirs) {
  const rows = [];
  for (const file of listJson(dirs.l4)) {
    const value = readJson(file, null);
    if (!value) continue;
    for (const item of value.承载句 || []) if (item.句) rows.push({ sceneId: value.sceneId, text: item.句, kind: '承载句' });
    for (const quote of value.描写摘录 || []) if (quote) rows.push({ sceneId: value.sceneId, text: quote, kind: '描写' });
    if (typeof value.金句 === 'string' && value.金句) rows.push({ sceneId: value.sceneId, text: value.金句, kind: '金句' });
  }
  return rows;
}

export function analyze(sentenceRows, options = {}) {
  const min = options.min ?? 4;
  const max = options.max ?? 8;
  const threshold = options.threshold ?? 0.15;

  const docs = new Map();
  for (const row of sentenceRows) {
    const grams = ngrams(row.text, min, max);
    for (const gram of grams) {
      const entry = docs.get(gram) || { gram, scenes: new Set(), count: 0 };
      entry.scenes.add(row.sceneId);
      entry.count += 1;
      docs.set(gram, entry);
    }
  }

  const totalScenes = new Set(sentenceRows.map((row) => row.sceneId)).size || 1;
  const ranked = [...docs.values()]
    .map((entry) => ({ gram: entry.gram, scenes: entry.scenes.size, count: entry.count, ratio: entry.scenes.size / totalScenes }))
    .filter((entry) => entry.scenes >= 2)
    .sort((a, b) => b.scenes - a.scenes || b.gram.length - a.gram.length);

  // 滑动窗口会产出大量互为子串的碎片（"潮以后母亲" / "高潮以后母亲"）。
  // 同一覆盖度下只保留最长的那个，否则统计结果全是噪声。
  const kept = [];
  for (const entry of ranked) {
    const nested = kept.some((other) => other.scenes >= entry.scenes && other.gram.includes(entry.gram));
    if (!nested) kept.push(entry);
  }

  return {
    generatedAt: new Date().toISOString(),
    totalSentences: sentenceRows.length,
    totalScenes,
    threshold,
    cliches: kept.filter((entry) => entry.ratio >= threshold).slice(0, 200),
    frequent: kept.slice(0, 200),
  };
}

export function writeStats(dirs, sentenceRows, options = {}) {
  const result = analyze(sentenceRows, options);
  writeJson(`${dirs.stats}/cliches.json`, result);
  return result;
}

export function grammarProfile(sentenceRows) {
  const lengths = sentenceRows.map((row) => row.text.length).filter((value) => value > 0);
  if (!lengths.length) return null;
  const total = lengths.reduce((sum, value) => sum + value, 0);
  return {
    count: lengths.length,
    averageLength: Number((total / lengths.length).toFixed(1)),
    min: Math.min(...lengths),
    max: Math.max(...lengths),
  };
}
