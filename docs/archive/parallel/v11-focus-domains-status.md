# V1.1 需要加强的领域

## 写入边界

本任务独占修改：`src/wise_reader/profile.py`、`src/wise_reader/store.py`、`src/wise_reader/app.py`、`src/wise_reader/l2.py`、`web/app.js` 和本文。已读 `AGENTS.md`、`docs/agents/domain.md`、`GLOSSARY.md`、ADR 0008。不修改领域文档、阅读工具、原型、收藏或弹窗文件。

## 隔离失败方式与验证计划（实现前记录）

- 旧 `domains` 被反转或覆盖：以仅含旧列的临时库启动，断言新 `focus_domains=[]`，旧值保持原样；旧字段独立 PATCH 不产生加强，也不继续压低旧领域候选。
- 新字段迁移丢失、重复迁移失败：API 保存后关闭并重新创建临时应用，重读字段和同一篇章的筛选结果；再次启动不得重置数据。
- 构造位置参数变化、CLI 缺字段失败：新增 dataclass 字段放末尾；回放旧位置参数构造和现有 CLI 路径。
- 未选择时基线漂移、清空不能恢复：同篇章顺序对比空选择、匹配选择、非匹配选择、取消和清空；匹配候选必须真实参与应用的筛选路径。
- 增益突破预算或复活关闭的辅助：匹配仅提升合格候选的排序，不改变密度、词频、重复、L1 开关或显式反馈约束；对比预算以及密度 0、L1 关闭。
- 保留注释或局部“已懂这里”被清除：通过现有记录 API 建立独立语境记录，对比 profile 开关前后和重启后的完整记录；浏览器检查保留呈现及已掌握局部抑制仍成立。
- 错误值污染设置：回放重复领域、未知领域、错误类型、空列表和无关字段 PATCH，检查校验及旧数据独立性。
- 自动保存竞态、失败谎报成功：浏览器快速开关、取消、清空、刷新；模拟一次保存失败并重试，只有成功响应才显示已保存，后续保存包含尚未成功的更改。
- 导入缓存错误绑定 profile：核对内容缓存不含 profile 字段；同一候选缓存对比开关结果并确认缓存内容不变，导入路径不新增 profile 依赖。
- 意外触及正式库、服务或 AI：仅使用新建临时 SQLite 和独立本地端口，显式关闭 AI 与本机输入，不调用生成接口；不重启现有服务。

验证采用真实应用 API + 临时 SQLite，领域候选使用明确标注的本地回放资料，不声称真实模型生成质量。只跑相关回放和浏览器走查，不写事后单元测试，不运行全套 E2E。首个失败、原始响应、复现步骤和截图保留在独立临时证据目录，完成后在本文登记。

## 当前状态

2026-10-11 已实现并完成本任务范围内临时库 HTTP 回放和 Chromium 走查。代码直接保留在共享工作区，未提交、未修改正式用户库、未重启任何现有服务。仅启动并关闭本任务自己的临时进程。其他协作者对阅读工具、弹窗、收藏与原型的并行改动未被覆盖。

## 实现与接口

| 文件 | 修改 |
| --- | --- |
| `src/wise_reader/profile.py` | 在 dataclass 末尾追加 `focus_domains: set[str]`，默认空集；保留原位置参数顺序及旧 `domains`。现有 CLI 无需改动。 |
| `src/wise_reader/store.py` | 缺列时追加 `focus_domains TEXT NOT NULL DEFAULT '[]'`；不从旧领域回填；新旧字段各自读写，重启不重置。 |
| `src/wise_reader/app.py` | GET 返回新字段；PATCH 接受新列表，按目录过滤并去重；旧字段仍兼容，不能代替新字段。 |
| `src/wise_reader/l2.py` | 移除旧熟悉领域的 culture 抑制；在合格候选中，强制反馈优先，其后领域匹配优先，再沿用表达/长度/词频排序。预算、零密度、重复与重叠约束不变。 |
| `web/app.js` | 标题“需要加强的领域”，说明未选择使用默认；仅读写新字段。选择/取消自动保存，增加清空；显示保存状态并支持失败重试。串行请求携带尚未保存的修改，旧失败不覆盖最新状态。 |
| `docs/parallel/v11-focus-domains-status.md` | 实现前失败方式、边界、证据与复现记录。 |

调用例：`PATCH /api/profile {"focus_domains":["tech"]}`；取消全部：`{"focus_domains":[]}`。旧 `domains` 即使含 `tech`，新选择仍缺省 `[]`。旧数据不删除，也不再参与正向或负向领域排序。

`Engine.prepare_import`、`SourceCache` 继续只缓存原文候选；本任务没有修改这些文件，也没有将 profile 加入缓存键。`Engine.present` 每次使用当前 profile 重新筛选。领域只优先已有且合格的带域候选，不推测缺失的 domain，不增加 AI 生成路径。局部掌握与保留仍由现有语境记录和阅读呈现层处理。

