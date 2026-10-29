// tools/calibrate.mjs — 用真实嵌入模型标定 config.sim.embedding 的五个阈值。
// 默认只打印建议；加 --apply 才写进 store.json。
// 用法：
//   node tools/calibrate.mjs --url http://127.0.0.1:11434 --model bge-m3
//   node tools/calibrate.mjs --model bge-m3 --apply
// 参数缺省时读库里的 config.embed；--root 指定库（默认当前目录）。

import path from 'node:path';
import { embedConfig, embedOne } from '../lib/embed.mjs';
import { cosine } from '../lib/sim.mjs';
import { readSnapshot, withWrite } from '../lib/repository.mjs';
import { round } from '../lib/util.mjs';

// 三组标定样本：同义改写（应合并）、同主题不同值（应判冲突）、无关（必须留在冲突线以下）。
// v0.2 扩到每组 12 对。这只是 sim.embedding 的粗调，不是可靠标定；检索绝对门槛
// 与候选质量必须用 eval/ 的带标签样本观测。不要拿样本数当质量证明。
const PAIRS = {
  paraphrase: [
    ['部署目标是 Windows 桌面端', '上线环境用 Windows 桌面版'],
    ['记忆库放在 D 盘的 remember 目录', 'remember 目录在 D 盘存放记忆'],
    ['用户偏好中文回复', '用户希望用中文交流'],
    ['衰减率越低记忆保留越久', 'lambda 越小，记忆强度下降越慢'],
    ['会话结束后执行巩固与修剪', '一次对话结束就做沉淀和裁剪'],
    ['写入前先检查重复', '落库之前先做去重'],
    ['冲突只标记不覆写', '遇到冲突只新增记录，不覆盖旧内容'],
    ['查询默认不修改记忆', '检索操作默认只读'],
    ['候选必须人工采纳', '模型产物要经过审核才能生效'],
    ['备份先校验再恢复', '恢复前先验证快照哈希'],
    ['会话隔离要求精确匹配 id', 'session 记录只对同一个会话可见'],
    ['模型只提供向量信号', '嵌入模型不负责判断事实真假'],
  ],
  contradiction: [
    ['部署目标是 Windows 桌面端', '部署目标改成 Linux 服务器'],
    ['用户偏好中文回复', '用户偏好英文回复'],
    ['记忆库使用单一 store.json', '记忆库拆成多个文件分别存储'],
    ['只衰减 Top20 之外的条目', '所有条目每轮都衰减'],
    ['回复默认简短', '回复默认详尽'],
    ['默认不自动注入记忆', '默认自动注入记忆'],
    ['查询默认只读', '查询默认会更新访问计数'],
    ['候选采纳不需要理由', '候选采纳必须填写理由'],
    ['旧版本正文会被删除', '旧版本正文保留在库中'],
    ['范围隔离允许跨会话读取', '跨会话记录必须拒绝访问'],
    ['情绪偏置默认开启', '情绪偏置默认关闭'],
    ['备份恢复直接覆盖当前库', '备份只恢复到新目录'],
  ],
  unrelated: [
    ['部署目标是 Windows 桌面端', '用户喜欢喝美式咖啡'],
    ['记忆库用 JSON 存储', '项目截止日期是下周五'],
    ['用户偏好中文回复', '显卡是 RTX 4090'],
    ['会话结束做重组', '密码存在密码管理器里'],
    ['人格档案走 EMA', '构建工具用 esbuild'],
    ['锁文件防止并发写', '今天下午要下雨'],
    ['证据必须可追溯', '咖啡豆来自埃塞俄比亚'],
    ['候选需要审核', '显示器分辨率是 4K'],
    ['衰减按天数结算', '周末去爬山'],
    ['向量缓存可以重建', '冰箱里还有牛奶'],
    ['迁移前先备份', '键盘是机械轴'],
    ['查询使用 RRF 融合', '机票改签到周五'],
  ],
};

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags[key] = argv[i + 1]; i += 1; }
    else flags[key] = true;
  }
  return flags;
}

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * q)))];
  return {
    n: v.length,
    min: round(v[0], 4),
    p25: round(at(0.25), 4),
    median: round(at(0.5), 4),
    p75: round(at(0.75), 4),
    max: round(v[v.length - 1], 4),
  };
}

