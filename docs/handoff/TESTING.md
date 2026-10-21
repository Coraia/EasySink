# EasySink 测试分层与证据

不同层解决不同问题。API 绿不能证明 WebKit、物理触控板或真实大库性能；鼠标合成事件也不能证明原生输入。

## 1. 无大资源小检查

```bash
uv run python -c 'from pathlib import Path; import wise_reader; print(Path(wise_reader.__file__).resolve())'
uv run pytest tests/test_tokenize.py -q
uv run python -m wise_reader.collections_smoke
```

接手时已在干净源码上验证 `6 passed` 和 `94 API checks passed`。为避免下载，本次执行显式使用已有 Python 3.13 解释器、`PYTHONPATH=src` 和 `PYTHONNOUSERSITE=1`，并断言 `wise_reader.__file__` 位于隔离源码；它不是全新 `.venv` 安装证据。后者创建临时数据库和全合成内容，输出 `transcript.jsonl` 后自行清理；它覆盖 source anchor、UTF-16、合并/撤回、导入导出和冲突回滚，但不是 GUI 或设备验收。

在 `main@74226309` 应用 011 portable core 后，旧 smoke harness 会因为没有提供新增的 `ctx.engine.lexicon` 而在注册阶段失败；这是冻结候选与其测试入口的真实漂移，不是 94 项断言失败。按 [当前状态](CURRENT-STATUS.md#活动候选与参考补丁) 再应用独立的 `candidate-011-smoke-harness-adapter.patch` 后，94 项通过。不要把这个 adapter 当作产品代码或词典行为验收。

portable core 还必须先应用 `candidate-011-module-closure-adapter.patch`；否则 `reader-chrome.js` 会引用未交付的点击实验模块。交接复建对候选 24 个 JS 根模块做了递归静态相对 import 检查：42 个可达模块、92 条边、0 缺失。`node --check` 只证明语法，不能替代模块闭包检查。

012 的 `candidate-012-progress-from-011.patch` 必须在 011 父文件 SHA 匹配后应用。已有真实 native 证据只覆盖 note 10 → 收卡可见首源、Quit 前后 SQL 和无导航 cold open；旧 011 红证据必须保留。两次 App 正常退出不等于完整 012 回归、帧性能或物理触控板通过。

独立的 G3 书架 patch 只做过三文件 AST 和小型临时 Store/URLCommitter 检查，覆盖无 URL、空 URL committer 与 summary index；没有读取真实 G 库，也没有性能通过结论。

合成手工导入 fixture：`tests/fixtures/handoff_synthetic.md`。它由项目交接生成，不含用户书籍、笔记或供应商响应。

## 2. Python/API 测试

```bash
uv run pytest tests/test_l0.py -q
uv run pytest tests/test_plugins.py -q
```

按变更选择已有测试；不要在开发中默认跑全套。`tests/conftest.py` 将用户库、PDF 目录、原生输入和 LLM 配置隔离到临时目录。凡创建 `Lexicon()` 的测试需要 `data/stardict.db`，缺资源应明确失败或跳过，不能偷偷读取另一台机器的绝对路径。

## 3. 浏览器验收

```bash
npm ci
npx playwright install chromium
npm run test:e2e -- tests/browser/word-popover.spec.js
```

`playwright.config.js` 固定单 worker，并通过 `scripts/test_server.py` 使用 18767 端口和临时数据库；fixture provider 在 18768，真实 LLM 被关闭。Playwright 报告、trace 和截图都在 ignored 目录。运行前确认没有占用共享端口，不复用个人服务。

完整 `scripts/e2e_acceptance.py` 只在功能冻结后跑。保留第一失败，不用反复重跑覆盖失败；记录源 SHA、fixture、浏览器版本、命令和原始输出。

## 4. 原生人工验收

原生验收必须在隔离 App 名称和隔离 data directory 上进行，不使用正式 `/Applications/EasySink.app`、Paragraph Preview 或真实书库。

最小清单：

1. 001/002 source 定位的加减注、空格和再次选择。
2. 右页尾加注后前后往返，检查 source 完整、译句和前文冻结。
3. 字号、窗口、单双页切换后 anchor 不漂移。
4. 正常 Quit，再冷启两次，首个 source 准确恢复。
5. 显式点击跨页译句，原文定位准确且翻译面板可关闭。
6. 真实物理触控板：页级翻页与卡片内部滚动分开记录。

每项标记 `PASS / FAIL / NOT RUN / BLOCKED`，同时写清版本和层级。“有限场景 PASS”不能扩大为“功能通过”。

## 5. 性能

- 小型合成库：用于回归和明显退化，不代表真实书架性能。
- 真实大库：独立副本、一致快照、流式 hash；不得 clone 失败后全量 copy。
- 原生帧与输入：使用现有 measurement/原生 harness，记录设备、DPR、窗口、帧定义和原始数组。
- PDF/OCR：完成率、首次页、峰值内存、转换质量和远端资源分别计量。

性能通过必须同时说明预算、输入规模和测量边界。浏览器 frame 数、WebKit 长帧、返回书架 loading 和真实 G 大库是不同指标。

## 6. 证据与安全

- 截图/trace 不包含私人正文、笔记、token 或供应商请求体。
- 测试数据用临时目录；退出后确认只清理自己创建的路径。
- 数据库一致性要求同时考虑 `user.db`、`-wal`、`-shm`；运行中复制不算可靠快照。
- 对 async 场景分别验证 A→B、A→翻页、A→书架，确认旧响应不会覆盖新意图。
- 发布门至少包括：自动化小测、目标浏览器走查、原生人工、物理触控板、真实库性能、干净机安装；未跑项不能用别层替代。
