# V1.1 records 前后端集成只读复核

复核结论：**未发现 P0；发现 4 项 P1**。其中 R1、R2 是导入时静默遗漏或覆盖个人资料，R3 是导出文件与恢复入口的容量合同不一致，R4 是并发合并后释义冲突重试失去原范围约束。修复前，不能把恢复完整性和跨窗口释义归属判为通过。

这是当前代码的静态调用链复核，**四项均未在本轮运行复现**。它不替代主控正在进行的真实 UI 走查，也不把此前临时库 API smoke 的结果升级为这些分支通过。

## 范围与证据边界

- 审阅当前共享工作区，包括未提交的新文件；HEAD 为 `023936a1d9df72715fc6794dbe64e3c38352eacb`。不能用该 HEAD 的提交差异代替当前集成代码。
- 主要范围：`web/collections-{store,list,dialogs,word,marks}.js`、`web/plugins/collections.js`，以及 `src/wise_reader/{collections,collections_source,collections_transfer}.py`、`src/wise_reader/plugins/collections.py`。沿调用读取了 source-selection、reader、reading-interactions、core 和原有 content/Store/assist/notes 等相关实现。
- 依据：根 `AGENTS.md`、`GLOSSARY.md`、`docs/agents/domain.md`、ADR 0008、`docs/72-v11-reading-loop-spec.md`、`docs/73-v11-development-control.md`。后者第 19–29 行为冻结的路由/字段合同。
- 本轮没有运行测试、API smoke、浏览器操作或真实 provider；没有读写用户数据库、变更配置、重启服务、提交或发布。唯一写入是本报告。
- 按 code-review 的 Standards / Spec 两个维度整理；这是一次单审阅者复核，不声称有两个独立审阅者交叉验证。
- 主文件最后一致性读回时间：`2026-10-11T01:47:30.587150+08:00`。审阅中 `collections-dialogs.js` 曾被并行修改，已重新读取；本文采用追加对话框事件隔离后的版本与行号。具体 SHA-256 在文末。

## Standards

未发现需要列为 P0/P1 的明确仓库规范违反。当前审阅遵守只读实现文件、不新增事后单元测试、不运行完整 E2E 的边界。未把风格或重构偏好提升为数据安全缺陷；以下问题属于 Spec / 行为合同。

## Spec

### R1 · P1：导入较大摘录会覆盖刚保留下来的本机子范围个人资料

**位置：** `src/wise_reader/collections_transfer.py:369–380`，尤其第 374–376 行；关联 `src/wise_reader/collections.py:199–231`。前端成功提示在 `web/collections-dialogs.js:549–550`。

**触发条件：** 同一可靠来源和版本，本机只有一个相交摘录，例如 `abcde` / `[0,5)`，已有我的释义、采用解释或解释历史。恢复另一个库导出的 `abcdefghij` / `[0,10)` 摘录，导入 UID 不同，且导入记录不含该本机个人资料。

**代码链路：**

1. `import_data()` 调用 `service.save()`。保存并集时，后者清空扩大后整条记录的释义/解释，把旧资料正确移入 `subranges`，并复用唯一旧记录的 ID。
2. `merged_ids` 只含被吸收且不再存活的其他 ID；只有一个旧摘录时返回 `[]`，并不意味着“创建了全新记录”。
3. 导入范围就是并集，故 `same_range` 为真；扩大后的整条释义/解释为空，且 `merged_ids=[]`。第 376 行执行 `local = {**saved, "anchor": bound["anchor"]}`，用导入对象替换整个 payload，丢掉步骤 1 刚保留下来的本机 `subranges`。
4. API 返回导入成功，界面显示“已恢复”。导入没有返回 undo token，第二次 `_write()` 还会使内部 save 的 undo 修订失效，不能通过正常撤销恢复这次覆盖。

**影响：** 本机旧范围的个人释义、解释和历史从当前记录及随后导出中消失。旧值可能仍在内部 undo 收据中，不能据此声称物理字节全部消失；但正常 UI/API 已无法找回，属于用户可见的资料丢失。

