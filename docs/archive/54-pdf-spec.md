# Wise Reader — PDF 一期规格

日期：2026-10-08。产品对齐和浏览器 E2E 的主验收 seam 已确认；项目已配置 Coraia/EasySink GitHub Issues，规格发布标签为 ready-for-agent，发布身份与核对结果在项目交付台账中记录。本文没有宣称 PDF 功能或转换验收已经完成。

## Problem Statement

中文读者希望在 Wise Reader 阅读英文书籍和学术材料，沿用按词汇水平提供理解辅助、选区翻译、语法分析、发音、笔记、书签、续读与真实纸张翻页。当前导入只覆盖 EPUB、TXT 和 Markdown，PDF 原件尚不能形成这条阅读路径。

PDF 可能包含印刷体扫描、乱码文字层、多栏排版、公式、表格、图片、脚注和混合语言。仅转换成一串文字会丢掉结构或错序；仅显示 PDF 原页又无法直接获得可重排的理解辅助。长时间转换还可能干扰已有阅读性能。读者也不希望因为识别失败就被自动外发整本文件、重复支付模型调用费用，或因重新识别和清理缓存而丢失阅读记录。

## Solution

一份 PDF 保留一个书籍条目和原件，提供两个互相定位的视图：阅读版是沉浸式主体验；原版是查看排版、放大和核对来源的入口。原件成功接收并校验后即进入书架，原版可用、转换中、阅读版就绪范围和全书完成分别表达，允许先读已完成并检查通过的内容。

默认在当前电脑处理英文数字 PDF 与印刷体扫描件；混合语言分别验收。可靠识别的内容进入结构化阅读版，未可靠识别的公式或表格在对应位置保留局部原图，严重乱码或错序范围保留原版核对与重新处理入口。阅读优先，转换可节流或暂停。新的有效结果在安全时机静默应用，保持来源位置和阅读记录。

首期外部增强仅提供用户主动选定页或区域的处理。含义明确的操作本身完成授权，不追加授权或费用确认。结果复用、本地重放和重新生成分清；结果未知的付费请求不自动重发。重要资料默认不按期限删除，调用与费用可查看，并提供可选调用次数上限。

首期默认接入一套经同条件实测选出的本机主转换流水线，复用开源组件并保留可替换接口。手动纠错为备选，未自动纳入本规格的交付范围。转换质量或既有功能/性能不达标时，不进入正式版本。

## User Stories

