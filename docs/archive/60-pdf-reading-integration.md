# PDF 与现有阅读器整合

2026-10-08，用户授权直接持续开发到 EPUB 阅读体验后统一验收。第一交付范围：同一书架导入/重开 PDF，渐进本机转换，现有阅读版的词注/密度/语境/选区译文/语法/发音、笔记/书签/续读/痕迹、单/双页/样式/真实纸面与现有手势；原版按需核对，图像及原图回退能记笔记。转换暂停/继续/取消与重启、局部本机重新识别及保留资料保护一并整合。付费 PDF 图像增强另按其实际能力验收，不伪造未接入能力。

## 所有权与并行

复用上一轮四个会话。按 2026-10-08 用户最新指示，主控及四个会话的后续模型统一为 gpt-6-astra / ultra，Fast 沿用配置（详见主控记录中的回读边界）。共享 local checkout；保留未提交文档，子会话不 commit/push/reset/stash。只改分配路径；相邻代码意见写状态交主控，不交叉写。

| 负责方 | 可写路径 | 本轮交付 |
|---|---|---|
| 后端会话 | 新 `src/wise_reader/pdf/`；`src/wise_reader/plugins/pdf.py`；`src/wise_reader/plugins/library.py`；旧 `pdf_lab/worker.py`、`storage.py`、`validation.py`；自己的状态文件 | PDF 原件/任务与书籍/阅读文档桥接、原页/资源/操作接口、页分片发布、生命周期 |
| 界面会话 | `web/plugins/pdf.js`、`importer.js`、`library.js`、`notes.js`、`notes-store.js`；`web/style.css`（仅新增 PDF 样式）；原型 vendor 保留；自己的状态文件 | 原有入口导入与状态、原版核对与返回、图片笔记、任务控制、安全静默更新 |
| 转换会话 | `pdf_lab/conversion.py`、`adapters/`；`scripts/pdf_lab_convert.py`；`requirements-pdf-lab.txt`；自己的状态文件 | 可恢复的页分片、真实材料、质量/来源、高清图片/复杂对象回退 |
| 走查会话 | 自己状态文件与独立 outputs 证据 | 独立整合服务直接点击 PDF/EPUB 全流程，性能与首失败；唯一浏览器操作者 |
| 主控 | `app.py`、`engine.py`、`content.py`、`reading_assist.py`、插件 catalog/runtime/tts；`web/index.html`、`reader.js`、`pagination.js`、`page-curl-renderer.js`、`reader-chrome.js`、`reading-interactions.js`、`reading-traces.js`、`plugin-host.js`；必要的新启动器、共同文档 | 核心接线、来源锚点、图像分页/翻页、接口协调与整合 review |

先在 18876 使用全量现有应用、独立用户库与禁用个人配置走查；8766 留在旧版本，直到交付检查完成后由主控备份资料并部署。18866 保留技术验证，继续开发时不再向用户作为体验交付。

## 同一阅读路径

PDF Module 接受现有 Store/Engine，保持 wr_book/wr_chapter/document 的旧格式接口。一份原件一个 wr_book(source=pdf)，摘要去重；登记即上书架，不等待 OCR。按固定有界原页范围（初始每 8 原页，implementation 可更小但必须稳定）形成阅读篇章，标题明确是原页范围而非虚构原书章节。正常连续翻页复用 ReadingPages.adjacent 的跨篇章行为。API 不返回全书正文。

每页真实完成后发布；表示准备/词法分析在 Store 事务之外，写入/更新在短事务中。读取已转换范围不重复 OCR。追加/重新识别保留稳定 doc ID 和原页来源；稳定 block ID 由原页与对象身份决定，原件、有效旧结果和记录不删。现在只做必要增量，不迁移/重建旧 EPUB。

后端插件 `pdf.register(app, ctx)` 在 app.state.pdf 放置 PDF Module。主控生命周期调用 `await app.state.pdf.start()` / `await close()`；插件依赖保持本机访问锁，读取保留内容不依赖处理开关。供主控调用：

- `document_metadata(doc_id)` → PDF 元数据或 None（轻量、无 OCR/分析）；返回字段下述约定。
- `prepare_document(doc_id)` 如需刷新已发布表示只做轻量检查，不在开书请求里重跑模型；重计算先由后台完成。
- `decorate_book(book_payload)` → 添加 pdf 元数据的书籍，library endpoint 使用；普通书籍原样返回。

阅读 GET /api/documents/{id} 沿用现有 compact 和 engine.present，主控添加可选 `pdf` 元数据。blocks 继续有 id/type/text/start/end/fragments，并可带 source、asset_url、width/height、caption、fallback_reason。图片/公式/表格回退的 canonical text 使用单一对象字符 U+FFFC 保持偏移；正文显示图片而不显示该字符，不冒充可翻译文字。原图回退 type=image_fallback；没有可靠结构不计结构识别成功。

`pdf` 元数据：`{book_id, source_id, source_sha256, page_count, start_page, end_page, ready_pages, source_url, status_url, revision, processing_enabled, task}`；source_url 为同源 `/api/pdf/books/{book_id}/source`；`task` 保留 state/done_pages/total_pages/error。book.pdf 另带 `reading_doc_id`（首可读篇章或 null），允许进入准备状态/原版，不能把空占位篇章假装正文就绪。

