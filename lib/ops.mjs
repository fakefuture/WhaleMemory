// lib/ops.mjs — 五类记忆操作的实现。
// 设计原则：
//   1) 存储只做账本与算术，不做“自动总结”。需要措辞的地方标记 needs_synthesis，由主模型用 merge 提供文本。
//   2) 任何冲突都不覆写，只新增冲突记录并降旧版本置信度。
//   3) 所有操作纯本地、纯函数式地修改传进来的 store 文档，不触网、不写模型权重。

import {
  newId, nowIso, clamp, round, daysBetween, cosineAlpha, unique, mean, salientDiffers, estimateTokens,
} from './util.mjs';
import { toComparable, simPair, thresholdsFor, contraFloorFor } from './sim.mjs';
import { scaleLine, priorityOf } from './scales.mjs';
import { emotionLine, dampingLine } from './emotion.mjs';

export const TIER_DEFAULTS = {
  semantic: { strength: 0.85, decay_rate: 0.008, confidence: 0.8 },
  episodic: { strength: 0.6, decay_rate: 0.05, confidence: 0.6 },
  working: { strength: 0.4, decay_rate: 0.15, confidence: 0.5 },
};

export const SCOPES = ['global', 'workspace', 'session'];

// 记忆域：只有 preference / personal 允许被人格与情绪偏置影响；
// factual / security 永久屏蔽染色（安全关键与事实记忆不能因为"性格像"或"心情对"被抬上来）。
export const DOMAINS = ['factual', 'security', 'preference', 'personal'];
export const COLORABLE_DOMAINS = ['preference', 'personal'];

const NEG_CUES = [
  '不', '没', '别', '取消', '改为', '改成', '不是', '错了', '不再', '其实',
  ' not ', "n't", 'no longer', 'instead', 'actually', 'wrong',
];

function hasNegCue(text) {
  const s = ` ${String(text ?? '').toLowerCase()} `;
  return NEG_CUES.some((c) => s.includes(c));
}

export function makeRecord(input) {
  const tier = TIER_DEFAULTS[input.tier] ? input.tier : 'episodic';
  const d = TIER_DEFAULTS[tier];
  const ts = nowIso();
  return {
    id: input.id || newId('mem'),
    content: String(input.content ?? '').trim(),
    tier,
    scope: SCOPES.includes(input.scope) ? input.scope : 'workspace',
    strength: round(clamp(input.strength ?? d.strength, 0, 1)),
    decay_rate: round(clamp(input.decay_rate ?? d.decay_rate, 0.0001, 1)),
    recall_count: input.recall_count ?? 0,
    confidence: round(clamp(input.confidence ?? d.confidence, 0, 1)),
    last_accessed: input.last_accessed || ts,
    last_decay_at: input.last_decay_at || ts,
    created_at: input.created_at || ts,
    state: input.state || 'active',
    protected: Boolean(input.protected),
    utility: { hits: 0, misses: 0, score: 0, last_note: null, ...(input.utility || {}) },
    tags: unique(input.tags || []),
    supersedes: unique(input.supersedes || []),
    conflicts_with: unique(input.conflicts_with || []),
    merged_from: unique(input.merged_from || []),
    variants: Array.isArray(input.variants) ? input.variants : [],
    source: input.source || 'user',
    needs_synthesis: Boolean(input.needs_synthesis),
    // 记忆染色（事实性标注，不是推断）：
    //   domain 决定这条记忆是否允许被人格/情绪偏置影响（默认 factual = 永久不染色）；
    //   affect_at_write 记录"写这条时的会话情绪"，供日后做心境一致检索；
    //   persona_fp 记录写这条时的卡版本指纹，用来识别"旧身份写的记忆"。
    // 这两个字段只被 query 的偏置分量读取，不参与任何自动注入。
    domain: DOMAINS.includes(input.domain) ? input.domain : 'factual',
    affect_at_write: input.affect_at_write || null,
    persona_fp: input.persona_fp || null,
    meta: { session: input.session ?? null, ...(input.meta || {}) },
    // 瞬态：来自 memory/embeddings.json，永不落盘到主库（saveStore 会剥掉）。
    _vec: Array.isArray(input.embedding) && input.embedding.length ? input.embedding : null,
  };
}

export function findRecord(store, id) {
  return store.records.find((r) => r.id === id) || store.archive.find((r) => r.id === id) || null;
}

function removeById(arr, id) {
  const i = arr.findIndex((r) => r.id === id);
  if (i >= 0) arr.splice(i, 1);
}

export function toArchive(store, rec) {
  removeById(store.records, rec.id);
  if (!store.archive.some((r) => r.id === rec.id)) store.archive.push(rec);
}

export function revive(store, rec) {
  removeById(store.archive, rec.id);
  rec.state = 'active';
  rec.strength = round(Math.max(rec.strength, 0.2));
  rec.revived_at = nowIso();
  rec.archived_at = null;
  rec.last_accessed = nowIso();
  rec.recall_count += 1;
  if (!store.records.some((r) => r.id === rec.id)) store.records.push(rec);
}

export function audit(store, op, payload = {}) {
  store.log.push({ at: nowIso(), op, ...payload });
  if (store.log.length > 500) store.log = store.log.slice(-500);
}

function openConflict(store, aId, bId, reason, suspect = false) {
  const status = suspect ? 'suspect' : 'open';
  const existing = store.conflicts.find(
    (c) => c.status === status && ((c.a === aId && c.b === bId) || (c.a === bId && c.b === aId)),
  );
  if (existing) return existing;
  const c = {
    id: newId('cfl'),
    a: aId,
    b: bId,
    reason,
    status,
    created_at: nowIso(),
    resolved_at: null,
    resolution: null,
    note: null,
  };
  store.conflicts.push(c);
  return c;
}

// ---------------------------------------------------------------- 巩固：准入 + 写入

