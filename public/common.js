/* 公共工具：API 请求、登录态、导航、Toast */
const Auth = {
  get token() { return localStorage.getItem('quiz_token') || ''; },
  get user() { try { return JSON.parse(localStorage.getItem('quiz_user') || 'null'); } catch { return null; } },
  save(token, user) { localStorage.setItem('quiz_token', token); localStorage.setItem('quiz_user', JSON.stringify(user)); },
  clear() { localStorage.removeItem('quiz_token'); localStorage.removeItem('quiz_user'); },
  require(role) {
    if (!this.token || !this.user) { location.href = 'login.html'; throw new Error('请先登录'); }
    if (role === 'admin' && this.user.role !== 'admin') { location.href = 'index.html'; throw new Error('需要管理员权限'); }
    return this.user;
  }
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(Auth.token ? { Authorization: 'Bearer ' + Auth.token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (res.status === 401) { Auth.clear(); location.href = 'login.html'; throw new Error(data.error || '请先登录'); }
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
const getJSON = (u) => api('GET', u);
const postJSON = (u, b) => api('POST', u, b);
const putJSON = (u, b) => api('PUT', u, b);
const delJSON = (u) => api('DELETE', u);

/* ---------- UI 工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, type = '') {
  let box = document.getElementById('toast-box');
  if (!box) { box = document.createElement('div'); box.id = 'toast-box'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

const TYPE_NAME = { single: '单选题', multiple: '多选题', judge: '判断题' };
const MODE_NAME = { practice: '专项刷题', exam: '模拟考试' };

function fmtTime(s) {
  s = Number(s) || 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(String(s).replace(' ', 'T'));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 答案显示：判断题 T/F -> 正确/错误 */
function fmtAnswer(a) {
  if (a === 'T') return '正确';
  if (a === 'F') return '错误';
  return a || '未作答';
}

/* ---------- 顶部导航 ---------- */
function renderHeader(active) {
  const u = Auth.user;
  const links = [
    { href: 'index.html', key: 'home', label: '首页' },
    { href: 'practice.html', key: 'practice', label: '专项刷题' },
    { href: 'wrong.html', key: 'wrong', label: '错题练习' },
    { href: 'exam.html', key: 'exam', label: '模拟考试' },
    { href: 'records.html', key: 'records', label: '我的成绩' }
  ];
  if (u && u.role === 'admin') links.push({ href: 'admin.html', key: 'admin', label: '管理后台' });
  const nav = links.map(l => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`).join('');
  const el = document.createElement('div');
  el.className = 'topbar';
  el.innerHTML = `
    <div class="topbar-inner">
      <a class="logo" href="index.html"><span class="logo-ico">✎</span>在线答题系统</a>
      <nav class="nav">${nav}</nav>
      <div class="topbar-user">
        <span class="role-badge">${u && u.role === 'admin' ? '管理员' : '学员'}</span>
        <span class="uname">${esc(u ? u.username : '')}</span>
        <button class="btn-exit" id="btn-exit">退出</button>
      </div>
    </div>`;
  document.body.prepend(el);
  el.querySelector('#btn-exit').onclick = () => {
    if (confirm('确定退出登录吗？')) { Auth.clear(); location.href = 'login.html'; }
  };
}

function confirmAction(msg) { return window.confirm(msg); }
