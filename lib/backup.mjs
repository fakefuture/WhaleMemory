// lib/backup.mjs — 快照工具：创建 / 列出 / 校验 / 清理。
//
// 备份是"改数据前先备份"这条规则的可执行形式。刻意保持笨：整目录拷贝 + 文本清单 + SHA256，
// 不压缩、不增量、不加密——出事时用资源管理器也能翻。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EXCLUDE = new Set(['backups', 'node_modules', '.git', 'tmp']);

// 清单里记哈希的关键文件（数据与契约，坏没坏一眼能看出来）
const KEY_FILES = [
  'memory/store.json',
  'memory/embeddings.json',
  'memory/emotions.json',
  'memory/probe-runs.json',
  'emotion-states.json',
  'emotion-state.json',
  'PROGRESS.md',
];

export function backupsDir(root) {
  return path.join(String(root), 'backups');
}

function stamp() {
  // 带毫秒，避免同一秒内连续两次备份挤进同一个目录。
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

export function createBackup(root, { label = 'snapshot' } = {}) {
  const src = String(root);
  let name = `${label}-${stamp()}`;
  // 极端情况下（同一毫秒）再撞名就加后缀，绝不覆盖已有快照。
  let n = 1;
  while (fs.existsSync(path.join(backupsDir(src), name))) {
    n += 1;
    name = `${label}-${stamp()}-${n}`;
  }
  const dir = path.join(backupsDir(src), name);
  fs.mkdirSync(dir, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dir, entry.name), { recursive: true });
  }

  const files = walk(dir, []);
  const bytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  const lines = [
    `snapshot_at: ${new Date().toISOString()}`,
    `source: ${src}`,
    `label: ${label}`,
    `files: ${files.length}`,
    `bytes: ${bytes}`,
  ];
  for (const rel of KEY_FILES) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) lines.push(`${rel}  sha256=${sha256(p)}`);
  }
  fs.writeFileSync(path.join(dir, 'MANIFEST.txt'), `${lines.join('\n')}\n`, 'utf8');
  return { status: 'ok', name, dir, files: files.length, bytes };
}

export function listBackups(root) {
  const base = backupsDir(root);
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  return entries
    .map((d) => {
      const dir = path.join(base, d.name);
      const manifest = path.join(dir, 'MANIFEST.txt');
      const info = { name: d.name, dir, has_manifest: fs.existsSync(manifest), files: 0, bytes: 0, at: null, at_ms: 0 };
      try {
        // 没有清单的老备份用目录 mtime 排序，否则会被当成"最新"。
        const mtime = fs.statSync(dir).mtime;
        info.at_ms = mtime.getTime();
        if (info.has_manifest) {
          const text = fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '');
          const at = /snapshot_at:\s*(.+)/.exec(text);
          const files = /files:\s*(\d+)/.exec(text);
          const bytes = /bytes:\s*(\d+)/.exec(text);
          if (at) info.at = at[1].trim();
          if (files) info.files = Number(files[1]);
          if (bytes) info.bytes = Number(bytes[1]);
        }
        // 没有清单、或清单是早期脚本写的（没有 files:/bytes: 行）→ 实际数一遍，
        // 否则会显示成"0 文件"，看起来像空备份。
        if (!info.files) {
          const all = walk(dir, []);
          info.files = all.length;
          info.bytes = all.reduce((sum, f) => sum + fs.statSync(f).size, 0);
        }
        // 清单里的时间可能带 +08:00 也可能带 Z，统一按 epoch 比较，别用字符串排序。
        if (info.at) {
          const parsed = Date.parse(info.at);
          if (Number.isFinite(parsed)) info.at_ms = parsed;
        } else {
          info.at = mtime.toISOString();
        }
      } catch { /* 读不了就留空 */ }
      return info;
    })
    .sort((a, b) => b.at_ms - a.at_ms);
}

// 校验一个快照：清单里的 sha256 与文件现状逐一比对。
export function verifyBackup(root, name) {
  const dir = path.join(backupsDir(root), String(name));
  if (!fs.existsSync(dir)) return { status: 'not_found', name };
  const manifest = path.join(dir, 'MANIFEST.txt');
  if (!fs.existsSync(manifest)) return { status: 'no_manifest', name };
  const text = fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '');
  const checks = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+sha256=([0-9A-F]{64})$/.exec(line.trim());
    if (!m) continue;
    const [, rel, expected] = m;
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) {
      checks.push({ file: rel, status: 'missing' });
      continue;
    }
    const actual = sha256(p);
    checks.push({ file: rel, status: actual === expected ? 'ok' : 'mismatch', expected, actual });
  }
  const bad = checks.filter((c) => c.status !== 'ok');
  return { status: bad.length ? 'mismatch' : 'ok', name, checked: checks.length, bad, checks };
}

// 只保留最近 keep 个快照（按名字排序 = 按时间），并拒绝动 backups 目录以外的东西。
export function pruneBackups(root, keep = 10) {
  const n = Math.max(0, Number(keep) || 0);
  const base = path.resolve(backupsDir(root));
  const all = listBackups(root);
  const victims = all.slice(n);
  const removed = [];
  for (const v of victims) {
    const resolved = path.resolve(v.dir);
    if (!resolved.startsWith(base + path.sep)) continue;
    fs.rmSync(resolved, { recursive: true, force: true });
    removed.push(v.name);
  }
  return { status: 'ok', kept: Math.min(n, all.length), removed };
}
