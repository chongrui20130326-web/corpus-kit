import { readJson } from './store.mjs';
import { parseJsonObject } from './llm.mjs';
import { SYSTEM } from './prompts.mjs';
import { buildIndex } from './corpusIndex.mjs';

/**
 * 续写顾问（跨书版）。
 *
 * 流程：拆解大纲 → 在全部书里检索最接近的场景 → 出建议 → （作者采纳后）写成正文。
 * 拆解出来的「环境 / 性爱类型」是检索的主键，比整段文字比相似度准得多。
 */

const PLACES = ['卧室', '客厅', '浴室', '厨房', '车内', '办公室', '户外', '酒店', '其他'];
const ACTS = ['口交', '乳交', '手交', '指交', '插入', '肛交', '后入', '骑乘', '捆绑', '调教', '多人', '露出', '镜前', '足部'];
const STAGES = ['前戏', '进入', '过程', '换位', '高潮', '事后'];
const POWERS = ['自愿', '半推半就', '强迫', '胁迫', '交易', '无意识'];

function bigrams(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fff]/g, '');
  const set = new Set();
  for (let index = 0; index + 2 <= clean.length; index += 1) set.add(clean.slice(index, index + 2));
  return set;
}

/* ------------------------------ 1. 拆解大纲 ------------------------------ */

export async function parseOutline(ctx, outline) {
  const prompt = `【任务】把作者的大纲拆成结构化字段，供语料检索使用。只输出 JSON。
【大纲】
${outline}

【输出】
{"环境":{"地点":"卧室","时间":"夜晚","私密性":"独处"},
 "性爱类型":["插入","后入"],
 "关系":"母子/情侣/上下级/陌生/其他",
 "权力":"自愿",
 "阶段":"过程",
 "强度":3,
 "人物":["母亲","表哥"],
 "关键动作":"一句话概括这一场最核心的那个动作"}

【规则】
- 地点只能取：${PLACES.join('/')}；无法判断填"其他"。
- 时间只能取：白天/夜晚/未知。
- 私密性只能取：独处/有人在外/公开。
- 性爱类型只能从以下选，可多选，没有就空数组：${ACTS.join('/')}。
- 权力只能取：${POWERS.join('/')}。
- 阶段只能取：${STAGES.join('/')}。
- 强度是 1 到 5 的整数，1 最含蓄、5 最露骨。
- 人物只列大纲里出现的角色名。
- 只依据大纲，不要补充大纲没有的情节。

${'只输出 JSON。'}`;

  const response = await ctx.llm.chat({ system: SYSTEM, prompt, step: 'ADV', meta: { label: 'outline' }, maxTokens: 1024 });
  try {
    return parseJsonObject(response.text);
  } catch {
    return { 环境: { 地点: '其他', 时间: '未知', 私密性: '独处' }, 性爱类型: [], 关系: '', 权力: '', 阶段: '', 强度: 3, 人物: [], 关键动作: '' };
  }
}

/* ------------------------------ 2. 跨书检索 ------------------------------ */

export function retrieveCross(index, dims, outline, options = {}) {
  const limit = options.limit ?? 4;
  const outlineGrams = bigrams(outline);
  const wantedActs = new Set(dims.性爱类型 || []);
  const wantPlace = dims.环境?.地点 || '';
  const wantPower = dims.权力 || '';
  const wantStage = dims.阶段 || '';
  const names = (dims.人物 || []).filter(Boolean);

  const scored = index.map((entry) => {
    let score = 0;
    const reasons = [];

    const actHits = entry.acts.filter((act) => wantedActs.has(act));
    if (actHits.length) { score += actHits.length * 4; reasons.push(`类型:${actHits.join('/')}`); }

    if (wantPlace && (entry.places.includes(wantPlace) || entry.place.includes(wantPlace))) { score += 3; reasons.push(`地点:${wantPlace}`); }
    if (wantPower && entry.power === wantPower) { score += 2; reasons.push(`权力:${wantPower}`); }
    if (wantStage && entry.sceneStage === wantStage) { score += 2; reasons.push(`阶段:${wantStage}`); }

    for (const name of names) {
      if (entry.participants.some((item) => item.includes(name)) || entry.summary.includes(name)) { score += 2; reasons.push(`人物:${name}`); }
    }

    const haystack = `${entry.summary}${entry.conflict}${entry.result}${entry.chain}`;
    let overlap = 0;
    for (const gram of bigrams(haystack)) if (outlineGrams.has(gram)) overlap += 1;
    score += overlap * 0.12;

    return { entry, score, reasons };
  });

  // 同一本书最多取 2 场，避免参考全挤在一本书里。
  const picked = [];
  const perBook = new Map();
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    if (item.score <= 0) break;
    const used = perBook.get(item.entry.book) || 0;
    if (used >= 2) continue;
    perBook.set(item.entry.book, used + 1);
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}

