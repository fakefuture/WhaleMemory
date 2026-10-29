// lib/sim.mjs — 相似度：优先用嵌入向量的余弦，缺向量时退回词面 Jaccard。
// 两套尺度的阈值不可混用，所以这里同时给出 thresholdsFor()，由调用方按实际用的尺度取阈值。

import { jaccard, tokenize, clamp, round } from './util.mjs';

export const SIM_LEXICAL = 'lexical';
export const SIM_EMBEDDING = 'embedding';

const FALLBACK_THRESHOLDS = {
  merge: 0.9, conflict: 0.3, cluster: 0.55, cover: 0.7, prune: 0.85,
};

const CONTRA_FLOOR = { lexical: 0.15, embedding: 0.45 };

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 把「文本 + 可选向量」包成可比较对象，避免在热循环里重复分词。
export function toComparable(text, vector) {
  const vec = Array.isArray(vector) && vector.length > 0 ? vector : null;
  return { text: String(text ?? ''), tokens: tokenize(text), vector: vec };
}

// 返回 { value, kind }。kind 决定调用方该用哪套阈值。
export function simPair(x, y) {
  if (x.vector && y.vector && x.vector.length === y.vector.length) {
    const c = cosine(x.vector, y.vector);
    if (c !== null) return { value: round(clamp(c, 0, 1)), kind: SIM_EMBEDDING };
  }
  return { value: round(jaccard(x.tokens, y.tokens)), kind: SIM_LEXICAL };
}

export function thresholdsFor(store, kind) {
  const table = (store.config && store.config.sim) || {};
  const profile = table[kind] || {};
  return { ...FALLBACK_THRESHOLDS, ...profile };
}

export function contraFloorFor(kind) {
  return CONTRA_FLOOR[kind] ?? CONTRA_FLOOR.lexical;
}
