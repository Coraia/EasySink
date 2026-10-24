// A word action may retain the open spread's presentation. These DOM snapshots
// are never inputs to canonical pagination.
import { sourceRuns } from './selection-range.js';

const key = item => JSON.stringify([item.block.id, item.start, item.end]);
const rect = value => ({x:value.x,y:value.y,width:value.width,height:value.height});
const nextTask = () => new Promise(resolve=>setTimeout(resolve,0));
const annotationIdentity = items => JSON.stringify(items.map(item=>[item.block.id,item.start,item.end,
  item.kind,item.text,item.note,item.target,item.source,item.forced,item.collectionsFeedbackId,item.preference_id]));

// The mixed-content fallback keeps the real prefix, not a frozen clone that
// can only reserve a new note. Its suffix is measured by the existing native
// page builder and retains code, list, quote and object containers.
export function captureRetainedWordLayout(pages) {
  const r=pages.r,a=r.popAnchor,owner=document.querySelector('#article'),pop=r.popElement;
  if(!owner || !a || a.segments?.length || a.version!==r.doc.version || !pop?.isConnected ||
    pages.displayPending || r.search || r.focus.isOpen() ||
    owner.querySelector('.inline-grammar:not([hidden])') ||
    !owner.querySelector('pre,blockquote,.list-block,[data-pdf-object],.url-image,.pdf-inline-object,.pdf-inline-formula,.table-row')) return null;
  const target=[...owner.querySelectorAll('[data-word]')].find(node=>node.dataset.sourceBlock===a.block_id &&
    +node.dataset.sourceStart===a.start && +node.dataset.sourceEnd===a.end);
  const block=target?.closest('[data-block]');
  if(!block || block.tagName!=='P' || block.closest('[aria-hidden="true"],.annotation-gloss-space')) return null;
  const leaves=[...owner.querySelectorAll('.page-leaf')].slice(0,pages.count),column=leaves.indexOf(target.closest('.page-leaf'));
  if(column<0) return null;
  const order=new Map(r.doc.blocks.map((b,i)=>[b.id,i])),before=item=>
    order.get(item.block.id)<order.get(a.block_id) || item.block.id===a.block_id && item.end<=a.start;
  const targetRect=rect(target.getBoundingClientRect()),prose=leaves.map(leaf=>leaf.querySelector('.reading-prose'));
  const lineHeight=parseFloat(getComputedStyle(block).lineHeight);
  if(!targetRect.width || !targetRect.height || !Number.isFinite(lineHeight) || lineHeight<=0 || prose.some(node=>!node)) return null;
  const prefix=[...owner.querySelectorAll('[data-word]')].filter(node=>{
    const i=order.get(node.dataset.sourceBlock),j=order.get(a.block_id);
    return (i<j || i===j && +node.dataset.sourceEnd<=a.end) && !node.closest('.annotation-gloss-space,[aria-hidden="true"]');
  }).map(node=>({node,rect:rect(node.getBoundingClientRect())}));
  return {r,pages,owner,pop,anchor:{...a},target,block,leaves,column,prose,
    proseRects:prose.map(node=>rect(node.getBoundingClientRect())),leafRects:leaves.map(node=>rect(node.getBoundingClientRect())),
    targetRect,blockRect:rect(block.getBoundingClientRect()),lineHeight,prefix,
    sourceIdentity:pages.sourceIdentity,geometryEpoch:pages.geometryEpoch,navigation:pages.navigation,
    before,beforeIdentity:annotationIdentity(pages.activeAnnotations.filter(before)),
    annotationIdentity:annotationIdentity(pages.activeAnnotations),position:{...pages.position()}};
}

export function captureAnnotationLayout(pages) {
  const leaves = [...document.querySelectorAll("#article .page-leaf")];
  const fragments = leaves.slice(0, pages.count).map(leaf => {
    const parts = [];
    for (const block of leaf.querySelectorAll('[data-block]')) {
      const part = {id:block.dataset.block,start:+block.dataset.start,end:+block.dataset.end};
      const previous = parts.at(-1);
      if (previous?.id === part.id && previous.end === part.start) previous.end = part.end;
      else parts.push(part);
    }
    return parts;
  });
  if (pages.displayPending || (!pages.complete && fragments.length < pages.count) || !fragments[0]?.length) return null;
  return fragments.map((parts, index) => {
    const leaf = leaves[index];
    const clone = leaf.cloneNode(true);
    const originals = [...leaf.querySelectorAll("[data-annotation], [data-annotation-slot]")];
    const copies = [...clone.querySelectorAll("[data-annotation], [data-annotation-slot]")];
    originals.forEach((node, i) => {
      const item = pages.r.annotations[+node.dataset.annotation];
      const slot = copies[i];
      slot.dataset.annotationSlot = node.dataset.annotationSlot || key(item);
      // Inline word groups must retain their existing line boxes after removal.
      slot.style.display = getComputedStyle(node).display;
      const gloss = node.querySelector(".gloss");
      if (gloss && !slot.dataset.glossBox) {
        const rect = gloss.getClientRects()[0], parent = node.getBoundingClientRect();
        if (rect) slot.dataset.glossBox = JSON.stringify({
          left: rect.left - parent.left, top: rect.top - parent.top,
          width: rect.width, height: rect.height,
        });
      }
    });
    return { fragments: parts.map(part => ({...part})), leaf: clone };
  });
}

