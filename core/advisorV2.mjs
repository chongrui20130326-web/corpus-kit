import fs from 'node:fs';
import path from 'node:path';
import { layout, readJson } from './store.mjs';
import { parseJsonObject } from './llm.mjs';
import { SYSTEM } from './prompts.mjs';

/**
 * 续写顾问 v2：基于本书已经落盘的全部结构化数据给建议。
 *
 * 和大纲检索版的区别：不再跨书找相似场景，而是直接读这本书的人物卡与场景分析，
 * 让建议贴合「这个人是什么人、此刻处在什么阶段、说话什么腔调」。
 */

const pick = (list, count) => (Array.isArray(list) ? list.slice(0, count) : []);

function cardBlock(card, scene) {
  if (!card) return '';
  const lines = [];
  lines.push(`【${card.姓名}】（${card.性别 || '未知'}）${card.身份 || ''}`);

  const traits = pick(card.性格档案 || [], 3).map((item) => `${item.情境}：${item.表现}`);
  if (traits.length) lines.push(`  性格：${traits.join('；')}`);

  const speech = pick(card.语言档案 || [], 3).map((item) => `${item.情境}——${item.特点}${item.例句 ? `（如「${String(item.例句).slice(0, 30)}」）` : ''}`);
  if (speech.length) lines.push(`  说话方式：${speech.join('；')}`);

  const lines3 = pick(card.台词库 || [], 3).map((item) => `「${String(item.台词).slice(0, 34)}」（${item.场合}${item.情境 ? '·' + String(item.情境).slice(0, 16) : ''}）`);
  if (lines3.length) lines.push(`  原话样例：${lines3.join(' ')}`);

  const erotic = scene && ['core', 'edge'].includes(scene.情色分级);
  if (erotic) {
    const body = pick(card.身体档案 || [], 2).map((item) => `${item.部位}：${(item.描写 || []).slice(0, 2).join('、') || (item.条目?.[0]?.引文 || '').slice(0, 20)}`);
    if (body.length) lines.push(`  身体：${body.join('；')}`);
    const reaction = pick(card.性反应 || [], 2).map((item) => `${item.反应}×${item.次数}`);
    if (reaction.length) lines.push(`  性反应：${reaction.join('、')}`);
    const sensitive = pick(card.敏感点 || [], 2).map((item) => `${item.部位}×${item.次数}`);
    if (sensitive.length) lines.push(`  敏感点：${sensitive.join('、')}`);
  }

  const outfit = pick(card.衣着档案 || [], 2).map((item) => `[${item.场合大类}] ${item.描写}`);
  if (outfit.length) lines.push(`  衣着：${outfit.join('；')}`);

  const timeline = pick((card.人生轨迹 || []).slice(-3), 3).map((item) => `${item.节点}（${item.发生了什么}）`);
  if (timeline.length) lines.push(`  最近经历：${timeline.join('；')}`);

  return lines.join('\n');
}

function sceneBlock({ scene, scenes, summaries, chains, events, stages, sceneId }) {
  if (!scene) return '';
  const index = scenes.findIndex((item) => item.sceneId === sceneId);
  const before = scenes.slice(Math.max(0, index - 2), index).map((item) => `${item.sceneId}：${(summaries[item.sceneId] || {}).情节描述 || ''}`.slice(0, 90));
  const summary = summaries[sceneId] || {};
  const chain = (chains[sceneId] || {}).动作链 || [];
  const lines = [];
  lines.push(`【当前场景】${sceneId} 第${scene.章}章　阶段：${scene.弧阶段 || ''} ${scene.场景阶段 || ''}　权力：${scene.权力 || ''}　情色：${scene.情色分级 || ''}`);
  if (summary.情节描述) lines.push(`  这场发生了什么：${summary.情节描述}`);
  if (scene.轨迹) lines.push(`  心态变化：${scene.轨迹.起点} → ${scene.轨迹.终点}`);
  if (before.length) lines.push(`  前两场：${before.join(' ／ ')}`);
  if (chain.length) lines.push(`  本场动作链：${chain.slice(0, 10).join(' → ')}`);
  const nearbyEvents = (events || []).filter((item) => item.sceneId === sceneId).map((item) => item.名称 || item.事件 || '');
  if (nearbyEvents.length) lines.push(`  关键事件：${nearbyEvents.join('、')}`);
  if (stages?.初次突破?.sceneId === sceneId) lines.push('  这一场是「初次突破」的关键场景');
  return lines.join('\n');
}

export function buildAdviseContext(dir, { sceneId, people }) {
  const dirs = layout(dir);
  const scenes = readJson(dirs.l2Scenes, { scenes: [] })?.scenes || [];
  const summaries = readJson(dirs.l2Summaries, { scenes: {} })?.scenes || {};
  const chains = readJson(dirs.l2Chains, { scenes: {} })?.scenes || {};
  const eventsDoc = readJson(dirs.l3Events, null);
  const events = Array.isArray(eventsDoc) ? eventsDoc : (eventsDoc?.events || []);
  const stages = readJson(dirs.l3Stages, null);
  const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} })?.cards || {};

  const scene = scenes.find((item) => item.sceneId === sceneId) || null;
  const sceneText = sceneBlock({ scene, scenes, summaries, chains, events, stages, sceneId });

  const names = (people && people.length ? people : (scene?.参与者 || [])).filter(Boolean).slice(0, 4);
  const personText = names.map((name) => cardBlock(cards[name], scene)).filter(Boolean).join('\n\n');

  return { sceneText, personText, names, scene, cards };
}

