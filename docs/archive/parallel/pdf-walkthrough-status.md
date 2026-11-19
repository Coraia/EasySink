# PDF 初期走查与旧书基线

**16:54 SGT 最终复核已收尾**：主控重启18876后整页reload，实际assets/c6e4a7796eceb087。doc3 更多→阅读痕迹明确“译文片段 · 旧引用保留”，点击该条“回到原文”实际打开原页2完整可见ROI，返回doc3当前26/26，sourcePosition逐字相同（不是跳回新版本同名block）。restart-final/01–03、historical-return-comparison.json通过。关闭preview PDF处理→IAB仅上传同GSA文件一次→HTTP409 code processing_disabled，UI明确 `PDF processing is disabled; retained books remain readable.`，不再通用格式错误，04通过；处理开关UI恢复勾选05通过。16:52:19–16:53:52独立7GET前后：doc3 revision及笔记1/书签1/历史译文1的ID与完整内容摘要不变，historical=true，文本/语音AI enabled=false、processing_enabled=true。记录查询窗无增删/变化，不冒称数据库零写入。实际加载core/reading-traces/pdf/importer四文件已导出并关闭Debugger/Network；不再跑性能/其它已过场景。**正常8766 doc52继续留给用户；本走查没有剩余可独立执行的必要界面项。** 空首页修复当前由converter/主控独立收尾，实际物理触控/扬声器与未覆盖质量边界仍保留。

**当前验收交接（16:45 SGT）**：preview实际扫描76/数字PDF记录生命周期与normal8766公开doc52必要UI已完成，正式体验入口 http://127.0.0.1:8766/#/read/52 已留在IAB。新Python /traces与服务进程重启仍待主控restart18876通知；空首页首失败修复由converter负责，无需再大范围。所有证据在本页后续段落以及final-iab/、production-readonly/。

**性能文件必须区分**：所有P95都采用nearest-rank `sorted[ceil(.95*n)-1]`（n=10取最大），不是插值或覆盖。`iab-fixed-warm-10.json`/`iab-current-warm-10.json`原批P95首正文194.4/133.6、ready299.9/204.4，旧窗与normalized OCR重叠，不能配对空闲。`iab-paired-resource-check.json`追加有活动观察配对窗P95首正文157.4/145.3、ready255.8/229.5，20/22活动样本全部无转换/下载匹配。完整算法、每项原值及文件SHA在 **long-epub/iab-summary.json**。原批fixed SHA404f01318ee0e6731b42bdc9fc765b1979cc963815ee862c48c0f5ef640daaef、current SHA4e8afb671efd3f27c9511ea37502b7ac839815d2133ff33e8a1f311271f01bfc；追加文件SHA9a9bd08f9467fa35d1a7df4ac3437df29d6f2c5d19a7153b468fe66fa65738c4。不再为数字追加跑数，34ms守卫不变。

**16:26 SGT 收尾实时状态**：IAB可用，Chrome通路停止重试。IAB固定69同一54,789词章节已完成10暖重开＋4暖翻页；1280×720/DPR2/M4 Metal/单页卷页，866页，翻页P95 18.6/18.7/18.6/18.6ms。首转等待误用不存在的data-page-turning=false已保留，实际落页正确，后续按curlPhase=idle观察。当前版同条件正在测。只读审计确认Darwin76实际OCR16:13:19–16:13:34已经结束，活动观察16:15:53才开始；现有UI不能证明与真实OCR重叠。若主控仍要求实际后台OCR条件，请先等本人长书就绪再启动一次原预算内有界OCR；不把digital或已结束任务替代。

**16:31 SGT 新审计纠正**：normalized Darwin真实Docling在16:25:10.061–16:25:26.670运行，PID71448/engine=docling，固定69长章节10暖开16:25:11.992–16:25:24.044全窗重叠，21条活动样本匹配。**实际后台OCR时旧长书可阅读/重开已有证据，无需为了该项再起OCR。** 旧首正文P50/P95=103.5/194.4ms、ready201.7/299.9、分页505.35/734；当前91/133.6、174/204.4、443.55/494.8。资源条件不同且当前窗监视已截止，不能作为空闲同条件非退步通过。两组暖翻页都在已知OCR结束后，P95均18.7，无over34。

真实GSA文字笔记CRUD/撤销、选区书签、回收站恢复后原引用/来源高亮已通过IAB并保存final-iab/01–09；字号26实际重排及保留Federal词注在原文密度“0自动+1保留”通过10–11。正在跨8页范围、处理全局开关和最终局部识别入口收尾。全书旧GSA结果不冒充已替换修正版本。

**16:33 SGT 生命周期/上传首失败**：真实GSA范围1–8末26/26→现有更多/下一章→9–16/doc4，实际原页9全文选区/sourceSHA高亮→返回→书架reload重开仍原页9锚点，12–16通过。UI关闭PDF阅读后正文/原版仍可读，PDF处理 panel明确关闭且无recognize，17–19通过。

