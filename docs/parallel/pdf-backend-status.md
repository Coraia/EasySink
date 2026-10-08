# PDF 实验后端状态

## 阅读整合轮次（2026-10-08，docs60）

用户已授权直接整合到现有阅读路径；本轮拥有新 `pdf/`、`plugins/pdf.py`、`plugins/library.py` 和旧 worker/storage/validation。旧lab文件由本会话的子agent并行负责，其余由本会话桥接。主控负责app/Engine/Anchor/纸面接线；不重启8766、个人库或18866，不新造阅读器。

实施前额外失败边界：跨registry/用户库登记中断造成重书/漏书；后台词法分析持锁拖慢旧阅读；一页进度多次创建不同docID；8页范围跨范围错序/正文无界；新识别覆盖旧文导致笔记锚点错绑；图片字符偏移与正文/词注不一致；资源URL错映射书籍/版本；关闭处理、回收和迟到页发布竞态；重启复发已取消任务或改变范围；schema2索引误当正文、丢失逐页检查点。将采用摘要唯一映射、固定范围ID、事务外准备/短提交、保留历史表示、版本/生命周期再核对、真实进程控制和页索引有界读取。

本轮验证仅使用新独立临时DB/端口与合成/公开资料；保留实际HTTP、首次失败、源摘要，不写事后unit tests、不跑fullsuite。当前实现中，不能把上一轮CLI通过挪为本轮阅读整合通过。

整合最小链已实际贯通：独立18878/`outputs/pdf-reader-backend-20261008-01/data`，新插件 register 设置app.state.pdf，调用start/close、document_metadata/prepare_document/decorate_book及 async set_processing_enabled。合成3页数字原件登记202（本次163.589 ms），立即一本wr_book/无空篇章；真实转换完成后同一书出现doc_id=1，现有 `/api/documents/1?compact=true`返回可词注blocks与pdf来源元数据。尚在继续控制/范围/图像检查，不声明浏览器通过。

读者source已投影为轻量几何/身份/资产信息，glyphs等逐字数据只留原始页分片；content版本覆盖图片/来源/资产变化。新module对旧书不加字段，library删除PDF转为可恢复回收。资产/原件/状态读取不依赖处理开关；访问锁仍由现有全局middleware覆盖。

主控相邻必修（不越界改）：当前 app.py 的 DELETE `/api/documents/{doc_id}` 仍直接delete_document，会绕过PDF回收并删除记录；应对 document_metadata!=None 转整书recycle/保留，旧书走原路径。另外 reading_assist.selected/TTS服务端须拒绝image anchor/对象字符，不能只靠界面隐藏；版本变化后的历史wr_assist在痕迹视图需可核对，不能因当前version过滤而当丢弃旧记录。

本轮review修正正在复核：新增wr_pdf_page接受页ledger，恢复只重建当前授权代次的检查点；旧代次未被接受的worker页不在重启时混进正文，已接受的旧页独立保留并可与新局部结果组合。恢复/普通发布都二次核对epoch；旧底稿resume不覆盖更晚的已接受局部版本。Bridge异常独立显示bridge_error，后台有限队列最多两次无进展后停止；明确convert复用已完成任务时可修复表示，零新增OCR。library adopt同时拒绝PDF目标书/PDF来源篇章，旧书删除也不删除仍被PDF或其他书引用的doc。文本/图像anchor按原件sha、原页、bbox及唯一候选判断，旧quote/source不改。

本轮最终后端快照已就绪，可供主控重载18876。新PDF插件与既有Store/Engine/Reader接线完成；没有创建新阅读器。下面的新轮次结果取代“实现中”状态，不覆盖上一轮失败历史。

2026-10-08。实现中，仅为共同 T01 的后端贡献，不表示 T01/T02–T05 验收。只修改 `src/wise_reader/pdf_lab/` 顶层（除 `conversion.py`）、`scripts/pdf_lab_server.py` 和本文；不操作浏览器、正式 8766 服务、个人书库或公共 tracker。

## 实施前的失败模式与边界