export function updateAnnotationLayout(layout, annotations) {
  const indexed = new Map(annotations.map((item, index) => [key(item), {item, index}]));
  for (const page of layout) {
    const root = page.leaf;
    for (const slot of root.querySelectorAll("[data-annotation-slot]")) {
      const value = indexed.get(slot.dataset.annotationSlot);
      slot.classList.add("annotation-slot");
      slot.classList.toggle("annotation", Boolean(value));
      slot.style.borderColor = value ? "" : "transparent";
      for (const name of ["data-annotation", "data-target", "role", "tabindex", "aria-label"])
        slot.removeAttribute(name);
      const gloss = slot.querySelector(".gloss");
      // A changed gloss uses the old inline space and a bounded visible label.
      // Its full text remains available in the word card.
      if (gloss && (!value || gloss.textContent !== value.item.note)) {
        if (!slot.querySelector(".annotation-gloss-space")) {
          const space = gloss.cloneNode(true);
          space.className = "annotation-gloss-space";
          space.removeAttribute("style");
          slot.insertBefore(space, gloss);
        }
        gloss.remove();
      }
      if (!value) continue;
      const {item, index} = value;
      slot.dataset.annotation = index;
      slot.dataset.target = item.target;
      slot.setAttribute("role", "button");
      slot.setAttribute("tabindex", "0");
      slot.setAttribute("aria-label", `${item.text}：${item.note}`);
      if (!slot.querySelector(".gloss") && slot.dataset.glossBox) {
        const label = document.createElement("span"), rect = JSON.parse(slot.dataset.glossBox);
        label.className = "gloss annotation-gloss-update";
        label.setAttribute("aria-hidden", "true");
        label.textContent = item.note;
        label.title = item.note;
        Object.assign(label.style, Object.fromEntries(Object.entries(rect).map(([k,v]) => [k, `${v}px`])));
        slot.append(label);
      }
    }
    // A new annotation has no inline space in the open spread. Mark its source
    // immediately without inserting a gloss that would push the word away.
    for (const {item, index} of indexed.values()) {
      if ([...root.querySelectorAll("[data-annotation-slot]")].some(slot => slot.dataset.annotationSlot === key(item))) continue;
      const units = [...root.querySelectorAll("[data-word]")].filter(unit =>
        unit.dataset.sourceBlock === item.block.id &&
        +unit.dataset.sourceStart >= item.start && +unit.dataset.sourceEnd <= item.end);
      if (!units.length) continue;
      // Never split an existing phrase/word slot. Its dictionary remains
      // reachable, and a clean reflow will show the new annotation normally.
      if (units.some(unit => unit.closest("[data-annotation-slot]"))) continue;
      const range = document.createRange();
      range.setStartBefore(units[0]);
      range.setEndAfter(units.at(-1));
      const marker = document.createElement("span");
      marker.className = "annotation annotation-slot annotation-pending";
      marker.style.display = "inline";
      marker.dataset.annotationSlot = key(item);
      marker.dataset.annotation = index;
      marker.dataset.target = item.target;
      marker.dataset.kind = item.kind;
      marker.setAttribute("role", "button");
      marker.setAttribute("tabindex", "0");
      marker.setAttribute("aria-label", `${item.text}：${item.note}`);
      marker.append(range.extractContents());
      range.insertNode(marker);
    }
  }
  return layout;
}

