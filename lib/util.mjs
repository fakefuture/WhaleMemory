// lib/util.mjs — 无依赖工具：分词、相似度、时间、原子写。
// 目标：Windows 上 Node 18+ 直接可跑，不引入任何第三方包。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

export function round(x, digits = 4) {
  if (!Number.isFinite(x)) return 0;
  return Number(x.toFixed(digits));
}

export function newId(prefix = 'mem') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// 词面分词：ascii 词 + CJK 单字与双字。没有向量模型，这是刻意选择的“可解释”相似度。
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const set = new Set();
  for (const m of s.matchAll(/[a-z0-9_]+/g)) set.add(m[0]);
  const cjk = s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || [];
  for (let i = 0; i < cjk.length; i += 1) {
    set.add(cjk[i]);
    if (i + 1 < cjk.length) set.add(cjk[i] + cjk[i + 1]);
  }
  return set;
}

export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (b - a) / 86400000;
}

// 余弦衰减的 EMA 步长：观察次数越少步长越大，越往后越稳。
// n<=1 时取 alphaMax；n 达到 span 后降到 alphaMin。
export function cosineAlpha(n, { max = 0.6, min = 0.03, span = 24 } = {}) {
  if (!Number.isFinite(n) || n <= 1) return max;
  const t = Math.min(1, (n - 1) / Math.max(1, span));
  const c = 0.5 * (1 + Math.cos(Math.PI * t));
  return round(min + (max - min) * c, 6);
}

export function unique(arr) {
  return [...new Set((arr || []).filter((x) => x !== undefined && x !== null && x !== ''))];
}

export function sum(arr) {
  return (arr || []).reduce((a, b) => a + b, 0);
}

export function mean(arr) {
  const a = arr || [];
  return a.length ? sum(a) / a.length : 0;
}

export function parseList(v) {
  if (v === undefined || v === null || v === true || v === false) return [];
  return unique(String(v).split(',').map((x) => x.trim()).filter(Boolean));
}

export function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // 编辑器/PowerShell 可能写进 BOM：JSON.parse 会直接抛，读不到就当没有，
    // 于是情绪行、配置静默消失。这里统一剥掉。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// 先写临时文件再 rename，避免进程在写一半时被杀死留下坏 JSON。
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, body, 'utf8');
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// 显著性令牌：数字与 ascii 标识符（模型名、路径、版本号等）。
// 近重复合并前用它做守卫：两条记忆可能词面/余弦都"很像"，但数值不同就是不同事实。
// CJK 数字只在紧跟量词或时间单位时才算显著，避免"统一""一下"这类词造成误判。
export function salientTokens(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_.:+/-]*/g)) out.add(m[0]);
  for (const m of s.matchAll(/([零一二三四五六七八九十百千万亿两]+)(?=(点|时|刻|天|年|月|日|号|周|星期|个|条|项|次|人|分|秒|小时|块|元|%|％))/g)) {
    out.add(`cn:${m[1]}`);
  }
  return out;
}

export function salientDiffers(a, b) {
  const A = salientTokens(a);
  const B = salientTokens(b);
  if (A.size === 0 && B.size === 0) return false;
  if (A.size !== B.size) return true;
  for (const t of A) if (!B.has(t)) return true;
  return false;
}

const NEG_CUES = [
  '不', '没', '未', '别', '禁止', '取消', '改为', '改成', '不是', '不再', '无需', '不能', '不要',
  ' not ', "n't", 'no longer', 'instead', 'never', 'without',
];

export function hasNegationCue(text) {
  const s = ` ${String(text ?? '').toLowerCase()} `;
  return NEG_CUES.some((c) => s.includes(c));
}

// token 数估算：CJK 约 1 token / 1.5 字，其余约 1 token / 4 字符。
// 零依赖、不引 tokenizer——只用于人格卡片的预算告警，别拿它算钱。
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}
