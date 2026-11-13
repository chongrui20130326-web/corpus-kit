import fs from 'node:fs';
import path from 'node:path';

/**
 * 跨书语料索引。
 *
 * 顾问要在**所有书**里找最接近的一场戏，所以先把这个根目录下每本书的场景
 * 压成一张扁平的检索表，字段都是能直接比对的短文本 + 一组派生标签。
 *
 * 索引在内存里按需构建（两本书几千个场景也就几十毫秒），不落盘，避免过期。
 */

const ACT_TAGS = [
  ['口交', /口交|含住|舔弄|吮吸|吞吐|深喉|舔阴|吹箫/],
  ['乳交', /乳交|双乳夹|乳沟/],
  ['手交', /手交|撸动|套弄|握住.{0,4}(鸡巴|阴茎)|撸着/],
  ['指交', /指交|手指.{0,6}(抠|探|插)/],
  ['插入', /插入|进入|抽送|耸动|挺动|交合|性交/],
  ['肛交', /肛交|后穴|肛门|菊穴/],
  ['后入', /后入|背后|跪趴|撅起/],
  ['骑乘', /骑乘|跨坐|坐上去|骑在/],
  ['捆绑', /捆绑|绑住|绳索|手铐/],
  ['调教', /调教|主奴|命令|服从|鞭/],
  ['多人', /三人|多人|一起上|轮/],
  ['露出', /露出|公开|外面|阳台/],
  ['镜前', /镜子|镜前/],
  ['浴室', /浴室|淋浴|浴缸|花洒/],
  ['足部', /足交|玉足|脚趾|脚心/],
];

const PLACE_TAGS = [
  ['卧室', /卧室|床|被窝|房间/],
  ['客厅', /客厅|沙发/],
  ['浴室', /浴室|淋浴|浴缸/],
  ['厨房', /厨房/],
  ['车内', /车内|车里|后座/],
  ['办公室', /办公室|办公桌/],
  ['户外', /户外|树林|草地|野/],
  ['酒店', /酒店|宾馆/],
];

function tagsOf(text, table) {
  return table.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function buildIndex(root) {
  const entries = [];
  if (!fs.existsSync(root)) return entries;

  for (const dirName of fs.readdirSync(root)) {
    const dir = path.join(root, dirName);
    const bookFile = path.join(dir, 'book.json');
    if (!fs.existsSync(bookFile)) continue;

    const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
    const indexPath = path.join(dir, 'l3', 'scene-index.json');
    if (!fs.existsSync(indexPath)) continue;
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const summaries = readJson(path.join(dir, 'l2', 'summaries.json'))?.scenes ?? {};
    const chains = readJson(path.join(dir, 'l2', 'chains.json'))?.scenes ?? {};

    for (const scene of index.scenes || []) {
      const summary = summaries[scene.sceneId] || {};
      const chain = chains[scene.sceneId]?.动作链 || '';
      const l4 = readJson(path.join(dir, 'l4', `${scene.sceneId}.json`));
      const blob = `${summary.情节描述 || ''}${chain}${(l4?.描写摘录 || []).join('')}`;

      entries.push({
        book: dirName,
        bookTitle: book.title,
        sceneId: scene.sceneId,
        stage: `${scene.阶段类型 || ''}·${scene.弧阶段 || ''}`,
        sceneStage: scene.场景阶段 || '',
        arc: scene.弧阶段 || '',
        power: scene.权力 || '',
        place: scene.场所 || summary.地点 || '',
        participants: scene.参与者 || [],
        summary: summary.情节描述 || '',
        plot: summary.情节 || '',
        conflict: summary.矛盾 || '',
        result: summary.结果 || '',
        trajectory: scene.轨迹 ? `${scene.轨迹.起点} → ${scene.轨迹.终点}` : '',
        chain,
        carry: (l4?.承载句 || []).map((item) => item.句).slice(0, 2),
        quotes: (l4?.描写摘录 || []).slice(0, 3),
        acts: tagsOf(blob, ACT_TAGS),
        places: tagsOf(`${scene.场所 || ''}${summary.地点 || ''}${blob}`, PLACE_TAGS),
      });
    }
  }
  return entries;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export { ACT_TAGS, PLACE_TAGS };