function suggest(s) {
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const warnings = [];
  const cMax = s.contradiction.max;

  let merge = round(clamp(Math.min(s.paraphrase.min - 0.02, 0.99), 0.5, 0.99), 3);
  // 关键约束：merge 必须高于最高的矛盾对，否则"用户纠错"会被当成近重复合并吞掉。
  const mergeFloor = round(cMax + 0.03, 3);
  if (merge < mergeFloor) {
    merge = round(clamp(mergeFloor, 0.5, 0.995), 3);
    warnings.push(
      `同义对与矛盾对区间重叠：merge 已从 ${round(s.paraphrase.min - 0.02, 3)} 抬到 ${merge}`
      + `（= 最高矛盾对 ${round(cMax, 3)} + 0.03）。否则纠正会被合并吞掉；代价是低于该值的同义改写不再自动合并。`,
    );
  }
  if (merge > s.paraphrase.min) {
    warnings.push(`merge(${merge}) 已高于最低的同义对(${s.paraphrase.min})：语义去重只对高度接近的改写生效`);
  }

  const conflictFloor = Math.max(0.2, s.unrelated.max + 0.03);
  const conflict = round(clamp(s.contradiction.min - 0.02, conflictFloor, merge - 0.02), 3);
  // 聚类是"同主题归组"，比去重宽松得多；不能拿 merge 取中点——
  // merge 为防吞纠正被抬高后，中点和它一起虚高，同义的三条会被拆成两组。
  const cluster = round(Math.min(merge - 0.05, conflict + 0.12), 3);
  const cover = round(Math.max(conflict + 0.02, merge - 0.02), 3);
  const prune = round(Math.min(0.995, merge + 0.01), 3);

  if (s.unrelated.max >= s.contradiction.min - 0.03) {
    warnings.push('无关对与矛盾对的相似度区间重叠：该模型区分不了"同主题不同值"和"无关"，冲突检测会误报，建议保持默认或换模型');
  }
  if (s.paraphrase.min <= s.unrelated.max + 0.05) {
    warnings.push('同义对的下界贴近无关对的上界：语义去重会漏报，merge 阈值不要压太低');
  }
  return { merge, conflict, cluster, cover, prune, warnings };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const root = path.resolve(flags.root || process.env.PSM_ROOT || process.cwd());

  let base = null;
  try { base = readSnapshot(root); } catch { /* 没有库也能标定，用参数 */ }

  const cfg = {
    ...(base ? embedConfig(base.doc) : { enabled: true, provider: 'ollama', url: 'http://127.0.0.1:11434', model: 'bge-m3', timeout_ms: 60000 }),
  };
  if (typeof flags.url === 'string') cfg.url = flags.url;
  if (typeof flags.model === 'string') cfg.model = flags.model;
  if (typeof flags.provider === 'string') cfg.provider = flags.provider;
  if (flags['num-gpu'] !== undefined) cfg.num_gpu = Number(flags['num-gpu']);
  cfg.enabled = true;

  const pairCount = Object.values(PAIRS).reduce((n, rows) => n + rows.length, 0);
  console.log(`模型 ${cfg.model} @ ${cfg.url} (${cfg.provider})`);
  console.log(`正在嵌入 ${pairCount * 2} 条标定文本（${pairCount} 对）…\n`);

  const results = {};
  const dims = new Set();
  for (const [kind, pairs] of Object.entries(PAIRS)) {
    results[kind] = [];
    for (const [a, b] of pairs) {
      const va = await embedOne(cfg, a);
      const vb = await embedOne(cfg, b);
      dims.add(va.length);
      dims.add(vb.length);
      const sim = cosine(va, vb);
      results[kind].push({ a, b, sim: round(sim === null ? 0 : sim, 4) });
    }
  }

  if (dims.size !== 1) {
    console.error(`维度不一致（${[...dims].join(', ')}）：同一模型不该出现，先查端点`);
    return 1;
  }

  for (const [kind, rows] of Object.entries(results)) {
    const st = stats(rows.map((r) => r.sim));
    console.log(`[${kind}] n=${st.n}  min=${st.min}  p25=${st.p25}  median=${st.median}  p75=${st.p75}  max=${st.max}`);
    for (const r of rows) console.log(`   ${r.sim.toFixed(4)}  ${r.a}  ↔  ${r.b}`);
    console.log('');
  }

  const s = {
    paraphrase: stats(results.paraphrase.map((r) => r.sim)),
    contradiction: stats(results.contradiction.map((r) => r.sim)),
    unrelated: stats(results.unrelated.map((r) => r.sim)),
  };
  const rec = suggest(s);

  console.log(`维度 ${[...dims][0]}，建议写入 config.sim.embedding：`);
  console.log(`  merge ${rec.merge}  conflict ${rec.conflict}  cluster ${rec.cluster}  cover ${rec.cover}  prune ${rec.prune}`);
  for (const w of rec.warnings) console.log(`  ⚠ ${w}`);

  if (flags.json === true) {
    console.log(JSON.stringify({ stats: s, recommended: rec }, null, 2));
  }

  if (flags.apply !== true) {
    console.log('\n（只打印，未写入。确认后加 --apply 落到库配置）');
    return 0;
  }
  if (!base || base.version !== 2 || !base.writable) {
    console.error('没有可写的 v2 库：先运行 node bin/psm.mjs migrate --apply（v1 只读视图不能写）');
    return 1;
  }
  await withWrite(root, async (tx) => {
    tx.doc.config.sim = tx.doc.config.sim || {};
    tx.doc.config.sim.embedding = {
      merge: rec.merge, conflict: rec.conflict, cluster: rec.cluster, cover: rec.cover, prune: rec.prune,
    };
    tx.op({
      op: 'config.calibrate',
      source: 'tools/calibrate.mjs',
      changes: { model: cfg.model, pairs: pairCount, sim_embedding: tx.doc.config.sim.embedding },
    });
  });
  console.log(`\n已写入 ${path.join(root, 'memory', 'store.json')} 的 config.sim.embedding（同一写事务，revision 递增）`);
  console.log('注意：检索的 lexical_min/dense_min 没有自动改；请用 eval/ 的带标签样本另行标定。');
  return 0;
}

main().then((code) => { process.exitCode = typeof code === 'number' ? code : 0; }).catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
