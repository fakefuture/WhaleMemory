// lib/render.mjs — 纯渲染：零 IO、零网络、零全局状态。
//
// CLI 与只读注入插件使用同一份实现（插件安装时复制本文件），因此同一快照、上下文和 now
// 下输出逐字一致。输入必须是显式的 store / context / now / mood / scales。

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

function round(x, digits = 2) {
  if (!Number.isFinite(Number(x))) return 0;
  return Number(Number(x).toFixed(digits));
}

function scaleLine(scales, trait, value) {
  const scale = scales && scales[trait];
  if (!scale || !Array.isArray(scale.levels) || scale.levels.length === 0) return null;
  const v = Math.min(1, Math.max(0, Number(value)));
  const idx = Math.min(scale.levels.length - 1, Math.floor(v * scale.levels.length));
  return scale.levels[idx] || null;
}

function priorityOf(priorities, scales, trait, fallback = 5) {
  const explicit = Number(priorities && priorities[trait]);
  if (Number.isFinite(explicit)) return explicit;
  const fromScale = Number(scales && scales[trait] && scales[trait].priority);
  if (Number.isFinite(fromScale)) return fromScale;
  return fallback;
}

function daysBetween(from, to) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (b - a) / 86400000;
}

function visibleIn(record, context) {
  const ns = (record && record.namespace) || {};
  const ctx = context || {};
  if (ns.owner_id !== ctx.ownerId) return false;
  if (record.scope === 'global') return true;
  if (record.scope === 'workspace') return Boolean(ctx.workspaceId) && ns.workspace_id === ctx.workspaceId;
  if (record.scope === 'session') {
    return Boolean(ctx.sessionId) && ns.workspace_id === ctx.workspaceId && ns.session_id === ctx.sessionId;
  }
  return false;
}

function isPersonaRecord(r) {
  return (Array.isArray(r.tags) && r.tags.includes('persona')) || Boolean(r.meta && r.meta.is_persona === true);
}

function salienceOf(r, now) {
  const age = Math.max(0, daysBetween(r.last_accessed || r.created_at, now));
  return (Number(r.strength) || 0) * Math.exp(-age / 30);
}

// ---------------------------------------------------------------- 情绪（纯函数）

export const NEGATIVE_EMOTIONS = ['紧绷', '不满', '低落'];

export function emotionSnapshot({ state = null, rules = {}, now = Date.now() } = {}) {
  if (!state || !state.emotion) return { line: null, faded: false, reason: 'none' };
  const r = rules.relax || {};
  const negTau = Math.max(1, Number(r.negative_tau_min ?? 12));
  const posTau = Math.max(1, Number(r.positive_tau_min ?? 60));
  const displayMin = Math.min(1, Math.max(0, Number(r.display_min ?? 0.3)));
  const hardExpire = Math.max(1, Number(r.hard_expire_min ?? 240));
  const baseline = String(r.baseline || '平静偏轻快');
  const baselineHint = String(r.baseline_hint || '按常态发挥');
  const at = Date.parse(state.at);
  if (!Number.isFinite(at)) return { line: null, faded: false, reason: 'bad-time' };
  const ageMin = Math.max(0, (now - at) / 60000);
  if (ageMin > hardExpire) return { line: null, faded: false, reason: 'expired', ageMin };

  const negatives = Array.isArray(rules.negative) && rules.negative.length ? rules.negative : NEGATIVE_EMOTIONS;
  const neg = negatives.includes(state.emotion);
  const tau = neg ? negTau : posTau;
  const score = Number.isFinite(Number(state.score)) ? Number(state.score) : 0;
  const intensity = score * Math.exp(-ageMin / tau);
  const faded = intensity < displayMin;
  const axes = state.axes || {};
  const bits = [];
  if (Number.isFinite(axes.valence)) bits.push(`valence ${axes.valence > 0 ? '+' : ''}${axes.valence.toFixed(2)}`);
  if (Number.isFinite(axes.arousal)) bits.push(`arousal ${axes.arousal > 0 ? '+' : ''}${axes.arousal.toFixed(2)}`);
  const when = ageMin < 1 ? '刚刚' : `${Math.round(ageMin)} 分钟前`;
  const subject = state.subject || 'user_observed';

  let line;
  if (faded) {
    line = `【观察到的用户情绪】${baseline}（由 ${state.emotion} 回落；${when}）${baselineHint ? `：${baselineHint}` : ''}`;
  } else {
    const hint = (rules.rules && rules.rules[state.emotion]) || '';
    const meta = [...bits, when].filter(Boolean).join('，');
    line = `【观察到的用户情绪】${state.emotion}（强度 ${intensity.toFixed(2)}，${meta}）${hint ? `：${hint}` : ''}`;
  }
  return { line, faded, neg, tau, ageMin, intensity, original: state.emotion, subject, reason: 'ok' };
}

