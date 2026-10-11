// Independent interaction prototype. No production APIs, user records or model calls.
const $ = s => document.querySelector(s);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = x => structuredClone(x);
// Keep the agent walkthrough and the user's clean experience independently resumable.
const key = 'wr.prototype.v11-reading-loop.v1' + (new URLSearchParams(location.search).get('session') === 'experience' ? '.experience' : '');
const books = [
  {id:'quiet', title:'The quiet art of paying attention', color:'#dce4d8', label:'日常英文', pages:[
    ['A little more room',[
      'Nothing extraordinary happened that day. I did not discover a secret method for becoming more productive. I simply noticed more: the precise blue of the heron’s wing, the café owner’s laughter, the patience hidden inside a carefully written sentence.',
      'The quiet art of paying attention begins when we leave a little room for wonder. In light of what I had noticed, the walk home no longer felt like wasted time.'
    ]],
    ['Beside the river',[
      'She sat on the bank and watched the river. The water carried small leaves past her feet, each one taking a different path.',
      'Later, she went to the bank to deposit a cheque. The same word belonged to a different part of her day; understanding one use did not tell the whole story.'
    ]]
  ]},
  {id:'grace', title:'Notes on grace', color:'#e7ddcb', label:'神学语境', pages:[
    ['A gift, not a wage',[
      'In this account, grace is received as a gift rather than earned as a wage. The author uses the language of welcome to describe the relation between God and those who trust him.',
      'The discussion of justification asks how a person is put right with God. Different traditions explain this relation differently, so a brief dictionary gloss cannot settle the whole question.'
    ]],
    ['Reading with care',[
      'A reader can understand the word in this passage and still want to keep a short explanation beside it. A useful note leaves room for a question as well as an answer.',
      'We read again because the context matters. The words remain on the page; our questions may change.'
    ]]
  ]},
  {id:'code', title:'Small programs, clear ideas', color:'#d8e2e5', label:'技术语境', pages:[
    ['A thread of work',[
      'The worker thread waits for a message while the main thread keeps the interface responsive. A slow operation should not stop the reader from turning a page.',
      'Idempotent describes an operation that has the same effect when repeated. If a saved result already exists for the same input, the program can reuse it instead of asking for it again.'
    ]],
    ['A reliable boundary',[
      'A cache is useful only when its key describes the question being answered. Reusing the same spelling from a different context can be fast and still be wrong.',
      'Keep the original evidence. A clearer explanation should add to what was recorded, not silently replace the source.'
    ]]
  ]}
];
const dictionary = {
  extraordinary:{gloss:'非凡的；不寻常的', senses:['adj. 非凡的；出乎意料的'], context:'这里说明那一天并没有发生特别的事，与后文“只是注意到了更多”形成对照。'},
  'In light of':{gloss:'鉴于；考虑到', senses:['固定表达 · 鉴于；考虑到'], context:'这里指考虑到散步途中注意到的细节，而不是光照。应整体理解 in light of。'},
  bank:{gloss:'河岸；银行', senses:['n. 河岸；岸边','n. 银行；金融机构'], context:'river 和 water 表明这里的 bank 指河岸。'},
  grace:{gloss:'恩典；优雅', senses:['n. 神学 · 恩典','n. 举止或动作的优雅'], context:'本段以 gift 与 wage 作对照，grace 在这段神学语境中指恩典。'},
  justification:{gloss:'称义；正当理由', senses:['n. 神学 · 称义','n. 行为的辩护、正当理由'], context:'这里讨论人与上帝的关系，justification 指称义；不同传统对其内涵仍有不同解释。'},
  thread:{gloss:'线程；线索', senses:['n. 计算机 · 线程','n. 线；贯穿的线索'], context:'这里的 thread 是执行工作的一条线程；与 main thread 对照，涉及界面响应。'},
  Idempotent:{gloss:'中文释义待补', senses:['adj. Having the same effect when applied more than once.'], context:'这里描述重复执行后效果不变，即幂等。此中文解释为原型预设，非真实生成。', missing:true},
  cache:{gloss:'缓存；储藏处', senses:['n. 计算机 · 缓存','n. 隐藏的储藏处'], context:'这里指按输入身份保存并复用结果的缓存。'}
};
function pageData(bookId, page) {
  const book=books.find(b=>b.id===bookId), source=book.pages[page]; let offset=0;
  const paragraphs=source[1].map(text=>{const p={text,start:offset,end:offset+text.length};offset+=text.length+2;return p;});
  return {book,title:source[0],paragraphs,text:source[1].join('\n\n')};
}
function locate(book,page,text,n=0){const full=pageData(book,page).text;let at=-1;for(let i=0;i<=n;i++)at=full.indexOf(text,at+1);return {book,page,start:at,end:at+text.length};}
function sourceOf(r){return pageData(r.book,r.page);}
function quote(r){return sourceOf(r).text.slice(r.start,r.end);}
function id(){return crypto.randomUUID();}
function baseRecord(kind,r){return {...r,id:id(),kind,quote:quote(r),context:sourceOf(r).text,bookTitle:sourceOf(r).book.title,version:'demo-text-v1',created:Date.now(),history:[]};}
function defaults(){
  const bank=baseRecord('word',locate('quiet',1,'bank'));bank.meaning='河岸；银行';bank.meaningSource='预设基础词典';
  const grace=baseRecord('excerpt',locate('grace',0,'In this account, grace is received as a gift rather than earned as a wage.'));
  const lost={id:id(),kind:'excerpt',book:'unavailable',page:0,start:0,end:52,quote:'A good question can stay with us longer than an answer.',context:'A good question can stay with us longer than an answer.',bookTitle:'An old notebook',unavailable:true,created:Date.now(),history:[]};
  return {records:[bank,grace,lost],notes:[],feedback:{},retained:{},cache:{},resume:{quiet:0,grace:0,code:0},revisit:{hidden:false,day:'',current:null,seen:{},snooze:{}},bookmarks:[],font:25,density:4};
}
let data;try{data=JSON.parse(localStorage.getItem(key))||defaults();}catch{data=defaults();}
if(!Number.isFinite(data.density))data.density=4;
let ui={screen:'shelf',book:'quiet',page:0,focus:true,selection:null,more:false,panel:null,word:null,filter:'all',bookFilter:'all',note:null};
let undo=null,toastTimer,drag=null,wordPoint={x:0,y:0},pending=null;
const save=()=>{try{localStorage.setItem(key,JSON.stringify(data));}catch{toast('当前浏览器无法保存原型资料；关闭后可能丢失。');}};
function toast(message,fn=null){undo=fn;clearTimeout(toastTimer);$('#toast').innerHTML=`<span>${escape(message)}</span>${fn?'<button data-action="undo">撤销</button>':''}<button aria-label="关闭提示" data-action="hide-toast">×</button>`;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,8000);}
const icons={
  toc:'<path d="M4 6h16M4 12h16M4 18h16"/>',notes:'<path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/>',collections:'<path d="M6 3h12v18l-6-4-6 4z"/>',progress:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--paper)"/><circle cx="16" cy="17" r="3" fill="var(--paper)"/>',style:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',font:'<path d="M4 20L12 4l8 16M7 14h10"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',back:'<path d="M20 12H4m6-6l-6 6 6 6"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
