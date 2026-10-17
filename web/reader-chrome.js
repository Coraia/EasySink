import { openReadingAI } from "./ai-setup-guard.js";
import { $, e, local, toast } from "./core.js";

const icons = {
  outline: '<path d="M4 5h16M4 12h16M4 19h16"/>',
  notes: '<path d="M5 3h11l3 3v15H5zM8 8h8M8 12h8M8 16h5"/>',
  collections: '<path d="M6 3h12v18l-6-4-6 4zM9 7h6M9 10h6"/>',
  progress:
    '<path d="M3 9h5m4 0h9M3 16v2m6-2v2m6-2v2m6-2v2"/><circle cx="10" cy="9" r="2"/>',
  appearance:
    '<circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2"/>',
  typography: '<path d="M4 20L12 4l8 16M7 14h10"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  fullscreen: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
};
export const readerIcon = (id) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[id] || icons.more}</svg>`;

export function readerShell(d, progressEnabled) {
  const sourceRange = d.pdf ? `来源 PDF 第 ${d.pdf.start_page}–${d.pdf.end_page} 页` : "";
  const caption = d.pdf ? `阅读版 · ${sourceRange}` : d.title;
  let source = "";
  if (!d.pdf && d.availability === "ready" && d.source) {
    const value = d.source.final_url;
    try {
      const url = new URL(value);
      if (typeof value === "string" && ["https:", "http:"].includes(url.protocol) &&
          !url.username && !url.password && !/[\u0000-\u0020\u007f\\]/.test(value)) {
        const details = [["作者", d.source.author], ["发布", d.source.published_at], ["抓取", d.source.fetched_at]]
          .filter(([, v]) => typeof v === "string" && v.length).map(([label, v]) => `${label}：${e(v)}`).join(" · ");
        source = `<span class="reading-url-source" style="display:block;white-space:normal;overflow-wrap:anywhere">来源：<a href="${e(value)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${e(value)}</a>${details ? `<span style="display:block">${details}</span>` : ""}</span>`;
      }
    } catch { /* Invalid source metadata must never become a navigation target. */ }
  }
  return `<div class="reader paged-reader" data-document-id="${d.id}" data-chrome="closed">
    <button id="show-tools" class="reader-top-zone" aria-label="显示阅读工具" aria-expanded="false"></button>
    <div id="reader-chrome" hidden>
      <button id="chrome-dismiss" class="chrome-backdrop" aria-label="收起阅读工具"></button>
      <header class="reading-banner"><a href="#/" aria-label="返回书架">←</a><span class="banner-title">${d.pdf ? "阅读版 · " : ""}${e(d.title)}</span><span id="reader-save" role="status">${progressEnabled ? "阅读位置会自动保存" : "续读已关闭"}</span><button id="reader-fullscreen" class="reader-icon" aria-label="进入全屏" title="进入全屏">${readerIcon("fullscreen")}</button></header>
      <nav id="reader-actions" class="reader-icon-strip" aria-label="阅读工具"></nav>
    </div>
    <section class="reading-viewport" id="reading-stage">
      <header class="reading-heading" hidden><h1>${e(d.title)}</h1><span id="annotation-meta"></span></header>
      <div class="reading-columns"><article id="article" class="reading-spread" lang="en" aria-label="英文正文"></article><aside id="translation-pane" aria-label="所选文字的对照译文" hidden></aside></div>
      <button id="reading-edge-prev" class="reading-edge-grip" aria-label="抓住左侧纸页" title="按住向右拖动 · 上一页"></button><button id="reading-edge-next" class="reading-edge-grip" aria-label="抓住右侧纸页" title="按住向左拖动 · 下一页"></button>
      <div id="page-curl-layer" aria-hidden="true" hidden></div>
      <div id="reading-selection" class="reading-selection" hidden></div>
      <div class="reader-page-caption" aria-live="off"><span class="caption-title" ${d.pdf ? 'data-pdf-reading-edition title="当前为可重排阅读版；来源页码用于核对 PDF 原件"' : ""}>${e(caption)}${source}</span><span id="reading-page-total"></span></div>
    </section>
    <button id="panel-dismiss" class="panel-backdrop" aria-label="关闭阅读面板" hidden></button>
    <aside class="tool-panel" id="tool-panel" hidden></aside>
    <div id="reader-extra-tools" hidden></div>
    <div id="reader-book-actions" hidden><div id="reader-density-actions"><div class="density-control" role="group" aria-label="辅助密度"><span>辅助密度</span>${[
      [0, "原文"],
      [2, "轻"],
      [4, "适中"],
      [8, "多"],
    ]
      .map(
        ([v, label]) =>
          `<button data-density="${v}" aria-label="辅助密度：${label}" class="${d.density === v ? "active" : ""}">${label}</button>`,
      )
      .join(
        "",
      )}</div><p id="density-hint" class="muted"></p></div><div class="row wrap"><button id="archive-reading" class="text-button">${d.archived ? "移回书架" : "归档"}</button><button id="finish-reading" class="text-button">读完了 ✓</button></div><div id="chapter-nav"></div></div>
    <div class="read-progress" hidden><div></div></div>
  </div>`;
}

