import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  tempRoot, initStore, readStore, serviceFor, patchConfig, runPsmJson, sha256Text,
} from './helpers.mjs';
import { readSnapshot } from '../lib/repository.mjs';
import {
  attachVectors, fingerprintOf, emptyCache, VECTOR_CACHE_VERSION,
} from '../lib/embed.mjs';
import { retrieve } from '../lib/retrieval.mjs';
import { resolveContext } from '../lib/policy.mjs';

const FP = fingerprintOf({ provider: 'ollama', model: 'test-embed', url: 'http://127.0.0.1:11434' });

function cacheFor(entries, dim = null) {
  const doc = emptyCache(FP, dim);
  doc.version = VECTOR_CACHE_VERSION;
  for (const e of entries) doc.entries[e.record_id] = e;
  return doc;
}

function entryOf(rec, vector, overrides = {}) {
  return {
    record_id: rec.id,
    content_hash: sha256Text(rec.content),
    model_fingerprint: FP,
    dim: vector.length,
    vector,
    built_at: new Date().toISOString(),
    ...overrides,
  };
}

test('T19 正文改变但向量 ID 不变：旧向量拒用', async (t) => {
  const root = tempRoot(t, 't19');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const added = await service.add({ content: '旧正文 alpha 8080', tier: 'semantic' });
  const snap = readSnapshot(root);
  const cache = cacheFor([entryOf(snap.doc.records[0], [1, 0, 0])]);

  // 模拟外部编辑：正文改了，缓存仍指向同一个 record id。
  snap.doc.records[0].content = '新正文 beta 9090';
  const out = attachVectors(snap.doc, cache, FP);
  assert.equal(out.attached, 0);
  assert.equal(out.reasons.content_hash_mismatch, 1);
  assert.equal(snap.doc.records[0]._vec, undefined, '旧向量不得挂到改过的正文上');
  assert.equal(added.id, snap.doc.records[0].id);
});

test('T20 维度错误、NaN、Infinity、零向量：不参与向量通道，不污染排序', async (t) => {
  const root = tempRoot(t, 't20');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const ids = [];
  for (const content of ['port alpha one', 'port alpha two', 'port alpha three', 'port alpha four']) {
    const r = await service.add({ content, tier: 'semantic' });
    ids.push(r.id);
  }
  let snap = readSnapshot(root);
  const recs = snap.doc.records;
  const cache = cacheFor([
    entryOf(recs[0], [0, 0, 0, 0]),
    entryOf(recs[1], [NaN, 1, 0, 0]),
    entryOf(recs[2], [Infinity, 1, 0, 0]),
    entryOf(recs[3], [1, 0, 0], { dim: 4 }),
  ], 4);
  const attached = attachVectors(snap.doc, cache, FP);
  assert.equal(attached.attached, 0);
  assert.ok(attached.reasons.invalid_vector >= 3);
  assert.equal(attached.reasons.dim_mismatch, 1);

  snap = readSnapshot(root);
  snap.doc.records[0]._vec = [NaN, 1, 1, 1];
  snap.doc.records[1]._vec = [0, 0, 0, 0];
  snap.doc.records[2]._vec = [Infinity, 1, 1, 1];
  snap.doc.records[3]._vec = [1, 2, 3];
  const res = retrieve(snap.doc, 'port alpha', {
    ctx: resolveContext(snap.doc, { sessionId: null }),
    queryVector: [1, 1, 1, 1],
    limit: 10,
  });
  assert.equal(res.results.length, 4);
  for (const row of res.results) {
    assert.equal(row.dense_score, null, '非法向量不得进入 dense 通道');
    assert.equal(row.channels.includes('dense'), false);
    assert.ok(Number.isFinite(row.score));
    assert.ok(Number.isFinite(row.lexical_score));
  }
  assert.equal(res.diagnostics.dense_channel, true);
});

test('T21 部分记录无向量：词面仍参与，两个分数不直接混排', async (t) => {
  const root = tempRoot(t, 't21');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const a = await service.add({ content: 'alpha beta gamma', tier: 'semantic' });
  const b = await service.add({ content: 'alpha beta delta', tier: 'semantic' });
  const c = await service.add({ content: 'zzz epsilon', tier: 'semantic' });
  const snap = readSnapshot(root);
  const roster = new Map(snap.doc.records.map((r) => [r.id, r]));
  const cache = cacheFor([
    entryOf(roster.get(a.id), [1, 0, 0]),
    entryOf(roster.get(c.id), [1, 0, 0]),
  ], 3);
  attachVectors(snap.doc, cache, FP);
  const res = retrieve(snap.doc, 'alpha beta', {
    ctx: resolveContext(snap.doc, { sessionId: null }),
    queryVector: [1, 0, 0],
    limit: 10,
  });
  const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
  assert.ok(byId[a.id] && byId[b.id] && byId[c.id]);
  assert.equal(byId[a.id].match, 'hybrid');
  assert.equal(byId[b.id].match, 'lexical');
  assert.equal(byId[c.id].match, 'dense');
  assert.equal(byId[b.id].dense_score, null);
  assert.equal(byId[c.id].lexical_score, 0);
  assert.ok(byId[a.id].lexical_score > 0 && byId[a.id].dense_score > 0.45);
  // 两路用 RRF 排名融合，而不是把 Jaccard 与余弦直接相加。
  assert.ok(byId[a.id].fused_score > byId[b.id].fused_score);
  assert.ok(byId[a.id].components.relevance <= 1);
  assert.equal(byId[b.id].components.relevance > 0, true);
});

test('T22 无模型 / --offline / --lexical-only：不发禁止的网络请求，降级信息准确', async (t) => {
  const root = tempRoot(t, 't22');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  await service.add({ content: '离线查询 alpha beta', tier: 'semantic' });

  let connections = 0;
  const server = net.createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  patchConfig(root, (cfg) => {
    cfg.embed.enabled = true;
    cfg.embed.url = `http://127.0.0.1:${port}`;
    cfg.embed.timeout_ms = 1500;
  });

  const offline = runPsmJson(root, ['query', '离线查询 alpha', '--offline']);
  assert.equal(offline.diagnostics.dense_channel, false);
  assert.ok(offline.warnings.some((w) => w.includes('暂定')));
  const lexical = runPsmJson(root, ['query', '离线查询 alpha', '--lexical-only']);
  assert.equal(lexical.diagnostics.dense_channel, false);
  assert.ok(lexical.results.length >= 1, '词面通道仍应工作');

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(connections, 0, '--offline / --lexical-only 不得连接嵌入服务');
});
