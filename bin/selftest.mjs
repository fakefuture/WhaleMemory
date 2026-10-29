// bin/selftest.mjs — v0.2 自检入口：运行 test/*.test.mjs 里的 node:test 离线用例。
//
// 为什么不再保留 v1 的同步 check 清单：那些断言写死了 v1 语义（query 默认强化记忆、
// 同向量自动合并、merge 直接生成正式条目等），这些正是 v0.2 规格明确替换掉的行为。
// 相关场景已重新表达为 T01–T43；失败用例没有被删除来换绿灯，而是按新规格重写。
//
// 所有用例都在内存或系统临时目录运行，不读真实会话、不联网、不碰用户数据。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_DIR = path.join(REPO_ROOT, 'test');

export function testFiles(dir = TEST_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => /^t[0-9].*\.test\.mjs$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

// 返回进程退出码。子进程继承当前环境；Electron-as-Node 下也按 Node 跑。
export function runSelfTest({ dir = TEST_DIR, files = null, stdio = 'inherit' } = {}) {
  const list = files || testFiles(dir);
  if (!list.length) {
    console.error(`没有找到测试文件：${dir}`);
    return 1;
  }
  const r = spawnSync(process.execPath, ['--test', ...list], {
    cwd: REPO_ROOT,
    stdio,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (r.error) {
    console.error(`自检启动失败：${r.error.message}`);
    return 1;
  }
  return r.status === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = runSelfTest();
