import { $, $$, e, api, local, busy, toast } from "./core.js";
import { scenes, storyText, storyTitle } from "./picturebook-story.js";
import { mountStoryArt } from "./picturebook-art.js";
import { mountFoxExperiment } from "./picturebook-3d.js";

const asset = new URL(
  "./assets/picturebook/little-prince-atlas.webp",
  import.meta.url,
).href;
const star =
  '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m16 2 3.8 9.8L30 16l-10.2 4.2L16 30l-3.8-9.8L2 16l10.2-4.2Z" fill="currentColor"/></svg>';
const editionButtons = () =>
  '<div class="edition-switch" role="group" aria-label="阅读版本"><button data-edition="standard">普通版</button><button data-edition="kids">✦ 少儿版</button></div>';
const artStyle = (index) =>
  `--pb-art:url('${asset}');--pb-x:${(index % 3) * 50}%;--pb-y:${index < 3 ? 0 : 100}%`;

function sentences(doc) {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return doc.blocks.flatMap((block, blockIndex) =>
    [...segmenter.segment(block.text || "")]
      .filter((part) => part.segment.trim())
      .map((part) => ({
        text: part.segment.trim(),
        block: block.id,
        blockIndex,
        start: part.index + part.segment.indexOf(part.segment.trim()),
      })),
  );
}
function atmosphere(text, index) {
  const themes = [
    /star|planet|moon|night|sky/i,
    /rose|flower|garden|water/i,
    /bird|fly|flew|wind|travel/i,
    /desert|sand|pilot|sun|morning/i,
    /fox|friend|tree|grass|forest/i,
  ];
  const found = themes.findIndex((pattern) => pattern.test(text));
  return found < 0 ? index % 6 : found;
}