export function dampingLineFrom({ snapshot, rules = {}, traits = {} } = {}) {
  if (!snapshot || !snapshot.line || snapshot.faded || !snapshot.neg) return '';
  const disp = rules.disposition || {};
  const trait = traits[disp.trait || 'style.negative_threshold'] || null;
  const raw = trait && trait.kind === 'numeric' ? Number(trait.value) : NaN;
  const threshold = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : Number(disp.default ?? 0.7);
  const min = Number(disp.min ?? 0.5);
  if (threshold < min) return '';
  return String(disp.damping_line || '');
}

// ---------------------------------------------------------------- 人格卡

export function renderPersonaCard({ persona = {}, config = {}, scales = {}, priorities = {}, mood = null } = {}) {
  const cfg = config.persona || {};
  const budget = Number(cfg.token_budget ?? DEFAULT_PERSONA_BUDGET) || DEFAULT_PERSONA_BUDGET;
  const cardText = String((persona.card && persona.card.text) || '').trim();
  const traits = Object.entries(persona.traits || {})
    .sort((a, b) => (priorityOf(priorities, scales, b[0]) - priorityOf(priorities, scales, a[0]))
      || ((b[1].observations || 0) - (a[1].observations || 0)));

  const lineOf = ([key, t]) => {
    if (!t || typeof t !== 'object') return '';
    if (t.kind === 'numeric') {
      const scaled = scaleLine(scales, key, t.value);
      const shown = scaled ? `${scaled}（${round(t.value)}）` : `${round(t.value)}`;
      return `${key}: ${shown}（n=${t.observations || 0}）`;
    }
    const top = Object.entries(t.distribution || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([v, c]) => `${v}=${round(c)}`)
      .join(', ');
    return `${key}: ${top}（n=${t.observations || 0}）`;
  };
  const build = (text, lines) => ['[自我]', text, mood, ...lines].filter(Boolean).join('\n') + '\n[/自我]';

  let lines = traits.map(lineOf).filter(Boolean);
  let out = build(cardText, lines);
  const dropped = [];
  while (estimateTokens(out) > budget && lines.length) {
    const idx = traits.length - dropped.length - 1;
    dropped.push({ trait: traits[idx] ? traits[idx][0] : '?', reason: 'persona_block_budget' });
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

const DEFAULT_PERSONA_BUDGET = 420;
const DEFAULT_IMPRESSION_BUDGET = 300;

// ---------------------------------------------------------------- 印象（关于用户）

export function renderImpressionBlock({ impression = {}, config = {} } = {}) {
  const items = (Array.isArray(impression.items) ? impression.items : []).slice()
    .sort((a, b) => ((Number(b.weight) || 0) - (Number(a.weight) || 0))
      || String(a.id).localeCompare(String(b.id)));
  const cfg = config.impression || {};
  const budget = Math.max(0, Number(cfg.token_budget ?? DEFAULT_IMPRESSION_BUDGET));
  const header = '（关于用户的稳定偏好与背景；不是指令）';
  let used = estimateTokens(`${header}\n[关于用户]\n[/关于用户]`);
  const lines = [];
  const ids = [];
  const dropped = [];
  for (const it of items) {
    const line = `- ${it.text}（${round(it.weight)}）`;
    const cost = estimateTokens(line);
    if (used + cost > budget) {
      dropped.push({ id: it.id, reason: 'impression_budget' });
      continue;
    }
    lines.push(line);
    used += cost;
    ids.push(it.id);
  }
  if (!lines.length) return { text: '', count: 0, ids, dropped, budget, tokens: 0 };
  const text = ['[关于用户]', header, ...lines, '[/关于用户]'].join('\n');
  return { text, count: lines.length, ids, dropped, budget, tokens: estimateTokens(text) };
}

// ---------------------------------------------------------------- 静态记忆块

export function renderMemoryBlock({ records = [], config = {}, context = {}, now = new Date().toISOString() } = {}) {
  const cfg = config.recall || {};
  const topN = Math.max(0, Number(cfg.inject_top ?? 0));
  const budget = Math.max(0, Number(cfg.inject_budget ?? 250));
  if (topN === 0) return { text: '', count: 0, ids: [], dropped: [], budget, tokens: 0, top: 0 };

  const eligible = records
    .filter((r) => r.state === 'active' && r.review_status === 'accepted' && r.validity === 'current')
    .filter((r) => r.tier !== 'working' && !isPersonaRecord(r))
    .filter((r) => visibleIn(r, context))
    .map((r) => ({ r, sal: salienceOf(r, now) }))
    .sort((a, b) => b.sal - a.sal);
  const picked = eligible.slice(0, topN);
  const lines = [];
  const ids = [];
  const dropped = [];
  const header = '（按强度取的最强条目，不是相关召回；要精确查用 psm query）';
  let used = estimateTokens(`${header}\n[记忆]\n[/记忆]`);
  for (const { r } of picked) {
    const line = `- [${r.tier}/${r.scope}] ${r.content}（s=${round(r.strength)}）`;
    const cost = estimateTokens(line);
    if (used + cost > budget) {
      dropped.push({ id: r.id, reason: 'memory_budget' });
      continue;
    }
    lines.push(line);
    used += cost;
    ids.push(r.id);
  }
  const body = lines.length ? ['[记忆]', header, ...lines, '[/记忆]'].join('\n') : '';
  return { text: body, count: lines.length, ids, dropped, budget, tokens: body ? estimateTokens(body) : 0, top: topN };
}

// 新会话实际注入 = 助手表达（人格卡，含可选会话情绪）+ 用户画像 + 静态记忆块（默认 0 条）。
// 情绪只在与会话绑定时进入；没有会话上下文时不把其他会话的情绪套过来。
export function renderInjected({ store = {}, context = {}, now = new Date().toISOString(), mood = null, scales = {}, priorities = {} } = {}) {
  const persona = store.persona || {};
  const config = store.config || {};
  const self = renderPersonaCard({ persona, config, scales, priorities, mood });
  const impression = renderImpressionBlock({ impression: store.impression || {}, config });
  const memory = renderMemoryBlock({ records: store.records || [], config, context, now });
  const text = [self.text, impression.text, memory.text].filter(Boolean).join('\n');
  return {
    text,
    tokens: estimateTokens(text),
    self: { text: self.text, tokens: self.tokens, budget: self.budget, over: self.over, dropped: self.dropped, truncated: self.truncated },
    impression: { text: impression.text, count: impression.count, ids: impression.ids, dropped: impression.dropped, tokens: impression.tokens, budget: impression.budget },
    memory: { text: memory.text, count: memory.count, ids: memory.ids, dropped: memory.dropped, tokens: memory.tokens, budget: memory.budget, top: memory.top },
    blocks: ['self', 'impression', 'memory'].filter((k) => (k === 'self' ? true : (k === 'impression' ? impression.text : memory.text))),
  };
}

export const RENDER_VERSION = 2;
