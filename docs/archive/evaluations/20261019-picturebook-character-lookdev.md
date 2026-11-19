# 狐狸与小王子：第一轮角色样片 · 2026-10-19

交付入口：http://127.0.0.1:18805/static/picturebook-lookdev.html 。三列分别为现有绘本局部、生成式风格目标图、实际 Blender 离线模型渲染。可切两个角色、正面／四分之三／侧面、干净渲染／轻水彩合成，也可看完整原绘本与完整设计板。

**样片已制作并可对照，美术品质未达标。** 设计参考更接近已有绘本；实际模型仍有明显的程序造型与材质差距。本轮不把生成式目标图当作已完成模型，不把 Blender 离线画面当作网页引擎实测。没有替换阅读场景、改原文或改用户数据库。

## 产物与来源

- 原绘本依据：`web/assets/picturebook-full/key-events-11.webp` 第一格，第21章“苹果树下的狐狸”。这是本项目已有的AI绘本插画，不是圣埃克苏佩里的原著插画。对比页通过 CSS 显示局部；原文件未修改。
- `web/assets/picturebook-lookdev/fox-design-v1.png`、`prince-design-v1.png`：本轮用内置 image_gen，以既有绘本作身份和画风参照，生成两张三视角设计板。它们属于美术方向参考。源输出路径与完整实际提示词：[generation.json](../../web/assets/picturebook-lookdev/generation.json)。未切换CLI或调用另一个外部图像API。
- `web/assets/picturebook-lookdev/{fox,prince}-{front,three-quarter,side}-{raw,painted}.png`：12张真实 Blender 渲染；两个角色各用同一个场景模型，只更换相机。输出960×1152、Cycles40 samples。raw保留直接渲染，painted使用原生Kuwahara ANISOTROPIC，Size2.3、Uniformity2、Sharpness0.7。轻量滤镜没有修正基础造型的能力。
- 实际模型源：[狐狸 .blend](../../outputs/picturebook-lookdev-20261019/fox-lookdev.blend)、[小王子 .blend](../../outputs/picturebook-lookdev-20261019/prince-lookdev.blend)、[可复现构建／渲染脚本](../../outputs/picturebook-lookdev-20261019/build_samples.py)。这是脚本构建的网格／曲线和程序颜料材质，不冒充手工雕刻、UV手绘纹理或绑定后的生产资产。
- 工具位于隔离目录 `.runtime/picturebook-lookdev-20261019/Blender.app`，未替换系统应用。官方 Blender4.5.3 LTS Apple Silicon DMG SHA-256与官方清单相等：`73ea841053b55404bb3a71a9a22366f1f8821787fe5c899f8b55a7fff929d01b`。下载、校验与源码都保留；可用同一隔离二进制重跑脚本的 `-- fox` / `-- prince` 参数。

## 真实走查与可复现证据

证据目录：`outputs/picturebook-lookdev-20261019/`。

实际浏览器依次操作2角色×3角度×2模式，全部12种组合中两张图片均complete且naturalWidth>0，错误状态为空。原绘本全幅切换、设计板弹窗、按钮关闭、Escape关闭正常；390px窄屏无横向溢出，图片正常加载。控制台warn/error为空。原始记录在 `browser-checks.json`，截图为 `compare-fox.png`、`compare-prince.png`、`mobile.png`。没有新增单元测试，没有运行全量E2E；本轮对独立对比页做完整直接浏览器走查。

最终模型／渲染日志为 `fox-render-final.log` 与 `prince-render-final.log`；同场景相机信息在 `fox-renders.json` 与 `prince-renders.json`。清单、文件SHA-256与工具来源在 `manifest.json`。构建脚本、.blend和渲染PNG全部保留，不仅交付截图。

## 首次失败与实际限制

首轮模型出现狐狸耳根悬空、过粗胸毛形成尖刺，小王子头发／领片拼接感强。原始 .blend、脚本和六张水彩渲染留在 `first-pass/`，没有抹掉失败。随后修正耳根连接、胸毛位置和粗细、头发边界、领片与嘴鼻体积，并重新输出全部视角。

最终仍不满足目标：狐狸耳廓、胸毛和脸部轮廓依然生硬；小王子五官、发束、围巾／衣料体积还不自然；程序色块缺乏定向手绘笔触。生成式三视角只是身份／风格探索，也不能当作严格几何一致的建模尺寸图。现有插画只有有限角度，比较页没有把不同朝向伪装成严格同镜头测量。

本轮实际推进并暴露了模型制作的缺口；尚未完成前轮工作流中的合格雕刻／拓扑、UV手绘、动画绑定、GLB交付、网页材质复现与真机验证。设计图的完成度不代表这些环节已经完成。当前应继续停留在角色美术验证关，不能以技术加载成功扩大到全书。
