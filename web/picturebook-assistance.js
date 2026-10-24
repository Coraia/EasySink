import { e, api } from "./core.js";
import { chapterLearningNotes } from "./picturebook-learning-notes.js";

// These notes are authored for the first two chapters, not mastery estimates.
const notes = {
  "broke down": "出了故障",
  "on my own": "独自",
  "lay down": "躺下来",
  "fell asleep": "睡着了",
  "cut off": "与外界隔绝",
  "living soul": "一个人",
  "at a glance": "一眼就能看出",
  "came in very handy": "派上了大用场",
  "close quarters": "近距离",
  "gave up": "放弃了",
  "put a stop to": "让……停止",
  "on earth": "究竟；到底",
  "takes up": "占据",
  "all over again": "从头再来",
  "turned it down": "否定了这幅画",
  "wearing thin": "快要耗尽了",
  "stripping down": "拆开发动机",
  "light up": "露出喜色",
  "it's got": "它长着",
  "that's": "那就是",
  "it's": "它是；它已经",
  "i'd": "我会",
  "can't": "不能",
  "don't": "不；不要",
  drew: "画了",
  drawn: "画过",
  "grown-up": "大人",
  bridge: "桥牌",
  magnificent: "非常漂亮的",
  constrictor: "蟒蛇",
  constrictors: "蟒蛇",
  swallowing: "吞下",
  swallow: "吞下",
  prey: "猎物",
  chewing: "咀嚼",
  digest: "消化",
  digesting: "正在消化",
  crayon: "蜡笔",
  masterpiece: "得意的画作",
  "grown-ups": "大人们",
  scary: "吓人的",
  inside: "里面",
  outside: "外面",
  explanations: "解释",
  concentrate: "集中注意力",
  geography: "地理",
  arithmetic: "算术",
  grammar: "语法",
  disaster: "失败",
  glorious: "辉煌的",
  career: "职业生涯",
  nuisance: "麻烦事",
  profession: "职业",
  handy: "有用的",
  glance: "一瞥",
  sensible: "明事理的",
  quarters: "近处",
  opinion: "看法",
  intelligent: "聪明的",
  perceptive: "有洞察力的",
  delighted: "高兴的",
  reasonable: "通情达理的",
  neckties: "领带",
  politics: "政治",
  mechanic: "机械修理工",
  passengers: "乘客",
  complicated: "复杂的",
  engine: "发动机",
  repair: "修理",
  depended: "依靠",
  barely: "勉强；几乎不",
  sahara: "撒哈拉",
  desert: "沙漠",
  soul: "人；生命",
  castaway: "漂流遇难的人",
  adrift: "漂流着",
  ocean: "海洋",
  astonishment: "惊讶",
  awakened: "被叫醒",
  daybreak: "黎明",
  lamb: "小羊",
  leaped: "跳起来",
  struck: "击中",
  lightning: "闪电",
  rubbed: "揉了揉",
  stared: "盯着看",
  extraordinary: "非同寻常的",
  fellow: "小家伙",
  intently: "专注地",
  delightful: "可爱的",
  fault: "过错",
  artistic: "艺术的",
  gazed: "凝视",
  amazement: "惊讶",
  exhaustion: "疲惫",
  hunger: "饥饿",
  thirst: "口渴",
  fright: "害怕",
  utmost: "极大的",
  seriousness: "认真",
  baffled: "困惑的",
  meekly: "顺从地",
  irritably: "不耐烦地",
  astounded: "大吃一惊",
  dangerous: "危险的",
  tiny: "很小的",
  scrutinised: "仔细端详",
  effort: "尝试；画作",
  sickly: "病弱的",
  indulgently: "宽容地",
  ram: "公羊",
  horns: "角",
  old: "年老的",
  stripping: "拆卸",
  patience: "耐心",
  hastily: "匆忙地",
  sketched: "画了草图",
  crate: "木箱",
  critic: "评论者（这里指小王子）",
  acquaintance: "相识",
};
export const tokenPattern = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
export function learningMarkup(text, vocabulary, dictionary, chapter, more) {
  let out = "",
    pos = 0;
  const authoredNotes =
    chapter <= 2 ? notes : chapterLearningNotes(chapter, text);
  const expressions = Object.keys(authoredNotes)
    .filter((w) => /[ -]/.test(w))
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]"));
  const pattern = new RegExp(
    "(?<![A-Za-z])(?:" +
      expressions.join("|") +
      ")(?![A-Za-z])|" +
      tokenPattern.source,
    "gi",
  );
  for (const match of text.matchAll(pattern)) {
    const word = match[0].toLowerCase(),
      entry = dictionary[word];
    const authored = word === "old" && /\byears?\s+$/i.test(text.slice(0, match.index))
      ? "岁（年龄）" : authoredNotes[word.replace(/’/g, "'")];
    const note = authored || vocabulary[word]?.[0] || entry?.note || "";
    const marked =
      !!note &&
      (!!authored ||
        !!vocabulary[word] ||
        !entry?.rank ||
        entry.rank > (more ? 500 : 2000));
    out += e(text.slice(pos, match.index));
    const end = match.index + match[0].length;
    const punctuation = text.slice(end).match(/^[,.;:!?…\)\]”’"»]+/)?.[0] || "";
    out += `<span class="fs-lexeme"><button class="fs-token ${marked ? "fs-word" : ""}" data-fs-word="${e(word)}" aria-label="${e(match[0])}${marked ? " · " + e(note) : " · 查词"}">${marked ? `<ruby>${e(match[0])}<rt aria-hidden="true">${e(note.split(/[\/,，;；]/)[0].slice(0, 6))}</rt></ruby>` : e(match[0])}</button>${e(punctuation)}</span>`;
    pos = end + punctuation.length;
  }
  return out + e(text.slice(pos));
}
export function learningNote(word, vocabulary, dictionary, chapter, text = "") {
  const authoredNotes =
    chapter <= 2 ? notes : chapterLearningNotes(chapter, text);
  if (word === "old" && /\byears?\s+old\b/i.test(text)) return "岁（年龄）";
  return (
    authoredNotes[word.replace(/’/g, "'")] ||
    vocabulary[word]?.[0] ||
    dictionary[word]?.note ||
    ""
  );
}

