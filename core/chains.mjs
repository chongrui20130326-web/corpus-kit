import { readJson, writeJson, exists } from './store.mjs';
import { parseJsonObject } from './llm.mjs';
import { SYSTEM, COMMON } from './prompts.mjs';
import { flatten } from './split.mjs';

/**
 * PC · 色情动作链。
 *
 * 用途是**仿写模板**：别人拿着这条链，换掉人物和场景就能照着写一场戏。
 * 所以两个要求同时成立：
 *   1. 角色泛化——把"母亲/表哥"换成"女人/男人"，模板才可复用；
 *   2. 细节保留——部位、体态、动作方式、声音、台词都要留，不能压成"抚摸""亲吻"。
 *
 * 之前只做到第 1 点，链变成了情节提纲，仿写时没有参考价值。
 */

export function pActionChain({ sceneId, stage, power, actors, text }) {
  // 原文太长时模型会开始"总结"而不是输出 JSON，截到 1200 字保住输出格式。
  const body = String(text || '').slice(0, 1200);
  return `只输出一个 JSON 对象，第一个字符必须是 {，最后一个字符必须是 }。不要解释、不要总结、不要加代码块标记。

【任务】把下面这场戏改写成一条可复用的动作链模板。
【输入】
场景：${sceneId}　阶段：${stage}　权力：${power}　参与者：${actors}
原文：
${body}

【输出格式（照这个结构填）】
{"sceneId":"${sceneId}","主动者":["原文里的称呼"],"被动者":["原文里的称呼"],"动作链":"第一环 10 到 35 字 → 第二环 → 第三环 → 第四环 → 第五环 → 第六环","反应序列":"状态词 → 状态词 → 状态词 → 状态词","模板":["抽象词","抽象词","抽象词"]}

【硬性要求】
- 动作链 6 到 12 环，每环 10 到 35 字，用 → 连接，总长 120 到 500 字
- 反应序列 4 到 8 个状态词，用 → 连接
- 模板 3 到 6 个抽象词
- 主动者 / 被动者 必须来自原文里的称呼
- 字符串内不要出现英文双引号，引用原文时用「」
- 只依据原文，不补充原文没有的动作
`;
}



/** 模型输出的 JSON 常常缺逗号或带未转义引号，正则直接把四个字段抠出来。 */
function salvageChain(rawText, sceneId) {
  const source = String(rawText || '');
  const pick = (key) => {
    const match = source.match(new RegExp('"' + key + '"\\s*:\\s*"([\\s\\S]*?)"\\s*,\\s*"'));
    return match ? match[1] : '';
  };
  const pickArray = (key) => {
    const match = source.match(new RegExp('"' + key + '"\\s*:\\s*\\[([\\s\\S]*?)\\]'));
    if (!match) return [];
    return [...match[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]).filter(Boolean);
  };

  let chain = pick('动作链');
  // 动作链是最后一个字段时，后面没有逗号
  if (!chain) {
    const match = source.match(/"动作链"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
    chain = match ? match[1] : '';
  }
  let flow = pick('反应序列');
  if (!flow) {
    const match = source.match(/"反应序列"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
    flow = match ? match[1] : '';
  }

  return {
    sceneId,
    主动者: pickArray('主动者'),
    被动者: pickArray('被动者'),
    动作链: chain,
    反应序列: flow,
    模板: pickArray('模板'),
  };
}

/** 某本书的 PC 跑不通时，放一个 .skip-pc 标记，直接跳过这一步。 */
function pcSkipped(dirs) {
  try { return fs.existsSync(dirs.root + '/.skip-pc'); } catch { return false; }
}

export function validateChains(value, ctx) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['返回值不是对象'], value: null };
  if (value.sceneId !== ctx.sceneId) errors.push(`sceneId 应为 ${ctx.sceneId}`);

  const actors = Array.isArray(value.主动者) ? value.主动者.filter((name) => typeof name === 'string' && name.trim()) : [];
  const receivers = Array.isArray(value.被动者) ? value.被动者.filter((name) => typeof name === 'string' && name.trim()) : [];
  if (!actors.length) errors.push('主动者 不能为空');
  if (!receivers.length) errors.push('被动者 不能为空');

  let chain = typeof value.动作链 === 'string' ? value.动作链.trim() : '';
  if (!chain) errors.push('动作链 必须是非空字符串');
  else {
    let links = chain.split('→').map((item) => item.trim()).filter(Boolean);

    // 模型经常写过长的链（60+ 环）：不整段作废，按 20 环合并——相邻两环合成一环。
    while (links.length > 20) {
      const merged = [];
      for (let index = 0; index < links.length; index += 2) {
        merged.push(index + 1 < links.length ? links[index] + '，' + links[index + 1] : links[index]);
      }
      links = merged;
    }
    if (links.length < 6) errors.push(`动作链只有 ${links.length} 环，至少 6 环`);
    const rebuilt = links.join(' → ');
    if (rebuilt.length > 900) {
      chain = rebuilt.slice(0, 900);
    } else {
      chain = rebuilt;
    }
    if (chain.length < 45) errors.push(`动作链总长 ${chain.length} 字，太短，细节不够`);
    const thin = links.filter((link) => link.length < 8);
    // 合并后必然有长环，短环只做提示，不再判失败
    if (thin.length > links.length / 2) errors.push(`动作链有 ${thin.length} 环短于 8 字，写具体一点`);
    value.动作链 = chain;
  }

  let flow = typeof value.反应序列 === 'string' ? value.反应序列.trim() : '';
  if (flow) {
    let words = flow.split('→').map((item) => item.trim()).filter(Boolean);
    if (words.length > 12) {
      // 只保留前 12 个，不判失败
      words = words.slice(0, 12);
      value.反应序列 = words.join(' → ');
      flow = value.反应序列;
    }
  }

  // 模板是锦上添花，模型给不出来就不强求。
  if (value.模板 !== undefined && !Array.isArray(value.模板)) errors.push('模板 必须是数组');  return { ok: errors.length === 0, errors, value };
}

