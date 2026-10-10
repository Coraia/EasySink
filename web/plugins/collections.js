import { $, toast } from "../core.js";
import { sameSelection } from "../source-selection.js";
import { childScope, createCollectionsStore } from "../collections-store.js";
import {
  createMarkPainter,
  createAnnotationOverlay,
} from "../collections-marks.js";
import { mountCollectionsList, mountResurface } from "../collections-list.js";
import { mountCollectionWord } from "../collections-word.js";

const STATE_READINESS_MS = 1500;

// The preparation owns a handled result, never a publishing continuation.
// It can start before the document exists and be consumed once by its reader.
function startStateRead(store, docId, owner) {
  const scope = childScope(store.scope, owner),
    ownerSignal = owner?.signal || owner;
  let timer;
  const interrupted = new Promise((_, reject) => {
    const aborted = () =>
      reject(new DOMException("Collection read cancelled", "AbortError"));
    scope.signal.addEventListener("abort", aborted, { once: true });
    scope.cleanup(() => scope.signal.removeEventListener("abort", aborted));
    if (scope.signal.aborted) aborted();
    else
      timer = setTimeout(() => {
        // Reject first: fetch/body parsing may swallow cancellation.
        reject(new Error("收藏记录加载超时，请重试"));
        scope.dispose();
      }, STATE_READINESS_MS);
  });
  const result = (async () => {
    try {
      const payload = await Promise.race([
        store.read(`/state/${encodeURIComponent(docId)}`, scope),
        interrupted,
      ]);
      scope.signal.throwIfAborted();
      return { payload };
    } catch (error) {
      return { error };
    } finally {
      clearTimeout(timer);
      scope.dispose();
    }
  })();
  return {
    docId,
    scope,
    result,
    isCurrent: () => !ownerSignal?.aborted && !store.scope.signal.aborted,
  };
}

