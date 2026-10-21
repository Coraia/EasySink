# EasySink 交接状态（2026-10-21）

## 三层代码必须分开

| 层 | 固定标识 | 用途 | 结论 |
| --- | --- | --- | --- |
| 远端主线 | `main@74226309ebd1211bdbeeace4323049c2c175f742` | 新设备 clone、文档和开发基线 | 可复现，但不含近期修复 |
| 本机共享 checkout | 同一 HEAD，存在大量 tracked/untracked dirty | 并行修复、绘本、品牌和桌面实验 | 不可整批提交，不是候选快照 |
| 冻结候选 011 | manifest `200835d735cc49630a37f64ec8f4e70d336e8e5bb944beaa643caf8d5c1bd822`，518 文件 | 一次固定的本机修复证据 | 约 1.07 GB、未合 main、未形成发布门 |

当前修复 owner 仍在推进，冻结 011 manifest 尚未变化。较早的 006 HOLD / 007 撤回记录属于历史；最新固定证据已把第三种 pending 的 safe 撤回 headless 场景闭环，但这仍不能扩大为原生或整体验收。

## 已有的有限证据

- 011 上的 001/002 原生 GUI、字号/单双页、正常 Quit 后冷启动 source×2、Doc40 段落/译句有有限场景通过。
- `case-b-safe-leading-011-005` 在治理后用 26.553 秒完成四阶段，`notPassed=[]`；第三种 pending 关卡后 current generation/canonical 在 1122 ms 内就绪，真实 previous→return 撤回及完整 source frontier 通过。1 秒 RSS family 采样峰值为 595,034,112 B，进程与端口已清理。这只是有限 headless 功能证据。
- 干净远端基线源码已通过 `tests/test_tokenize.py` 的 6 项和 `wise_reader.collections_smoke` 的 94 项合成 API 检查。
- 活动修复线的资源治理已改用 1 秒 Darwin CPU tick（active ≤ 0.5），保留 10 GiB + 最坏增量磁盘门和 2 GiB 系统 RAM；11 项小检查和 122 B 代表路径通过，原有两个 native caller 已迁到固定槽。它们仍不是大资源或真实 App 验收。
- 私库原 snapshot 与 BF7 publisher 路径用时 3.788 秒，但原签名校验在 App 启动前被 `codesign --strict` 拒绝，因此 App 启动次数仍为 0。

这些都不等于完整功能、最终原生、真实触控板、真实性能或发布通过。

## 仍未闭环

1. safe 撤回目前只有上述 headless 场景；原生 presentation、长帧与完整交互链未复验。
2. 原生长帧、物理触控板卡片滚动/翻页边界、书架真实 App 与 G 大库性能未验收。
3. 001/002 与 Doc40 只有有限输入；还不能跨版本拼成整体绿。
4. 两个 active native caller 的固定槽迁移只有当前修复环境里的小检查证据，未纳入本 portable patch，也没有恢复完整 App 构建链。
5. `codesign --strict` 目前在启动前拒绝候选；原因仍在只读调查，不能擅自改签、删资源或另造 App 绕过。
6. 正式 Build 28、当前 Paragraph Preview、真实书库/笔记/进度没有纳入源码交接，也绝不能由新开发环境覆盖。
7. 签名、公证、干净 macOS 安装、发布包完整性和许可清单仍未完成。

## 仓库卫生核对

本次只检查 Git 已跟踪内容和本次新增文件，没有扫描整台机器：

- `.gitignore` 已排除 `data/*.db`、WAL/backup、`.env`、`.runtime/`、`outputs/`、PDF 资料、模型、日志、node/venv 和构建产物。
- `git ls-files` 未发现已跟踪的数据库、`.env`、`.runtime` 或 `outputs` 内容；本次新增 fixture 是完全合成文本。
- 对本次新增材料的高置信 token/private-key 与个人绝对路径扫描无命中。
- 历史已跟踪文档和生成 metadata 中仍存在个人绝对路径引用，这是可移植性债务，不是新设备配置；不要照抄这些路径。
- 已跟踪最大文件是约 3.4 MB 的绘本图片，仓库中已有多项 MB 级图片资产；大词典、私库和 App bundle 未跟踪。后续新增大文件前应先核版权、必要性和 Git 体积。
- 仓库没有顶层 LICENSE；不能因为 ECDICT 是 MIT 就把整个项目描述为 MIT 或擅自改变可见性。

## 活动候选与参考补丁

`docs/handoff/patches/` 里的 patch 都是**未合入参考**：

