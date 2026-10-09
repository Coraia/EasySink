import {
  $,
  $$,
  e,
  api,
  Scope,
  local,
  toast,
  errorBox,
  date,
  openDialog,
  busy,
} from "./core.js";
import { PluginHost } from "./plugin-host.js?v=20261006-grab1";
import { Reader } from "./reader.js?v=20261008-paper";
import { renderAI } from "./ai-settings.js";
import { installReadingTrackpad } from "./reading-trackpad.js?v=20261007-native-hd";
import { installDesktopLifecycle } from "./desktop-lifecycle.js";
installDesktopLifecycle();
const hooks = new Map(),
  routes = new Map();
const ctx = {
  root: $("#app"),
  profile: null,
  reader: null,
  scope: null,
  hook(slot, fn) {
    if (!hooks.has(slot)) hooks.set(slot, new Set());
    hooks.get(slot).add(fn);
    return () => hooks.get(slot).delete(fn);
  },
  route(name, fn) {
    routes.set(name, fn);
    return () => routes.delete(name);
  },
  async run(slot, arg) {
    for (const fn of hooks.get(slot) || []) {
      if (arg?.scope?.signal.aborted) return;
      try {
        await fn(arg);
      } catch (err) {
        if (err.name === "AbortError") return;
        console.warn("Optional feature failed", err);
        toast("一项辅助功能暂时不可用，正文仍可阅读");
      }
    }
  },
  enabled: (id) => host.enabled(id),
  navigate(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  },
  refresh: () => route(),
  cards,
  importText: () => importText(),
  openDialog,
  jump(doc_id, anchor) {
    if (anchor) local.set(`jump:${doc_id}`, anchor);
    ctx.navigate(`#/read/${doc_id}`);
  },
};
const host = new PluginHost(ctx);
ctx.host = host;
// App-owned input stream survives chapter loading; it reads no stale Reader.
installReadingTrackpad(ctx);
const palette = [
  "#dce4d8",
  "#e9dfcc",
  "#dce5e7",
  "#e7dcd1",
  "#dfe0eb",
  "#e5e8d0",
];
function cards(items) {
  return items
    .map((d, i) => {
      if (d.cardKey) return `<article class="book-card" data-card-key="${e(d.cardKey)}"><div class="book-cover" style="--cover:${palette[i % palette.length]}"><small>${e(d.coverLabel)}</small><div class="cover-title">${e(d.title)}</div></div><div class="book-info"><h3>${e(d.title)}</h3><div class="row"><span data-card-subtitle>${e(d.subtitle)}</span><span>·</span><span>${date(d.created_at)}</span></div><div data-card-status>${d.statusHTML || ""}</div><footer><a class="book-card-open" data-card-open href="${e(d.href)}" aria-label="${e(d.title)} · 打开"><span data-card-action>${e(d.action)}</span><span aria-hidden="true"> ↗</span></a><a class="book-card-status-link" href="${e(d.statusHref)}">处理详情</a></footer></div></article>`;
      return `<a class="book-card" href="${d.href || "#/read/" + d.id}"><div class="book-cover" style="--cover:${palette[i % palette.length]}"><small>${e(d.coverLabel || "WISE READER / ARTICLE")}</small><div class="cover-title">${e(d.title)}</div></div><div class="book-info"><h3>${e(d.title)}</h3><div class="row"><span>${e(d.subtitle || `${d.word_count?.toLocaleString() || 0} 词`)}</span><span>·</span><span>${date(d.created_at)}</span></div><footer><span>${e(d.action || "打开阅读")}</span><span>↗</span></footer></div></a>`;
    })
    .join("");
}
async function route() {
  ctx.readStarted = performance.now();
  ctx.scope?.dispose();
  ctx.reader = null;
  const scope = (ctx.scope = new Scope());
  const hash = location.hash.replace(/^#\/?/, "");
  const [name, id] = hash.split("/");
  document.body.classList.remove("reading", "immersive", "paged-reading");
  if (name === "read" && /^\d+$/.test(id))
    document.body.classList.add("paged-reading");
  $("#header-context").textContent = "你的英文阅读空间";
  $$("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === (name || "home")),
  );
  ctx.root.innerHTML = '<div class="loading" role="status">正在打开…</div>';
  window.scrollTo(0, 0);
  try {
    const reading = name === "read" && /^\d+$/.test(id);
    // These reads are independent. Plugin installation still completes before
    // the reader mounts; personal selection is computed by the document API.
    const [{ plugins }, profile, doc] = await Promise.all([
      api("/plugins", { signal: scope.signal }),
      api("/profile", { signal: scope.signal }),
      reading
        ? api(`/documents/${id}?compact=true`, { signal: scope.signal })
        : null,
    ]);
    if (scope.signal.aborted) return;
    await host.sync(plugins);
    if (scope.signal.aborted) return;
    ctx.profile = profile;
    if (reading) {
      ctx.reader = new Reader(ctx, scope, doc);
      await ctx.reader.mount();
    } else if (name === "profile" || name === "settings")
      await renderProfile(scope);
    else if (name === "ai") await renderAI(ctx, scope);
    else if (name === "labs") await renderLabs(scope);
    else if (name === "jobs") await renderJobs(scope);
    else if (routes.has(name)) await routes.get(name)(scope, id);
    else if (!name || name === "history") await renderHome(scope);
    else
      ctx.root.innerHTML =
        '<div class="empty"><h2>这个功能已关闭</h2><p>可在功能管理里重新开启，原来的数据仍在。</p><a class="button" href="#/labs">打开功能管理</a></div>';
  } catch (err) {
    if (err.name === "AbortError" || scope.signal.aborted) return;
    document.body.classList.remove("reading", "immersive", "paged-reading");
    if (err.status === 401 && routes.has("login")) {
      await routes.get("login")(scope);
      return;
    }
    scope.dispose();
    ctx.reader = null;
    ctx.root.innerHTML = `<div class="page"><h1>暂时无法打开</h1>${errorBox(err)}<button id="retry-page">重新连接</button></div>`;
    $("#retry-page").onclick = route;
  }
}
async function renderHome(scope) {
  const documents = await api("/documents", { signal: scope.signal });
  if (scope.signal.aborted) return;
  ctx.root.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">YOUR READING SPACE</div><h1>留在故事里。</h1><p>从一篇文章开始，让语言不再打断思考。</p></div><div class="row" id="home-actions"><button class="primary" id="new-reading">＋ 添加阅读</button></div></div><section class="welcome ${documents.length ? "compact" : ""}"><div class="welcome-copy"><div class="eyebrow">READ WITH UNDERSTANDING</div><h2>好的阅读体验，<br>是忘记自己在读英文。</h2><p>只解释你需要的词、表达与背景。无需先做测试，开始阅读后，辅助会随你的反馈调整。</p><div class="row wrap"><button id="try-sample">体验一篇示例 <span>→</span></button><button id="try-grammar-sample" class="text-button">体验长难句</button><a class="text-button" href="#/profile">调整我的阅读辅助</a></div></div><div class="reading-sample"><p>Curiosity is a quiet form of <span>courage <small>勇气</small></span>.</p><div class="caption">英文在前，理解就在旁边。</div></div></section><div id="home-continue"></div><div id="book-collections"></div><div class="section-heading"><h2>我的阅读</h2><span id="shelf-count" role="status">正在整理书架…</span></div><div class="shelf-tools"><div class="filters" role="group" aria-label="内容筛选"><button class="filter active" data-filter="all">全部</button><button class="filter" data-filter="recent">最近添加</button><button class="filter" data-filter="archived">已归档</button></div><input type="search" id="shelf-search" placeholder="搜索标题…" aria-label="搜索书架"></div><div class="book-grid" id="article-grid"></div></div>`;
  let filter = "all";
  const view = { scope, documents, collections: [], chapterIds: new Set() };
  const draw = () => {
    let items = documents.filter((d) =>
      filter === "archived"
        ? d.archived
        : !d.archived && !view.chapterIds.has(d.id),
    );
    if (filter !== "archived") items = [...view.collections, ...items];
    const bookCount = filter === "archived" ? 0 : view.collections.length;
    $("#shelf-count").textContent =
      `${bookCount} 本书 · ${items.length - bookCount} 篇内容`;
    const search = $("#shelf-search").value.toLowerCase();
    items = items.filter((d) => d.title.toLowerCase().includes(search));
    if (filter === "recent") items = items.slice(0, 6);
    $("#article-grid").innerHTML =
      cards(items) ||
      '<div class="empty"><h3>这里还没有内容</h3><p>添加一篇文章，或导入一本 EPUB，开始自己的阅读旅程。</p></div>';
  };
  $("#article-grid").innerHTML =
    '<p class="muted" role="status">正在整理书架…</p>';
  scope.on($("#new-reading"), "click", () => importText());
  scope.on($("#try-grammar-sample"), "click", (ev) =>
    busy(
      ev.target,
      async () => {
        const title = "在关系中理解知识 · 长难句体验";
        const existing = documents.find((d) => d.title === title);
        if (existing) {
          ctx.navigate("#/read/" + existing.id);
          return;
        }
        const text = await fetch("/static/grammar-sample.txt", {
          signal: scope.signal,
        }).then((r) => r.text());
        const value = await api("/documents", {
          method: "POST",
          body: { title, text },
          signal: scope.signal,
        });
        if (!scope.signal.aborted) ctx.navigate("#/read/" + value.id);
      },
      "正在打开…",
    ).catch(() => {}),
  );
  scope.on($("#try-sample"), "click", (ev) =>
    busy(
      ev.target,
      async () => {
        const sample = await fetch("/static/sample.txt").then((r) => r.text());
        const doc = await api("/documents", {
          method: "POST",
          body: { title: "The quiet art of paying attention", text: sample },
        });
        ctx.navigate("#/read/" + doc.id);
      },
      "正在准备…",
    ).catch(() => {}),
  );
  scope.on($("#shelf-search"), "input", draw);
  scope.on($(".filters"), "click", (ev) => {
    const b = ev.target.closest("[data-filter]");
    if (b) {
      filter = b.dataset.filter;
      $$(".filter").forEach((x) => x.classList.toggle("active", x === b));
      draw();
    }
  });
  await ctx.run("home", view);
  if (!scope.signal.aborted) draw();
}
function importText() {
  const draft = local.get("import-draft", { title: "", text: "" });
  const d = openDialog(
    "添加一段值得读的文字",
    `<div id="import-extension"></div><form id="paste-form" class="stack"><div><label for="paste-title">标题</label><input id="paste-title" placeholder="给这篇阅读起个名字" value="${e(draft.title)}"></div><div><label for="paste-text">英文原文</label><textarea id="paste-text" rows="8" required placeholder="粘贴文章、邮件或你想读懂的一段英文…">${e(draft.text)}</textarea></div><div class="row between"><span class="save-state" id="paste-state">草稿保留在此浏览器</span><button class="primary" type="submit">开始阅读 →</button></div></form>`,
  );
  const form = $("#paste-form", d);
  form.oninput = () => {
    const saved = local.set("import-draft", {
      title: $("#paste-title", d).value,
      text: $("#paste-text", d).value,
    });
    $("#paste-state", d).textContent = saved
      ? "草稿已自动保存"
      : "草稿未保存，请复制内容";
  };
  form.onsubmit = (ev) => {
    ev.preventDefault();
    busy(
      $("button[type=submit]", form),
      async () => {
        const text = $("#paste-text", d).value.trim();
        if (!text) throw new Error("先粘贴一些英文内容");
        const doc = await api("/documents", {
          method: "POST",
          body: { title: $("#paste-title", d).value, text },
        });
        local.remove("import-draft");
        d.close();
        ctx.navigate("#/read/" + doc.id);
      },
      "正在整理…",
    ).catch(() => {});
  };
  ctx.run("importDialog", d).catch((err) => toast(err.message));
}
async function renderProfile(scope) {
  const p = ctx.profile;
  let domains = new Set(p.domains);
  let queue = Promise.resolve();
  let latest = 0;
  ctx.root.innerHTML = `<div class="settings-layout"><div class="page-head"><div><div class="eyebrow">MAKE IT YOURS</div><h1>刚刚好的帮助。</h1><p>所有选择都会自动保存。读得越多，越懂你的需要。</p></div><span class="save-state" id="profile-save" role="status">已同步</span></div><section class="card"><h2>阅读辅助</h2><div class="setting-row"><div><strong>从熟悉的程度开始</strong><p>这是词频门槛的起点，可以随时调整，不需要先做测试。</p></div><select id="vocab-level" aria-label="英语熟悉程度">${[
    [3500, "基础阅读"],
    [4500, "大学四级左右"],
    [6000, "大学六级左右"],
    [8000, "熟练阅读"],
    [12000, "进阶阅读"],
  ]
    .map(
      ([v, label]) =>
        `<option value="${v}" ${p.vocab_size === v ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}${![3500, 4500, 6000, 8000, 12000].includes(p.vocab_size) ? `<option selected value="${p.vocab_size}">自定义 · ${p.vocab_size}</option>` : ""}</select></div><div class="setting-row"><div><strong>默认辅助密度</strong><p>每百词约显示多少处解释。要求保留的注释优先显示。</p></div><select id="default-density" aria-label="默认辅助密度">${[
    [0, "原文"],
    [2, "轻 · 2 处"],
    [4, "适中 · 4 处"],
    [8, "多 · 8 处"],
  ]
    .map(
      ([v, label]) =>
        `<option value="${v}" ${p.density === v ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}${![0, 2, 4, 8].includes(p.density) ? `<option selected value="${p.density}">${p.density} 处</option>` : ""}</select></div><div class="setting-row"><div><strong>重复解释</strong><p>同一个词在一篇文章中再次出现时，仍显示解释。</p></div><input class="switch" type="checkbox" id="repeat" aria-label="重复解释" ${p.repeat ? "checked" : ""}></div><div class="setting-row"><div><strong>表达与文化注释</strong><p>${p.l1_available ? "已连接 AI，在阅读时主动请求上下文解释与语法分析。" : "常用表达可离线解释；上下文解释与语法分析需配置 AI 后主动请求。"}</p></div><input class="switch" type="checkbox" id="l1-enabled" aria-label="表达与文化注释" ${p.l1_enabled ? "checked" : ""}></div></section><section class="card"><h2>我熟悉的领域</h2><p class="muted">选择你已有背景知识的领域，减少相关背景解释。</p><div class="chips" id="domains">${Object.entries(
    p.domain_catalog,
  )
    .map(
      ([id, label]) =>
        `<button class="chip" data-domain="${id}" aria-pressed="${domains.has(id)}">${e(label)}</button>`,
    )
    .join(
      "",
    )}</div><p class="save-state" id="domain-state">已选择 ${domains.size} 个领域 · 自动保存</p></section><section class="card"><div class="row between"><div><h2>了解我的阅读起点</h2><p class="muted" style="margin:0;font-size:14px">可选的短测试，给出词频熟悉度范围。</p></div><button id="vocab-test">试一试 →</button></div><div id="vocab-test-area"></div></section><section class="card row between"><div><h3>AI 与语音</h3><p class="muted">配置按需解释、选区翻译、语法分析和朗读。</p></div><a class="button" href="#/ai">配置服务 →</a></section><div id="profile-extensions" class="stack"></div><section class="card row between"><div><h3>让功能保持轻盈</h3><span class="muted">按需开关各项功能，已有数据会保留。</span></div><a class="button" href="#/labs">功能管理 →</a></section></div>`;
  const save = (fields) => {
    const version = ++latest;
    $("#profile-save").textContent = "保存中…";
    queue = queue
      .catch(() => {})
      .then(() => api("/profile", { method: "PATCH", body: fields }))
      .then((saved) => {
        ctx.profile = saved;
        if (!scope.signal.aborted && version === latest) {
          $("#profile-save").textContent = "已自动保存 ✓";
          $("#domain-state").textContent =
            `已选择 ${saved.domains.length} 个领域 · 已保存`;
        }
      })
      .catch((err) => {
        if (!scope.signal.aborted) {
          $("#profile-save").innerHTML =
            '<button class="text-button" id="retry-save">保存失败 · 重试</button>';
          $("#retry-save").onclick = () => save(fields);
        }
        toast(err.message);
      });
  };
  scope.on($("#vocab-level"), "change", (ev) =>
    save({ vocab_size: +ev.target.value }),
  );
  scope.on($("#default-density"), "change", (ev) =>
    save({ density: +ev.target.value }),
  );
  scope.on($("#repeat"), "change", (ev) => save({ repeat: ev.target.checked }));
  scope.on($("#l1-enabled"), "change", (ev) =>
    save({ l1_enabled: ev.target.checked }),
  );
  scope.on($("#domains"), "click", (ev) => {
    const btn = ev.target.closest("[data-domain]");
    if (!btn) return;
    const id = btn.dataset.domain;
    domains.has(id) ? domains.delete(id) : domains.add(id);
    btn.setAttribute("aria-pressed", domains.has(id));
    $("#domain-state").textContent = `已选择 ${domains.size} 个领域 · 保存中…`;
    save({ domains: [...domains] });
  });
  scope.on($("#vocab-test"), "click", () => vocabTest(scope));
  await ctx.run("profile", { scope });
}
async function vocabTest(scope) {
  const root = $("#vocab-test-area");
  const draw = (q) => {
    if (scope.signal.aborted) return;
    if (q.finished) {
      root.innerHTML = `<div class="notice">建议的阅读起点：${q.estimate.toLocaleString()} 词频门槛。已保存。<p class="muted">参考范围 ${q.range[0].toLocaleString()}–${q.range[1].toLocaleString()}；这不是精确词汇量。你可以直接阅读，再调整辅助。</p></div>`;
      return;
    }
    root.innerHTML = `<div class="gap card"><div class="meta">第 ${q.round} 轮 / 最多 ${q.max_rounds} 轮 · 已回答 ${q.progress} 题</div><h2 style="font:32px Georgia,serif;margin:20px 0">${e(q.question.word)}</h2><div class="row"><button data-answer="true">认识</button><button data-answer="false">不确定 / 不认识</button></div></div>`;
    $$("[data-answer]", root).forEach(
      (b) =>
        (b.onclick = async () => {
          const buttons = $$("[data-answer]", root);
          buttons.forEach((el) => (el.disabled = true));
          try {
            draw(
              await api("/vocab-test/answer", {
                method: "POST",
                body: {
                  session: q.session,
                  word: q.question.word,
                  known: b.dataset.answer === "true",
                },
                signal: scope.signal,
              }),
            );
          } catch (err) {
            if (err.name !== "AbortError") {
              toast(err.message);
              buttons.forEach((el) => (el.disabled = false));
            }
          }
        }),
    );
  };
  try {
    draw(
      await api("/vocab-test/start", {
        method: "POST",
        body: {},
        signal: scope.signal,
      }),
    );
  } catch (err) {
    if (!scope.signal.aborted) root.innerHTML = errorBox(err);
  }
}
async function renderLabs(scope) {
  const catalog = host.catalog;
  ctx.root.innerHTML = `<div class="settings-layout"><div class="page-head"><div><div class="eyebrow">A LIGHTER READER</div><h1>留下你需要的。</h1><p>关闭立即生效，书籍、笔记与设置仍会保留。</p></div><span class="save-state" id="plugin-save" role="status">${catalog.filter((p) => p.enabled).length} / ${catalog.length} 已开启</span></div><div class="card">${catalog.map((p, i) => `<div class="plugin-row"><span class="number">${String(i + 1).padStart(2, "0")}</span><div class="description"><h3>${e(p.name)}</h3><p>${e(p.summary)}</p></div><input type="checkbox" class="switch" data-plugin="${p.id}" aria-label="${e(p.name)}" ${p.enabled ? "checked" : ""}></div>`).join("")}</div><p class="muted" style="font-size:13px">账号功能仅用于锁住这台机器上的阅读空间。关闭访问锁后，同机访问不再需要密码。</p><a class="text-button" href="#/profile">← 返回阅读偏好</a></div>`;
  scope.on(ctx.root, "change", async (ev) => {
    const box = ev.target.closest("[data-plugin]");
    if (!box) return;
    $$("[data-plugin]").forEach((b) => (b.disabled = true));
    $("#plugin-save").textContent = "应用中…";
    try {
      const { plugins } = await api(`/plugins/${box.dataset.plugin}`, {
        method: "PATCH",
        body: { enabled: box.checked },
      });
      await host.sync(plugins);
      if (!scope.signal.aborted)
        $("#plugin-save").textContent = "已保存并生效 ✓";
    } catch (err) {
      box.checked = !box.checked;
      toast(err.message);
      if (!scope.signal.aborted)
        $("#plugin-save").textContent = "保存失败，请重试";
    } finally {
      $$("[data-plugin]").forEach((b) => (b.disabled = false));
    }
  });
}
async function renderJobs(scope) {
  ctx.root.innerHTML =
    '<div class="page"><div class="page-head"><div><h1>后台任务</h1><p>已完成的分段会保留；失败后可以从断点继续。</p></div><a class="button" href="#/">回书架</a></div><div id="jobs-list"></div></div>';
  const labels = {
    queued: "等待中",
    running: "进行中",
    complete: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  const update = async () => {
    try {
      const jobs = await api("/jobs", { signal: scope.signal });
      if (scope.signal.aborted) return;
      $("#jobs-list").innerHTML =
        jobs
          .map(
            (j) =>
              `<section class="card gap"><div class="row between"><h3>${j.kind === "translate" ? "中文翻译" : "增强注释"} · ${j.doc_ids.length} 章</h3><span class="meta">${labels[j.status]}</span></div><div class="progress-track"><div style="width:${(j.cursor / Math.max(1, j.total)) * 100}%"></div></div><p class="meta gap">${j.cursor} / ${j.total} 分段 ${e(j.error)}</p><div class="row">${["queued", "running"].includes(j.status) ? `<button data-job="${j.id}" data-action="cancel">取消任务</button>` : ""}${["failed", "cancelled"].includes(j.status) ? `<button data-job="${j.id}" data-action="retry">从断点重试</button>` : ""}<a class="text-button" href="#/read/${j.doc_ids[0]}">打开正文 →</a></div></section>`,
          )
          .join("") || '<div class="empty">还没有后台任务。</div>';
    } catch (err) {
      if (err.name !== "AbortError") toast(err.message);
    }
  };
  await update();
  scope.interval(update, 2000);
  scope.on(ctx.root, "click", async (ev) => {
    const b = ev.target.closest("[data-job]");
    if (b) {
      b.disabled = true;
      try {
        await api(`/jobs/${b.dataset.job}/${b.dataset.action}`, {
          method: "POST",
        });
        await update();
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
    }
  });
}
window.addEventListener("hashchange", route);
try {
  const { plugins } = await api("/plugins");
  await host.sync(plugins);
  await route();
} catch (err) {
  ctx.root.innerHTML = `<div class="page"><h1>阅读空间暂时无法连接</h1>${errorBox(err)}<p>请检查本机 Web 服务是否已启动，然后刷新页面。</p></div>`;
}
