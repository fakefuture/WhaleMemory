// lib/doctor.mjs — 一键体检：把散落在各处的"应该成立"集中检查一遍。
//
// 只读 doctor 不修数据。repair 先展示动作，显式 --apply 才写入；无法恢复的证据和来源不得编造。
// 返回 { ok, fail, warn, checks: [{ name, status, detail }] }，status ∈ 'ok' | 'warn' | 'fail'。

import fs from 'node:fs';
import path from 'node:path';
import { round } from './util.mjs';
import { sha256Text, readJsonStrict, walkFiles, copyFileAtomic } from './fsx.mjs';
import { PsmError, CODES } from './errors.mjs';
import { renderPersonaCard, renderImpressionBlock } from './render.mjs';
import { loadModel } from './emotion.mjs';
import { loadScales } from './scales.mjs';
import { personaFingerprint } from './probe.mjs';
import { readSnapshot, withWrite } from './repository.mjs';
import { resolveContext } from './policy.mjs';
import { lockStatus, repairLock, acquireLock } from './lock.mjs';
import { loadColdIndex, verifyCold, repairCold, coldDir } from './cold.mjs';
import { safeLoadVectors, saveVectors, emptyCache, fingerprintOf, embedConfig, isValidVector } from './embed.mjs';

const KEY_FILES = [
  'memory/store.json',
  'memory/embeddings.json',
  'emotion-state.json',
  'emotion-states.json',
  'memory/emotions.json',
  'docs/persona-scales.json',
  'docs/emotion-rules.json',
  'docs/persona-probes.json',
  'cold/index.json',
];

function checkJsonReadable(root) {
  const bad = [];
  for (const rel of KEY_FILES) {
    const p = path.join(String(root), rel);
    if (!fs.existsSync(p)) continue;
    try {
      readJsonStrict(p);
    } catch (err) {
      bad.push({ file: rel, code: err.code || null });
    }
  }
  return bad;
}

function loadScaleInputs(root) {
  try {
    const doc = readJsonStrict(path.join(String(root), 'docs', 'persona-scales.json'), { optional: true });
    if (doc) return { scales: (doc && doc.scales) || {}, priorities: (doc && doc.trait_priorities) || {} };
  } catch { /* 回退到代码内默认刻度 */ }
  return { scales: loadScales(), priorities: {} };
}

