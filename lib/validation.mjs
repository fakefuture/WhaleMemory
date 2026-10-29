// lib/validation.mjs — 合成候选的确定性校验。
//
// 通过只能叫「规则检查通过」，不能叫「事实已验证」。数值守卫通过不代表中文语义无失真；
// 无法判断时返回 inconclusive，保留原条目，由显式 ack + 理由决定是否采纳。

import { salientTokens, hasNegationCue } from './util.mjs';

export const CHECK = {
  STRUCTURE: 'structure',
  SOURCE_SUBSET: 'source_ids_subset',
  SOURCE_VISIBLE: 'source_visible',
  SOURCE_HASH: 'source_hash_unchanged',
  NEW_VALUE: 'no_new_or_changed_values',
  KEY_VALUE: 'key_values_preserved',
  NEGATION: 'negation_not_flipped',
  CONDITION: 'conditions_preserved',
  SOURCE_CONFLICT: 'sources_conflict_free',
  SELF_REPORTED_CONFLICT: 'model_reported_conflict',
  INSTRUCTION: 'instructions_treated_as_data',
};

const ALLOWED_FIELDS = new Set(['proposed_text', 'source_ids', 'has_conflict']);

const CONDITION_CUES = [
  '如果', '若', '除非', '只有', '仅当', '前提', '条件', '在…时', '当…时', '之前', '之后',
  'if ', 'unless', 'when ', 'only if', 'provided',
];

const INJECTION_CUES = [
  '忽略规则', '忽略之前', '忽略以上', '无视规则', '系统提示', '你现在是', '从现在起你必须',
  'ignore previous', 'ignore all previous', 'disregard', 'system prompt', 'you must now',
  '执行以下命令', 'run the following',
];

export class ValidationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_FAILED';
    this.detail = detail;
  }
}

function check(id, status, detail) {
  return { id, status, detail: detail || null };
}

