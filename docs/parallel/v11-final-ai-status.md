# 最新状态：v22 GO，3 个 owned 后端文件已应用，主控可打包

{
  "src/wise_reader/reading_assist.py": "42c50784a142a92b7acbcae5842332b6751878d8c1c1087be6fdbf77c0511ce6",
  "src/wise_reader/assist_context.py": "313f14081fa98672b84202f0f7fc387d1327ba6b66a106520d63e4014997f43c",
  "src/wise_reader/assist_context_generation.py": "277195b89bb6b07ec43b1e7f35edd2c99e2cf422aa123e57ae6ee5c6129daeba"
}

冻结 `88d2228955d787f8cee17ab3f51d522897221ec3b7047051fad04ff27d23c65c` 已获 Aristotle final static PASS（主控转达）。38公开字段逐字节一致、缓存/历史/采纳/回顾输入清洁、3重复键API故障回放通过，0新传输。含主控 collections.py 集成依赖哈希 `749a6b9f64b25224b63ae5f4d25a400f9158d932812c421b769d457e0965e732`。详情 `outputs/v11-final-repair-20261011/ai/v22/provenance-containment/INTEGRATED.json`。未重启正式服务或客户端。后续仅补紧凑交接，不再改源码/调用模型。

## v22 containment审查入口已准备；下游1处需主控接线

候选 `v22/provenance-containment/candidate-source/src/wise_reader/` 已移除新结果/缓存/history的target_usage.usage，原始stage journal完全保留。`assist_context.public_payload(payload)` 是统一只读复制适配。发现 `src/wise_reader/collections.py:179` adopt()返回完整旧payload，需主控把该payload经public_payload再返回（shared文件不归本lane，未改）。否则收藏旧缓存仍会携带usage。正在已保存38的零传输API回放。请Aristotle独立确认输出来源隔离及38公开字段质量；可直接读candidate与后续 replay证据。

## v22 38/38可见输出初审通过；内部诊断须独立裁决

批次结束：76新调用/累计456，全部返回，无重试。原30+8可见meaning/explanation已读，未发现实质错误。但technical-03最终target_usage.usage新增“即在类中定义的方法，而非实例方法”，原文没有实例方法排除；technical-06 usage“指程序在遇到缺失键时抛出异常”未体现rather than，说明句正确。已记录 `v22/diagnostic-audit-findings.json`，请Aristotle独立审查，不先合入。正在无凭据缓存/重放验证；正式v9未动。

## v22 已冻结，唯一真实38开始

离线14/14通过（嵌套JSON递归脱敏、无歧义字段归位与冲突拒绝、取消/超时/解析失败）。freeze SHA256 6e2c5c031a63ea3e92e6bfeea359aad32f09efc15565b0c54da1ded34dde9753。从380累计开始最多76次，禁止补抽/重试；原始两阶段证据在v22/final。正式源码v9，不集成至完整独立审查通过。v21完整结论 `v21/final-outcome.json`，修后纯日志身份与无语义差异证明 `v21/journal-repair/identity.json`，嵌套API回放证据 `v22/p2-v21-journal-repair/`。

## v22 实施/离线验证中

v21已完整结束380累计调用：人工与主控独立审查均36/38，失败everyday-04、theology-03；不得集成。v22只增加通用字段归位、被动角色及三槽一致性核对、嵌套JSON逐叶脱敏。旧原始证据保留；压缩25个已关闭v21测试库并逐个SHA回验，释放2064429315字节，清单 `outputs/v11-final-repair-20261011/ai/v21/closed-fixture-compression.json`。新隔离库用APFS clone。新外部调用0，正式源码v9。

## v21 gate 已发现失败，完成唯一批次审读中

确定失败：everyday-04第二阶段JSON层级错导致API 502；theology-03将was Israel expected to deduce误译为以色列期望…推断。旧判据不变，不补抽、不修冻后输入。两P2离线通过，正式源码仍v9。最终完整计数在本批38结束后给出。

## v21 已冻结，开始固定38真实验证

两P2与六项失败边界离线10/10通过。源码/输入冻结 `outputs/v11-final-repair-20261011/ai/v21/freeze.json` SHA256 0ff2f6c71172cb57da2cbae722a1cac6102bb05d1409d8b1b6cfce0d351a15d0。本批最多76调用，累计上限380；每阶段原响应独立持久留存。正式源码仍v9，等待38最终语义审读。

## v21 正在执行

候选目录 `outputs/v11-final-repair-20261011/ai/v21` 已建立。两P2修复已在 candidate-source 落地，正在离线API重放；尚未新增外部调用（累计304）。原38与判据不变，最终冻结前必须通过P2。正式3文件仍v9。主控可只读review候选 `reading_assist.py`；不动UI/客户端/服务。

# V1.1 AI lane收尾：v16 NO-GO，正式源码已恢复v9

原固定30：28/30；固定扩展8：7/8，总35/38。v16固定38仅跑一次；先前v15仍29/30+7/8，旧失败不改判。扩展8是复用的固定集，不再宣称未见样本。

