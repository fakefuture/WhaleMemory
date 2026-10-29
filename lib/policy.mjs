// lib/policy.mjs — 范围可见性、回答资格、合并/覆盖限制、幂等键。
// CLI、capture、service、插件都必须走这里；不允许各自维护一份规则。

import { salientDiffers } from './util.mjs';

export const DEFAULT_CONTEXT = Object.freeze({
  ownerId: 'local',
  workspaceId: null,
  sessionId: null,
  now: null,
  actor: 'user',
  requestId: null,
});

export function resolveContext(store, ctx = {}) {
  const identity = (store && store.identity) || {};
  const now = ctx.now || new Date().toISOString();
  return {
    ownerId: String(ctx.ownerId || identity.owner_id || 'local'),
    workspaceId: ctx.workspaceId || identity.workspace_id || null,
    sessionId: ctx.sessionId === undefined || ctx.sessionId === null || ctx.sessionId === ''
      ? null
      : String(ctx.sessionId),
    now,
    actor: String(ctx.actor || 'user'),
    requestId: ctx.requestId ? String(ctx.requestId) : null,
  };
}

export function namespaceOf(ctx) {
  return {
    owner_id: ctx.ownerId,
    workspace_id: ctx.workspaceId,
    session_id: ctx.sessionId || null,
  };
}

export function sameOwner(a, b) {
  return (a.namespace && a.namespace.owner_id) === (b.namespace && b.namespace.owner_id);
}

export function sameNamespace(a, b) {
  const x = a.namespace || {};
  const y = b.namespace || {};
  if (x.owner_id !== y.owner_id) return false;
  if (x.workspace_id !== y.workspace_id) return false;
  if (a.scope === 'session' || b.scope === 'session') return x.session_id === y.session_id;
  return true;
}

export function sameScope(a, b) {
  return a.scope === b.scope;
}

// 可见性矩阵：global 同 owner；workspace 同 owner+workspace；session 再要求 session 精确匹配。
// 没给 sessionId 时，一条 session 记录都不可见（回退 active 会串会话）。
export function visible(record, ctx, { allScopes = false } = {}) {
  if (!record) return false;
  const ns = record.namespace || {};
  if (allScopes) return ns.owner_id === ctx.ownerId;
  if (ns.owner_id !== ctx.ownerId) return false;
  if (record.scope === 'global') return true;
  if (record.scope === 'workspace') return Boolean(ctx.workspaceId) && ns.workspace_id === ctx.workspaceId;
  if (record.scope === 'session') {
    return Boolean(ctx.sessionId) && ns.workspace_id === ctx.workspaceId && ns.session_id === ctx.sessionId;
  }
  return false;
}

export function scopeAllowedForQuery(record, ctx, { scope = null, allScopes = false } = {}) {
  if (allScopes) return visible(record, ctx, { allScopes: true });
  if (scope && record.scope !== scope && record.scope !== 'global') return false;
  return visible(record, ctx);
}

// 半开区间 [valid_from, valid_to)。null 表示未知 / 无声明，不能冒充精确历史。
export function timeMatches(record, at) {
  if (!at) return { ok: true, unknown: false };
  const t = record.time || {};
  const point = Date.parse(at);
  if (!Number.isFinite(point)) return { ok: false, unknown: false, reason: 'bad_at' };
  let unknown = !t.valid_from && !t.valid_to;
  if (t.valid_from) {
    const from = Date.parse(t.valid_from);
    if (Number.isFinite(from) && point < from) return { ok: false, unknown: false, reason: 'before_valid_from' };
  } else if (t.valid_to) {
    unknown = true;
  }
  if (t.valid_to) {
    const to = Date.parse(t.valid_to);
    if (Number.isFinite(to) && point >= to) return { ok: false, unknown: false, reason: 'after_valid_to' };
  } else if (t.valid_from) {
    unknown = true;
  }
  return { ok: true, unknown };
}

// 默认可回答资格：accepted + current + active + 当前上下文可见 + 查询时间匹配。
export function eligibleForAnswer(record, ctx, opts = {}) {
  if (!record) return { ok: false, reason: 'missing' };
  if (record.state !== 'active') return { ok: false, reason: 'state' };
  if (record.review_status !== 'accepted') return { ok: false, reason: 'review_status' };
  if (record.validity !== 'current') return { ok: false, reason: 'validity' };
  if (!visible(record, ctx, { allScopes: opts.allScopes === true })) return { ok: false, reason: 'scope' };
  const tm = timeMatches(record, opts.at);
  if (!tm.ok) return { ok: false, reason: tm.reason || 'time' };
  return { ok: true, time_unknown: tm.unknown };
}

export function visibleTo(record, ctx) {
  return visible(record, ctx);
}

