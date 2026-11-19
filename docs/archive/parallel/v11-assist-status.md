# V1.1 assist / #42

状态：分工实现完成，等待主控集成走查；尚不构成真实模型、浏览器或客户端验收。真实模型调用数：0。未提交/推送/发布 issue，未写用户库或正式配置，未重启服务。

## 实际改动文件

- `src/wise_reader/reading_assist.py`：新增 context 预览/生成契约、持久请求保护和历史保存；公共 selected 的原文版本读取提取为 source_content；translation/grammar 的选区/完整句语义与校验保持。HTTP 错误响应也在 raise 前保留至诊断。
- `src/wise_reader/assist_context.py`（新增）：有界 UTF-16 上下文、实际内容缓存身份、wr_context_attempt 表及重启保护。
- `web/reading-interactions.js`：主操作分组、更多、词典联动与新语境卡挂接；未改 reader.js，也没有修改 ai.py。
- `web/assist-popup.js`（新增）：原文范围预览、邻段选择、缓存/历史显示、明确重新解释、取消/未知/离线状态及收藏事件。
- 本交接文档；本地 `outputs/v11-assist-20261011/` 保存生产 API 核查脚本、逐次原始记录及诊断。outputs 是本地证据，不把它当成已提交文件。

## 隔离核查前记录的失败类别

- 原文锚点失效、错误版本或非连续跨段；图片被当文字；UTF-16 代理对被截断；长段截取没围绕选区；换上下文后误复用；用户笔记/画像或整章被隐含发送。
- 6000 UTF-16 上下文预算漏算段落分隔符；选择本身超过上下文预算时把原文静默缩短；上下文范围与实际请求不一致；前后段越过相邻边界或图片。
- 只按词形/模型/凭据缓存；旧协议冒充已记录实际上下文；刷新、换模型或离线误触发生成；重新解释覆盖历史；失败被记作成功。
- 同时请求重复计费；相同 request_id 绑定不同原文；超时、取消、网络断开或重启后自动重发；并发取消一方误伤其他消费者；刚成功的历史记录被迟到取消删除。
- 服务未配置、供应商 429、错误 JSON/空结果、持久化失败被混淆；原始响应/第一失败丢失；请求状态或诊断泄露凭据。
- 词卡关闭/换词后的迟到结果覆盖新词卡；重新解释按钮实际仅重读缓存；缓存与新上下文来源混淆；收藏采用传文本而非 assist id；页面点击收藏隐含请求 AI。
- 主菜单分组使朗读/书签/核对原版消失；更多中的 pending 取消不可用；图片菜单、选区手柄、selection-render 插件标签更新或跨段翻译/完整句语法回归。

仅做必要语法检查及不触及正式库、不开启真实模型的定向生产 API 核查；不新增事后单元测试、不跑完整 E2E。任何合成资料或注入历史只验证相应状态，不当作实际模型质量或设备验收。

## 已实现的上下文与请求契约

- `POST /api/documents/{doc_id}/context/preview` body `{anchor,context_previous?:false,context_next?:false}`。不调用模型；返回 `{anchor,source,context,context_identity,cached,history,attempt,provider}`。它只读取原文/成功历史并整理失去执行者的 pending 收据为 unknown，不生成解释、不改收藏。
- `POST /api/documents/{doc_id}/context` body `{anchor,request_id,regenerate?:false,context_previous?:false,context_next?:false}`。显式 regenerate 必须带新 request_id，使用发起时当前服务/模型。相同 request_id 重放不重新调用；跨内容或更改 regenerate 含义返回 409。
- `source` 为经服务端锚点校验的完整所选原文，保留既有 8000 UTF-16 上限。`context.text` 最多 6000 UTF-16，计入段间 `\n\n`。默认当前段；读者需要时可勾选紧邻前/后一段，不越过图片另找上下文。多段选区保留原来的连续段语义。
- 长段围绕选区截取；需要邻段时，在选区本身能容纳的前提下为每个邻段预留至多 1000 单位，再分配剩余空间。当前段短时邻段可使用更多余量，总计仍不超过 6000。选区本身超过 6000 时仅 context 被截取，source 不缩短，并明确报告邻段省略。
- `context` 含 `{protocol,text,utf16_length,limit_utf16,ranges,omitted,truncated,selection_context_truncated,requested_neighbors,available_neighbors}`。每个 range 带 `{block_id,role,start,end,text,source_utf16_length,truncated}`；role 为 current/previous/next，start/end 为原段 UTF-16 半开区间。展示的实际文本与模型请求中的 context 完全来自同一字段。
- 模型消息只有协议说明和 `{task:'context-meaning',source,context}`，不读取/附带笔记、画像、书名或整章对象。
- 缓存身份绑定协议、doc_id、内容版本、锚点各段范围、实际选区和实际上下文范围/文本；不含模型、地址或凭据。已有成功结果先于配置/网络检查返回。重新解释新增 wr_assist，不覆盖之前的记录。
- 新成功记录 `payload` 继续包含 `meaning/explanation`，增加 `context/context_identity/protocol/provider`。`source` 继续为 `AI · <model>`，完整 assist ID/anchor/version 保持兼容收藏后端。旧协议记录仍保留并在词卡标明未保存实际发送上下文，不伪装成 v4 有效缓存。
- `wr_context_attempt` 在 transport 前提交 pending；成功保存 assist_id 和响应，格式错误/配额为 failed，超时/网络中断/取消/5xx/重启为 unknown。无自动重传、轮询生成或后台补发。取消只停止等待，不承诺服务未计费；迟到取消不会删掉成功语境历史。
- 原有文本 AI 只有供应商 429 额度/频率错误，并无本地金额账本；本次保留该错误与缓存可读性，未宣称实现本地金额限额。未知响应与供应商错误文本保留在收据/既有私有诊断，不被写成成功解释。

