# V1.1 real AI quality lane

状态：原 32 次预算已完成，语义问题未整体关闭；新增 v6 六样本复验已获授权，仅完成准备，等待主控明确发出 v6 完成通知。当前真实传输仍为 32，总新上限 38。

## 已完成的真实证据

- 独立库为 `outputs/v11-delivery-20261011/baseline/private/runs/v11-quality/`，通过 baseline/scripts/prepare_run.py 新建，未复用 v11-candidate。
- 全 30 条在请求前验证 doc SHA256、stored text_hash、content version、block SHA256、UTF-16 选区、绝对码点位置及来源元数据一致。
- 使用实际 create_app/FastAPI HTTP routes，经进程内 ASGI transport 进入生产路由，再经真正 HTTPX 网络请求访问现有文本 provider。无 mock 返回；未启动 app lifespan/background jobs。本证据不包含 TCP 入站服务器、浏览器、设备或真实词卡 UI 验收。
- 30 次首次真实请求均 HTTP 200，生产解析接受；这是协议结果，不是“语义全通过”。全部逐条人工式对照原文和 expected_contextual_boundary，未调用评分模型、未计算语义准确率。
- 30 次 v4 缓存重放均返回首次 assist id，零新增 provider transport。
- 1 次 v4 明确 regenerate：technical-08，旧 assist 31、新 34，历史二者均在。此调用在主控“暂不使用 regenerate”通知到达之前已完成，已及时报告。
- 1 次 v5 明确 regenerate：theology-07，旧 assist 20、新 35，同 doc/version/anchor/实际 context；新协议 preview 零传输、旧历史仍可读，随后缓存复用新增零调用。
- 总真实 transport 32；并发峰值 2；自动重试 0；HTTP/transport 失败 0。未知/失败自动重发路径本轮未触发，不宣称已由真实失败验证。
- 当前段落足够的 29 条只发当前段；theology-02 使用紧邻前后各一个列表条目。context 为 49–1449 UTF-16，上限 6000，本批没有截断实例。未发整书、画像、笔记或评审预期。
- 首次 API 端到端耗时中位数 2002.51 ms，nearest-rank p95 3093.51 ms；缓存中位数 9.00 ms。含生产路由与持久化开销，不是 UI 性能。
- 网关报告累计 prompt 5696 / completion 2647 / total 8343 tokens。未提供或核实金额，费用未知，不记零。配置模型 alias 与响应 model 分别记录；不能据响应字段独立证明上游内部路由或账单。
- 已只读核对正式公共配置再复制必要 text 配置。原 32 次结束后清除本独立库复制的 key 并关闭该副本 text 配置；正式配置 SHA256 与开始时相同。新增 v6 准备尚未重新配置副本。

## 主要发现与复验边界

首个明确上报的失败保存在 `first-semantic-failure.json`（theology-06），此前 theology-02 身份推断、theology-04 窄化问题也完整留在逐条评审中，没有因阈值分类而抹去。

- theology-06/07/09：额外神学论证、未提供的前后文或作者归属，不应冒充本段证据。
- technical-01：把实际线程锁选区误解成线程对象支持上下文管理协议；technical-05：动词选区转成名词解释，并丢失实现限定。technical-02 的对象类型关系及 technical-03 的版本限定也需修正。
- v5 仅复验 theology-07：新解释引用了确实收到的短语，明确本段未展开经文依据，原先虚构后文的问题在这一次输出中未出现。旧响应完整保留。尚不能推广成整个语义问题已修好。
- 最高价值复验原为 theology-07 / technical-01：分别覆盖虚构证据与混淆选区出现位置。主控后来识别 payload 缺少 occurrence，已授权 v6 对 theology-06/07/09、technical-01/02/05 六条定向再生成。

## 新增 v6 批次（尚未调用）

`protocol-v6-plan.json` 已准备六条相同选区、相同有界 context、v4 原响应、theology-07 的 v5 响应及各自修正理由；预计算选区前后片段仅用于核查，尚未构造或发送 v6 provider 请求。须等主控完成通知后核对实际 v6 契约，再使用 outputs 中受控模块副本；不改主控源码。

新授权仅 6 次 regenerate，总硬上限 38、并发最多 2、不自动重试，不重跑原 30 条。新 identity 的 preview/历史/缓存读取不得自动传输。每个新增请求继续保留 exact request/full response/时间/usage 与逐条比较。

