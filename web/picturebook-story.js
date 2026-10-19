// Original short English retelling inspired by The Little Prince, not an edition's text.
export const storyTitle = "The Little Prince · 小王子的星际旅行";
export const scenes = [
  {
    title: "一颗小小的星球",
    en: "A tiny planet",
    art: 0,
    color: "#284c65",
    lines: [
      [
        "On a tiny planet, a little prince watched the stars.",
        "在一颗小小的星球上，小王子望着星星。",
        "tiny",
        "小小的",
      ],
      [
        "His home was small, but his questions were big.",
        "他的家很小，可他的问题很大。",
        "questions",
        "问题",
      ],
      [
        "He wondered what was waiting beyond the sky.",
        "他想知道，天空的那一边有什么在等着他。",
        "wondered",
        "好奇，想知道",
      ],
    ],
  },
  {
    title: "独一无二的玫瑰",
    en: "A rose to care for",
    art: 1,
    color: "#6b7962",
    lines: [
      [
        "One morning, a red rose opened in the sunlight.",
        "一天清晨，一朵红玫瑰在阳光下绽放。",
        "sunlight",
        "阳光",
      ],
      [
        "The little prince brought her water every day.",
        "小王子每天都给她送来清水。",
        "brought",
        "带来",
      ],
      [
        "Taking care of her made his small world feel warm.",
        "照顾她，让他的小小世界变得温暖。",
        "care",
        "照顾",
      ],
    ],
  },
  {
    title: "向远方出发",
    en: "Beyond the little world",
    art: 2,
    color: "#7c6887",
    lines: [
      [
        "One day, the prince followed the birds into the sky.",
        "有一天，小王子跟着鸟儿飞向天空。",
        "followed",
        "跟随",
      ],
      [
        "His golden scarf danced behind him in the wind.",
        "他的金色围巾在身后的风中起舞。",
        "scarf",
        "围巾",
      ],
      [
        "He carried a thousand questions and a memory of his rose.",
        "他带着一千个问题，还有对玫瑰的思念。",
        "memory",
        "回忆",
      ],
    ],
  },
  {
    title: "沙漠里的相遇",
    en: "A friend in the desert",
    art: 3,
    color: "#b18450",
    lines: [
      [
        "Far away, a pilot had landed in a quiet desert.",
        "在遥远的地方，一位飞行员降落在寂静的沙漠里。",
        "desert",
        "沙漠",
      ],
      [
        "The prince sat beside him as the morning light grew.",
        "晨光渐渐亮起，小王子坐到了他的身旁。",
        "beside",
        "在……旁边",
      ],
      [
        "In that great sea of sand, two strangers became friends.",
        "在那片辽阔的沙海里，两个陌生人成了朋友。",
        "strangers",
        "陌生人",
      ],
    ],
  },
  {
    title: "慢慢靠近的朋友",
    en: "The fox and the prince",
    art: 4,
    color: "#8d754b",
    lines: [
      [
        "Under a tree, a fox waited in the golden grass.",
        "一棵树下，一只狐狸在金色的草丛中等候。",
        "fox",
        "狐狸",
      ],
      [
        "Each day, the prince sat a little closer to his new friend.",
        "每天，小王子都坐得离这位新朋友更近一点。",
        "closer",
        "更近",
      ],
      [
        "They learned that friendship grows when we give it time.",
        "他们懂得了：给友谊一些时间，它就会慢慢生长。",
        "friendship",
        "友谊",
      ],
    ],
  },
  {
    title: "星光替我说晚安",
    en: "A sky full of stories",
    art: 5,
    color: "#304d72",
    lines: [
      [
        "That night, the prince looked up at the shining stars.",
        "那天夜里，小王子抬头望向闪亮的星星。",
        "shining",
        "闪闪发光的",
      ],
      [
        "Somewhere among them, his little rose was waiting.",
        "在星星之间的某个地方，他的小玫瑰正在等待。",
        "somewhere",
        "在某个地方",
      ],
      [
        "The sky felt full of friends, and he no longer felt alone.",
        "天空仿佛住满了朋友，他再也不觉得孤单了。",
        "alone",
        "孤单的",
      ],
    ],
  },
];
export const storyText = scenes
  .map((scene) => scene.lines.map((line) => line[0]).join(" "))
  .join("\n\n");
