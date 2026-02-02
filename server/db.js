import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

sqlite3.verbose();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "data.sqlite");
export const db = new sqlite3.Database(DB_PATH);

export function initDb() {
  db.serialize(() => {
    db.run(`PRAGMA foreign_keys = ON;`);

    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        about TEXT DEFAULT '',
        avatar_url TEXT DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL DEFAULT 'dm', -- dm|group|channel (пока используется dm)
        title TEXT DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        PRIMARY KEY (chat_id, user_id),
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        kind TEXT NOT NULL, -- text|image|file|voice
        text TEXT DEFAULT '',
        file_url TEXT DEFAULT '',
        file_name TEXT DEFAULT '',
        file_size INTEGER DEFAULT 0,
        mime TEXT DEFAULT '',
        duration_sec INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
  

    // migrations (safe to run multiple times)
    const ignore = (err) => {
      if (!err) return;
      const msg = String(err.message || err);
      if (msg.includes('duplicate column name') || msg.includes('already exists')) return;
      console.warn('[db] migration warning:', msg);
    };

    db.run(`ALTER TABLE chats ADD COLUMN slug TEXT;`, ignore);
    db.run(`ALTER TABLE chats ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;`, ignore);
    db.run(`ALTER TABLE chats ADD COLUMN owner_user_id INTEGER;`, ignore);

    db.run(`ALTER TABLE chat_members ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`, ignore);
    db.run(`ALTER TABLE chat_members ADD COLUMN joined_at INTEGER NOT NULL DEFAULT 0;`, ignore);

    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_slug ON chats(slug);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);`);
  });
}

export function run(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function get(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export function all(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
