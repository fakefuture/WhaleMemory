import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  tempRoot, initStore, readStore, serviceFor, storeFile, fileHash, patchConfig,
  spawnNode, FIXTURES, sha256Text, allFileHashes,
} from './helpers.mjs';
import { MemoryService } from '../lib/service.mjs';
import { vectorsPath } from '../lib/embed.mjs';
import { emptyCache, fingerprintOf, loadVectors, attachVectors } from '../lib/embed.mjs';
import { readSnapshot } from '../lib/repository.mjs';
import { lockPath, lockStatus, acquireLock, repairLock, lockEventLog } from '../lib/lock.mjs';

test('T23 20 个独立进程同时新增：全部保留，revision 与成功写次数对应', async (t) => {
  const root = tempRoot(t, 't23');
  initStore(root);
  const runs = [];
  for (let i = 0; i < 20; i += 1) {
    runs.push(spawnNode(path.join(FIXTURES, 'add-worker.mjs'), [root, String(i)]));
  }
  const results = await Promise.all(runs.map((r) => r.done));
  for (let i = 0; i < results.length; i += 1) {
    assert.equal(results[i].code, 0, `worker ${i} 失败：${results[i].stderr}`);
  }
  const doc = readStore(root);
  assert.equal(doc.records.length, 20, '并发写入不能丢更新');
  assert.equal(new Set(doc.records.map((r) => r.content)).size, 20);
  const adds = doc.operations.filter((o) => o.op === 'add');
  assert.equal(adds.length, 20);
  assert.equal(doc.revision, 20, 'revision 必须与成功写次数一一对应');
  assert.equal(Math.max(...doc.operations.map((o) => o.revision)), doc.revision);
});

test('T24 写进程在提交前终止：原文件完整、后续可回收锁', async (t) => {
  const root = tempRoot(t, 't24');
  initStore(root);
  const before = fileHash(storeFile(root));
  const holder = spawnNode(path.join(FIXTURES, 'hold-lock.mjs'), [root]);
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (holder.stdout.includes('LOCKED')) { clearInterval(timer); resolve(); return; }
      if (Date.now() - started > 8000) { clearInterval(timer); reject(new Error('锁进程没有启动')); }
    }, 25);
  });
  assert.equal(lockStatus(root).held, true);
  holder.child.kill('SIGKILL');
  await holder.done;
  assert.equal(fileHash(storeFile(root)), before, '被终止的写进程不能改坏主库');

  const service = serviceFor(root);
  const added = await service.add({ content: '崩溃恢复后的第一条 alpha', scope: 'workspace' });
  assert.equal(added.status, 'added');
  assert.equal(lockStatus(root).held, false);
  const events = fs.readFileSync(lockEventLog(root), 'utf8');
  assert.ok(events.includes('lock_reclaimed_stale'), '回收必须留下事件记录');
  assert.equal(readStore(root).records.length, 1);
});

test('T25 rename 持续失败：报错，原文件逐字节不变，不退回直接覆盖', async (t) => {
  const root = tempRoot(t, 't25');
  initStore(root);
  const service = serviceFor(root);
  const first = await service.add({ content: 'rename 失败前的记录 alpha', scope: 'workspace' });
  assert.equal(first.status, 'added');
  const before = fileHash(storeFile(root));

  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === storeFile(root)) {
      const err = new Error('模拟 rename 失败（EACCES）');
      err.code = 'EACCES';
      throw err;
    }
    return original(from, to);
  };
  try {
    await assert.rejects(
      () => service.add({ content: 'rename 失败时的新记录 beta', scope: 'workspace' }),
      (err) => err.code === 'WRITE_FAILED',
    );
  } finally {
    fs.renameSync = original;
  }
  assert.equal(fileHash(storeFile(root)), before, '原文件必须逐字节不变');
  const leftovers = fs.readdirSync(path.join(root, 'memory')).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '失败后不得留下临时文件');
  const after = await service.add({ content: 'rename 恢复后可写 gamma', scope: 'workspace' });
  assert.equal(after.status, 'added');
});

