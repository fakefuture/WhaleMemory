// lib/lock.mjs — 单库跨进程写锁。
//
// 规则（对应任务书 8.1）：
//   - 锁文件带唯一 token / PID / 主机 / 创建时间；
//   - 同主机、持有者进程已不存在 → 可以证明已退出，回收并记事件；
//   - 同主机且进程仍存活 → 即使超过「过期时间」也不抢；
//   - 跨主机 / 锁文件损坏 / 无法判断 → LOCK_STALE_UNKNOWN，只能显式 repair；
//   - 等待有上限，不无限阻塞。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonStrict, writeTextAtomic, randomToken } from './fsx.mjs';
import { PsmError, CODES } from './errors.mjs';

export function lockPath(root) {
  return path.join(String(root), 'memory', '.psm.lock');
}

export function lockEventLog(root) {
  return path.join(String(root), 'memory', 'lock-events.log');
}

const HOST = (() => {
  try { return os.hostname(); } catch { return 'unknown-host'; }
})();

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但不属于我们；仍算存活。
    return err && err.code === 'EPERM';
  }
}

function logEvent(root, event) {
  try {
    fs.mkdirSync(path.join(String(root), 'memory'), { recursive: true });
    fs.appendFileSync(lockEventLog(root), `${JSON.stringify({ at: new Date().toISOString(), host: HOST, pid: process.pid, ...event })}\n`, 'utf8');
  } catch { /* 日志写不了不能影响锁语义 */ }
}

export function readLock(root) {
  const file = lockPath(root);
  try {
    const meta = readJsonStrict(file);
    if (!meta || typeof meta !== 'object' || !meta.token || !meta.pid) {
      return { status: 'corrupt', file, meta: null };
    }
    return { status: 'ok', file, meta };
  } catch (err) {
    if (err.code === CODES.FILE_NOT_FOUND) return { status: 'free', file, meta: null };
    return { status: 'corrupt', file, meta: null, error: err.code };
  }
}

export function lockStatus(root) {
  const cur = readLock(root);
  if (cur.status === 'free') return { held: false, status: 'free' };
  if (cur.status === 'corrupt') return { held: true, status: 'corrupt', file: cur.file };
  const meta = cur.meta;
  const sameHost = meta.host === HOST;
  const alive = sameHost ? pidAlive(meta.pid) : null;
  return {
    held: true,
    status: alive === false ? 'stale' : (alive === null ? 'foreign-host' : 'held'),
    meta: { ...meta, token: undefined },
    same_host: sameHost,
    pid_alive: alive,
    age_ms: Date.now() - (Date.parse(meta.created_at) || Date.now()),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 返回 { release(), token, meta, reclaimed }
export async function acquireLock(root, opts = {}) {
  const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 5000));
  const file = lockPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  let lastCode = CODES.LOCK_BUSY;
  let lastHolder = null;
  let reclaimed = null;

  for (;;) {
    const meta = {
      token: randomToken(),
      pid: process.pid,
      host: HOST,
      created_at: new Date().toISOString(),
      purpose: opts.purpose || null,
    };
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
        try { fs.fsyncSync(fd); } catch { /* ignore */ }
      } finally {
        fs.closeSync(fd);
      }
      const release = () => {
        const cur = readLock(root);
        if (cur.status === 'ok' && cur.meta.token === meta.token) {
          try { fs.unlinkSync(file); } catch { /* 已被回收 */ }
        }
      };
      return { release, token: meta.token, meta, reclaimed };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new PsmError(CODES.IO_ERROR, `无法创建锁文件：${file}（${err.message}）`, { file, syscode: err.code });
      }
    }

    const cur = readLock(root);
    if (cur.status === 'corrupt') {
      lastCode = CODES.LOCK_STALE_UNKNOWN;
      lastHolder = { reason: '锁文件无法解析，无法证明持有者已退出' };
    } else if (cur.status === 'ok') {
      lastHolder = { pid: cur.meta.pid, host: cur.meta.host, created_at: cur.meta.created_at, purpose: cur.meta.purpose || null };
      if (cur.meta.host === HOST && !pidAlive(cur.meta.pid)) {
        // 同主机且进程已不存在：可以证明持有者退出。再读一次 token 防止误删新锁。
        const again = readLock(root);
        if (again.status === 'ok' && again.meta.token === cur.meta.token) {
          try {
            fs.unlinkSync(file);
            reclaimed = { stale: lastHolder, at: new Date().toISOString() };
            logEvent(root, { event: 'lock_reclaimed_stale', stale: lastHolder });
            continue;
          } catch { /* 竞争失败，继续等 */ }
        }
      } else if (cur.meta.host !== HOST) {
        lastCode = CODES.LOCK_STALE_UNKNOWN;
        lastHolder = { ...lastHolder, reason: '锁来自其他主机，无法确认进程是否存活' };
      } else {
        lastCode = CODES.LOCK_BUSY;
      }
    }

    if (Date.now() - started >= timeoutMs) {
      const msg = lastCode === CODES.LOCK_STALE_UNKNOWN
        ? `写锁状态无法判定（${file}）；确认没有其他进程在写后运行：node bin/psm.mjs repair --lock --reason "…"`
        : `记忆库正被其他进程写入（${file}），等待 ${timeoutMs}ms 后仍未获得锁`;
      throw new PsmError(lastCode, msg, { file, holder: lastHolder, waited_ms: Date.now() - started });
    }
    await sleep(20 + Math.floor(Math.random() * 40));
  }
}

export async function withLock(root, fn, opts = {}) {
  const handle = await acquireLock(root, opts);
  try {
    return await fn(handle);
  } finally {
    handle.release();
  }
}

// 显式修复：只允许人确认后调用；必须给理由，并写入事件日志。
export function repairLock(root, { reason, actor = 'manual' } = {}) {
  if (!reason || !String(reason).trim()) {
    throw new PsmError(CODES.INVALID_ARGUMENT, 'repair --lock 必须用 --reason 说明为什么可以安全删除锁', {});
  }
  const cur = readLock(root);
  if (cur.status === 'free') return { status: 'noop', reason: '没有锁文件' };
  const meta = cur.meta || { corrupt: true };
  try { fs.unlinkSync(lockPath(root)); } catch (err) {
    throw new PsmError(CODES.IO_ERROR, `无法删除锁文件：${err.message}`, {});
  }
  logEvent(root, { event: 'lock_repaired', reason: String(reason), actor, previous: { pid: meta.pid, host: meta.host, created_at: meta.created_at } });
  return { status: 'repaired', previous: { pid: meta.pid, host: meta.host, created_at: meta.created_at }, reason: String(reason) };
}

// 测试辅助：判断当前进程是否持锁（不暴露 token）。
export function isHeldByThisProcess(root) {
  const cur = readLock(root);
  return cur.status === 'ok' && cur.meta.pid === process.pid && cur.meta.host === HOST;
}

export { writeTextAtomic };
