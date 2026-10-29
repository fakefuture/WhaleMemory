// tools/capture.mjs — 把 DSH 会话里「用户说的、像记忆的句子」提交为候选。
//
// v0.2 规则：
//   - 只提交候选（review_status=candidate），不直接进正式记忆，也不做瞬时近重复旁路；
//   - 候选 / 证据 / 游标在同一次主库事务提交（见 lib/service.mjs ingestMessages）；
//   - 稳定键 + 前缀哈希检测重写/截断，游标只推进到实际处理完的位置；
//   - 达到 --limit / --max 时未处理尾部留待下次；
//   - --dry-run 只读，不写主库、不写任何状态文件。
//
// 用法：
//   node tools/capture.mjs --all --dry-run      # 扫本工作区近期会话，看会提交什么
//   node tools/capture.mjs --all                # 扫本工作区近期会话并提交候选
//   node tools/capture.mjs --session <id>       # 只处理一个会话
//   node tools/capture.mjs --file <archive>     # 直接指定归档文件
//   node tools/capture.mjs --all --everywhere --days 7 --limit 4 --max 12 --quiet
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { MemoryService } from '../lib/service.mjs';
import { sha256Text } from '../lib/schema.mjs';

const MAGIC = 0xfd2fb528;
const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function';

// zstd 多帧拼接：逐帧解压后拼接文本。坏帧跳过，不伪造内容。
function splitFrames(buf) {
  const parts = [];
  let off = 0;
  let frames = 0;
  const frameEnd = (start) => {
    if (buf.readUInt32LE(start) !== MAGIC) return null;
    let p = start + 4;
    const fhd = buf[p]; p += 1;
    const fcsFlag = (fhd >> 6) & 3;
    const singleSegment = (fhd >> 5) & 1;
    const hasChecksum = (fhd >> 2) & 1;
    const didFlag = fhd & 3;
    if (!singleSegment) p += 1;
    p += [0, 1, 2, 4][didFlag];
    p += [0, 1, 2, 4][fcsFlag];
    for (;;) {
      if (p + 3 > buf.length) return null;
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      p += 3;
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
      if (type === 3) return null;
      p += type === 1 ? 1 : size;
      if (p > buf.length) return null;
      if (last) break;
    }
    if (hasChecksum) p += 4;
    return p;
  };
  while (off < buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC) { off += 1; continue; }
    const end = frameEnd(off);
    if (!end || end <= off) { off += 1; continue; }
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(off, end))); frames += 1; } catch { /* 跳过坏帧 */ }
    off = end;
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames };
}

function decodeArchive(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 4 && buf.readUInt32LE(0) === MAGIC) {
    if (!HAS_ZSTD) {
      throw new Error(
        `当前 Node ${process.version} 的 zlib 不支持 zstdDecompressSync：读取 DSH 的 .jsonl.zstd 需要 Node 22.15+（推荐 24）。`
        + '可先用支持的 Node 运行 tools/session-export.mjs 导出 JSONL，再用 capture --file 读取。',
      );
    }
    const { text, frames } = splitFrames(buf);
    return { text, frames, format: 'zstd' };
  }
  // 纯 JSONL（测试夹具与导出文件）。
  return { text: buf.toString('utf8'), frames: 0, format: 'jsonl' };
}

function collectText(content) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (typeof x === 'string') { out.push(x); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') {
      if (typeof x.text === 'string') out.push(x.text);
      else if (Array.isArray(x.content)) walk(x.content);
    }
  };
  walk(content);
  return out.filter((s) => String(s).trim()).join('\n\n').trim();
}