function nav(){return `<header class="nav row between"><div class="row"><div class="logo">W.</div><div class="brand">wise reader</div></div><nav class="navlinks"><button data-action="shelf" class="${ui.screen==='shelf'?'active':''}">书架</button><button data-action="global" class="${ui.screen==='collection'?'active':''}">词句收藏</button><button data-action="help" aria-label="原型说明">ⓘ</button></nav></header>`;}
function daily(manual=false){
  const r=data.revisit, now=Date.now(),day=new Date().toLocaleDateString('sv-SE');
  const valid=data.records.filter(x=>!(r.snooze[x.id]>now));
  if(!manual&&r.day===day&&valid.some(x=>x.id===r.current))return valid.find(x=>x.id===r.current);
  let pool=valid.filter(x=>x.id!==r.current||r.day!==day);
  if(!pool.length){if(manual)return null;pool=valid;}
  pool.sort((a,b)=>(r.seen[a.id]||0)-(r.seen[b.id]||0));
  const fresh=pool.find(x=>!r.seen[x.id]||now-r.seen[x.id]>7*864e5),pick=fresh||pool[0];
  r.day=day;r.current=pick?.id||null;if(pick)r.seen[pick.id]=now;save();return pick;
}
function savedParagraph(r){const before=r.context.lastIndexOf('\n\n',r.start),after=r.context.indexOf('\n\n',r.end);return r.context.slice(before<0?0:before+2,after<0?r.context.length:after);}
function revisit(){
  if(data.revisit.hidden)return `<p class="muted">再次遇见已关闭。<button data-action="show-revisit">重新打开</button></p>`;
  const item=daily();return `<section class="revisit"><div class="row between"><span class="eyebrow">再次遇见 · 今天的一条</span><button data-action="hide-revisit" aria-label="关闭再次遇见">×</button></div>${item?`<p class="quote">${escape(item.quote)}</p>${item.kind==='word'?`<p style="font:19px/1.7 Georgia;max-width:830px;margin:0 0 15px">${escape(savedParagraph(item))}</p>`:''}<div class="source">${escape(item.bookTitle)} · ${item.kind==='word'?'词语收藏':'摘录'}</div><div class="actions spaced"><button class="primary" data-action="source" data-id="${item.id}">回原文</button><button data-action="next-revisit">换一条</button><button data-action="snooze" data-id="${item.id}">30 天内不推荐</button><button data-action="global">查看全部</button></div>`:'<div class="empty">暂时没有可展示的收藏。阅读时，留下你想再见到的词句。</div>'}</section>`;
}
function shelf(){return `${nav()}<main class="shelf"><div class="shelf-intro"><div><div class="eyebrow">A little room for reading</div><h1 style="margin-top:9px">让阅读自然发生。</h1><p class="muted">读懂这一处，也留下值得再见的词句。</p></div><span class="pill">V1.1 交互原型 · 独立演示资料</span></div>${revisit()}<div class="row between spaced"><h3>继续阅读</h3><small>3 篇预设材料</small></div><div class="bookgrid">${books.map(b=>`<button class="book" data-action="read" data-book="${b.id}"><div class="cover" style="background:${b.color}"><b>${escape(b.title)}</b><span class="eyebrow">${b.label}</span></div><div class="bookinfo">继续阅读 <span>第 ${(data.resume[b.id]||0)+1} / 2 节 →</span></div></button>`).join('')}</div><div class="prototype-footer">仅此原型的操作会保存在当前浏览器。<button data-action="help">体验路径与边界</button><button data-action="reset">重置演示</button></div></main>`;}
function reader(){const p=pageData(ui.book,ui.page);return `<main class="reading ${ui.focus?'focus':''}"><button class="topzone" data-action="tools" aria-label="展开或收起阅读工具"></button><header class="reader-top"><button data-action="shelf" aria-label="返回书架">${icon('back')}</button><span class="title">${escape(p.book.title)}</span><button data-action="tools" aria-label="阅读工具">···</button></header><article class="paper" aria-label="英文正文"><div class="row between"><span class="eyebrow">${p.book.label} · ${ui.page+1}</span><span class="pill">原型</span></div><h1>${escape(p.title)}</h1><div id="paragraphs"></div></article><footer class="pagefoot"><button data-action="previous" ${ui.page===0?'disabled':''}>← 上一节</button><span>第 ${ui.page+1} / 2 节 · 位置已保存</span><button data-action="next" ${ui.page===1?'disabled':''}>下一节 →</button></footer><nav class="dock" aria-label="阅读工具栏">${[['toc','目录与书签'],['notes','本书笔记'],['collections','本书收藏'],['progress','阅读进度'],['style','样式'],['font','字体'],['more','更多']].map(([name,label])=>`<button data-action="dock" data-name="${name}" aria-label="${label}" title="${label}">${icon(name)}${name==='collections'?`<span class="count">${data.records.filter(r=>r.book===ui.book).length||''}</span>`:''}</button>`).join('')}</nav></main>`;}
function filters(scope){return `<div class="filters">${[['all','全部'],['word','词语'],['excerpt','摘录']].map(([k,v])=>`<button data-action="filter" data-filter="${k}" class="${ui.filter===k?'active':''}">${v}</button>`).join('')}${scope==='all'?`<select id="book-filter" aria-label="按书筛选"><option value="all">所有书籍</option>${[...new Set(data.records.map(r=>r.book))].map(b=>`<option value="${b}" ${b===ui.bookFilter?'selected':''}>${escape(data.records.find(r=>r.book===b).bookTitle)}</option>`).join('')}</select>`:''}</div>`;}
function recordCards(scope){const list=data.records.filter(r=>(scope==='all'?(ui.bookFilter==='all'||r.book===ui.bookFilter):r.book===scope)&&(ui.filter==='all'||r.kind===ui.filter));return `<div class="records">${list.map(r=>`<section class="record" data-record="${r.id}"><div class="row between"><span class="pill">${r.kind==='word'?'词语':'摘录'}</span><small>${r.unavailable?'原文不可定位':`第 ${r.page+1} 节`}</small></div><p class="quote">${escape(r.quote)}</p><p class="source">${escape(r.bookTitle)}</p>${r.meaning?`<div class="explanation">${escape(r.meaning)}<div class="source">${escape(r.meaningSource)}</div></div>`:''}${r.mine?`<div class="explanation">我的释义：${escape(r.mine)}</div>`:''}<div class="actions"><button class="btn" data-action="source" data-id="${r.id}">回原文</button><button data-action="record-edit" data-id="${r.id}">详情 / 我的释义</button><button data-action="remove-record" data-id="${r.id}">${r.kind==='word'?'取消收藏':'删除划线'}</button></div></section>`).join('')||'<div class="empty">还没有这一类收藏。<br>词卡收藏词语，选中文字留下划线。</div>'}</div>`;}
function collections(){return `${nav()}<main class="shelf"><div class="row between wrap"><div><div class="eyebrow">Words worth keeping</div><h1 style="margin-top:9px">词句收藏</h1></div><button class="btn" data-action="manage">导出 / 清理</button></div><p class="muted spaced">每次相遇，都留着它自己的上下文。</p>${filters('all')}${recordCards('all')}<div class="prototype-footer"><button data-action="all-notes">独立保存的笔记 · ${data.notes.length}</button><button data-action="show-revisit">在书架显示再次遇见</button></div></main>`;}
function render(){hideSelectionUI();$('#wordcard').hidden=true;$('#app').innerHTML=ui.screen==='reader'?reader():ui.screen==='collection'?collections():shelf();if(ui.screen==='reader')paintText();}
function lexicalRanges(){const p=pageData(ui.book,ui.page);const list=[];for(const [term,def] of Object.entries(dictionary)){let from=0,pos;while((pos=p.text.toLowerCase().indexOf(term.toLowerCase(),from))!==-1){if(!/[a-z]/i.test(p.text[pos-1]||'')&&!/[a-z]/i.test(p.text[pos+term.length]||''))list.push({book:ui.book,page:ui.page,start:pos,end:pos+term.length,term,def});from=pos+term.length;}}return list;}
function same(a,b){return a&&b&&a.book===b.book&&a.page===b.page&&a.start===b.start&&a.end===b.end;}
function contains(a,b){return a.book===b.book&&a.page===b.page&&a.start<=b.start&&a.end>=b.end;}
function overlaps(a,b){return a.book===b.book&&a.page===b.page&&a.start<b.end&&b.start<a.end;}
function identity(r){return `${r.book}:${r.page}:${r.start}:${r.end}`;}
function paintText(){
  const host=$('#paragraphs');if(!host)return;const p=pageData(ui.book,ui.page), lex=lexicalRanges(),s=ui.selection;
  host.innerHTML=p.paragraphs.map((part,index)=>{const cuts=new Set([part.start,part.end]);for(const r of [...data.records,...data.notes,...lex,...(s?[s]:[])])if(r.book===ui.book&&r.page===ui.page&&overlaps(r,{...part,book:ui.book,page:ui.page})){cuts.add(Math.max(part.start,r.start));cuts.add(Math.min(part.end,r.end));}const positions=[...cuts].sort((a,b)=>a-b);
    const spans=positions.slice(0,-1).map((start,i)=>{const end=positions[i+1],chunk={book:ui.book,page:ui.page,start,end},l=lex.find(r=>r.start<=start&&r.end>=end),marked=data.records.some(r=>r.kind==='excerpt'&&overlaps(r,chunk)),wordSaved=data.records.some(r=>r.kind==='word'&&overlaps(r,chunk)),note=data.notes.some(r=>overlaps(r,chunk));
      const show=l&&l.end===end&&(data.retained[identity(l)]||(!data.feedback[identity(l)]&&data.density>0&&lex.indexOf(l)<(data.density===2?1:data.density===4?2:Infinity)));
      return `<span data-start="${start}" data-end="${end}" class="${marked?'marked ':''}${s&&overlaps(s,chunk)?'selected ':''}${wordSaved?'word-saved ':''}${note?'has-note ':''}${l?'lexical':''}" ${l?`data-lex="${l.start}"`:''} ${show?`data-gloss="〈${escape(l.def.gloss)}〉"`:''}>${escape(p.text.slice(start,end))}</span>`;}).join('');
    return `<section class="paragraph-wrap"><p class="passage" data-paragraph="${index}" data-base="${part.start}" style="font-size:${data.font}px">${spans}</p><div class="paragraph-tools"><button data-action="select-paragraph" data-index="${index}">选择这一段</button></div></section>`;}).join('');
  const count=$('.dock .count');if(count)count.textContent=data.records.filter(r=>r.book===ui.book).length||'';
}
function hideSelectionUI(){for(const name of ['#selection-tools','#handle-start','#handle-end'])$(name).hidden=true;}
function clearSelection(){ui.selection=null;ui.more=false;window.getSelection()?.removeAllRanges();hideSelectionUI();if(ui.screen==='reader')paintText();}
function offsetOf(node,offset){
  const el=node.nodeType===3?node.parentElement:node,p=el?.closest('.passage');if(!p)return null;
  const range=document.createRange();range.selectNodeContents(p);try{range.setEnd(node,offset);}catch{return null;}return Number(p.dataset.base)+range.toString().length;
}
function selectNative(){
  if(ui.screen!=='reader'||drag||$('#dialog').open||ui.panel||!$('#wordcard').hidden)return;
  const s=window.getSelection();if(!s||s.isCollapsed)return;
  const a=offsetOf(s.anchorNode,s.anchorOffset),b=offsetOf(s.focusNode,s.focusOffset);if(a==null||b==null||a===b)return;
  ui.selection={book:ui.book,page:ui.page,start:Math.min(a,b),end:Math.max(a,b)};ui.more=false;s.removeAllRanges();paintText();showSelection();
}
function rangeAt(start,end){
  const spans=[...document.querySelectorAll('.passage span[data-start]')];let a=spans.find(x=>Number(x.dataset.start)<=start&&Number(x.dataset.end)>start),b=[...spans].reverse().find(x=>Number(x.dataset.start)<end&&Number(x.dataset.end)>=end);
  if(!a||!b)return null;const r=document.createRange();r.setStart(a.firstChild,start-Number(a.dataset.start));r.setEnd(b.firstChild,end-Number(b.dataset.start));return r;
}
function showSelection(){
  const s=ui.selection;if(!s||ui.screen!=='reader'||ui.panel||!$('#wordcard').hidden){hideSelectionUI();return;}
  const r=rangeAt(s.start,s.end);if(!r)return;const rects=[...r.getClientRects()].filter(x=>x.width&&x.height);if(!rects.length)return;
  const exact=data.records.some(x=>x.kind==='excerpt'&&contains(x,s));
  $('#selection-tools').innerHTML=`<button data-action="highlight">${exact?'删除划线':'划线'}</button><button data-action="note">记一笔</button><button data-action="existing" data-name="翻译所选文字">翻译</button><button data-action="existing" data-name="语法分析">语法</button><button data-action="selection-more" aria-label="更多选区操作" aria-expanded="${ui.more}">···</button><button data-action="clear-selection" aria-label="取消选区">×</button>${ui.more?'<div class="extra"><button data-action="lookup">查词 / 表达</button><button data-action="existing" data-name="核对原版">核对原版</button><button data-action="bookmark">在选区加书签</button><button data-action="existing" data-name="朗读选区">朗读选区</button></div>':''}`;
  const bar=$('#selection-tools');bar.hidden=false;const first=rects[0],last=rects.at(-1),w=bar.offsetWidth,h=bar.offsetHeight;
  bar.style.left=Math.max(12,Math.min(innerWidth-w-12,first.left+(Math.min(r.getBoundingClientRect().width,600)-w)/2))+'px';
  let y=first.top-h-16;if(y<40)y=last.bottom+20;if(y+h>innerHeight-12)y=innerHeight-h-12;bar.style.top=Math.max(12,y)+'px';
  for(const [name,box,x] of [['start',first,first.left],['end',last,last.right]]){const handle=$(`#handle-${name}`);handle.hidden=box.bottom<0||box.top>innerHeight;handle.style.left=Math.max(0,Math.min(innerWidth-18,x-9))+'px';handle.style.top=(name==='start'?box.top:box.bottom-24)+'px';}
}
function setSelection(r){ui.selection=clone(r);window.getSelection()?.removeAllRanges();paintText();showSelection();}
function highlight(){const s=clone(ui.selection);if(!s)return;const before=clone(data.records.filter(r=>r.book===s.book&&r.page===s.page&&r.kind==='excerpt'));const exact=data.records.find(r=>r.kind==='excerpt'&&contains(r,s));
  if(exact)data.records=data.records.filter(r=>r.id!==exact.id);
  else {let range=clone(s),hits=[];do{hits=data.records.filter(r=>r.kind==='excerpt'&&overlaps(r,range));const next={...range,start:Math.min(range.start,...hits.map(r=>r.start)),end:Math.max(range.end,...hits.map(r=>r.end))};if(same(range,next))break;range=next;}while(true);
    const record=baseRecord('excerpt',range);record.references=hits.map(r=>({quote:r.quote,range:[r.start,r.end],meaning:r.meaning,meaningSource:r.meaningSource,mine:r.mine,references:r.references,history:r.history}));data.records=data.records.filter(r=>!hits.some(h=>h.id===r.id));data.records.push(record);ui.selection=range;
  }save();paintText();showSelection();toast(exact?'已删除整条划线；笔记和词语收藏保留':'已划线；可以直接删除整条',()=>{data.records=data.records.filter(r=>!(r.book===s.book&&r.page===s.page&&r.kind==='excerpt')).concat(before);ui.selection=s;save();paintText();showSelection();});
}
function showPanel(name,body){ui.panel=name;hideSelectionUI();$('#wordcard').hidden=true;$('#panel').innerHTML=`<header><h2>${escape(name)}</h2><button class="close" data-action="close-panel" aria-label="关闭面板">×</button></header>${body}`;$('#panel').hidden=false;$('#panel-shade').hidden=false;}
function closePanel(){ui.panel=null;$('#panel').hidden=true;$('#panel-shade').hidden=true;ui.note=null;showSelection();}
function showCollection(){ui.filter='all';showPanel('本书收藏',`<p class="muted">${escape(pageData(ui.book,ui.page).book.title)}</p>${filters(ui.book)}${recordCards(ui.book)}`);}
function showNotes(all=false){const notes=data.notes.filter(n=>all||n.book===ui.book);showPanel(all?'全部笔记':'本书笔记',`<p class="muted">想法独立保存，删除划线不会带走它。</p><div class="records spaced">${notes.map(n=>`<section class="record"><small>${escape(n.bookTitle)}</small><p class="quote">${escape(n.quote)}</p><p class="note-text">${escape(n.body)}</p><div class="actions"><button data-action="edit-note" data-id="${n.id}">编辑</button><button data-action="remove-note" data-id="${n.id}">删除笔记</button></div></section>`).join('')||'<div class="empty">选中文字后，记下第一条想法。</div>'}</div>`);}
function editNote(n){if(!n){if(!ui.selection)return;n={...baseRecord('note',ui.selection),body:''};}ui.note=n;
  showPanel('记一笔',`<div class="original">${escape(n.quote)}</div><textarea id="note-body" aria-label="我的想法" placeholder="这段文字让你想到了什么？">${escape(n.body)}</textarea><div id="save-status" class="autosave">${n.body?'已保存':'输入即自动保存'}</div><p class="source spaced">笔记独立保留，取消收藏不会删除这条想法。</p>`);ui.note=n;$('#note-body').focus();
}
function openDialog(title,body){$('#dialog').innerHTML=`<header><h2>${escape(title)}</h2><button data-action="close-dialog" class="close" aria-label="关闭弹窗">×</button></header>${body}`;if(!$('#dialog').open)$('#dialog').showModal();}
function preview(r){if(!r)return;pending=r;let text;
  if(r.unavailable){text=`<div class="notice">原书已不可定位。下面保留收藏时的引用，不会跳到另一段文字。</div><p class="quote">${escape(r.quote)}</p>`;}
  else {const p=sourceOf(r),a=Math.max(0,r.start-160),b=Math.min(p.text.length,r.end+200);text=`<p class="quote">${a?'…':''}${escape(p.text.slice(a,r.start))}<mark>${escape(r.quote)}</mark>${escape(p.text.slice(r.end,b))}${b<p.text.length?'…':''}</p>`;}
  openDialog('原文预览',`<p class="source">${escape(r.bookTitle)}${r.unavailable?'':` · 第 ${r.page+1} 节`}</p>${text}<p class="notice">关闭后回到${ui.screen==='reader'?'本书收藏与当前阅读现场':ui.screen==='collection'?'词句收藏':'书架'}，续读位置不变。</p><div class="actions spaced">${!r.unavailable?'<button class="primary" data-action="continue-source">从这里继续读 →</button>':''}<button class="btn" data-action="close-dialog">关闭预览</button></div>`);
}
function openBook(book,page=null,range=null){closePanel();$('#dialog').close();ui.word=null;ui.selection=range?clone(range):null;ui.screen='reader';ui.book=book;ui.page=page??data.resume[book]??0;ui.focus=true;data.resume[book]=ui.page;save();render();window.scrollTo(0,0);if(range){paintText();showSelection();}}
function wordDefinition(r){const t=quote(r);let found=Object.entries(dictionary).find(([term])=>term.toLowerCase()===t.toLowerCase());const def=found?clone(found[1]):{gloss:'暂无可靠释义',senses:['这段选文暂无预设词典结果。'],context:'原型只为指定示例提供语境解释，不伪造任意选文的释义。',unknown:true};if(t.toLowerCase()==='bank'&&sourceOf(r).text.slice(r.start,r.start+50).includes('deposit'))def.context='这里出现 deposit a cheque，bank 在此处指银行。';return def;}
function contextFor(r){const p=sourceOf(r);const i=p.paragraphs.findIndex(x=>x.start<=r.start&&x.end>=r.start);return p.paragraphs.slice(Math.max(0,i-1),i+2).map(x=>x.text).join('\n\n');}
function cacheKey(r){return `${identity(r)}:demo-text-v1:${contextFor(r)}`;}
function showWord(r,point){ui.word=clone(r);ui.selection=clone(r);hideSelectionUI();paintText();if(point)wordPoint=point;renderWord();}
function renderWord(){
  const r=ui.word;if(!r)return;const def=wordDefinition(r),saved=data.records.find(x=>x.kind==='word'&&same(x,r)),cached=data.cache[cacheKey(r)],stateKey=identity(r),title=quote(r);
  $('#wordcard').innerHTML=`<div class="row between"><span class="pill">预设词典 · 通用释义</span><button class="close" data-action="close-word" aria-label="关闭词卡">×</button></div><h2>${escape(title)}</h2>${def.missing?'<div class="notice">可靠中文释义暂缺，先提供已有英文。</div>':''}${def.senses.map(s=>`<div class="definition">${escape(s)}</div>`).join('')}<p class="source">演示义项 · 不能视为当前语境已确定</p><div class="independent"><button data-action="save-word" class="${saved?'active':''}">${saved?'已收藏词语 ✓':'收藏词语'}</button><button data-action="feedback" class="${data.feedback[stateKey]?'active':''}">${data.feedback[stateKey]?'已掌握 ✓':'已掌握'}</button><button data-action="retain" class="${data.retained[stateKey]?'active':''}">${data.retained[stateKey]?'已保留注释 ✓':'保留注释'}</button></div>${cached?`<section class="context-box"><div class="row between"><b>这里的意思</b><span class="pill">已保存 · 预设 AI</span></div><p style="margin-top:9px">${escape(cached.text)}</p><div class="actions"><button data-action="explain-again">重新解释</button>${saved&&saved.meaning!==cached.text?'<button data-action="adopt-preview">更新收藏解释</button>':''}</div></section>`:`<button class="btn spaced" data-action="explain" ${def.unknown?'disabled':''}>解释这里的意思</button><p class="source" style="margin-top:8px">本原型展示预设解释，不调用模型。</p>`}${saved?`<div class="actions spaced"><button data-action="record-edit" data-id="${saved.id}">我的释义 / 已存解释</button></div>`:''}`;
  $('#wordcard').hidden=false;positionWordCard();
}
function positionWordCard(){const el=$('#wordcard');if(el.hidden)return;const w=el.offsetWidth,h=el.offsetHeight;el.style.left=Math.max(12,Math.min(innerWidth-w-12,wordPoint.x+14))+'px';el.style.top=Math.max(15,Math.min(innerHeight-h-15,wordPoint.y-25))+'px';}
function recordEdit(r){pending=r;openDialog('收藏详情',`<p class="quote">${escape(r.quote)}</p><p class="source">${escape(r.bookTitle)}</p>${r.meaning?`<hr class="divider"><h3>已保存的解释</h3><p>${escape(r.meaning)}</p><p class="source">${escape(r.meaningSource)}</p>`:''}<label for="my-meaning" class="spaced" style="display:block">我的释义</label><textarea id="my-meaning" placeholder="只记录你对这一次用法的理解">${escape(r.mine||'')}</textarea><span id="meaning-status" class="autosave">输入即自动保存</span>${r.history?.length?`<details class="spaced"><summary>此前的解释 · ${r.history.length}</summary>${r.history.map(h=>`<p class="spaced">${escape(h.meaning)}<br><small>${escape(h.source)}</small></p>`).join('')}</details>`:''}${r.references?.length?`<details class="spaced"><summary>合并前的片段与解释</summary>${r.references.map(ref=>`<p class="quote">${escape(ref.quote)}</p><p>${escape(ref.meaning||ref.mine||'此片段没有单独解释')}</p>`).join('')}</details>`:''}`);}
function refreshCollections(){if(ui.screen==='collection')render();else if(ui.panel==='本书收藏')showPanel('本书收藏',`${filters(ui.book)}${recordCards(ui.book)}`);else if(ui.screen==='shelf')render();if(ui.screen==='reader')paintText();}
function removeRecord(recordId){const r=data.records.find(x=>x.id===recordId);if(!r)return;data.records=data.records.filter(x=>x.id!==recordId);save();refreshCollections();toast('已取消这条收藏；笔记保持不变',()=>{if(!data.records.some(x=>x.id===r.id))data.records.push(r);save();refreshCollections();});}
function manage(){openDialog('导出 / 清理',`<p class="muted">只操作独立演示资料；原书不在清理范围内。</p><div class="settings spaced"><label>范围 <select id="manage-book"><option value="all">全部书籍</option>${books.map(b=>`<option value="${b.id}">${escape(b.title)}</option>`).join('')}</select></label><label><input id="manage-records" type="checkbox" checked> 词句收藏</label><label><input id="manage-notes" type="checkbox"> 个人笔记</label><label><input id="manage-feedback" type="checkbox"> 掌握反馈</label></div><div class="actions spaced"><button class="primary" data-action="export">预览并导出演示资料</button><button class="danger" data-action="clean">清理所选资料</button></div>`);}
function getManage(){return {book:$('#manage-book').value,records:$('#manage-records').checked,notes:$('#manage-notes').checked,feedback:$('#manage-feedback').checked};}
function exportPayload(m){const inScope=x=>m.book==='all'||x.book===m.book;return {prototype:true,format:'prototype-only-not-production-migration',records:m.records?data.records.filter(inScope):[],notes:m.notes?data.notes.filter(inScope):[],feedback:m.feedback?Object.fromEntries(Object.entries(data.feedback).filter(([k])=>m.book==='all'||k.startsWith(m.book+':'))):{}};}
function help(){openDialog('这次体验什么',`<span class="pill">Q1–Q24 已确认 · 等待视觉验收</span><ol class="help-list"><li>打开第一篇，拖选正文的一部分或跨段文字，点“划线”；再选重叠范围，观察合并和“删除划线”。</li><li>点带注释的词，分别试“收藏词语”“已掌握”“保留注释”；三项互不替代。</li><li>点击顶部“···”，底部书签形图标查看本书收藏。回到书架才会看到所有书的词句。</li><li>在收藏里先预览原文，再关闭；只有“从这里继续读”才改变续读位置。</li><li>回书架看今天的一条，试“换一条”、暂不推荐与关闭。</li></ol><div class="notice">本原型只保存自身演示资料。词典与 AI 为预设内容，不调用模型、不产生费用；原版、翻译、语法、语音保留入口说明。篇段切换不代表正式分页或翻页性能。真实质量、缓存、迁移和设备性能在实现阶段另验。</div><div class="actions spaced"><button class="primary" data-action="read" data-book="quiet">开始体验 →</button></div>`);}

