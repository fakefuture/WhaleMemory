// lib/embed.mjs — 嵌入向量的传输与 v2 缓存。
//
// 边界：
//   - 只有这个文件会为了嵌入发起网络请求；不需要嵌入时整条链路走词面相似度。
//   - 缓存是缓存：主库 memory/store.json 是业务事实来源，缓存丢失/损坏不得导致记忆丢失。
//   - v2 缓存条目验证：content_hash、模型指纹、维度、有限数值、非零向量；正文改动后旧向量立即失效。
//   - 模型指纹含 provider/model/可用 digest；远端没给 digest 时 quality=weak，不声称能检测同名模型更新。

import path from 'node:path';
import { readJsonStrict, writeJsonAtomic, sha256Text } from './fsx.mjs';

export const VECTORS_REL = path.join('memory', 'embeddings.json');
export const VECTOR_CACHE_VERSION = 2;

export function vectorsPath(root) {
  return path.join(String(root), VECTORS_REL);
}

export function embedConfig(store) {
  const e = (store && store.config && store.config.embed) || {};
  const rawGpu = e.num_gpu;
  return {
    enabled: e.enabled === true,
    provider: e.provider === 'openai' ? 'openai' : 'ollama',
    url: String(e.url || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: String(e.model || 'bge-m3'),
    timeout_ms: Number(e.timeout_ms || 15000),
    // null = 不干预，交给后端决定；0 = 强制 CPU。
    num_gpu: rawGpu === null || rawGpu === undefined ? null : Number(rawGpu),
    // 可选：服务端能提供的模型 digest / 版本。没有就是 weak。
    digest: e.digest ? String(e.digest) : null,
  };
}

// 指纹覆盖 provider/model/digest 与端点：换端点或换模型都不会混用旧向量。
export function fingerprintOf(cfg) {
  const provider = cfg && cfg.provider === 'openai' ? 'openai' : 'ollama';
  const model = String((cfg && cfg.model) || 'bge-m3');
  const digest = cfg && cfg.digest ? String(cfg.digest) : null;
  const endpoint = String((cfg && cfg.url) || '').replace(/\/+$/, '');
  const endpointHash = sha256Text(endpoint).slice(0, 16);
  return {
    provider,
    model,
    digest,
    endpoint_hash: endpointHash,
    quality: digest ? 'strong' : 'weak',
    id: sha256Text(JSON.stringify({ provider, model, digest, endpointHash })).slice(0, 32),
  };
}

export function sameFingerprint(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return a.provider === b.provider
    && a.model === b.model
    && (a.digest || null) === (b.digest || null)
    && (a.endpoint_hash || null) === (b.endpoint_hash || null);
}

export function isValidVector(vec, dim = null) {
  if (!Array.isArray(vec) || vec.length === 0) return false;
  if (dim !== null && Number(dim) > 0 && vec.length !== Number(dim)) return false;
  let norm = 0;
  for (const x of vec) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return false;
    norm += x * x;
  }
  return norm > 0;
}

// ---------------------------------------------------------------- 传输