目标：独立 FastAPI `127.0.0.1:18866`，登记原件/书籍/任务后立即响应；无外部 AI、本机重型模型或个人 `.env` 初始化。CLI 烟检只证明接口行为，浏览器、质量、性能及整票验收交由走查/主控。

- 接收：空文件、假 PDF、截断/损坏、加密受限、零页、无 PDF 校验能力、超限上传、页数超限、空间不足、连接中断、写入/登记失败；不形成假书籍或假成功。
- 去重：同内容不同名、并发同内容、同名不同内容；摘要来自实际流，数据库唯一约束及短事务保证活动归属唯一。
- 持久：原件落盘前不能提交书籍；落盘后登记失败可能遗留未引用文件，但不能发布成功；重开读已有身份；重启中断任务保留范围并暂停，不自动继续或重复转换。
- 引擎：入口/独立环境/依赖/模型未就绪、未知 engine、能力探测超时、启动失败、非法页范围、运行非零、无结果、损坏 JSON、页重复/越界、进度早于原子发布；不能增加假进度或显示全书就绪。
- 任务：重叠转换、取消/暂停与退出竞态、运行进程遗留、缓冲 stdout、过大 stderr、子进程后代、重启丢监控、退出时未终止；单 worker 串行，进程组信号真实控制，保留产物。
- 资源：任意路径/绝对 asset/`..`/符号链接、猜测未登记文件、未知书籍/任务、产物不完整、无界结果读取；仅允许登记原件和该书任务产物，限制结果文件大小与范围读取。
- 观测：HTTP 登记、首真实发布、全书转换与浏览器原版可见分别记时；原版渲染只能由浏览器记录，不能用 HTTP 200 冒充可见。

冻结实验接收上限：单文件 256 MiB、10,000 原页；流式接收前后保留至少 512 MiB 可用空间。规范化结果文件暂限 64 MiB，范围 API 单次至多 50 页。上述是实验服务界限，不是正式产品承诺。

## 接口对齐

遵循 `docs/59-pdf-development-control.md` v1。转换侧状态已说明 `--capabilities`、engine ids `digital/docling/auto`；后端通过独立子进程探测，不导入转换模型。原件校验优先在转换 Python 中用实际 PDF parser；macOS PDFKit 为独立本机校验后备，不凭 `%PDF` 标记判断合法。

默认数据 `.runtime/pdf-lab/`，SQLite 与原件、任务日志/产物均独立。服务启动器支持 `--data-dir` 和 `--port` 用于独立烟检，默认只绑定 localhost；已有端口不杀未知进程。

证据目录：`outputs/pdf-backend-20261008T062527Z/`。预算沿用主控累计四小时/20 GiB/零付费，不安装转换依赖，不新建单元测试，不跑 full E2E。每条路径连续两次无进展即停并保留错误。

## 当前进度

- 已读共享控制、领域词汇、ADR、开发契约、T01 与失败分类；初始 18866 未监听。
- 既有 `.venv` 有 FastAPI/uvicorn/multipart，没有 PDF parser；转换侧正在建立独立 `.venv-pdf-lab`。
- 最小可集成实现与后端 CLI 烟检已完成；浏览器证据由走查/主控记录，不在本会话声明。

## 集成进度（14:55 SGT 前后）

- 18866 已由本人的启动器启动，入口 `/static/prototypes/pdf-lab/index.html`；服务不需要转换依赖即可启动。当前正在针对独立 18868/证据数据目录做 CLI 烟检，18866 留给统一浏览器走查。
- 转换 `auto` 保持 CLI 原有混合语义；digital 可用即允许 auto 编排，无 OCR 则原图回退，Docling 就绪时实际 OCR。`auto` 不伪装成额外 Adapter。
- `supported_actions` 当前为 `convert/cancel`。cancel 真实终止进程组，pause/resume 暂返回 501，界面不应展示。
- result API 使用 start_page/end_page，默认从 1 开始最多 50 页。只为已发布、实际存在且归属本任务的 asset 添加 asset_url；存档相对 asset 不改。保留 `coordinate_space` 与页旋转/裁剪，不自行猜坐标。
- 已知实验局限：转换和后端均逐页重写累计 result/published JSON，整本量级可能 O(n²)；HTTP 响应虽按范围有界，读取现有产物仍解析累计 JSON。没有长书/百万字/大扫描性能通过证据；正式大书需分片或索引改进。
- 首次 CLI 失败已保留 `first-validation-failure.json`：合法合成 PDF 被后端 validator 误判，原因是当前 pypdfium2 的 PdfPage 不支持 context manager。已改为 try/finally 显式 close；这不是原件损坏或引擎质量失败。

