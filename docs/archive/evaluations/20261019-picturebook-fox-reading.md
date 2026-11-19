# 小王子与狐狸：一页动态阅读

体验入口：<http://127.0.0.1:18805/#/fox-story/22>。原书第 21 章阅读页和角色对比页也增加入口。本次交付是 9 句原创英文改写短篇，三幕分别为狐狸出现、互相问候、成为朋友。完整英文正文仍在原阅读页，短篇不写入原书阅读进度。

## 实际效果与实现边界

悬浮、点击句子或使用左右方向键，画面随故事推进：小王子独处、狐狸出现、双方问候、换为坐姿、逐渐靠近。下划线单词显示中文词义并触发局部动作；time 放慢动画。支持中文提示、暂停动作、一遍自动演示和手动打断演示。

沿用已认可的绘画角色，新增同风格双人坐姿素材。Three.js 纹理网格与局部变形产生头部、耳朵、尾巴、围巾的动作和有限视差。这是 2.5D 动态绘本：站姿到坐姿通过交叉淡入淡出切换，未制作完整骨骼、角色背面、自由旋转或口型，不代表全书动画已经完成。

实现文件：`web/picturebook-fox-reading.js`、`web/picturebook-fox-reading.css`、`web/picturebook-fox-reading-scene.js`、`web/picturebook-painted-actors.js`。路由及原书入口在 `web/picturebook.js`，对比页入口在 `web/picturebook-lookdev.html`。原对比样片的渲染实现保留。

坐姿素材由内置 image_gen 参照已认可的 prince.png / fox.png 生成，透明原图直接保存，未用图像处理脚本改绘。完整实际提示词、来源、参考图在 [generation.json](../../web/assets/picturebook-fox-reading/generation.json)。角色分离通过运行时 UV 遮罩完成。

## 浏览器复现与证据

实际 IAB 浏览器、实际 WebGL，隔离预览服务 18805；窄屏是浏览器 390 CSS px 视口，不是物理手机或原生桌面客户端验证。未运行无关全量 E2E，未新增单元测试。

1. 从 `/#/read/22` 点击“读一页会动的故事”。首句仅小王子，页面只创建一个绘画 canvas。
2. 悬浮第二句，狐狸出现；悬浮 morning，双方回应并显示词义。
3. 逐句前进到第九句，再反向回读；第六句换坐姿，第七至九句逐渐靠近。方向键也可推进。
4. 点击“演示一遍”，自动结束在第九句；再次播放后点击第三幕，演示立即停止并响应手动选择。
5. 键盘 Enter 触发 closer；点 time 显示词义并进入放慢动作状态。
6. 暂停动作，两次独立采样 frames 均为 2272、time 均为 30.742。恢复后继续。
7. 390px 宽度点击句子和中文提示，插画固定在上方，正文可阅读，无横向溢出。
8. 返回完整原文，动态绘本 canvas 和 body 样式清除，原书仍为第 21 章第 1/49 页、首句 “It was then that the fox appeared.”。重新点击入口从短篇首句开始，仅一个 canvas。

证据目录：[outputs/picturebook-fox-reading-20261019](../../outputs/picturebook-fox-reading-20261019/)。`browser-checks.json` 保留 30 次 DOM 状态采样与控制台结果（warn/error 空）；`final-reading.png` 为最终实际画面，另有 `arrival.png`、`arrival-before.png`、`demo-ended.png`、`mobile-friendship.png`。原始标签 mobile-390 的第一次采样实际为 429px；后续 mobile-390-click 和 mobile-translation 才是实测 390px，原记录保留。

暂停、返回原文、重入均实际操作验证。稳定友谊场景 3 次绘制调用，未做帧率基准，不据此声称手机性能通过。资源加载失败与 WebGL 丢失的静态插画回退已实现，但未强制故障注入；系统减少动态效果偏好也未实际切换验证。

首次可见问题及修复保留在 `first-failures.md`：应用侧栏漏出、背景上下色带。修复后重新检查桌面及窄屏。语法检查、格式检查与 `git diff --check` 通过；源文件和证据哈希见 `manifest.json`。