export function addMemory(store, input = {}) {
  const cfg = store.config;
  const content = String(input.content ?? '').trim();
  if (content.length < cfg.admission.min_content_length) {
    return { status: 'rejected', reason: `content 过短（< ${cfg.admission.min_content_length} 字符）` };
  }
  if (content.length > 4000) {
    return { status: 'rejected', reason: 'content 过长（> 4000 字符），请先切分' };
  }
  let tier = TIER_DEFAULTS[input.tier] ? input.tier : 'episodic';
  const tags = unique(input.tags || []);
  const cand = toComparable(content, input.embedding);
  // 提前声明：近重复分支要判断"是不是显式纠错"，那一步在冲突检测之前。
  const supersedes = unique(input.supersedes || []);

  // 1. 完全重复：只记一次命中，不新增。
  for (const r of store.records) {
    if (r.state !== 'active') continue;
    if (r.content.toLowerCase() === content.toLowerCase()) {
      r.recall_count += 1;
      r.last_accessed = nowIso();
      audit(store, 'add.duplicate', { id: r.id });
      return { status: 'duplicate', id: r.id, tier: r.tier };
    }
  }

  // 2. 近重复：合并元数据，原文进 variants，不丢信息。
  //    显式纠正（--supersedes）跳过这一步：纠错必须走冲突分支，不能被"像"吞掉。
  let near = null;
  let nearSim = 0;
  let nearKind = 'lexical';
  // 超过 merge 阈值、但显著性令牌不同 → 不是重复，是另一条事实（交给干扰检测留痕）。
  let mergeBlocked = null;
  if (supersedes.length === 0) {
    for (const r of store.records) {
      if (r.state !== 'active') continue;
      const s = simPair(cand, toComparable(r.content, r._vec));
      if (s.value > nearSim) { nearSim = s.value; nearKind = s.kind; near = r; }
    }
  }
  if (near && nearSim >= thresholdsFor(store, nearKind).merge) {
    // 守卫：数值/标识符不同就不是"重复"，而是另一条事实。
    // 否则"凌晨三点"与"凌晨两点"会被静默合并，用户的数值纠错只剩 variants 里一个影子，
    // 而 variants 不参与检索。
    if (salientDiffers(near.content, content)) {
      mergeBlocked = near;
    } else {
      near.tags = unique([...near.tags, ...tags]);
      near.confidence = round(Math.max(near.confidence, input.confidence ?? TIER_DEFAULTS[tier].confidence));
      near.strength = round(clamp(near.strength + 0.05, 0, 1));
      near.recall_count += 1;
      near.last_accessed = nowIso();
      if (cand.vector && !near._vec) near._vec = cand.vector;
      if (!near.variants.includes(content)) near.variants.push(content);
      audit(store, 'add.merged', { id: near.id, similarity: round(nearSim) });
      return { status: 'merged', id: near.id, similarity: round(nearSim) };
    }
  }

  // 3. 干扰检测：候选旧记忆、标记冲突、降旧版本置信度。绝不覆写。
  const lowered = [];
  const conflicts = [];
  const cueNew = hasNegCue(content);
  for (const r of store.records) {
    if (r.state !== 'active') continue;
    const s = simPair(cand, toComparable(r.content, r._vec));
    const forced = supersedes.includes(r.id);
    const cueMismatch = cueNew !== hasNegCue(r.content);
    const weakForced = input.contra === true && s.value >= contraFloorFor(s.kind);
    // 被合并守卫拦下的那一条，无论有没有否定词都要留痕：数值不同本身就是矛盾候选。
    const valueMismatch = Boolean(mergeBlocked) && mergeBlocked.id === r.id;
    const declared = forced || weakForced;
    const heuristic = valueMismatch || (s.value >= thresholdsFor(store, s.kind).conflict && cueMismatch);
    if (!declared && !heuristic) continue;

    const reason = forced ? 'explicit_correction'
      : (weakForced ? 'declared_contra' : (valueMismatch ? 'value_mismatch' : 'negation_mismatch'));
    // 只有调用方声明的冲突才动机器：启发式证据经实测不足以区分"矛盾"与"互补细节"，
    // 所以只记为 suspect，供人/模型裁决，绝不擅自给旧记忆降权。
    const c = openConflict(store, r.id, null, reason, !declared);
    r.conflicts_with = unique([...r.conflicts_with, c.id]);
    if (declared) {
      if (forced) {
        r.strength = round(clamp(r.strength * 0.5, 0, 1));
        r.decay_rate = round(clamp(r.decay_rate * 2, 0.0001, 1));
        r.confidence = round(clamp(r.confidence * 0.5, 0, 1));
        // 被显式纠正的旧记忆在排序中降档：纠错是语义信号，不该靠强度去和相关性强抢。
        r.demoted = true;
      } else {
        r.confidence = round(clamp(r.confidence * 0.8, 0, 1));
      }
      lowered.push({ id: r.id, confidence: r.confidence, strength: r.strength });
    }
    conflicts.push(c);
  }

  // 4. 纠正继承旧条目的 scope / tier。
  // 否则纠错会落到另一个作用域，按 scope 过滤的检索仍然只命中被降权的旧事实。
  let scope = input.scope;
  if (supersedes.length) {
    const old = findRecord(store, supersedes[0]);
    if (old) {
      if (!scope) scope = old.scope;
      if (!TIER_DEFAULTS[input.tier] && old.tier !== 'working') tier = old.tier;
    }
  }

  // 5. 落盘新记录。
  const rec = makeRecord({
    content,
    tier,
    scope,
    embedding: input.embedding,
    confidence: supersedes.length ? Math.max(input.confidence ?? 0, 0.95) : input.confidence,
    strength: supersedes.length ? 0.9 : undefined,
    decay_rate: supersedes.length ? 0.005 : undefined,
    tags: supersedes.length ? unique([...tags, 'correction']) : tags,
    source: input.source || 'user',
    supersedes,
    session: input.session,
    protected: input.protected,
    domain: input.domain,
    affect_at_write: input.affect_at_write,
    persona_fp: input.persona_fp,
  });
  for (const c of conflicts) { c.b = rec.id; rec.conflicts_with.push(c.id); }
  store.records.push(rec);
  audit(store, 'add', { id: rec.id, tier: rec.tier, conflicts: conflicts.length });

  return {
    status: 'added',
    id: rec.id,
    tier: rec.tier,
    scope: rec.scope,
    conflicts: conflicts.map((c) => ({ id: c.id, with: c.a, reason: c.reason })),
    lowered,
  };
}

// ---------------------------------------------------------------- 回忆加权

function isPersonaRecord(r) {
  return r.tags.includes('persona') || r.meta.is_persona === true;
}

// 给已有记录补域标签（只改元数据，不动内容与权重）。
// 用途：染色白名单需要准确的域；历史记录默认 factual，人工确认后再标。
export function setDomain(store, id, domain) {
  const rec = findRecord(store, id);
  if (!rec) return { status: 'not_found', id };
  if (!DOMAINS.includes(domain)) {
    return { status: 'rejected', reason: `domain 必须是 ${DOMAINS.join(' | ')}` };
  }
  const before = rec.domain || 'factual';
  rec.domain = domain;
  audit(store, 'record.domain', { id, before, after: domain });
  return { status: 'ok', id, before, after: domain };
}

export function salience(r, now = nowIso()) {
  const age = Math.max(0, daysBetween(r.last_accessed || r.created_at, now));
  return r.strength * Math.exp(-age / 30);
}

// 心境一致性：写这条时的情绪 vs 此刻情绪。
// 同情绪 1.0；同极性（正/负）0.5；跨极性 0（此刻低落不该把"当时愉悦"的记忆抬上来）。
export function moodCongruence(mood, atWrite) {
  if (!mood || !mood.emotion || !atWrite || !atWrite.emotion) return 0;
  if (mood.emotion === atWrite.emotion) return 1;
  const neg = new Set(['紧绷', '不满', '低落']);
  const a = neg.has(mood.emotion);
  const b = neg.has(atWrite.emotion);
  return a === b ? 0.5 : 0;
}

export function touchOnRecall(store, r) {
  const cfg = store.config.recall;
  r.recall_count += 1;
  r.last_accessed = nowIso();
  r.decay_rate = round(Math.max(cfg.lambda_floor, r.decay_rate * (1 - cfg.lambda_recall_damp)));
}

