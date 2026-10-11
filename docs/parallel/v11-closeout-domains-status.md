# V1.1 真实材料领域收口

2026-10-11。**源码定稿，可纳入 build4**。实际只修改 `src/wise_reader/l0.py`、`src/wise_reader/lexicon.py`、本文件和 `outputs/v11-closeout-20261011/domains/`。`l2.py`、`profile.py` 的原有未提交修改、`semantics.py` 以及主控/AI 协作者文件均未改写。UI、客户端与性能由主控负责，真实 AI 30 条由另一协作者负责。此次为有限真实材料效果补齐，不是通用领域覆盖或完整产品验收。

## 实现前失败方式与可复现判据

1. **真实候选无领域，偏好空转**：固定 30 条神学/技术/日常材料及其真实篇章，从只读 acceptance seed 核对原文、版本和锚点；以生产 Engine 和词典生成全部候选，不注入候选。相同正文、density、vocab_size 下保存默认/匹配/非匹配/取消的完整输出及确切增删。缺失或无效果作为失败保留，不改造原文凑结果。
2. **歧义误标**：词典某个义项有领域不等于整词在当前语境属于该域。尤其 grace、justification、class、object、thread、bank 不得按拼写或书名强行贴标签。仅接受可追溯的词库领域和保守明确映射；多义/冲突/不确定应无域。完整释义保持，不能冒充语境解释。
3. **优先级越权**：自动注释不超过同密度预算；零密度为零；旧显式 unknown 保留优先、known 不被领域复活；局部掌握与保留 API 记录完整不变。局部呈现由浏览器实现的部分明确交主控，不用 API 保存成功代替 UI 验收。
4. **取消/重启/缓存漂移**：清空须恢复完全相同注释；profile 不进原文候选缓存；新代码缓存版本须使旧无域候选重建；重启后偏好、来源和结果一致。
5. **外发/污染**：仅新建证据目录下隔离 SQLite，正式及 seed 库只读，词典 immutable 只读。应用显式关闭 AI/PDF/native，无后台生命周期；拒绝外部连接并记录。设置领域不得创建 AI/job 请求。不读正式密钥，不改服务与配置。
6. **证据夸大/覆盖**：保存首次产品失败、任何工具失败、源码前后摘要、词典原行、候选和完整响应；原始失败不覆盖。机器筛选和人工语义质量验收分开。稳定 fixture/启动器供主控浏览器使用，不操作浏览器。

复现工件将先于产品改动建立，以真实生产引擎/API 定向走查，不写事后单元测试、不跑全套 E2E。主控 UI 核验仍 pending。

## 主控直接点击

本任务独立实例 **18785 已按主控要求关闭**，下表 URL 仅保留为历史复现入口。主控已报告独立复制 `fixture-seed/user.db` 到自己的 `private/domain-ui.db` 并在 **18777** 核验；本任务未操作该库或服务。原 18785 绑定 loopback，仅写 `outputs/v11-closeout-20261011/domains/repaired-api/user.db`，不是正式 Web/客户端库。后续重启验证使用的 18786、修复前的 18784 也均已关闭。