**违反：** 规格故事 12（第 24 行：合并不丢原子范围资料）、故事 23/31，以及第 53/62 行的子引用保留、可恢复导出；ADR 0008 第 7 行要求旧解释仍属于原子范围。

**修复要求：** 明确区分全新插入与复用/扩展本机记录，不能用 `merged_ids` 为空或整条释义为空推断没有本机资料。导入合并必须保留已有子范围、解释历史和个人释义，再合入导入内容。

**主控待复现（本轮未执行）：** 在临时库 A 为 `[0,5)` 保存个人资料；库 B 对同一来源导出 `[0,10)`；A 恢复该文件，检查详情中的原片段资料及再次导出的 JSON。当前分支会丢失 A 的个人资料。

### R2 · P1：相同范围去重忽略新增子范围资料，却永久记为已恢复

**位置：** `src/wise_reader/collections_transfer.py:353–368`，尤其第 357–362 行；重复恢复的提前返回在第 315–326 行。

**触发条件：** 两个库对同一来源、同一完整范围有不同 UID。两条记录顶层 `anchor/quote/explanation/explanation_history/my_meaning` 相同，但导入记录的 `subranges` 含本机没有的个人释义或解释历史。例如本机直接收藏 `[0,10)`，外库先为 `[0,5)` 写释义，再扩展为 `[0,10)`；两边完整范围的顶层个人字段均为空。

**代码链路：** 去重只比较上述五个顶层字段。只有顶层不同且未出现相同 incoming 对象时，才进入分支并追加导入 `subranges`。顶层相同时完全跳过子范围合入，却增加 `duplicates` 并写入该 UID 的导入映射。随后重试同一文件由映射提前返回，也不会补回遗漏。

**影响：** 导入文件中真正新增的个人资料没有恢复，界面只报告“重复”，后续导出仍缺失这些资料。原备份文件仍有内容，但正常重复恢复不能修补，不能将该结果当作无损幂等。

**违反：** 规格第 24/43/53/62 行要求保存合并前个人内容与可恢复资料；第 45 行的幂等不能解释成丢弃新增的嵌套内容。

**修复要求：** 顶层去重与子范围资料合并分开处理。无论顶层是否相同，都按稳定范围及内容身份合入遗漏的子范围/历史，并保留本机较新的编辑。只有完整处理后才登记该导入身份。

**主控待复现（本轮未执行）：** A 直接保存 `[0,10)`；B 保存 `[0,5)` 并写释义，然后合并到 `[0,10)`。将 B 导入 A，检查子范围、再次导出，并重复导入一次。当前分支两次都不能恢复 B 的释义。

### R3 · P1：成功生成的 JSON 备份可能被自身恢复入口拒绝

**位置：** `src/wise_reader/collections_transfer.py:167–170`；`src/wise_reader/plugins/collections.py:139–151`；`web/collections-dialogs.js:529–549`。

**触发条件：** 较大的合法导出，满足紧凑 JSON 的 UTF-8 字节数不超过 8 MiB，而缩进后的下载文件超过 8 MiB。多条带子范围和历史的记录可以进入这一边界。

**代码链路：**

1. 导出校验用 `packed(data)`，其实现是无空白的紧凑序列化（`collections_source.py:16–20`）。
2. 路由实际下载 `json.dumps(..., indent=2)`，没有再次检查文件字节数。缩进和换行增加体积，界面仍提示“已生成下载文件”。
3. 恢复界面在解析前检查实际 `file.size > 8 MiB`，直接拒绝该备份。
4. 另一个边界是服务端导入限制整个 `{data: ...}` 请求为 8 MiB，而导出限制仅计算 data 本身；即使改成紧凑下载，接近上限时请求包裹仍可能导致 413。

**影响：** 用户可成功下载由产品生成、却不能经产品恢复的备份。若据此进行后续永久清理，恢复承诺失效。本项限定于容量边界，不表示所有小文件都无法恢复；本轮没有生成或测量边界文件。