IAB filechooser确实选入完整31MiB Darwin原件，实际POST /api/pdf/imports **409**，body code=processing_disabled；界面却写“输入格式不正确，请检查后重试”。这不是Chrome权限失败，也不是Darwin格式坏；firstUI截图/实际response在final-iab/。停止关闭状态重试，将恢复处理开关。请主控确认已无converter重型后，可HTTP登记Darwin并暂停初任务，走查再只做原页76识别与来源；或修复通用409错误文案后一次正常IAB重传。本人不启动并发OCR/不扩大预算。

**16:35 SGT 最终追加配对已完成**：处理开关已UI恢复。资源观察重新启动（原OCR观察完整rename为activity-observer-normalized-ocr.jsonl保留），16:34:21.956–16:34:32.856固定组20样本、16:34:32.856–16:34:45.170当前组22样本，全部无观察匹配。各10暖开，font24/line1.8/single/866pages/同一chapterVersion/M4Metal/DPR2/1280×720；首正文P50/P95旧89.1/157.4、新91.35/145.3，ready旧181.7/255.8、新184.05/229.5，完整分页旧443.7/478.4、新442.15/468.8ms。仅这一配对窗P95无退步，P50约+2ms，不能外推普适性能。此前后台OCR旧长书可用的独立原批保留。新原始文件long-epub/iab-paired-resource-check.json；本测量浏览器实际assets/75477afb9356ec1b源码12文件已导出final-iab/loaded-source，不猜共享HEAD字节。

**16:39 SGT 扫描登记与控制**：已读converter实际PLOS3–4命令exit0/16.012s（read_thread最后命令），无重型并发再用IAB完整Darwin原件成功登记book5。GSA正常UI同文件上传复用也通过22，IAB上传有实际成功，不抹除Chrome权限/OS picker未通过。Darwin初自动全书任务在原页1（空内容）失败，message `Docling produced no content for source page 1.`；点击暂停时已失败，不能把23 screenshot叫暂停通过，初失败API单存。准备沿已授权HTTP仅原页76 recognize（不冒充UI范围输入），实际单页任务将用于UI pause/resume/cancel，然后有界只76完成后实际正文/source闭环。正常8766只读复核按主控新授权随后执行，不创建笔记/AI调用。

**16:42 SGT 本轮必要界面收尾完成，待主控重启/空首页修复通知**：实际单页76任务3393…已UI暂停→继续→取消，24–26与取消后API确认range76–76/cancelled保存。HTTP有界新任务3d808…仅76再开始（不是UI输入范围），完成11.371s worker/RSS1,582,301,184bytes/ocr1/fallback0/cloud0；首范围11.470s/总12.974s。doc24 sourceSHA=b26f3d634c0bce70e1b6b7cb95249b482a4d821147ac3930498f675ef5a4c132，真实扫描正文、philosophically词卡、原页76实际ROI（印刷62）/返回、书签/浏览器reload续读/书签列表跳转通过27–34。**这是浏览器重开，服务进程重启未由走查执行；/traces新Python仍待主控restart18876后复核。** 当前UI章节标题73–80是8页分片标识，实际仅76 ready，绝不宣称73–80全部或整556页识别通过。原文破折号→连字符错误已由converter保留，不称全OCR质量通过。

正常8766公开book4 **doc52** 原页9–16只读复核全部通过：专注/本机separately词卡、原页9完整可见ROI/返回锚点、双页1–2→3–4→1–2，实际一次renderer P9518.7/firstFrame4.6/over34=0，更多PDF处理显示118/118完成。产物production-readonly/01–07及final-public-book4.json。当前给用户体验链接 **http://127.0.0.1:8766/#/read/52**，IAB页留在专注原页9并markDeliverable；不建测试笔记、不改个人AI、不触发主动模型请求。正常浏览本身自动保存阅读位置，不冒称数据库零写入。双页同block两片严格selector首工具失败保留，改明确首片后正常；图片实际检查原页9 ROI全可见。

2026-10-08，当前正在18876“同 EPUB 阅读体验”的实际整合走查；15:16固定旧书基线已归档，15:36起进入完整PDF路径。**18px图像阻断已由主控修复并静态复验，原图笔记CRUD/撤销与来源已走通；31曲面像素实际显示表格/公式，逆向33仍只文字，前面像素不以计数通过。** 后续真实GSA文字记录/字号/跨范围、生命周期及长EPUB精确配对进行中，尚未体验交付。仍是唯一浏览器操作者，只写本人状态和独立 outputs，不写应用/测试、不运行 full E2E、不接触 8766。新证据 `outputs/pdf-reading-walkthrough-20261008-1512/`；下面上一轮实验目录/结论作为历史保留。

**上一轮实验结论（不是体验交付）**：修正数字/扫描小样本的阅读版、实际原版 Canvas、正常/125%＋90° 来源高亮、短页来源返回、重开/续读、公开 HTTP 准备后的持久化与去重均有实际通过证据；两次 UI 真实失败已由所有者修复并复验，旧失败保留。62 页范围样本 `1→50→51→62→1` 及 61/62 页刷新续读和来源往返通过，实际 HTTP 响应每次仅 2–3 近邻原页。上传控件、真实 Mac 手势、无负载配对性能、复杂长书与全书完成前浏览器渐进可读仍待验收。旧书超 34 ms 帧数字保留且与 OCR 重叠，不能归因代码回归或称无负载普适基线。没有独立接受 T01 整票或 T02–T06。

