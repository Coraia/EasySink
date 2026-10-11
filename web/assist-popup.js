import { $, e, api } from "./core.js";
import { anchorSegments } from "./source-selection.js";
import { offerAISetup } from "./ai-setup-guard.js";

// Keep the server's bounded current-passage default for every preview/request.
// Removing the scope UI must never expand what is sent to the model.
const defaultContext = Object.freeze({ context_previous: false, context_next: false });

function attemptMessage(attempt) {
  if (attempt.state === "pending") return "正在解释，可稍后查看结果。";
  if (attempt.state === "unknown") return "暂时无法确认解释结果，不会自动重试。可稍后查看结果。";
  return attempt.http_status === 429 ? "解释服务额度不足或繁忙，不会自动重试。" :
    "这次未能取得可用解释，不会自动重试。";
}

function failureMessage(error) {
  if (error.code === "context_pending") return attemptMessage({ state: "pending" });
  if (!error.status || error.code === "context_unknown") return attemptMessage({ state: "unknown" });
  if ([400, 404, 410, 422].includes(error.status)) return "这处原文暂不可用，请重新打开词卡。";
  return attemptMessage({ state: "failed", http_status: error.status });
}

function sameSelection(value, anchor) {
  const a = anchorSegments(value.anchor), b = anchorSegments(anchor);
  return value.kind === "context" && value.anchor.version === anchor.version &&
    value.anchor.quote === anchor.quote && a.length === b.length &&
    a.every((part, i) => part.block_id === b[i].block_id && part.start === b[i].start && part.end === b[i].end);
}

function validLocalRecord(r, value, anchor) {
  const context = value.payload?.context;
  if (!sameSelection(value, anchor) || value.doc_id !== r.doc.id ||
      value.version !== r.doc.version || !context ||
      !["context-meaning-v7", "context-meaning-v9", "context-meaning-v22"].includes(context.protocol) ||
      context.requested_neighbors.previous !== defaultContext.context_previous ||
      context.requested_neighbors.next !== defaultContext.context_next) return false;
  const blocks = new Map(r.doc.blocks.map(block => [block.id, block]));
  return anchorSegments(anchor).every(part => blocks.get(part.block_id)?.text.slice(part.start, part.end) === part.quote) &&
    context.ranges.every(part => blocks.get(part.block_id)?.text.slice(part.start, part.end) === part.text);
}

