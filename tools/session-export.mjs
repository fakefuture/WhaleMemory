// tools/session-export.mjs — 把 DSH 的会话存档（多帧 zstd JSONL）导出成可读 Markdown。
//
// 为什么需要：DSH 的 session.v4.jsonl.zstd 是 append-only 多帧 zstd（每追加一次写一帧），
// Node 的 zlib.zstdDecompressSync 只解第一帧，所以要先按帧切开再逐帧解。
// 用法：node tools/session-export.mjs <session.v4.jsonl.zstd> <输出.md> [--raw 输出.jsonl]
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = 0xfd2fb528;
const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function';
if (!HAS_ZSTD) {
  console.error(
    `当前 Node ${process.version} 的 zlib 不支持 zstdDecompressSync：导出 .jsonl.zstd 需要 Node 22.15+（推荐 24）。`,
  );
  process.exit(2);
}

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
  return out.filter((s) => s.trim()).join('\n\n').trim();
}

const [, , src, out, ...rest] = process.argv;
if (!src || !out) {
  console.error('用法：node tools/session-export.mjs <session.v4.jsonl.zstd> <输出.md> [--raw 输出.jsonl]');
  process.exit(2);
}
const rawOutIdx = rest.indexOf('--raw');
const rawOut = rawOutIdx >= 0 ? rest[rawOutIdx + 1] : null;

const buf = fs.readFileSync(src);
const { text, frames } = splitFrames(buf);
const lines = text.split('\n').filter(Boolean);
if (rawOut) fs.writeFileSync(rawOut, text, 'utf8');

const rows = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type === 'user/message' || o.type === 'assistant/message') {
    const d = o.data || {};
    const body = collectText(d.content ?? d.message?.content ?? d);
    if (body) rows.push({ role: o.type === 'user/message' ? 'user' : 'assistant', time: o.time, text: body });
  }
}
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(Number(ms) || Date.now()); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const head = [
  '# 会话导出',
  '',
  `- 源文件：${src}`,
  `- 帧数：${frames}；事件行：${lines.length}`,
  `- 导出时间：${new Date().toISOString()}`,
  `- 对话条目：${rows.length}`,
  '',
  '---',
  '',
].join('\n');
const body = rows.map((r) => `## ${r.role === 'user' ? '👤 用户' : '🐋 助手'} · ${stamp(r.time)}\n\n${r.text}\n`).join('\n');
fs.writeFileSync(out, head + body, 'utf8');
console.log(`frames=${frames} events=${lines.length} dialogue=${rows.length} -> ${(Buffer.byteLength(head + body) / 1048576).toFixed(2)}MB ${out}`);
