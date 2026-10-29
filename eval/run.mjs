// eval/run.mjs — v0.2 评测运行器（离线规则 + 可选真实嵌入模型）。
//
// 默认只读：不写任何 store、不联网。只有显式提供 --embed-model 才会请求嵌入服务，
// 用于密集通道与情绪诊断；没有模型时情绪项明确输出 NOT_RUN，绝不用假向量冒充模型质量。
//
// 用法：
//   node eval/run.mjs                     # test 划分，离线词面 + 规则校验
//   node eval/run.mjs --split calibration # 调参划分
//   node eval/run.mjs --split all --json
//   node eval/run.mjs --embed-model bge-m3 --embed-url http://127.0.0.1:11434
//   node eval/run.mjs --write-manifest    # 重新登记夹具版本与哈希（夹具变更后手动执行）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { emptyStore, makeRecord } from '../lib/schema.mjs';
import { retrieve } from '../lib/retrieval.mjs';
import { parseProposalJson, validateProposal, CHECK } from '../lib/validation.mjs';
import { embedOne } from '../lib/embed.mjs';
import { buildModel as buildEmotionModel, classify as classifyEmotion } from '../lib/emotion.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = '2026-10-28T12:00:00.000Z';
const WORKSPACE = 'eval-ws';
const SESSION = 'eval-session';
const MAX_PROPOSAL_CHARS = 300;
const EMOTION_MIN_SCORE = 0.6;

// 阈值扫描用：--dense-min / --lexical-min 只影响本次评测构造的临时库，不写任何文件。
const THRESHOLD_OVERRIDE = { denseMin: null, lexicalMin: null };

