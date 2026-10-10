import { $, Scope, e } from "./core.js";

const css = new URL("./pdf-enhancement.css", import.meta.url).href;
if (!document.querySelector('link[data-pdf-enhancement-style]')) {
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = css; link.dataset.pdfEnhancementStyle = "true";
  document.head.append(link);
}
const label = { queued: "等待处理", running: "正在识别", completed: "识别结果已保存",
  unknown: "结果未确认", failed: "本次未完成", cancelled: "已取消后续处理" };
const endpoint = "/api/pdf/enhancement";
const errors = {
  pdf_call_limit: "已达到请求上限；已有结果和本地重放仍可使用",
  connection_test_failed: "未能连接所选模型；请检查服务地址、模型和密钥，配置尚未保存",
  invalid_endpoint: "请输入不含密钥或查询参数的 HTTP(S) 服务地址",
  key_destination_changed: "服务地址已改变，请填写这个服务的密钥",
  vision_configuration_required: "请填写服务地址、图像模型，并勾选支持图片输入",
  vision_service_disabled: "请先启用图像识别服务",
  processing_disabled: "请先启用 PDF 处理",
  book_recycled: "请先从回收站恢复这本书",
  enhancement_queue_busy: "正在处理其他原图，请稍后再试",
  request_inflight: "本次请求仍在处理中，请等待或取消后续处理",
  replay_unavailable: "当前结果无法本地重放；没有重新调用服务",
  replay_invalid: "保留的结果仍无法解析；没有重新调用服务",
  source_render_failed: "所选原图暂时无法读取，请重新选择页面或区域",
  invalid_region: "请在原页内重新框选一个区域",
  invalid_page: "请选择有效的 PDF 原页",
  service_changed: "服务配置已改变，请重新打开面板后操作",
  configuration_changed: "配置已变化，请重新打开面板检查",
};
const failureMessage = (error) => errors[error?.code] || "本次处理暂未完成；已有阅读内容和处理记录保留。";
async function request(url, method = "GET", body, signal) {
  const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(failureMessage(result?.detail));
  return result;
}

