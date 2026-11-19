# V1.1 real AI quality lane

状态：本 lane 已完成已授权 41 次真实传输、逐条评审、缓存/历史核查和六条收藏 API seed。独立 quality HTTP 服务继续运行，等待主控真实浏览器点击、采纳与最终候选验收。仍有语义残留，不写“整体验收通过”。

## 交付与真实结果

- 固定 30 条 v4 首次请求 + 2 次明确 regenerate（v4 technical-08、v5 theology-07）+ 6 次明确 v6 repair + 3 次明确 v7 repair = **41 次实际 provider HTTP transport**。上限已用尽，并发峰值 2，自动重试 0；没有重跑原 30 条。
- 30 条全部先核对 doc SHA256、stored text_hash、content version、block SHA256、UTF-16 选区、绝对码点位置及来源元数据。六条 v6 保持同 doc/version/anchor/实际 context；新增 occurrence 提示只来自该 context。
- 41 条均 HTTP 200 且由生产解析接受。30 次 v4 缓存重放、1 次 v5 缓存、6 次 v6 缓存、3 次 v7 缓存及两版服务共 9 次真实 HTTP 缓存读取均无新增模型传输；新协议 preview/历史读取也为零。
- 语境范围为当前段，只有 theology-02 加入紧邻前后各一个列表项；原 30 条 context 为 49–1449 UTF-16，上限 6000，无截断样本。未向模型发送整书、画像、笔记或 expected_contextual_boundary。
- 使用真实 create_app/FastAPI 路由和真实外部 HTTPX provider transport，没有 mock。质量批次经进程内 ASGI 进入生产路由；后续 18773 才是实际 TCP HTTP 服务。没有浏览器/设备验收结论，没有启用 lifespan/background jobs。
- 30 条首次结果与 11 条明确再生成均由本会话直接对照原文评审，没有第二个模型评分、没有语义准确率百分比。
- 网关累计报告 prompt 9873 / completion 3333 / total 13206 tokens；其中 v7 为 1552 / 144 / 1696。费用未知，未核实金额或上游内部路由/账单。配置 alias 与响应 model 分开留存。
- 首次 API 中位 2002.51 ms、nearest-rank p95 3093.51 ms；v6 中位 2079.99 ms；v7 中位 1685.87 ms。缓存中位 9.00 ms。均不代表 UI 性能。
- `manifest-38.json` 的 917 个原证据文件逐个摘要验证未变；v7 与 UI refresh 均有独立目录，原首失败和旧响应未覆盖。

## 六条 v6 逐条判断（保留的阶段性结果）

| 样本 | 判断 | v6 assist | 保留历史 |
|---|---|---:|---|
| theology-06 | 核心更贴近原文；仍加了原段未明确给出的排他性说明，需保守化 | 37 | 37、19 |
| theology-07 | 主要虚构“下文”已去除；末句仍将未展开叙述具体化为发言，v5 这一点更严格 | 36 | 36、35、20 |
| theology-09 | 本次目标问题改善，去掉未给出的神学归属，贴合原段合一语境 | 38 | 38、22 |
| technical-01 | 已定位正确出现；但单词释义仍扩成中心词及所有关系，未完整修好 | 39 | 39、24 |
| technical-02 | 本次目标问题改善，回到对象类型，删除误导性的变量类型绑定说法 | 41 | 41、25 |
| technical-05 | 本次目标问题改善，正确解释所选动词，删除错误值/引用对立 | 40 | 40、29 |

这些是对实际输出的有限判断，不把“选区定位修复”当成全部语义问题闭环。theology-02/04、technical-03 等原批次 caveat 仍保留，未通过追加六条掩盖或替代。随后已按追加授权完成三条 v7 复验（见下），总额度现已到 41；不再发送任何模型请求。

## 最后三条 v7 逐条判断

| 样本 | 有限结论 | v7 assist | 完整历史 |
|---|---|---:|---|
| technical-01 | **仍未解决**：meaning 仍是邻近整个词组，未只定义所选单词；说明已定位正确但不能弥补定义越界 | 42 | 42、39、24 |
| theology-06 | 此前未提供的对照/展开本次未再出现；meaning 的中英混写和措辞仍需润色 | 43 | 43、37、19 |
| theology-07 | 本次未再出现虚构前后文/发言/文献展开；核心义项可接受，中文措辞可润色 | 44 | 44、36、35、20 |

三条与 v6 完全相同 anchor/context/selected_occurrences；只有协议和系统约束变化。三条说明均为一个句号且不超过 100 CJK；格式变短不是语义通过证明。`protocol-v7/comparison-3.md` 保留实际 v6/v7 输出、原文与理由，`protocol-v7/first-semantic-failure.json` 保留 technical-01 残留失败。没有为求通过继续调用。

## 主控浏览器入口

- 服务：`http://127.0.0.1:18773/`，PID **80808**，由本 lane 新启动且继续运行；未停止/重启其他服务。
- 数据：`outputs/v11-delivery-20261011/baseline/private/runs/v11-quality/user.db`。不复用 candidate 或正式库。
- 源码：`outputs/v11-ai-quality-20261011/protocol-v7-ui-refresh/runtime-source/`，v7 后端与独立更新的 `web/collections-dialogs.js`；父任务之后继续修改的源码不会自动进入此服务。
- 限制：text disabled、复制 key 已清除、lifespan off、OS sandbox `deny network-outbound`；实测到本机 TCP 也返回 EPERM。sandbox 同时拒绝写正式 data 目录。正式配置 SHA256 与开始一致。
- v7 三条经真实 HTTP 确认当前缓存；其他三条的 v6 历史仍可读，新协议没有自动请求。wr_context_attempt 共 41。
- 主控后补 `collections-dialogs.js` 的按 id 降序、时间戳与折叠实际原文已复制到独立 UI 冻结目录。实际 HTTP 字节 SHA256 为 `0913c73b0118827e9e12a34fcc5dba7cde4a0f43f1f5a6c08e703015cc4b85d9`，新资源前缀 `/assets/0c1d286a053649b7`。请整页刷新；渲染/交互仍由主控浏览器确认。
- 只替换了本 lane 已核验的 quality PID 75490 → 80187 → 80808，未操作其他服务。六条收藏及主控可能已采纳的状态在两次刷新前后逐项相同，没有重建 seed 或代采纳。