**违反：** 规格故事 31 与第 62 行要求可恢复的版本化 JSON。前后端各自限制大小是合理的，但限制对象和序列化格式必须一致。

**修复要求：** 统一最终文件和请求包裹的容量预算。下载前检查实际输出字节数，或统一紧凑输出并给请求包裹留预算；不能让界面先宣告备份成功再要求用户手工拆开自己的恢复文件。

**主控待复现（本轮未执行）：** 在临时资料库构造满足 `compactBytes <= 8 MiB < prettyBytes` 的合法按书导出，记录两种字节数；下载后直接从 UI 恢复。另单独验证紧凑 data 加请求包裹后的上限。修复后这两条边界应能恢复，或在导出阶段明确拒绝并提示缩小范围。

### R4 · P1：并发扩大摘录后，冲突重试把旧范围释义写到新范围

**位置：** `web/collections-dialogs.js:315–353`；原始身份与引用保存在第 193–206 行；PATCH 在第 275–278 行。服务端范围扩大与同 ID 复用见 `collections.py:205–220`，整条释义写入见第 233–240 行。

**触发条件：** Web/macOS 或两个窗口同时操作。A 打开 `[0,5)` 的详情；B 将这条作为存活主记录扩展到 `[0,10)`。A 随后输入仅针对原片段的释义，旧 revision 被服务端正确拒绝。

**代码链路：**

1. “重新核对版本”按旧引用前缀检索，再仅按原记录 ID 找到最新值；不重新比较 `source_identity/anchor/quote`。
2. 合并保持主记录 ID，较大引用仍含旧前缀，所以最新并集会命中。
3. 核对窗口只显示当前释义和用户输入；外层详情仍显示打开时的旧引用，没有展示范围从 `[0,5)` 扩大到 `[0,10)`。
4. “用我的输入保存”把 `item` 替换成 latest，以最新 revision 重发 PATCH。后端把该输入写成整个并集的 `my_meaning`，而不是原 `[0,5)` 的子范围释义。

**影响：** revision 守卫虽然生效，前端的恢复流程却把针对旧来源范围的个人内容重新绑定到扩大后的范围，用户看见的仍是旧引用。不是错绑到另一数字 ID 的书，而是同一 ID 下丢失个人释义的范围语义。

**违反：** 规格第 24/53 行与 ADR 0008 第 7 行要求合并保留原子范围资料；故事 35 包含多窗口/客户端使用。原记录 ID 相同不足以证明引用未变。

**修复要求：** 冲突重试必须校验原始来源身份、版本和完整范围。范围改变时保留草稿并显示变化后的引用，禁止把它当成普通同范围释义冲突重发；如支持保存到原子范围，应有明确的界面与服务端语义。若要求重开，应保留原草稿供用户取回。

**主控待复现（本轮未执行）：** A 打开短摘录详情但先不输入；B 扩展这条摘录；A 输入释义，等待 409，再点重新核对及“用我的输入保存”。检查 A 所见引用和最终顶层/子范围 `my_meaning` 的归属。

## 冻结 API 与前端调用对照

以下“对齐”仅指读代码所见方法、字段与相关守卫一致，**不表示真实 UI 或持久化验收通过**。

