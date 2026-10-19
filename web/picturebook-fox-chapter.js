// Story cues are anchored to the installed chapter, never substituted for its text.
const sections = [
  [
    "It was then that the fox appeared.",
    "初次相遇",
    "Under the apple tree",
    "A FIRST ENCOUNTER",
    "狐狸出现在苹果树下，两位陌生人开始交谈。",
    "meeting",
  ],
  [
    "“What does that mean-‘tame’?”",
    "建立联系",
    "To establish ties",
    "BECOMING UNIQUE",
    "驯养，是让彼此从陌生变成独一无二。",
    "ties",
  ],
  [
    "“I am beginning to understand,”",
    "想起玫瑰",
    "A flower, far away",
    "SOMEONE SPECIAL",
    "小王子想起遥远星球上，那朵与他建立了联系的花。",
    "rose",
  ],
  [
    "But the fox came back to her idea.",
    "金色麦田",
    "The colour of gold",
    "THE WIND IN THE WHEAT",
    "金色的麦田，会让狐狸想起小王子的头发。",
    "wheat",
  ],
  [
    "The fox gazed at the little prince",
    "耐心靠近",
    "A little closer, every day",
    "GIVE IT TIME",
    "先安静坐在远处，再一天一天靠近。",
    "patience",
  ],
  [
    "The next day the little prince came back.",
    "等待的仪式",
    "At the same hour",
    "A TIME TO BE HAPPY",
    "约定的时间，让等待也有了幸福的意义。",
    "ritual",
  ],
  [
    "So the little prince tamed the fox.",
    "告别时刻",
    "The colour of the wheat",
    "SOMETHING TO KEEP",
    "即使离别会难过，麦田也从此有了特别的颜色。",
    "farewell",
  ],
  [
    "The little prince went away, to look again at the roses.",
    "重看玫瑰",
    "My rose is different",
    "ONE AMONG ALL THE ROSES",
    "小王子独自回到花园，明白自己的玫瑰为何珍贵。",
    "garden",
  ],
  [
    "And he went back to meet the fox.",
    "狐狸的秘密",
    "Only with the heart",
    "A VERY SIMPLE SECRET",
    "真正重要的东西，要用心去看。",
    "secret",
  ],
  [
    "“It is the time you have wasted for your rose",
    "记住责任",
    "Responsible for your rose",
    "WHAT MAKES HER IMPORTANT",
    "付出的时间，让玫瑰变得重要；建立的联系，也带来责任。",
    "responsibility",
  ],
];

export const vocabulary = {
  fox: ["狐狸", "fox"],
  prince: ["王子", "prince"],
  appeared: ["出现", "fox"],
  morning: ["早上；问候", "greeting"],
  politely: ["有礼貌地", "prince"],
  play: ["玩耍", "happy"],
  unhappy: ["不快乐的", "sad"],
  tame: ["建立联系；驯养", "bond"],
  tamed: ["建立了联系；被驯养", "bond"],
  ties: ["联系；纽带", "bond"],
  unique: ["独一无二的", "bond"],
  friend: ["朋友", "bond"],
  friends: ["朋友们", "bond"],
  friendship: ["友谊", "bond"],
  flower: ["花", "rose"],
  rose: ["玫瑰", "rose"],
  roses: ["玫瑰花", "rose"],
  planet: ["星球", "prince"],
  curious: ["好奇的", "fox"],
  hunters: ["猎人", "alert"],
  hunt: ["捕猎", "alert"],
  monotonous: ["单调的", "sad"],
  bored: ["感到无聊的", "sad"],
  steps: ["脚步声", "alert"],
  step: ["脚步声", "alert"],
  music: ["音乐", "fox"],
  wheat: ["小麦", "wind"],
  grain: ["谷物；麦子", "wind"],
  gold: ["金色", "gold"],
  golden: ["金色的", "gold"],
  hair: ["头发", "gold"],
  wind: ["风", "wind"],
  listen: ["聆听", "fox"],
  time: ["时间", "time"],
  patient: ["耐心的", "time"],
  sit: ["坐下", "sit"],
  distance: ["距离", "distance"],
  closer: ["更近", "closer"],
  happy: ["快乐的", "happy"],
  happier: ["更快乐的", "happy"],
  jumping: ["跳跃", "happy"],
  hour: ["小时；时刻", "time"],
  rites: ["仪式；固定的约定", "time"],
  rite: ["仪式", "time"],
  cry: ["哭泣", "sad"],
  goodbye: ["再见", "greeting"],
  secret: ["秘密", "heart"],
  heart: ["心", "heart"],
  invisible: ["看不见的", "heart"],
  essential: ["至关重要的", "heart"],
  watered: ["浇过水", "rose"],
  responsible: ["负有责任的", "care"],
  forever: ["永远", "care"],
  remember: ["记住", "prince"],
};
export const wordPattern = new RegExp(
  `\\b(${Object.keys(vocabulary)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`,
  "gi",
);