## 验证结果

- 临时库真实 HTTP 应用回放：**39/39** 检查通过（包括一次浏览器子流程检查）；另有旧位置参数构造与现有 `wise-reader annotate` CLI 成功运行。
- 真实 Chromium 页面走查：**12/12** 检查通过，无 pageerror、无浏览器外部请求。保存失败场景采用显式 503 注入，其余请求使用真实临时应用。
- JavaScript/Python 语法解析和 `git diff --check` 通过；未新增或运行事后单元测试，未运行全套 E2E。
- 关闭再启动独立服务进程后，`focus_domains`、旧 `domains`、筛选结果、完整局部反馈记录和内容候选缓存均保持。
- 真实 `.txt` 导入成功；切换领域后导入缓存键及压缩内容保持相同，无领域候选的导入内容呈现不变。
- 回放结束 `wr_job=0`、`wr_assist=0`、`annotation_cache=0`；服务显式关闭模型且不配置密钥，无生成调用。

预算竞争使用一篇 90 词原文、1 处自动注释预算和本地预置领域候选；保存为 `source=local-domain-replay`，并经真实 Engine/SQLite/HTTP 路径筛选：

| 设置 | 自动选中 | 数量 / 预算 |
| --- | --- | --- |
| 新字段缺省 `[]`，旧 `domains=["tech"]` | Market signals（business） | 1 / 1 |
| `focus_domains=["tech"]` | Neural（tech） | 1 / 1 |
| `focus_domains=["law"]`，无匹配 | Market signals | 1 / 1 |
| 取消、清空及重启后清空 | Market signals | 1 / 1 |
| `density=0`，仍选择 tech | 无自动注释 | 0 / 0 |

保留注释与“已懂这里”通过现有 `/api/collections/feedback` 建立：`Neural` 同时保留并声明已懂，仍显示保留说明；`circuits` 仅声明已懂，其自动解释在阅读页隐藏。上述结果在领域开启、关闭时都成立；零密度下 `Neural` 保留说明依旧可见。profile 切换没有改写任何反馈记录。

## 可核验证据与复现

证据根目录：`/tmp/wise-reader-focus-domains-dulMi6`（macOS 实际路径 `/private/tmp/wise-reader-focus-domains-dulMi6`）。最终完整回放为 `combined-run1`。

- `replay.py`：真实应用启动、旧库构造、API 请求、SQLite 对比、进程重启和清理；每次要求全新的输出子目录。
- `walkthrough.mjs`：真实页面选择/取消/清空/失败重试/并发保存、刷新、阅读呈现走查。
- `combined-run1/checks.json`、`http.jsonl`、`browser-checks.json`、`browser-requests.json`：逐项结果、原始请求响应与耗时。
- `combined-run1/browser-trace.zip`：完整浏览器 trace；同目录 `profile-focused.png`、`profile-default.png`、`profile-save-failed.png`、`reader-focus-on.png`、`reader-focus-off.png`、`reader-zero-density-retained.png` 为截图。
- `combined-run1/user.db`、`fixture.json`、`import-response.json`、`server.log`、`cli.txt`：临时库、输入、导入响应、进程日志与 CLI 结果。
- `source-snapshot/`、`source-sha256.json`、`implementation.patch`：本任务 5 个代码文件快照、校验值与差异。
- 完整打包：`/tmp/wise-reader-focus-domains-evidence.zip`；包内 `MANIFEST.sha256` 可逐文件校验。

从当前 checkout 复现（输出目录必须尚不存在）：

```sh
cd /Users/fish/projects/Personal/APP/wise_reader
.venv/bin/python /tmp/wise-reader-focus-domains-dulMi6/replay.py /tmp/wise-reader-focus-domains-dulMi6/reproduction-1 --browser
```

只回放 API 时省略 `--browser`。打开浏览器轨迹：

```sh
node_modules/.bin/playwright show-trace /tmp/wise-reader-focus-domains-dulMi6/combined-run1/browser-trace.zip
```

## 保留的首次失败与证据边界

1. `api-run1/first-failure.txt`：回放脚本把 `/tmp` 字面前缀当作安全边界，macOS 解析为 `/private/tmp` 后被拒绝；发生在建库前。改为要求解析后路径属于脚本目录的全新子目录。
2. `api-run2/first-failure.txt` 与同目录原始响应：脚本误断言 L1 关闭后所有注释都为空。实际 `Neural` 的文化候选已被排除，保留下来的为普通词典词注。修正为核对 `local-domain-replay` 表达不出现。`api-run3` 为 36/36 的纯 API 成功回放，`combined-run1` 增加真实导入和浏览器验证。

这些结果证明当前候选的 profile/UI/API/筛选链路，不代表领域识别或解释生成质量。领域输入是回放资料，未调用真实模型；浏览器为桌面 Chromium 自动操作，不等同客户端/真机/人工验收。后续主控仍负责整轮阅读工具与客户端的完整验收。
