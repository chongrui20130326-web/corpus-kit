import fs from 'node:fs';
import path from 'node:path';

/**
 * 角色知识库（按用户定义的数据模型）
 *
 * characters.json
 *   { characters: [{ id, name, aliases: [], scenes: [], status }] }
 *   name     = 人物姓名，唯一标识
 *   aliases  = 常用代称，可多个
 *
 * relations.json
 *   { relations: [{
 *       a, b,               // 人物姓名（无序对）
 *       aRole, bRole,       // 甲的角色、乙的角色（如 小姨 / 外甥）
 *       kind: 'identity' | 'reference',
 *       scenes: [],         // 出现在哪些场
 *       evidence: [{ sceneId, sentence }]
 *   }] }
 *   identity  = 人物关系：同一对人只能有一条，冲突时按证据投票
 *   reference = 参考关系：可以多条（被强奸者/强奸者 之类），不传给模型
 */

const dirOf = (work) => path.join(work, 'l2');
const norm = (s) => String(s || '').trim().replace(/\s+/g, '');

// 亲属称谓
const KINSHIP = /^(母亲|妈妈|妈|父亲|爸爸|爸|儿子|女儿|哥哥|姐姐|弟弟|妹妹|表哥|表姐|表弟|表妹|堂哥|堂姐|大姨|小姨|姨|姨夫|姑|姑姑|舅|舅舅|婶|婶子|叔|叔叔|爷爷|奶奶|姥姥|姥爷|外公|外婆|丈夫|妻子|老公|老婆|媳妇|情人|爱人|主人|工友|众人|对方|男人|女人|少妇|小伙子|少年|少女)$/;

// 岗位/身份称呼：不是真名，不能作为角色姓名
const ROLE_ONLY = /(主持人|伴郎|伴娘|司仪|保安|门卫|司机|秘书|助理|经理|老板|主任|局长|科长|处长|部长|总裁|董事长|医生|护士|警察|法官|律师|老师|同学|同事|领导|下属|职工|员工|服务员|售货员|收银员|店长|房东|邻居|路人|宾客|客人|客人|嘉宾|亲戚|村民|工人|农民|士兵|将军|小二|掌柜|老板|前台|摄像|摄影|化妆师|设计师|工程师|记者|主编|作者|读者|新郎|新娘|众人|人群|人群|男人|女人|老头|老太太|大爷|大妈|阿姨|大叔|少年|少女|小孩|孩子)$/;

export const isRoleOnly = (name) => ROLE_ONLY.test(norm(name));

export const isKinship = (name) => KINSHIP.test(norm(name));

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
}


// ---- 关系方向校验 ----
// 常见互为一对的角色词；用于判断模型给出的 (aRole,bRole) 是否方向写反
const PAIRS = [
  ['小姨', '外甥'], ['小姨', '外甥女'], ['姨妈', '外甥'], ['姨母', '外甥'],
  ['舅舅', '外甥'], ['舅舅', '外甥女'], ['姑姑', '侄子'], ['叔叔', '侄子'],
  ['母亲', '儿子'], ['母亲', '女儿'], ['父亲', '儿子'], ['父亲', '女儿'],
  ['丈夫', '妻子'], ['哥哥', '妹妹'], ['哥哥', '弟弟'], ['姐姐', '妹妹'], ['姐姐', '弟弟'],
  ['表哥', '表妹'], ['表哥', '表弟'], ['表姐', '表妹'], ['爷爷', '孙子'], ['奶奶', '孙子'],
  ['姥姥', '外孙'], ['姥爷', '外孙'], ['上司', '下属'], ['主人', '性奴'], ['债主', '债务人'],
];
const normRole = (r) => String(r || '').replace(/[\s的]/g, '');
function counterpartOf(role) {
  const r = normRole(role);
  const out = [];
  for (const [x, y] of PAIRS) {
    if (r === x) out.push(y);
    else if (r === y) out.push(x);
    else if (r.includes(x)) out.push(y);
    else if (r.includes(y)) out.push(x);
  }
  return [...new Set(out)];
}
function roleValid(aRole, bRole) {
  const a = normRole(aRole); const b = normRole(bRole);
  if (!a || !b) return true;
  return counterpartOf(a).some((c) => b.includes(c) || c.includes(b));
}