## 新一轮：EPUB 等同阅读体验（15:12 SGT 起，进行中）

用户已授权继续到现有 Reader 全流程后统一交体验，最新边界按 `docs/60-pdf-reading-integration.md`；上文实验阶段结论仅为历史贡献，不能作为体验交付。

本轮新证据目录 `outputs/pdf-reading-walkthrough-20261008-1512/`，仍只写本人状态和 outputs，不写 app/tests、tracker、commit/push，不操作 8766。18876 就绪等待主控通知，不无变化轮询。

为防共享源码变动污染旧书基线，已合法 `git archive 69f0fd0fe3b455a8be1e74d673fa06f78ba28d91` 到本人输出中的 source 目录；不 checkout 共享树。仅复制公开只读词典 `stardict.db`/`lemma.en.txt`，不复制个人 user.db/AI 配置。将用 archive 的 Python 模块与 web，同一既有依赖环境但显式禁用 .env、独立用户库，18767 本人的旧进程核对后替换。首次两批测量须无模型下载/实际 OCR 重叠，计划记录逐秒进程与转换活动时间，重叠则保留该批但不接受为清洁基线。

**实施前失败分类**：archive 漏只读词典导致启动失败；editable install 指向共享模块而非 archive；Settings 误读个人 .env；端口归属误认；同 origin 的旧测试续读/偏好造成设置不一致；测量与模型下载/OCR重叠；非 Metal 或 DPR 降级；frame 观察器开销/后台节流；把合成 EPUB 性能外推真实 PDF；真实手势/TTS扬声器证据缺失。启动路径/readback、模块路径/字典摘要、实际视口/GPU、原始性能、活动记录和首次失败分别核对；连续两次无进展停该路径。

### 固定旧书基线完成（15:16 SGT）

18767 当前已由本人的归档服务替换：设置模块路径实际为 `outputs/pdf-reading-walkthrough-20261008-1512/baseline-fixed/source/src/wise_reader/settings.py`，env_file=null；lsof 核对只读词典确实来自同 archive/data。启动 readback/词典与 tar SHA/源文件 manifest/复现命令均存 `baseline-fixed/`。本人旧 PID 37282 核对后停止，新 PID 98586（瞬时值，不能直接当未来授权），session 5535；个人 8766 未操作。初次复制因 archive 无 data 目录失败，已保留并补目录重做，无假启动通过。

此既有 test_server 同时启动了确定性 HTTP Provider fixture **18768**，仅用于测试，尚未为本轮调用。18876 准备时不要重复绑定同端口的 Provider；主控可选择另一个独立 mock 端口或复用已知 fixture 后明确标注。真实模型质量/计费不能由它通过。

两个批次 UTC 07:16:11.730–07:16:27.121、07:16:27.122–07:16:41.925（SGT 15:16），各 10 暖重开＋10 前后交替点击。0.5秒进程观察两窗各 29 样本，转换 worker/模型下载/依赖安装观察匹配均 0。转换会话状态回读明确暂不做长 OCR，等待本基线，快照在 `conversion-status-after-baseline.md`；只把该窗称无**观察到的**重型推理/模型下载重叠，不保证所有系统背景活动为零。

| 批次 | 首正文 P50/P95 ms | ready P50/P95 ms | 活跃 RAF P50/P95/max ms | 每次 renderer P95 的中位/max ms |
|---|---:|---:|---:|---:|
| 1 | 18.0 / 27.3 | 68.45 / 102.2 | 16.7 / 18.5 / 31.7 | 19.05 / 21.7 |
| 2 | 19.1 / 23.2 | 67.4 / 84.6 | 16.7 / 18.5 / 34.2 | 19.0 / 36.5 |

全部正确落页、实际 M4 Metal GPU、DPR2、1920×1270，缓存至多 2 张 / 7,174,400 像素，无软件回退。**批次2第一次 renderer P95=36.5ms 超 34ms 参考守卫**，`first-renderer-reference-failure.json` 保留；活跃 RAF pooled P95 18.5 不能掩盖该单次异常。不把短合成 EPUB 外推全部旧书/真实 PDF。

两批 P95 自然差：首正文4.1ms、ready17.6ms、活跃 RAF0ms；后者仅此短窗样本，不宣称普适零波动。34ms守卫不变。初开firstSource43.6/ready100.4单存。原始 dataset、帧、活动与 summary 可重算。

最小旧功能基线：专注、heron词卡/音标；点击保留后原文辅助密度为“0自动＋1保留”，恢复适中；引用笔记保存与刷新后仍存在。保留注释自动关闭/重排词卡，紧随的旧“关闭”selector失败作为工具时序记录保存，未列应用缺陷。没有触发付费AI或声称扬声器/物理触控板通过。

当前阶段仅完成环境与最少旧书准备。18876 全 Reader 就绪仍等主控通知，不无变化轮询；后续候选 EPUB/PDF 与真实 OCR 活跃条件必须和这些固定设置配对。

### 18876 早期新版 EPUB 实际准备（PDF 路由仍未尝试）