// All listeners belong to the reader scope; no global handler survives a route.
export function installReaderChrome(r) {
  const chrome = $("#reader-chrome"),
    trigger = $("#show-tools"),
    stage = $("#reading-stage");
  let pointer = null,
    released = null;
  const consume = (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  const modal = () => Boolean(document.querySelector("dialog[open]"));
  const close = (focus = false) => {
    if (r.panelId) r.closePanel();
    chrome.hidden = true;
    trigger.hidden = false;
    stage.inert = false;
    trigger.setAttribute("aria-expanded", "false");
    $(".reader").dataset.chrome = "closed";
    r.positionSelection?.();
    if (focus) trigger.focus({ preventScroll: true });
  };
  const open = () => {
    if (modal()) return;
    r.pages?.finishAnimation();
    r.closePop();
    r.closePanel();
    chrome.hidden = false;
    trigger.hidden = true;
    stage.inert = true;
    trigger.setAttribute("aria-expanded", "true");
    $(".reader").dataset.chrome = "open";
    r.positionSelection?.();
    $("#reader-fullscreen").focus({ preventScroll: true });
  };
  const onInk = (target, x, y) => {
    if (
      target.closest(
        ".source-unit,.annotation,.gloss,.inline-grammar,#translation-pane,.reader-page-caption,.pdf-object",
      )
    )
      return true;
    const text = target.closest("[data-block],.leaf-heading");
    if (!text) return false;
    const range = document.createRange();
    range.selectNodeContents(text);
    return [...range.getClientRects()].some(
      (box) =>
        box.width &&
        box.height &&
        x >= box.left &&
        x <= box.right &&
        y >= box.top &&
        y <= box.bottom,
    );
  };
  r.scope.on(
    document,
    "pointerdown",
    (ev) => {
      released = null;
      pointer = {
        id: ev.pointerId,
        x: ev.clientX,
        y: ev.clientY,
        moved: false,
        dismissedPop: Boolean(
          r.popElement &&
          !r.popElement.contains(ev.target) &&
          !ev.target.closest(".source-unit,.annotation"),
        ),
      };
    },
    { capture: true },
  );
  r.scope.on(
    document,
    "pointermove",
    (ev) => {
      if (
        pointer?.id === ev.pointerId &&
        Math.hypot(ev.clientX - pointer.x, ev.clientY - pointer.y) > 6
      )
        pointer.moved = true;
    },
    { capture: true },
  );
  r.scope.on(
    document,
    "pointerup",
    (ev) => {
      if (pointer?.id === ev.pointerId) released = pointer;
      pointer = null;
    },
    { capture: true },
  );
  r.scope.on(
    document,
    "pointercancel",
    () => {
      released = null;
      pointer = null;
    },
    { capture: true },
  );
  r.scope.on(
    document,
    "click",
    (ev) => {
      const target =
        ev.target instanceof Element ? ev.target : ev.target.parentElement;
      const gesture = released;
      released = null;
      if (r.aiSetupOpen || modal() || target.closest("dialog")) return;
      const dismissedSelection = r.selectionDismissedByPointer;
      r.selectionDismissedByPointer = false;
      // Undo belongs above the reader's dismiss surface and toolbar.
      if (target.closest("#toast")) return;
      if (location.search.includes("acceptance"))
        $(".reader").dataset.lastTap = JSON.stringify({
          x: ev.clientX,
          y: ev.clientY,
          detail: ev.detail,
          moved: gesture?.moved,
          tag: target.tagName,
          chrome: !chrome.hidden,
          panel: r.panelId,
        });
      if (gesture?.moved && !target.closest("input,textarea,select")) {
        consume(ev);
        return;
      }
      if (dismissedSelection && !target.closest("button,a,input,textarea,select") &&
          !onInk(target, ev.clientX, ev.clientY)) {
        consume(ev);
        return;
      }
      if (!chrome.hidden) {
        // The entire strip is an interaction surface, including its borders.
        // Primary controls keep chrome visible while their panel is toggled.
        if (target.closest("#reader-actions")) {
          if (!target.closest("button[data-tool]")) consume(ev);
          return;
        }
        // Panels sit above the transparent dismiss layer and remain editable.
        if (target.closest("#tool-panel")) return;
        if (
          target.closest(
            "#reader-chrome button:not(#chrome-dismiss),#reader-chrome a",
          )
        )
          queueMicrotask(() => close());
        else {
          if (r.panelId) r.dismissPanel();
          else close(true);
          consume(ev);
        }
        return;
      }
      if (target.closest("#show-tools")) {
        open();
        consume(ev);
        return;
      }
      if (
        modal() ||
        r.panelId ||
        target.closest(
          ".annotation-pop,#reading-selection,#translation-pane,.inline-grammar,button,a,input,textarea,select",
        )
      )
        return;
      if (gesture?.dismissedPop || r.popElement) {
        r.closePop();
        consume(ev);
        return;
      }
      if (
        getSelection()?.toString().trim() ||
        ev.detail !== 1 ||
        onInk(target, ev.clientX, ev.clientY)
      )
        return;
      if (!target.closest(".paged-reader")) return;
      consume(ev);
      r.pages.adjacent(ev.clientX < innerWidth / 2 ? -1 : 1);
    },
    { capture: true },
  );
  r.scope.on(
    document,
    "keydown",
    (ev) => {
      if (r.aiSetupOpen || modal()) return;
      if (ev.key === "Escape") {
        if (r.panelId) {
          r.dismissPanel();
          consume(ev);
        } else if (!chrome.hidden) {
          close(true);
          consume(ev);
        }
        return;
      }
      if (
        !chrome.hidden ||
        modal() ||
        r.panelId ||
        r.popElement ||
        ev.target.closest(
          'input,textarea,select,button:not(#show-tools):not(.reading-edge-grip),a,[contenteditable="true"]',
        ) ||
        ev.ctrlKey ||
        ev.metaKey ||
        ev.altKey ||
        getSelection()?.toString()
      )
        return;
      const direction = ["ArrowRight", "PageDown", " "].includes(ev.key)
        ? 1
        : ["ArrowLeft", "PageUp"].includes(ev.key)
          ? -1
          : 0;
      if (direction) {
        consume(ev);
        r.pages.adjacent(direction);
      }
    },
    { capture: true },
  );
  r.scope.on($("#panel-dismiss"), "click", () => r.dismissPanel());
  r.scope.on($("#reader-fullscreen"), "click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast("当前窗口不支持全屏，可使用浏览器全屏。");
    }
  });
  r.scope.on(document, "fullscreenchange", () => {
    const label = document.fullscreenElement ? "退出全屏" : "进入全屏";
    $("#reader-fullscreen").setAttribute("aria-label", label);
    $("#reader-fullscreen").title = label;
  });
  r.focus = { open, close, isOpen: () => !chrome.hidden };
  close();
  r.scope.cleanup(() => {
    stage.inert = false;
    document.body.classList.remove("paged-reading");
  });
}