// 严格 JSON：允许整体被 ``` 围栏包住；不允许解释文字、数组、标量或额外字段。
// 超长直接拒绝，绝不截断后通过。
export function parseProposalJson(raw, { maxChars = 2000 } = {}) {
  if (typeof raw !== 'string') throw new ValidationError('模型输出不是字符串');
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  if (text.length > Math.max(maxChars * 8, 4000)) {
    throw new ValidationError(`模型输出过长（${text.length} 字符），拒绝解析`, { length: text.length });
  }
  if (!text.startsWith('{') || !text.endsWith('}')) {
    throw new ValidationError('模型输出必须是单个 JSON 对象（不得有解释文字）');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`模型输出不是合法 JSON：${err.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ValidationError('模型输出必须是 JSON 对象');
  }
  const extra = Object.keys(obj).filter((k) => !ALLOWED_FIELDS.has(k));
  if (extra.length) {
    throw new ValidationError(`模型输出包含不允许的字段：${extra.join(', ')}`, { extra });
  }
  return obj;
}

function normalizeProposalText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean).join(' ').trim();
}

export function salientValues(text) {
  const out = new Set(salientTokens(text));
  const s = String(text ?? '').toLowerCase();
  // 路径（含 Windows 盘符与 posix）与版本号：词面守卫必须看到它们。
  for (const m of s.matchAll(/[a-z]:\\[^\s，。；、"'）)]+/g)) out.add(`path:${m[0]}`);
  for (const m of s.matchAll(/(?:^|[\s(（])((?:\/|\.\.?\/)[^\s，。；、"'）)]+)/g)) out.add(`path:${m[1]}`);
  for (const m of s.matchAll(/\bv?\d+\.\d+(?:\.\d+)*\b/g)) out.add(`ver:${m[0]}`);
  for (const m of s.matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g)) out.add(`time:${m[0]}`);
  for (const m of s.matchAll(/\b\d+(?:\.\d+)?\s*(?:%|ms|s|m|h|kb|mb|gb|tb|px|天|小时|分钟|秒)\b/g)) out.add(`qty:${m[0].replace(/\s+/g, '')}`);
  return out;
}

function missingValues(sourceText, outputText) {
  const src = salientValues(sourceText);
  const out = salientValues(outputText);
  return [...src].filter((t) => !out.has(t));
}

function extraValues(sourcesText, outputText) {
  const out = salientValues(outputText);
  const union = new Set();
  for (const t of sourcesText) for (const v of salientValues(t)) union.add(v);
  return [...out].filter((t) => !union.has(t));
}

function hasCondition(text) {
  const s = String(text ?? '').toLowerCase();
  return CONDITION_CUES.some((c) => s.includes(c));
}

export function containsInstructionText(text) {
  const s = String(text ?? '').toLowerCase();
  return INJECTION_CUES.some((c) => s.includes(c.toLowerCase()));
}

/**
 * @param {object} input
 * @param {object} input.proposal        已解析的 { proposed_text, source_ids, has_conflict }
 * @param {Array}  input.sources         当前来源记录（含 content/content_hash/namespace/scope）
 * @param {Set|Array} input.allowedIds   本次允许引用的来源 id
 * @param {object} input.sourceHashes    生成时记录的 id→hash
 * @param {Set}   [input.visibleIds]     当前上下文可见的来源 id（缺省不检查额外可见性）
 * @param {number}[input.maxChars]
 * @param {boolean}[input.sourcesHaveConflict] 来源之间存在未决冲突
 */
export function validateProposal(input = {}) {
  const checks = [];
  const proposal = input.proposal || {};
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const allowedIds = new Set(input.allowedIds ? [...input.allowedIds] : sources.map((s) => s.id));
  const hashes = input.sourceHashes || {};
  const maxChars = Math.max(1, Number(input.maxChars) || 300);
  const text = normalizeProposalText(proposal.proposed_text);

  // 1. 结构、类型、长度
  if (!text) {
    checks.push(check(CHECK.STRUCTURE, 'fail', 'proposed_text 为空'));
  } else if (text.length > maxChars) {
    checks.push(check(CHECK.STRUCTURE, 'fail', `proposed_text 超长（${text.length} > ${maxChars}），拒绝截断后采纳`));
  } else if (typeof proposal.has_conflict !== 'boolean') {
    checks.push(check(CHECK.STRUCTURE, 'fail', 'has_conflict 必须是布尔值'));
  } else {
    checks.push(check(CHECK.STRUCTURE, 'pass', `${text.length} 字符`));
  }

  // 2. source_ids 非空且是允许集合的子集
  const ids = Array.isArray(proposal.source_ids) ? proposal.source_ids : [];
  const uniqueIds = [...new Set(ids.filter((x) => typeof x === 'string' && x))];
  if (!uniqueIds.length) {
    checks.push(check(CHECK.SOURCE_SUBSET, 'fail', 'source_ids 为空'));
  } else if (uniqueIds.length !== ids.length) {
    checks.push(check(CHECK.SOURCE_SUBSET, 'fail', 'source_ids 含重复或非字符串项'));
  } else if (uniqueIds.some((id) => !allowedIds.has(id))) {
    checks.push(check(CHECK.SOURCE_SUBSET, 'fail', `source_ids 含未允许的来源：${uniqueIds.filter((id) => !allowedIds.has(id)).join(', ')}`));
  } else {
    checks.push(check(CHECK.SOURCE_SUBSET, 'pass', `${uniqueIds.length} 个来源`));
  }

  // 3. 引用可见且仍存在
  const byId = new Map(sources.map((s) => [s.id, s]));
  const missing = uniqueIds.filter((id) => !byId.has(id));
  if (missing.length) {
    checks.push(check(CHECK.SOURCE_VISIBLE, 'fail', `来源不存在或不可见：${missing.join(', ')}`));
  } else if (input.visibleIds) {
    const vis = new Set(input.visibleIds);
    const hidden = uniqueIds.filter((id) => !vis.has(id));
    checks.push(check(CHECK.SOURCE_VISIBLE, hidden.length ? 'fail' : 'pass', hidden.length ? `来源不可见：${hidden.join(', ')}` : null));
  } else {
    checks.push(check(CHECK.SOURCE_VISIBLE, 'pass', null));
  }

  // 4. 来源哈希仍与生成时相同
  const changed = [];
  for (const id of uniqueIds) {
    const rec = byId.get(id);
    if (!rec) continue;
    const expected = hashes[id];
    if (expected && rec.content_hash !== expected) changed.push(id);
  }
  checks.push(check(CHECK.SOURCE_HASH, changed.length ? 'fail' : 'pass',
    changed.length ? `来源在生成后被修改：${changed.join(', ')}，请重新生成` : null));

  const sourceTexts = uniqueIds.map((id) => byId.get(id)).filter(Boolean).map((r) => r.content);

  if (text) {
    // 5. 新增/改变的关键取值
    const added = extraValues(sourceTexts, text);
    checks.push(check(CHECK.NEW_VALUE, added.length ? 'fail' : 'pass',
      added.length ? `出现来源中没有的关键取值：${added.join(', ')}` : null));

    // 6. 关键取值遗漏
    const missingVals = [];
    for (const src of sourceTexts) for (const v of missingValues(src, text)) if (!missingVals.includes(v)) missingVals.push(v);
    checks.push(check(CHECK.KEY_VALUE, missingVals.length ? 'fail' : 'pass',
      missingVals.length ? `遗漏来源关键取值：${missingVals.join(', ')}` : null));

    // 7. 否定反转
    const outNeg = hasNegationCue(text);
    const srcNeg = sourceTexts.map(hasNegationCue);
    const flip = srcNeg.length ? (outNeg !== srcNeg.some(Boolean)) : false;
    checks.push(check(CHECK.NEGATION, flip ? 'fail' : 'pass',
      flip ? `否定极性被反转（来源${srcNeg.some(Boolean) ? '含' : '不含'}否定，输出${outNeg ? '含' : '不含'}）` : null));

    // 8. 条件遗漏：来源有明确条件，输出没有 → inconclusive（不能确定语义是否仍成立）
    const srcCond = sourceTexts.some(hasCondition);
    if (srcCond && !hasCondition(text)) {
      checks.push(check(CHECK.CONDITION, 'inconclusive', '来源含明确条件，输出未见条件；无法确定是否仍等价'));
    } else {
      checks.push(check(CHECK.CONDITION, 'pass', null));
    }
  }

  // 9. 来源包含未决冲突 → 禁止采纳为单一结论
  checks.push(check(CHECK.SOURCE_CONFLICT, input.sourcesHaveConflict ? 'fail' : 'pass',
    input.sourcesHaveConflict ? '来源之间存在未决冲突，不能采纳为单一结论' : null));

  // 10. 模型自报冲突只会更谨慎
  if (proposal.has_conflict === true) {
    checks.push(check(CHECK.SELF_REPORTED_CONFLICT, 'fail', '模型自报存在冲突；需先解决来源冲突'));
  } else {
    checks.push(check(CHECK.SELF_REPORTED_CONFLICT, 'pass', '模型自报无冲突只是信号，不证明无冲突'));
  }

  // 11. 指令文本只当数据；绝不执行，也不作为助手行为配置采纳
  checks.push(check(CHECK.INSTRUCTION, 'pass',
    containsInstructionText(text) ? '输出含指令样文本：按数据处理，不执行、不改变行为配置' : null));

  const fail = checks.filter((c) => c.status === 'fail').length;
  const inconclusive = checks.filter((c) => c.status === 'inconclusive').length;
  const status = fail > 0 ? 'fail' : (inconclusive > 0 ? 'inconclusive' : 'pass');
  const reasons = checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}: ${c.detail || c.status}`);
  return { status, reasons, checks, normalized_text: text };
}

// 规则通过 → 「规则检查通过」；不要把它写成「事实已验证」。
export function describeValidation(result) {
  if (!result) return '未校验';
  if (result.status === 'pass') return '规则检查通过（不等于事实已验证）';
  if (result.status === 'inconclusive') return `无法确定（inconclusive）：${result.reasons.join('；')}`;
  return `规则检查失败：${result.reasons.join('；')}`;
}