| 调用 | 前端入口 → 后端 | 静态结论 |
| --- | --- | --- |
| 列表/过滤/分页 | `collections-list.js:104` → `GET /collections`；路由第 105–109 行 | `doc_id/book_id/kind/q/limit/offset` 与 `{items,total}` 对齐，搜索及分页上限有对应；本书入口传实际书归属，独立文章传 doc_id。 |
| 词语新增/删除 | `collections-word.js:199–207`、store `remove()` → POST / DELETE | kind、anchor、解释字段对齐；DELETE 发送 revision，重复保存按 kind 分开；普通词卡不会把模型解释伪装为离线词典隐式采用。 |
| 摘录新增/并集/删除 | `web/plugins/collections.js:219–245` → POST / DELETE | 精确相同选区才删除，否则保存；返回 `item.anchor` 用于更新仍然对应的选区。后端真实相交、同版本并集；**导入复用这条路径时存在 R1**。 |
| 我的释义 PATCH | `collections-dialogs.js:275–278` → PATCH /{id} | `expected_revision` 与 20,000 字限制对齐；**冲突恢复有 R4**。 |
| 采用解释/历史 | `collections-dialogs.js:419–429` → PATCH `{adopt_assist_id,expected_revision}` | 用户预览后采用；后端校验持久 assist、成功状态、文档、版本及精确/包含子范围，保存旧解释历史。**导入后的历史保全有 R1/R2**。 |
| undo | `collections-store.js:67–78` → POST `/undo` `{token}` | 仅有 token 时提供撤销；后端持久收据、revision 和活动范围冲突守卫，拒绝重复使用及覆盖后续修改；前端通过 change 刷新状态。 |
| understood/retained | `collections-word.js:241–246` → POST `/feedback` | 仅发送改变的字段；后端 `exclude_unset` 保留缺省字段，understood 可 null，retained 独立；未改旧全局 verdict。 |
| 当前篇章 state | `web/plugins/collections.js:104` → GET `/state/{doc_id}` | `{items,feedback}` 对齐；marks 根据 reader 当前版本过滤收藏和反馈，避免把旧版本直接画在新内容上。 |
| source 预览/继续 | `collections-dialogs.js:100–159` → GET `/{id}/source` | 先显示快照，可靠 available 才开放继续；继续前重新获取来源；明确点击才跳转，historical/current_context 与旧快照分开展示。 |
| Markdown/JSON 导出 | `collections-dialogs.js:515–538` → POST `/export` 文件响应 | scope、类别开关、format 与 blob 下载对齐；Markdown 逃逸内容。**JSON 容量往返有 R3**。 |
| 导入 | `collections-dialogs.js:539–550` → POST `/import` `{data}` | 响应计数字段对齐，来源不直接信任旧数字 ID；**语义完整性有 R1/R2，大小有 R3**。 |
| cleanup | `collections-dialogs.js:552–557` → POST `/cleanup` | `{book_id|ids,collections,notes,feedback,confirm}` 对齐；后端拒绝无 scope/无类别/未确认，按选中类别清理并移除相关 undo 收据，不删除原书。并发永久清理未运行验证。 |
| resurface | `collections-list.js:267,293` → GET/POST `/resurface` | next/hide/show/snooze、id 与 `{enabled,item,reason}` 对齐；后端持久当天选择、七日避重与三十日暂缓，候选排除已删除记录。真实跨日/重启效果未验证。 |

## anchor / version / explanation / source 安全核对

- `collections_source.validate():86–126` 从服务端内容验证 UTF-16 字符边界、范围、跨段连续性与引用；拒绝非法选区，以服务端值构造快照/PDF 来源信息。保存与反馈共用此入口。
- `collections_source.resolve()` 使用来源身份和可靠唯一引用匹配；导入清掉原 doc/book 绑定并重新解析，不能因原数字 ID 恰好存在就跳到本机另一书。找不到可靠来源保留快照，返回不可用；不把历史 OCR 版本直接当成当前画面范围。
- `collections.py:157–178,241–267` 对采用解释作持久结果及范围/版本检查；导入中的 assist_id 改为 imported_assist_id，只作来源记录，不据其绑定本机 assist。
- 预览和个人文本展示使用转义或 textContent；来源预览 GET 不更新续读。没有在 records 保存/恢复路径中发现真实模型调用。
- 以上守卫不能消除 R1/R2 的嵌套资料丢失，或 R4 在前端重试中对范围身份的忽略。未发现 P0 不等于对所有恶意输入、跨版本 PDF 或并发状态作了运行验证。

## 主控集成要求

优先修复 R1/R2，再修正 R3 的统一容量预算与 R4 的冲突范围核对。四项均可在保持冻结路由和字段名的前提下修复；如果 R4 决定增加子范围编辑 API，需要先通知主控与另一侧，不能单边改合同。