收到主控“已写启动器、可先做旧 EPUB”的通知后，一次检查 health 实际返回 `20261008-pdf-reader`，已读取 `scripts/pdf_reader_preview.py`：Settings(_env_file=None)，独立 `.runtime/pdf-reader-preview/user.db`，LLM false/空 key、native0、mock baseURL18768。当前PID7363，sample.epub HTTP准备得到book1/doc1、2；实际 Chrome 点击书架/阅读路径可用，布局从自动双页切单页，卷页/纸影保持。不是缺 PDF 路由失败，不运行未接线入口。

同视口/DPR进行两个新版 EPUB 批次，均10重开＋10交替翻页；`candidate-idle/` 保存原始值。第一批活动匹配0；第二批末尾 UTC07:23:55.456（SGT15:23:55）观察到PID10186转换worker，CPU38.9%、RSS49,744KiB，保存原始活动并不标完全空闲通过。同刻 `plain-digital-first.jsonl` 完成，待与转换记录核对具体类别；不能因猜测是轻量数字解析而静默删重叠记录。此两批只是早期源码状态，整合接线/restart后还须记录当前版本。

核对转换产物：`plain-digital-first.jsonl` 在15:23:56完成，engine=digital，ocr_pages=0、fallback_pages=3、worker elapsed1,016.656ms、RSS110,706,688bytes；时间支持轻量数字提取重叠的推断，未保存同PID映射，仍保留第二批 claimed_idle=false。固定旧书15:16两批无观察重叠结论不变。

新版两批首正文P95 27.1/30.3ms、readyP95 86.9/89.0ms、活跃RAF P95均18.6ms；第一批单次renderer P95最大34.3ms超34ms参考守卫，已保存 `candidate-idle/first-renderer-reference-failure.json`。全部落页正确，不由这些初期/含重叠记录宣称最终性能验收或普适非退步。

源码导出首次把URL的`?v=...`误作文件名导致0选中，刷新前实际asset35f5085f132e7d2a的脚本URL保留。修正后导出的源码明确标“测量后reload实际加载”，不冒充此前字节完全一致的测量版本。完整PDF整合/restart后需新快照；该工具错误已留档。临时帧观察器停止并reload移除，Debugger disable。准备/复现见 `candidate-idle/README.md`，仍待主控通知PDF接线就绪，不重复缺路由检查。

### 完整 Reader 首失败（15:36起）

主控通知catalog/register已载入后，PID19968、新asset `4a06fcc6126d7eb2`。新证据 `full-reader-01/` 已保存这次实际加载app/reader/pagination/page-curl-renderer、plugins-pdf/notes/notes-store/library/importer，以及通过CDP CSS读取的实际style.css；不是文件变化后猜测浏览器仍旧版本。

真实公开GSA `federal-plain-language-guidelines.pdf`，118原页、SHA `8a3d4b07eec19e2dd5a850892deacec7c55cea9171ab883a93cd72afc9235ba6` 核对plain-source-manifest后，经新 `/api/pdf/imports` HTTP准备得到book2、首阅读doc3。真实书架显示单PDF书籍及可读范围，从 `#/read/3` 进入同一专注Reader，词卡/音标/整段选区可用；原版Canvas实际高亮对应“Federal Plain Language”区域，返回后仍正文。`02-gsa-first-reader`、`03-pdf-wordcard`、`04-pdf-selection`、`05-full-reader-original` 保存。首正文125.1ms、ready349ms、实际M4 GPU/DPR2，缓存2纸面/7,174,400像素、已内嵌2图片；仍未作为完整性能验收。

**结构样本静态图片真实失败（只一轮，不继续声明图片纸面通过）**：book3，`structured-synthetic.pdf` SHA `90c54a0fb235fb624061baec006f8f03191f3b0b15a9bc295014f7543f5a7fb5`（合成边界，不是真实复杂质量）。表格/公式PNG已完整加载，natural尺寸996×330、337×71；但实际DOM两图宽都18px，内容在截图几乎不可见。首失败 `06-structure-reader.jpg/.txt`、`06-structure-image-dom.json`、`first-image-width-failure.jpg`、`first-image-width-failure-cdp.json`、控制台、loaded-source全部保留。

定位线索：img inline style预期662×219和225×48，computed width却18；父`figure.pdf-object.image_fallback`宽18，外层`div.source-row`是686px grid，columns=`18px 662px`。figure落在网格第一列而不是正文662列，max-width100%将图限制成18px。请主控协调核心/样式所有者修复当前PDF object placement，再通知刷新复验；不以asset200/naturalWidth或curlEmbeddedImages>0称图像/公式表格可读。本人不改app/CSS，图片笔记/图像纸面依赖项暂不通过，独立文字流程可继续。

修复后：`11-structure-after-fix.jpg`实际可读表格Item/Value、Notes17、Year2026和公式α＋β＝17±2；宽度662/225，natural996/337，记录自然像素与渲染比例，不冒充结构识别。原图笔记从图像入口创建，列表保存正确图像；编辑后引用不变，删除变0，撤销恢复1，`13`–`19`保留完整步骤。图片笔记点击定位后SourceAnchor kind=image、book3/sourceSHA90c5…、bbox[54,172,386,282]，原版真实高亮表格区域，返回仍对象，不假作可朗读文字。