// 贪心 MMR：每步在剩余候选里挑 argmax(λ·score − (1−λ)·max_sim(已选))。
// 相似度先按 "cluster 阈值" 归一化：低于聚类的相似度（例如 bge-m3 给无关文本的
// 0.40–0.50）算作 0 冗余，否则不同主题的记忆会被当成重复而互相惩罚。
// 只重排前 limit 名，避免 O(N²)；被纠正的条目仍然整体排在最后（分组各自选）。
function mmrOrder(sorted, k, lambda, floorOf) {
  if (k <= 0 || k >= sorted.length) return sorted;
  const chosen = [];
  const penalty = (a, b) => {
    const s = simPair(toComparable(a.r.content, a.r._vec), toComparable(b.r.content, b.r._vec));
    const floor = floorOf(s.kind);
    if (!(floor > 0) || floor >= 1) return s.value;
    return Math.max(0, (s.value - floor) / (1 - floor));
  };
  const take = (group) => {
    const rest = [...group];
    while (rest.length && chosen.length < k) {
      let bi = 0;
      let bestVal = -Infinity;
      for (let i = 0; i < rest.length; i += 1) {
        const c = rest[i];
        let maxSim = 0;
        for (const s of chosen) {
          const v = penalty(c, s);
          if (v > maxSim) maxSim = v;
        }
        const val = lambda * c.score - (1 - lambda) * maxSim;
        if (val > bestVal) { bestVal = val; bi = i; }
      }
      chosen.push(rest[bi]);
      rest.splice(bi, 1);
    }
  };
  take(sorted.filter((s) => !s.r.demoted));
  if (chosen.length < k) take(sorted.filter((s) => s.r.demoted));
  const picked = new Set(chosen);
  return [...chosen, ...sorted.filter((s) => !picked.has(s))];
}

export function queryMemory(store, text, opts = {}) {
  const cfg = store.config.recall;
  const qc = toComparable(text, opts.embedding);
  const limit = Math.max(1, Number(opts.limit ?? cfg.limit) || cfg.limit);
  const pool = store.records.filter((r) => r.state === 'active');
  if (opts.withDormant) pool.push(...store.archive.filter((r) => r.state === 'dormant'));

  const scored = [];
  for (const r of pool) {
    if (opts.scope && r.scope !== opts.scope && r.scope !== 'global') continue;
    if (opts.tier && r.tier !== opts.tier) continue;
    const s = simPair(qc, toComparable(r.content, r._vec));
    const rel = s.value;
    const age = Math.max(0, daysBetween(r.last_accessed || r.created_at, nowIso()));
    const recency = Math.exp(-age / cfg.recency_half_life_days);
    const util = (clamp(r.utility.score, -1, 1) + 1) / 2;
    scored.push({ r, rel, kind: s.kind, recency, util });
  }

  // 相关性归一化：语义层初值 0.85、情节层 0.60，若不归一化，这个固定差会盖过相关性差异，
  // 把"更相关但层级较低"的记忆压到后面。组内差距太小时（全是同一主题的近似分）不放大噪声。
  let relMin = Infinity;
  let relMax = -Infinity;
  for (const s of scored) {
    if (s.rel < relMin) relMin = s.rel;
    if (s.rel > relMax) relMax = s.rel;
  }
  const spread = scored.length > 0 ? relMax - relMin : 0;
  const normalize = cfg.relevance_normalize !== false
    && scored.length > 1
    && spread >= (cfg.min_relevance_spread ?? 0.05);
  for (const s of scored) {
    s.relUsed = normalize ? (s.rel - relMin) / spread : s.rel;
    s.base = cfg.w_relevance * s.relUsed
      + cfg.w_strength * s.r.strength
      + cfg.w_recency * s.recency
      + cfg.w_utility * s.util;
  }

  // 人格权重：同等相关性下加成，但加成后不得越过“事实性记忆的最优分 + cap”。
  let bestFactualBase = 0;
  let bestFactualRel = 0;
  for (const s of scored) {
    if (isPersonaRecord(s.r)) continue;
    if (s.base > bestFactualBase) bestFactualBase = s.base;
    if (s.rel > bestFactualRel) bestFactualRel = s.rel;
  }
  const capCeiling = bestFactualBase * (1 + cfg.persona_cap);
  for (const s of scored) {
    if (!isPersonaRecord(s.r)) { s.score = s.base; continue; }
    const comparable = s.rel >= bestFactualRel - cfg.persona_relevance_tolerance;
    const boosted = comparable ? s.base * (1 + cfg.persona_boost) : s.base;
    s.score = bestFactualBase > 0 ? Math.min(boosted, capCeiling) : boosted;
  }

  // 记忆染色偏置：默认按 config.color 的小权重生效（不是 0），可显式关掉。
  // 三条硬规则：事实/安全域永不染色；情绪不明确时不染色；人格抑制生效时强制归零。
  const bias = opts.bias || null;
  for (const s of scored) {
    s.base_relevance = round(s.score);
    s.persona_bias = 0;
    s.affect_bias = 0;
    s.bias_note = null;
    if (bias && bias.suppress) {
      s.bias_note = 'persona_conflict';
      s.final_score = s.base_relevance;
      continue;
    }
    const dom = s.r.domain || 'factual';
    const colorable = COLORABLE_DOMAINS.includes(dom);

    if (bias && Number(bias.affect_alpha) > 0 && bias.mood && bias.mood.emotion) {
      if (!colorable) {
        s.bias_note = 'domain_blocked';
      } else {
        const cong = moodCongruence(bias.mood, s.r.affect_at_write);
        if (cong > 0) {
          s.affect_bias = round(Number(bias.affect_alpha) * cong);
          s.bias_note = 'affect';
        } else {
          s.bias_note = 'no_congruence';
        }
      }
    }
    // 人格一致性是双向的：同一版人格写的 +α（"自己当前的承诺"），
    // 旧版人格写的 −α（旧身份的东西先让位）；没有指纹（老记录）保持中性。
    if (bias && Number(bias.persona_alpha) > 0 && bias.persona_fp && s.r.persona_fp && colorable) {
      const same = s.r.persona_fp === bias.persona_fp;
      s.persona_bias = round(same ? Number(bias.persona_alpha) : -Number(bias.persona_alpha));
      const tag = same ? 'persona_same' : 'stale_persona';
      s.bias_note = s.bias_note ? `${s.bias_note}+${tag}` : tag;
    }
    s.final_score = round(clamp(s.base_relevance + s.affect_bias + s.persona_bias, 0, 1));
  }

  // 被显式纠正的旧记忆排在所有未被纠正的记忆之后（仍然返回，保留可追溯性），
  // 而不是靠一个凑出来的惩罚系数去和相关性抢分。
  const byScore = [...scored].sort((x, y) => (Number(Boolean(x.r.demoted)) - Number(Boolean(y.r.demoted)))
    || ((y.final_score ?? y.score) - (x.final_score ?? x.score))
    || (y.rel - x.rel));

  // MMR 多样性重排：同一条事实的近重复条目会互相顶替，把不同信息挤出 top-k。
  // 纯相对分排序解决不了——它们的 score 常常并列第一——所以选下一条时要扣掉
  // 与已选条目的相似度。λ 越小越强调多样性；null / 0 / 1 关闭。
  const mmrLambda = Number(cfg.mmr_lambda);
  const useMmr = Number.isFinite(mmrLambda) && mmrLambda > 0 && mmrLambda < 1;
  const ordered = useMmr ? mmrOrder(byScore, limit, mmrLambda, (kind) => thresholdsFor(store, kind).cluster) : byScore;

  // 绝对相关度：score 是组内归一化后的相对分，噪声也会被顶到高分；
  // 判断“到底有没有命中”必须看这个绝对值，接口里单独暴露。
  const maxRelevance = scored.length ? Math.max(...scored.map((s) => s.rel)) : 0;
  const top = ordered.slice(0, limit);
  const topKind = top.length ? top[0].kind : null;

  const revived = [];
  if (opts.touch !== false) {
    for (const s of top) {
      // revive 内部已计一次召回，不要再 touch，否则唤醒被记成两次。
      if (s.r.state === 'dormant') { revive(store, s.r); revived.push(s.r.id); }
      else touchOnRecall(store, s.r);
    }
  }

  return {
    query: String(text ?? ''),
    revived,
    max_relevance: round(maxRelevance),
    max_relevance_kind: topKind,
    results: top.map((s) => ({
      id: s.r.id,
      content: s.r.content,
      tier: s.r.tier,
      scope: s.r.scope,
      state: s.r.state,
      strength: s.r.strength,
      confidence: s.r.confidence,
      recall_count: s.r.recall_count,
      relevance: round(s.rel),
      relevance_used: round(s.relUsed),
      recency: round(s.recency),
      utility: round(s.util),
      score: round(s.score),
      // 染色分量：分开返回才能审计"为什么被召回"（相关？人格？情绪？）。
      domain: s.r.domain || 'factual',
      base_relevance: s.base_relevance,
      affect_bias: s.affect_bias,
      persona_bias: s.persona_bias,
      final_score: s.final_score,
      bias_note: s.bias_note,
      affect_at_write: s.r.affect_at_write || null,
      match: s.kind,
      demoted: Boolean(s.r.demoted),
      persona: isPersonaRecord(s.r),
      needs_synthesis: s.r.needs_synthesis,
    })),
  };
}

