import fs from 'node:fs';
import path from 'node:path';

const read = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

/** 列出语料根目录下所有含 book.json 的工作目录。 */
export function listBooks(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const book = read(path.join(dir, 'book.json'));
      if (!book) return null;
      const index = read(path.join(dir, 'l3', 'scene-index.json'));
      const scenes = index?.scenes?.length ?? 0;
      return {
        id: entry.name,
        title: book.title,
        chapters: book.chapterCount,
        paragraphs: book.paragraphCount,
        scenes,
        stages: index?.stages?.length ?? 0,
        hasL4: fs.existsSync(path.join(dir, 'l4')),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.scenes - a.scenes);
}

/** 把一本书的所有层合并成一个对象，前端一次拿全，不用来回请求。 */
export function loadBook(root, id) {
  const dir = path.join(root, id);
  if (!fs.existsSync(path.join(dir, 'book.json'))) return null;

  const book = read(path.join(dir, 'book.json'));
  const index = read(path.join(dir, 'l3', 'scene-index.json'));
  const stages = read(path.join(dir, 'l3', 'stages.json'));
  const breakthrough = read(path.join(dir, 'l3', 'breakthrough.json'));
  const cliches = read(path.join(dir, 'stats', 'cliches.json'));
  const summaries = read(path.join(dir, 'l2', 'summaries.json'))?.scenes ?? {};
  const chains = read(path.join(dir, 'l2', 'chains.json'))?.scenes ?? {};
  const eventsFile = read(path.join(dir, 'l3', 'events.json'));
  const events = eventsFile?.events ?? [];
  const cardsFile = read(path.join(dir, 'l2', 'cards.json'));

  const paragraphs = [];
  for (const chapter of book.chapters || []) {
    for (const paragraph of chapter.paragraphs || []) {
      paragraphs.push({ id: paragraph.id, chapter: chapter.index, chapterTitle: chapter.title, text: paragraph.text });
    }
  }
  const paragraphMap = new Map(paragraphs.map((item) => [item.id, item]));

  // 每段的 40 字概括，用来拼出「场景摘要」——这是 L1 那层留下的东西。
  const paragraphSummary = new Map();
  const l1Dir = path.join(dir, 'l1');
  if (fs.existsSync(l1Dir)) {
    for (const file of fs.readdirSync(l1Dir).filter((name) => name.endsWith('.json'))) {
      const chapter = read(path.join(l1Dir, file));
      for (const item of chapter?.paragraphs ?? []) {
        if (item?.id && item?.概括) paragraphSummary.set(item.id, item.概括);
      }
    }
  }

  const scenes = (index?.scenes || []).map((scene) => {
    const l4 = read(path.join(dir, 'l4', `${scene.sceneId}.json`));
    const l2 = read(path.join(dir, 'l2', 'analysis', `${scene.sceneId}.json`));
    const merged = {
      ...scene,
      参与者: scene.参与者?.length ? scene.参与者 : (l2?.参与者 ?? []).map((person) => person.角色).filter(Boolean),
      参与者详情: l2?.参与者 ?? [],
      反应链: l2?.反应链 ?? [],
      节拍: l2?.节拍 ?? [],
      是否首次: l2?.是否首次 ?? scene.是否首次,
      承载句: l4?.承载句 ?? [],
      功能序列: l4?.功能序列 ?? [],
      手法: l4?.手法 ?? null,
      描写摘录: Array.isArray(l4?.描写摘录) ? l4.描写摘录 : (l4?.金句 ? [l4.金句] : []),
    };

    // 场景摘要：把这一段范围内每段的概括接起来，去掉重复的。
    const start = Number(String(scene.从).slice(1));
    const end = Number(String(scene.到).slice(1));
    const parts = [];
    for (let n = start; n <= end; n += 1) {
      const text = paragraphSummary.get(`P${String(n).padStart(4, '0')}`);
      if (text && !parts.includes(text)) parts.push(text);
    }
    merged.摘要 = parts.join('；').slice(0, 160);
    merged.场景摘要 = summaries[scene.sceneId] ?? null;
    merged.动作链 = chains[scene.sceneId] ?? null;

    // 描写摘录是主体，承载句补充「推动位移」的那几句，去重后一起当可引用素材。
    const quotes = [...(merged.描写摘录 || [])];
    for (const item of merged.承载句 || []) {
      if (quotes.length >= 16) break;
      if (item?.句 && !quotes.includes(item.句)) quotes.push(item.句);
    }
    merged.引用句 = quotes;

    // 没有状态位移的场次，模型仍会填一个「转折句」。那不是转折，只是这场里最要紧的一句。
    // 拆成两个字段：转折句只留给真有位移的场次，其余的降级成关键句。
    if (!merged.轨迹 && merged.转折句) {
      merged.关键句 = merged.转折句;
      merged.转折句 = '';
    }
    return merged;
  });

  return {
    id,
    title: book.title,
    source: book.source || '',
    chapterCount: book.chapterCount,
    paragraphCount: book.paragraphCount,
    autoUnits: Boolean(book.autoUnits),
    chapters: (book.chapters || []).map((chapter) => ({ index: chapter.index, title: chapter.title, from: chapter.from, to: chapter.to })),
    paragraphs,
    // scene-index 里的阶段带「类型」；stages.json 只有名字。优先用带类型的那份。
    stages: index?.stages?.length ? index.stages : (stages?.阶段 ?? []),
    breakthroughs: breakthrough,
    初次突破: breakthrough,
    scenes,
    events,
    cards: cardsFile?.cards ?? null,
    eventsFallback: eventsFile?.来源 === 'fallback',
    cliches: cliches ?? null,
    hasIndex: Boolean(index),
    paragraphMapSize: paragraphMap.size,
  };
}

export function sceneText(book, scene) {
  const rows = book.paragraphs;
  const start = rows.findIndex((item) => item.id === scene.从);
  const end = rows.findIndex((item) => item.id === scene.到);
  if (start < 0 || end < start) return '';
  return rows.slice(start, end + 1).map((item) => item.text).join('\n');
}
