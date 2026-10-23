# EasySink 交接状态（更新至 2026-10-23）

## 三层代码必须分开

| 层 | 固定标识 | 用途 | 结论 |
| --- | --- | --- | --- |
| 远端主线 | `main@74226309ebd1211bdbeeace4323049c2c175f742` | 新设备 clone、文档和开发基线 | 可复现，但不含近期修复 |
| 本机共享 checkout | 同一 HEAD，存在大量 tracked/untracked dirty | 并行修复、绘本、品牌和桌面实验 | 不可整批提交，不是候选快照 |
| 冻结候选 011 | manifest `200835d735cc49630a37f64ec8f4e70d336e8e5bb944beaa643caf8d5c1bd822`，518 文件 | 一次固定的本机修复证据 | 约 1.07 GB、未合 main、未形成发布门 |
| source012 单文件 overlay | logical manifest `1594c6bf463556769c884144e00065e7337cdf93891794695ec18275563e42b7` | 在 011 上替换 `web/plugins/progress.js` | 仅续读子门通过，不是完整新候选 |

当前修复 owner 仍在推进；011 的 518 文件 manifest 未改，012 只是一项可重放的小 overlay。较早的 006 HOLD / 007 撤回记录属于历史；safe 撤回 headless 与 012 续读子门已有固定证据，但都不能扩大为原生或整体验收。

## 已有的有限证据

- 011 上的 001/002 原生 GUI、字号/单双页、Doc40 段落/译句有有限场景通过；此前 `saved0` 字体场景的两次 cold 绿只证明该固定输入，不能概括为所有续读已经修复。
- `case-b-safe-leading-011-005` 在治理后用 26.553 秒完成四阶段，`notPassed=[]`；第三种 pending 关卡后 current generation/canonical 在 1122 ms 内就绪，真实 previous→return 撤回及完整 source frontier 通过。1 秒 RSS family 采样峰值为 595,034,112 B，进程与端口已清理。这只是有限 headless 功能证据。
- 011 的真实 native 反例保留为红证据：从 note 10 进入时，GUI 首屏落在 `I've`（page 100 / block 9 / offset 0），导航锚却是 `comprehensive`（76:89），随后旧 progress 被保存；正常 Quit 再冷开时首屏从 `comprehensive` 开始。
- function012/source012 只替换 `web/plugins/progress.js`，续读因果与窄 native 回归真实 PASS：note 10 → known/need → 收卡后实际首屏仍是 `I've`；正常 Quit 前 SQL 与闭库后 SQL 均为 page 100 / block 9 / `[0,0)`，无导航 cold open 仍从 `I've` 开始。两次 App 分别 44.818 秒与 15.049 秒正常 `exit 0`，A 已独立只读核对 AX、SQL 和 receipt。012 的窄原生回归还覆盖 Right/Left 和 Doc40 的完整段落、14 句缓存、跨页显式点击与关闭。App 文件名仍含 011，实际功能源是 `source012`；这些通过项不等于 012 全矩阵重跑。
- 最新可信原生输入链 `cold008 / build280534 / source012` 已不再是旧的“0 帧”：真实 source pointerdown 和 19 次交替反馈 commit 均可信，`firstFailure=null`，采得 1228 帧；冻结评分为 `no-go-observed`、`errors=[]`，全程 max 72 ms、p95 20 ms、37 帧大于 34 ms。target/prefix 位移均为 0，末段 settle 650 ms；原 GPU context 保持 antialias、MSAA4 和 reducedMotion=false。正常 Quit 后独立核对进程/端口清理、WAL 为空与 quick check。精简、无正文的可迁移证据在 `docs/handoff/evidence/source012-native-input-chain-008-summary.json`。
- 上述 19 次动作不是“严格 65 ms rapid 已通过”：工具实际 post-commit→下一次输入间隔是 547–1161 ms。物理触控板、#53 独立翻页帧、稳定改善和最终放行仍未完成；新 Mac 还必须重新绑定 App PID、窗口、DPR、坐标和 profile，不能照搬旧机点击坐标。
- 随后的同步 JS 小诊断只得到 4 次完整 draw 调用（约 20–26 ms）与不完整 AX 文本，不能解释整段 72 ms。属性快照优化单对 warm draw 为 33/27 ms，没有实质改善，已否决并完全回退；当前 source012 不含这个候选，也不含临时诊断 snippet。恢复后 App 的 Reflow/index/Info/Mach-O 与回退清单一致。`Animation Hitches` timeline 的两次尝试均在 CPU 资源门前被阻止，App/trace 0 Popen，因此状态是 `NOT RUN / RESOURCE`，不是录制失败或性能通过。
- CF 控制器已撤销“backend 必须与 App 同 process group”的错误假设，改用 direct parent / executable / birth identity；该身份验证与 `normalQuit003` 有限场景通过。这证明控制器门可工作，不证明续读或原生产品整体通过。
- 干净远端基线源码已通过 `tests/test_tokenize.py` 的 6 项和 `wise_reader.collections_smoke` 的 94 项合成 API 检查。
- 活动修复线的资源治理已改用 1 秒 Darwin CPU tick（active ≤ 0.5），保留 10 GiB + 最坏增量磁盘门和 2 GiB 系统 RAM；11 项小检查和 122 B 代表路径通过，原有两个 native caller 已迁到固定槽。它们仍不是大资源或真实 App 验收。
- 早先一条私库 snapshot + BF7 publisher 路径用时 3.788 秒，但当时被 `codesign --strict` 在启动前拒绝；后续已安全恢复有限真实 native 验证并得到上述 NO-GO。两次证据属于不同阶段，不能把有限启动写成签名/发布通过。

