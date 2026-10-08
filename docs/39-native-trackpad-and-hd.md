# 本机触控板与高清翻页

独立原型经用户体验通过后，接入正式 `#/read/<id>`。正式正文仍为可选择的 DOM，翻动纸页才使用 WebGL。

## 运行与边界

`python3 scripts/web.py start` 在 macOS 上同时启动本机 scrollWheel 阶段桥接；stop/restart 管理对应生命周期。需要已有的 Swift 编译环境，编译只发生在辅助服务启动时，不在打开书籍时。失败不会阻止正文或鼠标/键盘翻页。没有开机启动项。

连接发现由 `/api/reading/native-trackpad` 提供，限定本机请求、禁止缓存。运行时连接配置存 `.runtime/trackpad-lab/client.json`（权限 0600）；WebSocket 仅绑定 127.0.0.1:8769，并检查 Origin 和临时令牌。数据仅 scrollWheel 的位移/阶段，不包含原文、键盘或其他应用活动。

在本机接入可用时，原生阶段决定结束：手指停驻没有阶段结束则保持纸张；ended/cancelled 或进入惯性才完成/返回，不应用惯性位移。完成规则、反向意图与二维抓取几何沿用验收原型。松手收尾目标 100–180ms，实际时长与纹理等待分别记录。

纸边与正文都可激活；没有覆盖正文的输入层。工具层、选区、词卡、译文、编辑和缩放保留自己的交互；Esc、失焦、路由和布局变化清理手势/队列。末页给出反馈，有下一章时按稳定文档位置进入，旧惯性不能再次翻页。

非本机或桥接初始不可用时保留旧 wheel 兼容方式，`data-trackpad-mode=wheel-compatibility`。这种模式无法证明手指接触状态。已连接的原生接入断开时取消半翻状态、有限重连，使用鼠标/键盘仍可继续；不会用静默计时器冒充真实抬手。

## 清晰度与性能

旧代码把纹理/画布限制为最多 1.5×；新代码分别按屏幕 DPR（最多 3）创建纹理和画布，受 GPU 最大边长和像素预算约束。硬件画布最多 8M 像素、单张纹理最多 6M；缓存最多 6 张／24M 像素（约 96MB RGBA）。软件 GPU 维持低画布像素预算并避免昂贵的高清着色，以明确的 software 标志记录降级。静态 DOM 正文不降清晰度。

支持时，硬件使用高精度纹理坐标和最多 4× 各向异性过滤，改善倾斜纸面的采样；参见 [WebGL 扩展规范](https://registry.khronos.org/webgl/extensions/EXT_texture_filter_anisotropic/)。屏幕 DPR 变化会失效缓存。这里只预热相邻页，不扫描或截图整本书；有正在显示的纹理时，缓存淘汰跳过它们。

阅读节点的 `data-curl-resolution` 分别记录屏幕 DPR、画布与前/后纸纹理尺寸；`data-curl-driver` 与 `data-curl-device` 区分实际 GPU。`data-curl-metrics` 包含首帧、绘制间隔、输入延迟、释放动画与纹理等待。

## 模块与清退

- `reading-trackpad.js`：入口及本机／兼容选择。
- `reading-native-trackpad.js`：阶段、队列、门控和有界手势摘要。
- `reading-wheel.js`：原有浏览器兼容行为。
- `reading-gesture-policy.js`：鼠标/触控板共用完成与回滑意图。
- `pagination.js`：原生短收尾和稳定阅读位置；`page-curl-renderer.js`：高清纹理、GPU 缓存与光影。
- `native_input.py`、`scripts/trackpad_lab/`：本机配置发现和服务生命周期。

通过 `WR_NATIVE_TRACKPAD=0 python3 scripts/web.py start` 禁用本机接入（已运行时先 restart，或单独停止桥接）。本机接入可独立撤掉；无需移除书籍、笔记、译文或其他阅读功能。生成的 bridge-config.js 不提交。系统手势记录不写入磁盘，诊断报告只按需要在本项目保存快照。

## 验收范围

开发结束后运行完整浏览器 E2E；新增正式原生阶段文件 `tests/browser/reader-native.spec.js` 明确使用 phase fixture，验证生产 DOM、实际 Metal GPU 与 DPR 尺寸，不能替代用户真实触控板复验。原有兼容输入、书籍导入、笔记/译文、位置和性能守卫一起回归。

复现：`WR_E2E_EVIDENCE=outputs/native-hd-reproduce npx playwright test`。

报告与首轮失败保留在 `outputs/wise-reader-native-production-20261007/`。真实手感建议在正式书籍单页、双页分别测试：连续 10 次、停驻至少 1 秒再继续/回滑、抬手收尾、前后交替，以及翻页时的文字锐度。
