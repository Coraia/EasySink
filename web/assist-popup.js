import { $, e, api } from "./core.js";
import { anchorSegments } from "./source-selection.js";
import { offerAISetup } from "./ai-setup-guard.js";

const roles = { current: "当前原文段", previous: "前一段", next: "后一段" };

function contextHTML(context, source, title) {
  if (!context) return '<p class="meta">旧版记录未保存实际发送的上下文，不能据此确认当时的语境范围。</p>';
  return `<details class="assist-context-scope"><summary>${e(title)} · ${context.utf16_length}/6000${context.truncated ? " · 已截取" : ""}</summary>
    <p class="meta">长度按 UTF-16 计，包含段落之间的空行。${context.selection_context_truncated ? "选区较长，上下文仅含部分选区；单独发送的所选原文仍完整。" : ""}</p>
    <p>所选原文</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:12em;overflow:auto">${e(source)}</pre>
    <p>实际上下文${context.truncated ? "（已按上限截取）" : ""}</p>
    <pre data-context-text style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:16em;overflow:auto">${e(context.text)}</pre>
    <ul>${context.ranges.map(range => `<li data-context-block="${e(range.block_id)}">${e(roles[range.role])} · 字符 ${range.start}–${range.end}${range.truncated ? "（段落已截取）" : ""}</li>`).join("")}
      ${context.omitted.map(range => `<li>${e(roles[range.role])}：上下文已达上限，未包含。</li>`).join("")}</ul></details>`;
}

function sameSelection(value, anchor) {
  const a = anchorSegments(value.anchor), b = anchorSegments(anchor);
  return value.kind === "context" && value.anchor.version === anchor.version &&
    value.anchor.quote === anchor.quote && a.length === b.length &&
    a.every((part, i) => part.block_id === b[i].block_id && part.start === b[i].start && part.end === b[i].end);
}

function validLocalRecord(r, value, anchor, neighbors) {
  const context = value.payload?.context;
  if (!sameSelection(value, anchor) || value.doc_id !== r.doc.id ||
      value.version !== r.doc.version || !context || context.protocol !== "context-meaning-v7" ||
      context.requested_neighbors.previous !== neighbors.context_previous ||
      context.requested_neighbors.next !== neighbors.context_next) return false;
  const blocks = new Map(r.doc.blocks.map(block => [block.id, block]));
  return anchorSegments(anchor).every(part => blocks.get(part.block_id)?.text.slice(part.start, part.end) === part.quote) &&
    context.ranges.every(part => blocks.get(part.block_id)?.text.slice(part.start, part.end) === part.text);
}

