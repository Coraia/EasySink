import { $, api, e } from "../core.js";
import { openReadingAI } from "../ai-setup-guard.js";

const LOOKAHEAD = 2, MAX_BLOCKS = 48, MAX_SOURCE = 8000;
const AI_REQUIRED = "请先在 AI 与语音中配置并启用文本 AI";
const SKIP = new Set(["image", "image_fallback", "formula", "table", "table-row", "code"]);
const key = ({doc_id, version, block_id}) => JSON.stringify([doc_id, version, block_id]);
const failureMessage = {
  alignment: "译文未能与原文完整对齐",
  model_format: "模型返回的译文格式不正确",
  credentials: "AI 服务拒绝了凭据，请检查配置",
  rate_limit: "AI 服务额度或频率已达上限，请稍后重试",
  provider_http: "AI 服务返回错误，请检查配置或稍后重试",
  timeout: "AI 服务响应超时，结果未知",
  connection: "连接 AI 服务失败，结果未知",
  interrupted: "上次请求未留下结果，不会自动重试",
};

function sourceUnits(doc) {
  const units = new Map(), sizes = new Map(), pending = new Set(), interned = new Map();
  for (const block of doc.blocks) {
    if (block.pdf_role || SKIP.has(block.type) || !block.text.trim()) continue;
    const projected = doc.pdf?.prose?.[block.id];
    if (projected?.pending) {
      pending.add(block.id);
      continue;
    }
    if (projected) {
      const ref = projected.ref, id = key(ref);
      if (!interned.has(id)) interned.set(id, ref);
      units.set(block.id, interned.get(id));
      sizes.set(ref.block_id, projected.size);
      continue;
    }
    // PDF import publishes source-ordered groups only for complete paragraphs.
    const first = block.paragraph_group?.blocks[0] || block.id;
    sizes.set(first, (sizes.has(first) ? sizes.get(first) + 2 : 0) + block.text.length);
    units.set(block.id, {doc_id: doc.id, version: doc.version, block_id: first});
  }
  return {units, sizes, pending};
}

const intersects = (range, fragment, doc) => range.block_id === fragment.id &&
  (!range.doc_id || range.doc_id === doc.id && range.revision === doc.version) &&
  range.start < fragment.end && range.end > fragment.start;

