// lib/synth.mjs — 小模型生成的传输层。模型只产出「候选」，绝不直接改正式记录。
//
// 分工：
//   - 本文件负责配置、提示词构造和 HTTP 调用；
//   - 严格 JSON 解析、来源哈希/修订重检、取值/否定/条件校验、失败留痕都在 service.synthesizeCandidates；
//   - 生成在锁外进行，提交时 assertUnchanged；失败不覆盖上次的候选内容，原因写进 proposal_failures。

import { buildProposalPrompt } from './service.mjs';

export function synthConfig(store) {
  const s = (store && store.config && store.config.synth) || {};
  const rawGpu = s.num_gpu;
  return {
    enabled: s.enabled === true,
    url: String(s.url || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: String(s.model || 'qwen2.5:1.5b'),
    timeout_ms: Number(s.timeout_ms || 60000),
    // 本地小模型跑 CPU 最稳（Vulkan 后端在 BERT 上崩过，LLM 未必稳）
    num_gpu: rawGpu === null || rawGpu === undefined ? 0 : Number(rawGpu),
    max_chars: Number(s.max_chars || 300),
  };
}

// 与 service.buildProposalPrompt 同源：正文放在不可信 DATA 区块，严格 JSON 输出。
export function buildSynthesisPrompt(sources, maxChars = 300) {
  return buildProposalPrompt({ sources, maxChars });
}

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

export async function generateSynthesis(cfg, prompt) {
  const json = await postJson(`${cfg.url}/api/generate`, {
    model: cfg.model,
    prompt,
    stream: false,
    format: 'json',
    options: { temperature: 0, num_gpu: cfg.num_gpu },
  }, cfg.timeout_ms);
  const text = json && (json.response || (json.message && json.message.content));
  if (typeof text !== 'string' || !text.trim()) throw new Error('响应里没有可用的文本');
  return text;
}

// 对 service 的薄封装：每个候选生成前 service 会重新取快照，生成在锁外，提交时校验 revision/哈希。
export async function synthesizePending(service, cfg, opts = {}) {
  const generate = opts.generate || (({ prompt }) => generateSynthesis(cfg, prompt));
  return service.synthesizeCandidates({
    generate,
    cfg,
    dryRun: opts.dryRun === true,
    limit: Number(opts.limit || 20),
    context: opts.context || {},
  });
}
