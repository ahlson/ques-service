/**
 * 题目相关的纯逻辑：题型常量、题目规范化、判分、以及题库导入解析。
 * 不依赖任何运行时（Node / Workers 通用）。
 */

export const TYPE_MAP = { 单选: 'single', 多选: 'multiple', 判断: 'judge', 单选题: 'single', 多选题: 'multiple', 判断题: 'judge', single: 'single', multiple: 'multiple', judge: 'judge' };
export const TYPE_NAME = { single: '单选题', multiple: '多选题', judge: '判断题' };

/** 判断题固定选项与答案映射 */
export const JUDGE_OPTIONS = ['正确', '错误'];
const JUDGE_TRUE = /^(正确|对|T|TRUE|YES|Y|1|A)$/i;
const JUDGE_FALSE = /^(错误|错|F|FALSE|NO|N|0|B)$/i;

/** 把用户输入的答案统一成大写、去空格 */
export function normalizeAnswer(ans) {
  return String(ans == null ? '' : ans).trim().toUpperCase().replace(/\s+/g, '');
}

/** 判分：多选按字母集合比较，其余直接字符串比较 */
export function isCorrect(type, correct, userAns) {
  const u = normalizeAnswer(userAns);
  if (!u) return false;
  if (type === 'multiple') {
    const a = [...new Set(u.split(''))].sort().join('');
    const c = [...new Set(String(correct).split(''))].sort().join('');
    return a === c;
  }
  return u === String(correct).trim().toUpperCase();
}

/**
 * 校验并规范化一道题。
 * @returns {{error:string}|{row:{category,type,stem,options,answer,analysis}}}
 */
export function normalizeQuestion(b) {
  const rawType = String(b.type || '').trim();
  const type = TYPE_MAP[rawType];
  if (!type || !['single', 'multiple', 'judge'].includes(type)) {
    return { error: '题目类型不合法（应为 单选/多选/判断）' };
  }
  const category = TYPE_NAME[type];
  const stem = String(b.stem || '').trim();
  if (!stem) return { error: '请填写题干' };

  let options = [];
  let answer = normalizeAnswer(b.answer);

  if (type === 'judge') {
    options = JUDGE_OPTIONS;
    if (JUDGE_TRUE.test(answer)) answer = 'T';
    else if (JUDGE_FALSE.test(answer)) answer = 'F';
    else return { error: '判断题答案只能是「正确」或「错误」（也接受 对/错/T/F/A/B）' };
  } else {
    options = (Array.isArray(b.options) ? b.options : [])
      .map((o) => String(o == null ? '' : o).trim())
      .filter((o) => o.length > 0);
    if (options.length < 2 || options.length > 6) return { error: '选择题至少需要 2 个非空选项（最多 6 个）' };
    const maxLetter = String.fromCharCode(64 + options.length);
    if (type === 'single') {
      if (!/^[A-Z]$/.test(answer) || answer > maxLetter) {
        return { error: `单选题答案应为 A~${maxLetter} 中的一个字母` };
      }
    } else {
      if (!/^[A-Z]{2,6}$/.test(answer)) return { error: '多选题答案应为多个字母，如 ABD' };
      const letters = [...answer];
      if (new Set(letters).size !== letters.length) return { error: '多选题答案字母不能重复' };
      if (letters.some((l) => l > maxLetter)) {
        return { error: `答案包含超出选项范围的字母（最多 ${maxLetter}）` };
      }
      answer = [...new Set(letters)].sort().join('');
    }
  }

  return {
    row: {
      category,
      type,
      stem,
      options: JSON.stringify(options),
      answer,
      analysis: String(b.analysis || '').trim()
    }
  };
}

/* ================================================================
 *                        CSV / 文本导入解析
 * ================================================================ */

/** 引号感知的 CSV 解析（字段内可含换行、逗号、转义双引号） */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  const s = String(text || '').replace(/^﻿/, ''); // 去掉 BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === ',') { row.push(cur); cur = ''; continue; }
    if (c === '\r') { continue; }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; continue; }
    cur += c;
  }
  row.push(cur);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const cleanCell = (s) => String(s == null ? '' : s).replace(/^﻿/, '').trim();

/** 判断一行是否像表头 */
function looksLikeHeader(cells) {
  const flat = cells.map(cleanCell).join('|');
  return /题干/.test(flat) || /题型/.test(flat) || /答案/.test(flat);
}

/**
 * 模板 CSV（10 列）解析：
 * 题号,题干,A,B,C,D,E,答案,难度,题型
 * - 判断题：难度列 = 判断，A/B 选项为 正确/错误，答案为 A 或 B
 * - 单选/多选：题型列 = 单选题 / 多选题，答案为字母（多选多个字母）
 *
 * 也容忍缺列、列顺序不同（按表头名定位）。
 */
