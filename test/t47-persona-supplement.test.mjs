// T47 人格卡补充工具：只做候选抽取与聚类，不触网、不写库。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCandidates, extractMessages, clusterBySimilarity,
} from '../tools/persona-supplement.mjs';

test('T47 补充工具：抽取风格线索、剔除任务与寒暄', () => {
  const md = [
    '## 👤 用户 · 12:00',
    '',
    '以后都用中文回答，别用英文',
    '',
    '## 👤 用户 · 12:01',
    '',
    '继续',
    '',
    '## 👤 用户 · 12:02',
    '',
    '帮我写一个脚本',
    '',
    '## 👤 用户 · 12:03',
    '',
    'Current runtime context. 这一段是噪声',
    '',
  ].join('\n');

  assert.equal(extractMessages(md).length, 4);
  const cands = extractCandidates(md);
  assert.deepEqual(cands, ['以后都用中文回答，别用英文']);
});

test('T47 补充工具：相似度聚类把同簇合并、异簇分开', () => {
  const texts = ['用中文回答', '请用中文回复', '先备份再改'];
  const sim = (a, b) => (a.includes('中文') && b.includes('中文') ? 0.9 : 0.1);
  const clusters = clusterBySimilarity(texts, sim, 0.86);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].members.length, 2);
  assert.equal(clusters[1].members[0], '先备份再改');
});