export function createReadingSpeech(scope, report) {
  let ticket = 0,
    controller,
    audio,
    url,
    config,
    utterance,
    current = "";
  function stop() {
    ticket++;
    controller?.abort();
    controller = null;
    if (audio) {
      audio.onended = audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio = null;
    }
    if (url) URL.revokeObjectURL(url);
    url = null;
    if (utterance) {
      utterance.onend = utterance.onerror = null;
      window.speechSynthesis?.cancel();
      utterance = null;
    }
    current = "";
    report("idle", "");
  }
  async function toggle(text, key, rate = 0.85) {
    if (current === key) return stop();
    stop();
    const id = ticket;
    current = key;
    controller = new AbortController();
    const signal = controller.signal;
    report("loading", key);
    try {
      config ||= await api("/speech/status", { signal });
      if (id !== ticket || scope.signal.aborted) return;
      const engine =
        config.mode === "natural"
          ? "natural"
          : config.mode === "browser" || !config.local.available
            ? "browser"
            : "local";
      if (engine === "browser") {
        if (!window.speechSynthesis || !window.SpeechSynthesisUtterance)
          throw Error("当前浏览器无法发音，请在 AI 与语音里选择本地英文音色。");
        utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        utterance.rate = rate;
        utterance.voice =
          window.speechSynthesis.getVoices().find((v) => v.lang === "en-US") ||
          null;
        utterance.onstart = () => {
          if (id === ticket) report("playing", key, engine);
        };
        utterance.onend = () => {
          if (id === ticket) stop();
        };
        utterance.onerror = () => {
          if (id === ticket) {
            stop();
            report("error", "", engine, "发音失败，请重试或选择本地英文音色。");
          }
        };
        window.speechSynthesis.speak(utterance);
      } else {
        const response = await fetch(
          engine === "local" ? "/api/speech/local" : "/api/speech",
          {
            method: "POST",
            credentials: "same-origin",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text,
              voice: engine === "local" ? config.local_voice : config.voice,
            }),
          },
        );
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw Error(error.detail || "暂时无法发音");
        }
        const blob = await response.blob();
        if (id !== ticket || scope.signal.aborted) return;
        url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.playbackRate = rate;
        audio.onended = () => {
          if (id === ticket) stop();
        };
        audio.onerror = () => {
          if (id === ticket) {
            stop();
            report("error", "", engine, "音频播放失败，请重试。");
          }
        };
        await audio.play();
        if (id === ticket) report("playing", key, engine);
      }
    } catch (error) {
      if (id !== ticket || scope.signal.aborted) return;
      stop();
      if (error.name !== "AbortError") report("error", "", "", error.message);
    }
  }
  scope.cleanup(stop);
  return { toggle, stop };
}
