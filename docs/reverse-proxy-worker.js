/**
 * 反向代理 Worker —— 部署在「域名所在」的那个 Cloudflare 账号
 *
 * 适用场景：你的域名在 Cloudflare 账号 B，答题系统的 Worker 在账号 A，
 * 两边都不想搬。Cloudflare 不允许跨账号给 Worker 绑域名，也不允许跨账号 CNAME
 * 到 workers.dev（会报 Error 1014），所以用一个转发 Worker 打通。
 *
 * 部署步骤（在账号 B 操作）：
 *   1. Workers 和 Pages → 创建 → 创建 Worker → 随便起个名（如 ques-proxy）→ 部署
 *   2. 点「编辑代码」，把本文件内容整段粘贴进去，把下面的 ORIGIN 改成你自己的地址
 *   3. 点「部署」
 *   4. Settings → 域和路由 → 添加 → 自定义域 → 填 ques.你的域名.com
 *
 * 代价：每访问一次要跑两个 Worker，免费版每天 10 万次请求的额度相当于减半；
 *      延迟多一跳（通常几十毫秒）。能接受就用，长期用更建议把域名和 Worker 放同一账号。
 */

const ORIGIN = 'https://ques-service.asksonglh.workers.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, ORIGIN);

    const init = {
      method: request.method,
      headers: request.headers,
      redirect: 'manual',
    };
    // GET / HEAD 不能带 body，否则 Worker 会抛错
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    try {
      return await fetch(new Request(target, init));
    } catch (e) {
      return new Response('源站不可达：' + (e && e.message ? e.message : '未知错误'), {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
};
