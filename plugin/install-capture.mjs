// 把 dsh-memory-capture 装进 DSH profile：自动抄写随 Harness 启动。
// 原则同 install.mjs：只做加法、先备份、装完自检；失败就停。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROW_ID = 'psm-memory-capture';
const PKG = 'dsh-memory-capture';
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

fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(patchFile, path.join(backupDir, 'cordis.patch.yml'));
console.log(`备份 → ${backupDir}`);

fs.rmSync(dstDir, { recursive: true, force: true });
fs.cpSync(srcDir, dstDir, { recursive: true });
console.log(`已复制 → ${dstDir}`);

const block = `
# PSM 自动抄写（dsh-memory-capture）：随 Harness 启动，每 3 分钟调一次 tools/capture.mjs。
# 关闭方式：加 \`disabled: true\`，或删掉整段后重启。手动兜底：node tools/capture.mjs --all
- insert:
    - id: ${ROW_ID}
      name: '${PKG}'
      config:
        root: '${ROOT}'
        interval_ms: 180000
        days: 3
`;
const before = fs.readFileSync(patchFile, 'utf8');
if (before.includes(ROW_ID)) {
  const rootLine = new RegExp(`(id:\\s*${ROW_ID}[\\s\\S]{0,300}?root:\\s*)'[^']*'`);
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

const require = createRequire(path.join(profileDir, 'package.json'));
let YAML;
try { YAML = require('yaml'); } catch (err) { fail(`profile 里解析不到 yaml 模块：${err.message}`); }
let doc;
try { doc = YAML.parse(fs.readFileSync(patchFile, 'utf8')); } catch (err) { fail(`cordis.patch.yml 解析失败（请立即回滚）：${err.message}`); }
const rows = (Array.isArray(doc) ? doc : []).flatMap((e) => (Array.isArray(e && e.insert) ? e.insert : []));
const row = rows.find((r) => r && r.id === ROW_ID);
if (!row) fail('自检失败：patch 里找不到刚插入的行');

let resolved;
try { resolved = require.resolve(PKG); } catch (err) { fail(`自检失败：Node 解析不到 ${PKG}：${err.message}`); }

console.log('\n自检通过：');
console.log(`  插入行=${JSON.stringify(row)}`);
console.log(`  模块解析=${resolved}`);
console.log(`\n回滚命令：`);
console.log(`  Copy-Item "${backupDir}\\cordis.patch.yml" "${patchFile}" -Force`);
console.log(`  Remove-Item "${dstDir}" -Recurse -Force`);
console.log('\n注意：需要重启 DeepSeek Harness 才会加载。');
