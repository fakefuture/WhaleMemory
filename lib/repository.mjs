// lib/repository.mjs — 严格读取、跨进程写锁、revision、原子提交、迁移与恢复。
//
// 事务边界：withWrite 先拿锁 → 读最新主库 → 业务变更 → 追加 operations → revision+1 → 原子写。
// 空操作（没有 operations）不递增 revision、不写盘。网络嵌入/生成必须在锁外完成，
// 提交时用 assertUnchanged 检查来源哈希与 revision，防止旧结果覆盖新数据。

import fs from 'node:fs';
import path from 'node:path';
import {
  readJsonStrict, writeJsonAtomic, writeTextAtomic, copyFileAtomic, ensureDir, walkFiles, fileSha256, sha256Text,
} from './fsx.mjs';
import { PsmError, CODES } from './errors.mjs';
import { acquireLock, lockStatus, repairLock } from './lock.mjs';
import {
  SCHEMA_VERSION, emptyStore, normalizeStore, validateStore, viewV2, migrateV1ToV2, newId, nowIso,
} from './schema.mjs';

export const STORE_REL = path.join('memory', 'store.json');
export const VECTORS_REL = path.join('memory', 'embeddings.json');
export const CAPTURE_STATE_REL = path.join('memory', 'capture-state.json');

export function storePath(root) {
  return path.join(String(root), STORE_REL);
}

export function vectorsPath(root) {
  return path.join(String(root), VECTORS_REL);
}

export function captureStatePath(root) {
  return path.join(String(root), CAPTURE_STATE_REL);
}

function readRawStore(root) {
  const file = storePath(root);
  const raw = readJsonStrict(file, { optional: true });
  if (!raw) {
    throw new PsmError(CODES.NO_STORE, `没有找到记忆库：${file}\n先运行：node bin/psm.mjs init`, { file });
  }
  return raw;
}

// 只读快照。v1 返回只读兼容视图（writable=false），绝不静默写回版本。
export function readSnapshot(root) {
  const raw = readRawStore(root);
  const version = Number(raw.version) || 1;
  if (version === SCHEMA_VERSION) {
    const doc = normalizeStore(raw);
    validateStore(doc);
    return { doc, version, writable: true, file: storePath(root) };
  }
  if (version === 1) {
    const doc = viewV2(raw);
    return { doc, version, writable: false, file: storePath(root), report: doc.migrations ? null : null };
  }
  throw new PsmError(CODES.VERSION_UNSUPPORTED, `不支持的库版本：${version}（本程序支持 v1 只读 / v2 读写）`, { version });
}

function stripTransient(doc) {
  for (const r of [...doc.records, ...doc.archive]) {
    if (r && Object.prototype.hasOwnProperty.call(r, '_vec')) delete r._vec;
  }
  return doc;
}

export function writeStore(root, doc) {
  stripTransient(doc);
  doc.version = SCHEMA_VERSION;
  doc.updated_at = nowIso();
  validateStore(doc);
  writeJsonAtomic(storePath(root), doc);
  return doc;
}

function makeTx(root, doc, context) {
  const tx = {
    doc,
    root,
    context: context || {},
    baseRevision: doc.revision,
    operations: [],
    _touched: new Set(),
    op(payload = {}) {
      const type = payload.op || payload.type;
      if (!type) throw new PsmError(CODES.INVALID_ARGUMENT, 'operation 缺少 op 类型', {});
      const row = {
        operation_id: newId('op'),
        revision: doc.revision + 1,
        at: payload.at || nowIso(),
        op: type,
        actor: payload.actor || (context && context.actor) || null,
        target: payload.target || payload.targets || null,
        source: payload.source || null,
        reason: payload.reason || null,
        changes: payload.changes ? JSON.parse(JSON.stringify(payload.changes)) : null,
        evidence_ids: payload.evidence_ids || [],
      };
      this.operations.push(row);
      return row;
    },
    assertUnchanged({ revision, sourceHashes } = {}) {
      if (revision !== undefined && revision !== null && Number(revision) !== doc.revision) {
        throw new PsmError('STALE_PROPOSAL',
          `主库在生成期间发生变化（生成时 revision=${revision}，当前 ${doc.revision}），拒绝覆盖新数据`,
          { expected_revision: revision, actual_revision: doc.revision });
      }
      if (sourceHashes && typeof sourceHashes === 'object') {
        for (const [id, hash] of Object.entries(sourceHashes)) {
          const rec = doc.records.find((r) => r.id === id) || doc.archive.find((r) => r.id === id);
          if (!rec) {
            throw new PsmError('STALE_PROPOSAL', `来源 ${id} 已不存在，拒绝使用过期结果`, { id });
          }
          if (rec.content_hash !== hash) {
            throw new PsmError('STALE_PROPOSAL', `来源 ${id} 在生成后被修改，拒绝使用过期结果`, { id });
          }
        }
      }
      return true;
    },
  };
  return tx;
}

