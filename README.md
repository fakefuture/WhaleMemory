# WhaleMemory

本地、可审计、可回滚的外置记忆库。用户内容不进模型权重，存在自己的文件里。

零第三方依赖的 Node 实现：严格存储、范围隔离、候选审核、两路检索；
人格卡、印象层、情绪行通过只读插件注入系统提示词。

> PSM 指 Personal Semantic Memory。这不是 RAG 服务：默认不往提示词里塞记忆，
> 由调用方显式 `query` / `add`；注入插件只渲染人格卡与印象层，不检索、不联网。

## 设计原则

- **查询默认只读**：`query` 不改强度、不降衰减、不唤醒休眠；只有 `--touch` 更新访问计数。
- **模型只生成候选**：巩固、采集、合成、合并都写 `review_status=candidate`；
  `candidates accept` 必须给理由，规则校验失败或 inconclusive 时不能采纳。
- **准入只做确定性去重**：同 namespace + scope + 审核状态 + 正文完全相同才算重复；
  相似但取值/否定不同的记录只标 `suspect` 冲突，不降权。
- **范围是硬边界**：`global` 同 owner；`workspace` 再加 workspace；
  `session` 必须精确匹配 `sessionId`，没有会话上下文时一条 session 记录都不可见。
- **显式纠错保留旧正文**：`--supersedes` 只把旧记录标 `validity=superseded`，正文与证据不删。
- **存储有锁、revision 与原子提交**：所有写操作走同一事务入口。
- **模型权限收窄**：BGE-M3 只提供向量/相似候选，Qwen 只提供压缩措辞；
  二者都不能判定事实等价、解决冲突、提高信度或直接写正式库。
- **染色默认关闭**：新库 `color.affect_alpha=0`、`persona_alpha=0`，字段保留但不参与排序。

## 快速开始

需要 **Node 18+**，无其它必需依赖。读取 DSH 的 `.jsonl.zstd` 会话存档
（`capture` / `session-export`）需要 Node 22.15+（推荐 24）。

```powershell
node bin/psm.mjs init                  # 建 v2 空库
node bin/selftest.mjs                  # 离线回归 T01–T46；不通过先别用
node bin/psm.mjs doctor                # 只读体检；FAIL 退出码非零
node bin/psm.mjs add "用户的工作目录是 D:\work" --tier semantic --scope workspace
node bin/psm.mjs query "工作目录" --limit 5
node bin/psm.mjs explain <id>          # 正文哈希、证据、审核链、冲突
node bin/psm.mjs report
```

## 命令速查

| 命令 | 作用 |
|---|---|
| `add "<内容>" \| --file <路径> [--tier …] [--scope …] [--supersedes id,…] [--candidate] [--domain …] [--evidence "原文"]` | 准入后写入；只做完全相同去重；冲突只标记 |
| `query "<问题>" [--limit 8] [--scope …] [--at ISO] [--touch] [--session id] [--all-scopes] [--explain]` | 两路检索；默认只读；候选/历史/争议分栏 |
| `explain <id>` | 正文哈希、证据、审核链、冲突与操作记录 |
| `feedback <id> good\|bad` / `revive <id>` | 效用反馈 / 显式唤醒休眠条目 |
| `candidates list\|show\|accept\|reject` | 候选审核；accept/reject 需要理由 |
| `merge --ids … --content "…"` / `synthesize` | 只创建合成候选 |
| `consolidate` / `reorg` / `decay [--top-k 20]` | 巩固只造候选；重组与衰减见 README 的「已知限制」 |
| `conflicts [--open\|--suspect]` / `resolve <id> keep-a\|keep-b\|both` | 冲突队列与人工裁决 |
| `capture [--all\|--session id\|--file 路径]` | 会话扫描 → 候选/证据/游标同一事务提交 |
| `session-end` | 本地收尾（衰减 + 巩固候选） |
| `persona show\|card\|update\|set\|history\|rollback` / `impression add\|list\|remove` / `probe …` | 人格、印象、探针 |
| `emotion build\|track\|classify\|state\|sessions\|use` | 情绪向量、状态与诊断 |
| `context ["问题"]` | 宿主实际会注入的静态块 + 可选词面相关块 |
| `embed` / `calibrate` | 生成向量缓存 / 粗调相似度阈值 |
| `backup create\|list\|verify\|prune` / `restore` | 整库快照、哈希校验、恢复 |
| `cold add\|list\|get\|verify\|stats` | 冷存储：纯归档，不渲染、不检索、不注入 |
| `migrate` / `doctor` / `repair` / `report` / `config` / `selftest` | 迁移、体检、修复、概况、回归 |

通用参数：`--root <目录>` 或 `PSM_ROOT`；`--json` 输出机器可读 JSON；
`--offline` 本次不请求嵌入服务。

## 检索

默认只做词面 Jaccard；启用嵌入后增加余弦通道。两路绝对门槛在归一化、强度、偏置之前执行：
词面 `> lexical_min (0.12)`、余弦 `> dense_min (0.55)`；各自排名后用 RRF（k=60）融合，
再乘业务权重 `relevance .55 / strength .25 / recency .12 / utility .08`。

词面分与余弦分不直接相加；判断有没有答案看 `no_match`、`reason` 与
`diagnostics.max_lexical / max_dense`，而不是 `score`。

`query --json` 的结果行包含 `lexical_score`、`dense_score`、`lexical_rank`、`dense_rank`、
`fused_score`、`score`、`match`（lexical/dense/hybrid）与 `components`。
`--at` 使用半开区间 `[valid_from, valid_to)`；缺失一端会标 `time_unknown`。