async function nativeRetainedSuffix(pages, request, valid) {
  const a=request.anchor,focused=pages.activeAnnotations.find(item=>item.block.id===a.block_id &&
    item.start<=a.start && item.end>=a.end);
  if(focused && (focused.start!==a.start || focused.end!==a.end)) throw new Error('这项复合注释暂时无法在原位展开。');
  const source=pages.blocks.get(a.block_id),markup=pages.markup,flowSegments=pages.flowSegments;
  const note=focused?[{block_id:a.block_id,start:a.start,end:a.end,note:focused.note,
    glyphStart:0,text:`〈${focused.note}〉`}]:[];
  const inset=(request.lineHeight-request.targetRect.height)/2;
  const lineTop=request.targetRect.y-inset;
  const indent=request.targetRect.x+request.targetRect.width-request.blockRect.x;
  let cursor={block_id:a.block_id,start:a.end},carry=note,representedNote=!focused;
  const result=[];
  for(let column=request.column;column<pages.count && cursor;column++) {
    if(!valid()) return null;
    const first=column===request.column,top=first?lineTop:request.proseRects[column].y;
    const available=pages.height-(top-request.proseRects[column].y);
    const measure=pages.measure.cloneNode(false),packet=Object.create(Object.getPrototypeOf(pages));
    pages.measure.parentElement.append(measure);
    Object.assign(packet,{r:pages.r,blocks:pages.blocks,fragments:pages.fragments,urlRanges:pages.urlRanges,
      inlineStyles:pages.inlineStyles,inlineObjects:pages.inlineObjects,urlImages:pages.urlImages,
      measure,width:pages.width,height:available,count:1,pages:[],index:0,complete:false,
      viewStart:cursor,incomingCarry:carry,excludedCarry:[]});
    packet.markup=function(part, measuring=false) {
      // The page builder gets the remaining height, but objects keep the same
      // full-paper size as the canonical reader instead of shrinking to fit.
      const remaining=this.height;let html;
      this.height=pages.height;
      try {html=markup.call(this,part,measuring);} finally {this.height=remaining;}
      if((first || carry.length) && part.id===a.block_id && part.start===a.end) {
        const holder=document.createElement('div');holder.innerHTML=html;
        const block=holder.querySelector('[data-block]');
        if(block) {
          if(first) {
            const seed=document.createElement('span');
            seed.style.cssText=`display:inline-block;width:${indent}px;height:0;vertical-align:baseline;`;
            block.prepend(seed);block.style.minHeight=`${request.lineHeight}px`;
          }
          if(focused) for(const continuation of block.querySelectorAll('[data-kind="continuation"]'))
            continuation.dataset.annotation=pages.r.annotations.indexOf(focused);
          html=holder.innerHTML;
        }
      }
      return html;
    };
    packet.flowSegments=function*() {
      // Even a word at paragraph end leaves its native line and paragraph
      // margin before the next rich block. This is a source-free layout row.
      if(first && a.end===source.text.length && !carry.length) yield{block:source,start:a.end,end:a.end,carryOnly:true};
      yield* flowSegments.call(this);
    };
    let builder,host;
    try {
      if(first) {
        measure.innerHTML=packet.markup({id:a.block_id,start:a.end,end:a.end,annotationCarry:true},true);
        const block=measure.firstElementChild,css=getComputedStyle(block);
        const height=block.getBoundingClientRect().height+parseFloat(css.marginTop)+parseFloat(css.marginBottom)+2;
        if(height>available) {result.push({column,container:null});continue;}
      }
      builder=packet.buildPages();let parts=null;
      for(let next=builder.next();!next.done;next=builder.next()) {
        if(next.value) {parts=next.value;break;}
        await nextTask();if(!valid()) return null;
      }
      if(!parts?.length) break;
      const leaf=request.leaves[column],box=request.leafRects[column],prose=request.proseRects[column];
      host=leaf.cloneNode(false);
      Object.assign(host.style,{position:'fixed',left:`${box.x}px`,top:`${box.y}px`,width:`${box.width}px`,
        height:`${box.height}px`,visibility:'hidden',pointerEvents:'none',overflow:'hidden',zIndex:'-1'});
      host.setAttribute('aria-hidden','true');
      const native=document.createElement('div');native.className='reading-prose';native.dataset.retainedNativeSuffix='true';
      Object.assign(native.style,{position:'absolute',left:`${prose.x-box.x-leaf.clientLeft}px`,
        top:`${top-box.y-leaf.clientTop}px`,width:`${prose.width}px`});
      native.innerHTML=packet.fragmentsMarkup(parts);host.append(native);document.querySelector('.reader').append(host);
      const images=[...native.querySelectorAll('img')];
      if(images.length) {
        let timer;
        try {await Promise.race([Promise.all(images.map(image=>image.decode())),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('阅读图片尚未准备完成。')),3000);})]);}
        finally {clearTimeout(timer);}
        if(!valid()) return null;
      }
      if(native.getBoundingClientRect().height>available+.5) throw new Error('这项注释在当前页剩余空间中尚无法完整展开。');
      const text=new Map();
      for(const run of sourceRuns(native)) text.set(run.block,(text.get(run.block)||'')+run.node.textContent);
      for(const block of native.querySelectorAll('[data-block]')) {
        const original=pages.blocks.get(block.dataset.block);
        if(pages.visualBlock(original)) continue;
        if((text.get(block)||'')!==original.text.slice(+block.dataset.start,+block.dataset.end)) throw new Error('阅读文字位置校验未通过，已保留当前页面。');
      }
      if(carry.length) representedNote ||= [...native.querySelectorAll('.gloss')].some(gloss=>gloss.textContent===carry[0].text);
      result.push({column,container:native,parts});carry=[];
      const last=parts.at(-1);cursor={block_id:last.id,start:last.end,afterObject:pages.visualBlock(pages.blocks.get(last.id))};
      await nextTask();if(!valid()) return null;
    } finally {builder?.return();host?.remove();measure.remove();}
  }
  if(!representedNote) throw new Error('当前页面的剩余空间不足以完整展开这项注释。');
  return {columns:result,focused};
}