export function installPicturebook(ctx) {
  ctx.route("fox-story", async (scope, id) => {
    const { mountFoxReading } = await import("./picturebook-fox-reading.js");
    if (!scope.signal.aborted) await mountFoxReading(ctx, scope, id);
  });
  ctx.route("living-book", async (scope, id) => {
    const { mountFoxReading } = await import("./picturebook-fox-reading.js");
    if (!scope.signal.aborted) await mountFoxReading(ctx, scope, id);
  });
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./picturebook.css", import.meta.url).href;
  document.head.append(css);
  const enabled = () => local.get("edition", "standard") === "kids";
  const sync = () => {
    document.body.dataset.edition = enabled() ? "kids" : "standard";
    $$("[data-edition]").forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.edition === (enabled() ? "kids" : "standard")),
      ),
    );
  };
  const change = (value) => {
    if (value === (enabled() ? "kids" : "standard")) return;
    local.set("edition", value);
    sync();
    if (value === "standard" && location.hash.startsWith("#/picturebook/"))
      ctx.navigate(location.hash.replace("#/picturebook/", "#/read/"));
    else ctx.refresh();
  };
  $(".top-actions").insertAdjacentHTML("afterbegin", editionButtons());
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-edition]");
    if (button) change(button.dataset.edition);
  });
  sync();

  ctx.hook("home", ({ scope, documents }) => {
    const welcome = $(".welcome");
    const teaser = document.createElement("section");
    teaser.className = "pb-invitation";
    teaser.innerHTML = `<div class="pb-invitation-art" style="${artStyle(0)}" role="img" aria-label="小王子站在自己的小星球上仰望星空"></div><div class="pb-invitation-copy"><span class="pb-eyebrow">LITTLE READERS, BIG WORLDS</span><h2>把英文，读成一场奇遇。</h2><p>跟着完整英文原文，走过小王子的每一次相遇。停在故事里，让画面随情节展开。</p><button class="pb-primary" id="open-full-picturebook">${star} 阅读《小王子》全书 <span>↗</span></button><button class="pb-short-demo" id="try-picturebook">先看 6 幕短篇体验</button><small>27 章完整英文 · 60 幅关键情节插画 · 动态阅读</small></div>`;
    if (enabled()) welcome.replaceWith(teaser);
    else welcome.after(teaser);
    scope.on($("#open-full-picturebook"), "click", (event) =>
      busy(
        event.currentTarget,
        async () => {
          const result = await api("/picturebook/little-prince/install", {
            method: "POST",
          });
          if (scope.signal.aborted) return;
          local.set("edition", "kids");
          sync();
          ctx.navigate(`#/living-book/${result.doc_id}`);
        },
        "正在准备全书…",
      ).catch(() => {}),
    );
    scope.on($("#try-picturebook"), "click", (event) =>
      busy(
        event.currentTarget,
        async () => {
          let doc;
          const savedId = local.get("picturebook-demo");
          if (documents.some((item) => item.id === savedId)) {
            const existing = await api(`/documents/${savedId}?compact=true`, {
              signal: scope.signal,
            });
            if (
              sentences(existing)
                .map((line) => line.text)
                .join(" ") ===
              scenes
                .flatMap((scene) => scene.lines.map((line) => line[0]))
                .join(" ")
            )
              doc = existing;
          }
          if (!doc)
            doc = await api("/documents", {
              method: "POST",
              body: { title: storyTitle, text: storyText },
              signal: scope.signal,
            });
          if (scope.signal.aborted) return;
          local.set("picturebook-demo", doc.id);
          local.set("edition", "kids");
          sync();
          ctx.navigate(`#/read/${doc.id}`);
        },
        "正在打开星球…",
      ).catch(() => {}),
    );
    sync();
  });

  function readerSwitch(reader) {
    const control = document.createElement("div");
    control.className = "pb-reader-switch";
    control.innerHTML = editionButtons();
    $(".reader").append(control);
    reader.scope.on(control, "pointerdown", (event) => event.stopPropagation());
    sync();
  }

  async function mount(doc, scope) {
    const all = sentences(doc);
    const demo =
      all.map((line) => line.text).join(" ") ===
      scenes.flatMap((scene) => scene.lines.map((line) => line[0])).join(" ");
    const illustrationStatus = !demo
      ? await api(`/documents/${doc.id}/illustrations`, {
          signal: scope.signal,
        }).catch(() => null)
      : null;
    if (scope.signal.aborted) return;
    const plan = illustrationStatus?.story_plan;
    const frameFor = (index) =>
      plan?.frames.findLast(
        (frame) =>
          frame.paragraph < all[index].blockIndex ||
          (frame.paragraph === all[index].blockIndex &&
            frame.start <= all[index].start),
      );
    const spreads = [];
    for (let index = 0; index < all.length; index += 3) {
      const lines = all.slice(index, index + 3);
      const position = index / 3;
      spreads.push({
        ...(demo
          ? scenes[position]
          : {
              title: plan ? plan.title : `故事的第 ${position + 1} 幕`,
              en: plan ? plan.en : "A page of your story",
              art: atmosphere(
                lines.map((line) => line.text).join(" "),
                position,
              ),
              color: "#546b60",
            }),
        lines,
      });
    }
    if (!spreads.length) {
      ctx.root.innerHTML =
        '<div class="page"><h1>这里还没有可阅读的文字</h1><p>先在普通版准备好英文正文，再来开启绘本。</p><button data-edition="standard">回到普通版</button><a class="button" href="#/">返回书架</a></div>';
      sync();
      return;
    }
    const key = `picturebook-position:${doc.id}`;
    const saved = local.get(key, {});
    let page = Math.max(
      0,
      Math.min(spreads.length - 1, Number(saved.page) || 0),
    );
    let line = Math.max(
      0,
      Math.min(spreads[page].lines.length - 1, Number(saved.line) || 0),
    );
    let chinese = local.get("picturebook-chinese", false),
      hoverTimer,
      speech = null;
    let turnPointer = null;
    const chapters = doc.chapters || [];
    const chapterIndex = chapters.findIndex(
      (chapter) => chapter.doc_id === doc.id,
    );
    const previousChapter = chapters[chapterIndex - 1];
    const nextChapter = chapters[chapterIndex + 1];
    function jumpChapter(chapter, end = false) {
      local.set(`picturebook-position:${chapter.doc_id}`, {
        page: end ? Number.MAX_SAFE_INTEGER : 0,
        line: end ? Number.MAX_SAFE_INTEGER : 0,
      });
      ctx.navigate(`#/read/${chapter.doc_id}`);
    }
    const chapterPicker =
      chapters.length > 1
        ? `<select id="pb-chapter" aria-label="选择章节">${chapters.map((chapter) => `<option value="${Number(chapter.doc_id)}" ${chapter.doc_id === doc.id ? "selected" : ""}>${e(chapter.title)}</option>`).join("")}</select>`
        : "";
    document.body.classList.add("picturebook-reading");
    ctx.root.innerHTML = `<div class="picturebook" data-ready="true" data-demo="${demo}">
      <header class="pb-header"><a href="#/" class="pb-brand" aria-label="返回书架">${star}<span>wise reader<small>小小读者，大大世界。</small></span></a><div class="pb-header-middle">THE PICTURE BOOK EDITION <span>少儿绘本</span></div>${editionButtons()}</header>
      <div class="pb-bookline"><a href="#/">← 我的书架</a><span>${e(doc.title)}</span>${chapterPicker}<span class="pb-saved">● 进度自动保存在本机</span></div>
      <section class="pb-spread" aria-label="绘本阅读"><div class="pb-art-wrap"><div class="pb-art" role="img"></div><div class="pb-art-grain"></div><div class="pb-art-badge">${star}<span>THE LITTLE WONDERS</span></div><div class="pb-art-caption"><span id="pb-scene-number"></span><h1 id="pb-scene-title"></h1><p id="pb-scene-en" lang="en"></p></div><span class="pb-art-note">${demo ? "小王子 · 原创改写绘本" : "原文逐句阅读 · 氛围配图"}</span></div>
      <div class="pb-paper"><div class="pb-paper-top"><span class="pb-eyebrow">LET THE STORY UNFOLD</span><span id="pb-page-number"></span></div><div class="pb-read-heading"><span class="pb-mini-star">✧</span><h2>让故事，慢慢发生。</h2><p>停在一句英文上，看看画里发生了什么。</p></div><div id="pb-lines" class="pb-lines" lang="en" aria-label="悬浮或点击句子推进绘本"></div><div class="pb-understanding"><p id="pb-translation" lang="zh-CN" hidden></p><div id="pb-word" class="pb-word"></div></div><div class="pb-reading-tools"><button id="pb-speak" aria-label="朗读当前句">▷ <span>听这一句</span></button>${demo ? '<button id="pb-chinese" aria-pressed="false">中 <span>中文提示</span></button>' : '<span class="pb-generic-hint">保留你的英文原文</span>'}</div><div class="pb-turn"><button id="pb-prev" aria-label="上一幕">←</button><div><span id="pb-line-progress"></span><small>悬浮 / 点击句子 · ← → 逐句探索</small></div><button id="pb-next" aria-label="下一幕">→</button></div></div></section>
      <footer class="pb-footer"><div><span class="pb-eyebrow">${demo ? "A LITTLE JOURNEY" : "YOUR STORY JOURNEY"}</span><h2>${demo ? "每一次靠近，都是新的发现。" : "一步一步，走进你的故事。"}</h2></div><nav id="pb-scenes" aria-label="绘本场景目录"></nav><p>${demo ? "据《小王子》主题原创英文改写<br>六幕小故事，送给永远好奇的你。" : "插画为主题氛围示意<br>故事内容以英文原文为准。"}</p></footer>
      <div id="pb-announcement" class="pb-sr-only" role="status" aria-live="polite"></div></div>`;
    sync();
    const root = $(".picturebook");
    $(".pb-turn", root).insertAdjacentHTML(
      "beforebegin",
      '<div class="pb-art-controls"><span id="pb-art-status" role="status">正在打开故事画面…</span><button id="pb-generate">生成本幕插画</button><a id="pb-art-settings" href="#/ai" hidden>插画设置</a><p id="pb-art-message" hidden></p></div>',
    );
    if (plan) {
      root.dataset.fullBook = "true";
      $(".pb-read-heading h2", root).textContent = plan.title.replace(
        /^\d+ · /,
        "",
      );
      $(".pb-read-heading p", root).textContent =
        "完整英文逐句阅读 · 画面在关键情节处变化";
      $(".pb-footer > p", root).innerHTML =
        `英文译者 ${e(plan.source.translator)}<br>${e(plan.source.publisher)} · ${plan.source.year} · <a href="${e(plan.source.license_url)}" target="_blank" rel="noreferrer">${e(plan.source.license)}</a>`;
      root.insertAdjacentHTML(
        "beforeend",
        `<details class="pb-source"><summary>关于这个英文版本与插画</summary><p>原著：${e(plan.source.author)}。英文译者：${e(plan.source.translator)}。${e(plan.source.publisher)}，${plan.source.year}，ISBN ${e(plan.source.isbn)}。<a href="${e(plan.source.source_url)}" target="_blank" rel="noreferrer">查看英文版本来源</a> · <a href="${e(plan.source.license_url)}" target="_blank" rel="noreferrer">CC BY-NC 3.0 许可</a>。</p><p>全书 27 章英文正文，60 幅 AI 生成的关键情节插画。同一情节中的句子共用画面；进入新情节时换图。保留来源措辞与拼写，仅合并原页排版空白和拆开的首字母。中文标题为阅读引导。</p><p lang="en">${e(plan.source.changes)}</p><h3>原书献词</h3><p lang="en" class="pb-dedication">${e(plan.source.dedication.replace(/ +/g, " "))}</p></details>`,
      );
    }
    const storyArt = mountStoryArt({
      root,
      doc,
      scope,
      all,
      demo,
      initialStatus: illustrationStatus,
      plan,
      onFrame(frame) {
        if (!plan) return;
        $("#pb-scene-number", root).textContent =
          `CHAPTER ${plan.chapter} / ${plan.chapter_count} · 情节 ${plan.frames.indexOf(frame) + 1} / ${plan.frames.length}`;
        $("#pb-scene-title", root).textContent = frame.title;
        $("#pb-scene-en", root).textContent = plan.en;
      },
    });
    if (plan) {
      $(".pb-read-heading", root).insertAdjacentHTML(
        "beforeend",
        `<a class="pb-primary" style="margin-top:12px;font-size:11px" href="#/living-book/${doc.id}">✦ 动态绘本：完整英文与画面互动 ↗</a>`,
      );
    }
    const experiment =
      plan?.chapter === 21
        ? mountFoxExperiment({
            root,
            scope,
            onFirstPage(first) {
              if (first) {
                page = 0;
                line = 0;
              }
              draw();
            },
            onSelectLine(index) {
              select(index);
            },
          })
        : null;
    const stopSpeech = () => {
      if (speech) {
        window.speechSynthesis?.cancel();
        speech = null;
      }
      const button = $("#pb-speak", root);
      if (button) {
        button.innerHTML = "▷ <span>听这一句</span>";
        button.setAttribute("aria-pressed", "false");
      }
    };
    function active(announce = false) {
      const spread = spreads[page];
      $$("[data-pb-line]", root).forEach((button, index) => {
        button.classList.toggle("is-active", index === line);
        button.setAttribute("aria-current", String(index === line));
      });
      root.dataset.page = page;
      root.dataset.line = line;
      storyArt.show(page * 3 + line);
      experiment?.show(page, page * 3 + line);
      if (plan) {
        const frame = frameFor(page * 3 + line);
        $$("[data-pb-event]", root).forEach((button, index) =>
          button.setAttribute(
            "aria-current",
            String(plan.frames[index] === frame),
          ),
        );
      }
      const detail = demo
        ? spread.lines[line] && scenes[page].lines[line]
        : null;
      $("#pb-translation", root).hidden = !chinese || !detail;
      $("#pb-translation", root).textContent = detail?.[1] || "";
      $("#pb-word", root).innerHTML = detail
        ? `<span>小小词袋</span><strong>${e(detail[2])}</strong><span>${e(detail[3])}</span>`
        : "<span>把光标停在下一句，继续走进故事。</span>";
      $("#pb-line-progress", root).innerHTML =
        spread.lines
          .map(
            (_, index) => `<i class="${index <= line ? "is-read" : ""}"></i>`,
          )
          .join("") + `<span>${line + 1} / ${spread.lines.length} 句</span>`;
      local.set(key, { page, line });
      if (announce)
        $("#pb-announcement", root).textContent = spread.lines[line].text;
      stopSpeech();
    }
    function draw() {
      const spread = spreads[page];
      root.style.setProperty("--pb-accent", spread.color);
      $(".pb-art", root).setAttribute("style", artStyle(spread.art));
      $(".pb-art", root).setAttribute(
        "aria-label",
        demo
          ? `${spread.title}：${spread.lines.map((_, index) => scenes[page].lines[index][1]).join("")}`
          : "根据篇章主题选取的绘本氛围插画",
      );
      $("#pb-scene-number", root).textContent =
        `${plan ? "READING PAGE" : "SCENE"} ${String(page + 1).padStart(2, "0")} / ${String(spreads.length).padStart(2, "0")}`;
      $("#pb-scene-title", root).textContent = spread.title;
      $("#pb-scene-en", root).textContent = spread.en;
      $("#pb-page-number", root).textContent =
        `${page + 1} / ${spreads.length}${plan ? " 页 · 第 " + plan.chapter + " / 27 章" : ""}`;
      $("#pb-lines", root).innerHTML = spread.lines
        .map((sentence, index) => {
          const live = page === 0 && experiment?.active();
          const tag = live ? "div" : "button";
          return `<${tag} class="pb-sentence" data-pb-line="${index}" ${live ? 'role="group" tabindex="0"' : ""}><span class="pb-line-num">${String(index + 1).padStart(2, "0")}</span><span>${live ? experiment.markup(sentence.text) : e(sentence.text)}</span><span class="pb-line-spark" aria-hidden="true">✧</span></${tag}>`;
        })
        .join("");
      $("#pb-prev", root).disabled = page === 0 && !previousChapter;
      $("#pb-prev", root).setAttribute(
        "aria-label",
        page === 0 && previousChapter ? "上一章" : "上一阅读页",
      );
      $(".pb-turn small", root).textContent =
        page === spreads.length - 1 && nextChapter
          ? "本章读完了 · 点击 → 继续下一章"
          : "悬浮 / 点击句子 · ← → 逐句探索";
      $("#pb-next", root).textContent =
        page === spreads.length - 1 && !nextChapter ? "↺" : "→";
      $("#pb-next", root).setAttribute(
        "aria-label",
        page === spreads.length - 1
          ? nextChapter
            ? "下一章"
            : "故事读完了，再读一遍"
          : "下一阅读页",
      );
      const start = Math.max(0, Math.min(page - 2, spreads.length - 6));
      $("#pb-scenes", root).setAttribute(
        "aria-label",
        plan ? "本章关键情节目录" : "绘本场景目录",
      );
      $("#pb-scenes", root).innerHTML = plan
        ? plan.frames
            .map(
              (frame, index) =>
                `<button data-pb-event="${index}" aria-label="关键情节 ${index + 1}：${e(frame.title)}" title="${e(frame.title)}"><span class="pb-thumb" style="--pb-art:url('${plan.asset_base + frame.file}');--pb-x:${(frame.cell % 2) * 100}%;--pb-y:${frame.cell >= 2 ? 100 : 0}%;background-size:200% 200%"></span><span>${String(index + 1).padStart(2, "0")}</span></button>`,
            )
            .join("")
        : spreads
            .slice(start, start + 6)
            .map(
              (scene, index) =>
                `<button data-pb-scene="${start + index}" aria-label="第 ${start + index + 1} 幕：${e(scene.title)}" aria-current="${page === start + index}"><span class="pb-thumb" style="${artStyle(scene.art)}"></span><span>${String(start + index + 1).padStart(2, "0")}</span></button>`,
            )
            .join("");
      active();
    }
    function select(index, announce = false) {
      clearTimeout(hoverTimer);
      if (index === line) return;
      line = index;
      active(announce);
    }
    function turn(next, focus = false) {
      clearTimeout(hoverTimer);
      page = Math.max(0, Math.min(spreads.length - 1, next));
      line = 0;
      // Prevent newly drawn text under a stationary cursor from advancing itself.
      turnPointer = null;
      draw();
      $("#pb-announcement", root).textContent =
        `${spreads[page].title}，第 ${page + 1} 阅读页，共 ${spreads.length} 页`;
      if (focus) $("[data-pb-line]", root).focus({ preventScroll: true });
    }
    scope.on($("#pb-lines", root), "pointermove", (event) => {
      if (event.pointerType === "touch") return;
      const target = event.target.closest("[data-pb-line]");
      if (!target || turnPointer === target) return;
      turnPointer = target;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => select(Number(target.dataset.pbLine)), 160);
    });
    scope.on($("#pb-lines", root), "pointerleave", () => {
      clearTimeout(hoverTimer);
      turnPointer = null;
    });
    scope.on($("#pb-lines", root), "click", (event) => {
      const button = event.target.closest("[data-pb-line]");
      if (button) select(Number(button.dataset.pbLine), true);
    });
    scope.on($("#pb-lines", root), "focusin", (event) => {
      const button = event.target.closest("[data-pb-line]");
      if (button) select(Number(button.dataset.pbLine));
    });
    scope.on($("#pb-prev", root), "click", () => {
      if (page === 0 && previousChapter) jumpChapter(previousChapter, true);
      else turn(page - 1);
    });
    scope.on($("#pb-next", root), "click", () => {
      if (page === spreads.length - 1 && nextChapter) jumpChapter(nextChapter);
      else if (page === spreads.length - 1 && plan && chapters[0])
        jumpChapter(chapters[0]);
      else turn(page === spreads.length - 1 ? 0 : page + 1);
    });
    scope.on($("#pb-scenes", root), "click", (event) => {
      const eventButton = event.target.closest("[data-pb-event]");
      if (eventButton) {
        clearTimeout(hoverTimer);
        turnPointer = null;
        const frame = plan.frames[Number(eventButton.dataset.pbEvent)];
        const index = all.findIndex(
          (sentence) =>
            sentence.blockIndex > frame.paragraph ||
            (sentence.blockIndex === frame.paragraph &&
              sentence.start >= frame.start),
        );
        page = Math.floor(index / 3);
        line = index % 3;
        draw();
        return;
      }
      const button = event.target.closest("[data-pb-scene]");
      if (button) turn(Number(button.dataset.pbScene));
    });
    scope.on($("#pb-chapter", root), "change", (event) => {
      ctx.navigate(`#/read/${Number(event.target.value)}`);
    });
    scope.on($("#pb-chinese", root), "click", (event) => {
      chinese = !chinese;
      local.set("picturebook-chinese", chinese);
      event.currentTarget.setAttribute("aria-pressed", String(chinese));
      active();
    });
    scope.on($("#pb-speak", root), "click", () => {
      if (speech) {
        stopSpeech();
        return;
      }
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        toast("当前环境未提供本机朗读，可以先逐句阅读。");
        return;
      }
      speech = new SpeechSynthesisUtterance(spreads[page].lines[line].text);
      const utterance = speech;
      speech.lang = "en-US";
      speech.rate = 0.82;
      const voices = window.speechSynthesis.getVoices();
      speech.voice =
        voices.find(
          (voice) => voice.lang.startsWith("en") && voice.localService,
        ) || null;
      speech.onend = () => {
        if (speech === utterance) stopSpeech();
      };
      speech.onerror = () => {
        if (speech !== utterance) return;
        stopSpeech();
        if (!scope.signal.aborted)
          toast("本机朗读暂不可用，请检查英文语音是否已安装。");
      };
      $("#pb-speak", root).innerHTML = "Ⅱ <span>停止朗读</span>";
      $("#pb-speak", root).setAttribute("aria-pressed", "true");
      window.speechSynthesis.speak(speech);
    });
    scope.on(document, "keydown", (event) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.target.closest(
          'input,textarea,select,[contenteditable="true"]',
        ) ||
        $("dialog[open]") ||
        !["ArrowRight", "ArrowLeft"].includes(event.key)
      )
        return;
      event.preventDefault();
      if (event.repeat) return;
      if (event.key === "ArrowRight") {
        if (line < spreads[page].lines.length - 1) select(line + 1, true);
        else if (page < spreads.length - 1) turn(page + 1, true);
        else if (nextChapter) jumpChapter(nextChapter);
      } else if (line > 0) select(line - 1, true);
      else if (page > 0) {
        turn(page - 1);
        select(spreads[page].lines.length - 1, true);
        $(`[data-pb-line="${line}"]`, root).focus({ preventScroll: true });
      } else if (previousChapter) jumpChapter(previousChapter, true);
    });
    scope.cleanup(() => {
      clearTimeout(hoverTimer);
      stopSpeech();
      document.body.classList.remove("picturebook-reading");
    });
    draw();
    $("#pb-chinese", root)?.setAttribute("aria-pressed", String(chinese));
  }
  return {
    enabled,
    mount,
    readerSwitch,
    activate() {
      local.set("edition", "kids");
      sync();
    },
  };
}