这些都不等于完整功能、最终原生、真实触控板、真实性能或发布通过。

## 仍未闭环

1. 012 只关闭上述续读子门和窄原生场景；最新原生帧是 `no-go-observed`，严格 65 ms rapid、物理触控板卡片滚动/翻页边界、#53 独立翻页帧和 G 大库性能未验收。
2. safe 撤回目前只有上述 headless 场景；原生 presentation、长帧与完整交互链未复验。
3. 001/002 与 Doc40 只有有限输入；还不能跨版本拼成整体绿。
4. active native caller 的固定槽与 `--warm-attachment-only --native-hitches` 改动只有当前修复环境证据，未纳入 portable patch，也没有恢复完整 App 构建链。下一台 Mac 需先把旧机绝对路径、sealed root、App/data/profile 绑定改成显式输入再运行。
5. 正式 Build 28、当前 Paragraph Preview、真实书库/笔记/进度没有纳入源码交接，也绝不能由新开发环境覆盖。
6. 签名、公证、干净 macOS 安装、发布包完整性和许可清单仍未完成；不得用两次有限 native 正常退出覆盖这些门。

## 新 Mac 的性能续跑边界

当前没有待集成的性能产品补丁：属性候选已否决并回退，临时诊断 snippet 也已撤回。下一步是在原 source012 上采集一次**只附着自有 App PID**的 `Animation Hitches`，再判断热点属于 WebKit/layout/composite 还是只有宿主；只得到宿主的 trace 不足以归因。现有 runner 已有 `--warm-attachment-only --native-hitches` 入口，但 runner 本身仍在旧机 ignored runtime，不能直接当作跨机工具。

