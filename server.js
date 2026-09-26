/**
 * Node / Docker 入口：Express + SQLite，复用 shared/ 里的业务核心。
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiRoutes, HttpError } from './shared/api-core.js';
import { verifyToken } from './shared/auth.js';
import { createSqlite } from './lib/db-sqlite.js';

// Node 18 没有全局 crypto（Web Crypto 到 Node 19 才默认暴露），
// 而 shared/ 里的密码哈希与 Token 签名全部基于 Web Crypto，缺失会让登录直接 500。
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 兼容旧版本用 node scrypt 生成的密码哈希（salt:hash，均为 hex） */
async function legacyVerify(pwd, stored) {
  const s = String(stored || '');
  if (s.startsWith('pbkdf2$')) return false;
  const [salt, hash] = s.split(':');
  if (!salt || !hash || !/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(hash)) return false;
  try {
    const h = crypto.scryptSync(String(pwd), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = createSqlite();
// 启动时建表：全新库直接按 schema.sql 建全套，老库因 IF NOT EXISTS 不会被动到。
// （不要只补新表——空库上 questions 不存在，后面的索引语句会直接崩。）
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
// 老库补列：早期版本的 questions 没有 bank_id
{
  const cols = db.raw.prepare('PRAGMA table_info(questions)').all().map((c) => c.name);
  if (cols.length && !cols.includes('bank_id')) {
    try { db.exec('ALTER TABLE questions ADD COLUMN bank_id INTEGER'); } catch { /* 已存在则忽略 */ }
  }
}
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_questions_bank ON questions(bank_id)');
} catch { /* 忽略 */ }

const secret = process.env.TOKEN_SECRET || 'ques-service-secret-please-change';
const routes = createApiRoutes();

for (const r of routes) {
  const handler = async (req, res) => {
    const ctx = {
      params: req.params || {},
      query: req.query || {},
      body: req.body || {},
      user: req.user,
      db,
      secret,
      env: { legacyVerify }
    };
    try {
      if (r.auth === 'user' || r.auth === 'admin') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const payload = await verifyToken(token, secret);
        if (!payload) return res.status(401).json({ error: '请先登录' });
        if (r.auth === 'admin' && payload.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
        ctx.user = payload;
      }
      const data = await r.handler(ctx);
      res.json(data === undefined ? { ok: true } : data);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      if (e && typeof e.code === 'string' && e.code.startsWith('SQLITE_')) {
        console.error('[DB ERROR]', e.message);
        return res.status(503).json({ error: '数据库访问失败：请确认已执行 npm run init 建表' });
      }
      console.error('[API ERROR]', r.method, r.path, e && e.message);
      res.status(500).json({ error: '服务器内部错误' });
    }
  };
  const p = r.path.replace(/:([A-Za-z0-9_]+)/g, ':$1'); // express 与 hono 的写法一致
  if (r.method === 'GET') app.get(p, handler);
  else if (r.method === 'POST') app.post(p, handler);
  else if (r.method === 'PUT') app.put(p, handler);
  else if (r.method === 'DELETE') app.delete(p, handler);
}

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`在线答题系统已启动: http://localhost:${PORT}`);
  console.log('数据库：' + db.DB_PATH);
  console.log('首次使用：执行 npm run init 建表并创建默认账号；题目请在管理后台网页导入。');
});
