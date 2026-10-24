import { buildLivingChapter } from "./picturebook-living-chapter.js";

export const roseVocabulary = {
  bud: ["花苞", "bloom"],
  sprout: ["幼芽", "grow"],
  sprouts: ["幼芽", "grow"],
  seed: ["种子", "grow"],
  growing: ["生长", "grow"],
  petals: ["花瓣", "petals"],
  ring: ["一圈", "petals"],
  simple: ["朴素的", "flowers"],
  dressed: ["装扮", "petals"],
  adjusted: ["整理", "petals"],
  colours: ["颜色", "petals"],
  sunrise: ["日出", "sunrise"],
  morning: ["早晨", "sunrise"],
  sun: ["太阳", "sunrise"],
  awake: ["醒来", "bloom"],
  yawned: ["打哈欠", "bloom"],
  beauty: ["美丽", "admire"],
  beautiful: ["美丽的", "admire"],
  admiration: ["赞叹", "admire"],
  breakfast: ["早餐", "water"],
  water: ["水", "water"],
  sprinkling: ["洒水", "water"],
  "sprinkling-can": ["洒水壶", "water"],
  can: ["水壶", "water"],
  tended: ["照料", "water"],
  thorns: ["花刺", "thorns"],
  tigers: ["老虎", "thorns"],
  claws: ["爪子", "thorns"],
  clows: ["爪子（原文拼写）", "thorns"],
  draughts: ["穿堂风", "wind"],
  screen: ["挡风屏", "screen"],
  globe: ["玻璃罩", "globe"],
  glass: ["玻璃", "globe"],
  night: ["夜晚", "night"],
  cold: ["寒冷的", "wind"],
  coughed: ["咳嗽了", "cough"],
  cough: ["咳嗽", "cough"],
  remorse: ["懊悔", "sad"],
  unhappy: ["不开心", "sad"],
  fragrance: ["香气", "fragrance"],
  perfumed: ["使充满香气", "fragrance"],
  breathe: ["呼吸", "fragrance"],
  radiance: ["光辉", "fragrance"],
  tenderness: ["温柔", "love"],
  love: ["爱", "love"],
  affection: ["爱意", "love"],
  heart: ["心", "love"],
  flower: ["花", "rose"],
  flowers: ["花朵", "rose"],
  rose: ["玫瑰", "rose"],
  prince: ["小王子", "prince"],
};
// Every act starts at an exact source quotation, never at a translated summary.
const scenes = [
  [
    "I soon learned to know this flower better.",
    "一朵与众不同的花",
    "A flower unlike any other",
    "小王子守在幼芽身边，等待它慢慢长大。",
    {
      key: "watch",
      pose: "seated",
      bloom: 0,
      growth: 0.65,
      night: 0.45,
      action: "grow",
    },
  ],
  [
    "The little prince, who was present at the first appearance",
    "花苞的准备",
    "Getting ready for the world",
    "花苞把自己藏在绿房间里，一片一片整理花瓣。",
    {
      key: "bud",
      pose: "seated",
      bloom: 0,
      growth: 1,
      night: 0.25,
      action: "petals",
    },
  ],
  [
    "Then one morning, exactly at sunrise",
    "在日出时盛开",
    "Born with the sun",
    "太阳升起，花苞缓缓打开，玫瑰第一次露出容颜。",
    { key: "bloom", pose: "seated", bloom: 1, action: "bloom" },
  ],
  [
    "But the little prince could not restrain",
    "忍不住赞叹",
    "How beautiful you are",
    "小王子靠近一点，托着脸，认真看着这朵美丽的花。",
    { key: "admire", pose: "seated", bloom: 1, near: 1, action: "admire" },
  ],
  [
    "“I think it is time for breakfast,”",
    "给玫瑰浇水",
    "A little water for breakfast",
    "小王子端来洒水壶，倾斜壶嘴，把清水送到玫瑰根边。",
    { key: "water", pose: "watering", bloom: 1, action: "water" },
  ],
  [
    "One day, for instance, when she was speaking",
    "四根小小的刺",
    "Four little thorns",
    "玫瑰挺起花头，骄傲地说起自己的四根刺。",
    { key: "thorns", pose: "standing", bloom: 1, action: "thorns" },
  ],
  [
    "“I am not at all afraid of tigers,”",
    "挡住吹来的风",
    "A shelter from the wind",
    "风吹动围巾和花叶，小王子为玫瑰准备挡风屏。",
    { key: "wind", pose: "standing", bloom: 1, screen: 1, action: "wind" },
  ],
  [
    "“At night I want you to put me under a glass globe.",
    "夜里的玻璃罩",
    "Safe beneath the glass",
    "夜色渐深，玻璃罩轻轻落下，为玫瑰挡住寒意。",
    {
      key: "night",
      pose: "seated",
      bloom: 1,
      globe: 1,
      night: 1,
      action: "globe",
    },
  ],
  [
    "Embarrassed over having let herself be caught",
    "两三声咳嗽",
    "A tiny, insistent cough",
    "玫瑰轻咳两三声，小王子停下来，转向她。",
    { key: "cough", pose: "standing", bloom: 1, screen: 1, action: "cough" },
  ],
  [
    "So the little prince, in spite of all the good will",
    "后来才懂得的爱",
    "More than words",
    "他想起玫瑰的香气与光辉，慢慢明白她藏在话语后的爱意。",
    { key: "love", pose: "seated", bloom: 1, near: 1, action: "love" },
  ],
];
export function buildRoseChapter(doc, plan) {
  const { lines } = buildLivingChapter(doc, plan);
  const acts = scenes.map(([anchor, title, english, cue, scene]) => ({
    start: lines.findIndex((l) => l.text.startsWith(anchor)),
    title,
    english,
    cue,
    eyebrow: "CHAPTER VIII · THE ROSE",
    scene,
  }));
  if (acts.some((a, i) => a.start < 0 || (i && a.start <= acts[i - 1].start)))
    throw Error("玫瑰章的原文位置发生了变化，请返回原阅读页核对。");
  const pages = [];
  lines.forEach((line, index) => {
    line.act = acts.findLastIndex((a) => a.start <= index);
    const act = acts[line.act];
    line.scene = {
      growth: 1,
      near: 0,
      globe: 0,
      screen: 0,
      night: 0,
      ...act.scene,
      frame: plan.frames[act.start < 17 ? 0 : 1],
    };
    // Specific source occurrences refine the act, without making the book a summary.
    if (index >= 4 && index <= 6) {
      line.scene.growth = 0.55 + (index - 4) * 0.15;
      line.scene.action = "grow";
    }
    if (index === 32 || index === 33) line.scene.action = "water";
    if (index === 35 || index === 36) line.scene.action = "thorns";
    if (index === 42 || index === 51 || index === 52)
      line.scene.action = "screen";
    if (index === 50 || index === 53) line.scene.action = "cough";
    if (index >= 54 && index <= 57) line.scene.action = "sad";
    if (index === 58 || index === 59 || index === 65)
      line.scene.action = "fragrance";
    line.cue = act.cue;
    if (act.scene.key === "water" && line.blockIndex < 10) {
      Object.assign(line.scene, { pose: "seated", action: "rose" });
      line.scene.label = "玫瑰提出早餐请求 · 还没有取来水壶";
      line.cue = line.scene.label;
    } else if (act.scene.key === "water" && line.blockIndex >= 11) {
      Object.assign(line.scene, { pose: "standing", action: "rose" });
    }
    if (["wind", "night"].includes(act.scene.key)) {
      line.scene.label =
        act.scene.key === "wind"
          ? "玫瑰请求挡风屏 · 保护方式的示意"
          : "玫瑰希望夜里盖上玻璃罩 · 想象";
      line.cue = line.scene.label;
    }
    if (act.scene.key === "cough") {
      line.scene.screen = 0;
      line.scene.allowScreen = false;
      line.scene.label = "挡风屏还没有找来，玫瑰在催促";
    }
    line.scene.words = Object.keys(roseVocabulary).filter(
      (word) => word !== "can" || /sprinkling-can/i.test(line.text),
    );
    // The opening compares the rose with the planet's earlier, simple flowers.
    // Those flowers have one ring of petals; they are not rose buds.
    if (index <= 3) {
      Object.assign(line.scene, {
        key: [
          "rose-introduction",
          "simple-flowers",
          "single-ring",
          "simple-flowers-fade",
        ][index],
        bloom: 1,
        growth: 1,
        night: 0,
        near: 1,
        keepRose: true,
        meadow: index > 0 ? 1 : 0,
        detail: index === 2 ? 1 : 0,
        action: ["rose", "flowers", "single-ring", "flowers"][index],
        frame: plan.frames[index === 0 ? 1 : 0],
      });
      line.caption = [
        "慢慢认识这朵花",
        "回看玫瑰到来以前",
        "那些小花，只有一圈花瓣",
        "那些朝开夕谢的小花",
      ][index];
      line.cue = [
        "故事从这朵特别的玫瑰说起，小王子静静望着她。",
        "玫瑰仍在眼前；上方的回忆里，是她到来以前那些朴素的小花。",
        "原文的 They 指回忆里的小花：只有一圈花瓣，不占地方，也不给谁添麻烦。",
        "这句仍在回忆以前的小花：早晨开放，晚上就凋谢了。玫瑰的幼芽还没登场。",
      ][index];
    }
    const last = pages.at(-1);
    if (
      !last ||
      last.act !== line.act ||
      last.indices.length >= 3 ||
      last.chars + line.text.length > 330
    )
      pages.push({ act: line.act, indices: [], chars: 0 });
    const page = pages.at(-1);
    page.indices.push(index);
    page.chars += line.text.length;
    line.page = pages.length - 1;
  });
  return { lines, acts, pages };
}