function parseFlags(argv) {
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

const NOISE = [
  'Current runtime context',
  '<system-reminder>',
  '<available_skills>',
  'Time sampled while preparing',
  'Browser time zone for this request',
  'Elapsed since the preceding model-visible message',
];

// 稳定信号只决定「值不值得当候选」，不再用来跳过准入/去重。
const STRONG = [
  /(记住|记一下|记下来|记一条|以后都|今后|下次都|不要再|别再|必须|一定要|决定|定了|定下|规矩|约定|偏好|习惯)/,
  /(我喜欢|我不喜欢|我希望|我要|我想要|我倾向|我更|我不想要)/,
  /(不要|别把|不可以|禁止|不允许)/,
];
const ACK = /^(继续|要|好|嗯|对|可以|行|是的|没错|试试|先[0-9]+.*|按建议来)[。！!？?，,]*$/;

function clean(text) {
  return String(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}

function worthCandidate(text) {
  const t = clean(text);
  if (t.length < 8 || t.length > 500) return false;
  if (NOISE.some((n) => t.startsWith(n))) return false;
  if (ACK.test(t)) return false;
  if (!/[\u3400-\u9fff]/.test(t)) return false;
  return STRONG.some((re) => re.test(t));
}

// 粗分类：偏好/规矩写语义候选，其余写情节候选。拿不准就降级为 episodic。
function classify(text) {
  if (/(记住|以后都|今后|我希望|我喜欢|我不喜欢|我要|我偏好|不要再|别再|必须|规矩|约定)/.test(text)) {
    return { tier: 'semantic', domain: 'preference' };
  }
  return { tier: 'episodic', domain: undefined };
}

function sessionsBase(flags) {
  if (flags['sessions-dir']) return path.resolve(String(flags['sessions-dir']));
  if (process.env.DSH_SESSIONS_DIR) return path.resolve(process.env.DSH_SESSIONS_DIR);
  return path.join(os.homedir(), '.dsh', 'sessions');
}

function discoverSessions({ days, onlySlug = null, base }) {
  if (!fs.existsSync(base)) return [];
  const since = Date.now() - Math.max(1, days) * 86400000;
  const out = [];
  for (const ws of fs.readdirSync(base)) {
    if (onlySlug && ws !== onlySlug) continue;
    const wsDir = path.join(base, ws);
    let stat;
    try { stat = fs.statSync(wsDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const id of fs.readdirSync(wsDir)) {
      const file = path.join(wsDir, id, 'session.v4.jsonl.zstd');
      let m;
      try { m = fs.statSync(file).mtimeMs; } catch { continue; }
      if (m < since) continue;
      out.push({ sessionId: id, workspace: ws, file, mtime: m });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function messageIdOf(o) {
  const d = o.data || {};
  return o.id || d.id || d.messageId || d.message_id || d.message?.id || null;
}

// 读用户消息：保留稳定 message_id；无 id 时用正文哈希 + 同文序号做稳定键。
function readUsers(file) {
  const { text, format, frames } = decodeArchive(file);
  const users = [];
  const seen = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const type = String(o.type || '');
    const msg = o.data || {};
    const isUser = type === 'user/message'
      || ((type === 'message' || type === 'user') && (msg.role === 'user' || o.role === 'user'));
    if (!isUser) continue;
    const body = collectText(msg.content ?? msg.message?.content ?? msg);
    if (!body) continue;
    const at = o.time || msg.time || msg.at || null;
    const messageId = messageIdOf(o);
    const norm = clean(body);
    let key;
    // 稳定键带正文摘要：同 id 被编辑后键变化，前缀哈希能发现「重写」；
    // 未编辑的消息重扫时命中回执，不会重复提交。
    if (messageId) key = `msg|${messageId}|${sha256Text(norm).slice(0, 16)}`;
    else {
      const h = sha256Text(norm).slice(0, 24);
      const n = (seen.get(h) || 0) + 1;
      seen.set(h, n);
      key = `msg|sha|${h}|${n}`;
    }
    users.push({ at, text: body, key, message_id: messageId });
  }
  return { users, format, frames };
}

function shortKey(key) {
  return String(key).slice(0, 48);
}

function planTarget(target, { cursor, limit }) {
  const { users, format, frames } = readUsers(target.file);
  const keys = users.map((u) => u.key);
  const total = users.length;
  const prior = cursor || null;
  const priorProcessed = Math.max(0, Math.min(Number(prior?.processed) || 0, total));
  let rewritten = false;
  if (prior && prior.prefix_hash) {
    const prefix = sha256Text(keys.slice(0, priorProcessed).join('|'));
    rewritten = prefix !== prior.prefix_hash;
  } else if (prior && prior.processed > total) {
    rewritten = true; // 截断
  }
  const start = rewritten ? 0 : priorProcessed;
  const picked = [];
  let scanned = 0;
  let irrelevant = 0;
  for (let i = start; i < users.length; i += 1) {
    const u = users[i];
    scanned += 1;
    if (picked.length >= limit) break;
    if (!worthCandidate(u.text)) { irrelevant += 1; continue; }
    picked.push({ ...u, index: i });
  }
  const lastIndex = picked.length ? picked[picked.length - 1].index : start - 1;
  return {
    users, keys, total, start, rewritten, format, frames, picked, scanned, irrelevant, lastIndex,
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const root = path.resolve(flags.root ? String(flags.root) : (process.env.PSM_ROOT || process.cwd()));
  const quiet = flags.quiet === true;
  const dryRun = flags['dry-run'] === true;
  const all = flags.all === true;
  const days = Math.max(1, Number(flags.days || 3));
  const limit = Math.max(1, Number(flags.limit || 6));
  const maxTotal = Math.max(1, Number(flags.max || 12));

  let targets = [];
  if (flags.file) {
    const file = path.resolve(String(flags.file));
    const sessionId = String(flags.session || path.basename(path.dirname(file)) || '').trim();
    targets = [{ sessionId, workspace: null, file, mtime: 0 }];
  } else if (all) {
    // 默认只抄本库工作区的会话；--everywhere 才扫全机。
    const slug = flags.everywhere ? null : `--${root.replace(/[:]/g, '-').replace(/[\\/]/g, '')}--`;
    targets = discoverSessions({ days, onlySlug: slug, base: sessionsBase(flags) });
  } else {
    const sessionId = String(flags.session || process.env.DSH_SESSION_ID || '').trim();
    if (!sessionId) {
      console.error('没有会话 id：传 --session、--all、--file，或设置 DSH_SESSION_ID');
      process.exit(2);
    }
    const hit = discoverSessions({ days: 3650, base: sessionsBase(flags) }).find((s) => s.sessionId === sessionId);
    if (!hit) {
      if (!quiet) console.log(`找不到会话存档：${sessionId}`);
      return;
    }
    targets = [hit];
  }

  const service = new MemoryService({ root });
  const snap = service.snapshot();
  if (Number(snap.doc.version) !== 2) {
    console.error('记忆库不是 v2：先运行 node bin/psm.mjs migrate --dry-run 再 migrate --apply');
    process.exit(3);
  }
  const ctx = snap.ctx;
  const cursors = (snap.doc.captures && snap.doc.captures.cursors) || {};
  const known = new Set(snap.doc.records
    .filter((r) => r.review_status === 'candidate' || r.validity === 'current')
    .map((r) => String(r.content || '').replace(/\s+/g, ' ').trim().toLowerCase()));

  const report = [];
  let scannedSessions = 0;
  let submitted = 0;
  let failed = 0;
  for (const t of targets) {
    if (submitted + failed >= maxTotal) break;
    const sourceId = `session:${t.sessionId}`;
    const prior = cursors[sourceId] || null;
    const plan = planTarget(t, { cursor: prior, limit: Math.min(limit, Math.max(0, maxTotal - submitted - failed)) });
    scannedSessions += 1;
    if (plan.rewritten) {
      report.push({ status: 'rewrite', session: t.sessionId, note: '前缀哈希不一致，从第 0 条重新扫描（回执仍防重）' });
    }
    if (!plan.picked.length && !plan.rewritten && plan.start >= plan.total) continue;

    if (dryRun) {
      for (const p of plan.picked) {
        const isDup = known.has(clean(p.text).toLowerCase());
        report.push({
          status: isDup ? 'duplicate' : 'would-candidate',
          session: t.sessionId,
          text: clean(p.text).slice(0, 100),
        });
        if (!isDup) submitted += 1;
      }
      if (!plan.picked.length && plan.irrelevant) {
        report.push({ status: 'irrelevant', session: t.sessionId, count: plan.irrelevant });
      }
      continue;
    }

    // 只把扫描到的前缀（含无关消息）交给服务：无关消息标记 evidence:false / capture:false，
    // 游标才能越过它们；最后一条候选之后的尾部不提交，留待下次。
    const upto = plan.picked.length ? plan.lastIndex + 1 : plan.total;
    const messages = [];
    const pickedSet = new Map(plan.picked.map((p) => [p.index, p]));
    for (let i = plan.start; i < upto; i += 1) {
      const u = plan.users[i];
      const picked = pickedSet.get(i);
      if (picked) {
        const meta = classify(picked.text);
        messages.push({
          role: 'user',
          text: clean(picked.text).slice(0, 400),
          at: picked.at || undefined,
          message_id: picked.message_id || undefined,
          key: picked.key,
          tier: meta.tier,
          domain: meta.domain,
          capture: true,
          evidence: true,
        });
      } else {
        messages.push({
          role: 'user',
          text: clean(u.text),
          at: u.at || undefined,
          message_id: u.message_id || undefined,
          key: u.key,
          capture: false,
          evidence: false,
        });
      }
    }
    if (!messages.length) continue;
    const res = await service.ingestMessages({
      context: { sessionId: t.sessionId, requestId: `capture-${t.sessionId}-${plan.start}-${upto}` },
      messages,
      source: {
        id: sourceId,
        file: t.file,
        workspace: t.workspace,
        session_id: t.sessionId,
        keys: plan.keys,
        start_index: plan.start,
        users_total: plan.total,
        rewrite_detected: plan.rewritten,
      },
    });
    for (const r of res.results) {
      if (r.status === 'candidate') submitted += 1;
      if (r.status === 'failed') failed += 1;
      if (r.status === 'candidate' || r.status === 'failed') {
        report.push({
          status: r.status, session: t.sessionId, id: r.id || null, key: shortKey(r.key), reason: r.reason || null,
          text: messages.find((m) => m.key === r.key)?.text?.slice(0, 100) || '',
        });
      }
    }
    if (!quiet && !report.some((x) => x.session === t.sessionId)) {
      report.push({ status: 'scanned', session: t.sessionId, count: plan.irrelevant });
    }
  }

  if (!quiet) {
    const head = dryRun
      ? `扫描 ${scannedSessions} 个会话，dry-run 命中 ${submitted} 条（未写任何文件）`
      : `扫描 ${scannedSessions} 个会话，提交候选 ${submitted} 条${failed ? `，失败 ${failed} 条` : ''}`;
    console.log(head);
    for (const r of report) {
      if (r.status === 'would-candidate' || r.status === 'candidate') {
        console.log(`  ${r.status === 'candidate' ? '+' : '~'} ${r.id || ''} ${r.text || ''}`.trim());
      } else if (r.status === 'duplicate') {
        console.log(`  = 重复  ${r.text || ''}`.trim());
      } else if (r.status === 'failed') {
        console.log(`  ! 失败  ${r.key || ''} ${r.reason || ''}`.trim());
      } else if (r.status === 'rewrite') {
        console.log(`  ↺ 重写  ${r.session} ${r.note}`);
      } else if (r.status === 'irrelevant') {
        console.log(`  · 无关 ${r.count} 条（游标已推进）`);
      } else if (r.status === 'scanned') {
        console.log(`  · ${r.session} 无新候选（${r.count} 条无关已推进）`);
      }
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('capture 失败：', e && e.message ? e.message : e);
  process.exit(1);
});
