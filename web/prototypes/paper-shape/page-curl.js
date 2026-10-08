import {
  paperVertex,
  paperForPointer,
  paperMesh,
} from "./paper-model.js?v=20261008-paper1";
// Temporary paint surface only. The accessible/selectable reader remains ordinary DOM.
// Geometry: rotate into a tilted fold axis, wrap a half cylinder, rotate back.
// No external renderer, experimental browser API, or whole-book capture is required.
const captures = new Map();
export function clearCaptures() {
  captures.clear();
}
const styles = [
  "display",
  "position",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "flex",
  "flex-direction",
  "flex-shrink",
  "grid-template-columns",
  "gap",
  "padding",
  "margin",
  "top",
  "bottom",
  "left",
  "right",
  "overflow",
  "overflow-wrap",
  "font",
  "letter-spacing",
  "color",
  "background-color",
  "border",
  "border-radius",
  "text-align",
  "white-space",
  "vertical-align",
  "opacity",
];

export function snapshotSpread(spread) {
  const rect = spread.getBoundingClientRect(),
    copy = spread.cloneNode(true);
  const source = [spread, ...spread.querySelectorAll("*")],
    target = [copy, ...copy.querySelectorAll("*")];
  source.forEach((el, i) => {
    const clone = target[i],
      css = getComputedStyle(el);
    clone.removeAttribute("id");
    clone.removeAttribute("aria-label");
    for (const attr of Array.from(clone.attributes))
      if (attr.name.startsWith("data-") && attr.name !== "data-layout")
        clone.removeAttribute(attr.name);
    // Spans inherit typography; block geometry must not reflow in the SVG viewport.
    if (el.tagName !== "SPAN" || !el.classList.contains("word"))
      for (const name of styles)
        clone.style.setProperty(name, css.getPropertyValue(name));
    clone.classList.remove("word", "linked", "selected-source");
    if (clone.classList.contains("paragraph-tools"))
      clone.style.display = "none";
  });
  Object.assign(copy.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: rect.width + "px",
    height: rect.height + "px",
    margin: "0",
    visibility: "visible",
  });
  const css = getComputedStyle(spread),
    vars = [
      "--paper",
      "--sheet",
      "--ink",
      "--muted",
      "--line",
      "--accent",
      "--tint",
      "--size",
      "--leading",
      "--font",
    ]
      .map((v) => `${v}:${css.getPropertyValue(v)}`)
      .join(";");
  const leaves = Array.from(
    spread.querySelectorAll(":scope > .sheet:not([hidden]):not(.translation)"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.left - rect.left,
      y: r.top - rect.top,
      width: r.width,
      height: r.height,
    };
  });
  const rules = Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules, (rule) => rule.cssText);
      } catch {
        return [];
      }
    })
    .join("\n");
  const xml = (text) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const markup = `<div xmlns="http://www.w3.org/1999/xhtml" style="${xml(vars)};position:relative;width:${rect.width}px;height:${rect.height}px;color:${css.color};font:14px/1.5 -apple-system,sans-serif"><style>${xml(rules)}</style>${new XMLSerializer().serializeToString(copy)}</div>`;
  const key = markup,
    ratio = Math.min(
      devicePixelRatio || 1,
      3,
      4096 / rect.height,
      4096 / rect.width,
      Math.sqrt(12000000 / (rect.width * rect.height)),
    );
  if (!captures.has(key)) {
    const image = new Image(),
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(rect.width * ratio)}" height="${Math.ceil(rect.height * ratio)}" viewBox="0 0 ${rect.width} ${rect.height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
    const ready = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("Page texture could not be rendered"));
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    captures.set(key, ready);
    ready.catch(() => captures.delete(key));
    while (captures.size > 6) captures.delete(captures.keys().next().value);
  }
  return { node: copy, rect, leaves, ratio, ready: captures.get(key) };
}

