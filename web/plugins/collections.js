import { $, toast } from "../core.js";
import { sameSelection } from "../source-selection.js";
import { childScope, createCollectionsStore } from "../collections-store.js";
import {
  createMarkPainter,
  createAnnotationOverlay,
} from "../collections-marks.js";
import { mountCollectionsList, mountResurface } from "../collections-list.js";
import { mountCollectionWord } from "../collections-word.js";

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
      events = new EventTarget();
    const painter = createMarkPainter(reader),
      overlay = createAnnotationOverlay(reader);
    let state = { items: [], feedback: [] },
      generation = 0,
      requestScope,
      mounted = false,
      initial = true;
    let annotationSignature = "[]",
      markSignature = "[]";
    const publish = (payload) => {
      if (scope.signal.aborted) return;
      state = { items: payload.items || [], feedback: payload.feedback || [] };
      reader.collectionsSeed = payload;
      controller.loaded = true;
      controller.error = null;
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
        reader.emit("collections-change", { state });
        if (annotationsChanged)
          reader.emit("annotations-change", {
            initial,
            feedback: state.feedback,
          });
      }
      initial = false;
    };
    const controller = {
      events,
      loaded: false,
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
        const current = ++generation;
        requestScope?.dispose();
        requestScope = childScope(scope);
        try {
          const payload = await store.read(
            `/state/${encodeURIComponent(reader.doc.id)}`,
            requestScope,
          );
          if (scope.signal.aborted || current !== generation) return;
          publish(payload);
        } catch (error) {
          if (
            scope.signal.aborted ||
            current !== generation ||
            error.name === "AbortError"
          )
            return;
          controller.loaded = false;
          controller.error = error;
          events.dispatchEvent(new Event("state"));
          if (mounted) reader.emit("collections-change", { state, error });
          // Body reading is never blocked by an optional record failure.
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
    });
    controller.ready = reader.collectionsSeed
      ? Promise.resolve(publish(reader.collectionsSeed))
      : controller.reload();
    return controller;
  }

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
            if (controller.error) {
              const button = document.createElement("button");
              button.textContent = "重新加载正文划线与反馈";
              el.prepend(button);
              panelScope.on(button, "click", async () => {
                button.disabled = true;
                await controller.reload();
                button.disabled = false;
                button.textContent = controller.error
                  ? "加载失败，点击重试"
                  : "正文记录已加载";
              });
            }
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
    prepare();
    read();
    word();
    route();
    home();
    for (const controller of [...controllers]) controller.scope.dispose();
    store.dispose();
  };
}
