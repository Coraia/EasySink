import * as THREE from "./vendor/three-0.186.0/three.module.js";
import { createPaintedActors } from "./picturebook-painted-actors.js";

const art = new URL("./assets/picturebook-lookdev-v2/", import.meta.url);
const seatedArt = new URL(
  "./assets/picturebook-fox-reading/friends-seated.png",
  import.meta.url,
);
const damp = THREE.MathUtils.damp;
const ease = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export async function createFoxReadingScene({ host, signal, onError }) {
  let renderer,
    scene,
    camera,
    observer,
    resize,
    raf,
    disposed = false,
    visible = true;
  let time = 0,
    last = performance.now(),
    frames = 0,
    lastSample = 0,
    beat = 0,
    ready = false;
  let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let pointer = { x: 0, y: 0 },
    orbit = { x: 0, y: 0 };
  const state = { action: "idle" },
    textures = [],
    seated = [];
  let characters, fox, prince, world, backdrop, garden, rose, motes;
  let moment = {
    pose: "standing",
    fox: 1,
    princeX: -1.8,
    foxX: 2.25,
    gap: 0,
    garden: 0,
    rose: 0,
    action: "fox",
    key: "meeting",
  };
  let wordAction = null,
    wordUntil = 0,
    gardenAlpha = 0;

  const targets = {
    foxAlpha: 0,
    standing: 1,
    sitting: 0,
    foxX: 2.3,
    princeX: -1.8,
    gap: 0.7,
    garden: 0,
    rose: 0,
  };
  const controller = new AbortController();
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    controller.abort();
    observer?.disconnect();
    resize?.disconnect();
    textures.forEach((t) => t.dispose());
    scene?.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    renderer?.dispose();
    renderer?.domElement.remove();
    host.dataset.disposed = "true";
  }
  signal.addEventListener("abort", dispose, { once: true });
  const on = (el, event, fn) =>
    el.addEventListener(event, fn, { signal: controller.signal });
  function sittingPart(texture, side) {
    const g = new THREE.PlaneGeometry(9.25, 9.25 / 1.5, 100, 100);
    const orig = new Float32Array(g.attributes.position.array);
    for (let i = 0; i < g.attributes.position.count; i++) {
      const u = g.attributes.uv.getX(i),
        v = 1 - g.attributes.uv.getY(i);
      orig[i * 3 + 2] =
        0.36 *
        Math.exp(
          -(
            (u - (side === 0 ? 0.4 : 0.76)) ** 2 / 0.035 +
            (v - 0.45) ** 2 / 0.2
          ),
        );
    }
    const m = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.04,
      side: THREE.DoubleSide,
      opacity: 0,
    });
    m.forceSinglePass = true;
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>\nfloat boundary=.57+.045*smoothstep(.70,.90,1.0-vMapUv.y);\nif (${side === 0 ? "vMapUv.x > boundary" : "vMapUv.x <= boundary"}) discard;`,
      );
    };
    m.customProgramCacheKey = () => `seated-${side}`;
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(0, -0.65, 0.55);
    mesh.renderOrder = side + 4;
    world.add(mesh);
    const part = { mesh, orig, side };
    seated.push(part);
    return part;
  }
  function deformSeated(part) {
    const p = part.mesh.geometry.attributes.position,
      uv = part.mesh.geometry.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const u = uv.getX(i),
        v = 1 - uv.getY(i);
      let x = part.orig[i * 3],
        y = part.orig[i * 3 + 1],
        z = part.orig[i * 3 + 2];
      if (part.side === 0) {
        const scarf =
          (1 - ease(0.23, 0.34, u)) *
          ease(0.27, 0.34, v) *
          (1 - ease(0.65, 0.75, v));
        const head =
          (1 - ease(0.3, 0.42, v)) *
          ease(0.23, 0.32, u) *
          (1 - ease(0.5, 0.57, u));
        const wind =
          state.action === "wind" || state.action === "scarf" ? 1 : 0;
        y += scarf * Math.sin(time * 2.2 + u * 7) * (0.06 + wind * 0.16);
        z += scarf * Math.sin(time * 2.2 + u * 7) * 0.14;
        const reply = [
          "prince",
          "greeting",
          "heart",
          "care",
          "bond",
          "rose",
        ].includes(state.action)
          ? 2.2
          : 1;
        x += head * Math.sin(time * 1.5) * 0.026 * reply;
        y += head * Math.sin(time * 1.5) * 0.025 * reply;
      } else {
        const tail = ease(0.67, 0.84, u) * ease(0.64, 0.82, v);
        const head = 1 - ease(0.39, 0.58, v);
        const reply = ["fox", "greeting", "happy", "alert", "bond"].includes(
          state.action,
        )
          ? 2
          : 1;
        y += tail * Math.sin(time * 1.7) * 0.065 * reply;
        x += head * Math.sin(time * 1.5 + 0.8) * 0.018 * reply;
        if (state.action === "sad") {
          y -= head * 0.1;
          x += head * 0.035;
        }
        if (state.action === "heart" || state.action === "care")
          y += head * Math.sin(time) * 0.025;
      }
      p.setXYZ(i, x, y, z);
    }
    p.needsUpdate = true;
  }
  function setMoment(next, index) {
    moment = { ...next };
    beat = index;
    wordAction = null;
    state.action = moment.action;
    Object.assign(targets, {
      foxAlpha: moment.fox,
      standing: moment.pose === "standing" ? 1 : 0,
      sitting: moment.pose === "seated" ? 1 : 0,
      foxX: moment.foxX,
      princeX: moment.princeX,
      gap: moment.gap,
      garden: moment.garden,
      rose: moment.rose,
    });
    host.dataset.beat = String(beat);
    host.dataset.pose = moment.pose;
    host.dataset.scene = moment.key;
    host.dataset.action = state.action;
    host.dataset.foxTargetOpacity = String(targets.foxAlpha);
    host.dataset.friendDistance = String(targets.gap);
    if (paused && ready) {
      update(1, true);
      render();
    }
  }
  function update(dt, instant = false) {
    const step = (from, to) => (instant ? to : damp(from, to, 4, dt));
    if (wordAction && performance.now() > wordUntil) {
      wordAction = null;
      state.action = moment.action;
    }
    const action = state.action;
    const sitting = action === "sit" ? 1 : targets.sitting;
    const standing = 1 - sitting;
    const gap =
      action === "closer" || action === "bond"
        ? Math.max(0, targets.gap - 0.28)
        : action === "distance"
          ? 0.85
          : targets.gap;
    const roseAlpha = action === "rose" && !targets.garden ? 1 : targets.rose;
    gardenAlpha = step(gardenAlpha, targets.garden);
    garden.material.opacity = gardenAlpha;
    garden.visible = gardenAlpha > 0.001;
    rose.material.opacity = step(rose.material.opacity, roseAlpha);
    rose.visible = rose.material.opacity > 0.001;
    rose.rotation.z = Math.sin(time * 1.3) * 0.025;
    const glow = ["heart", "care", "bond", "gold"].includes(action);
    motes.material.opacity = step(motes.material.opacity, glow ? 0.65 : 0);
    motes.visible = motes.material.opacity > 0.001;
    motes.rotation.z = Math.sin(time * 0.2) * 0.07;
    motes.position.y = Math.sin(time * 0.6) * 0.16;
    const bp = backdrop.geometry.attributes.position,
      uv = backdrop.geometry.attributes.uv;
    for (let i = 0; i < bp.count; i++) {
      const u = uv.getX(i),
        v = uv.getY(i);
      bp.setZ(
        i,
        Math.sin(time * (action === "wind" ? 2.1 : 0.7) + u * 18) *
          (action === "wind" ? 0.065 : 0.008) *
          (1 - ease(0.3, 0.55, v)),
      );
    }
    bp.needsUpdate = true;
    const hop = action === "happy" ? Math.max(0, Math.sin(time * 5)) * 0.16 : 0;
    fox.mesh.position.y = -1.9 + hop;
    host.dataset.action = action;
    host.dataset.friendDistance = String(gap);
    host.dataset.gardenOpacity = gardenAlpha.toFixed(3);
    host.dataset.roseOpacity = rose.material.opacity.toFixed(3);
    host.dataset.hop = hop.toFixed(3);
    prince.mesh.position.x = step(
      prince.mesh.position.x,
      targets.princeX + (action === "bond" && !sitting ? 0.14 : 0),
    );
    fox.mesh.position.x = step(
      fox.mesh.position.x,
      targets.foxX +
        (action === "alert" ? 0.28 : action === "bond" && !sitting ? -0.14 : 0),
    );
    prince.mesh.material.opacity = step(prince.mesh.material.opacity, standing);
    fox.mesh.material.opacity = step(
      fox.mesh.material.opacity,
      standing * targets.foxAlpha,
    );
    for (const part of seated) {
      part.mesh.material.opacity = step(
        part.mesh.material.opacity,
        sitting * (part.side === 1 ? targets.foxAlpha : 1),
      );
      part.mesh.position.x = step(
        part.mesh.position.x,
        part.side === 0 ? -gap * 0.35 : gap,
      );
      part.mesh.position.y = -0.65 + (part.side === 1 ? hop : 0);
      part.mesh.visible = part.mesh.material.opacity > 0.001;
      if (part.mesh.visible) deformSeated(part);
    }
    for (const a of characters.actors) {
      a.mesh.visible = a.mesh.material.opacity > 0.001;
      if (a.mesh.visible) characters.deform(a, time, 1);
    }
    host.dataset.foxOpacity = fox.mesh.material.opacity.toFixed(3);
    host.dataset.sittingOpacity = seated[0].mesh.material.opacity.toFixed(3);
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
    if (!paused && visible && !document.hidden) {
      time += dt * (state.action === "time" ? 0.45 : 1);
      orbit.x = damp(orbit.x, pointer.x * 0.45, 4, dt);
      orbit.y = damp(orbit.y, -pointer.y * 0.25, 4, dt);
      update(dt);
      render();
      frames++;
      if (now - lastSample > 400) {
        host.dataset.frames = String(frames);
        host.dataset.time = time.toFixed(3);
        host.dataset.drawCalls = String(renderer.info.render.calls);
        lastSample = now;
      }
    }
    raf = requestAnimationFrame(tick);
  }
  try {
    if (signal.aborted) {
      dispose();
      return null;
    }
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setClearColor(0, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "fox-story-canvas";
    renderer.domElement.setAttribute(
      "aria-label",
      "随句子推进的狐狸与小王子动态绘本",
    );
    host.prepend(renderer.domElement);
    scene = new THREE.Scene();
    world = new THREE.Group();
    scene.add(world);
    world.scale.setScalar(0.9);
    world.position.y = 0.6;
    camera = new THREE.PerspectiveCamera(37, 1, 0.1, 50);
    const loader = new THREE.TextureLoader();
    const results = await Promise.allSettled(
      ["prince.png", "fox.png", "meadow.png"]
        .map((f) => new URL(f, art).href)
        .concat(
          seatedArt.href,
          new URL(
            "./assets/picturebook-fox-reading/rose-garden.png",
            import.meta.url,
          ).href,
          new URL("./assets/picturebook-fox-reading/rose.png", import.meta.url)
            .href,
        )
        .map((url) => loader.loadAsync(url)),
    );
    results.forEach((r) => {
      if (r.status === "fulfilled") textures.push(r.value);
    });
    if (disposed) {
      textures.forEach((t) => t.dispose());
      return null;
    }
    if (results.some((r) => r.status === "rejected"))
      throw Error("角色插画未能全部加载");
    textures.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    });
    backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 12, 50, 36),
      new THREE.MeshBasicMaterial({ map: textures[2] }),
    );
    backdrop.position.z = -0.7;
    scene.add(backdrop);
    garden = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 12),
      new THREE.MeshBasicMaterial({
        map: textures[4],
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    garden.position.z = -0.6;
    garden.renderOrder = 1;
    scene.add(garden);
    rose = new THREE.Mesh(
      new THREE.PlaneGeometry(
        1.65,
        (1.65 * textures[5].image.height) / textures[5].image.width,
      ),
      new THREE.MeshBasicMaterial({
        map: textures[5],
        transparent: true,
        opacity: 0,
        depthWrite: false,
        alphaTest: 0.035,
      }),
    );
    rose.position.set(0.2, -2.3, 1.1);
    rose.renderOrder = 6;
    world.add(rose);
    const mg = new THREE.BufferGeometry();
    const mp = [];
    for (let i = 0; i < 28; i++) {
      const a = i * 2.399;
      const r = 1.1 + (i % 7) * 0.29;
      mp.push(Math.cos(a) * r, Math.sin(a) * r * 0.65 + 0.2, 1.2);
    }
    mg.setAttribute("position", new THREE.Float32BufferAttribute(mp, 3));
    motes = new THREE.Points(
      mg,
      new THREE.PointsMaterial({
        color: 0xffe5a0,
        size: 0.035,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    motes.renderOrder = 7;
    world.add(motes);
    characters = createPaintedActors(world, state);
    prince = characters.actor(textures[0], "prince");
    fox = characters.actor(textures[1], "fox");
    prince.mesh.position.set(-1.8, -0.12, 0.3);
    prince.mesh.scale.setScalar(0.92);
    fox.mesh.position.set(3.3, -1.9, 0.6);
    fox.mesh.scale.setScalar(0.9);
    fox.mesh.material.opacity = 0;
    sittingPart(textures[3], 0);
    sittingPart(textures[3], 1);
    resize = new ResizeObserver(() => {
      if (disposed) return;
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.fov =
        (2 * Math.atan(Math.max(10, 10 / camera.aspect) / 30) * 180) / Math.PI;
      camera.updateProjectionMatrix();
      backdrop.scale.setScalar(
        Math.max(10 / 18, Math.max(10, 10 / camera.aspect) / 12) * 1.12,
      );
      garden.scale.copy(backdrop.scale);
      render();
    });
    resize.observe(host);
    observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        host.dataset.visible = String(visible);
      },
      { threshold: 0.02 },
    );
    observer.observe(host);
    on(host, "pointermove", (event) => {
      const r = host.getBoundingClientRect();
      pointer = {
        x: ((event.clientX - r.left) / r.width) * 2 - 1,
        y: ((event.clientY - r.top) / r.height) * 2 - 1,
      };
    });
    on(host, "pointerleave", () => {
      pointer = { x: 0, y: 0 };
    });
    on(document, "visibilitychange", () => {
      last = performance.now();
    });
    on(renderer.domElement, "webglcontextlost", (event) => {
      event.preventDefault();
      dispose();
      host.classList.remove("is-ready");
      onError("动画暂时暂停，绘本和文字仍可继续阅读。");
    });
    ready = true;
    setMoment(moment, 0);
    update(1, true);
    host.classList.add("is-ready");
    host.dataset.engine = "painted-relief-2.5d";
    host.dataset.paused = String(paused);
    last = performance.now();
    raf = requestAnimationFrame(tick);
    return {
      setMoment,
      trigger(action) {
        wordAction = action;
        wordUntil = performance.now() + 3200;
        state.action = action;
        host.dataset.action = action;
        if (paused) {
          update(1, true);
          render();
        }
      },
      pause(value) {
        paused = value;
        host.dataset.paused = String(paused);
        last = performance.now();
        return paused;
      },
      isPaused: () => paused,
      dispose,
    };
  } catch (error) {
    dispose();
    if (!signal.aborted)
      onError("动态画面暂时无法打开，可以继续看绘本、读句子。");
    return null;
  }
}
