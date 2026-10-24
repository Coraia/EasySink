import { actor } from "./picturebook-cast-catalog.js";
const object = (id, asset, x, y, h, z = 3, flip = 1) =>
  actor(id, asset, x, y, h, flip, z);
const remove = (s, ...ids) => {
  s.actors = s.actors.filter((a) => !ids.includes(a.id));
};
const put = (s, a) => {
  remove(s, a.id);
  s.actors.push(a);
};
const pose = (s, asset, extras = {}) => {
  const prince = s.actors.find((a) => a.id === "prince");
  if (prince) Object.assign(prince, { asset }, extras);
  s.lockPose = true;
};
const memory = (s, asset, label) => {
  s.editorialMemory = { asset, label };
};
const plane = () => object("plane", "plane", 2.6, -1.1, 2.8, 0);
const pilot = () => object("pilot", "pilotSeated", -2.5, -3.35, 4.1, 3);
const volcanoes = () => [
  object("volcano", "volcano", 2.8, -1.8, 1.5, 0),
  object("volcanoSmall", "volcano", -3.5, -0.6, 1.2, 0),
  object("volcanoExtinct", "volcanoDormant", 0.1, -1.0, 1.1, 0),
];

// Build all moments in source order once. Every resulting recipe is independent:
// reverse seeking, keyboard navigation and resume must reproduce the same state.
export function refineCastMoment(s, line, n, state) {
  const b = line.blockIndex,
    t = line.text.toLowerCase();
  if (n === 2 && b === 1) {
    if (/awakened at daybreak/.test(t)) state.awake = true;
    if (!state.awake) {
      s.background = "night";
      remove(s, "prince");
      put(s, object("pilot", "pilotSleeping", -0.8, -3.35, 2.2, 4));
      s.label = "第一夜 · 飞行员独自在沙漠睡着了";
    } else {
      s.label = "黎明 · 一个小小的声音";
    }
  }
  if (n === 3) {
    if (!s.actors.some((a) => a.id === "plane")) s.actors.push(plane());
    if (!s.actors.some((a) => a.id === "pilot")) s.actors.push(pilot());
    s.targets = { ...s.targets, plane: "plane", pilot: "pilot" };
    if (b >= 10) put(s, object("box", "drawingCrate", -0.1, -2.8, 2.3, 5));
    s.sourceState = b >= 10 ? "crate-conversation" : "plane-conversation";
  }
  if (n === 4) {
    if (b < 3) s.label = "飞行员讲述小王子的故乡 · 示意";
    if (b === 5 && /so in 1920|this time everybody/.test(t))
      state.european = true;
    if (b >= 3 && b <= 5) {
      s.label = state.european
        ? "1920年 · 换上欧洲服装再次报告"
        : "1909年 · 土耳其天文学家";
      if (state.european)
        s.actors.find((a) => a.id === "astronomer").asset =
          "astronomerEuropean";
    }
    if (b >= 6 && b < 13) {
      s.background = "study";
      s.actors = [object("pilot", "pilot", -1.3, -3.35, 4.8)];
      s.targets = { pilot: "pilot" };
      s.label = "飞行员回想大人怎样看待数字与朋友";
    }
    if (b >= 13) {
      s.label = "六年后 · 飞行员重新拿起画笔";
      if (b === 13) remove(s, "drawing");
      else s.actors.find((a) => a.id === "drawing").asset = "drawingCrate";
      memory(s, "prince", "想画得像一点 · 回忆中的朋友");
    }
  }
  if (n === 5) {
    s.lockPose = true;
    s.label =
      b === 14 ? "放任猴面包树生长的后果 · 想象" : "小王子回忆自己的星球";
    const tree = s.actors.find((a) => a.id === "baobab");
    if (tree && b !== 14) tree.asset = "seedlings";
    if (b >= 6 && b <= 8) memory(s, "baobab", "成年猴面包树 · 与幼苗比较");
    if (b >= 17) {
      s.label = "飞行员画下的警示 · 示意";
      memory(s, "baobab", "长成大树后，根会破坏小星球");
    }
  }
  if (n === 6) {
    pose(s, "princeChair");
    s.label = "回想故乡的日落 · 挪一挪椅子就能再看";
    s.sourceState = "chair-sunset";
  }
  if (n === 7) {
    if (!s.actors.some((a) => a.id === "plane")) s.actors.push(plane());
    s.targets.plane = "plane";
    if (b < 32) {
      const p = s.actors.find((a) => a.id === "pilot");
      if (p) p.asset = "pilotRepair";
    }
    if (b >= 31 && b < 32) pose(s, "sad");
    if (b >= 32) s.label = "天黑了 · 放下工具，抱住哭泣的小王子";
    if (b >= 24 && b <= 28) s.label = "“蘑菇”是小王子生气时的比喻";
  }
  if (n === 9) {
    s.lockPose = true;
    s.actors = s.actors.filter((a) => !a.id.startsWith("volcano"));
    s.actors.push(...volcanoes());
    s.targets.volcano = "volcano";
    if (b === 2) {
      if (/watered the flower/.test(t)) state.lastWater = true;
      if (state.lastWater) {
        pose(s, "roseWatering", { x: -1.7, h: 4.3, flip: -1 });
        put(s, object("rose", "rose", 1.5, -3.3, 2.6, 3));
        put(s, object("globe", "glassGlobe", 3.1, -3.3, 2.7, 5));
        s.label = "最后一次浇水 · 准备玻璃罩";
      } else {
        put(s, object("seedlings", "seedlings", 1.4, -3.3, 1.0));
        s.label = "出发前，拔掉最后的猴面包树嫩芽";
      }
    }
    if (b >= 3) {
      // The globe is held in mid-air, then put aside at the rose's request.
      put(
        s,
        object(
          "globe",
          "glassGlobe",
          b >= 9 ? -3 : 0.1,
          b >= 9 ? -3.3 : -0.1,
          2.6,
          5,
        ),
      );
      s.targets.globe = "globe";
      s.label =
        b >= 9 ? "玫瑰不愿再要玻璃罩 · 罩子放在一旁" : "告别 · 玻璃罩停在半空";
    }
    if (b === 0) s.label = "两座活火山，一座不冒烟的死火山";
  }
  if (n === 10) {
    if (b >= 17 && b < 51) pose(s, "princeGround", { h: 3.2 });
    if (b >= 38 && b < 53)
      put(s, object("almanac", "almanac", 1.4, -1.2, 1.4, 5));
    if (b >= 53) {
      s.depart = true;
      pose(s, "prince");
      s.label = "小王子向国王告别";
    }
    if (b >= 56) {
      remove(s, "king", "almanac");
      s.label = "已经离开国王的星球";
    }
  }
  if (n === 11) {
    if (b === 7 && /raised his hat/.test(t)) state.hatRaised = true;
    const vain = s.actors.find((a) => a.id === "vain");
    if (vain) vain.asset = state.hatRaised ? "vainSaluting" : "vainResting";
    if (b < 7 || b >= 9) pose(s, "prince");
    if (b >= 18) {
      s.depart = true;
      s.label = "告别只愿听见赞美的人";
    }
    if (b >= 19) remove(s, "vain");
    s.sourceState = state.hatRaised ? "hat-raised" : "hat-on-head";
  }
  if (n === 12) {
    if (b >= 9) {
      s.depart = true;
      s.label = "小王子困惑地离开";
    }
    if (b >= 10) remove(s, "tippler", "bottles");
  }
  if (n === 13) {
    if (b === 45 && /and then i put/.test(t)) state.drawerClosed = true;
    if (b >= 45) {
      put(
        s,
        object(
          "drawer",
          state.drawerClosed ? "drawerClosed" : "drawer",
          1.7,
          -3.35,
          1.7,
          5,
        ),
      );
      s.targets.drawer = "drawer";
      s.targets.paper = "drawer";
      s.label = "锁进抽屉的是记录星星数量的纸";
    }
    if (b === 50) memory(s, "drawingVolcanoes", "小王子想起自己的三座火山");
    if (b >= 51) s.depart = true;
    if (b >= 52) {
      remove(s, "businessman", "drawer");
      s.label = "小王子离开数星星的商人";
    }
    s.sourceState = state.drawerClosed
      ? "number-paper-locked"
      : b >= 45
        ? "number-paper-drawer"
        : "counting-stars";
  }
  if (n === 14) {
    if (b === 7 || b === 23) state.lamp = true;
    if (b === 3 || b === 12 || (b === 32 && /put out/.test(t)))
      state.lamp = false;
    s.lampOn = !!state.lamp;
    if (b >= 33) {
      s.depart = true;
      s.label = "小王子离开忠于职守的点灯人";
    }
    if (b >= 34) remove(s, "lamplighter", "lamp");
  }
  if (n === 15) {
    if (b >= 2 && b < 48) pose(s, "princeTable", { x: -2.4, h: 4.2 });
    if (b >= 44) memory(s, "rose", "留在故乡、可能消逝的玫瑰 · 回忆");
    if (b >= 48) {
      pose(s, "prince");
      s.depart = true;
      s.label = "带着对玫瑰的牵挂，启程去地球";
    }
  }
  if (n === 16) {
    put(s, object("earth", "earthGlobe", 0, 0.1, 4.8, 0));
    s.targets.planet = "earth";
    s.label = "原文里的旧时代地球 · 全球点灯人的示意";
  }
  if (n === 17) {
    if (b < 2) {
      remove(s, "snake");
      s.label = "飞行员介绍地球，故事还没有进入相遇";
    } else {
      s.background = "night";
      const snake = s.actors.find((a) => a.id === "snake");
      if (snake) {
        snake.asset = "goldenSnake";
        snake.h = b >= 23 ? 0.65 : 1.15;
        snake.x = b >= 23 ? -0.15 : 2;
        snake.y = -3.35;
        s.snakeWrapped = b >= 23;
      }
      if (b >= 9 && b < 23) pose(s, "princeGround", { h: 3.5 });
      if (b >= 23) {
        pose(s, "prince");
        s.label = "金色的蛇缠在脚踝，像一只手镯";
      }
    }
    s.sourceState =
      b >= 23
        ? "snake-around-ankle"
        : b >= 2
          ? "snake-first-meeting"
          : "earth-introduction";
  }
  if (n === 18) {
    s.label = "只有三片花瓣的小花 · 不是玫瑰";
    if (b >= 6) s.depart = true;
  }
  if (n === 19) {
    s.sourceAction = [3, 5, 7].includes(b) ? "echo" : "listen";
    s.sourceTarget = [3, 5, 7].includes(b) ? "echo" : "prince";
    s.label = [3, 5, 7].includes(b)
      ? "回答他的只有山里的回声"
      : "山上没有人 · 小王子独自说话";
  }
  if (n === 20) {
    if (b === 0) {
      s.background = "desert";
      remove(s, "rose", "rose2", "rose3");
      s.label = "走过沙石和积雪，终于找到一条路";
    }
    if (b >= 7 && b < 10)
      memory(s, "rose", "以为独一无二的那一朵 · 故乡的回忆");
    if (b >= 10) {
      pose(s, "princeLying", { x: -0.5, h: 2.4 });
      s.label = "伏在草地上哭泣";
    }
    s.sourceState =
      b >= 10 ? "lying-crying" : b === 0 ? "road-before-garden" : "rose-garden";
  }
  if (n === 22) {
    s.trainNumber = b >= 12 ? 3 : b >= 7 ? 2 : b >= 4 ? 1 : 0;
    if (b < 4) {
      s.train = false;
      remove(s, "train");
      s.label = "道岔旁交谈 · 列车还没有驶来";
    } else
      s.label = [
        "",
        "第一列快车驶过",
        "第二列快车 · 相反的方向",
        "第三列快车驶过",
      ][s.trainNumber];
    if (b >= 14) memory(s, "trainWindow", "车窗里的其他孩子 · 放大看");
    s.sourceState = "train-" + s.trainNumber;
  }
  if (n === 23) {
    s.label =
      b >= 7 ? "小王子想象慢慢走向清泉 · 并未到达" : "故事里售卖解渴药丸的商人";
  }
  if (n === 24) {
    if (b <= 10) {
      s.actors.push(plane());
      s.targets.plane = "plane";
      put(s, object("pilot", "pilotStanding", -2.5, -3.35, 4.8));
    }
    if (b === 11) s.label = "离开飞机，开始寻找水井";
    if (b >= 11 && b < 17) {
      put(s, object("pilot", "pilotWalking", -2.3, -3.35, 4.8));
      pose(s, "princeWalking", { h: 4.3, flip: -1 });
      s.walk = true;
      s.label =
        b >= 12 ? "夜里继续寻找水井 · 还没有找到" : "离开飞机，开始寻找水井";
    }
    if (b >= 17 && b < 26) {
      put(s, pilot());
      pose(s, "princeGround", { h: 3.6 });
      s.label = "两人坐在沙丘上 · 水井还藏在远处";
    }
    if (b >= 26 && b < 28) s.label = "飞行员抱着睡着的小王子继续走";
    if (b >= 28) s.label = "直到黎明，才发现水井";
  }
  if (n === 25) {
    s.targets.well = "well";
    if (b === 12 && /he drank/.test(t)) state.drinking = true;
    if (b >= 13) state.drinking = false;
    if (b === 12) {
      remove(s, "prince", "pilot", "bucket");
      put(s, object("drinkPair", "drinkingPair", -1.7, -3.35, 5.2, 4));
      s.targets = {
        ...s.targets,
        prince: "drinkPair",
        pilot: "drinkPair",
        water: "drinkPair",
        bucket: "drinkPair",
      };
      s.label = "飞行员把木桶举到小王子嘴边";
    }
    if (b >= 13) {
      put(s, object("prince", "prince", 1.8, -3.4, 4.3, 4, -1));
      put(s, pilot());
      put(s, object("bucket", "bucket", 0.0, -3.3, 0.9, 3));
      s.targets = {
        ...s.targets,
        pilot: "pilot",
        prince: "prince",
        bucket: "bucket",
        water: "bucket",
      };
      s.label = "喝完水，木桶放下，两人在井边交谈";
      line.caption = "喝完水，继续说说心里的话";
    }
    if (b >= 20) {
      pose(s, "princeGround", { h: 3.6 });
    }
    if (b >= 23) {
      line.caption = "兑现给小羊画嘴套的承诺";
      const asset =
        b <= 26
          ? "drawingCabbage"
          : b <= 28
            ? "drawingFox"
            : b <= 30
              ? "drawing"
              : "drawingMuzzle";
      put(s, object("drawing", asset, -0.1, -2.8, 2.3, 5));
      s.targets.drawing = "drawing";
      s.label =
        b <= 26
          ? "草图 · 像卷心菜的猴面包树"
          : b <= 28
            ? "草图 · 耳朵像角的狐狸"
            : b <= 30
              ? "飞行员回想自己会画的蟒蛇"
              : "给羊的嘴套草图 · 没有画皮带";
    }
    s.sourceState =
      b >= 31
        ? "muzzle-sketch"
        : b >= 27 && b <= 28
          ? "fox-sketch"
          : b >= 23 && b <= 26
            ? "baobab-sketch"
            : b >= 13
              ? "after-drinking"
              : b === 12
                ? "pilot-offers-water"
                : "well-bucket";
  }
  if (n === 26) {
    if (b < 65) {
      put(s, object("well", "well", 3.0, -2.7, 2.8, 0));
      s.targets.well = "well";
    }
    if (b >= 43 && b < 65) put(s, object("wall", "wall", 1.4, -2.7, 1.8, 0));
    if (b < 12) {
      put(s, object("pilot", "pilotWalking", -3, -3.35, 4.7));
      s.label = "第二天傍晚 · 水井旁的石墙";
    }
    if (b >= 12 && b < 65) {
      const talkingPilot = s.actors.find((a) => a.id === "pilot");
      if (talkingPilot?.asset === "pilot") {
        Object.assign(talkingPilot, { asset: "pilotStanding", h: 4.8 });
      }
    }
    const snake = s.actors.find((a) => a.id === "snake");
    if (snake) {
      snake.asset = "goldenSnake";
      snake.h = 0.65;
    }
    if (b === 11 && /disappeared/.test(t)) {
      remove(s, "snake");
      s.label = "金色的蛇已经消失在石缝里";
    }
    if (b === 67 && /took me by the hand/.test(t)) state.holdingHands = true;
    if (b >= 65 && b < 79) {
      pose(s, "princeWalking", { h: 4.3, flip: -1 });
      put(s, object("pilot", "pilotWalking", -2.4, -3.35, 4.8));
      s.label = "那天夜里 · 飞行员跟上小王子";
      if (state.holdingHands) {
        remove(s, "prince", "pilot");
        put(s, object("walkPair", "walkingPair", 0, -3.4, 5.1, 4));
        s.label = "那天夜里 · 两人牵着手往前走";
        s.targets = {
          ...s.targets,
          prince: "walkPair",
          pilot: "walkPair",
          wind: "walkPair",
        };
      }
    }
    if (b >= 79) {
      put(
        s,
        object(
          "pilot",
          b >= 82 ? "pilotSeated" : "pilotStanding",
          -2.5,
          -3.35,
          b >= 82 ? 4.1 : 4.8,
        ),
      );
    }
    if (b >= 80 && b < 84) pose(s, "princeGround", { h: 3.6 });
    if (b >= 84) {
      pose(s, "prince");
      s.walk = false;
    }
    if (b === 85) {
      if (/feel as gently/.test(t)) state.fallen = true;
      if (state.fallen) {
        pose(s, "resting", { h: 2.1 });
        s.fall = true;
        s.label = "金色一闪之后，他轻轻倒在沙地上";
      } else {
        s.fall = false;
        s.label = "脚踝旁一闪金黄 · 他一瞬间没有动";
      }
      s.snakeWrapped = true;
      const snake = s.actors.find((a) => a.id === "snake");
      if (snake) {
        snake.x = 0.35;
        snake.y = -3.35;
      }
      if (state.fallen) remove(s, "snake");
    }
    s.sourceState = state.fallen
      ? "fallen-on-sand"
      : b >= 85
        ? "yellow-flash"
        : b >= 65
          ? "night-walk"
          : b < 12
            ? "wall-and-well"
            : "farewell-conversation";
  }
  if (n === 27) {
    s.label = b >= 8 ? "六年后 · 空沙漠，等待可能的重逢" : "六年后的回忆与牵挂";
    if (b >= 2 && b <= 6)
      memory(s, "drawingMuzzle", "飞行员忘画了嘴套的皮带 · 回忆");
    s.sourceState = b >= 8 ? "empty-desert-ending" : "six-years-later";
  }
  const groundedPlane = s.actors.find((a) => a.id === "plane");
  if (groundedPlane && s.background === "night")
    Object.assign(groundedPlane, { x: 2.6, y: -3.4, h: 2.3 });
  if (s.label) line.cue = s.label;
  return s;
}
