import { $, $$, e, api, local } from "./core.js";

export function installReadingTraces(r) {
  r.showTraces = () =>
    r.panel(
      "traces",
      "阅读痕迹",
      '<p class="muted">正在读取已保留的痕迹…</p>',
      async (el, scope) => {
        r.speech?.stop();
        const traces = await api(`/documents/${r.doc.id}/traces`, {
          signal: scope.signal,
        });
        if (scope.signal.aborted) return;
        const reviewId = traces.review_doc_id;
        const review = await api(`/documents/${reviewId}/review`, {
          signal: scope.signal,
        });
        if (scope.signal.aborted) return;
        const notes = r.ctx.enabled("notes") ? traces.notes : [],
          marks = r.ctx.enabled("bookmarks") ? traces.bookmarks : [];
        const entries = [
          ...notes.map((n) => ({
            key: -n.id,
            doc_id: n.doc_id,
            type: "笔记",
            text: n.body,
            anchor: n.anchor || { quote: n.quote },
          })),
          ...marks.map((n) => ({
            key: -1000000000 - n.id,
            doc_id: n.doc_id,
            type: "书签",
            text: n.label,
            anchor: n.anchor || { ratio: n.scroll_ratio },
          })),
          ...traces.assists.map((a) => ({
            key: a.id,
            doc_id: a.doc_id,
            type: {
              context: "查阅的词义",
              grammar: "语法分析",
              translation: "译文片段",
            }[a.kind] + (a.historical ? " · 旧引用保留" : ""),
            text:
              a.kind === "context"
                ? a.payload.meaning
                : a.kind === "grammar"
                  ? a.payload.summary
                  : a.payload.segments.map((v) => v.zh).join(""),
            anchor: a.anchor,
            assist: a,
          })),
        ];
        el.innerHTML = `<p class="muted">原始笔记、书签与主动查阅记录分别保留。AI 回顾只整理你勾选的痕迹。</p><div class="trace-entries">${entries.map((v) => `<div class="trace-entry"><label><input type="checkbox" data-trace="${v.key}" checked>${e(v.type)}</label><p>${e(v.text)}</p><blockquote>${e(v.anchor.quote || "")}</blockquote><button type="button" data-trace-jump="${v.key}" class="text-button">回到原文</button>${v.assist ? `<button type="button" data-trace-remove="${v.key}" class="text-button">移除</button>` : ""}</div>`).join("") || "<p>还没有痕迹。阅读时可以选句记笔记、添加书签或查阅解释。</p>"}</div><div class="row wrap gap"><button type="button" id="review-generate" ${entries.length ? "" : "disabled"}>AI 整理所选痕迹</button><a class="text-button" href="#/ai">AI 配置</a></div><p id="review-status" role="status"></p><section id="review-draft" ${review.body ? "" : "hidden"}><label for="review-body">回顾草稿 · 可编辑</label><textarea id="review-body" rows="6">${e(review.body)}</textarea><button type="button" id="review-confirm">确认保留</button></section>`;
        $("#review-status", el).textContent = review.body
          ? review.confirmed
            ? "回顾已确认保留"
            : "AI 回顾草稿，待你确认"
          : "";
        let controller;
        scope.on(el, "click", async (ev) => {
          const jump = ev.target.closest("[data-trace-jump]"),
            remove = ev.target.closest("[data-trace-remove]");
          if (jump) {
            const entry = entries.find(
              (v) => v.key === +jump.dataset.traceJump,
            );
            r.closePanel();
            if (entry.assist?.historical && entry.anchor.pdf_source) {
              if (entry.doc_id === r.doc.id) r.pdfTools?.openOriginal(entry.anchor.pdf_source);
              else r.ctx.jump(entry.doc_id, {...entry.anchor, pdf_historical: true});
              return;
            }
            if (entry.doc_id !== r.doc.id) {
              if (entry.assist?.kind === "translation")
                local.set(`translation-jump:${entry.doc_id}`, entry.assist.id);
              r.ctx.jump(entry.doc_id, entry.anchor);
            } else {
              r.restore(entry.anchor);
              if (entry.assist?.kind === "translation")
                r.showTranslation?.(entry.assist);
            }
          }
          if (remove) {
            remove.disabled = true;
            try {
              await api(
                `/documents/${entries.find((v) => v.key === +remove.dataset.traceRemove).doc_id}/assists/${remove.dataset.traceRemove}`,
                { method: "DELETE", signal: scope.signal },
              );
              r.assists = r.assists.filter(
                (a) => a.id !== +remove.dataset.traceRemove,
              );
              remove.closest(".trace-entry").remove();
              r.emit("draw");
            } catch (err) {
              if (err.name !== "AbortError") {
                r.status(err.message);
                remove.disabled = false;
              }
            }
          }
        });
        scope.on($("#review-generate", el), "click", async (ev) => {
          if (controller) {
            controller.cancel();
            controller = null;
            ev.target.textContent = "AI 整理所选痕迹";
            $("#review-status", el).textContent = "已取消整理";
            return;
          }
          controller = r.assistController(reviewId);
          const current = controller;
          ev.target.textContent = "取消整理";
          $("#review-status", el).textContent = "正在整理勾选的阅读痕迹…";
          try {
            const value = await api(`/documents/${reviewId}/review`, {
              method: "POST",
              body: {
                request_id: current.requestId,
                sources: $$("[data-trace]:checked", el).map(
                  (v) => +v.dataset.trace,
                ),
              },
              signal: current.signal,
            });
            if (scope.signal.aborted || controller !== current) return;
            $("#review-draft", el).hidden = false;
            $("#review-body", el).value = value.body;
            $("#review-status", el).textContent =
              "AI 回顾草稿，待你确认；原始痕迹未改动。";
          } catch (err) {
            if (err.name !== "AbortError" && !scope.signal.aborted)
              $("#review-status", el).textContent = err.message;
          } finally {
            if (controller === current) {
              controller = null;
              ev.target.textContent = "AI 整理所选痕迹";
            }
          }
        });
        scope.on($("#review-confirm", el), "click", async (ev) => {
          ev.target.disabled = true;
          try {
            await api(`/documents/${reviewId}/review`, {
              method: "POST",
              body: { confirm: true, body: $("#review-body", el).value },
              signal: scope.signal,
            });
            if (!scope.signal.aborted)
              $("#review-status", el).textContent = "回顾已确认保留";
          } catch (err) {
            if (err.name !== "AbortError" && !scope.signal.aborted)
              $("#review-status", el).textContent = err.message;
          } finally {
            ev.target.disabled = false;
          }
        });
        scope.cleanup(() => controller?.cancel());
      },
    );
  r.tool("traces", "阅读痕迹", r.showTraces);
}
