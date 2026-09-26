-- Migration number: 0002
-- 题库分组与授权：question_banks / bank_acl，questions 增加 bank_id

ALTER TABLE questions ADD COLUMN bank_id INTEGER;

CREATE TABLE IF NOT EXISTS question_banks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL DEFAULT 0,
  scope      TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('public','private')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_banks_owner ON question_banks(owner_id);

CREATE TABLE IF NOT EXISTS bank_acl (
  bank_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (bank_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_acl_user ON bank_acl(user_id);

CREATE INDEX IF NOT EXISTS idx_questions_bank ON questions(bank_id);
