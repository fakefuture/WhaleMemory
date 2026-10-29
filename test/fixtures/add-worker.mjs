// test/fixtures/add-worker.mjs — 独立进程新增一条记忆，用于跨进程并发测试。
import { MemoryService } from '../../lib/service.mjs';

const [root, index] = process.argv.slice(2);
const service = new MemoryService({ root, context: { actor: 'test' } });
const res = await service.add({
  content: `并发写入条目 ${index} alpha beta gamma`,
  scope: 'workspace',
  tier: 'episodic',
  note: `worker ${index}`,
});
if (res.status !== 'added') {
  console.error(`worker ${index} 没有写成：${res.status} ${res.reason || ''}`);
  process.exit(1);
}
process.stdout.write(`${res.id}\n`);