// ---------------------------------------------------------------- 效用反馈

export function feedback(store, id, verdict, note = null) {
  const r = findRecord(store, id);
  if (!r) return { status: 'not_found', id };
  const good = verdict === 'good';
  const sign = good ? 1 : -1;
  if (good) r.utility.hits += 1; else r.utility.misses += 1;
  r.utility.score = round(clamp(r.utility.score + 0.3 * (sign - r.utility.score), -1, 1));
  r.utility.last_note = note;
  if (good) {
    r.strength = round(clamp(r.strength + 0.06, 0, 1));
    r.decay_rate = round(Math.max(store.config.recall.lambda_floor, r.decay_rate * 0.85));
  } else {
    r.strength = round(clamp(r.strength - 0.1, 0, 1));
    r.decay_rate = round(clamp(r.decay_rate * 1.2, 0.0001, 1));
  }
  if (r.state === 'dormant' && good) revive(store, r);
  audit(store, 'feedback', { id, verdict, score: r.utility.score });
  return {
    status: 'ok', id, verdict,
    strength: r.strength, decay_rate: r.decay_rate, utility: r.utility.score, state: r.state,
  };
}

// ---------------------------------------------------------------- 衰减调度

export function decayStore(store, opts = {}) {
  const cfg = store.config.decay;
  const topK = Math.max(0, Number(opts.topK ?? cfg.top_k));
  const now = nowIso();

  // 0. 工作层：会话结束先沉降/丢弃，不受 Top K 保护影响。
  //    被检索过或有正向效用的 → 沉降为情节层；从没被用到 → 丢弃（归档，不物理删除）。
  const settled = [];
  const discarded = [];
  if (cfg.working_settle !== false) {
    for (const r of [...store.records]) {
      if (r.state !== 'active' || r.tier !== 'working') continue;
      const useful = r.recall_count > 0 || r.utility.hits > 0;
      if (useful) {
        r.tier = 'episodic';
        r.strength = round(clamp(r.strength + 0.15, 0, 1));
        r.decay_rate = round(Math.max(r.decay_rate, TIER_DEFAULTS.episodic.decay_rate));
        r.tags = unique([...r.tags, 'settled']);
        r.settled_at = now;
        settled.push(r.id);
      } else {
        r.state = 'pruned';
        r.pruned_at = now;
        r.prune_reason = 'discarded_working';
        discarded.push(r.id);
        toArchive(store, r);
      }
    }
  }

  const actives = store.records.filter((r) => r.state === 'active');
  const ranked = [...actives].sort((a, b) => salience(b, now) - salience(a, now));
  const protect = new Set(ranked.slice(0, topK).map((r) => r.id));
  for (const r of actives) if (r.protected) protect.add(r.id);

  const decayed = [];
  const archived = [];
  const protectedIds = [];
  for (const r of actives) {
    const dt = Math.max(0, daysBetween(r.last_decay_at || r.created_at, now));
    if (protect.has(r.id)) {
      r.last_decay_at = now;
      protectedIds.push(r.id);
      continue;
    }
    if (dt <= 0) continue;
    const util = clamp(r.utility.score, -1, 1);
    const lambdaEff = r.decay_rate
      * (1 + cfg.negative_utility_boost * Math.max(0, -util))
      * clamp(1 - cfg.positive_utility_damp * Math.max(0, util), 0.15, 1);
    const before = r.strength;
    r.strength = round(clamp(before * Math.exp(-lambdaEff * dt), 0, 1));
    // 强度下限：衰减可以，但不归零。设成 ≥ τ_archive 时归档不再发生
    // （强度永远够不到 τ），记忆只会变弱、排得靠后，不会离开活跃区。
    const floor = Number(cfg.strength_floor);
    if (Number.isFinite(floor) && floor > 0 && r.strength < floor) r.strength = round(floor);
    r.last_decay_at = now;
    if (r.strength < cfg.tau_archive) {
      r.state = 'dormant';
      r.archived_at = now;
      archived.push({ id: r.id, before, after: r.strength, tier: r.tier });
    } else {
      decayed.push({ id: r.id, before, after: r.strength });
    }
  }

  for (const r of [...store.records]) if (r.state === 'dormant') toArchive(store, r);

  // 会话计数只由 session-end 负责：单跑 decay 是一次维护操作，不是一次会话收尾。
  if (opts.countSession === true) {
    store.sessions.last_end = now;
    store.sessions.count += 1;
  }
  audit(store, 'decay', { decayed: decayed.length, archived: archived.length, protected: protectedIds.length, settled: settled.length, discarded: discarded.length });
  return {
    decayed, archived, protected: protectedIds, topK, tau_archive: cfg.tau_archive, settled, discarded,
  };
}

// ---------------------------------------------------------------- 睡眠时重组：巩固 + 修剪

