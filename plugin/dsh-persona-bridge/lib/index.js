// dsh-persona-bridge — 只读地把 PSM 记忆库渲染成 system-prompt 段落。
//
// 设计约束：
//   1. 只读：读 memory/store.json、docs/*.json、情绪状态文件；不写库、不联网、不起子进程。
//   2. 不抛错：库缺失/JSON 损坏/字段缺失时返回空串，绝不让宿主装配失败。
//   3. 渲染复用 lib/render.mjs 的纯函数（安装时由 plugin/sync-render.mjs 复制，
//      verify-installed 会校验与仓库版本逐字节一致），保证与 CLI 同一快照、上下文、now 下逐字相同。
//   4. 没有会话上下文时不注入任何会话情绪，避免把别的对话情绪套过来。

import fs from 'node:fs';
import path from 'node:path';
import { renderInjected, emotionSnapshot, RENDER_VERSION } from './render.mjs';

export const name = 'psm-persona-bridge';
export const inject = ['systemPrompt'];
export { RENDER_VERSION, renderInjected };

const SECTION_NAME = 'psm:persona-card';
const DEFAULT_ROOT = process.env.PSM_ROOT || '';

let cache = { at: 0, root: '', key: '', text: '' };
let probeCache = { at: 0, key: '' };

function loadJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scaleInputs(root) {
  const doc = loadJson(path.join(String(root), 'docs', 'persona-scales.json'));
  const scales = (doc && doc.scales) || {};
  const priorities = (doc && doc.trait_priorities) || {};
  return { scales, priorities };
}

// 会话 id：显式参数 > 环境变量。没有就返回空，绝不回退到 active 会话以外的东西。
export function sessionIdOf(opts = {}) {
  if (opts.sessionId !== undefined && opts.sessionId !== null && String(opts.sessionId).trim()) {
    return String(opts.sessionId).trim();
  }
  const env = process.env.DSH_SESSION_ID ? String(process.env.DSH_SESSION_ID).trim() : '';
  return env || null;
}

function pickState(root, sessionId) {
  if (!sessionId) return { state: null, reason: 'no-session' };
  const doc = loadJson(path.join(String(root), 'emotion-states.json'));
  if (doc && doc.sessions && doc.sessions[sessionId]) {
    return { state: doc.sessions[sessionId], reason: 'session' };
  }
  return { state: null, reason: doc && doc.sessions ? 'session-empty' : 'no-states' };
}

function recordProbe(root, info) {
  const key = JSON.stringify(info);
  if (probeCache.key === key && Date.now() - probeCache.at < 60000) return;
  probeCache = { at: Date.now(), key };
  try {
    const dir = path.join(String(root), 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'plugin-probe.json');
    const prev = loadJson(file);
    const entries = Array.isArray(prev && prev.entries) ? prev.entries : [];
    entries.push({ at: new Date().toISOString(), ...info });
    fs.writeFileSync(file, `${JSON.stringify({ entries: entries.slice(-20) }, null, 2)}\n`, 'utf8');
  } catch { /* 写不了痕迹不影响渲染 */ }
}

function moodLine(root, sessionId, now) {
  const { state, reason } = pickState(root, sessionId);
  recordProbe(root, { env_session: sessionId, picked: state ? sessionId : null, reason, hooked: Boolean(state) });
  if (!state) return null;
  const rules = loadJson(path.join(String(root), 'docs', 'emotion-rules.json')) || {};
  const snap = emotionSnapshot({ state: { ...state, subject: state.subject || 'user_observed' }, rules, now });
  return snap.line || null;
}

/**
 * 纯渲染：同一 store/context/now 永远得到同一文本。
 * @param {object} store  v2 store 文档
 * @param {object} opts   { root, sessionId, now, mood }
 */
export function renderFor(store, opts = {}) {
  const root = String(opts.root || '');
  const sessionId = sessionIdOf(opts);
  const rawNow = opts.now !== undefined ? opts.now : Date.now();
  const nowMs = typeof rawNow === 'number' ? rawNow : (Number.isFinite(Date.parse(String(rawNow))) ? Date.parse(String(rawNow)) : Date.now());
  const now = new Date(nowMs).toISOString();
  const identity = (store && store.identity) || {};
  const context = {
    ownerId: identity.owner_id || 'local',
    workspaceId: identity.workspace_id || null,
    sessionId,
  };
  let mood = opts.mood !== undefined ? opts.mood : null;
  if (mood === null && root && sessionId) mood = moodLine(root, sessionId, nowMs);
  const { scales, priorities } = opts.scales
    ? { scales: opts.scales, priorities: opts.priorities || {} }
    : (root ? scaleInputs(root) : { scales: {}, priorities: {} });
  return renderInjected({ store, context, now, mood, scales, priorities });
}

export function renderInjectedFile(root, opts = {}) {
  const file = path.join(String(root), 'memory', 'store.json');
  const store = loadJson(file);
  if (!store) return '';
  try {
    return renderFor(store, { ...opts, root }).text;
  } catch {
    return '';
  }
}

// 兼容旧调用：只渲染人格卡。
export function renderCardFile(root, opts = {}) {
  const file = path.join(String(root), 'memory', 'store.json');
  const store = loadJson(file);
  if (!store) return '';
  return renderFor(store, { ...opts, root }).self.text;
}

export { renderCardFile as renderCard };

function orderFor(ctx) {
  try {
    const base = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX');
    if (Number.isFinite(base)) return base + 1;
  } catch { /* 拿不到就用固定值 */ }
  return 10500;
}

export function apply(ctx, config = {}) {
  const root = String((config && config.root) || process.env.PSM_ROOT || DEFAULT_ROOT);
  const ttl = Math.max(0, Number((config && config.cache_ms) ?? 1000) || 0);
  const sessionId = sessionIdOf(config || {});

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: orderFor(ctx),
    interpolate: false,
    text: () => {
      try {
        const now = Date.now();
        const key = `${sessionId || ''}`;
        if (cache.root === root && cache.key === key && now - cache.at < ttl) return cache.text;
        const rendered = renderInjectedFile(root, { sessionId, now });
        cache = { at: now, root, key, text: rendered };
        return rendered;
      } catch {
        return '';
      }
    },
  }), 'psm-persona-bridge.section()');
}