真实 UI 走查应补入上面四个具体失败类，并保存修复前结果、修复后详情/导出内容和容量数值。涉及恢复与永久清理的组合只使用临时资料库。现阶段不需要为本报告复跑完整套件，也不应把此前 smoke 的计数用于关闭这些发现。

## 审阅版本指纹

```text
1e55ad9948faa5a2f80759df5819582131a9650e070b01aeddea969d3a3fa2fd  web/collections-store.js
6cbf82e910756db185002424d45367f8598941f2fc569439ce100ea86fad6bc0  web/collections-list.js
76b4700b603df072df0ee3c5d6bccff3a4b235548c0f761f6d26464f27d7be87  web/collections-dialogs.js
78a310614f0757f1cfe90c9d40d223f42ea477dddd2460c12a636348672b3387  web/collections-word.js
0cf369f7b8bbe6a1badf297d9bef1123622cb1564107c855c76cfbb9b99b4b47  web/collections-marks.js
cd35b33b2e2e943b27c4fa39a31c235e699d2e3e9ad23a8c6888c099722d7848  web/plugins/collections.js
fd2525789ce4911102d40873728335436e6d0d876c60b14a0659774b135902aa  src/wise_reader/collections.py
003e1594bf362695abea7b501b7c77f65ca3e0c6adab13f56acf71327cf5dd98  src/wise_reader/collections_source.py
1d74d46ce42e43b520ceb0a44aa866fe76f5a18b93643188bc1c6226531dd863  src/wise_reader/collections_transfer.py
007f94ac5790598cd80030b0230fc4337dc288d3051df7e7551088a6008d5e6d  src/wise_reader/plugins/collections.py
```

Standards：0 项 P0/P1；Spec：0 项 P0、4 项 P1，最严重的类别为静默遗漏/覆盖个人资料。全部结论仅针对上述静态版本。

## R1–R3 后端修复与真实路由复验 · 2026-10-11

以上原始审阅与版本指纹保留不改。本节记录用户随后授权的后端修复：**R1–R3 已修复并通过对应临时库 API 场景；R4 仍由 Ohm 处理前端，未在本任务中关闭。** 本节没有声称 Web/macOS 真实 UI 验收完成。

### 实际改动与合同

- `src/wise_reader/collections_transfer.py`：新增统一的个人资料合并函数。无论两条记录的顶层内容是否相同，始终合入本机及导入的 subranges，以完整内容去重，保留相同范围的不同释义/历史；合并后超过 2,000 个子范围会在事务中拒绝，不截断。扩大后空白的整条记录可接收导入快照，同时保留原本机的所有子范围。已有顶层个人内容继续保留，导入的不同顶层内容作为对应范围的历史资料保存。
- `src/wise_reader/plugins/collections.py`：JSON 下载改用与导出容量校验完全相同的紧凑 UTF-8 序列化。data/文件上限仍为 **8,388,608 字节**；HTTP 请求另留 **1,024 字节**给 `{data:…}` 包裹及有限空白，总请求上限 **8,389,632 字节**，解析后仍独立校验 data 不超过 8 MiB。没有放宽数据文件上限。
- 新增 `src/wise_reader/collections_repair_smoke.py`：修复前编写的定向生产路由复现工具，仅创建自己的临时 SQLite 库，以实际 FastAPI 路由、Store 和 content/assist schema 执行；不使用模型、mock provider、用户配置或运行中的服务。大请求/响应按原始字节 gzip 保存，并记录字节数、SHA-256。
- `/api/collections` 路由、请求及响应字段、`PATCH expected_revision` 合同均不变；**没有新增 expected_anchor，也没有修改共享 UI**。R4 可继续用现有 revision 拒绝陈旧写入，由前端核对 sameSelection/完整来源身份后决定是否重试。

### 首失败已保留，随后修复

先运行未修复的实际路由：**76 次 HTTP 请求，18 项语义检查中 10 通过、8 失败**。失败恰含 R1 本机资料及再导出丢失，R2 两个不同 UID 的嵌套资料及再导出遗漏，以及 R3 文件超限、包裹请求 413、恢复条数为零。没有为制造首失败篡改生产逻辑。

