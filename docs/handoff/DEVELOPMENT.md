# EasySink 架构、开发与数据

## 技术栈与模块

| 层 | 入口 | 职责 |
| --- | --- | --- |
| FastAPI 服务 | `src/wise_reader/app.py` | 健康检查、文档/画像/查词 API、静态资源与插件挂载 |
| 数据与内容 | `store.py`, `content.py`, `collections*.py` | SQLite/WAL、source anchor、书籍/章节、收藏与迁移 |
| 能力插件 | `src/wise_reader/plugins/` | notes、bookmarks、progress、translate、PDF、importer 等路由与迁移 |
| 阅读前端 | `web/reader.js`, `pagination.js`, `reading-interactions.js` | 分页、选区、阅读状态与交互 |
| 页面/手势 | `page-curl-renderer.js`, `reading-native-trackpad.js` | 翻页视觉和原生输入桥接 |
| macOS 壳 | `desktop/App.swift`, `ReadingStorage.swift` | AppKit/WKWebView、独立后端、窗口/退出与原生桥 |
| PDF lab | `src/wise_reader/pdf_lab/`, `scripts/pdf_lab_*` | 独立转换、OCR 适配、可暂停任务与发布资料 |

前端生产代码不需要 npm 构建；Node/Playwright 只用于格式化和浏览器验收。新增领域概念先读 `GLOSSARY.md` 和相关 ADR，不把未决设计塞进词汇表。

## 依赖与开发命令

- Python：`pyproject.toml` 要求 `>=3.12`；Web 开发建议固定 3.13，桌面 builder 要求 uv 管理的 standalone CPython 3.12 arm64。
- Python 精确解析：`uv.lock`。当前主要锁定值包括 FastAPI 0.141.1、Uvicorn 0.52.4、Pydantic 2.13.5、HTTPX 0.28.1、Pillow 12.3.0、pytest 9.1.1。
- Node 精确解析：`package-lock.json`；`package.json` 当前使用 Playwright 1.58.x 和 Prettier 3.9.x。
- 桌面 wheel 冻结：`scripts/desktop/dependencies.lock`。

```bash
uv sync --python 3.13 --frozen --extra dev
uv run python scripts/web.py start
uv run python scripts/web.py status
uv run python scripts/web.py stop
```

默认 Web 地址是 `http://127.0.0.1:8766/`，运行日志和 PID 在 `.runtime/`，都不提交。

## 配置

`.env.example` 只给变量名和非敏感示例。复制成 `.env` 后自行填本机值；`.env` 已忽略。

- `WR_USER_DB`：Web 用户 SQLite 路径；默认 `data/user.db`。
- `WR_PDF_DATA_DIR`：PDF 原件、任务和转换资料目录。
- `WR_LLM_*`：可选 Chat Completions 兼容服务；API key 只留本机。
- `WR_NATIVE_TRACKPAD`：仅原生受控入口启用；浏览器测试强制关闭。

不要把 token 放进命令行、测试 fixture、截图或 issue。远程 AI/OCR 配置与书库数据分离。

## 数据、备份与迁移

Web 数据库使用 SQLite WAL。备份前先停止服务，确认没有 writer；不要只复制正在写入的 `user.db` 而漏掉 `-wal`。

```bash
uv run python scripts/web.py stop
sqlite3 data/user.db ".backup 'EasySink-user-backup.db'"
shasum -a 256 EasySink-user-backup.db
```

新机器先用空库启动一次，再停服务，用备份文件替换目标 `user.db`。PDF 用户资料另行迁移 `data/user-pdf/`；先做文件清单和校验和，再复制。词典 `data/stardict.db` 是可重新获取的开发资源，不应和私库备份混在一起。AI key、环境 token 和 `.env` 不随资料包传递。

macOS 候选数据位于 `~/Library/Application Support/EasySink Candidate`，与 Web 的 `data/user.db` 相互独立，当前没有自动迁移。正式 App/个人候选数据迁移必须在副本上演练，不用真实库做首次测试。

## 词典与大资源

`scripts/fetch_lexicon.py` 从 ECDICT `1.0.28` release 获取 SQLite 包，并从 upstream master 获取 `lemma.en.txt`。ECDICT 上游许可是 MIT：<https://github.com/skywind3000/ECDICT/blob/master/LICENSE>。这只说明上游词典的许可，不等于 EasySink 仓库整体采用 MIT；仓库目前没有顶层 LICENSE。

```bash
uv run python scripts/fetch_lexicon.py
shasum -a 256 data/stardict.db
```

本机曾核对过的**建索引后** artifact SHA-256 是 `e47b3cf4e4ddef869b3f74b516c8afadf275cde0595117110ddd317b4e168591`。没有重新下载证明每次 fresh 构建必然得到该值，因此只能用于比对现有 artifact，不能作为下载包的供应链承诺。下载源、解压结果、SQLite 版本和脚本版本都要分别记录。

缺少词典时，`test_tokenize.py` 和 `collections_smoke` 仍可运行；完整服务查词和依赖 `Lexicon()` 的测试不应伪装成功。大词典、OCR 模型、`.runtime`、App bundle 和个人库都不进入 Git。

开发时共享一个只读词典可以节省空间；发布包仍必须有自己的完整资源清单、hash 与许可材料。“开发共享可用”不等于“发布包完整”。

## macOS 构建

仅在固定源、固定依赖和小测试通过后构建：

```bash
python3 scripts/desktop/build.py \
  --dependency-lock scripts/desktop/dependencies.lock \
  --archive
```

远端基线 builder 生成 `dist/Wise Reader.app` / ZIP，最低系统版本声明为 macOS 13，要求 Apple Silicon、Xcode Command Line Tools 和 standalone CPython 3.12。该命令不是 Build 28 的可复现声明；当前安装包、品牌名变更、签名/公证和干净机器安装状态见 [当前状态](CURRENT-STATUS.md)。不要覆盖 `/Applications/EasySink.app`。

## 分支与提交纪律

- `main@74226309` 是公开可取的源码基线；本机 dirty 和 active repair 都不是它的一部分。
- 从最新远端提交创建自己的短分支；一次提交只包含一个可审阅主题。
- 逐文件 `git add path...`，提交前执行 `git diff --cached --check` 和 `git diff --cached --name-only`。
- 从 active repair 接代码时要求固定父 SHA、patch SHA、文件清单、应用顺序和验收层；没有这些就保持为参考补丁。
- 不 reset/clean 别人的共享 checkout，不把 `.runtime` 证据树或绝对个人路径搬进仓库。