function clusterBy(store, recs) {
  const clusters = [];
  const used = new Set();
  for (const r of recs) {
    if (used.has(r.id)) continue;
    const cl = [r];
    used.add(r.id);
    for (const o of recs) {
      if (used.has(o.id)) continue;
      const takes = cl.some((m) => {
        const s = simPair(toComparable(m.content, m._vec), toComparable(o.content, o._vec));
        return s.value >= thresholdsFor(store, s.kind).cluster;
      });
      if (takes) {
        cl.push(o);
        used.add(o.id);
      }
    }
    clusters.push(cl);
  }
  return clusters;
}

// 找最相近的语义条目，并把「是否越过该尺度的阈值」一并算好交给调用方。
function bestSemanticCover(store, comparable, thresholdKey) {
  let best = null;
  let bestSim = 0;
  let bestKind = 'lexical';
  for (const s of store.records) {
    if (s.state !== 'active' || s.tier !== 'semantic') continue;
    const hit = simPair(comparable, toComparable(s.content, s._vec));
    if (hit.value > bestSim) { bestSim = hit.value; bestKind = hit.kind; best = s; }
  }
  if (!best) return null;
  return {
    semantic: best,
    similarity: bestSim,
    kind: bestKind,
    ok: bestSim >= thresholdsFor(store, bestKind)[thresholdKey],
  };
}

export function consolidate(store, opts = {}) {
  const cfg = store.config.consolidation;
  const dry = Boolean(opts.dryRun);
  const cands = store.records.filter((r) => r.state === 'active'
    && r.tier === 'episodic'
    && (r.recall_count >= cfg.min_recall_count || r.utility.hits >= cfg.min_utility_hits));

  const clusters = clusterBy(store, cands);
  const promoted = [];
  const absorbed = [];

  for (const cl of clusters) {
    let cover = null;
    let coverSim = 0;
    for (const m of cl) {
      const hit = bestSemanticCover(store, toComparable(m.content, m._vec), 'cover');
      if (hit && hit.ok && hit.similarity > coverSim) { coverSim = hit.similarity; cover = hit.semantic; }
    }
    if (cover) {
      if (!dry) {
        cover.confidence = round(Math.max(cover.confidence, mean(cl.map((m) => m.confidence))));
        cover.recall_count += cl.reduce((n, m) => n + m.recall_count, 0);
        cover.utility.hits += cl.reduce((n, m) => n + m.utility.hits, 0);
        cover.utility.score = round(clamp(cover.utility.score
          + 0.2 * (mean(cl.map((m) => m.utility.score)) - cover.utility.score), -1, 1));
        cover.strength = round(clamp(cover.strength + 0.03, 0, 1));
        cover.tags = unique([...cover.tags, ...cl.flatMap((m) => m.tags)]);
        cover.meta.absorbed_from = unique([...(cover.meta.absorbed_from || []), ...cl.map((m) => m.id)]);
        for (const m of cl) {
          m.state = 'pruned';
          m.pruned_at = nowIso();
          m.superseded_by = cover.id;
          audit(store, 'consolidate.absorb', { id: m.id, into: cover.id });
        }
        for (const m of cl) toArchive(store, m);
        absorbed.push({ semantic: cover.id, episodes: cl.map((m) => m.id), similarity: round(coverSim) });
      } else {
        absorbed.push({ semantic: cover.id, episodes: cl.map((m) => m.id), similarity: round(coverSim), dry: true });
      }
      continue;
    }

    // 没有语义记忆覆盖：造一条候选，但内容仍是原文 —— 措辞由主模型用 merge 提供。
    const best = [...cl].sort((a, b) => (b.confidence - a.confidence) || (b.strength - a.strength))[0];
    if (dry) {
      promoted.push({ content: best.content, from: cl.map((m) => m.id), dry: true });
      continue;
    }
    const rec = makeRecord({
      content: best.content,
      tier: 'semantic',
      scope: best.scope,
      embedding: best._vec,
      confidence: round(clamp(mean(cl.map((m) => m.confidence)), 0, 0.9)),
      strength: round(clamp(mean(cl.map((m) => m.strength)), 0, 1)),
      tags: unique(cl.flatMap((m) => m.tags)),
      source: 'consolidation',
      session: best.meta.session,
      merged_from: cl.map((m) => m.id),
      needs_synthesis: true,
    });
    rec.meta.pending_ids = cl.map((m) => m.id);
    store.records.push(rec);
    for (const m of cl) m.consolidation_target = rec.id;
    promoted.push({ id: rec.id, from: cl.map((m) => m.id), needs_synthesis: true });
    audit(store, 'consolidate.promote', { id: rec.id, from: rec.merged_from.length });
  }

  return { dry, promoted, absorbed };
}

// 主模型提供措辞：把若干条目合成一条语义记忆，源条目归档但保留追溯。
export function mergeInto(store, ids, content, opts = {}) {
  const src = unique(ids).map((id) => findRecord(store, id)).filter(Boolean);
  if (!src.length) return { status: 'not_found', ids };
  const text = String(content ?? '').trim();
  if (!text) return { status: 'rejected', reason: 'merge 需要 --content' };
  const conf = opts.confidence ?? Math.max(...src.map((r) => r.confidence));
  const rec = makeRecord({
    content: text,
    tier: 'semantic',
    scope: opts.scope || src[0].scope,
    confidence: conf,
    strength: 0.85,
    tags: unique(src.flatMap((r) => r.tags)),
    source: opts.source || 'model_synthesis',
    session: opts.session,
    merged_from: src.map((r) => r.id),
    needs_synthesis: false,
    embedding: opts.embedding,
  });
  store.records.push(rec);
  for (const r of src) {
    r.state = 'pruned';
    r.pruned_at = nowIso();
    r.superseded_by = rec.id;
    toArchive(store, r);
  }
  audit(store, 'merge', { id: rec.id, from: rec.merged_from.length });
  return { status: 'merged', id: rec.id, from: rec.merged_from, confidence: rec.confidence };
}

export function reorganize(store, opts = {}) {
  const cfg = store.config.reorg;
  const dry = Boolean(opts.dryRun);
  const res = consolidate(store, { dryRun: dry });
  const pruned = [];
  if (!dry) {
    for (const r of [...store.records]) {
      if (r.state !== 'active' || r.tier !== 'episodic') continue;
      const hit = bestSemanticCover(store, toComparable(r.content, r._vec), 'prune');
      if (!hit || !hit.ok || hit.semantic.confidence < cfg.prune_min_confidence) continue;
      r.state = 'pruned';
      r.pruned_at = nowIso();
      r.superseded_by = hit.semantic.id;
      pruned.push({ id: r.id, by: hit.semantic.id, similarity: round(hit.similarity) });
      toArchive(store, r);
    }
  }
  const open = store.conflicts.filter((c) => c.status === 'open');
  const suspect = store.conflicts.filter((c) => c.status === 'suspect');
  // 休眠但长期未被证明有用的条目：只报告，不删除。
  const stale = store.archive.filter((r) => r.state === 'dormant' && r.recall_count === 0).map((r) => r.id);
  audit(store, 'reorg', { promoted: res.promoted.length, absorbed: res.absorbed.length, pruned: pruned.length });
  return {
    dry,
    consolidation: res,
    pruned,
    open_conflicts: open.map((c) => ({ id: c.id, a: c.a, b: c.b, reason: c.reason, created_at: c.created_at })),
    suspect_conflicts: suspect.map((c) => ({ id: c.id, a: c.a, b: c.b, reason: c.reason })),
    dormant_without_recall: stale,
  };
}