function norm(s) {
  return String(s ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function countBy(arr, fn) {
  const out = {};
  for (const x of arr) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

export function runDoctor(root, store, extra = [], { context = {}, version = null } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail: detail || '' });

  // 1) 文件可解析（截断/BOM 之外的损坏都会在这里露出来）
  const badFiles = checkJsonReadable(root);
  add('JSON 文件可解析', badFiles.length ? 'fail' : 'ok',
    badFiles.length ? `坏文件：${badFiles.map((b) => `${b.file}${b.code ? `(${b.code})` : ''}`).join(', ')}` : `检查 ${KEY_FILES.length} 个文件`);

  const v = Number(version || (store && store.version) || 1);
  if (!store || typeof store !== 'object') {
    add('主库', 'fail', '未加载或不是对象；先检查 memory/store.json');
    const fail = checks.filter((c) => c.status === 'fail').length;
    const warn = checks.filter((c) => c.status === 'warn').length;
    return { ok: fail === 0, fail, warn, checks };
  }

  // 2) 版本 / 结构 / revision
  if (v !== 2) {
    add('主库版本', 'warn', `v${v} 只读视图；写操作前先 migrate --dry-run，再 migrate --apply`);
  } else {
    const ops = Array.isArray(store.operations) ? store.operations : [];
    const maxOpRev = ops.reduce((m, o) => Math.max(m, Number(o.revision) || 0), 0);
    const revisionOk = Number(store.revision) === maxOpRev || (store.revision === 0 && ops.length === 0);
    add('主库版本/revision', revisionOk ? 'ok' : 'warn',
      `v2 revision=${store.revision}，operations=${ops.length}，最大 operation revision=${maxOpRev}`
      + (revisionOk ? '' : '（不一致：可能被外部编辑过）'));
  }

  const all = [...(store.records || []), ...(store.archive || [])];
  const ids = new Set(all.map((r) => r.id));
  const overlap = (store.records || []).filter((r) => (store.archive || []).some((a) => a.id === r.id)).length;
  add('records/archive id 互斥', overlap ? 'fail' : 'ok', overlap ? `${overlap} 个重复 id` : '');

  // 3) 证据引用
  const evidenceIds = new Set((store.evidence || []).map((e) => e.id));
  const danglingEvidence = [];
  let missingHistory = 0;
  for (const r of all) {
    for (const eid of r.evidence_ids || []) {
      if (!evidenceIds.has(eid)) danglingEvidence.push({ id: r.id, evidence_id: eid });
    }
    if (!r.review || !Array.isArray(r.review.history) || r.review.history.length === 0) missingHistory += 1;
  }
  add('证据引用完整', danglingEvidence.length ? 'fail' : 'ok',
    danglingEvidence.length ? `${danglingEvidence.length} 个悬空引用（不编造证据；需人工确认）` : `${all.length} 条记录的 evidence_ids 均存在`);
  add('审核历史', missingHistory ? 'warn' : 'ok', missingHistory ? `${missingHistory} 条记录没有 review.history` : '');
  const badEvidenceHash = (store.evidence || []).filter((e) => sha256Text(e.text) !== e.content_hash).length;
  add('证据正文哈希', badEvidenceHash ? 'fail' : 'ok', badEvidenceHash ? `${badEvidenceHash} 条证据哈希不一致` : '');

  // 4) 正文哈希 / 状态
  const badHash = all.filter((r) => sha256Text(r.content) !== r.content_hash);
  add('正文哈希', badHash.length ? 'warn' : 'ok',
    badHash.length ? `${badHash.length} 条记录 content_hash 与正文不一致；可 repair --action content-hash` : '');
  const badRange = all.filter((r) => !(Number(r.strength) >= 0 && Number(r.strength) <= 1)
    || !(Number(r.confidence) >= 0 && Number(r.confidence) <= 1)).length;
  add('强度/置信度在 [0,1]', badRange ? 'fail' : 'ok', badRange ? `${badRange} 条越界` : '');
  const oddReview = all.filter((r) => r.review_status === 'candidate' && r.validity !== 'current').length;
  add('候选有效性', oddReview ? 'warn' : 'ok', oddReview ? `${oddReview} 条候选不是 current` : '');

  // 5) 未知会话
  const unknownSessions = all.filter((r) => r.scope === 'session'
    && (!r.namespace || !r.namespace.session_id || r.namespace.session_id === 'legacy_unknown' || r.legacy_unknown_session));
  add('未知会话隔离', unknownSessions.length ? 'warn' : 'ok',
    unknownSessions.length ? `${unknownSessions.length} 条 session 记录隔离为 legacy_unknown（不进入普通会话查询）` : '');

  // 6) 候选积压
  const candidates = (store.records || []).filter((r) => r.review_status === 'candidate');
  const stale = candidates.filter((r) => {
    const t = Date.parse(r.updated_at || r.created_at || '');
    return Number.isFinite(t) && (Date.now() - t) > 14 * 86400000;
  }).length;
  add('候选积压', candidates.length ? (stale ? 'warn' : 'ok') : 'ok',
    candidates.length ? `${candidates.length} 条待审，其中 ${candidates.filter((r) => r.needs_synthesis).length} 条待合成${stale ? `，${stale} 条超过 14 天` : ''}` : '无候选');

  // 7) 冲突
  const strayConflicts = (store.conflicts || []).filter((c) => !ids.has(c.a) || (c.b && !ids.has(c.b))).length;
  add('冲突引用', strayConflicts ? 'fail' : 'ok', strayConflicts ? `${strayConflicts} 条悬空冲突` : '');
  const unresolved = (store.conflicts || []).filter((c) => ['open', 'suspect'].includes(c.status) || c.legacy_ambiguity === true).length;
  add('未决冲突', unresolved ? 'warn' : 'ok', unresolved ? `${unresolved} 条未决/legacy 歧义，默认不进入结果` : '');

  // 8) 确定性重复（同 namespace/scope/审核/有效状态的相同正文）
  const seen = new Map();
  let dupCount = 0;
  for (const r of (store.records || [])) {
    if (r.state !== 'active' || r.validity !== 'current') continue;
    const ns = r.namespace || {};
    const key = [ns.owner_id, ns.workspace_id, r.scope, r.review_status, ns.session_id || '', norm(r.content)].join('|');
    if (seen.has(key)) dupCount += 1;
    else seen.set(key, r.id);
  }
  add('确定性去重', dupCount ? 'warn' : 'ok', dupCount ? `${dupCount} 条同范围同文重复` : '');

  // 9) 向量缓存
  const { doc: cache, error: cacheError } = safeLoadVectors(root);
  const embedCfg = embedConfig(store);
  const fp = fingerprintOf(embedCfg);
  if (cacheError) {
    add('向量缓存', 'warn', `缓存损坏（${cacheError}）；业务数据不受影响，可 repair --action vectors --apply 或 embed --force`);
  } else if (!cache) {
    add('向量缓存', 'warn', embedCfg.enabled ? '还没有缓存：embed 补齐' : 'embed 未启用，全部走词面比较');
  } else if (cache.version !== 2) {
    add('向量缓存', 'warn', `缓存是旧格式 v${cache.version || 1}，不予使用；跑 embed --force 重建`);
  } else {
    const entries = cache.entries || {};
    const recs = new Map(all.map((r) => [r.id, r]));
    let valid = 0;
    let staleEntries = 0;
    let invalidVectors = 0;
    for (const [id, e] of Object.entries(entries)) {
      const r = recs.get(id);
      if (!r) { staleEntries += 1; continue; }
      if (e.content_hash !== sha256Text(r.content)) { staleEntries += 1; continue; }
      if (!isValidVector(e.vector, Number(e.dim) || null)) { invalidVectors += 1; continue; }
      valid += 1;
    }
    const mismatch = !cache.fingerprint || cache.fingerprint.id !== fp.id;
    const target = all.filter((r) => r.state === 'active' && r.review_status === 'accepted' && r.validity === 'current');
    const coverage = target.length ? valid / target.length : 0;
    if (mismatch) {
      add('向量缓存', 'warn', `模型/端点指纹不一致（质量 ${cache.fingerprint?.quality || 'unknown'}）；旧向量拒用，跑 embed --force`);
    } else if (invalidVectors || staleEntries) {
      add('向量缓存', 'warn', `${valid}/${all.length} 可用；${staleEntries} 条正文已变/条目消失，${invalidVectors} 条向量无效；repair --action vectors --apply 或 embed --force`);
    } else if (target.length && coverage < 0.98) {
      add('向量缓存', 'warn', `${valid}/${all.length} 有向量；正式条目覆盖率 ${Math.round(coverage * 100)}%，跑 embed 补齐（缺失时仍可词面检索）`);
    } else {
      add('向量缓存', 'ok', `${valid}/${all.length} 条可用，指纹质量 ${fp.quality}${fp.quality === 'weak' ? '（未提供 digest，无法检测同名模型更新）' : ''}`);
    }
  }

  // 10) 锁
  const lock = lockStatus(root);
  if (!lock.held) add('写锁', 'ok', '空闲');
  else if (lock.status === 'stale') add('写锁', 'warn', '持有者进程已退出；下次写入会回收，或 repair --action lock --apply --reason "…"');
  else if (lock.status === 'corrupt') add('写锁', 'warn', '锁文件损坏，无法判断持有者；确认无写入后 repair --action lock --apply --reason "…"');
  else if (lock.status === 'foreign-host') add('写锁', 'warn', '锁来自其他主机；只能显式 repair');
  else add('写锁', 'warn', `被 pid ${lock.meta?.pid || '?'} 持有（${lock.meta?.purpose || 'unknown'}）`);

  // 11) 冷存储：索引完整性 + 孤立条目
  try {
    const idx = loadColdIndex(root);
    const verify = verifyCold(root);
    const dir = path.join(coldDir(root), 'entries');
    const files = fs.existsSync(dir)
      ? walkFiles(dir).filter((rel) => rel.endsWith('.json')).map((rel) => `cold/entries/${rel}`)
      : [];
    const indexed = new Set(idx.entries.map((e) => String(e.path).replace(/\\/g, '/')));
    const orphans = files.filter((f) => !indexed.has(f));
    if (verify.status !== 'ok' || orphans.length) {
      add('冷存储', 'warn', `${idx.entries.length} 条索引，${verify.bad.length} 条缺失/哈希不符，${orphans.length} 个孤立条目；cold repair --dry-run 查看`);
    } else {
      add('冷存储', 'ok', `${idx.entries.length} 条，索引与内容一致；不参与渲染与检索`);
    }
  } catch (err) {
    add('冷存储', 'fail', `cold/index.json 损坏：${err.message}；不要直接删除，先 cold repair --dry-run`);
  }

  // 12) 采集状态
  const cursors = (store.captures && store.captures.cursors) || {};
  const receipts = (store.captures && store.captures.receipts) || {};
  const pendingTotal = Object.values(cursors).reduce((sum, c) => {
    const total = Number(c && c.users_total);
    const done = Number(c && c.processed);
    return sum + (Number.isFinite(total) && Number.isFinite(done) ? Math.max(0, total - done) : 0);
  }, 0);
  const rewrites = Object.values(cursors).filter((c) => c && c.rewrite_detected_at).length;
  const legacyCapture = fs.existsSync(path.join(String(root), 'memory', 'capture-state.json'));
  add('采集状态', pendingTotal ? 'warn' : 'ok',
    `${Object.keys(cursors).length} 个来源游标，${Object.keys(receipts).length} 条幂等回执`
    + `，待处理尾部 ${pendingTotal} 条`
    + (rewrites ? `；${rewrites} 个来源检测到重写/截断` : '')
    + (legacyCapture ? '；存在旧版 memory/capture-state.json（迁移时已导入游标，可核对后删除）' : ''));

  // 13) 迁移状态
  const migrations = Array.isArray(store.migrations) ? store.migrations : [];
  add('迁移状态', v === 2 ? 'ok' : 'warn', v === 2
    ? (migrations.length ? `已迁移 ${migrations.length} 次，最近 ${migrations[migrations.length - 1].at}，备份 ${migrations[migrations.length - 1].backup?.name || '无'}` : 'v2（可能新建，无迁移记录）')
    : `当前 v${v}，写操作前必须 migrate`);

  // 14) 人格卡片 / 印象
  const { scales, priorities } = loadScaleInputs(root);
  const card = renderPersonaCard({ persona: store.persona || {}, config: store.config || {}, scales, priorities });
  if (!card.card_chars) add('人格卡片', 'warn', '卡文本为空，只渲染特质');
  else if (card.over) add('人格卡片', 'fail', `${card.tokens}/${card.budget} 超预算`);
  else if (card.tokens / card.budget > 0.9) add('人格卡片', 'warn', `${card.tokens}/${card.budget}，已用 ${Math.round((card.tokens / card.budget) * 100)}%`);
  else add('人格卡片', 'ok', `${card.tokens}/${card.budget}，特质 ${Object.keys(store.persona?.traits || {}).length} 条`);

  const imp = renderImpressionBlock({ impression: store.impression || {}, config: store.config || {} });
  const impTotal = ((store.impression && store.impression.items) || []).length;
  add('印象层', impTotal ? 'ok' : 'warn', impTotal ? `${imp.count}/${impTotal} 条进注入，${imp.tokens}/${imp.budget} token` : '空（可留空）');
  add('人格卡预算默认值', 'ok', `persona.token_budget=${store.config?.persona?.token_budget ?? '?'}，impression.token_budget=${store.config?.impression?.token_budget ?? '?'}`);

  // 15) 情绪模型
  const emo = loadModel(root);
  if (!emo) add('情绪向量', 'warn', '还没建：emotion build');
  else if (emo.model && embedCfg.model && emo.model !== embedCfg.model) add('情绪向量', 'warn', `模型不一致（${emo.model} ≠ ${embedCfg.model}），需重建`);
  else add('情绪向量', 'ok', `${Object.keys(emo.emotions || {}).length} 情绪，${emo.dim} 维，${emo.model}`);

  // 16) 探针基线
  const probeRuns = path.join(String(root), 'memory', 'probe-runs.json');
  if (!fs.existsSync(probeRuns)) {
    add('人格探针', 'warn', '还没跑过：probe list → probe score');
  } else {
    try {
      const doc = readJsonStrict(probeRuns);
      const last = (doc.runs || [])[doc.runs.length - 1];
      if (!last) add('人格探针', 'warn', '无记录');
      else {
        const cur = personaFingerprint(store);
        const same = last.fingerprint === cur;
        add('人格探针', same ? 'ok' : 'warn', same
          ? `最近 ${last.score}（${last.passed}/${last.total}），指纹 ${last.fingerprint} 与当前卡一致`
          : `最近一次是旧卡（指纹 ${last.fingerprint}），当前卡 ${cur}——基线过期，重跑 probe score`);
      }
    } catch {
      add('人格探针', 'fail', 'probe-runs.json 解析失败');
    }
  }

  // 17) 情绪状态：多会话与老单文件是否一致
  try {
    const states = readJsonStrict(path.join(String(root), 'emotion-states.json'), { optional: true });
    if (states) {
      const legacyPath = path.join(String(root), 'emotion-state.json');
      if (!fs.existsSync(legacyPath)) {
        add('情绪状态文件', 'warn', '只有多会话文件，没有老单文件（不影响使用）');
      } else {
        const legacy = readJsonStrict(legacyPath);
        const active = states.active && states.sessions ? states.sessions[states.active] : null;
        const same = active && legacy && active.at === legacy.at && active.emotion === legacy.emotion;
        add('情绪状态文件', same ? 'ok' : 'warn', same
          ? `active ${states.active} 与单文件一致`
          : `active(${states.active || '无'}) 与 emotion-state.json 不同步（重跑 emotion track 即修复）`);
      }
    }
  } catch { /* 没有或损坏：上面 JSON 检查已报告 */ }

  // 18) 染色
  {
    const cfgColor = store.config.color || {};
    const a1 = Number(cfgColor.affect_alpha || 0);
    const a2 = Number(cfgColor.persona_alpha || 0);
    const stampedMood = all.filter((r) => r.affect_at_write && r.affect_at_write.emotion).length;
    const stampedFp = all.filter((r) => r.persona_fp).length;
    const strong = a1 > 0.2 || a2 > 0.2;
    const armedNoData = (a1 > 0 && stampedMood === 0) || (a2 > 0 && stampedFp === 0);
    add('记忆染色', strong || armedNoData ? 'warn' : 'ok',
      `已标 affect_at_write ${stampedMood} 条 / persona_fp ${stampedFp} 条；α_affect=${a1} α_persona=${a2}`
      + (strong ? '，α 偏高：可能放大噪声，建议 ≤0.1' : '')
      + (armedNoData ? '，α 已开但没有任何带标注的记录 → 偏置恒为 0' : ''));
  }

  // 19) 备份
  const backups = path.join(String(root), 'backups');
  let n = 0;
  let bytes = 0;
  const sumDir = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) sumDir(p);
      else if (f.isFile()) bytes += fs.statSync(p).size;
    }
  };
  try {
    for (const d of fs.readdirSync(backups, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      n += 1;
      sumDir(path.join(backups, d.name));
    }
  } catch { /* 没有 backups 目录 */ }
  add('备份', n ? 'ok' : 'warn', n ? `${n} 个快照，约 ${round(bytes / 1048576, 1)} MB` : '还没有快照：backup create');

  // 20) 注入层会话隔离探针
  try {
    const probe = readJsonStrict(path.join(String(root), 'tmp', 'plugin-probe.json'));
    const entries = probe.entries || [];
    const nulls = entries.filter((e) => !e.env_session);
    if (!entries.length) add('注入层会话隔离', 'warn', '没有探针记录（插件还没渲染过）');
    else if (nulls.length) {
      const lastNull = nulls[nulls.length - 1];
      add('注入层会话隔离', 'warn',
        `app 进程装配时 env_session=null（${nulls.length} 条记录），注入退回 active=${lastNull.active || '无'}；详见 docs/UNIMPLEMENTED.md`);
    } else add('注入层会话隔离', 'ok', '所有记录都带会话 id，按会话隔离生效');
  } catch {
    add('注入层会话隔离', 'warn', '没有 tmp/plugin-probe.json（插件未安装或未渲染）');
  }

  // 21) 外部检查（插件一致性等由 CLI 传入）
  for (const c of extra) add(c.name, c.status, c.detail);

  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  return { ok: fail === 0, fail, warn, checks };
}

