#!/usr/bin/env node
/**
 * 生成部署用的 wrangler.deploy.jsonc
 *
 * 目的：不想把 D1 的 database_id 写进 GitHub 仓库时使用。
 * 真实 ID 放在 Cloudflare Workers Builds 的「变量和机密」里（设成 Secret），
 * 构建时由本脚本把占位符替换掉，生成的 wrangler.deploy.jsonc 已被 .gitignore 忽略，
 * 不会进入版本库。
 *
 * 用法：
 *   D1_DATABASE_ID=xxx-xxx-xxx node scripts/gen-wrangler.js
 *
 * 可选环境变量：
 *   D1_DATABASE_ID   D1 数据库 ID（必填，除非 wrangler.jsonc 里已经填了真实值）
 *   TOKEN_SECRET     登录 Token 签名密钥（可选，不填就沿用 wrangler.jsonc 里的值）
 *
 * 退出码：缺少 D1_DATABASE_ID 时为 1，并打印清晰的错误提示。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, '..', 'wrangler.jsonc');
const outPath = join(here, '..', 'wrangler.deploy.jsonc');

const PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID';

if (!existsSync(srcPath)) {
  console.error('[gen-wrangler] 找不到 wrangler.jsonc：' + srcPath);
  process.exit(1);
}

let text = readFileSync(srcPath, 'utf8');

// 取当前配置里写的 database_id
const currentIdMatch = text.match(/"database_id"\s*:\s*"([^"]*)"/);
const currentId = currentIdMatch ? currentIdMatch[1] : '';
const envId = (process.env.D1_DATABASE_ID || '').trim();

let finalId = envId || (currentId && currentId !== PLACEHOLDER ? currentId : '');

if (!finalId) {
  console.error(
    '\n[gen-wrangler] 缺少 D1_DATABASE_ID。\n' +
      '请在 Cloudflare → Workers 和 Pages → ques-service → Settings → 变量和机密\n' +
      '里添加 Secret：D1_DATABASE_ID = 你的 D1 Database ID；\n' +
      '或者本地执行：D1_DATABASE_ID=你的ID node scripts/gen-wrangler.js\n'
  );
  process.exit(1);
}

text = text.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${finalId}"`);

const envSecret = (process.env.TOKEN_SECRET || '').trim();
if (envSecret) {
  text = text.replace(/"TOKEN_SECRET"\s*:\s*"[^"]*"/, `"TOKEN_SECRET": "${envSecret}"`);
}

writeFileSync(outPath, text, 'utf8');
console.log('[gen-wrangler] 已生成 wrangler.deploy.jsonc（database_id = ' + finalId + '）');
console.log('[gen-wrangler] 该文件不会被提交到 Git。');
