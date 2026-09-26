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
async function fetchQuestionsByIds(db, ids, cols = 'id, type, answer') {
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const map = new Map();
  for (let i = 0; i < uniq.length; i += MAX_PARAMS) {
    const part = uniq.slice(i, i + MAX_PARAMS);
    const [rows] = await db.query(`SELECT ${cols} FROM questions WHERE id IN (?)`, [part]);
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

/**
 * 抽题核心。
 * - new（默认）：只出「一道都没做过」的题，不足就少出，绝不掺旧题；刷完返回空数组
 * - smart：按已练次数升序 + 随机，没做过的排前面，保证每轮凑满 limit
 * - random：最初的纯随机行为
 */
async function pickQuestions({ db, userId, type, limit, mode }) {
  if (mode === 'random' || !userId) {
    const [rows] = await db.query(
      `SELECT id, category, type, stem, options FROM questions
        WHERE (? = '' OR type = ?) ORDER BY RANDOM() LIMIT ?`,
      [type, type, limit]);
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
      WHERE (? = '' OR q.type = ?)`;
  if (mode === 'new') {
    const [rows] = await db.query(
      `SELECT q.id, q.category, q.type, q.stem, q.options` + joinSql +
      ` AND IFNULL(done.done_count, 0) = 0 AND IFNULL(s.seen_count, 0) = 0
        ORDER BY RANDOM() LIMIT ?`,
      [userId, userId, type, type, limit]);
    return rows;
  }
  const [rows] = await db.query(
    `SELECT q.id, q.category, q.type, q.stem, q.options` + joinSql +
      ` ORDER BY (IFNULL(done.done_count, 0) + IFNULL(s.seen_count, 0)) ASC, RANDOM() LIMIT ?`,
    [userId, userId, type, type, limit]);
  return rows;
}

const pickMode = (m) => (m === 'random' ? 'random' : (m === 'smart' ? 'smart' : 'new'));
const parseOptions = (rows) => rows.map((r) => ({ ...r, options: JSON.parse(r.options) }));

/* ================================================================
 *                            路由表
 * ================================================================ */

export function createApiRoutes() {
  return [
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
    {
      method: 'POST', path: '/api/register', auth: 'none',
      handler: async ({ db, body, secret }) => {
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/.test(username)) return fail(400, '用户名需为 3~20 位字母、数字、下划线或中文');
        if (password.length < 6 || password.length > 40) return fail(400, '密码长度需为 6~40 位');
        const [exist] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (exist.length) return fail(400, '该用户名已被注册');
        const [r] = await db.query('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)',
          [username, await hashPassword(password), 'user']);
        const [rows] = await db.query('SELECT id, username, role, created_at FROM users WHERE id = ?', [r.insertId]);
        const user = rows[0];
        return { token: await signToken({ uid: user.id, role: user.role, username: user.username }, secret), user };
      }
    },
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
      method: 'GET', path: '/api/categories', auth: 'none',
      handler: async ({ db }) => {
        const [rows] = await db.query(
          `SELECT category, type, COUNT(*) AS count FROM questions GROUP BY type
            ORDER BY CASE type WHEN 'single' THEN 1 WHEN 'multiple' THEN 2 ELSE 3 END`);
        return rows;
      }
    },

    /* ---------------- 专项刷题 ---------------- */
    {
      method: 'GET', path: '/api/practice/questions', auth: 'user',
      handler: async ({ db, query, user }) => {
        const type = String(query.type || '').trim();
        const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 200);
        const mode = pickMode(String(query.mode || 'new').trim());
        const rows = await pickQuestions({ db, userId: user.uid, type, limit, mode });
        return parseOptions(rows);
      }
    },
    {
      method: 'GET', path: '/api/practice/progress', auth: 'user',
      handler: async ({ db, query, user }) => {
        const type = String(query.type || '').trim();
        const [tot] = await db.query('SELECT COUNT(*) AS n FROM questions WHERE (? = \'\' OR type = ?)', [type, type]);
        const [done] = await db.query(
          `SELECT COUNT(*) AS n FROM (
              SELECT DISTINCT d.question_id AS qid
                FROM record_details d JOIN exam_records r ON r.id = d.record_id
               WHERE r.user_id = ? AND r.status = 'submitted'
              UNION
              SELECT s.question_id AS qid FROM practice_seen s WHERE s.user_id = ?
           ) t JOIN questions q ON q.id = t.qid
           WHERE (? = '' OR q.type = ?)`,
          [user.uid, user.uid, type, type]);
        const total = tot[0].n;
        const doneCount = done[0].n;
        return { total, done: doneCount, unseen: total - doneCount, percent: total ? Math.round((doneCount / total) * 100) : 0 };
      }
    },
    {
      method: 'POST', path: '/api/practice/check', auth: 'user',
      handler: async ({ db, body, user }) => {
        const [rows] = await db.query('SELECT id, type, options, answer, analysis FROM questions WHERE id = ?', [body.questionId]);
        if (!rows.length) return fail(404, '题目不存在');
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
        const qMap = await fetchQuestionsByIds(db, ids);

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
        const picked = [];
        const actual = { single: 0, multiple: 0, judge: 0 };
        const notice = [];
        for (const type of ['single', 'multiple', 'judge']) {
          if (!wanted[type]) continue;
          const rows = await pickQuestions({ db, userId: user.uid, type, limit: wanted[type], mode });
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

        const qMap = await fetchQuestionsByIds(db, answers.map((a) => a.questionId));
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
        const where = [];
        const args = [];
        if (keyword) { where.push('stem LIKE ?'); args.push(`%${keyword}%`); }
        if (category) { where.push('category = ?'); args.push(category); }
        if (type) { where.push('type = ?'); args.push(type); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const [cnt] = await db.query(`SELECT COUNT(*) AS n FROM questions ${whereSql}`, args);
        const [rows] = await db.query(
          `SELECT * FROM questions ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
          [...args, pageSize, (page - 1) * pageSize]);
        return { total: cnt[0].n, page, pageSize, list: parseOptions(rows) };
      }
    },
    {
      method: 'POST', path: '/api/admin/questions', auth: 'admin',
      handler: async ({ db, body }) => {
        const { row, error } = normalizeQuestion(body);
        if (error) return fail(400, error);
        const [r] = await db.query(
          'INSERT INTO questions (category, type, stem, options, answer, analysis) VALUES (?,?,?,?,?,?)',
          [row.category, row.type, row.stem, row.options, row.answer, row.analysis]);
        return { id: r.insertId };
      }
    },
    {
      method: 'PUT', path: '/api/admin/questions/:id', auth: 'admin',
      handler: async ({ db, body, params }) => {
        const { row, error } = normalizeQuestion(body);
        if (error) return fail(400, error);
        const [r] = await db.query(
          'UPDATE questions SET category=?, type=?, stem=?, options=?, answer=?, analysis=? WHERE id=?',
          [row.category, row.type, row.stem, row.options, row.answer, row.analysis, params.id]);
        if (!r.affectedRows) return fail(404, '题目不存在');
        return { ok: true };
      }
    },
    {
      method: 'DELETE', path: '/api/admin/questions/:id', auth: 'admin',
      handler: async ({ db, params }) => {
        await db.query('DELETE FROM questions WHERE id=?', [params.id]);
        return { ok: true };
      }
    },
    {
      method: 'POST', path: '/api/admin/questions/clear', auth: 'admin',
      handler: async ({ db }) => {
        await db.batch([
          { sql: 'DELETE FROM record_details', params: [] },
          { sql: 'DELETE FROM practice_seen', params: [] },
          { sql: 'DELETE FROM wrong_book', params: [] },
          { sql: 'DELETE FROM questions', params: [] }
        ]);
        return { ok: true };
      }
    },
    {
      method: 'POST', path: '/api/admin/questions/import', auth: 'admin',
      handler: async ({ db, body }) => {
        const { rows, failed, format } = parseImportText(body.text);
        if (!rows.length && !failed.length) return fail(400, '没有可导入的内容');
        if (rows.length) {
          await db.batch(chunkInserts(
            'INSERT INTO questions (category, type, stem, options, answer, analysis) VALUES ',
            6,
            rows.map((r) => [r.category, r.type, r.stem, r.options, r.answer, r.analysis])));
        }
        return { success: rows.length, failed, format };
      }
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
}

export { TYPE_MAP, TYPE_NAME, JUDGE_OPTIONS };
