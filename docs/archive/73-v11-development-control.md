# V1.1 并行开发控制

基线 023936a / v1.0.0。主规格 72-v11-reading-loop-spec.md，用户直接授权规划、任务发布、并行实现、完整走查和客户端更新。原型不再作为实施阻塞。

## 文件归属

- 主控：规格/任务发布、app/catalog/engine 集成、reader.js、reader-chrome.js、公共导航/样式、最终走查和客户端安装。
- records 后端：新增 src/wise_reader/collections.py、plugins/collections.py 与其专属模块。不得改其他现有源文件；向主控报告集成点。
- dictionary：lexicon.py、l0.py、l2.py、semantics.py 和新的词典专属模块/资料。不得改 engine.py/app.py/reader.js；提供所需挂接。
- assist：reading_assist.py、ai.py、web/reading-interactions.js；与主控确认共享方法挂接，不改 reader.js。
- collections 界面：新增 web/plugins/collections.js、web/collections.css 及新 collections-* 模块；不得改现有 reader/app/sidebar/interaction 文件，向主控报告最小挂接。

同一文件仅一位写入；共享 checkout 不回滚别人的工作、不安装/重启正式服务、不触碰用户库。未经主控安排不跑完整 E2E、不替代真实模型验收。所有分支修改直接在当前 checkout，最终由主控统一 review/commit。

## 收藏 API v1 契约

以下字段名称在并行阶段固定；需要改变时先告知主控与对侧。

- GET /api/collections?doc_id=&book_id=&kind=&q=&limit=50&offset=0 → {items,total}。item 至少 {id,kind:'word'|'excerpt',doc_id,book_id,title,book_title,anchor,quote,context,source_identity,explanation:{text,source,kind,assist_id?}|null,explanation_history:[],my_meaning,created_at,updated_at,revision}；缺原文仍返回快照。
- POST /api/collections {doc_id,kind,anchor,explanation?} → {item,merged_ids,undo_token}。服务端校验原文、并集；前端使用返回 item.anchor 更新选区。
- PATCH /api/collections/{id} {my_meaning?,adopt_assist_id?,expected_revision?} → {item,undo_token}。个人释义与解释历史独立。
- DELETE /api/collections/{id}?revision= → {undo_token}；POST /api/collections/undo {token} → {ok,items?}；有冲突拒绝覆盖而不是猜恢复。
- GET /api/collections/state/{doc_id} → {items,feedback}。只当前篇章，用于可见划线与反馈。feedback item={id,doc_id,anchor,understood:bool|null,retained:bool,note,detail,target,revision}。
- POST /api/collections/feedback {doc_id,anchor,understood?:bool|null,retained?:bool,note?,detail?,target?} → {state,undo_token}；缺省字段保持。
- GET /api/collections/{id}/source → {available,doc_id,anchor,title,book_title,quote,context,reason?,historical?}。内容不可靠不可 available，数字 ID 不是来源身份。
- GET /api/collections/resurface → {enabled,item,reason?}；POST /api/collections/resurface {action:'next'|'hide'|'show'|'snooze',id?} 同响应。原型中间状态不算推荐记录。
- POST /api/collections/export {book_id?,ids?,collections:true,notes:false,feedback:false,format:'json'|'markdown'} → 文件响应。
- POST /api/collections/import {data:<导出结构>} → {imported,duplicates,unresolved}。正文不随记录导入，不信旧数字 ID。
- POST /api/collections/cleanup {book_id?,ids?,collections:false,notes:false,feedback:false,confirm:true} → {removed:{collections,notes,feedback}}；原书不受影响。

## 阅读器挂接契约

- 插件 id=collections，默认开，关闭保留资料。全局 route='collections'，侧栏入口“词句收藏”。
- 新插件 ctx.hook('read', reader) 装载；reader.selectionAction、reader.on('selection-render'/'draw')、reader.tool、reader.panel、reader.choose/anchorFor/restore 复用现有接口。
- `prepare-document` 在请求正文/画像前收到 `{docId, scope}`，仅并发准备该来源的收藏状态；实际读取时按同一 docId/scope 消费一次。相邻范围已有 seed 优先；旧路由响应不得发布。完整响应头及 body 共用1500ms期限，失败保留可见错误与显式重试。
- `prepare-reading` 在首屏及相邻范围预热的分页之前运行，只准备当前篇章的收藏/反馈与 controller，不安装工具或 DOM 监听。`reader.collectionsSeed` 可从预热传递到落页，避免双重请求和纸面状态闪变。
- 主控增加 ctx.hook('word', {reader,pop,item,anchor,scope})，词卡 DOM 已创建，插件可增收藏/反馈三入口；启用 collections 时旧 data-verdict 全局操作隐藏，停用时保留旧入口兼容。
- 新前端可向 reader.collectionsController 提供 paint()/applyAnnotations() 等有界方法，主控按约定挂接。读书失败不得因收藏加载失败而阻断正文。
- 本书收藏归属 reader.doc.chapter?.book_id ?? reader.doc.pdf?.book_id；独立文章按 doc_id。
- 首页 ctx.hook('home', view)，现有书架先渲染后插入推荐，不重绘书架卡片。
- 首页完成 `draw()` 后调用 `view.mountCollectionsResurface?.()`。`PageCurlRenderer.prepare` 在 detached `leafMarkup` 上调用来源 reader 的 `collectionsController.paint(page)`，确保跨范围翻页也画对书内收藏。
- collection 首次加载不能依赖整书正文；CSS/渲染保留选择层颜色区分，并确保纸张纹理保存划线效果。

## 交付门槛

每位贡献者留本地交付说明：实际改动、验证、失败/限制、集成要求。主控逐项对照 Q1–Q24、实际 provider 30 样例、Web/客户端走查、保护数据摘要与性能基线。只有证据足够才完成 goal。
