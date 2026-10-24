// UV rectangles are authored against the original, unmodified generated atlases.
// Coordinates use the top-left of the image. Every actor owns its own mesh.
const atlas = (file, cell, extra = {}) => ({
  file: `picturebook-cast/${file}.png`,
  rect: [(cell % 2) / 2, Math.floor(cell / 2) / 2, 0.5, 0.5],
  ...extra,
});
const full = (file, extra = {}) => ({ file, rect: [0, 0, 1, 1], ...extra });
export const castAssets = {
  prince: full("picturebook-lookdev-v2/prince.png", {
    human: true,
    scarf: true,
  }),
  king: atlas("people-a", 0, { rect: [0, 0, 0.54, 0.52], human: true, cut: 1 }),
  vain: atlas("people-a", 1, {
    rect: [0.52, 0, 0.48, 0.54],
    human: true,
    cut: 2,
  }),
  tippler: atlas("people-a", 2, { rect: [0, 0.54, 0.49, 0.46], human: true }),
  businessman: atlas("people-a", 3, {
    rect: [0.49, 0.54, 0.51, 0.46],
    human: true,
  }),
  pilot: atlas("people-b", 0, { rect: [0.12, 0, 0.35, 0.49], human: true }),
  child: atlas("people-b", 1, { rect: [0.59, 0.02, 0.3, 0.46], human: true }),
  geographer: atlas("people-b", 2, {
    rect: [0.11, 0.49, 0.43, 0.49],
    human: true,
  }),
  astronomer: atlas("people-b", 3, {
    rect: [0.61, 0.48, 0.32, 0.51],
    human: true,
  }),
  lamplighter: atlas("people-c", 0, { human: true }),
  switchman: atlas("people-c", 1, { human: true }),
  merchant: atlas("people-c", 2, { human: true }),
  carrying: atlas("people-c", 3, {
    rect: [0.53, 0.49, 0.41, 0.5],
    human: true,
  }),
  gardening: atlas("prince-poses", 0, {
    rect: [0, 0, 0.49, 0.48],
    human: true,
    scarf: true,
  }),
  seated: atlas("prince-poses", 1, {
    rect: [0.56, 0, 0.43, 0.48],
    human: true,
    scarf: true,
  }),
  sad: atlas("prince-poses", 2, {
    rect: [0.04, 0.54, 0.49, 0.43],
    human: true,
    scarf: true,
  }),
  drinking: atlas("prince-poses", 3, { human: true, scarf: true }),
  clapping: atlas("gestures", 0, {
    rect: [0, 0, 0.49, 0.55],
    human: true,
    scarf: true,
  }),
  waving: atlas("gestures", 1, {
    rect: [0.5, 0, 0.5, 0.55],
    human: true,
    scarf: true,
  }),
  repairing: atlas("gestures", 2, {
    rect: [0, 0.56, 0.48, 0.44],
    human: true,
    scarf: true,
  }),
  resting: atlas("gestures", 3, {
    rect: [0.49, 0.68, 0.51, 0.29],
    scarf: true,
  }),
  wallSeated: atlas("story-poses", 0, { human: true, scarf: true }),
  embrace: atlas("story-poses", 1, { human: true }),
  bucketDrink: atlas("story-poses", 2, { human: true, scarf: true }),
  pilotRepair: atlas("story-poses", 3, { human: true }),
  plane: atlas("props-a", 0, { rect: [0, 0, 0.59, 0.49], cut: 3 }),
  sheep: atlas("props-a", 1, { rect: [0.58, 0.045, 0.4, 0.43], cut: 4 }),
  box: atlas("props-a", 2, { rect: [0, 0.54, 0.47, 0.43] }),
  baobab: atlas("props-a", 3, { rect: [0.47, 0.49, 0.53, 0.51], plant: true }),
  volcano: atlas("props-b", 0),
  lamp: atlas("props-b", 1),
  well: atlas("props-b", 2, { rect: [0.07, 0.53, 0.36, 0.44] }),
  train: atlas("props-b", 3, { rect: [0.49, 0.64, 0.5, 0.23] }),
  snake: atlas("props-c", 0),
  desertFlower: atlas("props-c", 1, { plant: true }),
  telescope: atlas("props-c", 2),
  bottles: atlas("props-c", 3),
  bucket: atlas("props-d", 0),
  bird: atlas("props-d", 1),
  wall: atlas("props-d", 2),
  drawing: atlas("drawings", 0),
  drawingInside: atlas("drawings", 1),
  drawingSheep: atlas("drawings", 2),
  drawingBox: atlas("drawings", 3),
  drawingSick: atlas("sheep-drawings-v2", 0),
  drawingRam: atlas("sheep-drawings-v2", 1),
  drawingOld: atlas("sheep-drawings-v2", 2),
  drawingCrate: atlas("sheep-drawings-v2", 3),
  princeChair: atlas("review-poses", 0, { rect: [0, 0, 0.5, 0.54] }),
  drinkingPair: atlas("review-poses", 1, { rect: [0.5, 0, 0.5, 0.54] }),
  pilotSeated: atlas("review-poses", 2, {
    rect: [0, 0.54, 0.5, 0.46],
    human: true,
  }),
  princeLying: atlas("review-poses", 3, {
    rect: [0.5, 0.7, 0.5, 0.25],
    scarf: true,
  }),
  drawer: atlas("review-props", 0),
  goldenSnake: atlas("review-props", 1),
  wateringCan: atlas("review-props", 2, { rect: [0, 0.5, 0.54, 0.5] }),
  seedlings: atlas("review-props", 3, {
    rect: [0.56, 0.5, 0.44, 0.5],
    plant: true,
  }),
  drawingCabbage: atlas("review-drawings", 0),
  drawingFox: atlas("review-drawings", 1),
  drawingMuzzle: atlas("review-drawings", 2),
  drawingVolcanoes: atlas("review-drawings", 3),
  astronomerEuropean: full("picturebook-cast/review-more.png", {
    rect: [0, 0, 0.36, 0.5],
    human: true,
  }),
  vainResting: full("picturebook-cast/review-more.png", {
    rect: [0.36, 0, 0.24, 0.5],
    human: true,
  }),
  pilotSleeping: full("picturebook-cast/review-more.png", {
    rect: [0.6, 0.3, 0.4, 0.2],
  }),
  princeTable: full("picturebook-cast/review-more.png", {
    rect: [0, 0.52, 0.39, 0.46],
  }),
  vainSaluting: full("picturebook-cast/review-more.png", {
    rect: [0.39, 0.5, 0.28, 0.48],
    human: true,
  }),
  drawerClosed: full("picturebook-cast/review-more.png", {
    rect: [0.68, 0.68, 0.32, 0.23],
  }),
  earthGlobe: atlas("review-world-v2", 0),
  volcanoDormant: atlas("review-world-v2", 1),
  almanac: atlas("review-world-v2", 2),
  trainWindow: atlas("review-world-v2", 3),
  glassGlobe: full("picturebook-rose-actors/rose-shelters.png", {
    rect: [0, 0, 0.48, 1],
  }),
  roseWatering: full("picturebook-rose-actors/prince-watering.png", {
    human: true,
    scarf: true,
  }),
  princeGround: full("picturebook-rose-actors/prince-seated.png", {
    scarf: true,
  }),
  pilotStanding: atlas("review-walking", 0, { human: true }),
  pilotWalking: atlas("review-walking", 1, { human: true }),
  princeWalking: atlas("review-walking", 2, { human: true, scarf: true }),
  walkingPair: atlas("review-walking", 3),
  rose: full("picturebook-fox-reading/rose.png", { plant: true }),
  desert: atlas("backgrounds", 0),
  mountain: atlas("backgrounds", 1),
  station: atlas("backgrounds", 2),
  study: atlas("backgrounds", 3),
  night: full("picturebook-cast/night-stage.png"),
  planet: full("picturebook-rose-actors/planet-stage.png"),
  meadow: full("picturebook-lookdev-v2/meadow.png"),
  garden: full("picturebook-fox-reading/rose-garden.png"),
  fountain: full("picturebook-cast/fountain.png"),
  pilotWell: full("picturebook-cast/pilot-well.png", { human: true }),
};

