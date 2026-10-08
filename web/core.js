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
export async function api(
  path,
  { method = "GET", body, signal, keepalive = false } = {},
) {
  const options = { method, signal, credentials: "same-origin", keepalive };
  if (body !== undefined) {
    options.body = body instanceof FormData ? body : JSON.stringify(body);
    if (!(body instanceof FormData))
      options.headers = { "Content-Type": "application/json" };
  }
  const r = await fetch("/api" + path, options);
  const payload = await r
    .json()
    .catch(() => ({ detail: "服务返回了无法识别的数据" }));
  if (!r.ok) {
    const err = new Error(
      typeof payload.detail === "string"
        ? payload.detail
        : "输入格式不正确，请检查后重试",
    );
    err.status = r.status;
    throw err;
  }
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
      return true;
    } catch {
      toast("浏览器空间不足，草稿未能保存。请复制内容。");
      return false;
    }
  },
  remove(key) {
    localStorage.removeItem("wr2:" + key);
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
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } catch (err) {
    if (err.name !== "AbortError") toast(err.message);
    throw err;
  } finally {
    button.disabled = false;
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