/* ------------------------------ 3. 出建议 ------------------------------ */

export function buildPrompt({ outline, dims, picked, cliches, characters }) {
  const refs = picked.map((item, i) => `【参考${i + 1}】《${item.entry.bookTitle}》${item.entry.sceneId}　${item.entry.stage}　${item.entry.power}　${item.entry.place}
命中原因：${item.reasons.join('，') || '文本相近'}
情节：${item.entry.summary}
矛盾：${item.entry.conflict}
动作链：${item.entry.chain || '无'}
承载句：${item.entry.carry.join(' / ') || '无'}
描写：${item.entry.quotes.join(' / ') || '无'}`).join('\n\n');

  return `【任务】你是色情小说写作顾问。作者给出大纲，请给出这一场戏的写作建议。
**不写正文**，只给骨架、节点和可参考的原文。

【作者的大纲】
${outline}

【大纲拆解】
环境：${dims.环境?.地点 || '—'} / ${dims.环境?.时间 || '—'} / ${dims.环境?.私密性 || '—'}
性爱类型：${(dims.性爱类型 || []).join('、') || '—'}
关系：${dims.关系 || '—'}　权力：${dims.权力 || '—'}　阶段：${dims.阶段 || '—'}　强度：${dims.强度 ?? '—'}/5
核心动作：${dims.关键动作 || '—'}
${characters ? `人物设定：${characters}` : ''}

【跨书检索到的参考（来自 ${new Set(picked.map((item) => item.entry.bookTitle)).size} 本书）】
${refs}

【这本书里用滥的表达（必须避开）】
${cliches.length ? cliches.join('、') : '（暂无）'}

【输出】严格 JSON：
{
 "情境判断": {"阶段": "前戏", "权力": "自愿", "关系": "", "人物状态": ""},
 "推荐轨迹": {"起点": "", "终点": "", "触发": ""},
 "动作链骨架": ["男人…… → 女人……（10 到 16 环）"],
 "描写节点": [{"位置": "开场/中段/转折/收尾", "写什么": "", "技法": "触觉/感官/动作分解/心理侧写/留白"}],
 "应避免": ["3 到 6 条"],
 "参考": [{"book": "书名", "sceneId": "S06", "为什么像": "一句话"}]
}

【规则】
- 阶段与权力必须从上文的词表里选。
- 动作链骨架要能直接套用：角色泛化成"男人/女人"，保留部位、体态、动作方式和台词，10 到 16 环。
- 描写节点 3 到 5 个，写"该给什么细节"，不要写成品句子。
- 参考只能引用上面给出的场景，book 和 sceneId 逐字照抄。
- 大纲没写的人物和情节不要补。

只输出 JSON。`;
}

export function validateAdvice(value) {
  const errors = [];
  if (!value || typeof value !== 'object') return { ok: false, errors: ['不是对象'] };
  if (!value.情境判断 || typeof value.情境判断 !== 'object') errors.push('缺少 情境判断');
  if (!value.推荐轨迹 || typeof value.推荐轨迹 !== 'object') errors.push('缺少 推荐轨迹');
  if (!Array.isArray(value.动作链骨架) || !value.动作链骨架.length) errors.push('缺少 动作链骨架');
  if (!Array.isArray(value.描写节点) || value.描写节点.length < 3) errors.push('描写节点 少于 3 个');
  return { ok: errors.length === 0, errors };
}