/** 节拍兜底时，把"谁主动"换成男人/女人。 */
function roleOf(name, actives, passives) {
  if (!name) return '';
  if (passives.includes(name)) return '女人';
  if (actives.includes(name)) return '男人';
  return name;
}

/** 把角色名换成通用称呼：模板要能给别人用，不能带着本书的人名。 */function generalizeRoles(value) {
  if (!value || typeof value !== 'object') return value;
  const pairs = [
    ...(value.主动者 || []).map((name) => [name, '男人']),
    ...(value.被动者 || []).map((name) => [name, '女人']),
  ].filter(([name]) => typeof name === 'string' && name.trim().length >= 2)
    .sort((a, b) => b[0].length - a[0].length);

  for (const field of ['动作链', '反应序列']) {
    if (typeof value[field] !== 'string') continue;
    let text = value[field];
    for (const [name, label] of pairs) text = text.split(name).join(label);
    value[field] = text;
  }
  return value;
}

function repairChain(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value.动作链)) value.动作链 = value.动作链.join(' → ');
  if (typeof value.动作链 !== 'string') value.动作链 = '';
  value.动作链 = value.动作链
    .replace(/\r?\n+/g, ' → ')
    .replace(/[0-9０-９]+\s*[.、)）]\s*/g, '')
    .replace(/\s*[→➡>-]{1,2}\s*/g, ' → ')
    .replace(/(\s*→\s*)+/g, ' → ')
    .replace(/^\s*→\s*|\s*→\s*$/g, '')
    .trim();

  if (typeof value.反应序列 !== 'string') value.反应序列 = '';
  if (Array.isArray(value.反应序列)) value.反应序列 = value.反应序列.join(' → ');
  value.反应序列 = value.反应序列
    .replace(/\r?\n+/g, ' → ')
    .replace(/\s*[→➡>-]{1,2}\s*/g, ' → ')
    .replace(/(\s*→\s*)+/g, ' → ')
    .replace(/^\s*→\s*|\s*→\s*$/g, '')
    .trim();

  // 模板：模型有时给字符串、有时给数组，统一成数组。
  if (typeof value.模板 === 'string') value.模板 = value.模板.split(/[→、,，/;；\s]+/u).map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(value.模板)) value.模板 = [];

  // 反应序列模型经常给不出来：用链里以被动者开头的那几环兜底，至少保证有内容。
  if (!value.反应序列) {
    const links = value.动作链.split('→').map((item) => item.trim()).filter(Boolean);
    const passive = links.filter((link) => link.startsWith('女人')).slice(0, 8);
    value.反应序列 = passive.length >= 3 ? passive.join(' → ') : '';
  }
  return value;
}

/**
 * 只有真的含性行为或明确情欲身体描写的场景才做动作链。
 * 像"喝交杯酒"这种张力场景，虽然被判成情色段，但没有性动作可梳理。
 */
const EROTIC_KEYWORDS = /插入|射精|射了|口交|舔|含住|吮|抽送|耸动|勃起|勃|阴茎|龟头|蜜穴|阴道|阴户|阴蒂|肛门|乳|胸|臀|裸|赤裸|呻吟|喘息|湿透|爱液|精液|交合|性交|骑|后入/;
const ACT_STAGES = new Set(['进入', '过程', '换位', '高潮', '事后']);