本机明确mock18768/v1、normal、dummy fixture key（非个人凭据）只做应用范围/缓存。GSA译文请求原文446chars，重复点击后provider selection-translation仍1次；语法同段因fixture固定“so”节点父modifier不存在而被拒绝，源夹具错误不是实际模型语法质量判断。换完整结构句mock有valid overview/main，原段落语法层真实打开；内容明确固定假输出，不作语法正确性通过。

Samantha本地实际语音 `/api/speech/local` 捕获loading→ended、再次playing→stopped；原入口无额外播放器卡。CDP二进制body首次为空，0byte失败另存，随后用相同捕获请求经本机缓存重放保存可解码WAV（PCM16 mono22050Hz、3.135147s），与浏览器播放状态分别记证据；不声称听见物理扬声器。`21`/`22`、local-speech-request.json、WAV及首导出失败保留。

图像卷页：真实GSA初冷turn `24` firstFrame150ms、P9546.1ms、textureWait127.9ms、warm=false失败原值保留。原结构逆向`27`只文字且视口cap默认DPR1，不算DPR2图片曲面通过；后受控1100×600明确DPR2（CDP emulation，非物理设备改变）重载当前代码，`31`真实曲面可见表格/公式、faces{front0,back2}、GPU且front/back/canvas ratio2。`33`逆向faces{front2,back0}但截图仍只文字，不以指标称前面图像通过。恢复窗口已核对1920×1270 DPR2。随后软件pointer停驻的预备步骤误在已恢复1页条件等待page1，未到实际Input步骤，保存时序观察，不伪造手势通过；该front捕获路径停止重复，已有正向像素和未覆盖项交主控评估。

较长EPUB按主控明确路径授权，只读Python Pocket Reference.epub目录，19文件固定mtime包装同一ZIP（SHA cb31943412cd15b909db3b771860da9473c87cdb1e5a98dd4a13c4545c6cd59c）分别HTTP准备18767/18876，私有清单留本人long-epub/，不发布原书文本或路径到tracker。性能将选同一最长章节，不将237词或GSA短范围当整本Python非退步结论；不放宽34ms。等待最终服务版本后只做必要配对。

当前浏览器连接中断：CUA显示Chrome未运行，恢复现有Chrome getApp超时，之后只有IAB/mcpapps可用。后续点击未执行；Chrome长书精确配对暂不能通过。已关闭18876本机mock文本AI（此次因浏览器中断用公开API准备，不冒充UI配置通过），避免私有Python书进入任何模型调用；本地语音未更改。准备转IAB继续产品功能，**不同browser/renderer条件不得与Chrome基线混比**；不扩Chrome文件权限、不改系统设置，不以另一浏览器通过抹除中断。

## 当前状态

- 基线 HEAD：`69f0fd0fe3b455a8be1e74d673fa06f78ba28d91`。旧阅读代码尚无本轮修改。
- 18767 启动前为空；独立 `scripts/test_server.py` 临时库，`WR_LLM_ENABLED=false`、`WR_NATIVE_TRACKPAD=0`。首次按现有脚本启动后检查源码，发现默认 Settings 会从 `.env` 初始化配置；该次未导入/使用书籍或调用 AI，随后停止本人进程，以 `Settings.model_config['env_file']=None` 的进程内覆盖重启。后续所有走查均在禁用 `.env` 的服务进行；未打印凭据。首次启动 log 保留。
- 实际 Mac mini Apple M4、24 GiB、macOS 26.6.2；Chrome 154，视口 1920×1270、DPR 2，未覆盖视口。实际环境 JSON 已保存。
- 固定旧书：仓库 `web/sample.epub`，SHA256 `3e60bd61b8391227ffa196679393f1e0381802907c23e73e4fdfa05942d438c8`。
- **工具上传阻断**：Chrome 扩展没有 Allow access to file URLs，`chooser.setFiles` 首次失败已保留。未改扩展权限。原生选择器打开但路径输入不可靠，连续无进展后停止此路径。可继续 HTTP 数据准备后浏览器点击的其他闭环；它不能替代浏览器文件选择导入通过。
- 18866 初次检查为空；主控通知就绪后已完成下述实际集成走查。本文后段按时间保留首次失败和复验，不重复上传权限路径。

## 证据边界

服务启动、HTTP 数据准备、浏览器可見页面、转换输出、真实原生触控板分别记录。此旧书隔离服务禁用原生触控板绑定，接触/停驻/松手保持待人操作；不把软件输入声明为真实 Mac 手势。

## 真实点击结果

