# PDF 界面开发状态

2026-10-08，PDF 界面会话。本轮 Omarchy 所有权为 importer/pdf/pdf-import-progress 三个插件及本文，依主控最新派发与 docs62；此前 Reader 整合见 docs60，原型与独立证据保留。

## Omarchy UI 接入（2026-10-08，已实现；待主控走查）

本轮只接入 `web/plugins/importer.js`、`pdf.js`、`pdf-import-progress.js`，保留主控已有上传进度/outline 改动；主控负责 API 和唯一浏览器走查。已读 docs62 的失败清单与外部处理 ADR。566 页 ≤180 秒和准确度属于待实测目标，界面不宣称通过。

实施前失败清单：选文件即上传而处理位置尚未可选；capabilities 慢/断连/缺字段将远端误报可用；adapter 顺序使 Omarchy 自动成为默认；用户选择远端后请求却发 auto；普通 EPUB/TXT 携带 PDF 参数；关闭重开面板接收旧 capabilities/上传回执；上传途中改选择造成回执与实际位置混淆；Omarchy 不可用挡住本机原件登记；重复导入复用原任务却显示新选择的位置；暂停任务 resume 被误改引擎；未知引擎或远端任务被标本机；任务失败被可读页数掩盖。按这些路径做静态核对，并交主控真实浏览器复验，不写单元测试或整套 E2E。

共享源码原始快照保留在 `outputs/pdf-ui-omarchy-20261008/before-*`。本轮实现：

- 导入弹窗在文件选择控件上方立即显示 PDF 处理位置，默认 `auto` 当前电脑，明确可选 `omarchy`。capabilities 提前读取，Omarchy 仅 `available === true` 时可选；缺失、未知、失败、8 秒超时均显示原因和重查入口，当前电脑入口独立可用。选择 Omarchy 提示“在你的 Omarchy 上识别，无付费 API”，并说明选择 PDF 后发送整份文件到该服务器；无第二确认。
- PDF multipart 追加 `engine`；EPUB/TXT/Markdown 仍走原 `/api/import`，不携带 engine。上传期间锁定位置与文件控件；原 scope 隔离迟到能力/上传响应。处理位置不持久化到下一次重开弹窗。
- `reused` 回执明确保留原任务位置，不把本次选择冒充实际处理；补 PDF 处理入口 `#/pdf-status/{id}`，由用户在已有书面板显式选择新任务。回收恢复仍只恢复资料。
- `pdf-import-progress.js` 根据真实 task.engine 显示位置：auto/digital/docling 是当前电脑，omarchy 是你的 Omarchy，未知字段显示位置未确认；保留原来的单书共享订阅/轮询代码，增加真实失败原因展示。不因选择项或已有可读页数宣称本轮 Omarchy 已执行或已准确识别。
- 准备/Reader 处理面板给新任务默认 auto 的明确选择，Omarchy 不可用/缺失/未知引擎显示原因；convert/recognize 使用当前选择及明确原页范围。resume 仅继续原任务并标明原位置。请求期间统一锁定操作，防止重复提交；原任务状态与新任务选择分开。

三个插件的 `node --check` 与分配路径 `git diff --check` 全部 exit 0，三个当前源码没有行尾空白。独立只读复核 importer/progress 增量未发现可行动问题；这只证明源码静态核对，不是浏览器或引擎验收。正式检查结果与源码 SHA 见同目录 `final-checks.json`；可复现命令和主控浏览器路径见 `README.md`。浏览器应覆盖 auto/Omarchy 请求参数、缺失/不可用/超时、EPUB/TXT、重复导入不换引擎、关闭重开隔离、已有书切换及原引擎 resume。566 页计时、OCR 准确度、远端实际可用性仍待主控与转换会话实测。

## 上一轮 Reader 整合结论

