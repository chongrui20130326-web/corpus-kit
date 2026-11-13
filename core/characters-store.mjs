import fs from 'node:fs';
import path from 'node:path';

/**
 * 角色表增量维护：详述逐场产出人物时，实时匹配/新增角色，并保留按场追溯。
 * 规则：
 *  - 先按「姓名 / 别名」精确匹配已知角色
 *  - 匹配不上记为候选（candidate），同一候选在 ≥2 场出现才提升为 confirmed
 *  - 每个角色记录出现在哪些场（scenes）
 */

const fileOf = (work) => path.join(work, 'l2', 'characters.json');

export function loadCharacters(work) {
  const file = fileOf(work);
  if (!fs.existsSync(file)) return { characters: [], candidates: {}, totals: {} };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.characters = doc.characters || [];
    doc.candidates = doc.candidates || {};
    return doc;
  } catch {
    return { characters: [], candidates: {}, totals: {} };
  }
}

const norm = (s) => String(s || '').trim().replace(/\s+/g, '');

// 这些是称谓/代称，不应作为角色的「真名」；有真名时应真名优先
const KINSHIP_TERMS = /^(母亲|妈妈|妈|母亲大人|父亲|爸爸|爸|儿子|女儿|哥哥|姐姐|弟弟|妹妹|表哥|表姐|表弟|表妹|堂哥|堂姐|大姨|小姨|姨娘|姨|姨夫|姑|姑姑|舅|舅舅|婶|婶子|叔|叔叔|爷爷|奶奶|姥姥|姥爷|外公|外婆|丈夫|妻子|老公|老婆|媳妇|情人|爱人|主人|工友|工友[ABC甲乙丙]|众人|对方|男人|女人|少妇|小伙子|少年|少女)$/;

const isKinship = (name) => KINSHIP_TERMS.test(norm(name));

// 一个人物条目可能写成「姓名：母亲，身份：任玲」这种倒置，取更像真名的那个
function pickNames(person) {
  const callNames = Array.isArray(person['称谓']) ? person['称谓'] : (person['代称'] ? [person['代称']] : []);
  const rawName = norm(person['姓名'] || person.name || '');
  const rawAlias = norm(person['身份'] || person['代称'] || person.alias || '');
  let name = rawName;
  let alias = rawAlias;
  if (name && alias && isKinship(name) && !isKinship(alias) && alias.length <= 6) {
    name = rawAlias;
    alias = rawName;
  }
  return { name, alias, callNames: callNames.map((x) => String(x || '').trim()).filter(Boolean) };
}

export function findByName(doc, name) {
  const target = norm(name);
  if (!target) return null;
  for (const c of doc.characters) {
    if (norm(c.name) === target) return c;
    if ((c.aliases || []).some((a) => norm(a) === target)) return c;
  }
  return null;
}

export function applyScenePeople(work, sceneId, people) {
  const doc = loadCharacters(work);
  const added = [];
  const matched = [];

  for (const p of people || []) {
    const picked = pickNames(p);
    const name = picked.name;
    if (!name || name.length > 10) continue;
    if (/^(他|她|它|他们|她们|众人|对方|大家|我|你|自己)$/.test(name)) continue;

    const hit = findByName(doc, name);
    if (hit) {
      // 真名优先：已有真名是称谓、新来的是真名 → 用新真名替换，旧称谓转别名
      if (isKinship(hit.name) && !isKinship(name)) {
        const oldName = hit.name;
        hit.name = name;
        hit.aliases = [...new Set([...(hit.aliases || []), oldName])];
      }
      matched.push(hit.name);
      if (!Array.isArray(hit.scenes)) hit.scenes = [];
      if (!hit.scenes.includes(sceneId)) hit.scenes.push(sceneId);
      // 身份/称谓补充进别名
      const alias = picked.alias;
      for (const cn of picked.callNames || []) {
        if (cn && cn !== hit.name && !(hit.aliases || []).some((a) => norm(a) === norm(cn))) hit.aliases = [...(hit.aliases || []), cn];
      }
      if (alias && alias !== norm(hit.name) && !(hit.aliases || []).some((a) => norm(a) === alias)) {
        hit.aliases = [...(hit.aliases || []), alias];
      }
      continue;
    }

    // 未匹配：先记候选
    const cand = doc.candidates[name] || { name, aliases: [], scenes: [], firstSeen: sceneId };
    if (!cand.scenes.includes(sceneId)) cand.scenes.push(sceneId);
    const alias = picked.alias;
    if (alias && alias !== name && !cand.aliases.includes(alias)) cand.aliases.push(alias);
    doc.candidates[name] = cand;
    if (cand.scenes.length >= 2) {
      // 出现两场以上，提升为正式角色
      const id = 'CH' + String(doc.characters.length + 1).padStart(2, '0');
      doc.characters.push({
        id, name, aliases: [...new Set([...(cand.aliases || []), ...(cand.scenes.length ? [] : [])])],
        scenes: [...cand.scenes], status: 'confirmed', source: 'scene-detail', firstSeen: cand.firstSeen,
      });
      delete doc.candidates[name];
      added.push(name);
    }
  }

  doc.totals = {
    characters: doc.characters.length,
    candidates: Object.keys(doc.candidates || {}).length,
    confirmed: doc.characters.filter((c) => (c.scenes || []).length >= 2 || c.status === 'confirmed').length,
  };
  doc.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(fileOf(work)), { recursive: true });
  fs.writeFileSync(fileOf(work), JSON.stringify(doc, null, 1), 'utf8');
  return { doc, added, matched, chars: doc.characters };
}
