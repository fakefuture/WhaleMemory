import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  tempRoot, initStore, readStore, serviceFor, storeFile, fileHash, sha256Text,
} from './helpers.mjs';
import {
  migrate as repoMigrate, listSnapshots, verifySnapshot, createSnapshot, restoreSnapshot, storePath,
} from '../lib/repository.mjs';

function v1Store(extra = {}) {
  return {
    version: 1,
    created_at: '2025-01-02T03:04:05.000Z',
    updated_at: '2025-06-01T00:00:00.000Z',
    config: { admission: { min_content_length: 2, max_content_length: 1234 } },
    records: [
      {
        id: 'r1', content: '迁移中文记录：项目代号是 Falcon', tier: 'semantic', scope: 'workspace',
        confidence: 0.9, strength: 0.8, created_at: '2025-02-01T00:00:00.000Z', needs_synthesis: false,
      },
      {
        id: 'r2', content: '待合成：以后都用 alpha 脚本', tier: 'episodic', scope: 'workspace',
        confidence: 0.5, strength: 0.4, created_at: '2025-03-01T00:00:00.000Z', needs_synthesis: true,
      },
      {
        id: 'r3', content: '已降权的旧结论：端口是 8080', tier: 'semantic', scope: 'workspace',
        confidence: 0.7, strength: 0.3, created_at: '2025-04-01T00:00:00.000Z', demoted: true,
      },
      {
        id: 'r4', content: '会话记录但缺少会话 id', tier: 'episodic', scope: 'session',
        confidence: 0.6, strength: 0.5, created_at: '2025-05-01T00:00:00.000Z', meta: { session: 'default' },
      },
    ],
    archive: [],
    conflicts: [{ id: 'cfl_old', a: 'r1', b: 'r2', reason: 'legacy_conflict', status: 'open' }],
    persona: {
      card: { text: '旧人格卡：说话简洁，先给命令。', updated_at: '2025-05-05T00:00:00.000Z', note: '手工' },
      traits: { 'style.verbosity': { kind: 'numeric', value: 0.3, observations: 4 } },
      versions: [{ at: '2025-05-05T00:00:00.000Z', card: '更早的卡片' }],
      observations: 7,
    },
    impression: { items: [{ id: 'imp1', text: '偏好中文', weight: 0.8 }] },
    sessions: { count: 3, last_end: '2025-05-06T00:00:00.000Z' },
    log: [{ at: '2025-01-01T00:00:00.000Z', action: 'old-log-entry' }],
    ...extra,
  };
}