本轮现有 Reader 界面贡献已实现，可供主控集成与 18876 真实点击走查；所有权以 docs/60-pdf-reading-integration.md 为准。只修改 pdf/importer/library/notes/notes-store 插件与 style.css 新增 PDF 样式、本文；原型与证据保留，18866 不再作为用户体验交付。18876 由主控/走查启动，本会话不操作浏览器或服务，不宣称整体验收已完成。

整合前失败方式：处理开关关闭不能卸载已有原版查看与图片记录；准备占位篇章不能伪装就绪；多页状态不能触发旧书 reflow；选择/词卡/笔记/输入/翻页时更新必须延后；图像不能作为 U+FFFC 被翻译/朗读；旧图像引用须保留 asset/source 身份，跨转换不能按重复文字首个匹配；来源弹窗 dispose 必须取消旧页渲染并保持原 Reader；导入关闭/重开与图像笔记 autosave 不依赖面板存在。首开 null 与 125%+90° 视口失败的防护继续沿用。

主控已接线（本会话未改这些文件）：PluginHost/catalog 的 always_readable 让处理关闭后保留 PDF 前端读能力；typed Anchor.pdf_source 保留 source/asset_url/conversion_task_id 等旧引用身份。现有 r.tool 非 primary 自动放在“更多”，没有另建 toolbar。

插件使用 image selection id `pdf-source`，提供 `r.notesController.addImage(block)` 与 `r.pdfTools.openOriginal(source, anchor)`。pdfCanRefresh 忽略该 refresh 自己设置的 restoring，但检查真实 selection/popover/note/panel/input/turn/pointer/dialog；主控在 nextDocument 提交前再次调用守卫，防止轮询请求期间才开始的交互被替换。

主控现已接上 pdfBackground/nextDocument 与返回 false 的守卫；插件传入已取得的 current canonical doc，避免重复 GET，false 时不标已应用。version 未变时仅更新 doc.pdf/chapters，保持连续跨范围导航，不 reflow。typed PDFSource 的 object_id/revision/conversion_task_id 已对齐，null conversion_task_id 在发送前省略。

渐进导航补充：poll 取得 next canonical doc 后现已统一调用 `r.refresh(density,{pdfBackground:true,nextDocument:doc})`，即使 version 没变也走主控 metadata-only 分支，由 Reader 更新 pdf/chapters；删除插件直接修改 metadata 及重复 restore 的分支。只有 refresh 明确返回 true 且 doc.version 确实为当前已应用版本，才推进 seenRevision；false/过时代次会在空闲时重试。reading_revision_applied 仅实际 version 改变时发出。语法与 diff whitespace CLI 已通过；相邻范围追加/未转换 gap 仍由走查实际点击验证。

图片选区书签 action 已由主控统一为旧 id `bookmarks`（本会话只读核对）；文字选区原菜单保持，没有添加重复 alias。图片点击浮层也有真实书签动作。

准备 route 已补真实 caps 控制（无首范围时也可开始/暂停/继续/取消），与重新识别原页的 Reader 面板分开；回收后进入同书 `#/pdf/{id}`，提供持久后端状态的恢复动作与原版核对，不自动继续取消/暂停任务。原件登记关闭开关时仍保留，host always_readable 已由主控实现。

回收清单补充：新增 route `#/pdf-recycle`，读取新冻结接口 `GET /api/pdf/recycle → {books:[...]}`。恢复按钮即时显示“恢复中”，仅调用同书 lifecycle restore；成功后显示后端实际 task 状态、“已恢复”与“回到书架”链接。不发 convert/resume，不要求额外用户确认。404/断连明确表示清单未读，不画成空清单；切路由后的迟到响应不改新页面；刷新与同书重复恢复串行隔离。由主控在 home 模板加书架入口，always_readable 保证处理关时路由仍可恢复。新后端接口上线、书架入口与跨重开真实恢复仍待走查。

主控现已在侧栏添加回收站入口（本会话未改 index/app），当前 plugin route 已就绪。清单读取期间禁用旧恢复按钮，防止刷新/恢复竞争覆盖“已恢复”状态。canonical GET 也新增 doc ID/density/Reader.generation 快照，返回后任一变化即丢弃，不让旧请求覆盖前台 refresh 后的新 chapters/pdf。

