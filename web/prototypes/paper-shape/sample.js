// Extra prototype-only content keeps sustained page-turn trials away from the end.
// The first section is unchanged, preserving existing sample anchors and notes.
import { chapters as original } from "../page-drag/sample.js";
export { dictionary, pairs, syntax } from "../page-drag/sample.js";

export const chapters = [
  ...original,
  ...Array.from({ length: 19 }, (_, round) =>
    original.map((chapter) => ({
      title: `${chapter.title} · Practice ${round + 2}`,
      paragraphs: [...chapter.paragraphs],
    })),
  ).flat(),
];
