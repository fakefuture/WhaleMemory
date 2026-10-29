import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tempRoot, initStore, readStore, serviceFor, storeFile, fileHash,
} from './helpers.mjs';

test('T01 完全无关或空查询：无命中，记录无变化', async (t) => {
  const root = tempRoot(t, 't01');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const a = await service.add({ content: '今天午餐吃了面条 alpha', scope: 'workspace' });
  const b = await service.add({ content: '周末去公园散步 beta', scope: 'workspace' });
  assert.equal(a.status, 'added');
  assert.equal(b.status, 'added');

  const before = fileHash(storeFile(root));
  const empty = await service.query('');
  assert.equal(empty.results.length, 0);
  assert.equal(empty.no_match, true);
  assert.equal(empty.reason, 'empty_query');

  const unrelated = await service.query('量子纠缠 qzxv');
  assert.equal(unrelated.results.length, 0);
  assert.equal(unrelated.no_match, true);
  assert.equal(unrelated.reason, 'no_result_above_threshold');
  assert.equal(fileHash(storeFile(root)), before, '查询默认只读，不能改主库字节');
});

test('T02 同一相关查询 100 次：不改变强度、信度、效用和召回次数', async (t) => {
  const root = tempRoot(t, 't02');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const added = await service.add({ content: '部署端口配置在 alpha 服务上', scope: 'workspace' });
  assert.equal(added.status, 'added');

  const before = readStore(root);
  const frozen = JSON.parse(JSON.stringify(before.records[0]));
  const revision = before.revision;
  for (let i = 0; i < 100; i += 1) {
    const res = await service.query('部署端口');
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].id, added.id);
  }
  const after = readStore(root);
  assert.equal(after.revision, revision, '默认查询不得推进 revision');
  for (const key of ['strength', 'confidence', 'decay_rate', 'recall_count', 'last_accessed', 'utility', 'updated_at']) {
    assert.deepEqual(after.records[0][key], frozen[key], `${key} 不得被默认查询改变`);
  }
});

test('T03 --touch 只让合格命中增加访问计数，不改变信度或衰减率', async (t) => {
  const root = tempRoot(t, 't03');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const hit = await service.add({ content: '部署端口是 alpha 8080', scope: 'workspace' });
  const miss = await service.add({ content: '午餐是面条 beta', scope: 'workspace' });
  const before = readStore(root);
  const hitBefore = before.records.find((r) => r.id === hit.id);
  const missBefore = before.records.find((r) => r.id === miss.id);

  const res = await service.query('部署端口', { touch: true });
  assert.equal(res.results.length, 1);
  assert.deepEqual(res.touched, [hit.id]);

  const after = readStore(root);
  const hitAfter = after.records.find((r) => r.id === hit.id);
  const missAfter = after.records.find((r) => r.id === miss.id);
  assert.equal(hitAfter.recall_count, hitBefore.recall_count + 1);
  assert.ok(Date.parse(hitAfter.last_accessed) >= Date.parse(hitBefore.last_accessed));
  assert.equal(hitAfter.confidence, hitBefore.confidence);
  assert.equal(hitAfter.decay_rate, hitBefore.decay_rate);
  assert.equal(missAfter.recall_count, missBefore.recall_count);
  assert.equal(after.revision, before.revision + 1, '只有真正写入才推进一次 revision');

  await assert.rejects(
    () => service.query('部署端口', { touch: true, allScopes: true }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
});

test('T04 feedback 枚举拼错：明确报错，主库不变', async (t) => {
  const root = tempRoot(t, 't04');
  initStore(root);
  const service = serviceFor(root);
  const added = await service.add({ content: '反馈测试条目 alpha', scope: 'workspace' });
  const before = fileHash(storeFile(root));
  for (const bad of ['GOOD', 'yes', '', 'good ']) {
    await assert.rejects(
      () => service.feedback(added.id, bad),
      (err) => err.code === 'INVALID_ARGUMENT',
      `verdict=${JSON.stringify(bad)} 必须被拒绝`,
    );
  }
  assert.equal(fileHash(storeFile(root)), before, '非法枚举不得写库');
  const ok = await service.feedback(added.id, 'good', { requestId: 'r-1' });
  assert.equal(ok.status, 'ok');
  const again = await service.feedback(added.id, 'good', { requestId: 'r-1' });
  assert.equal(again.status, 'duplicate', '同 requestId 不重复累计');
});