1. As a Chinese-speaking English reader, I want to import PDF books, so that I can read them with my existing understanding aids.
2. As a reader, I want digital PDFs to retain their reading order, so that extracted text preserves the author's argument.
3. As a reader, I want printed scanned PDFs to be recognized locally, so that image-only books can become readable text.
4. As a reader of academic books, I want mixed-language passages to have separately assessed quality, so that English results do not conceal errors in other languages.
5. As a reader, I want PDF available in the existing import entry, so that I do not need a separate document management workflow.
6. As a reader without configured AI, I want local PDF import to work, so that external credentials are not a prerequisite for reading.
7. As a reader, I want a validated import saved before I click Start Reading, so that leaving the import screen does not lose my book.
8. As a reader, I want one PDF represented by one book, so that its pages and chapters do not clutter my bookshelf as separate books.
9. As a reader, I want identical reimports to reuse the existing book and task, so that I do not create duplicates or repeat paid processing.
10. As a reader, I want different files with the same name kept distinct, so that the wrong original or results are not reused.
11. As a reader, I want to view an available original before conversion finishes, so that I can inspect the document promptly.
12. As a reader, I want honest conversion states and progress, so that a rendered original is not mistaken for a finished reading edition.
13. As a reader, I want to read validated converted ranges while remaining work continues, so that I do not wait for the entire book.
14. As a reader, I want unfinished or rejected ranges clearly identified, so that missing content is not silently presented as a complete book.
15. As a reader, I want the reading edition to open in focus mode, so that processing controls do not interrupt the text.
16. As a reader, I want responsive single-page and double-page layouts with my existing page-turn animation, so that PDF-derived content feels consistent with other books.
17. As a reader, I want clicks, keyboard navigation, pointer dragging and trackpad gestures to retain their behavior, so that importing PDF does not change how I turn pages.
18. As a reader, I want font, spacing and assistance preferences to apply to the reading edition, so that the source format does not dictate my reading layout.
19. As a reader, I want dictionary glosses and actively requested context explanations, so that I can understand words without automatic full-time AI use.
20. As a reader, I want selected translations linked to their source and grammar expanded inline, so that understanding aids remain connected to the passage I am reading.
21. As a reader, I want pronunciation and paragraph playback at the existing entry points, so that PDF does not add a duplicate player below the text.
22. As a reader, I want figures and their captions preserved, so that extraction does not remove information necessary to understand the text.
23. As a reader, I want formulas preserved as reliable structure or a faithful local original image, so that mathematical meaning is not replaced by plausible-looking text.
24. As a reader, I want tables to retain meaningful headers and cell relationships, so that reflow does not turn data into misleading prose.
25. As a reader, I want unreliable formulas and tables shown at their original reading position, so that I can continue without repeatedly opening another view.
26. As a reader, I want severe garbling or column-order errors withheld from ready text, so that failed conversion is not presented as trustworthy content.
27. As a reader, I want image fallback distinguished from successful recognition, so that quality summaries remain honest.
28. As a reader, I want a passage or image to locate its original PDF page and region, so that I can check its source quickly.
29. As a reader, I want source highlighting to remain correct after zoom and rotation, so that the highlighted evidence matches the selected content.
30. As a reader, I want returning from the original to restore my source position, so that checking a formula does not lose my place.
31. As a reader, I want to reprocess a selected page or region locally, so that a local recognition problem does not require importing the book again.
32. As a reader, I want to choose external enhancement for selected content, so that I can improve a difficult region deliberately.
33. As a reader, I want the processing operation to show its service and complete sending scope, so that selecting one region does not silently send the entire book.
34. As a reader, I want local failure to remain local until I choose external processing, so that configuration alone does not authorize document transmission.
35. As a reader, I want unsupported model input explained before sending, so that a text-only model is not treated as a working visual recognizer.
36. As a reader, I want the processing action itself to authorize the selected work, so that repetitive consent or fee popups do not interrupt reading.
37. As a reader, I want existing matching valid results reused, so that requesting the same enhancement does not repeat a model call.
38. As a reader, I want local replay to rebuild from retained responses and intermediate material, so that rebuilding does not require another paid request.
39. As a reader, I want missing replay material reported, so that a rebuild action does not secretly become paid regeneration.
40. As a reader, I want regeneration clearly distinguished from replay, so that I know when my operation can create a new charge.
41. As a reader, I want sent requests with unknown results kept unknown, so that a timeout does not cause automatic duplicate payment.
42. As a reader, I want existing results recovered or queried when supported, so that request uncertainty can be resolved without blind resending.
43. As a reader, I want call, usage and cost information in task details, so that I can inspect processing without a persistent billing banner.
44. As a reader, I want an optional limit on new PDF paid requests, so that I can control volume without entering a budget for every task.
45. As a reader, I want that limit to pause unsent work and permit a clear continue operation, so that exceeding it does not require another authorization dialogue.
46. As a reader, I want PDF limits separate from existing reading AI, so that conversion settings do not unexpectedly block translation or explanation.
47. As a reader, I want unknown costs and estimates labeled honestly, so that they are not mistaken for zero cost or a settled invoice.
48. As a reader, I want text notes to preserve their source, so that extraction changes do not sever my ideas from the book.
49. As a reader, I want notes on figures, formulas and table images, so that recording an idea does not require reliable OCR text.
50. As a reader, I want to add, edit, delete, undo and locate image notes, so that their lifecycle matches existing reading notes.
51. As a reader, I want bookmarks and resume positions based on source locations, so that font or window changes do not move them to another passage.
52. As a reader, I want new conversion results applied quietly at safe moments, so that I do not manage versions during ordinary reading.
53. As a reader, I want a held page turn, selection, note draft and active understanding aid kept stable, so that background conversion cannot replace content under my interaction.
54. As a reader, I want ambiguous record mappings retained with their old quotation and source location, so that the system does not guess and attach my note elsewhere.
55. As a reader, I want the original view to remain open until I leave it, so that completed conversion does not switch my view unexpectedly.
56. As a reader, I want reading to take priority over conversion, so that background work does not make older books slow or blurry.
57. As a reader, I want conversion tasks to survive book switches and browser closure, so that leaving a page does not discard progress.
58. As a reader, I want pause, continue and cancellation to retain completed content, so that controlling a task does not erase readable results.
59. As a reader, I want restart recovery to preserve task settings and scope, so that it does not switch providers or revive cancelled work.
60. As a reader, I want deleting a PDF book to stop future work and prevent late results from restoring it, so that my bookshelf follows my actions.
61. As a reader, I want a deleted book recoverable with its records and valid results, so that accidental deletion does not require reimport or payment.
62. As a reader, I want restored unfinished local work left paused, so that restoring a book does not immediately consume reading resources.
63. As a reader, I want originals, records, valid results and replay material protected from ordinary cache cleanup and default expiry, so that cleanup does not destroy reading history.
64. As a reader, I want disk pressure to free rebuildable resources or pause new work, so that important material is not silently deleted.
65. As a reader, I want explicit storage cleanup to name the material it releases, so that the action has a clear consequence without additional consent screens.
66. As a reader, I want disabling optional PDF processing to preserve existing material, so that experimenting with features does not delete my library.
67. As a reader, I want existing EPUB, TXT and Markdown flows unchanged, so that PDF support does not regress previously accepted features.
68. As a reader, I want whole-book reading traces to retain their original records, so that AI review does not replace my notes or quotations.
69. As a reader, I want local model preparation distinguished from document processing, so that downloading a model is not described as uploading my book.
70. As a reader, I want actual conversion and reading performance verified before release, so that a working demo is not mistaken for a reliable product.