新机执行前必须确认 Xcode `xctrace`、模板、签名/架构、唯一 PID、窗口/DPR、隔离 profile 与 10 GiB/2 GiB/CPU tick 资源门。原来的两次 timeline 尝试都在 CPU 门结束，没有 App 或 trace 进程。若 macOS 要求 Developer Tools 或隐私权限，应人工确认具体动作；不要修改系统设置来绕过门。旧机的 `used profile006` 已经使用过，不能在新证据里写成 unused。

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
- 这个 portable core 明确排除了词典/私库/运行资料、绘本/品牌/reading-spaces/essence、OCR adapter 实验和混合品牌的 `web/app.js`/`index.html`。它能从 GitHub 重建本轮阅读修复源码子集，但**不等于**完整 518 文件 manifest，也不继承原生/签名/设备验收。
- `candidate-011-module-closure-adapter.patch`：SHA-256 `2bdb5344fd8478bd850b505181b5c6fe5f69e749856c0346b1ff96ba90e4b99b`。portable core 的 `reader-chrome.js` 静态 import 了被主动排除的 `reading-click-paging-experiment.js`；这个 adapter 删除 import 和安装调用，保留原有点击翻页路径。它明确偏离冻结 011，只为得到不依赖缺失实验模块的 portable 开发版本。
- `candidate-012-progress-from-011.patch`：011→012 的单文件 exact diff，SHA-256 `154d2ef72194ea527879990a28fe955f6669c94466ca6aa21484549d761d81fb`。父文件 SHA-256 `4dd53131a689d3f9c4842d9e22fd521ae942451bc861896eee0842fc000caca7`，应用后 5437 bytes、SHA-256 `852c6a4aa18d10f2b7197f2c3716dc7f0e5d8191213f54985fb4bd8b341aaa21`。配套脱敏 `candidate-012-progress-overlay.json`（SHA-256 `61ecf0b590c6e48cd6670cb011540817de7b11dc2ad83b62607edc2860250823`）不含旧机路径或 receipt。
- `candidate-011-smoke-harness-adapter.patch`：仅修正旧测试上下文的 3 个注册点，SHA-256 `1d13443fb17827d1c3a1e6c5bbd389735d9775dc3581dbc29e6d4ad409f35ab0`。冻结 011 插件开始读取 `ctx.engine.lexicon`，但同一冻结包里的 `collections_smoke.py` 仍只提供 `ctx.store`；不加本 adapter，94 项 smoke 会在注册阶段报 `AttributeError`。adapter 传入 `lexicon=None`，不改变 35 个冻结候选文件，也不是产品修复。
- `candidate-011-shelf-performance-portable-main-74226309.patch`：相对 `main@74226309` 的 G3 书架性能 WIP，SHA-256 `34f74e47d60d09583e6908edd1e5da695b4770fdd5727d9be7e4d7c2631e4655`。`store.py` 与 `url_commit.py` 是冻结 011 的精确字节；`app.py` 只保留 `URLCommitter.list_documents` 接线，主动剔除同一候选中的 EasySink 品牌版本、picturebook/children-space 字段。三文件 AST 和无 URL / 空 URL committer / summary index 合成检查通过，但真实 G 大库性能仍未跑。
- `candidate-011-resume-only.patch` 仅保留为 provenance：它是 010→011 最后两文件 overlay，SHA-256 `ac8c6017014af819b9864897a5ff79cd1ea01eb907b49db23ffc46ad7075ee24`；新 Mac 不再依赖本机-only 010 来取得 portable core。
- `resource-governance-main-74226309.patch`：相对 `main@74226309` 的 portable 五文件治理快照，SHA-256 `a3da165baa7ac888424e8abb3ba879e186d6758fb444dd196b4c59c7ea688fb7`。它包含 1 秒 Darwin CPU tick 门，并剔除了 `EasySink.icns`、品牌版本、`reflow_omarchy_book.py` 和私有 `.runtime` caller 依赖；自包含 11 项小资源检查通过。活动修复线后来又迁了两个 native caller，但未收进这个固定 patch；接手者应取新的、可审阅的小 caller diff，而不是把旧机 runtime 当依赖。

### 未纳入 GitHub patch 的 active caller

活动修复环境中已有三组治理调用改动，但它们不能原样交付：

- `A/run-a.py` + `A/server.py`：一个 headless/native 验证 caller 单元，已改固定 A/B 槽、source admission 和独立数据库快照。
- `native-final-003/build_actual_app.py`：另一个实际 App 诊断 caller，已改固定槽与小文件刷新。
- `A/freeze-candidate.py`：开发候选冻结 helper，已改成 sealed base + small-code overlay。

这些文件位于 ignored `.runtime`，原 diff 含旧机绝对仓库路径、固定 sealed root、私库输入和既有诊断 App 约束；直接提交会让新 Mac 依赖旧机，并可能暴露私人运行布局。因此本交接**主动不附该 diff**。下一步应把路径、slot root、sealed manifest、App 和数据库全部改为显式参数，以合成 fixture 做小检查后，再形成相对公开基线的独立 patch。当前已做工作及缺口已记录，不需要旧机才能理解下一步，但不能声称这些 caller 已可迁移运行。

应用顺序：

