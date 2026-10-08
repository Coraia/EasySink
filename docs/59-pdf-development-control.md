# PDF 开发主控记录

## 当前模型约定（2026-10-08 更新）

用户最新指示覆盖下文初始模型约定：本项目主控和四个并行开发会话统一使用 `gpt-6-astra`、`ultra`，保留 Fast。已通过会话工具设置并从本机线程状态回读全部五个会话的模型和推理等级；全局 `service_tier=priority` 保留。正在执行的回复不能追溯换模型；后续回复及新派发任务沿用新约定。没有逐请求服务等级响应证据，不将 Fast 配置写成逐请求确认。此次仅改变会话设置，已交付开发成果保持冻结。

2026-10-08。用户已批准发布 21 票并开始并行开发，指定模型 `gpt-6.1-sol`、推理 `ultra`、Fast。创建工具可设置前两项，没有 Fast 参数；Fast 使用本机全局 `service_tier=priority` 配置；[官方说明](https://developers.openai.com/api/docs/guides/fast-mode)确认 priority 与 fast 为相同行为。创建后模型/推理已回读，实际每次请求是否以 priority 服务仍需响应证据，不把配置当作逐请求确认。

## 执行与验收

### 最新授权：直接推进到 EPUB 阅读体验

用户在查看实验入口后明确要求继续快速开发，直到可以像 EPUB 一样体验再交付。该指示覆盖原先 T06 单独原型验收之后才允许正式接入的执行顺序；现在允许实现、整合与走查，在完整阅读体验达到交付条件后统一用户验收。原有内容外发范围、零默认付费实验、资料保护和证据层级保持。当前接口和新文件所有权以 [本轮整合契约](60-pdf-reading-integration.md) 为准，下面首批实验记录保留为历史。

本会话负责 issue 发布、公共接口、整合和最终走查。用户最新指示优先于父规格及早期验收计划中要求新增自动化测试或完整套件的文字：尽量并行，减少新增测试代码，最终以直接浏览器点击走查、实际性能数字和可复现证据验收。保留原始失败，不把模拟状态、成功构建或服务启动当真实转换/设备验收。

票仍按依赖前沿交付。当前共同推进 T01 的完整隔离闭环；转换 Adapter 的准备不表示 T02–T05 已验收。T06 的真实转换选择及用户原型验收完成后，才进入 T07 正式接入。

## 共享工作区所有权

所有会话使用当前 local checkout，保留现有未提交文档。各自只修改分配文件；跨界修改先通过主控协调。子会话不 checkout/reset、stash、commit/push，不改他人文件，不替主控发布或关闭 issues。完成后在各自状态文件及本会话结果中列出变更、运行命令、证据、未完成条件。

| 会话职责 | 拥有的文件 | 初期范围 |
|---|---|---|
| 实验后端 | `src/wise_reader/pdf_lab/` 顶层，除 `conversion.py`；`scripts/pdf_lab_server.py`；`docs/parallel/pdf-backend-status.md` | 隔离书架、原件接收、持久状态与转换进程 |
| 实验界面 | `web/prototypes/pdf-lab/`；`docs/parallel/pdf-ui-status.md` | 真实实验书架、原版、阅读版及状态，不改正式阅读器 |
| 本机转换 | `src/wise_reader/pdf_lab/adapters/`；`src/wise_reader/pdf_lab/conversion.py`；`scripts/pdf_lab_convert.py`；`requirements-pdf-lab.txt`；`docs/parallel/pdf-conversion-status.md` | 本机真实提取、来源坐标、样本、候选边界 |
| 走查与基线 | `docs/parallel/pdf-walkthrough-status.md`；本人的 `outputs/` 证据目录 | 旧书点击基线、新入口直接走查与性能记录 |
| 主控 | 本文件、AGENTS、共同文档、issue 映射与整合修复 | 接口对齐、依赖前沿、最终状态 |

仅走查会话初期操作浏览器，避免多个会话争用页面；其他会话使用 CLI 核查并标明其证据等级。个人正式阅读服务 8766 与用户资料库保持；实验服务用 18866，自有资料目录。旧书基线用独立 18767；启动前检查端口，不杀未知进程。

## 实验公共接口 v1

独立 FastAPI 实验服务，绑定 `127.0.0.1:18866`，入口 `/static/prototypes/pdf-lab/index.html`。完全独立于正式 `app.create_app()` 的用户库、AI 队列与凭据；不加载个人 `.env`，不对外发文档。引擎进程单独执行，主服务不导入重型模型。

API 前缀 `/api/pdf-lab`，JSON 对象使用 snake_case；错误返回非 2xx 和 `detail`。书籍、任务 ID 是不透明字符串；原页 `page_number` 从 1 起。初期 API：

- `GET /health` → `{status: "ok"}`。
- `GET /capabilities` → `{adapters: [{id, label, available, missing_reason, supports_ocr, version}], cloud_enabled: false}`。不可用引擎不能被 UI 假装成功。
- `POST /imports`，multipart `file` → `{book, task, reused}`；接收校验并持久登记即可返回，不等 OCR。书籍 `{id, title, file_sha256, source_url, page_count, status}`；页数尚未知可为 null。合法 PDF 一个书籍，不点阅读仍保留。
- `GET /books` → `{books: [...]}`。
- `GET /books/{id}` → `{book, task, reading_ready, result_url}`。
- `GET /tasks/{id}` → `{id, book_id, state, done_pages, total_pages, engine, error, metrics}`。
- `POST /books/{id}/operations`，JSON `{action: "convert", engine: "auto", start_page: 1, end_page: null}` → `{book, task}`。动作 `pause/resume/cancel` 初期仅在实际可用时展示，未实现用明确状态，不假装支持。
- `GET /books/{id}/result` → 下述规范化结果；范围未就绪为空/部分结果，不能伪造全书就绪。原件与结果资源 URL 只能读取该服务登记拥有的文件。

结果读取采用已实现的 `start_page` / `end_page` query，单次至多 50 原页，省略时只返回从 start_page 起至多 50 页。界面在打开、跳页和原位返回时读取所需原页及有界邻近范围，不把未加载范围误报成未转换，也不循环下载全书。

2026-10-08 集成补充：capabilities 可返回服务实际支持的 `supported_actions` 数组，界面仅据此显示动作。结果读取时后端为已登记且实际存在的相对 asset 补充同源 `asset_url`；界面使用 `asset_url`，不猜磁盘路径或 URL。存档 result.json 保留相对 asset 与原始来源。原图回退须标明，不把转换完成等同质量校对完成。

来源页坐标约定细化为旋转后的 CropBox 左上角 points（`coordinate_space: "rotated_crop_top_left"`）；转换输出每页可带原始 `rotation` 和 `crop_box`。width/height 是该可见区域应用固有旋转后的尺寸。界面在 PDF.js 可见页几何吻合时按尺寸比例定位，并单列坐标未核对情形，不静默猜测。

导入是否开始转换由真实能力决定：有可用 Adapter 可开始本机任务，没有时仍保留原件并提示准备状态。后台每完成真实页才增加进度；元数据、原版可见、首实际阅读范围、全书结束分别记时。原版可见由浏览器实际渲染事件测量。

## 转换进程契约 v1

入口：`python scripts/pdf_lab_convert.py --source <PDF> --output <dir> --engine <id> --start-page N [--end-page N]`；单独依赖环境 `.venv-pdf-lab`，不修改既有 `.venv`。后端优先探测该环境 Python，缺失时使用可运行的轻量 Adapter，明确能力。

成功保存 `result.json`，写临时文件后原子替换；进度 stdout JSONL `{event: "page_completed", page_number: N, result_path: "result.json"}`，其他事件命名及字段由转换会话记录。异常 stderr 和非零退出可诊断，不含凭据。资源保存在 output 子目录，规范化 URL 由后端映射而非暴露任意本机路径。

`result.json`：`{schema_version: 1, engine, page_count, pages: [{page_number, width, height, text, blocks: [{id, type, text, source: {page_number, bbox: [x0,y0,x1,y1]}, asset: null}]}], metrics, warnings}`。

坐标单位为 PDF points，左上角原点，明确旋转/裁剪影响；type 至少区分 paragraph、heading、image、image_fallback、formula、table。asset 为相对产物路径；图片回退不记为结构识别成功。block ID 在同一转换产物中稳定，不承诺 OCR 改字仍不变。每页仅在真实完成后加入结果，文件锁与发布协调由后端负责。

## 实验预算与收尾

采用现有初始预算：最多三个候选，累计四小时主动实验，累计 20 GiB 下载，默认零付费调用；由转换会话独占依赖/模型安装，先核对磁盘。一次只跑一套重型引擎。连续两次无进展停该路径并保留失败，不重置预算。独立参考样本、合成样本及用户真实材料分开记录。

T01 已发布为 [#2](https://github.com/Coraia/EasySink/issues/2)。四个贡献会话已经启动，模型与 ultra 已从本机各自会话记录回读；全局配置 service_tier=priority，但尚没有逐请求 Fast 证据。

| 职责 | Codex thread ID | 启动状态 |
|---|---|---|
| 实验后端 | `01a11a2e-e900-70e2-b212-f716130a20f6` | 首批贡献已交付 |
| 实验界面 | `01a11a2e-ed9f-7b70-b462-af88930fc886` | 首批贡献已交付 |
| 本机转换 | `01a11a2e-f018-7791-bce7-a08568d47175` | 首批贡献已交付 |
| 走查基线 | `01a11a2e-f462-7043-b356-2e84880fe6c4` | 首批贡献已交付 |

开发状态与验收状态分开，未执行的走查不写通过。

## 已发布任务映射

全部 21 子任务已回读正文/标签，原生父子关系 21 条、阻塞关系 27 条已回读核对；父规格正文和 OPEN 状态保留。

| 本地编号 | GitHub | 标题 |
|---|---|---|
| T01 | [#2](https://github.com/Coraia/EasySink/issues/2) | 旧书兼容与隔离的 PDF 实验入口 |
| T02 | [#3](https://github.com/Coraia/EasySink/issues/3) | 数字 PDF 的原版与阅读版实验闭环 |
| T03 | [#4](https://github.com/Coraia/EasySink/issues/4) | 扫描 PDF 的本机 OCR 实验闭环 |
| T04 | [#5](https://github.com/Coraia/EasySink/issues/5) | 公式、表格、图片与原图回退实验 |
| T05 | [#6](https://github.com/Coraia/EasySink/issues/6) | 多栏、脚注与原页定位实验 |
| T06 | [#7](https://github.com/Coraia/EasySink/issues/7) | 冻结转换方案并验收完整交互原型 |
| T07 | [#8](https://github.com/Coraia/EasySink/issues/8) | 正式 PDF 导入、去重与原版查看 |
| T08 | [#9](https://github.com/Coraia/EasySink/issues/9) | 正式渐进阅读版与结构内容 |
| T09 | [#10](https://github.com/Coraia/EasySink/issues/10) | 阅读版与原版的区域定位和原位返回 |
| T10 | [#11](https://github.com/Coraia/EasySink/issues/11) | PDF 沿用查词、译文、语法和发音 |
| T11 | [#12](https://github.com/Coraia/EasySink/issues/12) | 文字与原图笔记、书签和续读 |
| T12 | [#13](https://github.com/Coraia/EasySink/issues/13) | 局部重新识别后的安全静默更新 |
| T13 | [#14](https://github.com/Coraia/EasySink/issues/14) | 独立任务的暂停、取消、重启与恢复 |
| T14 | [#15](https://github.com/Coraia/EasySink/issues/15) | PDF 书籍回收、迟到结果隔离与恢复 |
| T15 | [#16](https://github.com/Coraia/EasySink/issues/16) | 局部外部增强与有效结果复用 |
| T16 | [#17](https://github.com/Coraia/EasySink/issues/17) | 付费并发限额与未知结果恢复 |
| T17 | [#18](https://github.com/Coraia/EasySink/issues/18) | 保留付费资料的本地重放与明确重新生成 |
| T18 | [#19](https://github.com/Coraia/EasySink/issues/19) | 资料、磁盘压力与 PDF 处理开关 |
| T19 | [#20](https://github.com/Coraia/EasySink/issues/20) | 后台转换下的阅读优先与性能守卫 |
| T20 | [#21](https://github.com/Coraia/EasySink/issues/21) | PDF 高清纸面、光影与真实翻页 |
| T21 | [#22](https://github.com/Coraia/EasySink/issues/22) | 整体 review、完整走查 与一期发布验收 |

## 主控集成发现

- 转换侧 auto 是数字提取/实际 OCR 的编排模式，后端最初因 adapter 列表不含 auto 而降成 digital；后端会话已报告修复，保留本机扫描实际验证作为后续证据。
- 前端最初只读取默认前 50 原页，导致页 51 之后已转换内容被误报未准备；已要求按实际阅读范围读取，待浏览器跨范围验证。
- 实际浏览器首开出现 `null.text_offset`：captureAnchor 的两边可选链均得到 undefined 时比较为真，随后解引用 null。保留首次截图/控制台，交 UI 会话修复并复验。
- 累计 result.json 与 published.json 每页全量重写存在二次方 I/O 成本。当前只证明小样本实验闭环，大书需要页级检查点与有界发布，尚未验收。
- 旧书性能采样与模型准备/部分 OCR 运行时间重叠。已有点击功能证据、原始帧值和失败保留，但不是无负载基线，不能用于归因新代码回归或宣称完整性能守卫通过。

上述是进行中记录，修复状态以对应会话文档和复验为准。正式阅读源文件截至此阶段未修改；真实 Mac 手势、真实供应商、长书与用户 PDF 材料仍未完成验收。

## 首批交付与复验（2026-10-08）

四个会话的首批贡献均已交付，18866 实验服务保持。主控已查看扫描阅读版与125%+90°来源修复截图，正文与完整高亮实际可见。两处真实首失败均保留。跨范围1→50→51→62→1、61/62续读和来源往返已有浏览器证据，实际请求每次2–3页。

证据：

- [浏览器走查状态](parallel/pdf-walkthrough-status.md)，本机 `outputs/pdf-walkthrough-20261008-0844/index.html` 与 `pdf-integration/` 保留第一失败、修复后截图、加载的源码与原始数据。
- [转换状态](parallel/pdf-conversion-status.md)，本机 `outputs/pdf-conversion-20261008-01/README.md` 保留固定依赖/模型、20个合成样本页的独立参考核对及实际本机OCR。
- [后端状态](parallel/pdf-backend-status.md)，本机 `outputs/pdf-backend-20261008T062527Z/README.md` 保留接收、去重、范围、实际取消与恢复的CLI接口证据。
- 主控62页独立范围素材与参考在 `outputs/pdf-controller-20261008-range/`；它不是长书性能或实际复杂材料样本。

未完成：上传控件受Chrome扩展文件权限阻断（HTTP准备不替代上传UI），无负载配对性能、真实用户复杂PDF、真实Mac触控板、局部付费处理及完整一期发布验收。未关闭任何子任务；正式接入继续受T06原型与真实转换选择门槛约束。用户真实PDF路径已通过异步问题请求，独立样本执行不依赖其回答。
