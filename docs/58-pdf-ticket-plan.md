# PDF 一期：纵向任务清单

2026-10-08。父规格：[Coraia/EasySink #1](https://github.com/Coraia/EasySink/issues/1)。状态：用户已批准粒度、依赖和发布，开始并行开发；实际 issue 与开发会话对照见主控记录。

下列 T01–T21 是草案身份，每票都有独立正文与验收标准。一个交付覆盖相应数据、业务 Interface、UI 与端到端走查，先建立真实转换依据、验收原型，再进正式入口；不按数据库/后端/前端/测试拆成无法独立验收的水平任务。

## 任务与真实阻塞依赖

| 草案 | 标题与完整正文 | Blocked by | What it delivers |
|---|---|---|---|
| T01 | [旧书兼容与隔离的 PDF 实验入口](tickets/pdf-v1-drafts/issues/01-reading-seam-and-lab.md) | 无 | 固定旧书阅读闭环，提供隔离浏览器实验入口及必要的增量表示扩展 |
| T02 | [数字 PDF 的原版与阅读版实验闭环](tickets/pdf-v1-drafts/issues/02-digital-pdf-lab.md) | T01 | 实际数字 PDF 导入、原版、真实提取文字与时序证据 |
| T03 | [扫描 PDF 的本机 OCR 实验闭环](tickets/pdf-v1-drafts/issues/03-scanned-pdf-lab.md) | T02 | 实际扫描识别、低清/混合语言边界与原页核对 |
| T04 | [公式、表格、图片与原图回退实验](tickets/pdf-v1-drafts/issues/04-structured-content-lab.md) | T02 | 真实复杂结构呈现、忠实局部回退及独立质量清单 |
| T05 | [多栏、脚注与原页定位实验](tickets/pdf-v1-drafts/issues/05-order-and-provenance-lab.md) | T03、T04 | 数字/扫描的顺序与来源验证，拒绝严重失效范围 |
| T06 | [冻结转换方案并验收完整交互原型](tickets/pdf-v1-drafts/issues/06-validated-conversion-and-prototype.md) | T05 | 一套经实测达标的主流水线、门槛清单与用户认可的完整原型 |
| T07 | [正式 PDF 导入、去重与原版查看](tickets/pdf-v1-drafts/issues/07-production-import-and-original.md) | T06 | 正式书架持久保存一个归属，不点开始阅读也保留，原版可看 |
| T08 | [正式渐进阅读版与结构内容](tickets/pdf-v1-drafts/issues/08-progressive-reading-edition.md) | T07 | 先读合格范围，结构/回退/拒绝分清，原版不自动跳视图 |
| T09 | [阅读版与原版的区域定位和原位返回](tickets/pdf-v1-drafts/issues/09-original-reading-location.md) | T08 | 正确原页高亮、缩放/旋转和原文锚点往返 |
| T10 | [PDF 沿用查词、译文、语法和发音](tickets/pdf-v1-drafts/issues/10-immersive-understanding-aids.md) | T08 | 现有理解辅助用于 PDF，保留译文/语法位置与发音入口 |
| T11 | [文字与原图笔记、书签和续读](tickets/pdf-v1-drafts/issues/11-pdf-reading-records.md) | T09 | 实际记录生命周期、正文/底部入口、重排与重开定位 |
| T12 | [局部重新识别后的安全静默更新](tickets/pdf-v1-drafts/issues/12-safe-silent-updates.md) | T10、T11 | 新结果安全自动生效，交互稳定、记录迁移和歧义保留 |
| T13 | [独立任务的暂停、取消、重启与恢复](tickets/pdf-v1-drafts/issues/13-durable-task-controls.md) | T08 | 切书/关浏览器不中断，暂停/取消/重启保留进度与设置 |
| T14 | [PDF 书籍回收、迟到结果隔离与恢复](tickets/pdf-v1-drafts/issues/14-book-recycle-restore.md) | T11、T13 | 回收停止后续工作且不复活，恢复已有资料、任务暂停 |
| T15 | [局部外部增强与有效结果复用](tickets/pdf-v1-drafts/issues/15-scoped-external-enhancement.md) | T12、T13 | 明确范围/配置调用外部，复用有效结果并保存响应/费用依据 |
| T16 | [付费并发限额与未知结果恢复](tickets/pdf-v1-drafts/issues/16-paid-limit-and-unknown-results.md) | T15 | 并发预留、未知不盲重发、限额与旧阅读 AI 分开 |
| T17 | [保留付费资料的本地重放与明确重新生成](tickets/pdf-v1-drafts/issues/17-local-replay.md) | T16 | 额度耗尽可本地重建；资料缺失与可能新计费的重新生成分清 |
| T18 | [资料、磁盘压力与 PDF 处理开关](tickets/pdf-v1-drafts/issues/18-storage-and-feature-disable.md) | T14、T17 | 空间不足保护保留资料，清理可核对，关闭处理不删除数据 |
| T19 | [后台转换下的阅读优先与性能守卫](tickets/pdf-v1-drafts/issues/19-reading-first-performance.md) | T13 | 在真实负载中守住旧书与已转换 PDF 打开/交互/资源指标 |
| T20 | [PDF 高清纸面、光影与真实翻页](tickets/pdf-v1-drafts/issues/20-pdf-retina-page-turns.md) | T08 | 图片/公式/表格翻页不缺失，保留 DPI、装订和真实手势体验 |
| T21 | [整体 review、完整走查 与一期发布验收](tickets/pdf-v1-drafts/issues/21-release-review-and-e2e.md) | T18、T19、T20 | 真实材料、旧功能、性能与设备证据齐备后给出发布/阻断结论 |

## 为什么这样分

- T01 只做后续确实需要的兼容预重构，保持既有行为；没有必要就不做广泛重命名。T02–T05 是可以从浏览器实际体验和核对的转换闭环，不是安装环境就结束的研究任务。
- T03 的扫描文字与 T04 的复杂数字结构可并行；T05 需要两者，才能检查扫描结构、脚注与完整来源关系。T06 同时承担方案达标和人工原型验收，未完成不能开始正式实现。
- T09/T10/T13/T20 在 T08 后可分别推进；T11 依赖真实来源往返，T12 依赖实际辅助与记录，避免只验证一个空壳更新。
- 回收需要已有记录与任务控制；付费处理需要安全版本更新与独立任务。先形成可信的请求/响应记录，再做并发限额与未知恢复，再验证限额耗尽下的本地重放。
- 资料管理最后纳入回收及付费重放资料，避免只清一类缓存就声称全部安全。后台资源与高清翻页不需要等待付费功能，因此单独保留并行。
- T21 只列末端 T18/T19/T20；其余通过传递依赖已经完成，不添加重复阻塞边。完整走查 在这一结束阶段才运行，前面仅运行各票目标场景。

## 检查与发布规则

[机器可核对清单](tickets/pdf-v1-drafts/manifest.json) 保留阶段、阻塞、用户故事和验收场景映射。共 21 票、124 条验收标准；T01–T20 的映射覆盖全部 70 条用户故事。发布前检查有向无环、阻塞编号较早、没有冗余直接边，每票独立可验收。

用户已授权发布与实现，当前可交付的前沿为 T01。按依赖顺序发布为 #1 的子任务，应用 ready-for-agent；优先原生子任务和阻塞关系，不支持时采用明确文字引用，记录草案到真实 issue 的映射。父规格正文/状态保持。

粒度与依赖已获用户确认。手动纠错不在本次任务清单中。
