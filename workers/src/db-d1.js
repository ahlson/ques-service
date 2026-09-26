/**
 * Cloudflare D1 适配器：把 D1 包装成业务核心期望的 db 接口。
 *   db.query(sql, params) -> [rows | {insertId, affectedRows}, meta]
 *   db.batch([{sql, params}]) -> 原子执行（D1 batch 自带事务）
 *
 * 注意：D1 单条 SQL 最多 100 个绑定参数，业务侧已用 chunkInserts 拆分。
 */

/** D1 只接受 null / number / string；布尔和 undefined 需要转换 */
function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function isSelect(sql) {
  const h = sql.trimStart().slice(0, 7).toUpperCase();
  return h.startsWith('SELECT') || h.startsWith('WITH') || h.startsWith('PRAGMA');
}

/** 参数展开：数组参数展开为逗号占位符（支持 WHERE id IN (?)） */
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
    out.push(p);
    return '?';
  });
  return { text, params: out.map(norm) };
}

export function createD1(env) {
  const DB = env.DB;
  if (!DB) throw new Error('未绑定 D1 数据库（wrangler.jsonc 里需要 d1_databases.binding = "DB"）');

  async function query(sql, params = []) {
    const { text, params: ps } = expand(sql, params);
    const stmt = DB.prepare(text).bind(...ps);
    if (isSelect(text)) {
      const r = await stmt.all();
      return [r.results || [], r.meta || {}];
    }
    const r = await stmt.run();
    const info = { insertId: Number(r.meta && r.meta.last_row_id) || 0, affectedRows: Number(r.meta && r.meta.changes) || 0 };
    return [info, info];
  }

  /** 原子批量执行；空数组直接返回 */
  async function batch(statements = []) {
    const list = statements.filter((s) => s && s.sql);
    if (!list.length) return [];
    // D1 一次 batch 的语句数也有限制，按 20 条一组切分
    const out = [];
    for (let i = 0; i < list.length; i += 20) {
      const part = list.slice(i, i + 20).map((s) => {
        const { text, params } = expand(s.sql, s.params || []);
        return DB.prepare(text).bind(...params);
      });
      out.push(...await DB.batch(part));
    }
    return out;
  }

  /** 仅本地/迁移工具用：D1 运行时不支持多语句 exec */
  async function exec(text) {
    const parts = String(text).split(';').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) await query(p);
  }

  return { query, batch, exec, type: 'd1' };
}
