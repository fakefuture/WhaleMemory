// T46 回归：add 必须把向量并入缓存。
// 修前：新记录只进主库，要等手动 embed 才有 dense；查询里新记录 dense=-。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tempRoot, initStore, patchConfig, serviceFor,
} from './helpers.mjs';

test('T46 add 后立即可被语义检索（向量缓存同步写入）', async (t) => {
  const root = tempRoot(t, 't46');
  initStore(root);
  patchConfig(root, (cfg) => {
    cfg.embed.enabled = true;
    cfg.embed.provider = 'ollama';
    cfg.embed.url = 'http://127.0.0.1:11434';
    cfg.embed.model = 'bge-m3';
  });

  const service = serviceFor(root, { sessionId: null });
  const added = await service.add({
    content: 'gamma delta epsilon',
    tier: 'semantic',
    embedding: [1, 0],
  });
  assert.equal(added.status, 'added');

  const res = await service.query('zzz qqq', { queryVector: [1, 0], limit: 3 });
  assert.equal(res.results.length, 1);
  assert.notEqual(res.results[0].dense_score, null, 'add 之后 dense 应立即可用');
  assert.ok(res.results[0].dense_score > 0.9);
});
