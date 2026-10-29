// T45 回归：service.query 必须把向量缓存挂回记录。
// 修前 CLI 的 query 会把 _vec 挂到 snap.doc，但 MemoryService.snapshot() 重新 readSnapshot，
// 记录上没有 _vec → dense 通道永远为空，hybrid 实际退化成词面。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tempRoot, initStore, readStore, patchConfig, serviceFor, sha256Text,
} from './helpers.mjs';
import {
  fingerprintOf, emptyCache, VECTOR_CACHE_VERSION, saveVectors, embedConfig,
} from '../lib/embed.mjs';

test('T45 service 查询从向量缓存挂载 _vec，dense 通道可用', async (t) => {
  const root = tempRoot(t, 't45');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const added = await service.add({ content: 'kappa lambda unrelated', tier: 'semantic' });

  patchConfig(root, (cfg) => {
    cfg.embed.enabled = true;
    cfg.embed.provider = 'ollama';
    cfg.embed.url = 'http://127.0.0.1:11434';
    cfg.embed.model = 'bge-m3';
    cfg.retrieval.dense_min = 0.55;
  });

  const doc = readStore(root);
  const fp = fingerprintOf(embedConfig(doc));
  const cache = emptyCache(fp, 2);
  cache.version = VECTOR_CACHE_VERSION;
  cache.entries[added.id] = {
    record_id: added.id,
    content_hash: sha256Text('kappa lambda unrelated'),
    model_fingerprint: fp,
    dim: 2,
    vector: [1, 0],
    built_at: new Date().toISOString(),
  };
  saveVectors(root, cache);

  const res = await service.query('zzz qqq', { queryVector: [1, 0], limit: 3 });
  assert.equal(res.results.length, 1);
  assert.notEqual(res.results[0].dense_score, null, 'dense 应参与（修前这里永远是 null）');
  assert.ok(res.results[0].dense_score > 0.9);
});
