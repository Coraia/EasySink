import * as THREE from "./vendor/three-0.186.0/three.module.js";
import { targetFor } from "./picturebook-living-chapter.js";
import { motionLabels } from "./picturebook-living-rigs.js";

const modes = Object.keys(motionLabels);
// A painted relief: bounded deformation of authored subjects, with the original
// illustration as its texture. No generated geometry replaces the painted faces.
const vertexShader = `
 uniform float time; uniform float emphasis;
 uniform vec4 regions[8]; uniform float modes[8]; uniform float selected[8];
 varying vec2 vUv; varying float glow; varying float shade;
 void main(){
   vUv=uv; vec3 p=position; vec2 point=vec2(uv.x,1.0-uv.y); glow=0.0; shade=0.0;
   for(int i=0;i<8;i++){
     vec4 r=regions[i]; if(r.z<0.001) continue;
     vec2 d=(point-r.xy)/r.zw; float w=pow(max(0.0,1.0-dot(d,d)),2.0);
     float a=0.20+selected[i]*emphasis; float t=time*1.8+float(i)*0.73;
     float s=sin(t); float c=cos(t); float mode=modes[i]; vec2 delta=vec2(0.0);
     if(mode<0.5){ delta=vec2(s*d.y*0.035,c*0.018); }
     else if(mode<1.5){ delta=vec2(s*(1.0-d.y)*0.06,0.0); }
     else if(mode<2.5){ delta=vec2(s*0.025,sin(t*1.7+d.x*4.0)*0.065); }
     else if(mode<4.5){ glow+=w*(0.25+0.22*s)*a; }
     else if(mode<5.5){ delta=vec2(sin(t*2.0)*0.05,c*0.025); }
     else if(mode<7.5){ delta=vec2(-d.y,d.x)*s*0.12; }
     else if(mode<8.5){ delta=vec2(0.0,(0.5+0.5*s)*0.22); }
     else if(mode<10.5){ delta=vec2(d.x*0.025,(1.0-d.y)*s*0.04); }
     else if(mode<11.5){ delta=vec2(sin(t+d.y*5.0)*0.07,s*0.08); }
     else if(mode<12.5){ delta=vec2(s*0.04,sin(t+d.x*4.0)*0.03); }
     else if(mode<14.5){ delta=vec2(sin(t*2.8)*0.09,c*0.02); }
     else if(mode<15.5){ delta=vec2(sin(t*1.4+d.y*5.0)*0.11,cos(t+d.x*4.0)*0.04); }
     else if(mode<16.5){ glow+=w*(0.25+0.25*sin(t-length(d)*8.0))*a; }
     else if(mode<17.5){ delta=vec2(s*0.16,sin(t*5.0)*0.008); }
     else {delta=vec2(sin(t*2.0+d.y*9.0)*0.045,cos(t*1.6+d.x*9.0)*0.035);glow+=w*(0.1+0.1*s)*a;}
     p.xy+=delta*r.zw*10.0*w*a;
     p.z+=w*0.12*a;
   }
   gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
 }`;
const fragmentShader = `
 uniform sampler2D plate; uniform vec2 offset; uniform vec2 inset;
 uniform float opacity; uniform float darken;
 varying vec2 vUv; varying float glow;
 void main(){
   vec2 uv=offset+inset+vUv*(vec2(0.5)-inset*2.0);
   vec4 col=texture2D(plate,uv);
   col.rgb+=vec3(0.18,0.13,0.055)*glow;
   col.rgb*=1.0-darken*glow;
   gl_FragColor=vec4(col.rgb,opacity);
   #include <tonemapping_fragment>
   #include <colorspace_fragment>
 }`;

