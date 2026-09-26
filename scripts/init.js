/**
 * 初始化脚本（Docker / Node 版本）
 *
 *   npm run init                      建表 + 创建默认账号
 *   npm run init -- --csv 题库.csv     额外导入一份题库（可选，也可以网页导入）
 *   npm run init -- --force           已存在默认账号时也重置密码
 *
 * 默认账号：admin / admin123（管理员）、user / user123（学员）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqlite } from '../lib/db-sqlite.js';
import { hashPassword } from '../shared/auth.js';
import { parseImportText } from '../shared/questions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const hasFlag = (name) => argv.includes(name);

const db = createSqlite();

/* ---------- 1. 建表 ---------- */
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
console.log('✓ 数据表已就绪：' + db.DB_PATH);

/* ---------- 2. 默认账号 ---------- */
const SEEDS = [
  { username: 'admin', password: 'admin123', role: 'admin' },
  { username: 'user', password: 'user123', role: 'user' }
];

for (const s of SEEDS) {
  const [rows] = await db.query('SELECT id, password_hash FROM users WHERE username = ?', [s.username]);
  const isLegacy = rows.length && !String(rows[0].password_hash).startsWith('pbkdf2$');
  if (!rows.length) {
    await db.query('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)',
      [s.username, await hashPassword(s.password), s.role]);
    console.log(`✓ 已创建账号：${s.username} / ${s.password}（${s.role}）`);
  } else if (hasFlag('--force') || isLegacy) {
    // 旧版本是 node scrypt 哈希，统一升级为 PBKDF2（Workers 版本也能识别）
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(s.password), rows[0].id]);
    console.log(`✓ 已重置密码：${s.username} / ${s.password}`);
  } else {
    console.log(`· 账号已存在：${s.username}`);
  }
}

/* ---------- 3. 可选：导入题库 ---------- */
const csvPath = getArg('--csv');
if (csvPath) {
  const abs = path.isAbsolute(csvPath) ? csvPath : path.join(process.cwd(), csvPath);
  if (!fs.existsSync(abs)) {
    console.error('✗ 找不到题库文件：' + abs);
    process.exit(1);
  }
  const { rows, failed, format } = parseImportText(fs.readFileSync(abs, 'utf8'));
  if (rows.length) {
    const { chunkInserts } = await import('../shared/api-core.js');
    await db.batch(chunkInserts(
      'INSERT INTO questions (category, type, stem, options, answer, analysis) VALUES ',
      6,
      rows.map((r) => [r.category, r.type, r.stem, r.options, r.answer, r.analysis])));
  }
  console.log(`✓ 导入题库（${format}）：成功 ${rows.length} 题，失败 ${failed.length} 行`);
  if (failed.length) console.log('  失败明细（前 10 行）：', failed.slice(0, 10));
}

const [q] = await db.query('SELECT COUNT(*) AS n FROM questions');
console.log(`\n当前题库共 ${q[0].n} 题。`);
if (!q[0].n) console.log('提示：登录后在「管理后台 → 批量导入」上传题库 CSV 即可。');
console.log('启动服务：npm start');
