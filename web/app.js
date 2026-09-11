const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

let state = {
  profile: null,
  doc: null,
  bubble: null,
  lookups: 0,
};

window.WR = {
  state,
  flags: {},
  hooks: { home: [], read: [], history: [], profile: [], nav: [], routes: [] },
  on(name, fn) {
    (this.hooks[name] || (this.hooks[name] = [])).push(fn);
  },
  addRoute(test, fn) {
    this.hooks.routes.push({ test, fn });
  },
  addNav(item) {
    this.hooks.nav.push(item);
  },
  pluginOn(id) {
    return !!this.flags[id];
  },
  async emit(name, payload) {
    for (const fn of this.hooks[name] || []) {
      try {
        await fn(payload);
      } catch (err) {
        console.warn("plugin hook", name, err);
      }
    }
  },
};

function toast(msg) {
  toastEl.hidden = false;
  toastEl.textContent = msg;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastEl.hidden = true; }, 1800);
}

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  let res;
  try {
    const headers = isForm
      ? { ...(opts.headers || {}) }
      : { "Content-Type": "application/json", ...(opts.headers || {}) };
    res = await fetch(path, {
      ...opts,
      credentials: "include",
      headers,
      body: opts.body == null ? undefined : (isForm ? opts.body : JSON.stringify(opts.body)),
    });
  } catch (e) {
    throw new Error("服务连不上。请重新启动：uv run uvicorn wise_reader.app:create_app --factory --port 8766");
  }
  if (res.status === 401) {
    if (!location.hash.startsWith("#/login")) location.hash = "#/login";
    throw new Error("需要登录");
  }
  if (!res.ok) throw new Error(await res.text());
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

WR.api = api;
WR.toast = toast;
WR.escapeHtml = escapeHtml;

WR.scrollRatio = function () {
  const el = document.scrollingElement || document.documentElement;
  const max = el.scrollHeight - window.innerHeight;
  return max > 0 ? el.scrollTop / max : 0;
};