function parseTemplateCsv(rows) {
  const header = rows[0].map((c) => cleanCell(c));
  const idx = (...names) => {
    for (const n of names) {
      const i = header.findIndex((h) => h === n || h.replace(/\s/g, '') === n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iStem = idx('题干', '题目', '题目内容');
  const iAnswer = idx('答案', '正确答案', '标准答案');
  const iDiff = idx('难度', '难度等级');
  const iType = idx('题型', '题目类型', '类型');
  if (iStem < 0 || iAnswer < 0) return null;

  const optIdx = [];
  for (const L of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const i = header.findIndex((h) => h.toUpperCase() === L);
    if (i >= 0) optIdx.push(i);
  }
  // 兜底：没有 A/B/C/D 表头时，认为「题干之后、答案之前」都是选项列
  if (!optIdx.length) {
    for (let i = iStem + 1; i < iAnswer; i++) optIdx.push(i);
  }

  const out = [];
  const failed = [];
  rows.slice(1).forEach((r, n) => {
    const lineNo = n + 2;
    const stem = cleanCell(r[iStem]).replace(/\s*\r?\n\s*/g, '');
    if (!stem) { failed.push({ line: lineNo, reason: '题干为空' }); return; }
    const options = optIdx.map((i) => cleanCell(r[i]).replace(/\s*\r?\n\s*/g, '')).filter((x) => x !== '');
    const ansRaw = cleanCell(r[iAnswer]).replace(/\s+/g, '').toUpperCase();
    const diff = iDiff >= 0 ? cleanCell(r[iDiff]) : '';
    const typeRaw = iType >= 0 ? cleanCell(r[iType]) : '';

    let type = '';
    if (diff === '判断' || /判断/.test(typeRaw)) type = 'judge';
    else if (/多选/.test(typeRaw)) type = 'multiple';
    else if (/单选/.test(typeRaw)) type = 'single';
    // 选项本身就是 正确/错误 的一律按判断题处理
    const opts2 = options.map((o) => o.replace(/[（(]\s*[)）]/g, '').trim());
    if (!type && opts2.length === 2 && /^(正确|对)$/.test(opts2[0]) && /^(错误|错)$/.test(opts2[1])) {
      type = 'judge';
    }
    if (!type) type = ansRaw.length > 1 ? 'multiple' : 'single';

    const { row, error } = normalizeQuestion({ type, stem, options, answer: ansRaw, analysis: '' });
    if (error) { failed.push({ line: lineNo, reason: error }); return; }
    out.push(row);
  });
  return { rows: out, failed, format: 'csv' };
}

/**
 * 竖线分隔文本解析（旧格式）：
 * 题型|题干|选项A|选项B|…|正确答案|解析
 */
function parsePipeText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { rows: [], failed: [], format: 'pipe' };

  // 各题型答案的识别规则：选项个数可变（2~6），答案列位置随之前移，故从后往前定位
  const ANS_PATTERN = {
    single: /^[A-F]$/i,
    multiple: /^[A-F]{2,6}$/i,
    judge: /^(正确|错误|对|错|T|F|TRUE|FALSE|A|B)$/i
  };

  const rows = [];
  const failed = [];
  lines.forEach((line, i) => {
    const parts = line.split('|').map((s) => s.trim());
    const type = TYPE_MAP[parts[0]];
    if (!type) { failed.push({ line: i + 1, reason: '题型应为 单选/多选/判断' }); return; }
    if (parts.length < 3) { failed.push({ line: i + 1, reason: '字段过少，至少需 题型|题干|答案' }); return; }
    const pat = ANS_PATTERN[type];
    let k = -1;
    for (let idx = parts.length - 1; idx >= 2; idx--) {
      if (pat.test(parts[idx])) { k = idx; break; }
    }
    if (k === -1) {
      const hint = type === 'judge' ? '对/错' : (type === 'single' ? '单个字母如 C' : '多个字母如 ABD');
      failed.push({ line: i + 1, reason: `未找到答案列，${TYPE_NAME[type]}答案应为 ${hint}` });
      return;
    }
    const analysis = parts.slice(k + 1).join(' ').trim();
    const options = type === 'judge' ? ['正确', '错误'] : parts.slice(2, k).filter((x) => x.length > 0);
    const { row, error } = normalizeQuestion({ type, stem: parts[1], options, answer: parts[k], analysis });
    if (error) { failed.push({ line: i + 1, reason: error }); return; }
    rows.push(row);
  });
  return { rows, failed, format: 'pipe' };
}

/**
 * 自动识别并解析导入内容。
 * @returns {{rows:Array, failed:Array, format:'csv'|'pipe'|'empty'}}
 */
export function parseImportText(text) {
  const raw = String(text || '').replace(/^﻿/, '').trim();
  if (!raw) return { rows: [], failed: [], format: 'empty' };
  const rows = parseCsv(raw);
  if (rows.length && looksLikeHeader(rows[0])) {
    const r = parseTemplateCsv(rows);
    if (r) return r;
  }
  // 含逗号且首行像表头的 CSV 但解析失败时，退化为竖线格式再试一次
  return parsePipeText(raw);
}
