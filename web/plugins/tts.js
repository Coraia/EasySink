import { $, e, api, local, toast } from "../core.js";
import { speechBlob, voices } from "../ai-settings.js";
function chunks(text, limit) {
  const result = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current.length + word.length + 1 > limit && current) {
      result.push(current);
      current = "";
    }
    if (word.length > limit) {
      if (current) result.push(current);
      current = "";
      for (let i = 0; i < word.length; i += limit)
        result.push(word.slice(i, i + limit));
    } else current += (current ? " " : "") + word;
  }
  if (current) result.push(current);
  return result;
}
export function install(ctx) {
  return ctx.hook("read", (r) => {
    let generation = 0,
      controller,
      audio,
      url,
      playing = false,
      paused = false,
      index = 0,
      parts = [],
      mode = "browser",
      rate = local.get("speech-rate", 1),
      voice = "marin";
    const state = (text) => {
      const el = $("#speech-state");
      if (el) el.textContent = text;
    };
    const stop = () => {
      generation++;
      controller?.abort();
      controller = null;
      playing = false;
      paused = false;
      window.speechSynthesis?.cancel();
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        audio.remove();
        audio = null;
      }
      if (url) {
        URL.revokeObjectURL(url);
        url = null;
      }
      state("朗读已停止");
      if ($("#speech-pause")) $("#speech-pause").textContent = "暂停";
    };
    const next = async () => {
      if (!playing || r.scope.signal.aborted || index >= parts.length) {
        playing = false;
        state("朗读已停止");
        return;
      }
      const token = generation;
      if (mode === "browser") {
        if (!window.speechSynthesis) {
          playing = false;
          state("此浏览器不支持本机朗读");
          return;
        }
        const u = new SpeechSynthesisUtterance(parts[index]);
        u.lang = "en-US";
        u.rate = rate;
        const selected = window.speechSynthesis
          .getVoices()
          .find((v) => v.voiceURI === voice);
        if (selected) u.voice = selected;
        u.onend = () => {
          if (token === generation) {
            index++;
            next();
          }
        };
        u.onerror = (ev) => {
          if (
            token !== generation ||
            ["canceled", "interrupted"].includes(ev.error)
          )
            return;
          playing = false;
          state("本机语音暂不可用，请换一个英文音色");
        };
        state(`正在朗读 ${index + 1} / ${parts.length} 段 · 本机语音`);
        window.speechSynthesis.speak(u);
        return;
      }
      if (audio) {
        audio.pause();
        audio.remove();
        audio = null;
      }
      if (url) {
        URL.revokeObjectURL(url);
        url = null;
      }
      controller = new AbortController();
      state(`正在生成 ${index + 1} / ${parts.length} 段 · AI 语音`);
      try {
        const blob = await speechBlob(parts[index], voice, controller.signal);
        if (token !== generation || r.scope.signal.aborted) return;
        if (audio) {
          audio.pause();
          audio.remove();
        }
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        audio = document.createElement("audio");
        audio.id = "speech-audio";
        audio.src = url;
        audio.playbackRate = rate;
        $("#tool-panel").append(audio);
        audio.onended = () => {
          if (token === generation) {
            index++;
            next();
          }
        };
        audio.onerror = () => {
          if (token === generation) {
            playing = false;
            state("音频无法播放，请重新生成或更换音色");
          }
        };
        if (paused) {
          state("已暂停");
          return;
        }
        await audio.play();
        if (token === generation)
          state(`正在朗读 ${index + 1} / ${parts.length} 段 · AI 语音`);
      } catch (err) {
        if (token !== generation || err.name === "AbortError") return;
        playing = false;
        state(err.message);
      }
    };
    r.tool("tts", "朗读", () =>
      r.panel(
        "tts",
        "听英文原文",
        '<div class="loading">正在读取语音设置…</div>',
        async (el, scope) => {
          const config = await api("/speech/status", { signal: scope.signal });
          if (scope.signal.aborted) return;
          mode = config.available ? "natural" : "browser";
          voice =
            mode === "natural" ? config.voice : local.get("speech-voice", "");
          el.innerHTML = `<label for="speech-mode">朗读方式</label><select id="speech-mode"><option value="browser">本机语音 · 无需联网</option><option value="natural" ${mode === "natural" ? "selected" : ""}>自然语音 · AI 生成</option></select><p class="muted">仅朗读英文原文。自然语音会发送原文片段给配置的服务，生成后会在本机缓存。</p><a class="text-button" href="#/ai">配置与试听自然语音 →</a><div id="speech-voices-area"></div><label for="speech-rate">语速</label><select id="speech-rate">${[0.75, 1, 1.25, 1.5].map((v) => `<option value="${v}" ${v === rate ? "selected" : ""}>${v}×</option>`).join("")}</select><div class="row gap wrap"><button id="speech-play">从头朗读</button><button id="speech-pause">暂停</button><button id="speech-stop">停止</button></div><p class="save-state gap" id="speech-state" role="status">准备好听一会儿了</p>`;
          const paintVoices = () => {
            if (mode === "natural")
              $("#speech-voices-area", el).innerHTML =
                `<label for="speech-voice">音色</label><input type="text" id="speech-voice" list="reader-speech-voices" value="${e(voice)}"><datalist id="reader-speech-voices">${voices.map((v) => `<option value="${v}">`).join("")}</datalist>`;
            else {
              const available = (window.speechSynthesis?.getVoices() || [])
                .filter((v) => v.lang.startsWith("en"))
                .sort(
                  (a, b) =>
                    Number(/natural|enhanced|google/i.test(b.name)) -
                    Number(/natural|enhanced|google/i.test(a.name)),
                );
              if (!available.some((v) => v.voiceURI === voice))
                voice = available[0]?.voiceURI || "";
              $("#speech-voices-area", el).innerHTML =
                `<label for="speech-voice">英文音色</label><select id="speech-voice">${available.map((v) => `<option value="${e(v.voiceURI)}" ${v.voiceURI === voice ? "selected" : ""}>${e(v.name)} · ${e(v.lang)}</option>`).join("") || '<option value="">浏览器默认英文音色</option>'}</select>`;
            }
          };
          paintVoices();
          if (window.speechSynthesis?.addEventListener)
            scope.on(window.speechSynthesis, "voiceschanged", () => {
              if (mode === "browser") paintVoices();
            });
          scope.on($("#speech-voices-area", el), "change", (ev) => {
            voice = ev.target.value;
            if (mode === "browser") local.set("speech-voice", voice);
            stop();
          });
          scope.on($("#speech-mode", el), "change", (ev) => {
            stop();
            mode = ev.target.value;
            voice =
              mode === "natural" ? config.voice : local.get("speech-voice", "");
            paintVoices();
          });
          scope.on($("#speech-play", el), "click", () => {
            stop();
            mode = $("#speech-mode", el).value;
            voice = $("#speech-voice", el).value;
            if (mode === "natural" && !config.available) {
              state("自然语音尚未启用，请先配置并试听");
              return;
            }
            index = 0;
            parts = chunks(r.doc.text, mode === "natural" ? 1200 : 220);
            playing = true;
            next();
          });
          scope.on($("#speech-stop", el), "click", stop);
          scope.on($("#speech-pause", el), "click", async (ev) => {
            if (!playing) return;
            paused = !paused;
            ev.target.textContent = paused ? "继续" : "暂停";
            if (mode === "browser") {
              if (paused) window.speechSynthesis.pause?.();
              else window.speechSynthesis.resume?.();
            } else if (audio) {
              if (paused) audio.pause();
              else
                try {
                  await audio.play();
                } catch {
                  state("请点击从头朗读以恢复播放");
                  return;
                }
            }
            state(
              paused
                ? "已暂停"
                : mode === "natural" && !audio
                  ? `正在生成 ${index + 1} / ${parts.length} 段 · AI 语音`
                  : `正在朗读 ${index + 1} / ${parts.length} 段`,
            );
          });
          scope.on($("#speech-rate", el), "change", (ev) => {
            rate = +ev.target.value;
            local.set("speech-rate", rate);
            if (audio) audio.playbackRate = rate;
            if (mode === "browser") stop();
          });
          scope.cleanup(stop);
        },
      ),
    );
    r.scope.cleanup(stop);
  });
}
