// lib/service-core.mjs — 准入/去重/纠错/证据的核心逻辑，可在已有事务里复用。
//
// 为什么单独一层：capture、合成提交、宿主 ingestMessages 都必须和 CLI add 走同一套规则，
// 但不能各自再开一个写事务（会嵌套锁、丢 revision）。这里只操作 tx.doc，不读盘、不拿锁。
//
// 边界：
//   - 去重只在同 namespace + scope + 审核状态 + 有效状态下做，且只做「完全相同」的确定性去重；
//   - 相似但取值不同的记录只标 suspect 冲突，绝不降权、绝不自动合并；
//   - 显式 supersedes 保留旧正文，只改 validity/superseded_by，并写一条已裁决的 correction 关系；
//   - 证据必须真实存在：调用方给的 id 找不到直接拒绝，不编造原文。

import { PsmError, CODES } from './errors.mjs';
import {
  makeRecord, makeEvidence, sha256Text, TIER_DEFAULTS, SCOPES,
} from './schema.mjs';
import { namespaceOf, canSupersede } from './policy.mjs';
import { toComparable, simPair, thresholdsFor } from './sim.mjs';
import { unique, hasNegationCue, salientDiffers } from './util.mjs';

const NORMALIZE = (s) => String(s ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const CONFLICT_STATUSES = ['open', 'suspect'];

function resolveEvidenceIds(tx, ctx, input, content, { candidate = false } = {}) {
  const doc = tx.doc;
  const ids = [];
  const push = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };

  const explicit = unique(input.evidence_ids || []);
  const missing = explicit.filter((id) => !doc.evidence.some((e) => e.id === id));
  if (missing.length) {
    throw new PsmError(CODES.INVALID_ARGUMENT, `证据不存在：${missing.join(', ')}`, { evidence_ids: missing });
  }
  for (const id of explicit) push(id);

  const items = [];
  if (Array.isArray(input.evidence_items)) items.push(...input.evidence_items);
  if (input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)) items.push(input.evidence);

  for (const src of items) {
    const ev = makeEvidence({
      id: src.id || null,
      text: src.text !== undefined && src.text !== null ? src.text : content,
      kind: src.kind || (candidate ? 'message' : 'manual'),
      actor: src.actor || ctx.actor,
      subject: src.subject,
      session_id: src.session_id !== undefined ? src.session_id : ctx.sessionId,
      message_id: src.message_id ?? null,
      captured_at: src.captured_at || ctx.now,
      occurred_at: src.occurred_at ?? null,
      locator: src.locator || null,
      meta: src.meta || {},
    }, ctx);
    if (!doc.evidence.some((e) => e.id === ev.id)) doc.evidence.push(ev);
    push(ev.id);
  }

  if (!ids.length) {
    const ev = makeEvidence({
      text: content,
      kind: candidate ? 'message' : 'manual',
      actor: ctx.actor,
      session_id: ctx.sessionId,
    }, ctx);
    if (!doc.evidence.some((e) => e.id === ev.id)) doc.evidence.push(ev);
    push(ev.id);
  }
  return ids;
}

function sameBucket(r, { namespace, scope, reviewStatus }) {
  if (r.namespace.owner_id !== namespace.owner_id) return false;
  if (r.namespace.workspace_id !== namespace.workspace_id) return false;
  if (r.scope !== scope) return false;
  if (scope === 'session' && r.namespace.session_id !== namespace.session_id) return false;
  if (r.review_status !== reviewStatus) return false;
  if (r.validity !== 'current') return false;
  if (r.state !== 'active') return false;
  return true;
}

/**
 * 在一个已打开的事务里新增记录。
 * @param {object} tx  repository.withWrite 提供的事务对象
 * @param {object} ctx resolveContext 的结果
 * @param {object} input 与 MemoryService.add 的输入一致
 */
