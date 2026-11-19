# URL 导入来源白名单研究

日期：2026-10-17
范围：Wise Reader 本机、单用户、由读者主动粘贴单个公开 URL 的导入功能。本文只提出来源边界，不修改当前实现，也不把白名单等同于整版本验收。

## 结论

本轮核对的主流公共项目中，**没有一个可直接复用为“可信、适合正文阅读的网站白名单”**。Tranco 和 Cloudflare Radar 衡量流行度，Public Suffix List 描述域名注册边界，Disconnect、EasyList/EasyPrivacy 描述跟踪器、广告或页面干扰物；它们都不审核一个站点是否适合正文提取、内容是否可靠、文章是否无需登录、图片是否可保存。

Wise Reader 不应接入一个庞大的第三方名单。首版更适合维护约 10–20 条版本化的“来源配方”：**精确主机 + 正文路径 + 重定向规则 + 必要资源主机**。只有完成过一次真实文章导入、图片保存和重启离线阅读的配方才默认开启。用户需要的其他站点放进个人精确白名单，不自动扩大为同集团、同顶级域或同托管平台的所有内容。

白名单表达的是“允许 Wise Reader 获取这个公开来源”，不是对文章真实性、同行评审状态、版权或观点的背书。尤其是 arXiv、OpenReview、PMC 等同时包含预印本、作者稿或不同许可的内容；[PMC 官方也明确说明免费阅读不等于没有版权保护](https://pmc.ncbi.nlm.nih.gov/about/copyright/)。

## 为什么现成名单不能直接用

| 项目 | 官方维护目标 | 对 Wise Reader 的正确用途 | 不能作为内容白名单的原因 |
|---|---|---|---|
| [Tranco](https://tranco-list.eu/) | 将多个来源过去一段时间的结果聚合为研究用热门域名排名；[官方方法](https://tranco-list.eu/methodology)关注排名稳定性和可复现性 | 最多用于发现候选站点，随后人工审查 | 热门不等于可信、可读或安全；排名还会含 CDN、API、广告等基础设施域名 |
| [Cloudflare Radar Domain Rankings](https://developers.cloudflare.com/radar/investigate/domain-ranking-datasets/) | 依据 1.1.1.1 DNS 查询生成热门域名及分桶数据 | 最多用于发现候选站点 | 官方示例本身就有 `googleapis.com`、`gstatic.com` 等非正文来源；DNS 流行度不审核内容质量或页面结构 |
| [Public Suffix List](https://publicsuffix.org/) | 描述 `com`、`co.uk`、私有托管后缀等注册边界，主要服务 cookie、UI 和站点边界判断 | 可用于正确识别 registrable domain，并识别多租户边界 | 它不提供声誉。其 [ICANN/PRIVATE 分区](https://github.com/publicsuffix/list/wiki/format)恰好说明 `appspot.com` 一类私有后缀下可以有互不信任的租户，不能据此整域放行 |
| [Disconnect Tracking Protection](https://github.com/disconnectme/disconnect-tracking-protection) | 分类跟踪服务，供隐私保护和拦截使用 | 若未来确有需要，只能作为负向资源信号 | “没有列入 tracker”不表示正文可信或可提取；其列表为 CC BY-NC-SA 4.0，[仓库要求商业使用另行联系授权](https://github.com/disconnectme/disconnect-tracking-protection#readme) |
| [EasyList / EasyPrivacy](https://github.com/easylist/easylist) | [EasyList 移除广告，EasyPrivacy 移除跟踪](https://easylist.to/)；包含 URL、资源和页面元素级规则 | 首版不接入；以后若需要拦第三方资源再单独评估 | 它是 blocklist/filter list，不是站点目录；未命中不等于正文可读、可信或安全，还会带来持续更新和规则解释成本 |
| [Mozilla Readability](https://github.com/mozilla/readability) | Firefox Reader View 使用的通用正文提取器 | 可评估替代当前过拟合的模板检查，但与白名单分开 | 它是解析器，不是来源信誉名单；官方明确 `isProbablyReaderable` 会有误判，输出还需单独净化 |

因此首版运行时不需要 Tranco、Radar、Disconnect 或 EasyList。若使用 PSL，也只用于域名边界计算，不让它自动决定放行。

## 建议的首批内置来源配方

下面是**候选顺序**，不是声称现在已经全部兼容。每一项仍需用一篇真实长文完成“正文首尾、标题层级、必要图片、来源、重启离线阅读”后才可从候选升级为默认开启。

### 第一组：现有案例与官方技术/研究文章

| 精确主机 | 允许的正文路径 | 官方入口 | 建议 |
|---|---|---|---|
| `www.anthropic.com` | `/research/…` | [Anthropic Research](https://www.anthropic.com/research) | 首个配方；已有指定真实页面证据。资源仅允许已核验的 `www-cdn.anthropic.com/images/…`，不要放行页面出现的所有外链 |
| `research.google` | `/blog/…` | [Google Research Blog](https://research.google/blog/) | 首批候选；不要放行 `*.google.com` |
| `openai.com` | `/index/…`；栏目页 `/news/research/` 只作入口 | [OpenAI Research](https://openai.com/news/research/) | 首批候选；`chatgpt.com` 是产品/用户内容入口，不作为文章来源整域放行 |
| `www.microsoft.com` | `/en-us/research/blog/…` | [Microsoft Research Blog](https://www.microsoft.com/en-us/research/blog/) | 首批候选；不要放行整个 `microsoft.com` 的任意路径 |
| `machinelearning.apple.com` | 该专用研究主机上的文章路径 | [Apple Machine Learning Research](https://machinelearning.apple.com/) | 首批候选；仍按精确主机处理，不扩成 `*.apple.com` |
| `ai.meta.com` | `/blog/…` | [AI at Meta Blog](https://ai.meta.com/blog/) | 第二批候选，先验证真实正文与图片资源 |
| `blog.cloudflare.com` | 文章路径 | [Cloudflare Blog](https://blog.cloudflare.com/) | 第二批候选；该主机明确提供技术深度文章，但仍不自动信任 Cloudflare 的其他客户域名 |
| `github.blog` | 文章路径 | [GitHub Blog](https://github.blog/) | 第二批候选；不要把 `github.com` 仓库页面或 `github.io` 多租户站点一并放行 |

这里“ChatGPT、Claude”应映射到其公司的公开文章站：`openai.com`、`www.anthropic.com`，而不是广泛允许 `chatgpt.com`、`claude.ai` 的对话、分享或账户页面。两家公司自己的官方页面也把研究内容与产品入口分开：[OpenAI Research](https://openai.com/news/research/)、[Anthropic Research](https://www.anthropic.com/research)。

### 第二组：论文、开放期刊与标准

| 精确主机 | 允许的正文路径 | 官方依据 | 建议 |
|---|---|---|---|
| `pmc.ncbi.nlm.nih.gov` | `/articles/PMC…/` | [PMC 是 NIH/NLM 维护的生物医学与生命科学全文档案](https://pmc.ncbi.nlm.nih.gov/about/intro/) | 很适合 HTML 正文首批候选；保留每篇文章自己的版权/许可信息，不做批量抓取 |
| `journals.plos.org` | `/<journal>/article?id=…` | [PLOS ONE 说明文章开放获取并使用 CC BY](https://journals.plos.org/plosone/s/journal-information) | 首批开放期刊候选；路径和 `id` 参数都要匹配，不放行同域任意页面 |
| `elifesciences.org` | `/articles/…` | [eLife 是开放科学非营利组织](https://elifesciences.org/about/) | 首批候选；其图片可能来自专用资源主机，应按真实样本另列资源规则 |
| `arxiv.org` | `/html/…`；`/abs/…` 仅作元数据/摘要 | [arXiv API 文档说明其托管 e-prints 并提供文章标识和摘要](https://info.arxiv.org/help/api/user-manual.html) | 有 HTML 全文时可候选；PDF URL 仍交给现有 PDF 导入，不把摘要页伪装成全文。arXiv 也明确多数投稿版权并未转给 arXiv，[不能推断可再分发](https://info.arxiv.org/help/bulk_data_s3.html) |
| `aclanthology.org` | 精确论文 ID 的 landing page | [ACL Anthology 官方说明与 canonical URL 格式](https://aclanthology.org/faq/) | landing page 可提供元数据；PDF 应走 PDF 导入。不要把 landing page 当作完整论文 HTML |
| `openreview.net` | `/forum?id=…` | [OpenReview 官方说明其托管论文、评审与讨论](https://openreview.net/about) | 暂列候选，不首批开启；页面内容层次和动态结构需先实测，不为它引入无头浏览器 |
| `www.rfc-editor.org` | `/rfc/…` 的 HTML 文档 | [RFC Editor 负责编辑、发布和归档 RFC](https://www.rfc-editor.org/about/) | 建议补充的高价值长文来源，结构稳定，范围明确 |
| `www.w3.org` | `/TR/…` | [W3C Technical Reports](https://www.w3.org/TR/) | 建议补充的官方标准文档来源；只放行技术报告路径 |

bioRxiv/medRxiv、Nature、Science、ACM、IEEE 等可以后续逐站验证，但不因“论文网站”这一类别一次性整域开放。付费墙、登录、动态外壳或只有 PDF 的页面继续明确分流/失败，不为扩大覆盖引入浏览器自动化。

### 第三组：知名独立博客

不存在客观且稳定的“知名博客”全集。建议首版不内置大量个人判断，只提供少量可关闭的示例或由用户加入个人白名单，例如 [Martin Fowler 的 Articles](https://martinfowler.com/articles/)、[Julia Evans](https://jvns.ca/) 和 [Simon Willison](https://simonwillison.net/)。规则必须是精确主机/作者路径；站点易主或长时间失效时可以从默认候选中移除，但不删除用户已经保存的本地文章。

## 明确不应整域放行

- `medium.com`、`substack.com`、`wordpress.com`、`blogspot.com`、`github.io` 等多租户平台：只允许经用户或内置配方确认的**精确作者子域/作者路径**。PSL 可帮助识别私有后缀，但不能替代这个精确规则。
- `google.com`、`microsoft.com`、`apple.com`、`meta.com`、`amazon.com` 等公司根域：公司信誉不表示账号、控制台、商店、社区、用户上传和任意产品路径都是公开文章。
- `chatgpt.com`、`claude.ai`：不作为公开文章站整域放行，尤其不要自动获取分享会话、需登录页面或用户私有内容。
- 任意 CDN（如 `cdn.sanity.io`）、对象存储或通用图片代理：只有当某个已批准来源配方的真实文章确实需要，并且路径/媒体类型也被约束时，才加入该配方的资源规则；不能把 CDN 主机当正文来源。

## 最小维护模型

每条配方只需要下面这些字段，不再建立动态信誉系统：

```yaml
id: anthropic-research
document:
  scheme: https
  hosts: [www.anthropic.com]
  path_prefixes: [/research/]
  content_types: [text/html]
redirects:
  max_hops: 3
  allowed_document_rules: [anthropic-research]
resources:
  - host: www-cdn.anthropic.com
    path_prefixes: [/images/]
    content_types: [image/png, image/jpeg, image/webp]
parser: semantic-article
last_verified_url: https://www.anthropic.com/research/distillation-defenses
last_verified_on: 2026-10-17
```

维护规则：

1. **正文来源和资源来源分开。** 资源主机不能提交文章；正文主机也不能自动授权它页面里出现的所有第三方链接。
2. **每次重定向重新匹配。** 最终 URL 必须命中某条正文配方；不能因为起点在白名单就跟随到任意主机。
3. **精确主机优先，不支持 `*.example.com`。** 如果确实需要两个子域，就显式写两条。
4. **路径是能力边界。** 只开放实际文章栏目，不开放登录、搜索、评论、分享、控制台、文件上传等路径。
5. **配方保持数据化和小型化。** 新增来源只改一条配置并附一篇真实验收 URL；不要为单站 CSS 类名、页脚、分享按钮建立结构认证。通用解析器只取 `article/main` 的语义内容并净化。
6. **失败要简单。** 未命中显示“当前暂不支持该网站”；命中但正文不足显示“该页面结构暂不支持”。不要引入未知状态、重放协议或后台扫描。
7. **个人白名单独立。** 用户可添加精确主机（多租户平台则再要求精确作者子域/路径），但这不进入产品默认名单，也不自动上传或共享。
8. **保留少量通用保护。** 白名单不替代 HTTPS、连接/总时长、正文/图片/像素上限、不携带 Cookie/Authorization、不执行脚本、HTML 净化和 SQLite 提交原子性。这些直接保护本机资料，不能和过度防御一起删除。[Mozilla Readability 也明确要求对不可信输入另做净化并保持脚本/远程资源执行关闭](https://github.com/mozilla/readability#security)。

## 对当前开发顺序的建议

1. 先只保留 `anthropic-research` 一条已证明的来源配方，把现有 Anthropic 模板/CSS/分享区逐节点认证删除，改成精确 URL 边界 + 通用语义正文提取。
2. 用同一套简单解析流程各验证一篇 `research.google`、`openai.com/index`、PMC、PLOS/eLife、RFC；通过的才加到内置名单。
3. 暂不接 Tranco、Radar、Disconnect、EasyList，不建立在线名单更新服务。
4. 第二轮再根据用户实际粘贴失败记录增加来源，每轮只加少量 exact host/path；没有真实需求的站点不预先支持。

这能让白名单真正承担“缩小网络输入面”的职责，同时避免再造一个需要长期维护的站点信誉系统。
