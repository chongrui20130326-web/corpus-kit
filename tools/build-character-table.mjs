import fs from 'node:fs';
import { logPrompt } from '../core/prompt-log.mjs';
import path from 'node:path';
import { writeJsonAtomic } from '../core/atomic-json.mjs';
import { chatJson, recordFailure } from './lib-llm.mjs';

// 确保输出目录存在（新书首次运行时 l2 可能还没建）
function ensureOutputDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ } }

/**
 * 第 1 步：角色真名表 + 角色关系表
 * 1) 规则扫人名候选 → 模型裁剪出真名表
 * 2) 按章分批让模型给出「谁是谁的谁」→ 汇总去重成关系表
 * 输出 l2/characters.json、l2/relations.json
 */

const work = process.argv[2] || 'work/美少妇的哀羞';
const MODEL = process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K';
const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));

const KINSHIP_BLOCK = /^(丈夫|妻子|老公|老婆|太太|夫人|父亲|母亲|爸爸|妈妈|儿子|女儿|哥哥|姐姐|弟弟|妹妹|岳父|岳母|公公|婆婆|情人|爱人|主人|老大|大哥|对方|众人|男人|女人|少妇)$/;
const STOP = new Set(['于是', '然后', '这样', '那样', '什么', '怎么', '如果', '但是', '因为', '所以', '时候', '现在', '已经', '自己', '他们', '她们', '我们', '你们', '大家', '一个', '这个', '那个', '起来', '出来', '过来', '下来', '知道', '看见', '听到', '开始', '终于', '突然', '立刻', '马上', '只是', '还是', '就是', '不是', '没有', '可以', '应该', '似乎', '仿佛', '好像']);
const AFTER = /^([\u4e00-\u9fa5]{2,3})(说|道|问|喊|叫|笑|哭|答|点头|摇头|皱眉|冷笑|低声|大声|看着|望向|抬头|低头|转身|叹)/;
const BEFORE = /(叫|是|和|跟|对|被|让|给|与)([\u4e00-\u9fa5]{2,3})(说|道|问|喊|笑|点头)/;

async function chat(prompt, _maxTokens) {
  const result = await chatJson(prompt, { maxTokens: 4096, retries: 3 });
  if (result.ok) return result.data;
  recordFailure(path.join(work, 'l2', 'truncation-report.json'), {
    tool: 'build-character-table.mjs',
    reason: result.truncated ? '输出超过 4096 token，重试 3 次仍超限' : '调用失败',
    attempts: result.attempts,
    promptHead: prompt.slice(0, 300),
  });
  return null;
}

