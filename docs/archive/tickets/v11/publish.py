from pathlib import Path
import json,subprocess
root=Path(__file__).parent
repo='Coraia/EasySink'
tickets=[
 ('语境记录：词语收藏、整体划线与独立反馈',[],[
 '从真实阅读选区或词卡保存词语/摘录，服务端核对锚点、来源快照与书籍归属；同位置幂等。',
 '整体划线按真实重叠取并集，删除/合并后的选区和菜单一致；独立笔记、词语记录与子范围解释保留。',
 '已懂这里与保留注释分别持久化，只影响此处；旧全局反馈兼容且不伪造语境。',
 '撤销恢复前态，后续版本冲突拒绝覆盖；刷新/重启/插件关闭保留资料。']),
 ('离线释义：完整义项、可靠表达与词卡',[],[
 '基础词注保留合理候选，词卡显示词性、领域、完整义项和真实来源；缺中文诚实回退。',
 '可靠短语整体注释优先于冗余自动成员注释，成员词仍可查，显式保留不消失。',
 '固定日常、神学、技术样本揭示具体信息损失与修复；不冒充语境已确定。',
 '无需外部词典账户，接口可替换，离线可用且长书分析不增加无界匹配。']),
 ('主动语境解释：有界上下文、缓存与采用历史',[],[
 '选区主动解释使用实际必要句段及至多前后各一段，上限/截取状态可查看，不附整书、笔记或画像。',
 '同内容同语境有效结果可复用，换模型不自动重算，刷新和重开不新增调用。',
 '主动重新解释才用当前模型；未知/失败/限额/离线保持可解释，不自动重发未知请求。',
 '卡片区分词典候选与真实上下文解释；记录可主动采用新解释并保留历史和来源。']),
 ('词句收藏管理：来源预览、资料导出与恢复',[0],[
 '阅读内仅本书，书架汇总各书，支持词语/摘录及按书/词筛选，每次语境单独可读。',
 '回原文先预览，外部点击和 Escape 关闭回入口；只有明确继续读才更新正确书的续读。',
 '失去原件或不能可靠匹配仍读保存快照，不按数字 ID 或相同短语猜跳。',
 '个人释义与解释历史可管理；导出可读文件和可恢复 JSON，恢复校验来源与幂等，清理范围独立。']),
 ('书架再次遇见：当天稳定、主动轮换与持续关闭',[3],[
 '仅书架/全局收藏出现，一天稳定一条，优先未见，尽量七天避重，不使用未收藏正文或 AI。',
 '换一条、三十天暂不推荐、持续关闭/重新开启真实持久化；取消收藏立即退出。',
 '展示所收藏词句及对应语境与来源，预览不改续读；资料不足有安静空状态。']),
 ('V1.1 交付：真实质量、完整走查、性能与客户端',[0,1,2,3,4],[
 '三类材料各至少十个固定样本核对词注、词卡和实际 AI；确定错义修复或诚实降级，保留争议与边界。',
 '完整真实点击覆盖新增闭环及受影响 V1 阅读/笔记/书签/跨段/PDF/开关/退出恢复；首失败保留，修复后复验。',
 '同环境对照 V1 开书、翻页、选区与内存，新增功能不降低清晰度；不以 HTTP 时长替代首屏或模拟代替设备。',
 '备份并验证个人资料不被改写，更新 Web 与本机客户端，核对安装产物、源文件和运行版本；用户可以直接验收。',
 '完成代码 review、提交当前分支，并给出已验范围、未验证边界与体验路径，不宣称用户已通过。'])]
manifest=[]
for i,(title,blockers,criteria) in enumerate(tickets):
 body='## Parent\n\nPart of #39\n\n## What to build\n\n'+title+'。依据已接受 Q1–Q24 和 V1.1 规格，贯通实际阅读入口、持久化与回读。\n\n## Acceptance criteria\n\n'+'\n'.join('- [ ] '+c for c in criteria)+'\n\n## Further notes\n\n用户已明确授权主控直接完成规格、任务拆分和实现，无需再次询问粒度。沿用直接浏览器走查，不新增事后单元测试；故障模拟与真实质量证据分列。\n'
 file=root/f'{i+1:02d}.md';file.write_text(body)
 url=subprocess.check_output(['gh','issue','create','--repo',repo,'--title',f'V1.1 T{i+1:02d}：{title}','--body-file',str(file),'--label','ready-for-agent'],text=True).strip()
 number=int(url.split('/')[-1]);detail=json.loads(subprocess.check_output(['gh','issue','view',str(number),'--repo',repo,'--json','number,title,body,labels'],text=True));native=json.loads(subprocess.check_output(['gh','api',f'repos/{repo}/issues/{number}'],text=True))
 subprocess.run(['gh','api','-X','POST',f'repos/{repo}/issues/39/sub_issues','-F',f'sub_issue_id={native["id"]}'],check=True,stdout=subprocess.DEVNULL)
 for blocker in blockers:subprocess.run(['gh','api','-X','POST',f'repos/{repo}/issues/{number}/dependencies/blocked_by','-F',f'issue_id={manifest[blocker]["id"]}'],check=True,stdout=subprocess.DEVNULL)
 edges=json.loads(subprocess.check_output(['gh','api',f'repos/{repo}/issues/{number}/dependencies/blocked_by'],text=True))
 manifest.append({'local':i+1,'number':number,'id':native['id'],'url':url,'title':detail['title'],'blockers':[manifest[k]['number'] for k in blockers],'verified_edges':[e['number'] for e in edges],'body_readback_matches':detail['body'].strip()==body.strip(),'labels':[l['name'] for l in detail['labels']]})
 (root/'manifest.json').write_text(json.dumps({'spec':39,'tickets':manifest},ensure_ascii=False,indent=2)+'\n')
 print(number,title,flush=True)