## 本轮交付与实际证据

代码：`app.py` 独立 HTTP/静态实验挂载、流式摘要接收/容量与来源保护；`storage.py` 短事务书籍/任务登记与摘要 UNIQUE；`validation.py` 子进程 PDFium/其他已安装轻量 parser 和实测 PDFKit 后备；`worker.py` 子进程能力探测、单任务并发、逐页原子校验发布、真实进程组取消、重启范围恢复；`scripts/pdf_lab_server.py` 仅管理自己记录的 loopback 服务，未知端口不发送信号。

可复现命令与原始证据见 `outputs/pdf-backend-20261008T062527Z/README.md`。这里只称 CLI 烟检：

| 检查 | 实际观察 |
|---|---|
| health/capabilities/静态入口 | HTTP 200，cloud_enabled=false；独立环境真实 digital/docling 能力 |
| 同内容并发/改名导入 | 202/200；同书籍和任务、一个书架条目；本次新响应 402.314 ms、复用 123.162 ms |
| 同名不同内容 | 不同书籍，202；本次 285.330 ms |
| 原件及 Range | SHA-256 一致；Range 206/32 bytes |
| 非法/空/密码原件 | 422，密码明确 access_restricted；首误分类保留 |
| 过大请求头/非法范围/未知 engine | 413/422/422；没有实际 256 MiB streaming 或磁盘满注入 |
| 路径穿越/跨书资产/外部 Origin | 404/404/403 |
| 实际回退资产 | 已声明且存在的两张图片 200；仍是 image_fallback，非结构识别验收 |
| 真渐进与取消 | 合成 100 原页，任务 running/done_pages=2 时 HTTP 可读页1–2，1,082.835 ms；取消后进程查询不存在，JSONL止于1–2 |
| 取消后重启/重复导入 | ID、已就绪范围保持；cancelled 未自动续跑，重复导入200/reused/cancelled |
| 处理中重启 | 明确新本机范围3–100，在真实进度后重启；恢复paused/done_pages=4，旧页1–2与新增范围均保留 |
| 独立校验后备 | PDFium及不含parser的既有.venv经PDFKit均实际读到3原页 |

代码走查修正了取消与spawn竞态、准备阶段写盘错误悬挂queued、非对象JSON契约错误、真实failed/category事件接线和重启发布计数恢复。无新单元测试、无 full E2E。

未完成条件：T01整票浏览器/旧书完整基线由主控验收；用户真实材料质量、坐标浏览器核对、后台旧书配对性能、缺引擎的HTTP实景、强杀崩溃/受限磁盘注入和大书分片仍待对应票。结果完成和原图回退不等同质量通过。

收尾已核对：18868证据服务已停止；18866载入最终后端快照并保持运行（本轮最终PID 64234，仅为当前快照）。`/health`、静态index.html与app.js实际200，既有实验书籍ID/完成状态保留。源码摘要及六份文件快照见证据目录 `source-manifest.json` / `source-snapshot/`。

最后一次reload发现启动器预检socket未使用SO_REUSEADDR，TIME_WAIT被误判为占用，导致短暂未就绪；已保留 `launcher-first-restart-failure.txt`，修正为与uvicorn一致的bind语义，服务恢复。独立18868的start/restart/stop复验成功，见 `launcher-restart-corrected.txt`。没有杀未知进程。

## 阅读整合最终交付（docs60，2026-10-08）

自有代码已完成：`pdf/{module,representation,uploads,__init__}.py`、`plugins/pdf.py`、`plugins/library.py`、旧worker/storage/validation。接口为register设置app.state.pdf，async start/close/set_processing_enabled，轻量document_metadata/prepare_document/decorate_book。metadata含有序 `ranges:[{doc_id,start_page,end_page,revision,ready_count}]`，不含text/glyph；任务公开book_id为wr_book数字身份、另保留source_id。GET `/api/pdf/recycle` 已提供保留书籍恢复列表，读取不依赖处理开关。