export async function withWrite(root, fn, opts = {}) {
  const lock = await acquireLock(root, {
    timeoutMs: opts.timeoutMs,
    purpose: opts.purpose || 'withWrite',
  });
  try {
    const raw = readRawStore(root);
    const version = Number(raw.version) || 1;
    if (version !== SCHEMA_VERSION) {
      throw new PsmError(CODES.MIGRATION_REQUIRED,
        `主库是 v${version}，写操作前必须先迁移：node bin/psm.mjs migrate --dry-run，然后 migrate --apply`,
        { version });
    }
    const doc = normalizeStore(raw);
    validateStore(doc, { allowVectors: true });
    const tx = makeTx(root, doc, opts.context);
    const result = await fn(tx);
    if (!tx.operations.length) {
      return { result, committed: false, revision: doc.revision, reclaimed: lock.reclaimed };
    }
    doc.revision = tx.baseRevision + 1;
    doc.updated_at = nowIso();
    doc.operations.push(...tx.operations);
    // operations 是持久变更记录，不做 500 条截断；体积由写入频率决定。
    writeStore(root, doc);
    return { result, committed: true, revision: doc.revision, reclaimed: lock.reclaimed };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------- 备份与迁移

function backupRoot(root) {
  return path.join(String(root), 'backups');
}

const BACKUP_SKIP_DIRS = ['backups', 'node_modules', '.git', 'tmp', '.cache'];
const BACKUP_SKIP_FILES = ['memory/.psm.lock', 'memory/embeddings.json.tmp'];

export function createSnapshot(root, { label = 'snapshot', dirName = null } = {}) {
  const at = nowIso();
  const name = dirName || `${at.replace(/[:.]/g, '-')}-${label}`;
  const dir = path.join(backupRoot(root), name);
  ensureDir(dir);
  const files = walkFiles(root, { skipDirs: BACKUP_SKIP_DIRS, skipFiles: BACKUP_SKIP_FILES })
    .filter((rel) => !rel.startsWith('backups/'));
  const manifest = { at, label, root: path.resolve(String(root)), files: {} };
  for (const rel of files) {
    const src = path.join(String(root), rel);
    const dest = path.join(dir, rel);
    copyFileAtomic(src, dest);
    manifest.files[rel] = { sha256: fileSha256(dest), bytes: fs.statSync(dest).size };
  }
  writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
  writeTextAtomic(path.join(dir, '.complete'), `${at}\n`);
  return { name, dir, at, files: files.length, bytes: Object.values(manifest.files).reduce((n, f) => n + f.bytes, 0), manifest };
}

export function verifySnapshot(dir) {
  const manifest = readJsonStrict(path.join(dir, 'manifest.json'), { optional: true });
  if (!manifest) return { status: 'no_manifest', ok: false, bad: [{ file: 'manifest.json', status: 'missing' }], checked: 0 };
  const bad = [];
  let checked = 0;
  for (const [rel, meta] of Object.entries(manifest.files || {})) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) { bad.push({ file: rel, status: 'missing' }); continue; }
    const hash = fileSha256(file);
    if (hash !== meta.sha256) bad.push({ file: rel, status: 'mismatch', expected: meta.sha256, actual: hash });
    checked += 1;
  }
  return { status: bad.length ? 'mismatch' : 'ok', ok: bad.length === 0, checked, bad, manifest };
}

function importLegacyCaptureState(root, report) {
  const file = captureStatePath(root);
  try {
    const doc = readJsonStrict(file, { optional: true });
    if (!doc || !doc.sessions) return {};
    const cursors = {};
    for (const [sid, cur] of Object.entries(doc.sessions)) {
      cursors[sid] = {
        legacy_user_messages: Number(cur && cur.userMessages) || 0,
        legacy_added: Number(cur && cur.added) || 0,
        updated_at: (cur && cur.updated_at) || null,
        source: 'v1_capture_state',
      };
    }
    report.capture_cursors_imported = Object.keys(cursors).length;
    return cursors;
  } catch (err) {
    report.capture_state_error = err.message;
    return {};
  }
}