## Implementation Decisions

本节把已接受的产品规则落实为开发约束；模块、存储与 interface 是本规格提出的实现安排，尚未编码或运行验证。候选引擎、模型与发行版本须经比较决定，不假定其能力已经满足约束。

### Module 与 Interface

1. 新增深的 PDF 内容处理 Module，统一承载接收原件、任务、结果版本、来源定位、重放及付费尝试记录。其外部 Interface 只暴露导入、查询可阅读表示和明确的业务操作；引擎细节不散入书架、笔记或翻页调用方。
2. 在现有书架、阅读器、结构内容与插件启停 Interface 上做增量接入。已有 EPUB/TXT/Markdown 的请求和响应语义保持兼容，不将同步导入扩成等待整本 OCR 的请求。
3. PDF 任务独立于已有文本 AI 队列，未配置外部 AI 可运行本机任务；转换耗时、暂停或队列积压不能占住词卡、选区译文和语法请求。
4. 转换 Adapter 位于 PDF Module 内部的 seam。真实本机引擎与确定性故障 Adapter 满足同一 Interface；可替换不是默认安装全部候选。主引擎由相同材料、机器和质量规则下的比较选出。
5. 转换在独立进程中执行，短事务只提交元数据、检查点和完整结果；模型推理、图像编码与大文件处理不能占有用户资料库事务。浏览器页面关闭与 worker 生命周期分离。
6. 原版显示优先评估 PDF.js，作为来源查看 Adapter；其文字层不是扫描 OCR，也不自动等于逐词定位。若固定版本不能满足来源核对或资源要求，必须保留调查结论，不能以替代方案未经测试作为通过。

### 原件、结构与来源

7. 原件按文件实际内容确定身份，接收过程中计算摘要并做格式/可读取性检查，不能只依据扩展名、文件名或书名。两个并发相同导入也只能形成一个书籍归属；接收失败不留下假就绪条目。
8. 接收及校验完成后，原件、书籍归属、初始任务状态必须可恢复；原版就绪是可实际显示来源页，不是 OCR 全书完成。模型准备有独立状态，缺模型、空间或不支持文件时说明具体原因而非统称损坏。
9. 引擎输出直接适配结构化阅读内容：段落、标题、列表、代码、图像/说明、公式、表格及必要的脚注关联，保留顺序与来源；不先压成普通 Markdown，再经丢图/扁平表格的旧解析路径回填。
10. 每个内容对象具有独立于可见文字哈希的来源身份，包含原件、PDF 原页/区域及可用字符对应；阅读页码与印刷页码不作为稳定主键。来源坐标约定统一，旋转和缩放需可逆映射。
11. 确保原文、词注、选区、译文及笔记使用一致的有效文字与映射。词典匹配可规范化连字，但引用和来源仍可回溯；不能直接丢掉希腊字母、上下标、负号或区分意义的标点。
12. 结构检查失败的公式/表格生成就地原图回退，保留原页区域入口；严重乱码/串栏/错序范围不发布为就绪正文。页数、完成数、就绪范围、拒绝范围与回退范围分开计数。
13. 没有可靠目录时保留有序阅读范围，不伪造章节结构，不把每个 PDF 原页建成一本书。跨页结构的内容顺序和来源关系必须明确，不能为凑页而丢掉表头或后半表格。

