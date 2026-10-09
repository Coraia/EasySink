## Problem Statement

Wise Reader 已具备导入、沉浸式阅读、理解辅助、阅读记录和 PDF 渐进阅读的基础，但读者仍不能仅凭“已可读”判断正文是否完整、阅读是否连续、转换服务是否可用。既有成果中的模拟状态、历史性能、真实 OCR 和真人触控板证据覆盖范围不同，需要形成统一、可执行的 V1 收口依据。

读者关心实际打开速度、准确度和流畅度：跨 PDF 阅读版就绪范围应当像普通翻页；服务被切换或不可用时不能无反馈地等待；学术材料应能按需翻译术语和复杂句段，同时保留公式、图表和对应原文。识别更新、任务重启或调用失败不应丢失笔记、错绑来源或重复收费。

当前体验还依赖 Web 服务和开发环境。读者希望探索一个可安装、启动迅速的 macOS 客户端，保留已经打磨的阅读行为与高清翻页，而非为分发重新开发阅读内核。客户端技术路线和新增资源预算尚需原型实测，不能通过选择一个框架就宣称轻量、快速或已可正式发行。

## Solution

本规格是现有 [PDF 一期：本机转换、沉浸式阅读与来源核对](https://github.com/Coraia/EasySink/issues/1) 的 V1 收口补充，依据 [V1 收口最终决定](https://github.com/Coraia/EasySink/issues/24#issuecomment-6077370532)。保留原规格未被明确修改的产品语义、既有功能和 PDF-01 至 PDF-16 必需场景；更新真实材料、数值门槛、实际走查方式和最小客户端探索边界。它不另建一套 PDF 产品，也不以规格发布代替原有任务验收。

交付分为两个可分别取证的部分：

1. **V1 阅读收口**：沿正式用户入口修复并核验旧格式阅读、PDF 服务就绪与进度、正文质量、跨范围连续翻页、学术选区译文、来源与记录、任务恢复、局部识别增强及费用恢复；以真实材料、真实采用的服务和原始测量作结论。
2. **最小 macOS 客户端验证**：复用 Web 阅读核心，优先验证系统 WebView 承载。用户可以安装、打开书并使用基本词注，无需安装开发工具或运行终端服务；通过实际包体、启动、进程资源和真人手势证据决定后续分发方案。

主扫描材料改为用户指定的 **196 页英文扫描书**，原件及其私有路径留本机；新增固定版本 [arXiv:2609.36322v1](https://arxiv.org/abs/2609.36322v1)，用于学术论文的内容提取、选区翻译与对应交互。其余真实 EPUB、长书、TXT/Markdown、复杂排版和混合语言类别继续覆盖。普通正文的可选字能力、识别质量、原图回退和转换速度分别判断。

## User Stories

1. As a reader, I want to keep reading my existing EPUB books, so that PDF and desktop changes do not disrupt everyday reading.
2. As a reader, I want TXT and Markdown imports to keep working, so that simple materials remain easy to read.
3. As a reader, I want a successfully registered import to remain on my bookshelf before I start reading, so that closing the import panel does not lose it.
4. As a reader, I want identical PDFs to reuse their book and task identity, so that repeated imports do not create confusing copies.
5. As a reader, I want different files with the same name to remain distinct, so that one book does not overwrite another.
6. As a reader, I want to see whether the selected conversion service is ready, so that I know whether processing can start.
7. As a reader, I want service readiness checked again when work starts, so that a switched OCR model does not leave my import silently stuck.
8. As a reader, I want an unavailable remote OCR service to leave local reading and unrelated imports usable, so that one dependency failure does not block the product.
9. As a reader, I want real preparation progress directly visible in the import flow or on the bookshelf, so that I do not repeatedly open a separate status screen.
10. As a reader, I want original availability, readable ranges and full completion distinguished, so that a progress label describes what I can actually do.
11. As a reader, I want to read completed ranges before an entire book finishes, so that a long conversion does not prevent useful reading.
12. As a reader, I want a book with ready reading content to open that content at my saved position, so that I do not unexpectedly land in the original view.
13. As a reader, I want books to open in focus mode, so that the reading surface is the main experience.
14. As a reader, I want reading tools to respond to their whole intended interaction areas, so that I do not need to target small icons precisely.
15. As a reader, I want tool panels to leave the source text visible and return predictably to the reading tools, so that navigation does not interrupt orientation.
16. As a reader, I want a word card to scroll within its own content when appropriate, so that using it does not unexpectedly move the article underneath.
17. As a reader, I want retained annotations to remain independent of assistance density, so that adding one annotation does not remove another.
18. As a reader, I want a selected passage and its nearby action menu to be visibly connected, so that I know which text an action will use.
19. As a reader, I want context explanation to use my selected word in its passage, so that dictionary meanings are not presented as a confirmed contextual interpretation.
20. As a reader, I want translation limited to my chosen passage, so that help remains focused and does not turn the book into an automatic translation project.
21. As a reader, I want translated passages to correspond visibly to their source, so that I can move between the two without losing my place.
22. As a reader, I want the active translation correspondence distinguishable from the original selection, so that overlapping highlights remain understandable.
23. As a reader of academic papers, I want terminology, quantities, negation and qualifications translated faithfully, so that the argument is not changed by fluent but inaccurate wording.
24. As a reader of academic papers, I want formulas, code, captions and references to retain their relationships, so that surrounding translations remain interpretable.
25. As a reader, I want closing and reopening a translation to preserve my location and reuse a valid result, so that checking it again is quick and does not repeat work unnecessarily.
26. As a reader, I want grammar analysis available inline near the selected passage, so that it does not displace the translation area or main text.
27. As a reader, I want word and passage pronunciation available from their existing controls, so that listening does not add a redundant player beneath the text.
28. As a reader, I want ordinary scanned body text to become selectable and correctly ordered, so that I can use understanding aids rather than merely view page images.
29. As a reader, I want unreliable formulas or tables preserved as faithful local images with source location, so that difficult structures are not silently lost or invented.
30. As a reader, I want missing or seriously corrupted text distinguished from completed content, so that I am not misled into thinking an incomplete book is fully readable.
31. As a reader, I want source inspection to return me to the same reading position, so that checking the original does not become a navigation detour.
32. As a reader, I want adjacent PDF reading ranges to turn with the same paper motion as other pages, so that internal processing boundaries do not interrupt reading.
33. As a reader, I want backward navigation across a range boundary to reach the preceding reading screen, so that page order feels continuous.
34. As a reader, I want a missing next range or failed request to leave the current page intact and recoverable, so that a temporary problem does not blank or lock the reader.
35. As a reader, I want single-page and two-page layouts to retain source position after reflow, so that changing the window or typography does not lose my place.
36. As a trackpad reader, I want paper motion to follow my gesture and remain held while my fingers stay in contact, so that it behaves like direct manipulation.
37. As a trackpad reader, I want reversing a partial turn to cancel without changing location, so that exploring a gesture does not accidentally navigate.
38. As a trackpad reader, I want release to settle promptly and consecutive or alternating turns to remain responsive, so that an end-of-turn lock does not break the rhythm.
39. As a reader, I want text, figures and formulas sharp throughout a page turn, so that animation does not trade away readability.
40. As a reader, I want notes, image notes and bookmarks to support their complete visible lifecycle, so that I can add, edit, remove, undo and revisit them confidently.
41. As a reader, I want records to follow reliable source anchors after layout or recognition changes, so that they do not attach to the wrong passage.
42. As a reader, I want ambiguous record mappings to preserve the old reference, so that the application does not guess and silently change my notes.
43. As a reader, I want new conversion results applied at a safe moment, so that ongoing selection, note editing and page turns remain stable.
44. As a reader, I want conversion tasks to survive closing panels or reopening the application, so that long processing is not tied to one screen.
45. As a reader, I want pause, cancellation and restart to keep their distinct meanings, so that cancelled work does not restart unexpectedly.
46. As a reader, I want recoverable conversion failures retried within the same scope without blocking unrelated pages, so that isolated errors do not destroy useful progress.
47. As a reader, I want recycling and restoring a book to preserve its retained material, so that delayed work cannot recreate a removed book or cause duplicate processing.
48. As a reader, I want to choose a PDF page or region for external recognition enhancement, so that I can improve a difficult passage without sending an entire book.
49. As a reader, I want a clearly described processing action to express my authorization once, so that repeated confirmation dialogs do not interrupt reading.
50. As a reader, I want valid conversion reuse and local replay distinguished from regeneration, so that I know when a new service request may occur.
51. As a reader, I want processing limits enforced across simultaneous actions, so that parallel requests do not bypass my chosen usage boundary.
52. As a reader, I want an already sent request with an unknown result recovered without blind resubmission, so that a timeout does not cause an accidental second charge.
53. As a reader, I want measured, estimated and unknown processing costs distinguished, so that an estimate is not mistaken for a settled bill.
54. As a reader, I want low disk space and cache cleanup to preserve originals, records and replay material, so that recovery does not require losing work or paying again.
55. As a reader, I want background conversion and disabled PDF processing to leave existing reading usable, so that optional processing does not control basic access to my books.
56. As a Mac user, I want to install and open a minimal client without Python, Xcode or terminal setup, so that the product feels like an application rather than a development environment.
57. As a Mac user, I want basic reading and dictionary assistance ready without heavyweight OCR or speech models blocking every launch, so that ordinary reading starts quickly.
58. As a Mac user, I want installation resources and total process costs measured together, so that a small launcher does not conceal a large first-use burden.
59. As a Mac user, I want sleep, wake, exit, reopening and repeated launch to preserve data and handle owned processes correctly, so that the client does not leave conflicting services or lose my place.
60. As a product owner, I want reproducible walkthroughs, raw measurements and unresolved failures clearly separated, so that I can accept V1 based on actual behavior rather than setup or simulated passes.

## Implementation Decisions

1. **补充规格的边界。** 本规格固化 V1 收口要求和最小客户端原型的验证合同。已有 PDF 内容处理、书架、阅读、理解辅助、记录和插件模块继续使用；原有开发任务按实际完成度补齐，不重复创建同义模块。V1.1 的词句收藏闭环和 V2 的个性化策略不在本次实现范围。
2. **模块边界。** 继续由统一 PDF 内容处理模块承担原件接收、任务、阅读表示、转换版本、来源、重放和费用。书架与阅读器使用公开业务接口，不感知具体识别引擎。能力查询、导入、任务查询、转换操作、表示读取与回收恢复沿现有接口增量完善；不另开实验入口作为最终验收入口。
3. **服务状态合同。** 能力状态应表达是否可用、是否就绪、检查时间、失败原因及可采取动作；安装存在不等于模型和资源就绪。用户准备导入、提交及任务实际执行前都需在相应边界防止过期状态造成假成功。检查自身不隐式加载大模型、执行识别或切换其他服务；一个远端不可用不禁用不依赖它的本机路径或旧格式。
4. **入库和进度。** 校验并持久登记的原件归属在用户关闭导入界面后仍存在。原版可用、模型准备、转换进度、阅读版就绪范围、回退/拒绝范围和全书完成分别表达；进度来自实际工作单元，不编造进度百分比。导入反馈或书架中的主要进度区域提供可直接理解的状态，不要求反复进入额外页面才能知道是否在工作；不要求两处重复完整控制面板。
5. **处理位置与范围。** 默认本机转换，未配置文本 AI 不妨碍基本本机导入。用户明确选择自己的其他电脑（包括 Omarchy）仍属于外部转换；不因已配置模型而自动发送文件。本轮允许已明确选择的自有服务整书 OCR 路径，保留其与第三方付费服务的区别；付费局部增强不自动扩大成整本转换。本机失败不隐式切换服务。
6. **复用和兼容。** 相同原件内容复用既有归属；同名不同原件不合并。转换任务独立于文本 AI 队列和页面生命周期，重计算在用户资料短事务之外进行。旧格式的导入语义、既有记录身份与插件关闭后的访问行为保持兼容。
7. **正文与结构。** 可靠内容适配为结构化阅读表示，包含实际支持的正文、标题、代码、公式、表格、图片、说明及来源关系，不先压平而丢失结构。文字层可利用但需要质量判断；已有文字层不被计作新 OCR 的输出。普通正文缺失、严重乱码或错序不能通过展示原图冒充已识别。允许的结构原图回退应就地显示且可定位来源，回退与识别分别计数。
8. **首次打开及连续翻页。** 阅读版就绪后，按有效续读位置打开相应阅读范围；显式原版核对保持用户选择。对相邻范围进行有界准备，在同一阅读体验内前进、后退和取消，不先清空正文展示路由加载页。后退到前一范围末屏；取消、缺口和请求失败保留当前正文、范围和来源，不伪造连续内容，也不通过加载整本来换局部平滑。
9. **输入与纸面。** 复用已接受的装订、纸张形状、光影和鼠标/原生手势行为。接触停驻与抬手有不同含义；回滑、连续和交替不靠延长全局输入锁解决。静态、翻起、背面和落页使用一致表示和准备就绪的资源，保持高清和有界缓存；新 WebView 必须单独验证纹理与输入兼容性。
10. **现有交互的回归要求。** 默认专注；工具层拦截操作不遮掉正文；底部图标区域可交互，再点已开工具回工具层。保留段落选择可见性、附近菜单、词卡内部滚动及已有注释的独立性。译文对应高亮与原文选区可区分。语法分析保持段内入口；发音沿原有入口，不新增正文下方重复播放卡片。
11. **学术选区译文。** 仍是用户主动选定范围的理解辅助，不生成全书或整篇译本。提取和显示保留引用、公式变量、上下标、数字、否定与限定关系；译文由当前明确配置并实际可用的文本服务处理，现有有效结果复用。问题分别归因提取、模型输出和展示。全文可能出现的双栏、表格、脚注等只在实际检查后登记覆盖，不能由单篇论文的存在推断全部类别已满足。
12. **稳定来源与安全静默更新。** 阅读位置和记录沿原件、原页/区域、内容版本及可用文字对应绑定，不改为阅读页码。新结果在安全时机应用，翻页、选区和笔记输入期间保持当前表示。可靠映射自动保持；重复引文或不能确定的映射保留旧内容与来源，不猜测、不改写原始笔记、不要求日常手工点击采用新版。
13. **任务与容错。** 等待资源、排队、运行、暂停、部分完成、完成、失败和取消有清晰行为。记录检查点、错误页、原范围和配置，安全可重试的故障采用有界恢复，保留失败与尝试记录；不能无限重试或隐式换引擎。取消不因重启复活；迟到结果不重新上架已回收书籍或覆盖较新的转换版本。恢复书籍继续使用原记录与有效结果，需继续任务时沿原有明确操作。
14. **局部识别增强的缺口。** 本轮源代码核查显示外部图像增强关闭、区域请求不支持，Omarchy 仅接受整书范围。这是待补齐项，不因文本翻译或整书 OCR 存在而算完成。先完整接入一家真实图像服务，支持指定页及区域；供应商能力通过真实输入验证后才宣称支持，不默认声称多供应商兼容。
15. **授权、费用与调用身份。** 清楚表达服务、页/区域及必要上下文的业务操作本身构成已授权转换范围，不加逐次确认。有效结果复用、本地重放和重新生成是不同操作。相同内容、范围与处理设置匹配有效结果；重放不发起新付费调用；主动重新生成建立新尝试。范围、请求身份、派发与响应、用量和费用状态应可持久恢复，限额竞争不能绕过预留或被重启清零。
16. **结果未知。** 已发送但超时/断连的付费请求先查已有结果或服务真实支持的状态，不能当作未执行自动重发。无法确认时保留结果未知及额度占用依据；用户主动重新请求才产生新尝试。取消不承诺退款。未提供幂等或查询能力的供应商不能被臆造为具备这些能力。真实用量、估算费用和未知费用明确区分。
17. **保留资料和磁盘压力。** 原件、记录、有效结果和重放资料与临时阅读缓存分开。普通缓存清理不能删除保留资料；空间不足先安全释放可重建缓存，仍不足则停止新增写入并保留恢复依据。回收与恢复不等于永久删除；关闭 PDF 处理不影响既有可读资料和其他格式的访问。
18. **最小客户端的职责。** 保留 Web 阅读、翻页、词注和记录核心，优先验证系统 WebView；原生承载层处理启动、窗口、文件入口和真实手势。运行时、必要词库与资料目录有可安装的组织方式；不要求用户安装 Python/Xcode 或手动启动服务器。重模型按需准备，不阻塞每次基本阅读。是否后台驻留、最终框架、签名公证和更新路线不得假借原型范围提前定案。
19. **客户端生命周期与资料。** 验证冷启动、暖重开、退出/再次打开、重复启动、休眠唤醒、端口冲突、进程所有权与数据持久性。客户端只管理属于自身的进程；原型在隔离资料下验证，不能为启动方便覆盖个人书库或更改其他服务。浏览器基线与新承载的行为及成本分别报告。
20. **资源与性能决策。** 应用包、安装后资源、词库、OCR、语音下载成本分别报告，并测整棵进程树而非仅外壳内存。保留已确认的阅读守卫；新客户端绝对包体、启动和资源预算由最小原型实测后与用户冻结。预算未冻结或原型未体验时只能给探索结果，不能宣称正式轻量客户端已验收。
21. **模块化与实施接续。** 保持功能开关和引擎替换边界；关闭处理模块不删除资料。既有 PDF 任务继续承担已规格化的实现缺口，新客户端在已批准的原型决策内验证；后续拆票只覆盖新增工作或确需调整的缺口，先审阅粒度和依赖，再发布，不把所有历史任务因本规格成立而标为完成。

## Testing Decisions

### 已确认的最高业务入口

主要入口继续采用用户已确认的端到端流程：**选择文件导入 → 书架 → 阅读版/原版 → 翻页、理解辅助和记录 → 任务、重启和恢复**。从实际可点击入口观察真实 HTTP、持久状态、渲染与来源对应，不把内部函数返回、数据库行存在或服务健康响应当作用户功能通过。

用户先前已确认浏览器 E2E seam，并在 V1 对齐中接受最终直接点击走查、真实设备和性能取证。此次沿用该确认，不重新增加访谈或确认弹窗。客户端沿相同用户流程补充安装/启动及原生设备证据，不为验收新增能绕过正式行为的测试后门，也不假定现有 Chromium 自动化能直接证明 WebView 兼容。

优先实际浏览器/客户端走查，按需复用现有 Playwright、隔离服务、测量与截图/trace 机制。开发中只检查当前改动的相关路径；最后完成全链走查，不要求新增测试代码或运行完整自动化套件作为替代。不得在实现后补写单元测试。确需孤立验证系统时，先列全相关失败方式，再编写实验代码。

### 验证对象、先例与失败覆盖

| 组 | 对外行为和必需路径 | 证据与现有先例 |
| --- | --- | --- |
| A 旧阅读 | EPUB/TXT/Markdown入库、专注、词卡/密度/保留注释、选区译文、语法、发音、笔记/书签/续读/痕迹和开关 | 复用既有导入、阅读、词卡与反馈走查；刷新/重开核对完整生命周期 |
| B PDF入库 | 同文件并发/重复、同名不同件、首范围就绪、进度、原版与阅读版区别、服务忙/切换/超时及恢复 | 实际文件选择和书架回读；复用渐进导入与就绪检查先例，受控故障和真实探测分别标注 |
| C 内容与翻译 | 字符/顺序/覆盖，多栏、页眉页脚、脚注、公式、表格、图像、混合语言；学术术语及对应交互 | 独立原文参考与原页核对；提取/OCR/翻译/呈现四类错误分开记录 |
| D 连续阅读 | 单双页和重排，同范围及跨范围前后/取消，慢请求/缺口恢复，接触停驻/释放/连续/交替 | 复用跨范围与纸面/原生phase测量工具；真实触控板另留实际设备证据 |
| E 来源记录 | 原版定位、缩放/旋转、返回；文本/原图笔记增改删撤销，书签续读，安全静默更新及重复引文 | 用户操作回读与前后资料摘要并用；更新不能偷换当前选区或位置 |
| F 任务恢复 | 关面板/切书/重启、暂停取消、坏页恢复、迟到结果、回收恢复 | 真实检查点和执行次数；受控故障不得触碰个人正在使用的资料或服务 |
| G 外部费用 | 页/区域范围、复用/重放/生成、并发限额、已发超时、无状态查询、迟到响应与重启 | 故障供应商的独立收件记录可证应用行为；实际服务效果、用量及费用能力另行实测 |
| H 资源与关闭 | 接收/响应保存/提交时空间不足、清理和恢复、关闭PDF后旧资料照读 | 隔离资料与受控空间；不能通过删除用户资料或写满用户磁盘制造故障 |
| I 性能 | 空闲与真实后台转换下打开旧EPUB和已转换PDF，完整手势与收尾、清晰度及资源 | 固定源码和机器的配对原始序列，不以HTTP响应时间代替正文可操作时间 |
| J 最小客户端 | 无开发环境安装、基本阅读/词注、选择/笔记、高清纸面、真人手势、休眠和进程/数据生命周期 | 可复现安装产物及设备记录；模拟无开发环境不能写成干净系统验收 |

原 PDF-01 至 PDF-16 全部保留并映射到上述场景。模拟转换器/供应商只复现状态和故障，不能证明真实 OCR、真实供应商质量/账单或真人手感。性能用例中的合成 EPUB 不冒充真实扫描书。

### 固定材料和准确度核对

- 两类实际 EPUB、固定合成长 EPUB、TXT/Markdown、数字英文 PDF、用户指定 196 页英文扫描书，以及固定 [arXiv:2609.36322v1](https://arxiv.org/abs/2609.36322v1)（65页）。未覆盖的真实多栏、复杂/跨页表格、混合语言和困难扫描类别由代理补齐；不让用户为测试自行整理材料。
- 新扫描书抽查5页均有整页扫描图及不可见文字层。这只证明抽查结构，不证明全书文字正确。正常产品导入与明确忽略已有文字层的图像 OCR 分别取证，记录真正处理页数、分辨率、路径和耗时，不修改原件来掩盖测试条件。
- 首轮正文独立参考至少30段、5000个计分字符，兼顾固定随机样本与已知难点；数量是最低取证工作量，不是全书统计保证。原件摘要、版本、页序、段/区域、参考和字符规范化规则在比较前固定；参考不能由同一待测引擎生成并自行评分。
- 新扫描书无可选正文页逐页分类。封面、空白和纯插图不算正文OCR失败；有普通正文但未恢复的范围不通过。原图回退、正文覆盖、错误顺序、缺段及改变意义的错误分别报告，不藏在总体平均数里。
- 原566页样本的历史指标和首失败资料保留，新196页样本替换其本轮主验收职责。不得套用旧13页无正文数，也不得用196页结果声称566页规模已重新验收。
- 学术选区覆盖摘要/引言的核心术语和限定词、图注/代码附近段落（如原页3）、理论/公式附近说明（如原页8），并补实际存在的表格、脚注和跨页段。核对变量、上下标、引用、行尾连字、数字/否定和语气，不使用OCR字符分数评价译文。关闭译文后位置保持，再次打开复用有效结果；已有选区与当前对应高亮可分辨。
- 真实文本翻译和图像增强分别记录服务、模型、输入范围、响应及用量。实际外部图像试用先落实一个服务、少量明确可用的公开页/区域和累计预算；不自动用私有整书做付费实验，也不把已配置文本模型当成图像处理授权。

### 数值门槛与统计口径

| 指标 | 适用范围与门槛 |
| --- | --- |
| 旧合成长EPUB首次可读 | 首个正文出现并可选择小于2000ms，先于全书分页；原选区与恢复位置保持。此数不是应用冷启动或全书分页时间。 |
| 翻页流畅度 | 相应已有场景P95帧间隔及输入调度小于34ms；慢/中/快、取消、连续与交替均保留，覆盖完整释放收尾。 |
| 原生手势收尾 | 对应原生场景小于240ms；鼠标不同动画策略不混用该门槛，phase fixture不代表指尖到屏幕物理延迟。 |
| 高清与缓存 | DPR1/2/3、静态/翻起/背面/落页内容一致；原有不超过6张/24M缓存像素等守卫保持，不降清晰度换性能。 |
| 新扫描书完整转换 | 指定196页样本沿用180秒上限，从选择文件到全部结果持久发布；另报首范围就绪和页/秒，原件缓存未命中、无转换结果复用。真实OCR使用新模型进程，一次性模型安装另报；文字层提取与图像OCR独立报告。 |
| OCR正文质量 | 代表正文抽检字符准确率至少98%，按材料组报告；遗漏、错序、正文覆盖和改变意思的错误独立验收，结构原图不算识别正确。 |
| 阅读负载配对 | 固定机器、源码、浏览器/渲染后端、窗口、DPR、样本、位置、设置和缓存；先两批基线冻结噪声容差，再测候选空闲与真实转换。每条件至少10次配对操作，报告P50/P95/max与原始序列；候选P95不得超基线加冻结容差，也须满足硬守卫。 |
| 来源/记录/费用 | 必需场景内零丢失或错绑、零隐含扩大外发范围、零未知付费结果自动重发；不确定映射和未知费用按真实状态保留。 |
| 客户端新增指标 | 下载/安装/所需资源、冷启动至可阅读、暖重开、整棵进程树内存/CPU分别测；原型实测后由用户冻结预算，预算未定时不宣布该维度已通过。 |

冷启动、暖重开、模型准备、原版显示、首阅读范围和全书完成分开计时。不能由候选失败反推宽松容差、删除卡顿尾段或只选择最快一次。旧源码与当前候选不同的证据按变更影响决定复用范围；历史成绩不直接当成当前版本通过。

### 验收产物与放行

每次最终走查产生独立、可复现的证据包：源码/未提交修改摘要、依赖和模型版本、机器与输入设备、渲染后端、材料摘要、运行设置与预算、步骤、首失败、截图/录屏、原始性能序列、识别参考与错误、请求范围/次数/响应依据、逐项通过/失败/待验收结论。私有文件、完整原文、访问凭据和原始付费响应留本机，公开摘要只披露适合公开的范围与证据索引。

数据/费用错误、核心阅读阻断、明显沉浸断裂、性能/高清守卫失败，或必需真实证据缺失，阻断对应能力放行。轻微纯美观问题可以明确登记后续。代理完成全链取证后，用户再集中约15–20分钟体验重点场景；时长不是自动验收条件。

新客户端仍需用户实际体验承载方向并确认新增预算。核心阅读通过、客户端原型通过、正式发行通过是分别记录的结论；必要项待验收时，不能将本规格整体记为完成。

## Out of Scope

- V1.1 词句收藏/再次遇见闭环、词典来源最终升级，以及 V2 语境帮助需求评估、F1目标和个性化策略；这些继续由各自决策推进。
- 整书/整篇自动翻译、整本第三方付费 PDF 转换、默认外发整书，或因配置AI而隐含扩大授权。
- 重写原生阅读内核、云账号同步、排行榜、复杂背词计划或长期学习成效证明。
- 预先指定最终 macOS 框架、以其他产品包体作为本项目承诺、未经原型就冻结新客户端预算；签名公证、自动更新及正式公共发行的完整交付另行决定。
- 默认并装所有候选识别引擎、为保证通过而降低正文清晰度/隐藏失败/删除资料、以模拟或单一材料证明所有PDF和设备均可用。
- 本轮规格产出不包含产品代码修改、真实OCR/付费调用、完整走查或直接发布开发任务。

## Further Notes

1. 决策来源为 [V1 收口：哪些证据足以进入下一阶段](https://github.com/Coraia/EasySink/issues/24#issuecomment-6077370532)；本地验收矩阵与本文保持对应。本文沿用既有领域决定：阅读版优先、明确外部范围、保留资料、未知付费请求不盲重发、安全静默更新、单一主流水线的替换边界以及客户端复用Web核心。
2. [PDF 一期规格](https://github.com/Coraia/EasySink/issues/1) 继续有效；本补充明确更新主样本、数值门槛和用户已选择的直接点击走查方式。原计划中尚未冻结数值或默认要求完整自动化套件的文字不覆盖这些较新的决定。
3. 已有实现缺口沿用 [局部外部增强与有效结果复用](https://github.com/Coraia/EasySink/issues/16)、[付费并发限额与未知结果恢复](https://github.com/Coraia/EasySink/issues/17)、[本地重放与明确重新生成](https://github.com/Coraia/EasySink/issues/18)；其他PDF开发票同理，不重复建同义任务。图像服务选择及验证预算在执行该能力前落实，不凭文本服务配置推断已选定。
4. [最小 macOS 客户端原型](https://github.com/Coraia/EasySink/issues/34) 承担客户端方向和新预算的真实验证，仍未完成；[整体review、完整走查与一期发布验收](https://github.com/Coraia/EasySink/issues/22) 仍是既有PDF执行验收入口。规格发布不关闭这两项，也不改变决策地图的依赖关系。
5. 后续可进入 to-tickets，但只拆本补充带来的新增工作和确需补齐的缺口；审阅既有任务的实际实现/证据后复用原票。可并行推进不依赖客户端选型的阅读收口与客户端探索；最终框架/预算依赖原型结论，不能提前填成确定事实。
6. 本轮仅完成规格综合与发布。已核查源码、历史证据入口和材料元数据；没有重新运行OCR、翻译、真实触控板或完整E2E。已有定向修复证据、源代码存在和本规格中的要求不等于当前全链验收结果。
