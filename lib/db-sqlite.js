/**
 * SQLite（better-sqlite3）适配器：把本地数据库包装成业务核心期望的 db 接口。
 *   db.query(sql, params) -> [rows | {insertId, affectedRows}, meta]
 *   db.batch([{sql, params}]) -> 事务内执行
 *   db.exec(text) -> 多语句脚本（建表用）
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'quiz.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

/** 参数展开：数组参数展开为逗号占位符（对齐 D1 适配器的行为） */
function expand(sql, params = []) {
  const out = [];
  let i = 0;
  const text = sql.replace(/\?/g, () => {
    const p = params[i++];
    if (Array.isArray(p)) {
      if (!p.length) { out.push(null); return 'NULL'; }
      out.push(...p);
      return p.map(() => '?').join(',');
    }
    if (typeof p === 'boolean') { out.push(p ? 1 : 0); return '?'; }
    if (p === undefined) { out.push(null); return '?'; }
    out.push(p);
    return '?';
  });
  return { text, params: out };
}

function isSelect(sql) {
  const h = sql.trimStart().slice(0, 7).toUpperCase();
  return h.startsWith('SELECT') || h.startsWith('WITH') || h.startsWith('PRAGMA');
}

export function createSqlite() {
  async function query(sql, params = []) {
    const { text, params: ps } = expand(sql, params);
    if (isSelect(text)) {
      return [db.prepare(text).all(...ps), []];
    }
    const info = db.prepare(text).run(...ps);
    const result = { insertId: Number(info.lastInsertRowid), affectedRows: info.changes };
    return [result, result];
  }

  /** 事务内批量执行 */
  async function batch(statements = []) {
    const list = statements.filter((s) => s && s.sql);
    if (!list.length) return [];
    const run = db.transaction((items) => {
      const out = [];
      for (const s of items) {
        const { text, params } = expand(s.sql, s.params || []);
        out.push(db.prepare(text).run(...params));
      }
      return out;
    });
    return run(list);
  }

  function exec(sqlText) { db.exec(sqlText); }

  return { query, batch, exec, raw: db, DB_PATH, type: 'sqlite' };
}

export { DB_PATH };