// x, ground y, height, facing multiplier, depth. Poses share a semantic id.
export const actor = (
  id,
  asset = id,
  x = 0,
  y = -3.4,
  h = 4.4,
  flip = 1,
  z = 2,
) => ({ id, asset, x, y, h, flip, z });
const p = (x = -2, asset = "prince", flip = 1) =>
  actor("prince", asset, x, -3.4, 4.3, flip, 4);
const adult = (asset, x = 1.6, h = 5.1, flip = 1) =>
  actor(asset, asset, x, -3.35, h, flip, 3);
const prop = (id, x, h = 2, y = -3.3, z = 1) => actor(id, id, x, y, h, 1, z);
const scene = (background, actors, targets, extras = {}) => ({
  background,
  actors,
  targets,
  ...extras,
});
const roseMemory = {
  rose: { asset: "rose", label: "想起自己的玫瑰" },
  sheep: { asset: "sheep", label: "想象中的绵羊" },
};
const common = { prince: "prince", wind: "prince", greeting: "prince" };
const encounters = (name, bg = "planet", extras = {}) =>
  scene(bg, [p(), adult(name)], { ...common, [name]: name, ...extras });
const desertPair = () =>
  scene(
    "desert",
    [
      p(1.9, "prince", -1),
      adult("pilot", -1.7, 4.7),
      prop("plane", -1.1, 4.8, -3.3, 0),
    ],
    {
      ...common,
      pilot: "pilot",
      plane: "plane",
      bolt: "pilot",
      hammer: "pilot",
    },
    { memory: roseMemory },
  );