## 主控/收藏集成契约

- 保留 r.emit('selection-render')、selectionAction、requestAssist、choose 与手柄接口；collections-highlight 为主菜单第一动作，notes/translation/grammar 随后，其余在“更多”。
- 文字菜单主标签“划线/删除划线、笔记、翻译、语法”；原注册 label 保留为 title，pending 显示取消。图片仍只有 notes/bookmarks/pdf-source；更多中的插件按钮始终留在 DOM，selection-render 后插件可照旧更新它们。更多开合不改变选区；新选区/取消选择重置展开状态。
- `pop.contextRecord` 与 `reader.contextRecord` 为成功的完整 assist 记录或 null；`reader.contextRecordAnchor` 标明所属原文。`reader.emit('context-record', {pop,anchor,record})` 在载入/更新时触发，record 可为 null；收藏应检查 event.detail.pop 对应当前词卡，采用 `record.id` 为 `adopt_assist_id`。关闭词卡清理 property。只打开/收藏词卡不会发模型请求。
- 主控先 `ctx.run('word', {reader,pop,item,anchor,scope})` 再 enhancePop，已兼容；插件先安装事件监听，随后读缓存/生成成功会得到通知。
- 有 `item.dictionary` 时不重复 lookup，使用已有 phonetic。否则非空、至多 6 词/96 字符的实际原文表达会 `/lookup`，`mark_unknown:false`；返回赋 `item.dictionary` 与 `pop.dictionaryRecord`，调用主控 `reader.renderDictionary(pop,item)`。同时触发 `dictionary-record`，detail `{pop,item,anchor,dictionary,record,scope}`，dictionary/record 是相同结构化词典对象。音标只显示单词；发音仍在原词卡按钮，不新建播放器。
- parent 现有 app.register_reading_assist 即会注册新路由/迁移；新 JS 通过 reading-interactions.js 静态 import 自动进入 assets 摘要。构建需带新 assist_context.py 与 assist-popup.js。新表遵循现有单进程本机服务生命周期；未引入跨进程请求调度器。
- 完整永久清理/资料迁移若未来覆盖“AI 请求资料”，应考虑 wr_context_attempt 的 request/response 保留字段；当前收藏导出仍随已采用解释 payload 带出实际上下文，普通取消/收藏删除不清除辅助历史。

## 实际验证与证据

在实现前已记录上面的失败类别。运行 Python 编译、两个 JS 的 `node --check` 和限定文件 `git diff --check`，均通过。未新增事后单元测试；未运行完整 E2E，也未抢占主控浏览器/客户端。

可复现命令（仓库根）：`PYTHONPATH=src .venv/bin/python outputs/v11-assist-20261011/api-walkthrough.py`。脚本使用真实 create_app/FastAPI 路由与 SQLite Store，明确 TemporaryDirectory 和 `_env_file=None`，关闭后台生命周期任务。唯一 transport 目标是自己绑定但不监听的 loopback socket，审计钩子拒绝其他 socket.connect；不能命中任何模型。

第一轮 `api-run-01.json` 38 项、第二轮 `api-run-02.json` 38 项、第三轮 `api-run-03.json` 42 项均通过；包括 HTTP 状态检查，不是这么多个业务验收场景。第三轮新增 ownerless pending 和已存配额失败核查。随后完善“长当前段为明确需要的邻段留空间”，第四轮 `api-run-04.json` 43 项通过，`source-manifest.json` 保留最终文件摘要。所有早期记录保留，不覆盖首次证据。

核查覆盖：精确当前段/前后邻段、UTF-16 与代理对、长段预算、跨段连续原文、7000 选区/6000 上下文区别、未配置零调用、换模型有效缓存、明确 regenerate 绑定当前模型、重复请求/并发不重发、连接失败持久 unknown、旧成功记录不因失败/迟到取消删除、原文实际变化使缓存失效、ownerless pending、已存 quota guard、临时 app 重建的 unknown 与缓存保留。

证据边界：成功历史、配额失败及“崩溃前 pending”是明确注入的状态资料；没有 mock 模型成功响应，没有生成任何假解释当作交付。实际发生的 transport 是 2 次本地连接失败，诊断在 `diagnostics-run-03/` 及后续轮目录；真实模型调用数 0。未证实实际供应商 429/超时、真实模型输出、共享消费者单方取消、浏览器离线 UI、收藏采用 UI、手柄/更多触屏、真实翻译/语法回归或 macOS 显示。

主控最终走查需核对：30 条固定真实词句；缓存重开/换模型零多余请求、明确 regenerate 新 ID 与采用历史；真实错误/取消状态；短语与成员词的词典入口；更多中的朗读/书签/原版；图片、跨段、翻译、完整句语法与手柄；Web/macOS 构建包含新增文件。以上验收不在本分工阶段宣称通过。