生命周期重复导入补充：imports 返回 pdf.lifecycle=recycled 时，在现有回执中显示原归属在回收站与“恢复书籍/查看回收站/关闭”，不使用保留的 reading_doc_id 直接读，不显示为新上架。恢复仅一次 lifecycle restore（无 convert/resume、无额外确认），关闭回执不取消已派发恢复；结果迟到时不改被复用的面板。准备 route 原本已有 recycled 判定与单书恢复，不自动进 Reader。

library home hook 已并行读取活动书架与回收 API，将回收书籍全部 chapters.doc_id 加入 chapterIds，并从同一 view.documents 数组原位排除这些已知回收范围（核心归档分支不检查 chapterIds，故此窄过滤必需）。没有改 app，也没有删存储文档；library 关闭不装此 hook，旧行为保持。回收 API 失败/无效只记录 pdfRecycleUnavailable，活动普通书架保留，不据此声称回收清单为空。已回收 book 元数据即使含 reading_doc_id 也进入状态/恢复路径。

静态复查对主控 Reader 的两项建议（不跨界修改）：`await draw()` 后及 restore 后再核对 scope/generation；finally 的 rAF 回调内部再次核对 scope/generation 再清 restoring，避免过时回调清掉新刷新状态。语法 CLI 不能替代这些等待中的实际交互复验。

跨篇章/全局笔记的 image jump 在目标 PDF read hook 先核对旧对象来源/asset；无法对应时消费旧 jump 并在 Reader 就绪后核对保存的原页，避免凭相同 block ID 跳到替换图像。图像笔记编辑/保存保留原引用快照，删除请求完成后的 UI 操作均增加原 scope 守卫。

PDF 文字笔记 resolved 也已核对 source_sha256、原页与 bbox(.1pt)：仅唯一对应且原 start/end 的 quote 精确吻合才生成正文标记，缺来源/多重对应/改字保留旧引用并由主控 r.restore/PDF source 核对。不按 ordinal 或首个重复 quote 猜测。

本轮实现路径：

- `web/plugins/importer.js`：原添加阅读入口接收 PDF（256 MiB），旧格式继续原 API/20 MiB；登记后独立刷新书架，不点开始阅读也保留，关闭/复用面板隔离迟到 UI。
- `web/plugins/library.js`：source=pdf 或 book.pdf 一个卡片，实际 reading_doc_id/就绪章节才进入 Reader；原页范围标题与旧阅读页编号分开。
- `web/plugins/pdf.js`：read hook 仅装 PDF 行为；准备 route、原版来源 modal、双轴/实际几何可见、图像三动作、更多/PDF 处理、局部原页识别、任务实控、回收与单书恢复、安全版本更新；仅动态加载本地 PDF.js 6.4.299，无 CDN、无付费图像增强假结果。
- `web/plugins/notes.js` / `notes-store.js`：公开 addImage 与 source 引用，图片缩略图/原页；原 autosave/CRUD/undo/正文标记/底部入口保持，图像保存不会把 U+FFFC 当引文文字；队列捕获旧引用快照。
- `web/style.css`：仅末尾新增 PDF/来源 modal/图片笔记样式，旧正文、chrome、翻页/trackpad CSS 未重写。

CLI 证据目录 `outputs/pdf-ui-integration-20261008-01/`：五个 JS 的 node --check、分配文件 diff whitespace、source SHA256、PDF.js local module/worker/LICENSE 存在性。无新增 unit/E2E、无 full suite、无 commit/push；CLI 不等于浏览器通过。

cli-02 及后续 cli-03/04 的语法与 diff whitespace 均 exit 0；manifest 包含对应源码 SHA。显式 pdf.reading_doc_id=null 时 importer/library 不再回退到任意有 doc_id 的章节，避免空占位误入 Reader。实现可供 18876 接线走查，真实点击前不宣称这一轮用户体验已交付。

