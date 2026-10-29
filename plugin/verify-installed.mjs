// 校验「已装进 profile 的插件」与「项目里的 CLI」渲染结果逐字一致。
// 用法：node plugin/verify-installed.mjs [库根目录]
//
// 除输出对照外，还会校验已安装包里的 lib/render.mjs 与仓库版本 sha256 一致，
// 防止安装后有人手改副本导致两套实现漂移。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readSnapshot } from '../lib/repository.mjs';
import { renderInjected } from '../lib/render.mjs';
import { loadScales } from '../lib/scales.mjs';

const profileDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const require = createRequire(path.join(profileDir, 'package.json'));

let entry;
try {
  entry = require.resolve('dsh-persona-bridge');
} catch (err) {
  console.error(`未安装：${err.message}`);
  process.exit(1);
}

const installed = await import(pathToFileURL(entry).href);
const root = path.resolve(process.argv[2] || process.cwd());
const repoRender = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'render.mjs');
const installedRender = path.join(path.dirname(entry), 'render.mjs');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const now = '2026-01-01T00:00:00.000Z';
const snap = readSnapshot(root);
const { scales, priorities } = { scales: loadScales(), priorities: {} };
const context = {
  ownerId: snap.doc.identity.owner_id,
  workspaceId: snap.doc.identity.workspace_id,
  sessionId: null,
};
const pluginText = installed.renderInjectedFile(root, { sessionId: null, now, mood: null });
const cliText = renderInjected({ store: snap.doc, context, now, mood: null, scales, priorities }).text;

const hashOk = fs.existsSync(installedRender) && sha(installedRender) === sha(repoRender);

console.log(`库根           ${root}`);
console.log(`入口           ${entry}`);
console.log(`渲染模块一致   ${hashOk ? '是' : '否（重跑 node plugin/install.mjs 或 plugin/sync-render.mjs）'}`);
console.log(`插件渲染长度   ${pluginText.length} 字`);
console.log(`CLI 渲染长度   ${cliText.length} 字`);
console.log(`逐字一致       ${pluginText === cliText}`);
if (!hashOk || pluginText !== cliText) {
  if (pluginText !== cliText) {
    console.log('\n--- 插件 ---\n' + pluginText);
    console.log('\n--- CLI ---\n' + cliText);
  }
  process.exit(1);
}