## 对外 Interface

- `GET /api/pdf/capabilities`：真实可用 adapters、supported_actions、limits、cloud_enabled=false。
- `GET /api/pdf/recycle`：持久的 `{books:[...]}` 回收清单；关闭处理时仍可读取与恢复。
- `POST /api/pdf/imports` multipart file，202（新）/200（复用）→ `{book_id,title,author,source:"pdf",chapters:[{doc_id,title,word_count}],pdf:{...},reused,notice}`。登记先完成，关闭面板仍存在。256 MiB 初始上限与旧格式20MiB分开；无模型也登记原件。
- `GET /api/pdf/books/{book_id}` → `{book_id,title,pdf:{...},chapters:[...],task}`；准备 route `#/pdf/{book_id}` 等真正首范围可读，再进入旧 Reader。
- `GET /api/pdf/books/{book_id}/source`：原件按需 Range 读取；PDF.js 沿用本地6.4.299及资源，原版可见由渲染完成证明。
- `GET /api/pdf/books/{book_id}/assets/{task_id}/{asset:path}`：仅登记存在的 PNG/JPEG 等，同源；更新后的 block.asset_url由后端生成。
- `POST /api/pdf/books/{book_id}/operations` JSON `{action,engine?,start_page?,end_page?}`，action convert/pause/resume/cancel/recognize；识别默认只针对主动选定原页或区域，region未实现则清楚表达实际原页范围，不暗中扩大整书。返回 `{book_id,pdf,task}`。再识别保留旧可读版本，只有新范围完成才准备替换。
- `POST /api/pdf/books/{book_id}/lifecycle` JSON `{action:"recycle"|"restore"}`，停止未来任务/阻止迟到复活，恢复保留内容且未完成任务保持暂停。
- 处理开关来自 plugin_flag(pdf)：关闭停止后续处理，原件、阅读版、记录与 source查看仍可用。

来源对象使用 `{page_number,bbox:[x0,y0,x1,y1],width,height,coordinate_space:"rotated_crop_top_left",rotation?,crop_box?,book_id?,source_sha256?}`；bbox是固有旋转后CropBox左上角points，1起始原页。UI必须核对几何、缩放/额外旋转及实际可见区域。读者主动核对原版保持原文锚点，返回原位；右侧仍留给选区译文。

主控扩展 Anchor 可选 `kind:"text"|"image"`、`pdf_source`，旧字段/请求兼容。原图笔记保留图像来源与旧引用；不能匹配新对象时保留旧资料，不只用重复quote的第一次出现猜位置。普通发音/翻译/语法仅处理原文文字，图片没有假朗读/假文字。

## 页分片 CLI 契约

旧CLI默认v1保留，用 `--sharded` 开启新存储，`--resume` 重启同一原件/引擎/范围的未完成单元。每页在 `pages/p000001.json` 原子保存，原页内部结构沿用v1。`result.json` 为 schema_version=2 的轻量索引，含原件sha/设置身份、页数、范围、metrics/warnings与 pages:[{page_number,page_path}]。不累计复制所有文本/字形。

stdout每页真实完成后发 `{event:"page_completed",page_number,page_path,result_path:"result.json",...}`。后台验证并发布此页，保存轻量已发布索引；读取/资产验证只取所需页文件。resume校验原件/处理配置，只跳过已完整写入的真实单元，保留原进度，不把skip页伪造为新完成。v1历史产物仍可读取。本机模型默认离线，零付费、保留初始累计预算；大规模下载由转换会话独占。

## 静默更新与真实纸面

系统只在当前无选区/词卡/笔记编辑/翻页/手势和面板输入时应用已发布新内容；保留r.position，刷新canonical doc/reflow再恢复，禁止伪造UseNew确认步骤。前端read hook不能跳转/重建当前阅读器来制造状态更新。当前已转换篇章未变时不重排。

分页必须按图片尺寸测量，在可用页内完整显示必要对象；不能因img decode迟到改页。主控在翻页序列化时内嵌实际图像像素（同源、受限、缓存）；保持现有DPR、24M像素/6纸面守卫及已接受的薄纸/装订/手势几何，不改shader模型来掩盖缺图。

## 交付检查

先记录空闲EPUB与已转换PDF同环境基线，再运行真实OCR/转换时配对测量，禁止把与模型下载重叠的旧记录当新空闲基线。功能以直接点击贯通导入→书架→专注阅读→词卡/保留词注→选区译文/语法→笔记CRUD/撤销→书签/续读→字号/单双页/光影翻页→来源核对/返回→任务/重启/恢复。

使用可核对公开真实英文PDF（数字/扫描/结构），合成素材只验证边界/故障。应用AI流程可用明确模拟供应商核查输入范围/缓存/重放，不称实际模型质量或计费通过；本轮不主动调用用户付费凭据。实际TTS能力用本地可运行路径核查，物理扬声器/真实触控接触仍须分清证据。临时浏览器文件选择限制不扩权：明确HTTP准备与文件输入操作区别，先完成可做的真实路径，最后给准确遗漏。

主要体验交付前主控 review 并修复必要项；不给用户再次验收技术验证台。源码、首次失败、修复后操作/截图、原始数字、样本sha和可复现命令都保留在新的证据目录。全套E2E不作为开发过程默认动作，不新增事后单元测试。