function retainedPrefixUnchanged(request) {
  return request.prefix.every(({node,rect:before})=>{
    if(!node.isConnected) return false;
    const after=node.getBoundingClientRect();
    return ['x','y','width','height'].every(name=>after[name]===before[name]);
  });
}

function commitRetainedSuffix(pages, request, state) {
  const a=request.anchor,block=request.block,target=request.target,prose=request.prose[request.column];
  const attributes=new Map(),removed=[],spaces=[],added=[];
  const save=node=>{if(!attributes.has(node)) attributes.set(node,[...node.attributes].map(attr=>[attr.name,attr.value]));};
  const detach=node=>{removed.push({node,parent:node.parentNode,next:node.nextSibling});node.remove();};
  const restoreFocus=document.activeElement===target;
  const undo=()=>{
    added.forEach(node=>node.remove());
    for(const {node,parent,next} of [...removed].reverse()) parent.insertBefore(node,next?.parentNode===parent?next:null);
    for(const {space,node} of spaces) space.replaceWith(node);
    for(const [node,values] of attributes) {
      for(const attr of [...node.attributes]) node.removeAttribute(attr.name);
      for(const [name,value] of values) node.setAttribute(name,value);
    }
    if(restoreFocus) target.focus({preventScroll:true});
  };
  try {
    const runs=[...sourceRuns(request.owner)].filter(run=>run.block===block);
    if(runs.some(run=>run.start<a.end && run.end>a.end)) throw new Error('单词的原文边界暂时无法安全保留。');
    // Inert old spacing preserves native justification and the original pin.
    // Only the new suffix below owns these source offsets and interactions.
    for(const run of runs) if(run.start>=a.end) {
      const space=document.createElement('span');space.className='annotation-gloss-space reflow-prefix-space';
      space.setAttribute('aria-hidden','true');space.inert=true;
      run.node.replaceWith(space);space.append(run.node);spaces.push({space,node:run.node});
    }
    for(const word of block.querySelectorAll('[data-word]')) if(+word.dataset.sourceStart>=a.end) {
      save(word);
      for(const name of ['data-word','data-source-block','data-source-start','data-source-end','role','tabindex']) word.removeAttribute(name);
      word.style.visibility='hidden';word.style.pointerEvents='none';word.setAttribute('aria-hidden','true');
    }
    for(const annotation of block.querySelectorAll('[data-annotation]')) {
      const item=pages.r.annotations[+annotation.dataset.annotation];
      if(!item || item.end<=a.start) continue;
      for(const gloss of annotation.querySelectorAll('.gloss')) {save(gloss);gloss.classList.replace('gloss','annotation-gloss-space');}
      if(item.start>=a.end) {
        save(annotation);
        for(const name of ['data-annotation','data-annotation-slot','data-target','role','tabindex']) annotation.removeAttribute(name);
        annotation.style.visibility='hidden';annotation.style.pointerEvents='none';annotation.setAttribute('aria-hidden','true');
      }
    }
    save(block);block.dataset.end=a.end;
    const fragment=block.closest('.source-fragment');
    if(fragment) {
      save(fragment);fragment.dataset.fragmentEnd=a.end;
      for(const actions of fragment.querySelectorAll('.paragraph-actions')) detach(actions);
    }
    for(const following of [...prose.querySelectorAll('.source-fragment')]) {
      if(!following.contains(target) && (target.compareDocumentPosition(following)&Node.DOCUMENT_POSITION_FOLLOWING)) detach(following);
    }
    for(const container of [...prose.querySelectorAll('[data-retained-native-suffix]')]) {
      if(!container.contains(target) && !container.querySelector('.source-fragment')) detach(container);
    }
    for(let column=request.column+1;column<request.prose.length;column++) {
      for(const child of [...request.prose[column].childNodes]) detach(child);
    }
    for(const column of state.columns) if(column.container) {
      request.prose[column.column].append(column.container);added.push(column.container);
    }
    const binding=target.closest('[data-annotation],[data-annotation-slot]') || target;
    save(binding);save(target);
    binding.classList.remove('annotation-pending');
    target.classList.toggle('reflow-target-annotated',Boolean(state.focused) && binding===target);
    if(state.focused) {
      binding.dataset.annotation=pages.r.annotations.indexOf(state.focused);
      binding.dataset.target=state.focused.target;binding.dataset.kind=state.focused.kind;
      binding.style.borderColor='';
    } else {
      for(const name of ['data-annotation','data-target']) binding.removeAttribute(name);
      if(binding!==target) binding.style.borderColor='transparent';
    }
    if(restoreFocus) target.focus({preventScroll:true});
    if(!retainedPrefixUnchanged(request)) throw new Error('原文位置发生变化，已保留原来的页面。');
    const text=new Map();
    for(const run of sourceRuns(request.owner)) text.set(run.block,(text.get(run.block)||'')+run.node.textContent);
    for(const sourceBlock of request.owner.querySelectorAll('[data-block]')) {
      const original=pages.blocks.get(sourceBlock.dataset.block);
      if(pages.visualBlock(original)) continue;
      if((text.get(sourceBlock)||'')!==original.text.slice(+sourceBlock.dataset.start,+sourceBlock.dataset.end)) throw new Error('阅读文字位置校验未通过，已保留当前页面。');
    }
    return undo;
  } catch(error) {undo();throw error;}
}