export function mountPDFEnhancement(host, owner, { book, page, region = null, onClose }) {
  const scope = new Scope();
  owner.cleanup(() => scope.dispose());
  let config = null, selected = null, busy = false, intent = null, dirty = false, polling = false;
  // Keep a regeneration's identity until its receipt is known, including a lost response.
  const pendingActions = new Map();
  const publicationPolls = new Map();
  const base = `/api/pdf/books/${encodeURIComponent(book)}/enhancements`;
  const description = `PDF 原页 ${page}${region ? " · 框选区域" : " · 本页"}`;
  host.innerHTML = `<div class="row between"><h3>局部识别增强</h3><button type="button" class="text-button" data-enhance-close>收起</button></div>
    <p class="meta">${e(description)}。只发送这里选定的原图，不包含其他页面。</p>
    <p data-enhance-service class="meta">正在读取服务状态…</p>
    <details data-enhance-settings><summary>识别服务设置</summary><form data-enhance-config>
      <div class="enhance-fields"><label>服务地址<input name="endpoint" type="url" placeholder="https://example.com/v1" autocomplete="off" required></label>
      <label>图像模型<input name="model" autocomplete="off" required></label>
      <label>API Key<input name="api_key" type="password" autocomplete="new-password" placeholder="不回显已保存的密钥"></label>
      <label>累计请求上限（可留空）<input name="max_calls" type="number" min="0" step="1" placeholder="不限"></label></div>
      <label class="enhance-check"><input name="vision_capable" type="checkbox" required>此模型支持图片输入</label>
      <div class="row wrap"><button type="submit">检查连接并保存</button><button type="button" data-enhance-disable>停用服务</button></div>
      <p class="meta">连接检查不发送文档；只有点击识别才发送所选原图。费用由你的服务计收。</p>
    </form></details>
    <div class="row wrap"><button type="button" class="primary" data-enhance-submit disabled>识别${region ? "所选区域" : "本页"}</button><button type="button" data-enhance-refresh>查看处理记录</button></div>
    <p role="status" data-enhance-message></p><div data-enhance-result></div><div data-enhance-history></div>`;
  const form = $("[data-enhance-config]", host), status = $("[data-enhance-message]", host);
  const submit = $("[data-enhance-submit]", host);
  const say = (message, error = false) => { status.textContent = message; status.classList.toggle("enhance-error", error); };
  const updateService = () => {
    $("[data-enhance-service]", host).textContent = config?.processing_enabled === false
      ? "PDF 处理已关闭；原件、已有结果和处理记录仍可查看。可在功能管理中重新开启。"
      : config?.available
      ? `${config.model} · ${config.endpoint}${config.max_calls == null ? "" : ` · 剩余 ${config.limits?.remaining ?? "—"} 次`}`
      : "尚未启用可用的图像识别服务。";
    submit.disabled = busy || !config?.available || dirty;
    host.querySelectorAll("[data-enhance-job-action]").forEach(button => {
      const action = button.dataset.enhanceJobAction;
      button.disabled = busy || (action !== "cancel" && config?.processing_enabled === false)
        || (action === "regenerate" && (dirty || !config?.available));
    });
  };
  const fillConfig = (value) => {
    config = value;
    for (const name of ["endpoint", "model", "max_calls"]) form.elements[name].value = value[name] ?? "";
    form.elements.vision_capable.checked = !!value.vision_capable;
    form.elements.api_key.value = "";
    form.elements.api_key.placeholder = value.has_api_key ? "已保存；留空保留" : "本机无密钥服务可留空";
    dirty = false; updateService();
    if (!value.available && value.processing_enabled !== false) $("[data-enhance-settings]", host).open = true;
  };
  const showJob = (job) => {
    if (selected?.id === job.id && selected.cache_reused) job = { ...job, cache_reused: true };
    selected = job;
    const output = $("[data-enhance-result]", host);
    const receiptKey = JSON.stringify(job);
    // An unchanged poll must not collapse expanded text or remove a focused button.
    if (output.dataset.receiptKey === receiptKey) return;
    output.dataset.receiptKey = receiptKey;
    const published = job.publication === "applied" ? "已更新阅读版，返回阅读后在安全时机显示。"
      : job.publication === "stale" ? "原处理范围已变化；结果保留，未改动阅读版。"
      : job.status === "completed" ? "结果已保留，阅读版尚未更新；原内容仍可阅读。" : "";
    const counted = job.actual_called === "no" ? "未发出模型请求" : job.actual_called === "possible"
      ? "请求可能已被服务处理；费用未知，不会自动重发" : `服务已返回 · 用量 ${job.usage?.total_tokens == null ? "未知" : `${job.usage.total_tokens} tokens`} · 费用未知`;
    output.innerHTML = `<section class="enhance-receipt"><strong>${e(label[job.status] || job.status)}${job.cache_reused ? " · 已复用缓存" : ""}${job.local_replay ? " · 本地重放" : ""}</strong>
      <p class="meta">${e(published || (job.status === "unknown" ? "服务是否已完成尚未确认；不会自动重发，也不会释放本次已占用的额度。" : job.error ? failureMessage(job.error) : "关闭面板不影响任务；可在处理记录中查看。"))}</p>
      <p class="meta">${e(counted)}</p>${job.result?.text ? `<details><summary>查看识别文字</summary><div class="enhance-output">${e(job.result.text)}</div></details>` : ""}
      <div class="row wrap">${job.replay_available ? '<button type="button" data-enhance-job-action="replay">本地重放（不调用服务）</button>' : ""}
      ${["queued", "running"].includes(job.status) ? '<button type="button" data-enhance-job-action="cancel">取消后续处理</button>'
        : '<button type="button" data-enhance-job-action="regenerate">重新请求（可能计费）</button>'}</div></section>`;
    updateService();
  };
  const loadHistory = async () => {
    const data = await request(base, "GET", undefined, scope.signal);
    if (scope.signal.aborted) return;
    if (config) { config.limits = data.limits; updateService(); }
    const history = $("[data-enhance-history]", host);
    const historyHTML = data.jobs?.length
      ? `<details><summary>本书处理记录 · ${data.jobs.length}</summary>${data.jobs.map((job) => `<p><button type="button" class="text-button" data-enhance-job="${e(job.id)}">原页 ${e(job.scope.page_number)}${job.scope.region ? " 区域" : " 整页"} · ${e(label[job.status] || job.status)}${job.cache_reused ? " · 缓存" : ""}</button></p>`).join("")}</details>`
      : '<p class="meta">本书暂无局部处理记录。</p>';
    if (history.dataset.content !== historyHTML) {
      const wasOpen = history.querySelector("details")?.open;
      history.innerHTML = historyHTML;
      history.dataset.content = historyHTML;
      if (wasOpen && history.querySelector("details")) history.querySelector("details").open = true;
    }
    if (selected) {
      const fresh = data.jobs.find((job) => job.id === selected.id);
      // List receipts omit the retained result by design; keep the detail already loaded.
      if (fresh) {
        const detail = fresh.status === "completed" && !selected.result
          ? await request(`${base}/${encodeURIComponent(fresh.id)}`, "GET", undefined, scope.signal)
          : { ...fresh, result: fresh.result || selected.result };
        if (!scope.signal.aborted && selected?.id === fresh.id) showJob(detail);
      }
    }
  };
  scope.on($("[data-enhance-close]", host), "click", () => { scope.dispose(); host.replaceChildren(); onClose?.(); });
  scope.on(form, "input", () => { dirty = true; intent = null; updateService(); });
  scope.on(form, "submit", async (event) => {
    event.preventDefault(); if (busy) return;
    const draft = { endpoint: form.elements.endpoint.value.trim(), model: form.elements.model.value.trim(),
      vision_capable: form.elements.vision_capable.checked, enabled: true,
      max_calls: form.elements.max_calls.value === "" ? null : Number(form.elements.max_calls.value),
      ...(form.elements.api_key.value ? { api_key: form.elements.api_key.value } : {}) };
    busy = true; updateService(); say("正在检查连接；不发送文档…");
    const marker = JSON.stringify(draft);
    try {
      const result = await request(`${endpoint}/test`, "POST", draft, scope.signal);
      if (scope.signal.aborted) return;
      // Do not overwrite edits made while the request was running.
      const now = { endpoint: form.elements.endpoint.value.trim(), model: form.elements.model.value.trim(),
        vision_capable: form.elements.vision_capable.checked, enabled: true,
        max_calls: form.elements.max_calls.value === "" ? null : Number(form.elements.max_calls.value),
        ...(form.elements.api_key.value ? { api_key: form.elements.api_key.value } : {}) };
      config = result.config;
      if (JSON.stringify(now) === marker) { fillConfig(config); $("[data-enhance-settings]", host).open = false; }
      say(dirty ? "连接检查通过；你又修改了表单，请检查新配置后再识别。"
        : config.processing_enabled === false ? "服务配置已保存；PDF 处理仍关闭，未发送文档。"
        : "连接检查通过，已启用并保存。图片能力将在你主动识别时验证。");
    } catch (error) { if (!scope.signal.aborted) say(error.message, true); }
    finally { busy = false; if (!scope.signal.aborted) updateService(); }
  });
  scope.on($("[data-enhance-disable]", host), "click", async () => {
    if (busy) return;
    busy = true; updateService();
    try { fillConfig(await request(`${endpoint}/config`, "PUT", { enabled: false }, scope.signal)); say("服务已停用，已有结果与阅读内容保留。"); }
    catch (error) { if (!scope.signal.aborted) say(error.message, true); }
    finally { busy = false; if (!scope.signal.aborted) updateService(); }
  });
  scope.on(submit, "click", async () => {
    if (busy || dirty || !config?.available) return;
    intent ||= crypto.randomUUID();
    busy = true; updateService(); say("正在登记本次处理…");
    try {
      const job = await request(base, "POST", { page_number: page, region, service_id: config.service_id, intent_id: intent }, scope.signal);
      if (scope.signal.aborted) return;
      showJob(job); say("处理记录已保存，可以关闭面板继续阅读。"); await loadHistory();
    } catch (error) { if (!scope.signal.aborted) { say(`${error.message}。可查看处理记录；恢复本次状态不会新增处理意图。`, true); submit.textContent = "恢复本次状态"; } }
    finally { busy = false; if (!scope.signal.aborted) updateService(); }
  });
  scope.on($("[data-enhance-refresh]", host), "click", async () => {
    try {
      await loadHistory();
      if (scope.signal.aborted) return;
      const records = $("[data-enhance-history] details", host);
      if (records) records.open = true;
    } catch (error) { if (!scope.signal.aborted) say(error.message, true); }
  });
  scope.on(host, "click", async (event) => {
    const history = event.target.closest("[data-enhance-job]");
    const action = event.target.closest("[data-enhance-job-action]");
    if (busy || (!history && !action)) return;
    busy = true; updateService();
    try {
      if (history) showJob(await request(`${base}/${encodeURIComponent(history.dataset.enhanceJob)}`, "GET", undefined, scope.signal));
      else if (selected) {
        const name = action.dataset.enhanceJobAction;
        if (name !== "cancel" && config?.processing_enabled === false) throw new Error("PDF 处理已关闭；已有结果仍可查看。");
        if (name === "regenerate" && (dirty || !config?.available)) throw new Error("请先检查并保存可用的图像服务。");
        const actionKey = `${selected.id}:${name}:${config?.service_id || ""}`;
        if (name === "regenerate" && !pendingActions.has(actionKey)) pendingActions.set(actionKey, crypto.randomUUID());
        const receipt = await request(`${base}/${encodeURIComponent(selected.id)}/actions`, "POST", {
          action: name, ...(name === "regenerate" ? { intent_id: pendingActions.get(actionKey), service_id: config.service_id } : {}) }, scope.signal);
        pendingActions.delete(actionKey);
        if (scope.signal.aborted) return;
        showJob(receipt);
        await loadHistory();
      }
    } catch (error) { if (!scope.signal.aborted) say(error.message, true); }
    finally { busy = false; if (!scope.signal.aborted) updateService(); }
  });
  scope.interval(async () => {
    const waitingPublication = selected?.status === "completed" &&
      ["pending", "deferred"].includes(selected.publication) && (publicationPolls.get(selected.id) || 0) < 30;
    if (polling || busy || !selected || (!waitingPublication && !["queued", "running"].includes(selected.status))) return;
    polling = true;
    const polledId = selected.id;
    if (waitingPublication) publicationPolls.set(polledId, (publicationPolls.get(polledId) || 0) + 1);
    try { const job = await request(`${base}/${encodeURIComponent(polledId)}`, "GET", undefined, scope.signal); if (!scope.signal.aborted && !busy && selected?.id === polledId) { showJob(job); if (!["queued", "running"].includes(job.status)) await loadHistory(); } }
    catch (error) { if (!scope.signal.aborted) say("状态暂未刷新；不会自动重新请求模型。", true); }
    finally { polling = false; }
  }, 1200);
  Promise.all([request(`${endpoint}/config`, "GET", undefined, scope.signal), loadHistory()])
    .then(([value]) => { if (!scope.signal.aborted) fillConfig(value); })
    .catch((error) => { if (!scope.signal.aborted) say(error.message, true); });
  return scope;
}