| 入口 | 操作与确切结果 |
| --- | --- |
| [神学原段落](http://127.0.0.1:18785/#/read/71) | 词汇量 8000，density=1，默认 `illumines`、`monotheistic`；宗教开启后 `monotheism`、`monotheistic`；取消恢复原两项，2/2。 |
| [技术原段落](http://127.0.0.1:18785/#/read/91) | 同样设置，默认 `decoded`；科技开启后 `codec`；取消恢复 `decoded`，1/1。 |
| [领域偏好](http://127.0.0.1:18785/#/profile) | 只切领域并保存，回原文核对。保留当前“1 处”自定义密度；若切为轻(2)/适中(4)，正例可能已全部进入默认预算，不应再要求差异。 |

静态逐字对照：`outputs/v11-closeout-20261011/domains/review.html`。从保存的真实 HTTP 响应生成，显示默认/匹配/取消的完整原段落、注释、来源与哈希。不是模拟应用或浏览器截图。

稳定可复制种子：`domains/fixture-seed/user.db`，保存主控开始核验前的 13 原篇章、30 固定原段落及 3 技术补充原段落；每个段落由真实 POST `/api/documents` 导入，未写入伪造候选。勿直接启动种子，使用 `prepare_fixture.py 新名称` 复制到新目录后启动。

## 查实的根因与最小修复

旧 L0 从 ECDICT 提供词注但未传递任何 `domain`。真实 30 条锚点/版本/正文全部核对一致，涉及 13 篇章；density 1/2/4、vocab_size 8000 下 39 组对比均为零领域候选、零变化。真实 HTTP 同样失败，首失败保留。

不能把 ECDICT 任一义项的 `[计]` 直接赋给整词：`chapter`、`open`、`language` 等日常词都带此标签。此次只映射 7 个窄术语，**headword 及完整 translation/definition 必须同时匹配**，词库版本增加义项或原行变化则退回无域：

| 领域 | 词语 | 本地词典依据 |
| --- | --- | --- |
| 科技 | codec、username | 源词条明确的 `[计]` 单义行 |
| 宗教 | theocentric | 源词条明确的 `[宗]` 单义行 |
| 宗教 | monotheism、polytheism、trinitarian、eschatology | 完整中英文释义分别明确一神论、多神论、三位一体、末世论的显式映射 |

`lexicon.py` 暴露保守条目领域，`l0.py` 只将它传递到真实候选。释义、原文、词频、抑制规则、预算、重复/重叠、显式 known/unknown 排序均未改。SourceCache 本来会对这两个文件做版本指纹，因此重启后自动丢弃旧无域缓存并按原文重建；无需修改 store/engine。

`grace`、`justification`、`covenant`、`redemption`、`salvation`、`faith`、`righteousness`、`thread`、`type`、`class`、`object`、`reference`、`exception`、`string`、`scope`、`bank` 等继续无域。不会根据书名或句中关键词推断词义，不选择某个义项，不替换词典释义，不增加 AI 或能力模型。

## 实测结果与边界

- 固定 30 条：仅 theology-01 原段落在 density=1 下发生上表变化，另外 29 条无变化。固定的 10 条技术歧义选区均无变化。
- 从同一技术书真实内容中取出全部包含 `codec`/`username` 的 **3 个完整原块**，保存原块 ID/范围/哈希。其中 Unicode decoding 段在 density=1 有上表变化，其余无变化。没有截短、拼接或改写正文凑预算。
- 33 原段落 × 3 密度 × 4 选择/取消 = **396 组真实 HTTP 对比**。修复前零变化，修复后只有上述 2 组变化；取消全部精确恢复，日常 10 段及非匹配 sports 全部不变。
- 13 个**完整篇章**在 density 1/2/4 下仍无差异：7 个术语的 53 次候选出现已在原来默认选择内。保存 `repaired-01/no-visible-effect.json`，不将候选数增长冒充可见效果。更高密度中默认就能显示相关词也属正常，不强求增加条数。
- 定向 HTTP：**147 项通过**，包括 profile、相同原文/预算、清空恢复、L1 关闭、旧版 known 抑制与 unknown 强制优先、密度零和完整语境反馈保留。
- 原文/候选/缓存：**75 项通过**。改动前后默认输出逐字相同；候选除 domain 外均相同；旧缓存键重建；切换偏好不改变原文候选缓存；21 个歧义/反例条目保持无域。
- 另一个独立进程两次启动：领域偏好、codec 结果、完整反馈与缓存保持；重启后取消恢复 decoded。
- 所有自动注释 ≤ 原预算；显式 unknown 是现有独立强制通道，可超自动预算，但未被领域挤掉。局部保留/掌握记录在领域切换、密度零、重启后完整不变；**保留与掌握的最终显示由前端完成，本任务不声称浏览器/客户端已经验收**。种子中原 doc25 的 grace 同时 retained+understood，原 doc10 的 thread 仅 understood，供主控继续核对。
- AI、GPU、OCR 调用均未运行；服务 `--lifespan off` 等价关闭后台生命周期，显式空 AI key，native 关闭；OS 拒绝 network-outbound，Python 审计拒绝连接/域名解析。没有外发尝试日志；`wr_assist=wr_job=annotation_cache=0`。正式 DB/服务/配置未写、未重启；读入仅既有 acceptance seed 与只读词典。
- 未写事后单元测试、未跑全套 E2E、未控制浏览器、未提交/推送。语法与限定文件 `git diff --check` 通过。不报性能或完整 UI 通过。

## 证据与复现

根：`outputs/v11-closeout-20261011/domains/`（本地私有资料，勿发布原文包）。

- `corpus-30.json`、`passages.json`：固定选择、完整原段落及来源；`baseline-01/source-verification.json`：30 锚点逐一核对。
- `baseline-01/first-failure.json`、`baseline-http-01/first-failure.json`、`baseline-http-first-run.log`：首个真实无候选/无效果失败。第二个“带域但整篇无变化”保留在 `repaired-01/no-visible-effect.json`。没有工具失败被伪装成产品失败。
- `baseline-01/`、`repaired-01/`：完整生产候选、13 篇章 × 3 密度 × 5 设置的原始结果、比较、源码哈希。
- `baseline-passages-01/`、`repaired-passages-01/`：真正 HTTP 导入/设置/呈现及 396 组比较；`repaired-http-01/`：147 项原始请求响应和检查。
- `cache-audit-01/domain-provenance.json`：7 个映射的实际完整中英文原行、sense/source、词典 revision、出现次数；同目录有 75 项检查及缓存前后指纹。
- `restart-01/`：另一个实例的重启、取消与无外发证据，进程均已退出。
- `fixture-seed/`：稳定只读使用的种子；`review.html`：直接可看的静态证据。
- `before/`、`final-source/`、`source-final-sha256.json`、`implementation.patch`：本任务开始时共享状态、限定源码快照及最终差异。源文件定稿 SHA256：l0 `07661d54d6854f30e454ae6eaa5940a404d0116dd5143a644b37c9fa85745ec2`；lexicon `1d9b31edcb82c22b00fc93692beac689a093aa9ce9410e95bd81f1e403cac573`。

从仓库根执行（名称须全新；18785 为现有交接实例，不重复占用）：

```sh
.venv/bin/python -B outputs/v11-closeout-20261011/domains/prepare_fixture.py review-copy-01
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' .venv/bin/python -B outputs/v11-closeout-20261011/domains/api_server.py review-copy-01 18787
```

另一终端复查 HTTP：

```sh
.venv/bin/python -B outputs/v11-closeout-20261011/domains/api_walkthrough.py http-repeat-01 18787
.venv/bin/python -B outputs/v11-closeout-20261011/domains/passage_walkthrough.py passages-repeat-01 18787
.venv/bin/python -B outputs/v11-closeout-20261011/domains/engine_walkthrough.py engine-repeat-01
```

注意 passage 重跑会在复制库里新建原段落 document，ID 以本次 summary 为准。固定种子第一次交接的 71/91 不变。若比较修复前，应使用已保留基线 HTTP/候选证据或独立源码副本，**不要将 before 文件覆盖回共享工作区**。

剩余范围：7 词是明确且有限的词典映射，不保证任意神学/技术材料、其他十种领域或常见多义术语均有增强。进一步扩充须有逐条词典依据与人工语义核验，不建议在 V1.1 收口中引入上下文猜测。机器筛选不是语义质量人工验收；主控负责最终浏览器/客户端的领域开关、保留优先、掌握显示和性能。

## 清理完成

主控接收源码和种子后明确要求关闭本任务的 18785。停止前双重核对端口监听者为 PID 29164，命令为本任务 `api_server.py repaired-api 18785`；仅向该进程发送 SIGTERM。随后确认进程已退出、18785 无监听。未触碰主控 18777、正式服务或配置；未删除库、种子、原始失败、源码快照及证据。7 词范围不变。

清理记录：`outputs/v11-closeout-20261011/domains/cleanup-18785.json` 及单独校验文件 `cleanup-18785.sha256`。原始 `MANIFEST.sha256` 与历史交接记录保持原样；本节和清理记录覆盖早先“18785 运行中”的时点状态。协作任务完成。
