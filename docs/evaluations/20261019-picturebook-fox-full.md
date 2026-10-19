# 狐狸这一章：完整英文动态绘本

入口：<http://127.0.0.1:18805/#/fox-story/22>。沿用上一轮认可的角色与 2.5D 绘画风格，将九句改写替换为书库《小王子》第 21 章完整英文。原阅读页和角色对比页都提供入口。

## 内容与交互

正文在打开时读取 `/api/documents/{id}?compact=true`，不内嵌或改写译本。按 `Intl.Segmenter` 得到 145 个句子片段，保留块 ID、字符起止位置，排成 53 页。引号内问句、感叹词可能独立成片段，与现有绘本阅读采用相同分句口径。所有标点及当前书库措辞保留，包括源文本本身的用词。

十个情节段落通过原文锚点定位：初次相遇、建立联系、想起玫瑰、金色麦田、耐心靠近、等待的仪式、告别时刻、重看玫瑰、狐狸的秘密、记住责任。句子悬浮、点击、键盘左右键、情节按钮或进度条改变当前句与场景。前后阅读可跨页；长句不截断，桌面正文区域可滚动，窄屏正文自然流动、插画固定在上方。

重点单词提供释义并触发动作：问候和人物词对应头部、耳朵、尾巴动作，ties/tame 对应亲近，sit/distance/closer 对应坐姿及距离，wind/wheat/gold 对应围巾、头发、麦田，jumping/happy 对应轻跃，cry 对应低头，rose 对应玫瑰和小王子的回应，heart/responsible 对应柔和回应与光点，time/patient 放慢动作。单词效果持续约 3.2 秒，然后回到当前原句的场景状态。

自动阅读从当前句继续，按句长分配停留时间，到章末停止；手动选择会打断。当前动态绘本位置单独保存在本机 `fox-story-position:{docId}`，使用正文版本和原文锚点续读，不覆盖原阅读器位置。中文按钮明确标为“情节提示”，没有将场景说明冒充逐句译文。

## 素材与实现

- `web/picturebook-fox-chapter.js`：来源验证、分句、分页、情节锚点和词汇动作。
- `web/picturebook-fox-reading.js` / `.css`：阅读交互、续读、响应式布局。
- `web/picturebook-fox-reading-scene.js`、`web/picturebook-painted-actors.js`：绘画网格、背景转换、站姿/坐姿、局部动作。
- 新素材：[rose-garden.png](../../web/assets/picturebook-fox-reading/rose-garden.png)、[rose.png](../../web/assets/picturebook-fox-reading/rose.png)。使用内置 image_gen，参考现有 meadow / prince，原图直接复制入项目。完整实际提示词及来源：[chapter-generation.json](../../web/assets/picturebook-fox-reading/chapter-generation.json)。

这是固定镜头的 2.5D 动态绘本，站坐姿和背景采用交叉淡入淡出。没有新增完整三维骨骼或自由旋转；绘画表情主要来自原素材。全章每句可阅读并映射到情节，但相邻对话会共享同一画面构图，不是每句生成一张新插画。

## 实际浏览器验证

证据目录：[outputs/picturebook-fox-full-20261019](../../outputs/picturebook-fox-full-20261019/)。真实 IAB、实际 WebGL；移动端为实测 390 CSS px 视口，没有物理手机或原生桌面客户端性能结论。

完整正向走查从第一句连续点击“下一句”至第 145 句，采集每句显示文字、原文块 ID、起止位置、场景、页码、画布数量和横向溢出状态。`forward-source-145.json` 与读取的 `source-document.json` 对照，145/145 句逐字符匹配、锚点匹配，53 页全部经过，原文和显示文字 SHA-256 均为 `11715ab9e4bce94b89de2d669550cf9f94e9c8bd59aab0b887f068bd0388ab09`，详见 `source-verification.json`。

另外直接操作验证：悬浮回到前句、closer 缩短距离、键盘 Enter 触发 jumping/wind/cry/heart/watered、进度条跳转、不同情节切换、自动阅读到最后一句后停止、手动打断自动阅读、暂停及暂停时翻页、长句滚动到末尾、窄屏跨页/点词/提示、返回原文清理画布、重新进入恢复第 132 句、错误章节拒绝错配。

暂停两次独立采样 frames 均为 5474、time 均为 91.294；jumping 场景两次采样 hop 为 0.000 和 0.120，表明动作实际运行。数值是渲染行为证据，不是视觉质量评分或帧率基准。

原始交互状态与控制台结果在 `browser-checks.json`；截图包括章末、坐下/靠近、等待、长句末尾、390px 阅读与最终花园。第一次观察、早于悬浮防抖的采样和缩放导致的视口差异保留在 `first-observations.md`。前一版实现保留在 `before/`。

语法、格式与 `git diff --check` 通过。未新增单元测试，未运行无关全量 E2E。WebGL 失败回退保留但未进行强制故障注入；没有实体设备性能或音频验证。本轮没有提交、推送或更改数据库正文。
