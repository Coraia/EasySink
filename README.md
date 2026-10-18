# Wise Reader

面向中文读者的本地英文阅读应用，提供 Web 阅读器和 macOS 客户端。中文解释贴近正文，阅读偏好与笔记自动保存；19 个扩展可以逐个开关。

当前产品基线：**V1 · `v1.0.0`（2026-10-10）**。使用 FastAPI / SQLite / 本地词典，前端为可拆卸 ES modules，macOS 客户端复用阅读核心。该标签冻结本次已体验的源码；包内历史版本号暂保持不变，以对应已安装并走查的客户端。

版本范围、证据摘要及已知限制见 [V1 版本记录](docs/releases/v1.0.0.json)。本次为当前 Mac 上的个人使用基线；签名公证、干净机器分发和完整设备覆盖尚未验收。已同意后续处理高负载下个别慢帧、学术译文的术语与限定范围问题，保留原始失败记录。

## 启动

```bash
uv sync --extra dev
# 缺少词库时运行：python3 scripts/fetch_lexicon.py
python3 scripts/web.py start
python3 scripts/web.py status
```

打开 [本机阅读空间](http://127.0.0.1:8766/)。点击「体验一篇示例」可直接开始，不强制登录或测词汇量。

```bash
python3 scripts/web.py restart
python3 scripts/web.py stop
```

日志：`.runtime/web.log`。关闭终端后服务继续运行；电脑重启后需要重新启动。

## 能力与边界

EPUB/PDF/TXT/Markdown 导入、章节目录、沉浸阅读、笔记、书签、续读、译文、导出、朗读、主题、排版、搜索、统计、快捷键、本机访问锁。

PDF 从同一个「添加阅读」入口导入，原件登记后即保存在书架，不依赖点击开始阅读。阅读版沿用现有 Reader，按已完成的原页范围逐步开放，提供查词、选区译文、语法、发音和阅读记录。选区菜单及「更多 → PDF 处理」可核对原版；图表、公式或无法可靠重排的区域保留原图，也可记笔记和加书签。处理面板可暂停、继续、取消或重新识别指定原页；回收站可恢复同一书籍。关闭 PDF 处理保留已有原件、阅读版与记录。

PDF 转换运行在独立环境，轻量依赖见 `requirements-pdf-lab.txt`；可按实际就绪状态选择本机提取/OCR、原式优先或自有 Omarchy 服务。`.venv-pdf-lab/bin/python scripts/pdf_lab_convert.py --capabilities` 可核对 Web 开发环境能力，客户端运行时准备见 [桌面说明](desktop/README.md)。普通导入不调用付费服务；外部图像增强由用户明确选择页或区域后发起，保留有效缓存、重放资料、额度与结果未知状态。公式先保留原式，主动识别时才运行对应模型。转换完成不代表复杂版面、公式或任意扫描件已校对。

AI 是可选的：基础词注来自本地词典；点词后主动请求上下文，或选句后翻译、分析语法。仅翻译所选文字，右侧与原文联动；语法在原段落下方展开，已有结果用 +/− 重用。无自动整章/整书模型调用。进入「AI 与语音」配置已有 Chat Completions 兼容服务，凭据只保存在本机服务端，不回填页面。

分页使用原文字符锚点，与页码分离。改变字号、密度、窗口和译文栏宽后重新分页；笔记、书签和续读仍对应原文。EPUB 保留主要文本结构与章节，不提供原书高保真分页、图片原件、脚注或 DRM 解锁。

发音优先使用这台 Mac 已安装的英文音色，浏览器本机语音是离线备选；远程自然语音必须明确选用。单词浮层有词典音标；段落/选区就地播放与停止，不弹出播放器。尚未安装或验证额外的神经 TTS 模型，因此不承诺当前系统音色已经达到有声书音质。

「阅读痕迹」汇总整本书各章节的笔记、书签、译文与查阅记录。AI 回顾只整理用户勾选的痕迹，保留可编辑草稿，确认后保存；原始记录不被改写。旧版手工整章译文保留在数据库，旧整章/整书生成入口已停用。账号仍是本机访问锁，没有云端账户或多用户隔离。

首页「体验长难句」打开你提供的神学原句及两段补充示例；只有你点击时才加入书架。该示例没有预设 AI 答案，生成使用你配置的模型。

## 验证

```bash
npm ci
npx playwright install chromium
.venv/bin/python scripts/e2e_acceptance.py
```

本轮按用户要求以直接浏览器走查与实际性能记录为主，不新增事后单元测试，也不在开发中运行完整 E2E 套件。既有完整 E2E 入口仅在开发结束时按需运行，生成 `.runtime/acceptance/<时间>/` 下的 HTML、trace、截图、源码快照及校验清单。PDF 整合的原始操作、首次失败、复验截图和测量位于 `outputs/pdf-reading-walkthrough-20261008-1512/`；AI 应用流程使用 18768 本地模拟供应商，不证明真实模型质量或计费。

浏览器测试使用 18767 上的独立临时库，不污染个人内容。生产前端不需要 npm 构建；npm 仅用于格式化和浏览器验收。

## 文档

- [项目交接 · 2026-10-17：V1.2 进展与 Codex / Claude Code 接手入口](docs/handoffs/2026-10-17.md)
- [历史交接 · 2026-10-12](docs/handoffs/2026-10-12.md)
- [V1 版本记录与遗留项](docs/releases/v1.0.0.json)
- [V1 → V1.1 → V2 路线图](docs/65-v1-v2-roadmap.md)
- [macOS 客户端运行与构建](desktop/README.md)
- [领域词汇表](GLOSSARY.md)
- [工程技能的 issue tracker 约定](docs/agents/issue-tracker.md)、[领域文档约定](docs/agents/domain.md)
- [PDF 支持设计对齐与决策进度](docs/50-pdf-alignment.md)
- [PDF 一期共同理解摘要（已确认）](docs/53-pdf-shared-understanding.md)
- [PDF 一期规格](docs/54-pdf-spec.md)
- [PDF 一期开发契约](docs/55-pdf-development-contract.md)
- [PDF 一期转换比较与验收计划](docs/56-pdf-acceptance-plan.md)
- [PDF 配置与 GitHub 规格交付台账](docs/57-pdf-tracker-handoff.md)
- [PDF 一期纵向任务与发布记录](docs/58-pdf-ticket-plan.md)
- [PDF 开发主控与最新授权](docs/59-pdf-development-control.md)
- [PDF 与现有阅读器的整合契约](docs/60-pdf-reading-integration.md)
- [PDF 候选组件上游事实核对](docs/51-pdf-upstream-facts.md)
- [PDF 局部纠错的参考与备选设计](docs/52-pdf-correction-reference.md)
- [正式翻页曲面、原生触控板与高清渲染验收](docs/49-paper-production.md)
- [2026-10-08 验收摘要与复现信息](docs/evaluations/20261008-paper/acceptance.json)
- [Web 03 交互契约、开发说明与验收](docs/12-web-v3.md)
- [2026-10-04 反馈修复与验收](docs/09-feedback-fixes-acceptance.md)
- [初版 02 产品、模块清单、开发契约和体验路线](docs/07-web-prototype-v2.md)
- [本轮评审依据](docs/06-web-review.md)
- [历史可行性](docs/01-feasibility.md)、[历史 PRD](docs/02-prd.md)、[历史设计](docs/03-design.md)、[历史验收](docs/05-acceptance.md)

数据保存在 `data/user.db`，词典与用户库分离；PDF 原件和转换资料默认在 `data/user-pdf/`。功能开关不删除保留资料。升级前备份在 `data/backups/`；本轮比较基线为 `69f0fd0`。不要向 Git 提交数据库、原件、模型、日志或 API key。
