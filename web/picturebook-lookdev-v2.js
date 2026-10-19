import * as THREE from "./vendor/three-0.186.0/three.module.js";

// Painted reliefs: all depth is authored below; these are not reconstructed full 3D heads.
const stage = document.querySelector("#stage");
const status = document.querySelector("#status");
const names = { scene: "同一画页", fox: "狐狸", prince: "小王子" };
const state = {
  view: "scene",
  action: "idle",
  paused: matchMedia("(prefers-reduced-motion: reduce)").matches,
  close: false,
  previous: false,
};
const base = "./assets/picturebook-lookdev-v2/";
const smooth = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const bell = (x, y, cx, cy, rx, ry) =>
  Math.exp(-(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) * 2);
let renderer,
  scene,
  camera,
  backdrop,
  fox,
  prince,
  animation,
  disposed = false,
  visible = true;
let time = 0,
  last = performance.now(),
  pointer = { x: 0, y: 0 },
  orbit = { x: 0, y: 0 },
  actionStrength = 0;
let frames = 0,
  elapsed = 0,
  sampleFrames = 0,
  lastTelemetry = 0;
const actors = [];
const controls = new AbortController();
const on = (node, event, fn) =>
  node.addEventListener(event, fn, { signal: controls.signal });

function actor(texture, kind) {
  const aspect = texture.image.width / texture.image.height;
  const height = kind === "fox" ? 4.05 : 7.7;
  const width = height * aspect;
  const geometry = new THREE.PlaneGeometry(width, height, 120, 120);
  const pos = geometry.attributes.position;
  const original = new Float32Array(pos.array);
  const data = [];
  for (let i = 0; i < pos.count; i++) {
    const u = geometry.attributes.uv.getX(i),
      v = 1 - geometry.attributes.uv.getY(i);
    let z;
    if (kind === "fox") {
      z =
        0.46 * bell(u, v, 0.4, 0.5, 0.38, 0.24) +
        0.55 * bell(u, v, 0.24, 0.27, 0.19, 0.24) +
        0.18 * bell(u, v, 0.77, 0.7, 0.22, 0.22);
    } else {
      z =
        0.44 * bell(u, v, 0.61, 0.52, 0.25, 0.31) +
        0.52 * bell(u, v, 0.64, 0.18, 0.23, 0.19) +
        0.2 * bell(u, v, 0.26, 0.43, 0.33, 0.15);
    }
    original[i * 3 + 2] = z;
    data.push({ u, v, z });
  }
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.035,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = kind;
  mesh.renderOrder = kind === "fox" ? 3 : 2;
  scene.add(mesh);
  const item = {
    mesh,
    original,
    data,
    width,
    height,
    kind,
    goal: new THREE.Vector3(),
    scale: 1,
  };
  actors.push(item);
  return item;
}