确定失败：everyday-07的common sense仍为“是常识”；theology-10的中文仍残留likewise；holdout-08的引语比较仍是普通英文/中文混合。technical-03另有术语措辞与[a]遗漏，已记录，未声称全文完全忠实。

已按授权保留全部失败候选与原始请求/响应，逐字节恢复lane起点v9。v16本批已退出后才还原；不会打断进行中的真实请求。源码身份：

- src/wise_reader/reading_assist.py：5c7d2078c02e6199250d2d69cba212453f08ef4bcc5e8767398c0be0b383541a
- src/wise_reader/assist_context.py：a3ba2483c83829e066b6656844cd4ceeb8e09db3236a01e2fb7fbc07a9d630b8
- src/wise_reader/assist_context_generation.py：不存在。

v16新增38次，当前lane累计114/114实际外部请求，全返回；未知/未发待补/重复已发/自动重试均0，并发≤2。v16供应商计30,890 tokens，累计82,678，费用金额未核实。无凭据缓存38、原请求ID重放38、预览历史38，新增传输0；旧数据不变。没有UI/客户端操作、服务启动或重启、配置修改、GPU、commit/push；所有worker资源关闭。

明确整合决定：不要集成v14/v15/v16，不把恢复v9当作AI质量通过。主控的翻页/原生性能改动未触碰。停止追加调用或第三次同样审计。

必要证据全部位于outputs/v11-final-repair-20261011/ai：README.md、delivery-summary.json、final-audit-v16.json、v16/confirmed-failures.json、v16/manual-review-38.md、v16/restoration.json。原v15阶段报告留在v15/README.md与v15/delivery-summary.json。

## 追加授权v17已冻结，尚未通过

v14-v16原报告和失败不变。主控在既有修复授权内追加的协调批次：固定38一次，累计上限152，无pilot/重抽/自动重试。v17正式源码保持v9，候选仅在ai/v17/candidate-source及runtime-source中。先translations后独立lexical_gloss；meaning不再由中文片段摘取，语义一致和不吞邻词的用户标准不变。

38条原文、前/选/后与锚点均离线核对一致，完整74后端文件及实际输入冻结。freeze.json SHA256 74b19809262e8283ead89b73f0ca53cb011ac555756f6b00998fc0e1f6d8b461。

- 候选 reading_assist.py: f733c092aaf17c9c934d3b3e3ef0816edf64d3dec415303cbbc3a52ddc6a7bf1
- 候选 assist_context.py: 3e553f053f4a26bc2ee9a1d123b5e2f8431e55daab70809b480de38d10a6a59d
- 候选 assist_context_generation.py: 1f436b34b198f0d461cab075fb7ca5235b1735a00c8ec9afee66d99b66514a97

开始前累计114，本批目标累计152；通过前不集成，无UI/客户端操作。

v17批次38请求均已返回，当前无真实请求在跑，未补抽或重启；正在逐条语义审读和无凭据缓存重放，正式源码仍为v9。

## v18主控协调批次已冻结

v17保持失败，不追认通过。主控在既有修复授权内追加固定38一次，累计协调上限190。候选仍隔离，正式源码v9未改。v18取消中文标记/selected_fragments输出，保留精确英文锚点及前/选/后；plain_chinese完整来源译文先生成，lexical_gloss后生成。新增的是通用重复术语逐处保留要求，不特判样本。

完整74后端文件和38实际输入已冻结；freeze.json SHA256 f01007aee864cf8ef3f3539af1cd36a797bb0bc3115bd9723eb7af2a25fe961d。开始前累计152，本批唯一38，无pilot/重抽/自动重试。

## v19 已冻结

主控在既有修复授权内追加唯一固定38条协调批次，当前累计190、上限228。AI词典候选已移除，基础词卡不变。target_usage先局部辨义，再lexical_gloss，再完整plain_chinese；诊断不展示。全部38短片段经原锚点位置核验、每侧最多6词、授权来源不变。正式源码仍v9。

freeze.json SHA256 f9e853ff10e3d324d9b2bd0947aae018215f68d469ddb2c333ef4b32ad5903ce。候选和全部实际输入位于outputs/v11-final-repair-20261011/ai/v19；下一步唯一38一次、并发≤2，不重抽。

## v20 双阶段已冻结，等待真实语义验收

主控在既有修复授权内追加38次语境请求，每次最多两次同provider/model，真实调用累计上限304。第一阶段草稿，第二阶段独立依据原文核对并返回最终同结构JSON。两阶段请求/原响应保留在durable stages封套；旧读取不依赖response格式。正式源码保持v9。

freeze.json SHA256：30ad4ab12595a336b05dcd7afd83c1d1e438ebdf2954802b08a5dfb027f5bf4c。38原锚点和第一阶段输入、第二阶段确定性模板已冻结。离线API边界6/6（成功、两阶段各自timeout/parse失败、第一阶段后取消），0真实调用；不冒充真实供应商或语义通过。接下来只发唯一固定38，每阶段总并发≤2。
