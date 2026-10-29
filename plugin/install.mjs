// 把 dsh-persona-bridge 装进 DSH profile。
// 原则：只做加法、先备份、装完自检；任何一步失败就停，不覆盖用户已有的行。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { syncRender } from './sync-render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROW_ID = 'psm-persona-bridge';
const PKG = 'dsh-persona-bridge';
// 库根跟着本仓库走（迁移到别的盘也不用改代码）：插件目录的上一级；
// 也允许 PSM_ROOT 覆盖。
const ROOT = process.env.PSM_ROOT ? String(process.env.PSM_ROOT) : path.resolve(HERE, '..');

const home = os.homedir();
const profileDir = path.join(home, '.dsh', 'profiles', 'desktop');
const srcDir = path.resolve(HERE, PKG);
const dstDir = path.join(profileDir, 'node_modules', PKG);
const patchFile = path.join(profileDir, 'cordis.patch.yml');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = path.join(home, '.dsh', 'backups', stamp);

const fail = (msg) => { console.error(`ABORT: ${msg}`); process.exit(1); };

if (!fs.existsSync(profileDir)) fail(`找不到 profile 目录：${profileDir}`);
if (!fs.existsSync(patchFile)) fail(`找不到 ${patchFile}`);
if (!fs.existsSync(srcDir)) fail(`找不到插件源目录：${srcDir}`);

// 1) 备份两个会被碰到的文件
fs.mkdirSync(backupDir, { recursive: true });
for (const f of ['cordis.patch.yml', 'package.json']) {
  const p = path.join(profileDir, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(backupDir, f));
}
console.log(`备份 → ${backupDir}`);

// 2) 复制插件包（先删旧的同名目录，保证是纯替换）
//    先把仓库里唯一的渲染实现同步进包内，避免插件自带一份会漂移的副本。
const synced = syncRender({ srcDir, repoRoot: path.resolve(HERE, '..') });
console.log(`已同步渲染模块（sha256 ${synced.sha256.slice(0, 12)}）`);
fs.rmSync(dstDir, { recursive: true, force: true });
fs.cpSync(srcDir, dstDir, { recursive: true });
console.log(`已复制 → ${dstDir}`);

// 3) 追加 insert 行（幂等：已存在就跳过）
const block = `
# PSM 人格卡桥（dsh-persona-bridge）：只读 memory/store.json，注入一段 system prompt。
# 关闭方式：把下面这条 insert 里加 \`disabled: true\`，或删掉整段后重启。
- insert:
    - id: ${ROW_ID}
      name: '${PKG}'
      config:
        root: '${ROOT}'
        cache_ms: 1000
`;
const before = fs.readFileSync(patchFile, 'utf8');
if (before.includes(ROW_ID)) {
  // 已存在：把 root 改成当前库位置（迁移后靠这一步把 E: 改成新盘），其余不动。
  const rootLine = /(id:\s*psm-persona-bridge[\s\S]{0,200}?root:\s*)'[^']*'/;
  if (rootLine.test(before)) {
    const after = before.replace(rootLine, `$1'${ROOT}'`);
    if (after !== before) {
      fs.writeFileSync(patchFile, after, 'utf8');
      console.log(`patch 里已有该行，已把 root 更新为 ${ROOT}`);
    } else {
      console.log(`patch 里已有该行，root 已是 ${ROOT}`);
    }
  } else {
    console.log('patch 里已有该行，但没找到 root 字段，跳过（请手工检查）');
  }
} else {
  fs.appendFileSync(patchFile, block, 'utf8');
  console.log('已追加 insert 行');
}

// 4) 自检：YAML 可解析、行存在、包可解析
const require = createRequire(path.join(profileDir, 'package.json'));
let YAML;
try {
  YAML = require('yaml');
} catch (err) {
  fail(`profile 里解析不到 yaml 模块：${err.message}`);
}
let doc;
try {
  doc = YAML.parse(fs.readFileSync(patchFile, 'utf8'));
} catch (err) {
  fail(`cordis.patch.yml 解析失败（请立即回滚）：${err.message}`);
}
const rows = (Array.isArray(doc) ? doc : []).flatMap((e) => (Array.isArray(e && e.insert) ? e.insert : []));
const row = rows.find((r) => r && r.id === ROW_ID);
if (!row) fail('自检失败：patch 里找不到刚插入的行');

let resolved;
try {
  resolved = require.resolve(PKG);
} catch (err) {
  fail(`自检失败：Node 解析不到 ${PKG}：${err.message}`);
}

console.log('\n自检通过：');
console.log(`  yaml 条目数=${(Array.isArray(doc) ? doc : []).length}  插入行=${JSON.stringify(row)}`);
console.log(`  模块解析=${resolved}`);
console.log(`\n回滚命令：`);
console.log(`  Copy-Item "${backupDir}\\cordis.patch.yml" "${patchFile}" -Force`);
console.log(`  Remove-Item "${dstDir}" -Recurse -Force`);
console.log('\n注意：需要重启 DeepSeek Harness 才会加载。');
