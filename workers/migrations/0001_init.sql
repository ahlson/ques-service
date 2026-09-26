-- Migration number: 0001
-- 在线答题系统 初始表结构（Cloudflare D1 / SQLite 语法）

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  category   TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'single' CHECK (type IN ('single','multiple','judge')),
  stem       TEXT NOT NULL,
  options    TEXT NOT NULL,
  answer     TEXT NOT NULL,
  analysis   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
CREATE INDEX IF NOT EXISTS idx_questions_type    ON questions(type);

CREATE TABLE IF NOT EXISTS exam_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'exam' CHECK (mode IN ('practice','exam')),
  category      TEXT NOT NULL DEFAULT '全部',
  total_count   INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  score         INTEGER NOT NULL DEFAULT 0,
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  overtime      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing','submitted')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_user   ON exam_records(user_id);
CREATE INDEX IF NOT EXISTS idx_records_status ON exam_records(status);

CREATE TABLE IF NOT EXISTS record_details (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id   INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  user_answer TEXT NOT NULL DEFAULT '',
  is_correct  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_details_record ON record_details(record_id);
CREATE INDEX IF NOT EXISTS idx_details_question ON record_details(question_id);

CREATE TABLE IF NOT EXISTS wrong_book (
  user_id     INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_wrongbook_user ON wrong_book(user_id);

-- 「已练过」记录：每答一题立刻落库，避免中途退出导致下一轮重复抽到同一题
CREATE TABLE IF NOT EXISTS practice_seen (
  user_id     INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  seen_count  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_seen_user ON practice_seen(user_id);
