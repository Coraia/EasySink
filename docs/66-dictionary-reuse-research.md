# 词典复用：欧路与开放词库能承担哪些能力

访问日期：**2026-10-09**。对应[问题票 #25](https://github.com/Coraia/EasySink/issues/25)。研究基线：`9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d`。仅研究，不代表产品选型、应用性能或用户验收；预算到期停止新增检索。

## 判断与证据等级

**事实：**现有 ECDICT 能继续提供离线基础词注、音标与词频；部分信息损失来自本项目展示路径。Wiktionary/Kaikki 增加领域义项、例句和多词表达，但中文覆盖、义项标识与资源许可不能一概保证。欧路已证实有跳转及个人资料互通入口，尚未证实能作为可缓存、可再分发的通用释义后端。依据见下表及来源。

**推断：**词典可提供候选含义，不能仅凭词条存在就宣称完成语境解释。**建议：**保留可替换的核心词典，把欧路跳转、同步和外部词库导入作为可选适配；最终取舍留给 HITL。

证据标记：**D**＝官方文档／许可；**L**＝本地数据库只读实查及现有 `Lexicon.lookup().gloss()` 执行；**J**＝公开单词 JSONL 实取；**W**＝词条网页核对；**S**＝源码推导；**U**＝未验证。没有运行欧路 App、鉴权接口、完整供应商流程或产品 E2E；没有上传书籍、调用模型或下载完整词库。

## 欧路：四层开放性不可混同

| 层次 | 已取得的一手证据 | 复用边界与未知 |
|---|---|---|
| App | D：[服务协议](https://www.eudic.net/v4/en/home/UserLicense) §三(5–8)、§六限制逆向、未经许可复制及商业利用，另订协议或指定商业服务有例外 | 未找到公开源码许可，**不等于证明所有组件闭源**；目前不能据此复用 App 源码或嵌入其引擎 |
| 自带／官方／第三方词库 | D：[扩充词库指南](https://docs.eudic.net/1/shi-yong-zhi-yin/tian-jia-kuo-chong-ci-ku)证实可下载词库和离线语音库；协议§六限制内容复制 | 导入、购买、离线使用均不能推出再分发权。各英语词库的独立授权、缓存期限、商用条款 U；未把同站法语助手版权声明当作英语词库许可证 |
| 扩展格式 | D：指南列出 MDX/MDD、L2D、BGL，MDX 可伴随 CSS/JS | 证明兼容性，不证明格式为开放标准，也不证明内容开放；公开规范、格式专利及具体解析器许可 U。每份词库需独立来源和许可 |
| API／URL Scheme | D：[官方跳转文档](https://docs.eudic.net/1/jin-jie-gong-neng/url-scheme)列出 `eudic://dict/test`、`?context=…`、安卓浮窗；[API目录](https://my.eudic.net/OpenAPI/Doc_Index)列生词本、笔记、语音打分及 MCP | 跳转不是返回词义 JSON 的接口，context 参数也不是自动消歧证据。目录未列通用释义 API；未证明其不存在。鉴权调用、双向冲突处理、商用授权及缓存许可 U |

API 目录的实际页面由脚本加载[官方 Markdown](https://my.eudic.net/doc/index.md)，本次直接读取成功：个人 Authorization、UTF-8 JSON，限制为每分钟30次、30分钟500次，超限封停分别1小时／24小时（D）。这是文档参数，未作接口调用验证。语音打分不等于发音音频服务；同步用户收藏不授予复制供应商释义的权利（推断）。

欧路已知有离线词库／语音库下载入口（D）；具体安装体积、词库更新周期、释义字段、音标／例句／中文／多词表达覆盖率和义项ID均 U，不从产品功能介绍推算样本质量。

## 当前词库与候选边界

| 维度 | ECDICT／本项目 | Wiktionary → Kaikki |
|---|---|---|
| 字段与义项 | `translation/definition` 为多行文本；音标、词性比例、词频、标签、词形。无结构化义项ID，SQLite行ID不等于义项ID（D/L） | `senses/glosses/tags/topics/examples`、词形、读音及翻译；英文站提取中翻译可位于词条层并带文字 sense 描述（J） |
| 中文／例句 | 5个词头有中文；本次 `detail` 均空（L）；上游将例句扩展标为待添加（D） | 中文随义项缺失；有例句字段不等于每个专业义项都有例句（J） |
| 音标／单词发音 | 4个单词有音标，`say grace` 无；5条 audio 均空（L）。本项目语音是独立 TTS 路径（S） | 4个单词有 IPA及音频链接，短语有音频链接但无 IPA（J）；未播放，未取得各音频许可证 |
| 多词表达 | 数据确有 `say grace`，但当前L0逐词处理，有限短语规则不含它（L/S） | 同短语有独立条目、词形和领域标签（J/W）；未测整体覆盖率 |
| 体积／离线 | 本地3,402,564行，946,715,648字节（约902.86 MiB，L）；本机SQLite可只读查询 | [英文词条集](https://kaikki.org/dictionary/English/)后处理JSONL标3.1GB；[原始下载页](https://kaikki.org/dictionary/rawdata.html)英文版含多语言23.9GB／gzip 2.8GB（D），不是同一范围。离线需自建索引，未测建库体积／速度 |
| 更新 | [1.0.28发布](https://github.com/skywind3000/ECDICT/releases/tag/1.0.28)为2017-09-20；SQLite ZIP元数据216,765,132字节。本项目固定版本、文件存在即跳过；lemma来自master，未绑定同一版本（D/S） | 原始数据页称通常至少每周更新；当前dump日期2026-09-02。网站后处理下载明确标记弃用，未取得稳定API／SLA承诺（D） |

字段定义来自[ECDICT README](https://github.com/skywind3000/ECDICT#数据格式)，结构说明来自[Wiktextract源码仓库](https://github.com/tatuylonen/wiktextract)。本项目更新机制见[下载脚本](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/scripts/fetch_lexicon.py)，发音实现见[TTS源码](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/src/wise_reader/plugins/tts.py)。Wiktionary与Kaikki为同一上游的网页／提取形态，不能当作两家独立词典投票。

**展示损失（S/L）：**[lexicon.py](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/src/wise_reader/lexicon.py)未将英文 definition、detail、audio映射入Entry；`gloss()`取中文首行、去词性并限制18字符。[engine.py](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/src/wise_reader/engine.py)的手动查词详情也只取首行100字符。[L0](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/src/wise_reader/l0.py)及[有限规则](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/src/wise_reader/semantics.py)不足以自动识别任意短语；[发音入口](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/web/reading-interactions.js)补查音标的正则排除空格。这些是源码边界，没有冒充浏览器实测。

## 同一组8个公开短语境

句子均为本次自写。只查询加粗词头；句子未提交给供应商。下表比较**取得的信息能否支持人工选义**，不是语境模型评分。欧路所有8项均 U：无App词条或释义API响应，不给其质量排名。

| 自写语境／目标 | ECDICT实查与现有短释义（L） | Kaikki实取及网页（J/W） |
|---|---|---|
| 1. The **thread** waits for the lock. | 原始中文后行有线程；短释义只剩线、丝等，丢专业义 | 有计算执行单位义及中文线程；该义例句0。[词条](https://kaikki.org/dictionary/English/meaning/t/th/thread.html) |
| 2. The compiler checks the **type** of each value. | 有类型及计算机标签；短释义混列一般近义词 | 有变量／值的类型义；对应中文未见；例句0。[词条](https://kaikki.org/dictionary/English/meaning/t/ty/type.html) |
| 3. The preacher calls the lamb a **type** of Christ. | 查到典型、符号等，未见明确神学预表义 | 有神学预示人物／事件义；对应中文未见；例句0。[同词条](https://kaikki.org/dictionary/English/meaning/t/ty/type.html) |
| 4. The dancer moved with **grace**. | 有优雅，短释义保留 | 有动作优雅义及中文优雅；该义例句1。[词条](https://kaikki.org/dictionary/English/meaning/g/gr/grace.html) |
| 5. They describe salvation as a gift of **grace**. | 原中文有恩典，但18字符短释义未保留；首行详情仍可含它 | 有神学义及中文恩典／恩惠；该义例句5。[同词条](https://kaikki.org/dictionary/English/meaning/g/gr/grace.html) |
| 6. The sermon links **justification** with faith. | 有释罪，未见中文称义 | 有Christianity义，概括罪获赦免；对应中文未见；例句1。不能据此认为宗派解释完备。[词条](https://kaikki.org/dictionary/English/meaning/j/ju/justification.html) |
| 7. Full **justification** aligns both edges of the paragraph. | 后行仅有计算机“调整”，短释义保留辩护等，不能说明排版 | 有文字对齐义；对应中文未见；例句0。[同词条](https://kaikki.org/dictionary/English/meaning/j/ju/justification.html) |
| 8. We **say grace** before dinner. | 完整短语命中饭前祈祷；不代表当前自动短语识别可用 | 独立祷告短语条目；无中文、无例句。[词条](https://kaikki.org/dictionary/English/meaning/s/sa/say%20grace.html) |

另直接打开Wiktionary原词条，核对了[thread计算义](https://en.wiktionary.org/wiki/thread#English)、[grace神学义](https://en.wiktionary.org/wiki/grace#English)、[justification宗教及排版义](https://en.wiktionary.org/wiki/justification#English)与[say grace](https://en.wiktionary.org/wiki/say_grace#English)。例句数量只统计此次JSON记录，不评估教学质量或授权。

**ID警示（J/W）：**页面有如 `en-justification-en-noun-2v4brcnY` 的后处理ID；本次下载的5个原始JSONL中，义项均未取得 `id`。不能把网页ID当作原始数据保证，跨版本稳定性 U。

## 许可、缓存与组件

- **ECDICT（D）：**[1.0.28许可原文](https://raw.githubusercontent.com/skywind3000/ECDICT/1.0.28/LICENSE)是MIT，允许使用、修改、分发及销售，要求保留版权与许可声明。可据此设计本地副本／缓存；README也说明多来源汇集，未逐条查清上游权利，不能把仓库MIT理解成所有词条来源的法律担保。发布前需保留对应版本声明。
- **Wiktionary／Kaikki（D）：**[Kaikki授权声明](https://kaikki.org/dictionary/)指向Wiktionary许可；[Wikimedia使用条款§7](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content)及[CC BY-SA 4.0原文§2–4](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en)允许复制、改编及商业使用，分享时须署名、附许可、标明修改，分享改编物适用相同方式共享，数据库权利另有规定。缓存副本应保留来源、版本与许可。不能用“只是缓存”免除对外提供内容的义务，也不能推定整个应用代码因此必须同许可（具体组合边界未裁定）。
- **例句／音频（D/U）：**Wikimedia条款指出合理使用等例外；[Commons复用说明](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)要求逐文件看授权。音频链接可取得不等于已获统一许可；本次未核完单文件及引用例句权利，不建议直接打包全部资源。
- **组件（D）：**ECDICT的`stardict.py`可读写／转换数据；[Wiktextract许可](https://raw.githubusercontent.com/tatuylonen/wiktextract/master/LICENSE)主要为MIT，部分测试资料另受Wiktionary许可。提取器代码许可不替代数据许可。未安装、运行或验收这些组件。

## 可替换边界建议与剩余决定

建议核心词典返回词头、词性、候选义项、领域、中文／英文释义、音标、可选例句／音频及逐资源来源许可；缺失字段显式为空。缓存键包含供应商、数据版本、查询形式；内部ID与外部ID分开。语境解释另记录选区和依据，不能把短词注当作已消歧结果。

欧路适配只负责用户主动跳转或明确授权的收藏／笔记同步；本地词句收藏及原文锚点仍是本项目记录。导入适配按文件核授权并隔离HTML／JS，不能让某格式或账号成为核心查词前提。以上为建议，未实施。

尚待主控／HITL决定：是否接受英英补充与中文缺项、是否维护BY-SA数据及署名、是否接入欧路同步、神学译名采用何种编辑标准。事实补查项包括欧路具体词库／商业接口条款、鉴权返回及缓存规则、音频逐文件许可、词条来源权利和ID迁移策略；没有这些证据不应承诺完整离线发音或供应商互通成功。

## 可复核记录与失败保留

本地只读库：`data/stardict.db`；SHA-256为 `e47b3cf4e4ddef869b3f74b516c8afadf275cde0595117110ddd317b4e168591`。用 `sqlite3 'file:data/stardict.db?mode=ro'` 查询 `SELECT word,phonetic,definition,translation,detail,audio FROM stardict WHERE word IN ('type','thread','grace','justification','say grace');`，并对同词头调用基线 `Lexicon.lookup(word).gloss()`可复核本地比较；勿运行下载脚本。库文件未随报告发布，未对照远端ZIP校验其逐字一致性。

公开JSONL只在内存读取，未保存完整数据；每个URL均是上述词条页提供的单词下载链接。散列固定此次实际响应，未来变化应记录为新版本，不能要求动态站点永久返回相同内容。

| JSONL来源 | 字节 | SHA-256 |
|---|---:|---|
| [type](https://kaikki.org/dictionary/English/meaning/t/ty/type.jsonl) | 86143 | `f61ca53ac4142d123247c450e1bb7a45185f95e42736ab9bdd2a73b9cc68c53d` |
| [thread](https://kaikki.org/dictionary/English/meaning/t/th/thread.jsonl) | 93104 | `1dd761baaab1fa967e576d275c9d74960d9d3d710ca99ca962f1caa85d3f27f9` |
| [grace](https://kaikki.org/dictionary/English/meaning/g/gr/grace.jsonl) | 62535 | `24557d2147ea1fbe8a01963e5bedd93056dc253f346ab49f0f3b36ea58b9e85a` |
| [justification](https://kaikki.org/dictionary/English/meaning/j/ju/justification.jsonl) | 19958 | `b7b3a3852623f135b37f1068f64e052c32262362f1684783842d417b5d1e3802` |
| [say grace](https://kaikki.org/dictionary/English/meaning/s/sa/say%20grace.jsonl) | 3785 | `3217acb9d7129caa10eb8b5c141f51851ccde8f13315ae8cb1ab1d7150c9100f` |

首次访问欧路版权页超时，后从官方ftp子域取得，但内容主体为其他语种，未外推到英语。API HTML只显示标题；目录通过其脚本指向的Markdown核实。生词本详细Markdown读取遭SSL EOF，web也未取得，停止该路线并保留U；Kaikki FAQ返回404，不作为依据。未取得音频文件许可页，不宣称许可已核。没有新增测试、产品修改、服务操作或真实流程验收；本报告由主控判断是否足以关闭事实调研票。