### 表示、版本与阅读记录

14. 新增原件资料、来源对象、不可变转换版本、版本映射、保留产物、转换任务/检查点、付费尝试/用量记录和回收状态。已有书籍、篇章及阅读记录 ID 保持兼容；新增关联采用扩展方式，不能通过覆盖唯一正文悄悄失去旧结果。
15. 每次转换版本提交完整可验证的内容范围，读者一次看到一致的文字、来源与记录映射。旧已读结果与当前结果区分，部分失败不得覆盖原有有效范围；每次发布校验书籍状态和版本代次，迟到任务不能重新上架或覆盖较新的结果。
16. 新版本在未显示范围可先生效；当前范围翻页、选择、编辑或理解辅助操作结束后再安全应用并恢复原文锚点。原版不自动切换为阅读版，不出现日常“使用新版”前置步骤。
17. 阅读版的原图笔记记录对象及来源区域，文字笔记记录文字与版本/上下文。可可靠映射时自动迁移，不确定时保留旧引用和原页位置；重复引文不能凭首个匹配就猜测。草稿、已保存笔记和 AI 回顾分清，不改写原始记录。
18. 静态正文和翻页纸面都从相同的当前表示生成。图像、表格与公式资源准备完成后才能声明对应纹理可用；不得直接假设原版 Canvas 能被正文序列化复制，也不得删除公式资源引用所需的标识。绘制资源采用有界缓存，硬件 DPI、书脊模型和输入收尾行为保持现有守卫。

### 任务、调用与资料

19. 任务区分等待资源/模型、排队、运行、暂停、部分完成、完成、失败与取消；阅读范围状态与付费尝试结果另行表达。重启只恢复允许执行的任务，沿用任务设置，不自动继续取消的工作或改换外部服务。
20. 阅读优先调度在进程、并发和页/区域工作单元上实施。阅读延迟超出守卫时节流或暂停新转换，不以降低硬件纹理清晰度、禁用原有理解辅助或无限延长翻页锁来换性能。
21. 外部业务操作选定服务、模型、页/区域和必要上下文，范围摘要在执行入口可见；输入能力校验失败不发送。首期不提供整本付费外部转换，不能自动从本机失败切换外部或扩大区域。
22. 有效结果复用按原件/范围、输入表示、处理设置和版本确定。保留响应与必要中间产物支持真正的本地重放，只有经本地格式与来源检查后才发布；缺资料返回明确状态，不自动发新付费请求。重新生成是单独操作。
23. 付费尝试在可能发出请求前持久记录意图并预留限额。可证明未发送的请求与可能已发送、已收到响应或结果未知的请求分开；崩溃后不能证明未发时按可能已发处理，不靠自动重试补偿不确定计费。服务支持结果查询/幂等才使用相应能力，不宣称应用能够保证供应商只计费一次。
24. 可选次数限额计数应用发起的新付费或费用未知的外部请求，不将供应商内部计费动作伪装成已知调用。并发预留防止突破已设次数上限；已发结果未知保留占用，确定未发可以释放。复用与本地重放不占次数；PDF 限额独立于已有阅读 AI。费用可靠值、估算和未知分别展示，凭据不进入响应或日志。
25. 暂停/取消阻止后续工作并保留已完成内容；在途返回可保存必要的尝试凭据与有效资料，但必须重新检查任务/书籍状态后才发布。删除书籍进入可恢复状态并使任务停止，恢复后未完成本机任务保持暂停；永久释放仅由明确清理操作进行。
26. 保留资料默认无按天自动删除，临时资源有容量预算并可本机重建。容量不足先清临时资源，仍不足暂停新工作并显示缺口；预留原件、响应和提交结果的空间，避免写满后只剩一个“成功”标记。
27. PDF 处理启停沿用插件管理，关闭后隐藏新处理入口并停止后续处理，保留已有内容和记录；正常清理、关闭插件与永久删除区分。已有格式的导入和读取仍可运行。