// ---------------------------------------------------------------- 人格档案（外置对象，EMA 更新）

export function updatePersona(store, { trait, value, note = null } = {}) {
  const cfg = store.config.persona;
  const key = String(trait ?? '').trim();
  if (!key) return { status: 'rejected', reason: '需要 --trait' };
  if (value === undefined || value === null || value === '') return { status: 'rejected', reason: '需要 --value' };

  const cur = store.persona.traits[key];
  // 全局计数只用于报表；步长必须按“该特质自己的观测次数”算。
  // 否则库用久了以后，任何新加特质的首轮 EMA 只剩 α_min，等于永远学不进来。
  store.persona.observations += 1;
  const traitN = (cur && cur.observations ? cur.observations : 0) + 1;
  const alpha = cosineAlpha(traitN, {
    max: cfg.alpha_max, min: cfg.alpha_min, span: cfg.alpha_span,
  });
  const numeric = typeof value === 'number' && Number.isFinite(value);

  if (numeric) {
    const v = clamp(value, 0, 1);
    const prev = cur && cur.kind === 'numeric' ? cur.value : v;
    const next = cur && cur.kind === 'numeric' ? prev + alpha * (v - prev) : v;
    store.persona.traits[key] = {
      kind: 'numeric',
      value: round(next),
      observations: traitN,
      alpha: alpha,
      updated_at: nowIso(),
      note: note || (cur && cur.note) || null,
    };
  } else {
    const label = String(value).trim();
    const dist = cur && cur.kind === 'categorical' && cur.distribution ? { ...cur.distribution } : {};
    for (const k of Object.keys(dist)) dist[k] = dist[k] * (1 - alpha);
    const prev = dist[label] || 0;
    dist[label] = prev + alpha;
    const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
    for (const k of Object.keys(dist)) dist[k] = round(dist[k] / total, 3);
    store.persona.traits[key] = {
      kind: 'categorical',
      distribution: dist,
      observations: traitN,
      alpha: alpha,
      updated_at: nowIso(),
      note: note || (cur && cur.note) || null,
    };
  }

  store.persona.updated_at = nowIso();
  audit(store, 'persona.update', { trait: key, alpha });
  return { status: 'ok', trait: key, alpha, observations: store.persona.observations };
}

// ---------------------------------------------------------------- 人格候选池（自动演化的"只记录不生效"层）

const CANDIDATE_LIMIT = 30;

function sameCandidate(c, { trait, value }) {
  if (c.trait !== trait) return false;
  if (c.kind === 'numeric') {
    const a = Number(c.value);
    const b = Number(value);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.15;
  }
  return String(c.value) === String(value);
}

