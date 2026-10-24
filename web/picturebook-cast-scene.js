import * as THREE from "./vendor/three-0.186.0/three.module.js";
import { castAssets, actor } from "./picturebook-cast-catalog.js";
import { actionFor } from "./picturebook-cast-chapter.js";

const vertex = `
uniform float time, human, scarf, plant, head, arm, wind, bird, snake;
varying vec2 vUv; varying float worldY;
void main(){
 vUv=uv; vec3 p=position; vec2 q=vec2(uv.x,1.-uv.y);
 float crown=1.-smoothstep(.28,.43,q.y);
 vec2 d=q-vec2(.5,.35);float a=head;
 vec2 turn=mat2(cos(a),sin(a),-sin(a),cos(a))*d-d;
 p.x+=turn.x*crown*human;p.y-=turn.y*crown*human;
 float armMask=exp(-pow((q.y-.49)/.16,2.))*smoothstep(.1,.5,abs(q.x-.5));
 p.y+=sin(time*3.)*arm*armMask*.10;
 p.x+=sin(time*2.2+q.y*6.)*plant*(1.-q.y)*(.006+wind*.025);
 float cloth=(1.-smoothstep(.28,.50,q.x))*smoothstep(.2,.32,q.y)*(1.-smoothstep(.52,.65,q.y));
 p.y+=scarf*cloth*sin(time*2.7+q.x*9.)*(.008+wind*.035);
 p.z+=scarf*cloth*sin(time*2.7+q.x*9.)*.04;
 p.y+=human*sin(time*1.6)*.003*(1.-q.y);
 p.y+=bird*sin(time*4.+q.x)*.20*abs(q.y-.52);
 p.x+=snake*sin(time*3.+q.y*8.)*.035;
 worldY=(modelMatrix*vec4(p,1.)).y;
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
}`;
const fragment = `
uniform sampler2D map; uniform vec4 crop; uniform float alpha, cut, dusk, lampDark, clipBottom;
varying vec2 vUv; varying float worldY;
void main(){
 if(worldY<clipBottom)discard;
 vec2 q=vec2(vUv.x,1.-vUv.y);
 if(cut==1. && q.x>.96 && q.y<.45)discard;
 if(cut==2. && q.x<.055 && q.y>.28)discard;
 if(cut==3. && q.x>.965 && q.y<.52)discard;
 if(cut==4. && q.x<.17 && q.y>.48)discard;
 vec4 c=texture2D(map,vec2(crop.x+q.x*crop.z,1.-crop.y-q.y*crop.w));
 if(c.a<.025)discard;
 c.rgb=mix(c.rgb, c.rgb*vec3(.20,.27,.45),dusk);
 float lampMask=(1.-smoothstep(.33,.4,q.y))*smoothstep(.10,.16,q.y);
 c.rgb*=1.-lampDark*lampMask*.78;
 gl_FragColor=vec4(c.rgb,c.a*alpha);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;

export async function createCastScene({ host, signal, casts, onError }) {
  let renderer,
    raf,
    resize,
    observer,
    disposed = false,
    visible = true;
  let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let moment = casts[0],
    time = 0,
    last = performance.now(),
    beat = 0,
    frames = 0,
    trainPhase = 6,
    word = null,
    wordUntil = 0;
  const textures = new Map(),
    resources = [],
    pool = new Map(),
    backgrounds = new Map();
  const events = new AbortController(),
    scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-5, 5, 6, -6, 0.1, 100);
  camera.position.z = 30;
  const memory = document.createElement("aside");
  memory.className = "cast-memory";
  memory.hidden = true;
  host.append(memory);
  const label = document.createElement("span");
  label.className = "cast-scene-label";
  label.hidden = true;
  host.append(label);
  const keep = (x) => (resources.push(x), x);
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    resize?.disconnect();
    observer?.disconnect();
    events.abort();
    resources.forEach((x) => x.dispose());
    textures.forEach((x) => x.dispose());
    renderer?.dispose();
    renderer?.domElement.remove();
    memory.remove();
    label.remove();
    host.classList.remove("is-ready");
  }
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) {
    dispose();
    return null;
  }
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "fox-story-canvas";
    renderer.domElement.setAttribute(
      "aria-label",
      "独立手绘角色与物件组成的动态绘本",
    );
    host.append(renderer.domElement);
    renderer.domElement.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        dispose();
        onError("动作已暂停，仍可阅读原文与原插画。");
      },
      { signal: events.signal },
    );
    const needed = new Set();
    for (const s of casts) {
      needed.add(s.background);
      s.actors.forEach((a) => needed.add(a.asset));
      Object.values(s.memory || {}).forEach((m) => needed.add(m.asset));
      if (s.editorialMemory) needed.add(s.editorialMemory.asset);
      if (s.birds) needed.add("bird");
    }
    // Pose substitutions retain identity and are loaded only in relevant chapters.
    if (casts.some((s) => s.actors.some((a) => a.id === "prince"))) {
      needed.add("prince");
      needed.add("waving");
      needed.add("clapping");
      needed.add("sad");
      needed.add("resting");
    }
    const files = [
      ...new Set([...needed].map((k) => castAssets[k]?.file).filter(Boolean)),
    ];
    const result = await Promise.allSettled(
      files.map(async (file) => {
        const t = await new THREE.TextureLoader().loadAsync(
          new URL("./assets/" + file, import.meta.url).href,
        );
        if (disposed) {
          t.dispose();
          return;
        }
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        textures.set(file, t);
      }),
    );
    if (disposed) return null;
    if (result.some((r) => r.status === "rejected"))
      throw Error("Character assets unavailable");
    const geom = keep(new THREE.PlaneGeometry(1, 1, 32, 40));
    function make(asset) {
      const d = castAssets[asset],
        t = textures.get(d.file),
        r = d.rect;
      const material = keep(
        new THREE.ShaderMaterial({
          vertexShader: vertex,
          fragmentShader: fragment,
          transparent: true,
          depthWrite: false,
          uniforms: {
            map: { value: t },
            crop: { value: new THREE.Vector4(...r) },
            alpha: { value: 1 },
            cut: { value: d.cut || 0 },
            dusk: { value: 0 },
            lampDark: { value: 0 },
            clipBottom: { value: -100 },
            time: { value: 0 },
            human: { value: +!!d.human },
            scarf: { value: +!!d.scarf },
            plant: { value: +!!d.plant },
            head: { value: 0 },
            arm: { value: 0 },
            wind: { value: 0 },
            bird: { value: asset === "bird" ? 1 : 0 },
            snake: { value: 0 },
          },
        }),
      );
      const mesh = new THREE.Mesh(geom, material),
        group = new THREE.Group();
      group.add(mesh);
      scene.add(group);
      return {
        asset,
        mesh,
        group,
        u: material.uniforms,
        aspect: (t.image.width * r[2]) / (t.image.height * r[3]),
        alpha: 0,
      };
    }
    for (const asset of new Set(casts.map((s) => s.background))) {
      const b = make(asset);
      b.group.position.z = -6;
      b.mesh.renderOrder = -6;
      backgrounds.set(asset, b);
    }
    function body(spec) {
      const key = spec.id + ":" + spec.asset;
      let a = pool.get(key);
      if (!a) {
        a = make(spec.asset);
        a.id = spec.id;
        pool.set(key, a);
      }
      return a;
    }
    const softTexture = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const x = c.getContext("2d");
      const g = x.createRadialGradient(64, 64, 1, 64, 64, 64);
      g.addColorStop(0, "rgba(255,228,164,1)");
      g.addColorStop(0.25, "rgba(255,219,138,.65)");
      g.addColorStop(1, "rgba(255,210,120,0)");
      x.fillStyle = g;
      x.fillRect(0, 0, 128, 128);
      return keep(new THREE.CanvasTexture(c));
    })();
    function glow(w, h, x, y, z = 6) {
      const m = keep(
        new THREE.MeshBasicMaterial({
          map: softTexture,
          transparent: true,
          depthWrite: false,
        }),
      );
      const o = new THREE.Mesh(geom, m);
      o.scale.set(w, h, 1);
      o.position.set(x, y, z);
      o.renderOrder = z;
      scene.add(o);
      return o;
    }
    const lampGlow = glow(3, 3, 2.5, 1.9),
      sun = glow(2.7, 2.7, -2, 3, -4);
    const stars = Array.from({ length: 18 }, (_, i) =>
      glow(
        0.16 + (i % 3) * 0.07,
        0.16 + (i % 3) * 0.07,
        -4.2 + ((i * 1.71) % 8.4),
        1 + ((i * 1.13) % 4.4),
        -3,
      ),
    );
    const ropeMat = keep(new THREE.MeshBasicMaterial({ color: 0x8e6b41 }));
    const rope = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(0.025, 1)),
      ropeMat,
    );
    rope.renderOrder = 4;
    scene.add(rope);
    const handRopes = [0, 1].map(() => {
      const r = new THREE.Mesh(rope.geometry, ropeMat);
      r.renderOrder = 2.5;
      scene.add(r);
      return r;
    });
    function ropeSegment(mesh, ax, ay, bx, by) {
      mesh.position.set((ax + bx) / 2, (ay + by) / 2, 3);
      mesh.scale.y = Math.hypot(bx - ax, by - ay);
      mesh.rotation.z = Math.atan2(by - ay, bx - ax) - Math.PI / 2;
    }
    const pulley = new THREE.Mesh(
      keep(new THREE.RingGeometry(0.13, 0.18, 24)),
      keep(new THREE.MeshBasicMaterial({ color: 0x826844, transparent: true })),
    );
    pulley.renderOrder = 5;
    scene.add(pulley);
    const spoke = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(0.025, 0.32)),
      ropeMat,
    );
    pulley.add(spoke);
    const echoRings = Array.from({ length: 3 }, () => {
      const r = new THREE.Mesh(
        keep(new THREE.RingGeometry(0.97, 1, 64)),
        keep(
          new THREE.MeshBasicMaterial({
            color: 0xffe5b6,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        ),
      );
      r.renderOrder = 6;
      scene.add(r);
      return r;
    });
    const smoke = Array.from({ length: 8 }, () => glow(0.4, 0.5, 0, 0, 2));
    const shadowMat = keep(
      new THREE.MeshBasicMaterial({
        color: 0x654b32,
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
      }),
    );
    const shadows = new Map();
    function shadow(a) {
      if (!shadows.has(a.id)) {
        const s = new THREE.Mesh(
          keep(new THREE.CircleGeometry(1, 32)),
          shadowMat,
        );
        s.renderOrder = 0.5;
        scene.add(s);
        shadows.set(a.id, s);
      }
      return shadows.get(a.id);
    }
    let memoryKey = "";
    function memoryCard(m) {
      const key = m ? m.asset + ":" + m.label : "";
      if (key === memoryKey) return;
      memoryKey = key;
      memory.hidden = !m;
      if (m) {
        const d = castAssets[m.asset],
          t = textures.get(d.file),
          r = d.rect;
        const svg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        svg.setAttribute(
          "viewBox",
          `${r[0] * t.image.width} ${r[1] * t.image.height} ${r[2] * t.image.width} ${r[3] * t.image.height}`,
        );
        svg.setAttribute("aria-hidden", "true");
        const im = document.createElementNS(svg.namespaceURI, "image");
        im.setAttribute(
          "href",
          new URL("./assets/" + d.file, import.meta.url).href,
        );
        im.setAttribute("width", t.image.width);
        im.setAttribute("height", t.image.height);
        // A viewBox only clips at the SVG viewport. Letterboxing can expose
        // adjacent atlas cells in WebKit, so clip the source rectangle too.
        const defs = document.createElementNS(svg.namespaceURI, "defs");
        const clip = document.createElementNS(svg.namespaceURI, "clipPath");
        clip.id = "cast-memory-asset-clip";
        if (d.cut === 4) {
          const polygon = document.createElementNS(svg.namespaceURI, "polygon");
          polygon.setAttribute(
            "points",
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0.17, 1],
              [0.17, 0.48],
              [0, 0.48],
            ]
              .map(
                ([x, y]) =>
                  `${(r[0] + x * r[2]) * t.image.width},${(r[1] + y * r[3]) * t.image.height}`,
              )
              .join(" "),
          );
          clip.append(polygon);
        } else {
          const rect = document.createElementNS(svg.namespaceURI, "rect");
          rect.setAttribute("x", r[0] * t.image.width);
          rect.setAttribute("y", r[1] * t.image.height);
          rect.setAttribute("width", r[2] * t.image.width);
          rect.setAttribute("height", r[3] * t.image.height);
          clip.append(rect);
        }
        defs.append(clip);
        svg.append(defs);
        im.setAttribute("clip-path", "url(#cast-memory-asset-clip)");
        svg.append(im);
        const text = document.createElement("span");
        text.textContent = m.label;
        memory.replaceChildren(svg, text);
      }
    }
    function render(dt = 0, instant = false) {
      if (disposed) return;
      const active = word && time < wordUntil ? word : moment,
        action = active.action,
        target = active.target;
      const wave = Math.sin((time - beat) * 3.5);
      memoryCard(
        active === moment
          ? moment.memoryActive
          : active.memoryItem || moment.memoryActive,
      );
      label.hidden = !moment.label;
      label.textContent = moment.label || "";
      const blend = instant ? 1 : 1 - Math.exp(-dt * 7),
        specs = moment.actors.map((a) => ({ ...a }));
      if (moment.train) trainPhase += dt * (action === "train" ? 2.6 : 0.8);
      const prince = specs.find((a) => a.id === "prince");
      if (prince && !moment.lockPose) {
        if (moment.fall) {
          prince.asset = "resting";
          prince.h = 2.1;
          prince.x = 0.4;
        } else if (action === "clap") {
          prince.asset = "clapping";
          prince.flip = 1;
        } else if (action === "greeting") {
          if (prince.asset !== "waving") prince.flip *= -1;
          prince.asset = "waving";
        } else if (action === "sad" && prince.asset === "prince")
          prince.asset = "sad";
      }
      if (prince && moment.depart)
        prince.x -= Math.min(3, (time - beat) * 0.45);
      if (moment.birds)
        for (let i = 0; i < 3; i++)
          specs.push(
            actor(
              "bird" + i,
              "bird",
              3 - i * 2.2 - ((time * (action === "birds" ? 0.6 : 0.18)) % 1.7),
              2 + i * 0.5,
              1.0 - i * 0.1,
              1,
              0,
            ),
          );
      const current = new Set();
      shadows.forEach((s) => (s.visible = false));
      for (const spec of specs) {
        const a = body(spec);
        current.add(spec.id + ":" + spec.asset);
        a.spec = spec;
        const u = a.u;
        a.alpha += (1 - a.alpha) * blend;
        u.alpha.value = a.alpha;
        a.mesh.scale.set(spec.h * a.aspect, spec.h, 1);
        a.mesh.position.set(0, spec.h / 2, 0);
        a.mesh.renderOrder = spec.z;
        let x = spec.x,
          y = spec.y,
          angle = 0;
        const chosen = target === spec.id;
        if (moment.train && spec.id === "train") {
          x = (9 - trainPhase) * (moment.trainDirection || 1);
          y = 0.35 - 0.06 * x;
          spec.flip = moment.trainDirection || 1;
        }
        if (spec.id === "bucket" && moment.well) {
          const lift = ["bucket", "rope"].includes(action)
            ? paused
              ? 1
              : Math.min(1, (time - beat) / 2.2)
            : moment.bucket
              ? 1
              : 0;
          y = -2.3 + lift * 1.6;
          x = 2.15;
          u.clipBottom.value = -0.85;
        }
        if (chosen && action === "chair")
          x += Math.sin(Math.min(1, (time - beat) / 2) * Math.PI) * 0.65;
        if (chosen && action === "snake" && !moment.snakeWrapped)
          x += Math.sin((time - beat) * 1.5) * 0.3;
        if (chosen && action === "hat") angle = -0.065 * (0.5 + 0.5 * wave);
        if (chosen && action === "telescope") angle = 0.06 * Math.sin(time);
        if (chosen && action === "bottle") angle = 0.025 * wave;
        if (chosen && action === "box") angle = 0.025 * wave;
        if (moment.walk && ["prince", "walkPair"].includes(spec.id))
          x += Math.sin(time * 0.8) * 0.35;
        a.group.position.set(x, y, spec.z);
        a.group.scale.set(spec.flip, 1, 1);
        a.group.rotation.z = angle;
        u.time.value = time;
        u.head.value = chosen
          ? 0.035 * Math.sin(time * 1.7)
          : 0.009 * Math.sin(time * 1.2);
        u.arm.value =
          chosen &&
          [
            "command",
            "king",
            "clap",
            "hat",
            "drawing",
            "book",
            "count",
            "businessman",
            "pills",
            "merchant",
            "bucket",
            "lamp",
            "lamplighter",
            "greeting",
          ].includes(action)
            ? 1
            : 0;
        if (spec.id === "lamplighter" && action === "lamp") u.arm.value = 1;
        if (
          spec.asset === "pilotWell" &&
          ["bucket", "pulley", "rope"].includes(action)
        )
          u.arm.value = 1;
        if (spec.id === "vain" && action === "clap") {
          u.arm.value = 1;
          a.group.rotation.z = -0.06 * (0.5 + 0.5 * wave);
        }
        u.wind.value = action === "wind" ? 1 : 0.12;
        u.snake.value = spec.id === "snake" && chosen ? 1 : 0;
        u.lampDark.value = spec.id === "lamp" && !moment.lampOn ? 1 : 0;
        if (chosen && action === "drawing")
          a.group.rotation.z = 0.025 * Math.sin(time * 1.4);
        if (chosen && action === "baobabs" && spec.h < 2) {
          a.group.position.y +=
            Math.sin(Math.min(1, (time - beat) / 2) * Math.PI) * 0.22;
          u.wind.value = 0.5;
        }
        if (spec.z > 0 && !spec.id.startsWith("bird")) {
          const s = shadow(spec);
          s.visible = true;
          s.position.set(x, y + 0.1, 0.5);
          s.scale.set(spec.h * a.aspect * 0.27, 0.12, 1);
        }
      }
      pool.forEach((a, key) => {
        if (!current.has(key)) {
          a.alpha += (0 - a.alpha) * blend;
          a.u.alpha.value = a.alpha;
        }
        a.group.visible = a.alpha > 0.002;
      });
      backgrounds.forEach((b, key) => {
        b.alpha += ((key === moment.background ? 1 : 0) - b.alpha) * blend;
        b.u.alpha.value = b.alpha;
        b.group.visible = b.alpha > 0.002;
        const h = Math.max(
            camera.top * 2,
            (camera.right - camera.left) / b.aspect,
          ),
          w = h * b.aspect;
        b.mesh.scale.set(w, h, 1);
        b.u.dusk.value = moment.sun
          ? action === "sunset"
            ? 0.35 + 0.3 * Math.sin(time * 0.4)
            : moment.lampOn
              ? 0.75
              : 0
          : 0;
      });
      sun.visible = !!moment.sun && !moment.lamp;
      sun.position.set(
        -2 + Math.sin(time * 0.12) * 2,
        action === "sunset" ? 2.3 - Math.min(1, (time - beat) / 3) * 2.2 : 2.5,
        -4,
      );
      lampGlow.visible = !!moment.lamp;
      lampGlow.material.opacity = moment.lampOn
        ? 0.65 + 0.06 * Math.sin(time * 2)
        : 0;
      const lamp = specs.find((a) => a.id === "lamp");
      if (lamp) lampGlow.position.set(lamp.x, lamp.y + lamp.h * 0.78, 6);
      stars.forEach((s, i) => {
        s.visible = moment.background === "night" || action === "stars";
        s.material.opacity =
          (action === "stars" ? 0.85 : 0.3) *
          (0.55 + 0.45 * Math.sin(time * 1.2 + i));
      });
      rope.visible = pulley.visible = !!moment.well;
      handRopes.forEach((r) => (r.visible = !!moment.well));
      if (moment.well) {
        const bucket = pool.get("bucket:bucket");
        const bottom = Math.max(-0.5, bucket.group.position.y + 0.85),
          top = 1.36;
        rope.position.set(2.15, (top + bottom) / 2, 4);
        rope.scale.y = top - bottom;
        pulley.position.set(2.15, 1.36, 5);
        ropeSegment(handRopes[0], 2.15, 1.36, -0.22, 1.05);
        ropeSegment(handRopes[1], -0.22, 1.05, -0.3, -1.7);
        pulley.rotation.z =
          action === "bucket" || action === "pulley"
            ? -Math.min(time - beat, 2.2) * 2
            : 0;
      }
      echoRings.forEach((r, i) => {
        const phase = ((time - beat) * 0.45 + i * 0.33) % 1;
        r.visible = action === "echo";
        r.position.set(-0.5, 0.4, 6);
        r.scale.setScalar(0.3 + phase * 3.8);
        r.material.opacity = (1 - phase) * 0.35;
      });
      smoke.forEach((s, i) => {
        s.visible = !!moment.train || action === "volcano";
        if (moment.train) {
          const train = pool.get("train:train");
          const phase = (time * 0.35 + i * 0.12) % 1;
          s.position.set(
            (train?.group.position.x || 0) -
              (moment.trainDirection || 1) * 1.5 +
              phase * 0.8,
            2.0 + phase * 1.6,
            2,
          );
          s.scale.setScalar(0.3 + phase * 0.6);
          s.material.opacity = (1 - phase) * 0.3;
        } else if (action === "volcano") {
          s.position.set(
            2.5 + Math.sin(i) * 0.1,
            -1.6 + ((time * 0.3 + i * 0.13) % 1) * 1.4,
            2,
          );
          s.scale.setScalar(0.3);
          s.material.opacity = 0.25;
        }
      });
      renderer.render(scene, camera);
      frames++;
      host.dataset.engine = "painted-cast";
      host.dataset.cast = specs.map((a) => a.id + ":" + a.asset).join(",");
      host.dataset.action = action;
      host.dataset.target = target || "";
      host.dataset.memory = memoryKey;
      host.dataset.frames = String(frames);
      host.dataset.time = time.toFixed(3);
      host.dataset.lamp = String(!!moment.lampOn);
      host.dataset.bucket = String(moment.bucket || 0);
      host.dataset.sourceState = moment.sourceState || moment.key;
      host.dataset.background = moment.background;
      host.dataset.trainNumber = String(moment.trainNumber || 0);
      host.dataset.motion = JSON.stringify(
        specs.map((s) => {
          const a = pool.get(s.id + ":" + s.asset);
          return [
            s.id,
            +a.group.position.x.toFixed(3),
            +a.group.position.y.toFixed(3),
            +a.group.rotation.z.toFixed(3),
          ];
        }),
      );
    }
    function size() {
      const { width, height } = host.getBoundingClientRect();
      if (width > 0 && height > 0) {
        renderer.setSize(width, height, false);
        const ratio = width / height,
          h = Math.max(10.5, 10 / ratio);
        camera.left = (-h * ratio) / 2;
        camera.right = (h * ratio) / 2;
        camera.top = h / 2;
        camera.bottom = -h / 2;
        camera.updateProjectionMatrix();
        render(0, true);
      }
    }
    resize = new ResizeObserver(size);
    resize.observe(host);
    function schedule() {
      if (!disposed && !paused && visible && !document.hidden && !raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    }
    observer = new IntersectionObserver((e) => {
      visible = e[0]?.isIntersecting ?? true;
      schedule();
    });
    observer.observe(host);
    document.addEventListener("visibilitychange", schedule, {
      signal: events.signal,
    });
    function tick(now) {
      raf = null;
      if (disposed || paused || !visible || document.hidden) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      render(dt);
      raf = requestAnimationFrame(tick);
    }
    size();
    host.classList.add("is-ready");
    schedule();
    return {
      setMoment(next) {
        if (
          next.trainDirection !== moment.trainDirection ||
          next.trainNumber !== moment.trainNumber
        )
          trainPhase = 5;
        moment = next;
        beat = time;
        word = null;
        render(0, true);
      },
      trigger(action, w) {
        const a = actionFor(moment, action);
        if (!a) return;
        word = { ...a };
        if (action === "train" || action === "children") trainPhase = 7;
        wordUntil = time + 3.4;
        beat = time;
        host.dataset.word = w || "";
        render(0, true);
      },
      pause(value) {
        paused = value;
        host.dataset.paused = String(paused);
        schedule();
      },
      isPaused: () => paused,
      dispose,
    };
  } catch (error) {
    dispose();
    onError("角色素材暂时无法加载，已保留原插画与完整原文。");
    console.error("painted-cast:", error);
    return null;
  }
}