function deform(item, t, amount) {
  const { mesh, original, data, width: w, height: h, kind } = item,
    p = mesh.geometry.attributes.position;
  let maxMovement = 0;
  for (let i = 0; i < p.count; i++) {
    const { u, v, z } = data[i];
    let x = original[i * 3],
      y = original[i * 3 + 1],
      zz = z;
    if (kind === "fox") {
      const tail = smooth(0.57, 0.83, u) * smooth(0.36, 0.56, v);
      const ears =
        (1 - smooth(0.14, 0.27, v)) *
        smooth(0.12, 0.18, u) *
        (1 - smooth(0.29, 0.36, u));
      const head = (1 - smooth(0.31, 0.47, v)) * (1 - smooth(0.34, 0.46, u));
      const excited =
        state.action === "fox"
          ? amount
          : state.action === "greeting"
            ? amount * 0.6
            : 0;
      const wind = state.action === "wind" ? amount : 0;
      y +=
        tail * (Math.sin(t * 2.4) * (0.045 + excited * 0.14 + wind * 0.1)) * h;
      zz += tail * Math.sin(t * 2.4 + 0.6) * (0.04 + excited * 0.25);
      x += ears * Math.sin(t * 2.2) * (0.004 + excited * 0.025) * w;
      y += ears * excited * 0.022 * h;
      const turn = Math.sin(t * 1.7) * (0.007 + excited * 0.034);
      const px = (0.29 - 0.5) * w,
        py = (0.5 - 0.39) * h;
      const dx = x - px,
        dy = y - py;
      x += (Math.cos(turn) * dx - Math.sin(turn) * dy - dx) * head;
      y += (Math.sin(turn) * dx + Math.cos(turn) * dy - dy) * head;
      y += Math.sin(t * 1.75) * 0.012 * h * bell(u, v, 0.35, 0.51, 0.24, 0.22);
    } else {
      const scarf =
        (1 - smooth(0.36, 0.5, u)) *
        smooth(0.24, 0.32, v) *
        (1 - smooth(0.54, 0.62, v));
      const hair = (1 - smooth(0.15, 0.26, v)) * smooth(0.38, 0.47, u);
      const head = 1 - smooth(0.24, 0.31, v);
      const greet =
        state.action === "prince" || state.action === "greeting" ? amount : 0;
      const wind = state.action === "wind" ? amount : 0;
      y += scarf * Math.sin(t * 2.6 + u * 5) * (0.012 + wind * 0.035) * h;
      zz += scarf * Math.sin(t * 2.6 + u * 5 + 0.7) * (0.07 + wind * 0.22);
      x += hair * Math.sin(t * 2 + u * 13) * (0.0013 + wind * 0.0035) * w;
      const angle = Math.sin(t * 1.8) * (0.004 + greet * 0.029);
      const px = (0.59 - 0.5) * w,
        py = (0.5 - 0.28) * h,
        dx = x - px,
        dy = y - py;
      x += (Math.cos(angle) * dx - Math.sin(angle) * dy - dx) * head;
      y += (Math.sin(angle) * dx + Math.cos(angle) * dy - dy) * head;
      x += Math.sin(t * 1.7) * 0.005 * w * bell(u, v, 0.61, 0.45, 0.23, 0.2);
      y += Math.sin(t * 1.7) * 0.002 * h * (1 - smooth(0.7, 0.88, v));
    }
    p.setXYZ(i, x, y, zz);
    maxMovement = Math.max(
      maxMovement,
      Math.abs(x - original[i * 3]) + Math.abs(y - original[i * 3 + 1]),
    );
  }
  p.needsUpdate = true;
  item.movement = maxMovement;
}

function layout(instant = false) {
  const inScene = state.view === "scene";
  backdrop.visible = inScene;
  stage.classList.toggle("portrait", !inScene);
  for (const a of actors) {
    a.mesh.visible = inScene || state.view === a.kind;
    a.scale = inScene
      ? a.kind === "fox"
        ? 0.9
        : 0.92
      : a.kind === "fox"
        ? 1.55
        : 1.13;
    if (state.close && !inScene) {
      a.scale = a.kind === "fox" ? 3.15 : 2.7;
      a.goal.set(
        a.kind === "fox" ? 4.6 : -2.3,
        a.kind === "fox" ? -3.15 : -5.9,
        0.6,
      );
    } else if (inScene) {
      a.goal.set(
        a.kind === "fox" ? 1.85 : -1.75,
        a.kind === "fox" ? -1.9 : -0.12,
        a.kind === "fox" ? 0.6 : 0.3,
      );
    } else {
      a.goal.set(a.kind === "fox" ? 0 : -0.5, a.kind === "fox" ? -0.2 : 0, 0.5);
    }
    if (instant) {
      a.mesh.position.copy(a.goal);
      a.mesh.scale.setScalar(a.scale);
    }
  }
  if (state.paused) {
    layoutPaused();
    render();
  }
}
function layoutPaused() {
  for (const a of actors) {
    a.mesh.position.copy(a.goal);
    a.mesh.scale.setScalar(a.scale);
  }
}

