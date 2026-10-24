import { $, e, api, local } from "./core.js";
import { sourceUrlRanges, overlapsSourceUrl, sourceUrlParts } from "./source-urls.js";
import { pdfInlineStyles, pdfInlineObjects, renderPdfInline } from "./pdf-inline.js";
import { AnnotationReflow } from "./annotation-reflow.js";
import { captureAnnotationLayout } from "./annotation-layout.js";

const PRESENTATION_HISTORY_LIMIT = 4;

import { PageCurlRenderer } from "./page-curl-renderer.js?v=20261018-page-turn-latency-selection";

import { installReadingEdgeDrag } from "./reading-edge-drag.js?v=20261007-native-hd";

// Page numbers are presentation only. Every fragment keeps source UTF-16 offsets.
export class ReadingPages {
  constructor(reader) {
    this.r = reader;
    this.wordReflow = new AnnotationReflow(this);
    this.pages = [];
    this.index = 0;
    this.anchor = null;
    this.width = 0;
    this.height = 0;
    this.count = 1;
    this.animating = false;
    this.painter = reader.handoff?.painter || new PageCurlRenderer(this);
    if (reader.handoff?.painter) this.painter.rebind(this);
    this.generation = 0;
    this.navigation = 0;
    this.presentationRevision = 0;
    this.waiters = [];
    this.complete = true;
    this.ranges = new Map();
    this.edge = installReadingEdgeDrag(this);
    this.measure = document.createElement("article");
    this.measure.className = "reading-prose reading-page-measure";
    this.measure.setAttribute("aria-hidden", "true");
    document.querySelector(".reader").append(this.measure);
    const scope = reader.scope;
    scope.on($("#article"), "pointerdown", (event) => {
      if (event.button !== 0 || !event.target.closest(".source-fragment,[data-word],[data-annotation]")) return;
      this.interruptForSourceIntent();
    }, {capture: true});
    scope.on($("#article"), "keydown", (event) => {
      if (((event.key === "Enter" || event.key === " ") && event.target.matches("[data-word],[data-annotation]")) ||
          (event.shiftKey && /^(Arrow|Home|End)/.test(event.key))) this.interruptForSourceIntent();
    }, {capture: true});
    // choose/clearSelection announces intent before changing its anchor. This
    // also covers handle adjustments and selection from a non-pointer action.
    reader.on("before-selection", () => this.interruptForSourceIntent());
    let pixelRatio = devicePixelRatio || 1;
    scope.on(window, "resize", () => {
      if (pixelRatio === (devicePixelRatio || 1)) return;
      pixelRatio = devicePixelRatio || 1;
      this.invalidatePaint();
    });
    scope.cleanup(() => {
      this.finishAnimation("route-leave");
      this.clearRanges();
      ++this.generation;
      ++this.navigation;
      this.invalidateLayout();
      this.resolveFlow?.(false);
      clearTimeout(this.timer);
      this.wake();
      this.measure.remove();
    });
    let timer;
    const resize = new ResizeObserver(() => {
      if (reader.scope.signal.aborted) return;
      const rect = $(".reading-columns")?.getBoundingClientRect();
      if (!rect || !this.layoutChanged(rect)) return;
      clearTimeout(timer);
      const anchor = this.lastViewAnchor || this.position();
      this.invalidateLayout({geometry: true});
      timer = setTimeout(() => this.reflow(anchor, {reason: "viewport"}), 100);
    });
    resize.observe($(".reading-columns"));
    resize.observe($("#article"));
    scope.cleanup(() => {
      resize.disconnect();
      clearTimeout(timer);
    });
  }
  layoutChanged(rect) {
    const article = $("#article").getBoundingClientRect();
    return (
      Math.abs(rect.width - (this.containerWidth || 0)) > 1 ||
      Math.abs(rect.height - (this.containerHeight || 0)) > 1 ||
      Math.abs(article.width - (this.articleWidth || 0)) > 1 ||
      Math.abs(article.height - (this.articleHeight || 0)) > 1
    );
  }
  captureLayoutTicket() {
    return Object.freeze({docId:this.r.doc.id,sourceVersion:this.r.doc.version,
      layoutEpoch:this.layoutEpoch,generation:this.generation,navigation:this.navigation,
      annotationRevision:this.annotationRevision});
  }
  isCurrent(ticket) {
    const current=this.captureLayoutTicket();
    return Boolean(ticket && !this.r.scope.signal.aborted &&
      Object.keys(current).every(key=>current[key]===ticket[key]));
  }
  sourceAnchorEvidence(anchor = this.r.captureView().visibleAnchor) {
    const point=anchor && {block_id:anchor.block_id,start:anchor.start,end:anchor.end,
      version:anchor.version,affinity:"forward",
      ratio:((this.offsets.get(anchor.block_id) || 0)+anchor.start)/Math.max(1,this.length)};
    const leaves=[...document.querySelectorAll('#article .page-leaf')];
    const node=point && [...document.querySelectorAll('#article [data-word]')].find(node=>
      node.dataset.sourceBlock===point.block_id && +node.dataset.sourceStart<=point.start && +node.dataset.sourceEnd>point.start);
    const leaf=node?.closest('.page-leaf'),box=node?.getBoundingClientRect(),paper=leaf?.getBoundingClientRect();
    return {anchor:point,pageIndex:this.index,canonicalRevision:this.canonicalRevision,displayRevision:this.displayRevision,
      pendingRevision:this.wordReflow.pendingLayout?.revision ?? null,
      location:box?{leaf:leaves.indexOf(leaf),x:(box.x-paper.x)/paper.width,y:(box.y-paper.y)/paper.height}:null};
  }
  invalidateLayout({geometry = false} = {}) {
    this.layoutEpoch = (this.layoutEpoch || 0) + 1;
    this.stableEpoch = null;
    this.layoutComplete = false;
    if (geometry) {
      this.geometryEpoch = (this.geometryEpoch || 0) + 1;
      this.annotationLayout = null;
      this.wordReflow?.dispose();
    }
    for (const finish of [...(this.stableWaiters || [])]) finish(false);
    return this.layoutEpoch;
  }
  whenStable({epoch = this.layoutEpoch, signal} = {}) {
    if (signal?.aborted || this.r.scope.signal.aborted || epoch !== this.layoutEpoch)
      return Promise.resolve(false);
    if (this.markStable()) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = value => {
        this.stableWaiters.delete(finish);
        signal?.removeEventListener("abort", abort);
        this.r.scope.signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish(false);
      (this.stableWaiters ||= new Set()).add(finish);
      signal?.addEventListener("abort", abort, {once: true});
      this.r.scope.signal.addEventListener("abort", abort, {once: true});
      if (signal?.aborted || this.r.scope.signal.aborted || epoch !== this.layoutEpoch) finish(false);
    });
  }
  currentLayoutLanding() {
    const landed=this.layoutLanding;
    return Boolean(landed && landed.epoch===this.layoutEpoch && landed.generation===this.generation &&
      landed.navigation===this.navigation && landed.documentId===this.r.doc.id && landed.version===this.r.doc.version &&
      landed.leaf?.isConnected && landed.leaf.parentElement===landed.article && !this.canonicalDirty && !this.r.scope.signal.aborted);
  }
  markStable() {
    const word = this.wordReflow;
    if (!this.layoutComplete || !this.complete || this.displayPending || this.r.restoring ||
        this.animating || this.retainedLayoutPending || this.r.annotationRefreshPending || word?.pendingLayout || word?.flushing || word?.pendingCanonical ||
        (word?.owner?.isConnected && ["preparing", "playing"].includes(word.owner.dataset.reflowPhase)) ||
        this.r.scope.signal.aborted) return;
    this.stableEpoch = this.layoutEpoch;
    this.lastViewAnchor = this.r.captureView?.().visibleAnchor || null;
    for (const finish of [...(this.stableWaiters || [])]) finish(true);
    return true;
  }
  geometrySignature() {
    const article = $("#article"), prose = article.querySelector(".reading-prose") || article;
    const css = getComputedStyle(prose);
    return JSON.stringify([this.width, this.height, this.count, this.measure.style.width,
      css.fontFamily, css.fontSize, css.fontWeight, css.fontStyle, css.lineHeight,
      css.letterSpacing, css.wordSpacing, css.fontKerning, css.fontFeatureSettings,
      local.get("page-layout", "auto"), $("#translation-pane").hidden]);
  }
  layout() {
    const article = $("#article"),
      box = $(".reading-columns").getBoundingClientRect();
    const translated = !$("#translation-pane").hidden;
    const prefs = local.get("page-layout", "auto");
    const size =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--reading-size",
        ),
      ) || 22;
    const minimum = prefs === "double" ? 1000 : 2 * (size * 21 + 48) + 8;
    this.count =
      !translated && prefs !== "single" && box.width >= minimum ? 2 : 1;
    article.dataset.layout = this.count === 2 ? "double" : "single";
    $(".reader").dataset.pageLayout = article.dataset.layout;
    if (!article.children.length) article.innerHTML = this.leafMarkup(0);
    const leaf = article.querySelector(".page-leaf"),
      rect = leaf.getBoundingClientRect(),
      css = getComputedStyle(leaf);
    this.containerWidth = box.width;
    this.containerHeight = box.height;
    const articleBox = article.getBoundingClientRect();
    this.articleWidth = articleBox.width;
    this.articleHeight = articleBox.height;
    this.width = rect.width;
    this.height = Math.max(
      72,
      articleBox.height -
        parseFloat(css.paddingTop) -
        parseFloat(css.paddingBottom) -
        48 -
        4,
    );
    this.measure.style.width =
      Math.max(
        80,
        rect.width -
          parseFloat(css.paddingLeft) -
          parseFloat(css.paddingRight) -
          24 -
          2,
      ) + "px";
  }
  leafMarkup(index) {
    const fragments = this.pages[index] || [];
    // The edited spread is a temporary presentation, never a page boundary.
    // Preserve its current faces for a turn; a continuation packet owns its
    // destination faces without feeding them back into canonical pagination.
    const frozen = index >= this.index && index < this.index + this.count
      ? this.annotationLayout?.[index - this.index] : null;
    if (frozen) {
      const leaf = frozen.leaf.cloneNode(true);
      leaf.dataset.pageIndex = index;
      return leaf.outerHTML;
    }
    return `<section class="page-leaf" data-page-index="${index}"><div class="leaf-heading">${e(this.r.doc.title)}</div><div class="reading-prose">${this.fragmentsMarkup(fragments)}</div></section>`;
  }
  fragmentsMarkup(fragments) {
    let html = "", list = "";
    for (const fragment of fragments) {
      const block = this.blocks?.get(fragment.id);
      if (block?.type === "list-item") {
        const next = block.ordered ? "ol" : "ul";
        if (list !== next) {
          if (list) html += `</${list}>`;
          list = next;
          html += `<${list} class="source-list">`;
        }
        html += this.markup(fragment);
      } else {
        if (list) html += `</${list}>`;
        list = "";
        html += this.markup(fragment);
      }
    }
    if (list) html += `</${list}>`;
    return html;
  }
  invalidatePaint() {
    // A quiet word edit invalidates page textures, but has no curl frame to
    // finish. Clearing a retained full-screen Retina GL buffer here stalls
    // unrelated text animation on every feedback click.
    if (this.animating || this.preview || this.painter.scene) this.finishAnimation();
    const quietWord = this.wordReflow.eligible() && !this.animating && !this.preview && !this.painter.scene;
    const retired = this.painter.invalidate({deferTextures:quietWord,preserveSurface:quietWord});
    if (retired.length) this.wordReflow.retireTextures(retired);
    if (!this.wordReflow.eligible()) this.painter.warm();
  }
  finishAnimation(reason = "cancelled", {deferTrackpad = false} = {}) {
    if(this.preview?.finalize) return this.preview.finalize(false,reason);
    this.edge?.cancel(reason);
    if(!deferTrackpad)this.trackpad?.cancel(reason);
    if (this.preview) {
      const preview = this.preview;
      this.preview = null;
      preview.cancelled = true;
      cancelAnimationFrame(preview.raf);
      clearTimeout(preview.timeout);
      clearTimeout(preview.confirmTimer);
      clearTimeout(preview.settleTimer);
      clearTimeout(preview.loadingTimer);
      this.painter.record(false, reason, preview.requested, undefined, preview.setup);
      if (preview.boundary) this.recordBoundary(preview, false, reason);
    }
    delete $(".reader")?.dataset.pageTurning;
    clearTimeout(this.animationTimeout);
    this.animationToken = (this.animationToken || 0) + 1;
    this.painter.finish();
    this.animating = false;
    this.markStable();
  }
  interruptForSourceIntent() {
    ++this.navigation;
    if (this.preview || this.animating) this.finishAnimation("source-intent");
    // Release only navigation waiters; canonical flow continues for the new intent.
    this.wake();
  }
  presentationIdentity() {
    const css=getComputedStyle($("#article .reading-prose") || $("#article"));
    return JSON.stringify([this.r.doc.id,this.r.doc.version,this.generation,this.layoutEpoch,
      this.width,this.height,this.count,this.measure.style.width,css.font,css.lineHeight,css.letterSpacing,
      $("#translation-pane").hidden,this.activeAnnotations.map(a=>[a.block.id,a.start,a.end,a.note,a.kind,a.source])]);
  }
  presentationTextureGeneration(view) {
    return view.textureGeneration ||= `${this.generation}:view:${this.viewSerial=(this.viewSerial||0)+1}`;
  }
  clearPresentation() {
    this.presentationRevision++;
    this.presentedView=null;this.viewTrail=null;this.viewTrailIndex=0;this.viewIdentity=null;
    this.presentationPrefetch=new Map();
  }
  presentationPoints(snapshots) {
    const parts=snapshots.flatMap(page=>page.fragments).filter(f=>f.end>f.start || this.visualBlock(this.blocks.get(f.id)));
    const first=parts[0],last=parts.at(-1);
    return{start:first?{block_id:first.id,start:first.start}:null,
      end:last?{block_id:last.id,start:last.end,afterObject:this.visualBlock(this.blocks.get(last.id))}:null};
  }
  carryAfter(state, cursor) {
    if(!cursor || !state?.overflowGloss) return [];
    const order=new Map(this.r.doc.blocks.map((b,i)=>[b.id,i])),groups=new Map();
    for(const glyph of state.overflowGloss) {
      if(order.get(glyph.block_id)>order.get(cursor.block_id) ||
          (glyph.block_id===cursor.block_id && glyph.end>cursor.start)) continue;
      const item=this.activeAnnotations.find(a=>a.block.id===glyph.block_id && a.start===glyph.start && a.end===glyph.end);
      if(!item)continue;
      const key=JSON.stringify([glyph.block_id,glyph.start,glyph.end]);
      if(!groups.has(key))groups.set(key,{block_id:glyph.block_id,start:glyph.start,end:glyph.end,
        note:item.note,glyphStart:glyph.glyphStart,text:""});
      groups.get(key).text+=glyph.text;
    }
    const segment=new Intl.Segmenter(undefined,{granularity:"grapheme"});
    return [...groups.values()].filter(carry=>
      [...segment.segment(`〈${carry.note}〉`)].slice(carry.glyphStart).map(s=>s.segment).join("")===carry.text);
  }
  currentPresentation() {
    const identity=this.presentationIdentity();
    if(this.viewIdentity===identity && this.viewTrail?.[this.viewTrailIndex]) {
      const current=this.viewTrail[this.viewTrailIndex];
      this.presentationTextureGeneration(current);
      return current;
    }
    this.wordReflow.finish();
    const snapshots=captureAnnotationLayout(this);
    if(!snapshots)return null;
    for(const page of snapshots)page.leaf.querySelectorAll('.reflow-moving').forEach(n=>n.classList.remove('reflow-moving'));
    const points=this.presentationPoints(snapshots);
    if(!points.start || !points.end)return null;
    const priorIdentity=this.presentedView?.identity && JSON.parse(this.presentedView.identity);
    const validCarry=items=>priorIdentity?.[0]===this.r.doc.id && priorIdentity?.[1]===this.r.doc.version
      ? (items||[]).filter(item=>this.activeAnnotations.some(a=>a.block.id===item.block_id && a.start===item.start && a.end===item.end && a.note===item.note)) : [];
    const state=this.wordReflow.canonicalState,owner=state?.context?.anchor,focus=this.wordReflow.anchor;
    const ownsState=focus && owner?.block_id===focus.block_id && owner.start===focus.start && owner.end===focus.end;
    const current={snapshots,...points,identity,canonicalIndex:this.index,
      incomingCarry:validCarry(this.presentedView?.incomingCarry),
      outgoingCarry:ownsState?this.carryAfter(state,points.end):validCarry(this.presentedView?.outgoingCarry)};
    this.presentationTextureGeneration(current);
    this.presentationRevision++;
    this.presentationPrefetch=new Map();
    this.viewIdentity=identity;this.viewTrail=[current];this.viewTrailIndex=0;
    return current;
  }
  presentationOutside(direction) {
    if(!this.annotationLayout && !this.presentedView)return null;
    const current=this.currentPresentation();
    if(!current)return null;
    const cursor=direction>0?current.end:current.start,
      order=this.r.doc.blocks.findIndex(b=>b.id===cursor.block_id),block=this.blocks.get(cursor.block_id);
    return direction>0?order===this.r.doc.blocks.length-1 && cursor.start===block.text.length && !current.outgoingCarry.length
      : order===0 && cursor.start===0 && !current.incomingCarry.length;
  }
  async preparePresentation(direction, {from=null}={}) {
    if(from && (from.version!==undefined && from.version!==this.r.doc.version ||
      !Number.isInteger(from.start) || from.start<0 || from.start>this.blocks.get(from.block_id)?.text.length)) return null;
    const current=from?{identity:this.presentationIdentity(),end:from,outgoingCarry:[]}:this.currentPresentation();
    if(!current)return null;
    const historyIndex=this.viewTrailIndex+direction,prior=from?null:this.viewTrail?.[historyIndex];
    if(prior?.identity===current.identity)return this.presentationPacket(prior,{historyIndex});
    const prefetchKey=from?null:`${this.presentationTextureGeneration(current)}:${direction}`;
    const prefetched=prefetchKey&&this.presentationPrefetch?.get(prefetchKey);
    if(prefetched?.packet)return prefetched.packet;
    if(prefetched?.navigation===this.navigation)return prefetched.promise;
    if(prefetchKey&&prefetched)this.presentationPrefetch.delete(prefetchKey);
    const identity=current.identity,navigation=this.navigation;
    const valid=()=>!this.r.scope.signal.aborted && this.presentationIdentity()===identity && this.navigation===navigation;
    const preparing=(async()=>{
      const packet=Object.create(ReadingPages.prototype),measure=this.measure.cloneNode(false);
      this.measure.parentElement.append(measure);
      Object.assign(packet,{r:this.r,blocks:this.blocks,fragments:this.fragments,urlRanges:this.urlRanges,
        inlineStyles:this.inlineStyles,inlineObjects:this.inlineObjects,urlImages:this.urlImages,
        measure,width:this.width,height:this.height,count:this.count,pages:[],index:0,complete:false,
        viewStart:direction>0?current.end:null,incomingCarry:direction>0?current.outgoingCarry:[],
        excludedCarry:direction<0?current.incomingCarry:[]});
      const builder=direction>0?packet.buildPages():packet.reversePages(current.start);
      try {
        let done=false;
        while(!done && packet.pages.length<this.count) {
          if(!valid())return null;
          const deadline=performance.now()+4;
          do {
            const next=builder.next();done=next.done;
            if(!done && next.value===null)break;
            if(!done)packet.pages.push(next.value);
          }while(!done && packet.pages.length<this.count && performance.now()<deadline);
          if(!done && packet.pages.length<this.count)await new Promise(resolve=>setTimeout(resolve,0));
        }
        if(!valid())return null;
        if(direction<0)packet.pages.reverse();
        if(!packet.pages.length)return null;
        while(packet.pages.length<this.count)packet.pages.push([]);
        const snapshots=packet.pages.map((fragments,i)=>{
          const holder=document.createElement('div');holder.innerHTML=packet.leafMarkup(i);
          return{fragments,leaf:holder.firstElementChild};
        });
        const points=this.presentationPoints(snapshots);
        if(!points.start || !points.end)return null;
        const view={snapshots,...points,identity,canonicalIndex:this.pageFor(points.start),
          incomingCarry:packet.incomingCarry,outgoingCarry:[]};
        return this.presentationPacket(view,{direction});
      }finally{builder.return?.();measure.remove();}
    })();
    if(!prefetchKey)return preparing;
    this.presentationPrefetch??=new Map();
    const entry={navigation,promise:null,packet:null};
    entry.promise=preparing.then(packet=>{
      if(packet)entry.packet=packet;
      else if(this.presentationPrefetch.get(prefetchKey)===entry)this.presentationPrefetch.delete(prefetchKey);
      return packet;
    });
    this.presentationPrefetch.set(prefetchKey,entry);
    try{return await entry.promise;}
    catch(error){if(this.presentationPrefetch.get(prefetchKey)===entry)this.presentationPrefetch.delete(prefetchKey);throw error;}
  }
  presentationSourcePlanIdentity(current=this.viewTrail?.[this.viewTrailIndex]) {
    if((!this.annotationLayout && !this.presentedView) || !current)return null;
    return `${this.r.doc.id}:${this.r.doc.version}:${this.generation}:${this.presentationRevision}:`+
      `${current.textureGeneration}:${this.viewTrailIndex}:${this.index}:${this.count}`;
  }
  async getPresentationSourcePlan() {
    if(!this.annotationLayout && !this.presentedView)return null;
    const current=this.currentPresentation();
    if(!current)return null;
    const navigation=this.navigation,generation=this.generation,index=this.index,
      identity=this.presentationSourcePlanIdentity(current),
      valid=()=>!this.r.scope.signal.aborted && !this.animating && this.navigation===navigation &&
        this.generation===generation && this.index===index && this.viewTrail?.[this.viewTrailIndex]===current &&
        this.presentationSourcePlanIdentity()===identity;
    const sources=[this.presentationPacket(current,{historyIndex:this.viewTrailIndex})];
    for(const direction of [-1,1]) {
      if(!valid())return [];
      if(this.presentationOutside(direction)!==false)continue;
      const source=await this.preparePresentation(direction);
      if(!valid() || !source)return [];
      sources.push(source);
    }
    return {identity,sources,windows:sources.map(source=>source.view?.textureGeneration||source.generation)};
  }
  presentationPacket(view, intent) {
    const packet=Object.create(ReadingPages.prototype);
    Object.assign(packet,{r:this.r,blocks:this.blocks,fragments:this.fragments,urlRanges:this.urlRanges,
      inlineStyles:this.inlineStyles,inlineObjects:this.inlineObjects,urlImages:this.urlImages,
      pages:view.snapshots.map(p=>p.fragments),annotationLayout:view.snapshots,index:0,count:this.count,
      generation:this.presentationTextureGeneration(view),complete:true,view,intent});
    return packet;
  }
  commitPresentation(packet) {
    const navigation=this.navigation;
    const stale=()=>this.r.scope.signal.aborted || navigation!==this.navigation || packet.view.identity!==this.presentationIdentity();
    if(stale())return false;
    const {view,intent}=packet;
    this.wordReflow.dispose();
    if(stale())return false;
    this.r.emit('before-navigation');
    if(stale())return false;
    this.r.emit('before-page');
    if(stale())return false;
    this.r.closePop();this.r.cancelHighlight?.();
    if(stale())return false;
    this.r.selection=null;getSelection()?.removeAllRanges();
    // A canonical index can identify a different visible source window. Each
    // presentation now owns a stable texture generation, so retain bounded LRU
    // textures for an actual history return instead of forcing every turn cold.
    if(stale())return false;
    // No history or view mutation may precede a callback that can supersede it.
    if(intent.historyIndex!==undefined)this.viewTrailIndex=intent.historyIndex;
    else if(intent.direction>0) {
      this.viewTrail=this.viewTrail.slice(0,this.viewTrailIndex+1);this.viewTrail.push(view);++this.viewTrailIndex;
    }else{this.viewTrail.unshift(view);this.viewTrailIndex=0;}
    const dropped=Math.max(0,this.viewTrailIndex-PRESENTATION_HISTORY_LIMIT+1);
    if(dropped){this.viewTrail.splice(0,dropped);this.viewTrailIndex-=dropped;}
    if(this.viewTrail.length>PRESENTATION_HISTORY_LIMIT)this.viewTrail.splice(PRESENTATION_HISTORY_LIMIT);
    this.presentationRevision++;
    this.presentationPrefetch=new Map();
    this.presentedView=view;this.annotationLayout=view.snapshots;
    this.index=view.canonicalIndex;this.anchor=this.r.anchorFor(view.start.block_id,view.start.start,view.start.start);
    this.render();
    // draw may start a newer navigation after this view has already committed.
    if(!stale())this.r.emit('position');
    if(!stale() && !this.turnFinalizing && this.canonicalDirty)
      void this.wordReflow.flush({reconcile:true,anchor:this.r.captureView().visibleAnchor,ticket:this.captureLayoutTicket()});
    return true;
  }
  *reversePages(cursor) {
    let order=this.r.doc.blocks.findIndex(b=>b.id===cursor.block_id),end=cursor.start,page=[],used=0,slice=performance.now();
    const height=this.height;
    const measure=function*(part){
      this.measure.innerHTML=this.markup(part,true);
      const node=this.measure.firstElementChild,css=getComputedStyle(node),value=node.getBoundingClientRect().height+parseFloat(css.marginTop)+parseFloat(css.marginBottom)+2;
      if(performance.now()-slice>=4){yield null;slice=performance.now();}return value;
    }.bind(this);
    while(order>=0) {
      const block=this.r.doc.blocks[order],object=this.visualBlock(block);
      if(object && (block.id!==cursor.block_id || cursor.afterObject)) {
        const part={id:block.id,start:0,end:block.text.length,object:true},h=yield*measure(part);
        if(page.length && used+h>height){yield page;page=[];used=0;continue;}
        page.unshift(part);used+=Math.min(height,h);--order;end=this.r.doc.blocks[order]?.text.length||0;continue;
      }
      if(!end || object){--order;end=this.r.doc.blocks[order]?.text.length||0;continue;}
      const starts=[...block.text.slice(0,end).matchAll(/\S+\s*|\s+/g)].map(m=>m.index);
      if(!starts.length){--order;end=this.r.doc.blocks[order]?.text.length||0;continue;}
      let lo=0,hi=starts.length-1,best=-1,bestHeight=0;
      while(lo<=hi){const mid=(lo+hi)>>1,h=yield*measure({id:block.id,start:starts[mid],end});
        if(h<=height-used){best=mid;bestHeight=h;hi=mid-1;}else lo=mid+1;}
      if(best<0 && page.length){yield page;page=[];used=0;continue;}
      if(best<0){best=starts.length-1;bestHeight=height;}
      const start=starts[best];page.unshift({id:block.id,start,end});used+=bestHeight;end=start;
      if(start>0){yield page;page=[];used=0;}
      else{--order;end=this.r.doc.blocks[order]?.text.length||0;}
    }
    if(page.length)yield page;
  }
  async adjacent(direction, reason = "tap") {
    if(this.r.popElement)return;
    const intent=this.navigation;
    if (this.wordReflow.pendingLayout || this.wordReflow.flushing) await this.wordReflow.flush();
    if(this.r.scope.signal.aborted || this.r.popElement || intent!==this.navigation)return;
    if (this.r.focus.isOpen() || this.animating || this.displayPending) return;
    const presentationOutside=this.presentationOutside(direction);
    const target = presentationOutside!==null ? this.index+direction*this.count : this.index > 0
      ? Math.max(0, this.index + direction * this.count)
      : this.index + direction * this.count;
    if (presentationOutside===true || (presentationOutside===null && (target < 0 || (this.complete && target >= this.pages.length)))) {
      const next = this.neighbor(direction);
      if (next) {
        const rect = $("#article").getBoundingClientRect();
        const session = this.beginTurn(direction, rect.top + rect.height * 0.68, true);
        if (reason.startsWith("keyboard-")) session?.prefetchNext();
        session?.release(true, reason);
      } else this.r.status(this.r.doc.chapter
        ? direction > 0 ? "已到全书末尾" : "已到全书开头"
        : direction > 0 ? "已到本篇末尾" : "已到本篇开头");
      return;
    }
    return this.turn(Math.max(0, target), true, reason);
  }
  accelerateTurn(direction, reason = "keyboard-held") {
    if(this.r.popElement)return false;
    const preview = this.preview;
    if (!preview || preview.direction !== direction || preview.boundary ||
        !preview.session || preview.release?.reason !== "tap") return false;
    const progress = preview.session.resume();
    if (typeof progress !== "number") return false;
    preview.session.prefetchNext();
    preview.session.release(true, reason, { inputAt: performance.now() });
    return true;
  }
  neighbor(direction) {
    const chapters = this.r.doc.chapters || [];
    const current = chapters.findIndex(ch => ch.doc_id === this.r.doc.id);
    return this.r.doc.chapter && current >= 0 ? chapters[current + direction] : null;
  }
  rangeNeighbor(direction, report = false) {
    const doc = this.r.doc, next = this.neighbor(direction);
    if (!next) return null;
    // EPUB chapters use the same prepared-paper handoff. A plain route would
    // restore the destination's old resume position and drop the turn animation.
    if (!doc.pdf) return next;
    const range = doc.pdf.ranges?.find(v => v.doc_id === next.doc_id);
    if (!range || (direction > 0 ? range.start_page !== doc.pdf.end_page + 1
      : range.end_page !== doc.pdf.start_page - 1)) {
      if (report) this.r.status("相邻原页范围尚未准备，可从目录选择已准备内容或核对原版。", {notice: true});
      return null;
    }
    return next;
  }
  clearRanges() {
    clearTimeout(this.rangeWarmTimer);
    for (const entry of this.ranges.values()) entry.controller.abort();
    this.ranges.clear();
  }
  warmRanges() {
    clearTimeout(this.rangeWarmTimer);
    if (!this.r.doc.chapter || !this.complete || this.displayPending) return;
    const directions = [];
    if (this.index < this.count * 2) directions.push(-1);
    if (this.index + this.count * 2 >= this.pages.length) directions.push(1);
    this.rangeWarmTimer = setTimeout(async () => {
      for (const direction of directions) {
        if (this.r.scope.signal.aborted || this.animating) return;
        if (this.rangeNeighbor(direction)) {
          try {
            const source = await this.prepareRange(direction);
            // Six leaves cover the current and both adjacent spreads. Only a
            // boundary spread needs raster faces from another source range;
            // warming them earlier evicts the current page before a reverse turn.
            const index = this.index, generation = this.generation;
            const target = index + direction * this.count;
            if (!this.animating && !this.r.scope.signal.aborted &&
                (target < 0 || target >= this.pages.length)) {
              for (let offset = 0; offset < this.count; offset++) {
                if (this.animating || this.r.scope.signal.aborted ||
                    this.index !== index || this.generation !== generation) break;
                await this.painter.prepare(source.index + offset, source);
              }
            }
          } catch { /* Retry on the actual turn. */ }
        }
      }
    }, 160);
  }
  prepareRange(direction) {
    const next = this.rangeNeighbor(direction);
    if (!next) return Promise.reject(new Error("相邻阅读内容尚未准备"));
    if (this.ranges.has(next.doc_id)) return this.ranges.get(next.doc_id).promise;
    const controller = new AbortController(), generation = this.generation;
    const entry = {controller, packet: null};
    this.ranges.set(next.doc_id, entry);
    const timeout = setTimeout(() => controller.abort(), 15000);
    entry.promise = (async () => {
      let measure;
      try {
        const doc = await api(`/documents/${next.doc_id}?compact=true&density=${this.r.doc.density}`, {signal: controller.signal});
        if (this.r.doc.pdf ? (!doc.pdf || doc.pdf.book_id !== this.r.doc.pdf.book_id ||
            doc.pdf.source_sha256 !== this.r.doc.pdf.source_sha256 ||
            (direction > 0 ? doc.pdf.start_page !== this.r.doc.pdf.end_page + 1
              : doc.pdf.end_page !== this.r.doc.pdf.start_page - 1))
            : (!doc.chapter || doc.pdf || doc.chapter.book_id !== this.r.doc.chapter.book_id ||
              doc.chapter.idx !== this.r.doc.chapter.idx + direction || doc.id !== next.doc_id))
          throw new Error("相邻阅读内容已更新，请从目录重新核对阅读位置");
        // A bounded neighboring range, not a second mounted reader or a whole book.
        const reader = Object.create(Object.getPrototypeOf(this.r));
        Object.assign(reader, {ctx: this.r.ctx, scope: {signal: controller.signal}, doc, sourceBlocks: doc.blocks, search: ""});
        await reader.ctx.run("prepare-reading", reader);
        controller.signal.throwIfAborted();
        doc.blocks = reader.collectionsController?.applyAnnotations(reader.sourceBlocks) || reader.sourceBlocks;
        const pages = Object.create(ReadingPages.prototype);
        measure = this.measure.cloneNode(false);
        this.measure.parentElement.append(measure);
        Object.assign(pages, {r: reader, measure, pages: [], index: 0, complete: false,
          width: this.width, height: this.height, count: this.count, generation});
        reader.pages = pages;
        pages.indexSource();
        const builder = pages.buildPages();
        let done = false;
        while (!done) {
          controller.signal.throwIfAborted();
          if (this.r.scope.signal.aborted || generation !== this.generation)
            throw new DOMException("Reading layout changed", "AbortError");
          // Measurement must not compete with an already moving paper sheet.
          if (this.preview?.ready) {
            await new Promise(resolve => setTimeout(resolve, 30));
            continue;
          }
          const deadline = performance.now() + 4;
          do {
            const part = builder.next();
            done = part.done;
            if (!done && part.value === null) break;
            if (!done) pages.pages.push(part.value);
          } while (!done && performance.now() < deadline);
          if (!done) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (!pages.pages.length) throw new Error("相邻范围暂时没有可读内容");
        pages.complete = true;
        pages.index = direction > 0 ? 0 : Math.floor((pages.pages.length - 1) / pages.count) * pages.count;
        entry.packet = pages;
        return pages;
      } finally {
        clearTimeout(timeout);
        measure?.remove();
      }
    })().catch(error => {
      if (this.ranges.get(next.doc_id) === entry) this.ranges.delete(next.doc_id);
      throw error;
    });
    return entry.promise;
  }
  recordBoundary(preview, completed, reason) {
    if (preview.recorded) return;
    preview.recorded = true;
    const metric = {
      from: this.r.doc.id, to: preview.boundary.doc_id, direction: preview.direction,
      completed, reason, warm: preview.boundaryWarm,
      error: preview.failure || null,
      preparationMs: preview.preparedAt ? +(preview.preparedAt - preview.requested).toFixed(1) : null,
      totalMs: +(performance.now() - preview.requested).toFixed(1),
      landingIndex: preview.destination?.index ?? null,
      sourceStart: preview.destination?.r.doc.pdf?.start_page ?? null,
      sourceEnd: preview.destination?.r.doc.pdf?.end_page ?? null,
      paper: this.painter.scene ? this.painter.metrics?.at(-1) || null : null,
    };
    this.r.ctx.rangeTurns ??= [];
    this.r.ctx.rangeTurns.push(metric);
    this.r.ctx.rangeTurns = this.r.ctx.rangeTurns.slice(-20);
    $(".reader").dataset.rangeTurns = JSON.stringify(this.r.ctx.rangeTurns);
  }
  adopt(pages) {
    this.invalidateLayout({geometry: true});
    this.layout();
    // A comparison pane or a viewport change can alter the landing geometry.
    // Preserve the target source, never reuse pagination measured at another width.
    const fragment = pages.pages[pages.index]?.[0];
    if (this.count !== pages.count || Math.abs(this.width - pages.width) > 1 ||
        Math.abs(this.height - pages.height) > 1) {
      return this.reflow(fragment ? this.r.anchorFor(fragment.id, fragment.start, fragment.start) : null);
    }
    this.generation = pages.generation;
    this.pages = pages.pages;
    this.complete = true;
    this.index = pages.index;
    this.anchor = this.firstAnchor();
    this.geometryIdentity = this.geometrySignature();
    this.layoutComplete = true;
    $(".reader").dataset.paginationReady = "true";
    this.render();
    return Promise.resolve();
  }
  async seek(ratio) {
    this.r.emit("before-navigation");
    const offset = Math.round(Math.max(0, Math.min(1, ratio)) * this.length);
    const block =
      this.r.doc.blocks.find(
        (b) => (this.offsets.get(b.id) || 0) + b.text.length >= offset,
      ) || this.r.doc.blocks.at(-1);
    if (block)
      await this.restore(
        this.r.anchorFor(
          block.id,
          Math.min(block.text.length - 1, offset - this.offsets.get(block.id)),
          Math.min(block.text.length - 1, offset - this.offsets.get(block.id)),
        ),
        false,
      );
  }
  indexSource({preserveAnnotations = false} = {}) {
    if (!preserveAnnotations) this.r.annotations = [];
    const prior = new Map(this.r.annotations.map((a, index) =>
      [JSON.stringify([a.block.id,a.start,a.end,a.note,a.source]),index]));
    this.activeAnnotations = [];
    this.fragments = new Map();
    if (!preserveAnnotations) {
      this.urlRanges = new Map();
      this.inlineStyles = new Map();
      this.inlineObjects = new Map();
    }
    this.blocks = new Map();
    this.offsets = new Map();
    this.length = 0;
    for (const block of this.r.doc.blocks) {
      this.blocks.set(block.id, block);
      if (!preserveAnnotations) {
        this.inlineStyles.set(block.id, pdfInlineStyles(block));
        this.inlineObjects.set(block.id, this.r.doc.pdf
          ? pdfInlineObjects(block, this.r.doc.pdf.book_id) : []);
      }
      this.offsets.set(block.id, this.length);
      this.length += block.text.length;
      const urls = preserveAnnotations ? this.urlRanges.get(block.id) : sourceUrlRanges(block.text || "");
      if (!preserveAnnotations) this.urlRanges.set(block.id, urls);
      let cursor = 0;
      this.fragments.set(
        block.id,
        (block.fragments || [{type: "plain", text: block.text || ""}]).map((f) => {
          const item = { ...f, start: cursor, end: cursor + f.text.length };
          cursor = item.end;
          if (overlapsSourceUrl(urls, item.start, item.end)) item.type = "plain";
          if (item.type !== "plain") {
            const annotation = {
                ...f,
                start: item.start,
                end: item.end,
                block,
              };
            const key = JSON.stringify([block.id,item.start,item.end,item.note,item.source]);
            item.annotation = prior.get(key) ?? this.r.annotations.push(annotation) - 1;
            this.activeAnnotations.push(this.r.annotations[item.annotation]);
          }
          return item;
        }),
      );
    }
    const source = JSON.stringify([this.r.doc.id, this.r.doc.version]);
    const annotations = JSON.stringify(this.activeAnnotations.map(a =>
      [a.block.id, a.start, a.end, a.kind, a.text, a.note, a.target, a.source]));
    if (source !== this.sourceIdentity || annotations !== this.annotationIdentity) {
      this.annotationRevision=(this.annotationRevision || 0)+1;
      this.invalidateLayout({geometry: this.sourceIdentity !== undefined && source !== this.sourceIdentity});
    }
    this.sourceIdentity = source;
    this.annotationIdentity = annotations;
  }
  words(text, offset, block) {
    return sourceUrlParts(text, offset, this.urlRanges.get(block) || [])
      .map((part) => {
        if (part.url)
          return `<span class="source-unit source-url" data-source-url data-source-start="${part.start}" data-source-end="${part.end}" data-source-block="${e(block)}">${this.r.highlight(part.text)}</span>`;
        return [...part.text.matchAll(/\S+\s*|\s+/g)]
          .map((m) => {
            const value = m[0],
              word = value.match(
                /[A-Za-z\uFB00-\uFB06]+(?:['’-][A-Za-z\uFB00-\uFB06]+)*/,
              );
            if (!word) return this.r.highlight(value);
            const start = part.start + m.index + word.index,
              end = start + word[0].length;
            return (
              this.r.highlight(value.slice(0, word.index)) +
              `<span class="source-unit" role="button" tabindex="0" data-word="${e(word[0])}" data-source-start="${start}" data-source-end="${end}" data-source-block="${e(block)}" aria-label="查阅 ${e(word[0])}">${this.r.highlight(word[0])}</span>` +
              this.r.highlight(value.slice(word.index + word[0].length))
            );
          })
          .join("");
      })
      .join("");
  }
  markup(fragment, measure = false) {
    const b = this.blocks.get(fragment.id);
    const { start, end } = fragment;
    if (this.visualBlock(b)) {
      const urlAsset = this.urlAsset(b);
      const decoded = urlAsset ? this.urlImages?.get(urlAsset) : null;
      const box = b.source?.bbox;
      const width = Math.max(1, decoded?.naturalWidth || b.width || (box && box[2] - box[0]) || 600);
      const height = Math.max(1, decoded?.naturalHeight || b.height || (box && box[3] - box[1]) || 400);
      const available = Math.max(80, parseFloat(this.measure.style.width) || this.width - 64);
      const fitWidth = Math.min(available, width * 2);
      const scale = Math.min(1, Math.max(32, this.height - 100) / (fitWidth * height / width));
      const shownWidth = Math.round(fitWidth * scale), shownHeight = Math.round(shownWidth * height / width);
      if (urlAsset) {
        const figure = `<figure data-block="${e(b.id)}" data-start="0" data-end="0" class="url-image" style="margin:1.1em 0;max-width:100%"><img src="${e(urlAsset)}" alt="文章插图" width="${shownWidth}" height="${shownHeight}" style="display:block;margin-inline:auto;width:${shownWidth}px;height:${shownHeight}px;max-width:100%;object-fit:contain" draggable="false" decoding="async"></figure>`;
        if (measure) return figure;
        return `<section class="source-fragment url-image-fragment" data-fragment="${e(b.id)}" data-fragment-start="0" data-fragment-end="0"><div class="source-row"><span class="grammar-slot" aria-hidden="true"></span>${figure}</div></section>`;
      }
      const caption = b.type === "image_fallback"
        ? `原图保留${b.source?.page_number ? ` · 来源第 ${b.source.page_number} 页` : ""}`
        : b.caption || "";
      const figure = `<figure data-block="${e(b.id)}" data-start="0" data-end="${b.text.length}" data-pdf-object="${e(b.id)}" class="pdf-object ${e(b.type)}"><img src="${e(b.asset_url)}" alt="${e(caption || "PDF 原图")}" width="${shownWidth}" height="${shownHeight}" style="width:${shownWidth}px;height:${shownHeight}px;max-width:100%;object-fit:contain" draggable="false" decoding="async">${caption ? `<figcaption>${e(caption)}</figcaption>` : ""}</figure>`;
      if (measure) return figure;
      return `<section class="source-fragment pdf-object-fragment" data-fragment="${e(b.id)}" data-fragment-start="0" data-fragment-end="${b.text.length}"><div class="source-row"><span class="grammar-slot" aria-hidden="true"></span>${figure}</div></section>`;
    }
    const tag =
      { heading: "h2", quote: "blockquote", code: "pre", "list-item": "div" }[b.type] || "p";
    const carry=this.viewStart?.block_id===b.id && this.viewStart.start===start
      ? (this.incomingCarry||[]).map(item=>{
        const index=this.r.annotations.findIndex(a=>a.block.id===item.block_id && a.start===item.start && a.end===item.end && a.note===item.note);
        return index<0?"":`<span class="annotation" data-annotation="${index}" data-kind="continuation" role="button" tabindex="0"><span class="gloss reflow-note-piece" data-reflow-key="${e(JSON.stringify([item.block_id,item.start,item.end,item.glyphStart]))}" aria-hidden="true">${e(item.text)}</span></span>`;
      }).join("") : "";
    const text = carry+(this.fragments.get(b.id) || [])
      .filter((f) => f.start < end && f.end > start)
      .map((f) => {
        const a = Math.max(start, f.start),
          z = Math.min(end, f.end),
          source = b.text.slice(a, z);
        const render = (value, offset) => measure ? e(value)
          : b.type === "code" ? this.r.highlight(value) : this.words(value, offset, b.id);
        const styles = this.inlineStyles.get(b.id) || [];
        const objects = this.inlineObjects.get(b.id) || [];
        const rendered = styles.length || objects.length
          ? renderPdfInline(source, a, styles, render, objects)
          : render(source, a);
        if (f.type === "plain") return rendered;
        const cut=this.excludedCarry?.find(item=>item.block_id===b.id && item.start===f.start && item.end===f.end && item.note===f.note);
        const prefix=cut?[...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(`〈${f.note}〉`)].slice(0,cut.glyphStart).map(s=>s.segment).join(""):null;
        const gloss=z!==f.end?"":cut?(prefix?`<span class="gloss reflow-note-piece" data-reflow-key="${e(JSON.stringify([b.id,f.start,f.end,0]))}" aria-hidden="true">${e(prefix)}</span>`:""):`<span class="gloss" aria-hidden="true">${e(f.note)}</span>`;
        return `<span class="annotation" role="button" tabindex="0" data-target="${e(f.target)}" data-kind="${e(f.kind)}" data-annotation="${f.annotation}" aria-label="${e(source)}：${e(f.note)}"><span class="source-text">${rendered}</span>${gloss}</span>`;
      })
      .join("");
    const source = `<${tag} data-block="${b.id}" data-start="${start}" data-end="${end}" class="${b.type === "list-item" ? "list-block" : b.type}">${text}</${tag}>`;
    if (measure) return source;
    const actions =
      b.type === "heading"
        ? ""
        : `<div class="paragraph-actions"><button data-read-block="${b.id}" type="button" ${this.r.ctx.enabled("tts") ? "" : "hidden"}>听这一段</button><button data-select-block="${b.id}" type="button">选择这一段</button></div>`;
    const wrapper = b.type === "list-item" ? "li" : "section";
    return `<${wrapper} class="source-fragment" data-fragment="${b.id}" data-fragment-start="${start}" data-fragment-end="${end}"><div class="source-row"><span class="grammar-slot" data-grammar-slot="${b.id}"></span>${source}</div>${actions}<section class="inline-grammar" data-grammar-block="${b.id}" hidden></section></${wrapper}>`;
  }
  urlAsset(block) {
    const doc = this.r.doc, snapshot = doc.source?.snapshot_id;
    if (doc.pdf || !doc.source) return null;
    if (block?.type !== "image") return null;
    if (doc.availability !== "ready" || typeof snapshot !== "string" ||
        !/^[a-f0-9]{64}$/.test(snapshot) || typeof block.asset_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(block.asset_id))
      throw new Error("文章图片引用无效，请重新核对资料。");
    return `/api/import/url/snapshots/${snapshot}/assets/${block.asset_id}`;
  }
  async prepareUrlImages() {
    this.urlImages ??= new Map();
    for (const block of this.r.doc.blocks) {
      const url = this.urlAsset(block);
      if (!url || this.urlImages.has(url)) continue;
      const image = new Image(), signal = this.r.scope.signal;
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          image.onload = image.onerror = null;
          if (error) { image.removeAttribute("src"); reject(error); }
          else resolve();
        };
        const abort = () => finish(new DOMException("Reading closed", "AbortError"));
        const timer = setTimeout(() => finish(new Error("文章图片加载超时，请重新打开文章。")), 10000);
        image.onload = () => image.decode().then(() => finish(), () => finish(new Error("文章图片无法解码。")));
        image.onerror = () => finish(new Error("文章图片无法读取，请核对保留资料。"));
        signal.addEventListener("abort", abort, {once: true});
        if (signal.aborted) abort();
        else image.src = url;
      });
      signal.throwIfAborted();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("文章图片尺寸无效。");
      this.urlImages.set(url, image);
    }
  }
  visualBlock(block) {
    if (this.urlAsset(block)) return true;
    if (this.r.doc.source && !this.r.doc.pdf) return false;
    if (!block || !["image", "image_fallback", "formula", "table"].includes(block.type) || !block.asset_url) return false;
    try {
      const url = new URL(block.asset_url, location.origin);
      return url.origin === location.origin && /^\/api\/pdf\/books\/\d+\/assets\//.test(url.pathname);
    } catch { return false; }
  }
  wake() {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  // Build exact pages cooperatively. The first completed page is usable immediately.
  async reflow(anchor = this.position(), {keepDOM = false, reason = keepDOM ? "annotation" : "layout", reuseEpoch = false} = {}) {
    if (this.r.scope.signal.aborted) return;
    // A delayed metadata response can contain the exact annotation revision
    // already reconciled after a turn. Refresh bindings, not pagination.
    if(reason==="annotation" && !keepDOM && this.complete && !this.canonicalDirty &&
        this.canonicalSourceIdentity===this.sourceIdentity && this.canonicalAnnotationIdentity===this.annotationIdentity &&
        this.geometryIdentity===this.geometrySignature()) {
      this.render();
      return true;
    }
    const geometryChange=["font","size","line","width","typography-reset","viewport","columns"].includes(reason);
    let geometryIntent=null;
    if(geometryChange && this.validAnchor(anchor)) {
      const prior=this.geometryRestore;
      // Rapid inputs retain the original source start until the newest layout
      // lands. An intervening source navigation starts a different intent.
      if(prior && prior.navigation===this.navigation && prior.documentId===this.r.doc.id && prior.version===this.r.doc.version) anchor=prior.anchor;
      geometryIntent={anchor:structuredClone(anchor),navigation:this.navigation,documentId:this.r.doc.id,version:this.r.doc.version};
    }
    this.geometryRestore=geometryIntent;
    const epoch = reuseEpoch && this.layoutEpoch
      ? this.layoutEpoch : this.invalidateLayout({geometry: reason !== "annotation"});
    const generation = ++this.generation;
    this.layoutLanding=null;
    this.resolveFlow?.(false);
    this.flowReady = new Promise(resolve => { this.resolveFlow = resolve; });
    const retainedNavigation = this.navigation;
    if (!keepDOM) this.wordReflow.dispose();
    if (this.r.doc.source && !this.r.doc.pdf) {
      await this.prepareUrlImages();
      if (this.r.scope.signal.aborted || generation !== this.generation) return;
    }
    this.clearRanges();
    clearTimeout(this.timer);
    this.wake();
    if (this.animating || this.preview || this.painter.scene) this.finishAnimation();
    this.painter.invalidate({preserveSurface:keepDOM});
    // Explicit size/layout changes release word-action layout reservations.
    this.layout();
    const geometry = this.geometrySignature();
    if (this.geometryIdentity !== undefined && geometry !== this.geometryIdentity) {
      this.annotationLayout = null;
      this.geometryEpoch = (this.geometryEpoch || 0) + 1;
      this.wordReflow.dispose();
      keepDOM = false;
    }
    this.geometryIdentity = geometry;
    // Keep the currently visible source during font/density/column changes.
    // Replacing it with page one while seeking a late anchor causes a visible jump.
    this.displayPending = Boolean(
      this.validAnchor(anchor) && $("#article").children.length,
    );
    this.pages = [];
    if (!keepDOM) this.index = 0;
    this.complete = false;

    $(".reader").dataset.paginationReady = "false";
    this.flowStarted = performance.now();
    const builder = this.buildPages();
    const advance = () => {
      if (generation !== this.generation || this.r.scope.signal.aborted) return;
      if (this.animating) {
        this.timer = setTimeout(advance, 30);
        return;
      }
      const deadline = performance.now() + 5;
      do {
        const next = builder.next();
        if (next.done) {
          this.complete = true;
          if (!this.pages.length) this.pages = [[]];
          if (keepDOM && retainedNavigation === this.navigation) {
            this.index = this.pageFor(anchor);
            this.anchor = this.validAnchor(anchor) || this.firstAnchor();
          }
          this.canonicalDirty = false;
          this.canonicalSourceIdentity=this.sourceIdentity;
          this.canonicalAnnotationIdentity=this.annotationIdentity;
          this.canonicalRevision=this.annotationRevision;
          this.wordReflow.acknowledge(this.canonicalRevision);
          this.measure.replaceChildren();
          $(".reader").dataset.paginationReady = "true";
          $(".reader").dataset.paginationMs = (
            performance.now() - this.flowStarted
          ).toFixed(1);
          if (!keepDOM) { this.painter.warm(); this.warmRanges(); }
          this.resolveFlow?.(true);
          break;
        }
        if (next.value === null) break;
        this.pages.push(next.value);
      } while (performance.now() < deadline);
      if ((this.pages.length >= this.count || (this.complete && this.pages.length)) &&
          !keepDOM && !this.displayPending && this.painted !== generation) {
        this.painted = generation;
        this.anchor = this.firstAnchor();
        this.render();
      } else this.navigationUI();
      this.wake();
      if (!this.complete) this.timer = setTimeout(advance, 0);
    };
    advance();
    let landing;
    if (keepDOM) {
      this.displayPending = false;
      if (retainedNavigation === this.navigation) this.anchor = anchor;
      landing = Promise.resolve(true);
    } else {
      landing = this.restore(anchor, false, {reflow: true, alignStart:Boolean(geometryIntent)});
      if(geometryIntent && this.geometryRestore===geometryIntent) geometryIntent.navigation=this.navigation;
    }
    Promise.all([this.flowReady, landing]).then(([complete, landed]) => {
      if (epoch !== this.layoutEpoch || generation !== this.generation) return;
      this.layoutComplete = Boolean(complete && (landed || this.currentLayoutLanding()));
      if(this.layoutComplete && geometryIntent && this.geometryRestore===geometryIntent) this.geometryRestore=null;
      if (this.layoutComplete) this.markStable();
      else for (const finish of [...(this.stableWaiters || [])]) finish(false);
    }).catch(() => {
      if (epoch === this.layoutEpoch)
        for (const finish of [...(this.stableWaiters || [])]) finish(false);
    });
    return landing;
  }
  *flowSegments() {
    const blocks=this.r.doc.blocks,from=this.viewStart?blocks.findIndex(b=>b.id===this.viewStart.block_id):0;
    if(from<0)return;
    for(let i=from;i<blocks.length;i++) {
      const block=blocks[i],start=i===from&&this.viewStart?this.viewStart.start:0;
      if(i===from&&this.viewStart?.afterObject)continue;
      if(start===block.text.length && !this.visualBlock(block)) {
        if(i===from&&this.incomingCarry?.length)yield{block,start,end:start,carryOnly:true};
        continue;
      }
      yield{block,start,end:block.text.length};
    }
  }
  *buildPages() {
    const height = this.height;
    let page = [],
      used = 0;
    let sliceStarted = performance.now();
    const measure = function* (part) {
      this.measure.innerHTML = this.markup(part, true);
      const el = this.measure.firstElementChild,
        css = getComputedStyle(el);
      const measured = (
        el.getBoundingClientRect().height +
        parseFloat(css.marginTop) +
        parseFloat(css.marginBottom) +
        2
      );
      // A page can require many forced layouts. Yield inside its binary search,
      // preserving the measured value and all fragment state across the pause.
      // null is a scheduling checkpoint, never a completed reading page.
      if (performance.now() - sliceStarted >= 4) {
        yield null;
        sliceStarted = performance.now();
      }
      return measured;
    }.bind(this);
    for (const segment of this.flowSegments()) {
      if (segment.pages) {
        if (page.length) yield page;
        yield* segment.pages;
        page = [];
        used = 0;
        continue;
      }
      const b = segment.block;
      if(segment.carryOnly) {
        const part={id:b.id,start:segment.start,end:segment.end,annotationCarry:true},h=yield*measure(part);
        if(h>height)throw new Error("注释续页超出当前页面，请保留当前阅读位置后调整排版。");
        page.push(part);used+=h;continue;
      }
      if (this.visualBlock(b)) {
        const part = {id: b.id, start: 0, end: b.text.length, object: true};
        const objectHeight = yield* measure(part);
        if (page.length && used + objectHeight > height) {
          yield page;
          page = [];
          used = 0;
        }
        page.push(part);
        used += Math.min(height, objectHeight);
        continue;
      }
      const ends = [...b.text.matchAll(/\S+\s*/g)].map(
        (m) => m.index + m[0].length,
      ).filter(end => end > segment.start && end <= segment.end);
      if (!ends.length) continue;
      ends[ends.length - 1] = segment.end;
      let i = 0,
        start = segment.start;
      while (i < ends.length) {
        let lo = i + 1,
          hi = Math.min(ends.length, i + 240),
          best = i,
          bestHeight = 0;
        // Most book blocks fit whole: avoid a binary search for every paragraph.
        const wholeHeight = yield* measure({ id: b.id, start, end: ends[hi - 1] });
        if (wholeHeight <= height - used) {
          best = hi;
          bestHeight = wholeHeight;
        } else {
          hi--;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const h = yield* measure({ id: b.id, start, end: ends[mid - 1] });
            if (h <= height - used) {
              best = mid;
              bestHeight = h;
              lo = mid + 1;
            } else hi = mid - 1;
          }
        }
        if (best === i) {
          if (page.length) {
            yield page;
            page = [];
            used = 0;
            continue;
          }
          best = i + 1;
          bestHeight = height;
        }
        const crossing = this.fragments
          .get(b.id)
          .find(
            (f) =>
              f.type !== "plain" &&
              f.start < ends[best - 1] &&
              f.end > ends[best - 1],
          );
        if (crossing) {
          const before = ends.findIndex(
            (v, n) => n >= i && v >= crossing.start,
          );
          if (
            before >= i &&
            before + 1 < best &&
            ends[before] <= crossing.start
          )
            best = before + 1;
        }
        const end = ends[best - 1];
        page.push({ id: b.id, start, end });
        used += bestHeight;
        start = end;
        i = best;
        if (i < ends.length) {
          yield page;
          page = [];
          used = 0;
        }
      }
    }
    if (page.length) yield page;
  }
  validAnchor(anchor) {
    if (this.r.doc.pdf && anchor?.pdf_source) {
      const block = this.r.pdfAnchorBlock(anchor);
      return block ? {...anchor, block_id: block.id} : null;
    }
    return anchor?.block_id &&
      this.r.doc.blocks.some((b) => b.id === anchor.block_id)
      ? anchor
      : null;
  }
  pageFor(anchor) {
    let block = this.r.doc.blocks.find((b) => b.id === anchor?.block_id),
      start = anchor?.start || 0;
    if (this.r.doc.pdf && anchor?.pdf_source) block = this.r.pdfAnchorBlock(anchor);
    if (!block && anchor?.quote) {
      block = this.r.doc.pdf ? null : this.r.doc.blocks.find((b) => b.text.includes(anchor.quote));
      start = block?.text.indexOf(anchor.quote) || 0;
    }
    const i =
      block &&
      this.pages.findIndex((p) =>
        p.some(
          (f) =>
            f.id === block.id &&
            start >= f.start &&
            (start < f.end || (f.end === block.text.length && start === f.end)),
        ),
      );
    if (typeof i === "number" && i >= 0) return i;
    return Math.max(
      0,
      Math.min(
        this.pages.length - 1,
        Math.floor((anchor?.ratio || 0) * this.pages.length),
      ),
    );
  }
  firstAnchor() {
    const f = this.pages[this.index]?.[0];
    return f ? this.r.anchorFor(f.id, f.start, f.start) : { ratio: 0 };
  }
  position() {
    const a = this.anchor || this.firstAnchor();
    return {
      ...a,
      ratio: Math.min(
        1,
        ((this.offsets?.get(a?.block_id) || 0) + (a.start || 0)) /
          Math.max(1, this.length || 0),
      ),
    };
  }
  navigationUI({geometry = true} = {}) {
    const total = this.pages.length,
      last = Math.min(total, this.index + this.count);
    $("#reading-page-total").textContent =
      `${this.r.doc.chapter && !this.r.doc.pdf ? "本章 " : ""}${this.index + 1}${last > this.index + 1 ? "–" + last : ""} / ${total}${this.complete ? "" : "+"}`;
    const root = $(".reader");
    if (geometry) this.updateEdges();
    root.dataset.pageIndex = String(this.index);
    root.dataset.pageCount = String(total);
    root.dataset.sourcePosition = JSON.stringify(this.position());
    $(".read-progress div").style.width = this.position().ratio * 100 + "%";
  }
  render() {
    this.displayRevision=this.annotationRevision;
    this.painted = this.generation;
    $("#article").innerHTML = Array.from({ length: this.count }, (_, i) =>
      this.leafMarkup(this.index + i),
    ).join("");
    this.r.collectionsController?.paint($("#article"));
    this.navigationUI();
    this.r.renderSelection();
    this.r.ctx.run("draw", this.r).catch(console.error);
    this.r.emit("draw");
    this.markStable();
    this.painter.warm();
    this.warmRanges();
    if (!$(".reader").dataset.firstSourceMs)
      $(".reader").dataset.firstSourceMs = (
        performance.now() - this.r.ctx.readStarted
      ).toFixed(1);
  }
  lightEnabled() {
    return local.get("page-light", true);
  }
  canGrab(ownPreview = false) {
    // Word-card input belongs to the card until the reader closes it.
    return (
      !this.r.scope.signal.aborted &&
      !this.r.popElement &&
      !this.r.focus.isOpen() &&
      !this.r.aiSetupOpen &&
      !this.r.grammarInspecting &&
      !this.r.panelId &&
      !document.querySelector("dialog[open]") &&
      !$("#reading-stage").inert &&
      $("#translation-pane").hidden &&
      !this.displayPending &&
      (!this.animating || ownPreview)
    );
  }
  updateEdges() {
    const article = $("#article"),
      stage = $("#reading-stage"),
      leaves = [...article.children];
    if (!leaves.length) return;
    const rect = article.getBoundingClientRect(),
      bounds = stage.getBoundingClientRect();
    const enabled = $("#translation-pane").hidden;
    for (const [id, right] of [
      ["reading-edge-prev", false],
      ["reading-edge-next", true],
    ]) {
      const edge = $("#" + id),
        page = leaves[right ? leaves.length - 1 : 0].getBoundingClientRect();
      edge.hidden = !enabled;
      // Only outer paper padding and outer margin; never cover source text/notes.
      Object.assign(edge.style, {
        top: rect.top - bounds.top + 24 + "px",
        height: Math.max(0, rect.height - 48) + "px",
        left: right
          ? page.right - bounds.left - 14 + "px"
          : -bounds.left + "px",
        width: right
          ? innerWidth - page.right + 14 + "px"
          : page.left + 14 + "px",
      });
    }
  }
  commitPage(index) {
    const navigation=this.navigation,generation=this.generation;
    const stale=()=>this.r.scope.signal.aborted || navigation!==this.navigation || generation!==this.generation;
    if(stale())return false;
    this.r.emit("before-navigation");
    if(stale())return false;
    this.r.emit("before-page");
    if(stale())return false;
    this.clearPresentation();
    this.wordReflow.dispose();
    this.annotationLayout = null;
    this.r.closePop();
    this.r.cancelHighlight?.();
    if(stale())return false;
    this.r.selection = null;
    getSelection()?.removeAllRanges();
    this.index = index;
    this.anchor = this.firstAnchor();
    this.render();
    if(!stale())this.r.emit("position");
    if(!stale() && !this.turnFinalizing && this.canonicalDirty)
      void this.wordReflow.flush({reconcile:true,anchor:this.r.captureView().visibleAnchor,ticket:this.captureLayoutTicket()});
    return true;
  }
  beginTurn(direction, clientY, force = false) {
    // Forced button/keyboard entry must obey the same word-card boundary.
    if(this.r.scope.signal.aborted || this.r.popElement)return null;
    // A canonical reflow that already owns the document must finish first.
    // Pending (not-yet-started) work is safe: this turn freezes the current
    // presentation and either disposes it on commit or resumes it on cancel.
    if(this.wordReflow.flushing)return null;
    const setup = this.painter.collectPerformance ? { enteredAt: performance.now(), inputEvents: [] } : null;
    if ((!force && !this.canGrab()) || this.animating || this.displayPending || this.painter.scene)
      return null;
    // A preview is reversible. Assistance expires only when a new view commits.
    const presented=this.presentationOutside(direction);
    const currentView=presented===null?null:this.currentPresentation();
    const currentSource=currentView
      ? this.presentationPacket(currentView,{historyIndex:this.viewTrailIndex})
      : this;
    const target = presented!==null ? this.index+direction*this.count : this.index > 0
      ? Math.max(0, this.index + direction * this.count)
      : this.index + direction * this.count;
    if (presented===null && !this.complete && target + this.count > this.pages.length) return null;
    const outside=presented===null
      ? target < 0 || target >= this.pages.length : presented;
    const boundary = outside && this.complete ? this.rangeNeighbor(direction, true) : null;
    if (outside && !boundary) return null;
    document
      .querySelectorAll("#article .actions-visible")
      .forEach((el) => el.classList.remove("actions-visible"));
    const article = $("#article"),
      rect = article.getBoundingClientRect(),
      elements = [...article.children],
      element = elements[direction > 0 && this.count === 2 ? 1 : 0],
      leaf = element.getBoundingClientRect(),
      token = ++this.navigation;
    let generation=this.generation;
    const turnTxn={before:this.r.captureView(),ticket:this.captureLayoutTicket(),mutation:this.wordReflow.pendingLayout};
    if(setup) {
      setup.sourceBefore=this.sourceAnchorEvidence(turnTxn.before.visibleAnchor);
      setup.mutationRevision=turnTxn.mutation?.revision ?? null;
    }
    const preview = (this.preview = {
      requested: performance.now(),
      setup,
      progress: 0.008,
      dy: 0,
      grab: Math.max(0.02, Math.min(0.98, (clientY - leaf.top) / leaf.height)),
      ready: false,
      cancelled: false,
      raf: 0,
      boundary,
      direction,
      boundaryWarm: Boolean(boundary && this.ranges.get(boundary.doc_id)?.packet),
    });
    const turnRun=this.animationToken,turnPainter=this.painter,turnScene=turnPainter.scene;
    this.animating = true;
    // The open-card guard has already passed; retire any pending lookup so
    // its late response cannot open a card during this new turn.
    this.r.closePop();
    if (setup) {
      setup.previewCreatedAt = performance.now();
      this.painter.attachSetup = null;
    }
    $(".reader").dataset.pageTurning = "true";
    const valid = () =>
      this.preview === preview &&
      !preview.cancelled &&
      token === this.navigation &&
      generation === this.generation &&
      turnRun === this.animationToken &&
      !this.r.scope.signal.aborted;
    const canAttach = () => valid() && this.painter===turnPainter && turnPainter.scene===turnScene;
    const finalize = (complete, reason) => {
      if(this.preview!==preview || preview.finalized) return;
      preview.finalized=true;
      complete=complete && valid() && this.isCurrent(turnTxn.ticket);
      this.painter.record(complete, reason, preview.requested, preview.settle, preview.setup);
      clearTimeout(preview.timeout);
      clearTimeout(preview.loadingTimer);
      if (boundary) this.recordBoundary(preview, complete, reason);
      clearTimeout(preview.settleTimer);
      this.preview = null;
      this.finishAnimation(reason,{deferTrackpad:true});
      if(!this.isCurrent(turnTxn.ticket)) {this.trackpad?.cancel(reason);return;}
      let committed=!complete;
      this.turnFinalizing=true;
      try {
      if (complete && boundary) {
        const stale = () => token !== this.navigation || generation !== this.generation || this.r.scope.signal.aborted;
        if (stale()) return;
        this.r.emit("before-navigation");
        if (stale()) return;
        this.r.emit("before-page");
        if (!stale()) {this.r.ctx.commitReadingRange(this.r, preview.destination);committed=true;}
      }
      else if (complete && preview.presentation) committed=this.commitPresentation(preview.presentation);
      else if (complete) committed=this.commitPage(target);
      else this.painter.warm();
      } finally {this.turnFinalizing=false;}
      this.trackpad?.cancel(complete && committed?"settled":reason);
      // Only the terminal outcome chooses the source intent. The candidate's
      // original anchor must never overwrite a successfully landed view.
      if(this.r.scope.signal.aborted || this.r.doc.id!==turnTxn.ticket.docId || this.r.doc.version!==turnTxn.ticket.sourceVersion) return;
      const anchor=complete && committed?this.r.captureView().visibleAnchor:turnTxn.before.visibleAnchor;
      const reconciliation=this.wordReflow.flush({reconcile:true,anchor,ticket:this.captureLayoutTicket()});
      if(setup) {
        setup.outcome={completed:Boolean(complete && committed),reason,status:complete && committed?'landed':'cancelled'};
        setup.sourceOutcome=this.sourceAnchorEvidence(anchor);
        // Existing diagnostic export already includes this setup record. Keep
        // source identities/coordinates only: no book text and no frame probe.
        void Promise.resolve(reconciliation).then(async()=>{
          const stable=await this.whenStable();
          if(this.r.scope.signal.aborted)return;
          setup.stable=Boolean(stable);
          if(stable) {
            setup.sourceStable=this.sourceAnchorEvidence();
            setup.originalAnchorAfter=this.sourceAnchorEvidence(turnTxn.before.visibleAnchor);
          }
          $(".reader").dataset.curlMetrics=JSON.stringify(this.painter.metrics || []);
        });
      }
    };
    preview.finalize=finalize;
    const done = (complete, reason) => {if(valid())finalize(complete,reason);};
    const draw = () => {
      preview.raf = 0;
      if (valid() && preview.ready) {
        if (preview.following) {
          const delta = preview.target - preview.progress;
          preview.progress +=
            Math.sign(delta) * Math.min(0.06, Math.abs(delta));
          preview.following = Math.abs(delta) > 0.06;
        }
        this.painter.draw(
          preview.progress,
          preview.grab,
          preview.dy,
          preview.inputAt,
        );
        if (preview.following) preview.raf = requestAnimationFrame(draw);
        else if (preview.release)
          settle(
            preview.release.complete,
            preview.release.reason,
            preview.release.options,
          );
      }
      preview.inputAt = 0;
    };
    const settle = (complete, reason, options) => {
      if (!valid()) return;
      if (setup && setup.inputEvents.length < 128)
        setup.inputEvents.push({ kind: "release", handledAt: performance.now(), complete, reason });
      if (boundary && !complete && !preview.ready) {
        done(false, reason);
        return;
      }
      preview.release = {
        complete,
        reason,
        options,
        at: preview.release?.at ?? performance.now(),
      };
      if (!preview.ready || preview.following) return;
      cancelAnimationFrame(preview.raf);
      clearTimeout(preview.settleTimer);
      if (!this.painter.scene) {
        clearTimeout(preview.confirmTimer);
        preview.confirmTimer = setTimeout(
          () => done(complete, reason),
          Math.max(0, (options?.notBefore || 0) - performance.now()),
        );
        return;
      }
      $(".reader").dataset.curlPhase = "settling";
      const from = preview.progress,
        to = complete ? 1 : 0,
        dy = preview.dy,
        start = performance.now(),
        native = reason.startsWith("native-"),
        nativeQueued = reason === "native-queued-ended",
        trackpad = reason.startsWith("trackpad-"),
        keyboardFast = reason === "keyboard-held" || reason === "keyboard-tap-queued",
        duration = nativeQueued
          ? Math.max(16, Math.min(20, Math.abs(to - from) * 28))
          : native
          ? Math.max(20, Math.min(24, Math.abs(to - from) * 32))
          : keyboardFast
          ? Math.max(44, Math.min(46, Math.abs(to - from) * 54))
          : trackpad
          ? complete
            ? Math.max(160, Math.min(360, Math.abs(to - from) * 450))
            : Math.max(180, Math.min(480, from * 450))
          : complete
            ? Math.max(240, Math.min(540, Math.abs(to - from) * 560))
            : 220;
      preview.settle = {
        from,
        start,
        releaseAt: preview.release.at,
        inputAt: options?.inputAt,
        duration,
      };
      const frame = (now) => {
        if (!valid()) return;
        // A frame timestamp may precede a release handled in that same frame.
        // Never extrapolate the settling pose backwards before its start.
        // A busy compositor can deliver an rAF timestamp well before callback
        // entry. Native release duration follows elapsed time, not that stale
        // timestamp or an extra number of progress-limited frames.
        const clock = native ? performance.now() : now,
          t = Math.max(0, Math.min(1, (clock - start) / duration)),
          // Smooth in both directions; cancel no longer snaps with a short
          // ease-out. Confirmation is separate from this reversible preview.
          ease = trackpad ? t * t * (3 - 2 * t) : 1 - Math.pow(1 - t, 3);
        const confirmed = clock >= (options?.notBefore || 0);
        let desired = from + (to - from) * ease;
        if (complete && !confirmed) desired = Math.min(0.98, desired);
        const delta = desired - preview.progress;
        preview.progress = native && t === 1 && confirmed
          ? to
          : native || trackpad
          ? preview.progress +
            Math.sign(delta) *
              Math.min(nativeQueued ? 0.55 : native ? 0.4 : 0.065, Math.abs(delta))
          : desired;
        preview.dy = dy * (1 - ease);
        // A release may cancel a queued input frame. Preserve that input's
        // latency evidence on the first settling draw instead of losing it.
        this.painter.draw(preview.progress, preview.grab, preview.dy, preview.inputAt, "settling");
        preview.inputAt = 0;
        if (t < 1 || !confirmed || Math.abs(to - preview.progress) > 0.00001)
          preview.raf = requestAnimationFrame(frame);
        else done(complete, reason);
      };
      preview.raf = requestAnimationFrame(frame);
      if (native) {
        // Commit the final rendered pose at the elapsed release deadline even
        // when the compositor delivers rAF callbacks late. This is a bounded
        // completion task, not a second animation loop; actual draw/landing
        // times remain measured, and every cancel/resume clears the task.
        const land = () => {
          if (!valid() || preview.settle?.start !== start) return;
          const remaining = Math.max(start + duration, options?.notBefore || 0) - performance.now();
          if (remaining > 0) {
            preview.settleTimer = setTimeout(land, Math.ceil(remaining));
            return;
          }
          cancelAnimationFrame(preview.raf);
          preview.raf = 0;
          frame(performance.now());
        };
        preview.settleTimer = setTimeout(land, Math.ceil(Math.max(duration, (options?.notBefore || 0) - start)));
      }
    };
    const session = {
      turnDistance:
        leaf.width * 2 +
        (this.count === 2
          ? elements[1].getBoundingClientRect().left -
            elements[0].getBoundingClientRect().right
          : 0),
      height: leaf.height,
      update: (p, dy, inputAt, catchUp = false) => {
        if (!valid() || preview.release) return;
        if (setup && setup.inputEvents.length < 128)
          setup.inputEvents.push({ kind: "update", handledAt: performance.now(), inputAt, progress: p });
        if (catchUp || preview.following) {
          preview.target = p;
          preview.following = true;
        } else preview.progress = p;
        preview.dy = dy;
        preview.inputAt = inputAt;
        if (preview.ready && !preview.raf)
          preview.raf = requestAnimationFrame(draw);
      },
      release: settle,
      handoffRelease: () => {
        const release = preview.release;
        if (!valid() || !preview.ready || !release?.reason.startsWith("native-") ||
            performance.now() < (release.options?.notBefore || 0)) return;
        // A new gesture has already begun. Finish the released sheet's
        // actual final pose now so that the new gesture can own the next sheet,
        // rather than waiting for another compositor callback of the old one.
        cancelAnimationFrame(preview.raf);
        clearTimeout(preview.settleTimer);
        preview.raf = 0;
        preview.progress = release.complete ? 1 : 0;
        preview.dy = 0;
        this.painter.draw(preview.progress, preview.grab, 0, preview.inputAt, "settling");
        preview.inputAt = 0;
        done(release.complete, release.reason);
      },
      prefetchNext: () => {
        if (!valid() || boundary || !this.complete) return;
        const after = target + direction * this.count;
        for (let offset = 0; offset < this.count; offset++)
          if (after + offset >= 0 && after + offset < this.pages.length)
            void this.painter.prepare(after + offset);
      },
      resume: () => {
        if (!valid()) return null;
        cancelAnimationFrame(preview.raf);
        clearTimeout(preview.confirmTimer);
        clearTimeout(preview.settleTimer);
        preview.raf = 0;
        preview.release = null;
        preview.settle = null;
        preview.following = false;
        $(".reader").dataset.curlPhase = "dragging";
        return preview.progress;
      },
      cancel: (reason) => {
        if (valid()) this.finishAnimation(reason);
      },
    };
    preview.session = session;
    const motionOff = local.get("page-motion", "curl") === "off" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches || this.painter.failed;
    if (!boundary && motionOff && presented===null) { preview.ready = true; return session; }
    const leaves = elements.map(el => {
      const box = el.getBoundingClientRect();
      return { x: box.left - rect.left, y: 0, width: box.width, height: box.height };
    });
    if (setup) setup.layoutCapturedAt = performance.now();
    const ready = (front, back, stationary = []) => {
      if (!canAttach() || preview.ready) return;
      if (setup) setup.readyEnteredAt = performance.now();
      clearTimeout(preview.timeout);
      clearTimeout(preview.loadingTimer);
      if (!motionOff) this.painter.attach(
        leaves,
        direction,
        front,
        back,
        preview.grab,
        stationary,
      );
      if (setup) setup.attachReturnedAt = performance.now();
      preview.ready = true;
      // Submit at most one paper frame per refresh. An eager draw followed by
      // an immediate rAF used to submit two Retina spreads before presentation.
      if (preview.release && !preview.following)
        settle(
          preview.release.complete,
          preview.release.reason,
          preview.release.options,
        );
      else if (!preview.raf) preview.raf = requestAnimationFrame(draw);
    };
    const prepare = async (source, index) => {
      if (!canAttach()) return;
      if (setup) setup.incomingStartedAt = performance.now();
      const frontIndex = currentSource.index + (direction > 0 ? this.count - 1 : 0),
        backIndex = index + (direction < 0 ? this.count - 1 : 0);
      const faces = this.count === 1
        ? [{ source, index, x: leaves[0].x }]
        : direction > 0
          ? [{ source: currentSource, index: currentSource.index, x: leaves[0].x },
             { source, index: index + 1, x: leaves[1].x }]
          : [{ source, index, x: leaves[0].x },
             { source: currentSource, index: currentSource.index + 1, x: leaves[1].x }];
      if (setup) setup.incomingReadyAt = performance.now();
      if (motionOff) { ready(null, null); return; }
      this.painter.pendingTextures = [...new Set([
        this.painter.key(frontIndex,currentSource), this.painter.key(backIndex, source),
        ...faces.map(face => this.painter.key(face.index, face.source)),
      ])];
      this.painter.wasWarm = this.painter.pendingTextures.every(key => this.painter.cache.has(key));
      if (!boundary) preview.timeout = setTimeout(() => {
        $(".reader").dataset.curlFallback = "texture-timeout";
        ready(null, null);
      }, 1200);
      const [front, back, ...staticTextures] = await Promise.all([
        this.painter.prepare(frontIndex,currentSource), this.painter.prepare(backIndex, source),
        ...faces.map(face => this.painter.prepare(face.index, face.source)),
      ]);
      if (setup) setup.texturesReadyAt = performance.now();
      if (!canAttach()) return;
      if (boundary && (!front || !back || staticTextures.some(texture => !texture)) && !this.painter.failed)
        throw new Error("相邻页面图像尚未准备");
      ready(front, back, faces.map((face, i) => ({ x: face.x, texture: staticTextures[i] })));
    };
    if (boundary) {
      preview.loadingTimer = setTimeout(() => {
        if (valid() && !preview.ready) this.r.status("正在准备相邻页面，当前阅读位置保留…", {notice: true});
      }, 700);
      preview.timeout = setTimeout(() => {
        if (!valid()) return;
        done(false, "range-timeout");
        this.r.status("相邻页面暂未准备好，当前页面已保留。再次翻页可重试。", {notice: true});
      }, 15000);
      this.prepareRange(direction).then(source => {
        if (!valid()) return;
        preview.destination = source;
        preview.preparedAt = performance.now();
        return prepare(source, source.index);
      }).catch(error => {
        if (!valid()) return;
        preview.failure = error.name === "AbortError" ? "请求已中止或超时" : error.message;
        done(false, "range-error");
        this.r.status(`相邻页面未能加载，当前页面已保留；再次翻页可重试。${error.name === "AbortError" ? "" : " " + error.message}`, {notice: true});
      });
    } else if(presented!==null) {
      (async()=>{
        if(!valid())return;
        const source=await this.preparePresentation(direction);
        if(!valid())return;
        if(!source){done(false,'source-window-unavailable');return;}
        preview.presentation=source;return prepare(source,0);
      })().catch(error=>{
        if(!valid())return;
        preview.failure=error.message;done(false,'source-window-error');
        this.r.status(`相邻页面未能排版，当前阅读位置已保留。${error.message}`,{notice:true});
      });
    } else prepare(this, target);
    return session;
  }
  async turn(index, animate = false, reason = "tap") {
    if(this.r.popElement)return;
    const intent=this.navigation;
    if (this.wordReflow.pendingLayout || this.wordReflow.flushing) await this.wordReflow.flush();
    if(this.r.scope.signal.aborted || this.r.popElement || intent!==this.navigation)return;
    if (
      this.displayPending ||
      this.animating ||
      (index < 0 && !this.annotationLayout && !this.presentedView) ||
      index === this.index
    )
      return;
    const navigation = ++this.navigation,
      generation = this.generation;
    while (!this.complete && index + this.count > this.pages.length) {
      await new Promise((resolve) => this.waiters.push(resolve));
      if (
        navigation !== this.navigation ||
        generation !== this.generation ||
        this.r.popElement ||
        this.r.scope.signal.aborted
      )
        return;
    }
    if ((index >= this.pages.length && !this.annotationLayout && !this.presentedView) || this.r.popElement || this.r.scope.signal.aborted) return;
    if (
      animate &&
      Math.abs(index - this.index) === this.count &&
      $("#translation-pane").hidden
    ) {
      const rect = $("#article").getBoundingClientRect(),
        session = this.beginTurn(
          Math.sign(index - this.index),
          rect.top + rect.height * 0.68,
          true,
        );
      if (reason.startsWith("keyboard-")) session?.prefetchNext();
      session?.release(true, reason);
    } else {
      if(this.annotationLayout || this.presentedView) {
        const source=await this.preparePresentation(Math.sign(index-this.index));
        if(source && navigation===this.navigation && generation===this.generation && !this.r.popElement && !this.r.scope.signal.aborted)this.commitPresentation(source);
      }else this.commitPage(index);
    }
  }
  async restore(anchor, mark = true, {reflow = false, alignStart = false, signal} = {}) {
    if (signal?.aborted || this.r.scope.signal.aborted) return false;
    if (mark && anchor?.block_id) {
      const visible = [
        ...document.querySelectorAll("#article [data-block]"),
      ].some(
        (el) =>
          el.dataset.block === anchor.block_id &&
          (anchor.start || 0) >= +el.dataset.start &&
          (anchor.start || 0) < +el.dataset.end,
      );
      if (!visible) this.r.emit("before-navigation");
    }
    if (signal?.aborted || this.r.scope.signal.aborted) return false;
    this.finishAnimation();
    const navigation = ++this.navigation,
      generation = this.generation,epoch=this.layoutEpoch,documentId=this.r.doc.id,version=this.r.doc.version;
    const publication=this.captureLayoutTicket();
    const stale = () => signal?.aborted || !this.isCurrent(publication);
    const hasPage = () =>
      anchor?.block_id &&
      this.pages.some((p) =>
        p.some(
          (f) =>
            f.id === anchor.block_id &&
            (anchor.start || 0) >= f.start &&
            ((anchor.start || 0) < f.end ||
              f.end === this.blocks.get(f.id)?.text.length),
        ),
      );
    while (
      !this.complete &&
      (!this.pages.length || (!hasPage() &&
        (anchor?.block_id || anchor?.quote || anchor?.ratio > 0)) ||
        this.pages.length < this.pageFor(anchor) + this.count)
    ) {
      await new Promise((resolve) => {
        // Cancellation wakes only this restore, without waiting for more pages.
        const wake = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener("abort", wake, {once: true});
        if (signal?.aborted) wake();
      });
      if (stale()) return false;
    }
    if (stale()) return false;
    let view=null;
    if(alignStart) {
      const from=this.validAnchor(anchor);
      if(!from) return false;
      const packet=await this.preparePresentation(1,{from});
      if(stale() || !packet) return false;
      view=packet.view;
    }
    const index = this.pageFor(anchor);
    const visibleStart=this.annotationLayout && this.presentationPoints(this.annotationLayout).start;
    const sameWindow=!alignStart && visibleStart?.block_id===anchor?.block_id && visibleStart?.start===anchor?.start;
    this.displayPending = false;
    if (index !== this.index) this.r.emit("before-page", {reflow});
    if (stale()) return false;
    if(view) {
      this.clearPresentation();
      this.presentedView=view;this.annotationLayout=view.snapshots;
      this.viewTrail=[view];this.viewTrailIndex=0;this.viewIdentity=view.identity;
    } else if (!reflow && !sameWindow) {this.wordReflow.dispose();this.annotationLayout = null;this.clearPresentation();}
    this.index = index;
    this.anchor = this.validAnchor(anchor) || this.firstAnchor();
    this.render();
    const el = [...document.querySelectorAll("#article [data-block]")].find(
      (el) => el.dataset.block === this.anchor.block_id,
    );
    if (mark) el?.classList.add("anchor-flash");
    this.r.emit("position");
    if(stale() || epoch!==this.layoutEpoch || documentId!==this.r.doc.id || version!==this.r.doc.version) return false;
    const leaf=document.querySelector('#article .page-leaf');
    this.layoutLanding={epoch,generation,navigation,documentId,version,leaf,article:leaf?.parentElement};
    if(this.complete && this.currentLayoutLanding()) this.layoutComplete=true;
    this.markStable();
    return true;
  }
}
