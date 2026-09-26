/**
 * 认证工具：密码哈希（PBKDF2-SHA256）+ 轻量签名 Token（HMAC-SHA256）
 *
 * 全部基于 Web Crypto，因此同一份实现既能跑在 Cloudflare Workers 上，
 * 也能跑在 Node 18+（Docker 版本）上，两边产生的密码哈希与 Token 完全通用。
 */

const enc = new TextEncoder();
const PBKDF2_ITER = 100000;   // 迭代次数，越高越慢越安全
const TOKEN_TTL = 7 * 24 * 3600; // Token 有效期 7 天（秒）

/* ---------------- base64url ---------------- */

function toB64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- 密码 ---------------- */

/** 生成 `pbkdf2$<salt>$<hash>` 形式的密码哈希 */
export async function hashPassword(pwd) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pwd)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
  return 'pbkdf2$' + toB64Url(salt) + '$' + toB64Url(new Uint8Array(bits));
}

/** 校验密码；返回 false 表示不匹配或格式不对 */
export async function verifyPassword(pwd, stored) {
  const s = String(stored || '');
  if (!s.startsWith('pbkdf2$')) return false;
  const parts = s.split('$');
  if (parts.length !== 3) return false;
  let salt, want;
  try { salt = fromB64Url(parts[1]); want = fromB64Url(parts[2]); } catch { return false; }
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pwd)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256));
  if (bits.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i];
  return diff === 0;
}

/* ---------------- Token ---------------- */

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** 签发 Token（payload 内带 uid / role / username / exp） */
export async function signToken(payload, secret) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL };
  const raw = toB64Url(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(raw));
  return raw + '.' + toB64Url(new Uint8Array(sig));
}

/** 校验 Token，失败返回 null */
export async function verifyToken(token, secret) {
  const [raw, sig] = String(token || '').split('.');
  if (!raw || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64Url(sig), enc.encode(raw));
  } catch { return null; }
  if (!ok) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64Url(raw)));
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}