// v1 → v2：锁内完整备份并校验，然后写 v2。失败时原文件保持不变。
export async function migrate(root, { dryRun = false, backup = true, timeoutMs = 10000 } = {}) {
  const lock = await acquireLock(root, { timeoutMs, purpose: 'migrate' });
  try {
    const raw = readRawStore(root);
    const version = Number(raw.version) || 1;
    if (version === SCHEMA_VERSION) {
      return { status: 'noop', message: '已经是 v2，无操作', version: SCHEMA_VERSION, revision: raw.revision };
    }
    if (version !== 1) throw new PsmError(CODES.VERSION_UNSUPPORTED, `不支持的库版本：${version}`, { version });

    const workspaceId = raw.identity?.workspace_id || undefined;
    const { doc, report } = migrateV1ToV2(raw, { workspaceId, now: nowIso() });
    if (workspaceId) report.workspace_id_reused = true;
    const cursors = importLegacyCaptureState(root, report);
    doc.captures.cursors = cursors;
    doc.identity.workspace_id = doc.identity.workspace_id || workspaceId;

    if (dryRun) {
      return { status: 'dry_run', version_before: 1, version_after: 2, report, workspace_id: doc.identity.workspace_id, would_write: true };
    }

    let snap = null;
    if (backup) {
      snap = createSnapshot(root, { label: 'pre-migrate' });
      const verify = verifySnapshot(snap.dir);
      if (!verify.ok) {
        throw new PsmError(CODES.BACKUP_FAILED, `迁移前备份校验失败：${verify.bad.map((b) => b.file).join(', ')}`, { backup: snap.dir });
      }
    }

    doc.revision = 1;
    doc.updated_at = nowIso();
    doc.migrations[0].backup = snap ? { name: snap.name, dir: snap.dir, files: snap.files } : null;
    doc.operations = [{
      operation_id: newId('op'),
      revision: 1,
      at: nowIso(),
      op: 'migrate',
      actor: 'system',
      target: null,
      source: 'v1',
      reason: 'v1 → v2 结构迁移',
      changes: { from: 1, to: 2, evidence_created: report.evidence_created },
      evidence_ids: [],
    }];
    // 版本与迁移记录同次提交：writeStore 一次原子替换。
    writeStore(root, doc);
    return {
      status: 'applied',
      version_before: 1,
      version_after: 2,
      revision: doc.revision,
      report,
      backup: snap ? { name: snap.name, dir: snap.dir, files: snap.files, verified: true } : null,
    };
  } finally {
    lock.release();
  }
}

export function listSnapshots(root) {
  const dir = backupRoot(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const abs = path.join(dir, d.name);
      const manifest = readJsonStrict(path.join(abs, 'manifest.json'), { optional: true });
      return {
        name: d.name,
        dir: abs,
        files: manifest ? Object.keys(manifest.files || {}).length : null,
        at: manifest ? manifest.at : null,
        label: manifest ? manifest.label : null,
        has_manifest: Boolean(manifest),
      };
    })
    .sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

// 恢复到新目录并逐文件校验哈希；不直接覆盖当前 root。
export function restoreSnapshot({ from, to, force = false } = {}) {
  if (!from || !to) throw new PsmError(CODES.INVALID_ARGUMENT, 'restore 需要 --from <快照目录> 与 --to <新目录>', {});
  const verify = verifySnapshot(from);
  if (!verify.ok) {
    throw new PsmError(CODES.RESTORE_FAILED, `快照校验失败，拒绝恢复：${verify.bad.map((b) => b.file).join(', ')}`, { bad: verify.bad });
  }
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0 && !force) {
    throw new PsmError(CODES.RESTORE_FAILED, `目标目录非空：${to}（用 --force 明确覆盖）`, { to });
  }
  const files = Object.keys(verify.manifest.files || {});
  for (const rel of files) {
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    copyFileAtomic(src, dest);
    const hash = fileSha256(dest);
    if (hash !== verify.manifest.files[rel].sha256) {
      throw new PsmError(CODES.RESTORE_FAILED, `恢复后哈希不一致：${rel}`, { file: rel });
    }
  }
  return { status: 'restored', to, files: files.length, checked: verify.checked, manifest_at: verify.manifest.at, next: `用 --root "${to}" 或 PSM_ROOT 指向新目录；确认无误后再切换原目录` };
}

export function storeStatus(root) {
  const lock = lockStatus(root);
  let doc = null;
  let error = null;
  try {
    doc = readJsonStrict(storePath(root), { optional: true });
  } catch (err) {
    error = { code: err.code, message: err.message };
  }
  return {
    store: storePath(root),
    exists: Boolean(doc),
    version: doc ? (Number(doc.version) || 1) : null,
    revision: doc ? (Number(doc.revision) || 0) : null,
    records: doc && Array.isArray(doc.records) ? doc.records.length : null,
    archive: doc && Array.isArray(doc.archive) ? doc.archive.length : null,
    lock,
    error,
  };
}

export { lockStatus, repairLock, emptyStore, viewV2, sha256Text, writeTextAtomic };
