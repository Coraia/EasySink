export const $ = (q, root = document) => root.querySelector(q);
export const $$ = (q, root = document) => [...root.querySelectorAll(q)];
export const e = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let evidenceObserver = null;
export function setEvidenceObserver(observer) {
  evidenceObserver = observer;
  return () => { if (evidenceObserver === observer) evidenceObserver = null; };
}
export async function api(
  path,
  { method = "GET", body, signal, keepalive = false } = {},
) {
  const observer = evidenceObserver;
  let capture = null;
  try { capture = observer?.begin(path, method, body); } catch { /* optional */ }
  const options = { method, signal, credentials: "same-origin", keepalive };
  if (body !== undefined) {
    options.body = body instanceof FormData ? body : JSON.stringify(body);
    if (!(body instanceof FormData))
      options.headers = { "Content-Type": "application/json" };
  }
  if (capture) options.headers = {...options.headers,
    "X-WR-Evidence-Epoch": capture.epoch, "X-WR-Operation": capture.op, "X-WR-Session": capture.session};
  const finish = (payload, error) => { try { observer?.end(capture, payload, error); } catch { /* optional */ } };
  let r;
  try { r = await fetch("/api" + path, options); }
  catch (error) { finish(null, error); throw error; }
  let parseFailed = false;
  const payload = await r
    .json()
    .catch(() => { parseFailed = true; return { detail: "服务返回了无法识别的数据" }; });
  if (!r.ok) {
    const err = new Error(
      typeof payload.detail === "string"
        ? payload.detail
        : typeof payload.detail?.message === "string"
          ? payload.detail.message
          : "输入格式不正确，请检查后重试",
    );
    err.status = r.status;
    err.code = typeof payload.detail?.code === "string" ? payload.detail.code : null;
    finish(null, err);
    throw err;
  }
  finish(payload, parseFailed ? new Error("结果无法解析，采集状态未知") : null);
  return payload;
}
export class Scope {
  constructor() {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.cleanups = [];
  }
  on(el, event, fn, options = {}) {
    el?.addEventListener(event, fn, { ...options, signal: this.signal });
  }
  cleanup(fn) {
    this.cleanups.push(fn);
    return fn;
  }
  interval(fn, ms) {
    const id = setInterval(() => {
      if (!this.signal.aborted) fn();
    }, ms);
    this.cleanup(() => clearInterval(id));
    return id;
  }
  dispose() {
    this.controller.abort();
    for (const fn of this.cleanups.reverse())
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    this.cleanups = [];
  }
}
export const local = {
  get(key, fallback = null) {
    try {
      return JSON.parse(localStorage.getItem("wr2:" + key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("wr2:" + key, JSON.stringify(value));
      window.wiseReaderDesktop?.persistLocal?.(key, JSON.stringify(value));
      return true;
    } catch {
      toast("浏览器空间不足，草稿未能保存。请复制内容。");
      return false;
    }
  },
  remove(key) {
    localStorage.removeItem("wr2:" + key);
    window.wiseReaderDesktop?.persistLocal?.(key, null);
  },
};
let toastTimer;
export function toast(message, action) {
  const el = $("#toast");
  clearTimeout(toastTimer);
  el.replaceChildren(document.createTextNode(message));
  if (action) {
    const btn = document.createElement("button");
    btn.textContent = action.label;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await action.run();
        el.hidden = true;
      } catch (err) {
        el.firstChild.textContent = "操作失败，可重试：" + err.message;
        el.hidden = false;
        clearTimeout(toastTimer);
      } finally {
        btn.disabled = false;
      }
    };
    el.append(btn);
  }
  el.hidden = false;
  toastTimer = setTimeout(() => (el.hidden = true), action ? 10000 : 4500);
}
export function errorBox(err) {
  return `<div class="notice error" role="alert">${e(err.message || err)}</div>`;
}
export function date(value) {
  return value
    ? new Date(value).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      })
    : "";
}
export async function busy(button, fn, label = "保存中…") {
  if (button.disabled) return;
  const previous = button.textContent;
  const previousBusy = button.getAttribute("aria-busy");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = label;
  try {
    return await fn();
  } catch (err) {
    if (err.name !== "AbortError") toast(err.message);
    throw err;
  } finally {
    button.disabled = false;
    if (previousBusy === null) button.removeAttribute("aria-busy");
    else button.setAttribute("aria-busy", previousBusy);
    button.textContent = previous;
  }
}
export function openDialog(title, html, mount) {
  const d = $("#dialog");
  d.innerHTML = `<div class="dialog-head"><h2>${e(title)}</h2><button class="icon-button" aria-label="关闭">×</button></div>${html}`;
  $(".dialog-head button", d).onclick = () => d.close();
  d.showModal();
  mount?.(d);
  return d;
}
export function escapeEditing(ev) {
  return (
    ev.target.closest('input,textarea,select,[contenteditable="true"]') ||
    ev.metaKey ||
    ev.ctrlKey ||
    ev.altKey
  );
}
