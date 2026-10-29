// plugin/sync-render.mjs — 把仓库的 lib/render.mjs 复制进插件包。
//
// 为什么复制而不是 import：插件安装到 DSH profile 的 node_modules 后是独立包，
// 不能引用仓库路径；复制同一份纯函数是保证「插件与 CLI 逐字一致」的最简单办法。
// 安装脚本会调用它；测试会先同步再校验两边 sha256 相同。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function syncRender({ srcDir = path.join(HERE, 'dsh-persona-bridge'), repoRoot = path.resolve(HERE, '..') } = {}) {
  const source = path.join(repoRoot, 'lib', 'render.mjs');
  const destDir = path.join(srcDir, 'lib');
  const dest = path.join(destDir, 'render.mjs');
  const body = fs.readFileSync(source, 'utf8');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, body, 'utf8');
  return { source, dest, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const res = syncRender();
  console.log(`已同步渲染模块：${res.source}\n  → ${res.dest}\n  sha256=${res.sha256}`);
}
