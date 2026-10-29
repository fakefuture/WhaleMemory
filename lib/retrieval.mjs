// lib/retrieval.mjs — 两路检索、绝对门槛、排名融合、无答案判断。
//
// 关键约束：
//   - 分数为 0 的词面结果直接排除；
//   - 绝对门槛在归一化、强度、偏置加分之前执行；
//   - 词面 Jaccard 与余弦不是同一尺度：两路各自排名，用 RRF 融合，不做数值直接比较；
//   - 候选/历史/争议使用单独结果区，不混入默认 results；
//   - 无合格结果时 results=[] 且 no_match=true，给出 reason。

import { tokenize, jaccard, round, daysBetween } from './util.mjs';
import { eligibleForAnswer, visible, scopeAllowedForQuery, timeMatches } from './policy.mjs';
import { simPair, toComparable, thresholdsFor } from './sim.mjs';

export function isValidVector(vec, dim = null) {
  if (!Array.isArray(vec) || vec.length === 0) return false;
  if (dim && vec.length !== dim) return false;
  let norm = 0;
  for (const x of vec) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return false;
    norm += x * x;
  }
  return norm > 0;
}

export function cosineSafe(a, b) {
  if (!isValidVector(a) || !isValidVector(b) || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
}

function retrievalConfig(store) {
  const r = (store.config && store.config.retrieval) || {};
  const weights = { relevance: 0.55, strength: 0.25, recency: 0.12, utility: 0.08, ...(r.weights || {}) };
  return {
    lexicalMin: Number.isFinite(Number(r.lexical_min)) ? Number(r.lexical_min) : 0.12,
    denseMin: Number.isFinite(Number(r.dense_min)) ? Number(r.dense_min) : 0.55,
    rrfK: Number(r.rrf_k) > 0 ? Number(r.rrf_k) : 60,
    weights,
    mmrLambda: r.mmr_lambda ?? null,
    tentative: r.tentative !== false,
    legacyRecallConsolidation: r.legacy_recall_consolidation === true,
  };
}

function recencyOf(record, now, halfLifeDays) {
  const base = record.last_accessed || record.created_at;
  const age = Math.max(0, daysBetween(base, now));
  return Math.exp(-age / Math.max(1, halfLifeDays));
}

function utilityOf(record) {
  const u = Number((record.utility && record.utility.score) || 0);
  return (Math.max(-1, Math.min(1, u)) + 1) / 2;
}

function mmrOrder(rows, k, lambda, store) {
  if (!(lambda > 0 && lambda < 1) || k <= 0 || rows.length <= k) return rows;
  const chosen = [];
  const rest = [...rows];
  while (rest.length && chosen.length < k) {
    let best = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < rest.length; i += 1) {
      let maxSim = 0;
      for (const s of chosen) {
        const hit = simPair(
          toComparable(rest[i].record.content, rest[i].record._vec),
          toComparable(s.record.content, s.record._vec),
        );
        const floor = thresholdsFor(store, hit.kind).cluster;
        const v = floor > 0 && floor < 1 ? Math.max(0, (hit.value - floor) / (1 - floor)) : hit.value;
        if (v > maxSim) maxSim = v;
      }
      const val = lambda * rest[i].score - (1 - lambda) * maxSim;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    chosen.push(rest[best]);
    rest.splice(best, 1);
  }
  return [...chosen, ...rest];
}

/**
 * @param {object} store v2 文档
 * @param {string} text  查询
 * @param {object} opts
 *  ctx, queryVector, limit, scope, tier, at, allScopes, includeHistory, includeDormant,
 *  includeCandidates, lexicalOnly, explain
 */
export function retrieve(store, text, opts = {}) {
  const cfg = retrievalConfig(store);
  const ctx = opts.ctx;
  const q = String(text ?? '').trim();
  const limit = Math.max(1, Number(opts.limit) || Number(store.config.recall.limit) || 8);
  const now = ctx.now;
  const qTokens = tokenize(q);
  const qVec = isValidVector(opts.queryVector) ? opts.queryVector : null;
  const includeHistory = opts.includeHistory === true;
  const includeCandidates = opts.includeCandidates === true;
  const allScopes = opts.allScopes === true;
  const withDormant = opts.includeDormant === true;

  const diagnostics = {
    thresholds: { lexical: cfg.lexicalMin, dense: cfg.denseMin, tentative: cfg.tentative },
    lexical_channel: true,
    dense_channel: Boolean(qVec) && opts.lexicalOnly !== true,
    excluded: {},
  };
  const bump = (k) => { diagnostics.excluded[k] = (diagnostics.excluded[k] || 0) + 1; };

  if (!q) {
    return {
      query: '',
      results: [],
      no_match: true,
      reason: 'empty_query',
      disputed: [],
      history: [],
      candidates: [],
      warnings: cfg.tentative ? ['检索绝对门槛为暂定值，尚未用校准样例标定'] : [],
      diagnostics,
      hits: [],
    };
  }

  const pool = [...(store.records || [])];
  if (withDormant) pool.push(...(store.archive || []).filter((r) => r.state === 'dormant'));

  const scored = [];
  const disputed = [];
  const history = [];
  const candidates = [];

  for (const r of pool) {
    if (!scopeAllowedForQuery(r, ctx, { scope: opts.scope || null, allScopes })) { bump('scope'); continue; }
    if (opts.tier && r.tier !== opts.tier) { bump('tier'); continue; }
    if (r.state !== 'active' && r.state !== 'dormant') { bump('state'); continue; }
    if (r.state === 'dormant' && !withDormant) { bump('dormant'); continue; }

    const tm = timeMatches(r, opts.at);
    if (!tm.ok) { bump(tm.reason || 'time'); continue; }

    const lex = jaccard(qTokens, tokenize(r.content));
    let dense = null;
    if (diagnostics.dense_channel && isValidVector(r._vec, qVec.length)) {
      dense = cosineSafe(qVec, r._vec);
      if (dense !== null && !(dense > cfg.denseMin)) { dense = null; bump('dense_below_threshold'); }
    }
    const lexOk = lex > cfg.lexicalMin;
    if (!lexOk && dense === null) { bump('below_threshold'); continue; }

    const row = {
      record: r,
      lexical: lexOk ? lex : 0,
      dense,
      unknown_time: tm.unknown,
    };
    if (r.review_status === 'candidate') {
      if (includeCandidates) candidates.push(row);
      else bump('candidate');
      continue;
    }
    if (r.review_status === 'rejected') { bump('rejected'); continue; }
    if (r.validity === 'superseded') {
      if (includeHistory) history.push(row);
      else bump('superseded');
      continue;
    }
    if (r.validity === 'disputed') { disputed.push(row); continue; }
    if (r.review_status !== 'accepted' || r.validity !== 'current') { bump('not_eligible'); continue; }
    scored.push(row);
  }

  // 各自排名（RRF）。不做「词面分与余弦分直接相加」。
  const lexRanked = scored.filter((s) => s.lexical > 0).sort((a, b) => b.lexical - a.lexical);
  lexRanked.forEach((s, i) => { s.lexical_rank = i + 1; s.channels = ['lexical']; });
  const denseRanked = scored.filter((s) => s.dense !== null).sort((a, b) => b.dense - a.dense);
  denseRanked.forEach((s, i) => {
    s.dense_rank = i + 1;
    s.channels = s.channels ? [...s.channels, 'dense'] : ['dense'];
  });

  let maxFused = 0;
  for (const s of scored) {
    let fused = 0;
    if (s.lexical_rank) fused += 1 / (cfg.rrfK + s.lexical_rank);
    if (s.dense_rank) fused += 1 / (cfg.rrfK + s.dense_rank);
    s.fused = fused;
    if (fused > maxFused) maxFused = fused;
    s.match = s.dense_rank && s.lexical_rank ? 'hybrid' : (s.dense_rank ? 'dense' : 'lexical');
  }

  const w = cfg.weights;
  const halfLife = Number(store.config.recall.recency_half_life_days) || 14;
  for (const s of scored) {
    const relevance = maxFused > 0 ? s.fused / maxFused : 0;
    const recency = recencyOf(s.record, now, halfLife);
    const utility = utilityOf(s.record);
    s.components = {
      relevance: round(relevance, 6),
      strength: round(s.record.strength, 6),
      recency: round(recency, 6),
      utility: round(utility, 6),
    };
    s.score = relevance * w.relevance
      + s.record.strength * w.strength
      + recency * w.recency
      + utility * w.utility;
  }

  scored.sort((a, b) => (b.score - a.score) || (b.fused - a.fused) || (b.lexical - a.lexical));
  const lambda = opts.mmrLambda !== undefined ? opts.mmrLambda : cfg.mmrLambda;
  const ordered = mmrOrder(scored, limit, Number(lambda), store);
  const top = ordered.slice(0, limit);

  const describeRow = (s) => ({
    id: s.record.id,
    content: s.record.content,
    tier: s.record.tier,
    scope: s.record.scope,
    state: s.record.state,
    review_status: s.record.review_status,
    validity: s.record.validity,
    strength: round(s.record.strength),
    confidence: round(s.record.confidence),
    recall_count: s.record.recall_count,
    lexical_score: round(s.lexical, 4),
    dense_score: s.dense === null ? null : round(s.dense, 4),
    lexical_rank: s.lexical_rank || null,
    dense_rank: s.dense_rank || null,
    fused_score: round(s.fused, 6),
    score: round(s.score, 4),
    // 兼容字段：relevance 现在表示该条命中的原始通道分数（取较高的绝对分），不是组内相对分。
    relevance: round(Math.max(s.lexical, s.dense || 0), 4),
    match: s.match,
    channels: s.channels || [],
    components: s.components,
    time: s.record.time,
    time_unknown: s.unknown_time,
    needs_synthesis: s.record.needs_synthesis,
    evidence_count: (s.record.evidence_ids || []).length,
    explanation: {
      why: `lexical=${round(s.lexical)} (rank ${s.lexical_rank || '-'}), dense=${s.dense === null ? '-' : round(s.dense)} (rank ${s.dense_rank || '-'})`,
      thresholds: { lexical: cfg.lexicalMin, dense: cfg.denseMin },
      fused: round(s.fused, 6),
      business: s.components,
    },
  });

  const results = top.map(describeRow);
  const maxLex = scored.reduce((m, s) => Math.max(m, s.lexical), 0);
  const maxDense = scored.reduce((m, s) => Math.max(m, s.dense || 0), 0);

  let reason = null;
  if (!results.length) {
    if (disputed.length && !scored.length) reason = 'only_disputed';
    else if (candidates.length && !scored.length) reason = 'only_candidates';
    else if (history.length && !scored.length) reason = 'only_superseded';
    else reason = 'no_result_above_threshold';
  }

  return {
    query: q,
    results,
    no_match: results.length === 0,
    reason,
    disputed: disputed.map((s) => ({
      id: s.record.id,
      content: s.record.content,
      tier: s.record.tier,
      scope: s.record.scope,
      validity: s.record.validity,
      lexical_score: round(s.lexical, 4),
      dense_score: s.dense === null ? null : round(s.dense, 4),
      conflicts: (store.conflicts || [])
        .filter((c) => c.a === s.record.id || c.b === s.record.id)
        .map((c) => ({ id: c.id, a: c.a, b: c.b, reason: c.reason, status: c.status, resolution: c.resolution || null })),
      note: '争议记录不作为单一结论返回；请查看双方证据或先 resolve',
    })),
    history: includeHistory ? history.map(describeRow) : [],
    candidates: includeCandidates ? candidates.map(describeRow) : [],
    warnings: cfg.tentative ? ['检索绝对门槛为暂定值，尚未用校准样例标定'] : [],
    diagnostics: {
      ...diagnostics,
      max_lexical: round(maxLex, 4),
      max_dense: round(maxDense, 4),
      pool: pool.length,
      scored: scored.length,
    },
    hits: results.map((r) => r.id),
  };
}

export { retrievalConfig };
