import test from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, initStore, readStore, serviceFor } from './helpers.mjs';

test('T36 --at 半开区间与未知时间：不伪造时间精度', async (t) => {
  const root = tempRoot(t, 't36');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const timed = await service.add({
    content: 'release deadline alpha',
    tier: 'semantic',
    time: { valid_from: '2026-10-01T00:00:00.000Z', valid_to: '2026-11-01T00:00:00.000Z' },
  });
  const unknown = await service.add({ content: 'release notes beta', tier: 'semantic' });

  const at = async (iso) => service.query('release deadline', { at: iso, limit: 20 });
  const ids = (res) => res.results.map((r) => r.id);

  assert.ok(ids(await at('2026-10-01T00:00:00.000Z')).includes(timed.id), 'valid_from 是闭端');
  assert.ok(ids(await at('2026-10-31T23:59:59.000Z')).includes(timed.id));
  assert.ok(!ids(await at('2026-11-01T00:00:00.000Z')).includes(timed.id), 'valid_to 是开端');
  assert.ok(!ids(await at('2026-09-30T23:59:59.000Z')).includes(timed.id));

  const unk = await at('2026-10-15T12:00:00.000Z');
  const row = unk.results.find((r) => r.id === unknown.id);
  assert.ok(row, '未知时间的记录仍可返回，但不能假装精确');
  assert.equal(row.time_unknown, true);
  assert.deepEqual(row.time, { occurred_at: null, valid_from: null, valid_to: null });

  const doc = readStore(root);
  assert.deepEqual(doc.records.find((r) => r.id === unknown.id).time, {
    occurred_at: null, valid_from: null, valid_to: null,
  });

  await assert.rejects(
    () => service.add({ content: 'bad time alpha', time: { valid_from: '2026-10-01' } }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () => service.add({
      content: 'bad range alpha',
      time: { valid_from: '2026-11-01T00:00:00.000Z', valid_to: '2026-10-01T00:00:00.000Z' },
    }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
});

test('T37 冲突 keep-a/keep-b 改判：当前有效方恢复可见，旧方保留', async (t) => {
  const root = tempRoot(t, 't37');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const a = await service.add({ content: '服务端口是 8080 alpha', tier: 'semantic' });
  const b = await service.add({ content: '服务端口是 9090 alpha', tier: 'semantic' });
  const conflict = readStore(root).conflicts.find((c) => c.status === 'suspect' || c.status === 'open');
  assert.ok(conflict, '不同取值应形成待裁决冲突');
  assert.deepEqual([conflict.a, conflict.b].sort(), [a.id, b.id].sort());

  const first = await service.resolve(conflict.id, 'keep-a', { note: '以 8080 为准' });
  assert.equal(first.status, 'ok');
  let doc = readStore(root);
  assert.equal(doc.records.find((r) => r.id === a.id).validity, 'current');
  assert.equal(doc.records.find((r) => r.id === b.id).validity, 'superseded');
  assert.equal(doc.records.find((r) => r.id === b.id).demoted, true);
  let res = await service.query('服务端口 alpha', { limit: 10 });
  assert.ok(res.results.some((r) => r.id === a.id));
  assert.ok(!res.results.some((r) => r.id === b.id), '被裁决方默认不可回答');
  let hist = await service.query('服务端口 alpha', { limit: 10, includeHistory: true });
  assert.ok(hist.history.some((r) => r.id === b.id), '旧方仍可在历史区追溯');
  assert.equal(doc.records.find((r) => r.id === b.id).content, '服务端口是 9090 alpha');

  const second = await service.resolve(conflict.id, 'keep-b', { note: '改判：以 9090 为准' });
  assert.equal(second.status, 'ok');
  doc = readStore(root);
  assert.equal(doc.records.find((r) => r.id === b.id).validity, 'current');
  assert.equal(doc.records.find((r) => r.id === a.id).validity, 'superseded');
  res = await service.query('服务端口 alpha', { limit: 10 });
  assert.ok(res.results.some((r) => r.id === b.id));
  assert.ok(!res.results.some((r) => r.id === a.id));
  assert.equal(doc.records.find((r) => r.id === a.id).content, '服务端口是 8080 alpha', '旧正文不得被改写');

  const again = await service.resolve(conflict.id, 'keep-b', { note: '重复' });
  assert.equal(again.status, 'noop');
  await assert.rejects(() => service.resolve(conflict.id, 'keep-c'), (e) => e.code === 'INVALID_ARGUMENT');
});
