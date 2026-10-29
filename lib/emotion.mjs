// lib/emotion.mjs — 语料驱动的情绪向量（嵌入空间，不是模型激活）。
//
// 为什么要说清楚这一层：这是 bge-m3 语义空间里的方向，不是主模型残差流里的方向。
// 它能做：给文本打情绪标签、按情绪检索、给卡片/提示词提供"当前情绪"读数。
// 它不能做：直接调节生成时的激活。后者需要白盒模型，本机做不到。
//
// 算法（语料 → 向量）：
//   1. 每个情绪取若干种子短语，逐条嵌入；
//   2. 均值 → L2 归一化 = 该情绪的向量（质心）；
//   3. 派生两个连续轴：valence（愉悦−不满）、arousal（兴奋−平静），同样归一化。
// 换嵌入模型必须重建（embeddings 的 model 字段会记录并校验）。

import fs from 'node:fs';
import path from 'node:path';
import { round, nowIso, readJson } from './util.mjs';

export function l2norm(vec) {
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / n);
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function centroid(vectors) {
  const list = (vectors || []).filter((v) => Array.isArray(v) && v.length);
  if (!list.length) return null;
  const dim = list[0].length;
  const out = new Array(dim).fill(0);
  for (const v of list) {
    if (v.length !== dim) throw new Error(`维度不一致：${v.length} vs ${dim}`);
    for (let i = 0; i < dim; i += 1) out[i] += v[i];
  }
  return out.map((x) => x / list.length);
}

export function subtract(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  return a.map((x, i) => x - b[i]);
}

// 语料 → 模型。embed 是 (text) => Promise<number[]>，注入以便离线测试。
export async function buildModel({ corpus, embed, model = null }) {
  const emotions = (corpus && corpus.emotions) || {};
  const names = Object.keys(emotions);
  if (!names.length) throw new Error('语料里没有任何情绪');
  const out = {};
  const meta = {};
  for (const name of names) {
    const seeds = (emotions[name] || []).map((s) => String(s).trim()).filter(Boolean);
    if (!seeds.length) continue;
    const vecs = [];
    for (const s of seeds) {
      // eslint-disable-next-line no-await-in-loop
      const v = await embed(s);
      if (Array.isArray(v) && v.length) vecs.push(v);
    }
    if (!vecs.length) continue;
    out[name] = l2norm(centroid(vecs));
    meta[name] = { seeds: seeds.length, dim: out[name].length };
  }
  if (!Object.keys(out).length) throw new Error('所有情绪的种子都嵌入失败（嵌入服务是否在跑？）');

  // 派生连续轴：有对应情绪才算，缺了就跳过。
  const axes = {};
  const valPos = centroid([out['愉悦'], out['兴奋']].filter(Boolean));
  const valNeg = centroid([out['低落'], out['不满']].filter(Boolean));
  if (valPos && valNeg) axes.valence = l2norm(subtract(valPos, valNeg));
  const aroHi = centroid([out['兴奋'], out['紧绷']].filter(Boolean));
  const aroLo = centroid([out['平静'], out['低落']].filter(Boolean));
  if (aroHi && aroLo) axes.arousal = l2norm(subtract(aroHi, aroLo));

  return {
    version: 1,
    model,
    dim: Object.values(out)[0].length,
    built_at: nowIso(),
    emotions: out,
    axes,
    meta,
  };
}

