import { $, $$, e, api } from "./core.js";
import { annotationInk } from './annotation-ink.js';

// Capture source presentation, never infer that silence means understanding.
export function installReadingLearning(reader, scope) {
  let timer = 0, started = 0, lastPage = '', queue = Promise.resolve(), failed = 0;
  const spans = anchor => anchor.segments?.length ? anchor.segments : [anchor];
  const visibleRanges = () => $$('#article [data-block]').filter(el => {
    const rect = el.getBoundingClientRect(), leaf = el.closest('.page-leaf')?.getBoundingClientRect();
    return leaf && rect.width && rect.height && rect.bottom > Math.max(0,leaf.top) && rect.top < Math.min(innerHeight,leaf.bottom);
  }).map(el => ({block_id: el.dataset.block, start: +el.dataset.start, end: +el.dataset.end}));
  function snapshot(ranges, trigger, dwell) {
    const model = reader.doc.adaptive_profile;
    if (!model || !ranges.length) return null;
    const intersects = a => ranges.some(r => r.block_id === a.block_id && r.start < a.end && r.end > a.start);
    // Word-action markers may reserve the current layout without showing an
    // inline gloss yet. Exposure records describe what was actually displayed.
    const shown = annotationInk();
    const annotations = (reader.annotations || []).filter((a, index) => shown.has(index)).map(a => ({block_id:a.block.id,start:a.start,end:a.end,
      automatic: !a.forced && !['context-retained','usage-preference'].includes(a.source)})).filter(intersects);
    return {visit_id:crypto.randomUUID(),doc_id:reader.doc.id,version:reader.doc.version,
      trigger,dwell_ms:Math.min(300000,Math.round(dwell)),ranges,
      annotations,baseline_annotations:(reader.doc.baseline_annotations||[]).filter(intersects),
      model:{algorithm:model.algorithm,vocab_size:model.vocab_size,baseline_vocab_size:model.baseline_vocab_size,sample_lexemes:model.sample_lexemes}};
  }
  function submit(body) {
    if (!body) return Promise.resolve();
    queue = queue.catch(()=>{}).then(async()=>{
      try {
        await api('/collections/learning/exposure',{method:'POST',body,keepalive:JSON.stringify(body).length<50000});
      } catch (error) {
        failed++;
        // The source remains readable. A missing receipt never counts as read.
        reader.learningError = error.message;
      }
    });
    return queue;
  }
  function schedule() {
    clearTimeout(timer);
    started = performance.now();
    timer = setTimeout(()=>{
      if (scope.signal.aborted || document.hidden || reader.restoring || reader.popElement || reader.panelId || reader.selecting || reader.adjustingSelection || reader.pages?.animating || reader.focus.isOpen()) return;
      const ranges = visibleRanges();
      const key=JSON.stringify([reader.doc.id,reader.doc.version,ranges,reader.doc.adaptive_profile?.vocab_size]);
      if (key===lastPage) return;
      lastPage=key;
      void submit(snapshot(ranges,'dwell',performance.now()-started));
    },1500);
  }
  const openStats = () => {
    reader.closePop();
    reader.focus.close();
    return reader.panel('annotation-learning','标注反馈趋势', '<div class="reading-learning" data-learning-panel></div>', async(el,panelScope)=>{
      const root=$('[data-learning-panel]',el);
      let bucket=500,offset=0,current=null,generation=0;
      const rate=(n,d)=>d? (100*n/d).toFixed(2):'—';
      async function load() {
        const version=++generation;
        root.innerHTML='<p role="status">正在读取展示与反馈记录…</p>';
        try {
          await queue;
          const value=await api(`/collections/learning/stats/${reader.doc.id}?bucket_words=${bucket}&offset=${offset}`,{signal:panelScope.signal});
          if(panelScope.signal.aborted||version!==generation)return;
          current=value;
          const m=value.model,c=value.comparison;
          root.innerHTML=`<p class="meta">${e(value.title)}</p><div class="learning-model"><span>辅助词汇级估计</span><strong>${m.vocab_size.toLocaleString()}</strong><span>手动基准 ${m.baseline_vocab_size.toLocaleString()} · ${m.sample_lexemes} 个明确反馈词条</span></div>
            <p class="learning-note">这是辅助筛选的校准估计，已用于后续自动标注，不是标准词汇量测定。收藏、查词和没有操作都不作为掌握证据。</p>
            <p>首次展示 <strong>${value.totals.words.toLocaleString()}</strong> 词 · 当前可读正文覆盖 <strong>${value.coverage_percent}%</strong></p>
            <p class="meta">${e(value.coverage_basis)}。${value.milestones.map(x=>`${x.percent}%：${x.reached?'已覆盖':'尚未覆盖'}`).join(' · ')}</p>
            <section class="learning-compare"><h3>${c.comparable?"以首次展示顺序的 20% 为界":"原文版本已变化，阶段结果暂不直接比较"}</h3><div ${c.comparable?"":"hidden"}><p>前段：${c.early_words} 词，纠偏 ${c.early_corrections} 次（每百词 ${rate(c.early_corrections,c.early_words)}）</p><p>后段：${c.later_words} 词，纠偏 ${c.later_corrections} 次（每百词 ${rate(c.later_corrections,c.later_words)}）</p><p class="meta">界点按当前可读原文总词数计算；不是原书前 20% 的页码。</p></div>${!c.comparable?`<p class="meta">历史版本保留了 ${value.historical_version_words} 词次；覆盖率只计当前版本，下面仍按真实首次展示序列列出历史。</p>`:""}</section>
            <label class="learning-bucket">按首次展示顺序分组<select data-learning-bucket aria-label="统计分组">${[100,200,500,1000].map(n=>`<option value="${n}" ${bucket===n?'selected':''}>每 ${n} 词</option>`).join('')}</select></label>
            <div class="learning-table-wrap"><table class="learning-table"><thead><tr><th>展示词序</th><th>注释 / 百词</th><th>自动 / 百词</th><th>原设定 / 百词</th><th>＋ / −</th><th>纠偏 / 百词</th><th>辅助级</th></tr></thead><tbody>${value.buckets.map(b=>`<tr><td>${b.start_word}–${b.end_word}${b.words<bucket?'（未满）':''}</td><td>${b.annotations_per_100}</td><td>${b.automatic_per_100}</td><td>${b.baseline_per_100}</td><td>${b.plus} / ${b.minus}</td><td>${b.corrections_per_100}</td><td>${b.mean_vocab_size}</td></tr>`).join('')||'<tr><td colspan="7">尚无展示记录。从任何位置开始阅读即可；之前的顺序不回填。</td></tr>'}</tbody></table></div>
            <p class="learning-note">“注释”是实际展示的词注处数；“自动”排除明确保留；“原设定”是在相同原文和密度下、按手动词汇级生成的自动候选。短语在首词计一次。</p>
            <div class="learning-pagination"><button type="button" data-learning-prev ${offset===0?'disabled':''}>上一组</button><span>${value.total_buckets?offset+1:0}–${Math.min(offset+40,value.total_buckets)} / ${value.total_buckets} 组</span><button type="button" data-learning-next ${offset+40>=value.total_buckets?'disabled':''}>下一组</button></div>
            <details><summary>最初的展示来源（按记录先后）</summary><ol>${value.first_presentations.map(p=>`<li>${e(p.title)} · ${p.new_words} 个首次展示词 · ${p.trigger==='feedback'?'主动反馈':'稳定展示'} · ${e(p.at)}</li>`).join('')}</ol></details><details><summary>计数与数据边界</summary>${value.limitations.map(x=>`<p>${e(x)}</p>`).join('')}<p>小样本和反馈意愿会影响纠偏频率；不能由此承诺读到 20% 或 30% 后达到某个准确率。</p><p>未关联展示序列的反馈：${value.unattributed_feedback}，保留于日志，不计入阶段纠偏率。</p><p>本次未计入的展示请求：${failed}。${e(reader.learningError||'')}</p></details>
            <div class="learning-panel-actions"><button type="button" data-learning-refresh>刷新统计</button><button type="button" data-learning-export>导出当前统计 JSON</button></div>`;
        } catch(error) {
          if(!panelScope.signal.aborted)root.innerHTML=`<p role="status">暂时无法读取统计：${e(error.message)}</p><button type="button" data-learning-refresh>重试</button>`;
        }
      }
      panelScope.on(root,'change',event=>{if(event.target.matches('[data-learning-bucket]')){bucket=+event.target.value;offset=0;void load();}});
      panelScope.on(root,'click',event=>{
        if(event.target.closest('[data-learning-prev]')){offset=Math.max(0,offset-40);void load();}
        if(event.target.closest('[data-learning-next]')){offset+=40;void load();}
        if(event.target.closest('[data-learning-refresh]'))void load();
        if(event.target.closest('[data-learning-export]')&&current){
          const url=URL.createObjectURL(new Blob([JSON.stringify(current,null,2)],{type:'application/json'})),link=document.createElement('a');
          link.href=url;link.download=`wise-reader-annotation-trends-${reader.doc.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }
      });
      await load();
    });
  };
  const tool=reader.tool('annotation-learning','标注反馈趋势',openStats);
  reader.learning={openStats,captureFocused:anchor=>submit(snapshot(spans(anchor).map(p=>({block_id:p.block_id,start:p.start,end:p.end})),'feedback',0)),flush:()=>queue};
  for(const name of ['position','draw','reading-uncovered'])reader.on(name,schedule);
  scope.on(document,'visibilitychange',schedule);
  scope.on(window,'focus',schedule);
  scope.on(window,'reader-before-close',event=>event.detail.waitUntil(queue.then(()=>true)));
  scope.cleanup(()=>{clearTimeout(timer);tool.remove();delete reader.learning;});
  schedule();
}
