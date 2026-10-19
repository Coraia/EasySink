import { vocabulary as foxVocabulary } from "./picturebook-fox-chapter.js";
import { livingRigs } from "./picturebook-living-rigs.js";

export const bookVocabulary = {
  ...foxVocabulary,
  prince: ["小王子", "prince"],
  pilot: ["飞行员", "pilot"],
  child: ["孩子", "child"],
  children: ["孩子们", "children"],
  drawing: ["画；绘画", "drawing"],
  drawings: ["画作", "drawing"],
  draw: ["画", "drawing"],
  pencil: ["铅笔", "drawing"],
  boa: ["蟒蛇", "drawing"],
  elephant: ["大象", "drawing"],
  hat: ["帽子", "hat"],
  plane: ["飞机", "plane"],
  aeroplane: ["飞机", "plane"],
  engine: ["发动机", "plane"],
  flying: ["飞行", "plane"],
  sheep: ["绵羊", "box"],
  lamb: ["小羊", "box"],
  box: ["箱子", "box"],
  crate: ["木箱", "box"],
  rope: ["绳子", "rope"],
  planet: ["星球", "planet"],
  planets: ["星球", "planet"],
  asteroid: ["小行星", "planet"],
  asteroids: ["小行星", "planet"],
  stars: ["星星", "stars"],
  star: ["星星", "stars"],
  moon: ["月亮", "moon"],
  astronomer: ["天文学家", "astronomer"],
  telescope: ["望远镜", "telescope"],
  baobabs: ["猴面包树", "baobabs"],
  baobab: ["猴面包树", "baobabs"],
  seeds: ["种子", "baobabs"],
  roots: ["树根", "baobabs"],
  weeds: ["杂草", "baobabs"],
  volcano: ["火山", "volcano"],
  volcanoes: ["火山", "volcano"],
  sunset: ["日落", "sunset"],
  sunsets: ["日落", "sunset"],
  sun: ["太阳", "sunset"],
  chair: ["椅子", "chair"],
  clouds: ["云", "clouds"],
  bolt: ["螺栓", "bolt"],
  hammer: ["锤子", "hammer"],
  thorns: ["花刺", "rose"],
  flower: ["花", "flower"],
  flowers: ["花朵", "flowers"],
  rose: ["玫瑰", "rose"],
  roses: ["玫瑰花", "rose"],
  bud: ["花苞", "rose"],
  petals: ["花瓣", "rose"],
  water: ["水", "water"],
  watered: ["浇水", "water"],
  globe: ["罩子；球体", "globe"],
  birds: ["鸟儿", "birds"],
  king: ["国王", "king"],
  crown: ["王冠", "crown"],
  command: ["命令", "command"],
  orders: ["命令", "command"],
  vain: ["虚荣的", "man"],
  conceited: ["自负的", "man"],
  admire: ["赞赏", "man"],
  clap: ["鼓掌", "clap"],
  applauded: ["鼓掌", "clap"],
  tippler: ["饮酒的人", "man"],
  ashamed: ["羞愧的", "man"],
  bottles: ["瓶子", "bottle"],
  bottle: ["瓶子", "bottle"],
  businessman: ["商人", "businessman"],
  count: ["数数", "count"],
  counting: ["数数", "count"],
  numbers: ["数字", "count"],
  paper: ["纸", "paper"],
  drawer: ["抽屉", "drawer"],
  lamplighter: ["点灯人", "lamplighter"],
  lamp: ["灯", "lamp"],
  lamplighters: ["点灯人", "lamp"],
  lighted: ["点亮", "lamp"],
  extinguished: ["熄灭", "lamp"],
  geographer: ["地理学家", "geographer"],
  book: ["书", "book"],
  books: ["书", "book"],
  map: ["地图", "book"],
  maps: ["地图", "book"],
  ephemeral: ["短暂的；易逝的", "rose"],
  earth: ["地球", "planet"],
  snake: ["蛇", "snake"],
  bracelet: ["手镯", "snake"],
  echo: ["回声", "echo"],
  mountain: ["山", "echo"],
  mountains: ["群山", "echo"],
  railway: ["铁路", "train"],
  train: ["列车", "train"],
  trains: ["列车", "train"],
  express: ["快车", "train"],
  switchman: ["铁路扳道工", "switchman"],
  windows: ["车窗", "children"],
  merchant: ["商人", "merchant"],
  pills: ["药丸", "pills"],
  thirst: ["口渴", "water"],
  fountain: ["泉水", "water"],
  well: ["水井", "bucket"],
  bucket: ["水桶", "bucket"],
  pulley: ["滑轮", "pulley"],
  drink: ["喝", "water"],
  wind: ["风", "wind"],
  sand: ["沙子", "wind"],
  scarf: ["围巾", "wind"],
  laugh: ["笑", "prince"],
  laughter: ["笑声", "stars"],
  laughing: ["欢笑", "stars"],
  goodbye: ["再见", "greeting"],
  secret: ["秘密", "heart"],
  responsible: ["负有责任的", "care"],
};

