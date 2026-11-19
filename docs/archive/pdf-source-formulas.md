# PDF 原式优先与按需识别

2026-10-10 接入正式 Web 阅读器。选择导入处理方式「公式与复杂排版（原式优先）」使用本机 MinerU；默认 `auto` 与已有 Omarchy 扫描 OCR 保持原有选择。

## 阅读行为

- 导入时执行版面和正文提取，公式保留原件裁切，不运行公式转 LaTeX 模型。科研图表、表格与图片保留原图，图注进入正文。
- 行内公式跟随正文字号；独立公式保留编号。点击原式可核对原版，主动点击「识别公式」才调用本机 PP-FormulaNet。识别结果是旁注，不替换原式、不重写阅读内容与锚点。
- 成功结果持久保存。重复点击、服务重启、仅排版转换版本变更时，只要原文件、原页、裁切内容、模型与识别设置一致，即复用结果。不同来源版本有独立的可查询收据。
- 导入与识别共用有界的本机推理锁。忙时排队，取消、停用或退出时结束进程；失败不写入成功缓存，可以重试。已缓存内容在停用处理或模型暂缺时仍可查看。

## 模块与契约

`pdf_lab/adapters/mineru.py` 是转换适配；`mineru_engine.py` 把重模型隔离在子进程；`mineru_runtime.py` 负责轻量运行环境探测。MinerU 4.0.11 的公式钩子受固定版本约束，升级时必须重新走查，不能直接放宽版本。

行内原式在规范文本中占一个 U+FFFC，附带 `inline_objects`：Unicode codepoint 范围、可信资产、`formula_id`、原页坐标与正文基准字号。浏览器转换为 UTF-16 范围；笔记显示为「〔原式〕」，存储引用仍保持原字符。图表的上游类型 `chart` 必须显式映射到原图，不能压成纯文字。

`pdf/formulas.py` 管理本地队列、归属验证和 SQLite 缓存；`scripts/formula_recognize.py` 仅允许注册的 CPU 模型、裁切及配置，禁止网络与子进程扩散。

接口以已注册的 `task_id + formula_id` 寻址，不接受客户端文件路径：

- `POST /api/pdf/books/{book_id}/formulas`：提交或直接复用成功结果。
- `GET /api/pdf/books/{book_id}/formulas?task_id=…&formula_id=…`：查询已有结果，不发起推理；跨版本缓存命中可建立对应的完成收据。
- `GET /api/pdf/books/{book_id}/formulas/{job_id}`：查询该书任务状态。

缓存位置是 PDF 资料库下的 `formula-cache/cache.sqlite3`。任务缓存与阅读数据库分开；成功内容缓存依据源文件 SHA256、原页、裁切 SHA256、模型和配置身份。不要按页码或公式编号单独复用。

## 本机运行环境

运行环境独立存放在 `.runtime/mineru/`，不进入 Git，不在打开书籍时安装模型。现有受信任的 MinerU 4.0.11 环境可通过以下命令登记，安装过程不自动联网下载：

```sh
python3 scripts/setup_mineru_runtime.py --venv /absolute/existing/venv --models /absolute/MinerU-4_models_onnx
```

登记已有受管环境使用 `--register-only --refresh`。初次登记核对完整文件摘要；后续使用设备、inode、大小、mtime、ctime 一致的校验收据，变化时重新核对内容。探测状态不加载模型。缺少运行环境时明确禁用该处理选项，原有书籍仍能阅读。

## 验证与已知边界

本轮证据位于 `outputs/pdf-source-first-integration-20261010/REPORT.md`，GPU 对照位于 `outputs/pdf-gpu-import-20261010/README.md`。保留首个失败、修复记录、真实页面截图、原始 API 测量和受控故障记录。API 可读时间不是浏览器首屏时间，原图保留不是公式语义识别成功。

当前正式源式路径是 Mac CPU。Omarchy 的混合 GPU 论文转换仍是实验候选；扫描 OCR 三 worker 的速度也只是指定设备、指定样本的压测结论，不是全局默认。未宣称任意扫描、旋转、裁剪、多栏或全部公式准确率通过。本轮未重新打包 macOS 客户端，也没有调用付费 LLM。