export function installPageTranslation(r, pane, enabledBooks, book) {
  const section = document.createElement("section");
  section.hidden = true;
  section.lang = "zh-CN";
  section.dataset.pageTranslation = "";
  section.innerHTML = `<div class="translation-heading"><h2>当前页 · 对照</h2></div>
    <div class="meta" role="status" data-page-translation-status></div>
    <progress data-page-translation-progress aria-label="整本翻译进行中" hidden></progress>
    <button type="button" data-page-translation-setup hidden>配置文本 AI</button>
    <button type="button" data-page-translation-reload hidden>重新读取译文</button>
    <ul data-page-translation-failures hidden></ul>
    <div class="translation-segments" data-page-translation-segments></div>`;
  pane.append(section);
  const status = $("[data-page-translation-status]", section),
    progress = $("[data-page-translation-progress]", section),
    setup = $("[data-page-translation-setup]", section),
    reload = $("[data-page-translation-reload]", section),
    failures = $("[data-page-translation-failures]", section),
    text = $("[data-page-translation-segments]", section);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "reader-mode-toggle";
  toggle.dataset.pageTranslationToggle = "";
  toggle.title = "使用已配置的文本 AI，按完整自然段预译当前页和后续页面";
  toggle.innerHTML = '<span class="reader-mode-dot" aria-hidden="true"></span><span>整本翻译</span>';
  $(".reader-page-caption .caption-end").prepend(toggle);
  const updateToggle = () => toggle.setAttribute("aria-pressed", String(enabled()));

  let source = sourceUnits(r.doc), version = r.doc.version, projection = r.doc.pdf?.prose;
  const results = new Map();
  const enabled = () => enabledBooks.has(book);
  let covered = false, syncPane, work, timer, segments = [], shown, batch, requestError, setupError = false;
  let failureMarkup = "";
  const active = () => enabled() && !r.scope.signal.aborted;
  const visible = () => [...document.querySelectorAll("#article .reading-prose [data-block]")]
    .map(node => ({id: node.dataset.block, start: +node.dataset.start, end: +node.dataset.end}));
  const refs = (fragments, map) => [...new Set(fragments.map(part => map.units.get(part.id)).filter(Boolean))];
  const canTranslate = (ref) => source.sizes.get(ref.block_id) <= MAX_SOURCE;
  const authorized = (ref, doc = r.doc) => {
    if (!doc.pdf) return true;
    const versions = enabledBooks.get(book);
    const knownDoc = versions.get(doc.id), knownParagraph = versions.get(`${ref.doc_id}:${ref.block_id}`);
    return (!knownDoc || knownDoc === doc.version) && (!knownParagraph || knownParagraph === ref.version);
  };
  const remember = (ref, doc) => {
    if (!doc.pdf) return;
    const versions = enabledBooks.get(book);
    versions.set(doc.id, doc.version);
    versions.set(`${ref.doc_id}:${ref.block_id}`, ref.version);
  };
  const paint = () => {
    if (!active()) return;
    const visibleParts = visible();
    const current = refs(visibleParts, source), available = current.filter(canTranslate);
    const rows = available.map(ref => results.get(key(ref)));
    const done = rows.filter(row => row?.status === "ready").length;
    const waiting = rows.some((row, i) => row?.status === "pending" || !row && authorized(available[i]));
    const failed = rows.filter(row => row?.status === "failed" || row?.status === "unknown");
    const count = `本页已完成 ${done} / ${available.length} 段`;
    const processing = batch ? `本批 ${batch.total} 段，模型处理中` : "正在准备译文";
    const message = setupError ? AI_REQUIRED
      : requestError ? requestError
      : waiting || batch ? `${count} · ${processing}，仍可继续阅读原文…`
      : available.some((ref, i) => rows[i]?.status !== "ready" && !authorized(ref)) ? "正文已更新；如需翻译，请关闭再开启整本翻译。"
      : visibleParts.some(part => source.pending.has(part.id)) ? "等待相邻原页，暂不翻译未完段落。"
      : failed.length ? `${count} · ${failed.length} 段未完成`
      : !available.length ? (current.length ? "此段过长，请使用选区翻译。" : "本页没有可翻译的正文。")
      : current.length > available.length ? "过长段落未翻译，可使用选区翻译。" : "";
    if (status.textContent !== message) status.textContent = message;
    progress.hidden = setupError || Boolean(requestError) || !(waiting || batch);
    text.setAttribute("aria-busy", String(!progress.hidden && waiting));
    setup.hidden = !setupError && !failed.some(row => row.error_code === "credentials");
    reload.hidden = !requestError;
    const markup = rows.map((row, i) => {
      if (row?.status !== "failed" && row?.status !== "unknown") return "";
      const reason = failureMessage[row.error_code];
      return `<li><span>第 ${i + 1} 段：${reason}</span>
        <button type="button" data-page-translation-retry="${i}" aria-label="重试第 ${i + 1} 段"${batch || !authorized(available[i]) ? " disabled" : ""}>重试此段</button></li>`;
    }).join("");
    if (failureMarkup !== markup) {
      failureMarkup = markup;
      failures.innerHTML = markup;
      failures.hidden = !markup;
    }
    const next = rows.flatMap(row => row?.segments || [])
      .filter(segment => segment.ranges.some(range => visibleParts.some(part => intersects(range, part, r.doc))));
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
      refs(parts, source).map(ref => ({ref, doc: r.doc, size: source.sizes.get(ref.block_id)})));
    if (ahead.length < LOOKAHEAD && pages.complete && pages.rangeNeighbor(1)) {
      let neighbor;
      try { neighbor = await pages.prepareRange(1); }
      catch (error) { if (error.name !== "AbortError") console.warn("Cannot prepare adjacent translation pages", error); }
      if (neighbor) {
        const next = sourceUnits(neighbor.r.doc);
        for (const parts of neighbor.pages.slice(0, LOOKAHEAD - ahead.length))
          ahead.push(refs(parts, next).map(ref => ({ref, doc: neighbor.r.doc, size: next.sizes.get(ref.block_id)})));
      }
    }
    return {visibleRefs, ahead: ahead.map(row => row.filter(part => part.size <= MAX_SOURCE))};
  }
  async function post(body) {
    const response = await api(`/documents/${r.doc.id}/page-translation`, {
      method: "POST", body, signal: r.scope.signal,
    });
    batch = response.batch;
    for (const ref of body.blocks) if (results.get(key(ref))?.status === "pending") results.delete(key(ref));
    for (const row of response.blocks) results.set(key(row), row);
  }
  const bounded = (entries) => {
    const blocks = new Map();
    let size = 0;
    for (const part of entries) {
      const id = key(part.ref);
      if (blocks.has(id) || results.has(id) || !authorized(part.ref, part.doc)) continue;
      if (size + part.size > MAX_SOURCE || blocks.size >= MAX_BLOCKS) break;
      size += part.size;
      blocks.set(id, part.ref);
      remember(part.ref, part.doc);
    }
    return [...blocks.values()];
  };
  async function submit(plan) {
    try {
      await post(plan);
      if (batch) schedule(400);
    } catch (error) {
      if (error.message !== AI_REQUIRED) throw error;
      setupError = true;
      if (active()) await configure();
    }
  }
  const configure = () => openReadingAI(r, {pageTranslationResume() {
    setupError = false;
    schedule();
  }});
  async function refresh() {
    const index = r.pages.index, layout = r.pages.layoutEpoch, inputs = source;
    const samePage = () => active() && index === r.pages.index && layout === r.pages.layoutEpoch && source === inputs;
    const {visibleRefs, ahead} = await windowRefs();
    if (!samePage()) { schedule(); return; }
    const all = [...new Map([...visibleRefs, ...ahead.flat().map(part => part.ref)].map(ref => [key(ref), ref])).values()];
    const fresh = all.filter(ref => results.get(key(ref))?.status !== "ready");
    for (let offset = 0; offset < fresh.length || (offset === 0 && batch); offset += 200) {
      await post({blocks: fresh.slice(offset, offset + 200)});
      if (!samePage()) { schedule(); return; }
    }
    if (batch) { schedule(400); return; }
    if (setupError) return;
    const eligible = (ref, doc) => !results.has(key(ref)) && authorized(ref, doc);
    if (visibleRefs.some(ref => eligible(ref)) || ahead[0]?.some(part => eligible(part.ref, part.doc))) {
      const blocks = bounded([...visibleRefs.map(ref => ({ref, doc: r.doc, size: source.sizes.get(ref.block_id)})), ...ahead.flat()]);
      if (blocks.length) {
        await submit({blocks, generate: true});
        if (!samePage() || (!batch && !setupError && visibleRefs.some(ref => eligible(ref)))) schedule();
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
    requestError = null;
    work = action().then(paint, error => {
      if (!r.scope.signal.aborted) {
        requestError = error.message;
        paint();
      }
    }).finally(() => {
      work = null;
    });
  }
  r.scope.on(setup, "click", () => { if (active() && !work) run(configure); });
  r.scope.on(reload, "click", () => { if (active() && !work) schedule(); });
  r.scope.on(failures, "click", event => {
    const retry = event.target.closest("[data-page-translation-retry]");
    if (!retry || !active() || work || batch) return;
    const ref = refs(visible(), source).filter(canTranslate)[+retry.dataset.pageTranslationRetry];
    const row = ref && results.get(key(ref));
    if ((row?.status === "failed" || row?.status === "unknown") && authorized(ref)) {
      remember(ref, r.doc);
      run(() => submit({blocks: [ref], retry: row.batch_id}));
    }
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
    if (enabled()) enabledBooks.delete(book); else enabledBooks.set(book, new Map());
    updateToggle();
    syncPane();
    if (pane.hidden !== wasHidden)
      void r.pages.reflow(anchor, {reason: "translation-pane"})
        .catch(error => r.status(error.message, {notice: true}));
    $("#article").focus({preventScroll: true});
    if (enabled()) schedule(); else {
      clearTimeout(timer);
      if (!covered) r.paintRanges({}, []);
    }
  });
  r.on("draw", () => { if (!work) schedule(); else paint(); });
  r.on("pdf-prose", () => {
    if (version === r.doc.version && projection === r.doc.pdf?.prose) return;
    source = sourceUnits(r.doc);
    version = r.doc.version;
    projection = r.doc.pdf?.prose;
    schedule();
  });
  r.on("reader-ready", () => schedule());
  r.scope.cleanup(() => clearTimeout(timer));
  updateToggle();
  return {enabled, onToggle(fn) { syncPane = fn; }, setCovered(value) {
    covered = value;
    section.hidden = value || !enabled();
  }};
}