const wellScene = (drink = false) =>
  scene(
    "desert",
    [
      p(drink ? -2 : -3.2, drink ? "bucketDrink" : "prince"),
      prop("well", drink ? 1.2 : 2, drink ? 5.3 : 6.3),
      ...(drink
        ? []
        : [
            actor("pilot", "pilotWell", -1.3, -3.4, 5.3, 1, 3),
            actor("bucket", "bucket", 2, -2.3, 1.0, 1, 5),
          ]),
    ],
    {
      ...common,
      ...(drink ? {} : { pilot: "pilot" }),
      bucket: drink ? "prince" : "bucket",
      pulley: drink ? "well" : "bucket",
      rope: drink ? "well" : "bucket",
      water: drink ? "prince" : "bucket",
    },
    { well: !drink, bucket: drink ? 1 : 0 },
  );
export const castScenes = {
  "ch01-01": scene(
    "study",
    [adult("child", -0.7, 4.7), prop("drawing", 2.5, 1.8, -2.3, 5)],
    { child: "child", drawing: "drawing" },
  ),
  "ch01-02": scene(
    "desert",
    [
      adult("pilot", -0.5, 5),
      prop("plane", 1, 4.8, -3.3, 0),
      prop("drawing", -2.8, 1.5, -1.7, 5),
    ],
    { pilot: "pilot", plane: "plane", drawing: "drawing" },
  ),
  "ch02-01": desertPair(),
  "ch02-02": scene(
    "desert",
    [
      p(2, "prince", -1),
      adult("pilot", -1.6, 4.8),
      prop("plane", 2.6, 2.8, -1.1, 0),
      prop("drawing", -0.1, 2.5, -2.8, 5),
    ],
    { ...common, pilot: "pilot", plane: "plane", drawing: "drawing" },
    { memory: { sheep: { asset: "sheep", label: "他想要的小羊" } } },
  ),
  "ch02-03": scene(
    "desert",
    [
      p(2, "prince", -1),
      adult("pilot", -1.7, 4.8),
      prop("plane", 2.6, 2.8, -1.1, 0),
      prop("box", 0.2, 2.5, -3.1, 5),
    ],
    { ...common, plane: "plane", box: "box", drawing: "box" },
    { memory: { sheep: { asset: "sheep", label: "箱子里的小羊 · 想象" } } },
  ),
  "ch03-01": desertPair(),
  "ch03-02": scene(
    "desert",
    [p(0.8, "prince", -1), prop("box", -2, 1.7)],
    { ...common, box: "box", rope: "box" },
    { memory: { sheep: { asset: "sheep", label: "小王子想象的小羊" } } },
  ),
  "ch04-01": scene("planet", [p(0.7)], {
    ...common,
    planet: "sky",
    stars: "sky",
  }),
  "ch04-02": scene(
    "night",
    [adult("astronomer", -1.3, 5.7), prop("telescope", 1.7, 3.8)],
    {
      astronomer: "astronomer",
      telescope: "telescope",
      planet: "sky",
      stars: "sky",
    },
    { memory: { prince: { asset: "prince", label: "他的故乡 · B 612" } } },
  ),
  "ch04-03": scene(
    "study",
    [adult("pilot", -0.7, 5), prop("drawing", 2.4, 1.7, -2, 5)],
    { pilot: "pilot", drawing: "drawing" },
    { memory: { prince: { asset: "prince", label: "六年后 · 回忆中的朋友" } } },
  ),
  "ch05-01": scene(
    "planet",
    [p(-1, "gardening"), prop("baobab", 1.7, 0.9)],
    { ...common, baobabs: "baobab", sheep: "memory" },
    { memory: roseMemory },
  ),
  "ch05-02": scene(
    "planet",
    [p(-2.5), prop("baobab", 1, 7.6, -3.7, 0)],
    { ...common, baobabs: "baobab" },
    { label: "如果放任树苗生长 · 想象" },
  ),
  "ch05-03": scene("planet", [p(-1, "gardening"), prop("baobab", 1.7, 1.2)], {
    ...common,
    baobabs: "baobab",
  }),
  "ch06-01": scene(
    "planet",
    [p(0, "seated", 1)],
    { ...common, sunset: "sun", chair: "prince", sad: "prince" },
    { sun: true },
  ),
  "ch07-01": {
    ...desertPair(),
    actors: [
      p(1.9, "prince", -1),
      actor("pilot", "pilotRepair", -1.7, -3.3, 4.8),
      prop("plane", -1.1, 4.8, -3.3, 0),
    ],
  },
  "ch07-02": { ...desertPair(), memory: roseMemory },
  "ch07-03": scene(
    "night",
    [actor("embrace", "embrace", 0, -3.4, 5.2)],
    { prince: "embrace", pilot: "embrace", wind: "embrace" },
    { memory: roseMemory },
  ),
  "ch09-01": scene(
    "planet",
    [
      p(-0.7, "gardening"),
      prop("volcano", 2.5, 2.3, -3.1),
      prop("volcanoSmall", -3, 1.4, -2.4),
      actor("volcanoExtinct", "volcano", 2.8, -1.9, 1.1, 1, 0),
    ],
    { ...common, volcano: "volcano", birds: "bird" },
    { birds: true },
  ),
  "ch09-02": scene(
    "planet",
    [p(-1.9, "waving", -1), prop("rose", 1.7, 2.4)],
    { ...common, rose: "rose", globe: "rose", birds: "bird" },
    { birds: true },
  ),
  "ch10-01": encounters("king", "planet", {
    king: "king",
    crown: "king",
    command: "king",
  }),
  "ch10-02": encounters("king", "planet", {
    king: "king",
    crown: "king",
    command: "king",
  }),
  "ch11-01": encounters("vain", "planet", {
    man: "vain",
    hat: "vain",
    clap: "prince",
  }),
  "ch11-02": scene("planet", [p(-2, "clapping"), adult("vain", 1.6, 5.4)], {
    ...common,
    man: "vain",
    hat: "vain",
    clap: "prince",
  }),
  "ch12-01": scene(
    "planet",
    [p(-2.1), adult("tippler", 1, 4.4), prop("bottles", 2.8, 1.5, -3.4, 5)],
    { ...common, man: "tippler", bottle: "bottles" },
  ),
  "ch12-02": scene(
    "planet",
    [p(-2.1), adult("tippler", 1, 4.4), prop("bottles", 2.8, 1.5, -3.4, 5)],
    { ...common, man: "tippler", bottle: "bottles" },
  ),
  "ch13-01": encounters("businessman", "night", {
    businessman: "businessman",
    count: "businessman",
    paper: "businessman",
    drawer: "businessman",
    stars: "sky",
  }),
  "ch13-02": encounters("businessman", "night", {
    businessman: "businessman",
    count: "businessman",
    paper: "businessman",
    drawer: "businessman",
    stars: "sky",
  }),
  "ch14-01": scene(
    "planet",
    [p(-2.5), adult("lamplighter", 0.3, 5.4, -1), prop("lamp", 2.5, 6.7)],
    { ...common, lamp: "lamp", lamplighter: "lamplighter", sunset: "sun" },
    { lamp: true, sun: true },
  ),
  "ch14-02": scene(
    "planet",
    [p(-2.5), adult("lamplighter", 0.3, 5.4, -1), prop("lamp", 2.5, 6.7)],
    { ...common, lamp: "lamp", lamplighter: "lamplighter", sunset: "sun" },
    { lamp: true, sun: true },
  ),
  "ch15-01": encounters("geographer", "study", {
    geographer: "geographer",
    book: "geographer",
  }),
  "ch15-02": {
    ...encounters("geographer", "study", {
      geographer: "geographer",
      book: "geographer",
    }),
    memory: { rose: { asset: "rose", label: "想到远方的玫瑰 · 回忆" } },
  },
  "ch16-01": scene(
    "night",
    [adult("lamplighter", -1.1, 4.8, -1), prop("lamp", 1.8, 6.7)],
    { lamp: "lamp", lamplighter: "lamplighter", planet: "sky", stars: "sky" },
    { lamp: true, earth: true },
  ),
  "ch17-01": scene(
    "desert",
    [p(-1.5), prop("snake", 2, 1.6)],
    { ...common, snake: "snake", stars: "sky" },
    { memory: roseMemory },
  ),
  "ch17-02": scene(
    "desert",
    [p(-0.4), prop("snake", 0.2, 1.5, -3.3, 6)],
    { ...common, snake: "snake" },
    { memory: roseMemory },
  ),
  "ch18-01": scene("desert", [p(-1.5), prop("desertFlower", 1.6, 1.7)], {
    ...common,
    flower: "desertFlower",
    flowers: "desertFlower",
    wind: "desertFlower",
  }),
  "ch19-01": scene(
    "mountain",
    [p(-0.6)],
    { ...common, echo: "echo" },
    { echo: true },
  ),
  "ch20-01": scene(
    "garden",
    [
      p(-1.4),
      prop("rose", 2, 2.5),
      actor("rose2", "rose", 0.4, -3.7, 1.8),
      actor("rose3", "rose", 3.1, -2.9, 1.7),
    ],
    { ...common, rose: "rose", flowers: "rose", flower: "rose" },
    { memory: { homeRose: { asset: "rose", label: "自己的那一朵 · 回忆" } } },
  ),
  "ch20-02": scene(
    "garden",
    [
      p(-1, "sad"),
      prop("rose", 2, 2.5),
      actor("rose2", "rose", 0.3, -3.8, 1.8),
      actor("rose3", "rose", 3.2, -2.8, 1.7),
    ],
    { ...common, rose: "rose", flowers: "rose", flower: "rose" },
  ),
  "ch22-01": scene(
    "station",
    [p(-2), adult("switchman", 1.4, 5.2), prop("train", 0, 2, -0.8, 0)],
    { ...common, train: "train", switchman: "switchman", children: "train" },
    { train: true },
  ),
  "ch22-02": scene(
    "station",
    [p(-2), adult("switchman", 1.4, 5.2), prop("train", 0, 2, -0.8, 0)],
    { ...common, train: "train", switchman: "switchman", children: "train" },
    { train: true },
  ),
  "ch23-01": encounters("merchant", "desert", {
    merchant: "merchant",
    pills: "merchant",
  }),
  "ch23-02": {
    ...encounters("merchant", "desert", {
      merchant: "merchant",
      pills: "merchant",
    }),
    memory: { water: { asset: "fountain", label: "他想走向的泉水 · 想象" } },
  },
  "ch24-01": scene(
    "night",
    [p(1.9, "prince", -1), adult("pilot", -1.8, 4.7)],
    { ...common, pilot: "pilot", stars: "sky" },
    { memory: roseMemory },
  ),
  "ch24-02": scene(
    "night",
    [adult("carrying", 0, 5.6)],
    { pilot: "carrying", prince: "carrying", wind: "carrying", stars: "sky" },
    { memory: roseMemory },
  ),
  "ch24-03": scene(
    "desert",
    [adult("carrying", -1.8, 5.5), prop("well", 2, 4.7)],
    { pilot: "carrying", prince: "carrying", bucket: "well" },
  ),
  "ch25-01": wellScene(),
  "ch25-02": wellScene(true),
  "ch26-01": scene(
    "night",
    [
      prop("wall", 0, 2.7, -3.7),
      actor("prince", "wallSeated", 0, -2.6, 3.7, 1, 4),
      prop("snake", 2.4, 1.1, -3.6, 5),
    ],
    { ...common, snake: "snake", wall: "wall" },
    { memory: roseMemory },
  ),
  "ch26-02": scene(
    "night",
    [
      actor("embrace", "embrace", -0.5, -3.4, 5.4),
      prop("wall", 1.8, 2, -3.1, 0),
    ],
    { prince: "embrace", pilot: "embrace", wind: "embrace", stars: "sky" },
    { memory: roseMemory },
  ),
  "ch26-03": scene(
    "night",
    [p(0.6, "prince", -1), adult("pilot", -2, 4.6)],
    { ...common, pilot: "pilot", stars: "sky" },
    { memory: roseMemory },
  ),
  "ch26-04": scene(
    "night",
    [p(0.2), prop("snake", 1.5, 0.9, -3.4, 5)],
    { ...common, snake: "snake", stars: "sky" },
    { fall: true },
  ),
  "ch27-01": scene(
    "night",
    [adult("pilot", -1, 4.7)],
    { pilot: "pilot", stars: "sky" },
    {
      memory: {
        ...roseMemory,
        prince: { asset: "prince", label: "六年后 · 回忆中的小王子" },
      },
    },
  ),
  "ch27-02": scene(
    "night",
    [],
    { stars: "sky" },
    {
      memory: { prince: { asset: "prince", label: "盼望重逢 · 并非已经归来" } },
    },
  ),
};
// Reuse a prop with a distinct stable identity, without introducing another file.
castScenes["ch09-01"].actors.find((a) => a.id === "volcanoSmall").asset =
  "volcano";
