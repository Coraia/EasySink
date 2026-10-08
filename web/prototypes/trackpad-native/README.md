# 触控板与鼠标同几何、原生手势结束候选原型

仅独立原型，不改正式 reader、导入库、AI 配置或正式用户数据。冻结的正式版本为 20261007-gesture-fix。

2026-10-07 连翻样本扩展：本原型独立 sample.js 保留前三章，再追加 19 轮相同英文示例，合计 60 章。新增标题用 Practice 序号区分；页数随窗口和字号变化。其他原型、抓取几何、原生阶段、释放规则与光影不变。重复内容仅用于持续翻页体验。

## 编码前约束及失败模式

- 触控板与鼠标使用同一 beginPreview/update/release 及 turnDistance：横向 CSS 像素对应抓取点位移；纵向分量也作用于折角。不使用触控板专用的 /600 或 90% 完成门槛。
- 原生浏览器滚动承载输入，native scrollend 作为候选结束信号。无输入计时器不能自动释放；手势中纸张保持当前形状，恢复沿同一抓取点继续。禁止用永远保持模拟“已区分真实抬手”。
- scrollend 表示原生滚动及手势完成，可能包含惯性时间；支持该 API 不代表已验证当前 macOS/IAB 的真实手指状态。用户实际的“停住但仍贴着”必须验证：若 scrollend 提前到达即失败，停止将此候选称为符合需求。
- 不支持 scrollend 时明确禁用触控板候选，不悄悄用静默 polyfill。提供鼠标基线继续验收几何与收尾。
- 抬手后沿用鼠标距离/flick基础规则；回滑意图优先取消。触控板/鼠标统一几何，不能重复注释/叠卡打断正文。
- 快收尾只有 release 后生效，目标 100–180ms；准备纹理、等待原生结束、连续绘制分别记录，不把惯性或资源等待藏掉。
- 翻动用原有卷纸与光影 renderer；下一次输入可在落页时记录并接续，不增加旧静默锁；无迟到或跨布局提交。
- 鼠标、缩放、纵向、工具层、取消/失焦/布局变化隔离；scroll rail 初始化事件不能释放新手势；同向惯性属于原生同一手势，不开多页。
- wheel/end/scroll、纸页 pin、释放与落页时间仅留在此原型内存诊断，页码、字体等只写独立原型 localStorage key；不记录其他网站或系统输入。

## E2E 与真实验收

原生 wheel 首帧对照鼠标 pin/二维方向；鼠标停驻 1 秒到真实 pointerup 后才收尾；浏览器 CDP 合成触屏“保持接触→停驻→抬起”测试 scrollend 生命周期，明确其不是 Mac 触控板证据。检查单/双页、完成与取消、收尾时间、快速连续与交替、Esc/工具层、控制台错误。出具可复现 JSON 和截图。

真实验收待用户：两指向左/右滑动；手仍贴着暂停至少 1 秒；恢复并回滑；抬手后结束；慢/中/快、连续同向和交替。若原生结束信号与真实抬手不符，需另行确认本机 phase 接入，不能暗改正式版或假称已实现。

资料：[Chrome scrollend](https://developer.chrome.com/blog/scrollend-a-new-javascript-event)，[CSSOM View scrolling events](https://drafts.csswg.org/cssom-view/#scrolling-events)。

## 本机接入补充：用户已确认

用户确认可以增加仅本机 macOS 接入，优先真实触控板。通过 NSEvent 的 phase 与 momentumPhase 区分仍在操作／真正结束／惯性；只允许原型聚焦且指针在手势区域时的 scrollWheel，忽略键盘、其他输入、未激活原型和抬手后的惯性位移。监听助手不改变系统设置，也不安装后台启动项。

新增失败模式：助手失联、phaseEnded 丢失、重复 ended、momentum 开始前没有 ended、新 began 在旧落页期间到达、tab/窗口失焦、辅助进程只连接而未收到真实事件。必须分别记录连接就绪与真实阶段到达；模拟 phase 的 WebSocket E2E 不等于物理触控板验收。WebSocket 限 loopback、随机令牌及明确 Origin，不开放 LAN；没有客户端激活时助手不输出移动。

## 启动与清退

```sh
python3 scripts/trackpad_lab/manage.py start
python3 scripts/trackpad_lab/manage.py status
python3 scripts/trackpad_lab/manage.py stop
```

桥接端口 8769 只绑定 127.0.0.1。原型位于 `/static/prototypes/trackpad-native/index.html`。将鼠标移入正文再做两指手势；收到 began/changed/stationary 时不结算，ended/cancelled 或明确进入 momentum 时才结束；不应用后续 momentum 位移。零位移 ended 也必须通过监听。

关闭原型标签或移出/失焦会停止该页的接收；没有页面激活时辅助进程不输出手势移动。没有键盘监听，没有系统设置修改或开机启动项。停止本机服务并移除本文件夹与 `scripts/trackpad_lab/` 即可清退。生成的 bridge-config.js 是临时本机连接令牌，不提交，不放进报告。

真实 phase 接收与物理手感待用户验收；5 项 E2E 用明确标记的 phase fixture，不冒充真机。完整正式版源码仍匹配回滚基线。