function updateUI() {
  document.body.dataset.view = state.view;
  document.body.dataset.close = String(state.close);
  document
    .querySelectorAll("button[data-view]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.view === state.view)),
    );
  document
    .querySelectorAll("button[data-action]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.action === state.action)),
    );
  document.querySelector("#pause").textContent = state.paused
    ? "播放动作"
    : "暂停动作";
  document
    .querySelector("#pause")
    .setAttribute("aria-pressed", String(state.paused));
  document.querySelector("#closeup").disabled = state.view === "scene";
  document.querySelector("#closeup").textContent = state.close
    ? "看完整角色"
    : "看面部细节";
  document
    .querySelector("#closeup")
    .setAttribute("aria-pressed", String(state.close));
  document.querySelector("#reference-title").textContent = state.previous
    ? "上一轮几何模型"
    : "原绘本";
  document.querySelector("#reference-switch").textContent = state.previous
    ? "对照原绘本"
    : "对照上一轮";
  document
    .querySelector("#reference-switch")
    .setAttribute("aria-pressed", String(state.previous));
  document
    .querySelector("#reference")
    .classList.toggle("previous", state.previous);
  document
    .querySelector("#reference")
    .setAttribute(
      "aria-label",
      `${state.previous ? "上一轮模型" : "原绘本"} · ${names[state.view]}`,
    );
  const cues = {
    idle: "移动指针看轻微景深；悬浮或点按下面的词。",
    fox: "狐狸竖起耳朵，抬头，尾巴轻轻摆动。",
    prince: "小王子轻轻点头，回应你的目光。",
    wind: "风吹动围巾，狐狸的尾巴随风摇摆。",
    greeting: "小王子与狐狸互相回应。",
  };
  document.querySelector("#cue").textContent = cues[state.action];
  stage.dataset.view = state.view;
  stage.dataset.action = state.action;
  stage.dataset.paused = String(state.paused);
}
function setAction(action) {
  state.action = action;
  updateUI();
  if (state.paused) {
    actionStrength = action === "idle" ? 0 : 1;
    for (const a of actors) deform(a, time, actionStrength);
    render();
  }
}
function render() {
  camera.position.set(orbit.x, orbit.y, 15);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}
function tick(now) {
  if (disposed) return;
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (visible && !document.hidden && !state.paused) {
    time += dt;
    actionStrength = THREE.MathUtils.damp(
      actionStrength,
      state.action === "idle" ? 0 : 1,
      5,
      dt,
    );
    orbit.x = THREE.MathUtils.damp(orbit.x, pointer.x * 0.75, 4, dt);
    orbit.y = THREE.MathUtils.damp(orbit.y, -pointer.y * 0.45, 4, dt);
    for (const a of actors) {
      if (!a.mesh.visible) continue;
      a.mesh.position.lerp(a.goal, 1 - Math.exp(-8 * dt));
      a.mesh.scale.setScalar(
        THREE.MathUtils.damp(a.mesh.scale.x, a.scale, 8, dt),
      );
      deform(a, time, actionStrength);
    }
    render();
    frames++;
    sampleFrames++;
    elapsed += dt;
    if (now - lastTelemetry > 500) {
      stage.dataset.frames = String(frames);
      stage.dataset.time = time.toFixed(3);
      stage.dataset.foxDeformation = fox.movement?.toFixed(4) || "0";
      stage.dataset.princeDeformation = prince.movement?.toFixed(4) || "0";
      stage.dataset.triangles = String(renderer.info.render.triangles);
      stage.dataset.drawCalls = String(renderer.info.render.calls);
      stage.dataset.meanFrameMs = ((elapsed / sampleFrames) * 1000).toFixed(2);
      stage.dataset.camera = `${orbit.x.toFixed(3)},${orbit.y.toFixed(3)}`;
      lastTelemetry = now;
    }
  }
  animation = requestAnimationFrame(tick);
}

