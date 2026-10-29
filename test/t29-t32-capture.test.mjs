import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  tempRoot, initStore, readStore, runCapture, writeJsonl, userMessage,
  sha256Text, allFileHashes,
} from './helpers.mjs';

function relevant(id, text) {
  return userMessage(id, text);
}

test('T29 capture 超过单次 limit/max：后续运行接着处理，无漏项', async (t) => {
  const root = tempRoot(t, 't29');
  initStore(root);
  const file = path.join(root, 'sessions', 's1', 'archive.jsonl');
  writeJsonl(file, [
    relevant('m1', '请记住项目代号是 Falcon alpha 8080'),
    userMessage('m2', '今天天气怎么样呢'),
    relevant('m3', '以后都用 alpha 部署脚本'),
    relevant('m4', '我不喜欢 beta 的默认配置'),
    userMessage('m5', '随便聊聊最近的事情'),
    relevant('m6', '必须保留 gamma 的审计日志'),
    relevant('m7', '记住发布窗口是周五下午'),
  ]);

  const limits = [2, 2, 2];
  let totalCandidates = 0;
  for (const limit of limits) {
    const r = runCapture(root, ['--file', file, '--session', 'S1', '--limit', String(limit), '--max', '2', '--quiet']);
    assert.equal(r.status, 0, r.stderr);
    totalCandidates = readStore(root).records.filter((x) => x.review_status === 'candidate').length;
  }
  assert.equal(totalCandidates, 5, '三条运行后所有相关消息都应成为候选');
  const doc = readStore(root);
  const cursor = doc.captures.cursors['session:S1'];
  assert.equal(cursor.processed, 7, '游标推进到实际扫描完成的位置');
  assert.equal(cursor.users_total, 7);
  assert.equal(cursor.pending, 0);
  const messages = doc.evidence.filter((e) => e.kind === 'message');
  assert.equal(messages.length, 5, '无关消息不建证据');
});

test('T30 capture 提交后进程终止并重跑：无重复证据/候选，无跳过', async (t) => {
  const root = tempRoot(t, 't30');
  initStore(root);
  const file = path.join(root, 'sessions', 'terminal', 'archive.jsonl');
  const texts = [
    '请记住终端会话代号是 Terminal alpha',
    '以后都使用 beta 终端脚本',
    '必须保留 gamma 终端日志',
  ];
  const messages = texts.map((text, i) => {
    const id = `tm${i + 1}`;
    return {
      role: 'user',
      text,
      message_id: id,
      key: `msg|${id}|${sha256Text(text).slice(0, 16)}`,
      tier: 'episodic',
      capture: true,
      evidence: true,
    };
  });
  writeJsonl(file, texts.map((text, i) => userMessage(`tm${i + 1}`, text)));
  const keys = messages.map((m) => m.key);
  const messagesFile = path.join(root, 'messages.json');
  const keysFile = path.join(root, 'keys.json');
  fs.writeFileSync(messagesFile, JSON.stringify(messages), 'utf8');
  fs.writeFileSync(keysFile, JSON.stringify(keys), 'utf8');

  const { spawnNode, FIXTURES } = await import('./helpers.mjs');
  const worker = spawnNode(path.join(FIXTURES, 'ingest-once.mjs'), [
    root, 'session:terminal', messagesFile, keysFile,
  ]);
  const done = await worker.done;
  assert.equal(done.code, 0, done.stderr);
  const afterCommit = readStore(root);
  assert.equal(afterCommit.records.length, 3);
  assert.equal(afterCommit.captures.cursors['session:terminal'].processed, 3);
  const revision = afterCommit.revision;

  const rerun = runCapture(root, ['--file', file, '--session', 'terminal', '--quiet']);
  assert.equal(rerun.status, 0, rerun.stderr);
  const afterRerun = readStore(root);
  assert.equal(afterRerun.records.length, 3, '重跑不得产生重复候选');
  assert.equal(afterRerun.evidence.length, 3, '重跑不得产生重复证据');
  assert.equal(afterRerun.revision, revision, '没有新消息就不该写库');

  writeJsonl(file, [
    ...texts.map((text, i) => userMessage(`tm${i + 1}`, text)),
    userMessage('tm4', '记住追加的 delta 终端规则'),
  ]);
  const appended = runCapture(root, ['--file', file, '--session', 'terminal', '--quiet']);
  assert.equal(appended.status, 0, appended.stderr);
  const afterAppend = readStore(root);
  assert.equal(afterAppend.records.length, 4, '追加消息必须被处理，之前的不能重复');
  assert.ok(afterAppend.records.some((r) => r.content.includes('delta')));
});

