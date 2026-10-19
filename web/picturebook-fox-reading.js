import { $, $$, e, api, local } from "./core.js";
import {
  buildFoxChapter,
  vocabulary as foxVocabulary,
  wordPattern as foxWordPattern,
} from "./picturebook-fox-chapter.js";

import {
  buildCastChapter,
  castVocabulary,
} from "./picturebook-cast-chapter.js";

import {
  buildRoseChapter,
  roseVocabulary,
} from "./picturebook-rose-chapter.js";

const chapterStarts = new Map();
function markup(text, vocabulary, wordPattern, allowed) {
  let out = "",
    pos = 0;
  for (const m of text.matchAll(wordPattern)) {
    const w = m[0].toLowerCase();
    if (allowed && !allowed.includes(w)) continue;
    out +=
      e(text.slice(pos, m.index)) +
      `<button class="fs-word" data-fs-word="${w}" aria-label="${e(m[0])} · ${vocabulary[w][0]}">${e(m[0])}</button>`;
    pos = m.index + m[0].length;
  }
  return out + e(text.slice(pos));
}

export async function mountFoxReading(ctx, scope, id) {
  const docId = /^\d+$/.test(id || "") ? Number(id) : null;
  const back = docId ? `#/read/${docId}` : "#/";
  ctx.root.innerHTML = `<div class="card"><p>正在展开《小王子》的画页…</p><a href="${back}">返回阅读页</a></div>`;
  let doc, chapter, plan;
  try {
    if (!docId) throw new Error("请从《小王子》完整英文版进入动态绘本。");
    const results = await Promise.all([
      api(`/documents/${docId}?compact=true`, { signal: scope.signal }),
      api(`/documents/${docId}/illustrations`, { signal: scope.signal }),
    ]);
    doc = results[0];
    plan = results[1].story_plan;
    if (!plan)
      throw new Error(
        "这份正文尚未匹配《小王子》的完整绘本版本，请返回原阅读页。",
      );
    chapter =
      plan.chapter === 21
        ? buildFoxChapter(doc)
        : plan.chapter === 8
          ? buildRoseChapter(doc, plan)
          : buildCastChapter(doc, plan);
  } catch (error) {
    if (!scope.signal.aborted)
      ctx.root.innerHTML = `<div class="card"><h2>这一章暂时无法打开</h2><p>${e(error.message)}</p><a href="${back}">返回阅读页</a></div>`;
    return;
  }
  if (scope.signal.aborted) return;
  const { lines, acts, pages } = chapter;
  const isFox = plan.chapter === 21;
  const isRose = plan.chapter === 8;
  const vocabulary = isFox
    ? foxVocabulary
    : isRose
      ? roseVocabulary
      : castVocabulary;
  const wordPattern = isFox
    ? foxWordPattern
    : new RegExp(
        `\\b(${Object.keys(vocabulary)
          .sort((a, b) => b.length - a.length)
          .join("|")})\\b`,
        "gi",
      );
  const chapters = doc.chapters || [];
  const chapterIndex = chapters.findIndex((c) => c.doc_id === docId);
  function jumpChapter(destination, edge) {
    if (!destination) return;
    if (edge) chapterStarts.set(destination.doc_id, edge);
    ctx.navigate(`#/living-book/${destination.doc_id}`);
  }
  const initialEdge = chapterStarts.get(docId);
  chapterStarts.delete(docId);
  const resumeKey = `${isFox ? "fox-story" : "living-book"}-position:${docId}`;
  const saved = local.get(resumeKey, {});
  const resume =
    saved.version === doc.version
      ? lines.findIndex(
          (l) => l.block === saved.block && l.start === saved.start,
        )
      : -1;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./picturebook-fox-reading.css", import.meta.url).href;
  document.head.append(css);
  document.body.classList.add("fox-story-reading");
  ctx.root.innerHTML = `<main class="fox-story ${isRose ? "rose-chapter" : ""}" data-doc="${docId}" data-chapter="${plan.chapter}"><header class="fs-header"><a class="fs-brand" href="#/">✦ wise reader<small>小小读者，大大世界。</small></a><span>THE LITTLE PRINCE · A LIVING STORY</span><a href="${back}" class="fs-original">返回原阅读页 ↗</a></header><div class="fs-bookline"><span>${e(plan.title)}</span><span>完整英文 · ${lines.length} 句</span></div><nav class="fs-chapters" aria-label="全书章节"><button id="fs-chapter-prev" ${chapterIndex <= 0 ? "disabled" : ""} aria-label="上一章">← 上一章</button><label><span>我的星际旅程</span><select id="fs-chapter-select" aria-label="选择章节">${chapters.map((c) => `<option value="${c.doc_id}" ${c.doc_id === docId ? "selected" : ""}>${e(c.title)}</option>`).join("")}</select></label><button id="fs-chapter-next" ${chapterIndex >= chapters.length - 1 ? "disabled" : ""} aria-label="下一章">下一章 →</button></nav><section class="fs-book" aria-label="小王子的动态绘本阅读"><div class="fs-art-panel"><div class="fs-stage" id="fs-stage"><div class="fs-fallback"><img class="fs-boy" src="/static/assets/picturebook-lookdev-v2/prince.png" alt="金发绿衣的小王子"><img class="fs-fox" src="/static/assets/picturebook-lookdev-v2/fox.png" alt="金色草丛中的狐狸"><img class="fs-friends" src="/static/assets/picturebook-fox-reading/friends-seated.png" alt="小王子与狐狸坐在一起"><img class="fs-rose" src="/static/assets/picturebook-fox-reading/rose.png" alt="小王子的玫瑰"></div></div><div class="fs-art-top">${!isFox ? '<button id="fs-compare" aria-pressed="false">看原插画</button>' : "<span>✧ THE LITTLE WONDERS</span>"}<button id="fs-motion" aria-pressed="false">暂停动作</button></div><div class="fs-caption"><span id="fs-caption-number">01 · 狐狸出现</span><h1 id="fs-caption-title">一声问候，一段友谊。</h1><p id="fs-caption-text"></p></div></div><div class="fs-paper"><div class="fs-paper-top"><span id="fs-act-en"></span><span id="fs-count"></span></div><h2 id="fs-act-title"></h2><p class="fs-instruction">停在一句英文上，让故事慢慢发生。<span id="fs-page-label"></span></p><div id="fs-lines" lang="en" aria-label="悬浮、点击或用方向键逐句阅读"></div><div class="fs-help"><p id="fs-translation" hidden></p><div id="fs-word-card"><span>小小词袋</span><strong>fox</strong><span>狐狸</span></div></div><div class="fs-read-tools"><button id="fs-chinese" aria-pressed="false">中 · 情节提示</button><button id="fs-demo" aria-pressed="false">▷ 自动阅读</button></div><div class="fs-bottom"><button id="fs-prev" aria-label="上一句">←</button><label class="fs-progress-label"><span class="fs-sr">跳到句子</span><input id="fs-progress" type="range" min="0" max="${lines.length - 1}" value="0" aria-label="跳到句子"></label><button id="fs-next" aria-label="下一句">→</button></div><p class="fs-key-hint">← → 逐句探索 · 点点带下划线的单词</p><p id="fs-status" role="status">正在展开画页…</p></div></section><footer class="fs-footer"><div><span>A LITTLE JOURNEY</span><h2>${isFox ? "成为朋友，需要一点时间。" : "每一场相遇，都是新的发现。"}</h2></div><nav aria-label="故事情节">${acts.map((a, i) => `<button data-fs-act="${i}" aria-current="${i === 0}"><span>${String(i + 1).padStart(2, "0")}</span>${a.title}</button>`).join("")}</nav><a href="/static/picturebook-lookdev.html">看角色与原绘本的对比 ↗</a></footer><p class="fs-source">《小王子》第 ${plan.chapter} / 27 章 · 完整英文原文 · 中文情节提示为辅助说明 · 2.5D 动态绘本</p><details class="fs-source fs-edition"><summary>英文版本与插画来源</summary><p>原著 ${e(plan.source.author)} · 英译 ${e(plan.source.translator)} · ${e(plan.source.publisher)} ${plan.source.year} · <a href="${e(plan.source.source_url)}" target="_blank" rel="noreferrer">版本来源</a> · <a href="${e(plan.source.license_url)}" target="_blank" rel="noreferrer">CC BY-NC 3.0</a></p><p>保留书库中全部英文措辞与拼写。中文标题和提示为阅读引导；AI 手绘插画配合局部形变、灯光与角色动画。同一关键情节内共用画面，句子和重点单词驱动局部回应。</p><p lang="en">${e(plan.source.changes)}</p><h3>原书献词</h3><p lang="en">${e(plan.source.dedication.replace(/ +/g, " "))}</p></details><div class="fs-sr" id="fs-live" role="status" aria-live="polite"></div></main>`;
  const root = $(".fox-story", ctx.root),
    host = $("#fs-stage", root);
  if (!isFox) {
    host.classList.add("living-stage");
    host.innerHTML =
      '<div class="fs-living-backdrop"></div><svg class="fs-living-fallback" aria-label="当前情节插画" preserveAspectRatio="xMidYMid meet"><image width="200" height="200" /></svg>';
  }
  scope.on($("#fs-chapter-select", root), "change", (event) =>
    jumpChapter(chapters.find((c) => c.doc_id === Number(event.target.value))),
  );
  scope.on($("#fs-chapter-prev", root), "click", () =>
    jumpChapter(chapters[chapterIndex - 1], "start"),
  );
  scope.on($("#fs-chapter-next", root), "click", () =>
    jumpChapter(chapters[chapterIndex + 1], "start"),
  );
  let index = 0,
    act = -1,
    page = -1,
    chinese = false,
    scene = null,
    timer = null,
    hover = null,
    playing = false,
    hoverTarget = null;
  const stopDemo = () => {
    clearTimeout(timer);
    timer = null;
    playing = false;
    $("#fs-demo", root).textContent = "▷ 自动阅读";
    $("#fs-demo", root).setAttribute("aria-pressed", "false");
    root.dataset.playing = "false";
  };
  const updateMotion = () => {
    const paused = scene?.isPaused() || false;
    $("#fs-motion", root).textContent = paused ? "播放动作" : "暂停动作";
    $("#fs-motion", root).setAttribute("aria-pressed", String(paused));
  };
  function select(next, { manual = true, announce = false } = {}) {
    if (scope.signal.aborted) return;
    clearTimeout(hover);
    hover = null;
    if (manual) stopDemo();
    index = Math.max(0, Math.min(lines.length - 1, next));
    act = lines[index].act;
    if (lines[index].page !== page) {
      page = lines[index].page;
      hoverTarget = null;
      $("#fs-lines", root).innerHTML = pages[page].indices
        .map(
          (n) =>
            `<div class="fs-sentence ${lines[n].text.length > 350 ? "fs-long" : ""}" role="group" tabindex="0" data-fs-line="${n}" data-block="${e(lines[n].block)}" data-start="${lines[n].start}" data-end="${lines[n].end}" aria-label="第 ${n + 1} 句"><span class="fs-line-no">${String(n + 1).padStart(3, "0")}</span><span class="fs-source-text">${markup(lines[n].text, vocabulary, wordPattern, lines[n].scene.words)}</span><i aria-hidden="true">✧</i></div>`,
        )
        .join("");
      $("#fs-lines", root).scrollTop = 0;
    }
    $$("[data-fs-line]", root).forEach((el) => {
      el.classList.toggle("is-active", Number(el.dataset.fsLine) === index);
      el.setAttribute(
        "aria-current",
        String(Number(el.dataset.fsLine) === index),
      );
    });
    $$("[data-fs-act]", root).forEach((el) =>
      el.setAttribute("aria-current", String(Number(el.dataset.fsAct) === act)),
    );
    $("#fs-act-en", root).textContent = acts[act].eyebrow;
    $("#fs-act-title", root).textContent = acts[act].english;
    $("#fs-count", root).textContent =
      `${String(index + 1).padStart(3, "0")} / ${lines.length}`;
    $("#fs-caption-number", root).textContent =
      `${String(act + 1).padStart(2, "0")} · ${acts[act].title}`;
    $("#fs-caption-title", root).textContent =
      lines[index].caption || acts[act].title;
    $("#fs-caption-text", root).textContent =
      lines[index].cue === acts[act].title ? "" : lines[index].cue;
    $("#fs-translation", root).hidden = !chinese;
    $("#fs-translation", root).textContent = lines[index].cue;
    $("#fs-progress", root).value = String(index);
    $("#fs-progress", root).setAttribute(
      "aria-valuetext",
      `第 ${index + 1} 句，共 ${lines.length} 句`,
    );
    $("#fs-page-label", root).textContent =
      `第 ${page + 1} / ${pages.length} 页`;
    $("#fs-prev", root).disabled = index === 0 && chapterIndex <= 0;
    $("#fs-prev", root).setAttribute(
      "aria-label",
      index === 0 && chapterIndex > 0 ? "上一章末句" : "上一句",
    );
    $("#fs-next", root).textContent =
      index === lines.length - 1
        ? chapterIndex < chapters.length - 1
          ? "⇥"
          : "↺"
        : "→";
    $("#fs-next", root).setAttribute(
      "aria-label",
      index === lines.length - 1
        ? chapterIndex < chapters.length - 1
          ? "进入下一章"
          : "全书读完，再读本章"
        : "下一句",
    );
    root.dataset.sentence = String(index);
    root.dataset.act = String(act);
    host.dataset.beat = String(index);
    if (!isFox) {
      const f = lines[index].scene.frame;
      const svg = $(".fs-living-fallback", host);
      svg.setAttribute(
        "viewBox",
        `${(f.cell % 2) * 100} ${Math.floor(f.cell / 2) * 100} 100 100`,
      );
      $("image", svg).setAttribute("href", plan.asset_base + f.file);
      svg.setAttribute("aria-label", f.title);
      const bg = $(".fs-living-backdrop", host);
      bg.style.backgroundImage = `url("${plan.asset_base + f.file}")`;
      bg.style.backgroundPosition = `${(f.cell % 2) * 100}% ${Math.floor(f.cell / 2) * 100}%`;
    }
    host.dataset.pose = lines[index].scene.pose;
    host.dataset.foxHidden = String(!lines[index].scene.fox);
    host.dataset.garden = String(lines[index].scene.garden);
    host.dataset.rose = String(lines[index].scene.rose);
    const w =
      Object.keys(vocabulary).find((w) =>
        new RegExp(`\\b${w}\\b`, "i").test(lines[index].text),
      ) || "";
    wordCard(w);
    root.dataset.word = "";
    $$("[data-fs-word]", root).forEach((el) =>
      el.classList.remove("is-active"),
    );
    scene?.setMoment(lines[index].scene, index);
    root.dataset.page = String(page);
    root.dataset.total = String(lines.length);
    local.set(resumeKey, {
      version: doc.version,
      block: lines[index].block,
      start: lines[index].start,
    });
    if (announce) $("#fs-live", root).textContent = lines[index].text;
    if (announce || !manual) revealLine();
  }
  function revealLine() {
    $(".fs-sentence.is-active", root)?.scrollIntoView({
      block: matchMedia("(max-width: 720px)").matches ? "start" : "nearest",
    });
  }
  function wordCard(word) {
    $("#fs-word-card", root).innerHTML =
      `<span>小小词袋</span><strong>${e(word)}</strong><span>${vocabulary[word]?.[0] || "轻点下划线单词，让角色回应"}</span>`;
  }
  function word(button) {
    if (!button) return;
    const n = Number(button.closest("[data-fs-line]").dataset.fsLine);
    if (n !== index) select(n);
    else {
      clearTimeout(hover);
      stopDemo();
    }
    const w = button.dataset.fsWord;
    wordCard(w);
    root.dataset.word = w;
    scene?.trigger(vocabulary[w]?.[1] || w, w);
    $$("[data-fs-word]", root).forEach((el) =>
      el.classList.toggle("is-active", el === button),
    );
  }
  scope.on($("#fs-lines", root), "pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const target = event.target.closest("[data-fs-line]");
    if (!target || target === hoverTarget) return;
    hoverTarget = target;
    clearTimeout(hover);
    const n = Number(target.dataset.fsLine);
    if (n !== index) hover = setTimeout(() => select(n), 140);
  });
  scope.on($("#fs-lines", root), "pointerleave", () => {
    clearTimeout(hover);
    hoverTarget = null;
  });
  scope.on($("#fs-lines", root), "pointerover", (event) => {
    const b = event.target.closest("[data-fs-word]");
    if (b && event.relatedTarget?.closest?.("[data-fs-word]") !== b) word(b);
  });
  scope.on($("#fs-lines", root), "focusin", (event) => {
    const b = event.target.closest("[data-fs-word]");
    if (b) word(b);
    else {
      const l = event.target.closest("[data-fs-line]");
      if (l) select(Number(l.dataset.fsLine));
    }
  });
  scope.on($("#fs-lines", root), "click", (event) => {
    const b = event.target.closest("[data-fs-word]");
    if (b) word(b);
    else {
      const l = event.target.closest("[data-fs-line]");
      if (l) select(Number(l.dataset.fsLine), { announce: true });
    }
  });
  scope.on($("#fs-lines", root), "keydown", (event) => {
    if (
      event.target.matches("[data-fs-line]") &&
      ["Enter", " "].includes(event.key)
    ) {
      event.preventDefault();
      select(Number(event.target.dataset.fsLine), { announce: true });
    }
  });
  function step(direction) {
    if (direction < 0 && index === 0 && chapterIndex > 0)
      return jumpChapter(chapters[chapterIndex - 1], "end");
    if (
      direction > 0 &&
      index === lines.length - 1 &&
      chapterIndex < chapters.length - 1
    )
      return jumpChapter(chapters[chapterIndex + 1], "start");
    select(
      direction > 0 && index === lines.length - 1 ? 0 : index + direction,
      { announce: true },
    );
  }
  scope.on($("#fs-prev", root), "click", () => step(-1));
  scope.on($("#fs-next", root), "click", () => step(1));
  scope.on(root, "click", (event) => {
    const b = event.target.closest("[data-fs-act]");
    if (b) select(acts[Number(b.dataset.fsAct)].start, { announce: true });
  });
  scope.on($("#fs-progress", root), "input", (event) =>
    select(Number(event.target.value), { announce: true }),
  );
  scope.on($("#fs-chinese", root), "click", (event) => {
    chinese = !chinese;
    event.currentTarget.setAttribute("aria-pressed", String(chinese));
    $("#fs-translation", root).hidden = !chinese;
    if (matchMedia("(max-width: 720px)").matches)
      requestAnimationFrame(() => {
        if (!scope.signal.aborted) revealLine();
      });
  });
  scope.on($("#fs-motion", root), "click", () => {
    stopDemo();
    if (scene) {
      scene.pause(!scene.isPaused());
      updateMotion();
    }
  });
  let comparing = false,
    beforeComparePaused = false;
  if (!isFox)
    scope.on($("#fs-compare", root), "click", (event) => {
      comparing = !comparing;
      stopDemo();
      if (comparing) {
        beforeComparePaused = scene?.isPaused() || false;
        scene?.pause(true);
      } else scene?.pause(beforeComparePaused);
      host.classList.toggle("rose-compare", comparing);
      root.dataset.comparing = String(comparing);
      event.currentTarget.textContent = comparing ? "回到动态绘本" : "看原插画";
      event.currentTarget.setAttribute("aria-pressed", String(comparing));
      $("#fs-motion", root).disabled = comparing || !scene;
      $("#fs-demo", root).disabled = comparing;
      updateMotion();
    });
  scope.on($("#fs-demo", root), "click", () => {
    if (playing) {
      stopDemo();
      return;
    }
    if (index === lines.length - 1) select(0, { manual: false });
    scene?.pause(false);
    updateMotion();
    playing = true;
    root.dataset.playing = "true";
    $("#fs-demo", root).textContent = "Ⅱ 暂停阅读";
    $("#fs-demo", root).setAttribute("aria-pressed", "true");
    const advance = () => {
      if (!playing || scope.signal.aborted) return;
      const delay = Math.max(
        3400,
        Math.min(24000, lines[index].text.split(/\s+/).length * 340),
      );
      timer = setTimeout(() => {
        if (document.hidden) {
          advance();
          return;
        }
        if (index === lines.length - 1) {
          stopDemo();
          return;
        }
        select(index + 1, { manual: false, announce: true });
        advance();
      }, delay);
    };
    advance();
  });
  scope.on(document, "keydown", (event) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      event.target.closest("input,textarea,select,[contenteditable=true]") ||
      $("dialog[open]") ||
      !["ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    step(event.key === "ArrowLeft" ? -1 : 1);
  });
  scope.cleanup(() => {
    clearTimeout(hover);
    clearTimeout(timer);
    scene?.dispose();
    document.body.classList.remove("fox-story-reading");
    css.remove();
  });
  select(
    initialEdge === "end"
      ? lines.length - 1
      : initialEdge === "start"
        ? 0
        : resume >= 0
          ? resume
          : 0,
  );
  try {
    const createScene = isFox
      ? (await import("./picturebook-fox-reading-scene.js"))
          .createFoxReadingScene
      : isRose
        ? (await import("./picturebook-rose-scene.js")).createRoseScene
        : (await import("./picturebook-cast-scene.js")).createCastScene;
    if (scope.signal.aborted) return;
    scene = await createScene({
      casts: chapter.casts,
      frames: plan.frames,
      assetBase: plan.asset_base,
      host,
      signal: scope.signal,
      onError(message) {
        if (!scope.signal.aborted) $("#fs-status", root).textContent = message;
      },
    });
    if (scope.signal.aborted) {
      scene?.dispose();
      return;
    }
    if (scene) {
      if (comparing) scene.pause(true);
      $("#fs-status", root).textContent = "";
      scene.setMoment(lines[index].scene, index);
      updateMotion();
    } else $("#fs-motion", root).disabled = true;
  } catch {
    if (!scope.signal.aborted) {
      $("#fs-status", root).textContent =
        "动态画面暂时无法打开，绘本和文字仍可继续阅读。";
      $("#fs-motion", root).disabled = true;
    }
  }
}
