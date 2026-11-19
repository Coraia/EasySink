# 《小王子》单页 3D 阅读实验 · 2026-10-19

已在隔离预览的第 21 章第一阅读页接入真实 WebGL 3D：纯代码创建小王子、狐狸、苹果树、麦田、云朵、蝴蝶和灯光。原本三句英文逐字保留。范围仅这一页，其他页继续使用已有的全书水彩插画。

## 体验与复现

1. 保持隔离预览服务运行，打开 http://127.0.0.1:18805/#/read/22 。
2. 选择少儿版，点“试试：让这一页的单词动起来”或“动态 3D · 试读一页”。入口会回到本章第一页。
3. 悬浮、点击或 Tab 后回车选择带下划线的单词：fox 摇尾竖耳；appeared 从树后走出；morning 晨光升起；prince 挥手；turned 转身；nothing 狐狸藏到树后。最后两者共享这个原文情节。
4. 点击场景里的狐狸或小王子，会反向选中对应原文单词；横拖转动，点“初始视角”复位。暂停后仍可用词语切换静态姿态。
5. 下一阅读页自动回到水彩并销毁渲染器，返回第一页需再次主动进入。切章、切回普通版会随阅读路由清理资源。

## 实际浏览器证据

证据目录：`outputs/picturebook-3d-20261019/`。`browser-checks.json` 保存实际鼠标/点击/键盘操作后读取的画布帧计数、网格姿态、动作与相机转角。诊断值直接来自已渲染网格，不是独立模拟状态。

- 逐词实际悬浮六种词、键盘回车、狐狸/小王子射线点击、拖转、复位、快速跨词切换、水彩切换、翻页退出与切章清理已走查。原文三句与已有全书源文本相等。
- 暂停时连续观察帧计数相等；nothing 的实际 fox.visible 为 false，morning 的太阳高度从 4.3 变为 4.95，prince 手臂旋转约 -2.36，turned 的角色转角为 2.5 弧度。
- 实际拖转 yaw 从 0.060 变为 -0.587，复位回到 0.060。
- 窄屏浏览器实际视口宽 354 CSS px（视口工具请求 390×844，宿主显示缩放后测量值以实际 DOM 为准），页面 scrollWidth=354；场景宽 316.73、高 340，无横向溢出。点到下方 prince 时，场景仍 sticky 在 y=0，实际触发挥手。`mobile-final.png`。
- 桌面实际渲染平均帧间隔样本约 16.6ms，约 60fps，163–166 次 draw call；这是本机浏览器样本，不能代表真机或所有 GPU 性能。
- 最终源资源版本 `/assets/e0610eff31251d14/`。控制台历史仅保留首次 `/assets/6c753349b6e4744e/` 的 PCFSoftShadowMap 警告；修正后版本没有新增 warning/error。原始日志保留，不抹除初次问题。
- 最终画面 `preview-3d.png`，当前浏览器停在动态 3D、prince 挥手状态。

既有定向浏览器 E2E：3 passed / 0 failed，约 7.3 秒，覆盖粘贴导入、稳定位置保存/路由清理、入口与动态插件资源版本。命令：

```sh
WR_E2E_PORT=18825 WR_E2E_PROVIDER_PORT=18826 WR_E2E_EVIDENCE=outputs/picturebook-3d-20261019/regressions npx playwright test tests/browser/reader.spec.js tests/browser/feedback.spec.js --grep 'paste import persists|progress saves a stable location|entry, styles and dynamically imported plugins' --workers=1
```

截图与 Playwright trace 位于 `regressions/results/`。未新增单元测试，未运行全量无关 E2E。

## 实现与边界

`web/picturebook-fox-scene.js` 管理几何体、灯光、实际动画、射线点击和资源释放；`web/picturebook-3d.js` 管理单页模式、原文词语标记和路由生命周期；`web/picturebook-3d.css` 管理桌面与手机布局；`web/picturebook.js` 只对第 21 章挂载实验入口。Three.js 0.186.0 随仓库保留原始模块及 MIT 许可，点击进入后才加载，不需要 CDN、远端模型或贴图。

实现了 WebGL 不可用、模块失败、上下文丢失时退回水彩，以及减少动态效果偏好、标签隐藏和场景离屏时暂停循环；这些异常/偏好路径本轮未在真实设备上完整验收。手机证据是桌面浏览器窄屏，并非物理手机。无安装客户端、生产部署或全书 3D 的验收声明。

隔离预览继续使用 `.runtime/picturebook-preview-20261019/user.db`，未更改个人 `data/user.db`。重启同一隔离服务可运行 `.venv/bin/python outputs/picturebook-3d-20261019/restart_preview.py`；服务元数据位于该 runtime 目录 `server.json`。未提交或推送共享工作区。

首轮问题与修正见 `first-failures.md`：依赖文件名变更、初次阴影警告、暂停控件导致的 7.727px 内部滚动、窄屏 aspect-ratio 裁切均保留并修正。没有找到用户所说的具体 X 帖子，未声称复现某条作品。

依据：[Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)、[Raycaster](https://threejs.org/docs/pages/Raycaster.html)、[r186 源码与许可](https://github.com/mrdoob/three.js/tree/r186)。
