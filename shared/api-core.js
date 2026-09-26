/**
 * 业务核心：与 Web 框架无关的接口路由表。
 *
 * 同一份逻辑被两个入口复用：
 *   - Cloudflare Workers（Hono + D1）   -> workers/src/index.js
 *   - Node / Docker    （Express + SQLite）-> server.js
 *
 * 路由项结构：{ method, path, auth: 'none'|'user'|'admin', handler(ctx) }
 * handler 抛出 HttpError 表示业务错误，其余返回会被直接 JSON 序列化。
 *
 * ctx = { params, query, body, user, db, secret, env }
 * db 需实现：query(sql, params) / batch([{sql, params}]) / exec(text)
 */

import { hashPassword, verifyPassword, signToken } from './auth.js';
import {
  TYPE_MAP, TYPE_NAME, JUDGE_OPTIONS,
  normalizeQuestion, isCorrect, parseImportText
} from './questions.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, msg) => { throw new HttpError(status, msg); };

/** D1 单条 SQL 最多 100 个绑定参数，留些余量 */
const MAX_PARAMS = 90;

/**
 * 把多行 INSERT 拆成若干条参数不超限的语句。
 * @param prefix 形如 'INSERT INTO t (a,b,c) VALUES '
 * @param colCount 每行参数个数
 * @param rowParams 二维数组（每行一组参数）
 */
export function chunkInserts(prefix, colCount, rowParams) {
  if (!rowParams.length) return [];
  const per = Math.max(1, Math.floor(MAX_PARAMS / colCount));
  const placeholder = '(' + Array(colCount).fill('?').join(',') + ')';
  const out = [];
  for (let i = 0; i < rowParams.length; i += per) {
    const chunk = rowParams.slice(i, i + per);
    out.push({
      sql: prefix + chunk.map(() => placeholder).join(','),
      params: chunk.flat()
    });
  }
  return out;
}

/** 分批按 id 取题（避免 IN(?) 参数超限） */
async function fetchQuestionsByIds(db, ids, cols = 'id, type, answer', user = null) {
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const scope = user ? scopeFilter(user) : null;
  const map = new Map();
  for (let i = 0; i < uniq.length; i += MAX_PARAMS) {
    const part = uniq.slice(i, i + MAX_PARAMS);
    const where = scope ? `WHERE q.id IN (?) AND ${scope.sql}` : 'WHERE id IN (?)';
    const from = scope ? 'questions q' : 'questions';
    const args = scope ? [part, ...scope.params] : [part];
    const [rows] = await db.query(`SELECT ${cols} FROM ${from} ${where}`, args);
    rows.forEach((q) => map.set(q.id, q));
  }
  return map;
}

/**
 * 更新错题本：
 * - 答错：wrong_count +1
 * - 答对且 allowClear=true（刷题/错题练习）：清零，即移出错题本
 * - 答对且 allowClear=false（模拟考试）：不动，避免一次考试答对就掩盖历史薄弱点
 */
async function recordWrong(db, userId, questionId, correct, allowClear) {
  if (correct && allowClear) {
    await db.query(
      `INSERT INTO wrong_book (user_id, question_id, wrong_count, updated_at)
       VALUES (?,?,0,datetime('now','localtime'))
       ON CONFLICT(user_id, question_id) DO UPDATE SET wrong_count=0, updated_at=excluded.updated_at`,
      [userId, questionId]);
  } else if (!correct) {
    await db.query(
      `INSERT INTO wrong_book (user_id, question_id, wrong_count, updated_at)
       VALUES (?,?,1,datetime('now','localtime'))
       ON CONFLICT(user_id, question_id) DO UPDATE SET wrong_count=wrong_count+1, updated_at=excluded.updated_at`,
      [userId, questionId]);
  }
}

/** 立即标记「已练过」，中途退出也不会丢；重复练则计数 +1 */
async function markSeen(db, userId, questionIds) {
  const ids = [...new Set(questionIds.map(Number).filter(Boolean))];
  if (!ids.length) return;
  await db.batch(ids.map((qid) => ({
    sql: `INSERT INTO practice_seen (user_id, question_id, seen_count, updated_at)
          VALUES (?,?,1,datetime('now'))
          ON CONFLICT(user_id, question_id)
          DO UPDATE SET seen_count = seen_count + 1, updated_at = datetime('now')`,
    params: [userId, qid]
  })));
}

/* ================================================================
 *              题库可见性（题库分组 + 授权）
 *
 * 规则：
 *   - 管理员：看得到全部题目
 *   - 普通用户：只看得到
 *       ① 未分组题目（bank_id 为空，历史数据视为公共）
 *       ② 题库 scope='public'（全体可见）
 *       ③ 自己创建的题库
 *       ④ 被管理员授权给自己的题库（bank_acl）
 * ================================================================ */

/** 生成可见性过滤条件；管理员返回恒真条件 */
function scopeFilter(user, alias = 'q') {
  if (!user) return { sql: '1 = 0', params: [] };
  if (user.role === 'admin') return { sql: '1 = 1', params: [] };
  return {
    sql: `(${alias}.bank_id IS NULL OR EXISTS (
            SELECT 1 FROM question_banks b
             WHERE b.id = ${alias}.bank_id
               AND (b.scope = 'public'
                    OR b.owner_id = ?
                    OR EXISTS (SELECT 1 FROM bank_acl a WHERE a.bank_id = b.id AND a.user_id = ?))))`,
    params: [user.uid, user.uid]
  };
}

