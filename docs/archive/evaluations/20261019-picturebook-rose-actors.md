# 玫瑰章独立角色动态绘本验收 · 2026-10-19

本轮交付第 VIII 章（本机文档 9），入口 http://127.0.0.1:18805/#/living-book/9 。其他章节沿用各自现有渲染器，不能据此宣称全书已经完成独立角色升级。

## 实现与素材

- 保留现有英文版本的全部 69 句、原文 block id 和字符位置，重新分为 26 个阅读页、10 段情节。英文不是中文情节摘要的回译。
- 新增 `web/picturebook-rose-chapter.js`，以原文锚点划分守候、花苞、日出开放、赞叹、浇水、花刺、挡风、夜晚玻璃罩、咳嗽和理解爱意。
- 新增 `web/picturebook-rose-scene.js`：Three.js 正交场景，背景、三种小王子姿态、花苞、枝叶、花头、玻璃罩、挡风屏分别合成。花头使用独立枢轴；手臂与水壶受局部关节变形驱动，水滴沿壶嘴位置运动。玻璃罩下降，屏风滑入，昼夜颜色改变。
- 这是手绘素材驱动的 2.5D 角色动画。三种人物姿态通过透明素材交叉过渡；不是具有完整骨骼、任意视角和三维手指的 3D 模型。水壶绘制在浇水姿态素材中，与手臂一起变形，水流为单独粒子。
- 共享阅读控制器只为第 8 章选择专用数据和渲染器；新增“看原插画 / 回到动态绘本”，对照时暂停动画并恢复此前暂停状态。

使用 **built-in image_gen**，没有使用 CLI。五次生成的完整提示、输入参考和生成原始路径见 [generation.json](../../web/assets/picturebook-rose-actors/generation.json)。最终素材保存在 [picturebook-rose-actors](../../web/assets/picturebook-rose-actors/)：

| 素材 | 用途 |
| --- | --- |
| planet-stage.png | 无角色的星球舞台 |
| prince-seated.png | 托腮守候的独立角色 |
| prince-watering.png | 跪下持壶的独立角色 |
| rose-bud.png | 闭合花苞 |
| rose-shelters.png | 玻璃罩与挡风屏透明图集 |

复用此前获认可的 `picturebook-lookdev-v2/prince.png` 和 `picturebook-fox-reading/rose.png`，保持人物和花的造型。原始生成文件保留；项目内文件为直接复制，没有后处理重绘。透明通道检查在证据目录的 `asset-inspection.json`。

## 实际浏览器走查

证据目录：[outputs/picturebook-rose-actors-20261019](../../outputs/picturebook-rose-actors-20261019/)。以下来自当前本机 Web 应用的直接浏览器操作；窄屏为桌面浏览器视口模拟，不代表实体手机验收。

| 检查 | 结果 / 证据 |
| --- | --- |
| 连续逐句读完全部正文 | 69/69 句，26 页、10 情节；每页只有一个 canvas，无横向溢出。`forward-source-69.json` |
| 原文完整性与定位 | 与文档中的原文、block id、起止位置逐句匹配；`source-verification.json` |
| 悬浮句子 | 从第 19 句移到第 18 句，140ms 防抖后推进到对应句子；`sentence-hover-settled` |
| 花苞与开花 | 静止花苞、开放初期、完整开放截图；bloom 从 0.347 到 1.000 |
| 关键词 | 实际触发 water、prince、yawned、coughed、fragrance、draughts、screen、globe；鼠标悬浮与 Enter 均有覆盖 |
| 浇水时触发 prince | 水流暂退，持壶角色透明度始终 1；动作结束恢复浇水。`prince-while-watering-*` |
| 暂停与对照 | 暂停前后时间及帧数不变；对照原图时 canvas 隐藏、原图可见；切回保留暂停状态 |
| 暂停时切情节 | 花苞状态即时更新，可继续阅读 |
| 刷新恢复 | 第 59 句（索引 58）刷新后仍为同一句 |
| 390 CSS px 窄屏 | 单词点按、下一句正常，未横向溢出；`mobile-water.png` 与 `mobile-next` |
| 路由回归 | 狐狸章仍为 145 句原渲染器；日落章仍为 26 句通用渲染器；返回原阅读页后 canvas 数量为 0 |
| 控制台 | 当前捕获的 warning/error 为空，`console.json` |
| 静态检查 | 三个改动 JS 文件 `node --check` 通过；四个改动 JS/CSS 文件 Prettier 检查通过；`git diff --check` 通过 |

`browser-checks.json` 保留交互快照。即时悬浮观测可能在防抖前（`sentence-hover`），应查看后续 `sentence-hover-settled`；不要把前者当作已完成切句。截图用于检查视觉，DOM 中的动作名称仅为交互状态辅助证据。

## 复现

1. 打开上述入口，将“跳到句子”拖到第一句，连续使用“下一句”读完 69 句，观察 10 段情节和正文连续性。
2. 点“花苞的准备”，再点“在日出时盛开”；观察花苞向开放花头的过渡。
3. 点“给玫瑰浇水”，推进到第 33 句，点 water 和 prince：水流与人物动作响应，人物不消失；稍候恢复当前情节动作。
4. 点“挡住吹来的风”“夜里的玻璃罩”“两三声咳嗽”，分别触发 draughts、screen、globe、coughed；观察独立道具和花头。
5. 开关“看原插画”，再在暂停状态下重复开关；切回后应维持暂停。暂停中切情节仍应显示所选画面。
6. 第 59 句刷新验证位置；在 390 CSS px 宽度点 water、下一句，检查文字与固定画面不重叠。
7. 用章节选择器进入狐狸章和日落章，再回玫瑰章；返回原阅读页检查旧 canvas 已卸载。

复核已保存的浏览器原文证据：

```sh
node outputs/picturebook-rose-actors-20261019/verify-source.mjs
```

源文与实读英文的 SHA-256 均为 `9b2a7ec31790bd205eaa25f5633b0b25b268772f4c05b4050b645dc4397390af`。此命令验证已保存的浏览器结果，不替代重新走查当前网页。

本轮没有编写单元测试，没有运行无关的全项目 E2E 套件，没有提交或推送共享工作区。WebGL 不可用时的静态回退路径存在，但本轮没有进行故障注入；未声称原生客户端、实体手机或生产部署验收。