WR.restoreScroll = function (ratio) {
  const apply = () => {
    const el = document.scrollingElement || document.documentElement;
    const max = el.scrollHeight - window.innerHeight;
    if (max > 0 && ratio > 0) el.scrollTop = max * ratio;
  };
  apply();
  requestAnimationFrame(() => requestAnimationFrame(apply));
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function route() {
  closeBubble();
  toastEl.hidden = true;
  clearTimeout(toast.t);
  const hash = location.hash.slice(1) || "/";
  const [path, q] = hash.split("?");
  const params = new URLSearchParams(q || "");
  let task;
  const pluginHit = matchPluginRoute(path, params);
  if (pluginHit) task = pluginHit;
  else if (path === "/") task = renderHome();
  else if (path === "/history") task = renderHistory();
  else if (path === "/profile") task = renderProfile();
  else if (path === "/test") task = renderTest();
  else if (path === "/labs") task = renderLabs();
  else if (path.startsWith("/read/")) task = renderRead(path.split("/")[2], params.get("density"));
  else task = renderHome();
  document.querySelectorAll("nav a").forEach((a) => {
    const href = a.getAttribute("href");
    a.classList.toggle("active", href === `#${path}` || (path === "/" && href === "#/"));
  });
  Promise.resolve(task).catch((err) => {
    console.error(err);
    toast(err.message || "加载失败");
    app.innerHTML = `<p class="hero">${escapeHtml(err.message || "加载失败")}</p>`;
  });
}

function matchPluginRoute(path, params) {
  for (const r of WR.hooks.routes) {
    const t = r.test;
    const ok = typeof t === "function" ? t(path) : (path === t || path.startsWith(t + "/"));
    if (ok) return r.fn(path, params);
  }
  return null;
}

WR.route = route;

async function renderHome() {
  state.profile = await api("/api/profile");
  app.innerHTML = `
    <p class="hero">粘贴英文材料。按你的词汇量自动加中文注释，读的时候不用查词典。</p>
    <label>标题（可选）</label>
    <input id="title" type="text" placeholder="今天读的那篇" />
    <label>正文</label>
    <textarea id="text" placeholder="Paste English text here."></textarea>
    <div class="row">
      <button id="go">开始阅读</button>
      <span class="meta">当前词汇量估计 ${state.profile.vocab_size} · 密度 ${state.profile.density}/百词</span>
    </div>
    <div id="plugin-home"></div>
  `;
  document.getElementById("go").onclick = async () => {
    const text = document.getElementById("text").value.trim();
    if (!text) return toast("先贴一段英文");
    document.getElementById("go").disabled = true;
    try {
      const doc = await api("/api/documents", {
        method: "POST",
        body: { title: document.getElementById("title").value, text },
      });
      location.hash = `#/read/${doc.id}`;
    } catch (e) {
      toast(e.message || "处理失败");
      document.getElementById("go").disabled = false;
    }
  };
  await WR.emit("home", { root: document.getElementById("plugin-home") });
}

async function renderHistory() {
  const [docs, logs] = await Promise.all([api("/api/documents"), api("/api/reading-log")]);
  app.innerHTML = `
    <h2>阅读历史</h2>
    <ul class="list">
      ${docs.map(d => `<li><a href="#/read/${d.id}">${escapeHtml(d.title)}</a>
        <span class="meta">${d.word_count} 词 · ${d.created_at.slice(0,10)}</span></li>`).join("") || "<li>还没有文章</li>"}
    </ul>
    <h3>读完记录</h3>
    <ul class="list">
      ${logs.map(l => `<li><span>${escapeHtml(l.title || "#" + l.doc_id)}</span>
        <span class="meta">查词 ${l.manual_lookups} · 标注 ${l.annotation_count} · ${l.felt_density || ""}</span></li>`).join("") || "<li>还没有记录</li>"}
    </ul>
  `;
  await WR.emit("history", { root: app });
}

async function saveProfile(patch) {
  state.profile = await api("/api/profile", { method: "PATCH", body: patch });
  return state.profile;
}

function setSaveStatus(kind, text) {
  const el = document.getElementById("saveStatus");
  if (!el) return toast(text);
  el.dataset.state = kind;
  el.textContent = text;
}

async function renderProfile() {
  const p = await api("/api/profile");
  state.profile = p;
  const exams = Object.entries(p.exam_vocab);
  const selectedDomains = new Set(p.domains);
  app.innerHTML = `
    <div class="page-head">
      <div>
        <h2>读者档案</h2>
        <p class="hint">改动立即保存，不用找保存按钮。</p>
      </div>
      <span class="save-status" id="saveStatus" data-state="ok">已保存</span>
    </div>

    <section class="card">
      <h3>词汇量</h3>
      <p class="hint">点一个考纲，或自己改数字。只用来决定注释稀有度，读的时候还能纠正。</p>
      <div class="chips" id="exams">
        ${exams.map(([k, v]) => {
          const on = Number(p.vocab_size) === Number(v) ? "on" : "";
          return `<button type="button" class="chip ${on}" data-exam="${k}" aria-pressed="${on ? "true" : "false"}">${k.toUpperCase()}<span class="chip-n">${v}</span></button>`;
        }).join("")}
      </div>
      <div class="row tight">
        <label class="inline" for="vocab">自定义</label>
        <input id="vocab" type="number" min="500" max="50000" value="${p.vocab_size}" />
        <a class="link" href="#/test">或不选考纲，做 10 分钟测试</a>
      </div>
    </section>

    <section class="card">
      <h3>注释密度 <span id="densVal">${p.density}</span><small> / 百词</small></h3>
      <p class="hint">每百词最多标几处。宁少勿多。</p>
      <input id="dens" type="range" min="1" max="10" step="0.5" value="${p.density}" />
    </section>

    <section class="card">
      <h3>熟悉的领域</h3>
      <p class="hint">点亮的领域，文化背景注释会藏起来。点一下即保存。</p>
      <div class="chips" id="domains">
        ${Object.entries(p.domain_catalog).map(([k, v]) => {
          const on = selectedDomains.has(k);
          return `<button type="button" class="chip ${on ? "on" : ""}" data-d="${k}" aria-pressed="${on}">${v}</button>`;
        }).join("")}
      </div>
    </section>

    <p class="meta">个人词表 ${p.verdict_count} 条（认识 ${p.known_count} / 不认识 ${p.unknown_count}）
      · L1 ${p.l1_available ? "已配置" : "未配置，仅词汇层"}</p>
    <div id="plugin-profile"></div>
  `;

  const dens = document.getElementById("dens");
  let densTimer;
  dens.oninput = () => {
    document.getElementById("densVal").textContent = dens.value;
    setSaveStatus("busy", "保存中…");
    clearTimeout(densTimer);
    densTimer = setTimeout(async () => {
      try {
        await saveProfile({ density: +dens.value });
        setSaveStatus("ok", "已保存");
      } catch (err) {
        setSaveStatus("err", "保存失败");
        toast(err.message);
      }
    }, 280);
  };

  let vocabTimer;
  document.getElementById("vocab").addEventListener("input", (e) => {
    setSaveStatus("busy", "保存中…");
    clearTimeout(vocabTimer);
    vocabTimer = setTimeout(async () => {
      const n = +e.target.value;
      if (!n || n < 500) return;
      try {
        await saveProfile({ vocab_size: n });
        document.querySelectorAll("#exams .chip").forEach((chip) => {
          const v = state.profile.exam_vocab[chip.dataset.exam];
          const on = Number(n) === Number(v);
          chip.classList.toggle("on", on);
          chip.setAttribute("aria-pressed", on ? "true" : "false");
        });
        setSaveStatus("ok", "已保存");
      } catch (err) {
        setSaveStatus("err", "保存失败");
        toast(err.message);
      }
    }, 400);
  });

  document.getElementById("exams").onclick = async (e) => {
    const chip = e.target.closest("[data-exam]");
    if (!chip) return;
    setSaveStatus("busy", "保存中…");
    try {
      const next = await saveProfile({ exam: chip.dataset.exam });
      document.getElementById("vocab").value = next.vocab_size;
      document.querySelectorAll("#exams .chip").forEach((c) => {
        const v = next.exam_vocab[c.dataset.exam];
        const on = Number(next.vocab_size) === Number(v);
        c.classList.toggle("on", on);
        c.setAttribute("aria-pressed", on ? "true" : "false");
      });
      setSaveStatus("ok", "已保存");
    } catch (err) {
      setSaveStatus("err", "保存失败");
      toast(err.message);
    }
  };

  document.getElementById("domains").onclick = async (e) => {
    const chip = e.target.closest("[data-d]");
    if (!chip) return;
    chip.classList.toggle("on");
    chip.setAttribute("aria-pressed", chip.classList.contains("on") ? "true" : "false");
    const domains = [...document.querySelectorAll("#domains .chip.on")].map((x) => x.dataset.d);
    setSaveStatus("busy", "保存中…");
    try {
      await saveProfile({ domains });
      setSaveStatus("ok", `已保存 · ${domains.length} 个领域`);
    } catch (err) {
      chip.classList.toggle("on");
      chip.setAttribute("aria-pressed", chip.classList.contains("on") ? "true" : "false");
      setSaveStatus("err", "保存失败");
      toast(err.message);
    }
  };
  await WR.emit("profile", { root: document.getElementById("plugin-profile") });
}

async function renderLabs() {
  const data = await api("/api/plugins");
  app.innerHTML = `
    <div class="page-head">
      <div>
        <h2>实验室</h2>
        <p class="hint">每个功能都是独立插件。关掉后界面消失，对应 API 返回 404。清退代码：删 <code>src/wise_reader/plugins/&lt;id&gt;.py</code> 与 <code>web/plugins/&lt;id&gt;.js</code>，再从 catalog 去掉那一行。</p>
      </div>
    </div>
    <div class="plugin-grid">
      ${data.plugins.map((p) => `
        <label class="plugin-card">
          <div>
            <strong>${escapeHtml(p.name)}</strong>
            <span class="meta">${escapeHtml(p.id)}</span>
            <p class="hint">${escapeHtml(p.summary)}</p>
          </div>
          <input type="checkbox" data-id="${p.id}" ${p.enabled ? "checked" : ""} />
        </label>`).join("")}
    </div>
  `;
  app.querySelectorAll("input[data-id]").forEach((el) => {
    el.onchange = async () => {
      await api(`/api/plugins/${el.dataset.id}`, { method: "PATCH", body: { enabled: el.checked } });
      toast(el.checked ? "已开启" : "已关闭");
      location.reload();
    };
  });
}

async function renderTest() {
  let payload = await api("/api/vocab-test/start", { method: "POST", body: {} });
  const paint = () => {
    if (payload.finished) {
      app.innerHTML = `
        <div class="word-card">
          <p>估计词汇量</p>
          <div class="word">${payload.estimate}</div>
          <p class="meta">已写入档案，并记住你认识的词</p>
          <a class="btn" href="#/profile">回档案</a>
        </div>`;
      return;
    }
    const q = payload.question;
    app.innerHTML = `
      <div class="word-card">
        <p class="meta">第 ${payload.round} / ${payload.max_rounds} 轮</p>
        <div class="word">${escapeHtml(q.word)}</div>
        <div class="ipa">${q.phonetic ? "/" + escapeHtml(q.phonetic) + "/" : ""}</div>
        <div class="row" style="justify-content:center">
          <button id="yes">认识</button>
          <button class="ghost" id="no">不认识</button>
        </div>
        <p class="meta"><a href="#/profile">跳过，改用考纲自评</a></p>
      </div>`;
    const send = async known => {
      payload = await api("/api/vocab-test/answer", {
        method: "POST",
        body: { session: payload.session, word: q.word, known },
      });
      paint();
    };
    document.getElementById("yes").onclick = () => send(true);
    document.getElementById("no").onclick = () => send(false);
  };
  paint();
}

async function loadDoc(id, density) {
  const q = density != null ? `?density=${density}` : "";
  state.doc = await api(`/api/documents/${id}${q}`);
}

async function renderRead(id, densityParam) {
  closeBubble();
  if (!state.doc || String(state.doc.id) !== String(id) || densityParam != null) {
    await loadDoc(id, densityParam);
  }
  const d = state.doc;
  const html = d.fragments.map(f => {
    if (f.type === "plain") return escapeHtml(f.text);
    return `<span class="anno" data-lemma="${escapeHtml(f.lemma)}" data-detail="${escapeHtml(f.detail)}" data-kind="${f.kind}">${escapeHtml(f.text)}<span class="note">(${escapeHtml(f.note)})</span></span>`;
  }).join("");
  app.innerHTML = `
    <div class="toolbar">
      <span>${escapeHtml(d.title)}</span>
      <label style="margin:0">密度
        <input id="dens" type="range" min="1" max="10" step="0.5" value="${d.density}" />
      </label>
      <span id="densVal">${d.density}</span>
      <span class="meta">${d.word_count} 词 · ${d.annotation_count} 注 · ${d.density_actual}% · ${d.fragment_count} 节点</span>
      <span id="plugin-toolbar" class="plugin-toolbar"></span>
    </div>
    <div id="reader-stage">
      <article class="article" id="article">${html}</article>
    </div>
    <div class="row">
      <span class="meta">注释感觉：</span>
      <button class="ghost" data-felt="太多">太多</button>
      <button class="ghost" data-felt="合适">合适</button>
      <button class="ghost" data-felt="太少">太少</button>
    </div>
    <div id="plugin-below"></div>
  `;
  const dens = document.getElementById("dens");
  dens.oninput = () => { document.getElementById("densVal").textContent = dens.value; };
  dens.onchange = async () => {
    const t0 = performance.now();
    await loadDoc(id, dens.value);
    const dt = performance.now() - t0;
    await renderRead(id);
    if (dt > 500) toast(`重渲染 ${Math.round(dt)}ms`);
  };
  document.getElementById("article").onclick = onAnnoClick;
  setupLongPress(document.getElementById("article"));
  document.querySelectorAll("[data-felt]").forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/documents/${id}/finish`, {
        method: "POST",
        body: {
          annotation_count: state.doc.annotation_count,
          manual_lookups: state.lookups,
          felt_density: btn.dataset.felt,
        },
      });
      toast("已记入阅读日志");
    };
  });
  await WR.emit("read", {
    id: d.id,
    doc: d,
    article: document.getElementById("article"),
    toolbar: document.getElementById("plugin-toolbar"),
    below: document.getElementById("plugin-below"),
    stage: document.getElementById("reader-stage"),
  });
}

function onAnnoClick(e) {
  const el = e.target.closest(".anno");
  if (!el) { closeBubble(); return; }
  e.preventDefault();
  const r = el.getBoundingClientRect();
  showBubble(r.left + window.scrollX, r.bottom + window.scrollY + 6, {
    lemma: el.dataset.lemma,
    detail: el.dataset.detail,
    el,
  });
}

function showBubble(x, y, { lemma, detail, el }) {
  closeBubble();
  const b = document.createElement("div");
  b.className = "bubble";
  b.style.left = x + "px";
  b.style.top = y + "px";
  b.innerHTML = `
    <div>${escapeHtml(detail || lemma)}</div>
    <div class="actions">
      <button data-v="known">认识了</button>
      <button class="ghost" data-v="unknown">还是不认识</button>
    </div>`;
  b.onclick = async ev => {
    const v = ev.target.dataset.v;
    if (!v) return;
    await api("/api/feedback", { method: "POST", body: { lemma, verdict: v } });
    if (v === "known" && el) el.replaceWith(document.createTextNode(el.childNodes[0].textContent));
    closeBubble();
    toast(v === "known" ? "以后不再标" : "以后一定标");
  };
  document.body.appendChild(b);
  state.bubble = b;
}

function closeBubble() {
  if (state.bubble) { state.bubble.remove(); state.bubble = null; }
}

function wordAtPoint(x, y) {
  const caret = document.caretRangeFromPoint?.(x, y) || (document.caretPositionFromPoint && (() => {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    r.collapse(true);
    return r;
  })());
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return "";
  const text = caret.startContainer.textContent;
  const i = caret.startOffset;
  const m1 = text.slice(0, i).match(/[A-Za-z]+$/);
  const m2 = text.slice(i).match(/^[A-Za-z]+/);
  return ((m1 ? m1[0] : "") + (m2 ? m2[0] : ""));
}

function setupLongPress(article) {
  let timer = null;
  const start = ev => {
    const p = ev.touches ? ev.touches[0] : ev;
    timer = setTimeout(async () => {
      const w = wordAtPoint(p.clientX, p.clientY);
      if (!w) return;
      const info = await api("/api/lookup", { method: "POST", body: { word: w, mark_unknown: true } });
      state.lookups += 1;
      const r = { left: p.clientX + window.scrollX, bottom: p.clientY + window.scrollY };
      showBubble(r.left, r.bottom + 8, {
        lemma: info.lemma || w,
        detail: info.found ? `${info.note}${info.phonetic ? " /" + info.phonetic + "/" : ""}` : "词典未收录",
        el: null,
      });
    }, 500);
  };
  const cancel = () => { clearTimeout(timer); };
  article.addEventListener("mousedown", start);
  article.addEventListener("touchstart", start, { passive: true });
  article.addEventListener("mouseup", cancel);
  article.addEventListener("mouseleave", cancel);
  article.addEventListener("touchend", cancel);
}

window.addEventListener("hashchange", route);
document.querySelector(".top").addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='#']");
  if (!a) return;
  const next = a.getAttribute("href");
  if (location.hash === next) {
    e.preventDefault();
    route();
  }
});