```bash
# 当前目录保持在 handoff 分支；先把材料保存在 worktree 之外
handoff_root="$PWD"
dev_python="$(uv run python -c 'import sys; print(sys.executable)')"
scratch="$(mktemp -d)"
cp docs/handoff/patches/candidate-011-portable-core-* "$scratch/"
cp docs/handoff/patches/candidate-011-module-closure-adapter.patch "$scratch/"
cp docs/handoff/patches/candidate-012-progress-* "$scratch/"
cp docs/handoff/patches/candidate-011-smoke-harness-adapter.patch "$scratch/"
cp docs/handoff/patches/candidate-011-shelf-performance-portable-main-74226309.patch "$scratch/"
cp docs/handoff/patches/resource-governance-main-74226309.patch "$scratch/"
cp tests/fixtures/handoff_synthetic.md "$scratch/"
shasum -a 256 "$scratch"/*

# 精确 main 基线使用独立 worktree，交接文档不会消失
git worktree add --detach "$scratch/source" 74226309ebd1211bdbeeace4323049c2c175f742
cd "$scratch/source"
git apply --check "$scratch/candidate-011-portable-core-main-74226309.patch"
git apply "$scratch/candidate-011-portable-core-main-74226309.patch"
git apply --check "$scratch/candidate-011-module-closure-adapter.patch"
git apply "$scratch/candidate-011-module-closure-adapter.patch"
git apply --check "$scratch/candidate-012-progress-from-011.patch"
git apply "$scratch/candidate-012-progress-from-011.patch"
git apply --check "$scratch/candidate-011-shelf-performance-portable-main-74226309.patch"
git apply "$scratch/candidate-011-shelf-performance-portable-main-74226309.patch"
git apply --check "$scratch/resource-governance-main-74226309.patch"
git apply "$scratch/resource-governance-main-74226309.patch"
git apply --check "$scratch/candidate-011-smoke-harness-adapter.patch"
git apply "$scratch/candidate-011-smoke-harness-adapter.patch"

# 使用 handoff checkout 已经 uv sync 的解释器；不借旧电脑绝对路径
PYTHONPATH="$PWD/src" PYTHONNOUSERSITE=1 "$dev_python" -m pytest tests/test_tokenize.py -q
PYTHONPATH="$PWD/src" PYTHONNOUSERSITE=1 "$dev_python" -m wise_reader.collections_smoke
"$dev_python" scripts/desktop/check_resource_policy.py --output "$scratch/resource-check.json"
```

上述 patch/adapter 顺序已在干净 detached `main@74226309` 实跑：35 个 manifest 文件逐个 bytes/SHA 匹配，9 个 Python 文件 AST 解析通过，24 个 JavaScript 文件 `node --check` 通过；从这 24 个候选根模块递归检查到 42 个可达 JS 模块、92 条静态相对 import，缺失为 0。012 exact diff 另在父文件 SHA 匹配的轻量隔离目录应用，产物 hash/bytes 匹配并通过 `node --check`。`6 passed`、adapter 后 `94 API checks passed`、资源策略 11 项小检查通过，书架 patch 的三文件 AST 与小型 Store/URLCommitter 合成检查通过。未加 adapter 的 94 项失败与缺失点击实验模块均保留为已知 portable drift。由于本轮禁止下载，实际测试把命令里的 `$dev_python` 替换成旧机已有 Python 3.13 解释器，并用 `PYTHONPATH` 断言导入仍来自 detached 源；新 Mac 的 `uv sync` 尚未验证。这个 worktree 只是 WIP 复建，不要提交到 main；应用后仍要重新运行当前 owner 指定的浏览器/原生场景。不要把 patch、小检查、模块闭包或源码 hash 成功写成产品 PASS，不要从本机绝对路径复制候选资源。

## 推荐的下一步

1. 在新 Mac 上按 `START-HERE.md` 验证远端基线和两个无大资源 smoke。
2. 在新 Mac 上按父 SHA 应用 012 单 progress patch，先复现 011 红，再复验 note 10 → `I've`、Quit 前后 SQL 和无导航 cold open；不要从共享 dirty 猜代码。
3. 把 safe 撤回的 headless 绿复验到目标浏览器与原生 presentation seam，保留 source/full-gloss/显式译句定位门。
4. 复用已纠正的 direct parent / executable / birth 控制器身份门，在隔离 012 上先采自有 PID 的 `Animation Hitches` 最小 TOC/热点，再跑严格 65 ms rapid、001/002、Doc40 与物理触控板；不把 controller、慢节奏 19 次输入或续读子门 PASS 当产品 PASS，也不改签绕门。
5. 真实 App caller、失败无全量复制、free-space 预算、G 大库与发布资源清单齐全后，才恢复构建链和性能门。
