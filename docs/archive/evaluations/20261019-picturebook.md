# 少儿绘本版 · 2026-10-19

此页保留首版走查记录；后续「逐句情节插画」实现与当前证据见 [情节插画验收](20261019-picturebook-story-art.md)。

开发版已接入现有书架与阅读入口。普通版 / 少儿版在当前浏览器保存；两版共用同一篇章原文。绘本进度独立保存在本机，不覆盖普通版的原文锚点、笔记或收藏。

## 体验

本次已启动独立预览：[打开《小王子》](http://127.0.0.1:18805/#/picturebook/1)。该深链接直接启用少儿版。预览数据位于 `.runtime/picturebook-preview-20261019/`，不使用个人数据库，也没有替换已安装的 macOS 客户端。

1. 从书架右上角切换「少儿版」，点击「打开《小王子》绘本」。首次点击才把示例加入当前书架。
2. 在英文句子上停留约 160 ms，或点击句子：英文高亮、插画镜头、词袋和已开启的中文提示一起变化。
3. 用左右方向键逐句前进 / 后退，跨幕自动翻页；也可使用底部箭头或六幕缩略图。
4. 第六幕点击重读；刷新保留当前幕与句。普通版与少儿版分别记住进度。
5. 现有英文材料沿用相同阅读入口，自动分句，每三句一幕；EPUB 可在顶部章节菜单切换章节。

## 实现边界

- 《小王子》为根据主题原创的六幕、十八句英文短篇改写，并非原著全文或出版译本。中文提示和词袋为该示例编写。
- 六格水彩插画由内置 image_gen 生成，作为本地 WebP 资源交付。最终提示词与资源说明在 `web/assets/picturebook/README.md`。
- 通用材料保留原文，按关键词选择现有主题氛围插画。页面明确显示「氛围配图」；未接入任意故事的语义插画生成、自动翻译或自动词袋生成，不会自动调用付费模型。
- 每幕同一插画随句子推进平移、放大；跨幕更换场景，不是逐句生成动画视频。
- 朗读接入浏览器 Web Speech，优先选择本地英文音色；本轮没有完成真实扬声器听感验收。
- 当前为源码 Web 体验；没有重新打包或替换已安装客户端。未宣称全产品、扫描 PDF、实体设备或生产验收通过。

## 实际验证

证据目录：`outputs/picturebook-20261019/`。原始逐句结果与悬浮观测时间在 `walkthrough.json`；六幕完整截图在 `scene-1.png` 至 `scene-6.png`，另有普通版、通用故事、390 px 手机宽度、EPUB 跨章与最终预览截图。

| 场景 | 结果 |
| --- | --- |
| 少儿书架 → 示例创建 → 实际阅读 | 通过，本地 FastAPI / SQLite |
| 六幕十八句逐一点击、中文提示与词袋对应 | 通过，逐句结果保留于 JSON |
| 真实鼠标移动到第二句触发悬浮推进 | 通过，记录端到端自动化观测时间；不作为渲染帧率结论 |
| 左右键跨幕前进 / 后退、首幕边界、结尾重读 | 通过 |
| 刷新恢复当前幕与句、版本双向切换 | 通过 |
| 从添加阅读入口粘贴新故事，自动成为三幕 | 通过，八句与输入逐字核对，无漏句 |
| 390 px 宽排版 | 通过，document scrollWidth = clientWidth = 390；浏览器尺寸模拟，非手机实机 |
| 真实 EPUB 解析后跨章节阅读 | 通过，现有 `web/sample.epub` 经导入 API 上传，再从浏览器章节菜单切换 |
| EPUB 系统文件选择器 | IAB 文件选择事件超时，未计为通过；没有将 API 上传替代证据混写为文件选择器通过 |
| 既有粘贴导入与偏好保存 E2E | 2 passed，0 failed；trace / screenshots 位于 `existing-checks/` |

首次产品失败：示例元数据的 `lines` 覆盖了分句对象，首屏出现空白英文按钮。截图 `first-failure-empty-sentences.png` 已保留；调整对象组合顺序后重新走查六幕十八句，通过。首次 IAB 文件选择器超时另记在 JSON；不删除或覆盖首次证据。

## 复现

先在仓库根目录启动独立预览（以下命令不要与当前已运行的 18805 预览重复启动）：

```sh
mkdir -p .runtime/picturebook-preview-20261019
WR_USER_DB="$PWD/.runtime/picturebook-preview-20261019/user.db" \
WR_PDF_DATA_DIR="$PWD/.runtime/picturebook-preview-20261019/user-pdf" \
WR_LLM_ENABLED=false WR_NATIVE_TRACKPAD=0 \
.venv/bin/python -m uvicorn wise_reader.app:create_app --factory --host 127.0.0.1 --port 18805
```

打开首页并按上述 1–5 操作。已有定向回归复现命令：

```sh
WR_E2E_PORT=18777 WR_E2E_PROVIDER_PORT=18778 \
WR_E2E_EVIDENCE=outputs/picturebook-20261019/existing-checks \
npx playwright test tests/browser/reader.spec.js \
  --grep 'paste import persists|profile autosave' --workers=1
```

开发过程中未运行完整 E2E 套件，未新增事后单元测试。本次最终验收为以上功能的实际浏览器全流程与既有定向回归。
