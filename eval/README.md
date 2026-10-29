# PSM v0.2 评测集

本目录只放夹具、离线规则运行器和可选真实模型运行器。运行器默认只读、不联网，
全部数据在内存里构造，不读写任何真实记忆库或会话。

## 文件

| 文件 | 内容 | 规模 |
|---|---|---|
| `retrieval.jsonl` | 检索问题 + 小型夹具库 + 人工相关 ID | 60 题（每类 10） |
| `synthesis.jsonl` | 来源组 + 待校验提案 | 40 组 |
| `emotion.jsonl` | 情绪诊断文本 | 60 条 |
| `emotion-seeds.json` | 可选真实模型的情绪种子 | 5 类 |
| `manifest.json` | 夹具版本、每个文件的 sha256、各 split 数量 | — |
| `run.mjs` | 运行器（离线规则 + 可选真实嵌入） | — |

## 划分与版本

每条形如 `"split": "calibration" | "test"`。报告默认只跑 `test`，
`calibration` 只用于调参；同一组样例不得同时用于阈值调优与最终报告。
`manifest.json` 记录版本 `0.2.0-eval.1` 与所有夹具的 sha256，运行器默认校验哈希；
夹具变更后需显式运行 `node eval/run.mjs --write-manifest` 重新登记，不能静默漂移。

当前划分：

- 检索：12 calibration / 48 test；
- 合成：8 calibration / 32 test；
- 情绪：12 calibration / 48 test。

## 标注定义

**相关性标注**：`expected` 是人工预设的、应当出现在前 5 条里的记录 ID。
检索题只问一个明确事实；同义、纠错、数字、时间、范围各 10 题，另有无答案 10 题。
`forbidden` 列出绝不允许出现的记录（其他工作区/会话），用于统计范围泄漏。

**无答案**：`answerable: false` 且 `expected: []`。判定标准是：夹具库里没有任何
能直接回答该问题的记录；系统返回非空结果即算一次误报。空查询（`query: ""`）也算无答案，
且必须返回空结果。

**时间**：`at` 为 ISO 时间，采用半开区间 `[valid_from, valid_to)`。没有声明
`valid_from` 且没有 `valid_to` 的记录必须标记 `time_unknown`，不能冒充精确历史。

**合成标签**：`expected_status` 是规则校验应得到的 `pass | fail | inconclusive`。
`proposal_wrong: true` 表示提案文本本身引入了错误取值或反转了否定；
`wrong_value_adopted` 统计"文本本身错误、规则却判 pass"的数量，这是硬门槛，必须为 0。
`adoption_errors` 统计所有"期望非 pass、实际 pass"的情况。
规则通过只表示规则检查通过，不代表事实已验证。

**情绪标签**：`expected` 为五类情绪之一或 `none`。`none` 覆盖中性命令、
引用/转述他人情绪、歧义短句；它们不应被当作说话者本人的情绪。
情绪结果只作实验诊断，不据此开放高影响自动化。

## 运行

```bash
node eval/run.mjs                        # test 划分，词面检索 + 规则校验
node eval/run.mjs --split calibration    # 调参划分
node eval/run.mjs --split all --json     # 机器可读
node eval/run.mjs --skip-manifest        # 夹具调试时跳过哈希校验
node eval/run.mjs --write-manifest       # 夹具变更后重新登记
```

可选真实模型（会请求嵌入服务，需要本地模型或兼容端点）：

```bash
node eval/run.mjs --embed-model bge-m3 --embed-url http://127.0.0.1:11434
node eval/run.mjs --embed-model text-embedding-3-small --provider openai --embed-url http://127.0.0.1:8080
```

提供模型后：检索改为混合通道（词面 + 余弦，两路各自阈值后用 RRF 融合）；
情绪用 `emotion-seeds.json` 现场构建情绪向量并逐条分类，输出准确率与分组结果。

**没有真实模型时，情绪项明确输出 `NOT_RUN`，绝不用假向量或随机分数冒充模型质量。**
检索在没有模型时走纯词面通道，报告里标注 `lexical`；这只能说明确定性链路可用，
不能说明语义检索质量。

## 指标

- Recall@5：可答题中，期望 ID 出现在前 5 的比例（按题平均）。
- MRR@5：第一个期望 ID 的倒数排名（未命中记 0）。
- 无答案误报率：无答案题中返回非空结果的比例。
- 范围泄漏数：结果中出现 forbidden ID、未知 ID 或缺少会话上下文时的 session 记录的次数。
- 错误取值采纳数：提案文本本身错误却被规则判 pass 的数量。
- 规则拒绝率：合成用例中 `fail` 的比例。
- 候选可用率：合成用例中 `pass` 的比例（仍需人工审核，不等于事实正确）。
- 延迟：单次 `retrieve` 的墙钟时间，报告 p50 / p95 / max；仅代表当前机器与当前夹具规模。
- 缓存覆盖率：本目录不适用；向量缓存覆盖率由 `psm doctor` 检查。

## 硬门槛

- 范围泄漏数 = 0；
- 错误取值采纳数 = 0，采纳错误 = 0；
- `manifest.json` 哈希一致（或显式 `--skip-manifest`）。

未通过时运行器退出码非 0。检索召回和误报率没有硬阈值：绝对门槛仍是暂定值，
需要更多真实样例校准；不得为了让结果好看而下调门槛后宣称质量提升。

## 已知限制

- 夹具规模是最小规模（60/40/60），只覆盖高频场景，不代表全部分布。
- 检索题由单人按规则编写，没有多人标注一致性数据。
- 离线检索只能验证词面通道；同义表达质量需要真实嵌入模型后另行观测。
- 情绪诊断无法判断 subject 归属；引用他人情绪、歧义短句的失败是预期内的已知限制。
- 延迟只测内存中的 `retrieve`，不含磁盘、嵌入请求与宿主调度。