### 业务 Contract

| 操作 | 必要输入 | 可观察结果与约束 |
|---|---|---|
| 接收 PDF | 原件、显示元数据、导入意图标识 | 返回书籍和任务身份、是否复用、原版及阅读版就绪状态；不等待全书 OCR |
| 查询书籍表示 | 书籍、视图、来源锚点/阅读范围 | 按需返回当前范围、表示版本、来源和就绪状态；不能每次打开都传全书 |
| 查询任务详情 | 任务身份 | 返回范围、状态、已完成/就绪/回退/拒绝数量、调用/用量与费用类别，不泄露凭据 |
| 控制任务 | 任务、操作、操作意图标识、预期代次 | 暂停、继续、取消遵循状态和范围；重复送达同一次业务操作不能产生重复任务 |
| 局部重新识别/增强 | 明确原页或区域、处理方式、配置快照、操作意图 | 优先复用有效结果；本机与外部明确，必要上下文包含在所选范围描述内，不擅自扩展 |
| 本地重放 | 保留资料及目标范围/版本 | 仅本机重建；资料不足时明确不可重放，不隐式升级为新请求 |
| 重新请求 | 目标、处理配置、新操作意图 | 明确新尝试，可产生新费用；不会因界面自动重试重复提交 |
| 书籍回收/恢复 | 书籍和操作 | 读者可观察回收状态、记录保留、迟到结果隔离与恢复后暂停状态 |
| 资料清理 | 明确资料类别与书籍范围 | 返回已释放及仍保留的资料范围；普通缓存清理不能删用户记录或付费重放资料 |

HTTP 路由和持久字段在开发契约中细化；上述语义与失败行为是 Interface 的一部分。表中的“身份、范围、代次”不等于客户端可任意指定其他书籍资料。

## Testing Decisions

1. **主要验收 seam 已确认：沿用浏览器 E2E。** 从用户可用的导入、书架、阅读器、任务和设置操作开始，经真实本地 HTTP、持久化和渲染验证结果；不新增针对解析函数、SQL 行或私有 shader 方法的单元测试作为交付依据。
2. 测试对象是 PDF Module 的外部行为及与现有书架、阅读、来源定位、理解辅助、记录、任务和费用模块的组合行为。内部转换/供应商 Adapter 仅用于可重复复现等待、超时、故障与迟到结果，不另外建立低层测试体系。
3. 现有先例包括：导入异常与刷新重开、渐进分页中保持选区、跨排版续读/笔记/书签、外部模型可观察调用与无效结果处理、页纹理和 Retina 清晰度、原生 phase fixture 连续/取消/交替翻页。直接延续现有隔离服务、临时用户库和报告机制，不使用个人书库作为可变测试数据。
4. 好的测试断言用户可见内容、来源区域、完整记录生命周期、实际请求范围与次数、重启后恢复状态和测量值；不因内部调用次数、数组组织或类名改变而失败。原图可見、数据表存在和模拟通过都不能单独证明 OCR 正确。
5. 最终真实引擎验收须覆盖用户实际英文材料及有使用权的数字文字、清晰/低清扫描、多栏、公式、复杂/跨页表格、脚注和混合语言样本。独立建立参考文字/顺序/区域，对引擎输出做盲核对；不能让同一引擎同时生成答案与判定结果。
6. 来源与版本验收覆盖缩放/旋转、连字、重复引文、改字前已有记录、映射不确定、局部迟到结果、翻页/选区/笔记编辑时更新、跨书切换及删除恢复。不可靠定位保留资料并明确状态，不能只检查比例或页码近似。
7. 付费路径覆盖两个同时操作、达到限额、确实未发、发后丢响应、崩溃、服务无查询能力、迟到响应、复用、本地重放、缺重放资料及主动新尝试。模拟供应商的独立收件记录证明范围和次数；真实供应商兼容、用量与费用需另外验证，不能把本机收件数当准确账单。
8. 性能区分模型准备、接收校验、原版首屏、首个阅读版范围、已转换书籍重开与全书完成。沿用现有旧格式及翻页守卫，并比较无转换/转换后台负载；噪声容差在实验前由固定基线重复测量定义，不能在失败后放宽。
9. 鼠标/键盘与原生 phase fixture 验证可重复功能；Mac 真实触控板的接触停驻、松手、取消、连续/交替手感需真实设备记录，fixture 不能替代物理手感或指尖到屏幕延迟。
10. 如需隔离比较一个引擎，先写明乱码、错序、来源漂移、丢图、公式/表格失真、内存/空间峰值、不可取消和模型不可用等失败方式，再编写实验程序；优先仍从相同浏览器导入路径比较，保持最高 seam。
11. 开发中只运行当前纵向路径需要的目标 E2E；完整 E2E 仅在开发结束时运行。最后形成固定源码与依赖版本、样本/配置摘要、原始首次失败、HTML/JSON 报告、trace、截图、请求凭据和指标数据及复现步骤。
12. 所有一期必要场景必须通过，不用必要样本缺失的 skip 宣称完成。真实转换未验收、来源迁移未验收或旧功能/性能回归，均阻断正式发布。