/** 校验某个题库对当前用户是否可见/可操作 */
async function assertBankAccess(db, user, bankId, { write = false } = {}) {
  const id = Number(bankId);
  if (!Number.isInteger(id) || id <= 0) return fail(400, '请选择题库');
  const [rows] = await db.query('SELECT * FROM question_banks WHERE id = ?', [id]);
  if (!rows.length) return fail(404, '题库不存在');
  const b = rows[0];
  if (user.role === 'admin') return b;
  if (write) {
    // 普通用户只能操作自己创建的题库
    if (b.owner_id !== user.uid) return fail(403, '只能操作自己上传的题库');
    return b;
  }
  if (b.scope === 'public' || b.owner_id === user.uid) return b;
  const [acl] = await db.query('SELECT 1 AS ok FROM bank_acl WHERE bank_id = ? AND user_id = ?', [id, user.uid]);
  if (!acl.length) return fail(403, '你没有该题库的使用权限');
  return b;
}

/** 规范化 id 数组 */
const normalizeIds = (v) => [...new Set((Array.isArray(v) ? v : [])
  .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];

async function bankQuestionIds(db, bankId) {
  const [rows] = await db.query('SELECT id FROM questions WHERE bank_id = ?', [bankId]);
  return rows.map((r) => r.id);
}

/** 删除题目，并清理关联的错题本 / 已练记录 / 答题明细 */
async function deleteQuestions(db, ids) {
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (let i = 0; i < uniq.length; i += MAX_PARAMS) {
    const part = uniq.slice(i, i + MAX_PARAMS);
    await db.batch([
      { sql: 'DELETE FROM wrong_book    WHERE question_id IN (?)', params: [part] },
      { sql: 'DELETE FROM practice_seen WHERE question_id IN (?)', params: [part] },
      { sql: 'DELETE FROM record_details WHERE question_id IN (?)', params: [part] },
      { sql: 'DELETE FROM questions     WHERE id IN (?)', params: [part] }
    ]);
  }
}

/**
 * 导入题目到题库。
 * 管理员可导入到任意题库；普通用户只能导入到自己创建的题库。
 */
async function importQuestions(db, user, body) {
  const { rows, failed, format } = parseImportText(body.text);
  if (!rows.length && !failed.length) return fail(400, '没有可导入的内容');
  const bankId = Number(body.bankId) || 0;
  if (bankId) await assertBankAccess(db, user, bankId, { write: true });
  if (rows.length) {
    await db.batch(chunkInserts(
      'INSERT INTO questions (bank_id, category, type, stem, options, answer, analysis) VALUES ',
      7,
      rows.map((r) => [bankId || null, r.category, r.type, r.stem, r.options, r.answer, r.analysis])));
  }
  return { success: rows.length, failed, format, bankId: bankId || null };
}

/**
 * 抽题核心。
 * - new（默认）：只出「一道都没做过」的题，不足就少出，绝不掺旧题；刷完返回空数组
 * - smart：按已练次数升序 + 随机，没做过的排前面，保证每轮凑满 limit
 * - random：最初的纯随机行为
 */
async function pickQuestions({ db, user, type, limit, mode, bankId }) {
  const scope = scopeFilter(user);
  const bank = Number(bankId) > 0 ? ' AND q.bank_id = ?' : '';
  const bankArgs = Number(bankId) > 0 ? [Number(bankId)] : [];

  if (mode === 'random' || !user) {
    const [rows] = await db.query(
      `SELECT id, category, type, stem, options FROM questions q
        WHERE (? = '' OR type = ?) AND ${scope.sql}${bank} ORDER BY RANDOM() LIMIT ?`,
      [type, type, ...scope.params, ...bankArgs, limit]);
    return rows;
  }
  const joinSql = `
       FROM questions q
       LEFT JOIN (
         SELECT d.question_id AS question_id, COUNT(*) AS done_count
           FROM record_details d
           JOIN exam_records r ON r.id = d.record_id
          WHERE r.user_id = ? AND r.status = 'submitted'
          GROUP BY d.question_id
       ) done ON done.question_id = q.id
       LEFT JOIN practice_seen s ON s.user_id = ? AND s.question_id = q.id
      WHERE (? = '' OR q.type = ?) AND ${scope.sql}${bank}`;
  const head = [user.uid, user.uid, type, type, ...scope.params, ...bankArgs];
  if (mode === 'new') {
    const [rows] = await db.query(
      `SELECT q.id, q.category, q.type, q.stem, q.options` + joinSql +
      ` AND IFNULL(done.done_count, 0) = 0 AND IFNULL(s.seen_count, 0) = 0
        ORDER BY RANDOM() LIMIT ?`,
      [...head, limit]);
    return rows;
  }
  const [rows] = await db.query(
    `SELECT q.id, q.category, q.type, q.stem, q.options` + joinSql +
      ` ORDER BY (IFNULL(done.done_count, 0) + IFNULL(s.seen_count, 0)) ASC, RANDOM() LIMIT ?`,
    [...head, limit]);
  return rows;
}

const pickMode = (m) => (m === 'random' ? 'random' : (m === 'smart' ? 'smart' : 'new'));
const parseOptions = (rows) => rows.map((r) => ({ ...r, options: JSON.parse(r.options) }));

/* ================================================================
 *                            路由表
 * ================================================================ */

/** 管理员为纯管理账号：这些答题类接口一律拒绝（防止绕过页面直接调接口） */
const STUDENT_ONLY = new Set([
  '/api/practice/questions', '/api/practice/progress', '/api/practice/check', '/api/practice/finish',
  '/api/exam/start', '/api/exam/submit', '/api/wrong-questions'
]);

export function createApiRoutes() {
  const routes = [
    /* ---------------- 首次使用引导 ---------------- */
    {
      method: 'GET', path: '/api/bootstrap', auth: 'none',
      handler: async ({ db }) => {
        const [u] = await db.query('SELECT COUNT(*) AS n FROM users');
        const [q] = await db.query('SELECT COUNT(*) AS n FROM questions');
        return { needSetup: u[0].n === 0, userCount: u[0].n, questionCount: q[0].n };
      }
    },
    {
      method: 'POST', path: '/api/setup', auth: 'none',
      handler: async ({ db, body, secret }) => {
        const [u] = await db.query('SELECT COUNT(*) AS n FROM users');
        if (u[0].n > 0) return fail(400, '系统已初始化，请直接登录');
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/.test(username)) return fail(400, '用户名需为 3~20 位字母、数字、下划线或中文');
        if (password.length < 6 || password.length > 40) return fail(400, '密码长度需为 6~40 位');
        const [r] = await db.query('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)',
          [username, await hashPassword(password), 'admin']);
        const user = { id: r.insertId, username, role: 'admin' };
        return { token: await signToken({ uid: user.id, role: user.role, username }, secret), user };
      }
    },

    /* ---------------- 认证 ---------------- */
    /* 注册通道已关闭：账号只能由管理员在后台创建 */
    {
      method: 'POST', path: '/api/login', auth: 'none',
      handler: async ({ db, body, secret, env }) => {
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (!rows.length) return fail(400, '用户名或密码错误');
        const u = rows[0];
        let ok = await verifyPassword(password, u.password_hash);
        // 兼容旧版本（Node scrypt）生成的密码哈希：校验成功后自动升级为 PBKDF2
        if (!ok && env && typeof env.legacyVerify === 'function') {
          ok = await env.legacyVerify(password, u.password_hash);
          if (ok) await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), u.id]);
        }
        if (!ok) return fail(400, '用户名或密码错误');
        return {
          token: await signToken({ uid: u.id, role: u.role, username: u.username }, secret),
          user: { id: u.id, username: u.username, role: u.role, created_at: u.created_at }
        };
      }
    },
    {
      method: 'GET', path: '/api/me', auth: 'user',
      handler: async ({ db, user }) => {
        const [rows] = await db.query('SELECT id, username, role, created_at FROM users WHERE id = ?', [user.uid]);
        if (!rows.length) return fail(401, '账号不存在');
        return rows[0];
      }
    },
    {
      method: 'GET', path: '/api/categories', auth: 'user',
      handler: async ({ db, user }) => {
        const scope = scopeFilter(user);
        const [rows] = await db.query(
          `SELECT category, type, COUNT(*) AS count FROM questions q WHERE ${scope.sql} GROUP BY type
            ORDER BY CASE type WHEN 'single' THEN 1 WHEN 'multiple' THEN 2 ELSE 3 END`,
          scope.params);
        return rows;
      }
    },

    /* ---------------- 我的题库 ---------------- */
    {
      method: 'GET', path: '/api/banks', auth: 'user',
      handler: async ({ db, user }) => {
        // 管理员看全部；普通用户看「公共 + 自己的 + 被授权的」
        const args = [];
        let where = '';
        if (user.role !== 'admin') {
          where = `WHERE (b.scope='public' OR b.owner_id=? OR EXISTS (SELECT 1 FROM bank_acl a WHERE a.bank_id=b.id AND a.user_id=?))`;
          args.push(user.uid, user.uid);
        }
        const [list] = await db.query(`
          SELECT b.id, b.name, b.owner_id, b.scope, b.created_at,
                 u.username AS ownerName,
                 (SELECT COUNT(*) FROM questions q WHERE q.bank_id = b.id) AS questionCount,
                 (SELECT COUNT(*) FROM bank_acl a WHERE a.bank_id = b.id) AS aclCount
            FROM question_banks b LEFT JOIN users u ON u.id = b.owner_id
            ${where}
           ORDER BY b.id DESC`, args);
        return { list };
      }
    },
    {
      method: 'POST', path: '/api/banks', auth: 'user',
      handler: async ({ db, body, user }) => {
        const name = String(body.name || '').trim();
        if (!name) return fail(400, '请填写题库名称');
        if (name.length > 60) return fail(400, '题库名称过长（最多 60 字）');
        const isAdmin = user.role === 'admin';
        // 普通用户新建的题库一律是私有的（仅自己 + 管理员可见）
        const scope = isAdmin && String(body.scope || '') === 'public' ? 'public' : 'private';
        const userIds = isAdmin ? normalizeIds(body.userIds) : [];
        const [r] = await db.query(
          'INSERT INTO question_banks (name, owner_id, scope) VALUES (?,?,?)', [name, user.uid, scope]);
        const bankId = r.insertId;
        if (isAdmin && userIds.length) {
          await db.batch(chunkInserts('INSERT INTO bank_acl (bank_id, user_id) VALUES ', 2,
            userIds.map((uid) => [bankId, uid])));
        }
        return { id: bankId, name, scope, owner_id: user.uid };
      }
    },
    {
      method: 'DELETE', path: '/api/banks/:id', auth: 'user',
      handler: async ({ db, params, user }) => {
        const b = await assertBankAccess(db, user, params.id, { write: true });
        const ids = await bankQuestionIds(db, b.id);
        await deleteQuestions(db, ids);
        await db.batch([
          { sql: 'DELETE FROM bank_acl WHERE bank_id = ?', params: [b.id] },
          { sql: 'DELETE FROM question_banks WHERE id = ?', params: [b.id] }
        ]);
        return { ok: true, removed: ids.length };
      }
    },

    /* ---------------- 专项刷题 ---------------- */
    {
      method: 'GET', path: '/api/practice/questions', auth: 'user',
      handler: async ({ db, query, user }) => {
        const type = String(query.type || '').trim();
        const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 200);
        const mode = pickMode(String(query.mode || 'new').trim());
        const bankId = Number(query.bankId) || 0;
        const rows = await pickQuestions({ db, user, type, limit, mode, bankId });
        return parseOptions(rows);
      }
    },
    {
      method: 'GET', path: '/api/practice/progress', auth: 'user',
      handler: async ({ db, query, user }) => {
        const type = String(query.type || '').trim();
        const bankId = Number(query.bankId) || 0;
        const scope = scopeFilter(user);
        const bank = bankId ? ' AND q.bank_id = ?' : '';
        const bankArgs = bankId ? [bankId] : [];
        const [tot] = await db.query(
          `SELECT COUNT(*) AS n FROM questions q WHERE (? = '' OR q.type = ?) AND ${scope.sql}${bank}`,
          [type, type, ...scope.params, ...bankArgs]);
        const [done] = await db.query(
          `SELECT COUNT(*) AS n FROM (
              SELECT DISTINCT d.question_id AS qid
                FROM record_details d JOIN exam_records r ON r.id = d.record_id
               WHERE r.user_id = ? AND r.status = 'submitted'
              UNION
              SELECT s.question_id AS qid FROM practice_seen s WHERE s.user_id = ?
           ) t JOIN questions q ON q.id = t.qid
           WHERE (? = '' OR q.type = ?) AND ${scope.sql}${bank}`,
          [user.uid, user.uid, type, type, ...scope.params, ...bankArgs]);
        const total = tot[0].n;
        const doneCount = done[0].n;
        return { total, done: doneCount, unseen: total - doneCount, percent: total ? Math.round((doneCount / total) * 100) : 0 };
      }
    },
    {
      method: 'POST', path: '/api/practice/check', auth: 'user',
      handler: async ({ db, body, user }) => {
        const qid = Number(body.questionId);
        const scope = scopeFilter(user);
        const [rows] = await db.query(
          `SELECT id, type, options, answer, analysis FROM questions q WHERE q.id = ? AND ${scope.sql}`,
          [qid, ...scope.params]);
        if (!rows.length) return fail(404, '题目不存在或你没有权限');
        const q = rows[0];
        const correct = isCorrect(q.type, q.answer, body.answer);
        await recordWrong(db, user.uid, q.id, correct, true);
        await markSeen(db, user.uid, [q.id]);
        return { correct, correctAnswer: q.answer, analysis: q.analysis || '暂无解析', options: JSON.parse(q.options) };
      }
    },
    {
      method: 'POST', path: '/api/practice/finish', auth: 'user',
      handler: async ({ db, body, user }) => {
        const category = String(body.category || '').trim();
        const details = Array.isArray(body.details) ? body.details : [];
        if (!details.length) return fail(400, '没有可保存的答题记录');
        const durationSec = Math.max(0, Math.min(Number(body.durationSec) || 0, 24 * 3600));

        const ids = details.map((d) => Number(d.questionId)).filter(Boolean);
        if (!ids.length) return fail(400, '答题数据不合法');
        const qMap = await fetchQuestionsByIds(db, ids, 'id, type, answer', user);

        let correctCount = 0;
        const rows = [];
        for (const d of details) {
          const q = qMap.get(Number(d.questionId));
          if (!q) continue;
          const ok = isCorrect(q.type, q.answer, d.userAnswer);
          if (ok) correctCount++;
          rows.push([Number(d.questionId), d.userAnswer == null ? '' : String(d.userAnswer), ok ? 1 : 0]);
        }
        if (!rows.length) return fail(400, '答题数据不合法');
        const total = rows.length;
        const score = Math.round((correctCount / total) * 100);

        const [r] = await db.query(
          `INSERT INTO exam_records (user_id, mode, category, total_count, correct_count, score, duration_sec, status)
           VALUES (?,?,?,?,?,?,?,'submitted')`,
          [user.uid, 'practice', category || '全部', total, correctCount, score, durationSec]);
        try {
          await db.batch(chunkInserts(
            'INSERT INTO record_details (record_id, question_id, user_answer, is_correct) VALUES ',
            4,
            rows.map((x) => [r.insertId, ...x])));
        } catch (e) {
          await db.query('DELETE FROM exam_records WHERE id = ?', [r.insertId]);
          throw e;
        }
        await markSeen(db, user.uid, rows.map((x) => x[0]));
        return { recordId: r.insertId, score, correctCount, total };
      }
    },

    /* ---------------- 模拟考试 ---------------- */
    {
      method: 'POST', path: '/api/exam/start', auth: 'user',
      handler: async ({ db, body, user }) => {
        const EXAM_SEC_PER_Q = 90; // 每题 1 分半
        const wanted = {
          single: Math.max(0, Math.floor(Number(body.single) || 0)),
          multiple: Math.max(0, Math.floor(Number(body.multiple) || 0)),
          judge: Math.max(0, Math.floor(Number(body.judge) || 0))
        };
        const mode = String(body.mode || 'smart').trim() === 'random' ? 'random' : 'smart';
        const bankId = Number(body.bankId) || 0;
        const picked = [];
        const actual = { single: 0, multiple: 0, judge: 0 };
        const notice = [];
        for (const type of ['single', 'multiple', 'judge']) {
          if (!wanted[type]) continue;
          const rows = await pickQuestions({ db, user, type, limit: wanted[type], mode, bankId });
          actual[type] = rows.length;
          if (rows.length < wanted[type]) {
            notice.push(rows.length === 0
              ? `${TYPE_NAME[type]}题库暂无题目，已跳过`
              : `${TYPE_NAME[type]}仅有 ${rows.length} 道，已按实际数量组卷`);
          }
          picked.push(...rows);
        }
        if (!picked.length) return fail(400, '题库中没有所选题型的题目，请调整各题型数量');
        const total = picked.length;
        const durationSec = total * EXAM_SEC_PER_Q;
        const desc = ['single', 'multiple', 'judge']
          .filter((t) => actual[t] > 0)
          .map((t) => `${TYPE_NAME[t].replace('题', '')}${actual[t]}题`)
          .join('·');
        const [r] = await db.query(
          `INSERT INTO exam_records (user_id, mode, category, total_count, duration_sec, status)
           VALUES (?,?,?,?,?,'ongoing')`,
          [user.uid, 'exam', `组卷：${desc}（共${total}题）`, total, durationSec]);
        return {
          recordId: r.insertId, durationSec, total, actual, notice,
          questions: parseOptions(picked)
        };
      }
    },
    {
      method: 'POST', path: '/api/exam/submit', auth: 'user',
      handler: async ({ db, body, user }) => {
        const recordId = Number(body.recordId);
        const answers = Array.isArray(body.answers) ? body.answers : [];
        const [recs] = await db.query('SELECT * FROM exam_records WHERE id = ? AND user_id = ?', [recordId, user.uid]);
        if (!recs.length) return fail(404, '考试记录不存在');
        const rec = recs[0];
        if (rec.status === 'submitted') return fail(400, '该试卷已提交，请勿重复提交');

        const qMap = await fetchQuestionsByIds(db, answers.map((a) => a.questionId), 'id, type, answer', user);
        let correctCount = 0;
        const rows = [];
        for (const a of answers) {
          const q = qMap.get(Number(a.questionId));
          if (!q) continue;
          const ok = isCorrect(q.type, q.answer, a.answer);
          if (ok) correctCount++;
          else await recordWrong(db, user.uid, Number(a.questionId), false, false); // 考试答错计入错题本
          rows.push([Number(a.questionId), a.answer == null ? '' : String(a.answer), ok ? 1 : 0]);
        }
        const answered = rows.length;
        const correctTotal = rec.total_count || answered;
        const score = correctTotal ? Math.round((correctCount / correctTotal) * 100) : 0;
        const elapsed = Math.max(0, Math.round((Date.now() - new Date(String(rec.created_at).replace(' ', 'T')).getTime()) / 1000));
        const overtime = elapsed > rec.duration_sec + 120 ? 1 : 0;

        await db.query(
          `UPDATE exam_records SET correct_count=?, score=?, duration_sec=?, overtime=?, status='submitted', submitted_at=datetime('now','localtime')
           WHERE id=? AND status='ongoing'`,
          [correctCount, score, Math.min(elapsed, 24 * 3600), overtime, recordId]);

        if (rows.length) {
          const stmts = chunkInserts(
            'INSERT INTO record_details (record_id, question_id, user_answer, is_correct) VALUES ',
            4,
            rows.map((x) => [recordId, ...x]));
          await db.batch(stmts);
        }
        // 同步标记「已练过」，避免考试做过的题在专项刷题里又重复出现
        await markSeen(db, user.uid, rows.map((x) => x[0]));
        return { recordId, score, correctCount, total: correctTotal, answered };
      }
    },

    /* ---------------- 错题本 ---------------- */
    {
      method: 'GET', path: '/api/wrong-questions', auth: 'user',
      handler: async ({ db, query, user }) => {
        const minWrong = Math.max(0, Number(query.minWrong) || 0);
        const type = String(query.type || '').trim();
        const limit = Math.min(Math.max(Number(query.limit) || 0, 0), 2000);
        const where = ['w.user_id = ?', 'w.wrong_count > ?'];
        const args = [user.uid, minWrong];
        const scope = scopeFilter(user, 'q');
        where.push(scope.sql);
        args.push(...scope.params);
        if (type) { where.push('q.type = ?'); args.push(type); }
        const whereSql = 'WHERE ' + where.join(' AND ');
        const [cnt] = await db.query(
          `SELECT COUNT(*) AS n FROM wrong_book w JOIN questions q ON q.id = w.question_id ${whereSql}`, args);
        const limArgs = limit ? [...args, limit] : args;
        const [rows] = await db.query(
          `SELECT q.id, q.category, q.type, q.stem, q.options, w.wrong_count AS wrongCount
           FROM wrong_book w JOIN questions q ON q.id = w.question_id
           ${whereSql} ORDER BY w.wrong_count DESC, w.updated_at DESC ${limit ? 'LIMIT ?' : ''}`,
          limArgs);
        return { total: cnt[0].n, list: parseOptions(rows) };
      }
    },

    /* ---------------- 我的成绩 ---------------- */
    {
      method: 'GET', path: '/api/records/my', auth: 'user',
      handler: async ({ db, user }) => {
        const [rows] = await db.query(
          `SELECT id, mode, category, total_count, correct_count, score, duration_sec, overtime, created_at
           FROM exam_records WHERE user_id=? AND status='submitted' ORDER BY created_at DESC LIMIT 200`,
          [user.uid]);
        return rows;
      }
    },
    {
      method: 'GET', path: '/api/records/my/:id', auth: 'user',
      handler: async ({ db, params, user }) => {
        const [recs] = await db.query('SELECT * FROM exam_records WHERE id=? AND user_id=?', [params.id, user.uid]);
        if (!recs.length) return fail(404, '记录不存在');
        const [details] = await db.query(
          `SELECT d.question_id, d.user_answer, d.is_correct, q.category, q.type, q.stem, q.options, q.answer, q.analysis
           FROM record_details d JOIN questions q ON q.id = d.question_id WHERE d.record_id=? ORDER BY d.id`,
          [params.id]);
        return { ...recs[0], details: parseOptions(details) };
      }
    },

    /* ---------------- 管理后台：题库 ---------------- */
    {
      method: 'GET', path: '/api/admin/questions', auth: 'admin',
      handler: async ({ db, query }) => {
        const page = Math.max(1, Number(query.page) || 1);
        const pageSize = Math.min(50, Math.max(5, Number(query.pageSize) || 10));
        const keyword = String(query.keyword || '').trim();
        const category = String(query.category || '').trim();
        const type = String(query.type || '').trim();
        const bankId = Number(query.bankId) || 0;
        const where = [];
        const args = [];
        if (keyword) { where.push('q.stem LIKE ?'); args.push(`%${keyword}%`); }
        if (category) { where.push('q.category = ?'); args.push(category); }
        if (type) { where.push('q.type = ?'); args.push(type); }
        if (bankId) { where.push('q.bank_id = ?'); args.push(bankId); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const [cnt] = await db.query(
          `SELECT COUNT(*) AS n FROM questions q ${whereSql}`, args);
        const [rows] = await db.query(
          `SELECT q.*, b.name AS bankName FROM questions q
             LEFT JOIN question_banks b ON b.id = q.bank_id
             ${whereSql} ORDER BY q.id DESC LIMIT ? OFFSET ?`,
          [...args, pageSize, (page - 1) * pageSize]);
        return { total: cnt[0].n, page, pageSize, list: parseOptions(rows) };
      }
    },
    {
      method: 'POST', path: '/api/admin/questions', auth: 'admin',
      handler: async ({ db, body, user }) => {
        const { row, error } = normalizeQuestion(body);
        if (error) return fail(400, error);
        const bankId = Number(body.bankId) || 0;
        if (bankId) await assertBankAccess(db, user, bankId, { write: true });
        const [r] = await db.query(
          'INSERT INTO questions (bank_id, category, type, stem, options, answer, analysis) VALUES (?,?,?,?,?,?,?)',
          [bankId || null, row.category, row.type, row.stem, row.options, row.answer, row.analysis]);
        return { id: r.insertId };
      }
    },
    {
      method: 'PUT', path: '/api/admin/questions/:id', auth: 'admin',
      handler: async ({ db, body, params, user }) => {
        const { row, error } = normalizeQuestion(body);
        if (error) return fail(400, error);
        const bankId = Number(body.bankId) || 0;
        if (bankId) await assertBankAccess(db, user, bankId, { write: true });
        const [r] = await db.query(
          'UPDATE questions SET bank_id=?, category=?, type=?, stem=?, options=?, answer=?, analysis=? WHERE id=?',
          [bankId || null, row.category, row.type, row.stem, row.options, row.answer, row.analysis, params.id]);
        if (!r.affectedRows) return fail(404, '题目不存在');
        return { ok: true };
      }
    },
    {
      method: 'DELETE', path: '/api/admin/questions/:id', auth: 'admin',
      handler: async ({ db, params }) => {
        await deleteQuestions(db, [Number(params.id)]);
        return { ok: true };
      }
    },
    {
      method: 'POST', path: '/api/admin/questions/clear', auth: 'admin',
      handler: async ({ db }) => {
        // 题库一并清除，避免留下空壳题库
        await db.batch([
          { sql: 'DELETE FROM record_details', params: [] },
          { sql: 'DELETE FROM practice_seen', params: [] },
          { sql: 'DELETE FROM wrong_book', params: [] },
          { sql: 'DELETE FROM questions', params: [] },
          { sql: 'DELETE FROM bank_acl', params: [] },
          { sql: 'DELETE FROM question_banks', params: [] }
        ]);
        return { ok: true };
      }
    },
    {
      method: 'POST', path: '/api/admin/questions/import', auth: 'admin',
      handler: async ({ db, body, user }) => importQuestions(db, user, body)
    },
    {
      method: 'POST', path: '/api/banks/:id/import', auth: 'user',
      handler: async ({ db, body, params, user }) =>
        importQuestions(db, user, { ...body, bankId: params.id })
    },

    /* ---------------- 管理后台：成绩 ---------------- */
    {
      method: 'GET', path: '/api/admin/records', auth: 'admin',
      handler: async ({ db, query }) => {
        const page = Math.max(1, Number(query.page) || 1);
        const pageSize = Math.min(50, Math.max(5, Number(query.pageSize) || 10));
        const keyword = String(query.keyword || '').trim();
        const mode = String(query.mode || '').trim();
        const where = ["r.status='submitted'"];
        const args = [];
        if (keyword) { where.push('u.username LIKE ?'); args.push(`%${keyword}%`); }
        if (mode) { where.push('r.mode = ?'); args.push(mode); }
        const whereSql = 'WHERE ' + where.join(' AND ');
        const [cnt] = await db.query(
          `SELECT COUNT(*) AS n FROM exam_records r JOIN users u ON u.id=r.user_id ${whereSql}`, args);
        const [rows] = await db.query(
          `SELECT r.*, u.username FROM exam_records r JOIN users u ON u.id=r.user_id ${whereSql}
           ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
          [...args, pageSize, (page - 1) * pageSize]);
        return { total: cnt[0].n, page, pageSize, list: rows };
      }
    },
    {
      method: 'GET', path: '/api/admin/records/:id', auth: 'admin',
      handler: async ({ db, params }) => {
        const [recs] = await db.query(
          `SELECT r.*, u.username FROM exam_records r JOIN users u ON u.id=r.user_id WHERE r.id=?`, [params.id]);
        if (!recs.length) return fail(404, '记录不存在');
        const [details] = await db.query(
          `SELECT d.question_id, d.user_answer, d.is_correct, q.category, q.type, q.stem, q.options, q.answer, q.analysis
           FROM record_details d JOIN questions q ON q.id=d.question_id WHERE d.record_id=? ORDER BY d.id`,
          [params.id]);
        return { ...recs[0], details: parseOptions(details) };
      }
    },

    /* ---------------- 管理后台：用户 ---------------- */
    {
      method: 'GET', path: '/api/admin/users', auth: 'admin',
      handler: async ({ db, query }) => {
        const keyword = String(query.keyword || '').trim();
        const role = String(query.role || '').trim();
        const where = [];
        const args = [];
        if (keyword) { where.push('u.username LIKE ?'); args.push(`%${keyword}%`); }
        if (role) { where.push('u.role = ?'); args.push(role); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const [list] = await db.query(`
          SELECT
            u.id, u.username, u.role, u.created_at,
            IFNULL((SELECT GROUP_CONCAT(a.bank_id) FROM bank_acl a WHERE a.user_id = u.id), '') AS aclBankIds,
            IFNULL(SUM(CASE WHEN r.mode='exam' AND r.status='submitted' THEN 1 ELSE 0 END),0) AS examCount,
            IFNULL(SUM(CASE WHEN r.mode='practice' AND r.status='submitted' THEN 1 ELSE 0 END),0) AS practiceCount,
            IFNULL(ROUND(AVG(CASE WHEN r.status='submitted' THEN r.score END),1),0) AS avgScore,
            IFNULL(w.wrong, 0) AS wrongCount,
            COUNT(DISTINCT r.id) AS recordCount
          FROM users u
          LEFT JOIN exam_records r ON r.user_id = u.id
          LEFT JOIN (SELECT user_id, SUM(wrong_count) AS wrong FROM wrong_book GROUP BY user_id) w ON w.user_id = u.id
          ${whereSql}
          GROUP BY u.id, u.username, u.role, u.created_at
          ORDER BY u.id`, args);
        return { list };
      }
    },
    {
      method: 'PUT', path: '/api/admin/users/:id/reset-password', auth: 'admin',
      handler: async ({ db, body, params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) return fail(400, '无效的用户 ID');
        const password = String(body.password || '');
        if (password.length < 6 || password.length > 40) return fail(400, '密码长度需为 6~40 位');
        const [rows] = await db.query('SELECT id, username, role FROM users WHERE id = ?', [id]);
        if (!rows.length) return fail(404, '用户不存在');
        await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), id]);
        return { ok: true, username: rows[0].username };
      }
    },

    /* ---------------- 管理后台：账号增删改 ---------------- */
    {
      method: 'POST', path: '/api/admin/users', auth: 'admin',
      handler: async ({ db, body }) => {
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const role = String(body.role || '') === 'admin' ? 'admin' : 'user';
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/.test(username)) return fail(400, '用户名需为 3~20 位字母、数字、下划线或中文');
        if (password.length < 6 || password.length > 40) return fail(400, '密码长度需为 6~40 位');
        const [exist] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (exist.length) return fail(400, '该用户名已存在');
        const [r] = await db.query('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)',
          [username, await hashPassword(password), role]);
        return { id: r.insertId, username, role };
      }
    },
    {
      method: 'PUT', path: '/api/admin/users/:id', auth: 'admin',
      handler: async ({ db, body, params, user }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) return fail(400, '无效的用户 ID');
        const [rows] = await db.query('SELECT id, username, role FROM users WHERE id = ?', [id]);
        if (!rows.length) return fail(404, '用户不存在');
        const role = String(body.role || '') === 'admin' ? 'admin' : 'user';
        if (rows[0].role === 'admin' && role !== 'admin') {
          // 不允许把最后一个管理员降级，否则系统将无人可管理
          const [admins] = await db.query("SELECT COUNT(*) AS n FROM users WHERE role='admin'");
          if (admins[0].n <= 1) return fail(400, '至少要保留一个管理员');
          if (id === user.uid) return fail(400, '不能取消自己的管理员权限');
        }
        await db.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        return { ok: true, username: rows[0].username, role };
      }
    },
    {
      method: 'DELETE', path: '/api/admin/users/:id', auth: 'admin',
      handler: async ({ db, params, user }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) return fail(400, '无效的用户 ID');
        if (id === user.uid) return fail(400, '不能删除当前登录的账号');
        const [rows] = await db.query('SELECT id, role FROM users WHERE id = ?', [id]);
        if (!rows.length) return fail(404, '用户不存在');
        if (rows[0].role === 'admin') {
          const [admins] = await db.query("SELECT COUNT(*) AS n FROM users WHERE role='admin'");
          if (admins[0].n <= 1) return fail(400, '至少要保留一个管理员');
        }
        // 一并清理该用户的全部数据（题库归属/成绩/错题/授权）
        const [banks] = await db.query('SELECT id FROM question_banks WHERE owner_id = ?', [id]);
        for (const b of banks) {
          const ids = await bankQuestionIds(db, b.id);
          await deleteQuestions(db, ids);
        }
        const [records] = await db.query('SELECT id FROM exam_records WHERE user_id = ?', [id]);
        for (const rec of records) {
          await db.query('DELETE FROM record_details WHERE record_id = ?', [rec.id]);
        }
        await db.batch([
          { sql: 'DELETE FROM bank_acl WHERE user_id = ?', params: [id] },
          { sql: 'DELETE FROM question_banks WHERE owner_id = ?', params: [id] },
          { sql: 'DELETE FROM exam_records WHERE user_id = ?', params: [id] },
          { sql: 'DELETE FROM wrong_book WHERE user_id = ?', params: [id] },
          { sql: 'DELETE FROM practice_seen WHERE user_id = ?', params: [id] },
          { sql: 'DELETE FROM users WHERE id = ?', params: [id] }
        ]);
        return { ok: true };
      }
    },
    {
      // 设置某个用户可以使用哪些题库（覆盖式）
      method: 'PUT', path: '/api/admin/users/:id/banks', auth: 'admin',
      handler: async ({ db, body, params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) return fail(400, '无效的用户 ID');
        const [rows] = await db.query('SELECT id FROM users WHERE id = ?', [id]);
        if (!rows.length) return fail(404, '用户不存在');
        const bankIds = normalizeIds(body.bankIds);
        await db.query('DELETE FROM bank_acl WHERE user_id = ?', [id]);
        if (bankIds.length) {
          await db.batch(chunkInserts('INSERT INTO bank_acl (bank_id, user_id) VALUES ', 2,
            bankIds.map((b) => [b, id])));
        }
        return { ok: true, count: bankIds.length };
      }
    },

    /* ---------------- 管理后台：题库管理 ---------------- */
    {
      method: 'PUT', path: '/api/admin/banks/:id', auth: 'admin',
      handler: async ({ db, body, params }) => {
        const b = await assertBankAccess(db, { role: 'admin' }, params.id, { write: true });
        const name = String(body.name || '').trim();
        if (body.name !== undefined) {
          if (!name) return fail(400, '题库名称不能为空');
          if (name.length > 60) return fail(400, '题库名称过长（最多 60 字）');
        }
        const scope = String(body.scope || '') === 'public' ? 'public' : 'private';
        await db.query('UPDATE question_banks SET name = ?, scope = ? WHERE id = ?',
          [name || b.name, scope, b.id]);
        if (Array.isArray(body.userIds)) {
          const userIds = normalizeIds(body.userIds);
          await db.query('DELETE FROM bank_acl WHERE bank_id = ?', [b.id]);
          if (userIds.length) {
            await db.batch(chunkInserts('INSERT INTO bank_acl (bank_id, user_id) VALUES ', 2,
              userIds.map((uid) => [b.id, uid])));
          }
        }
        return { ok: true, name: name || b.name, scope };
      }
    },
    {
      method: 'DELETE', path: '/api/admin/banks/:id', auth: 'admin',
      handler: async ({ db, params }) => {
        const b = await assertBankAccess(db, { role: 'admin' }, params.id, { write: true });
        const ids = await bankQuestionIds(db, b.id);
        await deleteQuestions(db, ids);
        await db.batch([
          { sql: 'DELETE FROM bank_acl WHERE bank_id = ?', params: [b.id] },
          { sql: 'DELETE FROM question_banks WHERE id = ?', params: [b.id] }
        ]);
        return { ok: true, removed: ids.length };
      }
    },
    {
      method: 'GET', path: '/api/admin/banks/:id/users', auth: 'admin',
      handler: async ({ db, params }) => {
        const [users] = await db.query(
          'SELECT id, username, role FROM users ORDER BY role DESC, id');
        const [acl] = await db.query('SELECT user_id FROM bank_acl WHERE bank_id = ?', [params.id]);
        const allowed = new Set(acl.map((a) => a.user_id));
        return { list: users.map((u) => ({ ...u, allowed: allowed.has(u.id) })) };
      }
    },

    /* ---------------- 管理后台：统计 ---------------- */
    {
      method: 'GET', path: '/api/admin/stats', auth: 'admin',
      handler: async ({ db }) => {
        const [overview] = await db.query(`
          SELECT
            (SELECT COUNT(*) FROM users) AS userCount,
            (SELECT COUNT(*) FROM users WHERE role='admin') AS adminCount,
            (SELECT COUNT(*) FROM questions) AS questionCount,
            (SELECT COUNT(*) FROM exam_records WHERE status='submitted') AS recordCount,
            (SELECT IFNULL(ROUND(AVG(score),1),0) FROM exam_records WHERE status='submitted') AS avgScore,
            (SELECT IFNULL(ROUND(MAX(score),0),0) FROM exam_records WHERE status='submitted') AS maxScore`);
        const [byCategory] = await db.query(
          'SELECT category, COUNT(*) AS count FROM questions GROUP BY category ORDER BY count DESC');
        const [byMode] = await db.query(
          `SELECT mode, COUNT(*) AS count, IFNULL(ROUND(AVG(score),1),0) AS avgScore
           FROM exam_records WHERE status='submitted' GROUP BY mode`);
        const [recent] = await db.query(
          `SELECT r.id, r.mode, r.category, r.score, r.correct_count, r.total_count, r.created_at, u.username
           FROM exam_records r JOIN users u ON u.id=r.user_id WHERE r.status='submitted'
           ORDER BY r.created_at DESC LIMIT 10`);
        return { overview: overview[0], byCategory, byMode, recent };
      }
    }
  ];

  return routes.map((r) => (STUDENT_ONLY.has(r.path)
    ? {
      ...r,
      handler: (ctx) => {
        if (ctx.user && ctx.user.role === 'admin') return fail(403, '管理员账号为纯管理账号，不参与答题');
        return r.handler(ctx);
      }
    }
    : r));
}

export { TYPE_MAP, TYPE_NAME, JUDGE_OPTIONS };