export async function reconcileRetainedWordLayout(pages, request) {
  const serial=pages.retainedLayoutSerial=(pages.retainedLayoutSerial||0)+1;
  pages.retainedLayoutPending=request;
  const a=request.anchor;let generation;
  const valid=()=>pages.retainedLayoutSerial===serial && pages.retainedLayoutPending===request &&
    pages.generation===generation &&
    pages===request.r.pages && !request.r.scope.signal.aborted && request.r.doc.version===a.version &&
    (request.r.popElement===request.pop || !request.r.popElement) && request.target.isConnected &&
    pages.sourceIdentity===request.sourceIdentity && pages.geometryEpoch===request.geometryEpoch &&
    pages.navigation===request.navigation && request.leaves.every(leaf=>leaf.isConnected);
  try {
    const started=pages.reflow(request.position,{keepDOM:true,reason:'annotation'}),flow=pages.flowReady;
    generation=pages.generation;
    if(!await started || !await flow || !valid()) return false;
    if(annotationIdentity(pages.activeAnnotations.filter(request.before))!==request.beforeIdentity)
      throw new Error('前方注释也发生了变化，当前混排页面尚无法完整原位展开。');
    if(annotationIdentity(pages.activeAnnotations)===request.annotationIdentity) {
      pages.annotationLayout=captureAnnotationLayout(pages);
      return true;
    }
    const state=await nativeRetainedSuffix(pages,request,valid);
    if(!state || !valid()) return false;
    if(!retainedPrefixUnchanged(request)) throw new Error('原文位置已变化，已保留当前阅读位置。');
    const undo=commitRetainedSuffix(pages,request,state);
    const snapshots=captureAnnotationLayout(pages);
    if(!snapshots) {undo();throw new Error('阅读分页尚未准备完成，已保留原来的页面。');}
    pages.annotationLayout=snapshots;pages.clearPresentation();
    const retired=pages.painter.invalidate({deferTextures:true,preserveSurface:true});
    pages.wordReflow.retireTextures(retired);pages.wordReflow.releaseTextures();
    pages.r.collectionsController?.paint(request.owner);
    pages.r.notesController?.paint();pages.r.renderSelection?.();
    pages.navigationUI({geometry:false});
    await pages.r.ctx.run('draw',pages.r);
    pages.r.emit('draw');
    if(valid()) pages.annotationLayout=captureAnnotationLayout(pages) || pages.annotationLayout;
    return true;
  } finally {
    if(pages.retainedLayoutPending===request) pages.retainedLayoutPending=null;
    pages.markStable();
  }
}