function writeV1(root, doc = v1Store()) {
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(storePath(root), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

test('T33 v1 迁移含中文/冲突/卡片历史：字段保留，来源缺失标 unknown', async (t) => {
  const root = tempRoot(t, 't33');
  writeV1(root);
  const res = await repoMigrate(root);
  assert.equal(res.status, 'applied');
  assert.ok(res.backup && res.backup.verified);
  assert.equal(verifySnapshot(res.backup.dir).ok, true);

  const doc = readStore(root);
  assert.equal(doc.version, 2);
  assert.equal(doc.records.length, 4);
  const get = (id) => doc.records.find((r) => r.id === id);
  assert.equal(get('r1').content, '迁移中文记录：项目代号是 Falcon');
  assert.equal(get('r1').review_status, 'accepted');
  assert.equal(get('r2').review_status, 'candidate');
  assert.equal(get('r2').needs_synthesis, true);
  assert.equal(get('r3').validity, 'superseded');
  assert.equal(get('r4').scope, 'session');
  assert.equal(get('r4').namespace.session_id, 'legacy_unknown');
  assert.equal(get('r4').legacy_unknown_session, true);
  for (const r of doc.records) {
    assert.deepEqual(r.time, { occurred_at: null, valid_from: null, valid_to: null }, '迁移不得伪造时间');
    assert.equal(r.evidence_ids.length, 1);
    const ev = doc.evidence.find((e) => e.id === r.evidence_ids[0]);
    assert.equal(ev.kind, 'legacy_record');
    assert.equal(ev.actor, 'unknown');
    assert.equal(ev.text, r.content);
  }
  assert.equal(doc.persona.card.text, '旧人格卡：说话简洁，先给命令。');
  assert.equal(doc.persona.legacy, true);
  assert.equal(doc.persona.versions.length, 1);
  assert.equal(doc.persona.traits['style.verbosity'].value, 0.3);
  assert.equal(doc.impression.items[0].text, '偏好中文');
  assert.equal(doc.config.admission.max_content_length, 1234);
  assert.equal(doc.log[0].action, 'old-log-entry');
  assert.equal(doc.conflicts[0].legacy_ambiguity, true);
  assert.equal(doc.migrations[0].report.evidence_created, 4);
});

test('T34 迁移失败与重复迁移：旧文件不损坏，重复无新增', async (t) => {
  const root = tempRoot(t, 't34');
  writeV1(root);
  const before = fileHash(storeFile(root));

  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === storePath(root)) {
      const err = new Error('模拟迁移写失败');
      err.code = 'EACCES';
      throw err;
    }
    return original(from, to);
  };
  try {
    await assert.rejects(() => repoMigrate(root), (err) => err.code === 'WRITE_FAILED');
  } finally {
    fs.renameSync = original;
  }
  assert.equal(fileHash(storeFile(root)), before, '失败后旧文件必须逐字节不变');
  assert.equal(JSON.parse(fs.readFileSync(storeFile(root), 'utf8')).version, 1);
  const snaps = listSnapshots(root);
  assert.ok(snaps.length >= 1, '失败前应留下可校验的备份');
  assert.equal(verifySnapshot(snaps[0].dir).ok, true);

  const applied = await repoMigrate(root);
  assert.equal(applied.status, 'applied');
  const afterFirst = fileHash(storeFile(root));
  const records = readStore(root).records.length;
  const again = await repoMigrate(root);
  assert.equal(again.status, 'noop');
  assert.equal(fileHash(storeFile(root)), afterFirst);
  assert.equal(readStore(root).records.length, records, '重复迁移不得新增记录');
  assert.equal(readStore(root).migrations.length, 1);
});

test('T35 从备份恢复：数据哈希符合迁移前快照', async (t) => {
  const root = tempRoot(t, 't35');
  initStore(root);
  const service = serviceFor(root);
  await service.add({ content: '备份前的记录 alpha', scope: 'workspace' });
  await service.add({ content: '备份前的记录 beta', scope: 'workspace' });
  const snap = createSnapshot(root, { label: 't35' });
  const hashAtSnapshot = fileHash(storeFile(root));
  const manifestHash = JSON.parse(fs.readFileSync(path.join(snap.dir, 'manifest.json'), 'utf8')).files['memory/store.json'].sha256;
  assert.equal(hashAtSnapshot, manifestHash);

  await service.add({ content: '备份后的记录 gamma', scope: 'workspace' });
  assert.notEqual(fileHash(storeFile(root)), hashAtSnapshot);

  const restored = tempRoot(t, 't35-restore');
  const res = restoreSnapshot({ from: snap.dir, to: restored });
  assert.equal(res.status, 'restored');
  assert.equal(fileHash(path.join(restored, 'memory', 'store.json')), hashAtSnapshot);
  const doc = readStore(restored);
  assert.equal(doc.records.length, 2);
  assert.ok(doc.records.every((r) => !r.content.includes('gamma')));

  fs.mkdirSync(path.join(restored, 'extra'), { recursive: true });
  fs.writeFileSync(path.join(restored, 'extra', 'keep.txt'), 'x', 'utf8');
  assert.throws(() => restoreSnapshot({ from: snap.dir, to: restored }), (err) => err.code === 'RESTORE_FAILED');
  assert.equal(restoreSnapshot({ from: snap.dir, to: restored, force: true }).status, 'restored');
});
