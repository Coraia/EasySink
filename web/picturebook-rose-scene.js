import * as THREE from "./vendor/three-0.186.0/three.module.js";
const art = new URL("./assets/picturebook-rose-actors/", import.meta.url);
const actorVertex = `
 uniform float time; uniform float head; uniform float wind; uniform float pour;
 uniform float kind; uniform float bloom; uniform float speech;
 varying vec2 vUv;
 float gate(float a,float b,float x){return smoothstep(a,b,x);}
 void main(){
  vUv=uv;vec3 p=position;vec2 q=vec2(uv.x,1.0-uv.y);
  if(kind<2.5){
    float scarf=gate(.50,.65,q.x)*(1.0-gate(.62,.72,q.y))*gate(.25,.35,q.y);
    if(kind>1.5)scarf=(1.0-gate(.35,.49,q.x))*gate(.24,.33,q.y)*(1.0-gate(.54,.63,q.y));
    p.y+=scarf*sin(time*2.5+q.x*7.0)*(.035+wind*.22);
    p.z+=scarf*sin(time*2.5+q.x*7.0)*(.05+wind*.25);
    float mask=1.0-gate(kind<.5?.32:.29,kind<.5?.49:.38,q.y);
    vec2 pivot=kind<.5?vec2(.34,.40):vec2(.40,.34);
    if(kind>1.5)pivot=vec2(.59,.28);
    vec2 d=(q-pivot);float a=head+sin(time*1.7)*.012;
    vec2 delta=mat2(cos(a),sin(a),-sin(a),cos(a))*d-d;
    p.x+=delta.x*6.0*mask;p.y-=delta.y*6.0*mask;
    if(kind>.5&&kind<1.5){
      float arm=(1.0-gate(.44,.62,q.x))*gate(.37,.47,q.y)*(1.0-gate(.63,.72,q.y));
      vec2 d=q-vec2(.48,.46);float a=-pour;
      vec2 delta=mat2(cos(a),sin(a),-sin(a),cos(a))*d-d;
      p.x+=delta.x*5.55*arm;p.y-=delta.y*7.4*arm;
    }
    p.y+=sin(time*1.5)*.022*(1.0-gate(.70,.95,q.y));
  }else{
    float leaves=gate(.37,.48,q.y)*(1.0-gate(.82,.94,q.y));
    p.x+=leaves*sin(time*2.0+q.y*5.0)*(.02+wind*.12);
    p.y+=leaves*sin(time*2.0+q.x*8.0)*.025;
    if(kind>4.5){
      vec2 d=q-vec2(.50,.29);float mask=1.0-gate(.43,.52,q.y);
      float petal=sin(atan(d.y,d.x)*5.0+time*1.7)*speech*.035;
      p.x+=d.x*petal*3.4*mask;p.y-=d.y*petal*3.4*mask;
    }else if(kind>3.5){
      vec2 c=vec2(.52,.23);vec2 d=q-c;float mask=1.0-gate(.34,.43,q.y);
      float opening=.48+.52*bloom;
      float petal=sin(atan(d.y,d.x)*5.0+time*1.3)*speech*.026;
      p.x+=d.x*(opening-1.0+petal)*5.2*mask;
      p.y-=d.y*(opening-1.0+petal)*5.2*mask;
      p.z+=mask*(.15+sin(time*1.3)*.03);
    }
  }
  gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
 }`;
const actorFragment = `
 uniform sampler2D map;uniform float alpha;uniform float part;uniform vec3 tint;
 varying vec2 vUv;
 void main(){
   vec4 c=texture2D(map,vUv);float y=1.0-vUv.y;
   // The left leaf overlaps the blossom's bottom row: a horizontal cut splits it.
   bool crown=y<.395||(y<.46&&c.r>c.g*1.08&&c.r>c.b*1.08);
   if(part>0.5&&part<1.5&&crown)discard;
   if(part>1.5&&!crown)discard;
   if(c.a<.025)discard;
   gl_FragColor=vec4(c.rgb*tint,c.a*alpha);
   #include <tonemapping_fragment>
   #include <colorspace_fragment>
 }`;