## Out of Scope

- 整书中文翻译、自动整章翻译或为本功能扩建独立译本产品。
- 首期整本付费外部转换、因本机失败或已有 AI 配置自动外发材料。
- 默认部署三套完整转换环境、未经实测承诺某个候选主引擎或任意模型一定满足性能。
- 在原版复制完整查词、译文联动、语法和阅读笔记工具。
- 手动正文纠错编辑器或完整排版编辑器；轻量局部纠错仅为备选，是否引入另行决定。
- 任意语言、手写与所有低清扫描都拥有相同识别质量的保证。
- 供应商级精确金额硬限额、退款保证、在服务未提供支持时保证只计费一次。
- 默认到期清除重要资料、无限历史/磁盘容量、默默合并视觉相似但原件不同的书籍。
- 重建云账号、多用户或跨设备同步体系；改变现有登录及本机访问锁的产品范围。
- 本次规格阶段的模型安装、实际转换、付费调用、功能代码、完整 E2E、commit 或 push。

## Further Notes

- 用户于 2026-10-08 明确确认五轮共同理解，并要求进入 to-spec，随后再进入 to-tickets。现行决定来自 Q1–Q24，Q4、Q9、Q20 的初始提案不可替代修订结论；六份 PDF ADR 约束本规格。
- 对齐基线为提交 69f0fd0fe3b455a8be1e74d673fa06f78ba28d91；旧版验收记录与当前源码核对不是新增 PDF 的验收。上游候选仅有初步官方核对，固定模型、全部依赖许可及本机结果尚未形成。
- 源码静态核对显示现有同步导入、依赖 AI 的串行队列、按文字哈希的块身份、仅一份当前正文、可能选首个重复引文的记录恢复和正文纹理序列化，不能直接当作 PDF 已有能力。这些风险指导实现安排，本轮没有修改相应实现。
- 详细开发契约和验收计划作为本规格的配套文档维护。新增 PDF 的质量数值、资源/耗时预算、实际样本路径和供应商兼容结论必须在相应实验前冻结；未填写或未通过时不得发布，不让用户猜测技术事实。
- 用户显式调用 setup-matt-pocock-skills 并接受配置草案，已配置 Coraia/EasySink GitHub Issues、项目指令入口与单领域文档约定；triage 技能未安装，不建立五角色标签映射，to-spec/to-tickets 发布仍使用 ready-for-agent。发布规格后保存真实 issue 身份并读取核对正文与标签；创建 tickets 前还须确认其粒度和依赖。
- 用户已回答“是，按这个 E2E 入口设计”，接受上述主验收 seam。tracker 配置和规格发布后，to-tickets 按可演示的端到端纵向能力拆分，逐项声明真实阻塞依赖；先展示粒度与依赖供用户确认，再发布任务。此规格草案不自动授权创建全部 tickets，也不使任何开发任务已经开始。