async function postJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`${url} 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(err) {
  const msg = String((err && err.message) || err);
  return /HTTP 5\d\d/.test(msg) || /fetch failed|ECONNRESET|socket hang up|ETIMEDOUT/i.test(msg);
}

async function withRetry(fn, attempts = 3, delayMs = 700) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// 单条嵌入。失败时抛出带原因的错误，由调用方决定降级还是中止。
export async function embedOne(cfg, text) {
  const input = String(text ?? '').trim();
  if (!input) throw new Error('空文本无法嵌入');
  return withRetry(async () => {
    if (cfg.provider === 'openai') {
      const json = await postJson(`${cfg.url}/v1/embeddings`, { model: cfg.model, input }, cfg.timeout_ms);
      const vec = json && json.data && json.data[0] ? json.data[0].embedding : null;
      if (!Array.isArray(vec)) throw new Error('响应里没有 data[0].embedding');
      return vec;
    }
    // Ollama 0.3x+ 用 /api/embed（批量，返回 embeddings 数组）；老版本只有 /api/embeddings。
    const body = { model: cfg.model, input };
    if (cfg.num_gpu !== null && Number.isFinite(cfg.num_gpu)) body.options = { num_gpu: cfg.num_gpu };
    const json = await postJson(`${cfg.url}/api/embed`, body, cfg.timeout_ms);
    const first = json && Array.isArray(json.embeddings) ? json.embeddings[0] : null;
    const legacy = json && json.embedding;
    const vec = Array.isArray(first) ? first : (Array.isArray(legacy) ? legacy : null);
    if (!Array.isArray(vec)) throw new Error('响应里没有 embeddings/embedding');
    return vec;
  });
}

// ---------------------------------------------------------------- 缓存

export function emptyCache(fingerprint, dim = null) {
  return {
    version: VECTOR_CACHE_VERSION,
    fingerprint,
    dim,
    built_at: new Date().toISOString(),
    entries: {},
  };
}

// 严格读取：文件不存在返回 null；内容损坏抛 JSON_INVALID（由调用方决定是否降级）。
export function loadVectors(root) {
  const doc = readJsonStrict(vectorsPath(root), { optional: true });
  if (!doc) return null;
  return doc;
}

// 非严格读取：损坏/缺失都当没有缓存，并把原因交给调用方展示。
export function safeLoadVectors(root) {
  try {
    return { doc: loadVectors(root), error: null };
  } catch (err) {
    return { doc: null, error: err && err.message ? err.message : String(err) };
  }
}

export function saveVectors(root, doc) {
  if (!doc || typeof doc !== 'object') throw new Error('saveVectors 需要缓存对象');
  writeJsonAtomic(vectorsPath(root), doc);
  return doc;
}

// 把缓存挂到记录上（瞬态字段 _vec，写主库前会剥掉）。
// 逐条验证：条目存在、正文哈希一致、模型指纹一致、维度一致、向量有限且非零。
// 返回 { attached, skipped, reasons, fingerprint }；旧版 v1 缓存整体忽略并提示重建。
export function attachVectors(store, doc, fingerprint) {
  const fp = typeof fingerprint === 'string' ? { id: fingerprint } : fingerprint;
  const out = { attached: 0, skipped: 0, reasons: {}, fingerprint: fp || null };
  const bump = (k) => { out.reasons[k] = (out.reasons[k] || 0) + 1; };
  if (!doc || doc.version !== VECTOR_CACHE_VERSION) {
    out.skipped = [...(store.records || []), ...(store.archive || [])].length;
    out.reasons.cache_version = out.skipped;
    out.reasons.rebuild = 1;
    return out;
  }
  if (!sameFingerprint(doc.fingerprint, fp)) {
    out.skipped = [...(store.records || []), ...(store.archive || [])].length;
    out.reasons.fingerprint_mismatch = out.skipped;
    return out;
  }
  const entries = doc.entries && typeof doc.entries === 'object' ? doc.entries : {};
  for (const r of [...(store.records || []), ...(store.archive || [])]) {
    const e = entries[r.id];
    if (!e) { bump('missing_entry'); continue; }
    if (!e || e.record_id !== r.id) { bump('record_id_mismatch'); continue; }
    if (e.content_hash !== sha256Text(r.content)) { bump('content_hash_mismatch'); continue; }
    if (!sameFingerprint(e.model_fingerprint, fp)) { bump('entry_fingerprint_mismatch'); continue; }
    if (Number(e.dim) > 0 && Number(e.dim) !== e.vector?.length) { bump('dim_mismatch'); continue; }
    if (!isValidVector(e.vector, Number(e.dim) || null)) { bump('invalid_vector'); continue; }
    if (doc.dim && Number(doc.dim) !== e.vector.length) { bump('cache_dim_mismatch'); continue; }
    r._vec = e.vector;
    out.attached += 1;
  }
  return out;
}

// 从当前记录上的瞬态 _vec 收集缓存。维度混用视为无效，不写进缓存。
export function collectVectors(store, fingerprint) {
  const fp = typeof fingerprint === 'string' ? { id: fingerprint } : fingerprint;
  const entries = {};
  let dim = 0;
  let count = 0;
  let invalid = 0;
  for (const r of [...(store.records || []), ...(store.archive || [])]) {
    if (!Array.isArray(r._vec) || r._vec.length === 0) continue;
    if (!isValidVector(r._vec)) { invalid += 1; continue; }
    if (dim && r._vec.length !== dim) { invalid += 1; continue; }
    dim = r._vec.length;
    entries[r.id] = {
      record_id: r.id,
      content_hash: sha256Text(r.content),
      model_fingerprint: fp,
      dim: r._vec.length,
      vector: r._vec,
      built_at: new Date().toISOString(),
    };
    count += 1;
  }
  return { version: VECTOR_CACHE_VERSION, fingerprint: fp, dim: dim || null, built_at: new Date().toISOString(), entries, count, invalid };
}

// 批量补齐：不因单条失败中断，返回统计与首个错误。不写缓存（调用方决定）。
export async function embedAll(store, cfg, opts = {}) {
  const force = opts.force === true;
  const all = [...(store.records || []), ...(store.archive || [])];
  const targets = all.filter((r) => force || !isValidVector(r._vec));
  let done = 0;
  let failed = 0;
  let firstError = null;
  let dim = 0;
  for (const r of targets) {
    try {
      const vec = await embedOne(cfg, r.content);
      if (!isValidVector(vec)) throw new Error('服务返回了无效向量（空、非数值或全零）');
      if (dim && vec.length !== dim) throw new Error(`维度不一致：${vec.length} ≠ ${dim}`);
      r._vec = vec;
      dim = vec.length;
      done += 1;
      if (typeof opts.onProgress === 'function') opts.onProgress({ id: r.id, done, target: targets.length });
    } catch (err) {
      failed += 1;
      if (!firstError) firstError = err && err.message ? err.message : String(err);
      if (opts.stopOnError) break;
    }
  }
  return { total: all.length, targets: targets.length, done, failed, firstError, dim: dim || null };
}