function promptFor({ sceneText, personText, outline }) {
  return `【任务】你要给一段情色小说的续写提写作建议。必须贴着这本书已经确立的人物和数据来写，不要套模板。

${sceneText}

【出场人物档案】
${personText || '（没有人物卡，按大纲自行把握）'}

【作者想写的大纲】
${outline}

【输出】
{"人物一致性":[{"人物":"","依据":"","怎么写":""}],
 "场景衔接":[{"从哪接":"","怎么过渡":""}],
 "动作链骨架":[""],
 "描写节点":[{"位置":"","写什么":"","技法":""}],
 "可用台词":[{"人物":"","台词":""}],
 "应避免":[""],
 "参考依据":[{"场次":"","为什么":" "}]}

【规则】
- "人物一致性"：每个人一条，依据必须引用档案里的具体内容（性格情境、说话方式、原话、身体或反应），不要写"她性格温柔"这种空话。
- "动作链骨架"：8 到 12 环，一环一句，按实际操作顺序，从当前场景的结尾或指定位置接下去。
- "描写节点"：5 到 8 个，位置写"第几环之后"，技法写具体手法（如"用触感替代视觉""用她的呼吸节奏推进"）。
- "可用台词"：4 到 8 句，必须是这个人会说的话，带她的口癖和语气；不要写成通用台词。
- "应避免"：3 到 5 条，针对这本书的常见问题（如"不要让她突然主动""不要用书面语"）。
- "参考依据"：列出你实际用到的场次号，不要编造。
- 只依据上面的档案和场景，不要引入档案里没有的设定。

只输出 JSON。`;
}

function validate(value) {
  const errors = [];
  if (!Array.isArray(value.人物一致性) || value.人物一致性.length < 1) errors.push('人物一致性 至少 1 条');
  if (!Array.isArray(value.动作链骨架) || value.动作链骨架.length < 5) errors.push('动作链骨架 至少 5 环');
  if (!Array.isArray(value.描写节点) || value.描写节点.length < 3) errors.push('描写节点 至少 3 个');
  return { ok: errors.length === 0, errors };
}

export async function adviseWithContext(ctx, { sceneId, outline, people }) {
  const blocks = buildAdviseContext(ctx.root, { sceneId, people });
  const prompt = promptFor({ ...blocks, outline });

  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await ctx.llm.chat({ system: SYSTEM, prompt: prompt + feedback, step: 'ADV', meta: { label: sceneId || 'scene' }, maxTokens: 4096 });
      const value = parseJsonObject(response.text);
      const check = validate(value);
      if (check.ok) {
        return {
          ...value,
          数据: {
            场景: sceneId || '',
            人物: blocks.names,
            档案来源: Object.keys(blocks.cards).filter((name) => blocks.names.includes(name)),
          },
        };
      }
      feedback = `\n\n上次输出不合格：${check.errors.join('；')}。请补齐。`;
    } catch (error) {
      feedback = `\n\n上次输出无法解析：${error.message}。只输出 JSON。`;
    }
  }
  return null;
}

/** 按建议写成正文：把动作链、节点、可用台词、应避免一起交给模型。 */
export async function writeFromAdvice(ctx, { outline, advice, sceneId, people, length = 1200 }) {
  const blocks = buildAdviseContext(ctx.root, { sceneId, people });
  const skeleton = (advice?.动作链骨架 || []).join('\n');
  const nodes = (advice?.描写节点 || []).map((node) => `- [${node.位置}] ${node.写什么}（${node.技法}）`).join('\n');
  const lines = (advice?.可用台词 || []).map((item) => `${item.人物}：「${item.台词}」`).join('\n');
  const avoid = (advice?.应避免 || []).join('、');

  const prompt = `【任务】按大纲与建议写一段情色小说正文。
【大纲】
${outline}

${blocks.sceneText}

【人物档案】
${blocks.personText}

【必须落实的动作链】
${skeleton}

【必须给到的描写节点】
${nodes}

【可用的台词（按人物口吻挑用，不要全塞）】
${lines}

【必须避开的表达】
${avoid || '（无）'}

【要求】
- 第三人称叙述，约 ${length} 字，连贯成段，不要小标题、不要解释。
- 严格按动作链推进，每环落到具体动作或反应。
- 台词保留引号，符合人物既有腔调。
- 不写心理独白，用动作、呼吸、触感、对话表现。
只输出正文。`;

  const response = await ctx.llm.chat({ system: SYSTEM, prompt, step: 'ADV', meta: { label: 'prose' }, maxTokens: 4096 });
  return String(response.text || '').trim();
}
