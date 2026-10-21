# EasySink 交接状态（2026-10-21）

## 三层代码必须分开

| 层 | 固定标识 | 用途 | 结论 |
| --- | --- | --- | --- |
| 远端主线 | `main@74226309ebd1211bdbeeace4323049c2c175f742` | 新设备 clone、文档和开发基线 | 可复现，但不含近期修复 |
| 本机共享 checkout | 同一 HEAD，存在大量 tracked/untracked dirty | 并行修复、绘本、品牌和桌面实验 | 不可整批提交，不是候选快照 |
| 冻结候选 011 | manifest `200835d735cc49630a37f64ec8f4e70d336e8e5bb944beaa643caf8d5c1bd822`，518 文件 | 一次固定的本机修复证据 | 约 1.07 GB、未合 main、未形成发布门 |

当前修复 owner 仍在推进。最新监督口径中，006 因“已读前文应延后到安全时机刷新”仍 HOLD；007 的纯位置补偿方向已撤回。011 的局部证据不能覆盖这个更晚的产品判断。

## 已有的有限证据

- 011 上的 001/002 原生 GUI、字号/单双页、正常 Quit 后冷启动 source×2、Doc40 段落/译句有有限场景通过。
- 干净远端基线源码已通过 `tests/test_tokenize.py` 的 6 项和 `wise_reader.collections_smoke` 的 94 项合成 API 检查。
- 资源治理 helper 有 10 项小型假测通过。

这些都不等于完整功能、最终原生、真实触控板、真实性能或发布通过。

## 仍未闭环

1. scope 第三种 pending 状态和最终 safe 撤回/刷新语义未闭环。
2. 右页操作仍可能提前重排已读前文；需要 presentation 延后，而不是坐标补偿。
3. 原生长帧、物理触控板卡片滚动/翻页边界、书架真实 App 性能未验收。
4. 001/002 与 Doc40 只有有限输入；还不能跨版本拼成整体绿。
5. 资源治理已改 helper/部分 caller，但真实入口链尚未全部恢复，旧 caller 仍需迁移。
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

- `candidate-011-resume-only.patch`：只包含 010→011 的 `web/plugins/progress.js`、`web/reader.js` 两个续读差异。父 manifest 必须是 `89d84e64bf3e197096878fb50d5e53c3214e0e963ab200af4f882889710d60e6`；patch SHA-256 是 `ac8c6017014af819b9864897a5ff79cd1ea01eb907b49db23ffc46ad7075ee24`。它**不能**直接应用到 `main@74226309`，也不携带约 1 GB 的父候选。
- `resource-governance-main-74226309.patch`：相对 `main@74226309`，包含 `build.py`、`fetch_lexicon.py` 和 3 个资源策略文件；patch SHA-256 是 `51514fc75b1bef882572f46caa000c549c0f5635e7542d69df20844051bf451f`。已做 `git apply --check`，但只通过 helper 小测，真实 caller 链未全恢复。

应用顺序：

```bash
# 只做审阅；先核 patch 本身
shasum -a 256 docs/handoff/patches/*.patch

# 资源治理：仅在精确 main 基线上建立实验分支
git checkout -b experiment/resource-governance 74226309ebd1211bdbeeace4323049c2c175f742
git apply --check docs/handoff/patches/resource-governance-main-74226309.patch
git apply docs/handoff/patches/resource-governance-main-74226309.patch

# 011 overlay：仅当你已另行取得并核实 exact 010 source
git apply --check docs/handoff/patches/candidate-011-resume-only.patch
git apply docs/handoff/patches/candidate-011-resume-only.patch
```

应用后仍要重新运行当前 owner 指定的场景。不要把 patch apply 成功写成产品 PASS，不要从本机绝对路径复制候选资源。

## 推荐的下一步

1. 在新 Mac 上按 `START-HERE.md` 验证远端基线和两个无大资源 smoke。
2. 向修复 owner 要一个新的 fixed source SHA/manifest，以及 006 HOLD 的最小复现，不从共享 dirty 猜代码。
3. 优先修正“当前展开页冻结，真正离页后刷新”的 presentation seam；保留 source/full-gloss/显式译句定位门。
4. 完成 target browser 后，再在隔离原生 candidate 上跑 001/002、Doc40、冷启和物理触控板。
5. 资源治理的真实 caller 全部迁移、失败无全量复制、free-space 预算和发布资源清单齐全后，才恢复构建链。