export function installContextPopup(r, pop, anchor, scope) {
  const section = document.createElement("section");
  section.className = "word-context";
  section.innerHTML = `<h4>语境解释</h4>
    <div data-context-result class="context-result"></div>
    <div data-context-plan></div>
    <div class="context-neighbors"><label><input type="checkbox" data-context-previous disabled>需要前一段</label>
      <label><input type="checkbox" data-context-next disabled>需要后一段</label></div>
    <p class="meta" data-context-provider></p>
    <button type="button" class="context-action" data-context-generate disabled>解释这里的意思</button>
    <button type="button" class="context-action" data-context-regenerate hidden>重新解释 · 使用当前模型</button>
    <p class="meta" data-context-fee hidden>重新解释会发出新请求，可能再次计费；已有解释仍保留。</p>
    <p role="status" aria-live="polite" data-context-status>正在读取已有解释与原文范围…</p>
    <button type="button" data-context-refresh hidden>重新查看已保存结果</button>
    <div data-context-history></div>`;
  pop.append(section);
  const generate = $("[data-context-generate]", section);
  const regenerate = $("[data-context-regenerate]", section);
  const result = $("[data-context-result]", section);
  const status = $("[data-context-status]", section);
  const previous = $("[data-context-previous]", section);
  const next = $("[data-context-next]", section);
  const neighbors = () => ({ context_previous: previous.checked, context_next: next.checked });
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
    result.innerHTML = value ? `<p class="meta">${historical ? "此前上下文的已保存解释" : "已保存的语境解释"} · ${e(value.source)}</p>
      <p>${e(value.payload.meaning)}</p><p>${e(value.payload.explanation)}</p>
      ${contextHTML(value.payload.context, value.anchor.quote, "查看这条解释实际使用的上下文")}` : "";
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
    previous.disabled = busy || !plan?.context.available_neighbors.previous;
    next.disabled = busy || !plan?.context.available_neighbors.next;
  }
  async function preview({ preserveStatus = false } = {}) {
    const sequence = ++previewSequence;
    plan = null;
    buttons();
    try {
      const value = await api(`/documents/${r.doc.id}/context/preview`, {
        method: "POST", body: { anchor, ...neighbors() }, signal: scope.signal,
      });
      if (scope.signal.aborted || sequence !== previewSequence) return;
      plan = value;
      $("[data-context-plan]", section).innerHTML = contextHTML(value.context, value.source, "查看将使用的原文语境");
      $("[data-context-provider]", section).textContent = value.provider.available ?
        `新解释使用当前模型：${value.provider.model}` : "文本 AI 尚未启用；已有解释仍可查看。";
      for (const item of value.history) remember(item);
      const saved = value.cached || value.history[0] || null;
      show(saved, Boolean(saved && !value.cached));
      $("[data-context-history]", section).innerHTML = value.history.length > 1 ?
        `<details><summary>解释历史（${value.history.length}${value.history.length === 20 ? " 条最近记录" : " 条"}）</summary>${value.history.map(item =>
          `<article data-context-history-id="${item.id}"><p class="meta">${e(item.source)} · ${e(item.created_at)}</p><p>${e(item.payload.meaning)}</p>
          <p>${e(item.payload.explanation)}</p>${contextHTML(item.payload.context, item.anchor.quote, "查看历史上下文")}</article>`).join("")}</details>` : "";
      if (!preserveStatus) status.textContent = value.attempt && value.attempt.state !== "succeeded" ?
        value.attempt.error || "这处解释仍在处理中，可稍后重新打开查看；不会再发一次请求。" :
        value.cached ? "已读取保存的结果，没有请求模型。" : saved ? "保留此前解释。使用当前上下文需要明确重新解释。" :
        "默认只使用当前原文段；需要时可包含紧邻的前一段或后一段。";
    } catch (err) {
      if (err.name === "AbortError" || scope.signal.aborted || sequence !== previewSequence) return;
      // This only exposes already-loaded successful records whose exact source
      // still matches. A disconnected server is never a reason to retransmit.
      const saved = [...r.assists].reverse().find(item => validLocalRecord(r, item, anchor, neighbors()));
      show(saved || null);
      $("[data-context-plan]", section).textContent = "";
      status.textContent = saved ? "连接不可用，显示本次阅读已载入的有效解释。" : err.message;
    } finally {
      if (!scope.signal.aborted && sequence === previewSequence) buttons();
    }
  }
  async function explain(regenerateRequest) {
    if (controller) {
      const current = controller;
      controller = null;
      current.cancel();
      status.textContent = "已取消等待。服务可能已处理，不会自动重发；已有解释保留。";
      // The server may still be finishing cancellation. Only a read-only refresh
      // is allowed; it can report pending/unknown without triggering a model.
      await preview({ preserveStatus: true });
      return;
    }
    if (!plan) return;
    const current = r.assistController();
    controller = current;
    status.textContent = "正在结合显示的原文语境解释…";
    buttons();
    try {
      const value = await api(`/documents/${r.doc.id}/context`, {
        method: "POST", body: { anchor, ...neighbors(), regenerate: regenerateRequest, request_id: current.requestId },
        signal: current.signal,
      });
      if (scope.signal.aborted || controller !== current) return;
      remember(value);
      show(value);
      status.textContent = value.cached ? "已读取保存的结果，没有请求模型。" : "已保留新解释；可在收藏中预览后采用。";
      r.emit("assist-change");
      await preview({ preserveStatus: true });
    } catch (err) {
      if (err.name !== "AbortError" && !scope.signal.aborted &&
          offerAISetup(r, anchor, err, "context")) return;
      if (err.name !== "AbortError" && !scope.signal.aborted && controller === current) {
        status.textContent = err.message + (err.status ? "" : "。无法确认这次结果，不会自动重发。");
        await preview({ preserveStatus: true });
      }
    } finally {
      if (controller === current) controller = null;
      if (!scope.signal.aborted) buttons();
    }
  }
  scope.on(generate, "click", () => explain(false));
  scope.on(regenerate, "click", () => explain(true));
  scope.on(previous, "change", () => preview());
  scope.on(next, "change", () => preview());
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
