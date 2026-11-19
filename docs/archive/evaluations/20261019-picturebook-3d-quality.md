# 单页 3D 精细化原型与路线调整 · 2026-10-19

当前状态：程序模型比首版更丰富，原文互动回归正常；**美术质量尚未达到既有绘本标准**。用户提出先调研成熟经验后，停止继续堆程序几何，转向 [一手制作路线研究](20261019-storybook-3d-production-research.md)。

本轮改动仅位于单页实验：新增 `web/picturebook-painted-world.js` 管理场景美术，`web/picturebook-fox-scene.js` 保留交互与生命周期，调整 `web/picturebook-3d.css`。造型增加长外套、领片／腰带／袖口／发束，狐狸渐细口鼻、耳廓、毛发轮廓和尾巴；环境从底座换成连续麦田、独立叶片苹果树、远山。材质为程序噪声色块与颗粒，并非手绘贴图或已经完成的水彩 NPR 管线。

## 本轮真实验证

隔离预览：http://127.0.0.1:18805/#/read/22 ，点“动态 3D · 试读一页”。仍使用 `.runtime/picturebook-preview-20261019/user.db`，个人数据库未更改。

证据目录 `outputs/picturebook-3d-quality-20261019/`，保留 `before.png`、`first-render.png`、`after.png`、`reference-watercolor.png`、`reference-susurrus-browser.png`、`mobile-final.png`、`browser-checks.json`、`browser-logs.json`。最终源版本 `df3178f000fef9fc`，样式诊断 `painted-storybook-v2`。

- 六个原文词语实际悬浮触发姿态：fox/appeared 可见并到达 (0.85,0.55)，morning 的太阳高度4.95，prince 挥手，turned/nothing 的狐狸实际不可见。三句原文保留。
- 画布狐狸点击反选 fox，王子点击反选 prince；回车触发、横拖 yaw=-0.480、复位 yaw=0.060 正常。
- 暂停连续观察帧数36→36；翻到下一阅读页后 canvas 数为0。
- 最终窄屏实际 CSS 视口390、scrollWidth390，点 prince 后场景 sticky y=0，动画响应。此为浏览器窄屏，未冒充物理手机。
- 浏览器本轮 warn/error 日志为空。实际帧间隔样本约16.6–16.9ms；约155万三角形、390–400 draw call。仅本机样本，不能推断真机发热、长期性能或冷启动。
- 既有定向浏览器 E2E：3 passed / 0 failed，8635ms。命令与第一版相同，将 `WR_E2E_EVIDENCE` 改为本目录 `/regressions`。涵盖导入、阅读位置与资源版本，trace/截图保留。没有新增单元测试或运行全量套件。

## 首轮问题保留

首轮曲面索引绕序相反，尾巴局部出现内壳明暗；修正三角形绕序后重新检查实际画布。首轮麦穗颗粒复用32×24球体，约1762万三角形、帧间隔样本17.6ms；改用8×6细节球和低边数麦芒，最终约155万三角形。没有以该单样本声称完整性能通过。

首次窄屏测试实际宽1171，视口设置作用于另一个参考标签；该记录和截图原样保留为无效窄屏证据。关闭临时参考标签后重走，`mobile-final` 是390px的有效记录。

## 还缺什么

缺少定稿角色资产、UV手绘笔触、可控骨骼表演和真正画风后处理；当前标准光照加噪声仍有塑料／程序形状感。人物脸部、头发、狐狸轮廓与原插画不同。拖转／动作时的笔触稳定、真机性能和异常回退仍需后续验证。技术交互通过与用户美术认可分开记录，当前不能称“与绘本一样精细”。未提交、推送或更新安装客户端。