export function unresolvedConflictsBetween(store, aId, bId) {
  return (store.conflicts || []).filter((c) => {
    if (!['open', 'suspect'].includes(c.status)) return false;
    return (c.a === aId && c.b === bId) || (c.a === bId && c.b === aId);
  });
}

export function recordHasOpenConflict(store, id) {
  return (store.conflicts || []).some((c) => ['open', 'suspect'].includes(c.status)
    && (c.a === id || c.b === id));
}

// 合并/覆盖的共享守卫。调用方必须对每个成员独立调用，不能用「簇里有一个通过」代表全簇。
// 返回 { ok, reasons[] }，reasons 是稳定的机器可读代码。
export function canCombine(a, b, { store = null, similarity = null, requireAccepted = true } = {}) {
  const reasons = [];
  if (!a || !b) reasons.push('missing');
  if (a && b) {
    if (a.id === b.id) reasons.push('same_record');
    if (!sameNamespace(a, b)) reasons.push('namespace_mismatch');
    if (!sameScope(a, b)) reasons.push('scope_mismatch');
    if (a.scope === 'session' && a.namespace.session_id !== b.namespace.session_id) reasons.push('session_mismatch');
    if (requireAccepted && (a.review_status !== 'accepted' || b.review_status !== 'accepted')) reasons.push('not_accepted');
    if (a.validity !== 'current' || b.validity !== 'current') reasons.push('not_current');
    if (a.state !== 'active' || b.state !== 'active') reasons.push('not_active');
    if (salientDiffers(a.content, b.content)) reasons.push('salient_value_differs');
    if (store) {
      const open = unresolvedConflictsBetween(store, a.id, b.id);
      if (open.length) reasons.push('unresolved_conflict');
      if (recordHasOpenConflict(store, a.id) || recordHasOpenConflict(store, b.id)) reasons.push('record_in_conflict');
    }
    if (similarity !== null && !(Number(similarity) > 0)) reasons.push('no_similarity');
  }
  return { ok: reasons.length === 0, reasons };
}

// 情节 → 语义覆盖：额外要求目标确实是 accepted/current 的语义记录。
export function canCover(episode, semantic, { store = null, similarity = null } = {}) {
  if (!episode || !semantic) return { ok: false, reasons: ['missing'] };
  if (semantic.tier !== 'semantic') return { ok: false, reasons: ['target_not_semantic'] };
  if (episode.tier !== 'episodic') return { ok: false, reasons: ['source_not_episodic'] };
  const r = canCombine(episode, semantic, { store, similarity, requireAccepted: true });
  const reasons = [...r.reasons];
  if (semantic.review_status !== 'accepted') reasons.push('target_not_accepted');
  if (semantic.validity !== 'current') reasons.push('target_not_current');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function canSupersede(oldRec, newRec, { store = null } = {}) {
  if (!oldRec || !newRec) return { ok: false, reasons: ['missing'] };
  const reasons = [];
  if (!sameNamespace(oldRec, newRec)) reasons.push('namespace_mismatch');
  if (!sameScope(oldRec, newRec)) reasons.push('scope_mismatch');
  if (oldRec.state !== 'active') reasons.push('target_not_active');
  if (oldRec.review_status === 'candidate' || newRec.review_status === 'candidate') reasons.push('candidate_not_supersedable');
  if (store && recordHasOpenConflict(store, oldRec.id)) reasons.push('already_in_conflict');
  return { ok: reasons.length === 0, reasons };
}

// 幂等键：同一 requestId / 来源稳定键重复执行不产生第二条证据或候选。
export function idempotencyKey(parts) {
  return parts.filter((x) => x !== undefined && x !== null && x !== '').join('|');
}

export function alreadyProcessed(store, key) {
  if (!key) return null;
  const receipts = (store.captures && store.captures.receipts) || {};
  return receipts[key] || null;
}

export function markProcessed(store, key, payload) {
  if (!key) return;
  if (!store.captures.receipts) store.captures.receipts = {};
  store.captures.receipts[key] = { at: new Date().toISOString(), ...payload };
}

// 反馈幂等：同 requestId 只累计一次。
export function feedbackAlreadyRecorded(store, key) {
  if (!key) return false;
  if (!store.feedback_receipts) store.feedback_receipts = {};
  return Boolean(store.feedback_receipts[key]);
}

export function markFeedback(store, key, payload) {
  if (!key) return;
  if (!store.feedback_receipts) store.feedback_receipts = {};
  store.feedback_receipts[key] = { at: new Date().toISOString(), ...payload };
}

// 范围诊断查询：--all-scopes 只读，不允许强化、巩固、注入。
export function assertDiagnosticReadOnly(opts) {
  if (opts.allScopes && opts.touch) {
    const err = new Error('--all-scopes 是只读诊断查询：不能与 --touch 同用');
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }
}