export function addRecordInTx(tx, ctx, input = {}) {
  const doc = tx.doc;
  const cfg = doc.config;
  const content = String(input.content ?? '').trim();
  if (content.length < cfg.admission.min_content_length) {
    return { status: 'rejected', reason: `content 过短（< ${cfg.admission.min_content_length} 字符）` };
  }
  if (content.length > cfg.admission.max_content_length) {
    return { status: 'rejected', reason: `content 过长（> ${cfg.admission.max_content_length} 字符），请先切分` };
  }

  const scope = SCOPES.includes(input.scope) ? input.scope : 'workspace';
  if (scope === 'session' && !ctx.sessionId) {
    return {
      status: 'rejected',
      code: CODES.FORBIDDEN_SCOPE,
      reason: 'scope=session 的写入必须提供 sessionId；不用共享 default 会话冒充隔离',
    };
  }

  const reviewStatus = input.review_status === 'candidate' || input.candidate === true ? 'candidate' : 'accepted';
  const namespace = namespaceOf(ctx);
  const normalized = NORMALIZE(content);
  const tier = TIER_DEFAULTS[input.tier] ? input.tier : 'episodic';

  // 1) 确定性去重：只在同 namespace + scope + 审核/有效状态中进行。
  const dup = doc.records.find((r) => sameBucket(r, { namespace, scope, reviewStatus })
    && NORMALIZE(r.content) === normalized);
  if (dup) {
    // 只追加证据关联与审计；不因重复提交提高强度/信度/召回次数。
    const ids = resolveEvidenceIds(tx, ctx, input, content, { candidate: reviewStatus === 'candidate' });
    for (const id of ids) if (!dup.evidence_ids.includes(id)) dup.evidence_ids.push(id);
    tx.op({
      op: 'add.duplicate',
      target: dup.id,
      evidence_ids: ids,
      reason: '同 namespace / scope / 审核状态 / 有效状态下的相同正文',
    });
    return { status: 'duplicate', id: dup.id, tier: dup.tier, review_status: dup.review_status, evidence_ids: dup.evidence_ids };
  }

  // 2) 显式纠错：跨范围默认拒绝；旧版本保留正文，只标记 superseded。
  const supersedes = unique(input.supersedes || []);
  const supersededTargets = [];
  if (supersedes.length) {
    for (const id of supersedes) {
      const old = doc.records.find((r) => r.id === id);
      if (!old) return { status: 'rejected', reason: `supersedes 目标不存在：${id}` };
      if (old.namespace.owner_id !== namespace.owner_id) {
        return { status: 'rejected', code: CODES.FORBIDDEN_SCOPE, reason: `跨 owner 纠错被拒绝：${id}` };
      }
      if (old.scope !== scope
        || old.namespace.workspace_id !== namespace.workspace_id
        || (scope === 'session' && old.namespace.session_id !== namespace.session_id)) {
        return {
          status: 'rejected',
          code: CODES.FORBIDDEN_SCOPE,
          reason: `跨范围纠错被拒绝：${id}（${old.scope} → ${scope}）。改变 scope 是独立显式操作`,
        };
      }
      if (old.validity !== 'current') {
        return { status: 'rejected', reason: `纠错目标不是当前有效版本：${id}（validity=${old.validity}）` };
      }
      const guard = canSupersede(old, { namespace, scope, state: 'active', review_status: 'accepted' }, { store: doc });
      if (!guard.ok) {
        return { status: 'rejected', reason: `不能纠错 ${id}：${guard.reasons.join(', ')}` };
      }
      if (!supersededTargets.includes(old)) supersededTargets.push(old);
    }
  }

  // 3) 启发式冲突只标 suspect，不降权；候选不参与冲突判定。
  const suspectConflicts = [];
  if (reviewStatus === 'accepted') {
    const cand = toComparable(content, input.embedding);
    for (const r of doc.records) {
      if (!sameBucket(r, { namespace, scope, reviewStatus: 'accepted' })) continue;
      if (supersedes.includes(r.id)) continue;
      const sim = simPair(cand, toComparable(r.content, r._vec));
      const th = thresholdsFor(doc, sim.kind);
      if (sim.value < th.conflict) continue;
      const negMismatch = hasNegationCue(content) !== hasNegationCue(r.content);
      const valueMismatch = salientDiffers(r.content, content);
      if (!negMismatch && !valueMismatch) continue;

      const existing = doc.conflicts.find((c) => CONFLICT_STATUSES.includes(c.status)
        && ((c.a === r.id && c.b === null) || (c.a === null && c.b === r.id)));
      if (existing) {
        if (!suspectConflicts.includes(existing)) suspectConflicts.push(existing);
        continue;
      }
      const c = {
        id: `cfl_${sha256Text(`${r.id}:${normalized}`).slice(0, 16)}`,
        a: r.id,
        b: null,
        reason: valueMismatch ? 'value_mismatch' : 'negation_mismatch',
        status: 'suspect',
        created_at: ctx.now,
        resolved_at: null,
        resolution: null,
        note: '启发式只标疑似，未降权；需要人/模型裁决',
      };
      doc.conflicts.push(c);
      r.conflicts_with = unique([...r.conflicts_with, c.id]);
      suspectConflicts.push(c);
    }
  }

  // 4) 证据
  const evidenceIds = resolveEvidenceIds(tx, ctx, input, content, { candidate: reviewStatus === 'candidate' });
  const review = {
    history: [{
      at: ctx.now,
      action: reviewStatus === 'candidate' ? 'candidate' : 'accepted',
      actor: ctx.actor,
      note: input.note || null,
    }],
  };

  const rec = makeRecord({
    ...input,
    content,
    tier,
    scope,
    review_status: reviewStatus,
    validity: 'current',
    namespace,
    evidence_ids: evidenceIds,
    review,
    verification: reviewStatus === 'accepted'
      ? { method: input.verification?.method || 'manual_admission', actor: ctx.actor, at: ctx.now, note: input.note || null }
      : { method: input.verification?.method || null, actor: input.verification?.actor || null, at: input.verification?.at || null, note: input.note || null },
    time: input.time,
    session_id: ctx.sessionId,
    embedding: input.embedding,
  }, ctx);

  for (const c of suspectConflicts) {
    if (c.b === null) {
      c.b = rec.id;
      rec.conflicts_with = unique([...rec.conflicts_with, c.id]);
    }
  }
  for (const old of supersededTargets) {
    old.validity = 'superseded';
    old.superseded_by = rec.id;
    old.updated_at = ctx.now;
    const c = {
      id: `cfl_${sha256Text(`correction:${old.id}:${rec.id}`).slice(0, 16)}`,
      a: old.id,
      b: rec.id,
      reason: 'explicit_correction',
      status: 'resolved',
      created_at: ctx.now,
      resolved_at: ctx.now,
      resolution: 'superseded',
      note: input.note || '显式 supersedes；旧正文保留，默认查询排除',
    };
    doc.conflicts.push(c);
    old.conflicts_with = unique([...old.conflicts_with, c.id]);
    rec.conflicts_with = unique([...rec.conflicts_with, c.id]);
  }

  doc.records.push(rec);
  tx.op({
    op: 'add',
    target: rec.id,
    source: rec.source,
    reason: input.note || null,
    evidence_ids: evidenceIds,
    changes: {
      tier: rec.tier,
      scope: rec.scope,
      review_status: rec.review_status,
      supersedes: supersedes.length ? supersedes : undefined,
    },
  });

  return {
    status: 'added',
    id: rec.id,
    tier: rec.tier,
    scope: rec.scope,
    review_status: rec.review_status,
    validity: rec.validity,
    evidence_ids: rec.evidence_ids,
    conflicts: suspectConflicts.map((c) => ({ id: c.id, with: c.a, reason: c.reason, status: c.status })),
    superseded: supersededTargets.map((r) => r.id),
  };
}