export function installContextPopup(r, pop, anchor, scope) {
  const section = document.createElement("section");
  section.className = "word-context";
  section.innerHTML = `<h4>语境解释</h4>
    <div data-context-result class="context-result"></div>
    <button type="button" class="context-action" data-context-generate disabled>解释这里的意思</button>
    <button type="button" class="context-action" data-context-regenerate hidden>重新解释</button>
    <p class="meta" data-context-fee hidden>重新解释可能再次计费；已有解释仍保留。</p>
    <p role="status" aria-live="polite" data-context-status>正在读取解释…</p>
    <button type="button" data-context-refresh hidden>重新查看已保存结果</button>
    <div data-context-history></div>`;
  pop.append(section);
  const generate = $("[data-context-generate]", section);
  const regenerate = $("[data-context-regenerate]", section);
  const result = $("[data-context-result]", section);
  const status = $("[data-context-status]", section);
  let plan = null, controller = null, previewSequence = 0, selectedRecord = null;
  pop.contextRecord = null;
  // The word hook runs before enhancePop. Subscribers can read this property
  // immediately or await the context-record event after a read-only preview.
  function expose(value) {
    selectedRecord = value;
    pop.contextRecord = value;
    r.contextRecord = value;
    r.contextRecordAnchor = anchor;
    r.emit("context-record", { pop, anchor, record: value });
  }
  function remember(value) {
    const index = r.assists.findIndex(item => item.id === value.id);
    if (index < 0) r.assists.push(value);
    else r.assists[index] = value;
  }
  function show(value, historical = false) {
    expose(value);
    result.innerHTML = value ? `<p class="meta">${historical ? "此前保存的解释" : "已保存的语境解释"} · ${e(value.source)}</p>
      <p>${e(value.payload.meaning)}</p><p>${e(value.payload.explanation)}</p>` : "";
  }
  function buttons() {
    const busy = Boolean(controller);
    const guarded = plan?.attempt && plan.attempt.state !== "succeeded";
    generate.hidden = !busy && Boolean(selectedRecord || guarded);
    generate.disabled = !busy && !plan;
    generate.textContent = busy ? "取消解释" : "解释这里的意思";
    regenerate.hidden = busy || (!selectedRecord && !guarded);
    regenerate.disabled = !plan || plan.attempt?.state === "pending";
    $("[data-context-refresh]", section).hidden = busy || Boolean(plan && !guarded);
    $("[data-context-fee]", section).hidden = regenerate.hidden;
  }
  async function preview({ preserveStatus = false } = {}) {
    const sequence = ++previewSequence;
    plan = null;
    buttons();
    try {
      const value = await api(`/documents/${r.doc.id}/context/preview`, {
        method: "POST", body: { anchor, ...defaultContext }, signal: scope.signal,
      });
      if (scope.signal.aborted || sequence !== previewSequence) return;
      plan = value;
      for (const item of value.history) remember(item);
      const saved = value.cached || value.history[0] || null;
      show(saved, Boolean(saved && !value.cached));
      $("[data-context-history]", section).innerHTML = value.history.length > 1 ?
        `<details><summary>解释历史（${value.history.length}${value.history.length === 20 ? " 条最近记录" : " 条"}）</summary>${value.history.map(item =>
          `<article data-context-history-id="${item.id}"><p class="meta">${e(item.source)} · ${e(item.created_at)}</p><p>${e(item.payload.meaning)}</p>
          <p>${e(item.payload.explanation)}</p></article>`).join("")}</details>` : "";
      if (!preserveStatus) status.textContent = value.attempt && value.attempt.state !== "succeeded" ?
        attemptMessage(value.attempt) : "";
    } catch (err) {
      if (err.name === "AbortError" || scope.signal.aborted || sequence !== previewSequence) return;
      // This only exposes already-loaded successful records whose exact source
      // still matches. A disconnected server is never a reason to retransmit.
      const saved = [...r.assists].reverse().find(item => validLocalRecord(r, item, anchor));
      // Without a server preview, preserve the record as history rather than
      // claiming that it matches the currently deployed generation protocol.
      show(saved || null, true);
      if (!preserveStatus) status.textContent = saved ? "连接暂不可用，先显示已保存的解释。" :
        [400, 404, 409, 410, 422].includes(err.status) ? "这处原文暂不可用，请重新打开词卡。" :
        "暂时无法读取解释，请稍后查看。";
    } finally {
      if (!scope.signal.aborted && sequence === previewSequence) buttons();
    }
  }
  async function explain(regenerateRequest) {
    if (controller) {
      const current = controller;
      controller = null;
      current.cancel();
      status.textContent = "已取消等待。解释可能已经完成，不会自动重试。";
      // The server may still be finishing cancellation. Only a read-only refresh
      // is allowed; it can report pending/unknown without triggering a model.
      await preview({ preserveStatus: true });
      return;
    }
    if (!plan) return;
    const current = r.assistController();
    controller = current;
    status.textContent = "正在解释…";
    buttons();
    try {
      const value = await api(`/documents/${r.doc.id}/context`, {
        method: "POST", body: { anchor, ...defaultContext, regenerate: regenerateRequest, request_id: current.requestId },
        signal: current.signal,
      });
      if (scope.signal.aborted || controller !== current) return;
      remember(value);
      show(value);
      status.textContent = value.cached ? "已显示保存的解释。" : "已保留新解释；可在收藏中预览后采用。";
      r.emit("assist-change");
      await preview({ preserveStatus: true });
    } catch (err) {
      if (err.name !== "AbortError" && !scope.signal.aborted &&
          offerAISetup(r, anchor, err, "context")) return;
      if (err.name !== "AbortError" && !scope.signal.aborted && controller === current) {
        status.textContent = failureMessage(err);
        await preview({ preserveStatus: true });
      }
    } finally {
      if (controller === current) controller = null;
      if (!scope.signal.aborted) buttons();
    }
  }
  scope.on(generate, "click", () => explain(false));
  scope.on(regenerate, "click", () => explain(true));
  scope.on($("[data-context-refresh]", section), "click", () => preview());
  scope.cleanup(() => {
    previewSequence++;
    controller?.cancel();
    pop.contextRecord = null;
    if (r.contextRecordAnchor === anchor) {
      r.contextRecord = null;
      r.contextRecordAnchor = null;
    }
  });
  preview();
}
