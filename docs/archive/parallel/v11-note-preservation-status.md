# 删除原书后的独立笔记保留

主控修复 Spec review P1。修改前失败类别：library 删除先移除书籍归属、Store.delete_document 再删除 wr_note，既丢正文来源也丢独立想法；直接删除独立文章同样丢失。保留笔记但继续提供失效跳转会误导；保存快照后导出仍可能遗漏原书名；删除孤立笔记的撤销不能要求原文仍存在。快照失败必须回滚原书删除，不能只保存半本资料。明确清理笔记后不可用旧撤销恢复。

验证使用临时数据库上的真实 library/notes/collections API；记录首失败和修复后结果。浏览器与正式用户资料另由最终走查核验。没有新建事后单元测试。

## 两项 P2 修复前失败类别（独占 notes.py / note_sources.py）

- F1：先删除笔记、再删除原书、最后撤销，receipt 中没有来源快照；恢复正文想法却失去书名、篇章、语境与来源身份。删除笔记时须捕获完整来源，已有 source_snapshot 原样保留。
- F2：PUT 的存在性检查、正文/引用更新、锚点写入不原子；与 DELETE 交错可留下旧正文配新锚点。整个 PUT 必须在同一事务内完成。
- F3：undo 忽略 receipt 中的锚点，依赖残留 wr_anchor。残留锚点被改动、删除或原笔记无锚点时，撤销必须恢复 receipt 的准确锚点状态。
- F4：PUT/undo 的锚点写入失败不能提交半条笔记；undo 失败不能消耗 receipt，捕获来源失败不能删除笔记。
- F5：已失去原文的旧笔记仍能修改个人正文；删除/撤销不能改写已有来源快照。本次定向回放通过整书删除验证，独立文章复用相同 Store 保留入口，未另记为 API 实测。
- F6：明确永久清理 notes 后旧 receipt 不能恢复；复用 Epicurus 的 collections_transfer hooks，不另改其文件。

顺序：先运行现有 replay 的 after 场景（独立命名 baseline）；再扩展临时数据库实际 API 场景并保存独立首失败；仅随后修复两份产品文件；最后重跑相同场景保存另一份 after 证据。不覆盖既有证据，不访问正式资料或模型，不新增 unit tests。

## P2 修复交接与冻结

产品改动仅在本贡献独占的 `src/wise_reader/plugins/notes.py`、`src/wise_reader/note_sources.py`：

- 创建删除 receipt 前，在同一删除事务中捕获完整来源快照；已有非空快照逐字保留。原书删除和笔记删除复用同一来源捕获函数及 Epicurus 已完成的 `note_snapshot` hook。
- PUT 的存在性检查、正文/引用写入、锚点写入与返回记录读取在同一事务内完成。
- undo 在事务内先恢复笔记，再按 receipt 恢复锚点（包括原来没有锚点）；成功后才消耗 receipt。失败整体回滚。

验证顺序与独立证据：

1. [已有 after 场景 baseline](/Users/fish/projects/Personal/APP/wise_reader/outputs/v11-delivery-20261011/note-deletion-after-p2-baseline.json)：7/7。
2. [新增首失败](/Users/fish/projects/Personal/APP/wise_reader/outputs/v11-delivery-20261011/note-deletion-p2-first-failure.json)：26 项中 11 项失败。并发 PUT 返回 200/null，undo 得到旧正文配新锚点；PUT 锚点故障后正文已部分提交。此文件保留不改。
3. [首次修后运行](/Users/fish/projects/Personal/APP/wise_reader/outputs/v11-delivery-20261011/note-deletion-p2-after-repair.json)：前 25 项通过；回放屏障等待 DELETE 进入路由，但新事务已在其插件权限检查阶段阻挡读取，故脚本未完成。仅将屏障观察点前移至依赖入口，保留此失败记录。
4. [最终修后证据](/Users/fish/projects/Personal/APP/wise_reader/outputs/v11-delivery-20261011/note-deletion-p2-after-repair-verified.json)：26/26，48 次实际临时数据库 API 请求。PUT 存在性检查时事务深度 1，DELETE 在 PUT 暂停期间未完成，释放后 undo 恢复一致的新正文/引用/锚点。捕获来源失败、PUT/undo 锚点故障回滚、receipt 重试/单次使用、旧快照与编辑后正文、清理后禁止恢复均通过。

复现命令（使用新的 stage 名称，脚本拒绝覆盖已有证据）：

```sh
PYTHONPATH=src .venv/bin/python outputs/v11-delivery-20261011/note-deletion-replay.py p2-main-recheck p2
```

脚本在每次扩展运行保存自身副本、请求/响应、临时 DB 路径、并发观察值和代码 SHA-256。并发使用行跟踪屏障，锚点故障使用临时 SQLite trigger；这些是明确的调度/故障探针，未替换 Store、业务函数或 API 返回。仅合成资料和真实 API/SQLite 路径；没有浏览器、正式用户资料、provider、完整 E2E 或新 unit tests。静态差异空白检查通过；最终回放记录的四份源码/脚本哈希与结束时文件一致。

本贡献已冻结，交主控集成与最终验收。冻结 SHA-256：

- `src/wise_reader/plugins/notes.py`：`53b68c60726ac207f5e73237fb2cadc0c714f21dfa9b3c1cdbbf90fa3f156182`
- `src/wise_reader/note_sources.py`：`4e2bc968d1d8d5b3648d6cf622780d42ecc21a0c6309d24542a71c8a55ccbdcf`
