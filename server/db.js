import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'miaoji.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      phone TEXT,
      email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS household_members (
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (household_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS cats (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      breed TEXT,
      sex TEXT,
      birth TEXT,
      weight REAL,
      neutered INTEGER,
      avatar TEXT,
      rev INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      cat_id TEXT NOT NULL REFERENCES cats(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status TEXT,
      note TEXT,
      data TEXT,
      photos TEXT,
      remark TEXT,
      rev INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      cat_id TEXT REFERENCES cats(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      type TEXT,
      care_id TEXT,
      last_ts INTEGER,
      cycle_days INTEGER,
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      rev INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      cat_id TEXT REFERENCES cats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cats_household ON cats(household_id);
    CREATE INDEX IF NOT EXISTS idx_cats_rev ON cats(household_id, rev);
    CREATE INDEX IF NOT EXISTS idx_logs_household ON logs(household_id);
    CREATE INDEX IF NOT EXISTS idx_logs_cat ON logs(cat_id);
    CREATE INDEX IF NOT EXISTS idx_logs_rev ON logs(household_id, rev);
    CREATE INDEX IF NOT EXISTS idx_reminders_household ON reminders(household_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_cat ON reminders(cat_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_rev ON reminders(household_id, rev);
    CREATE INDEX IF NOT EXISTS idx_chats_household ON chats(household_id);
    CREATE INDEX IF NOT EXISTS idx_chats_cat ON chats(cat_id);
    CREATE INDEX IF NOT EXISTS idx_chats_rev ON chats(household_id, rev);
  `);
  // 迁移：历史库 chats 缺少 deleted_at 列时补上（软删除同步用）
  try { db.exec('ALTER TABLE chats ADD COLUMN deleted_at TEXT'); } catch (_) {}
}

export function newId() {
  return randomUUID();
}

// 导入本模块即确保表结构就绪（解决 routes/models 在 initDb 前 prepare 的时序问题）
initDb();