document.addEventListener('pointerup',e=>{if(drag)return;if(e.target.closest('.passage'))setTimeout(selectNative,0);});
document.addEventListener('keyup',e=>{if(e.key==='Shift')selectNative();});
document.addEventListener('pointerdown',e=>{
  if(e.target.closest('#selection-tools button,#wordcard button'))e.preventDefault();
  if(e.target.closest('#panel-shade')){closePanel();return;}
  if(ui.screen==='reader'&&!e.target.closest('#selection-tools,.handle,#wordcard,#panel,#dialog,.dock,.reader-top,.topzone,.paragraph-tools')){
    if(!$('#wordcard').hidden){$('#wordcard').hidden=true;ui.word=null;}
    if(ui.selection){ui.selection=null;hideSelectionUI();document.querySelectorAll('.selected').forEach(x=>x.classList.remove('selected'));}
  }
});
document.addEventListener('click',e=>{
  const lex=e.target.closest('.lexical');if(lex&&!window.getSelection()?.toString()&&!ui.selection&&!ui.panel){const r=lexicalRanges().find(x=>x.start===Number(lex.dataset.lex));if(r)showWord(r,{x:e.clientX,y:e.clientY});return;}
  const b=e.target.closest('[data-action]');if(!b||b.disabled)return;const action=b.dataset.action;
  switch(action){
    case 'shelf':closePanel();$('#dialog').close();ui.word=null;ui.selection=null;ui.screen='shelf';render();window.scrollTo(0,0);break;
    case 'global':closePanel();ui.word=null;ui.selection=null;ui.screen='collection';ui.filter='all';ui.bookFilter='all';render();window.scrollTo(0,0);break;
    case 'read':openBook(b.dataset.book);break;
    case 'help':help();break;
    case 'tools':ui.focus=!ui.focus;$('.reading')?.classList.toggle('focus',ui.focus);showSelection();break;
    case 'previous':case 'next':openBook(ui.book,Math.max(0,Math.min(1,ui.page+(action==='next'?1:-1))));break;
    case 'select-paragraph':{const p=pageData(ui.book,ui.page).paragraphs[Number(b.dataset.index)];setSelection({book:ui.book,page:ui.page,start:p.start,end:p.end});break;}
    case 'clear-selection':clearSelection();break;
    case 'highlight':highlight();break;
    case 'selection-more':ui.more=!ui.more;showSelection();break;
    case 'note':editNote();break;
    case 'edit-note':editNote(data.notes.find(n=>n.id===b.dataset.id));break;
    case 'remove-note':{const n=data.notes.find(x=>x.id===b.dataset.id);data.notes=data.notes.filter(x=>x.id!==n.id);save();showNotes(ui.screen!=='reader');toast('已删除笔记；划线保持不变',()=>{data.notes.push(n);save();showNotes(ui.screen!=='reader');});break;}
    case 'all-notes':showNotes(true);break;
    case 'lookup':if(ui.selection)showWord(ui.selection,{x:innerWidth/2,y:160});break;
    case 'close-word':$('#wordcard').hidden=true;ui.word=null;showSelection();break;
    case 'save-word':{const r=ui.word,existing=data.records.find(x=>x.kind==='word'&&same(x,r));if(existing)data.records=data.records.filter(x=>x.id!==existing.id);else{const n=baseRecord('word',r),cached=data.cache[cacheKey(r)];n.meaning=cached?.text||wordDefinition(r).gloss;n.meaningSource=cached?'预设 AI · 首次保存':'预设基础词典';data.records.push(n);}save();renderWord();paintText();toast(existing?'已取消词语收藏':'已收藏这次用法；其他语境不变',()=>{if(existing)data.records.push(existing);else data.records=data.records.filter(x=>!(x.kind==='word'&&same(x,r)));save();paintText();if(ui.word)renderWord();});break;}
    case 'feedback':case 'retain':{const k=identity(ui.word),field=action==='feedback'?'feedback':'retained',old=data[field][k];if(data[field][k])delete data[field][k];else data[field][k]=true;save();renderWord();paintText();toast(action==='feedback'?'已更新这次用法的理解反馈':'已更新这处注释的保留状态',()=>{if(old===undefined)delete data[field][k];else data[field][k]=old;save();paintText();if(ui.word)renderWord();});break;}
    case 'explain':case 'explain-again':{const r=ui.word;data.cache[cacheKey(r)]={text:wordDefinition(r).context,context:contextFor(r),source:'预设模型',at:Date.now()};save();renderWord();toast(action==='explain-again'?'已展示重新解释状态；原型没有真实请求':'已展示预设解释，再次打开可复用');break;}
    case 'adopt-preview':{const r=data.records.find(x=>x.kind==='word'&&same(x,ui.word));pending=r;openDialog('先查看，再采用',`<p class="source">${escape(r.quote)} · ${escape(r.bookTitle)}</p><h3 class="spaced">当前保存</h3><p>${escape(r.meaning)}</p><h3 class="spaced">预设新解释</h3><p>${escape(data.cache[cacheKey(ui.word)].text)}</p><div class="actions spaced"><button class="primary" data-action="adopt">采用新解释</button><button class="btn" data-action="close-dialog">保留原解释</button></div>`);break;}
    case 'adopt':{const r=pending;r.history.push({meaning:r.meaning,source:r.meaningSource});r.meaning=data.cache[cacheKey(ui.word)].text;r.meaningSource='预设 AI · 主动采用';save();$('#dialog').close();renderWord();toast('已采用；此前解释仍可回看');break;}
    case 'record-edit':recordEdit(data.records.find(x=>x.id===b.dataset.id));break;
    case 'source':preview(data.records.find(x=>x.id===b.dataset.id));break;
    case 'continue-source':if(pending&&!pending.unavailable)openBook(pending.book,pending.page,pending);break;
    case 'remove-record':removeRecord(b.dataset.id);break;
    case 'filter':ui.filter=b.dataset.filter;if(ui.screen==='collection')render();else showPanel('本书收藏',`${filters(ui.book)}${recordCards(ui.book)}`);break;
    case 'close-panel':closePanel();break;
    case 'close-dialog':$('#dialog').close();break;
    case 'existing':openDialog(b.dataset.name,`<p>正式阅读器已有的“${escape(b.dataset.name)}”继续保留。</p><p class="notice spaced">本轮原型只验收新增的词句收藏与释义交互，不执行 AI、语音或 PDF 服务。</p>${ui.selection?`<p class="quote">${escape(quote(ui.selection))}</p>`:''}`);break;
    case 'bookmark':{const r=clone(ui.selection);data.bookmarks.push({...r,id:id(),quote:quote(r)});save();toast('书签已保存在本书目录中');break;}
    case 'delete-bookmark':data.bookmarks=data.bookmarks.filter(x=>x.id!==b.dataset.id);save();dock('toc');break;
    case 'dock':dock(b.dataset.name);break;
    case 'goto':openBook(ui.book,Number(b.dataset.page));break;
    case 'density':data.density=Number(b.dataset.density);save();paintText();document.querySelectorAll('[data-action="density"]').forEach(btn=>{const active=Number(btn.dataset.density)===data.density;btn.setAttribute('aria-pressed',active);btn.classList.toggle('active',active);});toast('辅助偏好已自动保存');break;
    case 'font':data.font=Math.max(19,Math.min(31,data.font+Number(b.dataset.delta)));save();paintText();break;
    case 'hide-revisit':data.revisit.hidden=true;save();render();break;
    case 'show-revisit':data.revisit.hidden=false;save();if(ui.screen==='collection'){ui.screen='shelf';}render();break;
    case 'next-revisit':if(daily(true))render();else toast('没有其他可展示的收藏了。');break;
    case 'snooze':data.revisit.snooze[b.dataset.id]=Date.now()+30*864e5;data.revisit.current=null;save();render();toast('30 天内不自动展示这条；收藏仍然保留');break;
    case 'manage':manage();break;
    case 'export':{const p=exportPayload(getManage());pending=p;openDialog('导出内容预览',`<p class="notice">只导出选择的演示记录；本格式用于看清内容范围，不能导入正式产品。</p><pre>${escape(JSON.stringify(p,null,2))}</pre><div class="actions"><button class="btn" data-action="download" data-format="txt">下载可读文本</button><button class="btn" data-action="download" data-format="json">下载演示 JSON</button></div>`);break;}
    case 'download':{const format=b.dataset.format,content=format==='json'?JSON.stringify(pending,null,2):['Wise Reader V1.1 原型资料（非正式迁移格式）',...pending.records.map(r=>`${r.quote}\n来源：${r.bookTitle}\n上下文：${r.context}\n解释：${r.meaning||'无'}\n解释来源：${r.meaningSource||'无'}\n我的释义：${r.mine||'无'}`),...pending.notes.map(n=>`笔记：${n.body}\n引用：${n.quote}\n来源：${n.bookTitle}`),`所选掌握反馈：${JSON.stringify(pending.feedback)}`].join('\n\n');const url=URL.createObjectURL(new Blob([content],{type:format==='json'?'application/json':'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`wise-reader-prototype.${format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;}
    case 'clean':{const m=getManage();if(!m.records&&!m.notes&&!m.feedback){toast('先选择需要清理的资料');break;}pending=m;const p=exportPayload(m);openDialog('确认清理范围',`<p>将永久清理${m.book==='all'?'全部书籍':escape(books.find(b=>b.id===m.book).title)}的：收藏 ${p.records.length} 条、笔记 ${p.notes.length} 条、反馈 ${Object.keys(p.feedback).length} 条。</p><p class="notice spaced">只影响勾选的演示资料，原书、未勾选的记录和显式保留注释不变。</p><div class="actions spaced"><button class="danger btn" data-action="confirm-clean">确认清理</button><button class="btn" data-action="close-dialog">取消</button></div>`);break;}
    case 'confirm-clean':{const m=pending,keep=x=>m.book!=='all'&&x.book!==m.book;if(m.records)data.records=data.records.filter(keep);if(m.notes)data.notes=data.notes.filter(keep);if(m.feedback)data.feedback=Object.fromEntries(Object.entries(data.feedback).filter(([k])=>m.book!=='all'&&!k.startsWith(m.book+':')));undo=null;$('#toast').hidden=true;save();$('#dialog').close();refreshCollections();break;}
    case 'reset':openDialog('重置独立演示',`<p>清除本原型的练习操作，恢复三条预置收藏。正式阅读器资料不受影响。</p><button class="btn spaced" data-action="confirm-reset">确认重置演示</button>`);break;
    case 'confirm-reset':data=defaults();save();ui.screen='shelf';ui.selection=null;ui.word=null;closePanel();$('#dialog').close();$('#toast').hidden=true;undo=null;render();break;
    case 'undo':{const fn=undo;undo=null;if(fn){fn();toast('已恢复这次操作前的状态');}break;}
    case 'hide-toast':$('#toast').hidden=true;break;
  }
});
function dock(name){
  const title={toc:'目录与书签',notes:'本书笔记',collections:'本书收藏',progress:'阅读进度',style:'样式',font:'字体',more:'更多'}[name];
  if(ui.panel===title){closePanel();return;}if(name==='collections'){showCollection();return;}if(name==='notes'){showNotes();return;}
  if(name==='toc'){showPanel(title,`<h3>目录</h3>${books.find(b=>b.id===ui.book).pages.map((p,i)=>`<button class="nav-item ${i===ui.page?'active':''}" data-action="goto" data-page="${i}">${i+1} · ${escape(p[0])}</button>`).join('')}<h3 class="spaced">书签</h3>${data.bookmarks.filter(r=>r.book===ui.book).map(r=>`<div class="record spaced"><p>${escape(r.quote)}</p><div class="actions"><button data-action="goto" data-page="${r.page}">前往</button><button data-action="delete-bookmark" data-id="${r.id}">取消书签</button></div></div>`).join('')||'<p class="muted spaced">暂无书签</p>'}`);return;}
  if(name==='font'){showPanel(title,'<p class="muted">调整原型正文字号。</p><div class="actions spaced"><button class="btn" data-action="font" data-delta="-2">A−</button><button class="btn" data-action="font" data-delta="2">A＋</button></div>');return;}
  if(name==='progress'){showPanel(title,`<p>第 ${ui.page+1} / 2 节</p><p class="notice spaced">本原型以篇段演示续读状态；正式阅读器保留原有分页、进度拖动和书内“回到刚才”。</p>${books.find(b=>b.id===ui.book).pages.map((p,i)=>`<button class="nav-item" data-action="goto" data-page="${i}">${escape(p[0])}</button>`).join('')}`);return;}
  if(name==='style'){showPanel(title,`<h3>辅助密度</h3><div class="actions spaced">${[[0,'原文'],[2,'轻'],[4,'适中'],[8,'多']].map(([n,label])=>`<button data-action="density" data-density="${n}" aria-pressed="${data.density===n}" class="btn ${data.density===n?'active':''}">${label}</button>`).join('')}</div><p class="source spaced">调整即保存，明确保留的注释始终显示。</p>`);return;}
  showPanel(title,'<button class="nav-item" data-action="help">原型体验说明</button><p class="notice spaced">翻译、语法、朗读、核对原版仍从选区进入。本轮只展示入口，不调用真实服务。</p>');
}
document.addEventListener('input',e=>{
  if(e.target.id==='note-body'&&ui.note){ui.note.body=e.target.value;const i=data.notes.findIndex(n=>n.id===ui.note.id);if(ui.note.body.trim()){if(i<0)data.notes.push(ui.note);else data.notes[i]=ui.note;}else if(i>=0)data.notes.splice(i,1);save();$('#save-status').textContent=ui.note.body.trim()?'已保存 ✓':'空白笔记不会保存';paintText();}
  if(e.target.id==='my-meaning'&&pending?.id){pending.mine=e.target.value;save();$('#meaning-status').textContent='已保存 ✓';}
});
document.addEventListener('change',e=>{if(e.target.id==='book-filter'){ui.bookFilter=e.target.value;render();}});
$('#dialog').addEventListener('click',e=>{if(e.target!==$('#dialog'))return;const r=$('#dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#dialog').close();});
$('#dialog').addEventListener('close',()=>{if(ui.screen==='collection'||ui.screen==='shelf')render();else if(ui.panel==='本书收藏')showPanel('本书收藏',`${filters(ui.book)}${recordCards(ui.book)}`);else if(ui.word)renderWord();});
$('#wordcard').addEventListener('toggle',positionWordCard,true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#dialog').open){if(ui.panel)closePanel();else if(!$('#wordcard').hidden){$('#wordcard').hidden=true;ui.word=null;showSelection();}else clearSelection();}});
for(const name of ['start','end']){
  const h=$(`#handle-${name}`);h.addEventListener('pointerdown',e=>{if(!ui.selection)return;e.preventDefault();h.setPointerCapture(e.pointerId);drag={name,pointer:e.pointerId};$('#selection-tools').hidden=true;});
  h.addEventListener('pointermove',e=>{if(!drag)return;const caret=document.caretPositionFromPoint?.(e.clientX,e.clientY);const fallback=!caret&&document.caretRangeFromPoint?.(e.clientX,e.clientY);const pos=caret?offsetOf(caret.offsetNode,caret.offset):fallback?offsetOf(fallback.startContainer,fallback.startOffset):null;if(pos==null)return;const s=ui.selection;if(name==='start')s.start=Math.min(pos,s.end-1);else s.end=Math.max(pos,s.start+1);paintText();showSelection();$('#selection-tools').hidden=true;});
  const end=()=>{drag=null;showSelection();};h.addEventListener('pointerup',end);h.addEventListener('pointercancel',end);
  h.addEventListener('keydown',e=>{if(!ui.selection||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const d=e.key==='ArrowLeft'?-1:1,s=ui.selection;if(name==='start')s.start=Math.max(0,Math.min(s.end-1,s.start+d));else s.end=Math.max(s.start+1,Math.min(pageData(ui.book,ui.page).text.length,s.end+d));paintText();showSelection();});
}
addEventListener('resize',()=>{showSelection();if(ui.word)renderWord();});
// Reflow/focus can scroll the document too. Dismiss only on explicit outside click,
// Escape or close; keep the card's own scrolling separate from the article.
addEventListener('scroll',showSelection,{passive:true});
save();render();
