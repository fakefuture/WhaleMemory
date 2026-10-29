// tools/capture-watch.mjs — 每 3 分钟跑一次 capture，把当前会话的新句子抄进记忆库。
// 用法：node tools/capture-watch.mjs   （建议后台跑；kill 掉即停）
// 环境变量：CAPTURE_INTERVAL_MS（默认 180000）、DSH_SESSION_ID、PSM_ROOT
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.PSM_ROOT || path.join(here, '..'));
const sessionId = String(process.env.DSH_SESSION_ID || '').trim();
const interval = Math.max(60000, Number(process.env.CAPTURE_INTERVAL_MS || 180000));
const logFile = path.join(root, 'tmp', 'capture-watch.log');
const capture = path.join(here, 'capture.mjs');

function tick() {
  const args = [capture, '--root', root, '--quiet'];
  if (sessionId) args.push('--session', sessionId);
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  const line = `${new Date().toISOString()} exit=${r.status}${r.stdout ? ` out=${r.stdout.trim()}` : ''}${r.stderr ? ` err=${r.stderr.trim()}` : ''}\n`;
  try { fs.appendFileSync(logFile, line, 'utf8'); } catch { /* 写不了日志不影响抄写 */ }
}

if (!sessionId) {
  console.error('capture-watch: 没有 DSH_SESSION_ID，退出');
  process.exit(2);
}
console.log(`capture-watch: session=${sessionId} interval=${interval}ms root=${root}`);
tick();
setInterval(tick, interval);
