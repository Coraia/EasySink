import { sourceRuns } from './selection-range.js';
import { captureAnnotationLayout } from './annotation-layout.js';

const inkKey = (block, start, end) => `${block}:${start}:${end}`;
const rectOf = r => ({x:r.x,y:r.y,width:r.width,height:r.height});
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const cssText = css => ({font:css.font, color:css.color, letterSpacing:css.letterSpacing,
  fontKerning:css.fontKerning, fontFeatureSettings:css.fontFeatureSettings, fontVariantLigatures:css.fontVariantLigatures});

// A spread-local native layout. Source UTF-16 coordinates, not page numbers,
// own the text. The focused occurrence stays fixed while changed notes flow
// toward the following source frontier; already-read presentation waits for a turn.
export class AnnotationReflow {
  constructor(pages) {
    this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.pages=pages; this.serial=0; this.cache=new Map(); this.groups=[];
    pages.r.scope.cleanup(()=>this.dispose());
    pages.r.on('before-selection',()=>this.interruptPreparation());
    pages.r.on('before-page',event=>this.retireDeferredPrefixHistory(event));
    pages.r.on('position',()=>{
      if(this.deferredPrefixLeaf && !this.deferredPrefixLeaf.isConnected) {
        this.deferredPrefixPresentation=false;this.deferredPrefixLeaf=null;
      }
    });
    pages.r.on('reading-uncovered',()=>{
      clearTimeout(this.flushTimer);
      if(this.pendingLayout) pages.invalidateLayout();
      this.flushTimer=setTimeout(()=>{if(!pages.r.popElement) {if(this.pendingLayout || this.signature) void this.flush();else {this.dispose();pages.painter.warm();}}},0);
    });
  }
  focus(anchor) {
    if (this.eligible() && this.anchor.block_id===anchor.block_id && this.anchor.start===anchor.start) return;
    this.dispose();
    this.pages.painter.pauseWarm();
    if(this.pages.r.search || this.pages.r.focus.isOpen() || document.querySelector('#article .inline-grammar:not([hidden])'))return;
    const node=[...document.querySelectorAll('#article [data-word]')].find(n=>
      n.dataset.sourceBlock===anchor.block_id && +n.dataset.sourceStart===anchor.start);
    if (!node || anchor.end!==+node.dataset.sourceEnd || anchor.segments?.length || this.pages.displayPending) return;
    // Mixed object/style runs retain the existing exact-position reservation.
    if (document.querySelector('#article [data-pdf-object],#article .url-image,#article .pdf-inline-object,#article .pdf-inline-formula,#article .pdf-inline-anchor,#article pre,#article blockquote,#article .list-block,#article .table-row')) return;
    this.anchor={...anchor,end:+node.dataset.sourceEnd}; this.target=rectOf(node.getBoundingClientRect()); this.targetNode=node;
    this.index=this.pages.index; this.count=this.pages.count;
    this.leaves=[...document.querySelectorAll('#article .page-leaf')];
    this.boxes=this.leaves.map(n=>rectOf(n.getBoundingClientRect()));
    this.column=this.leaves.indexOf(node.closest('.page-leaf'));
    this.prose=this.leaves.map(n=>rectOf(n.querySelector('.reading-prose').getBoundingClientRect()));
    this.textBox=rectOf(node.closest('[data-block]').getBoundingClientRect());
    const leaf=this.leaves[this.column];
    if(leaf.dataset.reflowTextWidth) this.textBox={...this.textBox,x:this.boxes[this.column].x+(+leaf.dataset.reflowTextLeft),width:+leaf.dataset.reflowTextWidth};
    this.fonts=new Map([...document.querySelectorAll('#article [data-block]')].map(n=>[n.dataset.block,cssText(getComputedStyle(n))]));
    this.defaultFont=cssText(getComputedStyle(node.closest('.reading-prose')));
    this.lineHeight=parseFloat(getComputedStyle(node.closest('[data-block]')).lineHeight);
    this.bodyLineHeight=parseFloat(getComputedStyle(node.closest('.reading-prose')).lineHeight);
    this.units=new Map([...document.querySelectorAll("#article [data-word]")].map(node=>[inkKey(node.dataset.sourceBlock,+node.dataset.sourceStart,+node.dataset.sourceEnd),{node,template:null}]));
    this.inkColor=getComputedStyle(document.querySelector("#article")).color;
    this.base=this.capture();
    const order=this.pages.r.doc.blocks.findIndex(b=>b.id===anchor.block_id);
    this.prefix=this.base.filter(p=>p.order<order || p.order===order && (p.gloss?p.end<=anchor.start:p.end<=this.anchor.end));
    this.before=this.base;
    this.prefixPages=this.pages.pages.slice(0,this.index).map(parts=>parts.map(p=>({...p})));
    this.first=this.pages.pages[this.index][0];
    const extra=this.leaves.at(-1).cloneNode(false);
    extra.append(this.leaves.at(-1).querySelector('.leaf-heading').cloneNode(true));
    const extraProse=document.createElement('div');extraProse.className='reading-prose';extra.append(extraProse);
    this.leaves.push(extra);
    this.boxes.push({...this.boxes.at(-1),x:this.boxes.at(-1).x+this.boxes.at(-1).width});
    this.version=this.pages.r.doc.version;
    this.geometryEpoch=this.pages.geometryEpoch || 0;
    this.sourceFragments=new Map(this.pages.fragments);
    this.annotationItems=[...this.pages.activeAnnotations];
    this.registryItems=[...this.pages.r.annotations];
    this.annotationContext=this.annotationContextKey();
    this.earlierContext=this.earlierAnnotationContextKey();
    this.workJobs=new Set();
    // A canonical note can still be deferred on this spread. Start from what
    // this real word displays so a direct action never inherits that deferral.
    const shown=this.registryItems[+node.closest('[data-annotation]')?.dataset.annotation];
    const initial=shown?.block.id===anchor.block_id && shown.start<=anchor.start && shown.end>=this.anchor.end?shown:null;
    this.initialHasNote=Boolean(initial);
    this.annotationSignature=JSON.stringify(initial?[initial.start,initial.end,initial.note]:null);
    this.owner=document.querySelector('#article');
    this.owner.addEventListener('pointerdown',this.reveal=event=>{
      if(event.target.closest('.source-fragment,[data-word],[data-annotation]')) this.interruptPreparation();
      this.finish();
    },{capture:true});
    this.owner.addEventListener('keydown',this.prefixKey=event=>{
      if((['Enter',' '].includes(event.key) && event.target.closest('[data-word]')) ||
        event.shiftKey && /^(Arrow|Home$|End$)/.test(event.key)) this.interruptPreparation();
    },{capture:true});
  }
  capture() {
    const pieces=[]; const range=document.createRange();const order=new Map(this.pages.r.doc.blocks.map((b,i)=>[b.id,i]));
    for(const run of sourceRuns()) {
      for(const m of run.node.textContent.matchAll(/\S+\s*|\s+/g)) {
        range.setStart(run.node,m.index);range.setEnd(run.node,m.index+m[0].length);
        const previous=pieces.at(-1)?.r;
        const r=range.getClientRects()[0] || (previous?{...previous,x:previous.x+previous.width,width:0}:run.node.parentElement.getBoundingClientRect());
        const parent=run.node.parentElement, word=parent.closest('[data-word]');
        pieces.push({key:inkKey(run.block.dataset.block,run.start+m.index,run.start+m.index+m[0].length),
          block:run.block.dataset.block,start:run.start+m.index,end:run.start+m.index+m[0].length,
          order:order.get(run.block.dataset.block),text:m[0],r:rectOf(r),style:cssText(getComputedStyle(parent)),
          word:word?.dataset.word,wordStart:word?+word.dataset.sourceStart:null,wordEnd:word?+word.dataset.sourceEnd:null,
          page:this.leaves.indexOf(run.block.closest('.page-leaf'))});
      }
    }
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    for(const gloss of document.querySelectorAll('#article .gloss:not(.annotation-gloss-update)')) {
      const annotation=gloss.closest('[data-annotation]'), item=this.pages.r.annotations[+annotation?.dataset.annotation];
      if(!item) continue;
      const style=cssText(getComputedStyle(gloss)), glyphs=[];
      if(gloss.classList.contains('reflow-note-piece')) {
        pieces.push({key:gloss.dataset.reflowKey,block:item.block.id,start:item.start,end:item.end,order:order.get(item.block.id),text:gloss.textContent,r:rectOf(gloss.getBoundingClientRect()),style,gloss:true,annotationIndex:+annotation.dataset.annotation,page:this.leaves.indexOf(gloss.closest('.page-leaf'))});
        continue;
      }
      const walker=document.createTreeWalker(gloss,NodeFilter.SHOW_TEXT);let textNode;
      while((textNode=walker.nextNode())) {
        let offset=0;
        for(const text of textNode.textContent) {
          range.setStart(textNode,offset);offset+=text.length;range.setEnd(textNode,offset);
          const r=range.getClientRects()[0];if(r) glyphs.push({text,r:rectOf(r)});
        }
      }
      if(!glyphs.length) continue;
      context.font=style.font;
      const opening=context.measureText('〈').width, closing=context.measureText('〉').width;
      const first=glyphs[0].r,last=glyphs.at(-1).r;
      glyphs.unshift({text:'〈',r:{...first,x:first.x-opening,width:opening}});
      glyphs.push({text:'〉',r:{...last,x:last.x+last.width,width:closing}});
      glyphs.forEach((glyph,i)=>pieces.push({key:`g:${JSON.stringify([item.block.id,item.start,item.end])}:${i}`,
        block:item.block.id,start:item.start,end:item.end,order:order.get(item.block.id),...glyph,style,gloss:true,
        annotationIndex:+annotation.dataset.annotation,
        page:this.leaves.indexOf(gloss.closest('.page-leaf'))}));
    }
    return pieces;
  }
  eligible() {
    return this.anchor && this.index===this.pages.index && this.version===this.pages.r.doc.version &&
      this.geometryEpoch===(this.pages.geometryEpoch || 0) &&
      !this.pages.r.scope.signal.aborted && this.leaves.slice(0,this.count).every(n=>n.isConnected);
  }
  annotationIndex(item) {
    return this.pages.r.annotations.findIndex(a=>a.block.id===item.block.id && a.start===item.start && a.end===item.end && a.note===item.note);
  }
  annotationContextKey() {
    const a=this.anchor;
    return JSON.stringify(this.pages.activeAnnotations.filter(item=>
      !(item.block.id===a.block_id && item.start<=a.start && item.end>=a.end)).map(item=>
      [item.block.id,item.start,item.end,item.kind,item.text,item.note,item.target,item.source,
        item.forced,item.collectionsFeedbackId,item.preference_id]));
  }
  earlierAnnotationContextKey() {
    const order=new Map(this.pages.r.doc.blocks.map((block,i)=>[block.id,i]));
    const visible=this.pages.activeAnnotations.filter(item=>this.isVisiblePrefixItem(item))
      .map(item=>[item.block.id,item.start,item.end,item.note]);
    visible.sort((a,b)=>order.get(a[0])-order.get(b[0]) || a[1]-b[1] || a[2]-b[2] ||
      (a[3]<b[3]?-1:a[3]>b[3]?1:0));
    return JSON.stringify(visible);
  }
  isVisiblePrefixItem(item) {
    const a=this.anchor,blocks=this.pages.r.doc.blocks;
    const i=blocks.findIndex(block=>block.id===item.block.id),order=blocks.findIndex(block=>block.id===a.block_id);
    if(!(i<order || i===order && item.end<=a.start)) return false;
    // A mounted carry glyph counts even when its source word is on the
    // preceding page. Source pieces also admit an earlier, newly added note.
    return (this.before||this.prefix).some(piece=>piece.page>=0 && piece.page<this.count &&
      piece.block===item.block.id && piece.start<item.end && piece.end>item.start);
  }
  refreshPrefixBindings() {
    const registry=this.pages.r.annotations;
    const key=item=>JSON.stringify([item.block.id,item.start,item.end,item.note]);
    const active=new Map(this.pages.activeAnnotations.filter(item=>this.isVisiblePrefixItem(item))
      .map(item=>[key(item),{item,index:registry.indexOf(item)}]));
    const changes=[];
    for(const node of document.querySelectorAll('#article [data-annotation]')) {
      const old=registry[+node.dataset.annotation];
      if(!old || !this.isVisiblePrefixItem(old)) continue;
      const value=active.get(key(old));if(!value || value.index<0) continue;
      const {item,index}=value,kind=node.hasAttribute('data-kind') && node.dataset.kind!==item.kind;
      if(+node.dataset.annotation===index && !kind && (!node.hasAttribute('data-target') || node.dataset.target===item.target)) continue;
      let style=null;
      if(kind) {
        const css=getComputedStyle(node);
        style={display:css.display,maxWidth:css.maxWidth,whiteSpace:css.whiteSpace,overflowWrap:css.overflowWrap};
      }
      changes.push({node,item,index,style});
    }
    // Preserve current native line boxes while updating their real registry
    // ownership. Batch the style reads before any attribute/style writes.
    for(const {node,item,index,style} of changes) {
      if(style) Object.assign(node.style,style);
      node.dataset.annotation=index;
      if(node.hasAttribute('data-target')) node.dataset.target=item.target;
      if(node.hasAttribute('data-kind')) node.dataset.kind=item.kind;
    }
  }
  retireDeferredPrefixHistory({reflow=false}={}) {
    if(reflow || !this.deferredPrefixPresentation) return;
    // This event belongs to a committed page turn. A cancelled preview never
    // retires the current spread; return must use latest canonical fragments.
    this.pages.viewIdentity=null;
    this.deferredPrefixLeaf=document.querySelector('#article .page-leaf');
  }
  interruptPreparation() {
    if(!this.workJobs?.size) return;
    ++this.serial;
    this.warming=new Map();
    this.finish();
    this.preparedMotions?.forEach(value=>{value.groups.forEach(a=>a.cancel());value.ghosts.remove();});
    this.preparedMotions?.clear();
    // Complete the canonical ledger without replacing the source being used
    // by the newer pointer/selection. No retired prefix job may publish it.
    this.pendingLayout ||= {reconcile:true};this.pages.canonicalDirty=true;
    if(!this.pages.r.popElement) void this.flush();
  }
  refreshAnnotationContext() {
    const context=this.annotationContextKey();
    if(context===this.annotationContext) return false;
    // Persist indirect earlier changes now, but keep the measured prefix on
    // this spread. Only a real departure retires its presentation history.
    const earlier=this.earlierAnnotationContextKey();
    const prefixChanged=earlier!==this.earlierContext;
    if(prefixChanged) this.deferredPrefixPresentation=true;
    this.earlierContext=earlier;
    ++this.serial;
    this.finish();
    this.preparedMotions?.forEach(value=>{value.groups.forEach(a=>a.cancel());value.ghosts.remove();});
    this.preparedMotions?.clear();this.cache.clear();this.warming=new Map();
    if(!this.prefixState) this.prefixPreparing=null;
    this.staticLayout=null;this.signature=null;this.annotationSignature=null;
    this.sourceFragments=new Map(this.pages.fragments);
    this.annotationItems=[...this.pages.activeAnnotations];
    this.registryItems=[...this.pages.r.annotations];
    this.annotationContext=context;
    this.refreshPrefixBindings();
    return true;
  }
  async update() {
    if(!this.eligible()) return false;
    const jobs=this.workJobs,job={};jobs.add(job);
    try {
    const started=performance.now();
    const p=this.pages, contextChanged=this.refreshAnnotationContext();
    const target=p.activeAnnotations.find(n=>n.block.id===this.anchor.block_id && n.start<=this.anchor.start && n.end>=this.anchor.end);
    const signature=JSON.stringify(target?[target.start,target.end,target.note]:null);
    if(!contextChanged && !this.adopted && signature===this.annotationSignature) {
      this.staticLayout ||= captureAnnotationLayout(p);
      if(this.staticLayout) {
        p.annotationLayout=this.staticLayout;
        p.canonicalDirty=true;
        this.pendingLayout={static:true};
        document.querySelector('.reader').dataset.annotationReflowReady='true';
        if(!p.r.popElement) void this.flush();
      }
      return true;
    }
    if(signature===this.signature) return true;
    const warming=this.warming?.get(signature);
    const serial=warming?this.serial:++this.serial;
    let state=this.cache.get(signature);
    if(warming) state=await warming;
    if(!state) {
      state=await this.layout(serial);
      if(!state || serial!==this.serial || !this.eligible()) return true;
      // Retain the reversible endpoints; repeated +/- does no text measurement.
      if(this.cache.size>=4) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(signature,state);
    }
    if(serial!==this.serial || !this.eligible()) return true;
    if(signature===this.signature) return true;

    state.suffixPieces ||= state.pieces.filter(piece=>!this.prefix.includes(piece));
    await this.prepareDOM(state);
    if(serial!==this.serial || !this.eligible() || !state.doms) return true;
    await this.transition(state,signature);
    if(serial!==this.serial || !this.eligible()) return true;
    document.querySelector("#article").dataset.reflowWorkMs=(performance.now()-started).toFixed(1);
    return true;
    } finally {jobs.delete(job);}
  }
  prepareNote(note) {
    if(!this.eligible()) return;
    const a=this.anchor, serial=this.serial;
    const target=note?{block:this.pages.blocks.get(a.block_id),start:a.start,end:a.end,
      text:a.quote,target:a.quote,note,kind:'retained',source:'context-retained'}:null;
    const key=JSON.stringify(target?[target.start,target.end,target.note]:null);
    this.warming ||= new Map();
    if(this.cache.has(key)||this.warming.has(key)) return;
    const map=this.warming;
    const warming=(async()=>{
      const jobs=this.workJobs,job={};jobs.add(job);
      try {
      const state=await this.layout(serial,target);
      if(!state || serial!==this.serial || !this.eligible()) return null;

      state.suffixPieces=state.pieces.filter(piece=>!this.prefix.includes(piece));
      await this.prepareDOM(state);
      if(serial!==this.serial || !this.eligible() || !state.doms) return null;
      this.cache.set(key,state);
      if(!this.signature && Boolean(note)!==this.initialHasNote) await this.transition(state,key,{prepareOnly:true});
      return state;
      } finally {jobs.delete(job);}
    })().catch(()=>null).finally(()=>{if(map.get(key)===warming)map.delete(key);});
    map.set(key,warming);
  }
  async layout(serial, override) {
    if(serial!==this.serial || !this.eligible()) return null;
    const p=this.pages, a=this.anchor, col=this.column, box=this.prose[col];
    const textBox=this.textBox;
    const left=textBox.x, width=textBox.width;
    // The native line box starts above the glyph's typographic bounds.
    const glyphInset=(this.lineHeight-this.target.height)/2;
    const y=Math.max(0,this.target.y-box.y-glyphInset);
    const x=Math.max(0,this.target.x+this.target.width-left);
    const height=Math.max(this.lineHeight*2,p.height);
    const stride=col+1<this.prose.length?this.prose[col+1].x-box.x:this.boxes[col].width;
    const measure=document.createElement('div');
    measure.className='reading-prose annotation-reflow-measure';
    Object.assign(measure.style,{left:`${left}px`,top:`${box.y}px`,width:`${width}px`,height:`${height}px`,
      columnWidth:`${width}px`,columnGap:`${Math.max(0,stride-width)}px`,columnCount:'1',...this.defaultFont});
    measure.setAttribute('aria-hidden','true');
    const seed=document.createElement('div');seed.style.cssText=`height:${y}px;break-inside:avoid;`;
    measure.append(seed);
    const blocks=p.r.doc.blocks, from=blocks.findIndex(b=>b.id===a.block_id);
    // A bounded lookahead covers the visible spread and one overflow page.
    // Native pagination resumes from the last visible UTF-16 source offset.
    const focused=override===undefined?p.activeAnnotations.find(n=>n.block.id===a.block_id && n.start<=a.start && n.end>=a.end):override;
    document.querySelector('.reader').append(measure);
    let covered=false;
    for(let i=from;i<blocks.length && !covered;i++) {
      const b=blocks[i];
      if(p.visualBlock(b) || b.type==='code' || (p.inlineObjects.get(b.id)||[]).length) break;
      const start=i===from?a.end:0;
      const ends=[...b.text.slice(start).matchAll(/\S+\s*/g)].map(m=>start+m.index+m[0].length);
      const chunkEnds=ends.length?ends:[b.text.length];
      let content=null,chunkStart=start;
      for(let k=0;k<chunkEnds.length;k+=100) {
        const chunkEnd=chunkEnds[Math.min(chunkEnds.length-1,k+99)];
        const holder=document.createElement('div'),latest=p.fragments;p.fragments=this.sourceFragments;
        try {holder.innerHTML=p.markup({id:b.id,start:chunkStart,end:chunkEnd});} finally {p.fragments=latest;}
        const part=holder.querySelector('[data-block]');
        if(part) {
          if(content) content.append(...part.childNodes);
          else {
            content=part;
            if(this.fonts.has(b.id)) Object.assign(content.style,this.fonts.get(b.id));
            if(i===from) {
              content.style.marginTop='0';content.style.padding='0';content.style.border='0';
              const indent=document.createElement('span');indent.style.cssText=`display:inline-block;width:${x}px;height:0;vertical-align:baseline;`;
              content.prepend(indent);
              if(focused) {
                const note=document.createElement('span');note.className='gloss';note.dataset.reflowNote=JSON.stringify([focused.block.id,focused.start,focused.end]);
                note.textContent=focused.note;indent.after(note);
              }
            }
            measure.append(content);
          }
          content.dataset.end=chunkEnd;
          // Force only one bounded addition through native line layout. Stop
          // after the first word beyond the mounted spread and overflow leaf.
          const last=[...content.querySelectorAll('[data-word]')].at(-1);
          if(last) covered=col+Math.floor((last.getBoundingClientRect().x-left+.5)/stride)>=this.count+1;
        }
        chunkStart=chunkEnd;
        await pause();
        if(serial!==this.serial || !this.eligible()) {measure.remove();return null;}
        if(covered)break;
      }
    }
    // Split native Chinese glosses into glyphs, so the annotation can wrap
    // after its source word instead of keeping the entire group unbreakable.
    for(const node of measure.querySelectorAll('.annotation')) node.style.display='inline';
    let noteSlice=performance.now();
    for(const gloss of measure.querySelectorAll('.gloss')) {
      const id=gloss.dataset.reflowNote || (()=>{const item=this.registryItems[+gloss.closest('[data-annotation]').dataset.annotation];return JSON.stringify([item.block.id,item.start,item.end]);})();
      const text=`〈${gloss.textContent}〉`;gloss.textContent='';gloss.classList.add('reflow-glyph-note');
      [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].forEach(({segment:c},i)=>{const span=document.createElement('span');span.textContent=c;span.dataset.reflowGlyph=`${id}:${i}`;gloss.append(span);});
      if(performance.now()-noteSlice>4) {await pause();noteSlice=performance.now();if(serial!==this.serial || !this.eligible()) {measure.remove();return null;}}
    }
    await pause();
    if(serial!==this.serial || !this.eligible()) {measure.remove();return null;}
    const measured=rectOf(measure.getBoundingClientRect());let result=[...this.prefix];
    const unfinished=new Map();

    const order=new Map(blocks.map((b,i)=>[b.id,i]));
    let readSlice=performance.now();
    const tokenRange=document.createRange();
    const pageFor=r=>col+Math.floor((r.x-measured.x+.5)/stride);
    const place=r=>({x:r.x,y:r.y,width:r.width,height:r.height});
    const blockFonts=new Map();
    for(const block of measure.querySelectorAll('[data-block]')) {
      blockFonts.set(block.dataset.block,cssText(getComputedStyle(block)));
      const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT); let node,offset=+block.dataset.start,lastRect=null;
      while((node=walker.nextNode())) {
        if(node.parentElement.closest('.gloss')) continue;
        for(const m of node.textContent.matchAll(/\S+\s*|\s+/g)) {
          const range=tokenRange;range.setStart(node,m.index);range.setEnd(node,m.index+m[0].length);
          const previous=lastRect;
          const r=range.getClientRects()[0] || (previous?{...previous,x:previous.x+previous.width,width:0}:node.parentElement.getBoundingClientRect());
          lastRect=rectOf(r);
          const page=pageFor(r),word=node.parentElement.closest('[data-word]');
          if(page<this.count+1) result.push({key:inkKey(block.dataset.block,offset+m.index,offset+m.index+m[0].length),block:block.dataset.block,
            start:offset+m.index,end:offset+m.index+m[0].length,order:order.get(block.dataset.block),text:m[0],r:place(r),
            style:cssText(getComputedStyle(node.parentElement)),word:word?.dataset.word,
            wordStart:word?+word.dataset.sourceStart:null,wordEnd:word?+word.dataset.sourceEnd:null,page});
        }
        offset+=node.length;
        if(performance.now()-readSlice>4) {
          await pause();readSlice=performance.now();
          if(serial!==this.serial || !this.eligible()) {measure.remove();return null;}
        }
      }
    }
    const overflowGloss=[];
    for(const glyph of measure.querySelectorAll('[data-reflow-glyph]')) {
      const r=glyph.getBoundingClientRect(),page=pageFor(r);
      const encoded=glyph.dataset.reflowGlyph,parts=JSON.parse(encoded.slice(0,encoded.lastIndexOf(':')));
      if(page>=this.count) overflowGloss.push({block_id:parts[0],start:parts[1],end:parts[2],glyphStart:+encoded.slice(encoded.lastIndexOf(':')+1),text:glyph.textContent});
      if(page>=this.count+1) {unfinished.set(JSON.stringify(parts),parts);continue;}
      result.push({key:`g:${encoded}`,block:parts[0],start:parts[1],end:parts[2],order:order.get(parts[0]),text:glyph.textContent,
        r:place(r),style:cssText(getComputedStyle(glyph)),gloss:true,page});
      if(performance.now()-readSlice>4) {await pause();readSlice=performance.now();if(serial!==this.serial || !this.eligible()){measure.remove();return null;}}
    }
    measure.remove();
    // The unseen overflow leaf may end beside another annotation. Move that
    // whole occurrence into normal tail pagination rather than drop the rest
    // of its gloss. The operated word remains in the mounted spread.
    let cut=null;
    for(const [block,start,end] of unfinished.values()) {
      if(!result.some(piece=>!piece.gloss && piece.page===this.count && piece.block===block && piece.start>=start && piece.end<=end))continue;
      const candidate={block,start,order:order.get(block)};
      if(!cut || candidate.order<cut.order || candidate.order===cut.order && start<cut.start)cut=candidate;
    }
    if(cut) result=result.filter(piece=>piece.page<this.count || piece.order<cut.order || piece.order===cut.order && (piece.gloss?piece.start<cut.start:piece.end<=cut.start));
    result.sort((a,b)=>a.order-b.order || a.start-b.start || Number(a.gloss)-Number(b.gloss));
    const fragments=Array.from({length:this.count+1},(_,page)=>{
      const map=new Map();
      for(const piece of result.filter(n=>n.page===page && !n.gloss)) {
        const old=map.get(piece.block);
        if(old) {old.start=Math.min(old.start,piece.start);old.end=Math.max(old.end,piece.end);}
        else map.set(piece.block,{id:piece.block,start:piece.start,end:piece.end});
      }
      for(const piece of result.filter(n=>n.page===page && n.gloss)) if(!map.has(piece.block)) map.set(piece.block,{id:piece.block,start:piece.end,end:piece.end,annotationCarry:true});
      return [...map.values()].sort((a,b)=>order.get(a.id)-order.get(b.id));
    });
    if(fragments.some((parts,i)=>!parts.length && this.pages.pages[this.index+i]?.length)) return null;
    return {pieces:result,fragments,overflowGloss,fonts:blockFonts,annotations:[...this.annotationItems.filter(n=>!(n.block.id===a.block_id && n.start<=a.start && n.end>=a.end)),...(focused?[focused]:[])]};
  }
  async prepareDOM(state) {
    if(state.doms) return;
    const serial=this.serial;
    await this.preparePrefix();
    if(serial!==this.serial || !this.eligible() || !this.prefixState) return;
    let slice=performance.now();
    const doms=[];
    const p=this.pages, annotations=p.r.annotations;
    for(const item of state.annotations) if(!annotations.some(a=>a.block.id===item.block.id && a.start===item.start && a.end===item.end && a.note===item.note)) annotations.push(item);
    for(let page=0;page<this.leaves.length;page++) {
      const leaf=this.leaves[page],prose=document.createElement('div'),pagePieces=[];
      for(const part of state.fragments[page]) {
        const pieces=(state.suffixPieces||state.pieces).filter(n=>n.page===page && n.block===part.id);
        const sourcePieces=pieces.filter(n=>!n.gloss);if(!pieces.length)continue;
        const source=document.createElement('div');source.dataset.block=part.id;source.dataset.start=sourcePieces.length?Math.min(...sourcePieces.map(n=>n.start)):part.end;source.dataset.end=sourcePieces.length?Math.max(...sourcePieces.map(n=>n.end)):part.end;
        source.className='reflow-source-block';
        Object.assign(source.style,state.fonts?.get(part.id)||this.fonts.get(part.id)||this.defaultFont);
        const originX=Math.min(...pieces.map(n=>n.r.x)),originY=Math.min(...pieces.map(n=>n.r.y));
        const right=Math.max(...pieces.map(n=>n.r.x+n.r.width)),bottom=Math.max(...pieces.map(n=>n.r.y+n.r.height));
        Object.assign(source.style,{position:'absolute',left:'0',top:'0',width:`${right-originX}px`,height:`${bottom-originY}px`,
          transform:`translate(${originX-this.boxes[page].x-leaf.clientLeft}px,${originY-this.boxes[page].y-leaf.clientTop}px)`,
          margin:'0',padding:'0',border:'0',pointerEvents:'none'});
        const fragment=document.createElement('section');fragment.className='source-fragment';fragment.style.position='static';fragment.dataset.fragment=part.id;
        fragment.dataset.fragmentStart=part.start;fragment.dataset.fragmentEnd=part.end;fragment.append(source);prose.append(fragment);
        const lineHeight=+(state.fonts?.get(part.id)?.font.match(/\/\s*([\d.]+)px/)?.[1] || this.bodyLineHeight || this.lineHeight);
        const rows=new Map();
        for(const item of pieces) {
          const row=Math.round((item.r.y-originY)/lineHeight);
          if(!rows.has(row))rows.set(row,[]);rows.get(row).push(item);
        }
        for(const [,rowPieces] of [...rows].sort((a,b)=>a[0]-b[0])) {
          const line=document.createElement('span');line.className='reflow-source-line';
          Object.assign(line.style,{left:`${Math.min(...rowPieces.map(p=>p.r.x))-originX}px`,top:`${Math.min(...rowPieces.map(p=>p.r.y))-originY}px`,width:`${Math.max(...rowPieces.map(p=>p.r.x+p.r.width))-Math.min(...rowPieces.map(p=>p.r.x))+32}px`,height:`${lineHeight}px`,lineHeight:`${lineHeight}px`});source.append(line);
          for(const item of rowPieces) {
          const node=document.createElement('span');node.className=item.gloss?'gloss reflow-inline-piece reflow-note-piece':'reflow-inline-piece';
          node.dataset.reflowKey=item.key;
          if(item.gloss) node.setAttribute('aria-hidden','true');
          if(item.word) {
            node.classList.add('source-unit');node.dataset.word=item.word;node.dataset.sourceBlock=item.block;
            node.dataset.sourceStart=item.wordStart;node.dataset.sourceEnd=item.wordEnd;
            node.setAttribute('role','button');node.setAttribute('tabindex','0');node.setAttribute('aria-label',`查阅 ${item.word}`);
          }
          const shown=state.annotations.find(a=>a.block.id===item.block && a.start<=item.start && a.end>=item.end);
          const index=shown?annotations.indexOf(shown)>=0?annotations.indexOf(shown):annotations.findIndex(a=>a.block.id===shown.block.id && a.start===shown.start && a.end===shown.end && a.note===shown.note):-1;
          if(index>=0 && (item.gloss||item.word)) {
            item.annotationIndex=index;
            node.dataset.annotation=index;
            if(item.word) {node.dataset.target=annotations[index].target;node.dataset.kind=annotations[index].kind;}
            if(item.word) node.classList.add('annotation');
          }
          node.textContent=item.text;
          Object.assign(node.style,{...item.style,left:'0px',top:'0px'});
          line.append(node);item.node=node;item.template=node;pagePieces.push(item);
          if(item.gloss)node.style.color='var(--gloss)';else if(item.style.color===this.inkColor)node.style.color='var(--ink)';
          if(performance.now()-slice>4) {await pause();slice=performance.now();if(serial!==this.serial || !this.eligible())return;}
        }
        }
        if(sourcePieces.length && p.blocks.get(part.id)?.type!=='heading') {
          const actions=document.createElement('div');actions.className='paragraph-actions';
          Object.assign(actions.style,{top:`${bottom-this.boxes[page].y-leaf.clientTop+3}px`,bottom:'auto',right:'24px'});
          for(const [attribute,label] of [['readBlock','听这一段'],['selectBlock','选择这一段']]) {
            const button=document.createElement('button');button.type='button';button.dataset[attribute]=part.id;button.textContent=label;
            if(attribute==='readBlock' && !p.r.ctx.enabled('tts'))button.hidden=true;
            actions.append(button);
          }
          fragment.append(actions);
        }
      }
      p.r.collectionsController?.paint(prose);
      const stage=document.createElement('div');stage.className='annotation-inline-stage';stage.setAttribute('aria-hidden','true');
      Object.assign(stage.style,{left:`${this.boxes[page].x}px`,top:`${this.boxes[page].y}px`,width:`${this.boxes[page].width}px`,height:`${this.boxes[page].height}px`});
      stage.append(prose);document.querySelector('.reader').append(stage);
      try {
        for(const item of pagePieces) {
          const actual=item.node.getBoundingClientRect();
          item.node.style.left=`${item.r.x-actual.x}px`;item.node.style.top=`${item.r.y-actual.y}px`;
          if(performance.now()-slice>4) {await pause();slice=performance.now();if(serial!==this.serial || !this.eligible())return;}
        }
      } finally {stage.remove();}
      doms.push([...prose.childNodes]);
    }
    state.doms=doms;
  }
  async preparePrefix() {
    if(this.prefixState) return;
    this.prefixPreparing ||= this.buildPrefix();
    const preparing=this.prefixPreparing;
    try {await preparing;} finally {if(this.prefixPreparing===preparing)this.prefixPreparing=null;}
  }
  async buildPrefix() {
    const serial=this.serial,leaves=this.leaves;
    let slice=performance.now();
    const order=new Map(this.pages.r.doc.blocks.map((b,i)=>[b.id,i]));
    const targetOrder=order.get(this.anchor.block_id),a={...this.anchor};
    const spacers=[],annotations=[],words=[],hiddenBlocks=[],trims=[];
    for(const leaf of leaves.slice(0,this.count)) {
      const runs=[...sourceRuns(leaf)];
      for(const run of runs) if(order.get(run.block.dataset.block)>targetOrder || run.block.dataset.block===a.block_id && run.start>=a.end) {
        let spacer=run.node.parentElement.closest('.reflow-reservation-text');
        if(!spacer) {spacer=document.createElement('span');spacer.className='reflow-reservation-text';run.node.replaceWith(spacer);spacer.append(run.node);}
        spacers.push(spacer);
        if(performance.now()-slice>4) {await pause();slice=performance.now();if(serial!==this.serial || !this.eligible())return;}
      }
      for(const node of leaf.querySelectorAll('[data-annotation]')) {
        const item=this.pages.r.annotations[+node.dataset.annotation];
        if(item && (order.get(item.block.id)>targetOrder || item.block.id===a.block_id && item.end>a.start))annotations.push(node);
      }
      for(const node of leaf.querySelectorAll('[data-word]')) if(order.get(node.dataset.sourceBlock)>targetOrder || node.dataset.sourceBlock===a.block_id && +node.dataset.sourceStart>=a.end)words.push(node);
      for(const block of leaf.querySelectorAll('[data-block]')) {
        if(order.get(block.dataset.block)>targetOrder || block.dataset.block===a.block_id && +block.dataset.start>=a.end)hiddenBlocks.push(block);
        else if(block.dataset.block===a.block_id)trims.push(block);
      }
    }
    if(serial===this.serial && this.eligible())this.prefixState={doms:leaves.map(leaf=>[...leaf.querySelector('.reading-prose').childNodes]),spacers,annotations,words,hiddenBlocks,trims,anchor:a};
  }
  activatePrefix(state) {
    const plan=this.prefixState;if(plan.activated)return;plan.activated=true;
    for(const spacer of plan.spacers) {spacer.classList.add('annotation-gloss-space','reflow-prefix-space');spacer.setAttribute('aria-hidden','true');}
    const reused=new Set(state.suffixPieces.filter(piece=>piece.word).map(piece=>this.units.get(piece.key)?.node).filter(Boolean));
    for(const node of plan.annotations) {
      if(reused.has(node))continue;
      const gloss=node.querySelector('.gloss');if(gloss) {gloss.classList.replace('gloss','annotation-gloss-space');gloss.setAttribute('aria-hidden','true');}
      node.style.borderColor='transparent';node.style.background='transparent';delete node.dataset.annotation;delete node.dataset.target;node.removeAttribute('role');node.removeAttribute('tabindex');
    }
    for(const node of plan.words) {if(reused.has(node))continue;delete node.dataset.word;node.removeAttribute('role');node.removeAttribute('tabindex');node.setAttribute('aria-hidden','true');node.style.pointerEvents='none';node.style.visibility='hidden';}
    for(const block of plan.hiddenBlocks) {
      const fragment=block.closest('.source-fragment');if(fragment){fragment.style.visibility='hidden';fragment.setAttribute('aria-hidden','true');fragment.inert=true;}
      delete block.dataset.block;block.style.visibility='hidden';block.style.pointerEvents='none';block.setAttribute('aria-hidden','true');
    }
    for(const block of plan.trims) {
      block.dataset.end=Math.min(+block.dataset.end,plan.anchor.end);
      if(plan.anchor.end<this.pages.blocks.get(plan.anchor.block_id).text.length)block.closest('.source-fragment')?.querySelector('.paragraph-actions')?.remove();
    }
  }
  draw(state,movingKeys=null) {
    const drawStarted=performance.now();
    this.activatePrefix(state);
    const prefixReady=performance.now();
    for(const piece of state.suffixPieces) if(piece.word) {
      const template=piece.template;
      let entry=this.units.get(piece.key);
      if(!entry) {entry={node:template.cloneNode(true),template:null};this.units.set(piece.key,entry);}
      const node=entry.node;
      if(entry.template!==template) {
        if(entry.template)node.replaceWith(entry.template);
        else if(node.parentNode) {
          const space=node.cloneNode(true);delete space.dataset.word;delete space.dataset.annotation;space.removeAttribute('role');space.removeAttribute('tabindex');space.setAttribute('aria-hidden','true');space.style.visibility='hidden';space.style.pointerEvents='none';node.replaceWith(space);
        }
        node.querySelectorAll('.reflow-reservation-text').forEach(space=>space.replaceWith(...space.childNodes));
        const names=new Set([...template.attributes].map(attribute=>attribute.name));
        for(const attribute of [...node.attributes])if(!names.has(attribute.name))node.removeAttribute(attribute.name);
        for(const attribute of template.attributes)if(node.getAttribute(attribute.name)!==attribute.value)node.setAttribute(attribute.name,attribute.value);
        template.replaceWith(node);entry.template=template;
      }
      piece.node=node;
    }
    const wordsReady=performance.now();
    for(const piece of state.suffixPieces) {
      const moving=Boolean(movingKeys?.has(piece.key));
      if(piece.node.classList.contains('reflow-moving')!==moving)piece.node.classList.toggle('reflow-moving',moving);
    }
    this.leaves.forEach((leaf,page)=>{
      leaf.classList.add('annotation-reflow-leaf');
      leaf.dataset.reflowTextLeft=this.textBox.x-this.boxes[this.column].x;leaf.dataset.reflowTextWidth=this.textBox.width;
      const prose=leaf.querySelector('.reading-prose'),prefix=this.prefixState.doms[page];
      for(const node of [...prose.childNodes]) if(!prefix.includes(node)) node.remove();
      for(const node of prefix) if(!node.isConnected) prose.append(node);
      prose.append(...state.doms[page]);
    });
    if(!this.targetNode.isConnected) this.targetNode=[...document.querySelectorAll("#article [data-word]")].find(n=>n.dataset.sourceBlock===this.anchor.block_id && +n.dataset.sourceStart===this.anchor.start);
    const focused=state.annotations.find(a=>a.block.id===this.anchor.block_id && a.start<=this.anchor.start && a.end>=this.anchor.end);
    this.targetNode.classList.remove('annotation');
    this.targetNode.classList.toggle('reflow-target-annotated',Boolean(focused));
    if(focused) {this.targetNode.dataset.annotation=this.annotationIndex(focused);this.targetNode.dataset.target=focused.target;}
    else {delete this.targetNode.dataset.annotation;delete this.targetNode.dataset.target;}
    this.canonicalState=state;
    if(window.nativeBenchmarkOptions?.profile) {
      this.drawTrace ||= [];this.drawTrace.push({at:drawStarted,prefix:prefixReady-drawStarted,words:wordsReady-prefixReady,rest:performance.now()-wordsReady});
      document.querySelector('#article').dataset.reflowDrawTrace=JSON.stringify(this.drawTrace.slice(-12));
    }
  }
  async transition(state,signature,{prepareOnly=false}={}) {
    if(!prepareOnly)document.querySelector('#article').dataset.reflowPhase='preparing';
    if(this.reduced) {if(prepareOnly)return;this.finish();this.draw(state);this.adopt(state,signature);return;}
    if(this.pair && [this.pair.from,this.pair.to].includes(signature)) {
      const progress=this.groups[0]?.currentTime ?? (this.signature===this.pair.to?220:0);
      const forward=signature===this.pair.to;
      clearTimeout(this.timer);
      this.pendingCanonical=state;
      const canonical=this.canonicalState;
      canonical.moving ||= canonical.pieces.filter(piece=>this.pair.keys.has(piece.key)).map(piece=>piece.node).filter(Boolean);
      canonical.moving.forEach(node=>{if(!node.classList.contains('reflow-moving'))node.classList.add('reflow-moving');});
      if(this.ghosts.style.opacity!=='1')this.ghosts.style.opacity='1';
      for(const animation of this.groups) {
        animation.pause();animation.currentTime=progress;animation.playbackRate=forward?1:-1;animation.play();
      }
      this.timer=setTimeout(()=>this.settle(),Math.max(0,forward?220-progress:progress)+30);
      document.querySelector('#article').dataset.reflowPhase='playing';
      this.adopt(state,signature);
      return;
    }
    const staged=this.preparedMotions?.get(signature);
    if(!prepareOnly && staged && staged.base===this.signature) {
      const transitionSerial=this.serial;
      this.preparedMotions.delete(signature);
      this.finish();this.draw(state,staged.keys);
      this.ghosts=staged.ghosts;this.ghosts.style.opacity='1';this.groups=staged.groups;
      this.groups.forEach(animation=>{animation.currentTime=0;});
      // Commit the native text before starting the clock. A wide Retina
      // layout can otherwise consume the opening part of the animation.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      if(transitionSerial!==this.serial || !this.eligible())return;
      const start=document.timeline.currentTime;
      this.groups.forEach(animation=>{animation.currentTime=0;animation.play();animation.startTime=start;});
      document.querySelector('#article').dataset.reflowPhase='playing';
      this.pair={from:this.signature,to:signature,keys:staged.keys};
      this.timer=setTimeout(()=>this.settle(),250);this.adopt(state,signature);
      return;
    }
    const serial=this.serial,baseSignature=this.signature;
    const previous=this.before;

    const old=new Map(previous.filter(n=>n.page<this.count).map(n=>[n.key,n])), box=document.querySelector('#article').getBoundingClientRect();
    const grouped=new Map();
    const add=(item,frames,rect)=>{
      const band=Math.floor((rect.y-this.prose[Math.min(item.page,this.count-1)].y)/(this.lineHeight*2));
      const base=JSON.stringify([item.page,band,frames]);
      let bucket=0;while(grouped.get(`${base}:${bucket}`)?.items.length>=64) bucket++;
      const key=`${base}:${bucket}`;let group=grouped.get(key);
      if(!group) {group={frames,items:[]};grouped.set(key,group);}group.items.push({item,rect});

    };
    for(const item of state.pieces.filter(n=>n.page<this.count)) {
      const a=old.get(item.key), b=item.r;
      if(a && Math.abs(a.r.x-b.x)<.05 && Math.abs(a.r.y-b.y)<.05 && a.text===item.text) {old.delete(item.key);continue;}
      if((item.order<this.pages.r.doc.blocks.findIndex(b=>b.id===this.anchor.block_id) || item.order===this.pages.r.doc.blocks.findIndex(b=>b.id===this.anchor.block_id)&&!item.gloss&&item.end<=this.anchor.end)) continue;
      const delta=value=>Math.round(value*20)/20;
      const transform=a?`translate(${delta(a.r.x-b.x)}px,${delta(a.r.y-b.y)}px)`:'none';
      const slide=a && !item.gloss && a.page===item.page && (Math.abs(a.r.y-b.y)<2 || Math.abs(a.r.x-b.x)<.1);
      if(slide) add(item,[{transform,opacity:1,offset:0},{transform,opacity:1,offset:.25},{transform:'none',opacity:1,offset:.75},{transform:'none',opacity:1,offset:1}],b);
      else {
        if(a) add({...a,node:null},[{opacity:1,offset:0},{opacity:0,offset:.24},{opacity:0,offset:1}],a.r);
        add(item,[{opacity:0,offset:0},{opacity:0,offset:.76},{opacity:1,offset:1}],b);
      }
      old.delete(item.key);
    }
    for(const item of old.values()) add({...item,node:null},[{opacity:1,offset:0},{opacity:0,offset:.24},{opacity:0,offset:1}],item.r);
    const ghosts=document.createElement('div');ghosts.className='annotation-reflow-ghosts';ghosts.setAttribute('aria-hidden','true');ghosts.inert=true;
    const prepared=[];let slice=performance.now();
    for(const group of grouped.values()) {
      const x=Math.min(...group.items.map(i=>i.rect.x)),y=Math.min(...group.items.map(i=>i.rect.y));
      const right=Math.max(...group.items.map(i=>i.rect.x+i.rect.width)),bottom=Math.max(...group.items.map(i=>i.rect.y+i.rect.height));
      const node=document.createElement('div');node.className='reflow-motion-group';
      Object.assign(node.style,{left:`${x-box.x}px`,top:`${y-box.y}px`,width:`${right-x}px`,height:`${bottom-y}px`});
      for(const {item,rect} of group.items) {
        const copy=document.createElement('span');copy.className='reflow-piece';copy.textContent=item.text;
        copy.dataset.reflowVisual=item.key;
        if(item.gloss && item.annotationIndex!==undefined) copy.dataset.reflowAnnotation=item.annotationIndex;
        Object.assign(copy.style,{...item.style,color:item.gloss?"var(--gloss)":item.style.color===this.inkColor?"var(--ink)":item.style.color,left:`${rect.x-x}px`,top:`${rect.y-y}px`,width:`${rect.width}px`,height:`${rect.height}px`});node.append(copy);
        if(performance.now()-slice>4) {
          await pause();slice=performance.now();
          if(serial!==this.serial || !this.eligible()) return;
        }
      }
      prepared.push({node,frames:group.frames});
    }
    if(serial!==this.serial || !this.eligible()) return;
    // Stage a bounded compositor surface per frame. A first mount of every
    // glyph layer together stalls native WebKit even when JS itself is short.
    ghosts.style.opacity='.01';
    document.querySelector('#article').append(ghosts);
    const warmed=[];
    for(let index=0;index<prepared.length;index++) {
      const group=prepared[index];
      ghosts.append(group.node);
      const animation=group.node.animate(group.frames,{duration:220,fill:'both',easing:'linear'});
      animation.pause();animation.currentTime=group.frames[0].opacity===0?220:0;warmed.push(animation);
      if(index%2===1 || index===prepared.length-1) await new Promise(requestAnimationFrame);
      if(serial!==this.serial || !this.eligible()) {warmed.forEach(a=>a.cancel());ghosts.remove();return;}
    }
    const keys=new Set([...grouped.values()].flatMap(g=>g.items.map(i=>i.item.key)));
    if(prepareOnly) {
      if(baseSignature!==this.signature) {warmed.forEach(a=>a.cancel());ghosts.remove();return;}
      this.preparedMotions ||= new Map();
      this.preparedMotions.set(signature,{base:baseSignature,ghosts,groups:warmed,keys});
      return;
    }
    this.finish();this.draw(state,keys);
    this.ghosts=ghosts;ghosts.style.opacity='1';
    this.groups=warmed;
    this.groups.forEach(animation=>{animation.currentTime=0;});
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    if(serial!==this.serial || !this.eligible())return;
    const start=document.timeline.currentTime;
    this.groups.forEach(animation=>{animation.currentTime=0;animation.play();animation.startTime=start;});
    document.querySelector('#article').dataset.reflowPhase='playing';
    this.pair={from:this.signature,to:signature,keys};
    this.timer=setTimeout(()=>this.settle(),250);
    this.adopt(state,signature);
  }
  adopt(state,signature) {
    this.adopted=true;this.annotationSignature=signature;
    this.before=state.pieces;this.signature=signature;
    state.context ||= {leaves:[...this.leaves],prefixDOM:this.prefixState.doms,anchor:{...this.anchor}};
    const focused=state.annotations.find(a=>a.block.id===this.anchor.block_id && a.start<=this.anchor.start && a.end>=this.anchor.end);
    state.focusedBinding=focused?{index:this.annotationIndex(focused),target:focused.target}:null;
    const owner=this;
    state.snapshots ||= state.fragments.map((fragments,i)=>({fragments,get leaf() {return owner.snapshotLeaf(state,i);}}));
    this.pages.annotationLayout=state.snapshots.filter((page,i)=>i<this.count || page.fragments.length);
    ++this.pages.generation;
    this.pages.resolveFlow?.(false);
    clearTimeout(this.pages.timer);
    this.pages.canonicalDirty=true;
    this.pages.complete=false;
    this.pages.navigationUI({geometry:false});
    document.querySelector('.reader').dataset.paginationReady='false';
    document.querySelector('.reader').dataset.annotationReflowReady='true';
    this.pendingLayout=state;
  }
  snapshotLeaf(state,page) {
    state.snapshotLeaves ||= [];
    if(state.snapshotLeaves[page]) return state.snapshotLeaves[page];
    const original=state.context.leaves[page],leaf=original.cloneNode(false);
    leaf.append(original.querySelector('.leaf-heading').cloneNode(true));
    const prose=original.querySelector('.reading-prose').cloneNode(false);
    for(const node of [...state.context.prefixDOM[page],...state.doms[page]]) prose.append(node.cloneNode(true));
    leaf.append(prose);
    const anchor=state.context.anchor;
    const target=[...leaf.querySelectorAll('[data-word]')].find(node=>node.dataset.sourceBlock===anchor.block_id && +node.dataset.sourceStart===anchor.start);
    if(target) {
      target.classList.remove('annotation');target.classList.toggle('reflow-target-annotated',Boolean(state.focusedBinding));
      if(state.focusedBinding) {target.dataset.annotation=state.focusedBinding.index;target.dataset.target=state.focusedBinding.target;}
      else {delete target.dataset.annotation;delete target.dataset.target;}
    }
    leaf.querySelectorAll('.reflow-moving').forEach(node=>node.classList.remove('reflow-moving'));
    state.snapshotLeaves[page]=leaf;
    return leaf;
  }
  async flush({reconcile = false} = {}) {
    if(this.flushing && this.flushSerial===this.serial) return this.flushing;
    if(reconcile && this.eligible() && this.pages.annotationLayout) this.pendingLayout ||= {reconcile:true};
    if(!this.pendingLayout || !this.eligible()) return;
    this.pendingLayout=null;
    const serial=this.flushSerial=this.serial;
    const started=this.pages.reflow(this.pages.position(),{keepDOM:true,reason:'annotation',reuseEpoch:true});
    const flow=this.pages.flowReady;
    const pending=(async()=>{
      const landed=await started,complete=landed && await flow;
      if(serial!==this.serial || this.pages.r.scope.signal.aborted) return false;
      this.releaseTextures();
      if(complete && !this.pages.r.popElement) {
        this.pages.painter.warm();this.pages.warmRanges();
      }
      return complete;
    })().finally(()=>{if(this.flushing===pending)this.flushing=null;this.pages.markStable();});
    this.flushing=pending;
    return pending;
  }
  retireTextures(textures) {
    this.retiredTextures ||= [];
    this.retiredTextures.push(...textures);
  }
  releaseTextures() {
    const textures=this.retiredTextures?.splice(0) || [],gl=this.pages.painter.gl;
    const release=()=>{
      if(!textures.length || !gl || gl.isContextLost())return;
      if(this.pages.r.popElement || this.pages.animating) {schedule();return;}
      gl.deleteTexture(textures.pop());
      if(textures.length) schedule();
    };
    const schedule=()=>window.requestIdleCallback?requestIdleCallback(release,{timeout:1000}):setTimeout(release,32);
    if(textures.length)schedule();
  }
  settle() {
    if(this.owner?.isConnected)this.owner.dataset.reflowPhase='idle';
    this.groups.forEach(a=>a.pause());
    if(this.pendingCanonical) {this.draw(this.pendingCanonical,this.pair?.keys);this.pendingCanonical=null;}
    // Keep the pooled ink surfaces on the compositor while idle. Hiding their
    // parent makes wide Retina WebKit rasterize them again on every reversal.
    if(this.ghosts) this.ghosts.style.opacity='1';
    if(this.pair && this.canonicalState) {
      this.canonicalState.moving ||= this.canonicalState.pieces.filter(piece=>this.pair.keys.has(piece.key)).map(piece=>piece.node).filter(Boolean);
      this.canonicalState.moving.forEach(node=>{if(!node.classList.contains('reflow-moving'))node.classList.add('reflow-moving');});
    }
    this.pages.markStable();
  }
  finish() {
    if(this.owner?.isConnected)this.owner.dataset.reflowPhase='idle';
    clearTimeout(this.timer);
    if(this.pendingCanonical) {this.draw(this.pendingCanonical);this.pendingCanonical=null;}
    this.groups.forEach(a=>a.cancel());this.groups=[];
    this.ghosts?.remove();this.ghosts=null;
    this.pair=null;
    this.leaves?.forEach(n=>n.querySelectorAll('.reflow-moving').forEach(n=>n.classList.remove('reflow-moving')));
    this.pages.markStable();
  }
  dispose() {
    ++this.serial;clearTimeout(this.flushTimer);this.pendingLayout=null;
    this.finish();this.owner?.removeEventListener('pointerdown',this.reveal,{capture:true});
    this.owner?.removeEventListener('keydown',this.prefixKey,{capture:true});
    this.preparedMotions?.forEach(value=>{value.groups.forEach(a=>a.cancel());value.ghosts.remove();});this.preparedMotions?.clear();
    this.releaseTextures();
    this.anchor=null;this.annotationContext=null;this.earlierContext=null;this.cache.clear();this.signature=null;this.prefixState=null;this.prefixPreparing=null;this.warming?.clear();this.adopted=false;this.staticLayout=null;this.canonicalState=null;
  }
}