## 文件与交接

本 lane 未修改生产代码、正式 DB/配置、模型服务，也未操作浏览器、GPU/SSH、提交、推送或 issues。仅修改本交接、私有 outputs runner/评审/证据，以及自己的隔离库和配置副本。主控接管的 assist-popup.js 未触碰。

私有证据目录：`outputs/v11-ai-quality-20261011/`。

- `run-summary.json`：原 32 次不可覆盖的汇总；`usage-and-transport-32.json`：逐请求用量/时间/证据索引。
- `source-verification.json`、`corpus-30.json`、`previews-30.json`：冻结的来源与上下文。
- `first/<sample>/`：30 条 exact API/provider 请求、完整响应、时间与持久化 receipt；`cache/<sample>/`：30 条缓存复查。
- `manual-review-30.md/json`：完整逐条原文、预期、输出及人工式理由；分组 JSON 保留初始判断。
- `regen/technical-08/`：v4 再生成及历史；`protocol-v5/`：单独的 v5 请求、响应、导入源码信息、历史与 comparison.md。
- `credential-cleanup.json`：独立凭据清除与正式配置未变的证据。
- `evidence-audit-first-failure.json`：收尾凭据字节扫描首次停下的记录。短凭据与未执行 grammar prompt 中普通词碰巧相同；只脱敏了两份私有源码快照，记录执行时原 SHA256 和脱敏保留 SHA256。实际模型请求/响应无脱敏替换，完整字节摘要一致。该收尾失败不是模型传输失败。

主控仍负责真实词卡 UI、collection 采纳、最终候选构建与 walkthrough。API 中可读/缓存成功不替代这些集成验收。修订提示后的质量结论仅以对应真实复验样本为边界。

## 核查前失败类别

- corpus/doc/hash/version/UTF-16 原文锚点不一致；sanitized seed 缺失样本；误用候选或正式库；初始化/后台任务外发非选区资料。
- 配置路由与只读配置文件不一致；凭据泄露到输出；复制了不必要的 speech 配置；发送到未授权服务或更改模型。
- 实际消息带整书、画像、笔记或评审预期；上下文超过 6000 UTF-16，实际 request 与 preview 不一致，模型只收到半个选区。
- 超过 30+2、并发超过 2、自动重试失败/unknown、缓存核查产生新 transport、重复 request_id 产生重复计费。
- HTTP 成功但 JSON/schema/原文对应错误；费用/usage 缺失被说成零；完整响应或首失败被覆盖；网关 alias 与响应模型混为同一已验证身份。
- 熟词偏义、表达整体、否定/条件、技术版本限定、宗教作者归属或中文缺失被误解；使用模型自评分或硬算语义准确率。
- regenerate 覆盖旧解释或未创建新历史；证据目录与源文件继续变化导致验收无法复现；API 成功被当作真实词卡/设备验收。


## V5 受控复验前失败类别补充

主控更新系统提示与协议后，旧 v4 证据不可覆盖；协议新身份不得导致 preview/历史读取自动传输；两版本必须是相同 doc/version/anchor/上下文。须防源码混用、旧历史被错误当新协议缓存、预算把已用 v4 regenerate 漏算。当前已用 30 首次 + 1 次 v4 regenerate，只余 1 次；按后续授权仅复验 theology-07，真实传输硬上限 32。使用 outputs 中两个生产模块的只读内容副本作 Python 导入 overlay，不写主控源码。

## V6 复验前新增失败类别

v6 未完成或混用源码；occurrence 片段不在既有 context 内、选到同词的另一处；读取新 identity 自动发送；把此前 32 次漏出预算；新响应覆盖旧历史；通过扩大发送上下文或变更原选区掩盖失败；凭据副本未在本批结束后移除。

## Quality HTTP 服务启动前失败类别

端口已占用误停其他进程、误用 candidate/formal 库、应用 lifespan 启动后台任务、正文读时静默外发、禁用 key 但其他网络路径仍可访问、字典数据可写、浏览器缓存身份/锚点漂移、已保存历史被采纳时使用错误 assist id。服务须绑定 127.0.0.1:18773，使用独立 quality DB、lifespan off、OS sandbox deny network-outbound，并验证 sandbox 连本机出站连接也拒绝；只启动新实例，不重启既有服务。
