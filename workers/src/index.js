/**
 * Cloudflare Workers 入口：Hono + D1 + 静态资源
 *
 * 静态资源由 Workers Assets 提供（wrangler.jsonc 里 assets.directory 指向 public/），
 * 只有匹配不到静态文件的请求（也就是 /api/*）才会走到这里的 Worker。
 */

import { Hono } from 'hono';
import { createApiRoutes, HttpError } from '../../shared/api-core.js';
import { verifyToken } from '../../shared/auth.js';
import { createD1 } from './db-d1.js';

const app = new Hono();
const routes = createApiRoutes();

const readBody = async (c, method) => {
  if (method === 'GET' || method === 'DELETE' || method === 'HEAD') return {};
  const ct = c.req.header('content-type') || '';
  if (!ct.includes('application/json')) return {};
  try { return await c.req.json(); } catch { return {}; }
};

for (const r of routes) {
  const method = r.method.toLowerCase();
  const handler = async (c) => {
    const secret = (c.env && c.env.TOKEN_SECRET) || 'ques-service-secret-please-change';
    const ctx = {
      params: c.req.param() || {},
      query: c.req.query() || {},
      body: await readBody(c, r.method),
      db: createD1(c.env),
      secret,
      env: c.env
    };
    try {
      if (r.auth === 'user' || r.auth === 'admin') {
        const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
        const payload = await verifyToken(token, secret);
        if (!payload) return c.json({ error: '请先登录' }, 401);
        if (r.auth === 'admin' && payload.role !== 'admin') return c.json({ error: '需要管理员权限' }, 403);
        ctx.user = payload;
      }
      const data = await r.handler(ctx);
      return c.json(data === undefined ? { ok: true } : data);
    } catch (e) {
      if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
      console.error('[API ERROR]', r.method, r.path, e && e.message, e && e.stack);
      return c.json({ error: '服务器内部错误：' + (e && e.message ? e.message : '未知') }, 500);
    }
  };
  app[method](r.path, handler);
}

// API 兜底 404
app.all('/api/*', (c) => c.json({ error: '接口不存在' }, 404));

// 其余请求：交给静态资源（本地 dev 或 run_worker_first 场景下的兜底）
app.all('*', async (c) => {
  if (c.env && c.env.ASSETS) {
    try { return await c.env.ASSETS.fetch(c.req.raw); } catch { /* ignore */ }
  }
  return c.text('Not Found', 404);
});

export default app;
