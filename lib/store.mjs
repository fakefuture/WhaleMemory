// lib/store.mjs — 存储文档的加载/保存/默认值。
// 单一事实来源：一个 memory/store.json（pretty JSON，便于 git diff）。

import path from 'node:path';
import { readJson, writeJsonAtomic, nowIso } from './util.mjs';

export const STORE_REL = path.join('memory', 'store.json');

export function storePath(root) {
  return path.join(root, STORE_REL);
}

export function defaultConfig() {
  return {
    admission: {
      min_content_length: 2,
    },
    recall: {
      limit: 8,
      w_relevance: 0.5,
      w_strength: 0.25,
      w_recency: 0.15,
      w_utility: 0.1,
      recency_half_life_days: 14,
      persona_boost: 0.25,
      persona_relevance_tolerance: 0.15,
      persona_cap: 0.02,
      lambda_recall_damp: 0.15,
      lambda_floor: 0.002,
      // 相关性是组内相对信号，强度是绝对信号；不归一化时层级初值会盖过相关性差异。
      relevance_normalize: true,
      min_relevance_spread: 0.05,
      // MMR 多样性重排：λ·score − (1−λ)·与已选条目的最大相似度。null / 0 / 1 = 关闭。
      // 用来压住"同一事实的近重复条目互相顶替、把不同信息挤出 top-k"。
      mmr_lambda: null,
      // 绝对相关度下限（null = 关闭），按相似度尺度分开取：词面 Jaccard 与余弦不可换算，
      // 用一个数必然误伤一侧。低于下限时 query 会提示“可能没命中”。
      // score 是组内归一化的相对分，噪声也会被顶到 0.9，判断召回要看 rel 绝对值。
      min_abs_relevance: { lexical: null, embedding: null },
      // 注入到系统提示词的内容范围：人格卡 + 情绪行永远注入；
      // 记忆速览默认关闭（0 条）。要开就设成 6 之类，并注意 inject_budget。
      inject_top: 0,
      inject_budget: 250,
    },
    decay: {
      top_k: 20,
      tau_archive: 0.12,
      // 强度下限：衰减可以，但不归零。设成 ≥ tau_archive 时记忆永远不会休眠
      // （强度够不到 τ），只会变弱、排序靠后。null = 关闭。
      strength_floor: null,
      negative_utility_boost: 0.5,
      positive_utility_damp: 0.5,
      // 会话结束时：工作层被用过则沉降为情节层，没被用过则丢弃（归档）
      working_settle: true,
    },
    consolidation: {
      min_recall_count: 3,
      min_utility_hits: 2,
    },
    reorg: {
      prune_min_confidence: 0.75,
    },
    // 记忆染色：默认**小权重生效**（检索时参考当前人格与情绪），可用 --no-bias 关掉。
    // 权重刻意压得很低：α 越大越容易把噪声推上前。事实与安全域永久屏蔽。
    color: {
      affect_alpha: 0.05,
      persona_alpha: 0.03,
      domains: ['preference', 'personal'],
    },
    // 印象层（关于用户）的注入预算：按权重取条目，超了就截断。
    impression: {
      token_budget: 300,
    },
    persona: {
      alpha_max: 0.6,
      alpha_min: 0.03,
      alpha_span: 24,
      // 人格卡片（热层）的渲染预算：超了就丢低观测特质、再截断卡文本。
      // token 数是估算值（见 util.estimateTokens），零依赖、不引 tokenizer。
      token_budget: 420,
      // 自动演化：候选池里同向观测到这么多次（或一次显式强调）才晋升为特质。
      promote_hits: 2,
    },
    // 两套尺度的阈值不可互换：Jaccard 0.9 表示几乎逐字相同，余弦 0.9 只是高度相关。
    sim: {
      lexical: { merge: 0.9, conflict: 0.3, cluster: 0.55, cover: 0.7, prune: 0.85 },
      embedding: { merge: 0.95, conflict: 0.55, cluster: 0.72, cover: 0.82, prune: 0.9 },
    },
    embed: {
      enabled: false,
      provider: 'ollama',
      url: 'http://127.0.0.1:11434',
      model: 'bge-m3',
      timeout_ms: 15000,
      // null 交给 Ollama 决定；0 强制 CPU（Vulkan 后端 device lost 时的解法）
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

export function emptyStore() {
  const ts = nowIso();
  return {
    version: 1,
    created_at: ts,
    updated_at: ts,
    config: defaultConfig(),
    records: [],
    archive: [],
    conflicts: [],
    sessions: { count: 0, last_end: null },
    persona: { observations: 0, updated_at: ts, card: { text: '', updated_at: null, note: null }, traits: {}, versions: [], candidates: [] },
    impression: { items: [] },
    log: [],
  };
}

// 深合并 config 的两层结构，保证老 store 文件缺字段时也能跑。
export function normalizeStore(doc) {
  const base = emptyStore();
  const src = doc && typeof doc === 'object' ? doc : {};
  const out = {
    ...base,
    ...src,
    config: JSON.parse(JSON.stringify(base.config)),
    records: Array.isArray(src.records) ? src.records : [],
    archive: Array.isArray(src.archive) ? src.archive : [],
    conflicts: Array.isArray(src.conflicts) ? src.conflicts : [],
    log: Array.isArray(src.log) ? src.log : [],
  };
  const srcCfg = src.config && typeof src.config === 'object' ? src.config : {};
  for (const section of Object.keys(base.config)) {
    const s = srcCfg[section];
    if (s && typeof s === 'object') out.config[section] = { ...base.config[section], ...s };
  }
  out.sessions = { count: 0, last_end: null, ...(src.sessions || {}) };
  out.persona = {
    observations: 0,
    updated_at: base.created_at,
    traits: {},
    versions: [],
    candidates: [],
    ...(src.persona || {}),
  };
  if (!out.persona.traits || typeof out.persona.traits !== 'object') out.persona.traits = {};
  // 老库没有卡片字段：补一个空卡，渲染时只显示特质。
  if (!out.persona.card || typeof out.persona.card !== 'object') {
    out.persona.card = { text: '', updated_at: null, note: null };
  }
  if (typeof out.persona.card.text !== 'string') out.persona.card.text = '';
  if (!Array.isArray(out.persona.versions)) out.persona.versions = [];
  if (!Array.isArray(out.persona.candidates)) out.persona.candidates = [];
  // 印象层：老库没有就补空表。
  if (!out.impression || !Array.isArray(out.impression.items)) out.impression = { items: [] };

  // 相似度阈值已统一到 config.sim.*（词面/嵌入两套尺度）。清掉旧字段，
  // 否则老库里还留着一份"改了不生效"的阈值，等于埋了个坑。
  delete out.config.admission.merge_similarity;
  delete out.config.admission.conflict_similarity;
  delete out.config.consolidation.cluster_similarity;
  delete out.config.consolidation.cover_similarity;
  delete out.config.reorg.prune_similarity;

  return out;
}

export function loadStore(root) {
  const file = storePath(root);
  const doc = readJson(file, null);
  if (!doc) {
    const err = new Error(`没有找到记忆库：${file}\n先运行：node bin/psm.mjs init`);
    err.code = 'ENOSTORE';
    throw err;
  }
  return normalizeStore(doc);
}

export function saveStore(root, doc) {
  // _vec 是瞬态缓存（来自 memory/embeddings.json），不能写进主库。
  for (const r of [...doc.records, ...doc.archive]) delete r._vec;
  doc.updated_at = nowIso();
  writeJsonAtomic(storePath(root), doc);
  return doc;
}