export async function advise(ctx, { outline, characters }) {
  const dims = await parseOutline(ctx, outline);
  const index = buildIndex(ctx.root);
  const picked = retrieveCross(index, dims, outline, { limit: 4 });

  if (!picked.length) {
    return { 错误: '语料里没有找到接近的场景', 拆解: dims, 动作链骨架: [], 描写节点: [] };
  }

  const clicheFile = readJson(`${ctx.dirs.stats}/cliches.json`, null);
  const cliches = (clicheFile?.frequent || []).filter((item) => item.scenes >= 2).slice(0, 8).map((item) => item.gram);
  const prompt = buildPrompt({ outline, dims, picked, cliches, characters });

  let feedback = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await ctx.llm.chat({ system: SYSTEM, prompt: prompt + feedback, step: 'ADV', meta: { label: 'advice' }, maxTokens: 3072 });
      const value = parseJsonObject(response.text);
      const result = validateAdvice(value);
      if (result.ok) return { ...value, 拆解: dims, 参考: picked.map((item) => ({ book: item.entry.bookTitle, sceneId: item.entry.sceneId, 为什么像: item.reasons.join('，'), summary: item.entry.summary })) };
      feedback = `\n\n上次输出不合格：${result.errors.join('；')}。请补齐字段。`;
    } catch (error) {
      feedback = `\n\n上次输出无法解析：${error.message}。只输出 JSON。`;
    }
  }
  return null;
}

/* ------------------------------ 4. 采纳后写成正文 ------------------------------ */

export async function writeProse(ctx, { outline, advice, characters, length = 900 }) {
  const skeleton = Array.isArray(advice?.动作链骨架) ? advice.动作链骨架.join('\n') : '';
  const nodes = (advice?.描写节点 || []).map((node) => `- [${node.位置}] ${node.写什么}（${node.技法}）`).join('\n');
  const avoid = (advice?.应避免 || []).join('、');

  const prompt = `【任务】按大纲和写作建议，写出一段完整的小说正文。
【大纲】
${outline}
${characters ? `\n【人物】\n${characters}` : ''}

【必须落实的动作链】
${skeleton}

【必须给到的描写节点】
${nodes}

【必须避开的表达】
${avoid || '（无）'}

【要求】
- 写成连贯的第三人称叙述，约 ${length} 字，不要分段标题、不要解释。
- 严格按动作链的顺序推进，每环都要落到具体的动作或反应上，不能跳过。
- 每个描写节点都要有对应的细节，写在它该出现的段落里。
- 对话保留引号，不要写成转述。
- 不写心理分析段落，情绪通过动作、体态、生理反应体现。
- 不要使用上面列出的禁用表达；也不要使用"令人震惊""无法自拔"这类套话。
- 只输出正文，不要任何前后缀。

只输出正文。`;

  let feedback = '';
  const proseSystem = '你是中文小说写作者。直接输出正文，不要 JSON、不要代码围栏、不要任何解释。';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await ctx.llm.chat({ system: proseSystem, prompt: prompt + feedback, step: 'ADV', meta: { label: 'prose' }, maxTokens: 4096 });
    let text = String(response.text || '').trim();
    // 有些模型仍会套一层 JSON，剥掉。
    if (text.startsWith('{')) {
      try {
        const parsed = parseJsonObject(text);
        text = String(parsed.content || parsed.text || parsed.正文 || '').trim() || text;
      } catch { /* 不是 JSON 就原样保留 */ }
    }
    if (text.length >= 200) return text;
    feedback = '\n\n上次太短了，请写满要求字数，并保留动作链的每一环。';
  }
  return null;
}