| 场景 | 结论 | 证据 |
|---|---|---|
| 文件选择上传 | 工具阻断、未验收 | `baseline/first-upload-failure.txt`；HTTP 准备另存 `import-http-preparation.json` |
| 准备后书架、阅读和重开 | 通过此固定旧书场景 | `01-oldbook-shelf.jpg`、`02-oldbook-first-open.json`，一个书籍、两个章节 |
| 查词 | 通过词卡入口/释义显示 | `03-wordcard.jpg`，heron 音标与词典释义；未调用外部 AI，不宣称真实 TTS 播放通过 |
| 选区 | 通过整段选择入口 | `04-selection-dom.txt`；未覆盖物理拖选 |
| 引用笔记保存、重开、删除 | 通过 | `06-saved-note.jpg`、`07-note-after-reload.txt`、`08-note-deleted.txt`，引用正确、列表由 1 变 0、提供撤销入口；本轮未点击撤销 |
| 书签及定位 | 通过 | `14-bookmark-list.jpg/.txt`、`15-bookmark-jump.json`；第二条准确返回原段 quote 与 block_id。另一次工具书签保存了当前开头，故列表有两条 |
| 自动续读 | 通过 | `12-oldbook-landed.json` → 返回书架 → `13-resume-after-shelf.json`，页索引仍 1、block_id 与 ratio 一致 |
| 工具层显示/收起、单双页偏好 | 通过实际入口 | `05-tools-dom.txt`；从自动双页切始终单页、卷页/纸影不降级，偏好重开保持 |
| 点击翻页 | 顺序通过，性能失败 | 首次下一页正确；两批 20 次前后交替均正确落页，原始 JSON 和 RAF 保存，详见下表 |
| 真实 Mac 触控板接触/停驻/松手 | 待人操作 | 未使用 native phase fixture 冒充触控板 |

## 性能基线与冻结容差

样本仅为固定 demo EPUB，第一章 237 词、2 阅读页；不外推长书渐进首屏或所有材料。实际浏览器、DPR/窗口及 M4 Metal GPU 如上，未覆盖视口，未降清晰度，软件回退为 false。暖重开从书架实际点击；整页重载保留浏览器缓存，**不是进程/磁盘冷启动**。首次打开 `firstSourceMs=89.3`、`readyMs=166.7` 独立保留。

| 条件 | 批次 | 首正文 P50/P95 ms | ready P50/P95 ms |
|---|---:|---:|---:|
| 书架暖重开，10 次 | 1 | 25.2 / 44.2 | 86.05 / 102.4 |
| 书架暖重开，10 次 | 2 | 27.5 / 60.7 | 82.85 / 131.9 |
| 整页重载，10 次 | 1 | 25.2 / 172.5 | 90.8 / 229.9 |
| 整页重载，10 次 | 2 | 22.5 / 120.1 | 120.0 / 383.2 |

| 翻页条件 | 批次 | 活跃 RAF 间隔 P50/P95/max ms | 每次 renderer P95 的 P50/max ms |
|---|---:|---:|---:|
| 10 次交替按钮点击 | 1 | 32.8 / 66.5 / 100.0 | 63.5 / 102.6 |
| 10 次交替按钮点击 | 2 | 32.7 / 67.1 / 100.0 | 79.7 / 97.5 |

首次应用性能失败：`12-oldbook-landed.json` 的 renderer `p95FrameMs=39.5`，高于 34 ms 参考守卫。后续 20 次也未达目标，保留全部失败。历史原生 phase fixture 与本次按钮场景不同，不能由这些数字改写历史 fixture 的结论；本环境的点击性能不能判通过。20 次取 376 个实际 RAF 观察点（356 个连续活跃间隔），visibility 始终 visible；观察器 CPU P95 0.10 ms、max 0.20 ms，批次后整页重载清除，确认 `typeof window.__pdfWalkthrough === 'undefined'`。原始 renderer 摘要与独立 RAF 序列分别保存，不混作物理输入延迟。

冻结规则：P50 为中位数，P95 使用 nearest rank `ceil(0.95*n)-1`。候选同条件配对非退步可用 pooled 基线 P95，加两基线批次 P95 的绝对漂移作为自然波动容差。暖重开首正文/ready 容差 16.5/29.5 ms；整页重载 52.4/153.3 ms；活跃 RAF 0.6 ms。整页重载 ready 波动较大，仅用于此小样本的同条件比较，不能据此声明稳定普适性能。**34 ms 守卫不随容差放宽，当前基线自身未达目标。** 机器/视口/DPR/清晰度改变须另起条件，不覆盖本失败。详细汇总 `baseline/summary.json`。

## 命令、复现与资料

1. 确认 18767 空闲。通过 `.venv/bin/python` 进程内设置 `Settings.model_config['env_file']=None`，再 `runpy.run_path('scripts/test_server.py', run_name='__main__')`；实际启动命令保存在证据 README。独立临时库、LLM false、原生触控板 0。
2. `curl -sS -F file=@web/sample.epub http://127.0.0.1:18767/api/import` 准备固定旧书，明确这不是文件上传 UI 通过。
3. Chrome 打开 18767 → The Quiet Reader → heron → 关闭词卡 → 第一段「选择这一段」→ 记一笔 → 输入固定文本 → 完成 → 工具/笔记列表 → 重载/重开核对 → 更多/删除。
4. 第二段选择 → 在选区加书签；工具样式切始终单页、卷页与纸影保持；收起 → 下一页 → 返回书架 → 重开核对 sourcePosition。书架书签页第二条「跳到原文」核对 quote/block_id。
5. 每批从书架点击重开 10 次，读取公开 DOM `data-first-source-ms`/`data-ready-ms`；另两批每次整页重载 10 次。两批每次前/后交替点击 10 次，等待页索引正确且 `data-page-turning` 结束，读取现有 `data-curl-metrics`、DPR/硬件纹理资料。临时 `frame-observer.js` 仅记录 turning 期间实际 RAF，不合成输入；重载移除。

