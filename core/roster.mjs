import fs from 'node:fs';
import path from 'node:path';

/**
 * 统一读取名册。
 *
 * 历史原因有两种格式：
 *   { names: [{ name, scenes }] }   ← 老格式
 *   { people: [...], 无法判断: [...] } ← tools/resolve-roster.mjs 的格式
 * 这里统一成字符串数组，避免每个工具各写一份。
 */
export function readRosterNames(dir) {
  const file = path.join(dir, 'l2', 'roster.json');
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = doc.names || doc.people || [];
  const names = [];
  for (const item of list) {
    const name = typeof item === 'string' ? item : (item?.name || item?.姓名 || '');
    const text = String(name || '').trim();
    if (text && !names.includes(text)) names.push(text);
  }
  return names;
}

/** 称呼 → 真名。文件不存在时返回空对象。 */
export function readAliases(dir) {
  const file = path.join(dir, 'l2', 'aliases.json');
  if (!fs.existsSync(file)) return {};
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return doc.aliases || {};
}
