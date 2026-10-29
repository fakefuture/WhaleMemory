import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { apply, renderInjectedFile, renderFor } from '../lib/index.js';
import { syncRender } from '../../sync-render.mjs';
import { emptyStore } from '../../../lib/schema.mjs';
import { writeStore, readSnapshot } from '../../../lib/repository.mjs';
import { MemoryService } from '../../../lib/service.mjs';
import { renderInjected, renderPersonaCard, emotionSnapshot } from '../../../lib/render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const repoRoot = path.resolve(pluginDir, '..', '..');

let pass = 0;
function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    console.log(`  FAIL  ${label}\n        ${err.message}`);
    process.exitCode = 1;
  }
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function stubCtx(order = 10200) {
  const captured = { section: null };
  const ctx = {
    effect(fn) { return fn(); },
    systemPrompt: {
      getSectionOrder: () => order,
      section(cfg) { captured.section = cfg; return () => {}; },
    },
  };
  return { ctx, captured };
}

const synced = syncRender({ srcDir: pluginDir, repoRoot });
assert.equal(sha(synced.dest), sha(path.join(repoRoot, 'lib', 'render.mjs')), '插件内置渲染模块必须与仓库逐字节一致');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psm-plugin-'));
const prevEnv = process.env.DSH_SESSION_ID;
delete process.env.DSH_SESSION_ID;

try {
  writeStore(root, emptyStore({ workspaceId: 'ws_plugin' }));
  const svc = new MemoryService({ root, context: { workspaceId: 'ws_plugin', sessionId: 's1' } });
  await svc.add({ content: '用户要求所有回复先给结论', tier: 'semantic', domain: 'preference' });
  await svc.add({ content: '会话内私密：喜欢单引号', tier: 'semantic', scope: 'session' });
  await svc.write(async (tx, ctx) => {
    tx.doc.persona.card = { text: '你是务实的助手。', updated_at: ctx.now, note: null };
    tx.doc.persona.traits['style.verbosity'] = { kind: 'numeric', value: 0.3, observations: 2 };
    tx.doc.impression.items.push({ id: 'imp_1', text: '用户在 Windows 上使用 Git Bash', weight: 0.8, note: null, at: ctx.now });
    tx.op({ op: 'smoke.setup' });
  }, { context: { workspaceId: 'ws_plugin', sessionId: 's1' } });

  const now = '2026-10-01T12:00:00.000Z';
  const store = readSnapshot(root).doc;
  const context = { ownerId: 'local', workspaceId: 'ws_plugin', sessionId: null };

  check('同一快照/上下文/now 下插件与 lib/render 逐字一致', () => {
    const cli = renderInjected({ store, context, now, mood: null, scales: {}, priorities: {} });
    const plugin = renderInjectedFile(root, { sessionId: null, now, mood: null });
    assert.ok(plugin.includes('[自我]'));
    assert.ok(plugin.includes('[关于用户]'));
    assert.equal(plugin, cli.text);
  });

  check('没有会话上下文：不注入任何会话记忆与情绪', () => {
    const plugin = renderInjectedFile(root, { sessionId: null, now, mood: null });
    assert.ok(!plugin.includes('单引号'), 'session scope 记忆不得泄露到无会话上下文');
    assert.ok(!plugin.includes('观察到的用户情绪'));
  });

  check('有会话 id：读到该会话自己的情绪行', () => {
    fs.writeFileSync(path.join(root, 'emotion-states.json'), JSON.stringify({
      active: 'other',
      sessions: {
        s1: { emotion: '紧绷', score: 0.8, at: now, axes: { valence: -0.5, arousal: 0.6 }, subject: 'user_observed' },
        other: { emotion: '满意', score: 0.9, at: now },
      },
    }), 'utf8');
    const expectedMood = emotionSnapshot({
      state: { emotion: '紧绷', score: 0.8, at: now, axes: { valence: -0.5, arousal: 0.6 }, subject: 'user_observed' },
      rules: {}, now: Date.parse(now),
    }).line;
    const cli = renderInjected({ store, context: { ...context, sessionId: 's1' }, now, mood: expectedMood, scales: {}, priorities: {} });
    const plugin = renderInjectedFile(root, { sessionId: 's1', now, mood: undefined });
    assert.ok(plugin.includes('【观察到的用户情绪】'));
    assert.ok(!plugin.includes('满意'), '不能借用其他会话的情绪');
    assert.equal(plugin, cli.text);
  });

  check('apply 注册一个 section，text() 可重复读取', () => {
    const { ctx, captured } = stubCtx(10200);
    process.env.DSH_SESSION_ID = 's1';
    try {
      apply(ctx, { root, cache_ms: 0 });
      assert.ok(captured.section);
      assert.equal(captured.section.name, 'psm:persona-card');
      assert.equal(captured.section.order, 10201);
      assert.equal(captured.section.interpolate, false);
      assert.equal(typeof captured.section.text, 'function');
      assert.ok(captured.section.text().includes('[自我]'));
    } finally {
      delete process.env.DSH_SESSION_ID;
    }
  });

  check('库不存在 / store.json 损坏时返回空串，不抛错', () => {
    assert.equal(renderInjectedFile(path.join(root, 'no-such')), '');
    const broken = path.join(root, 'broken');
    fs.mkdirSync(path.join(broken, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'memory', 'store.json'), '{oops', 'utf8');
    assert.equal(renderInjectedFile(broken), '');
  });

  check('预算裁剪与 CLI 同一套规则（超预算丢特质、截断正文）', () => {
    const fake = {
      config: { persona: { token_budget: 30 } },
      persona: {
        card: { text: '这是一段很长的人格卡片正文，用来触发预算裁剪。'.repeat(4) },
        traits: {
          'a.b': { kind: 'numeric', value: 0.7, observations: 5 },
          'c.d': { kind: 'numeric', value: 0.3, observations: 2 },
        },
      },
    };
    const out = renderPersonaCard({ persona: fake.persona, config: fake.config, scales: {}, priorities: {} });
    assert.ok(!out.text.includes('a.b') || !out.text.includes('c.d'));
    assert.ok(out.text.includes('…'));
  });

  console.log(`\n结果：${pass} 通过，${process.exitCode ? 1 : 0} 失败`);
} finally {
  if (prevEnv === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = prevEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