test('T26 主库成功、缓存失败：committed=true，旧缓存拒用，业务数据保留', async (t) => {
  const root = tempRoot(t, 't26');
  initStore(root);
  const service = serviceFor(root);
  const added = await service.add({ content: '缓存失败前的正文 alpha 8080', scope: 'workspace' });
  assert.equal(added.status, 'added');
  const fp = fingerprintOf({ provider: 'ollama', model: 'test', url: 'http://x' });
  const rec0 = readStore(root).records[0];
  const cacheOld = emptyCache(fp, 3);
  cacheOld.entries[rec0.id] = {
    record_id: rec0.id,
    content_hash: sha256Text(rec0.content),
    model_fingerprint: fp,
    dim: 3,
    vector: [1, 0, 0],
    built_at: new Date().toISOString(),
  };
  fs.writeFileSync(vectorsPath(root), `${JSON.stringify(cacheOld, null, 2)}\n`, 'utf8');

  const write = await service.write(async (tx) => {
    const rec = tx.doc.records.find((r) => r.id === rec0.id);
    rec.content = '缓存失败后的正文 beta 9090';
    rec.content_hash = sha256Text(rec.content);
    rec.updated_at = tx.context?.now || new Date().toISOString();
    tx.op({ op: 'test.edit', target: rec.id, reason: '模拟业务成功提交' });
    return { edited: rec.id };
  });
  assert.equal(write.committed, true);

  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === vectorsPath(root)) {
      const err = new Error('模拟缓存写失败（EACCES）');
      err.code = 'EACCES';
      throw err;
    }
    return original(from, to);
  };
  try {
    const cacheNew = emptyCache(fp, 3);
    cacheNew.entries[rec0.id] = {
      record_id: rec0.id,
      content_hash: sha256Text('缓存失败后的正文 beta 9090'),
      model_fingerprint: fp,
      dim: 3,
      vector: [0, 1, 0],
      built_at: new Date().toISOString(),
    };
    // 真正写缓存走原子替换；rename 持续失败时必须报错，不能退回直接覆盖。
    const { saveVectors } = await import('../lib/embed.mjs');
    assert.throws(() => saveVectors(root, cacheNew), (err) => err.code === 'WRITE_FAILED');
  } finally {
    fs.renameSync = original;
  }

  const doc = readStore(root);
  assert.equal(doc.records[0].content, '缓存失败后的正文 beta 9090', '业务数据必须保留');
  assert.equal(doc.revision, write.revision);
  const snap = readSnapshot(root);
  const attached = attachVectors(snap.doc, loadVectors(root), fp);
  assert.equal(attached.attached, 0, '旧缓存必须因正文哈希不一致被拒用');
  assert.equal(attached.reasons.content_hash_mismatch, 1);
});

test('T27 JSON 截断 / 权限错误：不按空库继续写', async (t) => {
  const root = tempRoot(t, 't27');
  initStore(root);
  await serviceFor(root).add({ content: '截断前的记录 alpha', scope: 'workspace' });
  const truncated = '{"version":2,"revision":1,"records":[';
  fs.writeFileSync(storeFile(root), truncated, 'utf8');
  const before = fileHash(storeFile(root));
  const service = serviceFor(root);
  await assert.rejects(() => service.add({ content: '不能写到空库上', scope: 'workspace' }), (err) => err.code === 'JSON_INVALID');
  assert.equal(fileHash(storeFile(root)), before, '截断的主库必须保持原样');

  // 修复文件，再模拟读取权限错误。
  initStore(root);
  const original = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === storeFile(root)) {
      const err = new Error('模拟 EACCES');
      err.code = 'EACCES';
      throw err;
    }
    return original(file, ...rest);
  };
  try {
    await assert.rejects(
      () => service.add({ content: '权限错误时不能写', scope: 'workspace' }),
      (err) => err.code === 'PERMISSION_DENIED',
    );
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(readStore(root).records.length, 0);
});

test('T28 活进程持锁且超过过期时间：不凭年龄抢锁', async (t) => {
  const root = tempRoot(t, 't28');
  initStore(root);
  const meta = {
    token: 'test-token-live',
    pid: process.pid,
    host: os.hostname(),
    created_at: '2020-01-01T00:00:00.000Z',
    purpose: 'test-live-holder',
  };
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  const st = lockStatus(root);
  assert.equal(st.held, true);
  assert.equal(st.pid_alive, true);
  assert.ok(st.age_ms > 24 * 3600 * 1000);

  await assert.rejects(
    () => acquireLock(root, { timeoutMs: 150 }),
    (err) => err.code === 'LOCK_BUSY',
  );
  const still = JSON.parse(fs.readFileSync(lockPath(root), 'utf8'));
  assert.equal(still.token, 'test-token-live', '不得根据年龄删除活进程的锁');
  assert.deepEqual(repairLock(root, { reason: '测试确认没有其他写者' }), {
    status: 'repaired',
    previous: { pid: process.pid, host: os.hostname(), created_at: meta.created_at },
    reason: '测试确认没有其他写者',
  });
  assert.equal(lockStatus(root).held, false);
});