test('T31 capture 文件重写/截断：检测变化，稳定键防重复', async (t) => {
  const root = tempRoot(t, 't31');
  initStore(root);
  const file = path.join(root, 'sessions', 'rw', 'archive.jsonl');
  writeJsonl(file, [
    userMessage('m1', '请记住重写测试第一句 alpha'),
    userMessage('m2', '以后都用 beta 方案'),
  ]);
  assert.equal(runCapture(root, ['--file', file, '--session', 'RW', '--quiet']).status, 0);
  assert.equal(readStore(root).records.filter((r) => r.review_status === 'candidate').length, 2);

  // 同一 id 的正文被改写：稳定键里的正文摘要变化，前缀哈希应发现重写。
  writeJsonl(file, [
    userMessage('m1', '请记住重写测试第一句 alpha'),
    userMessage('m2', '以后都用 gamma 方案（已改写）'),
    userMessage('m3', '必须新增 delta 审计规则'),
  ]);
  const second = runCapture(root, ['--file', file, '--session', 'RW', '--quiet']);
  assert.equal(second.status, 0, second.stderr);
  const doc = readStore(root);
  const cursor = doc.captures.cursors['session:RW'];
  assert.ok(cursor.rewrite_detected_at, '重写必须被记录');
  assert.equal(cursor.processed, 3);
  const contents = doc.records.filter((r) => r.review_status === 'candidate').map((r) => r.content);
  assert.equal(contents.filter((c) => c.includes('第一句')).length, 1, '未变消息不重复生成候选');
  assert.equal(contents.filter((c) => c.includes('beta 方案')).length, 1);
  assert.equal(contents.filter((c) => c.includes('gamma 方案')).length, 1);
  assert.equal(contents.filter((c) => c.includes('delta')).length, 1);

  // 截断：只剩 m1，游标不能继续声称处理过 3 条。
  writeJsonl(file, [userMessage('m1', '请记住重写测试第一句 alpha')]);
  assert.equal(runCapture(root, ['--file', file, '--session', 'RW', '--quiet']).status, 0);
  const afterTruncate = readStore(root);
  assert.equal(afterTruncate.captures.cursors['session:RW'].processed, 1);
  assert.ok(afterTruncate.captures.cursors['session:RW'].rewrite_detected_at);
});

test('T32 capture --dry-run：所有数据文件、游标和缓存无变化', async (t) => {
  const root = tempRoot(t, 't32');
  initStore(root);
  const file = path.join(root, 'sessions', 'dry', 'archive.jsonl');
  writeJsonl(file, [
    userMessage('d1', '请记住 dry-run 不应写入 alpha'),
    userMessage('d2', '以后都用 beta 方案'),
  ]);
  const before = allFileHashes(root);
  const r = runCapture(root, ['--file', file, '--session', 'DRY', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run/);
  const after = allFileHashes(root);
  assert.deepEqual(after, before, 'dry-run 不得改主库、游标、向量或日志');
  assert.equal(fs.existsSync(path.join(root, 'memory', 'capture-state.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'memory', 'embeddings.json')), false);
  assert.equal(readStore(root).records.length, 0);
});