原件SHA去重与wr_book唯一映射，首次合法接收即保存书架/任务；固定8原页范围以首真实页创建文档，其后稳定doc_id。事务外组装/词法准备，短提交；原图正文canonical U+FFFC、source完整且asset_url同源。来源所有glyphs留页分片，读者Source仅投影几何/身份，三页合成compact响应从32,906降至10,658 bytes（仅此次样本）。历史canonical表示、原件、已接受页/图像和笔记引用保留。

页分片worker已支持真实pause/resume/cancel及force局部recognize，v1仍可读；schema2轻量published manifest+SQLite页/资产索引，按需读取所选页。wr_pdf_page明确已被Reader接受的产物；重启/关闭/回收不采用被旧代次拒绝的新页，当前许可代次才能修复未完成桥接；旧已接受范围仍可与新局部范围组合。Bridge异常可见并有限后台修复（连续两次无进展停止），显式convert复用已完成范围可修复表示，不依赖重新加载OCR模型。普通书籍资料不改变，adopt/删除路径保护PDF来源篇章。

实际HTTP/进程烟检（独立18878，所有材料合成，未称真实材料质量或浏览器通过）：

- 三页数字PDF新导入202/163.589 ms，立即一个书籍、reading_doc_id=null；真实页就绪后旧GET documents返回正文及词注。改名同SHA导入200，原书/篇章ID不变。
- 100页边界材料在running/done=9时两个范围doc_id=2/3；pause→resume保留任务ID、范围与这两个doc ID；关闭处理返回paused，原件Range206、旧Reader200；恢复处理不自动续跑。
- 回收移出普通书架；`/api/pdf/recycle`列出同一书，恢复保留doc ID/笔记并保持暂停。将PDF doc adopt到普通书返回409。主控core DELETE保护已重载核对409，随后Reader200、source206、三条笔记仍在。
- 实际图表/公式回退成为两个正常image_fallback正文对象，text=U+FFFC、偏移1，图片资产200。局部digital recognize只处理明确第1页，保留doc ID、改变revision，旧图URL200/图像笔记保留。正确信息与伪造同blockId/同quote但错误区域的两条文本锚点复核后，mapping_uncertain_count=1，旧quote/source未改。
- 取消后同一独立资料库重启，已接受5页保持5页、cancelled与doc ID不变。读取范围保持轻量且旧版本资料未删。cached convert任务ID/完成状态不变，转换命令文件数2→2，未重跑OCR。
- POSIX转换命令已用 `/usr/bin/nice -n 10`；实际第6页局部任务测到nice=10并completed。OMP/MKL/OpenBLAS/VECLIB/NUMEXPR/TORCH环境线程值设为2，现有capacity=1；这不是GPU硬保证。处理开关监听改为0.5s、to_thread查询与幂等转换，避免与PATCH重复generation/pause。

证据：`outputs/pdf-reader-backend-20261008-01/` 中control、image-and-reuse、anchor-and-restart、final-backend、cached-repair、last-http-smoke、core-delete-observation JSON与原请求/产物；worker-evidence/worker-recovery-evidence保存真实62页继续、51–52有界读取、进程恢复及身份故障注入，worker-first-failure保留最初样本页数假设错误。源码9文件摘要/快照已保存source-manifest/source-snapshot。本轮开发syntax错误也保留compile-first-failure（修复后编译通过，错误版从未重载服务）。

收尾：独立18878已停止，避免占用主控/走查最终18876的测量资源；8766、个人库与18866均未在本轮操作。18876由主控用最终代码重载。没有commit/push、新unit tests、fullsuite或paid调用。

证据边界：本会话尚未操作浏览器，未做真实材料盲质量验收、故意DB满/bridge异常实景或background OCR配对性能；这些不能从HTTP smoke推定。主控已告知历史PDF traces与image TTS拒绝接线完成；本会话仅实际核对了core DELETE409及保留读取。整体验收由主控/走查继续。