export function buildFoxChapter(doc) {
  if (doc.chapter?.idx !== 20 || !Array.isArray(doc.blocks))
    throw new Error("这个入口需要《小王子》第 21 章。请从狐狸章节进入。");
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const lines = doc.blocks.flatMap((b) =>
    [...segmenter.segment(b.text || "")]
      .filter((p) => p.segment.trim())
      .map((p) => {
        const text = p.segment.trim(),
          start = p.index + p.segment.indexOf(text);
        return { text, block: b.id, start, end: start + text.length };
      }),
  );
  const acts = sections.map(([anchor, title, english, eyebrow, cue, key]) => ({
    start: lines.findIndex((l) => l.text.startsWith(anchor)),
    title,
    english,
    eyebrow,
    cue,
    key,
  }));
  if (
    acts.some((a, i) => a.start < 0 || (i && a.start <= acts[i - 1].start)) ||
    !lines.at(-1)?.text.startsWith("“I am responsible for my rose,”")
  )
    throw new Error(
      "这一章的文本版本与画面编排不一致。请先返回原文阅读，避免错配情节。",
    );
  const sitIndex = lines.findIndex((l) =>
    l.text.includes("First you will sit down"),
  );
  const closerIndex = lines.findIndex((l) =>
    l.text.includes("But you will sit a little closer"),
  );
  const pages = [];
  let speaker = "fox";
  lines.forEach((line, i) => {
    line.act = acts.findLastIndex((a) => a.start <= i);
    const act = acts[line.act];
    const t = line.text;
    if (
      /little prince.*(?:said|replied|responded|added|asked)|(?:said|asked|replied|proposed).*little prince/i.test(
        t,
      )
    )
      speaker = "prince";
    else if (
      /fox.*(?:said|replied|added)|(?:said|replied).*fox|she said/i.test(t)
    )
      speaker = "fox";
    line.scene = {
      key: act.key,
      pose: "standing",
      fox: 1,
      princeX: -1.8,
      foxX: 2.25,
      gap: 0,
      garden: 0,
      rose: 0,
      action: speaker,
    };
    if (act.key === "meeting" && i === 2) line.scene.fox = 0.25;
    if (act.key === "rose") line.scene.rose = 1;
    if (act.key === "wheat")
      line.scene.action = /wind|wheat|gold|grain|hair/.test(t)
        ? "wind"
        : speaker;
    if (
      ["patience", "ritual", "farewell", "secret", "responsibility"].includes(
        act.key,
      )
    ) {
      line.scene.pose = "seated";
      line.scene.gap =
        act.key === "patience"
          ? i < sitIndex
            ? 0.85
            : i < closerIndex
              ? 0.65
              : 0.28
          : 0;
    }
    // The conversation about patience precedes the instruction to sit.
    if (act.key === "patience" && i < sitIndex) line.scene.pose = "standing";
    if (act.key === "ritual" && /happy|jumping|happier/.test(t))
      line.scene.action = "happy";
    if (act.key === "farewell" && /cry|departure/.test(t))
      line.scene.action = "sad";
    if (act.key === "garden")
      Object.assign(line.scene, {
        garden: 1,
        fox: 0,
        princeX: -1.7,
        action: "prince",
      });
    if (act.key === "secret") line.scene.action = "heart";
    if (act.key === "responsibility")
      Object.assign(line.scene, { rose: 1, action: "care" });
    line.cue = /sit down/.test(t)
      ? "他们安静地坐下，给彼此留一点距离。"
      : /closer/.test(t)
        ? "每一次相见，都让距离更近一点。"
        : /jumping|happier/.test(t)
          ? "想到即将见面，狐狸高兴得轻轻跃动。"
          : /cry/.test(t)
            ? "狐狸低下头，难过也来自珍惜。"
            : /wind in the wheat/.test(t)
              ? "风吹麦田，也吹动了小王子的围巾。"
              : act.cue;
    const last = pages.at(-1);
    if (
      !last ||
      last.act !== line.act ||
      last.indices.length >= 3 ||
      last.chars + t.length > 330
    )
      pages.push({ act: line.act, indices: [], chars: 0 });
    const page = pages.at(-1);
    page.indices.push(i);
    page.chars += t.length;
    line.page = pages.length - 1;
  });
  return { lines, acts, pages };
}
