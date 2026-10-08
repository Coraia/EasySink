# PDF 候选组件：上游事实核对

核对日期：2026-10-08。仅核对官方文档、仓库与许可；未安装组件、下载模型、转换 PDF 或调用付费接口。滚动文档的能力说明不等于固定发行版本的本机验收，选型时仍须冻结实际组件、模型与依赖版本。

## 原版显示与来源定位

PDF.js 提供页面渲染、文字内容及文字层；文字项含变换与尺寸信息，可作为原页定位的基础。扫描件仍需要额外 OCR，文字项也不保证按词拆分，区域映射与高亮需要应用实现并验证。来源：[官方 API](https://mozilla.github.io/pdf.js/api/draft/api.js.html)、[官方文字层源码](https://github.com/mozilla/pdf.js/blob/master/src/display/text_layer.js)。

Docling 的来源信息包含页号、区域框和字符范围，文档也区分坐标原点。元素级来源信息不等于可靠的逐词框，跨组件仍需验证缩放、旋转与坐标转换。来源：[官方数据模型](https://docling-project.github.io/docling/reference/docling_document/)。

## 结构内容与 Mac 平台

| 候选 | 官方声明能支持的部分 | 仍需核对的边界 |
|---|---|---|
| Docling | 图片/表格导出、公式增强；显式 CPU/MPS 加速选项 | 公式需相应增强配置与模型；OCR 后端的加速路径不一定与主流水线一致 |
| MinerU | 官方仓库列出 Apple Silicon Mac、本机后端及 MPS 路径 | 不同解析档位与后端的兼容、占用、质量不能由硬件表推断 |
| PaddleOCR/PaddlePaddle | 官方 macOS 路径支持 Mac M/arm64；当前 Paddle 原生安装说明仅支持 CPU | 其他推理后端或 VLM 路径不能直接视作完整 Mac/MPS PDF 流水线已可用 |

来源：[Docling 图像导出](https://docling-project.github.io/docling/_generated/examples/export_figures/)、[表格导出](https://docling-project.github.io/docling/_generated/examples/export_tables/)、[公式增强](https://docling-project.github.io/docling/_generated/examples/code_formula_granite_docling/)、[加速选项](https://docling-project.github.io/docling/_generated/examples/run_with_accelerator/)、[MinerU 官方仓库](https://github.com/opendatalab/MinerU)、[Paddle 官方 macOS 安装说明](https://www.paddlepaddle.org.cn/documentation/docs/en/install/pip/macos-pip_en.html)。

## 许可核对边界

- Docling 仓库标明代码 MIT，模型遵守各自原包许可。来源：[官方仓库](https://github.com/docling-project/docling)。
- MinerU 代码当前为 Apache-2.0 加附加条件，包括商业门槛和向第三方提供在线服务的署名要求，不能简写为无附加条件的 Apache。抽查的官方 MinerU2.5 权重卡标明 AGPL-3.0，不能把代码许可直接套用于所有权重。来源：[代码许可](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)、[具体权重模型卡](https://huggingface.co/opendatalab/MinerU2.5-2509-1.2B)。
- PaddleOCR 仓库标明 Apache-2.0，抽查的官方 PaddleOCR-VL-1.6 权重卡也标明 Apache-2.0；这不是全部历史模型及第三方依赖的许可审核。来源：[官方仓库](https://github.com/PaddlePaddle/PaddleOCR)、[具体权重模型卡](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)。

尚未据此决定具体引擎或判断任何发布场景的许可合规；最终需对实际依赖清单逐项核对。

## 对本项目的直接限制

1. 尚无本机 M4 的识别质量、转换耗时、峰值内存或阅读干扰测量。
2. 页范围、分块加载或批处理接口不等于已满足“先阅读、后逐步补齐结构”的产品流程。
3. 来源框与文字层不等于可靠逐词定位，也不证明公式、表格、脚注和阅读顺序正确。
4. 任何主引擎选择仍需相同样本、相同本机条件的比较；不把上游榜单当作用户材料验收。

本机只读硬件信息为 24 GiB 内存、10 个逻辑 CPU；已验收阅读证据记录 Apple M4 Metal。这些不是 OCR 可独占的资源预算，也不是新 PDF 流程的性能结果。
