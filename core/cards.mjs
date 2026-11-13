import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM } from './prompts.mjs';
import { parseJsonObject } from './llm.mjs';
import { readJson, writeJson, exists } from './store.mjs';
import { flatten } from './split.mjs';

/**
 * 角色卡。
 *
 * 分两段，和场景分析一样是「一个一个场景来」：
 *   1) 逐场抽取：每场原文过一遍，抽出这场里每个人物露出的细节（身份、称呼、外貌、
 *      性格、关系、语言习惯、习惯动作、新信息），每条都要带原文引文。
 *   2) 按人物归并：把同一个人散在几百场里的碎片汇总，让模型写成一张完整的卡。
 *
 * 第一段最贵（场景数，约 900 次调用），但可断点续跑；第二段每人一次，几十次。
 */

const FACT_FIELDS = ['身份', '称呼', '外貌', '年龄', '性格', '关系', '语言习惯', '习惯动作', '经历', '其他'];

function sceneTextOf(book, scene) {
  const rows = flatten(book);
  const from = rows.findIndex((row) => row.id === scene.从);
  const to = rows.findIndex((row) => row.id === scene.到);
  if (from < 0 || to < from) return '';
  return rows.slice(from, to + 1).map((row) => row.text).join('\n');
}

function factsPrompt({ sceneId, text, participants, roster = [], aliases = {} }) {
  const aliasLines = Object.entries(aliases).map(([alias, name]) => `${alias} = ${name}`).join('；');
  return `【任务】从这段小说原文里，抽取所有出场人物的细节信息。
【场景】${sceneId}
【分析给出的在场者】${participants.join('、') || '（未标注）'}
${roster.length ? `【人物名册】${roster.join('、')}\n` : ''}${aliasLines ? `【称呼对照（原文硬证据，必须照用）】${aliasLines}\n` : ''}
【原文】
${text}

【输出】
{"人物":[{"姓名":"","身份":"","称呼":[],"外貌":"","年龄":"","性格":"","关系":[],"语言习惯":"","习惯动作":"","经历":"","其他":"","引文":["原文逐字一句"]}]}

【规则】
- **姓名一律写真名**：原文写"我""老婆""岳母"这类称呼时，按称呼对照换成真名，不要把这些称呼当姓名；称呼本身放进"称呼"字段。
- 姓名优先从名册里选；对照表里有的必须照用，不许改。
- 原文里确实找不到对应真名的（例如只出现"一个陌生男人"），姓名写「未知：<原文里的称呼>」，不要硬凑名册里的名字。
- 同一个人不要在一场里出现两次。
- 只写原文里确实出现的信息，原文没写的字段填空字符串或空数组，**不要推测、不要补全**。
- 引文必须是原文逐字子串，用来证明上面填的信息，最多 2 条。
- 称呼写原文里别人怎么叫他/她（"妈""姐""老张"），可以有多个。
- 关系写和在场其他人的关系，例如"与陈默是夫妻"。
- 语言习惯写说话方式（口头禅、语气、爱用什么词）。
- 习惯动作写反复出现的小动作（咬嘴唇、点烟、摸后颈）。
- 经历写这场里发生的、对这个人有意义的事件。
- 只列在本场有实际言语或动作的人，不列只被提到的人。
- 最多 5 个人物；信息少的人物就少写字段。

只输出 JSON。`;
}

function cardPrompt({ name, facts }) {
  return `【任务】把下面这些散落的片段，整理成「${name}」的人物卡。
【片段】来自同一本书的不同场景，按出现顺序排列：
${facts}

【输出】
{
 "姓名":"",
 "别名":[],
 "身份":"",
 "年龄":"",
 "外貌":"",
 "性格":"",
 "语言风格":"",
 "习惯动作":[],
 "关系网":[{"对象":"","关系":"","依据":""}],
 "重要经历":[{"发生了什么":"","结果":"","场景":"S000"}],
 "能力与弱点":"",
 "情欲偏好":"",
 "变化轨迹":"",
 "矛盾点":""
}

【规则】
- 只整合片段里出现过的信息，片段之间冲突时以出现次数多的为准，并在"矛盾点"里写明冲突。
- **不要编造**：片段没提到的字段留空字符串或空数组。
- "关系网"只写片段里明确的关系。
- "重要经历"按时间顺序，最多 12 条，每条注明来自哪一场。
- "变化轨迹"写这个人从头到尾的变化（心态、处境、关系）。
- "情欲偏好"只在这个人有性描写时填写，否则留空。
- 用书面语，不要写"片段显示""根据材料"这类话。

只输出 JSON。`;
}