// 给一段文本向量打分：返回按余弦降序的情绪列表。
export function classify(model, vector, limit = 3) {
  const scores = Object.entries((model && model.emotions) || {}).map(([name, vec]) => ({
    emotion: name,
    score: round(cosine(vector, vec), 4),
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, Math.max(1, limit));
}

// 连续读数：valence ∈ [-1,1]（负=不悦，正=愉悦），arousal ∈ [-1,1]（正=亢奋）。
export function readAxes(model, vector) {
  const axes = (model && model.axes) || {};
  const out = {};
  if (axes.valence) out.valence = round(cosine(vector, axes.valence), 4);
  if (axes.arousal) out.arousal = round(cosine(vector, axes.arousal), 4);
  return out;
}

export function emotionsPath(root) {
  return path.join(String(root), 'memory', 'emotions.json');
}

// 当前情绪状态放在**库根**而不是 memory/：它每轮都可能被改写，
// 而 memory/ 在沙箱里可能不可写；根目录通常可写。
export function statePath(root) {
  return path.join(String(root), 'emotion-state.json');
}

// 多会话状态：{ active, sessions: { <sessionId>: state } }。
// 单会话的老文件（emotion-state.json）仍然能读，做向后兼容。
export function statesPath(root) {
  return path.join(String(root), 'emotion-states.json');
}

export function loadStates(root) {
  const doc = readJson(statesPath(root), null);
  if (!doc || typeof doc !== 'object' || !doc.sessions || typeof doc.sessions !== 'object') {
    return { version: 1, active: null, sessions: {} };
  }
  return { version: 1, active: doc.active || null, sessions: doc.sessions };
}

export function saveStates(root, doc) {
  const file = statesPath(root);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return file;
}

export const DEFAULT_SESSION = 'default';

// 环境里的会话 id（命令由 harness 注入）。插件进程里通常没有，会退回 active。
export function envSession() {
  const v = process.env.DSH_SESSION_ID;
  return v && String(v).trim() ? String(v).trim() : null;
}

// 选状态：env 里的会话 id 优先且**严格**——该会话没有状态就是没有，
// 绝不借用别人的情绪（借用正是"两个对话互相串"的根源）。
export function selectState(doc, envKey = null) {
  if (!doc || !doc.sessions || !Object.keys(doc.sessions).length) {
    return { state: null, picked: null, reason: 'legacy' };
  }
  const key = envKey ? String(envKey) : '';
  if (key && doc.sessions[key]) return { state: doc.sessions[key], picked: key, reason: 'session' };
  if (key) return { state: null, picked: null, reason: 'session-empty' };
  if (doc.active && doc.sessions[doc.active]) return { state: doc.sessions[doc.active], picked: doc.active, reason: 'active' };
  return { state: null, picked: null, reason: 'empty' };
}

export function activeKey(root) {
  return loadStates(root).active;
}

// 读某个会话的状态；不传 session 时按 env → active 的顺序，再退回老的单文件。
export function loadState(root, session = null) {
  const doc = loadStates(root);
  if (session) return doc.sessions[session] ? { ...doc.sessions[session], _session: session } : null;
  const picked = selectState(doc, envSession());
  if (picked.state) return { ...picked.state, _session: picked.picked };
  // 向后兼容：老的单状态文件（还没有多会话记录时）
  if (picked.reason === 'legacy') return readJson(statePath(root), null);
  return null;
}

// 删除某个会话的情绪状态（测试残留、误写都会用到）。active 被删时自动指向剩下的第一个。
export function forgetSession(root, key) {
  const doc = loadStates(root);
  const k = String(key || '').trim();
  if (!k || !doc.sessions[k]) return { status: 'not_found', key: k, sessions: Object.keys(doc.sessions) };
  delete doc.sessions[k];
  if (doc.active === k) doc.active = Object.keys(doc.sessions)[0] || null;
  saveStates(root, doc);
  // 单文件镜像跟着 active 走；没有 active 就删掉，避免读到已删除会话的状态。
  try {
    const activeState = doc.active ? doc.sessions[doc.active] : null;
    if (activeState) fs.writeFileSync(statePath(root), `${JSON.stringify(activeState, null, 2)}\n`, 'utf8');
    else fs.rmSync(statePath(root), { force: true });
  } catch { /* 镜像写不了不影响主流程 */ }
  return { status: 'ok', key: k, active: doc.active, remaining: Object.keys(doc.sessions).length };
}

// 写入某个会话的状态并把它设为 active。同时写一份老格式的单文件，
// 让"只认得旧文件"的读者（旧插件版本）不至于完全失效。
export function saveState(root, state, session = null) {
  const doc = loadStates(root);
  const key = session || state.session || envSession() || doc.active || DEFAULT_SESSION;
  doc.sessions[key] = { ...state, session: key };
  doc.active = key;
  const file = saveStates(root, doc);
  try {
    fs.writeFileSync(statePath(root), `${JSON.stringify(doc.sessions[key], null, 2)}\n`, 'utf8');
  } catch { /* 老路径写不了不影响主流程 */ }
  return file;
}

export function loadRules(root) {
  return readJson(path.join(String(root), 'docs', 'emotion-rules.json'), null);
}

// 信度闸：短句、指令句、中性句的分类分数会挤在一起，argmax 等于噪声。
// 只有"最高分够高"且"与第二名拉开差距"才采信；否则视为中性，不注入情绪行。
export function acceptEmotion(root, scores) {
  const rules = loadRules(root) || {};
  const minScore = Number(rules.min_score ?? 0.6);
  const minMargin = Number(rules.min_margin ?? 0.05);
  if (!Array.isArray(scores) || !scores.length) return false;
  const top = Number(scores[0].score);
  const second = Number(scores[1] ? scores[1].score : 0);
  if (!Number.isFinite(top)) return false;
  return top >= minScore && (top - second) >= minMargin;
}

// 松弛参数：负面退得快（tau 小），正面退得慢；掉到 display_min 以下退回基线。
export function relaxParams(root) {
  const rules = loadRules(root) || {};
  const r = rules.relax || {};
  return {
    negTau: Math.max(1, Number(r.negative_tau_min ?? 12)),
    posTau: Math.max(1, Number(r.positive_tau_min ?? 60)),
    displayMin: Math.min(1, Math.max(0, Number(r.display_min ?? 0.3))),
    hardExpire: Math.max(1, Number(r.hard_expire_min ?? 240)),
    baseline: String(r.baseline || '平静偏轻快'),
    baselineHint: String(r.baseline_hint || '按常态发挥'),
  };
}

export function isNegative(root, emotion) {
  const rules = loadRules(root);
  const list = (rules && rules.negative) || ['紧绷', '不满', '低落'];
  return Array.isArray(list) && list.includes(emotion);
}

// 人格的"负面情绪阈值"：越高越难起负面情绪（读 traits，缺省取 rules.disposition.default）。
export function negativeThreshold(root, store) {
  const rules = loadRules(root);
  const disp = (rules && rules.disposition) || {};
  const trait = (store && store.persona && store.persona.traits && store.persona.traits[disp.trait || 'style.negative_threshold']) || null;
  const v = trait && trait.kind === 'numeric' ? Number(trait.value) : NaN;
  if (Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  const d = Number(disp.default ?? 0.7);
  return Number.isFinite(d) ? Math.min(1, Math.max(0, d)) : 0.7;
}

// 对方情绪为负、且人格阈值够高时，追加一句"不承接负面"的抑制语。
// 情绪已回落到基线就不再追加（那时已经不需要收敛了）。
export function dampingLine(root, store, session = null) {
  const snap = emotionStateAt(root, Date.now(), session);
  if (!snap || !snap.line || snap.faded) return '';
  if (!isNegative(root, snap.original)) return '';
  const rules = loadRules(root);
  const disp = (rules && rules.disposition) || {};
  const min = Number(disp.min ?? 0.5);
  if (negativeThreshold(root, store) < min) return '';
  return String(disp.damping_line || '');
}

// 随时间松弛后的情绪快照：强度 = score · exp(−age/tau)，tau 按正负取（负面更快退）。
// 强度低于 display_min → 退回基线（中性偏正向）；超过 hard_expire → 整行消失。
export function emotionStateAt(root, now = Date.now(), session = null) {
  const state = loadState(root, session);
  const p = relaxParams(root);
  if (!state || !state.emotion) {
    return { line: null, reason: 'none', ageMin: null, intensity: 0, faded: false, label: p.baseline, params: p };
  }
  const at = Date.parse(state.at);
  if (!Number.isFinite(at)) {
    return { line: null, reason: 'bad-time', ageMin: null, intensity: 0, faded: false, label: p.baseline, params: p };
  }
  const ageMin = Math.max(0, (now - at) / 60000);
  if (ageMin > p.hardExpire) {
    return { line: null, reason: 'expired', ageMin: Math.round(ageMin * 10) / 10, intensity: 0, faded: false, label: p.baseline, params: p };
  }
  const neg = isNegative(root, state.emotion);
  const tau = neg ? p.negTau : p.posTau;
  const raw = Number(state.score);
  const score = Number.isFinite(raw) ? raw : 0;
  const intensity = score * Math.exp(-ageMin / tau);
  const faded = intensity < p.displayMin;
  const rules = loadRules(root) || {};
  const axes = state.axes || {};
  const bits = [];
  if (Number.isFinite(axes.valence)) bits.push(`valence ${axes.valence > 0 ? '+' : ''}${axes.valence.toFixed(2)}`);
  if (Number.isFinite(axes.arousal)) bits.push(`arousal ${axes.arousal > 0 ? '+' : ''}${axes.arousal.toFixed(2)}`);
  const when = ageMin < 1 ? '刚刚' : `${Math.round(ageMin)} 分钟前`;

  let line;
  if (faded) {
    line = `【当前情绪】${p.baseline}（由 ${state.emotion} 回落；${when}）${p.baselineHint ? `：${p.baselineHint}` : ''}`;
  } else {
    const hint = (rules.rules && rules.rules[state.emotion]) || '';
    const meta = [...bits, when].filter(Boolean).join('，');
    line = `【当前情绪】${state.emotion}（强度 ${intensity.toFixed(2)}，${meta}）${hint ? `：${hint}` : ''}`;
  }
  return {
    line,
    reason: 'ok',
    ageMin: Math.round(ageMin * 10) / 10,
    intensity: Math.round(intensity * 1000) / 1000,
    faded,
    label: faded ? p.baseline : state.emotion,
    original: state.emotion,
    neg,
    tau,
    axes,
    params: p,
  };
}

export function emotionLine(root, now = Date.now(), session = null) {
  return emotionStateAt(root, now, session).line;
}

export function loadModel(root) {
  return readJson(emotionsPath(root), null);
}

export function saveModel(root, model) {
  const file = emotionsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  return file;
}
