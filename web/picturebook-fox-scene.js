import * as T from "./vendor/three-0.186.0/three.module.js";
import { buildPaintedWorld } from "./picturebook-painted-world.js";

// Real geometry with world-space pigment shading; no flat picture replacements.
export function createFoxScene({ host, onPick, onUnavailable, reducedMotion }) {
  const renderer = new T.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  const canvas = renderer.domElement;
  canvas.className = "pb3d-canvas";
  canvas.dataset.style = "painted-storybook-v2";
  canvas.setAttribute(
    "aria-label",
    "可转动的水彩麦田：苹果树下的小王子与狐狸。拖动看另一面，点击角色找到单词。",
  );
  canvas.setAttribute("role", "img");
  host.prepend(canvas);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(34, 1, 0.1, 80);
  const world = new T.Group();
  scene.add(world);
  const {
    sunlight,
    sun,
    clouds,
    tree,
    fox,
    legs,
    foxHead,
    ears,
    tail,
    prince,
    princeBody,
    arms,
    head,
    ribbon,
    wheat,
    butterflies,
    hearts,
  } = buildPaintedWorld({ world, scene });
  const raycaster = new T.Raycaster(),
    pointer = new T.Vector2();
  let disposed = false,
    enabled = false,
    paused = !!reducedMotion,
    visible = true,
    inView = true,
    drag = null,
    yaw = 0.06,
    targetYaw = 0.06;
  let action = "fox",
    sentence = 0,
    clock = 0,
    lastTime = 0,
    actionStart = 0,
    frames = 0,
    lastWitness = 0,
    frameTimes = [];
  let easeFoxX = 0.85,
    easeFoxZ = 0.55,
    easeSun = 1,
    easePrinceAngle = 0.9;
  const aim = new T.Vector3(-0.05, 1.9, 0);
  function resize() {
    if (disposed) return;
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const narrow = w / h < 0.65;
    camera.position.set(narrow ? 5.8 : 3.8, 3.3, narrow ? 14.2 : 10.4);
    camera.lookAt(aim);
    camera.updateProjectionMatrix();
    render();
  }
  function witness(dt) {
    canvas.dataset.frames = String(frames);
    canvas.dataset.action = action;
    canvas.dataset.paused = String(paused);
    canvas.dataset.running = String(enabled && !paused && visible && inView);
    canvas.dataset.yaw = yaw.toFixed(3);
    canvas.dataset.pose = JSON.stringify({
      foxVisible: fox.visible,
      fox: [+fox.position.x.toFixed(3), +fox.position.z.toFixed(3)],
      tail: +tail.rotation.y.toFixed(3),
      arm: +arms[1].rotation.z.toFixed(3),
      prince: +prince.rotation.y.toFixed(3),
      sun: +sun.position.y.toFixed(3),
    });
    if (dt > 0 && dt < 0.5) {
      frameTimes.push(dt * 1000);
      if (frameTimes.length > 120) frameTimes.shift();
    }
    if (frameTimes.length)
      canvas.dataset.meanFrameMs = (
        frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
      ).toFixed(1);
    canvas.dataset.drawCalls = String(renderer.info.render.calls);
    canvas.dataset.triangles = String(renderer.info.render.triangles);
  }
  function pose(dt, manual = false) {
    const t = clock,
      age = t - actionStart,
      quiet = paused;
    const mix = manual ? 1 : 1 - Math.exp(-dt * 5);
    const hidden = action === "nothing" || action === "turned";
    const appear = action === "appeared";
    const targetX = hidden
      ? -2.05
      : appear && age < 0.12 && !manual
        ? -2
        : 0.85;
    const targetZ = hidden ? -1.7 : 0.55;
    easeFoxX = T.MathUtils.lerp(easeFoxX, targetX, mix);
    easeFoxZ = T.MathUtils.lerp(easeFoxZ, targetZ, mix);
    fox.position.x = easeFoxX;
    fox.position.z = easeFoxZ;
    fox.visible =
      !hidden || Math.hypot(easeFoxX - targetX, easeFoxZ - targetZ) > 0.1;
    fox.position.y =
      0.12 +
      (!quiet && action === "fox" ? Math.max(0, Math.sin(age * 5)) * 0.1 : 0);
    fox.rotation.y = hidden ? Math.PI * 0.8 : -0.9;
    tail.rotation.y =
      action === "fox" ? Math.sin(t * 8) * 0.45 : Math.sin(t * 2) * 0.12;
    tail.rotation.z = Math.sin(t * 2 + 0.4) * 0.07;
    foxHead.rotation.z = action === "fox" ? Math.sin(t * 3) * 0.09 : 0.03;
    foxHead.rotation.x = action === "morning" ? Math.sin(t * 4) * 0.1 : 0;
    ears.forEach(
      (ear, i) =>
        (ear.rotation.x = action === "fox" ? Math.sin(t * 5 + i) * 0.13 : 0),
    );
    legs.forEach(
      (leg, i) =>
        (leg.rotation.x =
          Math.abs(fox.position.x - targetX) > 0.05 && !quiet
            ? Math.sin(t * 10 + i * Math.PI) * 0.3
            : 0),
    );
    const pAngle = hidden ? 2.5 : action === "prince" ? 0.35 : 0.9;
    easePrinceAngle = T.MathUtils.lerp(easePrinceAngle, pAngle, mix);
    prince.rotation.y = easePrinceAngle;
    princeBody.position.y = !quiet ? Math.sin(t * 2) * 0.013 : 0;
    arms[1].rotation.z =
      action === "prince" ? -(2.3 + Math.sin(t * 6) * 0.22) : 0.15;
    head.rotation.y = action === "prince" ? -0.15 : Math.sin(t * 0.8) * 0.045;
    ribbon.rotation.y = !quiet ? Math.sin(t * 2.3) * 0.18 : 0;
    const morning = action === "morning";
    easeSun = T.MathUtils.lerp(easeSun, morning ? 1.65 : 1, mix);
    sun.position.y = 3.3 + easeSun;
    sunlight.intensity = 1.9 + easeSun;
    sunlight.color.set(morning ? 0xffd494 : 0xffdfb0);
    clouds.forEach(
      (c, i) => (c.position.x = -7 + i * 4 + Math.sin(t * 0.1 + i) * 0.3),
    );
    wheat.rotation.z = !quiet ? Math.sin(t * 0.8) * 0.002 : 0;
    butterflies.forEach(({ group: g, left, right }, i) => {
      g.position.set(
        Math.sin(t * 0.4 + i * 2) * 2,
        1.2 + Math.sin(t * 0.9 + i) * 0.45,
        Math.cos(t * 0.4 + i) * 1.3,
      );
      left.rotation.z = Math.sin(t * 10 + i) * 0.8;
      right.rotation.z = -left.rotation.z;
      g.visible = !hidden;
    });
    hearts.forEach((h, i) => {
      h.visible = (action === "fox" || action === "prince") && age < 3;
      h.position.set(
        (action === "fox" ? 0.85 : -0.8) + Math.sin(i * 2) * 0.3,
        2.6 + ((age + i * 0.35) % 1.0),
        0.5,
      );
      h.rotation.y = -0.3;
    });
    yaw = T.MathUtils.lerp(yaw, targetYaw, manual ? 1 : 1 - Math.exp(-dt * 8));
    world.rotation.y = yaw;
  }
  function render() {
    if (disposed) return;
    renderer.render(scene, camera);
    frames++;
  }
  function loop(time) {
    const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.08) : 1 / 60;
    lastTime = time;
    clock += dt;
    pose(dt);
    render();
    if (time - lastWitness > 160) {
      witness(dt);
      lastWitness = time;
    }
  }
  function schedule() {
    lastTime = 0;
    renderer.setAnimationLoop(
      enabled && !paused && visible && inView ? loop : null,
    );
    if (enabled) {
      render();
    }
    witness(0);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  const intersection = new IntersectionObserver(
    (entries) => {
      inView = entries[0].isIntersecting;
      schedule();
    },
    { threshold: 0.03 },
  );
  intersection.observe(host);
  const visibility = () => {
    visible = !document.hidden;
    schedule();
  };
  document.addEventListener("visibilitychange", visibility);
  const lost = (event) => {
    event.preventDefault();
    if (!disposed) {
      renderer.setAnimationLoop(null);
      onUnavailable();
    }
  };
  canvas.addEventListener("webglcontextlost", lost);
  const down = (event) => {
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startYaw: targetYaw,
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  };
  const move = (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
      drag.moved = true;
      targetYaw = T.MathUtils.clamp(drag.startYaw + dx * 0.006, -0.85, 0.85);
      if (paused) {
        yaw = targetYaw;
        pose(0, true);
        render();
        witness(0);
      }
    }
  };
  const up = (event) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    scene.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([fox, prince, tree, sun], true);
    if (!hits.length) return;
    let object = hits[0].object;
    while (object && !object.userData.word) object = object.parent;
    if (object?.userData.word) onPick(object.userData.word);
    else if (hits[0].object === sun) onPick("morning");
  };
  const cancel = () => {
    drag = null;
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  resize();
  pose(0, true);
  render();
  witness(0);
  return {
    enable(value) {
      if (enabled === value) return;
      enabled = value;
      schedule();
    },
    pause(value) {
      paused = value;
      schedule();
      return paused;
    },
    isPaused() {
      return paused;
    },
    sentence(index) {
      if (sentence === index) return;
      sentence = index;
      this.trigger(
        index === 0 ? "appeared" : index === 1 ? "morning" : "turned",
      );
    },
    trigger(word) {
      action = word;
      actionStart = clock;
      if (word === "appeared") {
        easeFoxX = -2;
        easeFoxZ = -1.35;
      }
      pose(paused ? 0 : 0.03, paused);
      render();
      witness(0);
    },
    reset() {
      targetYaw = 0.06;
      yaw = 0.06;
      actionStart = clock;
      pose(0, true);
      render();
      witness(0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      const gs = new Set(),
        ms = new Set();
      scene.traverse((o) => {
        if (o.geometry) gs.add(o.geometry);
        if (o.material) for (const m of [].concat(o.material)) ms.add(m);
      });
      gs.forEach((g) => g.dispose());
      ms.forEach((m) => m.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
