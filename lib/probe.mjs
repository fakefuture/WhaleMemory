// lib/probe.mjs — 人格探针：固定问题 + 确定性判据，用分数对比"改卡前/后"。
//
// 为什么不用模型打分：那会把"人格是否生效"变成又一次模型判断，不可复现。
// 判据只有三件事：必须出现的关键词、禁止出现的话术、长度区间。

import crypto from 'node:crypto';
import path from 'node:path';
import { readJson } from './util.mjs';

export function probesPath(root) {
  return path.join(String(root), 'docs', 'persona-probes.json');
}

export function loadProbes(root) {
  const doc = readJson(probesPath(root), null);
  return (doc && Array.isArray(doc.probes) ? doc.probes : []);
}

// 人格指纹：卡片正文 + 特质的稳定哈希。同一指纹下的分数才可比。
export function personaFingerprint(store) {
  const p = (store && store.persona) || {};
  const card = String((p.card && p.card.text) || '');
  const traits = Object.keys(p.traits || {}).sort().map((k) => {
    const t = p.traits[k] || {};
    return [k, t.kind, t.value ?? null, t.distribution ?? null].join(':');
  });
  const body = JSON.stringify({ card, traits });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

// 单条探针判定：返回 {pass, reasons[]}
export function scoreProbe(probe, answer) {
  const text = String(answer ?? '').trim();
  const reasons = [];
  if (!text) return { pass: false, reasons: ['空回答'] };
  for (const kw of probe.must || []) {
    if (!text.includes(kw)) reasons.push(`缺少「${kw}」`);
  }
  for (const kw of probe.must_not || []) {
    if (text.includes(kw)) reasons.push(`出现了禁止话术「${kw}」`);
  }
  const len = [...text].length;
  if (probe.min_chars && len < probe.min_chars) reasons.push(`太短（${len} < ${probe.min_chars}）`);
  if (probe.max_chars && len > probe.max_chars) reasons.push(`太长（${len} > ${probe.max_chars}）`);
  return { pass: reasons.length === 0, reasons, chars: len };
}

// answers: { p1: "...", p2: "..." }
export function scoreRun(probes, answers) {
  const details = probes.map((p) => {
    const r = scoreProbe(p, answers[p.id]);
    return { id: p.id, pass: r.pass, reasons: r.reasons, chars: r.chars ?? 0 };
  });
  const passed = details.filter((d) => d.pass).length;
  return { score: probes.length ? Math.round((passed / probes.length) * 1000) / 1000 : 0, passed, total: probes.length, details };
}

export function runsPath(root) {
  return path.join(String(root), 'memory', 'probe-runs.json');
}

export function loadRuns(root) {
  const doc = readJson(runsPath(root), null);
  return (doc && Array.isArray(doc.runs) ? doc.runs : []);
}
