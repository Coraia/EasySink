# V1.1 AI repair lane — 已收尾：v13 28/30，恢复v9

**最终确定28/30，不是29/30；v13不集成，本轮停止。**

两个失败：
- **everyday-02**：lease词义“租约”正确，但原固定判据明确要求保留OCR字符`<`；实际释读替换为句号，未保留。
- **theology-10**：原锚点只选`piece of clothing`，不含`beautiful`；meaning“美丽的衣物”吸入未选修饰词。句译正确不能抵消扩词义。

## 正式后端已稳定供打包

已逐字节恢复lane开始v9，只撤销本lane差异：
- `src/wise_reader/reading_assist.py`：`5c7d2078c02e6199250d2d69cba212453f08ef4bcc5e8767398c0be0b383541a`
- `src/wise_reader/assist_context.py`：`a3ba2483c83829e066b6656844cd4ceeb8e09db3236a01e2fb7fbc07a9d630b8`
- `src/wise_reader/assist_context_generation.py`：不存在。

主控已核对并打包安装build5（性能+离线历史修复）。本lane没有改UI/客户端、配置或其他共享脏文件，没有commit/push或启动服务。v9不是AI质量已通过；失败v10/v11/v12/v13只留outputs。

## 调用与证据边界

v10 5/6；v11 29/30；v12 26/30；v13 28/30。累计96次真实传输（6+30+30+30），v13原30每条一次，未知0、重复付费发送0、自动重试0，并发≤2。v12首次已发4条全部返回，后补26条此前从未发送；first-operational-failure指确定的结构失败，不是结果未知。没有追认v12通过。

v13 30 API200、结构失败0，但两项原判据失败。新原句/背景分区没有扩大源范围，scope已为“作用域”，justification为“依据”；三项同形中文对应坐标只标记歧义，没有强取第一处。

无凭据重开后30新ID缓存读取、30原付费ID重放、30历史读取：新增传输0、额外attempt0、旧记录不变。所有本lane资源已关闭。语义判断是assistant逐条审读；没有用第二模型评分，不等于UI/独立真人验收。

## 必要复验入口

- [v13最终报告](../../outputs/v11-repair-20261011/ai/v13/README.md)
- [两个失败及完整原锚点](../../outputs/v11-repair-20261011/ai/v13/confirmed-failures.json)
- [原30逐条人工语义审读](../../outputs/v11-repair-20261011/ai/v13/manual-review-30.md)
- [源码恢复哈希](../../outputs/v11-repair-20261011/ai/v13/restoration.json)
- [调用/用量/状态摘要](../../outputs/v11-repair-20261011/ai/v13/delivery-summary.json)
- [最终离线审计](../../outputs/v11-repair-20261011/ai/v13/offline-audit.json)
- [v12保留的失败结论](../../outputs/v11-repair-20261011/ai/v12/README.md)

不再扩大检查、追加调用或运行任务。
