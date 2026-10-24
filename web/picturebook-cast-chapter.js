import {
  buildLivingChapter,
  bookVocabulary,
} from "./picturebook-living-chapter.js";
import { castScenes } from "./picturebook-cast-catalog.js";
import { refineCastMoment } from "./picturebook-continuity.js";

export const castVocabulary = {
  ...bookVocabulary,
  sheep: ["绵羊", "sheep"],
  lamb: ["小羊", "sheep"],
  clapped: ["拍手", "clap"],
  clap: ["拍手", "clap"],
  hands: ["双手", "clap"],
  raised: ["抬起", "hat"],
  bowed: ["鞠躬", "hat"],
  salute: ["致意", "hat"],
  light: ["点亮；光", "lamp"],
  lights: ["灯光", "lamp"],
  extinguish: ["熄灭", "lamp"],
  extinguished: ["熄灭", "lamp"],
  hoisted: ["提起", "bucket"],
  drank: ["喝了", "water"],
  wept: ["哭泣", "sad"],
  cried: ["哭了", "sad"],
  sad: ["难过的", "sad"],
  uproot: ["拔除", "baobabs"],
  seedlings: ["幼苗", "baobabs"],
  three: ["三", "flower"],
  wall: ["墙", "wall"],
};
const aliases = {
  flower: "rose",
  flowers: "rose",
  heart: "prince",
  happy: "prince",
  sad: "prince",
  care: "rose",
  bond: "prince",
  time: "prince",
  sit: "prince",
  closer: "prince",
  distance: "prince",
  alert: "prince",
  gold: "wind",
  moon: "stars",
};
export function actionFor(scene, action) {
  if (scene.targets[action] && scene.targets[action] !== "memory")
    return { action, target: scene.targets[action] };
  if (scene.memory?.[action])
    return { action, target: "memory", memoryItem: scene.memory[action] };
  const alias = aliases[action];
  if (alias && scene.targets[alias])
    return { action: alias, target: scene.targets[alias] };
  if (alias && scene.memory?.[alias])
    return { action: alias, target: "memory", memoryItem: scene.memory[alias] };
  return null;
}

export function buildCastChapter(doc, plan) {
  const chapter = buildLivingChapter(doc, plan);
  const sourceState = {};
  let lampOn = false,
    bucketHeight = 0,
    childhoodDrawing = "drawing";
  for (const line of chapter.lines) {
    const recipe = castScenes[line.scene.key];
    if (!recipe) throw Error("本章独立角色尚未匹配原文。");
    const s = {
      ...recipe,
      actors: recipe.actors.map((a) => ({ ...a })),
      targets: { ...recipe.targets },
      frame: line.scene.frame,
      key: line.scene.key,
    };
    const t = line.text.toLowerCase(),
      n = plan.chapter,
      b = line.blockIndex;
    if (n === 22) s.trainDirection = b >= 7 && b < 12 ? -1 : 1;
    // Derive state in source order: reverse seeking reconstructs the same scene.
    if (n === 14) {
      if (b === 7 || b === 23) lampOn = true;
      if (b === 3 || b === 12 || b === 32) lampOn = false;
      s.lampOn = lampOn;
    } else if (n === 16) s.lampOn = true;
    if (n === 25) {
      if (b >= 9) bucketHeight = 1;
      s.bucket = bucketHeight;
    }
    if (n === 1) {
      if (b === 5 && /so then i drew the inside/.test(t))
        childhoodDrawing = "drawingInside";
      if (b >= 7) childhoodDrawing = "drawing";
      s.actors.find((a) => a.id === "drawing").asset = childhoodDrawing;
    }
    if (n === 2 && s.key === "ch02-02") {
      // Drawings persist through the reaction and change at the act of drawing.
      // Never reveal the next drawing before the source has reached it.
      const drawing = s.actors.find((a) => a.id === "drawing");
      if (b < 9) s.actors = s.actors.filter((a) => a.id !== "drawing");
      else if (b === 9) {
        drawing.asset = "drawing";
        s.label = "先画了蟒蛇吞象 · 不是小羊";
      } else if (b <= 11) {
        drawing.asset = "drawingSick";
        s.label = "第一只 · 病弱的小羊";
      } else if (b <= 13) {
        drawing.asset = "drawingRam";
        s.label = "第二只 · 有角的公羊";
      } else if (b <= 15) {
        drawing.asset = "drawingOld";
        s.label = "第三只 · 年老的羊";
      } else {
        drawing.asset = "drawingCrate";
        s.label = "最后 · 三个透气孔的箱子";
      }
    }
    if (n === 2 && s.key === "ch02-03")
      s.actors.find((a) => a.id === "box").asset = "drawingCrate";
    if (n === 3 && s.key === "ch03-02")
      s.actors.find((a) => a.id === "box").asset = "drawingBox";
    if (n === 2 && b < 2) s.actors = s.actors.filter((a) => a.id !== "prince");
    if (n === 2 && s.key === "ch02-01")
      s.actors.find((a) => a.id === "pilot").asset = "pilotRepair";
    if (n === 24 && b < 12) s.background = "desert";
    if (n === 26 && s.fall && !/he feel as gently|there was not even/.test(t))
      s.fall = false;
    if (n === 26 && s.key === "ch26-01" && b < 11)
      s.actors = s.actors.filter((a) => a.id !== "snake");
    if (n === 26 && b >= 65 && b < 85) s.walk = true;
    if (
      n === 10 &&
      /continued on his journey|taking his leave|went away/.test(t)
    )
      s.depart = true;
    if (n === 12 && /went away|took his leave/.test(t)) s.depart = true;
    if (n === 9 && b >= 3) s.globe = /globe|shelter/.test(t);
    refineCastMoment(s, line, n, sourceState);
    const matches = [...t.matchAll(/\b[a-z]+\b/g)]
      .map((m) => m[0])
      .filter((w) => castVocabulary[w]);
    const choices = matches
      .map((w) => ({ word: w, ...actionFor(s, castVocabulary[w][1]) }))
      .filter((c) => c.target);
    const chosen =
      choices.find((c) => !["prince", "pilot", "wind"].includes(c.action)) ||
      choices[0];
    Object.assign(
      s,
      chosen || {
        action: "listen",
        target:
          s.actors.find((a) => ["prince", "child", "pilot"].includes(a.id))
            ?.id || null,
      },
    );
    if (n === 14 && /put out|lighted|lights his/.test(t))
      Object.assign(s, { action: "lamp", target: "lamp" });
    if (n === 11 && /clap|applaud/.test(t))
      Object.assign(s, { action: "clap", target: "prince" });
    if (n === 25 && /hoisted/.test(t))
      Object.assign(s, { action: "bucket", target: s.targets.bucket });
    else if (n === 25 && /touched the rope|pulley/.test(t))
      Object.assign(s, { action: "pulley", target: s.targets.pulley });
    if (n === 19 && /echo|good morning|who are you|be my friends/.test(t))
      Object.assign(s, { action: "echo", target: "echo" });
    if (n === 6 && /sunset|sun go|sun goes/.test(t))
      Object.assign(s, { action: "sunset", target: "sun" });
    if (s.sourceAction)
      Object.assign(s, { action: s.sourceAction, target: s.sourceTarget });
    s.memoryActive = s.editorialMemory || chosen?.memoryItem || null;
    s.words = Object.keys(castVocabulary).filter((w) =>
      actionFor(s, castVocabulary[w][1]),
    );
    line.scene = s;
    if (s.memoryActive) line.cue = s.memoryActive.label + "。" + line.cue;
  }
  chapter.casts = chapter.lines.map((l) => l.scene);
  return chapter;
}
