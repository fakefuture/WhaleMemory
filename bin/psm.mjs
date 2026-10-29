#!/usr/bin/env node
// bin/psm.mjs — PSM v0.2 命令行入口。零依赖，Node 18+。
//
// 规则：
//   - 所有写操作经 MemoryService（同一事务、跨进程锁、revision）；
//   - query 默认只读，--touch 才更新访问计数；
//   - 模型只生成候选，采纳必须显式 candidates accept 并给理由；
//   - doctor 只读，repair 默认 dry-run 且必须 --reason。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MemoryService, isOpenConflict } from '../lib/service.mjs';
import {
  readSnapshot, writeStore, storeStatus, migrate as repoMigrate,
  createSnapshot, listSnapshots, verifySnapshot, restoreSnapshot,
} from '../lib/repository.mjs';
import { emptyStore, defaultConfig, findAnyRecord, sha256Text } from '../lib/schema.mjs';
import { parseList } from '../lib/util.mjs';
import {
  embedConfig, fingerprintOf, attachVectors, collectVectors, safeLoadVectors, saveVectors, embedAll, embedOne,
} from '../lib/embed.mjs';
import { synthConfig, synthesizePending, generateSynthesis } from '../lib/synth.mjs';
import { runDoctor, repair as doctorRepair } from '../lib/doctor.mjs';
import {
  addCold, listCold, getCold, verifyCold, coldStats, repairCold,
} from '../lib/cold.mjs';
import {
  loadProbes, scoreRun, personaFingerprint, loadRuns, runsPath,
} from '../lib/probe.mjs';
import { loadScales } from '../lib/scales.mjs';
import {
  renderInjected, renderPersonaCard, renderImpressionBlock, emotionSnapshot, RENDER_VERSION,
} from '../lib/render.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { runSelfTest } from './selftest.mjs';
import {
  updatePersona, setPersona, setPersonaCard, personaHistory, rollbackPersona,
  recordCandidate,
} from '../lib/ops.mjs';
import {
  buildModel as buildEmotionModel, classify as classifyEmotion, readAxes,
  loadModel as loadEmotionModel, saveModel as saveEmotionModel,
  saveState as saveEmotionState, acceptEmotion, loadState as loadEmotionState,
  loadStates as loadEmotionStates, saveStates as saveEmotionStates, envSession, activeKey,
  forgetSession, loadRules, emotionStateAt, dampingLine,
} from '../lib/emotion.mjs';

// import.meta.dirname 只在新版 Node 存在；核心 CLI 声明支持 Node 18+，用 fileURLToPath 派生。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[i + 1];
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

function contentOf(flags, positionals, from = 1) {
  if (flags.file) return fs.readFileSync(path.resolve(String(flags.file)), 'utf8').trim();
  return positionals.slice(from).join(' ').trim() || readStdin();
}

function ctxFlags(flags, extra = {}) {
  return {
    sessionId: flags.session ? String(flags.session) : (extra.sessionId ?? null),
    requestId: flags['request-id'] ? String(flags['request-id']) : (extra.requestId ?? null),
    actor: flags.actor ? String(flags.actor) : 'user',
    ...extra,
  };
}

function printJson(out) {
  console.log(JSON.stringify(out, null, 2));
}

function fmtRow(n, r) {
  const lines = [];
  const dense = r.dense_score === null || r.dense_score === undefined ? '-' : r.dense_score;
  lines.push(`${n}. [${r.tier}/${r.scope}/${r.review_status}] score=${r.score} lex=${r.lexical_score} dense=${dense} s=${r.strength} id=${r.id}`);
  lines.push(`   ${String(r.content || '').replace(/\s+/g, ' ').slice(0, 200)}`);
  if (r.time_unknown) lines.push('   time=unknown（历史过滤不会把它当成精确时间）');
  if (r.needs_synthesis) lines.push('   ⚠ needs_synthesis：候选，需审核');
  return lines.join('\n');
}

function usage() {
  return `PSM 记忆库 CLI（v0.2）

  建库与迁移
    init [--workspace <id>] [--owner <id>]
    migrate [--apply] [--no-backup]          默认 dry-run；--apply 才写
    restore --from <快照目录> --to <新目录> [--force]
    backup create [--label <名>] | backup list | backup verify [--name <名>|--all] | backup prune --keep <n>

  写入
    add "<内容>" | --file <路径>
        [--tier semantic|episodic|working] [--scope global|workspace|session]
        [--confidence 0.8] [--tag a,b] [--domain preference|personal|factual|security]
        [--supersedes <id,...>] [--candidate] [--note "..."] [--evidence "<原文>"]
        [--occurred-at <ISO>] [--session <id>]

  读取（默认只读）
    query "<问题>" [--limit 8] [--scope g|workspace|session] [--tier t]
        [--at <ISO>] [--lexical-only] [--offline] [--touch] [--session <id>]
        [--with-dormant] [--history] [--candidates] [--all-scopes] [--explain]
    explain <id>
    context ["问题"] [--session <id>] [--budget 400] [--json]
    feedback <id> good|bad [--request-id <id>] [--note "为什么"]
    revive <id> [--reason "为什么"]

  候选与合成
    candidates list [--kind capture|synthesis|consolidation] [--all]
    candidates show <id>
    candidates accept <id> --note "采纳理由" [--ack-inconclusive]
    candidates reject <id> [--note "拒绝理由"]
    merge --ids <id,id,...> --content "<措辞>" [--accept --note "…"]
    synthesize [--dry-run] [--limit 20] [--enable] [--model <名>]

  整理
    consolidate [--dry-run] | reorg [--dry-run] | decay [--top-k 20] [--dry-run]
    conflicts [--open|--suspect] | resolve <冲突id> keep-a|keep-b|both [--note "…"]
    session-end [--request-id <id>] [--emotion "<最后一条用户消息>"]

  人格 / 印象 / 探针 / 情绪
    persona show | persona card [--set "…" | --set-file <路径>]
    persona update --trait <名> --value <0.7|标签> [--note "…"]
    persona set --trait <名> --value <0.7|标签> [--note "…"]
    persona history | persona rollback --index <n>
    impression add "<内容>" [--weight 0.6] | impression list | impression remove <id>
    probe list | probe score --file answers.json | probe runs
    emotion build [--file docs/emotion-corpus.json] | emotion track "<文本>" | emotion classify "<文本>"
    emotion state [--session <id>] | emotion sessions | emotion use <id> | emotion forget <id> | emotion show

  维护
    capture [--all|--session <id>|--file <路径>] [--dry-run] [--limit 6] [--max 12] [--quiet]
    embed [--enable] [--url <http://…>] [--model <名>] [--provider ollama|openai] [--num-gpu 0] [--force]
    doctor [--json]
    repair [--apply] [--only content-hash,vectors,cold,lock|all] --reason "…"
    cold add "<内容>"|--file <路径> [--title …] [--kind note|doc|conversation|log] [--tag a,b]
    cold list [--kind k] [--limit n] | cold get <id> [--out <文件>] | cold verify | cold stats
    cold repair [--apply] --reason "…"
    report
    config [--json]
    selftest

  通用：--root <目录> 或环境变量 PSM_ROOT，默认当前工作目录。
        --json 输出机器可读 JSON。--offline 本次不请求嵌入服务。`;
}

