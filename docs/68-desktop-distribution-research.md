# V1 收口对齐 Q1：桌面分发限定事实研究

2026-10-09；检索窗口 07:29:15–07:31:46 UTC，低于四分钟。仅源码、官方文档和发行元数据研究；未安装、运行或下载 Magpie 整包，未实现客户端，不作产品选型决定。已读指定 research 技能。

## 1. 固定版本与实际架构

Magpie 源码固定为 [`62b1c995ffaebb223ad040b4c54ebabab0078c7a`](https://github.com/yetone/magpie/tree/62b1c995ffaebb223ad040b4c54ebabab0078c7a)。其 [`go.mod`](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/go.mod#L3-L21) 明列 Go 1.26.8、Wails v3.0.0-beta.24；不是 Tauri/Electron。该 Wails 版本解析到 `f5457ed12f5c53883c4820437d106d48f4340f1e`，其 [macOS 实现](https://github.com/wailsapp/wails/blob/f5457ed12f5c53883c4820437d106d48f4340f1e/v3/pkg/application/webview_window_darwin.m#L549-L557) 使用 WKWebView。

| 层次 | 源码事实 |
|---|---|
| UI | [index.html](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/gui/assets/index.html#L8-L22) 加载本地 JS/CSS；[api.go](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/gui/api.go#L135-L136) 用 `go:embed assets` 内嵌资源。 |
| 桌面入口 | [app.go](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/gui/app.go#L319-L343) 将同一 UI/JSON API handler 交给 Wails；不能据此称为所有功能单进程，WebKit 有内容进程。 |
| 本地服务 | [backend.go](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/gui/backend.go#L27-L42) 通常在本进程启动 gateway；若已有另一 Magpie/CLI 服务则复用，另有接管监视。并非强制独立常驻服务。 |
| 窗口生命周期 | [lightweight.go](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/gui/lightweight.go#L84-L96) 关闭窗口保留托盘；[轻量模式](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/gui/lightweight_rule.go#L5-L29) 开启后，关闭约 30–60 秒释放 WebView，再开重建。注释的内存节省不是本研究实测。 |

## 2. 构建、签名、发行与更新

[`make app`](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/Makefile#L17-L22) 在 macOS 原生编译链接 WebView，最低目标 12.0；[打包段](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/Makefile#L59-L67) 装入可执行文件、图标和 Info.plist。源码仓库 [release workflow](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/.github/workflows/release.yml#L41-L51) 委托独立 `yetone/magpie-releases`。

发行流水线固定 [`48b20c8af4bc89d73fbe7a470fa9e51cd5d18b1b`](https://github.com/yetone/magpie-releases/blob/48b20c8af4bc89d73fbe7a470fa9e51cd5d18b1b/.github/workflows/release.yml#L110-L170)：分 arm64/amd64 构建；有证书时 Developer ID + hardened runtime，提交 DMG 至 notarytool，要求 Accepted，给 DMG 和 ZIP 内 app staple 并执行 spctl；无证书分支为 ad-hoc 签名。**这是条件化源码流程，最新资产实际签名、公证状态未验。**

截至检索时，[latest API](https://api.github.com/repos/yetone/magpie-releases/releases/latest) 返回 [v0.1.1137](https://github.com/yetone/magpie-releases/releases/tag/v0.1.1137)，发布时间 `2026-10-09T06:34:27Z`。[固定版本 API](https://api.github.com/repos/yetone/magpie-releases/releases/tags/v0.1.1137) 的 `assets[].size` 如下；仅读取 metadata。发行 tag 的[源码解析](https://api.github.com/repos/yetone/magpie/commits/v0.1.1137)为 `1bc0ed404a54567c5073c49c193cdd40aeab2bc4`，与本次 main 源码快照分列，不冒充产物可复现证明。

| 压缩发行物 | bytes | MiB（÷1,048,576） |
|---|---:|---:|
| magpie-darwin-arm64.dmg | 19,404,287 | 18.51 |
| magpie-darwin-arm64.zip | 17,578,995 | 16.76 |
| magpie-darwin-amd64.dmg | 21,513,917 | 20.52 |
| magpie-darwin-amd64.zip | 19,390,118 | 18.49 |

发行说明宣称已安装应用会自动更新；[更新源码](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/update/update.go#L228-L326)显示：从 `https://usemagpie.ai/api/latest` 取 feed，下载对应架构 ZIP，[核对 SHA-256](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/update/update.go#L590-L655)，解压验证签名与原包 TeamIdentifier，暂存后替换，替换失败尝试恢复旧包；重启 helper 等原进程退出。两包都无 TeamIdentifier 时比较仍相等，不能把该比较等同于强制 Developer ID。[GUI](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/gui/update.go#L97-L101)允许关闭自动更新；[等待逻辑](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/gui/update_wait.go#L11-L22)延迟至 gateway 空闲。没有证明数据迁移回滚或所有子进程均已清理。

可借鉴：架构分包、安装 DMG/更新 ZIP 分工、校验后暂存、失败恢复、空闲更新。窗口释放与服务存续可分开设计，但阅读位置必须先持久化；不据此决定 Reader 是否常驻托盘。

## 3. 保留 Web 核心的两条路线

| 路线 | 少量官方证据及待验证代价 |
|---|---|
| 系统 WebView 壳：Swift WKWebView 或 Tauri | [Tauri 官方](https://v2.tauri.app/reference/webview-versions/)确认 macOS 使用系统 WKWebView，版本随系统更新；可省去自带 Chromium，但 WebKit 兼容须逐项验。Swift 可直接承接原生事件，Tauri 需相应原生桥；这是适配推断。官方 [sidecar](https://v2.tauri.app/develop/sidecar/) 支持按架构携带 Python 打包产物，不证明本项目已能封装。 |
| Electron | [官方进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)为 Chromium 多进程及 Node 主进程，可保留 Web 内容；需维护随包引擎、IPC 和 Python 子进程。引擎版本可控，也不能免除截图、手势、清晰度实测。 |

两者都不凭名字保证轻量、迅捷；冷启动、阅读首帧、整棵进程树内存、CPU、翻页延迟须同设备同资料比较。这里不选路线。

## 4. Wise Reader 约束与最小分发验证

以下由**主控当前工作区读取**提供；脚本关键项另与固定基线 `9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d` 核对。

| 现状及固定源码 | 分发验证点，不要求现在实现 |
|---|---|
| [pyproject.toml](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/pyproject.toml#L6-L14)：FastAPI、Python ≥3.12；[web.py](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/scripts/web.py#L74-L95)依赖根目录 `.venv/bin/python`、8766，脱离终端运行。 | 自带运行时/依赖、端口冲突、启动握手、退出所有权；不能直接搬开发启动脚本。 |
| [manage.py](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/scripts/trackpad_lab/manage.py#L34-L44)新起 bridge 时 swiftc 编译并用8769；[PhaseMonitor.swift](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/scripts/trackpad_lab/PhaseMonitor.swift#L23)仅列 Codex/ChatGPT/Chrome/Edge/Safari。 | 新 Reader.app 不匹配现有前台白名单；验证预编译 helper 或应用内 NSEvent，以及权限与生命周期。 |
| [server.py](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/scripts/trackpad_lab/server.py#L11)仅允许两个8766 HTTP Origin；[renderer](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/web/page-curl-renderer.js#L321)由 SVG foreignObject 图像生成 WebGL 纹理。 | 壳协议/Origin与事件桥适配；实际 WebKit 字体、图像、纹理和高 DPI 清晰度不能沿用 Chrome 结论。 |
| 主控测得 `data/stardict.db` 为946,715,648 bytes＝902.86 MiB；另有独立 OCR 环境、本地 TTS 可选。 | 这是词库文件当前大小，不是压缩安装包；核对词库/OCR/模型分包、版本、校验、离线可用性与失败恢复。Magpie 大小不能估算 Reader。 |

最小验收须留下机器/OS/架构、包 SHA-256、操作步骤、截图/录屏、时间与内存原始值、PID/端口快照及首个失败：① 无 Python、Xcode、开发环境的干净系统安装启动；② 实际阅读、触控板拖停/反向/取消及 WebGL 高 DPI 清晰度；③ 休眠、唤醒、退出重开恢复续读位置和转换状态；④ 明确退出后无本应用后台孤儿、端口残留，重复启动不抢占；⑤ 升级及中断升级后保留原件、笔记、书签、转换结果、重放资料，以更新前后清单/哈希和重新打开核对，符合 [ADR-0003](https://github.com/Coraia/EasySink/blob/9a8b46ac913bfbd8edca9bbc71d7f77d7ea39a9d/docs/adr/0003-preserve-conversion-and-replay-material.md)。**以上全部待验，当前无端到端分发通过结论。**

证据缺口：首次请求源码仓库 `/releases/latest` 为404，随后定位发行仓库；更新 feed 实读403，未确认当前响应；一次重复读取发行 workflow 遇 TLS EOF，采用此前成功读取的固定源码。最新包解压大小、签名/公证实况、真实资源占用及 Reader 封装体积均未知。未查看用户凭据，未运行测试或改动服务、数据库、issue。
