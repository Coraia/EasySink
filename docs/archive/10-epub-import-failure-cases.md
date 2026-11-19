# EPUB 导入失败：复现与验收范围

2026-10-04，基线 cbb33d7。开发前记录，仅使用端到端验收。

## 已观察

- 用户的真实内置浏览器导入弹窗显示「支持 EPUB、TXT 和 Markdown 文件」；服务日志有三次 `POST /api/import` 返回 400。
- 内置浏览器在独立临时库中上传 `web/sample.epub` 可以导入两章。因此目前没有证据表明所有 EPUB 上传都失效。
- 现有后端只检查 multipart 文件名后缀；有效 EPUB 如果被上传通道命名为 `blob`、临时名称或无后缀名称，会进入「格式不支持」分支。用户本次具体上传文件名仍待确认。

## 失败场景与期望

1. 有效 EPUB 被上传为无后缀名称、通用 MIME：根据归档中的 EPUB 清单识别，导入后章节顺序正确，能阅读、刷新重开。
2. EPUB MIME 正确，但无原始文件名：仍能识别 EPUB；损坏的内容明确报错，不保存半本书。
3. 普通 ZIP 被误当 EPUB：不能只根据 ZIP 签名接受，必须继续验证 EPUB 容器和书籍清单。
4. 云盘加密包装、损坏 EPUB、缺章节、超限：给出可理解且准确的错误，不伪装导入成功，不尝试解密。
5. TXT/Markdown：保留现有 UTF-8 导入；失败后仍可重新选择文件。
6. 大小、文件数、解压体积、章节数和正文长度限制，以及完整事务保存：继续生效。

## 证据边界

开发中运行新增导入目标场景；开发结束运行完整 E2E。使用真实 Chromium、FastAPI、独立 SQLite，保存首轮失败、最终报告、trace、截图、源码摘要。真实用户 EPUB 尚未提供时，不把示例书通过表述为该书已验收。

## 第一轮：无后缀识别结果

- 开发前目标场景 2 失败 / 1 通过，失败均为按文件名后缀误判。证据：`.runtime/epub-first-failure-20261004/`。
- 修复：以文件名、EPUB MIME 或归档中 `META-INF/container.xml` 识别 EPUB，然后由原解析器完整校验。普通 ZIP 不接受；错误信息显示收到的文件名，提示选择文件本身。没有放宽限额。
- 开发中目标场景 3/3 通过：`.runtime/epub-targeted-after-20261004/`。
- 首轮完整 E2E 26/27：Markdown 断言错误地包含了行内中文注释，已修正为核对去除注释后的原文；产品代码未因此更改。保留 `.runtime/acceptance/20261004T082230Z/`。
- 最终完整 E2E **27/27，31.1 秒**：`.runtime/acceptance/20261004T082344Z/`，源码在执行期间无变化。
- `python3 scripts/web.py restart` 后 8766 服务正常。用户原导入弹窗和内容保留；可以重新选择文件直接重试。
- 尚未确认用户失败文件的实际名称和内容。修复覆盖已复现的同提示缺陷，不宣称用户该本书已经导入成功。

复现最终验收：在项目根目录运行 `.venv/bin/python scripts/e2e_acceptance.py`。每次生成新的证据目录，不覆盖首轮失败。

## 追加：用户指定的 Mac EPUB 文件包（开发前记录）

`/Users/fish/Downloads/Python Pocket Reference.epub` 实际是目录，19 个文件、5 个 spine 条目、共 2815266 字节。用户提供了真实上传名 `Python Pocket Reference.epub.zip` 和格式拒绝提示。根目录清单检测不能识别带书名包装目录的归档；上一轮无后缀场景未覆盖这一情形。

新增端到端失败场景：

1. 单层或多层包装目录中的 EPUB：识别容器所在根目录，OPF、章节和加密清单都只从该书根目录读取；保留章节顺序、正文，刷新可重开。
2. 同 ZIP 中两本 EPUB：明确拒绝，不能随意选第一本书，不保存任何章节。
3. 包装根目录或 OPF 引用越界、缺失章节：明确拒绝，不能借兼容性读取归档中别的书或路径。
4. 未知 ZIP 或 Mac 元数据：不能被误识别为书籍；原始 EPUB、TXT/Markdown 仍能导入。
5. 用户这一本真实文件包：本机生成与文件包一致的包装 ZIP，通过真实浏览器上传、打开第三个章节、刷新。真实书只用于本地测试，不提交到代码仓库，不调用外部模型。

真实文件包验收通过 `WR_E2E_EPUB_PACKAGE` 指定本地测试 ZIP；默认测试不会依赖用户 Downloads。验收附件记录包装 ZIP 和原目录各文件摘要，重复验收时可据此核对材料。

## 第二轮：文件包修复和真实书验收

- 修复：搜索完整归档中的 EPUB 容器，以唯一书根目录解析 OPF、正文和加密清单。允许 `.epub.zip` 和单层/多层包装，不修改原书；多本书混装、根目录越界仍明确拒绝。前端允许 ZIP，并说明 Mac 文件包兼容性。
- 开发前 5 个包装场景全部失败，包含用户真实书同样的错误：`.runtime/package-first-failure-20261004/`。
- 首次目标验收 6/8；两条合成包装场景点击时还停留在旧书架，命中了多个历史同名链接。补上等待新书目录显示，未因此修改产品代码；保留 `.runtime/package-targeted-after-20261004/`。
- 最终目标验收 8/8：`.runtime/package-targeted-final-20261004/`。真实书导入、打开第三个 spine 条目、刷新重开通过。
- 最终完整 E2E **32/32，37.7 秒**，没有跳过或不稳定场景，执行期间源码未变化：`.runtime/acceptance/20261004T083724Z/`。包含用户真实书场景及材料摘要附件。
- 真实内置浏览器 8766：刷新后看见更新后的文件包提示；导入用户这一本书，确认「已完整导入 5 章」；书架 `#/book/2` 有 5 个条目；打开正文 `#/read/10`，54,789 词；普通刷新后仍为同一正文并达到 ready 状态。
- 真实页面截图：`.runtime/package-import-20261004/live-reader.png` 和 `live-reader-reopened.png`。原目录文件摘要复核由 `manual-verification.json` 记录。
- 这次实际导入是在用户现有本机书架中新增一本书；自动化 E2E 始终使用临时库。生产启动配置不自动排队模型注释，真实书验证只经过本机解析及词典，无外部模型调用。导入功能验收不代表书中注释语义质量已验收。

完整复现（原文件包必须存在）：

```bash
.venv/bin/python scripts/prepare_epub_package.py "/Users/fish/Downloads/Python Pocket Reference.epub" ".runtime/package-replay/Python Pocket Reference.epub.zip"
WR_E2E_EPUB_PACKAGE="$PWD/.runtime/package-replay/Python Pocket Reference.epub.zip" .venv/bin/python scripts/e2e_acceptance.py
```

`prepare_epub_package.py` 不覆盖已有 ZIP。重复生成请选择新的本地目录。书籍 ZIP 不提交到源码仓库；源码快照仅含准备脚本和合成 EPUB 场景。