/** 第一段：逐场抽取。可断点续跑。 */
export async function extractFacts(ctx, scenes, options = {}) {
  const { dirs } = ctx;
  const outDir = path.join(dirs.root, 'l2', 'facts');
  fs.mkdirSync(outDir, { recursive: true });
  const done = { extracted: 0, skipped: 0, failed: 0 };

  // 名册与称呼对照：让模型把「我/老婆/岳母」写成真名，而不是照抄称呼。
  const rosterDoc = readJson(path.join(dirs.root, 'l2', 'roster.json'), null);
  const roster = (rosterDoc?.names || []).map((item) => item.name)
    .filter((name) => name.length >= 2 && name.length <= 4 && !/^(老公|老婆|少妇|极品少妇|黑衣大汉|瘦高个)$/.test(name));
  const aliases = readJson(path.join(dirs.root, 'l2', 'aliases.json'), null)?.aliases || {};
  if (roster.length || Object.keys(aliases).length) {
    ctx.progress?.(`名册 ${roster.length} 人，称呼对照 ${Object.keys(aliases).length} 条`);
  }

  const targets = scenes.filter((scene) => {
    const file = path.join(outDir, `${scene.sceneId}.json`);
    if (exists(file) && !options.force) { done.skipped += 1; return false; }
    return true;
  });

  await ctx.pool(targets, async (scene) => {
    if (ctx.isPaused?.()) return;
    const text = sceneTextOf(ctx.book, scene);
    if (!text) { done.failed += 1; return; }
    const analysis = readJson(dirs.l2File(scene.sceneId), null);
    const participants = (analysis?.参与者 || []).map((person) => person.角色).filter(Boolean);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await ctx.llm.chat({
          system: SYSTEM,
          prompt: factsPrompt({ sceneId: scene.sceneId, text, participants, roster, aliases }),
          step: 'CARD',
          meta: { label: scene.sceneId },
          maxTokens: 6000,
        });
        const value = parseJsonObject(response.text);
        if (Array.isArray(value.人物)) {
          writeJson(path.join(outDir, `${scene.sceneId}.json`), value);
          done.extracted += 1;
          ctx.progress?.(`角色细节 ${done.extracted + done.skipped}/${scenes.length}　${scene.sceneId}`);
          return;
        }
      } catch { /* 重试一次 */ }
    }
    done.failed += 1;
    ctx.log?.({ step: 'CARD', target: scene.sceneId, status: 'failed' });
  });

  return done;
}

/** 同一人物常被拆成多张卡（彪哥/黄彪、岳母/许婉玉），按归并后的姓名合并。 */
export function dedupeCards(result) {
  const groups = new Map();
  for (const card of Object.values(result.cards || {})) {
    const name = String(card.姓名 || '').trim();
    if (!name) continue;
    if (!groups.has(name)) { groups.set(name, card); continue; }
    const base = groups.get(name);
    // 出现多的当底稿，另一张的独有信息并进来。
    const [main, extra] = (card.出现场次 || 0) > (base.出现场次 || 0) ? [card, base] : [base, card];
    const merged = { ...main };
    merged.别名 = [...new Set([...(main.别名 || []), ...(extra.别名 || [])])];
    merged.习惯动作 = [...new Set([...(main.习惯动作 || []), ...(extra.习惯动作 || [])])];
    merged.关系网 = [...(main.关系网 || []), ...(extra.关系网 || [])]
      .filter((item, index, list) => list.findIndex((other) => other.对象 === item.对象 && other.关系 === item.关系) === index);
    merged.重要经历 = [...(main.重要经历 || []), ...(extra.重要经历 || [])]
      .filter((item, index, list) => list.findIndex((other) => other.发生了什么 === item.发生了什么) === index)
      .slice(0, 16);
    merged.场景列表 = [...new Set([...(main.场景列表 || []), ...(extra.场景列表 || [])])].sort();
    merged.出现场次 = merged.场景列表.length;
    for (const key of ['身份', '年龄', '外貌', '性格', '语言风格', '能力与弱点', '情欲偏好', '变化轨迹', '矛盾点']) {
      const a = String(main[key] || '');
      const b = String(extra[key] || '');
      merged[key] = a.length >= b.length ? a : b;
    }
    groups.set(name, merged);
  }
  result.cards = Object.fromEntries(groups);
  return result;
}
/** 一屏放得下的批次数量；超过就分两级汇总。 */
const BATCH = 22;
const MERGE_WIDTH = 8;