// ---------- 1) 真名表：直接把正文交给模型找人物 ----------
// 不再依赖「正则先抽候选」，小书（人名极少、多用称谓）也能识别
const CHUNK_CHARS = 6000;
const chunks = [];
let buf = [];
let size = 0;
for (const chapter of book.chapters || []) {
  for (const para of chapter.paragraphs || []) {
    const line = String(para.text || '').trim();
    if (!line) continue;
    if (size + line.length > CHUNK_CHARS && buf.length) {
      chunks.push(buf.join('\n'));
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += line.length;
  }
}
if (buf.length) chunks.push(buf.join('\n'));
console.log(`正文分块 ${chunks.length} 段，每段约 ${CHUNK_CHARS} 字`);

const found = new Map();     // 姓名 -> Set(别名)
for (let i = 0; i < chunks.length; i += 1) {
  const value = await chat([
    '下面是一段小说正文。请找出这段里出现的所有人物：',
    '· 有真名/外号的写名字（如「林薇」「彬哥」）',
    '· 只用称谓指代、但明显是固定人物的也收（如「母亲」「表哥」），姓名就写该称谓',
    '· 不要把「他」「她」「众人」「对方」这类泛称当人物',
    '· 同一人物的不同称呼放进别名',
    '只返回 JSON：',
    '{\"characters\":[{\"姓名\":\"母亲\",\"别名\":[\"妈\",\"她\"]}]}',
    '',
    '【正文】',
    chunks[i].slice(0, CHUNK_CHARS),
  ].join('\n'), 16384);
  if (!value) { console.log(`  第 ${i + 1} 段解析失败，跳过`); continue; }
  const list = Array.isArray(value.characters) ? value.characters : [];
  for (const item of list) {
    const name = String(item.姓名 || item.name || '').trim();
    if (!name || name.length > 8) continue;
    if (/^(他|她|它|他们|她们|众人|对方|男人|女人|大家|我|你)$/.test(name)) continue;
    if (!found.has(name)) found.set(name, new Set());
    for (const alias of (Array.isArray(item.别名) ? item.别名 : [])) {
      const a = String(alias || '').trim();
      if (a && a !== name && a.length <= 8) found.get(name).add(a);
    }
  }
  console.log(`  第 ${i + 1}/${chunks.length} 段：累计人物 ${found.size} 个`);
  process.stdout.write('');
}

// ---------- 1.5) 合并同一个人：模型聚类，去掉不是人物的碎片 ----------
const rawList = [...found.entries()].map(([name, aliases]) => ({ name, aliases: [...aliases] }));
if (!rawList.length) {
  console.error('角色表为空：模型没有从正文里识别出人物');
  process.exit(2);
}

// 统计每个名字在正文里出现次数，给聚类提供依据
const textAll = chunks.join('\n');
const countOf = (n) => textAll.split(n).length - 1;

const clusterPrompt = [
  '下面是从一部小说正文里抽出的「人物候选」，每个候选后面是它自己被认为的别名。',
  '同一个人的不同称呼被拆成了多条（例如「母亲」和「任玲」是同一个人；「张海峰」和「表哥」也是）。',
  '请把它们合并成真正的人物列表：',
  '· 一个人只保留一条，选择一个最规范的姓名（有真名用真名，没有真名用最常用称谓）',
  '· 其他写法放进别名',
  '· 「三位工友」「众人」这类群体描述不是独立人物，直接丢弃',
  '· 只出现一次、且明显是某个人的别名，合并进那个人，不要单独保留',
  '只返回 JSON：',
  '{"characters":[{"姓名":"任玲","别名":["母亲","我妈","妈"]}]}',
  '',
  '【人物候选】',
  rawList.map((x) => x.name + '（出现 ' + countOf(x.name) + ' 次）' + (x.aliases.length ? ' 别名:' + x.aliases.join('/') : '')).join('\n'),
].join('\n');

const merged = await chat(clusterPrompt, 0);
const mergedList = Array.isArray(merged?.characters) ? merged.characters : null;
if (!mergedList || !mergedList.length) {
  console.log('聚类失败，退回未合并的候选');
}

const source = mergedList || rawList.map((x) => ({ 姓名: x.name, 别名: x.aliases }));
const characters = source
  .map((item) => ({
    name: String(item.姓名 || item.name || '').trim(),
    aliases: (Array.isArray(item.别名) ? item.别名 : []).map((a) => String(a || '').trim()).filter(Boolean),
  }))
  .filter((x) => x.name && x.name.length <= 10)
  .map((x, i) => ({ id: 'CH' + String(i + 1).padStart(2, '0'), name: x.name, aliases: [...new Set(x.aliases)].filter((a) => a !== x.name), firstSeen: null }));

if (!characters.length) {
  console.error('角色表为空：模型没有从正文里识别出人物');
  process.exit(2);
}
writeJsonAtomic(path.join(work, 'l2', 'characters.json'), {
  generatedAt: new Date().toISOString(),
  method: '正文分块 + 模型识别人物',
  chunks: chunks.length,
  totals: { characters: characters.length },
  characters,
});
console.log(`角色表 ${characters.length} 个：` + characters.map((c) => c.name).join('、'));

// ---------- 2) 关系表（全书按章，只取同句共现） ----------
const relations = new Map();
// 断点续跑：把已落盘的 partial 读回来，避免崩溃后整轮重来
{
  const partialForResume = path.join(work, 'l2', 'relations.partial.jsonl');
  if (fs.existsSync(partialForResume)) {
    for (const line of fs.readFileSync(partialForResume, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        const key = r.from + '>' + r.type + '>' + r.to;
        if (!relations.has(key)) relations.set(key, { ...r, _saved: true });
        else {
          const rec = relations.get(key);
          for (const e of r.evidence || []) if (!rec.evidence.some((x) => x.sentence === e.sentence)) rec.evidence.push(e);
        }
      } catch { /* 跳过坏行 */ }
    }
  }
}
const partialPath = path.join(work, 'l2', 'relations.partial.jsonl');
const progressPath = path.join(work, 'l2', 'relations.progress.json');
const doneChapters = new Set(fs.existsSync(progressPath) ? (JSON.parse(fs.readFileSync(progressPath, 'utf8')).chapters || []) : []);
const saveChapterRelations = (chapterId) => {
  const fresh = [...relations.values()].filter((r) => !r._saved);
  if (fresh.length) fs.appendFileSync(partialPath, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  for (const r of fresh) r._saved = true;
  doneChapters.add(chapterId);
  writeJsonAtomic(progressPath, { chapters: [...doneChapters], at: new Date().toISOString() });
};
const nameList = characters.flatMap((c) => [{ id: c.id, name: c.name }, ...(c.aliases || []).map((a) => ({ id: c.id, name: a }))]);
let chaptersDone = 0;
for (const chapter of book.chapters || []) {
  if (doneChapters.has(chapter.id)) continue;
  // 只把「同一句里同时出现两个角色」的句子交给模型，避免泛化
  const pairs = [];
  for (const para of chapter.paragraphs || []) {
    for (const s of para.sentences || []) {
      const line = String(s.text || '');
      const hit = nameList.filter((n) => n.name && line.includes(n.name));
      const uniq = [...new Map(hit.map((x) => [x.id, x])).values()];
      if (uniq.length >= 2) pairs.push({ line: line.slice(0, 120), ids: uniq.map((x) => x.id), sentence: Number(String(s.sid || s.id || '').replace(/^.*S/, '')), raw: line.slice(0, 200) });
      if (pairs.length >= 8) break;
    }
    if (pairs.length >= 8) break;
  }
  if (!pairs.length) {
    // 该章没有可抽取的关系对，也算处理完，避免进度永远停在中途
    saveChapterRelations(chapter.id);
    continue;
  }
  const value2 = await chat([
    '角色表：', nameList.map((c) => c.id + ' ' + c.name).join(' / '), '',
    '下面每行是同句中出现的多个角色。请只判断每句里这几个角色之间确认的关系。',
    '关系类型只能用 丈夫、妻子、父亲、母亲、儿子、女儿、兄弟、姐妹、上司、下属、朋友、仇人、主人、性奴、性伴、调教者、被调教者、债主、债务人。',
    '同一句可以给多条关系（例如既是上司又是主人），但每条都要能从这句读出来；看不出来就跳过。',
    '',
    '只返回 JSON：{"relations":[{"句子":1,"甲":"CH13","类型":"丈夫","乙":"CH01"}]}（句子=上面每行的序号，必填）',
    '',
    pairs.map((p, i) => (i + 1) + '. ' + p.line + '（' + p.ids.join('、') + '）').join('\n'),
  ].join('\n'), 16384);
  for (const r of value2?.relations || []) {
    const a = characters.find((c) => c.id === String(r.甲 || '').trim());
    const b = characters.find((c) => c.id === String(r.乙 || '').trim());
    const type = String(r.类型 || '').trim();
    if (!a || !b || !type || a.id === b.id) continue;
    const key = a.id + '>' + type + '>' + b.id;
    const idx = Number(r.句子 || 0) - 1;
    const ev = pairs[idx] || null;
    const evidence = ev && ev.sentence ? [{ sentence: ev.sentence, text: ev.raw }] : [];
    if (!relations.has(key)) relations.set(key, { from: a.id, fromName: a.name, type, to: b.id, toName: b.name, chapter: chapter.id, evidence });
    else {
      const rec = relations.get(key);
      for (const e2 of evidence) if (!rec.evidence.some((x) => x.sentence === e2.sentence)) rec.evidence.push(e2);
    }
  }
  saveChapterRelations(chapter.id);
  // 每章结束立刻刷新 relations.json：崩溃也不会丢掉已完成章节的关系
  {
    const snapshot = [...relations.values()].map(({ _saved, ...rest }) => rest);
    writeJsonAtomic(path.join(work, 'l2', 'relations.json'), {
      generatedAt: new Date().toISOString(),
      method: '同句共现 + 模型判定',
      totals: { relations: snapshot.length, chapters: doneChapters.size },
      relations: snapshot,
    });
  }
  chaptersDone += 1;
  process.stdout.write(`  关系 ${chapter.id}（${relations.size} 条）\r`);
}
console.log('');

const relationList = [...relations.values()];
writeJsonAtomic(path.join(work, 'l2', 'relations.json'), {
  generatedAt: new Date().toISOString(),
  method: '同句共现 + 模型判定',
  totals: { relations: relationList.length, chapters: chaptersDone },
  relations: relationList,
});
console.log(`关系表 ${relationList.length} 条（覆盖 ${chaptersDone} 章）`);
console.log(relationList.slice(0, 10).map((r) => `${r.fromName}-${r.type}->${r.toName}`).join(' / '));
