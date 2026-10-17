// Opt-in, bounded, in-memory capture. No localStorage/IndexedDB copy of source.
import { api, setEvidenceObserver, toast } from './core.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const id = () => crypto.randomUUID();
const visible = el => {
  if (!el?.isConnected || el.closest('[hidden]')) return false;
  const style = getComputedStyle(el), r = el.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
};

export class ReadingEvidence {
  constructor(ctx) {
    this.ctx = ctx; this.state = null; this.queue = []; this.size = 0;
    this.session = id(); this.seq = 0; this.last = ''; this.pending = new Map();
    this.undo = new Map(); this.error = ''; this.inflight = false; this.generation = 0;
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('wr-evidence-control') : null;
    if (this.channel) this.channel.onmessage = () => { this.stopLocal(); this.sync().catch(() => {}); };
    this.storageChanged = event => {
      if (event.key === null || event.key === this.intentKey()) {
        this.stopLocal(); this.sync().catch(() => {});
      }
    };
    window.addEventListener('storage', this.storageChanged);
    this.disposeObserver = setEvidenceObserver(this);
    this.timer = setInterval(() => this.tick(), 2000);
    this.pagehide = () => {
      if (!this.pending.size) this.record('session_closed', 'observed');
      this.flush(true);
    };
    window.addEventListener('pagehide', this.pagehide);
  }
  stopLocal() {
    this.generation++; this.queue = []; this.size = 0; this.pending.clear(); this.last = '';
    if (this.activity) { this.activity.last = null; this.activity.recent = null; }
    if (this.state) this.state = {...this.state, enabled: 0};
  }
  intentKey() { return this.library ? 'wr-evidence-intent-v1:' + this.library : null; }
  intent() {
    try { return this.intentKey() ? JSON.parse(localStorage.getItem(this.intentKey()) || 'null') : null; }
    catch { this.error = 'control-storage-unavailable / 本机已停采，无法持久确认设置'; return null; }
  }
  permitted() {
    const intent = this.intent();
    return Boolean(!this.deniedMemory && this.state?.enabled && intent?.mode === 'allow' && intent.epoch === this.state.epoch);
  }
  async sync() {
    const generation = this.generation;
    let next;
    try { next = await api('/evidence/status'); }
    catch (error) {
      if (generation === this.generation) {
        this.stopLocal();
        this.error = 'status-unconfirmed/gap / 采集状态未确认，本窗口已暂停；未确认队列可能有缺口，已有持久证据保留。请重试状态检查或明确重新开启。';
        this.notice();
      }
      throw error;
    }
    // A control action, storage event or another accepted epoch invalidates this response.
    if (generation !== this.generation) return this.state;
    this.library = next.library_id;
    const intent = this.intent();
    const enabled = !this.error && !this.deniedMemory && next.enabled && intent?.mode === 'allow' && intent.epoch === next.epoch ? 1 : 0;
    const changed = this.state?.epoch !== next.epoch || this.state?.enabled !== enabled;
    if (changed) { this.stopLocal(); this.session = id(); this.seq = 0; }
    this.state = {...next, enabled, server_enabled:next.enabled};
    this.controlNotice = !enabled && next.enabled ? '本机已停采；服务端状态可能仍开启。只有明确开启才恢复，关闭/清除未确认不代表成功。' : '';
    if (changed && enabled) this.record('session_opened', 'observed', {tail_policy: 'Unclosed session has unknown/gap tail; no historical backfill'});
    this.notice();
    return this.state;
  }
  notice() {
    const reason = this.error || this.state?.pause;
    if (reason && reason !== this.lastNotice) {
      this.lastNotice=reason;
      toast('本机阅读证据已暂停，已有证据保留。', {label:'查看',run:()=>this.ctx.navigate('#/evidence')});
    }
    const badge = document.querySelector('[data-evidence-state]');
    if (badge) badge.textContent = this.error || this.state?.pause ? '本机证据：已暂停 / 有缺口' : this.state?.enabled ? '本机证据：采集中' : '本机证据：未采集';
    const status = document.querySelector('[data-evidence-control-status]');
    if (status) status.textContent = this.error || this.state?.pause || this.controlNotice || '';
    const enable = document.querySelector('[data-enable]'), disable = document.querySelector('[data-disable]');
    if (enable) enable.disabled = Boolean(this.state?.enabled || this.state?.pause);
    if (disable) disable.disabled = !this.state?.server_enabled;
  }
  async control(action) {
    const epoch = this.state.epoch, key = this.intentKey(), token = id();
    // Only opaque consent metadata is durable; source never enters browser storage.
    // Persist the veto BEFORE sending, and recheck it on every capture/batch.
    this.stopLocal(); this.deniedMemory = true;
    let vetoPersisted = false;
    try {
      if (!key) throw new Error('library identity unavailable');
      localStorage.setItem(key, JSON.stringify({mode:'deny',token}));
      vetoPersisted = true; this.deniedMemory = false;
    } catch {
      this.error = 'control-storage-unavailable / 本窗口已停采；无法持久保存关闭意图';
      // Failure to store consent must forbid enabling, never prevent stopping.
      if (action === 'enable') { this.notice(); throw new Error(this.error); }
    }
    this.channel?.postMessage('stop'); this.notice();
    try {
      const state = await api('/evidence/control', {method:'POST',body:{action,epoch,confirm:action !== 'disable'}});
      if (!vetoPersisted) {
        this.state = {...state,enabled:0,server_enabled:state.enabled};
        this.error = `control-storage-unavailable / 服务端已确认${action === 'clear' ? '清除并关闭' : '关闭'}；本窗口已停采，本浏览器意图存储失败。旧标记不适用于新 epoch。`;
        this.channel?.postMessage('changed'); this.notice(); return state;
      }
      // An explicit later stop in any window wins over this late enable response.
      if (this.intent()?.token !== token) { await this.sync(); return state; }
      if (action === 'enable') localStorage.setItem(key,JSON.stringify({mode:'allow',token,epoch:state.epoch}));
      this.error = ''; this.state = {...state,enabled:0};
      await this.sync(); this.channel?.postMessage('changed');
      return state;
    } catch (error) {
      this.error = vetoPersisted
        ? 'control-unconfirmed / 本机已停采；服务端关闭或清除结果未确认，可重试或明确重新开启'
        : 'control-unconfirmed / 仅本窗口暂时停采；关闭意图存储失败且服务端未确认。其他窗口或重新加载可能恢复旧采集，请保持当前窗口并重试关闭，不要视为持久关闭或已清除';
      this.notice(); throw error;
    }
  }
  record(event_type, status, details = {}, snapshot = null, operation_id = null, evidence_class = 'fact') {
    if (!this.permitted() || this.error) return;
    const event = {schema_version:1,event_id:id(),session_id:this.session,session_seq:++this.seq,
      client_time:new Date().toISOString(),event_type,status,details,observer:'client',evidence_class};
    if (snapshot) event.snapshot = snapshot;
    if (operation_id) event.operation_id = operation_id;
    const size = bytes(event);
    if (this.queue.length >= 128 || this.size + size > 512 * 1024) {
      this.error = 'queue-overflow/gap'; this.notice(); return;
    }
    this.queue.push(event); this.size += size;
    if (this.queue.length >= 32) this.flush();
  }
  openDocument(r) {
    const root = this.ctx.root.querySelector('.reader');
    if (!root) return;
    const activity = {reader:r,root,last:performance.now(),recent:performance.now()};
    this.activity = activity;
    this.record('document_open','observed',{doc_id:r.doc.id,version:r.doc.version,inference:'none'},this.snapshot(r));
    const suspend = () => { activity.last = null; activity.recent = null; };
    const interact = event => {
      if (!event.isTrusted || event.target?.closest?.('input,textarea,[contenteditable="true"]')) return;
      activity.recent = performance.now();
      if (activity.last === null) activity.last = activity.recent;
    };
    for (const name of ['pointerdown','keydown','wheel']) r.scope.on(root,name,interact,{passive:true});
    r.scope.on(window,'blur',suspend);
    r.scope.on(document,'visibilitychange',suspend);
    r.scope.cleanup(()=>{if(this.activity===activity)this.activity=null;});
  }
  sampleActivity() {
    const a = this.activity, now = performance.now();
    if (!a) return;
    const last = a.last; a.last = now;
    if (!this.permitted() || !a.root.isConnected || document.hidden || !document.hasFocus() ||
        document.activeElement?.matches('input,textarea,[contenteditable="true"]') ||
        a.reader.notesController?.editor || a.reader.restoring || a.reader.pages?.turning) {
      a.recent = null; return;
    }
    if (last === null || a.recent === null || now-a.recent > 30000) return;
    const elapsed = now-last;
    if (elapsed > 3000) {
      this.record('activity_gap','unknown',{doc_id:a.reader.doc.id,version:a.reader.doc.version,reason:'unobserved_interval',inference:'none'});
      a.recent = null; return;
    }
    if (elapsed > 0) this.record('activity_segment','observed',{
      doc_id:a.reader.doc.id,version:a.reader.doc.version,duration_ms:Math.round(elapsed),
      inference:'none',meaning:'Visible focused application activity; not proof of reading or understanding'});
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { this.sampleActivity(); await this.sync(); await this.flush(); } catch { this.notice(); }
    finally { this.ticking = false; }
  }
  async flush(keepalive = false) {
    if (this.inflight || !this.queue.length || !this.permitted()) return;
    this.inflight = true;
    const generation = this.generation, epoch = this.state.epoch;
    let events = [], size = 1024;
    for (const event of this.queue) {
      const n = bytes(event);
      if (events.length >= 64 || size + n > (keepalive ? 60000 : 250000)) break;
      events.push(event); size += n;
    }
    try {
      if (!events.length) return;
      const result = await api('/evidence/batch', {method:'POST',body:{epoch,events},keepalive});
      if (generation !== this.generation) return;
      if (!result.durable) { this.error = result.paused || 'capture-paused'; this.stopLocal(); return; }
      const accepted = new Set(result.accepted);
      this.queue = this.queue.filter(e => !accepted.has(e.event_id));
      this.size = this.queue.reduce((sum, e) => sum + bytes(e), 0);
    } catch (error) {
      // Retry unchanged IDs only; a lost ACK cannot manufacture another event.
      if ([409,413,422].includes(error.status)) { this.error = 'rejected-batch/gap'; this.stopLocal(); }
    } finally { this.inflight = false; this.notice(); }
  }
  snapshot(r = this.ctx.reader, card = false) {
    if (!r || document.hidden || !document.hasFocus() || !r.pages || r.pages.turning || r.restoring) return null;
    const snapshot = {schema_version:1,kind:card?'word_card':'presentation',doc_id:r.doc.id,version:r.doc.version,
      source_identity:r.doc.pdf?.source_sha256 || r.doc.pdf?.sha256 || null,
      policy:'rendered-dom-v1',density:this.ctx.profile?.density,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
      ranges:[],annotations:[],card:null,truncated:false,
      limitations:['Text/annotation replay, not pixel recording; images are source references, not copied pixels.','Visible mounted fragments may be occluded by the word card; no hidden pages or notes collected.']};
    const fits = () => bytes(snapshot) <= 32000;
    // The page model is already partitioned into the actual mounted source ranges.
    for (const fragments of r.pages.pages.slice(r.pages.index, r.pages.index + r.pages.count)) {
      for (const f of fragments) {
        const block = r.doc.blocks.find(b => b.id === f.id);
        if (!block) continue;
        const node = [...document.querySelectorAll('#article [data-block]')].find(n=>n.dataset.block===f.id && visible(n));
        if (!node) continue;
        const anchor = r.anchorFor(f.id, f.start, f.end);
        const part = {block_id:f.id,start:f.start,end:f.end,text:block.text.slice(f.start,f.end),pdf_source:anchor?.pdf_source || null};
        if (!snapshot.source_identity && anchor?.pdf_source?.source_sha256) snapshot.source_identity=anchor.pdf_source.source_sha256;
        snapshot.ranges.push(part);
        if (!fits()) { snapshot.ranges.pop(); snapshot.truncated = true; break; }
      }
      if (snapshot.truncated) break;
    }
    for (const gloss of document.querySelectorAll('#article .annotation .gloss')) {
      if (!visible(gloss)) continue;
      const parent = gloss.closest('[data-annotation]'), a = r.annotations[Number(parent.dataset.annotation)];
      const item = {text:gloss.textContent,source:a?.source,block_id:a?.block?.id,start:a?.start,end:a?.end};
      snapshot.annotations.push(item);
      if (!fits()) {snapshot.annotations.pop();snapshot.truncated=true;break;}
    }
    if (card && visible(r.popElement)) {
      const pop = r.popElement;
      snapshot.card = {anchor:r.popAnchor,heading:pop.querySelector('h3')?.textContent,
        meaning:visible(pop.querySelector('.meaning'))?pop.querySelector('.meaning')?.textContent:null,
        detail:visible(pop.querySelector('.muted'))?pop.querySelector('.muted')?.textContent:null,
        dictionary:[...pop.querySelectorAll('.dictionary-caption,.dictionary-senses li,.dictionary-raw,.dictionary-missing')].filter(visible).map(n=>n.textContent),
        context:visible(pop.querySelector('[data-context-result]'))?pop.querySelector('[data-context-result]')?.textContent:null};
      if (!fits()) {snapshot.card = {anchor:r.popAnchor,heading:pop.querySelector('h3')?.textContent,truncated:true};snapshot.truncated=true;}
    }
    return snapshot;
  }
  present(r, card = false) {
    if (!this.permitted()) return;
    try {
      const snapshot = this.snapshot(r, card); if (!snapshot) return;
      const signature = JSON.stringify(snapshot);
      if (signature === this.last) return;
      this.last = signature;
      this.record(card?'word_card':'presentation','observed',{},snapshot);
    } catch { this.error = 'snapshot-failure/gap'; this.notice(); }
  }
  begin(path, method, body) {
    if (!this.permitted() || this.error || method === 'GET') return null;
    path = path.split('?')[0];
    let type;
    if (/^\/collections(?:\/(feedback|adopt|undo|\d+))?$/.test(path)) type='collections';
    else if (/^\/documents\/\d+\/context(?:\/preview)?$/.test(path)) type='explanation';
    else if (/^\/documents\/\d+\/assist-requests\/[A-Za-z0-9-]+$/.test(path) && method === 'DELETE') type='cancel_request';
    else if (path === '/lookup') type='lookup';
    else if (path === '/profile') type='density';
    else if (/^\/documents\/\d+\/progress$/.test(path)) type='resume_save';
    else return null;
    const op = id(), snapshot = this.snapshot(this.ctx.reader, Boolean(this.ctx.reader?.popElement));
    const details = {type,path,method};
    if (body?.request_id) details.request_id=body.request_id;
    if (type === 'cancel_request') details.request_id=path.split('/').at(-1);
    for (const key of ['expected_revision','expected_feedback_revision','expected_collection_revision']) if (Number.isInteger(body?.[key])) details[key]=body[key];
    if (path.endsWith('/feedback')) {
      if (Object.hasOwn(body||{},'understood')) details.understood = body.understood;
      if (Object.hasOwn(body||{},'retained')) details.retained = body.retained;
    }
    if (path.endsWith('/undo')) details.undo_of = this.undo.get(body?.token) || 'unknown/pre-collection';
    if (type === 'density') details.density = body?.density;
    this.pending.set(op,details);
    this.record('operation','started',details,snapshot,op,path.endsWith('/feedback')?'declaration':'fact');
    return {op,epoch:this.state.epoch,session:this.session,details};
  }
  end(token, payload, error) {
    if (!token || token.epoch !== this.state?.epoch) return;
    this.pending.delete(token.op);
    let status = error ? error.status === 409 ? 'conflict' : error.status ? 'failed' : 'unknown' : 'succeeded';
    const details = {...token.details,http_status:error?.status || (error?null:200),error_code:error?.code || null};
    // HTTP receipts are observations, not proof that cancellation stopped a provider.
    if (error?.code === 'context_failed') status='failed';
    if (error?.code === 'context_pending') { status='observed'; details.result_state='pending'; }
    if (error?.code === 'context_unknown' || error?.name === 'AbortError' || error?.status === 499) status='unknown';
    if (error?.status === 499) details.wait_status='cancelled_or_disconnected';
    if (!error && token.details.type === 'cancel_request') {
      status='observed'; details.cancel_accepted=payload?.ok === true;
      details.wait_status=payload?.ok === true ? 'cancel_requested' : 'unknown';
      details.result_state=['succeeded','failed','unknown'].includes(payload?.result_state) ? payload.result_state : 'unknown';
      if (typeof payload?.attempt_id === 'string') details.attempt_id=payload.attempt_id;
      if (Number.isInteger(payload?.assist_id)) details.assist_id=payload.assist_id;
      if (['pending','succeeded','failed','unknown'].includes(payload?.observed_attempt_state)) details.observed_attempt_state=payload.observed_attempt_state;
      if (payload?.receipt_gap === 'state-unavailable') details.receipt_gap=payload.receipt_gap;
    } else if (!error && token.details.path.endsWith('/context/preview')) {
      status='observed';
      details.cache_available=Number.isInteger(payload?.cached?.id);
      if (details.cache_available) details.cached_assist_id=payload.cached.id;
      const attempt=payload?.attempt;
      if (attempt && ['pending','succeeded','failed','unknown'].includes(attempt.state))
        details.attempt={id:attempt.id,request_id:attempt.request_id,state:attempt.state};
    } else if (!error && token.details.type === 'explanation') {
      // Only the execution endpoint's boolean receipt means a saved result was reused.
      status=Number.isInteger(payload?.id) ? payload.cached === true ? 'cache_hit' : 'succeeded' : 'unknown';
    }
    for (const key of ['id','revision','feedback_revision','collection_revision']) if (typeof payload?.[key] === 'number') details[key]=payload[key];
    if (payload?.undo_token) this.undo.set(payload.undo_token,token.op);
    // Client sees only returned resources. Actual before/after (including deleted
    // and merged rows omitted by the response) comes from the server commit receipt.
    const resources=[];
    for (const key of ['item','state']) if (payload?.[key]) resources.push({role:key,id:payload[key].id,revision:payload[key].revision});
    for (const item of (Array.isArray(payload?.items) ? payload.items : []).slice(0,16)) resources.push({role:'restored',id:item.id,revision:item.revision});
    if (resources.length) details.returned_resources=resources;
    if (Array.isArray(payload?.items) && payload.items.length > 16) details.returned_resources_truncated=true;
    if (payload?.undo) {
      const key = typeof payload.undo === 'string' ? payload.undo : payload.undo.token;
      if (key) this.undo.set(key,token.op);
    }
    if (this.undo.size > 128) this.undo.delete(this.undo.keys().next().value);
    this.record('operation',status,details,null,token.op,token.details.path.endsWith('/feedback')?'declaration':'fact');
    setTimeout(()=>this.present(this.ctx.reader,Boolean(this.ctx.reader?.popElement)),100);
  }
  dispose() {
    clearInterval(this.timer); this.disposeObserver(); this.channel?.close();
    window.removeEventListener('storage',this.storageChanged);
    window.removeEventListener('pagehide',this.pagehide); this.stopLocal();
  }
}
