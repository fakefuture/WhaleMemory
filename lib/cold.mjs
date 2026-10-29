// lib/cold.mjs — 冷存储：纯归档，不参与任何渲染与检索。
//
// 定位：热层（memory/store.json）是"会被注入、会被染色、会被衰减"的记忆；
// 冷层是"只求原样保存、以后能翻出来"的档案。所以它刻意很笨：
//   - 一条一个 JSON 文件，按日期分目录，人眼可读、grep 可搜
//   - 只做内容哈希去重，不做相似度、不做嵌入、不进 query
//   - 不读 emotion / persona / impression，任何渲染管线都不看这个目录
// 用途：整篇文档、对话原文、日志、参考资料——那些"不能丢但不需要每轮想起"的东西。
//
// v0.2 变化：
//   - 写入拿跨进程锁，索引原子替换；
//   - 索引损坏时拒绝写入，绝不用空索引覆盖坏索引；
//   - doctor/repair 能发现索引缺失、孤立条目、内容哈希不一致，并在显式 apply 时重建索引。

import fs from 'node:fs';
import path from 'node:path';
import { nowIso, newId } from './schema.mjs';
import { readJsonStrict, writeJsonAtomic, ensureDir, walkFiles, fileSha256, sha256Text, sha256 } from './fsx.mjs';
import { PsmError, CODES } from './errors.mjs';
import { acquireLock } from './lock.mjs';

export function coldDir(root) {
  return path.join(String(root), 'cold');
}

export function coldIndexPath(root) {
  return path.join(coldDir(root), 'index.json');
}

function emptyIndex() {
  return { version: 2, count: 0, entries: [] };
}

// 严格读取：文件缺失 → 空索引（首次使用）；内容损坏 → JSON_INVALID。
// 绝不能把坏索引当空索引，否则下一次写入会覆盖掉唯一的索引。
export function loadColdIndex(root) {
  const doc = readJsonStrict(coldIndexPath(root), { optional: true });
  if (!doc) return emptyIndex();
  if (typeof doc !== 'object' || !Array.isArray(doc.entries)) {
    throw new PsmError(CODES.JSON_INVALID, 'cold/index.json 不是含 entries 数组的对象；先运行 cold repair --dry-run', {
      file: coldIndexPath(root),
    });
  }
  return { version: 2, count: doc.entries.length, entries: doc.entries, readonly: false };
}

function saveColdIndex(root, idx) {
  idx.count = idx.entries.length;
  idx.updated_at = nowIso();
  writeJsonAtomic(coldIndexPath(root), idx);
  return idx;
}

export async function addCold(root, { content, title = null, kind = 'note', tags = [], note = null, source = 'user' } = {}) {
  const text = String(content ?? '');
  if (!text.trim()) return { status: 'rejected', reason: '内容为空' };
  const buf = Buffer.from(text, 'utf8');
  const hash = sha256(buf);
  const lock = await acquireLock(root, { purpose: 'cold-add', timeoutMs: 5000 });
  try {
    const idx = loadColdIndex(root);
    const dup = idx.entries.find((e) => e.sha256 === hash);
    if (dup) return { status: 'duplicate', id: dup.id, bytes: dup.bytes, path: dup.path };

    const id = newId('cold');
    const at = nowIso();
    const day = at.slice(0, 10).replace(/-/g, '');
    const rel = path.join('cold', 'entries', day, `${id}.json`).split(path.sep).join('/');
    const payload = {
      id,
      at,
      kind,
      title: title || null,
      tags: Array.isArray(tags) ? tags : [],
      note: note || null,
      source,
      bytes: buf.length,
      sha256: hash,
      // 原样保存：不做摘要、不改写、不裁切。
      content: text,
    };
    const abs = path.join(String(root), rel);
    writeJsonAtomic(abs, payload);

    idx.entries.push({
      id, at, kind, title: payload.title, tags: payload.tags, bytes: payload.bytes, sha256: hash, path: rel,
    });
    saveColdIndex(root, idx);
    return { status: 'added', id, bytes: payload.bytes, path: rel };
  } finally {
    lock.release();
  }
}

export function listCold(root, { kind = null, limit = null } = {}) {
  const idx = loadColdIndex(root);
  let rows = idx.entries;
  if (kind) rows = rows.filter((e) => e.kind === kind);
  rows = [...rows].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (limit) rows = rows.slice(0, Math.max(0, Number(limit)));
  return rows;
}