export function isEroticScene(text, analysis, extra = {}) {
  // 初次突破、首次发生、强迫类场景，即使原文用词克制，也一定是色情场景。
  if (extra.breakthrough || analysis?.是否首次) return true;
  if (['强迫', '胁迫', '无意识'].includes(analysis?.权力)) return true;
  if (ACT_STAGES.has(analysis?.阶段)) return true;
  if (!text) return false;
  const hits = text.match(new RegExp(EROTIC_KEYWORDS.source, 'g')) || [];
  return hits.length >= 3;
}

export async function runChains(ctx, scenes) {
  const { dirs } = ctx;

  const rows = flatten(ctx.book);
  const textOf = (scene) => {
    const start = rows.findIndex((item) => item.id === scene.从);
    const end = rows.findIndex((item) => item.id === scene.到);
    if (start < 0 || end < start) return '';
    return rows.slice(start, end + 1).map((item) => item.text).join('\n');
  };

  // 增量：已有的场景直接复用，只补缺失的（--force 时全部重算）。
  const existing = !ctx.force && exists(dirs.l2Chains) ? (readJson(dirs.l2Chains, { scenes: {} }).scenes || {}) : {};
  const chains = { ...existing };
  const targets = scenes.filter((scene) => scene.是否含情色 !== false && !existing[scene.sceneId]);
  const breakthroughId = readJson(dirs.l3SceneIndex, null)?.breakthrough?.sceneId ?? null;

  await ctx.pool(targets, async (scene) => {
    const analysis = readJson(dirs.l2File(scene.sceneId), null);
    if (!analysis) return;
    const text = textOf(scene);
    if (!text) return;
    // 非色情场景不建动作链。
    if (!isEroticScene(text, analysis, { breakthrough: scene.sceneId === breakthroughId })) return;

    const prompt = pActionChain({
      sceneId: scene.sceneId,
      stage: analysis.阶段 || '',
      power: analysis.权力 || '',
      actors: (analysis.参与者 || []).map((person) => `${person.角色}（${person.动机 || '—'}）`).join('、') || '未明',
      text,
    });

    let feedback = '';
    const attempts = pcSkipped(dirs) ? 0 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await ctx.llm.chat({
          system: SYSTEM,
          prompt: prompt + feedback,
          step: 'PC',
          meta: { sceneId: scene.sceneId, text, label: scene.sceneId },
          maxTokens: 1200,
        });
        let parsed = null;
        try {
          parsed = parseJsonObject(response.text);
        } catch {
          // JSON 坏了：按字段名正则抠出来再校验
          parsed = salvageChain(response.text, scene.sceneId);
        }
        const value = generalizeRoles(repairChain(parsed));
        const result = validateChains(value, { sceneId: scene.sceneId, text });
        if (result.ok) { chains[scene.sceneId] = value; return; }
        feedback = `\n\n上次输出未通过校验：\n- ${result.errors.slice(0, 8).join('\n- ')}`;
        ctx.log({ step: 'PC', target: scene.sceneId, status: 'invalid', errors: result.errors.slice(0, 5) });
      } catch (error) {
        feedback = `\n\n上次输出无法解析：${error.message}。请只输出 JSON。`;
        ctx.log({ step: 'PC', target: scene.sceneId, status: 'error', error: error.message });
      }
    }

    ctx.failed.push(`PC ${scene.sceneId}`);
    ctx.log({ step: 'PC', target: scene.sceneId, status: 'failed' });

    // 兜底：模型三次都不合格时，用场景分析的「节拍」拼一条，至少别让这场是空的。
    const beats = (analysis.节拍 || []).filter((beat) => beat.动作);
    if (beats.length >= 3) {
      const names = (analysis.参与者 || []).map((person) => person.角色).filter(Boolean);
      const actives = names.slice(0, 1);
      const passives = names.slice(1, 2);
      // 节拍里的"谁主动"经常缺或者标错，兜底时不再给人名加前缀，免得把主动方写反。
      const links = beats.map((beat) => beat.动作);
      chains[scene.sceneId] = {
        sceneId: scene.sceneId,
        主动者: actives,
        被动者: passives,
        动作链: links.join(' → '),
        反应序列: '',
        模板: [],
        来源: 'beats',
      };
      ctx.log({ step: 'PC', target: scene.sceneId, status: 'fallback-beats' });
    }
  });

  const document = { generatedAt: new Date().toISOString(), scenes: chains };
  writeJson(dirs.l2Chains, document);
  return document;
}
