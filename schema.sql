-- =============================================================
-- 在线答题系统 数据库结构（SQLite / Docker 版本）
-- 使用方法：npm run init
-- 数据库文件默认位于 data/quiz.db，可用环境变量 DB_PATH 覆盖
-- 注意：题库题目不在初始化时写入，请登录后在「管理后台 → 批量导入」上传 CSV
-- =============================================================

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id    INTEGER,                 -- 所属题库（NULL = 未分组，视为全体可见）
  category   TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'single' CHECK (type IN ('single','multiple','judge')),
  stem       TEXT NOT NULL,
  options    TEXT NOT NULL,
  answer     TEXT NOT NULL,
  analysis   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
CREATE INDEX IF NOT EXISTS idx_questions_type    ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_bank    ON questions(bank_id);

-- 题库：一次导入即一个题库，可整体授权给指定用户
CREATE TABLE IF NOT EXISTS question_banks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL,        -- 创建者（管理员或用户）
  scope      TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('public','private')),
  -- public  = 所有登录用户可见
  -- private = 仅创建者 + bank_acl 里被授权的用户 + 管理员可见
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_banks_owner ON question_banks(owner_id);

-- 题库授权：哪些用户可以使用这个题库
CREATE TABLE IF NOT EXISTS bank_acl (
  bank_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (bank_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_acl_user ON bank_acl(user_id);

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
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
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
CREATE INDEX IF NOT EXISTS idx_details_record   ON record_details(record_id);
CREATE INDEX IF NOT EXISTS idx_details_question ON record_details(question_id);

CREATE TABLE IF NOT EXISTS wrong_book (
  user_id     INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_wrongbook_user ON wrong_book(user_id);

-- 「已练过」记录：每答一题立刻落库，避免中途退出导致下一轮重复抽到同一题
CREATE TABLE IF NOT EXISTS practice_seen (
  user_id     INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  seen_count  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_seen_user ON practice_seen(user_id);
