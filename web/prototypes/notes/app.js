import { dictionary, syntax } from '../page-turn/sample.js';
const $ = (s) => document.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  directory:'<path d="M4 5h16M4 12h16M4 19h16"/>',
  notes:'<path d="M5 3h11l3 3v15H5zM8 8h8M8 12h8M8 16h5"/>',
  progress:'<path d="M3 9h5m4 0h9M3 16v2m6-2v2m6-2v2m6-2v2"/><circle cx="10" cy="9" r="2"/>',
  style:'<circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2"/>',
  font:'<path d="M4 20L12 4l8 16M7 14h10"/>', more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close:'<path d="M6 6l12 12M18 6L6 18"/>', back:'<path d="M15 5l-7 7 7 7"/>', pencil:'<path d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4"/>',
  fullscreen:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>'
};
const icon = (id) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[id]}</svg>`;
for (const b of document.querySelectorAll('[data-tool]')) b.insertAdjacentHTML('afterbegin',icon(b.dataset.tool));
for (const id of ['editor-close','selection-cancel']) $('#'+id).innerHTML=icon('close');
$('#editor-back').innerHTML=icon('back'); $('#fullscreen').innerHTML=icon('fullscreen');

const pages = [
 {chapter:1,title:'The argument and its structure',heading:'On knowledge and relations',blocks:[{id:'reasoning',text:'The reasoning of these two men did not carry conviction, since it was felt that the Absolute or Infinite does not necessarily exist outside of all relations, but can enter into various relations; and that the fact that we know things only in their relations does not mean that the knowledge so acquired is merely a relative or unreal knowledge.'}]},
 {chapter:1,title:'The argument and its structure',blocks:[{id:'distinction',text:'The question is not whether relations exist, but what follows from our knowledge of them. To know a thing through its relations is to encounter it in a particular way. It does not follow that the thing, or the knowledge we acquire, must therefore be unreal.'},{id:'attention',text:'A careful reader can keep these claims apart. The first concerns the way we come to know something; the second concerns what that knowledge is worth. A small note may preserve the distinction without interrupting the argument.'}]},
 {chapter:2,title:'What remains after reading',heading:'The traces of attention',blocks:[{id:'relative',text:'Relative does not automatically mean false. A description of the conditions under which knowledge is acquired is not, by itself, a rejection of that knowledge. The sentence asks us to keep those claims apart. When we return to a passage, the original words should remain close to the questions we asked about them.'},{id:'traces',text:'A note need not be an exhaustive account of everything we read. It can hold a doubt, a connection, or a distinction that would otherwise slip away. The passage remains the point of return.'}]},
 {chapter:2,title:'What remains after reading',blocks:[{id:'return',text:'When the book is closed, the notes remain as invitations to return. They are not a substitute for the experience of reading. They are the small, durable traces of attention: a word understood, a sentence questioned, and a thought that still deserves another look.'},{id:'question',text:'The practical measure of a reading tool is modest. Does it make the next paragraph easier to approach? Does it preserve the place where we stopped? Can we record a thought without losing the thread? Every added control must earn its place through these questions.'}]}
];
const blocks = pages.flatMap((p,page)=>p.blocks.map(b=>({...b,page,chapter:p.chapter})));
const blockById = id => blocks.find(b=>b.id===id);
function seed(){
 const make=(id,block,quote,body)=>({id,kind:'quote',block,start:blockById(block).text.indexOf(quote),end:blockById(block).text.indexOf(quote)+quote.length,quote,body,chapter:blockById(block).chapter,created:Date.now(),demo:true});
 return {notes:[make('demo-conviction','reasoning','did not carry conviction','这里评价的是论证的说服力，而不是两个人的信念。'),make('demo-relative','relative','Relative does not automatically mean false.','相对不等于虚假。回看时，需要把认识的获得方式和真实性分开。')],drafts:[],page:0};
}
const session=new URLSearchParams(location.search).get('session')||'experience';
const key='wise-reader-notes-prototype-v1:'+session;
let state;
try {state=JSON.parse(localStorage.getItem(key))||seed();} catch {state=seed();}
if(!Array.isArray(state.notes)||!Array.isArray(state.drafts)) state=seed();
let page=Math.min(3,Math.max(0,state.page||0)),chrome=false,tool=null,filter='book',selection=null,edit=null,previewBlock=null,flash=null,returnPage=null,saveTimer=null,toastTimer=null,simulateFailure=false;
state.bookmarks ||= [];
let translation=null,utterance=null;
const grammarKnown=new Set(),grammarOpen=new Set();
const double=()=>innerWidth>=1050;
const visiblePages=()=>translation?[blockById(translation.block).page]:double()?[page,page+1].filter(i=>i<pages.length):[page];
const alignPage=p=>double()?Math.floor(p/2)*2:p;
page=alignPage(page);
function persist(){state.page=page;localStorage.setItem(key,JSON.stringify(state));}
function toast(text,label,run){clearTimeout(toastTimer);$('#toast span').textContent=text;const b=$('#toast button');b.hidden=!label;b.textContent=label||'';b.onclick=()=>{run?.();$('#toast').hidden=true;};$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,label?10000:5500);}
function setChrome(open){chrome=open;$('#chrome').hidden=!open;$('#show-tools').hidden=open;$('#show-tools').setAttribute('aria-expanded',String(open));}
function badge(){const b=$('#note-count');b.textContent=state.notes.length||'';b.hidden=!state.notes.length&&!state.drafts.length;b.classList.toggle('draft',!!state.drafts.length);const button=$('[data-tool="notes"]');button.setAttribute('aria-label',`阅读笔记，${state.notes.length}条${state.drafts.length?'，有未保存草稿':''}`);}
function renderInk(b){
 const ns=state.notes.filter(n=>n.kind==='quote'&&n.block===b.id);
 const focus=edit?.kind==='quote'&&edit.block===b.id?edit:selection?.block===b.id?selection:null;
 const fl=flash?.block===b.id?flash:null;
 const bounds=[0,b.text.length,...ns.flatMap(n=>[n.start,n.end]),...(focus?[focus.start,focus.end]:[]),...(fl?[fl.start,fl.end]:[])].filter(n=>n>=0&&n<=b.text.length).sort((a,b)=>a-b);
 const cuts=[...new Set(bounds)];let result='';
 for(let i=0;i<cuts.length-1;i++){const a=cuts[i],z=cuts[i+1],notes=ns.filter(n=>n.start<=a&&n.end>=z),classes=[notes.length?'noted':'',focus&&focus.start<=a&&focus.end>=z?'selected-quote':'',fl&&fl.start<=a&&fl.end>=z?'jump-highlight':''].filter(Boolean).join(' ');result+=classes?`<span class="${classes}"${notes.length?` data-note-ids="${notes.map(n=>n.id).join(',')}" tabindex="0" role="button" aria-label="查看这处笔记"`:''}>${esc(b.text.slice(a,z))}</span>`:esc(b.text.slice(a,z));}
 return result;
}
function renderStage(){
 $('#spread').classList.toggle('double',double());
 $('#spread').innerHTML=visiblePages().map(i=>`<section class="leaf" aria-label="第${i+1}页" data-page="${i}"><div class="leaf-heading">${esc(pages[i].title)}</div>${pages[i].heading?`<h1>${esc(pages[i].heading)}</h1>`:''}${pages[i].blocks.map(b=>{const ns=state.notes.filter(n=>n.block===b.id&&n.kind==='quote');return `<section class="paragraph" data-block="${b.id}"><p class="source" data-source="${b.id}">${renderInk(b)}</p>${ns.length?`<button class="paragraph-note" data-open-block="${b.id}" aria-label="查看这段的${ns.length}条笔记" title="这段有${ns.length}条笔记">${icon('notes')}${ns.length>1?`<span class="small-count">${ns.length}</span>`:''}</button>`:''}<button class="paragraph-add" data-add-block="${b.id}" aria-label="记下这一段" title="记下这一段">${icon('pencil')}</button></section>`;}).join('')}</section>`).join('');
 $('#chapter-caption').textContent=`${pages[page].chapter===1?'第一章':'第二章'} · ${pages[page].title}`;
 $('#page-caption').textContent=visiblePages().map(i=>i+1).join('–')+' / 4';
 $('#return-position').hidden=returnPage===null;badge();augmentStage();
}
function place(el,rect){
 el.hidden=false;el.style.transform='none';el.style.bottom='auto';
 const safeTop=chrome?76:12,safeBottom=chrome?76:12;
 const h=Math.min(el.getBoundingClientRect().height,innerHeight-safeTop-safeBottom);
 const width=el.getBoundingClientRect().width;
 let top=rect?rect.bottom+10:innerHeight/2-h/2;
 if(top+h>innerHeight-safeBottom)top=rect&&rect.top-h-10>=safeTop?rect.top-h-10:innerHeight-safeBottom-h;
 const left=Math.min(innerWidth-width-12,Math.max(12,rect?rect.left:innerWidth/2-width/2));
 el.style.left=left+'px';el.style.top=Math.max(safeTop,top)+'px';
}
function rectOf(block){const el=$(`[data-source="${block}"]`);if(!el)return null;const r=el.getBoundingClientRect();return {left:r.left,top:r.top,bottom:Math.min(r.bottom,innerHeight-100)};}
function panelHead(title){return `<div class="panel-head"><h2>${esc(title)}</h2><button class="icon" data-close-panel aria-label="关闭面板">${icon('close')}</button></div>`;}
function locationLabel(n){return n.kind==='journal'?'全书随记':`第${n.chapter===1?'一':'二'}章 · 第${blockById(n.block).page+1}页`;}
function noteHTML(n){return `<article class="note-item" data-note="${n.id}">${n.quote?`<button class="quote excerpt" data-jump="${n.id}" title="回到这段原文">${esc(n.quote)}</button>`:''}<p class="note-body">${esc(n.body)}</p><div class="note-actions"><span class="meta">${locationLabel(n)}${n.demo?' · 示例':''}</span><button class="text-button" data-edit="${n.id}">编辑</button><button class="icon" data-note-more="${n.id}" aria-label="笔记更多操作">${icon('more')}</button></div><div class="note-more" id="more-${n.id}" hidden><button class="text-button danger" data-delete="${n.id}">删除笔记</button></div></article>`;}
function renderNotes(){
 const list=state.notes.filter(n=>filter==='book'||n.kind==='quote'&&n.chapter===pages[page].chapter).sort((a,b)=>(a.kind==='journal'?9:blockById(a.block).page)-(b.kind==='journal'?9:blockById(b.block).page)||a.start-b.start||a.created-b.created);
 $('#panel').innerHTML=panelHead(`阅读笔记 · ${state.notes.length}`)+`<div class="list-controls"><button class="filter ${filter==='book'?'active':''}" data-filter="book">这本书</button><button class="filter ${filter==='chapter'?'active':''}" data-filter="chapter">当前章</button><button class="text-button" data-new-journal>＋ 写随记</button></div>`+state.drafts.map(d=>`<div class="draft-row"><span class="meta">未保存草稿 · ${locationLabel(d)}</span><button class="text-button" data-resume="${d.id}">继续</button><button class="text-button" data-discard="${d.id}">丢弃</button></div>`).join('')+(list.length?list.map(noteHTML).join(''):`<div class="empty">${icon('notes')}<p>${filter==='chapter'?'这一章还没有笔记':'还没有笔记'}<br>选中原文，记下你的想法。</p><button class="text-button" data-start-reading>回到正文试试</button></div>`)+`<p class="list-footer">点原句回到原文，点“编辑”修改想法。记录仅保存在此原型。</p>`;
 $('#panel').setAttribute('aria-label','阅读笔记列表');
}
function renderTool(id){
 $('#panel').hidden=false;
 if(id==='notes'){renderNotes();return;}
 const titles={directory:'阅读目录',progress:'阅读进度',style:'阅读样式',font:'字体调整',more:'原型说明'};
 let body='';
 if(id==='directory')body=[0,2].map(i=>`<button class="directory-link" data-page-jump="${i}">${i===0?'一':'二'} · ${esc(pages[i].title)}</button>`).join('');
 if(id==='progress')body=`<p class="meta">拖动后松开，即跳到原文位置。</p><input id="seek" type="range" min="0" max="3" step="1" value="${page}" aria-label="阅读进度"><p class="meta">第 ${page+1} / 4 页</p>${returnPage!==null?'<button data-return class="text-button">回到刚才</button>':''}`;
 if(id==='style')body='<div class="settings-row"><button class="text-button" data-theme="paper">纸白</button><button class="text-button" data-theme="night">夜读</button></div>';
 if(id==='font')body='<div class="settings-row"><button class="text-button" data-font="20">小</button><button class="text-button" data-font="23">适中</button><button class="text-button" data-font="26">大</button></div>';
 if(id==='more')body=`<div class="help-copy"><p>这版重点体验笔记交互，保留完整选区工具，使用四页样例与两条示例笔记。</p><p>① 选中文字，点“记一笔”；也可悬停段落，点边上的笔。</p><p>② 下划线和段落外侧的笔记图标表示已有笔记；点击查看、编辑或删除。</p><p>③ 点击顶部打开工具。底部笔记图标打开列表，再点同一区域回到 banner。</p><p>④ 引用可跳回原文，“回到刚才”恢复位置。空白区域和左右方向键可翻页。</p><p>笔记与书签保存到此原型，不写入正式版。翻译与语法是固定样例或位置预览，未连接 AI；朗读使用浏览器本机语音。</p><div class="settings-row"><label for="simulate-failure">体验保存失败与草稿恢复</label><input id="simulate-failure" type="checkbox" ${simulateFailure?'checked':''}></div><button class="text-button" data-reset>恢复示例笔记</button><p><a href="/#/read/3">返回正式版阅读 ↗</a></p></div>`;
 $('#panel').innerHTML=panelHead(titles[id])+body;$('#panel').setAttribute('aria-label',titles[id]);
}
function closeTool(){tool=null;$('#panel').hidden=true;for(const b of document.querySelectorAll('[data-tool]'))b.setAttribute('aria-expanded','false');}
function openTool(id){
 stopSpeech();
 if(edit?.origin==='list'&&id==='notes'){closeEditor(false);closeTool();setChrome(true);return;}
 if(edit)closeEditor(false);
 $('#preview').hidden=true;$('#selection-menu').hidden=true;selection=null;
 if(tool===id){closeTool();return;}
 tool=id;setChrome(true);for(const b of document.querySelectorAll('[data-tool]'))b.setAttribute('aria-expanded',String(b.dataset.tool===id));renderTool(id);
}
function navigate(p,remember=false){stopSpeech();translation=null;if(remember&&returnPage===null)returnPage=page;page=alignPage(Math.min(3,Math.max(0,p)));selection=null;$('#selection-menu').hidden=true;$('#preview').hidden=true;renderStage();try{persist();}catch{} }
function jump(id){const n=state.notes.find(n=>n.id===id);if(!n||n.kind==='journal')return;navigate(blockById(n.block).page,true);flash={block:n.block,start:n.start,end:n.end};closeTool();setChrome(false);renderStage();const el=$(`[data-source="${n.block}"]`);el?.scrollIntoView({block:'nearest'});setTimeout(()=>{flash=null;if(!edit&&!selection)renderStage();},3000);}
function showPreview(block,rect){previewBlock=block;selection=null;$('#selection-menu').hidden=true;const ns=state.notes.filter(n=>n.block===block);$('#preview').innerHTML=panelHead(`这段的笔记 · ${ns.length}`)+ns.map(noteHTML).join('')+'<button class="text-button" data-add-current>＋ 再记一笔</button>';$('#preview').querySelector('[data-close-panel]').setAttribute('aria-label','关闭笔记预览');place($('#preview'),rect||rectOf(block));}
function updateEditorPosition(){if(!edit)return;if(edit.origin==='list')return;place($('#editor'),edit.rect||rectOf(edit.block));}
function setSave(text,failed=false){$('#save-state').textContent=text;$('#save-state').classList.toggle('failed',failed);$('#retry-save').hidden=!failed;}
function saveNow(){
 clearTimeout(saveTimer);if(!edit)return true;
 const body=$('#note-body').value;edit.body=body;
 if(!body.trim()){setSave(edit.isNew?'写下想法后自动保存':'内容为空，原笔记保留');state.drafts=state.drafts.filter(d=>d.id!==edit.id);try{persist();}catch{}return true;}
 const draft={...edit};delete draft.origin;delete draft.rect;
 state.drafts=state.drafts.filter(d=>d.id!==draft.id);state.drafts.push(draft);
 try {persist();if(simulateFailure)throw Error('模拟保存失败');} catch {setSave('保存失败 · 草稿已保留',true);badge();return false;}
 const saved={id:edit.id,kind:edit.kind,block:edit.block,start:edit.start,end:edit.end,quote:edit.quote,body,chapter:edit.chapter,created:edit.created,demo:false};
 const prev=state.notes.find(n=>n.id===saved.id),beforeNotes=[...state.notes],beforeDrafts=[...state.drafts];state.notes=state.notes.filter(n=>n.id!==saved.id);state.notes.push(saved);state.drafts=state.drafts.filter(d=>d.id!==saved.id);
 try{persist();}catch{state.notes=beforeNotes;state.drafts=beforeDrafts;setSave('保存失败 · 草稿已保留',true);return false;}
 edit.isNew=false;setSave('已保存到此原型 ✓');renderStage();return true;
}
function openEditor(record,origin='source',isNew=false){
 if(edit)closeEditor(false);$('#preview').hidden=true;$('#selection-menu').hidden=true;selection=null;closeTool();
 edit={...record,origin,isNew};
 if(origin==='list'){setChrome(true);$('#editor').style.transform='';$('#editor').classList.add('list-editor');$('[data-tool="notes"]').setAttribute('aria-expanded','true');}
 else {setChrome(false);$('#editor').classList.remove('list-editor');}
 $('#editor-title').textContent=isNew?(edit.kind==='journal'?'写随记':'记一笔'):'编辑笔记';$('#editor-back').hidden=origin!=='list';
 $('#editor-context').textContent=locationLabel(edit);$('#editor-quote').hidden=!edit.quote;$('#editor-quote').classList.remove('expanded');$('#editor-quote').textContent=edit.quote||'';$('#editor-quote').title='点击展开或收起引用';$('#note-body').value=edit.body||'';$('#note-body').style.height='auto';
 const hasDraft=state.drafts.some(d=>d.id===edit.id);
 setSave(hasDraft?'未保存草稿 · 可继续编辑':isNew?'写下想法后自动保存':'已保存 · 修改后自动保存',hasDraft);$('#editor').hidden=false;renderStage();updateEditorPosition();$('#note-body').focus({preventScroll:true});
}
function createNote(anchor,origin='source'){
 openEditor({id:crypto.randomUUID(),kind:anchor?'quote':'journal',block:anchor?.block||null,start:anchor?.start||0,end:anchor?.end||0,quote:anchor?.quote||'',body:'',chapter:anchor?blockById(anchor.block).chapter:null,created:Date.now(),rect:anchor?.rect},origin,true);
}
function closeEditor(returnList=true){
 if(!edit)return;const origin=edit.origin,ok=saveNow();edit=null;$('#editor').hidden=true;$('#editor').classList.remove('list-editor');selection=null;renderStage();
 if(!ok)toast('草稿已保留，可从笔记列表继续');
 if(returnList&&origin==='list'){tool=null;openTool('notes');}else if(origin==='list'){setChrome(true);}
}
function removeNote(id){
 if(edit?.id===id){clearTimeout(saveTimer);edit=null;$('#editor').hidden=true;}
 const old=state.notes.find(n=>n.id===id);if(!old)return;const drafts=state.drafts.filter(d=>d.id===id);state.notes=state.notes.filter(n=>n.id!==id);state.drafts=state.drafts.filter(d=>d.id!==id);try{persist();}catch{state.notes.push(old);state.drafts.push(...drafts);toast('删除失败，笔记仍保留');return;}
 renderStage();if(tool==='notes')renderNotes();if(!$('#preview').hidden){const ns=state.notes.filter(n=>n.block===previewBlock);if(ns.length)showPreview(previewBlock);else $('#preview').hidden=true;}
 toast('笔记已删除','撤销',()=>{state.notes.push(old);state.drafts.push(...drafts);try{persist();}catch{toast('撤销保存失败');}renderStage();if(tool==='notes')renderNotes();});
}
function cardAction(ev,origin){
 const b=ev.target.closest('button');if(!b)return;
 if(b.dataset.edit){const n=state.notes.find(n=>n.id===b.dataset.edit);openEditor(n,origin,false);}
 if(b.dataset.noteMore){const menu=$('#more-'+b.dataset.noteMore);menu.hidden=!menu.hidden;}
 if(b.dataset.delete)removeNote(b.dataset.delete);
 if(b.dataset.jump)jump(b.dataset.jump);
}
$('#toolbar').onclick=ev=>{const b=ev.target.closest('[data-tool]');if(b)openTool(b.dataset.tool);};
$('#show-tools').onclick=()=>{stopSpeech();if(edit)closeEditor(false);$('#preview').hidden=true;$('#selection-menu').hidden=true;setChrome(true);};
$('#dismiss').onclick=()=>{if(edit){closeEditor(false);closeTool();}else if(tool)closeTool();else setChrome(false);};
$('#prototype-help').onclick=()=>openTool('more');
$('#fullscreen').onclick=()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>toast('此窗口不支持全屏'));else document.exitFullscreen?.();};
$('#panel').onclick=ev=>{
 cardAction(ev,'list');const b=ev.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-close-panel'))closeTool();
 if(b.dataset.filter){filter=b.dataset.filter;renderNotes();}
 if(b.hasAttribute('data-new-journal'))createNote(null,'list');
 if(b.dataset.resume){const d=state.drafts.find(d=>d.id===b.dataset.resume);openEditor(d,'list',d.isNew);}
 if(b.dataset.discard){const d=state.drafts.find(d=>d.id===b.dataset.discard);state.drafts=state.drafts.filter(d=>d.id!==b.dataset.discard);try{persist();}catch{}renderNotes();badge();toast('草稿已丢弃','撤销',()=>{state.drafts.push(d);persist();badge();if(tool==='notes')renderNotes();});}
 if(b.hasAttribute('data-start-reading')){closeTool();setChrome(false);toast('拖选一小段原文，点击“记一笔”');}
 if(b.dataset.pageJump!==undefined){navigate(+b.dataset.pageJump,true);closeTool();setChrome(false);}
 if(b.hasAttribute('data-return'))returnToReading();
 if(b.dataset.theme){document.body.classList.toggle('night',b.dataset.theme==='night');}
 if(b.dataset.font){document.documentElement.style.setProperty('--size',b.dataset.font+'px');}
 if(b.hasAttribute('data-reset')){const old=JSON.parse(JSON.stringify(state));state=seed();page=0;returnPage=null;persist();renderStage();toast('已恢复示例笔记','撤销',()=>{state=old;page=alignPage(state.page);persist();renderStage();if(tool==='notes')renderNotes();});}
};
$('#panel').onchange=ev=>{if(ev.target.id==='seek'){navigate(+ev.target.value,true);renderTool('progress');}if(ev.target.id==='simulate-failure')simulateFailure=ev.target.checked;};
$('#preview').onclick=ev=>{cardAction(ev,'source');const b=ev.target.closest('button');if(b?.hasAttribute('data-close-panel'))$('#preview').hidden=true;if(b?.hasAttribute('data-add-current')){const bl=blockById(previewBlock);createNote({block:bl.id,start:0,end:bl.text.length,quote:bl.text,rect:rectOf(bl.id)});}};
$('#editor-close').onclick=()=>closeEditor();$('#editor-back').onclick=()=>closeEditor();$('#done').onclick=()=>closeEditor();$('#retry-save').onclick=()=>saveNow();
$('#editor-quote').onclick=()=>{$('#editor-quote').classList.toggle('expanded');updateEditorPosition();};
$('#note-body').oninput=()=>{
 edit.body=$('#note-body').value;clearTimeout(saveTimer);const ta=$('#note-body');ta.style.height='auto';ta.style.height=Math.min(220,Math.max(100,ta.scrollHeight))+'px';
 if(edit.body.trim()){state.drafts=state.drafts.filter(d=>d.id!==edit.id);const d={...edit};delete d.rect;delete d.origin;state.drafts.push(d);try{persist();}catch{}setSave('保存中…');badge();saveTimer=setTimeout(saveNow,550);}else setSave(edit.isNew?'写下想法后自动保存':'内容为空，原笔记保留');
 updateEditorPosition();
};
$('#selection-note').onclick=()=>{stopSpeech();if(selection)createNote(selection);};
$('#selection-cancel').onclick=()=>{stopSpeech();selection=null;$('#selection-menu').hidden=true;window.getSelection()?.removeAllRanges();renderStage();};
function captureSelection(){
 if(edit||chrome)return;const sel=window.getSelection();if(!sel||sel.isCollapsed||!sel.rangeCount||!sel.toString().trim())return;
 const r=sel.getRangeAt(0),element=n=>n.nodeType===1?n:n.parentElement,a=element(r.startContainer)?.closest('[data-source]'),b=element(r.endContainer)?.closest('[data-source]');
 if(!a||a!==b){if(a||b)toast('先选取同一段中的文字');return;}
 const prefix=document.createRange();prefix.selectNodeContents(a);prefix.setEnd(r.startContainer,r.startOffset);const start=prefix.toString().length,end=start+r.toString().length,rect=r.getBoundingClientRect();
 stopSpeech();selection={block:a.dataset.source,start,end,quote:blockById(a.dataset.source).text.slice(start,end),rect:{left:rect.left,top:rect.top,bottom:rect.bottom}};$('#preview').hidden=true;syncSelectionTools();place($('#selection-menu'),selection.rect);
}
document.addEventListener('mouseup',ev=>{if(ev.target.closest('#stage'))captureSelection();});
document.addEventListener('keyup',ev=>{if(ev.shiftKey&&ev.target.closest('#stage'))captureSelection();});
$('#stage').onclick=ev=>{
 if(edit){closeEditor();return;}if(!$('#preview').hidden&&!ev.target.closest('[data-open-block],[data-note-ids]')){$('#preview').hidden=true;return;}
 if(selection||window.getSelection()?.toString().trim())return;
 const marker=ev.target.closest('[data-open-block]'),marked=ev.target.closest('[data-note-ids]'),add=ev.target.closest('[data-add-block]');
 if(marker){showPreview(marker.dataset.openBlock,marker.getBoundingClientRect());return;}
 if(marked){showPreview(marked.closest('[data-source]').dataset.source,marked.getBoundingClientRect());return;}
 if(add){const bl=blockById(add.dataset.addBlock);createNote({block:bl.id,start:0,end:bl.text.length,quote:bl.text,rect:rectOf(bl.id)});return;}
 if(ev.target.closest('button,a,input,textarea,.translation-leaf,.grammar-inline'))return;
 if(ev.target.closest('.source,h1,.leaf-heading,.caption'))return;
 navigate(page+(ev.clientX<innerWidth/2?(double()?-2:-1):(double()?2:1)));
};
function returnToReading(){if(returnPage===null)return;const p=returnPage;returnPage=null;navigate(p);closeTool();setChrome(false);}
$('#return-position').onclick=returnToReading;
document.addEventListener('keydown',ev=>{
 if(ev.key==='Escape'){ev.preventDefault();if(edit)closeEditor();else if(!$('#preview').hidden)$('#preview').hidden=true;else if(tool)closeTool();else if(chrome)setChrome(false);else if(selection){selection=null;$('#selection-menu').hidden=true;window.getSelection()?.removeAllRanges();renderStage();}return;}
 if(ev.target.closest('textarea,input,button,a'))return;
 if(ev.key==='ArrowRight'||ev.key==='ArrowLeft'){if(!chrome&&!edit){navigate(page+(ev.key==='ArrowRight'?1:-1)*(double()?2:1));ev.preventDefault();}}
 if(ev.key.toLowerCase()==='n'&&!edit)openTool('notes');
});
$('#stage').addEventListener('keydown',ev=>{if(!chrome&&!edit&&(ev.key==='Enter'||ev.key===' ')&&ev.target.matches('[data-note-ids]')){ev.preventDefault();showPreview(ev.target.closest('[data-source]').dataset.source,ev.target.getBoundingClientRect());}});
window.addEventListener('resize',()=>{page=alignPage(page);renderStage();updateEditorPosition();if(!$('#preview').hidden)showPreview(previewBlock);if(!$('#selection-menu').hidden){selection=null;$('#selection-menu').hidden=true;}});
window.addEventListener('pagehide',()=>{stopSpeech();if(edit)saveNow();});

const translations={
 reasoning:'这两个人的论证未能令人信服，因为人们认为，绝对者或无限者不一定存在于一切关系之外，也可以进入各种关系；而且，我们只能通过事物之间的关系来认识事物这一事实，并不意味着由此获得的知识就只是相对的或不真实的知识。',
 distinction:'问题不在于关系是否存在，而在于从我们对关系的认识中能推出什么。通过关系认识一个事物，只是以一种特定方式接触它。这并不意味着事物本身，或我们获得的知识，必然不真实。',
 attention:'细心的读者能够区分这两种主张。第一种涉及我们如何认识某物，第二种涉及这种知识的价值。一条简短的笔记可以保留这个区别，而不打断论证。',
 relative:'相对并不自动等于虚假。描述知识获得的条件，本身并不是否定这种知识。这个句子要求我们区分这些主张。重读一段文字时，原文应当与我们对它提出的问题保持相邻。'
};
function bookmarked(a){return (state.bookmarks||[]).some(b=>b.block===a?.block&&b.start===a.start&&b.end===a.end);}
function syncSelectionTools(){
 const marked=selection&&bookmarked(selection);$('#selection-bookmark').textContent=marked?'移除书签':'书签';$('#selection-bookmark').setAttribute('aria-pressed',String(!!marked));
 const word=selection?.quote.trim().toLowerCase(),ipa=word&&/^[a-z-]+$/.test(word)?dictionary[word]?.ipa:null;$('#selection-ipa').hidden=!ipa;$('#selection-ipa').textContent=ipa||'';
}
function stopSpeech(){if(utterance){utterance.onend=null;utterance.onerror=null;window.speechSynthesis?.cancel();utterance=null;}$('#selection-speak').textContent='朗读';$('#selection-speak').setAttribute('aria-pressed','false');}
$('#selection-speak').onclick=()=>{
 if(utterance){stopSpeech();return;}if(!selection)return;
 if(!window.speechSynthesis||!window.SpeechSynthesisUtterance){toast('此浏览器暂不可朗读');return;}
 const u=new SpeechSynthesisUtterance(selection.quote);u.lang='en-US';u.rate=.93;const voice=speechSynthesis.getVoices().find(v=>/^en[-_]/i.test(v.lang));if(voice)u.voice=voice;
 utterance=u;$('#selection-speak').textContent='停止';$('#selection-speak').setAttribute('aria-pressed','true');u.onend=()=>{if(utterance===u){utterance=null;$('#selection-speak').textContent='朗读';$('#selection-speak').setAttribute('aria-pressed','false');}};u.onerror=ev=>{u.onend();if(!['canceled','interrupted'].includes(ev.error))toast('本机朗读暂不可用');};speechSynthesis.speak(u);
};
$('#selection-bookmark').onclick=()=>{
 if(!selection)return;state.bookmarks ||= [];const same=b=>b.block===selection.block&&b.start===selection.start&&b.end===selection.end;
 if(bookmarked(selection))state.bookmarks=state.bookmarks.filter(b=>!same(b));else state.bookmarks.push({...selection,id:crypto.randomUUID()});
 try{persist();}catch{toast('书签暂未保存');}window.getSelection()?.removeAllRanges();renderStage();syncSelectionTools();place($('#selection-menu'),selection.rect);
};
$('#selection-translate').onclick=()=>{if(!selection)return;stopSpeech();translation={...selection};$('#selection-menu').hidden=true;window.getSelection()?.removeAllRanges();renderStage();};
$('#selection-grammar').onclick=()=>{if(!selection)return;stopSpeech();grammarKnown.add(selection.block);grammarOpen.add(selection.block);$('#selection-menu').hidden=true;window.getSelection()?.removeAllRanges();renderStage();$(`[data-grammar-body="${selection.block}"]`)?.scrollIntoView({block:'nearest'});};
function augmentStage(){
 for(const p of document.querySelectorAll('.paragraph')){
  const id=p.dataset.block;
  p.insertAdjacentHTML('beforeend',`<button class="paragraph-select" data-select-paragraph="${id}" aria-label="选择这一段" title="选择这一段">···</button>`);
  const marks=(state.bookmarks||[]).filter(b=>b.block===id);
  if(marks.length)p.insertAdjacentHTML('beforeend',`<button class="paragraph-bookmark" data-remove-bookmarks="${id}" aria-label="移除此段书签" title="移除此段书签"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg></button>`);
  if(grammarKnown.has(id))p.insertAdjacentHTML('beforeend',`<button class="paragraph-bookmark" style="top:80px;color:var(--accent)" data-grammar-toggle="${id}" aria-label="${grammarOpen.has(id)?'收起':'展开'}语法分析" aria-expanded="${grammarOpen.has(id)}">${grammarOpen.has(id)?'−':'+'}</button>`);
  if(grammarOpen.has(id))p.insertAdjacentHTML('beforeend',`<section class="grammar-inline" data-grammar-body="${id}"><div class="grammar-head"><span>语法分析 · 固定样例，未连接 AI</span><button class="text-button" data-grammar-toggle="${id}">收起</button></div>${id==='reasoning'?syntax.map((n,i)=>`<button class="syntax-node ${n.level===1?'child':n.level===2?'grandchild':''}" data-syntax="${i}">${esc(n.title)}<small>${esc(n.quote)}</small></button>`).join(''):'<p class="meta">此段展示分析的展开位置；第一段长难句提供完整的语法样例。</p>'}<div class="syntax-detail">${id==='reasoning'?'点击层级，与原句对应高亮。':'正式版按选区所在的完整句子分析。'}</div></section>`);
 }
 $('#spread').classList.toggle('with-translation',!!translation);
 if(translation){
  const block=blockById(translation.block),whole=translation.start===0&&translation.end===block.text.length;
  const short={'the reasoning of these two men':'这两个人的论证','did not carry conviction':'未能令人信服','relative does not automatically mean false.':'相对并不自动等于虚假。'}[translation.quote.trim().toLowerCase()];
  const text=whole?translations[block.id]:short;
  $('#spread').insertAdjacentHTML('beforeend',`<aside class="leaf translation-leaf" aria-label="选区对照译文"><div class="panel-head"><h2>选区对照译文</h2><button class="icon" id="close-translation" aria-label="收起译文">${icon('close')}</button></div><p class="meta">${text?'固定译文样例 · 未连接 AI':'译文位置预览 · 未连接 AI'}</p><blockquote class="quote">${esc(translation.quote)}</blockquote><div class="translation-copy">${esc(text||'此处将展示所选文字对应的中文译文。当前原型只演示布局；选择第一段的整段文字，可以查看固定译文样例。')}</div></aside>`);
  $('#close-translation').onclick=()=>{translation=null;selection=null;renderStage();};
 }
}
$('#stage').addEventListener('click',ev=>{
 const b=ev.target.closest('button');if(!b)return;
 if(b.dataset.selectParagraph){ev.stopImmediatePropagation();stopSpeech();const bl=blockById(b.dataset.selectParagraph);selection={block:bl.id,start:0,end:bl.text.length,quote:bl.text,rect:rectOf(bl.id)};$('#preview').hidden=true;syncSelectionTools();renderStage();place($('#selection-menu'),selection.rect);}
 if(b.dataset.removeBookmarks){ev.stopImmediatePropagation();state.bookmarks=(state.bookmarks||[]).filter(m=>m.block!==b.dataset.removeBookmarks);persist();renderStage();if(selection)syncSelectionTools();}
 if(b.dataset.grammarToggle){ev.stopImmediatePropagation();const id=b.dataset.grammarToggle;grammarOpen.has(id)?grammarOpen.delete(id):grammarOpen.add(id);renderStage();}
 if(b.dataset.syntax!==undefined){ev.stopImmediatePropagation();const n=syntax[+b.dataset.syntax],text=blockById('reasoning').text,start=text.indexOf(n.quote);if(start>=0){flash={block:'reasoning',start,end:start+n.quote.length};renderStage();}$('[data-grammar-body="reasoning"] .syntax-detail').textContent=n.detail;}
},true);
renderStage();setChrome(false);toast('选中文字记一笔；点击顶部打开笔记列表');
