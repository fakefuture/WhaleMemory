// lib/schema.mjs — v2 数据契约：默认值、记录构造、结构校验、v1→v2 纯转换。
//
// 语义边界（任务书 §5）：
//   tier      稳定事实 / 情节 / 工作记忆
//   state     active | dormant | pruned（存储生命周期）
//   review_status  candidate | accepted | rejected（能否作为默认回答依据）
//   validity  current | disputed | superseded（是否为当前有效版本）
// accepted 只表示被流程采纳，不表示客观事实已被证明。

import crypto from 'node:crypto';
import { PsmError, CODES } from './errors.mjs';

export const SCHEMA_VERSION = 2;
export const OWNER_ID = 'local';

export const TIER_DEFAULTS = {
  semantic: { strength: 0.85, decay_rate: 0.008, confidence: 0.8 },
  episodic: { strength: 0.6, decay_rate: 0.05, confidence: 0.6 },
  working: { strength: 0.4, decay_rate: 0.15, confidence: 0.5 },
};
export const TIERS = Object.keys(TIER_DEFAULTS);
export const SCOPES = ['global', 'workspace', 'session'];
export const REVIEW_STATUSES = ['candidate', 'accepted', 'rejected'];
export const VALIDITIES = ['current', 'disputed', 'superseded'];
export const DOMAINS = ['factual', 'security', 'preference', 'personal'];
export const EVIDENCE_KINDS = ['message', 'manual', 'legacy_record'];
export const ACTORS = ['user', 'assistant', 'unknown'];

export const nowIso = () => new Date().toISOString();

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newWorkspaceId() {
  return `ws_${crypto.randomBytes(6).toString('hex')}`;
}