function notesOf(partial, index) {
  return `[${index + 1}] 身份：${partial.身份 || '—'}；外貌：${partial.外貌 || '—'}；性格：${partial.性格 || '—'}；语言：${partial.语言风格 || '—'}；习惯：${(partial.习惯动作 || []).slice(0, 4).join('、') || '—'}；关系：${(partial.关系 || []).slice(0, 4).map((r) => `${r.对象}(${r.关系})`).join('、') || '—'}；经历：${String(partial.经历 || '—').slice(0, 60)}`;
}

function condensePrompt({ name, notes }) {
  return `【任务】把「${name}」的这些片段要点合并成一份更短的要点。
【要点】
${notes}

【输出】
{"身份":"","外貌":"","性格":"","语言风格":"","习惯动作":[],"关系":[{"对象":"","关系":""}],"经历":""}

【规则】
- 相同信息合并，冲突的保留出现多的那种说法。
- 每项不超过 60 字，习惯动作最多 6 条，关系最多 6 条。
- 不要编，只压缩。

只输出 JSON。`;
}

function chunkPrompt({ name, facts, index, total }) {
  return `【任务】这是「${name}」的第 ${index}/${total} 批原文片段。把这一批整理成人物要点。
【片段】
${facts}

【输出】
{"姓名":"${name}","身份":"","外貌":"","性格":"","语言风格":"","习惯动作":[],"关系":[{"对象":"","关系":""}],"经历":"","其他":""}

【规则】
- 只写片段里出现过的，没写的留空字符串或空数组，不要编。
- 身份/外貌/性格各写一句，合并同类描述，不要罗列零散形容词。
- 关系只写和片段里其他人物的关系。
- 经历写这一批里发生的事，一两句即可。

只输出 JSON。`;
}

async function chatJson(ctx, prompt, label, maxTokens) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await ctx.llm.chat({ system: SYSTEM, prompt, step: 'CARD', meta: { label }, maxTokens });
      const value = parseJsonObject(response.text);
      if (value && typeof value === 'object') return value;
    } catch { /* 再试一次 */ }
  }
  return null;
}

/** 生成单个角色的卡，片段多时先分批粗归并。 */
async function buildCard(ctx, name, items) {
  if (items.length <= BATCH) {
    return chatJson(ctx, cardPrompt({ name, facts: items.join('\n') }), name, 4096);
  }

  const chunks = [];
  for (let offset = 0; offset < items.length; offset += BATCH) chunks.push(items.slice(offset, offset + BATCH));

  const partials = [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (ctx.isPaused?.()) return null;
    const value = await chatJson(ctx, chunkPrompt({ name, facts: chunks[index].join('\n'), index: index + 1, total: chunks.length }), `${name} ${index + 1}/${chunks.length}`, 2048);
    if (value) {
      partials.push(value);
      // 每批结果立刻存盘，长任务中断也不丢
      try {
        const partialDir = path.join(dirs.root, "l2", "cards", ".partials");
        fs.mkdirSync(partialDir, { recursive: true });
        writeJson(path.join(partialDir, name + "-" + (index + 1) + "-" + chunks.length + ".json"), value, 2);
      } catch { /* 存盘失败不影响主流程 */ }
    }
    ctx.progress?.(`　${name} 分批 ${index + 1}/${chunks.length}`);
  }
  if (!partials.length) return null;

  // 要点太多时逐级压缩，最后一定落到 8 条以内，避免最终那次调用超上下文。
  let notes = partials;
  while (notes.length > MERGE_WIDTH) {
    if (ctx.isPaused?.()) return null;
    const merged = [];
    for (let offset = 0; offset < notes.length; offset += MERGE_WIDTH) {
      const group = notes.slice(offset, offset + MERGE_WIDTH);
      const value = await chatJson(ctx, condensePrompt({ name, notes: group.map(notesOf).join('\n') }), `${name} 压缩`, 1536);
      if (value) merged.push(value);
    }
    if (!merged.length) break;
    notes = merged;
    ctx.progress?.(`　${name} 压缩到 ${notes.length} 段`);
  }

  const digest = notes.map(notesOf).join('\n');
  return chatJson(ctx, cardPrompt({ name, facts: digest }), name, 4096);
}

