// test/fixtures/ingest-once.mjs — 提交一次采集后立即终止进程，用于“提交后进程终止”重跑测试。
import fs from 'node:fs';
import { MemoryService } from '../../lib/service.mjs';

const [root, sourceId, messagesFile, keysFile] = process.argv.slice(2);
const messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
const service = new MemoryService({ root });
const res = await service.ingestMessages({
  context: { sessionId: 'session-terminal' },
  messages,
  source: {
    id: sourceId,
    file: messagesFile,
    session_id: 'session-terminal',
    keys,
    start_index: 0,
    users_total: keys.length,
  },
});
process.stdout.write(`${JSON.stringify(res)}\n`);
// 模拟提交后立刻崩溃/被杀：不再做任何收尾。
process.exit(0);