// ---------------------------------------------------------------- repair

async function planContentHash(root) {
  const snap = readSnapshot(root);
  if (!snap.writable) return { action: 'content-hash', status: 'blocked', reason: 'v1 只读视图；先 migrate --apply' };
  const bad = [...snap.doc.records, ...snap.doc.archive]
    .filter((r) => sha256Text(r.content) !== r.content_hash)
    .map((r) => ({ id: r.id, from: r.content_hash, to: sha256Text(r.content) }));
  return { action: 'content-hash', status: bad.length ? 'planned' : 'noop', count: bad.length, records: bad };
}

function inspectVectors(root, store) {
  const cfg = embedConfig(store);
  const fp = fingerprintOf(cfg);
  const { doc: cache, error } = safeLoadVectors(root);
  const valid = {};
  const invalid = [];
  if (cache && cache.version === 2 && cache.fingerprint && cache.fingerprint.id === fp.id) {
    const recs = new Map([...store.records, ...store.archive].map((r) => [r.id, r]));
    for (const [id, e] of Object.entries(cache.entries || {})) {
      const r = recs.get(id);
      if (!r) { invalid.push({ id, reason: 'record_missing' }); continue; }
      if (e.content_hash !== sha256Text(r.content)) { invalid.push({ id, reason: 'content_hash_mismatch' }); continue; }
      if (!isValidVector(e.vector, Number(e.dim) || null)) { invalid.push({ id, reason: 'invalid_vector' }); continue; }
      valid[id] = e;
    }
  } else if (cache) {
    invalid.push({ id: null, reason: error ? 'cache_corrupt' : 'fingerprint_or_version_mismatch' });
  } else if (error) {
    invalid.push({ id: null, reason: 'cache_corrupt' });
  }
  return { action: 'vectors', fingerprint: fp, cache, error, valid, invalid, dim: cache && cache.dim ? cache.dim : null };
}

