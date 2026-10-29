// lib/scales.mjs — 数值特质的分级措辞（刻度化）。
//
// 为什么需要：把 `style.verbosity: 0.3` 直接塞进 system prompt，模型读到的是一个
// 没有单位的数字，等于噪声。刻度化把它变成一句可执行的话：`简洁：结论先行，理由至多一条`。
// 刻度表是数据（docs/persona-scales.json），改措辞不用改代码，也不用动模型。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'persona-scales.json');
let cache = { mtime: 0, scales: {}, priorities: {} };

export function scalesFile() {
  return FILE;
}

export function loadScales() {
  try {
    const stat = fs.statSync(FILE);
    if (stat.mtimeMs !== cache.mtime) {
      const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache = { mtime: stat.mtimeMs, scales: (doc && doc.scales) || {}, priorities: (doc && doc.trait_priorities) || {} };
    }
  } catch {
    cache = { mtime: 0, scales: {}, priorities: {} };
  }
  return cache.scales;
}

// 特质优先级：超预算时先丢优先级低的。显式 trait_priorities 优先，
// 其次看 scale 里的 priority，都没有就给默认 5。
export function priorityOf(trait, fallback = 5) {
  loadScales(); // 确保 cache.priorities 已加载
  const explicit = Number(cache.priorities[trait]);
  if (Number.isFinite(explicit)) return explicit;
  const fromScale = Number(cache.scales[trait] && cache.scales[trait].priority);
  if (Number.isFinite(fromScale)) return fromScale;
  return fallback;
}

// 返回该档位的措辞；没有刻度（或档位为空）时返回 null，调用方回退成原始数字。
export function scaleLine(trait, value) {
  const scale = loadScales()[trait];
  if (!scale || !Array.isArray(scale.levels) || scale.levels.length === 0) return null;
  const v = Math.min(1, Math.max(0, Number(value)));
  const idx = Math.min(scale.levels.length - 1, Math.floor(v * scale.levels.length));
  return scale.levels[idx] || null;
}