阈值当前标为 `tentative=true`。换嵌入模型必须重新标定；`eval/` 提供带标签样例与 runner。

## 范围、身份与证据

`store.identity = { owner_id, workspace_id }` 是数据归属标识，不是认证系统。

| scope | 可见条件 |
|---|---|
| `global` | 同 owner |
| `workspace` | 同 owner + 同 workspace_id |
| `session` | 同 owner + 同 workspace_id + `session_id` 精确相等；无会话上下文则不可见 |

`--all-scopes` 是只读诊断视图，不能与 `--touch` 同用；`explain` 对不可见记录返回
`not_found`，不泄露正文与证据。

每条新记录至少有一条证据；调用方显式给的证据必须真实存在，否则拒绝。
`accepted` 只表示被流程采纳，不表示客观事实已被证明。

## 可选：嵌入

```powershell
ollama pull bge-m3
node bin/psm.mjs embed --enable --url http://127.0.0.1:11434 --model bge-m3 --num-gpu 0
node tools/calibrate.mjs --model bge-m3 --apply
```

服务不可用时 `add` / `query` 退回词面比较并打警告，不会因为模型没起而写不进记忆。
向量缓存记录模型指纹、维度与正文哈希；换模型或正文改变后旧向量自动拒用。

## 可选：本地小模型

```powershell
ollama pull qwen2.5:1.5b
node bin/psm.mjs synthesize --enable --model qwen2.5:1.5b
node bin/psm.mjs candidates list --kind synthesis
node bin/psm.mjs candidates accept <id> --note "核对来源后采纳"
```

默认关闭；打开也只启用“生成候选”，没有自动采纳开关。提示词只许压缩、不许推断、
不改写取值、冲突不选边；输出要过结构、来源哈希、新取值、否定与条件检查。

## 人格 / 印象 / 情绪

- **人格档案**：`persona.traits`，数值走余弦 EMA，分类走分布；`persona set` 显式改档案。
- **人格卡片**：手写正文 + 刻度化特质 + 可选情绪行，渲染成 `[自我]`，带 token 预算、
  优先级裁剪与版本回滚。
- **印象层**：`[关于用户]`，按权重注入、同文去重。
- **情绪**：语料 → 向量 → 6 情绪 + 两轴；强度按正负不同 tau 指数松弛，低信度记中性；
  状态按会话存储，没有 session 上下文就不套用其他会话的情绪。
- **染色**：`domain` / `affect_at_write` / `persona_fp` 字段保留，查询管线默认不应用偏置。

`context` 与插件共用同一份纯渲染函数，同一快照/上下文下输出逐字一致。
默认只注入 `[自我]` 与 `[关于用户]`，不自动注入记忆。

## 注入插件（可选）

```powershell
node plugin/install.mjs           # dsh-persona-bridge → DSH profile；需重启 Harness
node plugin/verify-installed.mjs  # 插件渲染与 CLI 逐字比对
node plugin/install-capture.mjs   # 可选：定时调用 tools/capture.mjs
```

`dsh-persona-bridge` 只读 `memory/store.json`，不写库、不联网、不起子进程；渲染失败就静默不注入。
`dsh-memory-capture` 只起定时器，抄什么由 `tools/capture.mjs` 决定。

宿主拿不到会话 id 时，插件不会拿到会话情绪，也不会回退到别的会话。

## 评测

```powershell
node eval/run.mjs --split test --json
node eval/run.mjs --split calibration --json
node eval/run.mjs --write-manifest
```

夹具覆盖检索、合成与情绪；`manifest.json` 固定样本数与 SHA256，runner 先校验再跑硬门槛
（范围泄露 = 0、错误取值采纳 = 0）。情绪必须接真实嵌入模型才有结果，没有模型就如实
`NOT_RUN`。

## 目录结构

```
bin/        psm.mjs（CLI）、selftest.mjs（T01–T46 runner）
lib/        repository / lock / fsx / schema / policy / service / service-core /
            retrieval / validation / synth / render / embed / cold / doctor / backup / …
tools/      capture、calibrate、fake-embed、session-export
eval/       run.mjs、retrieval/synthesis/emotion 夹具、manifest
test/       T01–T46 离线回归（node:test，临时目录，自动清理）
docs/       人格/情绪语料、刻度表、探针集、卡片模板（运行时数据）
plugin/     dsh-persona-bridge（只读注入）、dsh-memory-capture（定时采集）
memory/     store.json（空库样例）、embeddings.json（可重建，已 gitignore）
```

公开的 `memory/store.json` 是 v2 空库样例，不含真实数据。实际使用时把 `--root` 指向
独立数据目录；`backups/`、`cold/`、`exports/`、`tmp/`、锁文件与向量缓存都在 `.gitignore` 里。

## 已知限制

- 单 owner/workspace，没有多租户认证。
- 锁是协作式的，只约束经过本程序的写进程。
- 原子写降低半写风险，不承诺硬件级断电安全。
- 每次提交写整份 JSON，库大时写放大会明显。
- 检索阈值是暂定值，换模型必须重标。
- 冲突判定靠显式声明与启发式 `suspect`，没有 NLI。
- 人格向量未实现，需要白盒激活。
- 情绪染色默认不参与排序。
- 1.5B 小模型只适合压缩，不适合判断偏好或矛盾。
- Windows PowerShell 5.1 用 `Get-Content/Set-Content` 读写 UTF-8 会乱码，建议用编辑器或
  `--file` + Node。

## License

MIT，见 [LICENSE](LICENSE)。
