// test/fixtures/hold-lock.mjs — 拿到写锁后停住，模拟“提交前被终止”的写进程。
import { acquireLock } from '../../lib/lock.mjs';

const root = process.argv[2];
const hold = await acquireLock(root, { purpose: 'test-hold', timeoutMs: 5000 });
process.stdout.write('LOCKED\n');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => { hold.release(); process.exit(0); });