其中 R3 的原始测量为：紧凑 data **8,388,608** 字节，实际下载文件 **8,438,666** 字节，前端 8 MiB 检查会拒绝；包裹请求 **8,388,617** 字节，真实导入响应 **413**，错误为“导入请求超过 8 MiB”。

修复后重跑同一工具：**80 次 HTTP 请求、19 项语义检查全部通过**。新增的一项执行来自首失败时无法进入的“成功恢复后的重复恢复”分支；没有改变断言来制造通过。实际验证包括：

- 导入扩大摘录后，原本机子范围的释义、采用解释、旧解释历史保留，且再次导出仍包含这些内容。
- 两个不同 UID、顶层相同但各带不同子范围资料的恢复均保留新增内容；重复恢复同一 UID 不改变记录内容或 revision；不同根释义留在子范围，不覆盖较新的本机释义。
- 非法子范围的导入返回 422，前后列表完全相同，事务未部分提交。
- 恰好 **8,388,608 字节**的下载文件符合前端文件限制；**8,388,617 字节**包裹请求返回 **200**，恢复 10 条，再次导入报告 10 条重复且记录不变。
- data 多 **1 字节**时导入返回 413，资料不变；导出超过同一上限也返回 413，不产出不可恢复的备份。

容量场景的 10 条记录故意没有本机原文，均诚实返回 unresolved=10，快照正常保留；这不是来源匹配成功证据。R1/R2 使用两侧同一真实合成原文及服务端锚点，解释是写入实际 assist schema 的明确合成成功结果，不代表真实模型质量。工具仍发出环境现有 Starlette/httpx 弃用提示，未安装或变更依赖。

### 可复现的本地证据

本地保留证据目录（位于已忽略的 `.runtime`，不含用户数据）：

`/Users/fish/projects/Personal/APP/wise_reader/.runtime/evidence/v11-records-r1-r3/`

其中 `first-failure/`、`after-fix/` 各保留完整 transcript、result、逐请求/响应 gzip 及关闭后的临时 SQLite 库；`production-before/`、`production-after/` 保存涉及修改的代码与同一工具；`repair.diff` 是本次实际后端改动，`sha256.json` 覆盖证据文件。

| 证据 | SHA-256 |
| --- | --- |
| `first-failure/transcript.jsonl` | `6e4f5e0c4df6f856bcdbc28fd55fd2138933f55a791222ce8dedcce3462df42b` |
| `first-failure/result.json` | `b266395395642c86190d240507c19313e35082602db88899884b023644768d67` |
| `after-fix/transcript.jsonl` | `8c4789aae6d2b39b3991e353f1bac2b6bca1c0b0220479e7f86738cb4b0fc05c` |
| `after-fix/result.json` | `eb1ca043fdd9142c41ac856d5433125f668594153d7887abf273a62d2d70473e` |
| `repair.diff` | `895267f90949a8a9dea3f49f5285bfe06d701cd770c443526a3faf2ab91d5cfd` |

重放当前修复，始终生成全新的临时库：

```sh
PYTHONPATH=src .venv/bin/python -m wise_reader.collections_repair_smoke
```

首失败原路径为 `/var/folders/f4/gkwt98j97fj2vz13z5m54lxc0000gn/T/wise-collections-repair-e60ujrji/`；修复后为 `/var/folders/f4/gkwt98j97fj2vz13z5m54lxc0000gn/T/wise-collections-repair-1bz29ek5/`。两者已复制到上述本地证据目录，不依赖系统临时目录保留期限。

### 剩余集成边界

这次没有运行原有 94 请求 smoke、全套 E2E、真实 UI、服务重启或客户端构建。没有提交、推送、发布、改写用户库或追溯修复既有资料。修复保证本节已复验的新导入行为；不能凭代码修复宣称此前已丢失且无备份的个人资料自动恢复。R4 与主控完整 Web/macOS 走查继续独立完成。