async function applyVectors(root, store, plan) {
  const fp = plan.fingerprint;
  const lock = await acquireLock(root, { purpose: 'repair-vectors', timeoutMs: 5000 });
  try {
    if (plan.error) {
      const src = path.join(String(root), 'memory', 'embeddings.json');
      const dest = path.join(String(root), 'memory', `embeddings.corrupt-${Date.now()}.json`);
      copyFileAtomic(src, dest);
    }
    const entries = {};
    for (const [id, e] of Object.entries(plan.valid || {})) entries[id] = { ...e, model_fingerprint: fp };
    const dim = plan.dim || Object.values(entries).find((e) => e.dim)?.dim || null;
    const doc = { ...emptyCache(fp, dim), entries };
    saveVectors(root, doc);
    return { written: Object.keys(entries).length, dim, quarantined: plan.error ? 'memory/embeddings.corrupt-*.json' : null };
  } finally {
    lock.release();
  }
}

/**
 * repair：默认 dry-run；显式 apply 才写入。必须给 --reason。
 * actions: content-hash | vectors | cold | lock（all = content-hash + vectors）
 */
export async function repair(root, { apply = false, actions = [], reason = null, actor = 'cli' } = {}) {
  if (!reason || !String(reason).trim()) {
    throw new PsmError(CODES.INVALID_ARGUMENT, 'repair 必须用 --reason 说明为什么可以这样修复', {});
  }
  const selected = actions.length ? actions : ['content-hash', 'vectors'];
  const expanded = new Set();
  for (const a of selected) {
    if (a === 'all') { expanded.add('content-hash'); expanded.add('vectors'); } else expanded.add(a);
  }

  const results = [];
  let store = null;
  try {
    store = readSnapshot(root).doc;
  } catch (err) {
    results.push({ action: 'load', status: 'blocked', reason: err.message });
  }

  for (const action of expanded) {
    try {
      if (action === 'content-hash') {
        const plan = await planContentHash(root);
        if (plan.status !== 'planned' || !apply) { results.push(plan); continue; }
        const outcome = await withWrite(root, async (tx) => {
          const ctx = resolveContext(tx.doc, { actor });
          let fixed = 0;
          for (const r of [...tx.doc.records, ...tx.doc.archive]) {
            const h = sha256Text(r.content);
            if (h === r.content_hash) continue;
            r.content_hash = h;
            r.updated_at = ctx.now;
            fixed += 1;
            tx.op({ op: 'repair.content_hash', target: r.id, reason: String(reason), changes: { to: h } });
          }
          return { fixed };
        }, { purpose: 'repair-content-hash', context: { actor } });
        results.push({ action, status: 'applied', ...outcome.result, revision: outcome.revision });
      } else if (action === 'vectors') {
        if (!store) { results.push({ action, status: 'blocked', reason: '主库未加载' }); continue; }
        const plan = inspectVectors(root, store);
        if (!apply) {
          results.push({ action, status: plan.invalid.length || plan.error ? 'planned' : 'noop', invalid: plan.invalid.length, entries: Object.keys(plan.valid).length, error: plan.error || null });
          continue;
        }
        const written = await applyVectors(root, store, plan);
        results.push({ action, status: 'applied', ...written, invalid_before: plan.invalid.length });
      } else if (action === 'cold') {
        const rep = await repairCold(root, { dryRun: !apply, reason: String(reason), actor });
        results.push({ action, ...rep });
      } else if (action === 'lock') {
        if (!apply) {
          const st = lockStatus(root);
          results.push({ action, status: st.held ? 'planned' : 'noop', lock: st });
        } else {
          results.push({ action, ...repairLock(root, { reason: String(reason), actor }) });
        }
      } else {
        results.push({ action, status: 'unknown_action' });
      }
    } catch (err) {
      results.push({ action, status: 'failed', code: err.code || null, reason: err.message });
    }
  }

  return { dry: !apply, reason: String(reason), actor, results };
}

export { KEY_FILES };