export function installCoreReaderTools(r) {
  r.tool("progress", "阅读进度", () =>
    r.panel(
      "progress",
      "阅读进度",
      `<div class="row between"><span id="seek-preview"></span><button id="seek-return" ${r.returnAnchor ? "" : "hidden"}>回到刚才</button></div><label for="reading-seek">拖动后松开，回到原文位置</label><input id="reading-seek" type="range" min="0" max="1000" step="1" value="${Math.round(r.position().ratio * 1000)}"><p class="muted">${e(r.doc.title)}</p>`,
      (el, scope) => {
        const input = $("#reading-seek", el),
          preview = $("#seek-preview", el),
          back = $("#seek-return", el);
        const update = () =>
          (preview.textContent = `${(+input.value / 10).toFixed(1)}%`);
        update();
        scope.on(input, "input", update);
        scope.on(input, "change", async () => {
          r.returnAnchor = { ...r.position() };
          back.hidden = false;
          await r.pages.seek(+input.value / 1000);
          if (!scope.signal.aborted) update();
        });
        scope.on(back, "click", async () => {
          const a = r.returnAnchor;
          if (!a) return;
          await r.restore(a);
          if (scope.signal.aborted) return;
          input.value = Math.round(r.position().ratio * 1000);
          update();
        });
      },
    ),
  );
  r.tool("appearance", "阅读样式", () =>
    r.panel(
      "appearance",
      "阅读样式",
      `<div id="appearance-assistance"></div><div class="chips">${[
        ["paper", "自然纸色"],
        ["sepia", "暖色书页"],
        ["night", "夜间阅读"],
      ]
        .map(
          ([id, label]) =>
            `<button data-reader-theme="${id}" aria-pressed="${document.documentElement.dataset.theme === id}">${label}</button>`,
        )
        .join(
          "",
        )}</div><label for="reader-layout">分页方式</label><select id="reader-layout">${[
        ["auto", "自动 · 宽屏双页"],
        ["single", "始终单页"],
        ["double", "宽屏双页"],
      ]
        .map(
          ([id, label]) =>
            `<option value="${id}" ${local.get("page-layout", "auto") === id ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select><label for="reader-motion">翻页效果</label><select id="reader-motion"><option value="curl">仿真卷页</option><option value="off">无动画</option></select><label class="row"><input id="reader-light" type="checkbox">纸页光影</label><p class="save-state">调整后自动保存</p>`,
      (el, scope) => {
        const assistance = $("#reader-density-actions");
        $("#appearance-assistance", el).append(assistance);
        scope.cleanup(() => $("#reader-book-actions").prepend(assistance));
        $("#reader-motion", el).value = local.get("page-motion", "curl");
        $("#reader-light", el).checked = local.get("page-light", true);
        scope.on($("#reader-light", el), "change", (ev) => {
          local.set("page-light", ev.target.checked);
          r.pages.invalidatePaint();
        });
        scope.on(el, "click", (ev) => {
          const b = ev.target.closest("[data-reader-theme]");
          if (!b) return;
          document.documentElement.dataset.theme = b.dataset.readerTheme;
          local.set("theme", b.dataset.readerTheme);
          el.querySelectorAll("[data-reader-theme]").forEach((x) =>
            x.setAttribute("aria-pressed", String(x === b)),
          );
          r.pages.invalidatePaint();
        });
        scope.on($("#reader-layout", el), "change", (ev) => {
          local.set("page-layout", ev.target.value);
          r.pages.reflow(r.position());
        });
        scope.on($("#reader-motion", el), "change", (ev) => {
          local.set("page-motion", ev.target.value);
          r.pages.finishAnimation();
        });
      },
    ),
  );
  r.tool("more", "更多阅读功能", () =>
    r.panel(
      "more",
      "阅读工具",
      `<div id="more-plugin-tools" class="more-plugin-tools"></div><div id="more-book-actions"></div><nav class="more-links"><button type="button" data-reading-ai>文本 AI 设置</button><a href="#/ai">语音设置 ↗</a><a href="#/profile">阅读偏好 ↗</a><a href="#/labs">功能管理 ↗</a></nav>`,
      (el, scope) => {
        scope.on($("[data-reading-ai]", el), "click", () => openReadingAI(r));
        const extra = $("#reader-extra-tools"),
          book = $("#reader-book-actions");
        $("#more-plugin-tools", el).append(...extra.childNodes);
        $("#more-book-actions", el).append(book);
        book.hidden = false;
        scope.cleanup(() => {
          extra.append(...$("#more-plugin-tools", el).childNodes);
          book.hidden = true;
          $(".reader").append(book);
        });
      },
    ),
  );
  // Stable semantic order, independent of asynchronous plugin installation.
  for (const id of [
    "outline",
    "notes",
    "collections",
    "progress",
    "appearance",
    "typography",
    "more",
  ]) {
    const button = $("#tool-" + id);
    if (button) $("#reader-actions").append(button);
  }
}
