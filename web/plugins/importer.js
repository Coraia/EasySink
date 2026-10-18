import { $, api, e, Scope } from "../core.js";
import { pdfImportProgress, watchPDFImport } from "./pdf-import-progress.js";

function readingDocument(id) {
  if (typeof id !== "number" && typeof id !== "string") return null;
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const urlUUID = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const urlTerminal = new Set(["committed", "cancelled", "failed", "interrupted", "source_removed", "unavailable"]);
const urlStates = new Set([...urlTerminal, "unknown", "running", "not_found", "prepared"]);
const allowedHostsKey = "wr2:url-allowed-hosts:v1";

function allowedHosts() {
  const raw = localStorage.getItem(allowedHostsKey);
  if (raw === null) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some(host => typeof host !== "string" || !host || host.length > 253 || host !== host.toLowerCase()))
    throw new Error("个人允许网站记录损坏");
  return [...new Set(value)].sort();
}

function saveAllowedHosts(hosts) {
  const value = JSON.stringify([...new Set(hosts)].sort());
  localStorage.setItem(allowedHostsKey, value);
  if (localStorage.getItem(allowedHostsKey) !== value) throw new Error("个人允许网站无法可靠保存");
}

function urlDialog(ctx, dialog, scope, current) {
  const form = $("#paste-form", dialog);
  const input = $("#paste-text", dialog);
  const primary = $("#import-continue", dialog);
  const clear = $("#import-clear", dialog);
  const panel = $("#url-import-panel", dialog);
  const tools = $("#url-import-tools", dialog);
  const requestTools = $("#url-import-request-tools", dialog);
  const detectedTitle = $("#import-detected-title", dialog);
  const detectedCopy = $("#import-detected-copy", dialog);
  const textOptions = $("#import-text-options", dialog);
  const submit = $("#url-import-submit", dialog);
  const check = $("#url-import-check", dialog);
  const cancel = $("#url-import-cancel", dialog);
  const fresh = $("#url-import-new", dialog);
  const open = $("#url-import-open", dialog);
  const history = $("#url-import-history", dialog);
  const status = $("#url-import-state", dialog);
  const consentPanel = $("#url-import-consent", dialog);
  const consentHost = $("#url-import-consent-host", dialog);
  const allowOnce = $("#url-import-allow-once", dialog);
  const allowAlways = $("#url-import-allow-always", dialog);
  const decline = $("#url-import-decline", dialog);
  const allowedList = $("#url-import-allowed-hosts", dialog);
  const removeAllowed = $("#url-import-remove-host", dialog);
  let library = null, intent = null, pending = 0, failure = "", lastError = "", receipt = null;
  let consent = null;
  const durable = new Set();
  let selectionRequired = false;
  let savedCount = 0, allowedCount = 0;
  const isURLMode = () => form.dataset.importKind === "url";
  const renderTools = () => { tools.hidden = savedCount === 0 && allowedCount === 0; };
  const activeKey = () => `wr2:url-intent-active:${library}`;
  const select = (record) => {
    const value = JSON.stringify({ request_id: record?.request_id ?? null });
    localStorage.setItem(activeKey(), value);
    if (localStorage.getItem(activeKey()) !== value) throw new Error("活动请求无法可靠保存");
    selectionRequired = false;
  };
  const key = (record) => `wr2:url-intent:${record.library_id}:${record.request_id}`;
  const persist = (record) => {
    const value = JSON.stringify(record);
    localStorage.setItem(key(record), value);
    if (localStorage.getItem(key(record)) !== value) throw new Error("请求编号无法可靠保存");
    durable.add(record.request_id);
  };
  const readSaved = () => {
    const result = [];
    const prefix = `wr2:url-intent:${library}:`;
    if (localStorage.length > 10000) throw new Error("本机存储项目过多，URL 导入已暂停");
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name?.startsWith(prefix)) continue;
      const value = JSON.parse(localStorage.getItem(name));
      if (!value || value.library_id !== library || !urlUUID(value.request_id) || key(value) !== name ||
          typeof value.url !== "string" || !value.url || value.url.length > 4096 || !urlStates.has(value.state) ||
          (value.user_approved !== undefined && typeof value.user_approved !== "boolean") ||
          (value.allow_after_success !== undefined && typeof value.allow_after_success !== "boolean") ||
          (value.approved_host !== undefined && (typeof value.approved_host !== "string" || !value.approved_host)))
        throw new Error("已保存的 URL 请求损坏；保留原记录，暂停导入");
      result.push(value);
      durable.add(value.request_id);
    }
    return result;
  };
  const render = () => {
    if (!current()) return;
    const state = intent?.state;
    panel.hidden = !isURLMode();
    if (!isURLMode()) return;
    requestTools.hidden = !intent;
    textOptions.hidden = true;
    input.disabled = !library || !!failure || selectionRequired || !!intent || !!consent;
    submit.disabled = !library || !!failure || selectionRequired || pending || !!consent || (!!intent && !["prepared", "not_found"].includes(state));
    submit.textContent = state === "not_found" ? "同编号重新提交" : "导入 URL";
    check.disabled = !library || !!failure || !intent || pending;
    cancel.disabled = !library || !intent || !durable.has(intent.request_id) || urlTerminal.has(state);
    fresh.disabled = !library || !!failure || pending || (!!intent && !urlTerminal.has(state));
    open.disabled = !!failure || pending || state !== "committed" || !readingDocument(receipt?.doc_id);
    history.disabled = !!failure || pending;
    consentPanel.hidden = !consent;
    consentHost.textContent = consent?.host || "";
    allowOnce.disabled = allowAlways.disabled = decline.disabled = !consent || pending || !!failure;
    removeAllowed.disabled = !allowedList.value || pending || !!failure;
    const messages = {
      prepared: "请求编号已保存，尚未发送。", running: "正在导入；可核对状态或请求取消。",
      unknown: "结果待核对。保留原编号，仅查询，不自动重抓。",
      not_found: "当前未查到结果，不代表从未提交。可手动用同一编号重发，或请求取消。",
      committed: receipt?.reused ? "已复用原文章，已有阅读记录保留。" : "已独立保存，旧文章和记录保留。",
      cancelled: "取消已确认，未返回可阅读文章。", failed: receipt?.message || "导入失败；原记录保留，可明确开始新请求。",
      interrupted: "上次导入已中断，可明确开始新请求。", source_removed: "原文章已删除，不会自动复活。",
      unavailable: "原资料损坏或不可用，不会自动重抓或导航。",
    };
    const prompt = consent ? `网站 ${consent.host} 不在内置或个人允许列表，请选择本次许可。` : "";
    const message = failure || (library ? `${lastError ? lastError + "。" : ""}${prompt || messages[state] || "同一快照复用原文章；内容变化则另存，旧记录保留。"}${intent ? ` 请求编号：${intent.request_id}` : ""}` : "正在核对资料库身份…");
    status.textContent = message;
    detectedTitle.textContent = state === "committed" ? "网页已经保存" : consent ? "需要确认网站权限" : "已识别为网页链接";
    detectedCopy.textContent = message;
    const checksExisting = state === "running" || state === "unknown";
    primary.disabled = state === "committed" ? open.disabled : checksExisting ? check.disabled : submit.disabled;
    primary.textContent = state === "committed" ? "打开文章 →" : consent ? "等待选择" : checksExisting ? "核对导入状态" : "核对并导入";
    clear.disabled = pending || (!!intent && !urlTerminal.has(state));
  };
  const failStorage = (error) => { failure = `${error.message}；未启动新的 URL 导入。已有编号保留，请勿清除存储。`; render(); };
  const list = () => {
    const saved = readSaved();
    savedCount = saved.length;
    history.innerHTML = '<option value="">选择已保存请求</option>' + saved.map(item =>
      `<option value="${e(item.request_id)}">${e(item.state)} · ${e(item.url)}</option>`).join("");
    history.value = intent?.request_id || "";
    renderTools();
    return saved;
  };
  const listAllowed = () => {
    const hosts = allowedHosts();
    allowedCount = hosts.length;
    allowedList.innerHTML = '<option value="">选择个人允许的网站</option>' +
      hosts.map(host => `<option value="${e(host)}">${e(host)}</option>`).join("");
    removeAllowed.disabled = true;
    renderTools();
    return hosts;
  };
  const inspect = async (url) => {
    const response = await fetch("/api/import/url/policy", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal: scope.signal });
    const value = await response.json();
    if (!response.ok || typeof value.url !== "string" || typeof value.host !== "string" || typeof value.builtin !== "boolean")
      throw new Error("网址无法识别，请检查后重试");
    return value;
  };
  const request = async (record, action, keepalive = false) => {
    const path = action === "submit" ? "/api/import/url" :
      `/api/import/url/requests/${record.request_id}${action === "cancel" ? "/cancel" : ""}`;
    const options = { method: action === "status" ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-WR-Library-ID": record.library_id }, keepalive };
    if (action !== "status") {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(action === "submit" ? {
        request_id: record.request_id, url: record.url, user_approved: record.user_approved === true,
      } : {});
    }
    const response = await fetch(path, options);
    const value = await response.json();
    if (value.library_id !== record.library_id || value.code === "library_mismatch")
      throw new Error("资料库身份不匹配或无法确认；原请求保留，请切回原资料库核对");
    if (value.request_id !== record.request_id || !urlStates.has(value.state) || value.state === "prepared" ||
        (value.state === "committed" && (!response.ok || !readingDocument(value.doc_id))))
      throw new Error("结果无法确认，请保留编号并查询");
    return value;
  };
  const reconcile = async (action, keepalive = false) => {
    const record = intent;
    if (!record || !durable.has(record.request_id) || (failure && action !== "cancel")) return null;
    if (action !== "cancel" && pending) return null;
    pending++;
    lastError = "";
    render();
    try {
      const value = await request(record, action, keepalive);
      // A late running reply cannot erase a cancellation/commit already observed.
      if (!urlTerminal.has(record.state) || urlTerminal.has(value.state)) record.state = value.state;
      if (value.state === "committed" && record.allow_after_success && record.approved_host) {
        try {
          saveAllowedHosts([...allowedHosts(), record.approved_host]);
          record.allow_after_success = false;
          listAllowed();
        } catch (error) {
          lastError = `文章已导入，但个人允许网站未保存：${error.message}`;
        }
      }
      persist(record);
      if (intent === record) receipt = value;
      if (current()) list();
      return value;
    } catch (error) {
      if (!urlTerminal.has(record.state)) record.state = "unknown";
      try { persist(record); } catch (storageError) { failStorage(storageError); }
      if (intent === record) lastError = error.message;
      return null;
    } finally {
      pending--;
      render();
    }
  };
  const sendIntent = async () => {
    try {
      persist(intent);
      list();
    } catch (error) { failStorage(error); return; }
    // Persist uncertain BEFORE sending, so even a renderer crash only queries on reopen.
    intent.state = "unknown";
    try { persist(intent); } catch (error) { failStorage(error); return; }
    await reconcile("submit");
  };
  const startURL = async (policy, remember) => {
    try {
      const created = { library_id: library, request_id: crypto.randomUUID(), url: policy.url, state: "prepared",
        user_approved: !policy.builtin, allow_after_success: remember, ...(remember ? { approved_host: policy.host } : {}) };
      persist(created);
      select(created);
      intent = created;
      input.value = policy.url;
    } catch (error) { failStorage(error); return; }
    await sendIntent();
  };
  const detectURL = () => {
    const value = input.value.trim();
    const matches = /^https?:\/\/\S+$/i.test(value);
    if (matches) {
      form.dataset.importKind = "url";
      textOptions.hidden = true;
      panel.hidden = false;
      primary.hidden = false;
      render();
    } else if (isURLMode() && !intent && !consent) {
      form.dataset.importKind = value ? "text" : "";
      input.disabled = false;
      panel.hidden = true;
    }
  };
  scope.on(input, "input", detectURL);
  scope.on(form, "wr:import-clear", () => {
    if (intent && !urlTerminal.has(intent.state)) return;
    try { if (library) select(null); } catch (error) { failStorage(error); return; }
    intent = null;
    receipt = null;
    consent = null;
    lastError = "";
    selectionRequired = false;
    history.value = "";
    input.disabled = false;
    panel.hidden = true;
  });
  scope.on(primary, "click", (event) => {
    if (!isURLMode()) return;
    event.preventDefault();
    const state = intent?.state;
    if (state === "committed") open.click();
    else if (state === "running" || state === "unknown") check.click();
    else submit.click();
  });
  scope.on(submit, "click", async () => {
    if (submit.disabled) return;
    if (intent) { await sendIntent(); return; }
    const url = input.value.trim();
    if (!url || url.length > 4096 || !/^https?:\/\//i.test(url)) {
      status.textContent = "请输入一个公开 HTTP(S) 网页 URL。"; return;
    }
    pending++;
    lastError = "";
    render();
    let approved = null;
    try {
      const policy = await inspect(url);
      const personal = allowedHosts().includes(policy.host);
      if (policy.builtin || personal) {
        approved = policy;
      } else {
        consent = policy;
      }
    } catch (error) {
      lastError = error.name === "AbortError" ? "网址核对已取消" : error.message;
    } finally {
      pending--;
      render();
    }
    if (approved) await startURL(approved, false);
  });
  scope.on(allowOnce, "click", async () => {
    if (!consent || allowOnce.disabled) return;
    const policy = consent; consent = null; render(); await startURL(policy, false);
  });
  scope.on(allowAlways, "click", async () => {
    if (!consent || allowAlways.disabled) return;
    const policy = consent; consent = null; render(); await startURL(policy, true);
  });
  scope.on(decline, "click", () => {
    if (decline.disabled) return;
    consent = null; lastError = "已取消导入，未访问该网站"; render();
  });
  scope.on(check, "click", () => { if (!check.disabled) void reconcile("status"); });
  scope.on(cancel, "click", () => { if (!cancel.disabled) void reconcile("cancel"); });
  scope.on(fresh, "click", () => {
    if (fresh.disabled) return;
    try { select(null); } catch (error) { failStorage(error); return; }
    intent = null; receipt = null; consent = null; lastError = ""; input.value = ""; history.value = "";
    form.dataset.importKind = "";
    input.disabled = false;
    panel.hidden = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  scope.on(allowedList, "change", render);
  scope.on(removeAllowed, "click", () => {
    if (removeAllowed.disabled) return;
    try {
      saveAllowedHosts(allowedHosts().filter(host => host !== allowedList.value));
      listAllowed();
      lastError = "已移除个人允许网站";
    } catch (error) { lastError = error.message; }
    render();
  });
  scope.on(history, "change", () => {
    if (history.disabled) return;
    try {
      const selected = readSaved().find(item => item.request_id === history.value);
      if (!selected) return;
      select(selected);
      intent = selected; receipt = null; input.value = selected.url; form.dataset.importKind = "url"; panel.hidden = false; render(); void reconcile("status");
    } catch (error) { failStorage(error); }
  });
  scope.on(open, "click", async () => {
    if (open.disabled) return;
    const value = await reconcile("status");
    if (!current() || failure || value?.state !== "committed" || !readingDocument(value.doc_id)) return;
    ctx.refresh(); dialog.close(); ctx.navigate(`#/read/${readingDocument(value.doc_id)}`);
  });
  detectURL();
  render();
  void (async () => {
    try {
      const response = await fetch("/api/import/url/identity", { credentials: "same-origin", cache: "no-store", signal: scope.signal });
      const value = await response.json();
      if (!response.ok || !urlUUID(value.library_id)) throw new Error("资料库身份不可用");
      if (!current()) return;
      library = value.library_id;
      listAllowed();
      const saved = list();
      const active = localStorage.getItem(activeKey());
      if (active === null) {
        selectionRequired = saved.length > 0;
        if (selectionRequired) lastError = "请选择已保存请求或明确开始新请求；不猜测上次活动编号";
      } else {
        const selected = JSON.parse(active);
        if (!selected || (selected.request_id !== null && !urlUUID(selected.request_id)))
          throw new Error("活动请求记录损坏；请保留存储");
        intent = selected.request_id === null ? null : saved.find(item => item.request_id === selected.request_id);
        if (selected.request_id !== null && !intent) throw new Error("活动请求原记录缺失；请保留存储");
      }
      if (intent) {
        input.value = intent.url;
        history.value = intent.request_id;
        form.dataset.importKind = "url";
        panel.hidden = false;
      } else detectURL();
      render();
      if (intent) await reconcile("status");
    } catch (error) { if (current()) failStorage(error); }
  })();
  return () => {
    if (intent && !urlTerminal.has(intent.state)) void reconcile("cancel", true);
  };
}

export function install(ctx) {
  let active = true;
  let dialogScope = null;
  const unhook = ctx.hook("importDialog", (dialog) => {
    dialogScope?.dispose();
    const scope = (dialogScope = new Scope());
    let closeURL = () => {};
    scope.on(dialog, "close", () => { closeURL(); scope.dispose(); });
    $("#import-supported", dialog).textContent = "支持 PDF、EPUB、TXT、Markdown";
    $("#import-file-slot", dialog).innerHTML = '<label class="import-file-button">选择文件<input id="upload-file" type="file" accept=".pdf,application/pdf,.epub,.zip,.txt,.md,.markdown" aria-label="选择阅读文件"></label>';
    $("#import-extension", dialog).innerHTML =
      '<section id="url-import-panel" class="import-context-panel" aria-label="网页导入" hidden><div id="url-import-consent" class="notice" hidden><strong>此网站尚未加入允许列表：<span id="url-import-consent-host"></span></strong><p class="dialog-hint">只会尝试提取公开正文和必要图片。跨网站重定向会停止，请粘贴最终地址重新确认。</p><div class="row wrap"><button type="button" id="url-import-allow-once">仅导入这一次</button><button type="button" id="url-import-allow-always">始终允许这个网站</button><button type="button" id="url-import-decline">取消</button></div></div><button type="button" id="url-import-submit" hidden>导入 URL</button><p id="url-import-state" hidden role="status" aria-live="polite"></p><details id="url-import-request-tools" class="import-secondary-tools" hidden><summary>请求详情</summary><div class="row wrap"><button type="button" id="url-import-check">核对状态</button><button type="button" id="url-import-cancel">请求取消</button><button type="button" id="url-import-new">新请求</button><button type="button" id="url-import-open">打开文章 →</button></div></details></section>' +
      '<details id="url-import-tools" class="import-secondary-tools" hidden><summary>历史与网站权限</summary><label>本资料库的已保存请求<select id="url-import-history"></select></label><details><summary>我允许的网站</summary><div class="row wrap"><select id="url-import-allowed-hosts" aria-label="个人允许的网站"></select><button type="button" id="url-import-remove-host">移除</button></div></details><p class="dialog-hint">Wise Reader 不判断网站或内容是否安全，不携带登录信息，也不执行页面脚本。</p></details>' +
      '<section id="pdf-import-panel" class="import-context-panel" aria-label="PDF 处理方式" hidden><div class="row wrap"><label>PDF 处理位置 <select id="pdf-import-engine" aria-describedby="pdf-import-location"><option value="auto" selected>当前电脑（默认）</option><option value="mineru_source" disabled>当前电脑 · 公式与复杂排版（原式优先）（正在检查）</option><option value="omarchy" disabled>Omarchy · GPU OCR（正在检查）</option></select></label><button type="button" id="pdf-import-capabilities-retry" class="text-button">刷新状态</button></div><div id="pdf-import-service-status" class="notice" role="status" aria-live="polite">正在检查 PDF 处理服务…</div><p id="pdf-import-location" class="dialog-hint" role="status">此选项只影响 PDF。</p></section><div id="upload-state" role="status"></div>';
    const input = $("#upload-file", dialog);
    const engine = $("#pdf-import-engine", dialog);
    const locationHint = $("#pdf-import-location", dialog);
    const retryCapabilities = $("#pdf-import-capabilities-retry", dialog);
    const serviceStatus = $("#pdf-import-service-status", dialog);
    const form = $("#paste-form", dialog);
    const entry = $("#import-entry", dialog);
    const textInput = $("#paste-text", dialog);
    const textOptions = $("#import-text-options", dialog);
    const detectedTitle = $("#import-detected-title", dialog);
    const detectedCopy = $("#import-detected-copy", dialog);
    const primary = $("#import-continue", dialog);
    const pdfPanel = $("#pdf-import-panel", dialog);
    const urlPanel = $("#url-import-panel", dialog);
    const uploadState = $("#upload-state", dialog);
    let caps = null;
    let checkedAt = null;
    let checkError = "";
    let capabilityRequest = null;
    let checkingCapabilities = false;
    let refreshTimer = null;
    let stopProgress = () => {};
    const current = () =>
      active && !scope.signal.aborted && $("#upload-file", dialog) === input;
    closeURL = urlDialog(ctx, dialog, scope, current);
    const adapter = (id) => caps?.adapters?.find((item) => item?.id === id);
    const available = (id) => caps?.processing_enabled !== false && adapter(id)?.available === true &&
      (id !== "omarchy" || adapter(id)?.readiness?.state === "ready");
    const updateLocation = () => {
      if (!current()) return;
      const remote = engine.querySelector('[value="omarchy"]');
      const formula = engine.querySelector('[value="mineru_source"]');
      // Keep a selected unavailable location visible. Never silently switch the
      // file's processing location, and never disable the shared EPUB input.
      remote.disabled = !available("omarchy");
      remote.textContent = `Omarchy · GPU OCR${available("omarchy") ? "" : checkingCapabilities ? "（正在检查）" : "（暂不可用）"}`;
      formula.disabled = !available("mineru_source");
      formula.textContent = `当前电脑 · 公式与复杂排版（原式优先）${available("mineru_source") ? "" : checkingCapabilities ? "（正在检查）" : "（模型未准备）"}`;
      locationHint.textContent = engine.value === "omarchy"
        ? "在你的 Omarchy 上识别，无付费 API。选择 PDF 后将发送整份文件到该服务器。"
        : engine.value === "mineru_source"
          ? "当前电脑处理公式与复杂排版；公式保留高清原式，阅读时点击才识别公式。此模式比默认文字提取更慢。"
          : "此选项只影响 PDF。";
      retryCapabilities.disabled = checkingCapabilities || input.disabled;
      retryCapabilities.textContent = checkingCapabilities ? "检查中…" : "刷新状态";
      if (checkingCapabilities) {
        serviceStatus.innerHTML = '<div class="pdf-service-summary"><span class="pdf-service-icon" aria-hidden="true">…</span><strong>正在检查 PDF 处理能力…</strong></div>';
        return;
      }
      const disabled = caps?.processing_enabled === false;
      const local = disabled ? "PDF 处理已关闭" : available("digital")
        ? available("docling") ? "文字提取 / 扫描 OCR 已准备" : "文字提取可用；扫描 OCR 未准备，将保留原图"
        : checkError || adapter("digital")?.missing_reason || "本机 PDF 组件未准备好";
      const readiness = adapter("omarchy")?.readiness;
      const gpu = readiness?.gpu;
      const remoteDetail = disabled ? "PDF 处理已关闭" : available("omarchy")
        ? `专用 OCR 启动条件已就绪${Number.isFinite(gpu?.free_mib) ? ` · 空闲显存 ${(gpu.free_mib / 1024).toFixed(1)} GiB` : ""}`
        : checkError || adapter("omarchy")?.missing_reason || "尚未确认 Omarchy 是否可用";
      const formulaDetail = disabled ? "PDF 处理已关闭" : available("mineru_source")
        ? "可用 · 原式保留，公式按需识别"
        : checkError || adapter("mineru_source")?.missing_reason || "模型未准备，暂不可用";
      const stamp = checkedAt ? new Date(checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
      const detailWasOpen = serviceStatus.querySelector("details")?.open === true;
      let summary = "", summaryDetail = "", summaryReady = false;
      if (engine.value === "omarchy") {
        summaryReady = available("omarchy");
        summary = summaryReady ? "Omarchy 已就绪" : "Omarchy 未就绪，请改用当前电脑";
        summaryDetail = remoteDetail;
      } else if (engine.value === "mineru_source") {
        summaryReady = available("mineru_source");
        summary = summaryReady ? "复杂排版处理已就绪，公式将保留原式" : "复杂排版处理未准备，请改用默认模式";
        summaryDetail = formulaDetail;
      } else {
        summaryReady = available("digital");
        summary = disabled ? "PDF 处理已关闭"
          : summaryReady && available("docling") ? "当前电脑：文字提取与扫描 OCR 可用"
          : summaryReady ? "当前电脑：文字提取可用；扫描 PDF 将保留原图"
          : "当前电脑暂不能处理 PDF";
        summaryDetail = local;
      }
      serviceStatus.innerHTML = `<div class="pdf-service-summary" data-state="${summaryReady ? "ready" : "attention"}" tabindex="0" title="${e(summaryDetail)}" aria-label="${e(summary)}。${e(summaryDetail)}"><span class="pdf-service-icon" aria-hidden="true">${summaryReady ? "✓" : "!"}</span><strong>${e(summary)}</strong><span class="pdf-service-hover">悬浮查看原因</span></div><details class="pdf-service-details"><summary>诊断详情</summary><div class="pdf-service-detail-list"><div data-pdf-local-state="${available("digital") ? "ready" : "unavailable"}"><strong>当前电脑</strong> · ${e(local)}</div><div data-pdf-formula-state="${available("mineru_source") ? "ready" : "unavailable"}"><strong>复杂排版（原式优先）</strong> · ${e(formulaDetail)}</div><div data-pdf-remote-state="${e(readiness?.state || (available("omarchy") ? "ready" : "unknown"))}"><strong>Omarchy</strong> · ${e(remoteDetail)}</div><div class="dialog-hint">${stamp ? `${e(stamp)} 检查 · ` : ""}提交前会再次核验；EPUB / TXT / Markdown 不受影响。</div></div></details>`;
      const details = serviceStatus.querySelector("details");
      if (details) details.open = detailWasOpen;
      if (
        form.dataset.importKind === "pdf" &&
        input.files[0] &&
        input.dataset.confirmed !== "true"
      ) {
        const selected = engine.value === "auto" ? "digital" : engine.value;
        primary.hidden = false;
        primary.textContent = "导入 PDF";
        primary.disabled = checkingCapabilities || input.disabled || !available(selected);
      }
    };
    const loadCapabilities = () => {
      if (!current()) return Promise.resolve(null);
      if (capabilityRequest) return capabilityRequest;
      checkingCapabilities = true;
      updateLocation();
      capabilityRequest = (async () => {
        const request = new AbortController();
        const abort = () => request.abort();
        scope.signal.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, 10000);
        try {
          const next = await api(`/pdf/capabilities?check=${Date.now()}`, { signal: request.signal });
          if (!Array.isArray(next?.adapters)) throw new Error("服务状态响应不完整");
          if (current()) { caps = next; checkError = ""; checkedAt = Date.now(); }
          return next;
        } catch (error) {
          if (current()) {
            caps = null;
            checkError = request.signal.aborted ? "检查超时，请刷新状态后再试" : "暂时无法取得 PDF 服务状态，请刷新后再试";
            checkedAt = Date.now();
          }
          return null;
        } finally {
          clearTimeout(timeout);
          scope.signal.removeEventListener("abort", abort);
          checkingCapabilities = false;
          updateLocation();
        }
      })().finally(() => { capabilityRequest = null; });
      return capabilityRequest;
    };
    scope.on(engine, "change", updateLocation);
    scope.on(retryCapabilities, "click", () => void loadCapabilities());
    // A visible, idle dialog keeps its snapshot fresh without watching hidden
    // tabs or disturbing the independent persisted import-progress stream.
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer);
      if (!current()) return;
      refreshTimer = setTimeout(async () => {
        if (!document.hidden && !input.disabled && !pdfPanel.hidden) await loadCapabilities();
        scheduleRefresh();
      }, 20000);
    };
    scope.cleanup(() => clearTimeout(refreshTimer));
    scope.on(document, "visibilitychange", () => {
      if (!document.hidden && current() && !input.disabled && !pdfPanel.hidden) void loadCapabilities();
    });
    scheduleRefresh();
    scope.on(primary, "click", (event) => {
      if (form.dataset.importKind !== "pdf" || !input.files[0]) return;
      event.preventDefault();
      if (primary.disabled || input.dataset.confirmed === "true") return;
      input.dataset.confirmed = "true";
      void input.onchange();
    });
    input.onchange = async () => {
      if (!current() || input.disabled) return;
      const file = input.files[0];
      if (!file) return;
      const isPDF =
        /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      const el = uploadState;
      form.dataset.importKind = isPDF ? "pdf" : "file";
      textInput.value = "";
      textInput.disabled = true;
      textOptions.hidden = true;
      urlPanel.hidden = true;
      pdfPanel.hidden = !isPDF;
      detectedTitle.textContent = isPDF ? "已识别为 PDF" : "已识别为阅读文件";
      detectedCopy.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(file.size >= 1024 * 1024 ? 1 : 2)} MB`;
      stopProgress();
      const limit = (isPDF ? 256 : 20) * 1024 * 1024;
      if (file.size > limit) {
        el.innerHTML = `<div class="notice error">${isPDF ? "PDF 超过 256 MiB，请选择较小的文件。" : "文件超过 20 MB，请拆分后导入。"}</div>`;
        input.value = "";
        delete input.dataset.confirmed;
        textInput.disabled = false;
        primary.disabled = true;
        primary.hidden = false;
        primary.textContent = "继续";
        return;
      }
      if (isPDF && input.dataset.confirmed !== "true") {
        primary.hidden = false;
        primary.disabled = true;
        primary.textContent = "导入 PDF";
        el.innerHTML = '<div class="notice">请选择处理位置，确认后再导入。文件尚未上传。</div>';
        if (capabilityRequest) await capabilityRequest;
        await loadCapabilities();
        updateLocation();
        return;
      }
      primary.disabled = true;
      primary.textContent = "正在导入…";
      primary.hidden = true;
      const selectedEngine = engine.value;
      input.disabled = true;
      engine.disabled = true;
      retryCapabilities.disabled = true;
      if (isPDF) {
        el.innerHTML = '<div class="notice">正在再次检查 PDF 处理服务…</div>';
        // An earlier open-dialog request is not the fresh submission check.
        if (capabilityRequest) await capabilityRequest;
        const latest = await loadCapabilities();
        if (!current()) return;
        const selected = latest?.adapters?.find((item) => item?.id === (selectedEngine === "auto" ? "digital" : selectedEngine));
        if (!latest || latest.processing_enabled === false || selected?.available !== true) {
          const reason = latest?.processing_enabled === false ? "PDF 处理已关闭，请开启后再导入。"
            : checkError || selected?.missing_reason || "所选 PDF 处理服务尚未就绪。";
          el.innerHTML = `<div class="notice error">${e(reason)}<br>本次尚未上传。可刷新状态，或选择其他处理位置后重新选择文件。</div>`;
          input.disabled = false;
          engine.disabled = false;
          textInput.disabled = false;
          input.value = "";
          primary.textContent = "继续";
          updateLocation();
          return;
        }
      }
      el.innerHTML = `<div class="notice">${isPDF ? `正在接收 PDF 原件并登记书籍。${selectedEngine === "omarchy" ? "已选择在你的 Omarchy 上识别，无付费 API。" : "已选择在当前电脑处理。"}阅读版状态单独提供，可以关闭这里。` : "正在检查文件并整理章节，请稍候…"}</div>`;
      const body = new FormData();
      body.append("file", file);
      if (isPDF) body.append("engine", selectedEngine);
      try {
        // A dialog's lifetime controls its UI, not the persistent import.
        const result = await api(isPDF ? "/pdf/imports" : "/import", {
          method: "POST",
          body,
        });
        // Import already persisted the book. Refresh independently of closing
        // the dialog or choosing Start Reading, without interrupting a reader.
        if (active && (!location.hash || /^#\/?$/.test(location.hash)))
          ctx.refresh();
        // The shared dialog may have been repurposed while the upload ran.
        if (!current()) return;
        let href;
        if (isPDF) {
          const bookId = result.book_id ?? result.pdf?.book_id;
          if (bookId === undefined || bookId === null || bookId === "")
            throw new Error("接收响应没有书籍身份，请刷新书架核对登记结果。");
          if (result.pdf?.lifecycle === "recycled") {
            el.innerHTML =
              '<div class="notice">这份 PDF 在回收站，原件、已有内容和记录仍保留。<p style="margin:12px 0 0"><button type="button" id="restore-import" class="primary">恢复书籍</button> <button type="button" id="open-pdf-recycle">查看回收站</button> <button type="button" id="close-import">关闭</button></p><p id="restore-import-state" role="status"></p></div>';
            scope.on($("#close-import", el), "click", () => dialog.close());
            scope.on($("#open-pdf-recycle", el), "click", () => {
              dialog.close();
              ctx.navigate("#/pdf-recycle");
            });
            scope.on($("#restore-import", el), "click", async (event) => {
              const button = event.currentTarget;
              if (button.disabled || !current()) return;
              button.disabled = true;
              button.textContent = "恢复中…";
              input.disabled = true;
              engine.disabled = true;
              retryCapabilities.disabled = true;
              try {
                const restored = await api(
                  `/pdf/books/${encodeURIComponent(bookId)}/lifecycle`,
                  { method: "POST", body: { action: "restore" } },
                );
                if (restored.pdf?.lifecycle === "recycled")
                  throw new Error("书籍仍在回收站，请刷新清单核对。");
                if (!current()) {
                  if (
                    active &&
                    (!location.hash || /^#\/?$/.test(location.hash))
                  )
                    ctx.refresh();
                  return;
                }
                dialog.close();
                ctx.navigate("#/");
              } catch (error) {
                if (current()) {
                  $("#restore-import-state", el).textContent =
                    `${error.message} 请刷新回收站核对实际状态。`;
                  button.disabled = false;
                  button.textContent = "恢复书籍";
                }
              } finally {
                if (current()) {
                  input.disabled = false;
                  engine.disabled = false;
                  retryCapabilities.disabled = false;
                }
              }
            });
            return;
          }
          el.innerHTML = `<div class="notice pdf-import-notice"><p class="pdf-import-saved">${result.reused ? "这份 PDF 已在书架，已复用同一书籍。" : "PDF 已保存在书架"}</p>${result.reused ? '<p class="dialog-hint">已保留原任务的处理位置；如需改用原式优先模式或 Omarchy，请在 PDF 处理中选择并启动。</p>' : ""}<div data-import-progress></div><div class="row wrap"><button type="button" id="open-import" class="primary">查看准备状态 →</button>${result.reused ? '<button type="button" id="manage-import">PDF 处理</button>' : ""}<button type="button" id="close-import">关闭，留在书架</button></div></div>`;
          scope.on($("#close-import", el), "click", () => dialog.close());
          scope.on($("#manage-import", el), "click", () => {
            dialog.close();
            ctx.navigate(`#/pdf-status/${encodeURIComponent(bookId)}`);
          });
          stopProgress = watchPDFImport(result, scope, (next, state) => {
            if (!current()) return;
            const docId = next.pdf?.lifecycle === "recycled" ? null : readingDocument(next.pdf?.reading_doc_id);
            href = docId ? `#/read/${docId}` : `#/pdf/${encodeURIComponent(bookId)}`;
            const progress = $("[data-import-progress]", el);
            const html = pdfImportProgress(next, state);
            if (progress.innerHTML !== html) progress.innerHTML = html;
            $("#open-import", el).textContent = docId ? "打开阅读版 →" : "查看准备状态 →";
          });
        } else {
          href = "#/read/" + (readingDocument(result.reading_doc_id) || result.chapters[0].doc_id);
          el.innerHTML = `<div class="notice">${result.reused ? "这本 EPUB 已在书架，已复用已有书籍。" : `已完整导入 ${result.chapters.length} 章。`}${e(result.notice || "")}<p style="margin:12px 0 0"><button type="button" id="open-import" class="primary">${result.reused ? "继续阅读" : "开始阅读"} →</button> <button type="button" id="close-import">关闭，留在书架</button></p></div>`;
          scope.on($("#close-import", el), "click", () => dialog.close());
        }
        $("#open-import", el).onclick = () => {
          if (!current()) return;
          dialog.close();
          ctx.navigate(href);
        };
      } catch (err) {
        if (current()) {
          const pdfMessages = {
            format_unreadable: "PDF 文件损坏、不完整或格式无法读取，尚未导入。请换一个可正常打开的原文件。",
            access_restricted: "PDF 需要密码，尚未导入。请先解锁文件后再导入。",
            validator_timeout: "读取 PDF 超时，尚未导入。可以重新选择文件再试。",
            validator_unavailable: "本机 PDF 读取组件暂不可用，尚未导入。请重新打开应用后再试。",
            space_insufficient: "本机可用空间不足，尚未导入。请释放空间后重试。",
            upload_too_large: "PDF 超过 256 MiB，请选择较小的文件。",
            page_limit: "PDF 超过 10,000 页，尚未导入。请拆分后再试。",
          };
          const message = isPDF && pdfMessages[err.code] || err.message;
          const uncertain = isPDF && !pdfMessages[err.code] && (!err.status || err.status >= 500);
          el.innerHTML = `<div class="notice error">${e(message)}${uncertain ? "<br>若接收响应中断，请先刷新书架核对已有书籍。" : ""}</div>`;
        }
      } finally {
        if (current()) {
          input.disabled = false;
          engine.disabled = false;
          retryCapabilities.disabled = false;
          textInput.disabled = false;
          input.value = "";
          delete input.dataset.confirmed;
        }
      }
    };
    scope.on(entry, "dragover", (event) => {
      if (!event.dataTransfer?.types?.includes("Files") || input.disabled) return;
      event.preventDefault();
      entry.classList.add("is-dragging");
    });
    scope.on(entry, "dragleave", () => entry.classList.remove("is-dragging"));
    scope.on(entry, "drop", (event) => {
      entry.classList.remove("is-dragging");
      if (!event.dataTransfer?.files?.length || input.disabled) return;
      event.preventDefault();
      input.files = event.dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    scope.on(textInput, "input", () => {
      if (form.dataset.importKind === "pdf" || form.dataset.importKind === "file") {
        form.dataset.importKind = textInput.value.trim() ? "text" : "";
        pdfPanel.hidden = true;
        uploadState.innerHTML = "";
        input.value = "";
        delete input.dataset.confirmed;
        primary.hidden = false;
      }
    });
    scope.on(form, "wr:import-clear", () => {
      stopProgress();
      input.value = "";
      delete input.dataset.confirmed;
      input.disabled = false;
      engine.disabled = false;
      textInput.disabled = false;
      pdfPanel.hidden = true;
      uploadState.innerHTML = "";
      primary.hidden = false;
    });
  });
  return () => {
    active = false;
    dialogScope?.dispose();
    unhook();
  };
}
