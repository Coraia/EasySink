import { $, api, e } from "../core.js";
import { openReadingAI } from "../ai-setup-guard.js";

const LOOKAHEAD = 2, MAX_BLOCKS = 48, MAX_SOURCE = 8000;
const AI_REQUIRED = "请先在 AI 与语音中配置并启用文本 AI";
const SKIP = new Set(["image", "image_fallback", "formula", "table", "table-row", "code"]);
const key = ({doc_id, version, block_id}) => JSON.stringify([doc_id, version, block_id]);

function sourceUnits(doc) {
  const units = new Map(), sizes = new Map();
  for (const block of doc.blocks) {
    if (SKIP.has(block.type) || !block.text.trim()) continue;
    // PDF import publishes source-ordered groups only for complete paragraphs.
    const first = block.paragraph_group?.blocks[0] || block.id;
    sizes.set(first, (sizes.has(first) ? sizes.get(first) + 2 : 0) + block.text.length);
    units.set(block.id, {doc_id: doc.id, version: doc.version, block_id: first});
  }
  return {units, sizes};
}

const intersects = (range, fragment) => range.block_id === fragment.id &&
  range.start < fragment.end && range.end > fragment.start;

export function installPageTranslation(r, pane, enabledBooks, book) {
  const section = document.createElement("section");
  section.hidden = true;
  section.lang = "zh-CN";
  section.dataset.pageTranslation = "";
  section.innerHTML = `<div class="translation-heading"><h2>当前页 · 对照</h2></div>
    <div class="meta" role="status" data-page-translation-status></div>
    <button type="button" data-page-translation-retry hidden>重试这一批</button>
    <div class="translation-segments" data-page-translation-segments></div>`;
  pane.append(section);
  const status = $("[data-page-translation-status]", section),
    retry = $("[data-page-translation-retry]", section),
    text = $("[data-page-translation-segments]", section);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "reader-mode-toggle";
  toggle.dataset.pageTranslationToggle = "";
  toggle.title = "使用已配置的文本 AI，按完整自然段预译当前页和后续页面";
  toggle.innerHTML = '<span class="reader-mode-dot" aria-hidden="true"></span><span>整本翻译</span>';
  $(".reader-page-caption .caption-end").prepend(toggle);
  const updateToggle = () => toggle.setAttribute("aria-pressed", String(enabled()));

  const source = sourceUnits(r.doc), results = new Map(), failures = new Map();
  const enabled = () => enabledBooks.has(book);
  let covered = false, syncPane, work, timer, segments = [], shown, setupError = false;
  const active = () => enabled() && !r.scope.signal.aborted;
  const visible = () => [...document.querySelectorAll("#article .reading-prose [data-block]")]
    .map(node => ({id: node.dataset.block, start: +node.dataset.start, end: +node.dataset.end}));
  const refs = (fragments, map) => [...new Set(fragments.map(part => map.units.get(part.id)).filter(Boolean))];
  const canTranslate = (ref) => source.sizes.get(ref.block_id) <= MAX_SOURCE;
  const failureFor = (entries) => {
    const ref = entries.find(ref => failures.has(key(ref)) || results.get(key(ref))?.status === "unknown");
    return ref && (failures.get(key(ref)) || {retry: results.get(key(ref)).batch_id, blocks: entries});
  };
  const paint = () => {
    if (!active()) return;
    const visibleParts = visible();
    const current = refs(visibleParts, source), available = current.filter(canTranslate);
    const rows = available.map(ref => results.get(key(ref)));
    const failure = failureFor(available);
    const message = setupError ? AI_REQUIRED
      : failure ? (failure.message || "这一批译文未完成，不会自动重试。")
      : rows.some(row => row?.status !== "ready") ? "正在准备本页译文，仍可继续阅读原文…"
      : !available.length ? (current.length ? "此段过长，请使用选区翻译。" : "本页没有可翻译的正文。")
      : current.length > available.length ? "过长段落未翻译，可使用选区翻译。" : "";
    if (status.textContent !== message) status.textContent = message;
    retry.hidden = !(failure || setupError);
    retry.textContent = setupError ? "配置文本 AI" : "重试这一批";
    retry.disabled = Boolean(work);
    const next = rows.flatMap(row => row?.segments || [])
      .filter(segment => segment.ranges.some(range => visibleParts.some(part => intersects(range, part))));
    if (next.length !== segments.length || next.some((segment, i) => segment !== segments[i])) {
      segments = next;
      text.innerHTML = next.map((segment, i) => `<button type="button" class="translation-segment" data-page-pair="${i}">${e(segment.zh)}</button>`).join("");
    }
    const first = visibleParts[0], position = first && `${first.id}:${first.start}`;
    if (position !== shown) {
      shown = position;
      if (!covered) pane.scrollTop = 0;
    }
  };

  async function windowRefs() {
    const pages = r.pages, start = pages.index + pages.count;
    const visibleRefs = refs(visible(), source).filter(canTranslate);
    const ahead = pages.pages.slice(start, start + LOOKAHEAD).map(parts =>
      refs(parts, source).map(ref => ({ref, size: source.sizes.get(ref.block_id)})));
    if (ahead.length < LOOKAHEAD && pages.complete && pages.rangeNeighbor(1)) {
      let neighbor;
      try { neighbor = await pages.prepareRange(1); }
      catch (error) { if (error.name !== "AbortError") console.warn("Cannot prepare adjacent translation pages", error); }
      if (neighbor) {
        const next = sourceUnits(neighbor.r.doc);
        for (const parts of neighbor.pages.slice(0, LOOKAHEAD - ahead.length))
          ahead.push(refs(parts, next).map(ref => ({ref, size: next.sizes.get(ref.block_id)})));
      }
    }
    return {visibleRefs, ahead: ahead.map(row => row.filter(part => part.size <= MAX_SOURCE))};
  }
  async function post(body) {
    const response = await api(`/documents/${r.doc.id}/page-translation`, {
      method: "POST", body, signal: r.scope.signal,
    });
    for (const row of response.blocks) {
      const id = key(row);
      if (row.status !== "ready" || results.get(id)?.status !== "ready") results.set(id, row);
      failures.delete(id);
    }
    return response;
  }
  const bounded = (entries) => {
    const blocks = new Map();
    let size = 0;
    for (const part of entries) {
      const id = key(part.ref);
      if (blocks.has(id) || results.has(id) || failures.has(id)) continue;
      if (size + part.size > MAX_SOURCE || blocks.size >= MAX_BLOCKS) break;
      size += part.size;
      blocks.set(id, part.ref);
    }
    return [...blocks.values()];
  };
  async function generate(plan) {
    try {
      const value = await post({...plan, generate: true});
      if (value.busy) schedule(650);
      if (value.error) {
        for (const row of value.blocks.filter(row => row.status === "unknown"))
          failures.set(key(row), {retry: row.batch_id, blocks: plan.blocks, message: value.error});
      }
    } catch (error) {
      if (r.scope.signal.aborted) return;
      if (error.message === AI_REQUIRED) {
        setupError = true;
        if (active()) await configure();
      } else {
        for (const ref of plan.blocks) failures.set(key(ref), {...plan, message: error.message});
      }
    }
  }
  const configure = () => openReadingAI(r, {pageTranslationResume() {
    setupError = false;
    schedule();
  }});
  async function refresh() {
    const index = r.pages.index, layout = r.pages.layoutEpoch;
    const samePage = () => active() && index === r.pages.index && layout === r.pages.layoutEpoch;
    const {visibleRefs, ahead} = await windowRefs();
    if (!samePage()) { schedule(); return; }
    const all = [...new Map([...visibleRefs, ...ahead.flat().map(part => part.ref)].map(ref => [key(ref), ref])).values()];
    const fresh = all.filter(ref => results.get(key(ref))?.status !== "ready");
    for (let offset = 0; offset < fresh.length; offset += 200) {
      const response = await post({blocks: fresh.slice(offset, offset + 200)});
      if (response.busy) { schedule(650); return; }
      if (!samePage()) { schedule(); return; }
    }
    if (setupError || failureFor(visibleRefs)) return;
    const missing = ref => !results.has(key(ref)) && !failures.has(key(ref));
    if (visibleRefs.some(missing) || (ahead[0]?.length && ahead[0].some(part => missing(part.ref)))) {
      const blocks = bounded([...visibleRefs.map(ref => ({ref, size: source.sizes.get(ref.block_id)})), ...ahead.flat()]);
      if (blocks.length) {
        await generate({blocks});
        if (!samePage() || (visibleRefs.some(missing) && !setupError && !failureFor(visibleRefs))) schedule();
      }
    }
  }
  function schedule(delay = 0) {
    clearTimeout(timer);
    if (!active()) return;
    paint();
    timer = setTimeout(() => {
      if (!active()) return;
      if (work) { schedule(100); return; }
      if (r.restoring || r.pages.animating || r.pages.displayPending) { schedule(100); return; }
      run(refresh);
    }, delay);
  }
  function run(action) {
    work = action().then(paint, error => {
      if (!r.scope.signal.aborted) {
        status.textContent = error.message;
        retry.textContent = "重新读取译文";
        retry.hidden = false;
      }
    }).finally(() => {
      work = null;
      retry.disabled = false;
    });
    retry.disabled = true;
  }
  r.scope.on(retry, "click", () => {
    if (!active() || work) return;
    if (setupError) {
      run(configure);
      return;
    }
    const current = refs(visible(), source).filter(canTranslate);
    const plan = failureFor(current);
    if (!plan) { schedule(); return; }
    run(async () => {
      if (!plan.retry) {
        await post({blocks: plan.blocks});
        if (!active()) return;
      }
      const original = plan.retry ? plan : failureFor(plan.blocks);
      await generate(original?.retry ? {blocks: original.blocks, retry: original.retry} : {blocks: plan.blocks});
    });
  });
  r.scope.on(section, "pointerover", event => {
    const pair = event.target.closest("[data-page-pair]");
    if (pair) r.paintRanges({}, [segments[+pair.dataset.pagePair]]);
  });
  r.scope.on(section, "pointerleave", () => r.paintRanges({}, []));
  r.scope.on(section, "click", event => {
    const pair = event.target.closest("[data-page-pair]");
    if (pair) r.paintRanges({}, [segments[+pair.dataset.pagePair]]);
  });
  r.scope.on(toggle, "click", () => {
    r.pages.finishAnimation();
    const anchor = r.captureView().visibleAnchor || undefined, wasHidden = pane.hidden;
    if (enabled()) enabledBooks.delete(book); else enabledBooks.add(book);
    updateToggle();
    syncPane();
    if (pane.hidden !== wasHidden)
      void r.pages.reflow(anchor).catch(error => r.status(error.message, {notice: true}));
    $("#article").focus({preventScroll: true});
    if (enabled()) schedule(); else {
      clearTimeout(timer);
      if (!covered) r.paintRanges({}, []);
    }
  });
  r.on("draw", () => { if (!work) schedule(); else paint(); });
  r.on("reader-ready", () => schedule());
  r.scope.cleanup(() => clearTimeout(timer));
  updateToggle();
  return {enabled, onToggle(fn) { syncPane = fn; }, setCovered(value) {
    covered = value;
    section.hidden = value || !enabled();
  }};
}