const vertex = paperVertex;
const fragment = `
precision highp float;
uniform sampler2D u_front;
uniform sampler2D u_back;
uniform float u_plane;
uniform float u_mirror;
uniform float u_progress;
uniform float u_dark;
uniform float u_debug;
uniform float u_grab;
varying vec2 v_uv;
varying vec3 v_normal;
varying float v_distance;
varying float v_radius;
void main(){
  if(u_plane>0.5){
    float d=(v_distance-v_radius*0.5)/(v_radius*1.8);
    float shadow=exp(-d*d)*0.32*sin(3.14159265*u_progress);
    gl_FragColor=vec4(0.08,0.09,0.07,shadow);return;
  }
  bool front=u_mirror>0.0?gl_FrontFacing:!gl_FrontFacing;
  vec2 uv=v_uv;
  uv.x=front?(u_mirror>0.0?uv.x:1.0-uv.x):(u_mirror>0.0?1.0-uv.x:uv.x);
  vec4 paper=front?texture2D(u_front,uv):texture2D(u_back,uv);
  vec3 n=normalize(front?v_normal:-v_normal);
  vec3 key=normalize(vec3(-0.45,-0.25,1.0));
  vec3 fill=normalize(vec3(0.7,0.25,0.75));
  float diffuse=0.52+0.37*max(dot(n,key),0.0)+0.14*max(dot(n,fill),0.0);
  float reflection=0.24*pow(max(dot(n,normalize(key+vec3(0.0,0.0,1.0))),0.0),18.0)
    +0.08*pow(max(dot(n,normalize(fill+vec3(0.0,0.0,1.0))),0.0),28.0);
  // Matte paper: stronger sheen at the bend, minimal illumination on flat text.
  float bend=1.0-abs(n.z);
  vec3 rgb=paper.rgb*mix(1.0,diffuse,bend)+vec3(reflection*bend*(1.0-u_dark*0.6));
  gl_FragColor=vec4(rgb,1.0);
  // Opt-in acceptance marker on the GPU-rendered grabbed edge, never in the
  // normal experience. Pixel location can verify the actual projected mesh.
  if(u_debug>0.5 && v_uv.x>0.988 && abs(v_uv.y-u_grab)<0.007)
    gl_FragColor=vec4(1.0,0.0,1.0,1.0);
}`;

