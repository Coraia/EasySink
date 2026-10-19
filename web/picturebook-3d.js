import { $, $$, e, toast } from "./core.js";

const vocabulary = {
  fox: ["狐狸", "它竖起耳朵，摇摇尾巴。"],
  appeared: ["出现了", "狐狸从苹果树后走了出来。"],
  morning: ["早晨", "晨光亮起来，狐狸点头问好。"],
  prince: ["王子", "小王子向你挥挥手。"],
  turned: ["转过身", "小王子转身寻找声音。"],
  nothing: ["什么也没有", "狐狸藏到树后，原来它在这里。"],
};
const pattern = /\b(fox|appeared|morning|prince|turned|nothing)\b/gi;

export function mountFoxExperiment({ root, scope, onFirstPage, onSelectLine }) {
  let wanted = false,
    active = false,
    pending = null,
    scene = null,
    page = -1,
    index = -1,
    stopped = false;
  const wrap = $(".pb-art-wrap", root);
  const modes = document.createElement("div");
  modes.className = "pb3d-modes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "这一页的画面");
  modes.innerHTML =
    '<button data-pb-visual="watercolor" aria-pressed="true">水彩绘本</button><button data-pb-visual="3d" aria-pressed="false">✦ 动态 3D · 试读一页</button>';
  wrap.append(modes);
  const stage = document.createElement("div");
  stage.className = "pb3d-stage";
  stage.hidden = true;
  stage.innerHTML = `<div class="pb3d-heading"><span>THE WORDS COME ALIVE</span><h2>苹果树下，故事醒了。</h2><p>拖动看看另一面 · 点点狐狸和小王子</p></div><div class="pb3d-ground-label"><span>✧</span> 一次相遇，慢慢成为朋友。</div><div class="pb3d-card" aria-live="polite"><div><strong id="pb3d-word">fox</strong><span id="pb3d-gloss">狐狸</span></div><p id="pb3d-response">停在右边带下划线的单词上，看看谁会回应你。</p></div><div class="pb3d-tools"><button id="pb3d-pause" aria-pressed="false">Ⅱ 暂停动画</button><button id="pb3d-reset">↶ 初始视角</button><span>小狐狸在等你打招呼</span></div>`;
  wrap.append(stage);
  const entry = document.createElement("button");
  entry.className = "pb3d-entry";
  entry.textContent = "✧ 试试：让这一页的单词动起来";
  $(".pb-read-heading", root).append(entry);
  const hint = document.createElement("p");
  hint.className = "pb3d-reading-hint";
  hint.hidden = true;
  hint.innerHTML =
    "停在 <strong>带下划线的单词</strong> 上，或用 Tab 选中后按回车。";
  $("#pb-lines", root).before(hint);
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./picturebook-3d.css", import.meta.url).href;
  document.head.append(css);
  const wordCard = (word) => {
    const [gloss, response] = vocabulary[word];
    $("#pb3d-word", stage).textContent = word;
    $("#pb3d-gloss", stage).textContent = gloss;
    $("#pb3d-response", stage).textContent = response;
  };
  function sync() {
    const value = active && page === 0;
    root.dataset.visual = value ? "3d" : "watercolor";
    stage.hidden = !value;
    hint.hidden = !value;
    modes
      .querySelector('[data-pb-visual="3d"]')
      .setAttribute("aria-pressed", String(value));
    modes
      .querySelector('[data-pb-visual="watercolor"]')
      .setAttribute("aria-pressed", String(!value));
    entry.hidden = value;
    scene?.enable(value);
  }
  function selectWord(button) {
    if (!active || page !== 0 || !button) return;
    const word = button.dataset.pbWord;
    const line = Number(button.closest("[data-pb-line]").dataset.pbLine);
    onSelectLine(line);
    $$("[data-pb-word]", root).forEach((n) =>
      n.classList.toggle("is-word-active", n === button),
    );
    root.dataset.word = word;
    wordCard(word);
    scene?.trigger(word);
  }
  const unavailable = () => {
    if (stopped) return;
    wanted = false;
    active = false;
    scene?.dispose();
    scene = null;
    sync();
    onFirstPage();
    toast("这里暂时无法打开 3D，已为你保留水彩绘本。");
  };
  async function choose(value) {
    wanted = value;
    if (!value) {
      active = false;
      sync();
      onFirstPage(false);
      return;
    }
    const button = modes.querySelector('[data-pb-visual="3d"]');
    button.disabled = true;
    button.textContent = "正在唤醒小世界…";
    try {
      if (!pending) pending = import("./picturebook-fox-scene.js");
      const { createFoxScene } = await pending;
      if (stopped || scope.signal.aborted || !wanted) return;
      if (!scene)
        scene = createFoxScene({
          host: stage,
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
          onUnavailable: unavailable,
          onPick(word) {
            const button = $(`[data-pb-word="${word}"]`, root);
            selectWord(button);
          },
        });
      active = true;
      onFirstPage(true);
      sync();
      scene.trigger("appeared");
      const paused = scene.isPaused();
      $("#pb3d-pause", stage).setAttribute("aria-pressed", String(paused));
      $("#pb3d-pause", stage).textContent = paused
        ? "▷ 播放动画"
        : "Ⅱ 暂停动画";
    } catch (error) {
      if (!stopped && !scope.signal.aborted) {
        pending = null;
        unavailable();
      }
    } finally {
      if (!stopped) {
        button.disabled = false;
        button.textContent = "✦ 动态 3D · 试读一页";
      }
    }
  }
  scope.on(modes, "click", (event) => {
    const b = event.target.closest("[data-pb-visual]");
    if (b) choose(b.dataset.pbVisual === "3d");
  });
  scope.on(entry, "click", () => choose(true));
  scope.on($("#pb-lines", root), "pointerover", (event) => {
    const b = event.target.closest("[data-pb-word]");
    if (!b || event.relatedTarget?.closest?.("[data-pb-word]") === b) return;
    selectWord(b);
  });
  scope.on($("#pb-lines", root), "focusin", (event) =>
    selectWord(event.target.closest("[data-pb-word]")),
  );
  scope.on($("#pb-lines", root), "click", (event) =>
    selectWord(event.target.closest("[data-pb-word]")),
  );
  scope.on($("#pb3d-pause", stage), "click", () => {
    const value = scene.pause(!scene.isPaused());
    $("#pb3d-pause", stage).textContent = value ? "▷ 播放动画" : "Ⅱ 暂停动画";
    $("#pb3d-pause", stage).setAttribute("aria-pressed", String(value));
  });
  scope.on($("#pb3d-reset", stage), "click", () => scene?.reset());
  scope.cleanup(() => {
    stopped = true;
    wanted = false;
    scene?.dispose();
    css.remove();
  });
  return {
    active() {
      return active;
    },
    markup(text) {
      let output = "",
        pos = 0;
      for (const m of text.matchAll(pattern)) {
        output += e(text.slice(pos, m.index));
        const word = m[0].toLowerCase();
        output += `<button type="button" class="pb3d-word" data-pb-word="${word}" aria-label="${e(m[0])} · ${vocabulary[word][0]} · 看看故事里发生什么">${e(m[0])}</button>`;
        pos = m.index + m[0].length;
      }
      return output + e(text.slice(pos));
    },
    show(currentPage, sentenceIndex) {
      page = currentPage;
      if (page !== 0 && active) {
        active = false;
        wanted = false;
        scene?.dispose();
        scene = null;
      }
      sync();
      if (active && index !== sentenceIndex) {
        index = sentenceIndex;
        delete root.dataset.word;
        $$("[data-pb-word]", root).forEach((n) =>
          n.classList.remove("is-word-active"),
        );
        scene.sentence(sentenceIndex);
        $("#pb3d-word", stage).textContent = "The fox";
        $("#pb3d-gloss", stage).textContent = "苹果树下的相遇";
        $("#pb3d-response", stage).textContent =
          "停在单词上，亲手让这一刻发生。";
      }
    },
  };
}
