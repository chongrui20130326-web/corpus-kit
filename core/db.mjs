import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function storageMode(env = process.env) {
  const mode = env.STORAGE || 'json';
  if (mode !== 'json' && mode !== 'sqlite') throw new Error(`STORAGE 必须是 json 或 sqlite，当前为 ${mode}`);
  return mode;
}

export function openDb(bookDir) {
  const db = new DatabaseSync(path.join(bookDir, 'corpus.db'));
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS book (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        sentence_total INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scene (
        book_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        chapter_id TEXT NOT NULL,
        title TEXT,
        s_from INTEGER NOT NULL,
        s_to INTEGER NOT NULL,
        sentences INTEGER NOT NULL,
        source TEXT,
        PRIMARY KEY (book_id, scene_id)
      );
      CREATE INDEX IF NOT EXISTS idx_scene_range ON scene(book_id, s_from, s_to);
      CREATE TABLE IF NOT EXISTS mention (
        book_id TEXT NOT NULL,
        mention_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        cls TEXT,
        sentence INTEGER NOT NULL,
        start_off INTEGER,
        end_off INTEGER,
        in_dialog INTEGER NOT NULL DEFAULT 0,
        scene_id TEXT,
        character_id TEXT,
        PRIMARY KEY (book_id, mention_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mention_scene ON mention(book_id, scene_id);
      CREATE INDEX IF NOT EXISTS idx_mention_sentence ON mention(book_id, sentence);
      CREATE TABLE IF NOT EXISTS scene_detail (
        book_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        detail_id TEXT,
        payload TEXT NOT NULL,
        questions INTEGER NOT NULL DEFAULT 0,
        pronoun_hits INTEGER NOT NULL DEFAULT 0,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (book_id, scene_id)
      );
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openReadDb(bookDir) {
  return new DatabaseSync(path.join(bookDir, 'corpus.db'), { readOnly: true });
}

export function withTransaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function upsertBook(db, row) {
  db.prepare(`INSERT OR REPLACE INTO book (id, title, sentence_total, imported_at)
    VALUES (?, ?, ?, ?)`).run(row.id, row.title, row.sentenceTotal, row.importedAt);
}

export function upsertScenes(db, bookId, rows) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO scene
    (book_id, scene_id, chapter_id, title, s_from, s_to, sentences, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  withTransaction(db, () => {
    for (const row of rows) stmt.run(bookId, row.sceneId, row.chapterId, row.title, row.sFrom, row.sTo, row.sentences, row.source);
  });
}

export function upsertMentions(db, bookId, rows) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO mention
    (book_id, mention_id, surface, cls, sentence, start_off, end_off, in_dialog, scene_id, character_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  withTransaction(db, () => {
    for (const row of rows) stmt.run(bookId, row.mentionId, row.surface, row.cls, row.sentence, row.startOff, row.endOff, row.inDialog, row.sceneId, row.characterId);
  });
}

export function upsertSceneDetails(db, bookId, rows) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO scene_detail
    (book_id, scene_id, detail_id, payload, questions, pronoun_hits, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  withTransaction(db, () => {
    for (const row of rows) stmt.run(bookId, row.sceneId, row.detailId, row.payload, row.questions, row.pronounHits, row.generatedAt);
  });
}

export function bookStats(db, bookId) {
  const row = db.prepare(`SELECT
    (SELECT COUNT(*) FROM scene WHERE book_id = ?) AS scenes,
    (SELECT COUNT(*) FROM mention WHERE book_id = ?) AS mentions,
    (SELECT COUNT(*) FROM mention WHERE book_id = ? AND character_id IS NOT NULL) AS mapped,
    (SELECT COUNT(*) FROM scene_detail WHERE book_id = ?) AS details`).get(bookId, bookId, bookId, bookId);
  return { scenes: row.scenes, mentions: row.mentions, mapped: row.mapped, details: row.details };
}