// A single renderer survives turns. Pointer movement only updates uniforms;
// neighbouring page textures are prepared before a gesture, with bounded caches.
export class CurlPainter {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "curl-canvas";
    this.textures = new Map();
    this.texturePixels = new Map();
    this.poseSamples = [];
    this.serial = 0;
    this.stats = [];
    this.failed = false;
    try {
      this.init();
    } catch (error) {
      this.failed = true;
      console.warn("Curl unavailable:", error.message);
    }
  }
  init() {
    const gl = (this.gl = this.canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }));
    if (!gl) throw new Error("WebGL unavailable");
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.failed = true;
      document.dispatchEvent(new Event("curl-context-lost"));
    });
    const compile = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, vertex),
      fs = compile(gl.FRAGMENT_SHADER, fragment);
    const p = (this.program = gl.createProgram());
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p));
    this.u = Object.fromEntries(
      [
        "view",
        "leaf",
        "progress",
        "mirror",
        "gap",
        "plane",
        "dark",
        "grab",
        "model",
        "curve",
        "pin",
        "debug",
        "front",
        "back",
      ].map((n) => [n, gl.getUniformLocation(p, "u_" + n)]),
    );
    const nx = 128,
      ny = 48,
      uv = [],
      indices = [];
    for (let y = 0; y <= ny; y++)
      for (let x = 0; x <= nx; x++) uv.push(x / nx, y / ny);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const a = y * (nx + 1) + x;
        indices.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1);
      }
    this.vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);
    this.indices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(indices),
      gl.STATIC_DRAW,
    );
    this.attribute = gl.getAttribLocation(p, "a_uv");
    this.indexCount = indices.length;
    this.shadowVertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowVertices);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.shadowIndices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.shadowIndices);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array([0, 1, 2, 1, 3, 2]),
      gl.STATIC_DRAW,
    );
    document.body.dataset.gpuContexts = "1";
  }
  invalidate() {
    this.serial++;
    if (this.gl && !this.gl.isContextLost())
      for (const t of this.textures.values()) this.gl.deleteTexture(t);
    this.textures.clear();
    this.texturePixels.clear();
  }
  texture(image, snapshot, leaf) {
    const key = image.src + ":" + leaf.x;
    if (this.textures.has(key)) {
      const t = this.textures.get(key);
      this.textures.delete(key);
      this.textures.set(key, t);
      return t;
    }
    const gl = this.gl,
      paint = document.createElement("canvas");
    paint.width = Math.ceil(leaf.width * snapshot.ratio);
    paint.height = Math.ceil(leaf.height * snapshot.ratio);
    paint
      .getContext("2d")
      .drawImage(
        image,
        leaf.x * snapshot.ratio,
        leaf.y * snapshot.ratio,
        leaf.width * snapshot.ratio,
        leaf.height * snapshot.ratio,
        0,
        0,
        paint.width,
        paint.height,
      );
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paint);
    this.textures.set(key, t);
    this.texturePixels.set(key, paint.width * paint.height);
    while (
      this.textures.size > 6 ||
      [...this.texturePixels.values()].reduce((a, b) => a + b, 0) > 24000000
    ) {
      const oldest = this.textures.keys().next().value;
      gl.deleteTexture(this.textures.get(oldest));
      this.textures.delete(oldest);
      this.texturePixels.delete(oldest);
    }
    document.body.dataset.cachedTextures = String(this.textures.size);
    document.body.dataset.cachedTexturePixels = String(
      [...this.texturePixels.values()].reduce((a, b) => a + b, 0),
    );
    return t;
  }
  async warm(snapshot) {
    const serial = this.serial,
      image = await snapshot.ready;
    if (this.failed || serial !== this.serial) return;
    for (const leaf of snapshot.leaves) this.texture(image, snapshot, leaf);
  }
  async attach(layer, before, after, direction) {
    if (this.failed) throw new Error("WebGL unavailable");
    const serial = this.serial,
      images = await Promise.all([before.ready, after.ready]);
    if (serial !== this.serial || !layer.isConnected)
      throw new Error("Obsolete curl scene");
    const double = before.leaves.length === 2;
    const frontLeaf = before.leaves[direction > 0 && double ? 1 : 0],
      backLeaf = after.leaves[direction < 0 && double ? 1 : 0];
    const front = this.texture(images[0], before, frontLeaf),
      back = this.texture(images[1], after, backLeaf);
    const gl = this.gl,
      rect = after.rect;
    const ratio = Math.min(
        after.ratio,
        Math.sqrt(8000000 / (rect.width * rect.height)),
      ),
      width = Math.ceil(rect.width * ratio),
      height = Math.ceil(rect.height * ratio);
    document.body.dataset.paintResolution = JSON.stringify({
      dpr: devicePixelRatio,
      canvasRatio: ratio,
      textureRatio: after.ratio,
    });
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
    gl.enableVertexAttribArray(this.attribute);
    gl.vertexAttribPointer(this.attribute, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.frontFace(gl.CW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.u.view, rect.width, rect.height);
    gl.uniform1f(this.u.mirror, direction);
    gl.uniform1f(this.u.dark, document.body.dataset.theme === "dark" ? 1 : 0);
    gl.uniform1f(
      this.u.debug,
      new URL(location.href).searchParams.has("debug-grip") ? 1 : 0,
    );
    gl.uniform4f(
      this.u.leaf,
      direction > 0 ? frontLeaf.x : frontLeaf.x + frontLeaf.width,
      frontLeaf.y,
      frontLeaf.width,
      frontLeaf.height,
    );
    gl.uniform1f(
      this.u.gap,
      double
        ? after.leaves[1].x - after.leaves[0].x - after.leaves[0].width
        : 0,
    );
    for (const [i, t] of [front, back].entries()) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(i === 0 ? this.u.front : this.u.back, i);
    }
    layer.replaceChildren();
    after.node.classList.add("curl-under");
    layer.append(after.node);
    if (double) {
      before.node.classList.add("curl-stationary");
      before.node.style.clipPath =
        direction > 0 ? "inset(0 50% 0 0)" : "inset(0 0 0 50%)";
      layer.append(before.node);
    }
    layer.append(this.canvas);
    layer.dataset.renderer = "webgl-interactive";
    this.frames = 0;
    this.solveTimes = [];
    this.gaps = [];
    this.lastFrame = 0;
    this.inputLatencies = [];
    this.layer = layer;
    this.scene = {
      rect,
      leaf: frontLeaf,
      direction,
      gap: double
        ? after.leaves[1].x - after.leaves[0].x - after.leaves[0].width
        : 0,
    };
  }
  draw(progress, grab, dy, inputAt = 0) {
    if (this.failed || !this.layer?.isConnected) return;
    const now = performance.now();
    if (this.lastFrame) this.gaps.push(now - this.lastFrame);
    this.lastFrame = now;
    if (inputAt) this.inputLatencies.push(now - inputAt);
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform1f(this.u.progress, progress);
    const { leaf, rect, direction, gap } = this.scene;
    const solveAt = performance.now();
    const fold = paperForPointer(leaf.width, leaf.height, progress, grab, dy);
    this.solveTimes ??= [];
    this.solveTimes.push(performance.now() - solveAt);
    gl.uniform1f(this.u.grab, grab);
    gl.uniform4fv(this.u.model, fold.model);
    gl.uniform4fv(this.u.curve, fold.curve);
    gl.uniform2f(this.u.pin, fold.x, fold.y);
    const mesh = paperMesh(leaf.width, leaf.height, fold.model, fold.curve);
    const bind = (vertices, indices) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      gl.vertexAttribPointer(this.attribute, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    };
    bind(this.shadowVertices, this.shadowIndices);
    gl.disable(gl.DEPTH_TEST);
    gl.uniform1f(this.u.plane, 1);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    bind(this.vertices, this.indices);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.DYNAMIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1f(this.u.plane, 0);
    gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
    document.body.dataset.paperVertices = String(mesh.uv.length / 2);
    this.layer.dataset.progress = progress.toFixed(3);
    this.layer.dataset.grab = grab.toFixed(3);
    this.layer.dataset.pin = JSON.stringify({
      x:
        rect.left +
        (direction > 0 ? leaf.x : leaf.x + leaf.width) +
        direction * fold.x,
      y: rect.top + leaf.y + leaf.height / 2 + fold.y,
      model: fold.model,
      requested: fold.requested,
      limited: fold.limited,
      dy,
    });
    this.layer.dataset.frames = String(++this.frames);
    this.poseSamples.push({
      at: now,
      progress,
      grab,
      dy,
      width: leaf.width,
      height: leaf.height,
      model: fold.model,
      curve: fold.curve,
      requested: fold.requested,
      pin: { x: fold.x, y: fold.y },
      limited: fold.limited,
    });
    if (this.poseSamples.length > 256) this.poseSamples.shift();
  }
  record(completed, reason) {
    const sorted = [...this.gaps].sort((a, b) => a - b),
      latencies = [...this.inputLatencies].sort((a, b) => a - b);
    const metric = {
      completed,
      reason,
      frames: this.frames,
      frameSamples: sorted.length,
      p95FrameMs: +(sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(2),
      over34ms: sorted.filter((n) => n > 34).length,
      p95InputMs: +(
        latencies[Math.floor(latencies.length * 0.95)] || 0
      ).toFixed(2),
      textures: this.textures.size,
      p95SolveMs:
        [...(this.solveTimes || [])].sort((a, b) => a - b)[
          Math.floor((this.solveTimes?.length || 0) * 0.95)
        ] || 0,
    };
    this.stats.push(metric);
    this.stats = this.stats.slice(-40);
    document.body.dataset.curlMetrics = JSON.stringify(this.stats);
  }
  detach() {
    this.layer = null;
    this.canvas.remove();
  }
  dispose() {
    this.detach();
    this.invalidate();
    if (this.gl && !this.gl.isContextLost()) {
      this.gl.deleteBuffer(this.vertices);
      this.gl.deleteBuffer(this.indices);
      this.gl.deleteBuffer(this.shadowVertices);
      this.gl.deleteBuffer(this.shadowIndices);
      this.gl.deleteProgram(this.program);
    }
  }
}
