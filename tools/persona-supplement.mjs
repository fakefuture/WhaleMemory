// tools/persona-supplement.mjs — 从语料里提取「人格卡补充条目」，只出提案，不改库。
//
// 默认关闭：不挂 CLI、不写 store、不读任何默认语料路径。只有显式运行并给 --file 才会工作。
// 隐私：语料由调用方提供，本工具不打包、不缓存、不上传；不要把个人语料提交进仓库。
//
// 用法：
//   node tools/persona-supplement.mjs --file <语料.md|json> [--limit 8] [--out 提案.md]
//
// 输出：Markdown 提案（【补充·从语料归纳】+ 来源），原人格卡不做任何修改。
import fs from 'node:fs';
import path from 'node:path';

import { readSnapshot } from '../lib/repository.mjs';
import { embedConfig, embedOne } from '../lib/embed.mjs';
import { jaccard, tokenize } from '../lib/util.mjs';
import { sha256Text } from '../lib/schema.mjs';

const NOISE = [/^Current runtime context/, /^<system-reminder>/, /^<available_skills>/];
const ACK = /^(继续|要|好|嗯|对|可以|行|是的|没错|试试)[。！!？?，,]*$/;
const CUE = /(记住|以后都|今后|不要再|别再|必须|一定要|规矩|约定|偏好|习惯|我喜欢|我不喜欢|我希望|我要|我想要|我倾向|我指|错了|不对|应该是|改成|别用|不用|不要用|语气|风格|回复|回答|中文|简洁|直接|先说结论|少客套)/;
const TASK = /(写一个|告诉我|汇总|记一条|先做|加上|跑一下|检查|装|拉下来|备份一份|看一下|给我|帮我|开始|继续做|按顺序|做一版)/;

// 把语料切成用户消息（支持会话导出 Markdown 或纯文本行）。
export function extractMessages(raw) {
  const out = [];
  if (raw.includes('## 👤 用户')) {
    for (const part of raw.split(/^## 👤 用户.*$/m).slice(1)) {
      const body = part.split(/^## /m)[0].trim();
      if (body) out.push(body);
    }
    return out;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t) out.push(t);
  }
  return out;
}

// 只保留「风格/偏好」候选，剔除任务指令与噪声。
export function extractCandidates(raw) {
  const out = [];
  for (const m of extractMessages(raw)) {
    const t = m.replace(/\s+/g, ' ').trim();
    if (t.length < 8 || t.length > 300) continue;
    if (NOISE.some((re) => re.test(t))) continue;
    if (ACK.test(t)) continue;
    if (TASK.test(t)) continue;
    if (!CUE.test(t)) continue;
    out.push(t);
  }
  return out;
}

// 贪心聚类：与簇代表相似度 >= threshold 就并入。
export function clusterBySimilarity(texts, similarity, threshold = 0.86) {
  const clusters = [];
  for (const t of texts) {
    const hit = clusters.find((c) => similarity(t, c.members[0]) >= threshold);
    if (hit) hit.members.push(t);
    else clusters.push({ members: [t] });
  }
  return clusters;
}

function bigramJaccard(a, b) {
  return jaccard(tokenize(a), tokenize(b));
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const file = flag('file', '');
  if (!file) {
    console.error('用法：node tools/persona-supplement.mjs --file <语料.md|json> [--limit 8] [--out 提案.md]');
    console.error('默认关闭：必须显式给 --file，工具不内置任何语料路径。');
    process.exit(2);
  }
  const limit = Math.max(1, Number(flag('limit', 8)));
  const outFile = flag('out', '');
  const root = path.resolve(flag('root', process.cwd()));

  const raw = file.endsWith('.json')
    ? String((JSON.parse(fs.readFileSync(file, 'utf8')) || {}).content || '')
    : fs.readFileSync(file, 'utf8');
  const candidates = extractCandidates(raw);

  let clusters;
  let mode = 'lexical';
  try {
    const { doc } = readSnapshot(root);
    const cfg = embedConfig(doc);
    if (cfg.enabled && candidates.length) {
      const vecs = [];
      for (const t of candidates) vecs.push({ t, v: await embedOne(cfg, t) });
      const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
      clusters = clusterBySimilarity(candidates, (a, b) => {
        const va = vecs.find((x) => x.t === a)?.v;
        const vb = vecs.find((x) => x.t === b)?.v;
        return va && vb ? cos(va, vb) : 0;
      }, 0.86);
      mode = 'embedding';
    }
  } catch {
    clusters = null;
  }
  if (!clusters) clusters = clusterBySimilarity(candidates, bigramJaccard, 0.6);

  clusters.sort((a, b) => b.members.length - a.members.length);
  const picked = clusters.slice(0, limit);

  let cardHash = '(未读取)';
  try {
    const { doc } = readSnapshot(root);
    cardHash = sha256Text(String((doc.persona && doc.persona.card && doc.persona.card.text) || '')).slice(0, 12);
  } catch { /* 库不存在也能出提案 */ }

  const lines = picked.map((c) => `- ${c.members[0]}（${c.members.length} 次）`);
  const body = [
    '# 人格卡补充提案',
    '',
    `语料：${path.basename(file)}；候选 ${candidates.length} 条；聚类 ${clusters.length} 个；相似度：${mode}。`,
    `原卡哈希：${cardHash}（本工具不修改任何库文件）`,
    '',
    '```text',
    '【补充·从语料归纳】',
    ...lines,
    '```',
    '',
    '## 来源',
    ...picked.map((c, i) => `${i + 1}. ${c.members.slice(0, 3).join(' / ')}${c.members.length > 3 ? ` …（共 ${c.members.length} 条）` : ''}`),
    '',
  ].join('\n');

  if (outFile) {
    fs.writeFileSync(outFile, body, 'utf8');
    console.log(`已写入 ${outFile}`);
  } else {
    console.log(body);
  }
}

if (process.argv[1] && process.argv[1].endsWith('persona-supplement.mjs')) {
  main().catch((err) => {
    console.error(`失败：${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
