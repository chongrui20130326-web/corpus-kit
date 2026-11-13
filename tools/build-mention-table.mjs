import fs from 'node:fs';
import path from 'node:path';
import { openDb, storageMode, upsertMentions, withTransaction } from '../core/db.mjs';
import { withJsonLock, writeJsonAtomic } from '../core/atomic-json.mjs';
import { assertNotShrinking, countOf } from '../core/guard.mjs';

// 确保输出目录存在（新书首次运行时 l2 可能还没建）
function ensureOutputDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ } }

/**
 * 第 2 步：给整本书的人称编号（纯扫描，不调模型）
 * 词表 = 角色真名表 + 代词 + 亲属/身份称谓；集体称呼单独分类。
 * 输出 l2/mention-table.json：每个出现一次 = 一条编号
 */

const work = process.argv[2] || 'work/美少妇的哀羞';
const mode = storageMode();
const dbFile = path.join(work, 'corpus.db');
if (mode === 'sqlite' && !fs.existsSync(dbFile)) throw new Error(`请先迁移这本书：${work}`);
const book = JSON.parse(fs.readFileSync(path.join(work, 'book.json'), 'utf8'));
const tablePath = path.join(work, 'l2', 'characters.json');
const characters = fs.existsSync(tablePath) ? (JSON.parse(fs.readFileSync(tablePath, 'utf8')).characters || []) : [];

const PRONOUN = ['他', '她', '它', '我', '你', '您'];
const KINSHIP = ['丈夫', '妻子', '老公', '老婆', '太太', '夫人', '父亲', '母亲', '爸爸', '妈妈', '儿子', '女儿', '哥哥', '姐姐', '弟弟', '妹妹', '岳父', '岳母', '公公', '婆婆', '情人', '爱人'];
const ROLE = ['男人', '女人', '少妇', '老人', '年轻人', '男孩', '女孩', '少年', '少女'];
const COLLECTIVE = ['他们', '她们', '它们', '我们', '你们', '咱们', '大家', '众人', '人群', '对方', '所有人', '其他人'];

const words = [];
for (const c of characters) {
  words.push({ word: c.name, cls: 'name', characterId: c.id });
  for (const alias of c.aliases || []) words.push({ word: alias, cls: 'name', characterId: c.id });
}
for (const w of PRONOUN) words.push({ word: w, cls: 'pronoun' });
for (const w of KINSHIP) words.push({ word: w, cls: 'kinship' });
for (const w of ROLE) words.push({ word: w, cls: 'role' });
for (const w of COLLECTIVE) words.push({ word: w, cls: 'collective' });
words.sort((a, b) => b.word.length - a.word.length);

// 句子号 -> 场景号（全局唯一编号，额外挂上场景，便于按场追溯）
const sceneOfSentence = new Map();
try {
  const scenesPath = path.join(work, 'l2', 'scenes-llm.json');
  if (fs.existsSync(scenesPath)) {
    for (const s of JSON.parse(fs.readFileSync(scenesPath, 'utf8')).scenes || []) {
      const from = Number(String(s.from).slice(1));
      const to = Number(String(s.to).slice(1));
      for (let n = from; n <= to; n += 1) sceneOfSentence.set(n, s.sceneId);
    }
  }
} catch { /* 忽略 */ }

const doc = { generatedAt: new Date().toISOString(), method: '词表扫描（无模型）', totals: {}, mentions: [] };
let serial = 0;
const stats = { pronoun: 0, kinship: 0, role: 0, collective: 0, name: 0 };

for (const chapter of book.chapters || []) {
  for (const para of chapter.paragraphs || []) {
    for (const s of para.sentences || []) {
      const text = String(s.text || '');
      if (/^《.+?》（第[0-9]+章/.test(text.trim())) continue;      // 标题句不参与
      const n = Number(String(s.sid || s.id || '').replace(/^.*S/, ''));
      if (!n) continue;
      // 判断某个位置是否在对话引号内
      const quoteAt = (pos) => {
        let open = false;
        for (let k = 0; k < pos; k += 1) {
          const ch = text[k];
          if (ch === '“' || ch === '「' || ch === '『' || ch === '"') open = !open;
        }
        return open;
      };
      let i = 0;
      while (i < text.length) {
        let hit = null;
        for (const item of words) {
          if (text.startsWith(item.word, i)) { hit = item; break; }
        }
        if (hit) {
          serial += 1;
          stats[hit.cls] = (stats[hit.cls] || 0) + 1;
          doc.mentions.push({
            id: 'M' + String(serial).padStart(6, '0'),
            surface: hit.word,
            cls: hit.cls,
            chapterId: chapter.id,
            sentence: n,
            start: i,
            end: i + hit.word.length,
            characterId: hit.characterId || '',
            inDialog: quoteAt(i),
          });
          i += hit.word.length;
        } else {
          i += 1;
        }
      }
    }
  }
}

doc.totals = {
  mentions: doc.mentions.length,
  characters: characters.length,
  ...stats,
};
const outFile = path.join(work, 'l2', 'mention-table.json');
  // 补场景号：句子号 → 场景号
  for (const m of doc.mentions) m.sceneId = sceneOfSentence.get(Number(m.sentence)) || '';

withJsonLock(outFile, () => {
  if (!fs.existsSync(dbFile)) { writeJsonAtomic(outFile, doc, 1); return; }
  const sceneFile = path.join(work, 'l2', 'scenes-llm.json');
  const scenes = fs.existsSync(sceneFile) ? (JSON.parse(fs.readFileSync(sceneFile, 'utf8')).scenes || []) : [];
  const sceneOf = new Map();
  for (const scene of scenes) {
    const from = Number(String(scene.from).slice(1));
    const to = Number(String(scene.to).slice(1));
    for (let n = from; n <= to; n++) sceneOf.set(n, scene.sceneId);
  }
  const mapFile = path.join(work, 'l2', 'scene-map.json');
  const mapDoc = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : { scenes: {} };
  const mapped = new Map();
  for (const rows of Object.values(mapDoc.scenes || {})) for (const row of rows) mapped.set(row.id, row.characterId || '');
  const validIds = new Set(characters.map((row) => row.id));
  const rows = doc.mentions.map((m) => {
    const raw = mapped.get(m.id) || m.characterId || '';
    return {
      mentionId: m.id, surface: m.surface, cls: m.cls, sentence: m.sentence,
      startOff: m.start ?? null, endOff: m.end ?? null, inDialog: m.inDialog ? 1 : 0,
      sceneId: sceneOf.get(m.sentence) || null,
      characterId: validIds.has(raw) ? raw : null,
    };
  });
  const db = openDb(work);
  try {
    withTransaction(db, () => {
      db.prepare('DELETE FROM mention WHERE book_id = ?').run(path.basename(path.resolve(work)));
      upsertMentions(db, path.basename(path.resolve(work)), rows);
      writeJsonAtomic(outFile, doc, 1);
    });
  } finally { db.close(); }
});
console.log(`人称编号 ${doc.totals.mentions} 条：代词 ${stats.pronoun} / 亲属 ${stats.kinship} / 身份 ${stats.role} / 集体 ${stats.collective} / 真名 ${stats.name}`);