本轮最终贡献已收尾：`cli-05-final-contribution.json` 保存五个 JS 的当前 SHA 与语法、分配 diff whitespace，全部 exit 0。新增回收清单、重复导入已回收原件的恢复、library 归属过滤，以及 PDF 文本/图像笔记保留来源均已实现；metadata-only 统一经 Reader；处理关时由 always_readable 保留读/恢复入口。主控可在后端就绪后重启 18876 交唯一走查会话操作。本会话未扩到其他文件、未运行浏览器/新 tests/fullsuite、未动个人库或 8766、未 commit/push。

主控/走查需覆盖：正式添加阅读 PDF 文件选择、关闭回执后重开同书、准备页无首范围时继续任务、阅读选择/词卡/译文/语法/发音、图片记一笔 autosave/编辑/删除/撤销与图像书签、125%+90° 来源区域可见与原位返回、重识别中新旧引用/交互冻结、追加篇章连续翻页、处理关闭仍读、回收恢复与重开。公有真实材料/扫描/OCR质量/性能由其他会话负责；本会话没有替代其验收。

以下为上一轮隔离贡献记录，未作为正式体验交付。

实现已可供真实走查；仅贡献 T01 隔离闭环，不表示 T01、T06 或正式 PDF 接入已完成。浏览器由走查会话操作。本会话不改正式 reader、个人资料库和 8766 服务，不发布或关闭 issue。

2026-10-08 集成重试：主控转来真实 UI 首开失败 `Cannot read properties of null (reading 'text_offset')`。已修复 captureAnchor 空选区/无 block 的判断：必须先有选区和有效 block 才读取偏移。`node --check web/prototypes/pdf-lab/app.js` exit 0；尚未由本会话声称真实 UI 重试通过。走查首失败保留原目录。可立即重试全新无续读数据的书籍首开、阅读→原版→返回和返回书架。

当前 `/result` 请求已使用 `start_page/end_page` 获取当前原页 ±1，key 包含范围；缓存至多六个近邻原页。页跳转重新取所需范围，不取全书。supported_actions 与 asset_url 已对齐主控补充。

第二处真实来源失败由主控转来：125% + 90° 时高亮在横向视口之外，旧实现仍记录 source_highlighted=true。已修复双轴滚动定位；原页容器用 block + auto margin，超宽页从可访问的左边缘滚动；滚动后再等一帧核对高亮与实际滚动视口相交。只有相交时显示“已显示来源区域”且 metric=true。来源 points/旋转不改写。`node --check` exit 0；需由走查会话重试原 125% + 90° 场景，保留其第二失败。

静态复查补充已处理：首次自动选择/恢复仅在用户尚未切视图或跳页时执行；范围加载中、读取失败与实际空范围分开；异步锚点恢复完成前不覆盖续读；字符偏移按同一转换 task 恢复；pagehide/pageshow 为浏览器 BFCache 返回重建订阅。以上是代码/CLI 核对，不宣称浏览器场景通过。

## 已读取的约束

AGENTS、docs59 所有权/实验 API、GLOSSARY、domain 入口、docs55 开发契约、全部 PDF ADR、docs56 失败分类、T01/T06/T09 草案及 GitHub #1 正文/评论（只读）。沿用暖白/深绿、阅读版为主、原版按需核对。阅读版保留原生文字选择；右侧留空给后续选区译文。不增加假转换、假结构和无后端支持的任务动作。

## 实现前风险与处置

