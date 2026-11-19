# 绘本风格交互 3D：原作者案例与制作路线研究

日期：2026-10-19。问题：把《小王子》狐狸相遇的一页，从可交互的几何模型样机提升到与已有精细水彩绘本一致的画面。本文研究的是资料与制作路线，不把他人作品的效果视为本项目已实现。本轮先前的程序模型改动及实际回归，另见 [当前原型评估](20261019-picturebook-3d-quality.md)。

结论：应把工作重心移到**角色造型与绘制资产、统一的风格开发、可控的动画表演、最后才是网页渲染集成**。继续堆球体、圆锥或全屏噪声，可以提高样机的丰富度，但不足以证明达到了现有绘本的美术质量。这里的“精细”主要是轮廓、比例、表情、笔触、颜色与构图，而不是更多面数。

## 一手案例：哪些经验经过了什么程度的验证

下列 6 个条目分为已发布网站、教学／个人实验和正式影视生产。影视案例用于美术工作流与时序稳定性参考，不是浏览器运行性能证据。没有把图层视差作品当成完整 3D，也没有声称找到了用户提到的那条 X 帖子。

| 案例与证据层级 | 原作者／官方材料中可核实的事实 | 对本项目的启发（推论） |
|---|---|---|
| **Bruno Simon folio-2019：已发布交互网站，公开源码** | 仓库资源表加载 GLB 模型、独立碰撞模型与地面阴影图片；材质代码使用多色 Matcap 和可调间接色，而非全靠实时标准灯光。依赖包含 Three.js、Cannon、GSAP、Howler。查阅的是当前仓库代码，不能把其现今依赖版本反推成 2019 年首发版本。[仓库](https://github.com/brunosimon/folio-2019)、[资源表](https://github.com/brunosimon/folio-2019/blob/master/src/javascript/Resources.js)、[材质](https://github.com/brunosimon/folio-2019/blob/master/src/javascript/World/Materials.js)、[依赖](https://github.com/brunosimon/folio-2019/blob/master/package.json)。 | 高完成度网站可以依赖离线资产和预制阴影；“网页代码驱动”与“所有形状都必须由 JS 原语生成”是两件事。Matcap 有利于稳定美术外观，但无法单独承担 morning 的动态晨光与影子变化。 |
| **Andrew Woan：Codrops Fan Museum，原作者完整教学 demo** | 作者公开参考收集、Blender blockout、雕刻与建模、UV、烘焙、导出和网页交互过程；会合并静态对象以减少 draw call，按分组制作贴图，并用 R3F 事件与 Zustand 连接场景交互。作者也明确列出自身画面／移动端缺陷。[技术拆解](https://tympanus.net/codrops/2025/04/08/3d-world-in-the-browser-with-blender-and-three-js/)、[代码](https://github.com/andrewwoan/codrops-fan-museum)。 | 借鉴“先确定镜头和构图，再决定值得制作的细节”，而非复制其全部大场景与加载策略。静态环境适合烘焙；狐狸、王子的动态接触关系不能直接烘死在背景里。该项目是教学成果，不据此宣称生产级稳定性。 |
| **Xianyao Wei：Susurrus，已发布个人 WebGL 作品与原作者拆解** | 栈为 React、R3F、Drei、Rapier、Howler、TypeScript；先做 Kuwahara 风格实验再完成 Blender 模型，使用并修改已有 3D 资产；交互包括点击产生面包和声音；作者为成本简化后处理。[原文与作品入口](https://tympanus.net/codrops/2026/04/24/susurrus-crafting-a-cozy-watercolor-world-with-three-js-and-shaders/)。 | 这是最贴近本需求的网页水彩案例：先做能通过视觉对照的风格样片，再投入角色细节。它证明路线可行，不证明任意模型加同一滤镜便会与《小王子》现有插画一致；该文也没有给出可直接继承的手机性能验收数据。 |
| **Fortiche／Arcane：正式系列制作** | Fortiche 官方说明其视觉语言依赖手作纹理与 2D／绘制式 3D；官方列出的 DCC 包括 Maya、Houdini、Nuke、Mari、Guerilla，并有内部工具。官方部门介绍涵盖角色／纹理、动画、合成与 2D FX。[官方 FAQ](https://forticheprod.com/faq/)、[官方风格说明](https://forticheprod.com/fortiche/)、[制作部门](https://forticheprod.com/forticher/)。 | 要学的是资产与表演、绘制与合成协作，不能把“Arcane 风格”简化为一个 shader 名称。我们可用 Blender 和纹理绘制工具完成较小规模的同类职责；没有必要复制整套昂贵片级软件。来源未公开某个可直接移植 Three.js 的完整材质配方，不补写猜测。 |
| **Disney Wish：正式影片，SIGGRAPH 2024 技术公开** | 官方发表《Dynamic Screen Space Textures for Coherent Stylization》，作者 Brent Burley、Brian Green、Daniel Teece；摘要明确把动态屏幕空间纹理与 Wish 水彩外观关联。Hyperion 团队的原作者目录也确认这是影片所用系统的一部分。[官方论文页](https://disneyanimation.com/publications/dynamic-screen-space-textures-for-coherent-stylization/)、[团队资料目录第 48 项](https://blog.yiningkarlli.com/2019/07/hyperion-papers.html)。 | 对转头、走路和镜头拖转而言，“动起来以后笔触是否贴住物体、是否闪烁／游泳”是独立验收项。这里只确认官方摘要与目录，未读到可提取的论文正文；不声称实现其算法，也不把片级屏幕纹理系统称为网页现成组件。 |
| **Sony／Spider-Verse：正式影片，官方作者工具介绍** | Imageworks 说明第一部结合半调、排线与手绘元素；Sony 官方将 Across 的表面笔触工具 Patchy Bomby、Gwen 水彩世界使用的 Rebelle、Vulture 手绘控制工具 Kismet 分开介绍。[Imageworks 制作说明](https://www.imageworks.com/our-craft/feature-animation/movies/spider-man-spider-verse)、[Sony 官方工具拆解](https://www.sony.com/en/brand/beyondthescreen/acrossthespiderverse/)。 | 不同对象与情绪需要可定向的美术控制；若只对整屏加一种“水彩滤镜”，狐狸眼睛、头发轮廓和天空可能一起失真。可将角色／背景／特效分层控制笔触强度。这里不把 Gwen 的所有镜头称作完整 3D，也不承诺其内部工具可用。 |

## 可直接参考的网页着色与交付技术

**作者实现参考，不等同美术资产替代品。** Maxime Heckel 的《On Crafting Painterly Shaders》公开了 R3F／GLSL 后处理推导，从 Kuwahara 到结构张量引导的各向异性版本，再到颜色调整和纸纹；他同时展示过大 kernel 会损失细节与变形。适合拿来做同一张狐狸参考帧的 A/B 风格实验；强度不能以“看起来有滤镜”作为成功条件。[原作者文章与交互示例](https://blog.maximeheckel.com/posts/on-crafting-painterly-shaders/)。

**模型／动画传输。** Three.js 的 GLTFLoader 可加载 glTF 场景与动画，并对接 Meshopt、Draco、KTX2 解码；AnimationMixer 提供 clip 播放管理。KTX2Loader 会根据 GPU 能力转码纹理。[GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)、[AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html)、[KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html)。因此本项目可继续使用现有 Three.js，无需为了画质强行改为 React。R3F 是场景生命周期与交互的组织方式，不自动生成更好的造型或纹理。

**优化要按瓶颈区分。** glTF Transform 官方支持 inspect、去重、合并、实例化与压缩；其 Meshopt 文档明确指出压缩不直接提高渲染帧率，应另行降低顶点或 draw call。[CLI](https://gltf-transform.dev/cli)、[Meshopt 边界](https://gltf-transform.dev/modules/extensions/classes/EXTMeshoptCompression)。R3F 官方性能指南支持实例化、LOD、渐进加载与按需渲染，可将这些原则用于原生 Three.js。[官方指南](https://r3f.docs.pmnd.rs/advanced/scaling-performance)。不能把包体减小当作帧时间已改善，也不能把文档给出的普遍建议当作本页预算。

## 纯代码的边界与画风一致性

以下是基于上述来源和本仓库目标的工程判断，而非来源原话：

- 代码很适合光照变化、风吹草木／围巾、粒子、镜头、事件映射、动作混合和资源调度；也能做程序化笔触与精细曲面。不存在“代码绝对做不出精美 3D”的物理限制。
- 但自动组合基本几何体不会自行决定狐狸嘴鼻比例、衣服褶皱、眼神或一笔合适的水彩边缘。要追齐现有绘本，仍须在几何、纹理或绘制笔触数据中表达这些美术选择。增加细分或对整屏加噪声不能填补缺失的设计信息。
- 水彩的透明叠色、边缘积色、干湿笔触和纸面留白，不等于统一粗糙度或颜色随机化。风格必须以实际参考图和暂停帧对照确认。
- 将现有画面切成卡片并做视差、用照片投影到受限相机的几何体，是可取的 **2.5D／投影** 备选。它能更快保持原画细节，却无法自动支持大角度绕看、真实肢体运动与遮挡；若采用，应在产品和验收中如实命名。

## 建议的单页制作工作流（尚未实施）

1. **冻结美术参照。** 从已交付狐狸页选一幅最终水彩原图作为目标；记录小王子和狐狸的正面、侧面、三分之四角度、体型比例、配色、笔触尺度、太阳与背景色。若参照中缺少侧面，先补设计，再建模，避免每次迭代换一套角色。
2. **用最终镜头做风格样片。** 保留同一狐狸相遇构图，限制可拖转范围。先做一个狐狸头部、一段衣服、一簇树叶的材质小样，比较“不加后处理／轻 Kuwahara／局部笔触”三种实际帧。画风和五官不通过时继续改资产，不先铺全书。
3. **角色资产。** Blender 手工建模或雕刻后整理成适于动画的拓扑、UV；绘制脸部、皮毛／衣服颜色、笔触与局部阴影。保留 .blend 与高质量未压缩源纹理。生成式模型如被采用，只作为待清理的起点，不能未经转面检查就视为合格角色。
4. **可控表演。** 狐狸做身体、头、耳、尾与腿的绑定／动作片段；王子做转身、挥手、眼神与围巾动作。为 appeared 制作真正的探头与走出，为 nothing 制作遮挡藏身，而非整体缩放。动作列表、起止姿态、过渡时间与中断规则需一并导出／记录。
5. **静态和动态分开。** 树、地面、背景可手绘并烘焙柔和基底；角色的接触阴影和 morning 的照明保留实时控制，或明确制作两个可混合的光照状态。避免贴图中永久画着“狐狸站在旧位置的影子”。背景可以是精细 2D 绘制与真正 3D 角色混合，但别称所有背景都为 3D。
6. **网页集成。** 沿用现有词语与原文锚点控制器，场景接口继续处理 action／pause／reset／dispose；由 GLTFLoader 加载命名角色节点，AnimationMixer 管理 clip，射线点击只选中合法的语境出现。全屏纸纹／颜色调整不影响 HTML 英文原文的锐度。
7. **优化交付。** 先 inspect 看纹理、几何与 draw call；以实际视觉损失比较 KTX2／WebP，合并不需要独立动画的对象，对麦穗／叶片实例化。保留原资产后才做最终压缩。只在本页进入时加载，离开释放，加载中显示已有水彩画面，避免白屏。
8. **再决定是否扩展。** 本页在用户视觉对照、真实交互与真机性能三关通过后，才把同一角色／风格库扩到下一幕。不要以“6 个词能触发动画”作为全书制作可规模化的证据。

## 验收提案：先记录风险，再实现与走查

这些是建议门槛，不是已经跑出的结果；具体性能预算应在目标设备与网络上校准。

| 验收面 | 复现方法与可审查产物 | 失败条件 |
|---|---|---|
| 造型与绘本一致 | 同一尺寸的原画／新帧并排；前、侧、三分之四各一张；狐狸头和王子脸放大裁图；由用户确认 | 只是“有纸纹”，仍为拼接玩具形状；角色比例、衣服／围巾颜色或表情漂移 |
| 动态绘制稳定 | 固定相机与慢速拖转录屏，分别录 fox、turned、appeared 的全程 | 纹理游泳、边缘闪烁、眼睛糊掉、过强滤镜抹去脸部；暂停与动态风格显著不同 |
| 语义与交互 | 实际鼠标悬浮、手机点词、键盘、场景点回词；快速来回触发并录屏 | 动作表现错词义、旧动作覆盖新动作、遮挡不成立、动效阻碍阅读或原文变化 |
| 冷启动／性能 | 记录机型、实际视口、网络条件、资产字节、首个可见场景时间、稳定阶段 P50／P95 帧间隔、draw call／三角形和内存趋势 | 只报平均 FPS；桌面窄屏冒充真机；为水彩滤镜持续掉帧／发热；压缩后脸和笔触出现明显损伤 |
| 生命周期／回退 | 重复进出页／章节；暂停、离屏、切标签、减少动态效果、加载失败／上下文丢失；截图与日志 | 循环未停止、资源持续增长、错误后白屏、回退丢原文／位置 |

本仓库已有的原文语义、稳定阅读位置与 WebView 复用决策不因 3D 重做；浏览器通过也不能替代原生客户端与真实手机验收。相关约束见 [领域术语](../../GLOSSARY.md)、[桌面复用阅读核心 ADR](../adr/0007-desktop-prototype-reuses-reading-core.md)。

## 证据与未确定事项

研究核实的是公开网页、公开源码和官方资料摘要，不是这些网站的完整运行走查、作者工程复建或手机性能测试。另外在实际浏览器打开 Susurrus，经入口滚动看到了其完整水彩主场景；截图位于 `outputs/picturebook-3d-quality-20261019/reference-susurrus-browser.png`。这次观察只确认主场景外观，不据此声称互动全通过或达到某帧率。Disney 论文官方入口与预印本索引可核实，但本轮未获得可读取的全文，不扩展其算法细节；Blender 当前 manual 页面抓取失败，没有据此声称特定版本的所有节点／约束能随 GLB 导出。实现前应在所用 Blender 版本用一份小资产实测导出，再确认支持范围。

## 对当前代码的具体差距与本页下一步

实际核对 `web/picturebook-painted-world.js` 和 `web/picturebook-fox-scene.js` 后，当前角色依然是程序几何，材质是 MeshStandardMaterial 叠加世界空间噪声，没有定稿 UV 手绘纹理、骨骼蒙皮、导出动作片段或 Kuwahara 后处理。噪声调制主要提供颜色变化，不能表达特定位置的毛流、衣褶或手绘轮廓；世界空间噪声也有运动角色穿过纹理场的风险，尚未完成笔触时序验收。动画是分组旋转和位置插值，尚非有脚部接地和表演设计的角色动作。

建议沿用此页与原文控制器，将下一轮交付限定为以下三个可审查产物：

1. **角色与材质样片**：以本章现有插画和 `reference-watercolor.png` 为依据，先提供狐狸头部／王子脸部与衣料的前、侧、三分之四角度；同镜头制作无后处理与轻水彩两种帧，核对轮廓、色块与五官，不以新增面数作为合格条件。
2. **可复用资产包**：保留 `.blend`、未压缩纹理、UV、绑定与命名动作片段，导出 `prince.glb`、`fox.glb` 和静态环境；附参考来源／版本。网页端用 GLTFLoader + AnimationMixer，背景烘焙与动态晨光分开，HTML 原文不进后处理。
3. **同页集成与验收记录**：沿用六个词和既有 pause/reset/dispose 接口，对照暂停帧、完整动作与慢速拖转录屏；先确认画风、角色和语义，再记录真机帧时间、冷启动与资源增长。完成这一页后再决定扩展。

上述内容是基于研究作出的本项目建议，尚未制作这些合格资产或声称完成效果。R3F、GSAP、Rapier 等只在实际需要相应组织方式／时间线／物理时引入；本页无需为复制他人的技术栈先迁移框架。

真正未完成的是本项目的合格角色资产、定稿手绘纹理、绑定与表演、目标水彩 shader 的实际对照和真机预算。这些应列作制作工作，不能通过更换 Three.js／R3F 名称或套用“成功案例”措辞抵消。