// ---------------------------------------------------------------- 嵌入辅助

async function queryVectorOf(cfg, text, offline) {
  if (!cfg.enabled || offline || !String(text || '').trim()) return null;
  try {
    return await embedOne(cfg, text);
  } catch (err) {
    console.warn(`嵌入服务不可用（${err.message}），本次只用词面通道`);
    return null;
  }
}

function scaleInputs(store) {
  const scales = loadScales();
  const priorities = {};
  for (const key of Object.keys((store && store.persona && store.persona.traits) || {})) {
    const p = Number(scales[key] && scales[key].priority);
    if (Number.isFinite(p)) priorities[key] = p;
  }
  return { scales, priorities };
}

function moodForSession(root, session) {
  if (!session) return null; // 没有会话上下文就不套用其他会话的情绪
  const st = loadEmotionState(root, session);
  if (!st) return null;
  const snap = emotionSnapshot({ state: { ...st, subject: st.subject || 'user_observed' }, rules: loadRules(root), now: Date.now() });
  return snap.line || null;
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0] || 'help';
  if (cmd === 'help' || flags.help === true) { console.log(usage()); return 0; }

  if (cmd === 'selftest') {
    return runSelfTest();
  }

  const root = path.resolve(flags.root || process.env.PSM_ROOT || process.cwd());
  const json = flags.json === true;
  const offline = flags.offline === true;

  // ---- 建库/迁移/恢复：不依赖已有 store
  if (cmd === 'init') {
    try {
      const snap = readSnapshot(root);
      if (json) printJson({ status: 'exists', root, version: snap.version, revision: snap.doc.revision });
      else console.log(`已存在 v${snap.version}，revision ${snap.doc.revision}：${storeStatus(root).store}`);
      return 0;
    } catch (err) {
      if (!['FILE_NOT_FOUND', 'NO_STORE'].includes(err.code)) throw err;
    }
    const doc = emptyStore({
      ownerId: flags.owner ? String(flags.owner) : undefined,
      workspaceId: flags.workspace ? String(flags.workspace) : undefined,
    });
    writeStore(root, doc);
    if (json) printJson({ status: 'created', root, identity: doc.identity });
    else console.log(`已创建 v2 记忆库：${path.join(root, 'memory', 'store.json')}\n  owner=${doc.identity.owner_id} workspace=${doc.identity.workspace_id}`);
    return 0;
  }

  if (cmd === 'migrate') {
    const apply = flags.apply === true;
    const res = await repoMigrate(root, { dryRun: !apply, backup: flags['no-backup'] !== true });
    if (json) printJson({ root, dry_run: !apply, ...res });
    else {
      if (res.status === 'dry_run') {
        console.log(`【dry-run】v1 → v2 预计：记录 ${res.report.records ?? '?'} 条，证据 ${res.report.evidence ?? '?'} 条`);
        console.log(`  工作区：${res.workspace_id}`);
        for (const [k, v] of Object.entries(res.report || {})) {
          if (typeof v === 'number' || typeof v === 'string') console.log(`  ${k}: ${v}`);
        }
        console.log('\n确认后运行：migrate --apply（会先完整备份并校验）');
      } else if (res.status === 'noop') {
        console.log(res.message);
      } else {
        console.log(`迁移完成：v2 revision ${res.revision ?? '?'}${res.backup ? `，备份 ${res.backup.name || res.backup.dir}` : ''}`);
        for (const [k, v] of Object.entries(res.report || {})) {
          if (typeof v === 'number' || typeof v === 'string') console.log(`  ${k}: ${v}`);
        }
      }
    }
    return ['noop', 'dry_run', 'applied'].includes(res.status) ? 0 : 1;
  }

  if (cmd === 'restore') {
    const res = restoreSnapshot({ from: flags.from, to: flags.to, force: flags.force === true });
    if (json) printJson(res);
    else console.log(`已恢复到 ${res.to}：${res.files} 个文件，哈希全部一致\n${res.next}`);
    return 0;
  }

  if (cmd === 'backup') {
    const sub = positionals[1] || 'list';
    let out;
    if (sub === 'create') {
      const snap = createSnapshot(root, { label: flags.label ? String(flags.label) : 'manual' });
      out = { status: 'ok', name: snap.name, dir: snap.dir, files: snap.files, bytes: snap.bytes };
      if (!json) console.log(`已创建 ${out.name}：${out.files} 个文件 / ${(out.bytes / 1024).toFixed(0)} KB\n  ${out.dir}`);
    } else if (sub === 'verify') {
      const snaps = listSnapshots(root);
      const targets = flags.all === true ? snaps : snaps.filter((s) => (flags.name ? s.name === String(flags.name) : s.has_manifest)).slice(0, 1);
      if (!targets.length) { console.error('没有可校验的快照：backup create'); return 2; }
      out = targets.map((s) => ({ name: s.name, ...verifySnapshot(s.dir) }));
      if (!json) for (const v of out) console.log(`${v.ok ? 'OK  ' : 'FAIL'}  ${v.name}：${v.checked} 个哈希${v.ok ? '一致' : `，坏 ${v.bad.length} 个`}`);
      if (out.some((v) => !v.ok)) process.exitCode = 1;
    } else if (sub === 'prune') {
      const keep = Math.max(0, Number(flags.keep ?? 10));
      const snaps = listSnapshots(root);
      const victims = snaps.slice(keep);
      const removed = [];
      for (const v of victims) {
        const resolved = path.resolve(v.dir);
        if (!resolved.startsWith(path.resolve(root, 'backups') + path.sep)) continue;
        fs.rmSync(resolved, { recursive: true, force: true });
        removed.push(v.name);
      }
      out = { kept: Math.min(keep, snaps.length), removed };
      if (!json) console.log(`保留 ${out.kept} 个快照，删除 ${removed.length} 个`);
    } else {
      out = listSnapshots(root);
      if (!json) {
        if (!out.length) console.log('还没有快照：backup create');
        for (const b of out) console.log(`  ${b.name}  ${b.files ?? '?'} 文件  ${b.at || ''}${b.has_manifest ? '' : '  ⚠ 无清单'}`);
      }
    }
    if (json) printJson(out);
    return 0;
  }

  // ---- 其余命令统一走 MemoryService
  const snap = readSnapshot(root);
  const service = new MemoryService({ root, context: ctxFlags(flags) });
  const cfg = embedConfig(snap.doc);
  const fp = fingerprintOf(cfg);
  const loaded = safeLoadVectors(root);
  const attachInfo = attachVectors(snap.doc, loaded.doc, fp);
  if (!json && loaded.error) console.warn(`向量缓存损坏，已忽略：${loaded.error}`);
  let out = null;

  switch (cmd) {
    case 'add': {
      const content = contentOf(flags, positionals, 1);
      if (!content) { console.error('用法：add "<内容>" | --file <路径>'); return 2; }
      const emb = await queryVectorOf(cfg, content, offline);
      const input = {
        content,
        tier: flags.tier,
        scope: flags.scope,
        confidence: flags.confidence !== undefined ? Number(flags.confidence) : undefined,
        tags: parseList(flags.tag),
        domain: flags.domain,
        supersedes: parseList(flags.supersedes),
        protected: flags.protected === true,
        source: flags.source || 'manual',
        note: flags.note ? String(flags.note) : null,
        evidence: flags.evidence !== undefined && flags.evidence !== true ? { text: String(flags.evidence), kind: 'manual', actor: 'user' } : undefined,
        embedding: emb,
        review_status: flags.candidate === true || flags.review === 'candidate' ? 'candidate' : 'accepted',
        time: flags['occurred-at'] ? { occurred_at: String(flags['occurred-at']) } : undefined,
      };
      out = await service.add(input);
      if (!json) {
        if (out.status === 'added') {
          console.log(`已写入 ${out.id}（${out.tier}/${out.scope}，${out.review_status}，evidence ${out.evidence_ids.length} 条）`);
          if (out.superseded.length) console.log(`已纠错：${out.superseded.join(', ')} 保留旧正文，标记 superseded`);
          if (out.conflicts.length) console.log(`疑似冲突 ${out.conflicts.length} 条（只标记，不降权）：${out.conflicts.map((c) => c.id).join(', ')}`);
        } else if (out.status === 'duplicate') {
          console.log(`重复内容，未新建；命中 ${out.id}`);
        } else {
          console.log(`拒绝：${out.reason}`);
          if (out.code) process.exitCode = out.code === 'FORBIDDEN_SCOPE' ? 3 : 2;
        }
      }
      break;
    }

    case 'query': {
      const text = contentOf(flags, positionals, 1);
      if (!text) { console.error('用法：query "<问题>"'); return 2; }
      if (flags['all-scopes'] === true && flags.touch === true) {
        console.error('--all-scopes 是只读诊断查询，不能与 --touch 同用');
        return 2;
      }
      const queryVector = flags['lexical-only'] === true ? null : await queryVectorOf(cfg, text, offline);
      out = await service.query(text, {
        limit: flags.limit !== undefined ? Number(flags.limit) : undefined,
        scope: flags.scope ? String(flags.scope) : null,
        tier: flags.tier ? String(flags.tier) : null,
        at: flags.at ? String(flags.at) : null,
        lexicalOnly: flags['lexical-only'] === true,
        allScopes: flags['all-scopes'] === true,
        includeDormant: flags['with-dormant'] === true,
        includeHistory: flags.history === true,
        includeCandidates: flags.candidates === true,
        touch: flags.touch === true,
        queryVector,
        context: { sessionId: flags.session ? String(flags.session) : null },
      });
      if (!json) {
        if (!out.results.length) {
          console.log(`（无命中：${out.reason || 'no_result_above_threshold'}）`);
        }
        out.results.forEach((r, i) => console.log(fmtRow(i + 1, r)));
        if (out.disputed.length) {
          console.log(`\n争议 ${out.disputed.length} 条（不作为单一结论）：`);
          for (const d of out.disputed) console.log(`  ${d.id} ${d.content.slice(0, 80)}`);
        }
        if (flags.history === true && out.history.length) {
          console.log(`\n历史版本 ${out.history.length} 条：`);
          for (const h of out.history) console.log(`  ${h.id} [${h.validity}] ${h.content.slice(0, 80)}`);
        }
        if (flags.candidates === true && out.candidates.length) {
          console.log(`\n候选 ${out.candidates.length} 条（需审核）：`);
          for (const c of out.candidates) console.log(`  ${c.id} ${c.content.slice(0, 80)}`);
        }
        if (out.touched && out.touched.length) console.log(`\n已 touch：${out.touched.length} 条只更新访问计数与时间`);
        for (const w of out.warnings || []) console.log(`提示：${w}`);
        if (flags.explain === true) {
          const d = out.diagnostics || {};
          console.log(`\n[explain] 门槛 lexical>${d.thresholds?.lexical} dense>${d.thresholds?.dense} tentative=${d.thresholds?.tentative}`);
          console.log(`  池 ${d.pool}，过门槛 ${d.scored}，排除计数 ${JSON.stringify(d.excluded || {})}`);
          for (const r of out.results) {
            console.log(`  ${r.id} score=${r.score} ${r.explanation?.why || ''}`);
            console.log(`    components=${JSON.stringify(r.components)} fused=${r.fused_score}`);
          }
        }
      }
      break;
    }

    case 'explain': {
      const id = positionals[1];
      if (!id) { console.error('用法：explain <id>'); return 2; }
      out = service.explain(id, { context: ctxFlags(flags) });
      if (!json) {
        if (out.status !== 'ok') {
          console.log(`未找到 ${id}${out.reason ? `（${out.reason}）` : ''}`);
          process.exitCode = 1;
        } else {
          const r = out.record;
          console.log(`${r.id} [${r.tier}/${r.scope}/${r.review_status}/${r.validity}] state=${r.state}`);
          console.log(`  ${r.content}`);
          console.log(`  hash=${r.content_hash} revision=${r.content_revision} 证据=${out.evidence.length} 条`);
          console.log(`  verification: ${r.verification?.method || '无'}${r.verification?.note ? ` — ${r.verification.note}` : ''}`);
          console.log(`  ${out.qualifier}`);
          for (const e of out.evidence) console.log(`  evidence ${e.id} [${e.kind}/${e.actor}] ${e.redacted ? '(已脱敏)' : String(e.text || '').slice(0, 100)}`);
          for (const c of out.conflicts) console.log(`  conflict ${c.id} [${c.status}] ${c.a} ↔ ${c.b} ${c.reason}`);
          if (out.relations.derived_from.length) console.log(`  derived_from: ${out.relations.derived_from.join(', ')}`);
          if (out.relations.descendants.length) console.log(`  descendants: ${out.relations.descendants.join(', ')}`);
        }
      }
      break;
    }

    case 'feedback': {
      const id = positionals[1];
      const verdict = positionals[2];
      if (!id || !verdict) { console.error('用法：feedback <id> good|bad'); return 2; }
      out = await service.feedback(id, verdict, {
        context: ctxFlags(flags), requestId: flags['request-id'] ? String(flags['request-id']) : null, note: flags.note || null,
      });
      if (!json) {
        if (out.status === 'not_found') console.log(`没找到 ${id}`);
        else if (out.status === 'duplicate') console.log(`重复请求，未重复累计（${out.idempotency_key}）`);
        else console.log(`${out.id} ${out.verdict} → strength=${out.strength} decay_rate=${out.decay_rate} utility=${out.utility} state=${out.state}`);
      }
      if (out.status === 'not_found') process.exitCode = 1;
      break;
    }

    case 'revive': {
      const id = positionals[1];
      if (!id) { console.error('用法：revive <id> [--reason "…"]'); return 2; }
      out = await service.revive(id, { context: ctxFlags(flags), reason: flags.reason || null });
      if (!json) console.log(out.status === 'ok' ? `已唤醒 ${out.id}` : (out.status === 'not_found' ? `没找到 ${id}` : `${out.status}：${out.state || ''}`));
      if (out.status === 'not_found') process.exitCode = 1;
      break;
    }

    case 'candidates': {
      const sub = positionals[1] || 'list';
      if (sub === 'show') {
        out = service.showCandidate(positionals[2], { context: ctxFlags(flags) });
        if (!json) {
          if (out.status !== 'ok') console.log(`没找到候选 ${positionals[2]}`);
          else {
            const c = out.candidate;
            console.log(`${c.id} [${c.review_status}/${c.validity}] kind=${c.proposal?.kind || 'capture'} tier=${c.tier} scope=${c.scope}`);
            console.log(`  当前：${c.content}`);
            if (out.diff) console.log(`  建议：${out.diff.to}`);
            if (out.validation) console.log(`  校验：${out.validation.status}${out.validation.reasons?.length ? ` — ${out.validation.reasons.join('；')}` : ''}`);
            for (const s of out.sources) console.log(`  来源 ${s.id}${s.missing ? '（缺失）' : ` [${s.review_status}/${s.validity}] ${String(s.content || '').slice(0, 80)}`}`);
            if (out.failures.length) for (const f of out.failures) console.log(`  失败记录：${f.reason}`);
            console.log(`  ${out.note}`);
          }
        }
        if (out.status !== 'ok') process.exitCode = 1;
        break;
      }
      if (sub === 'accept') {
        const id = positionals[2];
        if (!id) { console.error('用法：candidates accept <id> --note "采纳理由"'); return 2; }
        out = await service.acceptCandidate(id, {
          context: ctxFlags(flags), note: flags.note || null, ackInconclusive: flags['ack-inconclusive'] === true,
        });
        if (!json) {
          if (out.status === 'accepted') console.log(`已采纳 ${out.id}；归档来源 ${out.archived.length} 条`)
          else if (out.status === 'already_accepted') console.log(`已经采纳过 ${id}，未重复生成记录`);
          else console.log(`未采纳：${out.reason || out.status}`);
        }
        if (!['accepted', 'already_accepted'].includes(out.status)) process.exitCode = 2;
        break;
      }
      if (sub === 'reject') {
        out = await service.rejectCandidate(positionals[2], { context: ctxFlags(flags), note: flags.note || null });
        if (!json) {
          if (out.status === 'rejected') console.log(`已拒绝 ${out.id}`);
          else if (out.status === 'already_rejected') console.log(`已经拒绝过 ${positionals[2]}`);
          else console.log(`未拒绝：${out.reason || out.status}`);
        }
        if (!['rejected', 'already_rejected'].includes(out.status)) process.exitCode = 2;
        break;
      }
      out = service.listCandidates({
        kind: flags.kind ? String(flags.kind) : null,
        status: flags.all === true ? null : 'candidate',
        context: ctxFlags(flags),
      });
      if (!json) {
        if (!out.length) console.log('没有待审核候选');
        for (const c of out) {
          console.log(`  ${c.id}  ${c.kind}/${c.tier} ${c.review_status}${c.needs_synthesis ? ' 需合成' : ''}  ${String(c.proposed_text || c.content).slice(0, 90)}`);
        }
      }
      break;
    }

    case 'merge': {
      const ids = parseList(flags.ids || positionals.slice(1).filter((x) => x.startsWith('mem_')).join(','));
      const content = flags.file ? fs.readFileSync(path.resolve(String(flags.file)), 'utf8').trim() : String(flags.content ?? '');
      out = await service.merge({
        ids, content, context: ctxFlags(flags),
        accept: flags.accept === true, note: flags.note || null, model: flags.model ? String(flags.model) : 'manual',
      });
      if (!json) {
        if (out.status === 'candidate') console.log(`已创建候选 ${out.id}（校验 ${out.validation?.status}）。${out.note || ''}`);
        else if (out.status === 'accepted') console.log(`已采纳 ${out.id}，归档来源 ${out.archived.length} 条`);
        else console.log(`失败：${out.reason || out.status}`);
      }
      if (!['candidate', 'accepted'].includes(out.status)) process.exitCode = 2;
      break;
    }

    case 'consolidate': case 'reorg': case 'decay': {
      if (cmd === 'consolidate') out = await service.consolidate({ context: ctxFlags(flags), dryRun: flags['dry-run'] === true });
      else if (cmd === 'reorg') out = await service.reorg({ context: ctxFlags(flags), dryRun: flags['dry-run'] === true });
      else out = await service.decay({ context: ctxFlags(flags), topK: flags['top-k'] !== undefined ? Number(flags['top-k']) : null });
      if (!json) {
        if (flags['dry-run'] === true) console.log('【dry-run】未写盘');
        if (cmd === 'decay') {
          console.log(`衰减 ${out.summary?.decayed ?? 0}，休眠 ${out.summary?.archived ?? 0}，工作层沉降 ${out.summary?.settled ?? 0}`);
          for (const d of out.decayed || []) console.log(`  ${d.id} ${d.before} → ${d.after}`);
        } else {
          const plan = out.consolidation || out;
          console.log(`巩固候选 ${plan.promoted?.length ?? 0}，并入 ${plan.absorbed?.length ?? 0}${out.pruned ? `，修剪 ${out.pruned.length}` : ''}`);
          for (const p of plan.promoted || []) console.log(`  候选 ${p.id || '(dry)'} ← ${(p.from || []).join(', ')}`);
          for (const a of plan.absorbed || []) console.log(`  并入 ${a.semantic}：${(a.episodes || []).join(', ')}`);
          for (const p of out.pruned || []) console.log(`  修剪 ${p.id}（被 ${p.by} 覆盖）`);
        }
      }
      break;
    }

    case 'conflicts': {
      let list = snap.doc.conflicts || [];
      if (flags.open === true) list = list.filter((c) => c.status === 'open');
      if (flags.suspect === true) list = list.filter((c) => c.status === 'suspect' || c.legacy_ambiguity === true);
      out = list.map((c) => {
        const a = findAnyRecord(snap.doc, c.a);
        const b = findAnyRecord(snap.doc, c.b);
        return {
          ...c,
          open: isOpenConflict(c),
          a_content: a ? a.content : null,
          b_content: b ? b.content : null,
        };
      });
      if (!json) {
        if (!list.length) console.log('（无冲突记录）');
        for (const c of out) {
          console.log(`[${c.status}${c.legacy_ambiguity ? '/legacy' : ''}] ${c.id} (${c.reason})`);
          console.log(`  a: ${c.a} ${c.a_content ? c.a_content.slice(0, 80) : '(missing)'}`);
          console.log(`  b: ${c.b || '(待定)'} ${c.b_content ? c.b_content.slice(0, 80) : ''}`);
          if (c.note) console.log(`  note: ${c.note}`);
        }
      }
      break;
    }

    case 'resolve': {
      const id = positionals[1];
      const resolution = positionals[2];
      if (!id || !resolution) { console.error('用法：resolve <冲突id> keep-a|keep-b|both'); return 2; }
      out = await service.resolve(id, resolution, { context: ctxFlags(flags), note: flags.note || null });
      if (!json) {
        if (out.status === 'ok') console.log(`已处理 ${id}：${resolution}${out.note ? `；${out.note}` : ''}`);
        else if (out.status === 'noop') console.log(`已经是该裁决，未重复写入`);
        else console.log(`失败：${out.reason || out.status}`);
      }
      if (!['ok', 'noop'].includes(out.status)) process.exitCode = 2;
      break;
    }

    case 'synthesize': {
      if (flags.enable === true || typeof flags.model === 'string') {
        await service.write(async (tx, ctx) => {
          if (flags.enable === true) tx.doc.config.synth.enabled = true;
          if (typeof flags.model === 'string') tx.doc.config.synth.model = String(flags.model);
          tx.op({ op: 'config.synth', reason: 'synthesize 命令行配置', changes: { enabled: flags.enable === true, model: flags.model || null } });
        }, { context: ctxFlags(flags) });
      }
      const fresh = service.snapshot();
      const sc = synthConfig(fresh.doc);
      out = await synthesizePending(service, sc, { dryRun: flags['dry-run'] === true, limit: flags.limit ? Number(flags.limit) : 20, context: ctxFlags(flags) });
      if (!json) {
        if (flags['dry-run'] === true) console.log('【dry-run】未写盘');
        if (!sc.enabled) console.log('提示：synth.enabled=false，模型不会被自动调用；本次显式运行仍会请求');
        console.log(`模型 ${sc.model} @ ${sc.url}`);
        console.log(`待合成 ${out.pending ?? (out.pending || []).length}：成功 ${out.done?.length ?? 0}，失败 ${out.failed?.length ?? 0}`);
        for (const d of out.done || []) console.log(`  ${d.id} ← ${(d.from || []).join(', ')}`);
        for (const f of out.failed || []) console.log(`  失败 ${f.id}：${f.reason}`);
      }
      if ((out.failed || []).length) process.exitCode = 1;
      break;
    }

    case 'session-end': {
      const emoText = flags['emotion-file']
        ? fs.readFileSync(path.resolve(String(flags['emotion-file'])), 'utf8')
        : (typeof flags.emotion === 'string' ? flags.emotion : '');
      let emoRes = null;
      if (String(emoText).trim()) emoRes = await trackEmotion(root, snap.doc, emoText, flags.session ? String(flags.session) : null);
      out = await service.endSession({
        context: ctxFlags(flags),
        requestId: flags['request-id'] ? String(flags['request-id']) : null,
      });
      out.emotion = emoRes;
      if (!json) {
        if (out.status === 'duplicate') console.log(`同一 requestId 已收尾过：${out.request_id}`);
        else {
          console.log(`会话收尾：衰减 ${out.decay?.decayed ?? 0}，休眠 ${out.decay?.archived ?? 0}，候选巩固 ${out.promoted?.length ?? 0}`);
          if (emoRes) console.log(emoRes.ok ? `情绪：${emoRes.state.emotion || '中性'} ${emoRes.state.score ?? ''}` : `情绪跳过：${emoRes.reason}`);
        }
      }
      break;
    }

    case 'persona': {
      const sub = positionals[1] || 'show';
      if (sub === 'card') {
        const raw = flags['set-file']
          ? fs.readFileSync(path.resolve(String(flags['set-file'])), 'utf8')
          : (flags.set !== undefined && flags.set !== true ? String(flags.set) : undefined);
        if (raw !== undefined) {
          const w = await service.write(async (tx, ctx) => {
            const res = setPersonaCard(tx.doc, raw, flags.note || null);
            if (res.status === 'ok') tx.op({ op: 'persona.card', reason: flags.note || null, changes: { chars: res.chars } });
            return res;
          }, { context: ctxFlags(flags) });
          out = w.result;
          if (!json) console.log(`已写入人格卡片：${out.chars} 字，约 ${out.tokens} token`);
        } else {
          const { scales, priorities } = scaleInputs(snap.doc);
          const mood = moodForSession(root, flags.session ? String(flags.session) : null);
          out = renderPersonaCard({ persona: snap.doc.persona || {}, config: snap.doc.config || {}, scales, priorities, mood });
          if (!json) {
            console.log(out.text);
            console.log(`\n约 ${out.tokens} / ${out.budget} token${out.over ? '（超预算）' : ''}`);
          }
        }
        break;
      }
      if (sub === 'update' || sub === 'set') {
        const raw = flags['value-file'] ? fs.readFileSync(path.resolve(String(flags['value-file'])), 'utf8').trim() : flags.value;
        const value = raw !== undefined && /^-?\d+(\.\d+)?$/.test(String(raw)) ? Number(raw) : raw;
        out = (await service.write(async (tx) => {
          const fn = sub === 'set' ? setPersona : updatePersona;
          const res = fn(tx.doc, { trait: flags.trait, value, note: flags.note || null });
          if (res.status !== 'rejected') tx.op({ op: `persona.${sub}`, reason: flags.note || null, changes: { trait: flags.trait } });
          return res;
        }, { context: ctxFlags(flags) })).result;
        if (!json) console.log(out.status === 'rejected' ? `失败：${out.reason}` : `已${sub === 'set' ? '直接改写' : '更新'} ${out.trait}`);
        if (out.status === 'rejected') process.exitCode = 2;
        break;
      }
      if (sub === 'candidate') {
        const raw = flags.value;
        const value = raw !== undefined && /^-?\d+(\.\d+)?$/.test(String(raw)) ? Number(raw) : raw;
        out = (await service.write(async (tx) => {
          const res = recordCandidate(tx.doc, { trait: flags.trait, value, note: flags.note || null, strong: flags.strong === true });
          if (res.status !== 'rejected') tx.op({ op: 'persona.candidate', changes: { trait: flags.trait, status: res.status } });
          return res;
        }, { context: ctxFlags(flags) })).result;
        if (!json) console.log(out.status === 'rejected' ? `失败：${out.reason}` : `${out.status} ${out.trait || ''} ${out.value ?? ''}`);
        break;
      }
      if (sub === 'history') {
        out = personaHistory(snap.doc);
        if (!json) {
          if (!out.length) console.log('没有历史版本');
          for (const v of out) console.log(`  #${v.index}  ${v.at}  ${v.chars} 字  ${v.traits} 特质`);
        }
        break;
      }
      if (sub === 'rollback') {
        out = (await service.write(async (tx) => {
          const res = rollbackPersona(tx.doc, flags.index);
          if (res.status === 'ok') tx.op({ op: 'persona.rollback', changes: { index: Number(flags.index) } });
          return res;
        }, { context: ctxFlags(flags) })).result;
        if (!json) console.log(out.status === 'ok' ? `已回滚到 #${out.index}` : `失败：${out.reason}`);
        break;
      }
      const { scales, priorities } = scaleInputs(snap.doc);
      const card = renderPersonaCard({ persona: snap.doc.persona || {}, config: snap.doc.config || {}, scales, priorities });
      out = { card, traits: snap.doc.persona?.traits || {}, fingerprint: personaFingerprint(snap.doc) };
      if (!json) {
        console.log(card.text);
        console.log(`\n指纹 ${out.fingerprint}，特质 ${Object.keys(out.traits).length} 条`);
      }
      break;
    }

    case 'impression': {
      const sub = positionals[1] || 'list';
      if (sub === 'add') {
        const text = contentOf(flags, positionals, 2);
        if (!text) { console.error('用法：impression add "<内容>" [--weight 0.6]'); return 2; }
        out = (await service.write(async (tx, ctx) => {
          const list = tx.doc.impression.items;
          const dup = list.find((x) => String(x.text).trim() === text.trim());
          if (dup) return { status: 'duplicate', id: dup.id };
          const id = `imp_${sha256Text(text).slice(0, 12)}`;
          const item = { id, text: text.trim(), weight: Math.max(0, Math.min(1, Number(flags.weight ?? 0.6) || 0.6)), note: flags.note || null, at: ctx.now };
          list.push(item);
          tx.op({ op: 'impression.add', target: id, reason: flags.note || null });
          return { status: 'added', id, weight: item.weight };
        }, { context: ctxFlags(flags) })).result;
        if (!json) console.log(out.status === 'added' ? `已加入印象 ${out.id}（权重 ${out.weight}）` : `已存在：${out.id}`);
        break;
      }
      if (sub === 'remove') {
        const id = positionals[2];
        out = (await service.write(async (tx) => {
          const before = tx.doc.impression.items.length;
          tx.doc.impression.items = tx.doc.impression.items.filter((x) => x.id !== id);
          if (tx.doc.impression.items.length !== before) tx.op({ op: 'impression.remove', target: id });
          return { status: before === tx.doc.impression.items.length ? 'not_found' : 'ok', id };
        }, { context: ctxFlags(flags) })).result;
        if (!json) console.log(out.status === 'ok' ? `已删除 ${id}` : `没找到 ${id}`);
        break;
      }
      const block = renderImpressionBlock({ impression: snap.doc.impression || {}, config: snap.doc.config || {} });
      out = { items: snap.doc.impression?.items || [], block };
      if (!json) {
        for (const it of out.items) console.log(`  ${it.id}  w=${it.weight}  ${it.text}`);
        if (block.text) console.log(`\n${block.text}\n\n注入约 ${block.tokens} / ${block.budget} token`);
      }
      break;
    }

    case 'probe': {
      const sub = positionals[1] || 'list';
      const probes = loadProbes(root);
      if (sub === 'score') {
        if (!flags.file) { console.error('用法：probe score --file answers.json'); return 2; }
        let raw = fs.readFileSync(path.resolve(String(flags.file)), 'utf8');
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
        const res = scoreRun(probes, JSON.parse(raw));
        const run = { at: new Date().toISOString(), fingerprint: personaFingerprint(snap.doc), ...res };
        const runs = loadRuns(root);
        runs.push(run);
        writeJsonAtomic(runsPath(root), { runs });
        out = run;
        if (!json) {
          console.log(`得分 ${res.score}（${res.passed}/${res.total}）指纹 ${run.fingerprint}`);
          for (const d of res.details) console.log(`  ${d.pass ? 'PASS' : 'FAIL'} ${d.id}${d.pass ? '' : ` ${d.reasons.join('；')}`}`);
        }
        break;
      }
      if (sub === 'runs') {
        out = loadRuns(root);
        if (!json) {
          if (!out.length) console.log('还没有探针记录');
          for (const r of out) console.log(`  ${r.at}  ${r.score}  ${r.passed}/${r.total}  指纹 ${r.fingerprint}`);
        }
        break;
      }
      out = probes;
      if (!json) {
        console.log(`探针 ${probes.length} 条（确定性判据）`);
        for (const p of probes) console.log(`  ${p.id}  ${p.ask}`);
      }
      break;
    }

    case 'emotion': {
      const sub = positionals[1] || 'show';
      if (sub === 'build') {
        const file = path.resolve(flags.file ? String(flags.file) : path.join(REPO_ROOT, 'docs', 'emotion-corpus.json'));
        let corpus;
        try { corpus = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (err) { console.error(`读不到语料：${file}\n${err.message}`); return 2; }
        let ecfg = embedConfig(snap.doc);
        if (typeof flags.model === 'string') ecfg = { ...ecfg, model: String(flags.model) };
        if (typeof flags.url === 'string') ecfg = { ...ecfg, url: String(flags.url) };
        let built;
        try { built = await buildEmotionModel({ corpus, model: ecfg.model, embed: (t) => embedOne(ecfg, t) }); } catch (err) { console.error(`构建失败：${err.message}`); return 1; }
        const outFile = saveEmotionModel(root, built);
        out = { file: outFile, model: built.model, dim: built.dim, emotions: Object.keys(built.emotions) };
        if (!json) console.log(`模型 ${built.model}，维度 ${built.dim}，情绪 ${out.emotions.length} 个 → ${outFile}`);
        break;
      }
      if (sub === 'track') {
        const text = contentOf(flags, positionals, 2);
        if (!text) { console.error('用法：emotion track "<文本>"'); return 2; }
        const sess = flags.session ? String(flags.session) : envSession();
        const res = await trackEmotion(root, snap.doc, text, sess);
        if (!res.ok) { console.error(`失败：${res.reason}`); return 2; }
        out = { ...res.state, session: sess };
        if (!json) console.log(res.lowSignal
          ? `信号不足，记为中性（top ${res.state.scores[0].emotion} ${res.state.scores[0].score}）`
          : `当前情绪：${res.state.emotion} ${res.state.score}（会话 ${sess}）`);
        break;
      }
      if (sub === 'classify') {
        const text = contentOf(flags, positionals, 2);
        if (!text) { console.error('用法：emotion classify "<文本>"'); return 2; }
        const emo = loadEmotionModel(root);
        if (!emo) { console.error('还没有情绪向量：emotion build'); return 2; }
        const ecfg = embedConfig(snap.doc);
        if (emo.model && emo.model !== ecfg.model) { console.error(`模型不一致：${emo.model} != ${ecfg.model}`); return 1; }
        let vec;
        try { vec = await embedOne(ecfg, text); } catch (err) { console.error(`嵌入失败：${err.message}`); return 1; }
        out = { text, scores: classifyEmotion(emo, vec, flags.limit ? Number(flags.limit) : 3), axes: readAxes(emo, vec) };
        if (!json) for (const s of out.scores) console.log(`  ${s.emotion} ${s.score}`);
        break;
      }
      if (sub === 'state') {
        const sess = flags.session ? String(flags.session) : activeKey(root);
        const st = loadEmotionState(root, sess);
        if (!st) { out = { present: false }; if (!json) console.log('没有情绪状态'); break; }
        const snapState = emotionStateAt(root, Date.now(), sess);
        out = { present: true, session: sess, state: st, rendered: snapState };
        if (!json) {
          console.log(`状态：${st.neutral ? '中性' : `${st.emotion} ${st.score}`}（${snapState.ageMin} 分钟前）`);
          console.log(`会注入：${snapState.line ? '是' : '否'}`);
          if (snapState.line) console.log(snapState.line);
        }
        break;
      }
      if (sub === 'sessions') {
        const doc = loadEmotionStates(root);
        out = { active: doc.active, sessions: Object.entries(doc.sessions).map(([k, v]) => ({ session: k, active: k === doc.active, emotion: v.emotion, score: v.score, at: v.at })) };
        if (!json) for (const r of out.sessions) console.log(`  ${r.active ? '*' : ' '} ${r.session} ${r.emotion || '中性'} ${r.score ?? ''}`);
        break;
      }
      if (sub === 'use') {
        const key = positionals[2];
        const doc = loadEmotionStates(root);
        if (!key || !doc.sessions[key]) { console.error(`会话不存在：${key || '(未指定)'}`); return 2; }
        doc.active = key;
        out = { active: key, file: saveEmotionStates(root, doc) };
        if (!json) console.log(`active=${key}`);
        break;
      }
      if (sub === 'forget') {
        out = forgetSession(root, positionals[2]);
        if (!json) console.log(out.status === 'ok' ? `已删除 ${out.key}` : `没找到 ${out.key || ''}`);
        if (out.status !== 'ok') process.exitCode = 1;
        break;
      }
      const loadedEmo = loadEmotionModel(root);
      if (!loadedEmo) { console.error('还没有情绪向量：emotion build'); return 2; }
      out = { model: loadedEmo.model, dim: loadedEmo.dim, built_at: loadedEmo.built_at, emotions: Object.keys(loadedEmo.emotions || {}), axes: Object.keys(loadedEmo.axes || {}) };
      if (!json) console.log(`模型 ${out.model}，维度 ${out.dim}，情绪 ${out.emotions.join(' / ')}`);
      break;
    }

    case 'context': case 'prepare': {
      const query = contentOf(flags, positionals, 1) || null;
      const session = flags.session ? String(flags.session) : null;
      const budget = flags.budget !== undefined ? Number(flags.budget) : 400;
      const mood = moodForSession(root, session);
      out = service.prepareContext({ context: { sessionId: session, mood }, query, budget });
      if (!json) {
        console.log(out.text || '（无内容）');
        console.log(`\n约 ${out.tokens} token${out.no_match !== null ? `；相关块 ${out.no_match ? '无命中' : '有命中'}` : ''}`);
      }
      break;
    }

    case 'embed': {
      let changed = false;
      let ecfg = embedConfig(snap.doc);
      if (flags.enable === true) { snap.doc.config.embed.enabled = true; changed = true; }
      if (typeof flags.url === 'string') { snap.doc.config.embed.url = String(flags.url); changed = true; }
      if (typeof flags.model === 'string') { snap.doc.config.embed.model = String(flags.model); changed = true; }
      if (typeof flags.provider === 'string') { snap.doc.config.embed.provider = String(flags.provider); changed = true; }
      if (flags['num-gpu'] !== undefined && flags['num-gpu'] !== true) { snap.doc.config.embed.num_gpu = Number(flags['num-gpu']); changed = true; }
      if (changed) {
        await service.write(async (tx) => {
          tx.doc.config.embed = { ...snap.doc.config.embed };
          tx.op({ op: 'config.embed', changes: { enabled: tx.doc.config.embed.enabled, model: tx.doc.config.embed.model, url: tx.doc.config.embed.url } });
        }, { context: ctxFlags(flags) });
        ecfg = embedConfig(service.snapshot().doc);
      }
      const efp = fingerprintOf(ecfg);
      const cache = loadVectorsSafe(root);
      attachVectors(snap.doc, cache, efp);
      const res = await embedAll(snap.doc, ecfg, { force: flags.force === true });
      if (res.done > 0) {
        const outCache = collectVectors(snap.doc, efp);
        saveVectors(root, outCache);
      }
      out = { config: ecfg, fingerprint: efp, ...res };
      if (!json) {
        if (!ecfg.enabled) console.log('提示：embed.enabled=false；要启用加 --enable');
        console.log(`模型 ${ecfg.model} @ ${ecfg.url}（${ecfg.provider}），指纹 ${efp.id}`);
        console.log(`目标 ${res.targets} / 共 ${res.total}：成功 ${res.done}，失败 ${res.failed}${res.dim ? `，维度 ${res.dim}` : ''}`);
        if (res.firstError) console.log(`首个错误：${res.firstError}`);
        console.log('向量缓存写入 memory/embeddings.json（含 content_hash / 模型指纹 / 维度）');
      }
      if (res.done === 0 && res.failed > 0) return 1;
      break;
    }

    case 'capture': {
      const args = [path.join(REPO_ROOT, 'tools', 'capture.mjs'), '--root', root];
      for (const key of ['all', 'everywhere', 'dry-run', 'quiet', 'session', 'file', 'days', 'limit', 'max', 'sessions-dir']) {
        if (flags[key] === undefined) continue;
        if (flags[key] === true) args.push(`--${key}`);
        else args.push(`--${key}`, String(flags[key]));
      }
      const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
      return r.status === 0 ? 0 : 1;
    }

    case 'cold': {
      const sub = positionals[1] || 'list';
      if (sub === 'add') {
        const content = contentOf(flags, positionals, 2);
        out = await addCold(root, {
          content,
          title: flags.title || null,
          kind: flags.kind || 'note',
          tags: parseList(flags.tag),
          note: flags.note || null,
          source: flags.source || 'user',
        });
        if (!json) console.log(out.status === 'added' ? `已归档 ${out.id}（${out.bytes} 字节）→ ${out.path}` : (out.status === 'duplicate' ? `内容已存在：${out.id}` : `失败：${out.reason}`));
        if (out.status === 'rejected') return 2;
        break;
      }
      if (sub === 'get') {
        out = getCold(root, positionals[2]);
        if (!json) {
          if (out.status !== 'ok') console.log(`取不到 ${positionals[2]}：${out.status}`);
          else if (flags.out) { fs.writeFileSync(path.resolve(String(flags.out)), out.payload.content, 'utf8'); console.log(`已写出 ${flags.out}`); }
          else console.log(out.payload.content);
        }
        if (out.status !== 'ok') process.exitCode = 1;
        break;
      }
      if (sub === 'verify') {
        out = verifyCold(root);
        if (!json) console.log(out.status === 'ok' ? `OK ${out.checked} 条哈希一致` : `FAIL：${out.bad.map((b) => `${b.id}:${b.status}`).join(', ')}`);
        if (out.status !== 'ok') process.exitCode = 1;
        break;
      }
      if (sub === 'stats') {
        out = coldStats(root);
        if (!json) console.log(`冷存储：${out.count} 条 / ${(out.bytes / 1024).toFixed(1)} KB\n  ${out.dir}`);
        break;
      }
      if (sub === 'repair') {
        out = await repairCold(root, { dryRun: flags.apply !== true, reason: flags.reason || null, actor: 'cli' });
        if (!json) {
          console.log(flags.apply === true ? '已应用修复' : '【dry-run】未写盘');
          console.log(JSON.stringify(out, null, 2));
        }
        if (out.status === 'blocked') process.exitCode = 2;
        break;
      }
      out = listCold(root, { kind: flags.kind || null, limit: flags.limit !== undefined ? Number(flags.limit) : null });
      if (!json) {
        if (!out.length) console.log('冷存储是空的');
        for (const r of out) console.log(`  ${r.id}  ${String(r.at).slice(0, 19)}  [${r.kind}] ${(r.title || '(无标题)').slice(0, 40)}  ${r.bytes}B`);
      }
      break;
    }

    case 'doctor': {
      out = runDoctor(root, snap.doc, [], { context: ctxFlags(flags), version: snap.version });
      if (!json) {
        for (const c of out.checks) console.log(`${c.status === 'ok' ? 'OK  ' : (c.status === 'warn' ? 'WARN' : 'FAIL')}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
        console.log(`\n${out.ok ? '通过' : '有失败项'}：fail ${out.fail} / warn ${out.warn}`);
      }
      if (!out.ok) process.exitCode = 1;
      break;
    }

    case 'repair': {
      out = await doctorRepair(root, {
        apply: flags.apply === true,
        actions: parseList(flags.only || flags.action || ''),
        reason: flags.reason ? String(flags.reason) : null,
        actor: 'cli',
      });
      if (!json) {
        console.log(flags.apply === true ? '已应用修复' : '【dry-run】以下为计划，未写盘；确认后加 --apply');
        for (const r of out.results) console.log(`  ${r.action}: ${r.status}${r.fixed ? ` fixed=${r.fixed}` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      if (out.results.some((r) => r.status === 'failed' || r.status === 'blocked')) process.exitCode = 2;
      break;
    }

    case 'report': {
      const records = snap.doc.records || [];
      const archive = snap.doc.archive || [];
      const candidates = records.filter((r) => r.review_status === 'candidate');
      const accepted = records.filter((r) => r.review_status === 'accepted' && r.validity === 'current');
      const disputed = records.filter((r) => r.validity === 'disputed');
      const conflicts = snap.doc.conflicts || [];
      const cursors = snap.doc.captures?.cursors || {};
      const pendingCapture = Object.values(cursors).reduce((n, c) => n + Math.max(0, (Number(c?.users_total) || 0) - (Number(c?.processed) || 0)), 0);
      const runs = loadRuns(root);
      const snaps = listSnapshots(root);
      const { scales, priorities } = scaleInputs(snap.doc);
      const card = renderPersonaCard({ persona: snap.doc.persona || {}, config: snap.doc.config || {}, scales, priorities });
      out = {
        version: snap.version,
        revision: snap.doc.revision,
        identity: snap.doc.identity,
        counts: {
          records: records.length,
          archive: archive.length,
          accepted_current: accepted.length,
          candidates: candidates.length,
          disputed: disputed.length,
          evidence: (snap.doc.evidence || []).length,
          conflicts_open: conflicts.filter((c) => isOpenConflict(c)).length,
          conflicts_resolved: conflicts.filter((c) => c.status === 'resolved').length,
        },
        capture: { sources: Object.keys(cursors).length, receipts: Object.keys(snap.doc.captures?.receipts || {}).length, pending: pendingCapture },
        vectors: { fingerprint: fp.id, quality: fp.quality, attached: attachInfo.attached, skipped: attachInfo.skipped, reasons: attachInfo.reasons, cache_error: loaded.error || null },
        persona: { traits: Object.keys(snap.doc.persona?.traits || {}).length, card_tokens: card.tokens, card_budget: card.budget, fingerprint: personaFingerprint(snap.doc) },
        impression: { items: (snap.doc.impression?.items || []).length },
        probe: { runs: runs.length, last_score: runs.length ? runs[runs.length - 1].score : null },
        snapshots: snaps.length,
        last_session_end: snap.doc.sessions?.last_end || null,
      };
      if (!json) {
        console.log(`v${out.version} revision ${out.revision}  owner=${out.identity.owner_id} workspace=${out.identity.workspace_id}`);
        console.log(`记录 ${out.counts.records}（正式 ${out.counts.accepted_current} / 候选 ${out.counts.candidates} / 争议 ${out.counts.disputed}）/ 归档 ${out.counts.archive} / 证据 ${out.counts.evidence}`);
        console.log(`冲突：未决 ${out.counts.conflicts_open}，已裁决 ${out.counts.conflicts_resolved}`);
        console.log(`采集：${out.capture.sources} 个来源，待处理尾部 ${out.capture.pending} 条`);
        console.log(`向量：${out.vectors.attached} 条挂载 / ${out.vectors.skipped} 条跳过（${out.vectors.quality} 指纹）`);
        console.log(`人格：特质 ${out.persona.traits}，卡片 ${out.persona.card_tokens}/${out.persona.card_budget} token；印象 ${out.impression.items} 条；探针 ${out.probe.runs} 次；快照 ${out.snapshots} 个`);
      }
      break;
    }

    case 'config': {
      const ecfg = embedConfig(snap.doc);
      out = {
        render_version: RENDER_VERSION,
        schema_version: snap.version,
        defaults: defaultConfig(),
        effective: snap.doc.config,
        embed: { ...ecfg, fingerprint: fingerprintOf(ecfg) },
        synth: synthConfig(snap.doc),
        paths: {
          root, store: path.join(root, 'memory', 'store.json'), vectors: path.join(root, 'memory', 'embeddings.json'),
          lock: path.join(root, 'memory', '.psm.lock'), backups: path.join(root, 'backups'), cold: path.join(root, 'cold'),
        },
      };
      if (!json) {
        console.log(`schema v${out.schema_version}  render v${out.render_version}`);
        console.log(`检索阈值：lexical ${out.effective.retrieval.lexical_min}，dense ${out.effective.retrieval.dense_min}，RRF k=${out.effective.retrieval.rrf_k}，tentative=${out.effective.retrieval.tentative}`);
        console.log(`嵌入：enabled=${out.embed.enabled} ${out.embed.provider}/${out.embed.model} 指纹 ${out.embed.fingerprint.id}（${out.embed.fingerprint.quality}）`);
        console.log(`合成：enabled=${out.synth.enabled} ${out.synth.model} @ ${out.synth.url}`);
        console.log('用 --json 查看完整默认值与当前配置');
      }
      break;
    }

    default:
      console.error(`未知命令：${cmd}\n`);
      console.log(usage());
      return 2;
  }

  if (json && out !== null && out !== undefined) printJson(out);
  return 0;
}

// ---------------------------------------------------------------- 情绪写入

function loadVectorsSafe(root) {
  try { return safeLoadVectors(root).doc; } catch { return null; }
}

async function trackEmotion(root, store, text, session = null) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, reason: 'empty' };
  const emo = loadEmotionModel(root);
  if (!emo) return { ok: false, reason: 'no-model' };
  const cfg = embedConfig(store);
  if (emo.model && cfg.model && emo.model !== cfg.model) return { ok: false, reason: `model-mismatch:${emo.model}!=${cfg.model}` };
  let vec;
  try { vec = await embedOne(cfg, body); } catch (err) { return { ok: false, reason: `embed-failed:${err.message}` }; }
  const scores = classifyEmotion(emo, vec, 3);
  const axes = readAxes(emo, vec);
  const at = new Date().toISOString();
  const base = { scores, axes, at, sample: body.slice(0, 80), subject: 'user_observed' };
  if (!acceptEmotion(root, scores)) {
    const neutral = { ...base, emotion: null, neutral: true };
    const file = saveEmotionState(root, neutral, session);
    return { ok: true, file, state: neutral, lowSignal: true, session: session || null };
  }
  const state = { ...base, emotion: scores[0].emotion, score: scores[0].score };
  const file = saveEmotionState(root, state, session);
  return { ok: true, file, state, session: session || null };
}

try {
  const code = await Promise.resolve(main());
  process.exitCode = typeof code === 'number' ? code : 0;
} catch (err) {
  const code = err && err.code ? `[${err.code}] ` : '';
  console.error(`${code}${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
}
