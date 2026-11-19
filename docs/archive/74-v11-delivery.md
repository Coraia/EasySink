# V1.1 交付与验收记录

状态：2026-10-11 **V1.1 候选已完成实现、定向走查、问题修复和正式 Web／已安装 macOS 客户端更新，可交给用户体验。** 客户端版本为 1.1.0 / build 2；用户最终验收尚未进行，不等于通用分发或完整设备矩阵通过。

## 从哪里体验

- 已安装客户端：`~/Applications/Wise Reader Candidate/Wise Reader.app`，已启动并停留在原阅读位置。正常退出、重开后仍为同一来源位置。
- 正式 Web：<http://127.0.0.1:8766/>，现有阅读标签已刷新。Web 和客户端继续使用各自原来的资料库。
- 点击单词：查看完整词典候选，可分别操作“收藏词语”“已懂这里”“保留注释”。它们互不推断。
- 拖选文字：使用“划线”；相交范围合并后，操作立即变为“删除划线”。独立笔记不随划线删除。
- 底部工具中的“本书收藏”查看当前书；书架侧栏“词句收藏”查看全部。详情可编辑自己的释义、预览出处，再明确选择继续阅读。
- “解释这里的意思”才请求 AI；已有解释可复用、预览和采纳。明确重新解释才生成新结果。
- 书架有稳定的再次遇见入口；收藏支持 JSON 恢复、Markdown 导出及按类别管理。

不需要重新导入原书。词典内容更完整后，辅助文字可能改变分页总数；续读仍按原文位置恢复，不能用旧页码总数判断位置丢失。

## 交付依据与版本身份