// An action is tied to a visible subject when one is present; a remembered
// object otherwise prompts the visible character, rather than inventing it.
export function targetFor(action, regions) {
  const aliases = {
    gold: "wind",
    happy: "prince",
    sad: "prince",
    time: "prince",
    greeting: "prince",
    heart: "prince",
    care: "rose",
    bond: "prince",
    sit: "prince",
    closer: "prince",
    distance: "prince",
    alert: "prince",
    flower: "rose",
    flowers: "rose",
    water: "bucket",
    box: "drawing",
    hat: "man",
    rose: "flower",
    stars: "star",
    moon: "stars",
    planet: "stars",
    lamp: "lamplighter",
    children: "train",
  };
  return (
    regions.find((r) => r.key === action)?.key ||
    regions.find((r) => r.key === aliases[action])?.key ||
    regions.find((r) => ["prince", "pilot", "child", "man"].includes(r.key))
      ?.key ||
    regions[0].key
  );
}

export function buildLivingChapter(doc, plan) {
  if (
    !plan ||
    plan.id !== "little-prince-lampadariou-2015-v1" ||
    !plan.frames?.length
  )
    throw new Error(
      "这份正文尚未匹配《小王子》的完整绘本版本，请返回原阅读页。",
    );
  const segments = new Intl.Segmenter("en", { granularity: "sentence" });
  const lines = doc.blocks.flatMap((b, blockIndex) =>
    [...segments.segment(b.text || "")]
      .filter((p) => p.segment.trim())
      .map((p) => {
        const text = p.segment.trim(),
          start = p.index + p.segment.indexOf(text);
        return {
          text,
          block: b.id,
          blockIndex,
          start,
          end: start + text.length,
        };
      }),
  );
  const acts = plan.frames.map((f) => ({
    start: lines.findIndex(
      (l) => l.blockIndex === f.paragraph && l.start >= f.start,
    ),
    title: f.title,
    english: plan.en,
    eyebrow: `CHAPTER ${plan.chapter} · A LIVING STORY`,
    cue: f.description,
    key: f.id,
    frame: f,
  }));
  if (
    acts[0].start !== 0 ||
    acts.some(
      (a, i) =>
        a.start < 0 ||
        (i && a.start <= acts[i - 1].start) ||
        !livingRigs[a.key],
    )
  )
    throw new Error("这一章的原文位置与动态画面不一致，请先返回原阅读页。");
  const pages = [];
  lines.forEach((line, index) => {
    line.act = acts.findLastIndex((a) => a.start <= index);
    const act = acts[line.act],
      regions = livingRigs[act.key];
    const matched = [...line.text.matchAll(/\b[a-z]+\b/gi)]
      .map((m) => m[0].toLowerCase())
      .filter((w) => bookVocabulary[w]);
    // Prefer props explicitly present in this scene over a generic speaker.
    const word =
      matched.find((w) =>
        regions.some(
          (r) =>
            r.key === bookVocabulary[w][1] &&
            !["prince", "pilot"].includes(r.key),
        ),
      ) || matched[0];
    const action = word ? bookVocabulary[word][1] : regions[0].key;
    line.scene = {
      key: act.key,
      frame: act.frame,
      action,
      target: targetFor(action, regions),
      regions,
    };
    line.cue = act.cue;
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
