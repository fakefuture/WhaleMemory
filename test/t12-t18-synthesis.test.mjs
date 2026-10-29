import test from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, initStore, readStore, serviceFor, patchConfig } from './helpers.mjs';
import { parseProposalJson, validateProposal } from '../lib/validation.mjs';

async function pendingCandidate(service, sourceIds, label) {
  const res = await service.add({
    content: `待合成占位 ${label}`,
    tier: 'semantic',
    review_status: 'candidate',
    needs_synthesis: true,
    proposal: {
      kind: 'synthesis',
      source_ids: sourceIds,
      source_hashes: {},
      model: null,
      generated_at: null,
      has_conflict: false,
      proposed_text: null,
      validation: { status: 'inconclusive', reasons: ['等待生成'], checks: [] },
    },
    note: '测试候选',
  });
  assert.equal(res.status, 'added');
  return res.id;
}

function proposalJson(text, ids, hasConflict = false) {
  return JSON.stringify({ proposed_text: text, source_ids: ids, has_conflict: hasConflict });
}

test('T12 模型改数值/路径/版本/否定：拒绝或 inconclusive，原文保留', async (t) => {
  const root = tempRoot(t, 't12');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const cases = [
    { content: '部署端口是 8080 alpha', mutate: (s) => s.replace('8080', '9090') },
    { content: '配置放在 /etc/alpha.conf 里 beta', mutate: (s) => s.replace('/etc/alpha.conf', '/etc/beta.conf') },
    { content: '依赖版本 v1.2.3 alpha', mutate: (s) => s.replace('v1.2.3', 'v1.2.4') },
    { content: '允许外部访问 alpha beta', mutate: (s) => s.replace('允许', '不允许') },
  ];
  const candidates = [];
  for (let i = 0; i < cases.length; i += 1) {
    const src = await service.add({ content: cases[i].content, tier: 'semantic' });
    const cid = await pendingCandidate(service, [src.id], `t12-${i}`);
    candidates.push({ i, cid, srcId: src.id, expected: cases[i].mutate(cases[i].content) });
  }
  const byId = new Map(candidates.map((c) => [c.cid, c]));
  const res = await service.synthesizeCandidates({
    generate: async ({ rec, sources }) => {
      const c = byId.get(rec.id);
      return proposalJson(c.expected, sources.map((s) => s.id));
    },
    limit: 20,
  });
  assert.equal(res.failed.length, 0);
  assert.equal(res.done.length, cases.length);

  const doc = readStore(root);
  for (const c of candidates) {
    const done = res.done.find((d) => d.id === c.cid);
    assert.ok(['fail', 'inconclusive'].includes(done.status), `case ${c.i} 应被拒绝/inconclusive，实际 ${done.status}`);
    const rec = doc.records.find((r) => r.id === c.cid);
    assert.ok(['fail', 'inconclusive'].includes(rec.proposal.validation.status));
    const original = doc.records.find((r) => r.id === c.srcId);
    assert.equal(original.content, cases[c.i].content, '来源原文必须保留');
    assert.equal(original.state, 'active');
    const accepted = await service.acceptCandidate(c.cid, { note: '试图采纳', ackInconclusive: true });
    if (done.status === 'fail') assert.equal(accepted.status, 'rejected');
    else assert.notEqual(accepted.status, 'accepted', 'inconclusive 也不能在未重新校验时直接采纳');
  }
});

test('T13 模型遗漏条件或关键数值：不因长度合格直接接受', async (t) => {
  const root = tempRoot(t, 't13');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const src1 = await service.add({ content: '如果温度超过 80 度就关机 alpha', tier: 'semantic' });
  const src2 = await service.add({ content: '备份到 /var/backups 目录，保留 7 天 alpha', tier: 'semantic' });
  const c1 = await pendingCandidate(service, [src1.id], 't13-1');
  const c2 = await pendingCandidate(service, [src2.id], 't13-2');
  const res = await service.synthesizeCandidates({
    generate: async ({ rec, sources }) => {
      if (rec.id === c1) return proposalJson('如果温度超过就关机 alpha', sources.map((s) => s.id));
      return proposalJson('备份到目录，保留 7 天 alpha', sources.map((s) => s.id));
    },
  });
  assert.equal(res.done.length, 2);
  for (const d of res.done) assert.equal(d.status, 'fail', `${d.id} 遗漏关键取值必须 fail`);
  const doc = readStore(root);
  assert.equal(doc.records.find((r) => r.id === src1.id).content, '如果温度超过 80 度就关机 alpha');
  assert.equal(doc.records.find((r) => r.id === src2.id).content, '备份到 /var/backups 目录，保留 7 天 alpha');
  for (const cid of [c1, c2]) {
    const r = await service.acceptCandidate(cid, { note: '长度合格也应拒绝', ackInconclusive: true });
    assert.equal(r.status, 'rejected');
  }
});

