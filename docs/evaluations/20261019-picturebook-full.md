# 《小王子》全书绘本 · 2026-10-19

已交付本机网页预览： [全书第一章](http://127.0.0.1:18805/#/picturebook/2) · [狐狸一章](http://127.0.0.1:18805/#/picturebook/22)。用户预览页停在狐狸一章。原六幕、十八句改写示例仍是篇章 1。

## 正文与配图

采用 Antoine de Saint-Exupéry 原著、Iraklis Lampadariou 英译、Saita Publications 2015 年版，ISBN 978-618-5147-45-7。来源页与版权页明确标示 CC BY-NC 3.0 Unported；保留译者、出版者、许可链接、来源、改动说明及献词。版本来源：https://www.openrightslibrary.com/the-little-prince-ebook/ 。文本实际取自同版公开镜像 https://online.flipbuilder.com/npkog/rsmg/ 的 HTML 文本层；旧 PDF 链接返回 404，因此不声称成功取得或核对过该 PDF 原页。

完整故事 27 章、16,485 个空白分隔英文词、1,582 句，按三句一页形成 536 个阅读页。归档 85 个公开 HTML 页面；故事对应 HTML 页 5–81。提取仅去除页码/章号、合并排版空白与分离的首字母，保留源版用词、标点和拼写。处理后的所有非空白源字符与书中正文相同，每章另外保存 SHA-256。献词在版本详情中保留。

60 个关键情节节点对应 60 幅不同画面，采用 15 个有效 2×2 图集。画面由内置 image_gen 实际生成，不是占位图，也不以放大/平移代替内容变化。饮酒人与飞行员混同、水井背后多出村庄两处已通过两次图像编辑修正，旧成图与修订提示词均保留。所有有效节点原始像素散列互不相同。

同一情节内的多句原文共用一幅画，进入新节点时换图；界面明确区分“关键情节”与“原文句子”进度。本章缩略图可跳回对应句子，支持前后跨章、选章、键盘逐句、刷新续读及切换普通版。图集裁切保持画面比例，长句不会拉伸人物。

## 最终验收

真实浏览器在隔离库 18835 从书架按钮导入全书后走查；交付库 18805 再次通过书架按钮安装并检查首章、末章和狐狸章。没有覆盖个人 `data/user.db` 或已安装客户端。

- 27 章 / 536 个阅读页逐页核对，实际显示的 1,582 句与源文逐句完全一致。
- 全部 60 个节点通过实际鼠标悬浮、原文锚点、画面标识及图集格子验证，保存每个节点的完整页面截图。19 个同页情节边界另外验证由悬浮直接切换画面；跨阅读页的节点通过导航后悬浮验证，未将它们计为同页切图。
- 全书结束返回第一章；章末进入下一章；左右键跨章分别到上一章末句/下一章首句；刷新及切换普通版后恢复绘本原句。
- 20 次快速鼠标移动后，最终句子与画面匹配；390px 页面没有横向溢出，27 章选项可用；最终浏览器错误日志为空。
- 重复安装返回同一本书，没有重复章节。独立导入的同正文篇章在不属于书籍时也能安全重读。插画未齐时入口拒绝安装，不写入半本书。
- 隔离验收库和交付预览库的运行时图像 API 尝试记录均为 0；此样书读取已完成的本地图像，无需配置外部密钥。
- 既有相关 Playwright E2E：粘贴导入持久化、偏好自动保存、密钥脱敏、无效配置拒绝、移动端配置，共 5 passed / 0 failed。未运行全量无关套件，未新增单元测试。

初始失败及恢复见 `outputs/picturebook-full-20261019/first-failures.md` 和 `first-frame-walk-action-failure.json`。保留了旧脚本缓存下的初步记录；强制刷新后重新走查全部 536 页。自动点击页脚未滚入视口时保留截图，再用真实滚轮事件定位控件继续验收；没有为了绕过自动化问题修改产品行为。

## 证据与复现

全部材料在 `outputs/picturebook-full-20261019/`：

- `source/` 原始 HTML、提取文本与页面散列；`extract_source.py`、`plan_illustrations.py` 为可复现的源文处理及情节计划；`extraction-check.json`、`source-and-anchor-check.json` 核对源文和覆盖范围。
- `reading-pages-walkthrough.json` 保留全部实际显示句子；`full-text-walk-summary.json` 汇总；`key-events-walkthrough.json`、`key-events-summary.json` 保留实际悬浮结果；`event-ch*.png` 共 60 张节点截图。
- `interaction-checks.json`、`browser-errors.json`、`mobile-full-book.png`、`attribution-and-dedication.png`；`installed-book-check.json` 和 `delivered-preview-check.json` 核对已安装的章节、正文与请求记录。
- `browser-walkthrough-functions.js` 保存实际使用的 CUA 走查函数；重走时在 CUA 中绑定隔离浏览器、从 `book.json` 生成 Intl.Segmenter 预期句子、读取实际章节下拉项，按 0–26 依次执行正文及情节走查函数。`verify_installed.py` 是隔离服务 18835 的源文/API 审计脚本。
- `regressions/` 保留 5 项相关 E2E 的截图/trace；对应命令见下。
- `preview-full-book.png` 是交付页完整截图；`manifest-sha256.json` 为最终材料散列。

```sh
WR_E2E_PORT=18825 WR_E2E_PROVIDER_PORT=18826 \
WR_E2E_EVIDENCE=outputs/picturebook-full-20261019/regressions \
npx playwright test tests/browser/reader.spec.js tests/browser/feedback.spec.js \
--grep 'paste import persists|profile autosave|AI config masks|configuration rejects invalid secrets safely|mobile AI configuration' --workers=1
```

直接复现体验：打开全书第一章 → 悬浮三句 → 点击章内情节缩略图 → 在同页情节边界悬浮前后两句比较画面 → 用顶部下拉选第 21、24、26、27 章 → 章末右箭头继续 → 刷新或切普通版再返回，核对续读位置。书架“阅读《小王子》全书”可重复点击，不会再导入一份。

## 实现与边界

`src/wise_reader/picturebook_edition.py` 提供原文散列匹配、情节计划及原子安装；接入 `picturebook.py` 的状态接口。`web/picturebook.js` 与 `picturebook-art.js` 负责完整句子阅读、情节区间、目录、跨章和图片迟到保护。版本资源、署名、完整提示词与生成记录在 `web/assets/picturebook-full/`。

本次完成的是这一英文版本的全书制作，情节计划已为《小王子》编排并实际成图。其他书籍的通用运行时图像 API 仍沿用上一轮实现；其真实外部供应商的质量、计费和全书批量编排不在本次实测结论内。没有提交、推送或重打包已安装的原生客户端。
