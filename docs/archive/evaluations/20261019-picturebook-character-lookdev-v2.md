# 小王子与狐狸：第二轮绘画角色样片

交付页面：<http://127.0.0.1:18805/static/picturebook-lookdev.html>。这是重新制作角色原画、在 WebGL 中做深度与局部动作的 **2.5D 绘画样片**。它改善了视觉方向，但没有完成上轮计划中的完整 3D 雕刻、UV 手绘、骨骼与 GLB 工作流，不能把这次结果记成该工作流已完成。

## 视觉与交互

狐狸重新采用细长口鼻、自然四肢、深色耳缘、奶油色胸毛和蓬松长尾。小王子重新采用自然儿童脸型、金色卷发、苔绿色长外套、黄围巾和皮靴。三张最终绘画素材保留透明边缘与定向笔触，并置于相同麦田配色的场景。

页面支持同一画页、狐狸和小王子三种观察方式，角色细节放大，以及原绘本/上一轮模型切换。原绘本局部保持原像素，因此放大时可见原分辨率的模糊。两边不是严格相同镜头或同一笔触重现。

`fox` 触发耳朵/头部/尾巴变形，`prince` 触发轻点头，`wind` 增强围巾和尾巴摆动，`Good morning` 触发双方回应。它们改变局部网格，不只是整张图平移/放大。有限视差来自手工定义的深度场。角色背面未建模；毛发与表情细节主要存在于纹理中。

## 保留与复现

- 新页面：[picturebook-lookdev.html](../../web/picturebook-lookdev.html)，实现：[picturebook-lookdev-v2.js](../../web/picturebook-lookdev-v2.js)。
- 上轮页面：[picturebook-lookdev-v1.html](../../web/picturebook-lookdev-v1.html)，上轮 Blender 模型和所有渲染未覆盖。
- 新素材及来源：[README](../../web/assets/picturebook-lookdev-v2/README.md)，[完整实际提示词](../../web/assets/picturebook-lookdev-v2/generation.json)。使用内置 image_gen，未改用外部 3D 生成服务或 CLI 图像接口。
- 未改变正文阅读路由、读书位置或用户数据库。本轮只替换独立样片页。

## 直接浏览器走查

证据目录：`outputs/picturebook-lookdev-v2-20261019/`。实际 IAB 浏览器，桌面和实际 CSS 宽度 390px；并非物理手机验证。步骤：打开页面 → 三种角色视图 → 面部细节/完整角色 → 原绘本/上一轮 → 悬浮 fox/prince/wind → 键盘 Enter 触发 Good morning → 暂停/复位/播放 → 窄屏点按 wind → 画面离开视口 → 恢复桌面。

保留 `scene.png`、`fox-detail.png`、`prince-detail.png`、`prince-before-after.png`、移动视口截图、动作前后帧、`browser-checks.json` 与 `manifest.json`。暂停前后两个独立采样的计数均为 834、时间均为 13.366；狐狸动作运行期间采样变形量从 0.0070 变为 0.4090。这里只证明代码与局部动作实际运行，不将这些数值解释为美术验收评分。

页面未横向溢出，图片加载成功，控制台结果记录在原始检查文件。没有新增单元测试，没有运行无关全量 E2E。`node --check`、Prettier、`git diff --check` 通过。

首次失败保存在 `first-failures.md`：初版角色边缘超框；泛化的 data-view 选择器误绑定 body，导致按钮点击冒泡后重置；fullPage 截图在当前缩放下截断右侧，最终比较截图改为实际窗口截图并检查。

## 未完成的范围

这次是固定阅读镜头的视觉可行性样片。没有新增完整三维角色、自由旋转、骨骼动画、动态重照明、GLB、真正的眨眼/口型、实体手机性能验证，也没有扩展到全书。画面好坏仍需用户对照原绘本判断。