证据中有 `source-manifest.json`（109 个基线受版本控制源码 SHA256）、`machine.json`、实际浏览器环境、40 次开书原始 dataset、20 次翻页摘要、RAF 原序列、可见截图、控制台信息和首失败。测试服务当前本人 PID 37282、工具 session 52219，仍在 18767，后续可复用；该 PID 是本轮瞬时值，停止前需重新核对身份。不应操作其他服务。

## PDF 入口待验收

主控通知 18866 就绪后，直接走隔离实验书架/原版实际渲染/阅读版及来源往返/关闭导入后重开/同文件去重。文件上传工具权限未变，若沿公开 HTTP 准备样本继续则保持上传 UI 待验收；不自行开启权限。不独立声称 T01 整票或 T02–T06 已验收。

## 18866 集成首次真实失败（14:36 SGT 前后）

主控通知就绪后打开实际入口。使用转换会话 `samples-final/digital-synthetic.pdf`（已核对 manifest，SHA256 `96ea32fb3f14e5c700532cf7c57bac979f3aa0f23f9520a0d4a23888951ee089`，三页）经公开 HTTP 准备；不是字体缺陷初版，不计上传 UI 通过。实际能力返回 digital 0.11.10、docling 2.135.0、cloud_enabled=false。

书架可见一个 `digital-synthetic`，状态“转换已结束 · 3 原页”。**点击打开后页面 status 为 `Cannot read properties of null (reading 'text_offset')`，阅读版显示“原页 1 尚未提供转换内容”；点击“原版”也未切换。** 两次同路径无进展后停止，不自行修改 UI/后端。请主控协调 UI 所有者修复该 null-anchor 相关路径，再通知复验。

首失败保存在 `pdf-integration/first-ui-failure.txt/.jpg` 与 `first-ui-failure-console.json`；原件 HTTP 登记、book/result readback、样本校验在同目录。book id `0f4d574c87564504be212cc9dc498a0d`，task id `8a85b3163a034e5da899e9181bd7023d`。没有原版 Canvas/阅读版/来源往返通过结论。允许继续独立的书架重开、去重和状态检查。

同一空锚点还阻断“返回书架”；未重复重试该读者路径，通过整页重载返回实验书架继续独立检查。实际 result API 已保存三页有效文字，包括 17/not 71、连字展开与 α β − ±，所以该次“尚无转换内容”是 UI 未呈现结果，不能记为转换未完成。`first-failure-source/` 是发现失败后立即保存的源码快照；修改仍由原所有者处理。

### 旧书性能资源重叠补充

文件时间显示暖重开批次结束于 14:30:26/14:30:50 SGT，整页重载于 14:31:09/14:31:13，翻页于 14:31:40/14:31:54；本机 OCR 安装 log 最后更新时间 14:29:16，模型下载 log 最后更新 14:30:01；首 Docling OCR JSONL 于 14:32:06 结束，内部 elapsed 30,356 ms。若以文件 mtime 对齐，OCR 运行约自 14:31:35 起，**与翻页批次尾部重叠**。这是由产物时间推断的重叠，未保存基线期间逐秒进程 CPU/RSS，不能精确归因每一帧。

因此本轮旧书基线应描述为**并行开发/安装与部分 OCR 活跃环境的实际点击记录**，不是无负载旧版本基线；此前冻结波动只适用于已记录条件，不能用于宣称无负载普适非退步或归因 PDF 接入造成退步。原始失败保留，不把未控制负载下的数字直接判为代码性能回归。

## 空锚点修复后真实结果与第二处 UI 阻断（14:38–14:43 SGT）

UI 状态确认修复后刷新，数字 PDF 真实阅读版已显示全部第一页文字，包括 `17 notes, not 71`、`office/file/flower` 与 `α β − ±`。首失败不覆盖。当前浏览器实际加载 JS 已用 CDP Debugger.getScriptSource 保存为 `pdf-integration/browser-loaded-app.js`（SHA256 `2582bc7bfbe0a3546491f37f28d42c2a11803985566ee1f625da6466637c9e6b`），避免共享源码后续修改混淆这次证据。

已真实通过的小样本路径：

- 数字 PDF 正常来源按钮 → 实际 Canvas → 正确第一段原页区域高亮（`05-digital-original-source.jpg`，bbox `[54,107.6016,308.3555,119.6016]`）；字面与原页一致。
- 来源返回后，六个文字 section 的 block ID、文字与页面 y 位置和之前一致，原页仍 1、scrollTop 0（`08-return-position-comparison.json`，原始探针也包含来源按钮重复 ID，比较时仅取有文字 section）。仅这张短页，不外推长页选区/换字号恢复。
- 页范围前进到数字第二原页 → 返回书架 → 重开仍第二原页，`3.14/2026` 正确（`09-digital-reopen-page2.txt`）。
- 修正扫描样本真实 auto 本机 OCR，第一/第二原页在阅读版实际可见；17/not 71 与 2026 正确。原版 Canvas 与第一段两行来源区域确实可见（`10-scanned-reading.jpg`、`11-scanned-original-source.jpg`、`12-scanned-second-page.txt`）。复杂版面与任意 OCR 质量未验收。
- 导入弹窗打开期间经 HTTP 准备扫描原件，关闭弹窗后刷新书架仍有两书；数字同文件再导入返回同书籍/任务、reused=true，未增第三本。此路径证明公开接口准备后的持久化与去重，不证明上传控件完成上传。