test('T14 模型格式错/超时/超长：保留来源；可见失败原因；不截断后采纳', async (t) => {
  const root = tempRoot(t, 't14');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const s1 = await service.add({ content: '来源一 alpha 8080', tier: 'semantic' });
  const s2 = await service.add({ content: '来源二 beta 9090', tier: 'semantic' });
  const s3 = await service.add({ content: '来源三 gamma 7070', tier: 'semantic' });
  const c1 = await pendingCandidate(service, [s1.id], 't14-1');
  const c2 = await pendingCandidate(service, [s2.id], 't14-2');
  const c3 = await pendingCandidate(service, [s3.id], 't14-3');
  const res = await service.synthesizeCandidates({
    generate: async ({ rec, sources }) => {
      if (rec.id === c1) return '这不是 JSON';
      if (rec.id === c2) throw new Error('模型超时（模拟）');
      return proposalJson('a'.repeat(5000), sources.map((s) => s.id));
    },
    limit: 20,
  });
  assert.equal(res.done.length, 0);
  assert.equal(res.failed.length, 3);
  for (const f of res.failed) assert.ok(f.reason);

  const doc = readStore(root);
  for (const id of [s1.id, s2.id, s3.id]) {
    const rec = doc.records.find((r) => r.id === id);
    assert.equal(rec.state, 'active');
    assert.equal(rec.validity, 'current');
  }
  for (const cid of [c1, c2, c3]) {
    const rec = doc.records.find((r) => r.id === cid);
    assert.equal(rec.review_status, 'candidate', '失败不等于自动采纳');
    assert.equal(rec.needs_synthesis, true, '失败后仍待重新生成');
    assert.equal(rec.proposal.proposed_text, null, '失败不得截断后写入提案正文');
    assert.ok((rec.proposal_failures || []).length >= 1, '失败原因必须可见');
  }
  assert.throws(() => parseProposalJson('```json\n{"proposed_text":"x","source_ids":[],"has_conflict":false}\n``` trailing'), /JSON|对象/);
});

test('T15 模型自报无冲突但来源有冲突：禁止形成单一正式结论', async (t) => {
  const root = tempRoot(t, 't15');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const a = await service.add({ content: '服务端口是 8080 alpha', tier: 'semantic' });
  const b = await service.add({ content: '服务端口是 9090 alpha', tier: 'semantic' });
  const opened = readStore(root).conflicts.filter((c) => c.status === 'open' || c.status === 'suspect');
  assert.ok(opened.length >= 1, '两条不同取值的正式记录应产生疑似冲突');
  assert.ok(opened.some((c) => [c.a, c.b].includes(a.id) && [c.a, c.b].includes(b.id)));
  const c = await pendingCandidate(service, [a.id, b.id], 't15');
  const res = await service.synthesizeCandidates({
    generate: async ({ sources }) => proposalJson('服务端口是 8080 或 9090 alpha', sources.map((s) => s.id), false),
  });
  assert.equal(res.done.length, 1);
  assert.equal(res.done[0].status, 'fail');
  const doc = readStore(root);
  const cand = doc.records.find((r) => r.id === c);
  assert.equal(cand.proposal.has_conflict, false);
  assert.ok(cand.proposal.validation.checks.some((x) => x.id === 'sources_conflict_free' && x.status === 'fail'));
  const accepted = await service.acceptCandidate(c, { note: '不该通过', ackInconclusive: true });
  assert.equal(accepted.status, 'rejected');
  assert.equal(doc.records.find((r) => r.id === a.id).content, '服务端口是 8080 alpha');
  assert.equal(doc.records.find((r) => r.id === b.id).content, '服务端口是 9090 alpha');
});

test('T16 生成期间来源被修正：拒绝旧候选，不覆盖新数据', async (t) => {
  const root = tempRoot(t, 't16');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const src = await service.add({ content: '旧配置端口是 8080 alpha', tier: 'semantic' });
  const cid = await pendingCandidate(service, [src.id], 't16');
  let replacement = null;
  const res = await service.synthesizeCandidates({
    generate: async ({ sources }) => {
      replacement = await service.add({
        content: '新配置端口是 9090 beta',
        tier: 'semantic',
        supersedes: [src.id],
        note: '生成期间人工修正',
      });
      assert.equal(replacement.status, 'added');
      return proposalJson('旧配置端口是 8080 alpha', sources.map((s) => s.id));
    },
  });
  assert.equal(res.done.length, 0);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].code, 'STALE_PROPOSAL');
  const doc = readStore(root);
  const old = doc.records.find((r) => r.id === src.id);
  assert.equal(old.content, '旧配置端口是 8080 alpha', '旧正文保留');
  assert.equal(old.validity, 'superseded');
  assert.equal(doc.records.find((r) => r.id === replacement.id)?.content, '新配置端口是 9090 beta');
  const cand = doc.records.find((r) => r.id === cid);
  assert.equal(cand.needs_synthesis, true, '旧候选不得写入新提案');
  assert.equal(cand.proposal.proposed_text, null);
});