- `candidate-011-portable-core-main-74226309.patch`：可直接应用到远端 `main@74226309` 的 35 文件、纯文本 repair core，SHA-256 `08b31d3e9688ee078096d98eefcad40cd2c8f6720b4347db651c10d00bb967da`。每个目标文件都是冻结 011 的实际字节；配套 `candidate-011-portable-core-manifest.json`（SHA-256 `28f6b81d8ee688c4bdb378b0439613cf95ee79a2bd89b1c9320e7feaab8ccaef`）列出路径、new/modified、bytes 和 SHA。
- 这个 portable core 明确排除了词典/私库/运行资料、绘本/品牌/reading-spaces/essence、OCR adapter 实验、混合品牌的 `web/app.js`/`index.html`，以及 G3 书架性能三文件。它能从 GitHub 重建本轮阅读修复源码子集，但**不等于**完整 518 文件 manifest，也不继承原生/签名/设备验收。
- `candidate-011-smoke-harness-adapter.patch`：仅修正旧测试上下文的 3 个注册点，SHA-256 `1d13443fb17827d1c3a1e6c5bbd389735d9775dc3581dbc29e6d4ad409f35ab0`。冻结 011 插件开始读取 `ctx.engine.lexicon`，但同一冻结包里的 `collections_smoke.py` 仍只提供 `ctx.store`；不加本 adapter，94 项 smoke 会在注册阶段报 `AttributeError`。adapter 传入 `lexicon=None`，不改变 35 个冻结候选文件，也不是产品修复。
- `candidate-011-resume-only.patch` 仅保留为 provenance：它是 010→011 最后两文件 overlay，SHA-256 `ac8c6017014af819b9864897a5ff79cd1ea01eb907b49db23ffc46ad7075ee24`；新 Mac 不再依赖本机-only 010 来取得 portable core。
- `resource-governance-main-74226309.patch`：相对 `main@74226309` 的 portable 五文件治理快照，SHA-256 `a3da165baa7ac888424e8abb3ba879e186d6758fb444dd196b4c59c7ea688fb7`。它包含 1 秒 Darwin CPU tick 门，并剔除了 `EasySink.icns`、品牌版本、`reflow_omarchy_book.py` 和私有 `.runtime` caller 依赖；自包含 11 项小资源检查通过。活动修复线后来又迁了两个 native caller，但未收进这个固定 patch；接手者应取新的、可审阅的小 caller diff，而不是把旧机 runtime 当依赖。

应用顺序：

```bash
# 当前目录保持在 handoff 分支；先把材料保存在 worktree 之外
handoff_root="$PWD"
dev_python="$(uv run python -c 'import sys; print(sys.executable)')"
scratch="$(mktemp -d)"
cp docs/handoff/patches/candidate-011-portable-core-* "$scratch/"
cp docs/handoff/patches/candidate-011-smoke-harness-adapter.patch "$scratch/"
cp docs/handoff/patches/resource-governance-main-74226309.patch "$scratch/"
cp tests/fixtures/handoff_synthetic.md "$scratch/"
shasum -a 256 "$scratch"/*

# 精确 main 基线使用独立 worktree，交接文档不会消失
git worktree add --detach "$scratch/source" 74226309ebd1211bdbeeace4323049c2c175f742
cd "$scratch/source"
git apply --check "$scratch/candidate-011-portable-core-main-74226309.patch"
git apply "$scratch/candidate-011-portable-core-main-74226309.patch"
git apply --check "$scratch/resource-governance-main-74226309.patch"
git apply "$scratch/resource-governance-main-74226309.patch"
git apply --check "$scratch/candidate-011-smoke-harness-adapter.patch"
git apply "$scratch/candidate-011-smoke-harness-adapter.patch"

# 使用 handoff checkout 已经 uv sync 的解释器；不借旧电脑绝对路径
PYTHONPATH="$PWD/src" PYTHONNOUSERSITE=1 "$dev_python" -m pytest tests/test_tokenize.py -q
PYTHONPATH="$PWD/src" PYTHONNOUSERSITE=1 "$dev_python" -m wise_reader.collections_smoke
"$dev_python" scripts/desktop/check_resource_policy.py --output "$scratch/resource-check.json"
```

上述 patch/adapter 顺序已在干净 detached `main@74226309` 实跑：35 个 manifest 文件逐个 bytes/SHA 匹配，9 个 Python 文件 AST 解析通过，24 个 JavaScript 文件 `node --check` 通过，`6 passed`、adapter 后 `94 API checks passed`、资源策略 11 项小检查通过。未加 adapter 的 94 项失败也已保留为已知 harness drift。由于本轮禁止下载，实际测试把命令里的 `$dev_python` 替换成旧机已有 Python 3.13 解释器，并用 `PYTHONPATH` 断言导入仍来自 detached 源；新 Mac 的 `uv sync` 尚未验证。这个 worktree 只是 WIP 复建，不要提交到 main；应用后仍要重新运行当前 owner 指定的浏览器/原生场景。不要把 patch、小检查或源码 hash 成功写成产品 PASS，不要从本机绝对路径复制候选资源。

## 推荐的下一步

1. 在新 Mac 上按 `START-HERE.md` 验证远端基线和两个无大资源 smoke。
2. 向修复 owner 要最新 fixed source manifest，以及 portable patch 之后的 caller/CPU 门小 diff；不从共享 dirty 猜代码。
3. 把 safe 撤回的 headless 绿复验到目标浏览器与原生 presentation seam，保留 source/full-gloss/显式译句定位门。
4. 查明原签名 `codesign --strict` 拒绝原因后，再在隔离原生 candidate 上跑 001/002、Doc40、冷启和物理触控板；不改签绕门。
5. 真实 App caller、失败无全量复制、free-space 预算、G 大库与发布资源清单齐全后，才恢复构建链和性能门。