export async function createRoseScene({ host, signal, onError }) {
  let renderer,
    raf,
    resize,
    observer,
    disposed = false,
    visible = true,
    paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let time = 0,
    last = performance.now(),
    frames = 0,
    moment = {
      key: "watch",
      pose: "seated",
      bloom: 0,
      growth: 0.65,
      near: 0,
      globe: 0,
      screen: 0,
      night: 0,
      action: "grow",
    },
    wordAction = null,
    wordUntil = 0,
    beat = 0;
  const textures = [],
    materials = [],
    geometries = [];
  const controller = new AbortController();
  const scene = new THREE.Scene(),
    world = new THREE.Group();
  scene.add(world);
  world.scale.setScalar(1.1);
  world.position.y = 0.35;
  const camera = new THREE.OrthographicCamera(-5, 5, 6, -6, 0.1, 100);
  camera.position.z = 25;
  const state = {
    bloom: 0,
    growth: 0.65,
    near: 0,
    globe: 0,
    screen: 0,
    night: 0,
    water: 0,
    flow: 0,
    seated: 1,
    standing: 0,
    head: 0,
    pour: 0,
    meadow: 0,
    detail: 0,
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    controller.abort();
    resize?.disconnect();
    observer?.disconnect();
    textures.forEach((t) => t.dispose());
    materials.forEach((m) => m.dispose());
    geometries.forEach((g) => g.dispose());
    renderer?.dispose();
    renderer?.domElement.remove();
    host.dataset.disposed = "true";
  }
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) {
    dispose();
    return null;
  }
  const geometry = (...args) => {
    const g = new THREE.PlaneGeometry(...args);
    geometries.push(g);
    return g;
  };
  const basic = (map) => {
    const m = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
    });
    materials.push(m);
    return m;
  };
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
      "小王子与玫瑰：独立角色动态绘本",
    );
    host.append(renderer.domElement);
    renderer.domElement.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        host.classList.remove("is-ready");
        onError("角色动画已暂停，原文与插画仍可继续阅读。");
        dispose();
      },
      { signal: controller.signal },
    );
    const urls = {
      background: new URL("planet-stage.png", art),
      seated: new URL("prince-seated.png", art),
      watering: new URL("prince-watering.png", art),
      bud: new URL("rose-bud.png", art),
      simple: new URL("simple-flower.png", art),
      shelters: new URL("rose-shelters.png", art),
      standing: new URL(
        "./assets/picturebook-lookdev-v2/prince.png",
        import.meta.url,
      ),
      rose: new URL(
        "./assets/picturebook-fox-reading/rose.png",
        import.meta.url,
      ),
    };
    const loaded = {};
    const result = await Promise.allSettled(
      Object.entries(urls).map(async ([name, url]) => {
        const t = await new THREE.TextureLoader().loadAsync(String(url));
        if (disposed) {
          t.dispose();
          return;
        }
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        textures.push(t);
        loaded[name] = t;
      }),
    );
    if (disposed) return null;
    if (result.some((r) => r.status === "rejected"))
      throw Error("rose assets unavailable");
    const bg = new THREE.Mesh(geometry(10, 15), basic(loaded.background));
    const dusk = { value: 0 };
    bg.material.onBeforeCompile = (shader) => {
      shader.uniforms.roseDusk = dusk;
      shader.fragmentShader =
        "uniform float roseDusk;\n" +
        shader.fragmentShader.replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(.045,.075,.17) + diffuseColor.rgb * vec3(.09,.14,.27), roseDusk * .95);",
        );
    };
    bg.material.customProgramCacheKey = () => "rose-dawn-to-night";
    bg.position.set(0, 0, -4);
    bg.renderOrder = 0;
    world.add(bg);
    const actors = [];
    function actor(texture, width, height, kind, part = 0) {
      const m = new THREE.ShaderMaterial({
        vertexShader: actorVertex,
        fragmentShader: actorFragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          map: { value: texture },
          time: { value: 0 },
          head: { value: 0 },
          wind: { value: 0 },
          pour: { value: 0 },
          kind: { value: kind },
          bloom: { value: 0 },
          speech: { value: 0 },
          alpha: { value: 1 },
          part: { value: part },
          tint: { value: new THREE.Color("white") },
        },
      });
      materials.push(m);
      const mesh = new THREE.Mesh(geometry(width, height, 90, 90), m);
      world.add(mesh);
      actors.push(mesh);
      return mesh;
    }
    const seated = actor(loaded.seated, 6.4, 5.9, 0),
      watering = actor(loaded.watering, 5.55, 7.4, 1),
      standing = actor(loaded.standing, 5.7, 7.6, 2);
    seated.position.set(1.35, -0.85, 1.2);
    watering.position.set(1.65, -0.05, 1.3);
    standing.position.set(2.0, -0.05, 1.2);
    standing.scale.x = -1;
    seated.renderOrder = 8;
    watering.renderOrder = 9;
    standing.renderOrder = 8;
    const plant = new THREE.Group();
    world.add(plant);
    plant.position.set(-2.3, -3.55, 1);
    const stem = actor(loaded.rose, 5.2, 5.2, 3, 1),
      flower = actor(loaded.rose, 5.2, 5.2, 4, 2),
      bud = actor(loaded.bud, 5.2, 5.2, 3);
    plant.add(stem, flower, bud);
    stem.position.y = 2.6;
    bud.position.y = 2.6;
    const flowerJoint = new THREE.Group();
    plant.add(flowerJoint);
    flowerJoint.position.set(0.1, 2.99, 0.05);
    flowerJoint.add(flower);
    flower.position.set(-0.1, -0.39, 0);
    stem.renderOrder = 5;
    flower.renderOrder = 6;
    bud.renderOrder = 6;
    const smallFlowers = Array.from({ length: 3 }, (_, i) => {
      const mesh = actor(loaded.simple, 3.4, 3.4, 5);
      mesh.renderOrder = 6 + (i === 1 ? 1 : 0);
      return mesh;
    });
    // A separate memory vignette keeps the rose from appearing to change species.
    const memory = new THREE.Group();
    memory.position.set(-2.25, 3.05, 3);
    world.add(memory);
    const paperMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { alpha: { value: 0 } },
      vertexShader:
        "varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: `varying vec2 v;uniform float alpha;
      void main(){vec2 p=abs(v-.5);float edge=max(p.x*2.,p.y*2.);
      float a=(1.-smoothstep(.93,1.,edge))*alpha;
      vec3 cream=mix(vec3(.99,.97,.86),vec3(.72,.63,.40),smoothstep(.88,.94,edge)*.22);
      gl_FragColor=vec4(cream,a*.96);}`,
    });
    materials.push(paperMaterial);
    const paper = new THREE.Mesh(geometry(4.5, 3.0), paperMaterial);
    paper.renderOrder = 13;
    memory.add(paper);
    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 1024;
    labelCanvas.height = 128;
    const labelContext = labelCanvas.getContext("2d");
    labelContext.fillStyle = "#655d3c";
    labelContext.font = '68px "Songti SC", "Noto Serif SC", serif';
    labelContext.textAlign = "center";
    labelContext.textBaseline = "middle";
    labelContext.fillText("玫瑰到来以前", 512, 64);
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    textures.push(labelTexture);
    const memoryLabel = new THREE.Mesh(
      geometry(3.8, 0.475),
      basic(labelTexture),
    );
    memoryLabel.position.set(0, 1.05, 0.02);
    memoryLabel.renderOrder = 14;
    memory.add(memoryLabel, ...smallFlowers);
    smallFlowers.forEach((mesh) => {
      mesh.renderOrder = 15;
    });
    const ringGeometry = new THREE.RingGeometry(0.49, 0.515, 80);
    geometries.push(ringGeometry);
    const ringMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { alpha: { value: 0 }, time: { value: 0 } },
      vertexShader:
        "varying vec2 p;void main(){p=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: `varying vec2 p;uniform float alpha;uniform float time;
      void main(){float angle=fract(atan(p.y,p.x)/6.2831853+.25);
      float trail=step(angle,fract(time*.2));
      gl_FragColor=vec4(.72,.46,.12,alpha*(.18+.6*trail));}`,
    });
    materials.push(ringMaterial);
    const petalRing = new THREE.Mesh(ringGeometry, ringMaterial);
    petalRing.position.set(0, -0.95 + 0.56 * 3.4 * 0.71, 0.1);
    petalRing.renderOrder = 16;
    memory.add(petalRing);
    // Separate props, with their own transforms; no glass or screen baked into the scene.
    const prop = (cell, width, height) => {
      const texture = loaded.shelters.clone();
      texture.repeat.set(0.5, 1);
      texture.offset.x = cell * 0.5;
      textures.push(texture);
      const mesh = new THREE.Mesh(geometry(width, height), basic(texture));
      world.add(mesh);
      return mesh;
    };
    const globe = prop(0, 6.0, 6.0),
      screen = prop(1, 4.2, 4.2);
    globe.position.set(-2.3, -0.55, 2);
    globe.renderOrder = 11;
    screen.position.set(-3, -1.1, 0.5);
    screen.renderOrder = 3;
    function shadow(x, y, w) {
      const m = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { opacity: { value: 0.22 } },
        vertexShader:
          "varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader:
          "varying vec2 v;uniform float opacity;void main(){float a=pow(max(0.0,1.0-length((v-.5)*2.0)),2.0);gl_FragColor=vec4(.20,.16,.08,a*opacity);}",
      });
      materials.push(m);
      const mesh = new THREE.Mesh(geometry(w, 0.5), m);
      mesh.position.set(x, y, 0.1);
      mesh.renderOrder = 2;
      world.add(mesh);
      return mesh;
    }
    shadow(-2.3, -3.5, 2.2);
    const boyShadow = shadow(1.6, -3.55, 3.5);
    const dropGeo = new THREE.BufferGeometry();
    geometries.push(dropGeo);
    dropGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(72 * 3), 3),
    );
    const dropMat = new THREE.PointsMaterial({
      color: 0xd9f3ed,
      size: 2.1,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    materials.push(dropMat);
    const drops = new THREE.Points(dropGeo, dropMat);
    drops.renderOrder = 10;
    drops.frustumCulled = false;
    world.add(drops);
    const moteGeo = new THREE.BufferGeometry();
    geometries.push(moteGeo);
    moteGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(45 * 3), 3),
    );
    const moteMat = new THREE.PointsMaterial({
      color: 0xffeab1,
      size: 2.1,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
    });
    materials.push(moteMat);
    const motes = new THREE.Points(moteGeo, moteMat);
    motes.renderOrder = 12;
    motes.frustumCulled = false;
    world.add(motes);
    const starGeo = new THREE.BufferGeometry();
    geometries.push(starGeo);
    const starPoints = [];
    for (let i = 0; i < 80; i++)
      starPoints.push(Math.sin(i * 91.3) * 4.8, 1.0 + ((i * 13) % 47) / 9, -2);
    starGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(starPoints, 3),
    );
    const starMat = new THREE.PointsMaterial({
      color: 0xfff3cf,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    materials.push(starMat);
    const stars = new THREE.Points(starGeo, starMat);
    stars.renderOrder = 1;
    world.add(stars);
    function update(dt, instant = false) {
      if (wordAction && time >= wordUntil) wordAction = null;
      const action = wordAction || moment.action;
      const move = (key, value, speed = 4) =>
        (state[key] = instant
          ? value
          : THREE.MathUtils.damp(state[key], value, speed, dt));
      const water = action === "water",
        wind = action === "wind",
        sad = action === "sad",
        cough = action === "cough",
        love = ["love", "fragrance"].includes(action);
      move("meadow", moment.meadow || 0, 5);
      move(
        "detail",
        moment.meadow && action === "single-ring" ? 1 : moment.detail || 0,
        3,
      );
      move(
        "bloom",
        ["bloom", "rose", "admire", "water", "fragrance", "love"].includes(
          action,
        )
          ? 1
          : moment.bloom,
        1.5,
      );
      move("growth", moment.growth, 2);
      move(
        "near",
        moment.near || (["admire", "love", "rose"].includes(action) ? 1 : 0),
      );
      const waterPose = water || moment.pose === "watering";
      move("water", waterPose ? 1 : 0, 5);
      move("flow", water ? 1 : 0, 5);
      move("seated", waterPose ? 0 : moment.pose === "seated" ? 1 : 0, 5);
      move("standing", waterPose ? 0 : moment.pose === "standing" ? 1 : 0, 5);
      move("globe", action === "globe" ? 1 : moment.globe, 2.5);
      move(
        "screen",
        moment.allowScreen === false
          ? 0
          : action === "screen"
            ? 1
            : moment.screen,
        2.5,
      );
      move(
        "night",
        action === "night" ? 1 : action === "sunrise" ? 0 : moment.night,
        1.5,
      );
      move(
        "head",
        sad
          ? 0.13
          : action === "admire"
            ? -0.06
            : action === "prince"
              ? Math.sin(time * 2) * 0.08
              : 0,
      );
      move("pour", water ? 0.1 + Math.sin(time * 1.8) * 0.045 : 0);
      const tint = new THREE.Color().setRGB(
        1 - state.night * 0.38,
        1 - state.night * 0.3,
        1 - state.night * 0.12,
      );
      dusk.value = state.night;
      actors.forEach((mesh) => {
        const u = mesh.material.uniforms;
        u.time.value = time;
        u.head.value = state.head;
        u.wind.value = wind ? 1 : 0.2;
        u.pour.value = state.pour;
        u.bloom.value = state.bloom;
        u.speech.value = ["petals", "bloom", "rose", "single-ring"].includes(
          action,
        )
          ? 1
          : 0.15;
        u.tint.value.copy(tint);
      });
      seated.material.uniforms.alpha.value = state.seated;
      watering.material.uniforms.alpha.value = state.water;
      standing.material.uniforms.alpha.value = state.standing;
      seated.visible = state.seated > 0.002;
      watering.visible = state.water > 0.002;
      standing.visible = state.standing > 0.002;
      seated.position.x = 1.25 - state.near * 0.3;
      standing.position.x = 1.7 + (sad ? 0.2 : 0);
      watering.position.x = 1.4;
      const roseAlpha = moment.keepRose ? 1 : 1 - state.meadow;
      stem.material.uniforms.alpha.value = state.bloom * roseAlpha;
      flower.material.uniforms.alpha.value = state.bloom * roseAlpha;
      bud.material.uniforms.alpha.value = (1 - state.bloom) * roseAlpha;
      plant.visible = roseAlpha > 0.002;
      memory.visible = state.meadow > 0.002;
      paperMaterial.uniforms.alpha.value = state.meadow;
      memoryLabel.material.opacity = state.meadow;
      ringMaterial.uniforms.alpha.value = state.meadow * state.detail;
      ringMaterial.uniforms.time.value = time;
      smallFlowers.forEach((mesh, i) => {
        const featured = i === 1;
        const scale = featured ? 0.56 : 0.43;
        mesh.scale.setScalar(scale);
        mesh.position.set([-1.35, 0, 1.35][i], -0.95 + scale * 1.7, 0.06);
        mesh.rotation.z = Math.sin(time * 1.5 + i * 1.8) * 0.035;
        mesh.material.uniforms.alpha.value = state.meadow;
        mesh.material.uniforms.speech.value = featured ? state.detail : 0.1;
        mesh.visible = state.meadow > 0.002;
      });
      bud.visible = state.bloom < 0.998;
      stem.visible = flower.visible = state.bloom > 0.002;
      plant.scale.setScalar(state.growth);
      plant.rotation.z = Math.sin(time * 1.7) * (0.009 + (wind ? 0.065 : 0));
      const pulse = cough
        ? Math.pow(Math.max(0, Math.sin(time * 7.8)), 6) *
          Math.max(0, Math.sin(time * 1.6))
        : 0;
      flowerJoint.rotation.z =
        Math.sin(time * 1.6) * 0.028 +
        (action === "thorns" ? -0.1 : 0) +
        pulse * 0.19;
      flowerJoint.position.y =
        2.99 + (action === "thorns" ? 0.15 : 0) - pulse * 0.15;
      flowerJoint.rotation.y =
        action === "rose" || action === "admire"
          ? Math.sin(time * 1.5) * 0.1
          : 0;
      globe.material.opacity = state.globe * 0.56;
      globe.visible = state.globe > 0.002;
      globe.position.y = -0.55 + (1 - state.globe) * 7;
      screen.material.opacity = state.screen;
      screen.visible = state.screen > 0.002;
      screen.position.x = -2.5 - (1 - state.screen) * 6;
      screen.rotation.y = (1 - state.screen) * 0.5;
      boyShadow.material.uniforms.opacity.value = 0.2;
      // The water starts at the transformed painted can's spout, then falls to the root.
      const a = -state.pour,
        dx = 0.02 - 0.48,
        dy = 0.6 - 0.46;
      const spoutX =
        watering.position.x +
        (0.02 - 0.5) * 5.55 +
        (Math.cos(a) * dx - Math.sin(a) * dy - dx) * 5.55;
      const spoutY =
        watering.position.y +
        (0.5 - 0.6) * 7.4 -
        (Math.sin(a) * dx + Math.cos(a) * dy - dy) * 7.4;
      const dp = dropGeo.attributes.position;
      for (let i = 0; i < 72; i++) {
        const t = (time * 0.8 + i / 72) % 1;
        dp.setXYZ(
          i,
          THREE.MathUtils.lerp(spoutX, -2.25, t) + Math.sin(i * 9.4) * 0.055,
          THREE.MathUtils.lerp(spoutY, -3.4, t * t),
          2.3,
        );
      }
      dp.needsUpdate = true;
      drops.visible = state.flow > 0.1;
      dropMat.opacity = state.flow * 0.85;
      const mp = moteGeo.attributes.position;
      for (let i = 0; i < 45; i++) {
        const t = (time * 0.12 + i / 45) % 1;
        mp.setXYZ(
          i,
          -2.3 + Math.sin(i * 6.3 + time * 0.6) * (0.3 + t),
          -0.3 + t * 3.5,
          1.8,
        );
      }
      mp.needsUpdate = true;
      motes.visible = love || action === "thorns";
      moteMat.opacity = love ? 0.5 : 0.25;
      stars.material.opacity = state.night * (0.5 + Math.sin(time) * 0.15);
      host.dataset.action = action;
      host.dataset.scene = moment.key;
      host.dataset.pose =
        state.water > 0.5
          ? "watering"
          : state.standing > 0.5
            ? "standing"
            : "seated";
      host.dataset.bloom = state.bloom.toFixed(3);
      host.dataset.flowerSubject = moment.meadow
        ? "rose-with-earlier-flowers"
        : "rose";
      host.dataset.roseVisible = String(plant.visible);
      host.dataset.memoryFlowers = String(memory.visible);
      host.dataset.smallFlowerScale = "0.56";
      host.dataset.meadow = state.meadow.toFixed(3);
      host.dataset.petalDetail = state.detail.toFixed(3);
      host.dataset.water = state.flow.toFixed(3);
      host.dataset.princeOpacity = Math.max(
        state.seated,
        state.water,
        state.standing,
      ).toFixed(3);
      host.dataset.canAngle = state.pour.toFixed(3);
      host.dataset.flowerAngle = flowerJoint.rotation.z.toFixed(3);
      host.dataset.globe = state.globe.toFixed(3);
      host.dataset.screen = state.screen.toFixed(3);
      host.dataset.night = state.night.toFixed(3);
      host.dataset.princeX = seated.position.x.toFixed(3);
    }
    const render = () => {
      if (!disposed) renderer.render(scene, camera);
    };
    function tick(now) {
      raf = null;
      if (disposed || paused || document.hidden || !visible) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      update(dt);
      render();
      frames++;
      if (frames % 30 === 0) {
        host.dataset.frames = String(frames);
        host.dataset.time = time.toFixed(3);
        host.dataset.drawCalls = String(renderer.info.render.calls);
      }
      raf = requestAnimationFrame(tick);
    }
    function wake() {
      if (!disposed && !paused && !document.hidden && visible && !raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    }
    const fit = () => {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height) return;
      const aspect = width / height,
        h = Math.max(10.5, 10 / aspect);
      camera.left = (-h * aspect) / 2;
      camera.right = (h * aspect) / 2;
      camera.top = h / 2;
      camera.bottom = -h / 2;
      camera.updateProjectionMatrix();
      bg.scale.set(Math.max(1, (h * aspect) / 10), Math.max(1, h / 15), 1);
      renderer.setSize(width, height, false);
      render();
    };
    resize = new ResizeObserver(fit);
    resize.observe(host);
    observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      wake();
    });
    observer.observe(host);
    document.addEventListener("visibilitychange", wake, {
      signal: controller.signal,
    });
    update(1, true);
    fit();
    host.dataset.engine = "rose-independent-actors";
    host.dataset.ready = "true";
    host.dataset.independentActors =
      "prince,rose-stem,rose-head,bud,watering-can,glass-globe,wind-screen";
    host.classList.add("is-ready");
    wake();
    return {
      setMoment(next, index) {
        if (next.key === "bloom" && moment.key !== "bloom") state.bloom = 0;
        moment = { ...next };
        beat = index;
        wordAction = null;
        host.dataset.beat = String(beat);
        host.dataset.keyframe = next.key;
        if (paused) {
          update(1, true);
          render();
        }
        wake();
      },
      trigger(action) {
        if (moment.meadow && ["rose", "bloom", "petals"].includes(action))
          action = action === "petals" ? "single-ring" : "flowers";
        if (action === "bloom") state.bloom = 0;
        wordAction = action;
        wordUntil = time + 3.6;
        if (paused) {
          update(1, true);
          render();
        }
        wake();
      },
      pause(value) {
        paused = Boolean(value);
        host.dataset.paused = String(paused);
        if (paused) {
          cancelAnimationFrame(raf);
          raf = null;
        } else wake();
      },
      isPaused() {
        return paused;
      },
      dispose,
    };
  } catch (error) {
    dispose();
    onError("角色动画暂时无法打开，完整英文和原插画仍可继续阅读。");
    return null;
  }
}