/** 用双方已知代称校正方向：返回 { aRole, bRole, fixed } */
export function normalizeRoles(aRole, bRole, aliasesA = [], aliasesB = []) {
  const a = String(aRole || '').trim();
  const b = String(bRole || '').trim();
  if (!a || !b) return { aRole: a, bRole: b, fixed: false };
  if (roleValid(a, b)) return { aRole: a, bRole: b, fixed: false };

  // 方向反了？
  if (roleValid(b, a)) return { aRole: b, bRole: a, fixed: true };

  // 用代称找一对合法的称呼
  const candA = [a, ...aliasesA.map((x) => String(x || ''))];
  const candB = [b, ...aliasesB.map((x) => String(x || ''))];
  for (const x of candA) {
    for (const y of candB) {
      if (normRole(x) === normRole(y)) continue;
      if (roleValid(x, y)) return { aRole: x, bRole: y, fixed: true };
    }
  }
  return { aRole: a, bRole: b, fixed: false };
}

export function loadKnowledge(work) {
  const dir = dirOf(work);
  const charDoc = readJson(path.join(dir, 'characters.json'), { characters: [] });
  const relDoc = readJson(path.join(dir, 'relations.json'), { relations: [] });
  // 读取时也过滤：岗位/身份称呼不算真名，不进入角色表
  const characters = (charDoc.characters || []).filter((c) => !isRoleOnly(c.name));
  const valid = new Set(characters.map((c) => norm(c.name)));
  const relations = (relDoc.relations || []).filter((r) => valid.has(norm(r.a)) && valid.has(norm(r.b)));
  return { characters, relations };
}

/** 只给模型看的可信信息：姓名、代称、人物关系（不含参考关系） */
export function promptContext(work) {
  const { characters, relations } = loadKnowledge(work);
  const people = characters.map((c) => {
    const alias = (c.aliases || []).filter(Boolean);
    return c.name + (alias.length ? '（' + alias.slice(0, 6).join('/') + '）' : '');
  });
  const identity = relations
    .filter((r) => (r.kind || 'identity') === 'identity')
    .map((r) => `${r.a} -${r.aRole || '?'}-> ${r.b}（${r.bRole || '?'}）`);
  return { people, identity };
}

function findPerson(chars, name) {
  const target = norm(name);
  for (const c of chars) {
    if (norm(c.name) === target) return c;
    if ((c.aliases || []).some((a) => norm(a) === target)) return c;
  }
  return null;
}

