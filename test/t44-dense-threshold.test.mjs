// T44 回归：bge-m3 实测里 dense_min=0.45 会把「无答案」的余弦 0.50 放进来（误报率 0.1818）。
// 默认改为 0.55 后必须挡住；这条测试同时证明 0.45 确实会漏，防止有人把阈值又调回去。
import test from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, initStore, readStore, serviceFor } from './helpers.mjs';
import { resolveContext } from '../lib/policy.mjs';
import { retrieve } from '../lib/retrieval.mjs';

const Q = [1, 0];
const V_HALF = [0.5, Math.sqrt(0.75)]; // cos(Q, V_HALF) = 0.5

test('T44 dense_min 默认 0.55 挡住 0.50 的稠密误命中', async (t) => {
  const root = tempRoot(t, 't44');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  await service.add({ content: 'kappa lambda unrelated', tier: 'semantic' });

  const doc = readStore(root);
  assert.equal(doc.config.retrieval.dense_min, 0.55, '默认门槛应为 0.55');
  doc.records[0]._vec = V_HALF;

  const ctx = resolveContext(doc, { sessionId: null });

  const strict = retrieve(doc, 'zzz qqq', { ctx, queryVector: Q, limit: 5 });
  assert.equal(strict.results.length, 0, '0.50 余弦不应过 0.55 门槛');

  doc.config.retrieval.dense_min = 0.45;
  const loose = retrieve(doc, 'zzz qqq', { ctx, queryVector: Q, limit: 5 });
  assert.equal(loose.results.length, 1, '旧门槛 0.45 会放进这条误命中（回归证据）');
  assert.ok(loose.results[0].dense_score > 0.45);
  assert.ok(loose.results[0].dense_score < 0.55);
});
