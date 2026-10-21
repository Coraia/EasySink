# EasySink 接手：第一小时

这份入口面向一位新开发者和一台新的 macOS。先把远端主线跑到可验证状态，再选择功能工作；不要把本机候选、已安装 App 或个人书库当成源码基线。

> 当前不是可发布交接。远端稳定基线是 `main@74226309ebd1211bdbeeace4323049c2c175f742`；正在并行修复的候选仍有 HOLD 项。`/Applications/EasySink.app` Build 28、Paragraph Preview、真实书库、笔记和进度都不属于开发资产，禁止覆盖或拿来做测试。

## 0–10 分钟：取得确定的基线

```bash
git clone https://github.com/Coraia/EasySink.git
cd EasySink
git fetch --prune origin
git checkout codex/handoff-20261021
git rev-parse origin/main
```

预期远端主线是 `74226309ebd1211bdbeeace4323049c2c175f742`。交接分支在该源码之上只增加文档、fixture 和 WIP patch；保留这个 checkout 才能随时阅读材料。需要在精确主线上试 patch 时，按 [当前状态](docs/handoff/CURRENT-STATUS.md#活动候选与参考补丁) 另建临时 worktree，不要把当前目录切回 `main`。如果远端主线不同，先读本 PR，不要把旧 SHA 强推回去。

安装 Xcode Command Line Tools、[uv](https://docs.astral.sh/uv/) 和 Node.js 后：

```bash
uv sync --python 3.13 --frozen --extra dev
uv run python -c 'import wise_reader; print(wise_reader.__file__)'
uv run pytest tests/test_tokenize.py -q
uv run python -m wise_reader.collections_smoke
```

前两项小检查不需要大词典、个人数据库、浏览器或真实图书。预期分别为 `6 passed` 和 `94 API checks passed`；它们只是导入、分词和合成 API smoke，不是产品验收。

`uv sync` 在新机器创建仓库自己的 `.venv`，不依赖旧电脑路径，但可能下载 Python/wheel。本次交接因禁止下载，只用已有 Python 3.13 环境配合 `PYTHONPATH=src` 重跑了 6+94；**全新网络安装尚未验证**，若 `uv sync` 首次失败要保留原始错误，不能改用旧机 `.venv` 兜底。

## 10–30 分钟：理解系统

依次阅读：

1. [产品与行为验收](docs/handoff/PRODUCT.md)
2. [架构、开发与数据](docs/handoff/DEVELOPMENT.md)
3. [测试分层与证据](docs/handoff/TESTING.md)
4. [稳定主线、候选与已知问题](docs/handoff/CURRENT-STATUS.md)
5. [领域词汇表](GLOSSARY.md) 与相关 [ADR](docs/adr/)

后端是 FastAPI + SQLite；前端是无需构建的 ES modules；macOS 客户端用 AppKit/WKWebView 复用 Web 阅读核心。`uv.lock`、`package-lock.json` 和 `scripts/desktop/dependencies.lock` 是依赖事实来源。

## 30–60 分钟：选择一个安全入口

只做 Web/API 工作时，可先用合成 fixture 和临时数据库。需要完整阅读器查词时再获取 ECDICT：

```bash
uv run python scripts/fetch_lexicon.py
uv run python scripts/web.py start
uv run python scripts/web.py status
```

词典体积很大，不进 Git，也不是前两项 smoke 的前置条件。来源、许可、校验和缺资源行为见 [开发文档](docs/handoff/DEVELOPMENT.md#词典与大资源)。可导入 `tests/fixtures/handoff_synthetic.md` 做无版权手工走查；不要导入接手人的私人书籍。

若准备改正在修复的阅读链，先核对 [当前状态](docs/handoff/CURRENT-STATUS.md#活动候选与参考补丁) 并向当前 owner 取得新的固定 SHA。仓库附带的小 patch 只用于审阅或在精确父版本上重建，不代表已合入。

若准备构建 macOS 候选，还需单独安装并核对 uv-managed standalone CPython 3.12：

```bash
uv python install 3.12
uv python find --managed-python --no-python-downloads 3.12
uv run python -c 'import sys, tomllib; print(sys.version)'
```

最后一条应由已经同步好的开发解释器执行；builder 本身需要支持 `tomllib`，打包 runtime 则固定为前一条找到的 managed 3.12。新机上的完整原生构建仍未验证。

## 每次开始前

```bash
git status --short --branch
git diff --check
```

- 不提交 `data/`、`.runtime/`、`outputs/`、`.env`、数据库/WAL、PDF/EPUB、模型、词典、日志或 token。
- 不使用 `git add .` 接手混合工作区；逐文件 stage。
- 不在个人数据库或已安装 App 上跑测试。浏览器测试只用 `scripts/test_server.py` 创建的临时库。
- 原生构建只在源冻结后进行；签名、公证、干净机器安装和真实触控板仍是独立验收层。
