# PDF 一期：项目配置与 tracker 交付台账

日期：2026-10-08。

## 已完成

- 用户选择 Coraia/EasySink GitHub Issues，并明确答复“推荐新建 AGENTS.md 并采用该草案”。
- 已按批准正文写入 [AGENTS.md](../AGENTS.md)、[issue tracker 配置](agents/issue-tracker.md) 与 [领域文档约定](agents/domain.md)，初始保留原有指令；用户 2026-10-08 要求少写测试、最终点击走查后，已按新授权更新 Testing 部分。
- 未安装 triage，按 setup 规则不建立五角色标签映射；to-spec/to-tickets 使用的 ready-for-agent 标签已创建。
- 现有 GLOSSARY.md 与六份 PDF ADR 保留，单领域约定不改变为多领域布局。
- PDF 规格已发布为 [Coraia/EasySink #1：PDF 一期：本机转换、沉浸式阅读与来源核对](https://github.com/Coraia/EasySink/issues/1)，标签 ready-for-agent，状态 OPEN。
- 已读取远端完整正文、标签和评论；正文与 [本地规格](54-pdf-spec.md) 去除末尾换行后逐字一致，读取时无评论。标准化正文 SHA256：`615705aec7d4e8d277b7a495f29e5049f7bab1b0428b7cf71f19267cf040af26`。

原始发布正文和远端读取凭据保留在本机 outputs 的本轮发布证据中；这些凭据不代表新增 PDF 功能已经执行或通过测试。发布后进入 to-tickets，未改写或关闭父 issue 正文。

## 已获批准，已发布，开发中

[21 项纵向任务草案](58-pdf-ticket-plan.md) 已形成，逐票正文及依赖在 [草案清单](tickets/pdf-v1-drafts/manifest.json) 中记录，共 124 条验收标准。T01–T20 显式覆盖全部 70 条用户故事，T21 是最终整体验收；这些是草案编号，不是 GitHub issue 编号。

用户已批准粒度、依赖及发布，并授权以同模型新建并行开发会话。只有 T01 当前没有阻塞；后续任务中的实验、原型验收、正式实现及最终发布门槛不能被 ready-for-agent 标签绕过。

## 下一步发布 Contract

已开始按依赖顺序创建一个子 issue 对应一票，应用 ready-for-agent 并关联父规格 #1；原生子任务/阻塞关系可用时采用原生关系，否则使用明确 Parent/Blocked by 引用，并读取核对。保持父 issue 正文与状态，记录草案编号到真实 issue 的映射。

四个开发会话已开始执行，当前状态、文件所有权及模型核实见 [主控记录](59-pdf-development-control.md)。实际功能通过必须以各自走查证据为准；主控尚未 commit/push 本地配置与文档。日后可直接编辑项目配置；只在更换 tracker 或重新配置时重跑 setup。

## 发布回读结果

21 票已发布为 #2–#22，原生子任务及 27 条原生阻塞边全部回读核对；父规格 #1 正文与 OPEN 状态未改。各票正文包含用户最新点击走查要求，保留 124 条验收标准。对照见 [主控记录](59-pdf-development-control.md)，机器映射见 [manifest](tickets/pdf-v1-drafts/manifest.json)。回读凭据在本机 outputs/pdf-ticket-publish-20261008。

## 首批并行交付

四个指定模型会话已交付初期贡献。隔离实验入口已运行，数字/扫描小样本、实际原版来源高亮、跨50页读取与续读已经直接点击走查，两处真实UI失败修复后复验。上传控件与真实材料/长书/性能仍有明确待验收项；这不是21票一期完成，未关闭issues。最终证据与下一阶段门槛见主控记录。