export function install(ctx) {
  let stylesheet = document.querySelector("link[data-collections-style]");
  if (!stylesheet) {
    stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("../collections.css", import.meta.url).href;
    stylesheet.dataset.collectionsStyle = "";
    document.head.append(stylesheet);
  }
  const store = createCollectionsStore(),
    controllers = new Set();

  function createController(reader) {
    const scope = childScope(store.scope, reader.scope),
      events = new EventTarget(),
      beforeLayout = !reader.pages;
    let prefetch = reader.preparation?.collectionsPrefetch;
    if (prefetch) {
      delete reader.preparation.collectionsPrefetch;
      if (prefetch.docId !== reader.doc.id || !prefetch.isCurrent()) {
        prefetch.scope.dispose();
        prefetch = null;
      }
    }
    const painter = createMarkPainter(reader),
      overlay = createAnnotationOverlay(reader);
    let state = { items: [], feedback: [] },
      generation = 0,
      requestScope,
      mounted = false,
      initial = true;
    let annotationSignature = "[]",
      markSignature = "[]";
    const publish = (payload, error = null) => {
      if (scope.signal.aborted) return;
      if (!Array.isArray(payload?.items) || !Array.isArray(payload?.feedback))
        throw new Error("收藏记录返回格式不完整，请重试");
      state = { items: payload.items || [], feedback: payload.feedback || [] };
      reader.collectionsSeed = payload;
      controller.loaded = !error;
      controller.error = error;
      const nextAnnotations = JSON.stringify(
        state.feedback
          .filter(
            (value) =>
              value.anchor?.version === reader.doc.version &&
              (value.retained || value.understood === true),
          )
          .map((value) => [
            value.anchor,
            value.understood,
            value.retained,
            value.note,
            value.detail,
            value.target,
          ]),
      );
      const nextMarks = JSON.stringify(
        state.items.map((item) => [item.id, item.kind, item.anchor]),
      );
      overlay.set(state.feedback);
      const annotationsChanged = nextAnnotations !== annotationSignature;
      annotationSignature = nextAnnotations;
      if (nextMarks !== markSignature) {
        markSignature = nextMarks;
        painter.set(state.items);
        if (mounted) {
          painter.paint();
          reader.renderSelection?.();
          // Only textures change. Source pagination/reflow is unchanged.
          reader.pages?.invalidatePaint?.();
        }
      }
      events.dispatchEvent(new Event("state"));
      if (mounted) {
        reader.emit("collections-change", {
          state,
          ...(error ? { error } : {}),
        });
        if (annotationsChanged)
          reader.emit("annotations-change", {
            initial,
            feedback: state.feedback,
          });
      }
      initial = false;
    };
    const unavailable = (error) => {
      if (scope.signal.aborted) return;
      controller.loaded = false;
      controller.error = error;
      // Carry the exact fallback used to measure a neighboring packet through
      // handoff. A fresh prepaint request could disagree with its page index.
      // This is client-only failure metadata; successful seeds stay raw API data.
      reader.collectionsSeed = {
        ...state,
        collectionsUnavailable: {
          doc_id: reader.doc.id,
          version: reader.doc.version,
          message: error.message,
        },
      };
      events.dispatchEvent(new Event("state"));
      if (mounted) reader.emit("collections-change", { state, error });
    };
    const controller = {
      events,
      loaded: false,
      loading: false,
      error: null,
      scope,
      get state() {
        return state;
      },
      paint(root) {
        if (!scope.signal.aborted) painter.paint(root);
      },
      applyAnnotations(baseblocks = reader.doc.blocks) {
        return overlay.apply(baseblocks);
      },
      async reload() {
        if (scope.signal.aborted) return;
        const current = ++generation,
          docId = reader.doc.id,
          version = reader.doc.version;
        requestScope?.dispose();
        const request = (requestScope = childScope(scope));
        const read = prefetch || startStateRead(store, docId, request);
        prefetch = null;
        request.cleanup(() => read.scope.dispose());
        controller.loading = true;
        events.dispatchEvent(new Event("state"));
        try {
          const result = await read.result;
          if (
            scope.signal.aborted ||
            request.signal.aborted ||
            current !== generation
          )
            return;
          if (!read.isCurrent())
            throw new DOMException(
              "Collection preparation cancelled",
              "AbortError",
            );
          if (result.error) throw result.error;
          if (reader.doc.id !== docId || reader.doc.version !== version)
            throw new Error("原文版本已变化，请重新加载收藏记录");
          // A word-card retry can finish between first draw and the read hook.
          // No mounted reflow listener contract exists here yet: keep the
          // indexed fallback and let the user retry once UI mounting finishes.
          if (beforeLayout && !mounted && reader.pages)
            throw new Error("阅读准备尚未结束，请稍后重试收藏记录");
          publish(result.payload);
        } catch (error) {
          if (
            scope.signal.aborted ||
            request.signal.aborted ||
            current !== generation
          )
            return;
          unavailable(
            error.name === "AbortError"
              ? new Error("收藏记录加载已取消，请重试")
              : error,
          );
          // Body reading is never blocked by an optional record failure.
        } finally {
          request.dispose();
          if (current === generation) {
            requestScope = null;
            controller.loading = false;
            if (!scope.signal.aborted) events.dispatchEvent(new Event("state"));
          }
        }
      },
      mount() {
        if (mounted || scope.signal.aborted) return false;
        mounted = true;
        scope.on(store.events, "change", (event) => {
          const path = event.detail.path;
          if (["/resurface", "/export"].includes(path)) return;
          if (
            path === "" ||
            path.includes("?revision=") ||
            ["/undo", "/import", "/cleanup"].includes(path)
          ) {
            // A book list can remove a record in an already warmed neighbor.
            // Discard only bounded neighboring page packets, so handoff never
            // reuses their old seed. This is not a source redraw/reflow.
            reader.pages?.invalidatePaint?.();
            reader.pages?.clearRanges?.();
            reader.pages?.warmRanges?.();
          }
          void controller.reload();
        });
        scope.cleanup(() => {
          painter.clear();
          if (reader.collectionsController === controller)
            delete reader.collectionsController;
          if (!reader.scope.signal.aborted) {
            reader.emit("annotations-change", { initial: false, feedback: [] });
            reader.pages?.invalidatePaint?.();
          }
        });
        return true;
      },
    };
    reader.collectionsController = controller;
    controllers.add(controller);
    scope.cleanup(() => {
      controllers.delete(controller);
      requestScope?.dispose();
      prefetch?.scope.dispose();
    });
    const seed = reader.collectionsSeed;
    if (seed) {
      prefetch?.scope.dispose();
      prefetch = null;
      try {
        const failure = seed.collectionsUnavailable;
        if (
          failure &&
          (failure.doc_id !== reader.doc.id ||
            failure.version !== reader.doc.version)
        )
          throw new Error("准备的收藏记录与当前原文不一致，请重新加载");
        publish(seed, failure ? new Error(failure.message) : null);
      } catch (error) {
        unavailable(error);
      }
      controller.ready = Promise.resolve();
    } else controller.ready = controller.reload();
    return controller;
  }

  const prepareDocument = ctx.hook("prepare-document", (preparation) => {
    const docId = preparation.docId;
    if (
      !Number.isSafeInteger(docId) ||
      docId <= 0 ||
      preparation.scope?.signal?.aborted
    )
      return;
    if (
      preparation.collectionsPrefetch?.docId === docId &&
      preparation.collectionsPrefetch.isCurrent()
    )
      return;
    preparation.collectionsPrefetch?.scope.dispose();
    preparation.collectionsPrefetch = startStateRead(
      store,
      docId,
      preparation.scope,
    );
    // Deliberately return undefined: document/plugins/profile fetch in parallel.
  });

  const prepare = ctx.hook("prepare-reading", async (reader) => {
    const controller = reader.collectionsController || createController(reader);
    await controller.ready;
  });

  const read = ctx.hook("read", async (reader) => {
    const prepared = Boolean(reader.collectionsController),
      controller = reader.collectionsController || createController(reader);
    const scope = childScope(store.scope, reader.scope);
    await controller.ready;
    if (!controller.mount()) {
      scope.dispose();
      return;
    }
    if (scope.signal.aborted) return;
    if (controller.error)
      toast(
        `收藏划线与反馈暂不可用：${controller.error.message}。正文可继续阅读。`,
        {
          label: "重试",
          run: async () => {
            await controller.reload();
            if (!scope.signal.aborted)
              toast(
                controller.error
                  ? `${controller.error.message}；可从收藏面板重试`
                  : "正文收藏记录已加载",
              );
          },
        },
      );
    // A legacy host without prepare-reading needs one initial contextual
    // layout. Current hosts already apply the overlay before their first draw.
    if (
      !prepared &&
      controller.state.feedback.some(
        (value) => value.retained || value.understood === true,
      )
    )
      reader.emit("annotations-change", {
        initial: true,
        feedback: controller.state.feedback,
      });
    const id = "collections-highlight";
    let writing = false;
    const matching = (anchor) =>
      controller.state.items.find(
        (item) => item.kind === "excerpt" && sameSelection(item.anchor, anchor),
      );
    const updateAction = () => {
      if (scope.signal.aborted) return;
      const saved = matching(reader.selection),
        action = reader.selectionActions.get(id);
      const label = saved ? "删除划线" : "划线";
      if (action) action.label = label;
      const button = document.querySelector(`[data-selection-action="${id}"]`);
      if (button) {
        button.textContent = writing ? "保存中…" : label;
        button.disabled = writing || !controller.loaded;
        button.setAttribute("aria-pressed", String(Boolean(saved)));
        button.title = controller.error
          ? "收藏记录暂未加载，请从收藏面板重试"
          : saved
            ? "删除整条划线；独立词语收藏和笔记保留"
            : "保存选区；与重叠划线合并";
      }
    };
    reader.selectionAction(id, "划线", async (anchor) => {
      if (writing || !controller.loaded || !anchor || anchor.kind === "image")
        return;
      const saved = matching(anchor);
      writing = true;
      updateAction();
      try {
        const result = saved
          ? await store.remove(saved)
          : await store.write("", {
              doc_id: reader.doc.id,
              kind: "excerpt",
              anchor,
            });
        await controller.reload();
        if (
          !scope.signal.aborted &&
          !saved &&
          sameSelection(reader.selection, anchor) &&
          result.item?.anchor
        ) {
          // Adopt the server union verbatim. Never infer it from DOM text or
          // erase a subrange when the user selects only part of a saved quote.
          getSelection()?.removeAllRanges();
          reader.choose(result.item.anchor);
        }
        store.undo(
          result,
          saved
            ? "已删除整条划线；独立词语收藏和笔记仍保留"
            : result.merged_ids?.length
              ? "已合并重叠划线"
              : "已保存划线",
        );
      } catch (error) {
        if (!scope.signal.aborted) toast(error.message);
      } finally {
        writing = false;
        updateAction();
      }
    });
    const bookId = reader.doc.chapter?.book_id ?? reader.doc.pdf?.book_id;
    const tool = reader.tool(
      "collections",
      bookId ? "本书收藏" : "本篇收藏",
      () =>
        reader.panel(
          "collections",
          bookId ? "本书收藏" : "本篇收藏",
          "<div data-collections-panel></div>",
          (el, panelScope) => {
            const root = $("[data-collections-panel]", el);
            const notice = document.createElement("div"),
              status = document.createElement("p"),
              button = document.createElement("button");
            status.className = "collections-status";
            status.setAttribute("role", "status");
            button.type = "button";
            button.textContent = "重新加载正文划线与反馈";
            notice.append(status, button);
            el.prepend(notice);
            const renderAvailability = () => {
              if (panelScope.signal.aborted) return;
              notice.hidden = !controller.error && !controller.loading;
              status.textContent = controller.loading
                ? "正在加载正文划线与反馈…"
                : controller.error
                  ? `正文收藏记录暂不可用：${controller.error.message}。正文可继续阅读。`
                  : "";
              button.hidden = !controller.error;
              button.disabled = controller.loading;
            };
            panelScope.on(controller.events, "state", renderAvailability);
            panelScope.on(button, "click", () => void controller.reload());
            renderAvailability();
            mountCollectionsList(ctx, store, root, panelScope, {
              bookId,
              docId: bookId ? null : reader.doc.id,
              title: bookId ? "本书收藏" : "本篇收藏",
            });
          },
        ),
    );
    reader.on("selection-render", updateAction);
    reader.on("draw", () => {
      if (!scope.signal.aborted) {
        controller.paint();
        updateAction();
      }
    });
    scope.on(controller.events, "state", updateAction);
    scope.cleanup(() => {
      tool.remove();
      reader.selectionActions.delete(id);
      if (!reader.scope.signal.aborted) {
        if (reader.panelId === "collections") reader.closePanel();
        reader.renderSelection();
      }
    });
    controller.paint();
    reader.renderSelection();
    updateAction();
  });
  const word = ctx.hook("word", (payload) =>
    mountCollectionWord(ctx, store, payload),
  );
  const route = ctx.route("collections", (owner) => {
    const scope = childScope(store.scope, owner);
    ctx.root.innerHTML =
      '<div class="page collections-page"><div data-global-resurface></div><section data-global-collections></section></div>';
    mountResurface(ctx, store, $("[data-global-resurface]", ctx.root), scope);
    mountCollectionsList(
      ctx,
      store,
      $("[data-global-collections]", ctx.root),
      scope,
    );
  });
  const home = ctx.hook("home", (view) => {
    const scope = childScope(store.scope, view.scope);
    let root;
    const mount = () => {
      if (scope.signal.aborted || root?.isConnected) return;
      const shelf = $("#article-grid", ctx.root);
      if (!shelf) return;
      root = document.createElement("section");
      root.dataset.collectionsResurface = "";
      shelf.after(root);
      mountResurface(ctx, store, root, scope);
    };
    view.mountCollectionsResurface = mount;
    // The host calls this after rendering its existing shelf. No observer,
    // timeout, replacement cards or early recommendation request is needed.
    const unregister =
      typeof view.afterRender === "function" ? view.afterRender(mount) : null;
    scope.cleanup(() => {
      if (typeof unregister === "function") unregister();
      if (view.mountCollectionsResurface === mount)
        delete view.mountCollectionsResurface;
      root?.remove();
    });
  });
  return () => {
    prepareDocument();
    prepare();
    read();
    word();
    route();
    home();
    for (const controller of [...controllers]) controller.scope.dispose();
    store.dispose();
  };
}