// 记一次"看起来像稳定偏好"的观测。够次数（或用户明确强调）才晋升为特质；
// 否则只躺在候选池里——这就是"不会把一次性偏好写成人格"的那道闸。
export function recordCandidate(store, { trait, value, note = null, strong = false } = {}) {
  const key = String(trait ?? '').trim();
  if (!key) return { status: 'rejected', reason: '需要 --trait' };
  if (value === undefined || value === null || value === '') return { status: 'rejected', reason: '需要 --value' };

  const numeric = typeof value === 'number' && Number.isFinite(value);
  const normalized = numeric ? round(clamp(value, 0, 1)) : String(value).trim();
  const kind = numeric ? 'numeric' : 'categorical';
  store.persona.candidates = Array.isArray(store.persona.candidates) ? store.persona.candidates : [];

  let cand = store.persona.candidates.find((c) => c.status === 'pending' && sameCandidate(c, { trait: key, value: normalized }));
  if (!cand) {
    cand = {
      id: newId('cand'),
      trait: key,
      kind,
      value: normalized,
      hits: 0,
      strong: 0,
      notes: [],
      status: 'pending',
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    store.persona.candidates.push(cand);
  }
  cand.hits += 1;
  if (strong) cand.strong += 1;
  if (note) cand.notes = [...cand.notes, String(note)].slice(-5);
  cand.updated_at = nowIso();

  const cfg = store.config.persona || {};
  const threshold = Math.max(1, Number(cfg.promote_hits ?? 2));
  const promote = cand.strong > 0 || cand.hits >= threshold;

  if (!promote) {
    audit(store, 'persona.candidate', { id: cand.id, trait: key, hits: cand.hits });
    return { status: 'pending', id: cand.id, trait: key, value: normalized, hits: cand.hits, threshold };
  }

  // 晋升：数值走 EMA（保留"渐进"语义），分类走 setPersona（直接改分布）。
  const applied = numeric
    ? updatePersona(store, { trait: key, value: normalized, note: note || '候选池晋升' })
    : setPersona(store, { trait: key, value: normalized, note: note || '候选池晋升' });
  // 观测次数要记账：晋升至少算 cand.hits 次证据，否则显示 n=0（既误导，也影响预算裁剪的顺序）。
  const tr = store.persona.traits[key];
  if (tr) tr.observations = Math.max(Number(tr.observations) || 0, cand.hits);
  cand.status = 'promoted';
  cand.promoted_at = nowIso();
  cand.reason = cand.strong > 0 ? 'explicit_emphasis' : `hits>=${threshold}`;
  audit(store, 'persona.promote', { id: cand.id, trait: key, reason: cand.reason });
  if (store.persona.candidates.length > CANDIDATE_LIMIT) {
    store.persona.candidates = store.persona.candidates.slice(-CANDIDATE_LIMIT);
  }
  return {
    status: 'promoted',
    id: cand.id,
    trait: key,
    value: normalized,
    hits: cand.hits,
    threshold,
    reason: cand.reason,
    applied: applied.status,
  };
}

export function listCandidates(store, { status = null } = {}) {
  const rows = (store.persona && store.persona.candidates) || [];
  const filtered = status ? rows.filter((c) => c.status === status) : rows;
  return [...filtered].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export function rejectCandidate(store, id) {
  const rows = (store.persona && store.persona.candidates) || [];
  const c = rows.find((x) => x.id === id);
  if (!c) return { status: 'not_found', id };
  if (c.status !== 'pending') return { status: 'rejected', reason: `该候选已是 ${c.status}` };
  c.status = 'rejected';
  c.updated_at = nowIso();
  audit(store, 'persona.candidate.reject', { id });
  return { status: 'ok', id, trait: c.trait };
}

// 人格根本性转变：直接编辑档案本身，不走 EMA（原设计的"编辑档案，不触发微调"）。
export function setPersona(store, { trait, value, note = null } = {}) {
  const key = String(trait ?? '').trim();
  if (!key) return { status: 'rejected', reason: '需要 --trait' };
  if (value === undefined || value === null || value === '') return { status: 'rejected', reason: '需要 --value' };
  const prev = store.persona.traits[key];
  const observations = prev && prev.observations ? prev.observations : 0;
  const numeric = typeof value === 'number' && Number.isFinite(value);
  if (numeric) {
    store.persona.traits[key] = {
      kind: 'numeric',
      value: round(clamp(value, 0, 1)),
      observations,
      alpha: null,
      updated_at: nowIso(),
      note,
      edited: true,
    };
  } else {
    const label = String(value).trim();
    store.persona.traits[key] = {
      kind: 'categorical',
      distribution: { [label]: 1 },
      observations,
      alpha: null,
      updated_at: nowIso(),
      note,
      edited: true,
    };
  }
  store.persona.updated_at = nowIso();
  audit(store, 'persona.set', { trait: key });
  return { status: 'ok', trait: key, edited: true };
}

export function personaSummary(store, opts = {}) {
  const maxTraits = opts.maxTraits ?? 8;
  const traits = store.persona.traits || {};
  const keys = Object.keys(traits)
    .sort((a, b) => (traits[b].observations || 0) - (traits[a].observations || 0))
    .slice(0, maxTraits);
  if (!keys.length) return { lines: [], text: '(empty persona archive)' };
  const lines = keys.map((k) => {
    const t = traits[k];
    if (t.kind === 'numeric') {
      // 与人卡渲染保持一致：数值对模型是噪声，刻度措辞才可执行；没有刻度才回退成数字。
      const scaled = scaleLine(k, t.value);
      const shown = scaled ? `${scaled}（${round(t.value, 2)}）` : `${round(t.value, 2)}`;
      return `${k}: ${shown} (n=${t.observations})`;
    }
    const top = Object.entries(t.distribution || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([v, p]) => `${v}=${p}`)
      .join(', ');
    return `${k}: ${top} (n=${t.observations})`;
  });
  return { lines, text: lines.join('\n') };
}

// ---------------------------------------------------------------- 人格卡片（热层渲染）

// 卡片 = 手写文本（身份/价值观/语气/边界）+ 由 traits 派生的强度行 + 可选的当前情绪行。
// 这是"数据 → 文本"的那一步：档案回答"多强"，卡片回答"你是谁"，情绪行回答"此刻该怎么调"。
// root 用于读 emotion-state.json（放库根，避免 memory/ 的写权限问题）；缺省则跳过情绪行。
export function renderPersonaCard(store, root = '', opts = {}) {
  const session = opts.session || null;
  const p = store.persona || {};
  const budget = Number((store.config.persona && store.config.persona.token_budget) ?? 300) || 300;
  const cardText = String((p.card && p.card.text) || '').trim();
  const moodBase = root ? emotionLine(root, Date.now(), session) : null;
  // 人格侧抑制：对方负面时，阈值够高就只处理事实、不承接情绪。
  const mood = moodBase ? `${moodBase}${root ? dampingLine(root, store, session) : ''}` : null;
  const traits = Object.entries(p.traits || {})
    // 排序决定超预算时先丢谁：先按优先级（高者先留），再按观测次数。
    .sort((a, b) => (priorityOf(b[0]) - priorityOf(a[0])) || ((b[1].observations || 0) - (a[1].observations || 0)));
  const lineOf = ([k, t]) => {
    if (t.kind === 'numeric') {
      // 刻度化：数字对模型是噪声，档位措辞才是可执行的。没有刻度就回退成数字。
      const scaled = scaleLine(k, t.value);
      const shown = scaled ? `${scaled}（${round(t.value, 2)}）` : `${round(t.value, 2)}`;
      return `${k}: ${shown}（n=${t.observations || 0}）`;
    }
    const top = Object.entries(t.distribution || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([v, c]) => `${v}=${round(c, 2)}`)
      .join(', ');
    return `${k}: ${top}（n=${t.observations || 0}）`;
  };
  const build = (text, lines) => ['[自我]', text, mood, ...lines].filter(Boolean).join('\n') + '\n[/自我]';

  const dropped = [];
  let lines = traits.map(lineOf);
  let out = build(cardText, lines);
  // 超预算时先丢观测最少的特质（观测少 = 证据弱），再截卡文本。
  while (estimateTokens(out) > budget && lines.length) {
    dropped.push(traits[traits.length - dropped.length - 1][0]);
    lines = lines.slice(0, -1);
    out = build(cardText, lines);
  }
  let text = cardText;
  let truncated = false;
  while (estimateTokens(out) > budget && text.length > 0) {
    text = text.slice(0, text.length - 8);
    truncated = true;
    out = build(text.trim() ? `${text.trim()}…` : '', lines);
  }
  return {
    text: out,
    tokens: estimateTokens(out),
    budget,
    over: estimateTokens(out) > budget,
    dropped,
    truncated,
    card_chars: cardText.length,
  };
}

const PERSONA_VERSION_LIMIT = 10;

function snapshotPersona(store) {
  const p = store.persona || {};
  p.versions = Array.isArray(p.versions) ? p.versions : [];
  p.versions.push({
    at: nowIso(),
    card: { text: (p.card && p.card.text) || '', updated_at: (p.card && p.card.updated_at) || null, note: (p.card && p.card.note) || null },
    traits: JSON.parse(JSON.stringify(p.traits || {})),
  });
  if (p.versions.length > PERSONA_VERSION_LIMIT) p.versions = p.versions.slice(-PERSONA_VERSION_LIMIT);
}

export function setPersonaCard(store, text, note = null) {
  const t = String(text ?? '').trim();
  const prevText = (store.persona.card && store.persona.card.text) || '';
  // 覆盖前先存一版：人格卡是手写文本，改坏只能靠快照找回。
  if (prevText && prevText !== t) snapshotPersona(store);
  store.persona.card = { text: t, updated_at: nowIso(), note: note || null };
  store.persona.updated_at = nowIso();
  audit(store, 'persona.card', { chars: t.length, tokens: estimateTokens(t) });
  return { status: 'ok', chars: t.length, tokens: estimateTokens(t), versions: (store.persona.versions || []).length };
}

export function personaHistory(store) {
  const versions = Array.isArray(store.persona.versions) ? store.persona.versions : [];
  return versions.map((v, i) => ({
    index: i + 1,
    at: v.at,
    chars: ((v.card && v.card.text) || '').length,
    traits: Object.keys(v.traits || {}).length,
    head: ((v.card && v.card.text) || '').slice(0, 40),
  }));
}

// 回滚到某一版（1-based）。回滚自身也先存一版，所以可以再滚回来。
export function rollbackPersona(store, index) {
  const versions = Array.isArray(store.persona.versions) ? store.persona.versions : [];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 1 || i > versions.length) {
    return { status: 'rejected', reason: versions.length ? `版本号应为 1..${versions.length}` : '没有历史版本' };
  }
  snapshotPersona(store);
  const target = versions[i - 1];
  store.persona.card = {
    text: (target.card && target.card.text) || '',
    updated_at: nowIso(),
    note: target.card && target.card.note ? target.card.note : null,
  };
  store.persona.traits = JSON.parse(JSON.stringify(target.traits || {}));
  store.persona.updated_at = nowIso();
  audit(store, 'persona.rollback', { index: i });
  return {
    status: 'ok',
    index: i,
    chars: store.persona.card.text.length,
    traits: Object.keys(store.persona.traits).length,
  };
}

// ---------------------------------------------------------------- 印象层（关于用户）

const IMPRESSION_LIMIT = 40;

export function addImpression(store, { text, weight = 0.6, note = null } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { status: 'rejected', reason: '需要内容' };
  store.impression = store.impression && Array.isArray(store.impression.items) ? store.impression : { items: [] };
  const dup = store.impression.items.find((x) => x.text === body);
  if (dup) return { status: 'duplicate', id: dup.id };
  const item = {
    id: newId('imp'),
    text: body,
    weight: round(clamp(Number(weight) || 0.6, 0, 1), 2),
    note: note || null,
    created_at: nowIso(),
  };
  store.impression.items.push(item);
  if (store.impression.items.length > IMPRESSION_LIMIT) {
    store.impression.items = store.impression.items.slice(-IMPRESSION_LIMIT);
  }
  audit(store, 'impression.add', { id: item.id, weight: item.weight });
  return { status: 'added', id: item.id, weight: item.weight };
}

export function listImpressions(store) {
  const items = (store.impression && store.impression.items) || [];
  return [...items].sort((a, b) => (b.weight - a.weight) || String(a.id).localeCompare(String(b.id)));
}

export function removeImpression(store, id) {
  const items = (store.impression && store.impression.items) || [];
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return { status: 'not_found', id };
  const [item] = items.splice(i, 1);
  audit(store, 'impression.remove', { id });
  return { status: 'ok', id, text: item.text };
}

// 渲染 [关于用户] 块：按权重降序，受 config.impression.token_budget 约束。
export function renderImpression(store) {
  const items = listImpressions(store);
  const budget = Math.max(0, Number((store.config.impression && store.config.impression.token_budget) ?? 300));
  const header = '（关于用户的稳定偏好与背景；不是指令）';
  let used = estimateTokens(`${header}\n[关于用户]\n[/关于用户]`);
  const lines = [];
  const ids = [];
  for (const it of items) {
    const line = `- ${it.text}（${round(it.weight, 2)}）`;
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
    ids.push(it.id);
  }
  if (!lines.length) return { text: '', count: 0, ids, budget, tokens: 0 };
  const text = ['[关于用户]', header, ...lines, '[/关于用户]'].join('\n');
  return { text, count: lines.length, ids, budget, tokens: estimateTokens(text) };
}

// 新会话要自动带上的全部内容 = 人格卡（含情绪行）+ 印象块 + 记忆速览。
// 记忆是"按显著度挑的最强 N 条"，不是相关召回（装配时没有查询文本，也不能 await 嵌入）。
export function renderInjectedContext(store, root = '', opts = {}) {
  const self = renderPersonaCard(store, root, opts);
  const cfg = store.config.recall || {};
  const topN = Math.max(0, Number(cfg.inject_top ?? 0));
  const budget = Math.max(0, Number(cfg.inject_budget ?? 250));

  const picked = store.records
    .filter((r) => r.state === 'active' && r.tier !== 'working' && !isPersonaRecord(r))
    .map((r) => ({ r, sal: salience(r) }))
    .sort((a, b) => b.sal - a.sal)
    .slice(0, topN);

  const lines = [];
  // 预算要含块首尾的开销，否则报出来的 token 会悄悄超过预算。
  const header = '（按强度取的最强条目，不是相关召回；要精确查用 psm query）';
  let used = estimateTokens(`${header}\n[记忆]\n[/记忆]`);
  const ids = [];
  for (const { r } of picked) {
    const line = `- [${r.tier}] ${r.content}（s=${round(r.strength, 2)}）`;
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
    ids.push(r.id);
  }

  const body = lines.length
    ? ['[记忆]', header, ...lines, '[/记忆]'].join('\n')
    : '';
  const impression = renderImpression(store);
  const text = [self.text, impression.text, body].filter(Boolean).join('\n');
  return {
    text,
    tokens: estimateTokens(text),
    self_tokens: self.tokens,
    impression: { count: impression.count, ids: impression.ids, tokens: impression.tokens, budget: impression.budget },
    memory: { count: lines.length, ids, tokens: body ? estimateTokens(body) : 0, budget, top: topN },
  };
}

// ---------------------------------------------------------------- 报表

export function report(store) {
  const byTier = {};
  const byState = {};
  for (const r of [...store.records, ...store.archive]) {
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    byState[r.state] = (byState[r.state] || 0) + 1;
  }
  const active = store.records.filter((r) => r.state === 'active');
  const top = [...active]
    .sort((a, b) => salience(b) - salience(a))
    .slice(0, 5)
    .map((r) => ({ id: r.id, tier: r.tier, strength: r.strength, content: r.content.slice(0, 80) }));
  return {
    active: active.length,
    records_total: store.records.length,
    archived_total: store.archive.length,
    by_tier: byTier,
    by_state: byState,
    avg_strength: round(mean(active.map((r) => r.strength))),
    open_conflicts: store.conflicts.filter((c) => c.status === 'open').length,
    suspect_conflicts: store.conflicts.filter((c) => c.status === 'suspect').length,
    sessions: store.sessions,
    persona_traits: Object.keys(store.persona.traits || {}).length,
    persona_observations: store.persona.observations,
    needs_synthesis: active.filter((r) => r.needs_synthesis).map((r) => r.id),
    top,
    embed: {
      enabled: Boolean(store.config.embed && store.config.embed.enabled),
      model: (store.config.embed && store.config.embed.model) || null,
      with_vectors: [...store.records, ...store.archive].filter((r) => Array.isArray(r._vec) && r._vec.length).length,
      total: store.records.length + store.archive.length,
    },
    updated_at: store.updated_at,
  };
}

export function resolveConflict(store, conflictId, resolution, note = null) {
  const c = store.conflicts.find((x) => x.id === conflictId);
  if (!c) return { status: 'not_found', id: conflictId };
  if (!['keep-a', 'keep-b', 'both'].includes(resolution)) {
    return { status: 'rejected', reason: 'resolution 必须是 keep-a | keep-b | both' };
  }
  c.status = 'resolved';
  c.resolution = resolution;
  c.note = note;
  c.resolved_at = nowIso();
  const a = findRecord(store, c.a);
  const b = findRecord(store, c.b);
  if (resolution === 'keep-a' && a && b) {
    b.strength = round(clamp(b.strength * 0.3, 0, 1));
    b.confidence = round(clamp(b.confidence * 0.5, 0, 1));
    b.demoted = true;
    a.confidence = round(clamp(a.confidence + 0.1, 0, 1));
  }
  if (resolution === 'keep-b' && a && b) {
    a.strength = round(clamp(a.strength * 0.3, 0, 1));
    a.confidence = round(clamp(a.confidence * 0.5, 0, 1));
    a.demoted = true;
    b.confidence = round(clamp(b.confidence + 0.1, 0, 1));
  }
  audit(store, 'conflict.resolve', { id: conflictId, resolution });
  return { status: 'ok', id: conflictId, resolution };
}