export function getCold(root, id) {
  const idx = loadColdIndex(root);
  const entry = idx.entries.find((e) => e.id === id);
  if (!entry) return { status: 'not_found', id };
  const payload = readJsonStrict(path.join(String(root), entry.path), { optional: true });
  if (!payload) return { status: 'missing_file', id, path: entry.path };
  const ok = typeof payload.content === 'string' && sha256(Buffer.from(payload.content, 'utf8')) === entry.sha256;
  return { status: ok ? 'ok' : 'hash_mismatch', entry, payload, verified: ok };
}

// 校验：重算每条内容的哈希，与索引比对（发现被改过/被截断的文件）。
export function verifyCold(root) {
  const idx = loadColdIndex(root);
  const bad = [];
  for (const e of idx.entries) {
    const abs = path.join(String(root), e.path);
    if (!fs.existsSync(abs)) { bad.push({ id: e.id, status: 'missing' }); continue; }
    let payload = null;
    try {
      payload = readJsonStrict(abs, { optional: true });
    } catch (err) {
      bad.push({ id: e.id, status: 'unreadable', reason: err.message });
      continue;
    }
    if (!payload || typeof payload.content !== 'string') { bad.push({ id: e.id, status: 'unreadable' }); continue; }
    const hash = sha256(Buffer.from(payload.content, 'utf8'));
    if (hash !== e.sha256) bad.push({ id: e.id, status: 'mismatch', expected: e.sha256, actual: hash });
  }
  return { status: bad.length ? 'mismatch' : 'ok', checked: idx.entries.length, bad };
}

// 扫描 entries 目录，重建真实清单；不静默覆盖坏索引，repair 必须显式 apply。
export async function repairCold(root, { dryRun = true, reason = null, actor = 'cli' } = {}) {
  if (!reason || !String(reason).trim()) {
    throw new PsmError(CODES.INVALID_ARGUMENT, 'cold repair 需要 --reason 说明为什么重建索引', {});
  }
  const lock = await acquireLock(root, { purpose: 'cold-repair', timeoutMs: 5000 });
  try {
    let old = emptyIndex();
    let indexError = null;
    try {
      old = loadColdIndex(root);
    } catch (err) {
      indexError = err.message;
    }
    const oldById = new Map(old.entries.map((e) => [e.id, e]));
    const dir = path.join(coldDir(root), 'entries');
    const files = fs.existsSync(dir)
      ? walkFiles(dir).filter((rel) => rel.endsWith('.json'))
      : [];
    const rebuilt = [];
    const badFiles = [];
    for (const rel0 of files) {
      const abs = path.join(dir, rel0);
      const rel = path.join('cold', 'entries', rel0).split(path.sep).join('/');
      let payload = null;
      try {
        payload = readJsonStrict(abs, { optional: false });
      } catch (err) {
        badFiles.push({ path: rel, reason: err.message });
        continue;
      }
      if (!payload || typeof payload.content !== 'string' || !payload.id) {
        badFiles.push({ path: rel, reason: '缺少 id/content' });
        continue;
      }
      const hash = sha256(Buffer.from(payload.content, 'utf8'));
      const before = oldById.get(payload.id);
      rebuilt.push({
        id: payload.id,
        at: payload.at || null,
        kind: payload.kind || 'note',
        title: payload.title || null,
        tags: Array.isArray(payload.tags) ? payload.tags : [],
        bytes: Buffer.byteLength(payload.content, 'utf8'),
        sha256: hash,
        path: rel,
        previous_sha256: before && before.sha256 !== hash ? before.sha256 : null,
      });
    }
    const rebuiltIds = new Set(rebuilt.map((e) => e.id));
    const missing = old.entries.filter((e) => !rebuiltIds.has(e.id)).map((e) => ({ id: e.id, path: e.path }));
    const mismatched = rebuilt.filter((e) => e.previous_sha256).map((e) => ({ id: e.id, before: e.previous_sha256, now: e.sha256 }));
    const report = {
      dry: dryRun,
      index_error: indexError,
      old_count: old.entries.length,
      rebuilt_count: rebuilt.length,
      orphan_recovered: rebuilt.filter((e) => !oldById.has(e.id)).length,
      missing,
      hash_mismatch: mismatched,
      bad_files: badFiles,
      reason: String(reason),
      actor,
    };
    if (dryRun) return report;
    saveColdIndex(root, { version: 2, entries: rebuilt, repaired_at: nowIso(), repair_reason: String(reason), index_error: indexError });
    return { ...report, status: 'repaired' };
  } finally {
    lock.release();
  }
}

export function coldStats(root) {
  const idx = loadColdIndex(root);
  const byKind = {};
  let bytes = 0;
  for (const e of idx.entries) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    bytes += Number(e.bytes) || 0;
  }
  return { count: idx.entries.length, bytes, byKind, dir: coldDir(root) };
}

export { ensureDir, fileSha256, sha256Text };
