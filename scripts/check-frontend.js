/**
 * 前端自检脚本：静态检查 public/*.html 内联脚本的常见低级错误
 *
 * 检查三项：
 *   1. 语法：内联 <script> 是否通过 node --check
 *   2. DOM：getElementById('x') 里的 x 是否在同一个 HTML 中真的存在
 *   3. 调用：xxx( 形式的函数调用，是否在本页或 common.js 中定义
 *
 * 适用场景：大范围增删改页面字段/函数后，用来抓「删了定义却留下调用」这类
 * 浏览器控制台才会暴露的错误（例如 loadCategories is not defined）。
 *
 * 用法：node scripts/check-frontend.js
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COMMON_FILE = path.join(PUBLIC_DIR, 'common.js');

// JS 关键字：正则会把 `if (`、`catch (`、`function foo(` 误判成函数调用
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
  'await', 'else', 'do', 'try', 'throw', 'delete', 'void', 'in', 'of', 'instanceof',
  'async', 'var', 'case', 'super', 'this', 'yield', 'default', 'with'
]);

// JS / 浏览器内置，不算未定义
const BUILTINS = new Set([
  'window', 'document', 'JSON', 'Math', 'Number', 'String', 'Array', 'Object', 'Date',
  'console', 'fetch', 'localStorage', 'sessionStorage', 'setTimeout', 'setInterval',
  'clearInterval', 'clearTimeout', 'encodeURIComponent', 'decodeURIComponent',
  'FileReader', 'parseInt', 'parseFloat', 'isNaN', 'confirm', 'alert', 'Boolean',
  'Promise', 'Error', 'RegExp', 'Set', 'Map', 'location', 'navigator', 'history',
  'URLSearchParams', 'requestAnimationFrame', 'FormData', 'Blob', 'URL'
]);

/** 收集代码中定义的标识符 */
function collectDefs(code) {
  const defs = new Set();
  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) defs.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defs.add(m[1]);
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) defs.add(m[1]);
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/g)) defs.add(m[1]);
  return defs;
}

const commonDefs = fs.existsSync(COMMON_FILE) ? collectDefs(fs.readFileSync(COMMON_FILE, 'utf8')) : new Set();
const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));

let problems = 0;

for (const file of htmlFiles) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const allCode = scripts.join('\n');
  const issues = [];

  // 1. 语法检查：用 vm.Script 在内存中编译，不落临时文件
  scripts.forEach((code, i) => {
    if (!code.trim()) return;
    try {
      new vm.Script(code, { filename: `${file}#script${i}` });
    } catch (e) {
      issues.push(`语法错误(script#${i}): ${e.message}`);
    }
  });

  if (!allCode.trim()) {
    console.log(`${file.padEnd(14)} (无内联脚本)`);
    continue;
  }

  // 2. DOM id 检查
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const usedIds = [...allCode.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  const missingIds = [...new Set(usedIds)].filter((x) => !ids.has(x));
  if (missingIds.length) issues.push(`HTML 中不存在的 id: ${missingIds.join(', ')}`);

  // 3. 函数调用检查（async / var 等关键字是正则误报，忽略）
  const localDefs = collectDefs(allCode);
  const calls = [...allCode.matchAll(/(?:^|[^.\w$])([a-z][A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
  const undefinedCalls = [...new Set(calls)].filter(
    (c) => !localDefs.has(c) && !commonDefs.has(c) && !BUILTINS.has(c) && !KEYWORDS.has(c)
  );
  if (undefinedCalls.length) issues.push(`可能未定义就调用: ${undefinedCalls.join(', ')}`);

  if (issues.length) {
    problems += issues.length;
    console.log(`✗ ${file}`);
    issues.forEach((s) => console.log(`    - ${s}`));
  } else {
    console.log(`✓ ${file}`);
  }
}

console.log(problems ? `\n发现 ${problems} 处问题` : '\n前端自检全部通过');
process.exit(problems ? 1 : 0);