async function start() {
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0, 0);
    renderer.domElement.setAttribute(
      "aria-label",
      "带局部动画的绘本角色，固定视角 2.5D 样片",
    );
    stage.prepend(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(37, 1, 0.1, 50);
    const loader = new THREE.TextureLoader();
    const textures = await Promise.all(
      ["fox.png", "prince.png", "meadow.png"].map((f) =>
        loader.loadAsync(base + f),
      ),
    );
    if (disposed) {
      textures.forEach((t) => t.dispose());
      return;
    }
    textures.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    });
    backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(17.1, 11.4),
      new THREE.MeshBasicMaterial({ map: textures[2] }),
    );
    backdrop.position.set(0, 0, -0.7);
    scene.add(backdrop);
    fox = actor(textures[0], "fox");
    prince = actor(textures[1], "prince");
    const resize = new ResizeObserver(() => {
      const w = stage.clientWidth,
        h = stage.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    });
    resize.observe(stage);
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        stage.dataset.visible = String(visible);
      },
      { threshold: 0.02 },
    );
    observer.observe(stage);
    on(window, "pagehide", () => {
      disposed = true;
      cancelAnimationFrame(animation);
      controls.abort();
      resize.disconnect();
      observer.disconnect();
      textures.forEach((t) => t.dispose());
      scene.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      renderer.dispose();
    });
    on(stage, "pointermove", (e) => {
      const r = stage.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
      pointer.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    });
    on(stage, "pointerleave", () => {
      pointer = { x: 0, y: 0 };
    });
    on(renderer.domElement, "webglcontextlost", (e) => {
      e.preventDefault();
      state.paused = true;
      stage.classList.remove("ready");
      status.textContent =
        "画面暂停，当前显示角色原画。刷新页面可恢复动态样片。";
      updateUI();
    });
    on(document, "visibilitychange", () => {
      last = performance.now();
      stage.dataset.hidden = String(document.hidden);
    });
    document.querySelectorAll("button[data-view]").forEach((b) =>
      on(b, "click", () => {
        state.view = b.dataset.view;
        state.close = false;
        state.action = "idle";
        pointer = { x: 0, y: 0 };
        updateUI();
        layout();
      }),
    );
    document.querySelectorAll("button[data-action]").forEach((b) => {
      on(b, "pointerenter", () => setAction(b.dataset.action));
      on(b, "focus", () => setAction(b.dataset.action));
      on(b, "click", () => setAction(b.dataset.action));
    });
    on(document.querySelector("#pause"), "click", () => {
      state.paused = !state.paused;
      last = performance.now();
      updateUI();
    });
    on(document.querySelector("#closeup"), "click", () => {
      state.close = !state.close;
      updateUI();
      layout();
    });
    on(document.querySelector("#reference-switch"), "click", () => {
      state.previous = !state.previous;
      updateUI();
    });
    on(document.querySelector("#reset"), "click", () => {
      state.action = "idle";
      state.close = false;
      pointer = { x: 0, y: 0 };
      orbit = { x: 0, y: 0 };
      time = 0;
      actionStrength = 0;
      updateUI();
      layout(true);
      actors.forEach((a) => deform(a, 0, 0));
      render();
    });
    layout(true);
    actors.forEach((a) => deform(a, 0, 0));
    updateUI();
    render();
    stage.classList.add("ready");
    stage.dataset.engine = "three-webgl-painted-relief";
    status.textContent = "";
    last = performance.now();
    animation = requestAnimationFrame(tick);
  } catch (error) {
    status.textContent = "动态样片暂时无法启动，下面保留了角色原画。";
    stage.dataset.error = String(error.message);
    renderer?.dispose();
    console.error("Picturebook lookdev:", error);
  }
}
start();
