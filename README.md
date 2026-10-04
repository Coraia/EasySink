# Wise Reader

面向中文读者的本地英文阅读 Web 原型。中文解释贴近正文，阅读偏好与笔记自动保存；15 个扩展可以逐个开关。

当前版本：**Web 原型 02**。使用已有 FastAPI / SQLite / 本地词典，前端为可拆卸 ES modules。

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

AI 是可选的。未配置时使用词典和有限的语境/表达规则，可自行粘贴译文；配置后支持后台增强注释及分段整书翻译，提供进度、取消与断点重试。进入「AI 与语音」分别配置文本模型与自然语音服务；保存后立即生效，无需重启。服务端凭据文件 `data/ai-settings.json` 权限为 0600，不回填到页面。`.env` 仍作为未保存 UI 配置时的默认值。账号仅锁住本机实例，没有云端账户或多用户隔离。

EPUB 保留主要文本结构，图片使用替代文字，不保留完整原书版式和脚注交叉链接。辅助密度是软预算，明确要求保留的注释独立于自动预算，不会挤掉其他非重叠注释；「多」也会扩大候选词范围。书签可在工具栏切换，或直接点击正文标识移除。朗读支持可选的神经语音服务、试听、音色、暂停/继续及本机缓存。

## 验证

```bash
npm ci
npx playwright install chromium
.venv/bin/python scripts/e2e_acceptance.py
```

完整 E2E 只在开发结束时运行，生成 `.runtime/acceptance/<时间>/` 下的 HTML、trace、截图、源码快照及校验清单。开发中用 `npm run test:e2e -- --grep <场景>` 运行目标场景。AI 测试使用 18768 本地模拟供应商，不证明真实模型或音质。

浏览器测试使用 18767 上的独立临时库，不污染个人内容。生产前端不需要 npm 构建；npm 仅用于格式化和浏览器验收。

## 文档

- [2026-10-04 反馈修复与验收](docs/09-feedback-fixes-acceptance.md)
- [初版 02 产品、模块清单、开发契约和体验路线](docs/07-web-prototype-v2.md)
- [本轮评审依据](docs/06-web-review.md)
- [历史可行性](docs/01-feasibility.md)、[历史 PRD](docs/02-prd.md)、[历史设计](docs/03-design.md)、[历史验收](docs/05-acceptance.md)

数据保存在 `data/user.db`，词典与用户库分离。功能开关不删除数据。升级前备份在 `data/backups/`；代码基线为 `4a7da10`。不要向 Git 提交数据库、日志或 API key。
