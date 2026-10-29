// test/helpers.mjs — 离线测试公用工具。
// 所有数据都在系统临时目录，测试结束用 t.after / finally 清理。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { emptyStore, sha256Text } from '../lib/schema.mjs';
import { writeStore } from '../lib/repository.mjs';
import { MemoryService } from '../lib/service.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PSM = path.join(REPO, 'bin', 'psm.mjs');
export const CAPTURE = path.join(REPO, 'tools', 'capture.mjs');
export const FIXTURES = path.join(REPO, 'test', 'fixtures');

export function tempRoot(t, prefix = 'psm-test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
  });
  return root;
}

export function storeFile(root) {
  return path.join(root, 'memory', 'store.json');
}

export function initStore(root, opts = {}) {
  const doc = emptyStore(opts);
  writeStore(root, doc);
  return doc;
}

export function readStore(root) {
  return JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));
}

export function writeRawStore(root, doc) {
  fs.mkdirSync(path.dirname(storeFile(root)), { recursive: true });
  fs.writeFileSync(storeFile(root), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

export function serviceFor(root, context = {}) {
  return new MemoryService({ root, context });
}

export function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function allFileHashes(root, { skip = [] } = {}) {
  const out = {};
  const walk = (dir) => {
    for (const row of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, row.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (row.isDirectory()) walk(abs);
      else if (row.isFile()) out[rel] = fileHash(abs);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

export function patchConfig(root, fn) {
  const doc = readStore(root);
  fn(doc.config, doc);
  writeRawStore(root, doc);
  return doc;
}

export function nodeEnv(extra = {}) {
  return {
    ...process.env,
    // 测试可能由 Electron-as-Node 启动；子进程也必须按 Node 跑。
    ELECTRON_RUN_AS_NODE: '1',
    ...extra,
  };
}

export function runPsm(root, args, opts = {}) {
  return spawnSync(process.execPath, [PSM, ...args, '--root', root], {
    cwd: opts.cwd || root,
    encoding: 'utf8',
    env: nodeEnv(opts.env),
    timeout: opts.timeout || 30000,
  });
}

export function runPsmJson(root, args, opts = {}) {
  const r = runPsm(root, [...args, '--json'], opts);
  if (r.status !== 0) {
    throw new Error(`psm ${args.join(' ')} 退出 ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    throw new Error(`psm ${args.join(' ')} 没有输出 JSON：${r.stdout}\n${err.message}`);
  }
}

export function runCapture(root, args, opts = {}) {
  return spawnSync(process.execPath, [CAPTURE, ...args, '--root', root], {
    cwd: opts.cwd || root,
    encoding: 'utf8',
    env: nodeEnv(opts.env),
    timeout: opts.timeout || 30000,
  });
}

export function spawnNode(script, args, opts = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: opts.cwd || REPO,
    env: nodeEnv(opts.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

export function writeJsonl(file, messages) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(file, body, 'utf8');
}

export function userMessage(id, text, extra = {}) {
  return { type: 'user/message', id, time: '2026-10-28T10:00:00+08:00', data: { role: 'user', content: [{ type: 'text', text }] }, ...extra };
}

export function assistantMessage(id, text) {
  return { type: 'assistant/message', id, data: { role: 'assistant', content: [{ type: 'text', text }] } };
}

export function withOpenConflict(root) {
  const doc = readStore(root);
  return (doc.conflicts || []).filter((c) => c.status === 'open' || c.status === 'suspect');
}

export { sha256Text };
