import { chapters, dictionary, pairs, syntax } from "./sample.js";
import {
  snapshotSpread,
  clearCaptures,
  CurlPainter,
} from "../page-drag/page-curl.js?v=20261006-drag2";
import { installNativeTrackpad } from "./native-trackpad.js";
import { installEdgeDrag } from "./edge-drag.js?v=20261006-drag2";
import { installReadingZones } from "../page-drag/reading-zones.js?v=20261006-drag2";

const $ = (id) => document.getElementById(id);
const esc = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const svg = (content) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${content}</svg>`;
const icons = {
  close: svg('<path d="m6 6 12 12M6 18 18 6"/>'),
  directory: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  notes: svg(
    '<path d="m5 18 1-5L16 3l5 5-10 10-6 1Z"/><path d="m13 6 5 5M5 22h15"/>',
  ),
  progress: svg(
    '<path d="M3 9h5m4 0h9M3 16v2m6-2v2m6-2v2m6-2v2"/><circle cx="10" cy="9" r="2"/>',
  ),
  style: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  ),
  font: svg('<path d="m4 20 6-16 6 16M6 14h8M2 20h5m6 0h5M18 11h4m-2-2v11"/>'),
  fullscreen: svg('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>'),
  exit: svg('<path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>'),
  bookmark: svg('<path d="M6 3h12v18l-6-4-6 4V3Z"/>'),
  prev: svg('<path d="m15 5-7 7 7 7"/>'),
  next: svg('<path d="m9 5 7 7-7 7"/>'),
};
for (const name of ["directory", "notes", "progress", "style", "font"])
  $(name).querySelector(".tool-icon").innerHTML = icons[name];
for (const name of ["prev", "next", "fullscreen"])
  $(name).innerHTML = icons[name];
document
  .querySelectorAll(".icon[data-close],#note-dialog .icon")
  .forEach((el) => (el.innerHTML = icons.close));

const testSession = new URL(location.href).searchParams.get("test-session");
const key =
  "wise-reader:trackpad-native-prototype:v1" +
  (testSession && /^[a-z0-9-]{1,64}$/i.test(testSession)
    ? `:acceptance:${testSession}`
    : "");
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(key) || "{}") || {};
} catch {}
const state = {
  anchor: 0,
  size: 23,
  leading: 1.8,
  font: "serif",
  theme: "paper",
  layout: "single",
  motion: true,
  gloss: true,
  marks: [],
  notes: [],
  ...saved,
};
state.size = Math.max(18, Math.min(32, Number(state.size) || 23));
state.leading = Math.max(1.5, Math.min(2, Number(state.leading) || 1.8));
state.theme = ["paper", "light", "dark"].includes(state.theme)
  ? state.theme
  : "paper";
state.layout = ["auto", "single", "double"].includes(state.layout)
  ? state.layout
  : "auto";
state.font = ["serif", "sans"].includes(state.font) ? state.font : "serif";
state.marks = Array.isArray(state.marks) ? state.marks : [];
state.notes = Array.isArray(state.notes) ? state.notes : [];
let blocks = [],
  offset = 0;
chapters.forEach((chapter, ci) => {
  [chapter.title, ...chapter.paragraphs].forEach((text, bi) => {
    const start = offset;
    const tokens = Array.from(text.matchAll(/\S+\s*/g), (m) => ({
      text: m[0],
      start: start + m.index,
      end: start + m.index + m[0].length,
    }));
    blocks.push({
      id: blocks.length,
      chapter: ci,
      heading: bi === 0,
      text,
      start,
      end: start + text.length,
      tokens,
    });
    offset += text.length + 2;
  });
});
const total = offset;
state.anchor = Math.max(0, Math.min(total - 1, Number(state.anchor) || 0));
let pages = [],
  index = 0,
  count = 1,
  pageWidth = 0,
  pageHeight = 0,
  selection = null,
  translated = null,
  drawerTab = "chapters",
  lastJump = null,
  busy = false;
let timer,
  resizeTimer,
  toastTimer,
  speechButton = null;
let turnLayer = null,
  progressDrag = null,
  drawerInvoker = "directory";
let nativeTrackpad = null;
let edgeDrag = null,
  preview = null,
  warmTimer = 0,
  sceneEpoch = 0,
  paintStyle = "";
const snapshotCache = new Map(),
  painter = new CurlPainter();
const grammarOpen = new Set(),
  grammarKnown = new Set();
const readingZones = installReadingZones({
  turn,
  finishTurn,
  closeTransient,
  transientOpen: () =>
    ["popover", "word-pop", "selection"].some((id) => !$(id).hidden),
  panelOpen: () =>
    !$("drawer").hidden || !$("notes-drawer").hidden || $("note-dialog").open,
});
const sourceBlock = (anchor) =>
  blocks.find((b) => anchor < b.end) || blocks.at(-1);
const sourceText = (start, end) =>
  blocks
    .map((b) =>
      b.text.slice(
        Math.max(0, start - b.start),
        Math.max(0, Math.min(b.text.length, end - b.start)),
      ),
    )
    .filter(Boolean)
    .join("\n\n");
function save() {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    document.body.dataset.save = "saved";
    return true;
  } catch {
    document.body.dataset.save = "failed";
    toast("本机保存失败，刷新后可能丢失");
    return false;
  }
}
function toast(text) {
  clearTimeout(toastTimer);
  $("toast").textContent = text;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 2600);
}
function applyStyle() {
  const signature = [
    state.theme,
    state.size,
    state.leading,
    state.font,
    state.gloss,
  ].join(":");
  if (signature !== paintStyle) {
    paintStyle = signature;
    clearCaptures();
    painter.invalidate();
    snapshotCache.clear();
    sceneEpoch++;
    scheduleWarm();
  }
  document.body.dataset.theme = state.theme;
  document.body.dataset.motion = state.motion ? "on" : "off";
  document.documentElement.style.setProperty("--size", `${state.size}px`);
  document.documentElement.style.setProperty("--leading", state.leading);
  document.documentElement.style.setProperty(
    "--font",
    state.font === "serif"
      ? 'Georgia,"Times New Roman",serif'
      : "-apple-system,BlinkMacSystemFont,sans-serif",
  );
}
function pageFor(anchor) {
  let found = pages.findIndex((p) => anchor < p.end);
  return found < 0 ? Math.max(0, pages.length - 1) : found;
}
function desiredCount() {
  // Approximately 19 English characters per line, with inner and outer margins.
  const fits = $("stage").clientWidth - 144 >= 2 * (state.size * 19 + 88) + 32;
  return (state.layout === "double" || state.layout === "auto") && fits ? 2 : 1;
}
function fragmentHTML(fragment, tools = true) {
  const b = blocks[fragment.block],
    ts = b.tokens.slice(fragment.from, fragment.to);
  let words = ts
    .map((t) => {
      const match = t.text.match(
        /^([^A-Za-z]*)([A-Za-z]+(?:['’-][A-Za-z]+)*)([^A-Za-z]*)(\s*)$/,
      );
      if (!match) return esc(t.text);
      const clean = match[2],
        entry = dictionary[clean.toLowerCase()];
      const start = t.start + match[1].length,
        end = start + clean.length;
      const gloss =
        state.gloss &&
        [
          "conviction",
          "absolute",
          "relative",
          "acquired",
          "distinguish",
        ].includes(clean.toLowerCase())
          ? `<span class="gloss">${esc(entry.meaning.split("；")[0])}</span>`
          : "";
      return `${esc(match[1])}<span class="word" data-start="${start}" data-end="${end}" data-word="${esc(clean)}">${esc(clean)}</span>${gloss}${esc(match[3])}${esc(match[4])}`;
    })
    .join("");
  if (b.heading)
    return `<div class="fragment" data-block="${b.id}"><div class="chapter-kicker">Chapter ${b.chapter + 1}</div><h1>${words}</h1></div>`;
  let controls = "";
  if (tools) {
    const mark = state.marks.find(
      (m) => m.anchor >= ts[0].start && m.anchor < ts.at(-1).end,
    );
    const note = state.notes.some(
      (n) => n.anchor >= ts[0].start && n.anchor < ts.at(-1).end,
    );
    controls = `<div class="paragraph-tools"><button data-select="${b.id}" aria-label="选择这一段" title="选择这一段">···</button><button data-mark="${ts[0].start}" aria-label="${mark ? "移除" : "添加"}此处书签" title="书签">${mark ? "▰" : "♧"}</button>${grammarKnown.has(b.id) ? `<button class="grammar-toggle" data-grammar="${b.id}" aria-label="${grammarOpen.has(b.id) ? "收起" : "展开"}句式" aria-expanded="${grammarOpen.has(b.id)}">${grammarOpen.has(b.id) ? "−" : "+"}</button>` : ""}</div>`;
    if (mark)
      controls += `<button class="source-mark" data-mark="${mark.anchor}" aria-label="移除此处书签" title="移除书签">${icons.bookmark}</button>`;
    if (note)
      controls += `<button class="source-note" data-select="${b.id}" aria-label="查看此段笔记" data-show-notes="true">✎</button>`;
  }
  const analysis =
    tools && fragment.from === 0 && grammarOpen.has(b.id) ? syntaxHTML(b) : "";
  return `<div class="fragment ${grammarKnown.has(b.id) ? "has-grammar" : ""}" data-block="${b.id}" data-start="${ts[0].start}"><p>${words}</p>${controls}${analysis}</div>`;
}
function syntaxHTML(b) {
  if (b.id !== 1)
    return '<div class="syntax"><div class="syntax-head">句式分析 · 原型范围</div>此原型仅提供第一段长难句的固定分析。正式版将按所选内容请求 AI，不预先分析整本书。</div>';
  return `<div class="syntax"><div class="syntax-head"><span>句式展开 · 固定样例</span><button data-grammar="${b.id}" aria-label="收起句式">− 收起</button></div>${syntax.map((n, i) => `<button class="syntax-node ${n.level === 1 ? "child" : n.level === 2 ? "grandchild" : ""}" data-syntax="${i}">${esc(n.title)}<small>${esc(n.quote)}</small></button>`).join("")}<div class="syntax-detail">点击或悬停任一层级，与原文对应高亮。</div></div>`;
}
function paginate() {
  finishTurn();
  clearCaptures();
  painter.invalidate();
  applyStyle();
  const oldAnchor = state.anchor;
  closeTransient();
  translated = null;
  count = desiredCount();
  $("spread").dataset.layout = count === 2 ? "double" : "single";
  $("right").hidden = count !== 2;
  $("translation").hidden = true;
  const prose = $("left").querySelector(".prose");
  pageWidth = prose.clientWidth;
  pageHeight = prose.clientHeight;
  const measure = document.createElement("article");
  measure.className = "prose measure";
  measure.style.width = pageWidth + "px";
  document.body.append(measure);
  pages = [];
  let current = [];
  let currentChapter = 0;
  const fits = (fragments) => {
    measure.innerHTML = fragments.map((f) => fragmentHTML(f, false)).join("");
    return measure.getBoundingClientRect().height <= pageHeight - 2;
  };
  const commit = () => {
    if (!current.length) return;
    const first = current[0],
      last = current.at(-1);
    pages.push({
      fragments: current,
      chapter: currentChapter,
      start: blocks[first.block].tokens[first.from].start,
      end: blocks[last.block].tokens[last.to - 1].end,
    });
    current = [];
  };
  for (const b of blocks) {
    if (b.heading) {
      commit();
      currentChapter = b.chapter;
    }
    let from = 0;
    while (from < b.tokens.length) {
      const whole = { block: b.id, from, to: b.tokens.length };
      if (fits([...current, whole])) {
        current.push(whole);
        break;
      }
      if (current.length && !blocks[current.at(-1).block].heading) {
        commit();
        continue;
      }
      let lo = from + 1,
        hi = b.tokens.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits([...current, { block: b.id, from, to: mid }])) lo = mid;
        else hi = mid - 1;
      }
      current.push({ block: b.id, from, to: lo });
      from = lo;
      commit();
    }
  }
  commit();
  measure.remove();
  index = pageFor(oldAnchor);
  // Do not quantize the stored source anchor when typography changes.
  render();
  document.body.dataset.ready = "true";
}
function render(keepNative = false) {
  finishTurn(keepNative ? "settled" : "interrupted");
  const spread = $("spread");
  const first = translated ? translated.page : index;
  const physical = translated ? 1 : count;
  spread.dataset.layout = translated
    ? "translation"
    : count === 2
      ? "double"
      : "single";
  $("right").hidden = physical < 2;
  $("translation").hidden = !translated;
  [$("left"), $("right")].forEach((sheet, i) => {
    const page = pages[first + i],
      prose = sheet.querySelector(".prose");
    if (i >= physical) {
      prose.innerHTML = "";
      return;
    }
    sheet.querySelector(".page-heading").textContent = page
      ? chapters[page.chapter].title
      : "";
    sheet.querySelector(".page-number").textContent = page ? first + i + 1 : "";
    prose.innerHTML = page
      ? page.fragments.map((f) => fragmentHTML(f)).join("")
      : "";
    prose.classList.toggle(
      "assist-open",
      Boolean(prose.querySelector(".syntax")),
    );
    prose.scrollTop = 0;
  });
  const end = Math.min(index + count, pages.length);
  $("folio-pages").textContent =
    count === 2
      ? `${index + 1}–${end} / ${pages.length} 页`
      : `${index + 1} / ${pages.length} 页`;
  const percent = Math.round((state.anchor / total) * 100);
  $("folio-percent").textContent = percent + "%";
  $("hairline-fill").style.width = percent + "%";
  $("layout-status").textContent = translated
    ? "对照阅读"
    : count === 2
      ? "双页"
      : "单页";
  $("chapter-title").textContent = chapters[pages[first]?.chapter || 0].title;
  $("prev").disabled = first === 0 || !!translated;
  $("next").disabled = index + count >= pages.length || !!translated;
  $("return-position").hidden = lastJump === null;
  document.body.dataset.layout = translated
    ? "translation"
    : count === 2
      ? "double"
      : "single";
  document.body.dataset.page = index + 1;
  document.body.dataset.anchor = state.anchor;
  document.body.dataset.pages = pages.length;
  if (translated) {
    highlight(translated.start, translated.end, "selected-source");
  }
  $("announcement").textContent = $("folio-pages").textContent;
  snapshotCache.clear();
  sceneEpoch++;
  positionEdges();
  scheduleWarm();
}
function clearHighlights() {
  document
    .querySelectorAll(".word.linked,.word.selected-source")
    .forEach((el) => el.classList.remove("linked", "selected-source"));
}
function highlight(start, end, cls = "linked") {
  document
    .querySelectorAll(".word")
    .forEach((w) =>
      w.classList.toggle(cls, +w.dataset.start < end && +w.dataset.end > start),
    );
}
function closeTransient() {
  progressDrag = null;
  for (const id of ["popover", "selection", "word-pop"]) $(id).hidden = true;
  document
    .querySelectorAll(".tool")
    .forEach((b) => b.setAttribute("aria-expanded", "false"));
  selection = null;
  window.getSelection()?.removeAllRanges();
  clearHighlights();
  stopSpeech();
}
function dismissPanels() {
  closeTransient();
  if (translated) {
    translated = null;
    render();
  }
  $("drawer").hidden = true;
  $("notes-drawer").hidden = true;
  $("shade").hidden = true;
}
function finishTurn(reason = "interrupted") {
  if (reason !== "settled") nativeTrackpad?.cancel(reason);
  clearTimeout(warmTimer);
  if (preview) {
    preview.cancelled = true;
    cancelAnimationFrame(preview.raf);
    clearTimeout(preview.timeout);
  }
  edgeDrag?.cancel("interrupted");
  preview = null;
  painter.detach();
  turnLayer?.remove();
  turnLayer = null;
  busy = false;
  $("spread").style.visibility = "";
  document.body.dataset.turning = "false";
  document
    .querySelectorAll(".paragraph-tools")
    .forEach((el) => (el.style.visibility = ""));
  document.body.dataset.gesture = "idle";
  $("prev").disabled = index === 0 || !!translated;
  $("next").disabled = index + count >= pages.length || !!translated;
}
function positionEdges() {
  const rect = $("spread").getBoundingClientRect();
  for (const id of ["prev", "next"]) {
    const el = $(id);
    el.style.width =
      Math.max(36, (id === "prev" ? rect.left : innerWidth - rect.right) + 22) +
      "px";
    el.style.top = Math.max(64, rect.top) + "px";
    el.style.bottom = Math.max(24, innerHeight - rect.bottom) + "px";
    el.innerHTML = "";
  }
}
function snapshotAt(at) {
  if (snapshotCache.has(at)) return snapshotCache.get(at);
  const source = $("spread"),
    rect = source.getBoundingClientRect(),
    copy = source.cloneNode(true);
  copy.removeAttribute("id");
  copy.classList.add("snapshot-source");
  copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  for (const [i, sheet] of [
    ...copy.querySelectorAll(":scope > .sheet:not(.translation)"),
  ].entries()) {
    const page = pages[at + i];
    sheet.querySelector(".page-heading").textContent = page
      ? chapters[page.chapter].title
      : "";
    sheet.querySelector(".page-number").textContent = page ? at + i + 1 : "";
    const prose = sheet.querySelector(".prose");
    prose.innerHTML = page
      ? page.fragments.map((f) => fragmentHTML(f, false)).join("")
      : "";
    prose.classList.remove("assist-open");
  }
  Object.assign(copy.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: rect.width + "px",
    height: rect.height + "px",
    margin: "0",
  });
  document.body.append(copy);
  const snapshot = snapshotSpread(copy);
  copy.remove();
  snapshot.rect = rect;
  // Each animation needs disposable DOM clones; the decoded image is shared.
  snapshotCache.set(at, snapshot);
  return snapshot;
}
function sceneSnapshot(at) {
  const s = snapshotAt(at);
  return { ...s, node: s.node.cloneNode(true) };
}
function scheduleWarm() {
  clearTimeout(warmTimer);
  const epoch = sceneEpoch;
  warmTimer = setTimeout(async () => {
    if (epoch !== sceneEpoch || busy || translated || !state.motion) return;
    for (const at of [index, index + count, index - count]) {
      if (at < 0 || at >= pages.length || epoch !== sceneEpoch || busy)
        continue;
      try {
        await painter.warm(snapshotAt(at));
      } catch (error) {
        console.warn("Page warm-up:", error.message);
      }
    }
    if (epoch === sceneEpoch) document.body.dataset.prewarmed = "true";
  }, 80);
}
function canTurn() {
  return !busy && canInteract();
}
function canInteract() {
  return (
    !readingZones.isOpen() &&
    !translated &&
    $("drawer").hidden &&
    $("notes-drawer").hidden &&
    $("popover").hidden &&
    $("selection").hidden &&
    $("word-pop").hidden &&
    !$("note-dialog").open &&
    !getSelection()?.toString().trim()
  );
}
function commitPage(next, keepNative = false) {
  stopSpeech();
  grammarOpen.clear();
  index = next;
  state.anchor = pages[index].start;
  save();
  render(keepNative);
}
function beginPreview(direction, y) {
  if (!canTurn()) return null;
  const next = Math.max(
    0,
    Math.min(pages.length - 1, index + direction * count),
  );
  if (next === index || (direction > 0 && index + count >= pages.length))
    return null;
  const rect = $("spread").getBoundingClientRect(),
    leaf = $(
      direction > 0 && count === 2 ? "right" : "left",
    ).getBoundingClientRect();
  const s = (preview = {
    next,
    direction,
    progress: 0.008,
    dy: 0,
    grab: Math.max(0, Math.min(1, (y - leaf.top) / leaf.height)),
    ready: false,
    cancelled: false,
    raf: 0,
    release: null,
  });
  clearTimeout(warmTimer);
  busy = true;
  document.body.dataset.turning = "true";
  document.body.dataset.gesture = "preparing";
  document
    .querySelectorAll(".paragraph-tools")
    .forEach((el) => (el.style.visibility = "hidden"));
  const done = (completed, reason) => {
    if (s.cancelled || preview !== s) return;
    if (turnLayer?.dataset.renderer) painter.record(completed, reason);
    finishTurn("settled");
    if (completed) commitPage(next, true);
    else {
      document
        .querySelectorAll(".paragraph-tools")
        .forEach((el) => (el.style.visibility = ""));
      scheduleWarm();
    }
    nativeTrackpad?.paperSettled();
  };
  const draw = () => {
    s.raf = 0;
    if (!s.ready || s.cancelled) return;
    painter.draw(s.progress, s.grab, s.dy, s.inputAt || 0);
    s.inputAt = 0;
  };
  const settle = (complete, reason) => {
    s.release = { complete, reason };
    if (!s.ready || s.cancelled) return;
    cancelAnimationFrame(s.raf);
    document.body.dataset.gesture = complete ? "settling" : "spring-back";
    turnLayer.dataset.phase = document.body.dataset.gesture;
    const from = s.progress,
      fromDy = s.dy,
      to = complete ? 1 : 0,
      start = performance.now();
    const duration = Math.max(100, Math.min(180, Math.abs(to - from) * 250));
    const measured = {
      reason,
      from,
      to,
      requestedMs: duration,
      start,
      frames: [],
    };
    const frame = (now) => {
      if (s.cancelled) return;
      const t = Math.min(1, (now - start) / duration),
        ease = 1 - Math.pow(1 - t, 3);
      const desired = from + (to - from) * ease;
      s.progress +=
        Math.sign(desired - s.progress) *
        Math.min(0.08, Math.abs(desired - s.progress));
      measured.frames.push({ at: now, progress: s.progress });
      s.dy = fromDy * (1 - ease);
      painter.draw(s.progress, s.grab, s.dy);
      if (t < 1 || Math.abs(to - s.progress) > 0.00001)
        s.raf = requestAnimationFrame(frame);
      else {
        measured.actualMs = performance.now() - start;
        measured.end = performance.now();
        const all = JSON.parse(document.body.dataset.settleMetrics || "[]");
        all.push(measured);
        document.body.dataset.settleMetrics = JSON.stringify(all.slice(-40));
        done(complete, reason);
      }
    };
    s.raf = requestAnimationFrame(frame);
  };
  const session = {
    width: leaf.width,
    turnDistance:
      leaf.width * 2 +
      (count === 2
        ? $("right").getBoundingClientRect().left -
          $("left").getBoundingClientRect().right
        : 0),
    height: leaf.height,
    update(p, dy, inputAt) {
      if (s.release || s.cancelled) return;
      s.progress = p;
      s.dy = dy;
      s.inputAt = inputAt;
      if (s.ready && !s.raf) s.raf = requestAnimationFrame(draw);
    },
    release: settle,
    cancel(reason) {
      if (s.cancelled) return;
      s.release = { complete: false, reason };
      if (s.ready) done(false, reason);
      else {
        finishTurn();
        document
          .querySelectorAll(".paragraph-tools")
          .forEach((el) => (el.style.visibility = ""));
        scheduleWarm();
      }
    },
  };
  if (
    !state.motion ||
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    painter.failed
  ) {
    s.ready = true;
    session.update = () => {};
    session.release = (complete, reason) => done(complete, reason);
    return session;
  }
  turnLayer = document.createElement("div");
  turnLayer.className = "turn-layer";
  turnLayer.setAttribute("aria-hidden", "true");
  turnLayer.inert = true;
  Object.assign(turnLayer.style, {
    left: rect.left + "px",
    top: rect.top + "px",
    width: rect.width + "px",
    height: rect.height + "px",
  });
  turnLayer.dataset.phase = "preparing";
  document.body.append(turnLayer);
  s.timeout = setTimeout(() => {
    if (preview === s) {
      document.body.dataset.curlFallback = "texture-timeout";
      session.cancel("texture-timeout");
      toast("纸页准备较慢，请重试或关闭翻页动画");
    }
  }, 2000);
  painter
    .attach(turnLayer, sceneSnapshot(index), sceneSnapshot(next), direction)
    .then(() => {
      if (s.cancelled || preview !== s) return;
      clearTimeout(s.timeout);
      s.ready = true;
      document.body.dataset.gesture = "dragging";
      turnLayer.dataset.phase = "dragging";
      $("spread").style.visibility = "hidden";
      draw();
      if (s.release) settle(s.release.complete, s.release.reason);
    })
    .catch((error) => {
      if (s.cancelled) return;
      document.body.dataset.curlFallback = error.message;
      finishTurn();
      document
        .querySelectorAll(".paragraph-tools")
        .forEach((el) => (el.style.visibility = ""));
      if (s.release?.complete) commitPage(next);
      else scheduleWarm();
    });
  return session;
}
function turn(direction) {
  const rect = $("spread").getBoundingClientRect(),
    session = beginPreview(direction, rect.top + rect.height * 0.68);
  session?.release(true, "tap");
}
function jump(anchor) {
  if (anchor !== state.anchor) lastJump = state.anchor;
  state.anchor = anchor;
  index = pageFor(anchor);
  grammarOpen.clear();
  dismissPanels();
  save();
  render();
}
function returnToPosition() {
  if (lastJump === null) return;
  const anchor = lastJump;
  lastJump = null;
  state.anchor = anchor;
  index = pageFor(anchor);
  dismissPanels();
  save();
  render();
}
function anchorSettings() {
  // Already canonical: preserve the exact selected paragraph/word when it is known.
  if (translated) state.anchor = translated.start;
  save();
  paginate();
}
function positionFloating(el, rect) {
  el.hidden = false;
  const r = el.getBoundingClientRect(),
    x = Math.max(12, Math.min(innerWidth - r.width - 12, rect.left));
  const y =
    rect.bottom + r.height + 12 < innerHeight - 98
      ? rect.bottom + 8
      : Math.max(12, rect.top - r.height - 8);
  el.style.left = x + "px";
  el.style.top = y + "px";
}
function showSelection(start, end, rect) {
  $("word-pop").hidden = true;
  $("popover").hidden = true;
  selection = { start, end, text: sourceText(start, end) };
  $("selection-count").textContent =
    `已选 ${selection.text.trim().split(/\s+/).length} 词`;
  positionFloating($("selection"), rect);
}
function selectParagraph(id) {
  const b = blocks[id],
    el = document.querySelector(`.fragment[data-block="${id}"]`);
  if (!el) return;
  showSelection(b.start, b.end, el.getBoundingClientRect());
}
function showWord(el) {
  closeTransient();
  selection = {
    start: +el.dataset.start,
    end: +el.dataset.end,
    text: el.dataset.word,
  };
  const entry = dictionary[selection.text.toLowerCase()];
  $("word-name").textContent = selection.text;
  $("word-ipa").textContent = entry?.ipa || "";
  $("word-meaning").textContent =
    entry?.meaning || "此词不在原型的小型样例词典中。正式版继续使用现有词典。";
  $("word-context").disabled = !entry;
  $("context-meaning").textContent = entry?.context || "";
  $("context-meaning").hidden = true;
  positionFloating($("word-pop"), el.getBoundingClientRect());
}
function translateSelection() {
  if (!selection) return;
  const chosen = { ...selection },
    b = sourceBlock(chosen.start);
  $("selection").hidden = true;
  window.getSelection()?.removeAllRanges();
  translated = { ...chosen, page: pageFor(chosen.start) };
  let html = "";
  if (b.id === 1) {
    let cursor = b.start;
    for (const [english, chinese] of pairs) {
      const start = b.text.indexOf(english, cursor - b.start) + b.start,
        end = start + english.length;
      cursor = end;
      if (start < chosen.end && end > chosen.start)
        html += `<button class="translated-segment" data-pair-start="${Math.max(start, chosen.start)}" data-pair-end="${Math.min(end, chosen.end)}">${esc(chinese)}</button>`;
    }
  } else
    html =
      '<p class="info">此交互原型仅给第一段长难句提供固定译文。请通过目录回到第一章，选中第一段体验原文／译文联动。此处不会伪装成 AI 翻译。</p>';
  $("translation-body").innerHTML = html;
  render();
}
function openGrammar() {
  if (!selection) return;
  const id = sourceBlock(selection.start).id;
  grammarKnown.add(id);
  grammarOpen.add(id);
  $("selection").hidden = true;
  window.getSelection()?.removeAllRanges();
  render();
  const el = document.querySelector(`.fragment[data-block="${id}"] .syntax`);
  el?.scrollIntoView({ block: "nearest" });
}
function toggleGrammar(id) {
  grammarOpen.has(id) ? grammarOpen.delete(id) : grammarOpen.add(id);
  render();
  if (grammarOpen.has(id))
    document
      .querySelector(`.fragment[data-block="${id}"] .syntax`)
      ?.scrollIntoView({ block: "nearest" });
}
function mark(anchor) {
  const found = state.marks.findIndex((m) => m.anchor === anchor);
  if (found >= 0) state.marks.splice(found, 1);
  else
    state.marks.push({
      anchor,
      quote: sourceText(anchor, anchor + 100),
      id: Date.now(),
    });
  const ok = save();
  render();
  if (!$("drawer").hidden) renderDrawer();
  if (ok) toast(found >= 0 ? "书签已移除" : "书签已保存在原型");
}
function drawer(tab = "chapters") {
  if (tab === "notes") {
    openNotes();
    return;
  }
  closeTransient();
  finishTurn();
  drawerInvoker = "directory";
  drawerTab = tab;
  $("notes-drawer").hidden = true;
  $("drawer").hidden = false;
  $("shade").hidden = false;
  $("directory").setAttribute("aria-expanded", "true");
  renderDrawer();
  $("drawer").querySelector("[data-close]").focus();
}
function recordHTML(list, type) {
  return list
    .map(
      (r, i) =>
        `<div class="record"><button class="record-jump" data-jump="${r.anchor}">${esc(r.quote)}${r.text ? `<span>${esc(r.text)}</span>` : ""}<small>第 ${pageFor(r.anchor) + 1} 页 · 跟随原文位置</small></button><button class="icon" data-remove="${type}" data-record="${i}" aria-label="移除${type === "marks" ? "书签" : "笔记"}">${icons.close}</button></div>`,
    )
    .join("");
}
function openNotes() {
  closeTransient();
  finishTurn();
  drawerInvoker = "notes";
  $("drawer").hidden = true;
  $("notes-drawer").hidden = false;
  $("shade").hidden = false;
  $("notes").setAttribute("aria-expanded", "true");
  renderNotes();
  $("notes-drawer").querySelector("[data-close]").focus();
}
function renderNotes() {
  $("notes-content").innerHTML = state.notes.length
    ? recordHTML(state.notes, "notes")
    : '<p class="info">还没有笔记。选中原文，点击“记笔记”，便能留下自己的想法。</p>';
}
function renderDrawer() {
  if (drawerTab === "notes") drawerTab = "chapters";
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.tab === drawerTab),
    );
  $("drawer-title").textContent = "目录与书签";
  if (drawerTab === "chapters")
    $("drawer-content").innerHTML = chapters
      .map((c, i) => {
        const b = blocks.find((b) => b.chapter === i);
        return `<button class="toc-entry ${pages[index]?.chapter === i ? "active" : ""}" data-jump="${b.start}">${esc(c.title)}<small>Chapter ${i + 1} · 第 ${pageFor(b.start) + 1} 页</small></button>`;
      })
      .join("");
  else {
    $("drawer-content").innerHTML = state.marks.length
      ? recordHTML(state.marks, "marks")
      : '<p class="info">在段落旁点击书签图标，便能在这里找回来。</p>';
  }
}
function popover(id, content) {
  finishTurn();
  const el = $("popover"),
    wasOpen = !el.hidden && el.dataset.owner === id;
  closeTransient();
  if (wasOpen) return;
  el.innerHTML = `<div class="panel-head"><h2>${{ style: "阅读样式", font: "字体与排版", progress: "阅读进度", help: "原型体验说明" }[id]}</h2><button class="icon" data-close="popover" aria-label="关闭阅读设置">${icons.close}</button></div>${content}`;
  el.dataset.owner = id;
  el.hidden = false;
  const rect = $(id).getBoundingClientRect();
  el.style.left =
    Math.max(
      12,
      Math.min(
        innerWidth - el.offsetWidth - 12,
        rect.left + rect.width / 2 - el.offsetWidth / 2,
      ),
    ) + "px";
  $(id).setAttribute("aria-expanded", "true");
}
function openStyle() {
  popover(
    "style",
    `
  <div class="label-row"><span>背景</span><span>即时生效</span></div><div class="choice-row">${[
    ["paper", "纸色"],
    ["light", "浅色"],
    ["dark", "深色"],
  ]
    .map(
      ([value, text]) =>
        `<button data-theme="${value}" aria-pressed="${state.theme === value}">${text}</button>`,
    )
    .join("")}</div>
  <div class="label-row"><span>页面布局</span><span>宽度不足时自动回到单页</span></div><div class="choice-row">${[
    ["auto", "自动"],
    ["single", "单页"],
    ["double", "双页"],
  ]
    .map(
      ([value, text]) =>
        `<button data-layout="${value}" aria-pressed="${state.layout === value}">${text}</button>`,
    )
    .join("")}</div>
  <label class="toggle-row">翻页动画<input id="motion-setting" type="checkbox" ${state.motion ? "checked" : ""}></label><label class="toggle-row">简短中文注释<input id="gloss-setting" type="checkbox" ${state.gloss ? "checked" : ""}></label><p class="info">双页是连续原文。选区译文暂用右页，收起后恢复阅读。系统“减少动态效果”优先于动画开关。</p>`,
  );
}
function openFont() {
  popover(
    "font",
    `
  <div class="label-row"><label for="font-size">字号</label><span id="size-value">${state.size}</span></div><input id="font-size" type="range" min="18" max="32" value="${state.size}">
  <div class="label-row"><label for="line-height">行距</label><span id="leading-value">${state.leading}</span></div><input id="line-height" type="range" min="1.5" max="2" step="0.1" value="${state.leading}">
  <div class="label-row"><span>字体</span></div><div class="choice-row"><button data-font="serif" aria-pressed="${state.font === "serif"}" style="font-family:Georgia">Georgia</button><button data-font="sans" aria-pressed="${state.font === "sans"}">系统无衬线</button></div><p class="info">布局随字号重新分页，当前位置、书签和笔记跟随原文。</p>`,
  );
}
function openProgress() {
  const percentage = Math.round((state.anchor / total) * 100);
  popover(
    "progress",
    `
  <div class="progress-value"><span>当前位置 ${percentage}%</span><span id="jump-value">${percentage}%</span></div><input id="jump-slider" aria-label="阅读进度" type="range" min="0" max="100" step="0.1" value="${percentage}"><div class="progress-preview" id="jump-preview">${esc(chapters[sourceBlock(state.anchor).chapter].title)}</div><p class="info">拖动时预览，松开即前往。跳转后可回到刚才。</p>`,
  );
}
function commitProgress(slider) {
  if (
    !slider.isConnected ||
    $("popover").hidden ||
    $("popover").dataset.owner !== "progress"
  )
    return;
  const anchor = Math.min(total - 1, Math.round((+slider.value / 100) * total));
  jump(anchor);
}
function openHelp() {
  popover(
    "help",
    `<p>两指横向滑动，在正文中抓起纸张。它和鼠标纸边拖动共用相同的二维位移与卷纸几何。</p><ul><li>手指仍贴着触控板：半程停 1 秒，纸张应保持；继续前进或回滑应接上。</li><li>抬手后才收尾。本原型优先接收本机 NSEvent 的 ended 阶段；不把静默当作抬手，不等待抬手后的惯性流结束。真实手指体验仍待验收。</li><li>鼠标按住左右纸边作为对照；本原型两种输入都采用更短收尾，不改正式版。</li><li>若未抬手却回弹，或抬手后悬停，请记录并停止验收该方案。</li><li>此原型只验收翻页，正文上的词卡/选区暂由透明手势区覆盖。工具层仍可从顶部打开。</li></ul><button id="download-native" class="quiet">下载本原型手势记录</button>`,
  );
}
function stopSpeech() {
  window.speechSynthesis?.cancel();
  if (speechButton) {
    speechButton.textContent = speechButton.dataset.label;
    speechButton = null;
  }
}
function speak(text, button) {
  if (speechButton === button) {
    stopSpeech();
    return;
  }
  stopSpeech();
  if (!("speechSynthesis" in window)) {
    toast("此浏览器未提供本机发音");
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.92;
  const voice = speechSynthesis
    .getVoices()
    .find((v) => v.lang.startsWith("en") && v.localService);
  if (voice) utterance.voice = voice;
  speechButton = button;
  button.dataset.label = button.textContent;
  button.textContent = "停止";
  utterance.onend = () => {
    if (speechButton === button) {
      button.textContent = button.dataset.label;
      speechButton = null;
    }
  };
  utterance.onerror = (e) => {
    utterance.onend();
    if (e.error !== "canceled" && e.error !== "interrupted")
      toast("本机发音暂不可用");
  };
  speechSynthesis.speak(utterance);
}

// Controls are delegated so source fragments can be replaced after pagination.
document.addEventListener("click", (e) => {
  const target = e.target.closest("button");
  if (!target) return;
  if (target.dataset.close) {
    const id = target.dataset.close;
    if (id === "drawer" || id === "notes-drawer") {
      dismissPanels();
      readingZones.focusTrigger();
    } else if (id === "translation") {
      translated = null;
      selection = null;
      clearHighlights();
      render();
    } else {
      $(id).hidden = true;
      if (id === "word-pop" || id === "selection") stopSpeech();
      if (id === "selection") window.getSelection()?.removeAllRanges();
      if (id === "popover")
        document
          .querySelectorAll(".tool")
          .forEach((b) => b.setAttribute("aria-expanded", "false"));
    }
    return;
  }
  if (target.dataset.tab) {
    drawerTab = target.dataset.tab;
    renderDrawer();
    return;
  }
  if (target.dataset.jump) {
    jump(+target.dataset.jump);
    return;
  }
  if (target.dataset.remove) {
    state[target.dataset.remove].splice(+target.dataset.record, 1);
    save();
    renderDrawer();
    renderNotes();
    render();
    return;
  }
  if (target.dataset.mark) {
    mark(+target.dataset.mark);
    return;
  }
  if (target.dataset.showNotes) {
    drawer("notes");
    return;
  }
  if (target.dataset.select) {
    selectParagraph(+target.dataset.select);
    return;
  }
  if (target.dataset.grammar) {
    toggleGrammar(+target.dataset.grammar);
    return;
  }
  if (target.dataset.theme) {
    state.theme = target.dataset.theme;
    applyStyle();
    save();
    $("popover").hidden = true;
    openStyle();
    return;
  }
  if (target.dataset.layout) {
    state.layout = target.dataset.layout;
    anchorSettings();
    openStyle();
    return;
  }
  if (target.dataset.font) {
    state.font = target.dataset.font;
    anchorSettings();
    openFont();
    return;
  }
  if (target.dataset.syntax) {
    const node = syntax[+target.dataset.syntax],
      b = blocks[1],
      start = b.start + b.text.indexOf(node.quote);
    highlight(start, start + node.quote.length);
    target.closest(".syntax").querySelector(".syntax-detail").textContent =
      node.detail;
    return;
  }
  if (target.dataset.pairStart) {
    highlight(+target.dataset.pairStart, +target.dataset.pairEnd);
    document
      .querySelectorAll(".translated-segment")
      .forEach((el) => el.classList.toggle("active", el === target));
    return;
  }
  if (target.dataset.action) {
    const action = target.dataset.action;
    if (action === "translate") translateSelection();
    if (action === "grammar") openGrammar();
    if (action === "speak" && selection) speak(selection.text, target);
    if (action === "note" && selection) {
      $("note-quote").textContent = selection.text;
      $("note-body").value = "";
      $("note-dialog").showModal();
      $("note-body").focus();
    }
    return;
  }
  if (target.id === "download-native") {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            native: JSON.parse(document.body.dataset.nativeEvidence || "[]"),
            summary: JSON.parse(document.body.dataset.nativeSummary || "null"),
            settle: JSON.parse(document.body.dataset.settleMetrics || "[]"),
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wise-reader-prototype-gestures.json";
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const actions = {
    prev: () => turn(-1),
    next: () => turn(1),
    directory: () => drawer(),
    notes: openNotes,
    progress: openProgress,
    style: openStyle,
    font: openFont,
    help: openHelp,
    "return-position": returnToPosition,
    "word-speak": () => selection && speak(selection.text, $("word-speak")),
    "word-context": () => {
      $("context-meaning").hidden = !$("context-meaning").hidden;
    },
    fullscreen: async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (document.documentElement.requestFullscreen)
          await document.documentElement.requestFullscreen();
        else toast("当前浏览器不支持网页全屏，可使用窗口全屏");
      } catch {
        toast("当前浏览器未允许网页全屏，可使用窗口全屏");
      }
    },
  };
  actions[target.id]?.();
});
document.addEventListener("click", (e) => {
  // A setting can rebuild its panel during the delegated handler above. The old
  // button is then detached; treating it as an outside click closes the new panel.
  if (e.target.closest("button")) return;
  if (
    !e.target.closest("#popover,#selection,#word-pop,.toolbar,#help") &&
    !$("popover").hidden
  ) {
    $("popover").hidden = true;
    document
      .querySelectorAll(".tool")
      .forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
  const word = e.target.closest(".word");
  if (word && !window.getSelection()?.toString().trim()) showWord(word);
  else if (
    !e.target.closest(".word,#word-pop,#selection,.paragraph-tools") &&
    !$("word-pop").hidden
  ) {
    $("word-pop").hidden = true;
    stopSpeech();
  }
});
document.addEventListener("pointerover", (e) => {
  const pair = e.target.closest("[data-pair-start]");
  if (pair) highlight(+pair.dataset.pairStart, +pair.dataset.pairEnd);
  const node = e.target.closest("[data-syntax]");
  if (node) {
    const n = syntax[+node.dataset.syntax],
      b = blocks[1],
      start = b.start + b.text.indexOf(n.quote);
    highlight(start, start + n.quote.length);
    node.closest(".syntax").querySelector(".syntax-detail").textContent =
      n.detail;
  }
  const word = e.target.closest(".word");
  if (word && translated) {
    const start = +word.dataset.start;
    document
      .querySelectorAll("[data-pair-start]")
      .forEach((p) =>
        p.classList.toggle(
          "active",
          start >= +p.dataset.pairStart && start < +p.dataset.pairEnd,
        ),
      );
  }
});
document.addEventListener("pointerout", (e) => {
  if (e.target.closest("[data-pair-start],[data-syntax]"))
    document
      .querySelectorAll(".word.linked")
      .forEach((w) => w.classList.remove("linked"));
});
$("shade").onclick = () => {
  dismissPanels();
  readingZones.focusTrigger();
};
$("note-dialog").addEventListener("close", () => {
  if ($("note-dialog").returnValue !== "save" || !selection) return;
  const text = $("note-body").value.trim();
  if (!text) {
    toast("没有内容，未保存笔记");
    return;
  }
  state.notes.push({
    anchor: selection.start,
    end: selection.end,
    quote: selection.text,
    text,
    id: Date.now(),
  });
  const ok = save();
  $("selection").hidden = true;
  render();
  if (ok) toast("笔记已保存在原型");
});
document.addEventListener("input", (e) => {
  if (e.target.id === "jump-slider") {
    const anchor = Math.min(
      total - 1,
      Math.round((+e.target.value / 100) * total),
    );
    $("jump-value").textContent = e.target.value + "%";
    $("jump-preview").textContent = chapters[sourceBlock(anchor).chapter].title;
  }
  if (e.target.id === "font-size") $("size-value").textContent = e.target.value;
  if (e.target.id === "line-height")
    $("leading-value").textContent = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.id === "jump-slider" && !progressDrag) commitProgress(e.target);
  if (e.target.id === "font-size") {
    state.size = +e.target.value;
    anchorSettings();
    openFont();
  }
  if (e.target.id === "line-height") {
    state.leading = +e.target.value;
    anchorSettings();
    openFont();
  }
  if (e.target.id === "motion-setting") {
    state.motion = e.target.checked;
    applyStyle();
    save();
  }
  if (e.target.id === "gloss-setting") {
    state.gloss = e.target.checked;
    anchorSettings();
    openStyle();
  }
});
document.addEventListener(
  "pointerdown",
  (e) => {
    if (e.target.id === "jump-slider")
      progressDrag = {
        pointer: e.pointerId,
        slider: e.target,
        value: e.target.value,
      };
  },
  true,
);
document.addEventListener("pointercancel", () => {
  progressDrag = null;
});
document.addEventListener("pointerup", (e) => {
  if (progressDrag && progressDrag.pointer === e.pointerId) {
    const drag = progressDrag;
    progressDrag = null;
    if (drag.slider.value !== drag.value) commitProgress(drag.slider);
    return;
  }
  if (
    e.target.closest(
      "button,input,textarea,#drawer,#notes-drawer,#popover,.syntax,#translation",
    )
  )
    return;
  const native = window.getSelection();
  if (!native || native.isCollapsed || !native.rangeCount) return;
  const range = native.getRangeAt(0),
    container =
      range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
  if (!container.closest(".prose")) return;
  const words = Array.from(document.querySelectorAll(".prose .word")).filter(
    (w) => range.intersectsNode(w),
  );
  if (words.length > 1)
    showSelection(
      +words[0].dataset.start,
      +words.at(-1).dataset.end,
      range.getBoundingClientRect(),
    );
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && preview) {
    e.preventDefault();
    finishTurn();
    scheduleWarm();
    return;
  }
  if ($("note-dialog").open) return;
  if (e.key === "Escape") {
    if (!$("drawer").hidden || !$("notes-drawer").hidden) {
      dismissPanels();
      readingZones.focusTrigger();
    } else if (
      !$("popover").hidden ||
      !$("word-pop").hidden ||
      !$("selection").hidden
    )
      closeTransient();
    else if (translated) {
      translated = null;
      render();
    }
    return;
  }
  if (e.target.closest("input,textarea,select")) return;
  if (e.target.closest("button,a") && e.key === " ") return;
  if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey)
    $("fullscreen").click();
  if (["ArrowRight", "PageDown", " "].includes(e.key)) {
    e.preventDefault();
    turn(1);
  }
  if (["ArrowLeft", "PageUp"].includes(e.key)) {
    e.preventDefault();
    turn(-1);
  }
});
/* Pointer capture handles both mouse and touch edge gestures.
let swipe=null;
$('stage').addEventListener('touchstart',e=>{const t=e.touches[0];swipe=t&&(t.clientX<65||t.clientX>innerWidth-65)?{x:t.clientX,y:t.clientY}:null;},{passive:true});
$('stage').addEventListener('touchend',e=>{if(!swipe)return;const t=e.changedTouches[0],dx=t.clientX-swipe.x,dy=t.clientY-swipe.y;swipe=null;if(Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*1.5)turn(dx<0?1:-1);},{passive:true});
*/
document.addEventListener("fullscreenchange", () => {
  $("fullscreen").innerHTML =
    icons[document.fullscreenElement ? "exit" : "fullscreen"];
  $("fullscreen").setAttribute(
    "aria-label",
    document.fullscreenElement ? "退出全屏" : "进入全屏",
  );
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => paginate(), 80);
});
window.addEventListener("resize", () => {
  finishTurn();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => paginate(), 120);
});
window.addEventListener("blur", () => {
  finishTurn();
  scheduleWarm();
});
document.addEventListener("curl-context-lost", () => {
  finishTurn();
  document.body.dataset.curlFallback = "context-lost";
});
window.addEventListener("pagehide", () => {
  finishTurn();
  stopSpeech();
  save();
  painter.dispose();
});
edgeDrag = installEdgeDrag({ begin: beginPreview, enabled: canTurn });
nativeTrackpad = installNativeTrackpad({
  begin: beginPreview,
  enabled: canInteract,
  busy: () => busy,
});
await document.fonts.ready;
paginate();
save();
