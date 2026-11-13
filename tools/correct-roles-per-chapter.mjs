import fs from 'node:fs';
import { logPrompt } from '../core/prompt-log.mjs';
import path from 'node:path';
import { chatViaConsole, parseJsonLoose } from '../core/console-client.mjs';
import { renderTemplate } from '../core/prompt-templates.mjs';
import { resolvePrompt } from '../core/tab-config.mjs';
import { resolveModel } from '../core/tab-config.mjs';

/**
 * 5.1 角色纠错：按章用高阶/云端模型复核角色与关系
 *
 * 规则：
 *  - 姓名唯一，代称并入别名；真名优先于称谓
 *  - 关系里的甲/乙必须是角色表里的姓名，否则记入「未采用」
 *  - 单章没出现不等于角色不存在：只有「全书中从未出场」才允许删除
 *  - JSON 解析失败重试一次
 */

const work = process.argv[2] || 'work/母亲任玲';
const fromArg = process.argv[3] || '';
const toArg = process.argv[4] || '';
const MODEL = resolveModel('correct', 'qwen3.5:9b-uncensored-q8_0_64K', process.env.CORRECT_MODEL);
const REASONING = process.env.CORRECT_REASONING || 'medium';

const l2 = path.join(work, 'l2');
const reportFile = path.join(l2, 'correct-report.json');
const progressFile = path.join(l2, 'correct-progress.json');
fs.mkdirSync(l2, { recursive: true });

const readJ = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const saveJ = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');

const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const chapters = book.chapters || [];
const iFrom = fromArg ? chapters.findIndex((c) => c.id === fromArg) : 0;
const iTo = toArg ? chapters.findIndex((c) => c.id === toArg) : chapters.length - 1;
const targets = chapters.slice(Math.max(0, iFrom), Math.max(0, iTo) + 1);

const progress = readJ(progressFile, { done: [] });
const done = new Set(progress.done || []);
const report = readJ(reportFile, { chapters: {} });

const charDoc = readJ(path.join(l2, 'characters.json'), { characters: [] });
const relDoc = readJ(path.join(l2, 'relations.json'), { relations: [] });
charDoc.characters = charDoc.characters || [];
relDoc.relations = relDoc.relations || [];

const chapterText = (chapter) => (chapter.paragraphs || [])
  .map((p) => String(p.text || '').trim())
  .filter(Boolean).join('\n');

const GENERIC_ALIAS = /^(我|你|他|她|我们|你们|他们|她们|自己|人家|对方|众人|男人|女人|老男人|中年男人|胖子|老头|老太太|主人|情人|老公|老婆|丈夫|妻子|爸爸|妈妈|父亲|母亲|儿子|女儿|哥哥|姐姐|弟弟|妹妹|儿媳|女婿|公公|婆婆|岳父|岳母|亲家|老板|秘书|保安|主持人|伴郎|伴娘|服务生|司机|医生|护士|警察|老师|同学|同事|领导|下属|亲戚|朋友|邻居|路人|大汉|打手|女警|新娘|新郎|小姑子|嫂子)$/;
const isGenericName = (s) => GENERIC_ALIAS.test(String(s || '').trim()) || String(s || '').trim().length > 10;

const findChar = (name) => charDoc.characters.find((c) => c.name === name || (c.aliases || []).includes(name));

function saveState() {
  charDoc.totals = { characters: charDoc.characters.length };
  relDoc.totals = { relations: relDoc.relations.length };
  saveJ(path.join(l2, 'characters.json'), charDoc);
  saveJ(path.join(l2, 'relations.json'), relDoc);
  saveJ(reportFile, report);
  progress.done = [...done];
  saveJ(progressFile, progress);
}


// 关系归一：把甲/乙里的称谓换成角色表里的姓名，合并同一对，丢掉自相矛盾
function normalizeRelations() {
  const resolve = (name) => {
    const hit = findChar(name);
    return hit ? hit.name : '';
  };
  const byPair = new Map();
  const kept = [];
  let dropped = 0;
  for (const r of relDoc.relations) {
    const a = resolve(r.a);
    const b = resolve(r.b);
    if (!a || !b || a === b) { dropped += 1; continue; }
    const key = [a, b].sort().join('|') + '|' + (r.kind || 'identity');
    const existing = byPair.get(key);
    const scenes = r.scenes || [];
    if (existing) {
      existing.scenes = [...new Set([...existing.scenes, ...scenes])];
      existing.evidence = [...(existing.evidence || []), ...(r.evidence || [])];
      if (!existing.aRole && r.aRole) { existing.aRole = r.aRole; existing.bRole = r.bRole; }
      continue;
    }
    const fixed = a === r.a && b === r.b ? r : { ...r, a, b };
    byPair.set(key, fixed);
    kept.push(fixed);
  }
  relDoc.relations = kept;
  if (dropped) console.log('  关系归一：丢弃', dropped, '条（称谓无法对应/同一人）');
}

async function askModel(text, strict = false) {
  const people = charDoc.characters.map((c) => `${c.name}${(c.aliases || []).length ? '（' + c.aliases.slice(0, 6).join('/') + '）' : ''}`);
  const iden = relDoc.relations.filter((r) => (r.kind || 'identity') === 'identity')
    .map((r) => `${r.a} 是 ${r.b} 的 ${r.aRole || '?'}；${r.b} 是 ${r.a} 的 ${r.bRole || '?'}`);

  const prompt = renderTemplate('correct', {
    角色表: people.join(' / ') || '（空）',
    关系表: iden.slice(0, 40).join('\n') || '（空）',
    原文: text.slice(0, 60000),
    补充要求: resolvePrompt('correct') ? ('【补充要求】' + resolvePrompt('correct')) : '',
  });

  logPrompt(work, 'correct', prompt);

  const res = await chatViaConsole({ prompt, source: 'correct-roles', model: MODEL, maxTokens: 0, reasoningEffort: REASONING });
  if (!res.ok) return { error: res.error || '调用失败' };
  const data = parseJsonLoose(res.content);
  if (!data) return { error: 'JSON 解析失败', raw: String(res.content).slice(0, 400) };
  return { data };
}

