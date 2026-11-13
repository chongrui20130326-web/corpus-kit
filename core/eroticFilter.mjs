const PARTS = /胸|乳|奶子|臀|屁股|腿|大腿|腰|腹|肚|肩|背|颈|脖|唇|舌|口|嘴|脸|睫|眉|发|手|指|腕|耳|肌肤|皮|肉|身|下身|私处|阴|穴|花心|宫|玉足|脚|趾/;
const ACTS = /插|抽|送|顶|撞|耸|挺|磨|蹭|抚|摸|揉|捏|捻|搓|舔|含|吮|吸|咬|吻|亲|啃|搂|抱|压|按|拽|拖|扒|脱|剥|解|掀|撩|掰|抬|举|扣|攥|抓|握|蹭|蹭/;
const STATES = /湿|硬|涨|胀|酥|软|麻|痒|烫|热|哆嗦|颤|抖|痉挛|绷紧|收紧|收缩|喘|呻吟|哼|吟|叫|喊|哑|哽咽|失神|恍惚|发白|泛红|潮红|汗|水|滑|黏|浊|腥/;
const SEXUAL = /性交|性爱|性欲|性器|性事|性行为|情欲|欲火|欲望|快感|高潮|射精|精液|爱液|淫|骚|媚|荡|羞耻|屈辱|耻辱|交合|做爱|调教|强奸|强暴|口交|后入|抽送/;

export function isEroticQuote(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (SEXUAL.test(value)) return true;
  const strong = (value.match(ACTS) || []).length;
  const body = (value.match(PARTS) || []).length;
  const state = (value.match(STATES) || []).length;
  // 动作 + 身体/状态才算色情；只有"她很好看"这种不算。
  if (strong >= 1 && (body >= 1 || state >= 1)) return true;
  return body >= 2 && state >= 1;
}

/**
 * 二次判定：把候选摘录交给模型逐条判断"这是不是色情描写"。
 *
 * 关键词过滤只能拦住明显不是的（"母亲酒量不好""他推开门"），
 * 拦不住"提到身体但没性意味"的那种（"给母亲提了热水洗漱"）。
 * 每场多一次小调用，把候选逐条过一遍，比纯正则准得多。
 */
export async function classifyExcerpts(ctx, quotes) {
  if (!quotes.length) return [];
  const numbered = quotes.map((quote, index) => `${index}. ${quote}`).join('\n');

  const prompt = `【任务】逐条判断下面的句子是不是**色情描写**，保留是色情的，删掉其余的。
【判定标准】必须本身带性意味：身体接触、性器官、性行为、性快感、性反应、带性意味的对话或心理。
以下都不算：环境景物、家常生活（吃饭洗漱睡觉铺床）、赶路进门、剧情交代、人物介绍、与性无关的对话。
【候选】
${numbered}

【输出】{"保留":[0,2,5]}
- 只输出被判为色情的下标，按原顺序。
- 一条都不是就输出 {"保留":[]}。
- 只输出 JSON。`;

  try {
    const response = await ctx.llm.chat({ system: '你是文本判定器。只输出 JSON。', prompt, step: 'P7', meta: { label: 'classify' }, maxTokens: 512 });
    const raw = String(response.text || '');
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('没有 JSON');
    const parsed = JSON.parse(match[0]);
    const keep = Array.isArray(parsed.保留) ? parsed.保留 : [];
    // 模型明确说"一条都不算"就照办——空结果是正确的，不要拿关键词结果补回来。
    return keep
      .filter((index) => Number.isInteger(index) && index >= 0 && index < quotes.length)
      .map((index) => quotes[index]);
  } catch {
    return quotes.filter((quote) => isEroticQuote(quote));
  }
}
export function trimToErotic(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (!isEroticQuote(value)) return '';

  // 先按句切；整条只有一句时，退到按逗号切，把开头的交代从句切掉。
  let parts = value.split(/(?<=[。！？])/).map((item) => item.trim()).filter(Boolean);
  if (parts.length <= 1) parts = value.split(/(?<=[，；])/).map((item) => item.trim()).filter(Boolean);
  if (parts.length <= 1) return value;

  const first = parts.findIndex((part) => isEroticQuote(part));
  if (first === -1) return '';
  if (first === 0) return value;
  return parts.slice(first).join('');
}
