import { $, e, api, toast, openDialog } from '../core.js';
import { ReadingEvidence } from '../reading-evidence.js';

export async function install(ctx) {
  const capture = new ReadingEvidence(ctx);
  // Evidence is optional: a status failure must not block entering a book.
  capture.sync().catch(()=>{});
  const read = ctx.hook('read', r => {
    capture.openDocument(r);
    let timer;
    const sample = () => { clearTimeout(timer); timer=setTimeout(()=>capture.present(r),250); };
    r.scope.on(r.events,'draw',sample);
    r.scope.on(r.events,'position',sample);
    r.scope.interval(()=>capture.present(r,Boolean(r.popElement)),2000);
    r.scope.cleanup(()=>clearTimeout(timer));
    sample();
  });
  const word = ctx.hook('word', ({reader:r,pop,scope}) => {
    let timer;
    const sample = () => {clearTimeout(timer);timer=setTimeout(()=>capture.present(r,true),150);};
    const observer = new MutationObserver(sample);
    observer.observe(pop,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden']});
    scope.cleanup(()=>{observer.disconnect();clearTimeout(timer);}); sample();
  });
  const route = ctx.route('evidence', async scope => {
    let state;
    try { state=await capture.sync(); } catch(error) {ctx.root.textContent='本机阅读证据暂不可用：'+error.message;return;}
    if (scope.signal.aborted) return;
    ctx.root.innerHTML=`<div class="page"><div class="page-head"><div><div class="eyebrow">LOCAL EVIDENCE</div><h1>本机阅读证据</h1><p>事实不是能力判断；收藏、查阅或没有操作都不代表不懂或已掌握。</p></div></div>
      <section class="card"><h2 data-evidence-state></h2><p>首次明确开启后，持续保存阅读页当时可见的原文片段、实际注释和操作上下文。不采整书、个人笔记、全局输入或其他应用，不上传，不为采集调用模型。</p>
      <p>原有阅读统计、续读、收藏与采用历史独立保留；关闭本项不等于关闭这些业务记录。</p>
      <p>达到 256 MiB 或连续采集 90 天先到时暂停；已有证据保留至手动清除，不自动到期删除。占用计入 SQLite 文件、索引、WAL/共享内存和有界队列预留；按实际文件与保守记录计费的较大值提前暂停，不宣称可写满 256 MiB。检测到时钟明显倒退也会安全暂停。</p>
      <p data-summary>${state.events} 条事件 · ${state.contexts} 份去重上下文 · ${((state.accounted_bytes ?? state.charged)/1048576).toFixed(2)} MiB 计入配额（含队列预留），实际文件 ${((state.disk_bytes || 0)/1048576).toFixed(2)} MiB。${state.unclosed_sessions} 个会话尾部未确认，可能缺失，不能补记成功。</p>
      <p>业务保存成功不等于采集已持久化。服务端排队不是持久确认；只有证据批次提交成功才成为已保存事件。异常退出前未确认的短尾为 unknown/gap，即使这里显示零个会话也不能排除缺失。关闭或清除会丢弃尚未确认的队列。</p>
      <p>本浏览器只保存不含原文的采集意图标记。关闭意图在存储成功时跨窗口与重载保留；存储失败仍尝试服务端关闭。两侧均未确认时仅当前窗口暂时停采，其他窗口或重新加载可能恢复旧采集，须重试关闭，不能视为持久关闭。新浏览器或标记被清除后须重新明确开启。</p>
      <p>清除会立即关闭采集并使旧 epoch 失效。若出现 capture-cleanup-incomplete，新增记录已逻辑清除，但进行中的导出或存储故障可能阻止空间回收；等待导出结束后重试清除。已开始的导出保持清除前的一致快照，已导出的文件不受清除影响。</p>
      <p role="status" data-evidence-control-status>${e(state.pause || capture.error || capture.controlNotice)}</p>
      <div class="row"><button data-enable ${state.enabled||state.pause?'disabled':''}>明确开启本机采集</button><button data-disable ${!state.enabled?'disabled':''}>关闭采集</button><button data-export>导出阅读证据</button><button data-clear>清除阅读证据</button></div></section>
      <section class="card"><h2>只读回放</h2><p>读取当时保存的文本与注释，不重算词义或调用模型。不是像素录像；截断、未确认尾部与未知结果会保留。原文不与今天的新版本重新绑定。</p><button data-replay>查看已保存事件</button><div data-events></div><button data-more hidden>继续读取</button></section></div>`;
    capture.notice();
    const act=async(action)=>{try{await capture.control(action);ctx.refresh();}catch(err){toast(err.message);capture.notice();}};
    $('[data-enable]',ctx.root).onclick=()=>act('enable');
    $('[data-disable]',ctx.root).onclick=()=>act('disable');
    $('[data-clear]',ctx.root).onclick=()=>openDialog('清除新增阅读证据',`<p>只清除本项新增事件与上下文。不删除书籍、原件、收藏、笔记、采用历史或旧统计。采集将关闭，迟到批次作废。已经导出的文件不会被撤回。</p><div class="row"><button data-cancel>取消</button><button data-confirm>确认清除阅读证据</button></div>`,d=>{
      $('[data-cancel]',d).onclick=()=>d.close();$('[data-confirm]',d).onclick=()=>{d.close();act('clear');};
    });
    $('[data-export]',ctx.root).onclick=()=>openDialog('导出包含原文与阅读行为',`<p>将下载版本化 JSONL，包含去重上下文、事件与会话索引。文件只下载到本机；请自行保护，不自动上传。未确认的队列尾部可能缺失。</p><button data-download>确认下载 JSONL</button>`,d=>{
      $('[data-download]',d).onclick=async()=>{
        await capture.flush();
        const a=document.createElement('a');a.href='/api/evidence/export?confirm=true';a.download='wise-reader-evidence-v1.jsonl';a.click();d.close();
      };
    });
    let after=0;
    const more=$('[data-more]',ctx.root), target=$('[data-events]',ctx.root);
    const load=async()=>{
      const {events}=await api(`/evidence/events?after=${after}&limit=30`,{signal:scope.signal});
      for(const event of events){
        after=event.ordinal;
        const item=document.createElement('details');
        item.innerHTML=`<summary>${event.ordinal} · ${e(event.event_type)} · ${e(event.status)} · ${e(event.evidence_class)} · ${e(event.observer)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>`;
        const pre=$('pre',item);pre.textContent=JSON.stringify(event,null,2);
        if(event.context_hash){
          const button=document.createElement('button');button.textContent='回放当时上下文';
          button.onclick=async()=>{const snapshot=await api('/evidence/contexts/'+event.context_hash,{signal:scope.signal});pre.textContent=JSON.stringify({event,snapshot},null,2);};
          item.append(button);
        }
        target.append(item);
      }
      more.hidden=events.length<30;
    };
    $('[data-replay]',ctx.root).onclick=()=>{after=0;target.replaceChildren();load().catch(err=>toast(err.message));};
    more.onclick=()=>load().catch(err=>toast(err.message));
  });
  return ()=>{read();word();route();capture.dispose();};
}
