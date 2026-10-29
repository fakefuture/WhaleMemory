import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tempRoot, initStore, readStore, serviceFor, storeFile, fileHash, patchConfig,
} from './helpers.mjs';
import { MemoryService } from '../lib/service.mjs';
import { renderInjected } from '../lib/render.mjs';
import { readSnapshot } from '../lib/repository.mjs';
import { resolveContext } from '../lib/policy.mjs';

test('T05 候选与正式记录文本相同：候选不借去重旁路变成正式', async (t) => {
  const root = tempRoot(t, 't05');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const text = '项目代号是 Falcon alpha';
  const accepted = await service.add({ content: text, scope: 'workspace' });
  assert.equal(accepted.status, 'added');
  assert.equal(accepted.review_status, 'accepted');

  const cand = await service.add({ content: text, scope: 'workspace', review_status: 'candidate', note: '候选' });
  assert.equal(cand.status, 'added', '候选与 accepted 不同审核状态，不能静默并入正式记录');
  assert.equal(cand.review_status, 'candidate');
  assert.notEqual(cand.id, accepted.id);

  const dup = await service.add({ content: text, scope: 'workspace', review_status: 'candidate' });
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.id, cand.id, '重复候选只并到候选自己，不碰正式记录');

  const doc = readStore(root);
  const formal = doc.records.find((r) => r.id === accepted.id);
  const candidate = doc.records.find((r) => r.id === cand.id);
  assert.equal(formal.review_status, 'accepted');
  assert.equal(formal.content, text);
  assert.equal(candidate.review_status, 'candidate');

  const defaults = await service.query('Falcon 项目代号');
  assert.deepEqual(defaults.results.map((r) => r.id), [accepted.id], '默认查询不得返回候选');
  const withCand = await service.query('Falcon 项目代号', { includeCandidates: true });
  assert.ok(withCand.candidates.some((r) => r.id === cand.id));
});

test('T06 session A/B 同文：记录、证据与查询隔离', async (t) => {
  const root = tempRoot(t, 't06');
  initStore(root);
  const text = '我的部署偏好是 alpha 蓝绿切换';
  const a = new MemoryService({ root, context: { sessionId: 'A' } });
  const b = new MemoryService({ root, context: { sessionId: 'B' } });
  const ra = await a.add({ content: text, scope: 'session' });
  const rb = await b.add({ content: text, scope: 'session' });
  assert.equal(ra.status, 'added');
  assert.equal(rb.status, 'added');
  assert.notEqual(ra.id, rb.id, '不同会话相同正文必须各自记录');
  assert.notEqual(ra.evidence_ids[0], rb.evidence_ids[0]);

  const doc = readStore(root);
  const ea = doc.evidence.find((e) => e.id === ra.evidence_ids[0]);
  const eb = doc.evidence.find((e) => e.id === rb.evidence_ids[0]);
  assert.equal(ea.session_id, 'A');
  assert.equal(eb.session_id, 'B');
  assert.equal(doc.records.find((r) => r.id === ra.id).namespace.session_id, 'A');
  assert.equal(doc.records.find((r) => r.id === rb.id).namespace.session_id, 'B');

  const qa = await a.query('部署偏好 alpha');
  const qb = await b.query('部署偏好 alpha');
  assert.deepEqual(qa.results.map((r) => r.id), [ra.id]);
  assert.deepEqual(qb.results.map((r) => r.id), [rb.id]);

  const noSession = new MemoryService({ root, context: { sessionId: null } });
  const none = await noSession.query('部署偏好 alpha');
  assert.equal(none.results.length, 0, '没有会话上下文时不得看到任何会话记录');

  const again = await a.add({ content: text, scope: 'session' });
  assert.equal(again.status, 'duplicate');
  assert.equal(again.id, ra.id);
});

test('T07 无 session 上下文：不读 session 记忆或其他会话情绪', async (t) => {
  const root = tempRoot(t, 't07');
  initStore(root);
  patchConfig(root, (cfg) => {
    cfg.recall.inject_top = 10;
    cfg.recall.inject_budget = 1000;
  });
  const anon = new MemoryService({ root, context: { sessionId: null } });
  const s1 = new MemoryService({ root, context: { sessionId: 's1' } });
  await anon.add({ content: '全局规则 alpha 对所有项目有效', scope: 'global' });
  await anon.add({ content: '工作区规则 beta 只在本项目有效', scope: 'workspace' });
  await s1.add({ content: '会话内秘密 gamma 只在 s1 有效', scope: 'session' });

  const q = await anon.query('规则 alpha beta gamma');
  assert.ok(q.results.length >= 2);
  assert.ok(!q.results.some((r) => r.content.includes('会话内秘密')), '无会话查询不能看到 session 记忆');

  const snap = readSnapshot(root);
  const ctx = resolveContext(snap.doc, { sessionId: null });
  const rendered = renderInjected({ store: snap.doc, context: ctx, now: '2026-10-28T12:00:00.000Z', mood: null });
  assert.ok(rendered.text.includes('全局规则'));
  assert.ok(rendered.text.includes('工作区规则'));
  assert.ok(!rendered.text.includes('会话内秘密'), '静态注入同样排除 session 记录');
  assert.ok(!rendered.text.includes('【观察到的用户情绪】'), '无会话上下文不套用任何会话情绪');
});

test('T08 global/workspace/session 范围矩阵；跨范围诊断只读', async (t) => {
  const root = tempRoot(t, 't08');
  const doc = initStore(root, { workspaceId: 'ws_1' });
  assert.equal(doc.identity.workspace_id, 'ws_1');
  const ws1 = new MemoryService({ root, context: { workspaceId: 'ws_1', sessionId: null } });
  const s1 = new MemoryService({ root, context: { workspaceId: 'ws_1', sessionId: 's1' } });
  const ws2 = new MemoryService({ root, context: { workspaceId: 'ws_2', sessionId: null } });

  const g = await ws1.add({ content: '范围矩阵 global alpha', scope: 'global' });
  const w1 = await ws1.add({ content: '范围矩阵 workspace alpha', scope: 'workspace' });
  const s1r = await s1.add({ content: '范围矩阵 session alpha', scope: 'session' });
  const w2 = await ws2.add({ content: '范围矩阵 workspace alpha ws2', scope: 'workspace' });

  const ids = async (svc, opts = {}) => (await svc.query('范围矩阵 alpha', { limit: 20, ...opts })).results.map((r) => r.id);
  assert.deepEqual((await ids(ws1)).sort(), [g.id, w1.id].sort(), 'workspace 查询看到 global + 本工作区');
  assert.deepEqual((await ids(s1)).sort(), [g.id, w1.id, s1r.id].sort(), 'session 另加本会话');
  assert.deepEqual((await ids(ws2)).sort(), [g.id, w2.id].sort(), '其他工作区看不到 ws_1');

  const before = fileHash(storeFile(root));
  const all = await ws1.query('范围矩阵 alpha', { allScopes: true, limit: 20 });
  assert.deepEqual(all.results.map((r) => r.id).sort(), [g.id, w1.id, s1r.id, w2.id].sort(), '诊断查询按 owner 跨范围');
  assert.equal(fileHash(storeFile(root)), before, '--all-scopes 只读');
  await assert.rejects(() => ws1.query('范围矩阵', { allScopes: true, touch: true }), (e) => e.code === 'INVALID_ARGUMENT');
});