export function defaultConfig() {
  return {
    admission: {
      min_content_length: 2,
      max_content_length: 4000,
    },
    retrieval: {
      // 绝对相关性门槛在归一化、强度、偏置之前执行；两路各自独立。
      // 这些默认值没有评测依据时只是暂定值，doctor/report 会标 tentative。
      lexical_min: 0.12,
      dense_min: 0.55,
      rrf_k: 60,
      weights: { relevance: 0.55, strength: 0.25, recency: 0.12, utility: 0.08 },
      mmr_lambda: null,
      tentative: true,
      // 旧的「召回次数达标就巩固」必须显式打开；默认按正向效用。
      legacy_recall_consolidation: false,
    },
    recall: {
      limit: 8,
      w_strength: 0.25,
      w_recency: 0.15,
      w_utility: 0.1,
      recency_half_life_days: 14,
      persona_boost: 0.25,
      persona_relevance_tolerance: 0.15,
      persona_cap: 0.02,
      lambda_recall_damp: 0.15,
      lambda_floor: 0.002,
      relevance_normalize: true,
      min_relevance_spread: 0.05,
      mmr_lambda: null,
      // 静态注入默认关闭；显式开启也只选 accepted + current + 可见条目。
      inject_top: 0,
      inject_budget: 250,
    },
    decay: {
      top_k: 20,
      tau_archive: 0.12,
      strength_floor: null,
      negative_utility_boost: 0.5,
      positive_utility_damp: 0.5,
      working_settle: true,
    },
    consolidation: {
      min_recall_count: 3,
      min_utility_hits: 2,
      // 旧的召回次数模式默认关闭；打开即改变巩固条件，report 会显示行为说明。
      use_recall_count: false,
    },
    reorg: {
      prune_min_confidence: 0.75,
    },
    // v0.2：情绪与人格偏置默认 0（实验性）。不修改已有用户显式配置；新库用新默认值。
    color: {
      affect_alpha: 0,
      persona_alpha: 0,
      domains: ['preference', 'personal'],
    },
    impression: {
      token_budget: 300,
    },
    persona: {
      alpha_max: 0.6,
      alpha_min: 0.03,
      alpha_span: 24,
      token_budget: 420,
      promote_hits: 2,
    },
    sim: {
      lexical: { merge: 0.9, conflict: 0.3, cluster: 0.55, cover: 0.7, prune: 0.85 },
      embedding: { merge: 0.95, conflict: 0.55, cluster: 0.72, cover: 0.82, prune: 0.9 },
    },
    candidates: {
      max_proposal_chars: 300,
      require_note_for_reject: true,
      require_note_for_inconclusive: true,
    },
    embed: {
      enabled: false,
      provider: 'ollama',
      url: 'http://127.0.0.1:11434',
      model: 'bge-m3',
      timeout_ms: 15000,
      num_gpu: null,
    },
    synth: {
      enabled: false,
      url: 'http://127.0.0.1:11434',
      model: 'qwen2.5:1.5b',
      timeout_ms: 60000,
      num_gpu: 0,
      max_chars: 300,
    },
  };
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoWithZone(value) {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

// 新时间字段统一要求带时区的 ISO 8601。null 表示未知/无声明，不用创建时间猜。
export function assertTimeValue(value, field) {
  if (value === null || value === undefined) return null;
  if (!isIsoWithZone(value)) {
    throw new PsmError(CODES.INVALID_ARGUMENT,
      `${field} 必须是带时区的 ISO 8601（例如 2026-10-28T12:00:00+08:00 或 …Z），收到：${JSON.stringify(value)}`,
      { field, value });
  }
  return value;
}

export function normalizeTime(input, now = nowIso()) {
  const t = input && typeof input === 'object' ? input : {};
  const validFrom = assertTimeValue(t.valid_from, 'time.valid_from');
  const validTo = assertTimeValue(t.valid_to, 'time.valid_to');
  const occurred = assertTimeValue(t.occurred_at, 'time.occurred_at');
  if (validFrom && validTo && Date.parse(validTo) <= Date.parse(validFrom)) {
    throw new PsmError(CODES.INVALID_ARGUMENT, 'time.valid_to 必须晚于 time.valid_from', { valid_from: validFrom, valid_to: validTo });
  }
  void now;
  return { occurred_at: occurred, valid_from: validFrom, valid_to: validTo };
}

export function emptyStore({ ownerId = OWNER_ID, workspaceId = newWorkspaceId() } = {}) {
  const ts = nowIso();
  return {
    version: SCHEMA_VERSION,
    revision: 0,
    created_at: ts,
    updated_at: ts,
    identity: { owner_id: ownerId, workspace_id: workspaceId },
    config: defaultConfig(),
    records: [],
    archive: [],
    conflicts: [],
    evidence: [],
    operations: [],
    migrations: [],
    captures: { cursors: {}, receipts: {} },
    sessions: { count: 0, last_end: null, processed: [] },
    persona: { observations: 0, updated_at: ts, card: { text: '', updated_at: null, note: null }, traits: {}, versions: [], candidates: [] },
    impression: { items: [] },
    feedback_receipts: {},
    // 旧 log 原样保留；v2 的结构化变更记录在 operations。
    log: [],
  };
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function mergeConfig(base, src) {
  const out = clone(base);
  const s = src && typeof src === 'object' ? src : {};
  for (const section of Object.keys(out)) {
    if (s[section] && typeof s[section] === 'object' && !Array.isArray(s[section])) {
      out[section] = { ...out[section], ...clone(s[section]) };
    }
  }
  // 已知的旧键删除，避免「改了不生效」的暗坑。
  delete out.admission.merge_similarity;
  delete out.admission.conflict_similarity;
  delete out.consolidation.cluster_similarity;
  delete out.consolidation.cover_similarity;
  delete out.reorg.prune_similarity;
  return out;
}

export function makeRecord(input = {}, ctx = {}) {
  const ts = ctx.now || nowIso();
  const tier = TIERS.includes(input.tier) ? input.tier : 'episodic';
  const d = TIER_DEFAULTS[tier];
  const scope = SCOPES.includes(input.scope) ? input.scope : 'workspace';
  const content = String(input.content ?? '').trim();
  const now = ts;
  const time = normalizeTime(input.time, now);
  const review = REVIEW_STATUSES.includes(input.review_status) ? input.review_status : 'accepted';
  const validity = VALIDITIES.includes(input.validity) ? input.validity : 'current';
  const sessionId = scope === 'session' ? (input.session_id ?? ctx.sessionId ?? null) : null;
  const verification = {
    method: input.verification && input.verification.method ? input.verification.method : null,
    actor: input.verification && input.verification.actor != null ? input.verification.actor : null,
    at: input.verification && input.verification.at ? input.verification.at : (input.verification && input.verification.method ? now : null),
    note: input.verification && input.verification.note ? input.verification.note : null,
  };
  return {
    id: input.id || newId('mem'),
    content,
    content_hash: sha256Text(content),
    content_revision: Number(input.content_revision) || 1,
    tier,
    scope,
    state: input.state || 'active',
    review_status: review,
    validity,
    namespace: {
      owner_id: (input.namespace && input.namespace.owner_id) || input.owner_id || ctx.ownerId || OWNER_ID,
      workspace_id: (input.namespace && input.namespace.workspace_id) || input.workspace_id || ctx.workspaceId || null,
      session_id: sessionId,
    },
    evidence_ids: Array.isArray(input.evidence_ids) ? [...new Set(input.evidence_ids)] : [],
    time,
    verification,
    confidence: clampNum(input.confidence ?? d.confidence, 0, 1),
    strength: clampNum(input.strength ?? d.strength, 0, 1),
    decay_rate: clampNum(input.decay_rate ?? d.decay_rate, 0.0001, 1),
    recall_count: Number(input.recall_count) || 0,
    last_accessed: input.last_accessed || now,
    last_decay_at: input.last_decay_at || now,
    created_at: input.created_at || now,
    updated_at: now,
    protected: Boolean(input.protected),
    utility: { hits: 0, misses: 0, score: 0, last_note: null, ...(input.utility || {}) },
    tags: unique(input.tags || []),
    supersedes: unique(input.supersedes || []),
    superseded_by: input.superseded_by || null,
    conflicts_with: unique(input.conflicts_with || []),
    merged_from: unique(input.merged_from || []),
    derived_from: unique(input.derived_from || []),
    variants: Array.isArray(input.variants) ? input.variants : [],
    revisions: Array.isArray(input.revisions) ? input.revisions : [],
    source: input.source || 'user',
    needs_synthesis: Boolean(input.needs_synthesis),
    domain: DOMAINS.includes(input.domain) ? input.domain : 'factual',
    affect_at_write: input.affect_at_write || null,
    persona_fp: input.persona_fp || null,
    proposal: input.proposal ? clone(input.proposal) : null,
    review: input.review ? clone(input.review) : { history: [] },
    meta: { session: input.session ?? input.session_id ?? null, ...(input.meta || {}) },
    // 瞬态：嵌入缓存，save 前剥离。
    _vec: Array.isArray(input.embedding) && input.embedding.length ? input.embedding : null,
  };
}

function clampNum(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Number(Math.min(hi, Math.max(lo, n)).toFixed(4));
}

function unique(arr) {
  return [...new Set((arr || []).filter((x) => x !== undefined && x !== null && x !== ''))];
}

export function makeEvidence(input = {}, ctx = {}) {
  const ts = ctx.now || nowIso();
  const text = String(input.text ?? '');
  return {
    id: input.id || newId('ev'),
    kind: EVIDENCE_KINDS.includes(input.kind) ? input.kind : 'manual',
    actor: ACTORS.includes(input.actor) ? input.actor : 'unknown',
    subject: input.subject || null,
    session_id: input.session_id ?? (ctx.sessionId || null),
    message_id: input.message_id ?? null,
    captured_at: input.captured_at || ts,
    occurred_at: input.occurred_at || null,
    text,
    content_hash: sha256Text(text),
    locator: input.locator || null,
    meta: input.meta || {},
  };
}

export function evidenceExists(store, id) {
  return Boolean((store.evidence || []).find((e) => e.id === id));
}

export function findAnyRecord(store, id) {
  return (store.records || []).find((r) => r.id === id)
    || (store.archive || []).find((r) => r.id === id)
    || null;
}

// 只读兼容视图：v1 数据在内存里转换成 v2 形状，绝不写回。写操作必须先 migrate。
export function viewV2(doc, { ownerId = OWNER_ID, workspaceId = null, now = nowIso() } = {}) {
  if (!doc || typeof doc !== 'object') {
    throw new PsmError(CODES.SCHEMA_INVALID, '主库内容不是对象', {});
  }
  const version = Number(doc.version) || 1;
  if (version === SCHEMA_VERSION) return normalizeStore(doc, { ownerId, workspaceId });
  if (version !== 1) {
    throw new PsmError(CODES.VERSION_UNSUPPORTED, `不支持的库版本：${version}`, { version });
  }
  return migrateV1ToV2(doc, {
    ownerId,
    workspaceId: workspaceId || doc.identity?.workspace_id || 'ws_unmigrated_view',
    now,
    viewOnly: true,
  }).doc;
}

export function normalizeStore(doc, { ownerId = OWNER_ID, workspaceId = null } = {}) {
  const base = emptyStore({ ownerId, workspaceId: workspaceId || newWorkspaceId() });
  const src = doc && typeof doc === 'object' ? doc : {};
  const out = {
    ...base,
    ...src,
    version: SCHEMA_VERSION,
    revision: Number.isInteger(src.revision) ? src.revision : 0,
    identity: {
      owner_id: (src.identity && src.identity.owner_id) || ownerId,
      workspace_id: (src.identity && src.identity.workspace_id) || workspaceId || base.identity.workspace_id,
    },
    config: mergeConfig(base.config, src.config),
    records: Array.isArray(src.records) ? src.records : [],
    archive: Array.isArray(src.archive) ? src.archive : [],
    conflicts: Array.isArray(src.conflicts) ? src.conflicts : [],
    evidence: Array.isArray(src.evidence) ? src.evidence : [],
    operations: Array.isArray(src.operations) ? src.operations : [],
    migrations: Array.isArray(src.migrations) ? src.migrations : [],
    log: Array.isArray(src.log) ? src.log : [],
    captures: {
      cursors: (src.captures && src.captures.cursors) || {},
      receipts: (src.captures && src.captures.receipts) || {},
    },
    sessions: { count: 0, last_end: null, processed: [], ...(src.sessions || {}) },
    persona: {
      observations: 0,
      updated_at: base.created_at,
      traits: {},
      versions: [],
      candidates: [],
      ...(src.persona || {}),
    },
    impression: src.impression && Array.isArray(src.impression.items) ? src.impression : { items: [] },
    feedback_receipts: src.feedback_receipts && typeof src.feedback_receipts === 'object' ? src.feedback_receipts : {},
  };
  delete out._vec;
  if (!out.persona.card || typeof out.persona.card !== 'object') out.persona.card = { text: '', updated_at: null, note: null };
  if (!Array.isArray(out.persona.versions)) out.persona.versions = [];
  if (!Array.isArray(out.persona.candidates)) out.persona.candidates = [];
  if (!Array.isArray(out.sessions.processed)) out.sessions.processed = [];
  return out;
}

export function validateStore(doc, { allowVectors = false } = {}) {
  const bad = (msg, detail = {}) => {
    throw new PsmError(CODES.SCHEMA_INVALID, `主库结构不合法：${msg}`, detail);
  };
  if (!doc || typeof doc !== 'object') bad('不是对象');
  if (doc.version !== SCHEMA_VERSION) bad(`version 应为 ${SCHEMA_VERSION}，实际 ${doc.version}`);
  if (!Number.isInteger(doc.revision) || doc.revision < 0) bad('revision 必须是非负整数');
  if (!doc.identity || !doc.identity.owner_id || !doc.identity.workspace_id) bad('identity 缺少 owner_id/workspace_id');
  for (const key of ['records', 'archive', 'conflicts', 'evidence', 'operations', 'log']) {
    if (!Array.isArray(doc[key])) bad(`${key} 必须是数组`);
  }
  if (!doc.captures || typeof doc.captures !== 'object') bad('captures 缺失');
  if (!doc.captures.cursors || typeof doc.captures.cursors !== 'object') bad('captures.cursors 缺失');
  const ids = new Set();
  for (const [arrName, arr] of [['records', doc.records], ['archive', doc.archive]]) {
    arr.forEach((r, i) => {
      if (!r || typeof r !== 'object') bad(`${arrName}[${i}] 不是对象`);
      if (!r.id || typeof r.id !== 'string') bad(`${arrName}[${i}] 缺少 id`);
      if (ids.has(r.id)) bad(`记录 id 重复：${r.id}`, { id: r.id });
      ids.add(r.id);
      if (typeof r.content !== 'string') bad(`${arrName}[${i}] content 必须是字符串`, { id: r.id });
      if (!TIERS.includes(r.tier)) bad(`${arrName}[${i}] tier 无效：${r.tier}`, { id: r.id });
      if (!SCOPES.includes(r.scope)) bad(`${arrName}[${i}] scope 无效：${r.scope}`, { id: r.id });
      if (!REVIEW_STATUSES.includes(r.review_status)) bad(`${arrName}[${i}] review_status 无效`, { id: r.id });
      if (!VALIDITIES.includes(r.validity)) bad(`${arrName}[${i}] validity 无效`, { id: r.id });
      if (!r.namespace || !r.namespace.owner_id) bad(`${arrName}[${i}] namespace 缺失`, { id: r.id });
      if (r.scope === 'session' && !r.namespace.session_id) bad(`${arrName}[${i}] session 记录缺少 session_id`, { id: r.id });
      if (!r.time || typeof r.time !== 'object') bad(`${arrName}[${i}] time 缺失`, { id: r.id });
      if (!allowVectors && r._vec !== undefined && r._vec !== null) bad(`${arrName}[${i}] 主库不得包含瞬态 _vec`, { id: r.id });
      if (typeof r.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.content_hash)) bad(`${arrName}[${i}] content_hash 无效`, { id: r.id });
      if (!Number.isFinite(Number(r.strength)) || Number(r.strength) < 0 || Number(r.strength) > 1) bad(`${arrName}[${i}] strength 越界`, { id: r.id });
      if (!Number.isFinite(Number(r.confidence)) || Number(r.confidence) < 0 || Number(r.confidence) > 1) bad(`${arrName}[${i}] confidence 越界`, { id: r.id });
    });
  }
  for (const e of doc.evidence) {
    if (!e.id || typeof e.text !== 'string' || !/^[0-9a-f]{64}$/.test(String(e.content_hash || ''))) {
      bad('证据结构不合法', { id: e && e.id });
    }
  }
  return doc;
}

// ---------------------------------------------------------------- v1 → v2

function legacyEvidence(rec, now) {
  const text = String(rec.content ?? '');
  return makeEvidence({
    id: `ev_legacy_${sha256Text(`v1:${rec.id}`).slice(0, 24)}`,
    kind: 'legacy_record',
    actor: 'unknown',
    captured_at: now,
    text,
    locator: `legacy:v1:records:${rec.id}`,
  });
}

function hasSessionId(rec) {
  const candidates = [rec?.meta?.session, rec?.session, rec?.session_id];
  return candidates.some((x) => typeof x === 'string' && x.trim() && x !== 'default');
}

function mapLegacyRecord(rec, { now, workspaceId, ownerId, evidences }) {
  const content = String(rec.content ?? '').trim();
  const scope = SCOPES.includes(rec.scope) ? rec.scope : 'workspace';
  const demoted = Boolean(rec.demoted);
  const candidate = Boolean(rec.needs_synthesis);
  const review = candidate ? 'candidate' : 'accepted';
  const validity = demoted ? 'superseded' : 'current';
  const sessionFromLegacy = rec?.meta?.session || rec?.session;
  let sessionId = scope === 'session' ? sessionFromLegacy : null;
  let legacyUnknown = false;
  if (scope === 'session' && (!sessionId || String(sessionId) === 'default')) {
    // 旧 session 记录缺会话 ID：隔离为 legacy_unknown，不进入普通会话查询。
    sessionId = 'legacy_unknown';
    legacyUnknown = true;
  }
  const ev = legacyEvidence({ ...rec, content }, now);
  evidences.push(ev);
  return {
    id: rec.id,
    content,
    content_hash: sha256Text(content),
    content_revision: 1,
    tier: TIERS.includes(rec.tier) ? rec.tier : 'episodic',
    scope,
    state: rec.state || 'active',
    review_status: review,
    validity,
    namespace: {
      owner_id: ownerId,
      workspace_id: workspaceId,
      session_id: sessionId || null,
    },
    evidence_ids: [ev.id],
    time: { occurred_at: null, valid_from: null, valid_to: null },
    verification: {
      method: 'legacy_import',
      actor: 'unknown',
      at: now,
      note: 'v1 迁移：来源无法确定；未编造原始会话文本',
    },
    confidence: clampNum(rec.confidence ?? 0.6, 0, 1),
    strength: clampNum(rec.strength ?? 0.6, 0, 1),
    decay_rate: clampNum(rec.decay_rate ?? 0.05, 0.0001, 1),
    recall_count: Number(rec.recall_count) || 0,
    last_accessed: rec.last_accessed || rec.created_at || now,
    last_decay_at: rec.last_decay_at || rec.created_at || now,
    created_at: rec.created_at || now,
    updated_at: now,
    protected: Boolean(rec.protected),
    utility: { hits: 0, misses: 0, score: 0, last_note: null, ...(rec.utility || {}) },
    tags: unique(rec.tags || []),
    supersedes: unique(rec.supersedes || []),
    superseded_by: rec.superseded_by || null,
    conflicts_with: unique(rec.conflicts_with || []),
    merged_from: unique(rec.merged_from || []),
    derived_from: unique(rec.derived_from || []),
    variants: Array.isArray(rec.variants) ? rec.variants : [],
    revisions: [],
    source: rec.source || 'legacy',
    needs_synthesis: candidate,
    domain: DOMAINS.includes(rec.domain) ? rec.domain : 'factual',
    affect_at_write: rec.affect_at_write || null,
    persona_fp: rec.persona_fp || null,
    proposal: null,
    review: {
      history: [{
        at: now, action: 'legacy_import', actor: 'system', note: candidate ? 'needs_synthesis → candidate' : 'v1 普通条目 → accepted',
      }],
    },
    meta: {
      ...(rec.meta || {}),
      session: sessionFromLegacy ?? null,
      legacy: {
        from_version: 1,
        needs_synthesis: candidate,
        demoted,
        unknown_session: legacyUnknown,
      },
    },
    ...(legacyUnknown ? { legacy_unknown_session: true } : {}),
  };
}

export function migrateV1ToV2(v1, { ownerId = OWNER_ID, workspaceId = null, now = nowIso(), viewOnly = false } = {}) {
  const src = v1 && typeof v1 === 'object' ? v1 : {};
  const ws = workspaceId || (src.identity && src.identity.workspace_id) || newWorkspaceId();
  const evidences = [];
  const records = (src.records || []).map((r) => mapLegacyRecord(r, { now, workspaceId: ws, ownerId, evidences }));
  const archive = (src.archive || []).map((r) => mapLegacyRecord(r, { now, workspaceId: ws, ownerId, evidences }));
  const conflicts = (src.conflicts || []).map((c) => ({
    id: c.id || newId('cfl'),
    a: c.a,
    b: c.b,
    reason: c.reason || 'legacy_conflict',
    status: c.status || 'open',
    created_at: c.created_at || now,
    resolved_at: c.resolved_at || null,
    resolution: c.resolution || null,
    note: c.note || null,
    // 无法确定哪方有效：标注 legacy ambiguity，不自动裁决。
    legacy_ambiguity: c.status !== 'resolved',
  }));
  const base = emptyStore({ ownerId, workspaceId: ws });
  base.created_at = src.created_at || now;
  base.updated_at = now;
  base.config = mergeConfig(base.config, src.config);
  base.records = records;
  base.archive = archive;
  base.conflicts = conflicts;
  base.evidence = evidences;
  base.sessions = { count: 0, last_end: null, processed: [], ...(src.sessions || {}) };
  base.persona = {
    observations: 0,
    updated_at: now,
    traits: {},
    versions: [],
    candidates: [],
    ...(src.persona || {}),
    card: src.persona && src.persona.card ? src.persona.card : { text: '', updated_at: null, note: null },
    // 含混 traits 原样保留，不擅自重新归类；标 legacy 供 UI 说明。
    legacy: true,
  };
  base.impression = src.impression && Array.isArray(src.impression.items) ? src.impression : { items: [] };
  // 旧 log 原样保留，不截断、不重写历史；明确说明无法补回 operations。
  base.log = Array.isArray(src.log) ? src.log : [];
  base.operations = [];
  base.revision = 0;
  const report = {
    from: 1,
    to: 2,
    at: now,
    view_only: viewOnly,
    records: records.length,
    archive: archive.length,
    evidence_created: evidences.length,
    conflicts: conflicts.length,
    legacy_ambiguity: conflicts.filter((c) => c.legacy_ambiguity).length,
    candidate_from_needs_synthesis: records.filter((r) => r.review_status === 'candidate').length,
    session_unknown_isolated: records.filter((r) => r.legacy_unknown_session).length,
    notes: [
      '普通旧条目映射 accepted；needs_synthesis 映射 candidate；demoted 映射 superseded。',
      '旧条目来源缺失：建立 legacy_record 证据（actor=unknown），未编造原始会话文本。',
      '旧 created_at 保留为 created_at；occurred_at/valid_from/valid_to 全部为 null。',
      '旧 log 原样保留；v2 operations 从迁移后开始记录，无法补回历史。',
      '旧 color 配置值原样保留（迁移不改用户显式配置）。',
    ],
  };
  if (!viewOnly) {
    base.migrations = [{ from: 1, to: 2, at: now, report: clone(report) }];
  }
  return { doc: base, report };
}

export { clone };
