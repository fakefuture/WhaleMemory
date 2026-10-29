import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tempRoot, initStore, readStore, serviceFor, patchConfig,
} from './helpers.mjs';
import { planConsolidation } from '../lib/service.mjs';
import { readSnapshot } from '../lib/repository.mjs';
import { resolveContext } from '../lib/policy.mjs';

async function hitTwice(service, id) {
  await service.feedback(id, 'good', { requestId: `${id}-g1` });
  await service.feedback(id, 'good', { requestId: `${id}-g2` });
}

test('T09 数字不同但模拟向量相同：不自动合并、覆盖或归档', async (t) => {
  const root = tempRoot(t, 't09');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const a = await service.add({ content: '部署端口是 8080 alpha', tier: 'episodic' });
  const b = await service.add({ content: '部署端口是 9090 alpha', tier: 'episodic' });
  await hitTwice(service, a.id);
  await hitTwice(service, b.id);

  // 直接给两条记录同一向量：相似度守卫不能盖过“关键取值不同”。
  const snap = readSnapshot(root);
  const doc = snap.doc;
  for (const r of doc.records) r._vec = [1, 0, 0, 0];
  const plan = planConsolidation(doc, resolveContext(doc, { sessionId: null }));
  assert.equal(plan.absorbed.length, 0);
  assert.equal(plan.promoted.length, 2, '两条互不相同的取值各自成为独立候选');
  assert.ok(!plan.promoted.some((p) => p.from.length > 1));

  const res = await service.consolidate();
  assert.equal(res.absorbed.length, 0);
  const after = readStore(root);
  for (const id of [a.id, b.id]) {
    const rec = after.records.find((r) => r.id === id);
    assert.ok(rec, '来源仍应保留在活动记录中');
    assert.equal(rec.state, 'active');
    assert.equal(rec.validity, 'current');
  }
  assert.equal(after.records.find((r) => r.id === a.id).content, '部署端口是 8080 alpha');
  assert.equal(after.records.find((r) => r.id === b.id).content, '部署端口是 9090 alpha');
});

test('T10 簇中只有一条被覆盖：不整簇吸收', async (t) => {
  const root = tempRoot(t, 't10');
  initStore(root);
  patchConfig(root, (cfg) => {
    cfg.sim.lexical = { merge: 0.9, conflict: 0.3, cluster: 0.2, cover: 0.6, prune: 0.9 };
  });
  const service = serviceFor(root, { sessionId: null });
  const s = await service.add({
    content: 'alpha beta gamma delta epsilon zeta',
    tier: 'semantic',
  });
  const e1 = await service.add({
    content: 'alpha beta gamma delta epsilon zeta 说明',
    tier: 'episodic',
  });
  const e2 = await service.add({
    content: 'alpha beta gamma delta epsilon zeta 说明 补充 更多 内容',
    tier: 'episodic',
  });
  for (const id of [e1.id, e2.id]) await hitTwice(service, id);

  const snap = readSnapshot(root);
  const plan = planConsolidation(snap.doc, resolveContext(snap.doc, { sessionId: null }));
  const absorbedIds = plan.absorbed.flatMap((a) => a.episodes);
  assert.deepEqual(absorbedIds, [e1.id], '只有真正被覆盖的成员进入 absorbed');
  assert.equal(plan.promoted.length, 1);
  assert.deepEqual(plan.promoted[0].from, [e2.id], '未覆盖成员单独成候选，不随簇整体消失');

  const res = await service.consolidate();
  assert.equal(res.absorbed.length, 1);
  const after = readStore(root);
  for (const id of [s.id, e1.id, e2.id]) {
    assert.ok(after.records.some((r) => r.id === id), `${id} 不得被自动归档`);
  }
  const cand = after.records.find((r) => r.review_status === 'candidate');
  assert.ok(cand);
  assert.deepEqual(cand.merged_from, [e2.id]);
});

test('T11 巩固命中未采纳候选：不修剪正式来源；采纳后才可按规则修剪', async (t) => {
  const root = tempRoot(t, 't11');
  initStore(root);
  patchConfig(root, (cfg) => {
    cfg.sim.lexical = { merge: 0.9, conflict: 0.3, cluster: 0.3, cover: 0.6, prune: 0.5 };
    cfg.reorg.prune_min_confidence = 0.75;
  });
  const service = serviceFor(root, { sessionId: null });
  const e = await service.add({
    content: 'alpha beta gamma delta epsilon 说明',
    tier: 'episodic',
  });
  const cand = await service.add({
    content: 'alpha beta gamma delta epsilon 说明',
    tier: 'semantic',
    review_status: 'candidate',
    note: '待审核语义',
  });
  await hitTwice(service, e.id);

  const dry = await service.reorg({ dryRun: true });
  assert.deepEqual(dry.pruned, [], '未采纳候选不能成为修剪依据');

  const cons = await service.consolidate();
  assert.ok(cons.promoted.length >= 0);
  let doc = readStore(root);
  assert.ok(doc.records.some((r) => r.id === e.id), '巩固不得自动归档正式来源');
  assert.ok(doc.archive.every((r) => r.id !== e.id));

  const accepted = await service.acceptCandidate(cand.id, { note: '确认该语义可作为覆盖目标' });
  assert.equal(accepted.status, 'accepted');
  const dry2 = await service.reorg({ dryRun: true });
  assert.deepEqual(dry2.pruned.map((p) => p.id), [e.id], '采纳后才允许按覆盖规则修剪');

  const applied = await service.reorg();
  assert.deepEqual(applied.pruned.map((p) => p.id), [e.id]);
  doc = readStore(root);
  const archived = doc.archive.find((r) => r.id === e.id);
  assert.ok(archived, '旧正文进入归档，仍可追溯');
  assert.equal(archived.validity, 'superseded');
  assert.equal(archived.superseded_by, cand.id);
  assert.equal(archived.content, 'alpha beta gamma delta epsilon 说明');
  assert.equal(doc.records.find((r) => r.id === cand.id).review_status, 'accepted');
});