- 上传关闭/响应丢失：书籍归属由服务持久化；关闭面板不取消后台转换，响应未知时刷新书架核对，不自动重发。
- 切书、页跳转和缩放的迟到响应：请求代次及 AbortController 隔离；PDF loading/render 取消并校验当前书籍/页代次。
- Canvas 出现但未画完：分别记 original_requested、original_canvas_rendered 与 original_visible，实际渲染完成并接入可见 DOM 后才记可见。
- 原页/印刷页码/阅读页混用：实验按原页范围导航，明确标注，不编造目录或重排页码。
- 来源旋转/裁剪错绑：仅在结果页宽高与 PDF.js 的原页可见尺寸吻合时映射左上角 points；否则显示无法可靠定位。来源坐标不会用文字首个匹配猜测。
- 阅读版缺页、缺资源及无结构字段：真实部分结果单列；公式/表格未含可靠结构时不称识别成功；资源 URL 未提供时明确暂不可用并提供原版核对。
- 当前文字选择被轮询替换：当前页内容签名不变不重建 DOM；选择/指针交互期间延迟已有结果应用。
- 原位返回/字号改变：保留 block ID/原页与可见偏移，原版不销毁阅读 DOM；恢复对应 block，不凭阅读页码猜测。
- 引擎不可用/模型未准备/后端断连：分别显示真实 capabilities、任务 error 和请求错误；不把缺模型称为文件损坏。
- 超大原页/高缩放：有界单 Canvas，保留实际 DPR，超过像素预算明确要求缩小，不静默降清晰度。

## 实现与接口对齐

- 唯一入口 `http://127.0.0.1:18866/static/prototypes/pdf-lab/index.html`；后端启动方法 `python3 scripts/pdf_lab_server.py start`，本会话没有启动/停止服务。书架、导入、视图、来源、任务详情均调用真实 API，无 mock 文档。
- 按 docs59 补充的 supported_actions 决定 convert/cancel/pause/resume 是否呈现；asset 只使用服务返回且属于当前 book 的同源 asset_url。没有 URL 时明确暂不可用，不猜地址。
- 结果页必须声明 rotated_crop_top_left，并与 PDF.js 可见尺寸、可用 crop_box/rotation 核对后才画区域。新增用户旋转只影响视图坐标。不同 conversion_task_id 不自动认为旧 block ID 可映射。
- 阅读版请求当前原页 ±1、缓存最多六页；原版按需 getPage，单 Canvas 上限 16M 像素，保持实际 DPR。阅读文本、fallback DOM、真实图片加载可见及原版 Canvas/可见事件分开。
- 测量事件可在详情中导出 JSON，或使用 window.pdfLabEvidence.snapshot()；不包含文档正文。完整可复现步骤见原型 README。
- PDF.js 固定 **6.4.299**（[官方发行](https://github.com/mozilla/pdf.js/releases/tag/v6.4.299)），Apache-2.0 LICENSE 保留，worker/CMaps/字体/ICC/Wasm 全部本地。官方 zip SHA256 `f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d`。

未覆盖：正式阅读器接入、完整 T06 原型、笔记/书签、付费增强、存储/回收、复杂公式/表格结构、跨转换迁移、旧 WebGL/触控板、OCR 质量/性能和用户验收。右侧只保留空间，没有假译文；不把当前轻量转换结束称为已校对。

## 证据

本会话 CLI 已通过：HTML 77 个 ID 唯一，JS DOM 引用均存在；app、PDF.js display 和 worker 的 node --check 均 exit 0；18866 的 HTML/JS/CSS/display/worker HTTP 200，JS MIME 正确，线上资源字节与保存源码一致。205 个 vendor 文件共 14,055,752 字节与官方 zip 内容逐字节一致。

独立证据 `web/prototypes/pdf-lab/outputs/2026-10-08-ui-cli-01/` 包含官方 archive、vendor-sha256.json、cli-checks.json、cli-final*.json 和 commands.md；这是语法/资源证据，不替代 UI 验收。未新增单元或 E2E 测试，未跑 full suite。真实浏览器首失败、第二失败与源码快照保留在走查会话 `outputs/pdf-walkthrough-20261008-0844/pdf-integration/`。

最终代码已可真实复验；本会话不操作浏览器，没有自行宣称重试通过。主控可按 README 的首开/无续读、导入关闭、50页以后导航、125%+90° 来源/原位返回、选区/切书竞态路径安排走查。