console.log(`章节 ${targets.length} 个，已处理 ${done.size} 个，模型 ${MODEL}（思考 ${REASONING}）`);

for (const chapter of targets) {
  if (done.has(chapter.id)) continue;
  const text = chapterText(chapter);
  if (!text) continue;

  let out = await askModel(text);
  if (out.error) out = await askModel(text, true);
  if (out.error) {
    report.chapters[chapter.id] = { error: out.error, raw: out.raw || '', at: new Date().toISOString() };
    saveState();
    console.log(chapter.id, '失败', out.error);
    continue;
  }

  const data = out.data;

  // 1) 角色
  for (const item of data['角色'] || []) {
    const name = String(item['姓名'] || '').trim();
    if (!name || name.length > 10) continue;
    const aliases = Array.isArray(item['代称']) ? item['代称'].map((x) => String(x || '').trim()).filter(Boolean) : [];
    let person = findChar(name);
    if (!person) {
      const strongAliases = aliases.filter((a) => !isGenericName(a));
      const byAlias = strongAliases.length
        ? charDoc.characters.find((c) => strongAliases.some((a) => c.name === a || (c.aliases || []).includes(a)))
        : null;
      // 只有「新名像真名、旧名是通用称呼」时才改名，否则只并代称
      if (byAlias && byAlias.name !== name && !isGenericName(name) && isGenericName(byAlias.name)) {
        byAlias.aliases = [...new Set([...(byAlias.aliases || []), byAlias.name])];
        byAlias.name = name;
        person = byAlias;
      } else if (byAlias && byAlias.name !== name) {
        person = byAlias;
      } else {
        if (isGenericName(name)) continue;
        person = { id: 'CH' + String(charDoc.characters.length + 1).padStart(2, '0'), name, aliases: [], scenes: [] };
        charDoc.characters.push(person);
      }
    }
    for (const a of aliases) {
      if (!a || a === person.name) continue;
      const other = charDoc.characters.find((c) => c !== person && c.name === a);
      if (other) continue;   // 该称谓已经是别人的姓名，不能并进来
      if (!(person.aliases || []).includes(a)) person.aliases = [...(person.aliases || []), a];
    }
    person.scenes = [...new Set([...(person.scenes || []), chapter.id])];
  }

  // 2) 关系
  const unresolved = [];
  for (const rel of data['关系'] || []) {
    const A = String(rel['甲'] || '').trim();
    const B = String(rel['乙'] || '').trim();
    if (!A || !B || A === B) continue;
    const ca = findChar(A);
    const cb = findChar(B);
    if (!ca || !cb) { unresolved.push({ 甲: A, 乙: B, 原因: '角色表中没有该姓名' }); continue; }
    if (ca.name === cb.name) { unresolved.push({ 甲: A, 乙: B, 原因: '判定为同一人' }); continue; }

    const existing = relDoc.relations.find((r) => (r.kind || 'identity') === 'identity'
      && ((r.a === ca.name && r.b === cb.name) || (r.a === cb.name && r.b === ca.name)));
    const hasEvidence = Array.isArray(rel['证据句']) && rel['证据句'].length > 0;
    const aRole = String(rel['甲角色'] || '').trim();
    const bRole = String(rel['乙角色'] || '').trim();

    if (existing) {
      existing.scenes = [...new Set([...(existing.scenes || []), chapter.id])];
      if (hasEvidence) existing.verified = true;
      if (aRole && bRole && existing.a === ca.name && existing.verified !== true) {
        existing.aRole = aRole; existing.bRole = bRole;
        existing.decidedBy = 'correct-' + MODEL;
      }
    } else {
      relDoc.relations.push({
        a: ca.name, b: cb.name, aRole, bRole, kind: 'identity',
        scenes: [chapter.id], evidence: [],
        verified: hasEvidence, decidedBy: 'correct-' + MODEL,
      });
    }
  }

  normalizeRelations();

  // 3) 删除：只删从未出场的
  const removed = [];
  for (const del of data['删除角色'] || []) {
    const name = String(del['姓名'] || '').trim();
    const person = findChar(name);
    if (!person) continue;
    if ((person.scenes || []).length > 0) continue;
    const idx = charDoc.characters.indexOf(person);
    if (idx >= 0) { charDoc.characters.splice(idx, 1); removed.push(person.name); }
  }

  report.chapters[chapter.id] = {
    结论: data['本章结论'] || '',
    角色: data['角色'] || [],
    关系: data['关系'] || [],
    未采用关系: unresolved,
    删除: removed,
    存疑: data['存疑'] || [],
    at: new Date().toISOString(),
  };
  done.add(chapter.id);
  saveState();
  console.log(chapter.id, '完成 | 角色', (data['角色'] || []).length, '| 关系', (data['关系'] || []).length,
    '| 未采用', unresolved.length, '| 删除', removed.length, '| 存疑', (data['存疑'] || []).length);
}

normalizeRelations();
saveState();
console.log('结束');
