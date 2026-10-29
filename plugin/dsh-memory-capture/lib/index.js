// dsh-memory-capture — 随 Harness 启动，每 N 分钟跑一次记忆自动抄写。
//
// 设计约束：
//   1. 不阻塞会话：spawn 子进程，stdio ignore，失败只吞掉。
//   2. 不碰 system prompt、不注册工具，只起一个定时器。
//   3. 抄什么由 tools/capture.mjs 决定（稳定信号 + 去重 + 水位线），这里不判断内容。
//   4. Harness 退出/插件卸载时 clearInterval，不留孤儿。
import { spawn } from 'node:child_process';
import path from 'node:path';

export const name = 'dsh-memory-capture';

const DEFAULTS = {
  root: '',
  interval_ms: 180000,
  days: 3,
  disabled: false,
};

let running = false;

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (cfg.disabled) return;
  if (!ctx || typeof ctx.effect !== 'function') return; // 没有 effect 能力就什么都不做，别把启动搞崩

  const root = path.resolve(String(cfg.root || process.env.PSM_ROOT || process.cwd()));
  const script = path.join(root, 'tools', 'capture.mjs');
  const interval = Math.max(60000, Number(cfg.interval_ms) || 180000);
  const days = Math.max(1, Number(cfg.days) || 3);

  const run = () => {
    if (running) return; // 上一轮没跑完就跳过，避免堆积
    running = true;
    try {
      const child = spawn(process.execPath, [script, '--root', root, '--all', '--quiet', '--days', String(days)], {
        cwd: root,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.on('error', () => { running = false; });
      child.on('exit', () => { running = false; });
      if (typeof child.unref === 'function') child.unref();
    } catch {
      running = false; // 抄写失败不能影响会话
    }
  };

  ctx.effect(() => {
    run();
    const timer = setInterval(run, interval);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'psm-memory-capture.interval');
}
