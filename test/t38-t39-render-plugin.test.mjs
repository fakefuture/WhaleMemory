import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  tempRoot, initStore, readStore, serviceFor, runPsmJson, REPO, sha256Text,
} from './helpers.mjs';
import { readSnapshot } from '../lib/repository.mjs';
import { resolveContext } from '../lib/policy.mjs';
import { renderInjected } from '../lib/render.mjs';
import { fileHash } from './helpers.mjs';

const PLUGIN_DIR = path.join(REPO, 'plugin', 'dsh-persona-bridge');
const FIXED_NOW = '2026-10-28T12:00:00.000Z';

async function seedRenderStore(root) {
  initStore(root);
  const service = serviceFor(root, { sessionId: null });
  await service.add({ content: '渲染测试的工作区记录 alpha', scope: 'workspace' });
  await service.add({ content: '渲染测试的会话记录 secret', scope: 'session' }).catch(() => null);
  await service.write(async (tx) => {
    tx.doc.persona.card = { text: '你是 PSM 测试助手，先给结论。', updated_at: FIXED_NOW, note: 'test' };
    tx.doc.persona.traits = {
      'style.tone': { kind: 'distribution', distribution: { 直接: 3, 温和: 1 }, observations: 4 },
    };
    tx.doc.impression.items = [{ id: 'imp_r', text: '用户偏好中文和命令行', weight: 0.9 }];
    tx.op({ op: 'test.seed', target: null });
  }, { context: { sessionId: null } });
}

test('T38 相同快照、上下文与固定 now：CLI 与插件逐字一致', async (t) => {
  const root = tempRoot(t, 't38');
  await seedRenderStore(root);

  const cli = runPsmJson(root, ['context']);
  const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);
  const viaPlugin = plugin.renderInjectedFile(root, { sessionId: null, now: FIXED_NOW, mood: null });

  const snap = readSnapshot(root);
  const ctx = resolveContext(snap.doc, { sessionId: null });
  const viaLib = renderInjected({ store: snap.doc, context: ctx, now: FIXED_NOW, mood: null });
  assert.equal(viaPlugin, viaLib.text, '插件必须复用同一纯渲染实现');
  assert.equal(cli.text, viaLib.text, 'CLI prepareContext 与插件必须逐字一致');
  assert.ok(cli.text.includes('你是 PSM 测试助手'));
  assert.ok(cli.text.includes('用户偏好中文和命令行'));
  assert.ok(!cli.text.includes('secret'), '没有会话上下文时不能带入 session 记录');
});

test('T39 插件在独立临时安装目录：可正常加载，无开发机绝对路径依赖', async (t) => {
  const profile = tempRoot(t, 't39');
  const dst = path.join(profile, 'node_modules', 'dsh-persona-bridge');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(PLUGIN_DIR, dst, { recursive: true });

  const libDir = path.join(dst, 'lib');
  for (const file of ['index.js', 'render.mjs']) {
    const body = fs.readFileSync(path.join(libDir, file), 'utf8');
    assert.ok(!body.includes('C:\\Users\\') && !body.includes('/Users/'), `${file} 不得硬编码开发机路径`);
    assert.ok(!body.includes(REPO), `${file} 不得引用仓库绝对路径`);
  }
  assert.equal(
    fileHash(path.join(libDir, 'render.mjs')),
    fileHash(path.join(REPO, 'lib', 'render.mjs')),
    '安装包内的渲染实现必须与仓库逐字节一致',
  );

  const root = tempRoot(t, 't39-store');
  await seedRenderStore(root);
  const plugin = await import(`${pathToFileURL(path.join(libDir, 'index.js')).href}?isolated=1`);
  const text = plugin.renderInjectedFile(root, { sessionId: null, now: FIXED_NOW, mood: null });
  assert.ok(text.includes('你是 PSM 测试助手'));
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['systemPrompt']);
});