主控明确授权后，另经真实 `POST /api/collections` 保存以下六条，**只用于 UI 入口准备，不代表浏览器通过**。请求仅有 kind=word/doc_id/anchor；没有 explanation、adopt_assist_id、个人释义或理解反馈。响应已确认 explanation=null、历史为空，未采纳任何结果，未新增 AI 调用。

| 收藏 id | 书名 | 引用 | 样本 | doc |
|---:|---|---|---|---:|
| 1 | The Mission of God | righteousness | theology-06 | 30 |
| 2 | The Mission of God | justification | theology-07 | 40 |
| 3 | The Mission of God | in Christ | theology-09 | 40 |
| 4 | Python Pocket Reference | thread | technical-01 | 10 |
| 5 | Python Pocket Reference | type | technical-02 | 10 |
| 6 | Python Pocket Reference | reference | technical-05 | 10 |

进入 `http://127.0.0.1:18773/#/collections` → 详情 → 已有语境解释 → 预览并采用。实际点击/预览/采用以及零出站核查由主控完成。本 lane 没有代为采用。

完整 block id、UTF-16 范围、version 与历史 id 位于私有 `quality-browser-locations.json`、`quality-browser-handoff.md`、`ui-seed/summary.json`；最新记录 id 和 v7 状态见 `protocol-v7/quality-http-ready.json`，当前 UI 服务见 `protocol-v7-ui-refresh/quality-http-ready.json`。准备后这些文件是不可变快照；主控浏览器后续主动采用会改变独立 DB，但不会改写这些准备证据。

## 证据与改动范围

全部私有证据：`outputs/v11-ai-quality-20261011/`。

- `run-summary-41.json` 为最终调用/用量/边界汇总；`run-summary-38.json` 和 `run-summary.json` 分别保留 38 / 32 次时的汇总。
- `corpus-30.json`、`source-verification.json`、`previews-30.json` 保存冻结来源；`first/<sample>/` 保存 exact API/provider 请求、完整响应、时刻、耗时、usage 和持久化 receipt。
- `manual-review-30.md/json` 是 30 条完整人工式理由；原组内记录、`first-semantic-failure.json` 均保留。
- `regen/technical-08/`、`protocol-v5/` 和 `protocol-v6/` 各自保留再生成、历史与缓存证据。v6 对照详见 `protocol-v6/comparison-6.md` / `manual-comparison-6.json`；v7 见 `protocol-v7/comparison-3.md` / `manual-comparison-3.json`。
- `quality-no-outbound.sb`、`outbound-deny-check.json`、`quality-server-preflight.py`、`launch-quality-http.sh` 保存初始安全启动/核查过程；当前 launcher 为 `launch-quality-http-v7-ui.sh`，preflight 为 `quality-server-preflight-v7-ui.py`。
- `ui-seed/` 单独保存 6 条真实 API 请求、响应及保存前后列表；没有把其冒充浏览器动作。
- 原收尾凭据字节扫描曾因普通源码词与短凭据同字节而停止；`evidence-audit-first-failure.json` 记录这一离线审计失败、原源码摘要和两份旧快照的脱敏摘要。模型请求/响应保持完整字节，均已核对 SHA256；该事件不是模型传输失败。

本 lane 改动仅此交接、私有 outputs 脚本/评审/证据，以及独立 quality DB/配置。没有修改生产源码或正式 DB/设置，没有操作浏览器、GPU/SSH、提交、推送或 issues。主控接管的 assist-popup.js 未编辑。原样复制生产运行源码不等于本 lane 修改生产实现。

主控仍负责真实词卡/收藏采纳 UI、最终 Web/macOS 候选构建与 walkthrough；阅读历史可见和 HTTP 成功均不替代这些验收。

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

## 六条收藏 UI 准备前失败类别

主控明确要求通过真实 collections API 保存六条复验词语，作为后续浏览器入口：防止保存到错误实例、anchor 漂移、把 API seed 当浏览器通过、保存时意外带 explanation/assist_id 造成采纳、同词混合或写入个人释义/掌握反馈、产生模型调用。只 POST 六条 kind=word/doc_id/anchor；不 PATCH 采纳，不附 explanation，记录真实响应并核对未采纳状态与请求总数 38。

## V7 三条最终复验前失败类别

新增授权为 technical-01/theology-06/theology-07 各一次，原 38 次不得覆盖，总上限 41。风险包括预算仍按旧起点计算、同样本重试、邻近词被吸收进 selected 定义、短解释仍加入未给出的对照/归属/所有权/发言、源码未冻结一致、切换 quality HTTP 时误停其他 PID、重启误用正式库、六条 seed 被重建/覆盖或意外采纳。使用相同 quality DB 和原 anchors/context，不修改源码；只在核验 18773 仍属本 lane 后更新该独立实例，保留全部旧历史与现有收藏内容。