const FILES = {
  retrieval: 'retrieval.jsonl',
  synthesis: 'synthesis.jsonl',
  emotion: 'emotion.jsonl',
  seeds: 'emotion-seeds.json',
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { flags._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return flags;
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${path.basename(file)} 第 ${i + 1} 行不是合法 JSON：${err.message}`);
    }
  });
  return rows;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function r4(x) {
  return x === null || x === undefined ? null : Number(Number(x).toFixed(4));
}

function fileInfo(file) {
  const raw = fs.readFileSync(file);
  if (!file.endsWith('.jsonl')) {
    const doc = JSON.parse(raw.toString('utf8'));
    return {
      sha256: sha256(raw),
      cases: doc && doc.emotions ? Object.keys(doc.emotions).length : null,
      by_split: null,
    };
  }
  const rows = readJsonl(file);
  const bySplit = {};
  for (const r of rows) bySplit[r.split] = (bySplit[r.split] || 0) + 1;
  return { sha256: sha256(raw), cases: rows.length, by_split: bySplit };
}

function manifestFor(files) {
  return {
    version: '0.2.0-eval.1',
    created_at: FIXED_NOW,
    note: '同一夹具同时用于调参和报告是禁止的：按 split 划分，报告默认只跑 test。',
    files: Object.fromEntries(files.map(({ key, file }) => [key, { path: path.basename(file), ...fileInfo(file) }])),
  };
}

function verifyManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { status: 'MISSING', errors: ['manifest.json 不存在'] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = [];
  for (const [key, info] of Object.entries(manifest.files || {})) {
    const file = path.join(HERE, info.path);
    if (!fs.existsSync(file)) { errors.push(`${key}: 文件缺失`); continue; }
    const hash = sha256(fs.readFileSync(file));
    if (hash !== info.sha256) errors.push(`${key}: 哈希不一致（期望 ${String(info.sha256).slice(0, 12)}…，实际 ${hash.slice(0, 12)}…）`);
  }
  return { status: errors.length ? 'DRIFT' : 'OK', manifest, errors };
}

// ---------------------------------------------------------------- 检索评测

function buildRetrievalDoc(caseData) {
  const now = FIXED_NOW;
  const doc = emptyStore({ workspaceId: WORKSPACE });
  if (THRESHOLD_OVERRIDE.denseMin !== null || THRESHOLD_OVERRIDE.lexicalMin !== null) {
    doc.config.retrieval = { ...(doc.config.retrieval || {}) };
    if (THRESHOLD_OVERRIDE.denseMin !== null) doc.config.retrieval.dense_min = THRESHOLD_OVERRIDE.denseMin;
    if (THRESHOLD_OVERRIDE.lexicalMin !== null) doc.config.retrieval.lexical_min = THRESHOLD_OVERRIDE.lexicalMin;
  }
  for (const r of caseData.library) {
    const rec = makeRecord({
      id: r.id,
      content: r.content,
      scope: r.scope,
      tier: r.tier,
      workspace_id: r.workspace_id || WORKSPACE,
      session_id: r.session_id || (r.scope === 'session' ? SESSION : null),
      validity: r.validity,
      time: r.time,
      strength: 0.8,
      confidence: 0.8,
    }, { now, ownerId: doc.identity.owner_id, workspaceId: WORKSPACE, sessionId: r.session_id || SESSION });
    doc.records.push(rec);
  }
  return doc;
}

function evalRetrieval(cases, { embed = null } = {}) {
  const recalls = [];
  const reciprocal = [];
  const latencies = [];
  const leaks = [];
  const noAnswer = [];
  const timeUnknownMisses = [];
  const failures = [];
  const cache = new Map();

  const embedText = async (text) => {
    if (cache.has(text)) return cache.get(text);
    const vec = await embed(text);
    cache.set(text, vec);
    return vec;
  };

  return (async () => {
    for (const c of cases) {
      const doc = buildRetrievalDoc(c);
      let qVec = null;
      if (embed) {
        for (const rec of doc.records) rec._vec = await embedText(rec.content);
        if (String(c.query ?? '').trim()) qVec = await embedText(c.query);
      }
      const ctx = {
        ownerId: doc.identity.owner_id,
        workspaceId: WORKSPACE,
        sessionId: c.context_session === null ? null : (c.context_session || SESSION),
        now: FIXED_NOW,
      };
      const t0 = process.hrtime.bigint();
      const res = retrieve(doc, c.query, { ctx, limit: 5, at: c.at || null, queryVector: qVec });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      latencies.push(ms);
      const ids = res.results.map((r) => r.id);

      for (const id of ids) {
        if ((c.forbidden || []).includes(id)) leaks.push({ case: c.id, id, reason: 'forbidden_id' });
        if (!c.library.some((r) => r.id === id)) leaks.push({ case: c.id, id, reason: 'unknown_id' });
      }
      if (c.context_session === null) {
        const sessionRecord = c.library.find((r) => r.scope === 'session' && ids.includes(r.id));
        if (sessionRecord) leaks.push({ case: c.id, id: sessionRecord.id, reason: 'session_without_context' });
      }

      if (c.answerable) {
        const hits = (c.expected || []).filter((id) => ids.includes(id));
        recalls.push(hits.length / Math.max(1, (c.expected || []).length));
        const rank = ids.findIndex((id) => (c.expected || []).includes(id));
        reciprocal.push(rank >= 0 ? 1 / (rank + 1) : 0);
        if (!hits.length) failures.push({ case: c.id, query: c.query, expected: c.expected, got: ids });
      } else {
        noAnswer.push(ids.length === 0);
        if (ids.length) failures.push({ case: c.id, query: c.query, expected: [], got: ids });
      }

      if (c.expect_time_unknown) {
        for (const id of c.expected || []) {
          const row = res.results.find((r) => r.id === id);
          if (!row || row.time_unknown !== true) timeUnknownMisses.push({ case: c.id, id });
        }
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      cases: cases.length,
      answerable: recalls.length,
      no_answer: noAnswer.length,
      recall_at_5: r4(mean(recalls)),
      mrr_at_5: r4(mean(reciprocal)),
      no_answer_fp_rate: r4(noAnswer.length ? noAnswer.filter((x) => !x).length / noAnswer.length : null),
      scope_leaks: leaks.length,
      leak_details: leaks.slice(0, 20),
      time_unknown_misses: timeUnknownMisses,
      latency_ms: {
        samples: sorted.length,
        p50: r4(median(sorted)),
        p95: r4(percentile(sorted, 0.95)),
        max: r4(sorted[sorted.length - 1] || null),
      },
      failures: failures.slice(0, 10),
      channel: embed ? 'hybrid' : 'lexical',
    };
  })();
}

// ---------------------------------------------------------------- 合成校验评测

function evalSynthesis(cases) {
  const byKind = {};
  const out = [];
  for (const c of cases) {
    const sources = c.sources.map((s) => makeRecord({
      id: s.id,
      content: s.content,
      tier: 'episodic',
      strength: 0.8,
      confidence: 0.8,
    }, { now: FIXED_NOW, ownerId: 'local', workspaceId: WORKSPACE }));
    const sourceHashes = Object.fromEntries(sources.map((s) => [s.id, s.content_hash]));
    let result;
    try {
      const proposal = parseProposalJson(JSON.stringify(c.proposal), { maxChars: MAX_PROPOSAL_CHARS });
      result = validateProposal({
        proposal,
        sources,
        allowedIds: sources.map((s) => s.id),
        sourceHashes,
        maxChars: MAX_PROPOSAL_CHARS,
        sourcesHaveConflict: c.sources_conflict === true,
      });
    } catch (err) {
      result = { status: 'invalid_json', reasons: [err.message], checks: [] };
    }
    const instructionCheck = result.checks.find((x) => x.id === CHECK.INSTRUCTION);
    const row = {
      id: c.id,
      kind: c.kind,
      split: c.split,
      expected: c.expected_status,
      actual: result.status,
      matched: result.status === c.expected_status,
      proposal_wrong: c.proposal_wrong === true,
      contains_instruction: c.contains_instruction === true || Boolean(instructionCheck && instructionCheck.detail),
      reasons: result.reasons,
    };
    const k = byKind[c.kind] || (byKind[c.kind] = { cases: 0, pass: 0, fail: 0, inconclusive: 0, matched: 0 });
    k.cases += 1;
    k[result.status] = (k[result.status] || 0) + 1;
    if (row.matched) k.matched += 1;
    out.push(row);
  }

  const pass = out.filter((r) => r.actual === 'pass').length;
  const fail = out.filter((r) => r.actual === 'fail').length;
  const inconclusive = out.filter((r) => r.actual === 'inconclusive').length;
  const wrongAdopted = out.filter((r) => r.proposal_wrong && r.actual === 'pass').length;
  const adoptionErrors = out.filter((r) => r.expected !== 'pass' && r.actual === 'pass').length;
  const instructionCases = out.filter((r) => r.contains_instruction);

  return {
    cases: out.length,
    pass,
    fail,
    inconclusive,
    expected_match: out.filter((r) => r.matched).length,
    expected_match_rate: r4(out.length ? out.filter((r) => r.matched).length / out.length : null),
    rule_rejection_rate: r4(out.length ? fail / out.length : null),
    candidate_usable_rate: r4(out.length ? pass / out.length : null),
    wrong_candidate_texts: out.filter((r) => r.proposal_wrong).length,
    wrong_value_adopted: wrongAdopted,
    adoption_errors: adoptionErrors,
    instruction_cases: instructionCases.length,
    instruction_flagged: instructionCases.filter((r) => r.contains_instruction).length,
    by_kind: byKind,
    failures: out.filter((r) => !r.matched).slice(0, 20),
  };
}

// ---------------------------------------------------------------- 情绪诊断（需要真实模型）

async function evalEmotion(cases, { embed = null, model = null } = {}) {
  if (!embed || !model) {
    return {
      status: 'NOT_RUN',
      reason: '未提供真实嵌入模型（--embed-model/--embed-url）；不用假向量冒充模型质量',
      cases: cases.length,
    };
  }
  const seeds = JSON.parse(fs.readFileSync(path.join(HERE, FILES.seeds), 'utf8'));
  const emoModel = await buildEmotionModel({
    corpus: seeds,
    embed: async (text) => embed(text),
    model,
  });
  const rows = [];
  for (const c of cases) {
    const vec = await embed(c.text);
    const ranked = classifyEmotion(emoModel, vec, 1);
    const top = ranked[0] || { emotion: null, score: 0 };
    const correct = c.expected === 'none'
      ? Number(top.score) < EMOTION_MIN_SCORE
      : top.emotion === c.expected;
    rows.push({ id: c.id, group: c.group, expected: c.expected, top: top.emotion, score: top.score, correct });
  }
  const byGroup = {};
  for (const r of rows) {
    const g = byGroup[r.group] || (byGroup[r.group] = { cases: 0, correct: 0 });
    g.cases += 1;
    if (r.correct) g.correct += 1;
  }
  return {
    status: 'RUN',
    model,
    cases: rows.length,
    accuracy: r4(rows.filter((r) => r.correct).length / rows.length),
    by_group: byGroup,
    note: '情绪结果只作实验诊断；不据此开放高影响自动化。subject 归属无法由纯向量分类器保证。',
    rows: rows.slice(0, 60),
  };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const split = String(flags.split || 'test');
  if (!['calibration', 'test', 'all'].includes(split)) {
    console.error('--split 只能是 calibration、test 或 all');
    process.exit(2);
  }
  const json = flags.json === true;
  if (flags['dense-min'] !== undefined) THRESHOLD_OVERRIDE.denseMin = Number(flags['dense-min']);
  if (flags['lexical-min'] !== undefined) THRESHOLD_OVERRIDE.lexicalMin = Number(flags['lexical-min']);

  const fileEntries = Object.entries(FILES).map(([key, name]) => ({ key, file: path.join(HERE, name) }));
  for (const { file } of fileEntries) {
    if (!fs.existsSync(file)) {
      console.error(`缺少夹具：${file}`);
      process.exit(2);
    }
  }

  const manifestPath = path.join(HERE, 'manifest.json');
  if (flags['write-manifest'] === true) {
    const manifest = manifestFor(fileEntries);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`已写入 ${manifestPath}`);
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }

  let manifestCheck = { status: 'SKIPPED', errors: [] };
  if (flags['skip-manifest'] !== true) manifestCheck = verifyManifest(manifestPath);

  const pick = (rows) => (split === 'all' ? rows : rows.filter((r) => r.split === split));
  const retrieval = pick(readJsonl(path.join(HERE, FILES.retrieval)));
  const synthesis = pick(readJsonl(path.join(HERE, FILES.synthesis)));
  const emotion = pick(readJsonl(path.join(HERE, FILES.emotion)));
  if (!retrieval.length || !synthesis.length || !emotion.length) {
    console.error(`划分 ${split} 没有足够的样例：retrieval=${retrieval.length} synthesis=${synthesis.length} emotion=${emotion.length}`);
    process.exit(2);
  }

  let embed = null;
  let model = null;
  if (flags['embed-model']) {
    model = String(flags['embed-model']);
    const cfg = {
      provider: flags.provider === 'openai' ? 'openai' : 'ollama',
      url: String(flags['embed-url'] || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      model,
      timeout_ms: 30000,
      num_gpu: flags['num-gpu'] === undefined ? null : Number(flags['num-gpu']),
    };
    embed = (text) => embedOne(cfg, text);
  }

  const retrievalRes = await evalRetrieval(retrieval, { embed });
  const synthesisRes = evalSynthesis(synthesis);
  const emotionRes = await evalEmotion(emotion, { embed, model });

  const hardGates = {
    manifest_ok: manifestCheck.status === 'OK' || manifestCheck.status === 'SKIPPED',
    zero_scope_leaks: retrievalRes.scope_leaks === 0,
    zero_wrong_value_adoption: synthesisRes.wrong_value_adopted === 0 && synthesisRes.adoption_errors === 0,
  };
  const ok = Object.values(hardGates).every(Boolean);

  const report = {
    manifest: { version: manifestCheck.manifest?.version || null, status: manifestCheck.status, errors: manifestCheck.errors },
    split,
    retrieval: retrievalRes,
    synthesis: synthesisRes,
    emotion: emotionRes,
    hard_gates: hardGates,
    note: '规则校验通过只表示规则检查通过，不代表事实已验证；真实模型质量需在提供模型后另行观测。',
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('PSM v0.2 评测');
    console.log(`  夹具版本 ${report.manifest.version || '未登记'}（manifest ${manifestCheck.status}），划分 ${split}`);
    console.log(`  检索 ${retrievalRes.cases} 题（可答 ${retrievalRes.answerable} / 无答案 ${retrievalRes.no_answer}，${retrievalRes.channel}）`);
    console.log(`    Recall@5 ${retrievalRes.recall_at_5}  MRR@5 ${retrievalRes.mrr_at_5}  无答案误报率 ${retrievalRes.no_answer_fp_rate}`);
    console.log(`    范围泄漏 ${retrievalRes.scope_leaks}  时间未知漏标 ${retrievalRes.time_unknown_misses.length}  延迟 p50 ${retrievalRes.latency_ms.p50}ms / p95 ${retrievalRes.latency_ms.p95}ms`);
    console.log(`  合成 ${synthesisRes.cases} 组：pass ${synthesisRes.pass} / fail ${synthesisRes.fail} / inconclusive ${synthesisRes.inconclusive}`);
    console.log(`    规则拒绝率 ${synthesisRes.rule_rejection_rate}  候选可用率 ${synthesisRes.candidate_usable_rate}  期望命中 ${synthesisRes.expected_match_rate}`);
    console.log(`    错误候选文本 ${synthesisRes.wrong_candidate_texts}  错误取值被采纳 ${synthesisRes.wrong_value_adopted}  采纳错误 ${synthesisRes.adoption_errors}`);
    if (emotionRes.status === 'RUN') {
      console.log(`  情绪 ${emotionRes.cases} 条：准确率 ${emotionRes.accuracy}（${emotionRes.model}，实验诊断）`);
      for (const [g, v] of Object.entries(emotionRes.by_group)) console.log(`    ${g}: ${v.correct}/${v.cases}`);
    } else {
      console.log(`  情绪：NOT_RUN — ${emotionRes.reason}`);
    }
    console.log(`  硬门槛：${ok ? '通过' : '未通过'}  ${JSON.stringify(hardGates)}`);
    if (manifestCheck.status === 'DRIFT') console.log(`  manifest 错误：${manifestCheck.errors.join('; ')}`);
    if (retrievalRes.failures.length) {
      console.log('  检索未命中样例（前 10）：');
      for (const f of retrievalRes.failures) console.log(`    ${f.case} 「${f.query}」期望 ${JSON.stringify(f.expected)} 实际 ${JSON.stringify(f.got)}`);
    }
    if (synthesisRes.failures.length) {
      console.log('  合成期望不符样例（前 20）：');
      for (const f of synthesisRes.failures) console.log(`    ${f.id} [${f.kind}] 期望 ${f.expected} 实际 ${f.actual}：${f.reasons.join('; ')}`);
    }
  }

  return ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`评测失败：${err && err.message ? err.message : err}`);
  process.exitCode = 2;
});