- V1 固定基线：`023936a1d9df72715fc6794dbe64e3c38352eacb` / `v1.0.0`。
- [Q1–Q24](wayfinder/v1-v2/tickets/record-semantics.md)、[35条故事及规格](72-v11-reading-loop-spec.md)、[开发控制](73-v11-development-control.md)。规格 [#39](https://github.com/Coraia/EasySink/issues/39)，开发 #40–45；不关闭用户验收。
- 首次集成检查点 `e97f552d83f61d181fd3b29b40e73e2e2ca31d1c`，其后的已复验修复均纳入本次冻结产物。
- 冻结输入清单 SHA256：`b2323057bf1e815c1f8d333a49360f2750e1d634209bcb50c7195d9087d2176b`。
- 客户端 manifest SHA256：`fcf13e56842c8879d199a38baaf7918007470c895f14b6685be5fcded3385bbc`。
- ZIP SHA256：`94d903f86abac15c531119c9c124f854a75df1bf47148db23143f94aece76a87`，296,011,072 字节。未做公证，不作为公开分发包。
- 正式 Web 返回 `product_version=1.1.0`、`web_revision=20261011-reading-loop`；`version=0.2.0` 是保留的旧接口字段。61 个实际 HTTP 静态资源与冻结源码一致，145 个已安装运行文件与构建 manifest 一致。
- [候选交付清单](releases/v1.1.0-candidate.json)；[运行身份回读](../outputs/v11-delivery-20261011/baseline/deployment/final-runtime-identity.json)。

证据根目录为 `outputs/v11-delivery-20261011/`（下称 E）。词典证据 D=`outputs/v11-dictionary-20261011/`，实际模型证据 P=`outputs/v11-ai-quality-20261011/`。书籍、数据库、设置、备份、原始模型响应仅保留本地，不进入 Git。

## 已走查的产品流程

[完整操作记录](../outputs/v11-delivery-20261011/walkthrough-observations.json)记录实际操作和边界。主要 Web 走查使用独立复制库，IAB 1280×720、DPR1；另有 900×800 窄窗、真实双窗口冲突及实际已安装客户端。

| 范围 | 实际操作结果 |
| --- | --- |
| 词典与个人反馈 | 完整义项/词性/领域/来源；误收电影名等短语移除；固定表达成员可单独查；收藏、已懂、保留独立。成员保留在零辅助密度及刷新后仍生效。 |
| 选择与划线 | 部分单词选择出现菜单，拖动端点跨段；相交后取并集并变“删除划线”；整条删除和撤销；词语记录及独立笔记保留。 |
| 个人资料 | 我的释义自动保存、重开和搜索；记录归组；嵌套出处预览逐层返回；明确继续才跳转。 |
| 并发 | 两个实际窗口：旧选区草稿遇到另一窗口合并范围时显示冲突，不写给新范围；刷新可找回草稿，新范围释义独立。 |
| AI | 未配置时在阅读器内打开配置；真实 provider 已有结果按时间展示，预览后采纳；个人释义与采纳解释分别保存，刷新后仍在。该 UI 回放禁用 provider，未产生额外调用。 |
| 再次遇见／开关 | 同日记录稳定；暂缓后换条、关闭跨刷新保留；收藏插件关闭移除入口，重新开启资料保留。 |
| 备份恢复 | 实际浏览器下载 JSON 并恢复，duplicate=2、imported=0、unresolved=0。 |
| 原有导入阅读 | 实际 EPUB 上传只有一书两章，未点开始阅读仍在书架；章节边界和末页守卫；TXT、Markdown 各一书一章；损坏 EPUB 报错且不建条目。PDF 相邻范围 137→138→137 有翻页动画和划线恢复。 |
| 超时容错 | 生产收藏代码加独立延迟代理：分别延迟响应头、响应体 2.5秒，约1.5秒截止后正文可读、有错误与重试入口；迟到结果不重排正文，故障解除后点击重试恢复。它是明确的故障注入，不是真实供应商断网。 |
| 笔记撤销 | 冻结产物上实际删除测试笔记后点击撤销，条数、原句及正文恢复；撤销由服务端收据恢复。 |
| 已安装客户端 | 完整词卡、临时收藏、详情、出处预览及逐层返回；取消临时收藏后活跃收藏为0；原笔记仍在，目录/书签入口可用；实际前后翻页；正常退出重开到原位置21–22/31。 |
| 正式 Web | 已刷新新资源，当前书收藏空态可用，返回正文仍是原书、原位置；未复制测试资料进入正式库。 |

最后复核发现的一次“点短语翻页”属于走查工具落点问题：跨行 `break the ice` 的包围框中心 `(956.46,543.66)` 位于两个文字矩形之间。点击空白符合现有翻页规则；点击可见 `ice` 和另一短语的 `grain` 均打开正确词卡，页码不变。保留 [原始异常](../outputs/v11-delivery-20261011/unexpected-phrase-click-navigation.txt)、[最终复现](../outputs/v11-delivery-20261011/phrase-final-recheck.txt)、[文字落点复核](../outputs/v11-delivery-20261011/phrase-actual-ink-recheck.txt)，没有为了自动化包围框点击改写产品空白区规则。

## 审阅发现与修复

按 Standards 与 Spec 两轴独立审阅，保留 [Standards 原报告](parallel/v11-review-standards.md)、[Spec 原报告](parallel/v11-review-spec.md)和 [集成审阅](parallel/v11-records-integration-review.md)。报告描述的是当时版本，不改写首失败为通过。

| 发现 | 修复与证据 |
| --- | --- |
| 收藏状态请求可无限等待，并串行拖慢首屏 | 完整 fetch/body 1500ms 截止、迟到结果不发布、明确重试；启动请求与正文/画像加载重叠，只消费匹配来源的准备结果。[交接](parallel/v11-collections-readiness-status.md)，实际延迟 UI 回放与最终开书配对见下文。 |
| 稀疏子范围缺字段导致500，恢复后原件重导入的采纳被错误拒绝 | 子范围可选字段归一；以已验证来源身份检查当前 assist，不修改不可变快照；34个真实临时 API 请求15项通过，首轮8项失败保留。[证据](../outputs/v11-delivery-20261011/records-api-evidence/p2-adoption/README.md)。 |
| 精确原件重导入后旧 doc_id 无法定位 | 原ID失败后使用有上限的稳定身份搜索，只允许唯一且原始字符/版本/范围一致的匹配；原轮及复现32/43，修后43/43。[交接](parallel/v11-source-reimport-repair.md)。 |
| 删除原书连带删除独立笔记；笔记撤销收据丢来源，PUT/undo非原子 | 删除原件前保留来源；笔记删除时捕获完整快照和锚点；原子更新及一次性撤销，不覆盖新资料。基础7/7；后续首轮26项中11失败，最终48请求26项通过；实际 UI 删除/撤销也通过。[交接](parallel/v11-note-preservation-status.md)。 |
| 孤立导入笔记按书清理范围不可靠 | 只按可验证稳定身份和精确锚点归属清理，歧义保留，不删除另一书同源资料；50请求29/29。保留首失败和修后记录于 E/records-api-evidence/p2-orphan-note-scope/。 |
| 子范围资料导入覆盖、重复恢复漏资料、自身导出无法恢复 | 独立合并子范围、统一8MiB数据边界、超限原子拒绝；原轮76请求8项失败，修后80请求19项语义检查通过。[证据](../outputs/v11-delivery-20261011/records-api-evidence/README.md)。 |
| 并发扩展选区后旧草稿写入新范围 | 原始范围身份参与冲突判断；范围变更禁止盲重试，按原草稿身份保存。实际双窗冲突、草稿恢复已走查。 |
| 嵌套预览退出时同时退出阅读器 | 捕获阶段避开 modal，弹窗边界逐层处理；Web 与已安装客户端预览返回均已实际验证。 |
| 模型把选中词扩展成邻近整句含义 | v7 明确选区、前后文及UTF-16边界，要求短解释；真实对照有改善但仍有残留，见下一节。 |

遵从项目规则，没有补写单元测试，也没有在开发中运行全量 E2E。故障和隔离风险先记录，再通过临时库真实 API、既有定向检查和直接 UI 回放验证；这些层级不混记为用户验收。

## 35条故事证据覆盖

编号对应规格。B=直接浏览器或原生界面操作；A=临时资料库上的生产 API；D=真实只读词典接口；P=实际 provider；S=代码/语法/产物核对。A 中的合成 PDF 版本不是实际 OCR 修订。以下是证据覆盖而非35项全部真人通过。

| 故事 | 证据 | 明确保留的限制 |
| --- | --- | --- |
| 1–4 完整词典、缺失回退、固定表达、专业义项 | D固定30选区、保守19表达准入；B表达成员和已安装专业词卡；S完整raw_detail | 未在客户端逐项点击全部30样本；完整候选不等于语境正确选义。 |
| 5–6 独立词语与归组 | B保存/归组/原生取消；A位置身份 | 没有每种同形词多语境组合的逐项UI记录。 |
| 7–12 划线、幂等、并集、删除、桥接、子范围资料 | B部分词/跨段/重叠/删除/撤销/双窗；A相切、桥接、子范围和冲突 | 跨页与每种客户端组合未全跑；桥接全流程以A为主。 |
| 13–16 查阅不推断掌握、反馈撤销、保留独立、旧偏好 | B独立状态/零密度/刷新；A null/缺省/撤销；正式旧库摘要一致 | 其他语境及移动纸面全部组合未逐项记录。 |
| 17–18 零自动AI、固定来源、笔记与释义独立 | B保存/释义/撤销；A来源快照与删除原书保留；正式库无新增context AI尝试 | 删除原书与孤立笔记全UI矩阵仍以A补充。 |
| 19–23 有界上下文、隐私、缓存、明确重试、预览采纳 | A配额/未知状态/重启；P41调用；B已有结果采纳及刷新 | 未故意触发真实付费供应商429/崩溃；实际30样本较短，不证明6000上限UI全覆盖。 |
| 24 OCR版本隔离 | A版本/范围拒绝；B PDF相邻来源 | 未新增真实OCR修订任务。 |
| 25–27 本书/全局、预览/继续、原书缺失 | B列表过滤/预览/明确继续；A重导入/歧义/快照；原生预览 | 缺原件与所有跨库错ID UI组合以A为主。 |
| 28–30 每日再次遇见、暂缓关闭、本地选择 | B稳定/暂缓/关闭刷新；A选择及持久；S不在正文插入 | 未等待自然7天/30天，也未穷尽所有候选优先级。 |
| 31–33 导出/分类清理/恢复 | B JSON真实下载重复恢复；A Markdown/容量/错ID/事务/清理 | Markdown原生下载、永久清理的所有UI组合未全跑。 |
| 34 插件停用保留 | B关/开后资料恢复；A关闭404/重开数量 | 访问锁全部生命周期未复跑。 |
| 35 原有体验与性能 | B旧格式真实导入、PDF边界、原生重开；固定V1配对、内存循环、运行文件核对 | 物理触控板全速度矩阵、长时内存、量化选区延迟和新机安装仍不在本次证据内。 |

## 真实 AI 质量与费用边界

[AI交接](parallel/v11-ai-quality-status.md)、[41次汇总](../outputs/v11-ai-quality-20261011/run-summary-41.json)、[v7三条对照](../outputs/v11-ai-quality-20261011/protocol-v7/comparison-3.md)。

- 首轮日常、神学、技术各10条，共30次；后续11次明确再生成，共41次实际 provider HTTP，自动重试0，最大并发2。
- 供应商报告总token 13,206；无法确认实际币种账单，不填虚构金额。首次API中位2002.5ms、P95 3093.5ms；缓存中位9ms。这不是UI端到端时延。
- 重新打开／缓存／历史读取没有新增传输；UI采纳时使用真实已存结果，无额外模型调用。请求未暗带笔记、画像或整书。
- **technical-01 的 thread 仍把词义扩展到邻近短语**。v7修复了部分神学样本越界，但没有在最终协议重新跑完30条；不得将200、JSON有效或模型自评算成语义准确。用户始终预览后自行采纳。
- 固定词典基线保留完整候选；V2精准个体判断不在V1.1范围。

## 性能实测

[原计划](../outputs/v11-delivery-20261011/baseline/PERFORMANCE-PLAN.md)、[提前冻结容差](../outputs/v11-delivery-20261011/baseline/final-open-frozen-tolerance.json)、[最终汇总](../outputs/v11-delivery-20261011/baseline/final-performance-summary.json)。固定V1 B与候选C，前台IAB1280×720/DPR1、Apple M4，4个来源各10对交替打开且对齐相同原文位置。以下为P95，ms。

| 来源ID | firstSource B→C | ready B→C | 结果 |
| --- | --- | --- | --- |
| 10 Python | 227.8→214.1 | 301.2→288.3 | 落在原冻结波动范围内 |
| 23 长书 | 27.2→32.0 | 103.0→108.8 | 同上 |
| 51 PDF | 21.4→19.2 | 68.4→67.1 | 同上 |
| 137 学术PDF | 24.5→23.9 | 96.7→99.8 | 同上 |

这是路由到DOM正文/ready，包含缓存条件，不是像素呈现、冷磁盘或原生冷启动。原始记录为 E/baseline/prefetch-open-pairs.json 与 prefetch-open-paper-matched-anchor.json。

- 初次检查点 final-open 和 warm-open 中，23/51/137等有超差；首失败 [final-open](../outputs/v11-delivery-20261011/baseline/final-open-summary-e97f552.json)、[warm-open](../outputs/v11-delivery-20261011/baseline/warm-open-summary-e97f552.json)保留。发现收藏请求串行后做并发准备，才运行最终配对，不改变原容差。
- 第一组预取数据中137两版本恢复位置不同，仅替换该层；第一组翻页B为同范围/C为跨来源，也不作为配对时延。两份排除数据保留及说明，不混入最终结果。
- 同位置前后交替6次/版本：B每次帧间隔P95 16.9–17.5ms，C 17.1–17.6ms，均无>34ms帧。候选首帧1.6–23.9ms。[原始数据](../outputs/v11-delivery-20261011/baseline/prefetch-turns-matched-anchor.json)。
- 实际鼠标短拖取消：原页不变、spring-back，P95 16.8ms、无>34ms帧；收尾230ms。鼠标输入不证明原生手指抬起门槛。[记录](../outputs/v11-delivery-20261011/baseline/mouse-cancel.json)。
- 三轮固定Python阅读→6次→16次翻页→书架，无强制GC：B书架JS heap 15.36/14.54/12.99MiB、DOM168；C17.98/19.89/17.06MiB、DOM230。候选末轮回落，未观察到逐轮增长；缓存最多6叶、2,313,360像素。[记录](../outputs/v11-delivery-20261011/baseline/memory-browser-cycles.json)。这不是GPU/全进程内存或30分钟浸泡结论。
- 原生V1.1走查时责任进程组footprint约256.9MiB，仅为该时刻观测；与旧V1的窗口状态/冷热程度不同，**不作降低内存的配对宣称**。

V1已接受延期 D01（转换负载中一次帧P95 36.2ms）、D02（学术翻译术语/限定范围歧义）仍按 [V1清单](releases/v1.0.0.json)保留。本次没有使用GPU或重跑整书OCR，也没有降低纸面DPI来换取指标。

## 安装、资料保护与回退

[BUILD-COMPLETE](../outputs/v11-delivery-20261011/v11-client/BUILD-COMPLETE.json)验证冻结输入、包内文件和ZIP；构建约26.44秒，codesign可执行检查通过。[安装收据](../outputs/v11-delivery-20261011/v11-client/private-before-install/20261011-022847-882494/installation.json)；旧 `.app` 留在安装目录 `Wise Reader before-v11-20261011-022847-882494.app`。REUSE-ONLY.json仅为早期构建材料，已由新BUILD-COMPLETE和安装证据取代，不能再当作当前状态。

部署前正常退出客户端，完整备份其资料目录；Web正常停止后备份整个data。两库另有立即部署前SQLite备份和逐表摘要。部署后比较旧字段内容，而非只比行数：

- 两库 profile、word_verdict、wr_note、wr_bookmark、wr_assist、wr_translation 的旧内容均相同，无旧行丢失；笔记新增source_snapshot字段。
- Web锚点/进度不变；客户端只因实际前后翻页更新doc29的进度锚点与时间。其余原有锚点未变。
- 词法缓存仅更新已打开的Web137、客户端29；阅读时间增加是走查写入。正式Web无收藏测试资料；客户端worksheet临时收藏已取消，保留软删除行和撤销收据，活跃收藏0。
- Web14份、客户端9份PDF副库核对：发布内容、公式缓存、增强账本逻辑摘要一致；原件5份各自hash不变。仅任务注册表updated_at因启动恢复更新，状态/内容不变，没有新识别运行。
- 两处AI设置文件字节不变；未输出设置内容或跨库复制凭据。

证据：[旧字段逐行核对](../outputs/v11-delivery-20261011/baseline/deployment/legacy-row-audit.json)、[PDF保留](../outputs/v11-delivery-20261011/baseline/deployment/pdf-preservation-audit.json)、[仅任务时间变化](../outputs/v11-delivery-20261011/baseline/deployment/pdf-task-delta.json)、[配置字节核对](../outputs/v11-delivery-20261011/baseline/deployment/config-preservation.json)、[重启后界面](../outputs/v11-delivery-20261011/baseline/deployment/native-after-reopen.txt)。备份仅用于必要时明确恢复，不能在继续使用后直接覆盖新资料。

## 验收证据与下一步

截图在 [E/screenshots](../outputs/v11-delivery-20261011/screenshots/)。重点查看：installed-v11-collection.jpg、installed-v11-reopened.jpg、partial-word-union.jpg、conflict-range-blocked.jpg、conflict-draft-recovered.jpg、real-ai-persisted.jpg、collections-timeout-readable.jpg、note-server-undo.jpg。每张截图的结论以操作记录为准。

用户可直接从当前客户端开始体验：词卡三项独立操作 → 跨段划线/合并/删除/撤销 → 编辑个人释义 → 出处预览与继续阅读 → 书架再次遇见。重点由真人判断短语候选质量、术语解释是否贴合语境，以及真实触控板和屏幕上的沉浸感。本轮交付的是可使用、可复查的V1.1候选；没有宣布所有设备、每个语义样本或全部异常组合通过。
