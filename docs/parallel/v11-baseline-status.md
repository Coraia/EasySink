# V1.1 baseline / protected-data handoff

2026-10-11。仅负责 `outputs/v11-delivery-20261011/baseline/` 与本文件。没有修改产品源码、重启正式服务、操作 UI、调用网络/模型/OCR、提交或更新 issue。主控已报告独立 18771 baseline 第二次启动成功；这只表示服务启动，浏览器与性能结果由主控另行记录。

## 已交付

- 固定 V1：`git archive 023936a1d9df72715fc6794dbe64e3c38352eacb`，与 `v1.0.0^{}` 一致；576 个归档文件有逐文件 SHA256，未混入并行实现。
- 实际 8766 与已安装 Candidate 的进程/监听/工作目录/数据路径已只读核对，**不是仅凭默认配置推测**。两者用户 DB 不同；具体私有路径留在本地 runtime evidence。
- 安装 Candidate 的 2,842 个清单条目全部匹配 V1 接受产物，无额外文件。内部版本仍为 `0.2.0` build `1`，产品 V1 标签另列，不伪造包版本。完整安装树与 ZIP/可执行文件/解释器有 SHA256。
- 两份用户 SQLite online backup（各 34 表）及 18 份 PDF registry/publication/formula/enhancement SQLite 副库已私有备份；全部 20 份另目录恢复后，完整性、文件 SHA、逐表行数和内容摘要一致。不同 DB 分别一致，不是跨文件原子快照，也不代表完整外部原件/重放资料目录恢复。
- profile / 旧 verdict / 笔记与关联 key / anchors / bookmarks / progress / assist / translation 全部保留在私有备份。未把凭据或原始私有记录写入本文。
- sanitized seed 保留 4 书、66 篇章，已有真实 EPUB 两类及已转换真实 PDF 两类，原件、EPUB package fingerprint、内容版本与文本哈希保持；10,501 个复制文件登记 SHA。未重新导入/识别/请求模型。
- `v1-source/data/` 只链接现有词库，Lexicon 实际以 `mode=ro&immutable=1` 打开；可写用户库、原件和转换资产均为独立副本。
- 最终矩阵 31 行：P00 离线保护验证已完成，其余 30 行保持 PENDING。用户故事 1–35、实际模型 30 样例、Web/客户端、恢复、性能和设备证据均有明确验收要求。

## 主控使用入口

[完整交接与绝对路径/命令](../../outputs/v11-delivery-20261011/baseline/README.md)

[验收矩阵](../../outputs/v11-delivery-20261011/baseline/ACCEPTANCE-MATRIX.md) · [CSV](../../outputs/v11-delivery-20261011/baseline/acceptance-matrix.csv) · [配对性能计划](../../outputs/v11-delivery-20261011/baseline/PERFORMANCE-PLAN.md) · [隔离与失败清单](../../outputs/v11-delivery-20261011/baseline/ISOLATION.md)

- V1 源码：`baseline/v1-source/`。
- safe seed：`baseline/private/acceptance-seed/user.db`，不要直接启动它。
- 主控已启动的独立库：`baseline/private/runs/v1-baseline/user.db`，端口 18771，主控 exec session 70829，日志 `baseline/baseline-server.log`。
- 候选计划：主控选定源码冻结点后运行 `prepare_candidate.py`，冻结到 `baseline/candidate-source/`；`prepare_run.py v11-candidate` 从同 seed 复制到 `baseline/private/runs/v11-candidate/`；`launch-candidate.sh v11-candidate 18772`。这些候选复制/启动命令尚未由本贡献者执行。
- 当前运行副本开始浏览器操作后允许出现正常记录变化。重新启动若不满足 clean preflight，应新建 run，不清删操作证据来强行通过。

## 自动任务/外发边界

清空 AI job、凭据/会话和个人操作记录；文本/语音 AI 禁用且 key 为空；PDF processing 关闭但已有阅读版保留；复制 PDF 任务全部 completed、PID NULL；不复制 formula/enhancement 队列、runtime、raw response、命令及日志。启动使用独立 HOME/tmp/cache/models、清空继承环境、无 `.env`、native bridge 关闭、`--lifespan off`，系统 sandbox 禁止 outbound connect。详单见交接文件，无私密配置值。

B/C 必须使用相同隔离模式和现有 venv。该模式只能做 retained reading 配对；启动恢复、真实 AI、OCR 负载与原生设备须由主控另外隔离执行，不得套用本次静态准备作为通过证据。

## 首失败保留

- 离线 EPUB fingerprint helper 缺少 `_epub_roots`，已修复并验证两份真实 EPUB 与旧 import identity 相符；首失败脚本/记录保留。
- 主控第一次启动：frozen `app.py:74` / `lexicon.py:72` 报 `stardict.db` 不存在。原因是归档没有 data 目录，准备脚本在链接步骤中断，旧 preflight 漏查字典。已直接复现同异常，补建目录/链接，加入链接与数据库可读性检查；冻结 Lexicon 只读打开并加载 101,909 lemma 映射，preflight 通过。主控随后报告启动成功。私有首失败、复现、修复检查和父启动回报分别保留，不抹掉第一次失败。

## 尚未验收

本贡献者没有测首屏、翻页、选区、内存，也没有浏览器/真实设备/用户验收。旧合成长 EPUB <2000 ms、适用场景 P95 <34 ms、原生收尾 <240 ms 及高清/cache 守卫保留。选区与内存没有凭空新增绝对阈值；先两批各至少 10 次基线，冻结既有噪声公式，再做至少 10 对 B/C，同步保留原始序列与首失败。

V1-D01 负载下 36.2 ms 帧 P95 失败、V1-D02 学术术语/限定范围歧义继续明示；不是新的通过。rAF/DOM/HTTP/合成 phase 不能证明物理展示、指尖延迟或真实触控板手感。

最终升级与走查后，主控需生成新的 protected snapshot，逐表及来源关联复核，解释合法新增/续读变化；不能只比行数。新集合表允许新增，但旧画像、verdict、笔记、锚点、书签和有效 assist 不得无意改写。当前备份已经具备恢复校验证据，不覆盖任何仍运行的真实用户库。
