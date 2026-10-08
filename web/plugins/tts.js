import { $, $$, api, local } from "../core.js";

function chunks(text, limit = 1200) {
  const out = [];
  let value = "";
  for (const token of text.match(/\S+\s*|\s+/g) || []) {
    if (value.length + token.length > limit && value) {
      out.push(value);
      value = "";
    }
    if (token.length > limit) {
      for (let i = 0; i < token.length; i += limit)
        out.push(token.slice(i, i + limit));
    } else value += token;
  }
  if (value.trim()) out.push(value);
  return out;
}
export function install(ctx) {
  return ctx.hook("read", async (r) => {
    // Speech discovery can spawn an OS process; never await it to open a book.
    let config,
      configRequest,
      engine = "pending";
    const loadConfig = () => {
      if (config) return Promise.resolve(config);
      if (configRequest) return configRequest;
      configRequest = api("/speech/status", { signal: r.scope.signal })
        .then((value) => {
          if (r.scope.signal.aborted) return;
          config = value;
          engine =
            config.mode === "natural"
              ? "natural"
              : config.mode === "browser"
                ? "browser"
                : config.local.available
                  ? "local"
                  : "browser";
          controls();
          return config;
        })
        .catch((error) => {
          configRequest = null;
          engine = "unavailable";
          controls();
          throw error;
        });
      return configRequest;
    };
    let generation = 0,
      controller,
      audio,
      url,
      cancelPlayback,
      mode = "idle",
      anchor = null;
    const same = (a) =>
      a &&
      anchor &&
      a.block_id === anchor.block_id &&
      a.start === anchor.start &&
      a.end === anchor.end;
    const active = () => ["loading", "playing"].includes(mode);
    const controls = () => {
      if (r.scope.signal.aborted) return;
      $(".reader").dataset.audioState = mode;
      $(".reader").dataset.speechEngine = engine;
      const update = (button, value, idle) => {
        if (!button) return;
        const own = active() && same(value);
        button.textContent = own
          ? mode === "loading"
            ? "取消朗读"
            : "停止朗读"
          : idle;
        button.setAttribute("aria-pressed", String(own));
      };
      update($("#tool-tts"), anchor, "朗读");
      update($('[data-selection-action="speech"]'), r.selection, "朗读选区");
      $$("[data-read-block]").forEach((button) => {
        const b = r.doc.blocks.find((b) => b.id === button.dataset.readBlock);
        update(button, r.anchorFor(b.id, 0, b.text.length), "听这一段");
      });
      const word = r.popElement && $("[data-word-speak]", r.popElement);
      if (word) {
        const own = active() && same(r.popAnchor);
        word.textContent = own
          ? mode === "loading"
            ? "取消发音"
            : "停止发音"
          : "听发音";
        word.setAttribute("aria-pressed", String(own));
      }
    };
    const clean = () => {
      cancelPlayback?.();
      cancelPlayback = null;
      controller?.abort();
      controller = null;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        audio = null;
      }
      if (url) {
        URL.revokeObjectURL(url);
        url = null;
      }
      window.speechSynthesis?.cancel();
    };
    const stop = () => {
      generation++;
      clean();
      mode = "stopped";
      controls();
    };
    const speak = async (a) => {
      stop();
      anchor = { ...a };
      r.speech.anchor = anchor;
      const ticket = generation;
      if (!a.quote?.trim()) return;
      mode = "loading";
      controls();
      try {
        await loadConfig();
        if (ticket !== generation || r.scope.signal.aborted) return;
        const parts = chunks(a.quote, engine === "browser" ? 220 : 1200);
        for (const text of parts) {
          if (ticket !== generation || r.scope.signal.aborted) return;
          if (engine === "browser") {
            if (!window.speechSynthesis || !window.SpeechSynthesisUtterance)
              throw Error("浏览器没有本机语音，请在 AI 与语音中选择可用方式");
            await new Promise((resolve, reject) => {
              cancelPlayback = resolve;
              const u = new SpeechSynthesisUtterance(text);
              u.lang = "en-US";
              u.rate = local.get("speech-rate", 1);
              const voices = window.speechSynthesis.getVoices();
              u.voice =
                voices.find((v) => v.voiceURI === local.get("speech-voice")) ||
                voices.find(
                  (v) =>
                    v.lang === "en-US" &&
                    /natural|enhanced|samantha/i.test(v.name),
                ) ||
                voices.find((v) => v.lang === "en-US") ||
                null;
              u.onend = resolve;
              u.onerror = (ev) =>
                reject(
                  Error(
                    ["canceled", "interrupted"].includes(ev.error)
                      ? "已停止"
                      : "本机朗读失败，请重试",
                  ),
                );
              mode = "playing";
              controls();
              window.speechSynthesis.speak(u);
            });
          } else {
            if (engine === "natural" && !config.available)
              throw Error("自然语音未启用，请先配置，或改用本地语音");
            controller = new AbortController();
            const response = await fetch(
              engine === "local" ? "/api/speech/local" : "/api/speech",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  text,
                  voice: engine === "local" ? config.local_voice : config.voice,
                }),
                signal: controller.signal,
                credentials: "same-origin",
              },
            );
            if (!response.ok) {
              const err = await response.json().catch(() => ({}));
              throw Error(err.detail || "语音暂不可用");
            }
            const blob = await response.blob();
            if (ticket !== generation || r.scope.signal.aborted) return;
            if (url) URL.revokeObjectURL(url);
            url = URL.createObjectURL(blob);
            audio = new Audio(url);
            audio.playbackRate = local.get("speech-rate", 1);
            const ended = new Promise((resolve, reject) => {
              cancelPlayback = resolve;
              audio.onended = resolve;
              audio.onerror = () => reject(Error("音频无法播放，请重试"));
            });
            await audio.play();
            if (ticket !== generation) return;
            mode = "playing";
            controls();
            await ended;
          }
        }
        if (ticket === generation) {
          mode = "ended";
          clean();
          controls();
        }
      } catch (err) {
        if (ticket !== generation || r.scope.signal.aborted) return;
        mode = "error";
        clean();
        controls();
        if (err.name !== "AbortError") r.status(err.message, { notice: true });
      }
    };
    const toggle = (a) => {
      if (active() && same(a)) stop();
      else speak(a);
    };
    r.speech = { toggle, stop, anchor: null };
    r.tool("tts", "朗读", () => {
      const a =
        r.selection ||
        (() => {
          const f = r.pages.pages[r.pages.index][0],
            b = r.doc.blocks.find((b) => b.id === f.id);
          return r.anchorFor(b.id, 0, b.text.length);
        })();
      r.focus.close();
      toggle(a);
    });
    r.selectionAction("speech", "朗读选区", toggle);
    r.scope.on($("#article"), "click", (ev) => {
      const button = ev.target.closest("[data-read-block]");
      if (!button) return;
      r.closePop();
      const b = r.doc.blocks.find((b) => b.id === button.dataset.readBlock);
      toggle(r.anchorFor(b.id, 0, b.text.length));
    });
    for (const event of ["before-page", "before-selection"]) r.on(event, stop);
    for (const event of ["draw", "selection-render", "speech-controls"])
      r.on(event, controls);
    r.scope.cleanup(stop);
    controls();
    loadConfig().catch(() => {});
  });
}
