// lib/fsx.mjs — 严格文件 IO：区分「不存在 / 损坏 / 权限 / schema」，原子写失败绝不退回直接覆盖。
// 主库是业务事实来源；这里只负责把字节安全地放到位，不理解业务。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PsmError, CODES } from './errors.mjs';

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function sha256Text(text) {
  return sha256(Buffer.from(String(text ?? ''), 'utf8'));
}

export function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// 读文本。optional 只用于「明确允许缺失」的可选文件；主库不能 optional。
export function readTextStrict(file, { optional = false } = {}) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (optional) return null;
      throw new PsmError(CODES.FILE_NOT_FOUND, `文件不存在：${file}`, { file });
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new PsmError(CODES.PERMISSION_DENIED, `没有权限读取：${file}`, { file, syscode: err.code });
    }
    throw new PsmError(CODES.IO_ERROR, `读取失败：${file}（${err.message}）`, { file, syscode: err.code });
  }
}

export function readJsonStrict(file, { optional = false } = {}) {
  let text = readTextStrict(file, { optional });
  if (text === null) return null;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (err) {
    // 截断、BOM 之外的损坏都归为 JSON_INVALID：绝不当作空库继续写。
    throw new PsmError(CODES.JSON_INVALID, `${file} 不是合法 JSON：${err.message}`, { file });
  }
}

export function randomToken() {
  return crypto.randomBytes(12).toString('hex');
}

// 同目录唯一临时文件 → 写入并刷盘 → 关闭 → rename。rename 失败有限重试，最终失败保留原文件并报错。
// 不再提供「rename 失败就覆盖原文件」的退路：那条退路会直接毁掉主库。
export function writeJsonAtomic(file, data, { retries = 4, fsync = true } = {}) {
  const body = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
  return writeTextAtomic(file, body, { retries, fsync });
}

export function writeTextAtomic(file, body, { retries = 4, fsync = true } = {}) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    if (fsync) {
      try { fs.fsyncSync(fd); } catch { /* 文件系统不支持时忽略，README 已说明保证边界 */ }
    }
    fs.closeSync(fd);
    fd = null;
    let lastErr = null;
    for (let i = 0; i < Math.max(1, retries); i += 1) {
      try {
        fs.renameSync(tmp, file);
        return { file, bytes: Buffer.byteLength(body, 'utf8') };
      } catch (err) {
        lastErr = err;
        // Windows 上杀毒/索引可能短暂占用目标文件；短暂等待后重试，但绝不改成直接覆盖。
        const until = Date.now() + 12 * (i + 1);
        while (Date.now() < until) { /* 极短自旋，避免引入异步 */ }
      }
    }
    throw new PsmError(
      CODES.WRITE_FAILED,
      `原子替换失败：${file}（原文件保持不变；可重试或检查文件占用）`,
      { file, tmp, syscode: lastErr && lastErr.code, reason: lastErr && lastErr.message },
    );
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function copyFileAtomic(src, dest) {
  const buf = fs.readFileSync(src);
  const dir = path.dirname(dest);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// 递归列出文件（相对路径），用于备份与哈希验收。
export function walkFiles(root, { skipDirs = [], skipFiles = [] } = {}) {
  const skip = new Set(skipDirs.map((x) => x.replace(/\\/g, '/')));
  const skipF = new Set(skipFiles.map((x) => x.replace(/\\/g, '/')));
  const out = [];
  const visit = (dir) => {
    let rows;
    try { rows = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const row of rows) {
      const abs = path.join(dir, row.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (row.isDirectory()) {
        if (skip.has(rel) || skip.has(row.name)) continue;
        visit(abs);
      } else if (row.isFile()) {
        if (skipF.has(rel)) continue;
        out.push(rel);
      }
    }
  };
  visit(root);
  return out.sort();
}
