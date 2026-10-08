# Wise Reader

面向中文读者的本地英文阅读 Web 原型。中文解释贴近正文，阅读偏好与笔记自动保存；16 个扩展可以逐个开关。

当前版本：**Web 原型 03**。使用已有 FastAPI / SQLite / 本地词典，前端为可拆卸 ES modules。

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

EPUB/TXT/Markdown 导入、章节目录、沉浸阅读、笔记、书签、续读、译文、导出、朗读、主题、排版、搜索、统计、快捷键、本机访问锁。

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

完整 E2E 只在开发结束时运行，生成 `.runtime/acceptance/<时间>/` 下的 HTML、trace、截图、源码快照及校验清单。开发中用 `npm run test:e2e -- --grep <场景>` 运行目标场景。AI 测试使用 18768 本地模拟供应商，不证明真实模型或音质。

浏览器测试使用 18767 上的独立临时库，不污染个人内容。生产前端不需要 npm 构建；npm 仅用于格式化和浏览器验收。

## 文档

- [正式翻页曲面、原生触控板与高清渲染验收](docs/49-paper-production.md)
- [2026-10-08 验收摘要与复现信息](docs/evaluations/20261008-paper/acceptance.json)
- [Web 03 交互契约、开发说明与验收](docs/12-web-v3.md)
- [2026-10-04 反馈修复与验收](docs/09-feedback-fixes-acceptance.md)
- [初版 02 产品、模块清单、开发契约和体验路线](docs/07-web-prototype-v2.md)
- [本轮评审依据](docs/06-web-review.md)
- [历史可行性](docs/01-feasibility.md)、[历史 PRD](docs/02-prd.md)、[历史设计](docs/03-design.md)、[历史验收](docs/05-acceptance.md)

数据保存在 `data/user.db`，词典与用户库分离。功能开关不删除数据。升级前备份在 `data/backups/`；代码基线为 `4a7da10`。不要向 Git 提交数据库、日志或 API key。
