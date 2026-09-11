import { $, e, local, toast } from "../core.js";
export function install(ctx) {
  return ctx.hook("read", (r) => {
    if (!("speechSynthesis" in window)) {
      r.tool("tts", "朗读", () => toast("此浏览器不支持语音朗读"));
      return;
    }
    let speaking = false,
      index = 0,
      rate = local.get("speech-rate", 1),
      utterance,
      utteranceScope = 0;
    // Speak only source text; bounded chunks avoid long-utterance truncation in browsers.
    const chunks =
      r.doc.text
        .match(/[^.!?\n]+[.!?]?/g)
        ?.flatMap(
          (s) => s.match(/[\s\S]{1,220}(?:\s|$)|[\s\S]{1,220}/g) || [],
        ) || [];
    const status = () => {
      const el = $("#speech-state");
      if (el)
        el.textContent = speaking
          ? `正在朗读 ${index + 1} / ${chunks.length} 段`
          : "朗读已停止";
    };
    const stop = () => {
      utteranceScope++;
      speaking = false;
      window.speechSynthesis.cancel();
      status();
    };
    const next = () => {
      if (!speaking || r.scope.signal.aborted || index >= chunks.length) {
        speaking = false;
        status();
        return;
      }
      const generation = utteranceScope;
      utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = "en-US";
      utterance.rate = rate;
      const voice = window.speechSynthesis
        .getVoices()
        .find((v) => v.lang.startsWith("en"));
      if (voice) utterance.voice = voice;
      utterance.onend = () => {
        if (generation !== utteranceScope) return;
        index++;
        next();
      };
      utterance.onerror = (ev) => {
        if (
          generation !== utteranceScope ||
          ev.error === "canceled" ||
          ev.error === "interrupted"
        )
          return;
        speaking = false;
        status();
        toast("系统语音暂不可用，请检查浏览器语音设置");
      };
      status();
      window.speechSynthesis.speak(utterance);
    };
    r.tool("tts", "朗读", () =>
      r.panel(
        "tts",
        "听英文原文",
        `<p class="muted">使用此浏览器的英文语音，只朗读原文。</p><label for="speech-rate">语速</label><select id="speech-rate">${[0.75, 1, 1.25, 1.5].map((v) => `<option value="${v}" ${v === rate ? "selected" : ""}>${v}×</option>`).join("")}</select><div class="row gap"><button id="speech-play">从头朗读</button><button id="speech-stop">停止</button></div><p class="save-state gap" id="speech-state">${speaking ? "正在朗读" : "准备好听一会儿了"}</p>`,
        (el, scope) => {
          scope.on($("#speech-play", el), "click", () => {
            stop();
            index = 0;
            speaking = true;
            next();
          });
          scope.on($("#speech-stop", el), "click", stop);
          scope.on($("#speech-rate", el), "change", (ev) => {
            rate = +ev.target.value;
            local.set("speech-rate", rate);
            stop();
          });
          scope.cleanup(stop);
        },
      ),
    );
    r.scope.cleanup(stop);
  });
}