/** 记录一个人物出场：姓名唯一，代称并入别名 */
export function upsertPerson(work, { name, aliases = [], sceneId, socialRole = '', gender = '', evidence = [], ages = [] }) {
  // 岗位/身份称呼不能当姓名写入真名表
  if (isRoleOnly(name)) return null;
  const file = path.join(dirOf(work), 'characters.json');
  const doc = readJson(file, { characters: [] });
  const chars = doc.characters || [];
  let person = findPerson(chars, name);

  if (!person) {
    // 新角色：若名字是称谓，先建但标记，等真名出现再改名
    person = { id: 'CH' + String(chars.length + 1).padStart(2, '0'), name, aliases: [], scenes: [] };
    chars.push(person);
  } else if (isKinship(person.name) && !isKinship(name)) {
    // 真名优先：称谓名 → 真名
    const old = person.name;
    person.name = name;
    person.aliases = [...new Set([...(person.aliases || []), old])];
  }

  for (const a of aliases) {
    const v = String(a || '').trim();
    if (v && norm(v) !== norm(person.name) && !(person.aliases || []).some((x) => norm(x) === norm(v))) {
      person.aliases = [...(person.aliases || []), v];
    }
  }
  // 社会身份（绝对职业/职位）与性别：只在有新值时覆盖，并累积证据句
  if (socialRole) {
    const role = String(socialRole).trim();
    // 只排除不合规内容，不限定必须是什么
    const EXCLUDE = ['未知', '未提及', '不详', '不明', '路人', '普通人', '角色', '人物',
      '母亲', '父亲', '爸爸', '妈妈', '丈夫', '妻子', '老公', '老婆',
      '儿子', '女儿', '哥哥', '姐姐', '弟弟', '妹妹', '公公', '婆婆',
      '媳妇', '儿媳', '女婿', '叔叔', '阿姨', '舅舅', '姑姑', '爷爷', '奶奶',
      '朋友', '同事', '邻居', '熟人', '未婚夫', '未婚妻', '情人'];
    const bad = !role
      || role.length > 30
      || EXCLUDE.includes(role)
      || EXCLUDE.some((w) => role.includes(w))
      || /^[—\-无]$/.test(role);
    if (!bad && role !== person.socialRole) person.socialRole = role;
  }
  if (gender) {
    const g = String(gender).trim();
    if (['男', '女', '未知'].includes(g)) person.gender = g;
  }
  if (Array.isArray(evidence) && evidence.length) {
    person.socialEvidence = [...new Set([...(person.socialEvidence || []), ...evidence.map(Number).filter(Boolean)])];
  }
  // 年龄：允许多条（随情节变化），每条带证据句
  if (Array.isArray(ages) && ages.length) {
    const list = Array.isArray(person.ages) ? person.ages : [];
    for (const item of ages) {
      const age = String(item && (item['年龄'] ?? item.age) || '').trim();
      if (!age || age.length > 12) continue;
      // 丢弃占位值
      if (/^(未知|未提及|不详|不明|未知年龄|无|—|-)$/.test(age)) continue;
      if (!/\d|[一二三四五六七八九十百]/.test(age)) continue;
      const ev = (item['证据句'] || item.evidence || []).map(Number).filter(Boolean);
      const exist = list.find((x) => String(x.age) === age);
      if (exist) exist.evidence = [...new Set([...(exist.evidence || []), ...ev])];
      else list.push({ age, evidence: ev, sceneId });
    }
    person.ages = list.slice(-20);
  }
  if (sceneId && !(person.scenes || []).includes(sceneId)) person.scenes = [...(person.scenes || []), sceneId];

  doc.characters = chars;
  doc.totals = { characters: chars.length };
  doc.updatedAt = new Date().toISOString();
  writeJson(file, doc);
  return person;
}

/** 记录关系：identity 唯一，reference 可多条 */
export function upsertRelation(work, { a, b, aRole, bRole, kind = 'identity', sceneId, sentence }) {
  const file = path.join(dirOf(work), 'relations.json');
  const doc = readJson(file, { relations: [] });
  const rels = doc.relations || [];
  const A = String(a || '').trim();
  const B = String(b || '').trim();
  if (!A || !B || A === B) return null;

  // 方向校验：用双方别名纠正「外甥女/外甥」这类写反的角色
  {
    const doc0 = readJson(file, { characters: [] });
    const charA = findPerson(doc0.characters || [], A);
    const charB = findPerson(doc0.characters || [], B);
    const fixed = normalizeRoles(aRole, bRole, charA?.aliases || [], charB?.aliases || []);
    if (fixed.fixed) {
      aRole = fixed.aRole;
      bRole = fixed.bRole;
    }
  }

  const samePair = (r) => (norm(r.a) === norm(A) && norm(r.b) === norm(B)) || (norm(r.a) === norm(B) && norm(r.b) === norm(A));
  const evidence = sentence ? [{ sceneId, sentence }] : [];

  if (kind === 'identity') {
    const exist = rels.find((r) => (r.kind || 'identity') === 'identity' && samePair(r));
    if (exist) {
      exist.scenes = [...new Set([...(exist.scenes || []), sceneId])].filter(Boolean);
      exist.evidence = [...(exist.evidence || []), ...evidence];
      // 证据多的保留；冲突时保留出现场次更多的
      if ((aRole && bRole) && (exist.aRole !== aRole || exist.bRole !== bRole)) {
        exist.conflicts = exist.conflicts || [];
        exist.conflicts.push({ sceneId, aRole, bRole, kept: exist.aRole + '/' + exist.bRole });
      }
      if (!exist.aRole && aRole) { exist.aRole = aRole; exist.bRole = bRole; }
    } else {
      rels.push({ a: A, b: B, aRole: aRole || '', bRole: bRole || '', kind: 'identity', scenes: [sceneId].filter(Boolean), evidence });
    }
  } else {
    rels.push({ a: A, b: B, aRole: aRole || '', bRole: bRole || '', kind: 'reference', scenes: [sceneId].filter(Boolean), evidence });
  }

  doc.relations = rels;
  writeJson(file, doc);
  return true;
}