**第二处真实失败：125% 缩放后顺时针旋转 90°，第一段来源高亮完全落到右侧裁切区外。** `06-original-zoom-rotate.jpg` 是首张失败；仅复现一次后停止该路径。`second-ui-failure-rotated-geometry.json` 中高亮 x `[1597.5625,1619.0703]`，原版滚动容器 x `[370,1550]`，交集宽度 0，`scrollLeft=0`、`scrollWidth=1464 > clientWidth=1180`。页面仍说“已定位来源区域”，original_visible 事件也说 source_highlighted=true，**但实际截图没有可见高亮**。请主控协调 UI 所有者修复横向滚动/可见性，再通知复验；旋转来源定位不能判通过。

正常实际原版首次可见：数字 308.3 ms（Canvas rendered 281.1 ms）；扫描 179.7 ms（Canvas 149.7 ms），DPR 2，来自 `post-fix-ui-events.json`，不是 HTTP 200 计时。扫描这次隔离服务指标：first_range_published 13,806.755 ms、全范围 process wall 16,429.521 ms、worker elapsed 14,933.559 ms、ocr_pages=2、peak RSS 1,416,675,328 bytes、cloud_calls=0；浏览器进入阅读时已全书结束，**未证明浏览器在全书结束前逐页可读**。数字/扫描只独立核对这些样本，不接受 T02–T06 整票。

所有三页数字/两页扫描结果与 samples-final 独立作者参考逐页核对，声明 NFC、ﬃ/ﬁ/ﬂ 展开、空白折叠，其他字面均保留；五页全部 exact match，原始 reference/actual 保存 `independent-sample-text-comparison.json`。数字第三页实际显示也保存 `14-digital-final-page.txt`。此五页清晰合成材料通过，不外推复杂扫描、公式/表格或任意用户书籍。

本轮具体复现步骤与证据索引已更新 `outputs/pdf-walkthrough-20261008-0844/pdf-integration/README.md` 和总 `index.html`；浏览器待后续修复通知，停止重复旋转路径。

## 本阶段最终复验：旋转修复与 62 页范围（14:44 SGT 后）

收到主控修复通知后刷新，同数字第一页段落、125% 与顺时针 90°：截图 `16-rotated-source-after-fix.jpg` **实际看见完整高亮文字**。数值 `scrollLeft=284`，高亮 x `[1313.5625,1335.0703]` 位于容器 `[370,1550]` 内；横向交集 21.5078 px，纵向交集 456.0391 px，等于高亮全宽/高。旧首裁切与复现图不覆盖；同条件修复复验通过。

主控独立生成 `outputs/pdf-controller-20261008-range/range-62-pages.pdf`，SHA256 `d3cc29cee4ba14687f50ad728370a2e5d76d25c990ddc0a7fd068734347bebdc` 已核对；读取 manifest 的独立 PAGE-NNN 参考及四种失败分类后经公开 HTTP 准备。book id `c1ac505cf00046c0bbcce96b9f6b59da`。实际页面顺序 `1→50→51→62→1` 所有精确 marker 正确，保存 `range-navigation-sequence.json` 和每步截图。

Chrome Network 原始观察及 response body 证明真实 `/result` 请求依次为 `1–2 / 49–51 / 50–52 / 61–62 / 1–2`，响应页数组吻合，每次 2–3 页；`range-network-requests.json`、`range-response-summary.json` 和 `range-response-*.json` 保留。仅保存本服务 URL/状态/页数据，未保存 header/凭据。不是 CLI 猜测 UI 已调用范围 API。

61 与 62 均实际跳转 → 返回书架 → 整页刷新 → 重开仍对应 `PAGE-061/PAGE-062` → 段落来源按钮 → 正确原版及可见高亮 → 返回原页 marker。保存 `range-resume-page-61/62.txt/.jpg`、`range-source-page-61/62.txt/.jpg` 与 `range-source-return-page-61/62.txt`。首次跳转 61 时 waitFor 超时，下一次观察（无再次导航）已显示正确 61，保留 `range-first-wait-tool-failure.txt`；它发生在续读操作之前，不能误记为最终续读失败。

范围结束后当前 UI 的正常扫描/数字路径再核对，最终书架三本（后加入的范围样本不是重复数字书）；当前浏览器代码保存在 `browser-loaded-app-final.js`，SHA256 `0ee89a8e13651796796da9872310831f154cc80105bd7dbbf32aa054bd8db470`，最终结果/实际事件在 `final-summary.json`、`final-browser-events.json`。临时 Debugger/Network 观察均已 disable，不留下测量 hook。此次 62 页只有稀疏清晰数字内容，验证范围加载边界，**不代表长书性能、真实复杂质量或全书结束前的浏览器渐进阅读**。

最终状态、复现、首失败、修复后截图、原始数字与源码均在本人证据目录。继续由主控整合，不做 tracker 操作，不独立宣称整票验收；本阶段无需再重复等待或扩大完整套件。
