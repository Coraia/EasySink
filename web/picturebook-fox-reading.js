import { $, $$, e, api, local } from "./core.js";
import {
  buildFoxChapter,
  vocabulary as foxVocabulary,
} from "./picturebook-fox-chapter.js";

import {
  buildCastChapter,
  castVocabulary,
} from "./picturebook-cast-chapter.js";

import {
  buildRoseChapter,
  roseVocabulary,
} from "./picturebook-rose-chapter.js";

import {
  learningMarkup,
  learningNote,
  createReadingSpeech,
} from "./picturebook-assistance.js";
import { openChildrenPlan } from "./reading-spaces.js";

const chapterStarts = new Map();

export async function mountFoxReading(ctx, scope, id) {
  const docId = /^\d+$/.test(id || "") ? Number(id) : null;
  const back = "#/children";
  ctx.root.innerHTML = `<div class="card"><p>正在展开《小王子》的画页…</p><a href="${back}">返回少儿书架</a></div>`;
  let doc, chapter, plan, dictionary;
  try {
    if (!docId) throw new Error("请从《小王子》完整英文版进入动态绘本。");
    const results = await Promise.all([
      api(`/documents/${docId}?compact=true`, { signal: scope.signal }),
      api(`/documents/${docId}/illustrations`, { signal: scope.signal }),
    ]);
    doc = results[0];
    plan = results[1].story_plan;
    dictionary = results[1].vocabulary || {};
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
      ctx.root.innerHTML = `<div class="card"><h2>这一章暂时无法打开</h2><p>${e(error.message)}</p><a href="${back}">返回少儿书架</a></div>`;
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
  ctx.root.innerHTML = `
    <main class="fox-story ${isRose ? "rose-chapter" : ""}" data-doc="${docId}" data-chapter="${plan.chapter}">
      <header class="fs-header">
        <a class="fs-brand" href="#/children" aria-label="返回少儿书架"><span aria-hidden="true">←</span> 少儿书架</a>
        <nav class="fs-chapters" aria-label="全书章节">
          <button id="fs-chapter-prev" ${chapterIndex <= 0 ? "disabled" : ""} aria-label="上一章">‹</button>
          <label><span>小王子</span><select id="fs-chapter-select" aria-label="选择章节">${chapters.map((c) => `<option value="${c.doc_id}" ${c.doc_id === docId ? "selected" : ""}>${e(c.title)}</option>`).join("")}</select></label>
          <button id="fs-chapter-next" ${chapterIndex >= chapters.length - 1 ? "disabled" : ""} aria-label="下一章">›</button>
        </nav>
        <button id="fs-parent" class="fs-original">家长区 ↗</button>
      </header>
      <section class="fs-book" aria-label="小王子的动态绘本阅读">
        <div class="fs-art-panel"><div class="fs-stage" id="fs-stage"><div class="fs-fallback"><img class="fs-boy" src="/static/assets/picturebook-lookdev-v2/prince.png" alt="金发绿衣的小王子"><img class="fs-fox" src="/static/assets/picturebook-lookdev-v2/fox.png" alt="金色草丛中的狐狸"><img class="fs-friends" src="/static/assets/picturebook-fox-reading/friends-seated.png" alt="小王子与狐狸坐在一起"><img class="fs-rose" src="/static/assets/picturebook-fox-reading/rose.png" alt="小王子的玫瑰"></div></div><div class="fs-art-top">${!isFox ? '<button id="fs-compare" aria-pressed="false">看原插画</button>' : "<span>✧ THE LITTLE WONDERS</span>"}<button id="fs-motion" aria-pressed="false">暂停动作</button></div><div class="fs-caption"><span id="fs-caption-number">01 · 狐狸出现</span><h1 id="fs-caption-title">一声问候，一段友谊。</h1><p id="fs-caption-text"></p></div></div>
        <div class="fs-paper">
          <div class="fs-reading-heading">
            <div><div class="fs-paper-top"><span id="fs-act-en"></span></div><h2 id="fs-act-title"></h2></div>
            <details class="fs-reading-options">
              <summary>阅读设置 <span aria-hidden="true">☷</span></summary>
              <div class="fs-learning-tools">
                <label>词语提示<select id="fs-assistance" aria-label="词注多少"><option value="more">更多词注</option><option value="less">少些词注</option></select></label>
                <label>朗读语速<select id="fs-rate" aria-label="朗读语速"><option value="0.7">慢速</option><option value="0.85" selected>稍慢</option><option value="1">正常</option></select></label>
                <button id="fs-chinese" aria-pressed="false">中 · 情节提示</button>
                <button id="fs-demo" aria-pressed="false">▷ 自动阅读</button>
              </div>
            </details>
          </div>
          <div id="fs-lines" lang="en" aria-label="点击词语查义，用方向键逐句阅读"></div>
          <div class="fs-help"><p id="fs-translation" hidden></p></div>
          <div class="fs-bottom">
            <button id="fs-prev" aria-label="上一句">←</button>
            <label class="fs-progress-label"><span class="fs-sr">跳到句子</span><input id="fs-progress" type="range" min="0" max="${lines.length - 1}" value="0" aria-label="跳到句子"></label>
            <span id="fs-count"></span>
            <button id="fs-next" aria-label="下一句">→</button>
          </div>
          <aside class="fs-listen-dock" aria-label="固定发音栏">
            <div id="fs-word-card">
              <small id="fs-word-label">点选正文里的词，查看意思和发音</small>
              <div><strong id="fs-word-text">选一个词</strong><span class="fs-word-meaning"></span></div>
              <small id="fs-word-phonetic" lang="en"></small>
            </div>
            <div class="fs-speech-tools">
              <button id="fs-word-speak" disabled aria-label="先在原文点选一个词" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 5.5 9H2v6h3.5l5.5 4Z"/><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></svg><span data-speech-label>听这个词</span></button>
              <button id="fs-speak" aria-pressed="false" aria-label="听当前这一句"><span aria-hidden="true">▷</span> <span data-speech-label>听这一句</span></button>
            </div>
            <p id="fs-audio-status" role="status"></p>
          </aside>
          <p id="fs-status" role="status">正在展开画页…</p>
        </div>
      </section>
      <footer class="fs-footer">
        <nav aria-label="故事情节">${acts.map((a, i) => `<button data-fs-act="${i}" aria-current="${i === 0}"><span>${String(i + 1).padStart(2, "0")}</span>${a.title}</button>`).join("")}</nav>
        <span id="fs-page-label"></span>
      </footer>
      <details class="fs-source fs-edition"><summary>英文版本与插画来源</summary><p>原著 ${e(plan.source.author)} · 英译 ${e(plan.source.translator)} · ${e(plan.source.publisher)} ${plan.source.year} · <a href="${e(plan.source.source_url)}" target="_blank" rel="noreferrer">版本来源</a> · <a href="${e(plan.source.license_url)}" target="_blank" rel="noreferrer">CC BY-NC 3.0</a></p><p>保留书库中全部英文措辞与拼写。中文标题和提示为阅读引导；AI 手绘插画配合局部形变、灯光与角色动画。同一关键情节内共用画面，句子和重点单词驱动局部回应。</p><p lang="en">${e(plan.source.changes)}</p><h3>原书献词</h3><p lang="en">${e(plan.source.dedication.replace(/ +/g, " "))}</p></details>
      <div class="fs-sr" id="fs-live" role="status" aria-live="polite"></div>
    </main>`;
  const root = $(".fox-story", ctx.root),
    host = $("#fs-stage", root);
  let moreNotes = local.get("picturebook-assistance", "more") !== "less",
    cardWord = "";
  $("#fs-assistance", root).value = moreNotes ? "more" : "less";
  const speech = createReadingSpeech(scope, (state, key, engine, error) => {
    root.dataset.audioState = state;
    root.dataset.audioKey = key;
    if (engine) root.dataset.speechEngine = engine;
    const active = state === "loading" || state === "playing";
    for (const [selector, own, idle] of [
      ["#fs-speak", "sentence", "听这一句"],
      ["#fs-word-speak", "word", "听这个词"],
    ]) {
      const button = $(selector, root);
      if (!button) continue;
      const selected = active && key === own;
      $("[data-speech-label]", button).textContent = selected
        ? state === "loading"
          ? "取消发音"
          : "停止播放"
        : idle;
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", own === "word"
        ? cardWord ? `${selected ? state === "loading" ? "取消准备" : "停止播放" : "听单词"} ${cardWord}` : "先在原文点选一个词"
        : selected ? "停止整句播放" : "听当前这一句");
    }
    $("#fs-audio-status", root).textContent =
      error || (state === "loading" ? "正在准备发音…" : state === "playing" ? key === "word" ? `正在读：${cardWord}` : "正在读当前这一句" : "");
  });
  scope.on($("#fs-speak", root), "click", () => {
    stopDemo();
    speech.toggle(
      lines[index].text,
      "sentence",
      Number($("#fs-rate", root).value),
    );
  });
  const savedRate = Number(local.get("picturebook-rate", 0.85));
  $("#fs-rate", root).value = String([0.7, 0.85, 1].includes(savedRate) ? savedRate : 0.85);
  scope.on($("#fs-rate", root), "change", event => {
    local.set("picturebook-rate", Number(event.target.value));
    speech.stop();
  });
  const readingOptions = $(".fs-reading-options", root);
  scope.on(document, "click", event => {
    if (readingOptions.open && !readingOptions.contains(event.target))
      readingOptions.open = false;
  });
  scope.on(readingOptions, "keydown", event => {
    if (event.key === "Escape") {
      readingOptions.open = false;
      $("summary", readingOptions).focus();
      event.stopPropagation();
    }
  });
  scope.on($("#fs-parent", root), "click", () => {
    stopDemo();
    speech.stop();
    openChildrenPlan();
  });
  scope.on($("#fs-assistance", root), "change", (event) => {
    moreNotes = event.target.value === "more";
    local.set("picturebook-assistance", moreNotes ? "more" : "less");
    page = -1;
    select(index);
  });
  scope.on($("#fs-word-speak", root), "click", () => {
    if (!cardWord) return;
    stopDemo();
    speech.toggle(cardWord, "word", Number($("#fs-rate", root).value));
  });
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
    playing = false;
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
    speech.stop();
    if (manual) stopDemo();
    index = Math.max(0, Math.min(lines.length - 1, next));
    act = lines[index].act;
    if (lines[index].page !== page) {
      page = lines[index].page;
      $("#fs-lines", root).innerHTML = pages[page].indices
        .map(
          (n) =>
            `<div class="fs-sentence ${lines[n].text.length > 350 ? "fs-long" : ""}" role="group" tabindex="0" data-fs-line="${n}" data-block="${e(lines[n].block)}" data-start="${lines[n].start}" data-end="${lines[n].end}" aria-label="第 ${n + 1} 句"><span class="fs-line-no">${String(n + 1).padStart(3, "0")}</span><span class="fs-source-text">${learningMarkup(lines[n].text, vocabulary, dictionary, plan.chapter, moreNotes)}</span><i aria-hidden="true">✧</i></div>`,
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
    if (isFox || isRose) {
      let label = $(".fs-context-label", host);
      if (!label) {
        label = document.createElement("span");
        label.className = "fs-context-label cast-scene-label";
        host.append(label);
      }
      label.textContent = lines[index].scene.label || "";
      label.hidden = !label.textContent;
    }
    host.dataset.pose = lines[index].scene.pose;
    host.dataset.foxHidden = String(!lines[index].scene.fox);
    host.dataset.garden = String(lines[index].scene.garden);
    host.dataset.rose = String(lines[index].scene.rose);
    wordCard("");
    root.dataset.word = "";
    $$("[data-fs-word]", root).forEach((el) =>
      el.classList.remove("is-active"),
    );
    scene?.setMoment(lines[index].scene, index);
    host.dataset.sourceState =
      lines[index].scene.sourceState || lines[index].scene.key;
    root.dataset.page = String(page);
    root.dataset.total = String(lines.length);
    local.set(resumeKey, {
      version: doc.version,
      block: lines[index].block,
      start: lines[index].start,
      updated_at: Date.now(),
    });
    if (doc.chapter?.book_id) local.set(`children-book-chapter:${doc.chapter.book_id}`, docId);
    if (announce) $("#fs-live", root).textContent = lines[index].text;
    if (announce || !manual) revealLine();
  }
  function revealLine() {
    $(".fs-sentence.is-active", root)?.scrollIntoView({
      block: matchMedia("(max-width: 720px)").matches ? "start" : "nearest",
    });
  }
  function wordCard(word) {
    cardWord = word;
    const fullNote = learningNote(
      word,
      vocabulary,
      dictionary,
      plan.chapter,
      lines[index].text,
    );
    const note = fullNote.split(" / ")[0];
    $("#fs-word-label", root).textContent = word ? "已选词 · 点选其他词可更换" : "点选正文里的词，查看意思和发音";
    $("#fs-word-text", root).textContent = word || "选一个词";
    $(".fs-word-meaning", root).textContent = note || (word ? "正在查词…" : "");
    $("#fs-word-phonetic", root).textContent = dictionary[word]?.phonetic ? `/${dictionary[word].phonetic}/` : "";
    const speakButton = $("#fs-word-speak", root);
    speakButton.disabled = !word;
    const own = root.dataset.audioKey === "word" && ["loading", "playing"].includes(root.dataset.audioState);
    speakButton.setAttribute("aria-label", word ? `${own ? "停止播放" : "听单词"} ${word}` : "先在原文点选一个词");
    if (word && !note)
      api("/lookup", {
        method: "POST",
        body: { word, mark_unknown: false },
        signal: scope.signal,
      })
        .then((result) => {
          dictionary[word] = {
            note: result.note || "词典暂未收录这个词",
            phonetic: result.phonetic,
            rank: result.rank,
          };
          if (!scope.signal.aborted && cardWord === word) wordCard(word);
        })
        .catch((error) => {
          if (!scope.signal.aborted && cardWord === word)
            $(".fs-word-meaning", root).textContent = error.message;
        });
  }
  function word(button) {
    if (!button) return;
    const n = Number(button.closest("[data-fs-line]").dataset.fsLine);
    if (n !== index) select(n);
    else stopDemo();
    const w = button.dataset.fsWord;
    if (w !== cardWord) {
      speech.stop();
      wordCard(w);
    }
    root.dataset.word = w;
    if (
      vocabulary[w] &&
      (!lines[index].scene.words || lines[index].scene.words.includes(w))
    )
      scene?.trigger(vocabulary[w][1], w);
    $$("[data-fs-word]", root).forEach((el) =>
      el.classList.toggle("is-active", el === button),
    );
  }
  // Scrolling, hovering and keyboard focus never change the selected word or
  // sentence. Native button click handles mouse, touch and Enter/Space equally.
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
    if (event.key === "Escape" && !$("dialog[open]")) {
      speech.stop();
      wordCard("");
      root.dataset.word = "";
      $$("[data-fs-word]", root).forEach(el => el.classList.remove("is-active"));
      return;
    }
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