export async function createLivingScene({
  host,
  signal,
  onError,
  frames,
  assetBase,
}) {
  let renderer,
    observer,
    resize,
    raf,
    disposed = false,
    visible = true,
    current = null;
  let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let time = 0,
    last = performance.now(),
    count = 0,
    wordUntil = 0,
    activeAction = "";
  const textures = new Map(),
    meshes = new Map(),
    scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  camera.position.z = 20;
  const controller = new AbortController();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    controller.abort();
    observer?.disconnect();
    resize?.disconnect();
    meshes.forEach((m) => {
      m.geometry.dispose();
      m.material.dispose();
    });
    textures.forEach((t) => t.dispose());
    renderer?.dispose();
    renderer?.domElement.remove();
    host.dataset.disposed = "true";
  };
  signal.addEventListener("abort", dispose, { once: true });
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
      "随英文情节变化的手绘动态画面",
    );
    host.append(renderer.domElement);
    renderer.domElement.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        host.classList.remove("is-ready");
        onError("动态画面已暂停，当前插画和完整正文仍可阅读。");
        dispose();
      },
      { signal: controller.signal },
    );
    const results = await Promise.allSettled(
      [...new Set(frames.map((f) => f.file))].map(async (file) => {
        const texture = await new THREE.TextureLoader().loadAsync(
          assetBase + file,
        );
        if (disposed) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(
          4,
          renderer.capabilities.getMaxAnisotropy(),
        );
        textures.set(file, texture);
      }),
    );
    if (disposed) return null;
    if (results.some((r) => r.status === "rejected"))
      throw Error("illustration unavailable");
    for (const frame of frames) {
      const t = textures.get(frame.file),
        cell = frame.cell;
      const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        uniforms: {
          plate: { value: t },
          offset: {
            value: new THREE.Vector2((cell % 2) * 0.5, cell < 2 ? 0.5 : 0),
          },
          inset: {
            value: new THREE.Vector2(0.5 / t.image.width, 0.5 / t.image.height),
          },
          time: { value: 0 },
          opacity: { value: 0 },
          emphasis: { value: 0.65 },
          darken: { value: 0 },
          regions: {
            value: Array.from({ length: 8 }, () => new THREE.Vector4()),
          },
          modes: { value: new Float32Array(8) },
          selected: { value: new Float32Array(8) },
        },
      });
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 10, 144, 144),
        material,
      );
      mesh.visible = false;
      mesh.userData.alpha = 0;
      meshes.set(frame.id, mesh);
      scene.add(mesh);
    }
    const fit = () => {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height) return;
      const aspect = width / height;
      const h = aspect < 1 ? 10 / aspect : 10;
      camera.left = (-h * aspect) / 2;
      camera.right = (h * aspect) / 2;
      camera.top = h / 2;
      camera.bottom = -h / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      draw();
    };
    const draw = () => {
      if (!disposed) renderer.render(scene, camera);
    };
    resize = new ResizeObserver(fit);
    resize.observe(host);
    fit();
    observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      wake();
    });
    observer.observe(host);
    document.addEventListener("visibilitychange", wake, {
      signal: controller.signal,
    });
    function tick(now) {
      raf = null;
      if (disposed || paused || !visible || document.hidden) {
        last = now;
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      if (current && time >= wordUntil) {
        if (activeAction !== current.action) target(current.action);
        meshes.get(current.key).material.uniforms.darken.value = 0;
      }
      meshes.forEach((mesh, key) => {
        const target = key === current?.key ? 1 : 0;
        mesh.userData.alpha = THREE.MathUtils.damp(
          mesh.userData.alpha,
          target,
          7,
          dt,
        );
        mesh.visible = mesh.userData.alpha > 0.002;
        mesh.material.uniforms.opacity.value = mesh.userData.alpha;
        mesh.material.uniforms.time.value = time;
        mesh.material.uniforms.emphasis.value = time < wordUntil ? 1.45 : 0.65;
      });
      draw();
      count++;
      if (count % 30 === 0) {
        host.dataset.frames = String(count);
        host.dataset.time = time.toFixed(2);
        host.dataset.drawCalls = String(renderer.info.render.calls);
      }
      raf = requestAnimationFrame(tick);
    }
    function wake() {
      if (!disposed && !paused && visible && !document.hidden && !raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    }
    function target(action) {
      activeAction = action;
      const key = targetFor(action, current.regions),
        mesh = meshes.get(current.key),
        u = mesh.material.uniforms;
      current.regions.forEach(
        (r, i) => (u.selected.value[i] = r.key === key ? 1 : 0),
      );
      host.dataset.action = action;
      host.dataset.target = key;
      host.dataset.motion = current.regions
        .filter((r) => r.key === key)
        .map((r) => r.motion)
        .join(",");
    }
    host.dataset.engine = "painted-relief";
    host.dataset.ready = "true";
    host.classList.add("is-ready");
    wake();
    return {
      setMoment(next, index) {
        if (disposed) return;
        const changed = current?.key !== next.key;
        current = next;
        const mesh = meshes.get(next.key),
          u = mesh.material.uniforms;
        next.regions.forEach((r, i) => {
          u.regions.value[i].set(r.x, r.y, r.rx, r.ry);
          u.modes.value[i] = modes.indexOf(r.motion);
        });
        if (changed) {
          mesh.renderOrder = index;
          mesh.visible = true;
          if (paused) {
            meshes.forEach((m) => {
              m.userData.alpha = m === mesh ? 1 : 0;
              m.material.uniforms.opacity.value = m === mesh ? 1 : 0;
              m.visible = m === mesh;
            });
          }
        }
        target(next.action);
        wordUntil = time + 1.2;
        u.darken.value = 0;
        host.dataset.keyframe = next.key;
        host.dataset.beat = String(index);
        host.dataset.regions = String(next.regions.length);
        draw();
        wake();
      },
      trigger(action, word) {
        if (disposed || !current) return;
        target(action);
        wordUntil = time + 3.2;
        meshes.get(current.key).material.uniforms.darken.value =
          word === "extinguished" ? 1.7 : 0;
        draw();
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
    onError("动态画面暂时无法打开，插画和完整英文仍可阅读。");
    return null;
  }
}
