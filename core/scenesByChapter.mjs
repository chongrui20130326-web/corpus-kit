/**
 * 按章调度、场景跨章延续的切分器。
 *
 * 关键点：**章只是调度单位，不是场景边界。**
 *
 * 状态跨章保留：
 *   - 一章处理完，如果还有一场没结束，不关闭它，原样留给下一章；
 *   - 下一章的第一块进来时，用"上一场状态"判断它是否延续；
 *   - 只有内容真的换了地点/时间/人物，才关闭当前场、开新场。
 *
 * 这样 17 章的书也能按章推进进度，同时不会把"上一章插进去、下一章还在动"的戏切两半。
 */

const BLOCK = 6;

function prompt({ prevState, currentLength, block, prevTail }) {
  return `【任务】判断待判段落里，从哪里开始是新的一场戏。
【上一场状态】${prevState || '（还没有场景）'}
【上一场到目前已有段落数】${currentLength}
【上一场最后几段】
${prevTail.length ? prevTail.join('\n') : '（无）'}

【待判段落】
${block.map((row) => `${row.id}｜${row.text}`).join('\n')}

【输出】
{"切分点":[2],"本场状态":"40 字以内：地点 + 在场人物 + 动作到哪一步 + 被动方状态"}
或
{"切分点":[],"本场状态":"..."}

【规则】
- 切分点是**待判段落里的下标**（从 0 开始）。这几段全部属于上一场时输出空数组。
- **上一场可能还没结束**：如果这几段还在同一个地点、同一批人、同一条动作线上，就是延续，输出空数组。
- 以下情况才切：换了地方、时间跳了、关键人物进出改变局面、一件事做完开始另一件事。
- 以下情况不要切：只是插了一句对话/心理/交代，主线没断；同一个动作的继续。
- 当前段落数加这批超过 15 段时，必须在最像新起点的地方切一次。
- "本场状态"要具体：地点 + 人物 + 动作到了哪一步 + 被动方状态。
- 只输出 JSON。`;
}

export function validateSegmentation(value, blockSize) {
  const errors = [];
  if (!value || typeof value !== 'object') return { ok: false, errors: ['不是对象'] };
  const cuts = value.切分点;
  if (!Array.isArray(cuts)) errors.push('切分点 必须是数组');
  else {
    for (const cut of cuts) {
      if (!Number.isInteger(cut) || cut < 0 || cut >= blockSize) errors.push(`切分点 ${cut} 越界`);
    }
    if (cuts.some((cut, index) => index > 0 && cut <= cuts[index - 1])) errors.push('切分点必须递增');
  }
  if (typeof value.本场状态 !== 'string' || !value.本场状态.trim()) errors.push('本场状态 不能为空');
  return { ok: errors.length === 0, errors };
}

/**
 * 逐章推进场景切分，状态跨章保留。
 * @param chapters [{ index, title, paragraphs:[{id,text}] }]
 * @returns { scenes: [{ids:[], state:'', chapters:[]}], open: 最后是否还有未结束的场景 }
 */
export async function segmentByChapters(ctx, chapters, options = {}) {
  const blockSize = options.blockSize ?? BLOCK;
  const scenes = [];
  let current = null;      // { ids:[], state:'' }
  let prevState = '';
  let recent = [];         // 上一场最后几段，供判断延续

  const openScene = () => {
    current = { ids: [], state: '', chapters: [] };
    scenes.push(current);
    return current;
  };

  for (const chapter of chapters) {
    const rows = chapter.paragraphs;

    for (let offset = 0; offset < rows.length; offset += blockSize) {
      const slice = rows.slice(offset, offset + blockSize);
      if (!current) openScene();

      let value = null;
      let feedback = '';
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await ctx.llm.chat({
            system: '你是中文小说的结构化标注器。只输出一个合法 JSON 对象。',
            prompt: prompt({ prevState, currentLength: current.ids.length, block: slice, prevTail: recent }) + feedback,
            step: 'P2',
            meta: { label: `ch${chapter.index}.${offset}` },
            maxTokens: 1024,
          });
          const parsed = JSON.parse(String(response.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
          const result = validateSegmentation(parsed, slice.length);
          if (result.ok) { value = parsed; break; }
          feedback = `\n\n上次输出不合格：${result.errors.join('；')}`;
        } catch (error) {
          feedback = `\n\n上次输出无法解析：${error.message}`;
        }
      }

      // 判不出来就整块并入当前场，绝不丢段落。
      if (!value) {
        for (const row of slice) current.ids.push(row.id);
        if (!current.chapters.includes(chapter.index)) current.chapters.push(chapter.index);
        continue;
      }

      const cuts = [...new Set(value.切分点)].sort((a, b) => a - b);
      let start = 0;
      for (const cut of cuts) {
        for (let index = start; index < cut; index += 1) current.ids.push(slice[index].id);
        if (!current.chapters.includes(chapter.index)) current.chapters.push(chapter.index);
        // 这一场到此为止：保留它自己结尾时的状态，不要用切分后那一场的状态覆盖。
        if (!current.state) current.state = slice[start]?.text?.slice(0, 30) || '';
        // 关闭当前场，开新场；新场同样属于本章
        openScene();
        current.state = value.本场状态;
        current.chapters.push(chapter.index);
        start = cut;
      }
      for (let index = start; index < slice.length; index += 1) current.ids.push(slice[index].id);
      current.state = value.本场状态;
      if (!current.chapters.includes(chapter.index)) current.chapters.push(chapter.index);
      prevState = value.本场状态;
      recent = rows.slice(Math.max(0, offset + slice.length - 2), offset + slice.length).map((row) => `${row.id}｜${row.text.slice(0, 40)}`);
    }

    // 关键：章节结束不关闭场景，留给下一章判断是否延续。
    options.onChapter?.(chapter.index, chapters.length);
  }

  return { scenes: scenes.filter((scene) => scene.ids.length), open: Boolean(current && current.ids.length) };
}