/** 第二段：按人物归并成卡。 */
export async function mergeCards(ctx, scenes, options = {}) {
  const { dirs } = ctx;
  const outDir = path.join(dirs.root, 'l2', 'cards');
  fs.mkdirSync(outDir, { recursive: true });
  const factsDir = path.join(dirs.root, 'l2', 'facts');

  // 收集：人物 -> 片段
  const people = new Map();
  for (const scene of scenes) {
    const value = readJson(path.join(factsDir, `${scene.sceneId}.json`), null);
    for (const person of value?.人物 || []) {
      const name = String(person.姓名 || '').trim();
      if (!name || name.length > 12) continue;
      if (!people.has(name)) people.set(name, []);
      const lines = [];
      for (const field of FACT_FIELDS) {
        const raw = person[field];
        const text = Array.isArray(raw) ? raw.filter(Boolean).join('、') : String(raw || '').trim();
        if (text) lines.push(`${field}：${text}`);
      }
      if (lines.length) people.set(name, people.get(name).concat([`[${scene.sceneId}] ${lines.join('；')}`]));
    }
  }

  if (process.env.__DEBUG_PEOPLE__) console.log('[debug] people=', people.size, 'scenes=', scenes.length, 'factsDir=', factsDir);
  const minScenes = options.minScenes ?? 2;
  const only = Array.isArray(options.only) && options.only.length ? new Set(options.only) : null;
  const list = [...people.entries()]
    .filter(([name, items]) => items.length >= minScenes && (!only || only.has(name)))
    .sort((a, b) => b[1].length - a[1].length);

  // 只重跑指定人物时，把已有的卡带上，别把其他卡弄丢。
  const previous = only ? (readJson(path.join(dirs.root, 'l2', 'cards.json'), null)?.cards ?? {}) : {};
  const result = { generatedAt: new Date().toISOString(), cards: { ...previous } };
  let failedCards = 0;

  for (const [name, items] of list) {
    if (ctx.isPaused?.()) break;
    const card = await buildCard(ctx, name, items);
    if (!card) {
      ctx.log?.({ step: 'CARD', target: name, status: 'failed' });
      console.log(`✗ 建卡失败：${name}（${items.length} 场）`);
      failedCards += 1;
      continue;
    }
    card.姓名 = card.姓名 || name;
    card.出现场次 = items.length;
    card.场景列表 = [...new Set(items.map((line) => line.slice(1, line.indexOf(']'))))];
    result.cards[name] = card;
    // 增量写盘：每张卡完成就更新一次，别等全部结束
    try { writeJson(path.join(dirs.root, 'l2', 'cards.json'), result); } catch { /* 忽略 */ }
    ctx.progress?.(`角色卡 ${Object.keys(result.cards).length}　${name}（${items.length} 场）`);
    writeJson(path.join(outDir, `${name}.json`), card);
  }

  if (failedCards) console.log(`建卡失败合计 ${failedCards} 人`);
  dedupeCards(result);
  // 本轮一张都没建成时，保留旧文件，避免把已有卡片清空
  if (Object.keys(result.cards).length === 0) {
    console.log('本轮没有建成任何卡，保留原有 cards.json 不覆盖');
  } else {
    writeJson(path.join(dirs.root, 'l2', 'cards.json'), result);
  }
  return result;
}
