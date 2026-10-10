import { local, Scope, e } from "./core.js";

const RETURN_KEY = "ai-reading-return";

export function aiReadingReturn() {
  const value = local.get(RETURN_KEY);
  return value && Number.isInteger(value.doc_id) && value.doc_id > 0
    ? value
    : null;
}

export function returnFromAI(ctx, value) {
  local.remove(RETURN_KEY);
  ctx.jump(value.doc_id, value.anchor);
}

// Configuration belongs to the current reader. Closing this modeless dialog
// preserves its in-memory draft; only leaving the reader disposes it.
export async function openReadingAI(reader, request = {}) {
  if (reader.scope.signal.aborted) return;
  reader.pages?.finishAnimation();
  reader.focus.close();
  reader.closePop();
  getSelection()?.removeAllRanges();
  const title = { grammar: "语法分析", translation: "翻译所选文字" };
  let view = reader.readingAI;
  if (view?.failed) { view.scope.dispose(); view.dialog.remove(); view = reader.readingAI = null; }
  if (!view) {
    const scope = new Scope(), dialog = document.createElement("dialog");
    dialog.className = "ai-reading-dialog";
    dialog.setAttribute("aria-label", "阅读中的文本 AI 设置");
    dialog.innerHTML = `<section class="ai-reading-card"><header><div><h2>连接文本 AI</h2><p>原文和选区留在这里。点正文即可收起。</p></div><button type="button" data-ai-close aria-label="收起 AI 设置">×</button></header><div data-ai-editor><p role="status">正在读取配置…</p></div><footer><span data-ai-ready role="status">测试成功后自动保存</span><button type="button" class="primary" data-ai-resume hidden disabled></button></footer></section>`;
    document.querySelector(".reader").append(dialog);
    const card = dialog.querySelector(".ai-reading-card"), resume = dialog.querySelector("[data-ai-resume]");
    view = reader.readingAI = { dialog, card, scope, ready: false, request: {} };
    const position = () => {
      // Prefer the side with the most room around the selected source. On a
      // narrow page the card overlays the prose, without repaginating it.
      const rects = (reader.selectedTextRanges || []).flatMap(v => [...v.range.getClientRects()])
        .filter(b => b.width && b.bottom > 0 && b.top < innerHeight);
      const center = rects.length ? (Math.min(...rects.map(b => b.left)) + Math.max(...rects.map(b => b.right))) / 2 : innerWidth / 2;
      card.style.left = center < innerWidth / 2 ? "auto" : "16px";
      card.style.right = center < innerWidth / 2 ? "16px" : "auto";
    };
    view.close = () => {
      dialog.close();
      reader.aiSetupOpen = false;
      reader.positionSelection();
      document.querySelector("#article")?.focus({preventScroll: true});
    };
    scope.on(dialog, "click", event => {
      if (event.target === dialog || event.target.closest("[data-ai-close]")) {
        event.preventDefault(); event.stopPropagation(); view.close();
      }
    });
    scope.on(dialog, "cancel", event => { event.preventDefault(); view.close(); });
    scope.on(document, "keydown", event => {
      if (!dialog.open) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); view.close(); }
      if (event.key === "Tab") {
        const controls = [...card.querySelectorAll("button,input,a,select,textarea")].filter(el => !el.disabled && el.getClientRects().length);
        if (!controls.length) return;
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
      }
    }, {capture: true});
    scope.on(resume, "click", () => {
      const {anchor, kind} = view.request;
      view.close();
      if (!anchor || !reader.selectionActions.has(kind)) return;
      reader.choose(anchor);
      Promise.resolve(reader.selectionActions.get(kind).fn(anchor)).catch(error => reader.status(error.message, {notice: true}));
    });
    scope.on(window, "resize", position, {passive: true});
    view.open = request => {
      view.request = request;
      resume.hidden = !title[request.kind] || !request.anchor;
      resume.textContent = "继续" + (title[request.kind] || "阅读");
      resume.disabled = !view.ready || view.busy || view.dirty;
      reader.aiSetupOpen = true;
      if (!dialog.open) dialog.show();
      position(); reader.positionSelection();
    };
    reader.scope.cleanup(() => { scope.dispose(); dialog.remove(); reader.aiSetupOpen = false; });
    view.open(request);
    try {
      const { renderAI } = await import("./ai-settings.js");
      if (scope.signal.aborted) return;
      await renderAI({ ...reader.ctx, root: dialog.querySelector("[data-ai-editor]") }, scope, {
        embedded: true,
        onAvailability: ready => { view.ready = Boolean(ready); resume.disabled = !ready || view.busy || view.dirty; },
        onBusy: busy => { view.busy = busy; resume.disabled = busy || !view.ready || view.dirty; },
        onEdited: () => {
          view.dirty = true; resume.disabled = true;
          dialog.querySelector("[data-ai-ready]").textContent = view.ready ? "修改未保存 · 阅读仍使用上次配置" : "填写后测试连接，成功自动保存";
        },
        onReady: () => {
          view.dirty = false; resume.disabled = !view.ready || view.busy;
          dialog.querySelector("[data-ai-ready]").textContent = "已就绪 · 点正文继续阅读";
        },
      });
    } catch (error) {
      view.failed = true;
      if (!scope.signal.aborted) dialog.querySelector("[data-ai-editor]").innerHTML = `<p role="alert">${e(error.message)}</p>`;
    }
    return;
  }
  view.open(request);
}

// Only the server's explicit setup error opens the small editor. Existing
// cached results stay usable without a provider, and no paid request is retried.
export function offerAISetup(reader, anchor, error, kind) {
  if (error.status !== 400 ||
      error.message !== "请先在 AI 与语音中配置并启用文本 AI" ||
      reader.scope.signal.aborted) return false;
  const toast = document.querySelector("#toast");
  if (toast) toast.hidden = true;
  openReadingAI(reader, {anchor: structuredClone(anchor), kind}).catch(err => reader.status(err.message, {notice: true}));
  return true;
}