test('T17 同一候选 accept 两次：一次生效，无重复正式条目', async (t) => {
  const root = tempRoot(t, 't17');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const a = await service.add({ content: 'alpha beta gamma 8080', tier: 'episodic' });
  const b = await service.add({ content: 'delta epsilon zeta 9090', tier: 'episodic' });
  const merged = await service.merge({
    ids: [a.id, b.id],
    content: 'alpha beta gamma 8080 和 delta epsilon zeta 9090',
  });
  assert.equal(merged.status, 'candidate');
  assert.equal(merged.validation.status, 'pass');
  const first = await service.acceptCandidate(merged.id, { note: '规则检查通过，人工确认合并' });
  assert.equal(first.status, 'accepted');
  const second = await service.acceptCandidate(merged.id, { note: '重复点击' });
  assert.equal(second.status, 'already_accepted');
  const doc = readStore(root);
  const mergedText = doc.records.find((r) => r.id === merged.id).content;
  const same = doc.records.filter((r) => r.content === mergedText);
  assert.equal(same.length, 1, '不能生成第二条正式记录');
  assert.equal(same[0].review_status, 'accepted');
  const accepts = doc.operations.filter((o) => o.op === 'candidate.accept' && o.target === merged.id);
  assert.equal(accepts.length, 1);
  assert.equal(doc.archive.filter((r) => [a.id, b.id].includes(r.id)).length, 2);
});

test('T18 reject、修订、重新采纳：审核链可解释，旧版本仍可追溯', async (t) => {
  const root = tempRoot(t, 't18');
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  const a = await service.add({ content: 'alpha beta 8080', tier: 'episodic' });
  const b = await service.add({ content: 'gamma delta 9090', tier: 'episodic' });

  const bad = await service.merge({ ids: [a.id, b.id], content: 'alpha beta 8080 gamma delta 9090 初版' });
  const rejected = await service.rejectCandidate(bad.id, { note: '措辞不准确' });
  assert.equal(rejected.status, 'rejected');

  const good = await service.merge({ ids: [a.id, b.id], content: 'alpha beta 8080；gamma delta 9090（修订）' });
  const accepted = await service.acceptCandidate(good.id, { note: '修订后采纳' });
  assert.equal(accepted.status, 'accepted');

  // 直接修订正文：accept 时把旧正文写进 revisions。
  const src = await service.add({ content: '发布窗口 alpha beta 8080', tier: 'semantic' });
  const cand = await service.add({
    content: '发布窗口 alpha beta 8080 旧措辞',
    tier: 'semantic',
    review_status: 'candidate',
    note: '待修订',
    proposal: {
      kind: 'synthesis',
      source_ids: [src.id],
      source_hashes: {},
      has_conflict: false,
      proposed_text: '发布窗口 alpha beta 8080 新措辞',
      validation: { status: 'inconclusive', reasons: ['pending'], checks: [] },
    },
  });
  const revised = await service.acceptCandidate(cand.id, { note: '修订措辞后采纳' });
  assert.equal(revised.status, 'accepted');
  const doc = readStore(root);
  const badRec = doc.archive.find((r) => r.id === bad.id) || doc.records.find((r) => r.id === bad.id);
  assert.equal(badRec.review_status, 'rejected');
  assert.ok(badRec.review.history.some((h) => h.action === 'reject' && h.note === '措辞不准确'));
  const goodRec = doc.records.find((r) => r.id === good.id);
  assert.ok(goodRec.review.history.some((h) => h.action === 'accept' && h.note === '修订后采纳'));
  const revisedRec = doc.records.find((r) => r.id === cand.id);
  assert.equal(revisedRec.content, '发布窗口 alpha beta 8080 新措辞');
  assert.equal(revisedRec.content_revision, 2);
  assert.equal(revisedRec.revisions.length, 1);
  assert.equal(revisedRec.revisions[0].content, '发布窗口 alpha beta 8080 旧措辞');
  assert.match(revisedRec.revisions[0].content_hash, /^[0-9a-f]{64}$/);
});
