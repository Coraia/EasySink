import { $ } from "./core.js";

import {
  foldVertex,
  foldFragment,
  foldForPointer,
  paperMesh,
} from "./page-fold.js?v=20261008-paper";

// Software-only animation budget; hardware keeps native Retina resolution.
const SOFTWARE_PIXELS = 320000;
// RGBA storage only; decoded SVGs and drawing buffers have separate lifetimes.
const TEXTURE_BYTES = 96_000_000;
// Six full-screen 2x leaves need ~118 MB. Keep both adjacent spreads resident
// instead of evicting the current spread during idle warming.
const DOUBLE_TEXTURE_BYTES = 128_000_000;
const MAX_CAPTURE_JOBS = 8;

// One GPU service for one reader lifetime. Turns reuse programs, buffers and
// cached textures; each frame uploads a small mesh aligned with the curl.
export class PageCurlRenderer {
  constructor(pages) {
    this.pages = pages;
    this.cache = new Map();
    this.jobs = new Map();
    this.captureTail = Promise.resolve();
    this.captures = new Set();
    this.uploadWaiters = new Set();
    this.epoch = 0;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "curl-canvas";
    this.layer = $("#page-curl-layer");
    this.mountSurface();
    this.root = $(".reader");
    this.failed = false;
    this.root.dataset.curlContexts = "0";
    this.rules = null;
    this.assets = new Map();
    this.assetBytes = 0;
    this.raf = 0;
    this.warmTimer = 0;
    this.warmRun = 0;
    this.warmPlan = null;
    // Native diagnostics cannot add a URL flag. Keep bounded numeric traces in
    // its existing export, without book text or a second sampling timer.
    this.testControl = new URLSearchParams(location.search).get("readingPerf") === "1";
    this.collectPerformance = window.wiseReaderDesktop?.nativeTrackpad === true || this.testControl;
    if (this.testControl) this.root.__curlRendererTest = this;
    this.metricSequence = 0;
    pages.r.scope.cleanup(() => { if (!this.handingOff && this.pages === pages) this.dispose(); });
  }
  rebind(pages) {
    this.warmRun++;
    this.warmPlan = null;
    clearTimeout(this.warmTimer);
    cancelAnimationFrame(this.surfaceWarmRaf);
    this.surfaceWarm = null;
    for (const capture of this.captures) capture.abort();
    this.captures.clear();
    this.jobs.clear();
    const previousRoot = this.root;
    if (previousRoot.__curlRendererTest === this) delete previousRoot.__curlRendererTest;
    this.pages = pages;
    this.root = $(".reader");
    this.layer = $("#page-curl-layer");
    this.mountSurface();
    this.handingOff = false;
    this.root.dataset.curlContexts = this.gl ? "1" : "0";
    this.root.dataset.curlMetrics = JSON.stringify(this.metrics || []);
    if (this.testControl) this.root.__curlRendererTest = this;
    for (const key of ["curlDevice", "curlDriver", "curlCachedLeaves", "curlCachedPixels"])
      if (previousRoot.dataset[key]) this.root.dataset[key] = previousRoot.dataset[key];
    pages.r.scope.cleanup(() => { if (!this.handingOff && this.pages === pages) this.dispose(); });
  }
  init() {
    if (this.gl || this.failed) return;
    const setup = this.collectPerformance ? (this.contextSetup = { startedAt: performance.now() }) : null;
    try {
      const gl = (this.gl = this.canvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
      }));
      if (!gl) throw new Error("WebGL unavailable");
      if (setup) setup.contextCreatedAt = performance.now();
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      const driver = debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : "";
      this.software = /SwiftShader|llvmpipe|software/i.test(driver);
      this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.maxCanvas = Math.min(
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        ...gl.getParameter(gl.MAX_VIEWPORT_DIMS),
      );
      this.anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
      this.root.dataset.curlDevice = this.software ? "software" : "gpu";
      this.root.dataset.curlDriver = driver;
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const error = gl.getShaderInfoLog(shader);
          gl.deleteShader(shader);
          throw new Error(error);
        }
        return shader;
      };
      // Fine cones require matching high precision in both stages. Unsupported
      // devices keep the existing non-animated navigation fallback.
      if (
        !gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
          ?.precision
      )
        throw new Error("High-precision paper rendering unavailable");
      const precision = "highp";
      const vs = compile(
          gl.VERTEX_SHADER,
          foldVertex.replace(
            /precision \w+ float/,
            `precision ${precision} float`,
          ),
        ),
        fs = compile(
          gl.FRAGMENT_SHADER,
          (this.software
            ? foldFragment.replace(
                "if(abs(v_bindingDistance)<20.0) hinge=exp(-abs(v_bindingDistance)/3.0)*0.1;",
                "",
              )
            : foldFragment
          ).replace("precision mediump float", `precision ${precision} float`),
        );
      this.program = gl.createProgram();
      gl.attachShader(this.program, vs);
      gl.attachShader(this.program, fs);
      gl.linkProgram(this.program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(this.program));
      gl.useProgram(this.program);
      if (setup) setup.programReadyAt = performance.now();
      this.u = Object.fromEntries(
        [
          "view",
          "leaf",
          "progress",
          "mirror",
          "gap",
          "plane",
          "dark",
          "front",
          "back",
          "model",
          "curve",
          "pin",
          "grab",
          "light",
          "debug",
          "binding_debug",
        ].map((n) => [n, gl.getUniformLocation(this.program, "u_" + n)]),
      );
      this.attribute = gl.getAttribLocation(this.program, "a_uv");
      gl.enableVertexAttribArray(this.attribute);
      // Static paper faces reuse the same Retina textures as the bent sheet.
      // Avoid laying out and repainting cloned word-button trees mid-turn.
      const baseVertex = compile(gl.VERTEX_SHADER, `
        attribute vec2 a_uv; uniform vec2 u_view; uniform vec4 u_rect;
        varying highp vec2 v_uv;
        void main(){ v_uv=a_uv; vec2 p=u_rect.xy+a_uv*u_rect.zw;
          gl_Position=vec4(p.x/u_view.x*2.0-1.0,1.0-p.y/u_view.y*2.0,0.0,1.0); }
      `);
      const baseFragment = compile(gl.FRAGMENT_SHADER, `
        precision mediump float; uniform sampler2D u_image; varying highp vec2 v_uv;
        void main(){ gl_FragColor=texture2D(u_image,v_uv); }
      `);
      this.baseProgram = gl.createProgram();
      gl.attachShader(this.baseProgram, baseVertex);
      gl.attachShader(this.baseProgram, baseFragment);
      gl.linkProgram(this.baseProgram);
      gl.deleteShader(baseVertex); gl.deleteShader(baseFragment);
      if (!gl.getProgramParameter(this.baseProgram, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(this.baseProgram));
      this.baseAttribute = gl.getAttribLocation(this.baseProgram, "a_uv");
      this.baseUniforms = Object.fromEntries(["view", "rect", "image"].map(name =>
        [name, gl.getUniformLocation(this.baseProgram, "u_" + name)]));
      const mesh = (vertices, indices, streaming = false) => {
        const buffer = gl.createBuffer(),
          index = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          streaming ? 4096 : new Float32Array(vertices),
          streaming ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW,
        );
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
        gl.bufferData(
          gl.ELEMENT_ARRAY_BUFFER,
          streaming ? 4096 : new Uint16Array(indices),
          streaming ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW,
        );
        return { buffer, index, count: indices.length,
          vertexBytes: streaming ? 4096 : vertices.length * 4,
          indexBytes: streaming ? 4096 : indices.length * 2 };
      };
      // Rotate bounded storage instead of orphaning two Metal buffers on every
      // frame. 4 KiB covers both adaptive mesh forms; future meshes can grow.
      this.meshPool = Array.from({ length: 3 }, () =>
        mesh([0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 1, 3, 2], true));
      this.meshSlot = 0;
      this.mesh = this.meshPool[0];
      // An independent diagnostic uses the same vertex shader at material x=0;
      // it does not depend on adaptive paper vertices or cover any gap.
      this.spineMesh = mesh(
        Array.from({ length: 25 }, (_, y) => [0, y / 24]).flat(),
        Array.from({ length: 25 }, (_, y) => y),
      );
      this.plane = mesh([0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 1, 3, 2]);
      gl.frontFace(gl.CW);
      gl.enable(gl.BLEND);
      // Shadows darken opaque paper without lowering its coverage. Using the
      // RGB factors for alpha exposes the previous DOM page through the shadow.
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.root.dataset.curlContexts = "1";
      this.root.dataset.curlVertices = "4";
      this.canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        this.failed = true;
        this.root.dataset.curlFallback = "context-lost";
        this.pages.finishAnimation("gpu-lost");
      });
    } catch (error) {
      this.failed = true;
      this.root.dataset.curlFallback = error.message;
    }
    if (setup) {
      setup.finishedAt = performance.now();
      setup.canvasWidth = this.canvas.width;
      setup.canvasHeight = this.canvas.height;
      setup.failed = this.failed;
    }
  }
  mountSurface() {
    // Keep the WebGL context and drawing buffer warm, but attach its DOM node
    // only for an active turn. WKWebView can keep presenting the last IOSurface
    // after opacity/display changes; detaching the canvas is the compositor
    // ownership boundary that prevents a landed face covering the live DOM.
    Object.assign(this.layer.style, { contain: "layout paint", willChange: "transform" });
    this.layer.inert = true;
    this.layer.setAttribute("aria-hidden", "true");
    if (this.canvas.parentNode !== this.layer) this.layer.append(this.canvas);
  }
  invalidate({deferTextures = false, preserveSurface = false} = {}) {
    const retired = [];
    this.epoch++;
    this.warmRun++;
    this.warmPlan = null;
    cancelAnimationFrame(this.surfaceWarmRaf);
    delete this.root.dataset.curlWarm;
    delete this.root.dataset.curlWarmPlan;
    delete this.root.dataset.curlWarmStatus;
    if (!preserveSurface) this.primedSurface = null;
    this.pendingTextures = [];
    if (!preserveSurface) this.surfaceWarm = null;
    clearTimeout(this.warmTimer);
    for (const capture of this.captures) capture.abort();
    this.captures.clear();
    this.jobs.clear();
    if (this.gl && !this.gl.isContextLost())
      for (const value of this.cache.values()) {
        if (deferTextures) retired.push(value.texture);
        else this.gl.deleteTexture(value.texture);
      }
    this.cache.clear();
    return retired;
  }
  pauseWarm() {
    this.warmRun++;
    this.warmPlan = null;
    clearTimeout(this.warmTimer);
    cancelAnimationFrame(this.surfaceWarmRaf);
    delete this.root.dataset.curlWarm;
    delete this.root.dataset.curlWarmPlan;
    delete this.root.dataset.curlWarmStatus;
  }
  textureBudget() {
    return !this.software && this.pages.count === 2
      ? DOUBLE_TEXTURE_BYTES
      : TEXTURE_BYTES;
  }
  key(index, source = this.pages) {
    const generation = source.view?.textureGeneration ||
      source.presentedView?.textureGeneration || source.generation;
    return `${source.r.doc.id}:${source.r.doc.version}:${generation}:${this.epoch}:${devicePixelRatio || 1}:${index}`;
  }
  async inlineImages(page, ratio, signal) {
    const images = [...page.querySelectorAll("img")];
    const positive = value => Number.isFinite(value) && value > 0 ? value : 0;
    const prose = document.querySelector("#article .reading-prose");
    const liveFont = prose ? parseFloat(getComputedStyle(prose).fontSize) : 0;
    const font = positive(liveFont) || positive(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--reading-size"))) || 22;
    for (const image of images) {
      signal.throwIfAborted();
      const url = new URL(image.getAttribute("src"), location.origin);
      if (url.origin !== location.origin || !/^\/api\/pdf\/books\/\d+\/assets\//.test(url.pathname))
        throw new Error("Unregistered page image");
      // Capture pages are detached: their client rect / computed font can be
      // zero. Inline formula geometry is source points / source body font (em).
      // Resolve those em values against live prose, with conservative intrinsic
      // dimensions as fallback, never a missing attribute coerced to 1px.
      const headingScale = image.closest("h2") ? 1.15 : 1;
      const width = positive(Number(image.dataset.pdfWidthEm) * font * headingScale) ||
        positive(Number(image.getAttribute("width"))) || positive(image.naturalWidth);
      const height = positive(Number(image.dataset.pdfHeightEm) * font * headingScale) ||
        positive(Number(image.getAttribute("height"))) || positive(image.naturalHeight);
      const targetWidth = width ? Math.ceil(width * ratio) : null;
      const targetHeight = height ? Math.ceil(height * ratio) : null;
      const key = `${url.href}:${targetWidth}x${targetHeight}`;
      let cached = this.assets.get(key);
      if (!cached) {
        const response = await fetch(url, {credentials: "same-origin", cache: "force-cache", signal});
        const mime = (response.headers.get("Content-Type") || "").split(";")[0];
        if (!response.ok || !/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new Error("Page image unavailable");
        if (+(response.headers.get("Content-Length") || 0) > 64 * 1024 * 1024) throw new Error("Page image exceeds capture budget");
        const stream = response.body.getReader(), chunks = [];
        let size = 0;
        while (true) {
          const {done, value} = await stream.read();
          if (done) break;
          size += value.byteLength;
          if (size > 64 * 1024 * 1024) { await stream.cancel(); throw new Error("Page image exceeds capture budget"); }
          chunks.push(value);
        }
        let blob = new Blob(chunks, {type: mime});
        // Large retained scans are sampled at the actual paper texture density,
        // rather than embedding their full-resolution bytes in the SVG.
        if (size > 16 * 1024 * 1024) {
          if (!targetWidth || !targetHeight || !Number.isFinite(targetWidth * targetHeight) || targetWidth * targetHeight > 6e6)
            throw new Error("Page image exceeds texture budget");
          const bitmap = await createImageBitmap(blob, {resizeWidth: targetWidth, resizeHeight: targetHeight, resizeQuality: "high"});
          const canvas = document.createElement("canvas");
          try {
            canvas.width = targetWidth; canvas.height = targetHeight;
            canvas.getContext("2d").drawImage(bitmap, 0, 0);
            blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Page image sampling failed")), "image/png"));
          } finally {
            bitmap.close();
            canvas.width = canvas.height = 0;
          }
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Page image capture failed"));
          reader.readAsDataURL(blob);
        });
        signal.throwIfAborted();
        cached = {data, size: data.length * 2};
        if (cached.size <= 24 * 1024 * 1024) {
          while (this.assets.size && (this.assetBytes + cached.size > 24 * 1024 * 1024 || this.assets.size >= 256)) {
            const oldest = this.assets.keys().next().value;
            this.assetBytes -= this.assets.get(oldest).size;
            this.assets.delete(oldest);
          }
          this.assets.set(key, cached);
          this.assetBytes += cached.size;
        }
      } else {
        this.assets.delete(key);
        this.assets.set(key, cached);
      }
      image.setAttribute("src", cached.data);
      image.removeAttribute("loading");
    }
    return images.length;
  }
  async waitForIdleUpload(signal) {
    signal.throwIfAborted();
    while (this.scene && !this.failed) {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          this.uploadWaiters.delete(resume);
          signal.removeEventListener("abort", abort);
        };
        const resume = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        this.uploadWaiters.add(resume);
        signal.addEventListener("abort", abort, {once: true});
      });
      signal.throwIfAborted();
    }
  }
  async prepare(index, source = this.pages, guard = null) {
    // Resuming at an anchor may start a two-page spread on either parity.
    // Only pad the final spread reachable from that start, never an unfinished
    // layout whose provisional blank may become real text on the next yield.
    const trailingBlank = source.complete === true && source.count === 2 &&
      index === source.pages.length && source.index < source.pages.length &&
      (source.pages.length - source.index) % source.count === 1;
    if (guard && !guard()) return null;
    if (index < 0 || (index >= source.pages.length && !trailingBlank)) return null;
    const key = this.key(index, source),
      hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    if (this.jobs.has(key)) {
      const pending = this.jobs.get(key), value = await pending;
      if (value || (guard && !guard())) return value;
      // An input turn may arrive while an obsolete warm capture owns this key.
      // Retry only that stale producer; ordinary budget/failure nulls stay null.
      if (pending.warmGuard && !pending.warmGuard()) return this.prepare(index, source, guard);
      return null;
    }
    if (this.pages.r.scope.signal.aborted || this.jobs.size >= MAX_CAPTURE_JOBS) return null;
    const captureStartedAt = performance.now();
    const owner = this.pages, epoch = this.epoch,
      generation = this.pages.generation;
    const capture = new AbortController();
    this.captures.add(capture);
    const previousCapture = this.captureTail;
    let rasterImage = null, rasterCanvas = null;
    const job = (async () => {
      // A texture count limit cannot bound concurrent decoded SVG surfaces.
      // Keep one capture active; abort also releases its decoder on route leave.
      await previousCapture;
      capture.signal.throwIfAborted();
      if ((guard && !guard()) || owner !== this.pages || epoch !== this.epoch || generation !== this.pages.generation) return null;
      this.init();
      if (this.failed) return null;
      const leaf = $(".page-leaf"),
        rect = leaf?.getBoundingClientRect();
      if (!rect?.width) return null;
      const css = getComputedStyle(leaf),
        root = getComputedStyle(document.documentElement);
      const ratio = Math.min(
        devicePixelRatio || 1,
        this.software ? Math.sqrt(SOFTWARE_PIXELS / (document.getElementById("article").getBoundingClientRect().width * rect.height)) : 3,
        this.maxTexture / rect.height,
        this.maxTexture / rect.width,
        Math.sqrt(8e6 / (rect.width * rect.height)),
      );
      const vars = [
        "--bg",
        "--paper",
        "--surface",
        "--ink",
        "--muted",
        "--border",
        "--accent",
        "--accent-soft",
        "--gloss",
        "--reading-font",
        "--reading-size",
        "--reading-line",
        "--reading-width",
      ]
        .map((k) => `${k}:${root.getPropertyValue(k)};`)
        .join("");
      // Stylesheet serialization is cached once, not repeated per node or turn.
      this.rules ??= Array.from(document.styleSheets)
        .flatMap((sheet) => {
          try {
            return Array.from(sheet.cssRules, (r) => r.cssText);
          } catch {
            return [];
          }
        })
        .join("\n");
      const copy = document.createElement("div");
      copy.innerHTML = source.leafMarkup(index);
      const page = copy.firstElementChild;
      source.r.collectionsController?.paint(page);
      page
        .querySelectorAll(".inline-grammar,.bookmark-marker,.paragraph-actions,.pdf-object-actions,[data-pdf-source],[data-pdf-note]")
        .forEach((el) => el.remove());
      const embeddedImages = await this.inlineImages(page, ratio, capture.signal);
      if ((guard && !guard()) || owner !== this.pages || epoch !== this.epoch || generation !== this.pages.generation || this.pages.r.scope.signal.aborted) return null;
      page.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
      Object.assign(page.style, {
        width: rect.width + "px",
        height: rect.height + "px",
        padding: css.padding,
        margin: "0",
        overflow: "hidden",
      });
      const xml = (s) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const w = Math.ceil(rect.width * ratio),
        h = Math.ceil(rect.height * ratio);
      const markup = `<div xmlns="http://www.w3.org/1999/xhtml" class="paged-reader" style="${xml(vars)}width:${rect.width}px;height:${rect.height}px;color:${root.getPropertyValue("--ink")};background:${root.getPropertyValue("--paper")}"><style>${xml(this.rules)}</style><div id="article" style="width:100%;height:100%;display:block">${new XMLSerializer().serializeToString(page)}</div></div>`;
      // Keep the SVG viewport in pixels and scale inside the HTML subtree.
      // WebKit does not consistently apply a viewBox scale to foreignObject
      // HTML when the SVG is decoded as an image.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="transform:scale(${ratio});transform-origin:0 0;width:${rect.width}px;height:${rect.height}px">${markup}</div></foreignObject></svg>`;
      const image = await new Promise((resolve, reject) => {
        const img = (rasterImage = new Image());
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          img.onload = img.onerror = null;
          capture.signal.removeEventListener("abort", abort);
          if (error) {
            img.removeAttribute("src");
            reject(error);
          } else resolve(img);
        };
        const abort = () => finish(capture.signal.reason || new DOMException("Page capture cancelled", "AbortError"));
        img.onload = () => finish();
        img.onerror = () => finish(new Error("Page raster failed"));
        if (capture.signal.aborted) { abort(); return; }
        capture.signal.addEventListener("abort", abort, {once: true});
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      });
      // Decode lookahead while a hand is moving, but do not upload or query
      // GPU errors until that paper has landed. A synchronous error query can
      // otherwise wait for the active draw and stall its own release frames.
      // Required faces are prepared before attach; preserve their error checks,
      // native density, serialized capture and existing cache budgets.
      await this.waitForIdleUpload(capture.signal);
      if (
        (guard && !guard()) ||
        owner !== this.pages || epoch !== this.epoch ||
        generation !== this.pages.generation ||
        this.pages.r.scope.signal.aborted ||
        this.failed
      )
        return null;
      // SVG onload leaves direct WebGL uploads doing expensive vector raster
      // work. Stage through a native-size 2D surface before the pixel upload;
      // its backing store is released with the serialized capture below.
      const rasterStartedAt = performance.now();
      rasterCanvas = document.createElement("canvas");
      rasterCanvas.width = w;
      rasterCanvas.height = h;
      const rasterContext = rasterCanvas.getContext("2d");
      if (!rasterContext) throw new Error("Page raster context unavailable");
      rasterContext.drawImage(image, 0, 0);
      const uploadStartedAt = performance.now();
      const gl = this.gl,
        bytes = w * h * 4,
        budget = this.textureBudget(),
        bytesBefore = [...this.cache.values()].reduce((n, value) => n + value.bytes, 0),
        pinned = new Set([...(this.scene?.textures || []), ...(this.pendingTextures || []),
          ...(this.warmPlan?.keys || [])]),
        needsRoom = this.cache.size + 1 > 6 || bytesBefore + bytes > budget,
        reusable = needsRoom && [...this.cache.entries()].find(([oldKey, value]) =>
          !pinned.has(oldKey) && value.pixelWidth === w && value.pixelHeight === h);
      // Reserve room before allocation. Under continuous paging, reuse an old
      // unreferenced leaf's storage instead of allocating a fifth Retina image
      // and deleting it again after the upload has stalled the active release.
      const victims = reusable ? [reusable] : [];
      let plannedBytes = bytesBefore + bytes - (reusable ? reusable[1].bytes : 0),
        plannedCount = this.cache.size + 1 - (reusable ? 1 : 0);
      for (const entry of this.cache) {
        if (plannedBytes <= budget && plannedCount <= 6) break;
        if (pinned.has(entry[0]) || entry[0] === reusable?.[0]) continue;
        victims.push(entry);
        plannedBytes -= entry[1].bytes;
        plannedCount--;
      }
      // A wide DPR 3 double spread can need four pinned faces larger than its
      // soft byte target. Preserve that existing required working set; optional
      // prefetch cannot add to it, and no referenced face may be overwritten.
      if (plannedBytes > budget && (guard || !pinned.has(key))) return null;
      if (plannedCount > 6)
        throw new Error("Page texture cache budget exhausted");
      if (guard && !guard()) return null;
      for (const [oldKey, old] of victims) {
        this.cache.delete(oldKey);
        if (old !== reusable?.[1]) gl.deleteTexture(old.texture);
      }
      // Deletion can clear an idle binding. Snapshot only after eviction, and
      // restore on upload errors as well as success.
      const active = gl.getParameter(gl.ACTIVE_TEXTURE),
        bound = gl.getParameter(gl.TEXTURE_BINDING_2D),
        texture = reusable ? reusable[1].texture : gl.createTexture();
      let uploaded = false;
      try {
        if (!texture) throw new Error("Texture allocation failed");
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (reusable) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, rasterCanvas);
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          if (this.anisotropy && !this.software)
            gl.texParameterf(
              gl.TEXTURE_2D,
              this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
              Math.min(4, gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)),
            );
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rasterCanvas);
        }
        if (gl.getError() !== gl.NO_ERROR) throw new Error("Texture upload failed");
        uploaded = true;
      } finally {
        if (!uploaded) gl.deleteTexture(texture);
        gl.activeTexture(active);
        gl.bindTexture(gl.TEXTURE_2D, !uploaded && bound === texture ? null : bound);
      }
      const value = {
        texture,
        embeddedImages,
        width: rect.width,
        height: rect.height,
        pixels: w * h,
        bytes,
        pixelWidth: w,
        pixelHeight: h,
        ratio,
        key,
      };
      if (this.collectPerformance) {
        this.captureTrace ??= [];
        this.captureTrace.push({startedAt: captureStartedAt, rasterStartedAt, uploadStartedAt, finishedAt: performance.now(), moving: Boolean(this.scene), index, documentId: source.r.doc.id,
          uploadMethod: reusable ? "texSubImage2D" : "texImage2D", bytesBefore, bytesAfter: plannedBytes});
        this.captureTrace = this.captureTrace.slice(-24);
      }
      if (guard && !guard()) {
        if (!reusable) gl.deleteTexture(texture);
        return null;
      }
      this.cache.set(key, value);
      this.root.dataset.curlCachedLeaves = String(this.cache.size);
      this.root.dataset.curlCachedPixels = String(
        [...this.cache.values()].reduce((n, v) => n + v.pixels, 0),
      );
      this.root.dataset.curlCachedBytes = String(
        [...this.cache.values()].reduce((n, v) => n + v.bytes, 0),
      );
      return value;
    })()
      .catch((error) => {
        if (error.name !== "AbortError") this.root.dataset.curlFallback = error.message;
        return null;
      })
      .finally(() => {
        if (rasterCanvas) {
          rasterCanvas.width = rasterCanvas.height = 0;
          rasterCanvas = null;
        }
        if (rasterImage) {
          rasterImage.onload = rasterImage.onerror = null;
          rasterImage.removeAttribute("src");
          rasterImage = null;
        }
        this.captures.delete(capture);
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      });
    this.captureTail = job;
    job.warmGuard = guard;
    this.jobs.set(key, job);
    return job;
  }
  warm() {
    const run = ++this.warmRun;
    this.warmPlan = null;
    clearTimeout(this.warmTimer);
    cancelAnimationFrame(this.surfaceWarmRaf);
    delete this.root.dataset.curlWarm;
    delete this.root.dataset.curlWarmPlan;
    this.root.dataset.curlWarmStatus = "scheduled";
    const generation = this.pages.generation,
      epoch = this.epoch;
    this.warmTimer = setTimeout(async () => {
      const p = this.pages,
        index = p.index,
        baseValid = () =>
          run === this.warmRun && p === this.pages && p.index === index &&
          generation === p.generation && epoch === this.epoch &&
          !p.r.scope.signal.aborted && !p.animating && !p.r.popElement;
      const presentationPlan = await p.getPresentationSourcePlan?.();
      if (!baseValid()) return;
      if (presentationPlan?.sources?.length === 0) {
        this.root.dataset.curlWarmStatus = "failed";
        return;
      }
      const presentationSources = presentationPlan?.sources || null,
        plan = presentationSources
        ? presentationSources.flatMap(source =>
          Array.from({length: source.count}, (_, i) => ({source, index: source.index + i})))
        : [
          p.index,
          p.index + p.count - 1,
          p.index + p.count,
          p.index - 1,
          p.index + p.count * 2 - 1,
          p.index - p.count,
        ].map(index => ({source: p,index}));
      const warmable = ({source,index}) => index >= 0 && (index < source.pages.length ||
          (source.complete === true && source.count === 2 && index === source.pages.length &&
            source.index < source.pages.length && (source.pages.length - source.index) % source.count === 1)),
        unique = new Map(plan.filter(warmable).map(item => [this.key(item.index,item.source),item])),
        keys = [...unique.keys()],
        identity = presentationPlan?.identity ||
          `canonical:${p.r.doc.id}:${p.r.doc.version}:${generation}:${index}:${p.count}:${epoch}:${devicePixelRatio || 1}`,
        valid = () => baseValid() &&
          (presentationPlan
            ? p.presentationSourcePlanIdentity?.() === presentationPlan.identity
            : !p.presentationSourcePlanIdentity?.());
      if (!valid()) return;
      this.warmPlan = {run, identity, keys, presentation: Boolean(presentationPlan)};
      this.root.dataset.curlWarmPlan = JSON.stringify({run, identity,
        presentation: Boolean(presentationPlan), windows: presentationPlan?.windows || [], keys});
      this.root.dataset.curlWarmStatus = "preparing";
      for (const {source,index:i} of unique.values()) {
        if (!valid()) return;
        const value = await this.prepare(i,source,valid);
        if (!valid()) return;
        if (!value) {
          this.root.dataset.curlWarmStatus = "failed";
          this.warmPlan = null;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (!valid()) return;
      }
      if (!keys.every(key => this.cache.has(key))) {
        if (valid()) {
          this.root.dataset.curlWarmStatus = "failed";
          this.warmPlan = null;
        }
        return;
      }
      // Single-page queued-turn lookahead is optional and is not part of the
      // truthful warm plan. Try it only after every required key is resident,
      // without evicting that plan or exceeding the existing byte/count budget.
      if (!presentationSources && p.count === 1) {
        const optionalIndex = index + 2,
          optionalKey = this.key(optionalIndex),
          current = this.cache.get(this.key(index)),
          bytes = [...this.cache.values()].reduce((n, value) => n + value.bytes, 0);
        if (optionalIndex < p.pages.length && !this.cache.has(optionalKey) && current &&
            this.cache.size < 6 && bytes + current.bytes <= this.textureBudget()) {
          await this.prepare(optionalIndex,p,valid);
          if (!valid()) return;
        }
      }
      // Texture readiness does not allocate the final drawing buffer. Prepare
      // that same buffer while idle; attach still verifies its current size.
      if (!valid()) return;
      if (this.failed || !this.gl) {
        this.root.dataset.curlWarmStatus = "failed";
        this.warmPlan = null;
        return;
      }
      const rect = $("#article").getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const { width, height } = this.surfaceDimensions(rect);
        const setup = this.collectPerformance ? {
          startedAt: performance.now(), canvasBefore: [this.canvas.width, this.canvas.height],
          source: "idle-texture-warm",
        } : null;
        this.resizeSurface(width, height, setup);
        const stage = $("#reading-stage").getBoundingClientRect();
        Object.assign(this.layer.style, {
          left: rect.left - stage.left + "px", top: rect.top - stage.top + "px",
          width: rect.width + "px", height: rect.height + "px",
        });
        this.clearSurface();
        if (setup) this.surfaceWarm = setup;
        this.primePresentation(width, height, generation, epoch, () => {
          if (valid() && keys.every(key => this.cache.has(key))) {
            this.root.dataset.curlWarm = "true";
            this.root.dataset.curlWarmStatus = "ready";
          }
        }, valid);
      } else {
        this.root.dataset.curlWarmStatus = "failed";
        this.warmPlan = null;
      }
    }, 120);
  }
  primePresentation(width, height, generation, epoch, ready, guard = null) {
    const identity = `${width}:${height}`;
    if (this.primedSurface === identity) {
      ready?.();
      return;
    }
    cancelAnimationFrame(this.surfaceWarmRaf);
    const owner = this.pages;
    let remaining = 4;
    const frame = () => {
      this.surfaceWarmRaf = 0;
      if ((guard && !guard()) || owner !== this.pages || generation !== owner.generation ||
          epoch !== this.epoch || owner.r.scope.signal.aborted ||
          owner.animating || this.scene || this.failed ||
          this.canvas.width !== width || this.canvas.height !== height) return;
      // Allocating a drawing buffer is not presenting it. Warm WebKit's bounded
      // presentation-buffer rotation while idle, with transparent frames only.
      // No perpetual loop, extra textures, lower DPI or wait in the input path.
      this.clearSurface();
      this.gl.flush();
      if (--remaining) this.surfaceWarmRaf = requestAnimationFrame(frame);
      else {
        this.primedSurface = identity;
        ready?.();
      }
    };
    this.surfaceWarmRaf = requestAnimationFrame(frame);
  }
  surfaceDimensions(rect) {
    // A full-screen Retina spread needs ~10M pixels. Keep a bounded hardware
    // budget without downsampling ordinary 2x Mac windows.
    const pixels = this.software ? SOFTWARE_PIXELS : 16000000;
    const ratio = Math.min(
        devicePixelRatio || 1,
        3,
        this.maxCanvas / rect.height,
        this.maxCanvas / rect.width,
        Math.sqrt(pixels / (rect.width * rect.height)),
      ),
      width = Math.ceil(rect.width * ratio),
      height = Math.ceil(rect.height * ratio);
    return { pixels, ratio, width, height };
  }
  resizeSurface(width, height, setup) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      if (setup) setup.resizeStartedAt = performance.now();
      this.canvas.width = width;
      if (setup) setup.widthAssignedAt = performance.now();
      this.canvas.height = height;
      if (setup) setup.heightAssignedAt = performance.now();
    }
    if (setup) {
      setup.sizeReadyAt = performance.now();
      setup.canvasAfter = [this.canvas.width, this.canvas.height];
      setup.resized = Boolean(setup.resizeStartedAt);
    }
  }
  attach(leaves, direction, front, back, grab, stationary) {
    const setup = this.collectPerformance ? (this.attachSetup = {
      startedAt: performance.now(), canvasBefore: [this.canvas.width, this.canvas.height],
      contextAlreadyCreated: Boolean(this.gl),
    }) : null;
    if (this.failed || !front || !back || stationary.some(page => !page.texture)) return false;
    const gl = this.gl,
      rect = $("#article").getBoundingClientRect(),
      stage = $("#reading-stage").getBoundingClientRect();
    const double = leaves.length === 2,
      leaf = leaves[direction > 0 && double ? 1 : 0],
      gap = double ? leaves[1].x - leaves[0].x - front.width : 0;
    if (setup) setup.geometryReadAt = performance.now();
    Object.assign(this.layer.style, {
      left: rect.left - stage.left + "px",
      top: rect.top - stage.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
    this.layer.inert = true;
    for (const child of [...this.layer.children]) if (child !== this.canvas) child.remove();
    this.mountSurface();
    if (setup) setup.layersMountedAt = performance.now();
    // Software rasterizers pay per shaded pixel. Keep the animated sheet
    // bounded; the live source DOM and its static text retain full resolution.
    const { pixels, ratio, width, height } = this.surfaceDimensions(rect);
    this.root.dataset.curlDrawRatio = ratio.toFixed(3);
    this.root.dataset.curlTextureRatio = Math.min(
      front.ratio,
      back.ratio,
    ).toFixed(3);
    this.root.dataset.curlEmbeddedImages = String((front.embeddedImages || 0) + (back.embeddedImages || 0));
    this.root.dataset.curlImageFaces = JSON.stringify({front: front.embeddedImages || 0, back: back.embeddedImages || 0});
    this.root.dataset.curlResolution = JSON.stringify({
      dpr: devicePixelRatio || 1,
      canvas: {
        width,
        height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        ratio,
      },
      front: {
        width: front.pixelWidth,
        height: front.pixelHeight,
        ratio: front.ratio,
      },
      back: {
        width: back.pixelWidth,
        height: back.pixelHeight,
        ratio: back.ratio,
      },
      software: this.software,
      pixels,
    });
    this.resizeSurface(width, height, setup);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    if (setup) setup.viewportProgramAt = performance.now();
    gl.uniform2f(this.u.view, rect.width, rect.height);
    gl.uniform1f(this.u.mirror, direction);
    gl.uniform1f(
      this.u.dark,
      document.documentElement.dataset.theme === "night" ? 1 : 0,
    );
    gl.uniform1f(this.u.light, this.pages.lightEnabled() ? 1 : 0);
    gl.uniform1f(
      this.u.debug,
      new URL(location.href).searchParams.has("debug-grip") ? 1 : 0,
    );
    gl.uniform4f(
      this.u.leaf,
      direction > 0 ? leaf.x : leaf.x + leaf.width,
      0,
      leaf.width,
      leaf.height,
    );
    gl.uniform1f(this.u.gap, gap);
    this.bindingDebug = new URL(location.href).searchParams.has("debug-spine");
    gl.uniform1f(this.u.binding_debug, 0);
    for (const [i, value] of [front, back].entries()) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, value.texture);
      gl.uniform1i(i === 0 ? this.u.front : this.u.back, i);
    }
    if (setup) setup.uniformsTexturesAt = performance.now();
    this.scene = {
      rect,
      leaf,
      direction,
      gap,
      grab,
      front,
      back,
      stationary,
      textures: [...new Set([front.key, back.key, ...stationary.map(page => page.texture.key)])],
    };
    this.samples = [];
    this.inputSamples = [];
    this.solveSamples = [];
    this.drawTimes = [];
    this.submitSamples = [];
    this.lastInputPose = null;
    this.lastFrame = 0;
    this.started = performance.now();
    this.firstFrame = null;
    this.root.dataset.curlPhase = "dragging";
    this.layer.dataset.renderer = "webgl-developable-paper";
    if (setup) setup.finishedAt = performance.now();
    return true;
  }
  draw(progress, grab, dy, inputAt, inputPhase = "tracking") {
    if (!this.scene || this.failed) return;
    const gl = this.gl,
      now = performance.now(),
      { leaf, rect, direction, gap } = this.scene,
      solveStart = performance.now(),
      fold = foldForPointer(leaf.width, leaf.height, progress, grab, dy),
      mesh = paperMesh(leaf.width, leaf.height, fold.model, fold.curve);
    this.solveSamples.push(performance.now() - solveStart);
    this.mesh = this.meshPool[this.meshSlot];
    this.meshSlot = (this.meshSlot + 1) % this.meshPool.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.buffer);
    if (mesh.uv.byteLength > this.mesh.vertexBytes) {
      this.mesh.vertexBytes = 2 ** Math.ceil(Math.log2(mesh.uv.byteLength));
      gl.bufferData(gl.ARRAY_BUFFER, this.mesh.vertexBytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.uv);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.index);
    if (mesh.indices.byteLength > this.mesh.indexBytes) {
      this.mesh.indexBytes = 2 ** Math.ceil(Math.log2(mesh.indices.byteLength));
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indexBytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, mesh.indices);
    this.mesh.count = mesh.indices.length;
    this.root.dataset.curlVertices = String(mesh.uv.length / 2);
    if (this.lastFrame) this.samples.push(now - this.lastFrame);
    this.lastFrame = now;
    this.firstFrame ??= now;
    if (inputAt) {
      this.inputSamples.push(now - inputAt);
      // Identify a release-consumed input separately from a tracked hand pose.
      // Bounded numeric evidence makes a reported distortion reproducible.
      this.lastInputPose = {
        inputPhase,
        progress,
        grab,
        dy,
        direction,
        width: leaf.width,
        height: leaf.height,
        requested: fold.requested,
        effective: { x: fold.x, y: fold.y },
        limited: fold.limited,
        model: fold.model,
        curve: fold.curve,
      };
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.baseProgram);
    gl.enableVertexAttribArray(this.baseAttribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.plane.buffer);
    gl.vertexAttribPointer(this.baseAttribute, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.plane.index);
    gl.uniform2f(this.baseUniforms.view, rect.width, rect.height);
    gl.uniform1i(this.baseUniforms.image, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const page of this.scene.stationary) {
      gl.bindTexture(gl.TEXTURE_2D, page.texture.texture);
      gl.uniform4f(this.baseUniforms.rect, page.x, 0, page.texture.width, page.texture.height);
      gl.drawElements(gl.TRIANGLES, this.plane.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.useProgram(this.program);
    gl.enableVertexAttribArray(this.attribute);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.front.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.back.texture);
    gl.uniform1f(this.u.progress, progress);
    gl.uniform1f(this.u.grab, grab);
    gl.uniform4fv(this.u.model, fold.model);
    gl.uniform4fv(this.u.curve, fold.curve);
    gl.uniform2f(this.u.pin, fold.x, fold.y);
    const draw = (mesh) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
      gl.vertexAttribPointer(this.attribute, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    };
    gl.disable(gl.DEPTH_TEST);
    gl.uniform1f(this.u.plane, 1);
    draw(this.plane);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1f(this.u.plane, 0);
    draw(this.mesh);
    if (this.bindingDebug) {
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1f(this.u.binding_debug, 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spineMesh.buffer);
      gl.vertexAttribPointer(this.attribute, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spineMesh.index);
      gl.drawElements(
        gl.LINE_STRIP,
        this.spineMesh.count,
        gl.UNSIGNED_SHORT,
        0,
      );
      gl.uniform1f(this.u.binding_debug, 0);
    }
    this.layer.dataset.binding = JSON.stringify({
      x: rect.left + (direction > 0 ? leaf.x : leaf.x + leaf.width),
      top: rect.top + leaf.y,
      bottom: rect.top + leaf.y + leaf.height,
      materialVertices: this.spineMesh.count,
    });
    this.layer.dataset.pin = JSON.stringify({
      x:
        rect.left +
        (direction > 0 ? leaf.x : leaf.x + leaf.width) +
        direction * fold.x,
      y: rect.top + leaf.y + leaf.height / 2 + fold.y,
      requested: {
        x:
          rect.left +
          (direction > 0 ? leaf.x : leaf.x + leaf.width) +
          direction * fold.requested.x,
        y: rect.top + leaf.y + leaf.height / 2 + fold.requested.y,
      },
      limited: fold.limited,
      model: fold.model,
      grab,
      dy,
    });
    if (this.collectPerformance && this.drawTimes.length < 4096) {
      this.drawTimes.push(now - this.started);
      this.submitSamples.push(performance.now() - now);
    }
  }
  record(completed, reason, requested, settle, setup) {
    if (!this.scene) return;
    const percentile = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return +(sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(2);
    };
    const metric = {
      completed,
      reason,
      renderer: "webgl-developable-paper",
      firstFrameMs: +(
        (this.firstFrame || performance.now()) - requested
      ).toFixed(1),
      frames: this.samples.length + 1,
      p95FrameMs: percentile(this.samples),
      over34ms: this.samples.filter((n) => n > 34).length,
      p95InputMs: percentile(this.inputSamples),
      p95SolveMs: percentile(this.solveSamples),
      lastInputPose: this.lastInputPose,
      warm: this.wasWarm,
      cachedLeaves: this.cache.size,
    };
    if (settle) {
      const end = performance.now();
      metric.release = {
        from: +settle.from.toFixed(3),
        requestedDurationMs: +settle.duration.toFixed(1),
        actualDurationMs: +(end - settle.start).toFixed(1),
        textureWaitMs: +(settle.start - settle.releaseAt).toFixed(1),
        idleMs: settle.inputAt
          ? +(settle.releaseAt - settle.inputAt).toFixed(1)
          : null,
        inputToLandingMs: settle.inputAt
          ? +(end - settle.inputAt).toFixed(1)
          : null,
      };
    }
    if (this.collectPerformance) {
      if (settle) {
        const draws = this.drawTimes.map(at => this.started + at)
          .filter(at => at >= settle.releaseAt);
        const intervals = draws.map((at, i) => at - (i ? draws[i - 1] : settle.releaseAt));
        const complete = draws.length > 0 && this.drawTimes.length === this.solveSamples.length;
        // Keep legacy intervals above unchanged. An input-driven paper can
        // legitimately stay still; report release-to-landing separately,
        // including the wait from the release handler to the first draw.
        metric.releaseActive = {
          scope: "release handler to JS draw; excludes physical input queue and GPU presentation",
          status: complete ? "measured" : "incomplete",
          p95FrameMs: complete ? percentile(intervals) : null,
          over34ms: complete ? intervals.filter(ms => ms > 34).length : null,
          frameIntervalsMs: intervals,
        };
      }
      metric.sequence = ++this.metricSequence;
      metric.documentId = this.pages.r.doc.id;
      metric.pageIndex = this.pages.index;
      metric.raw = {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        visibility: document.visibilityState,
        timeOrigin: performance.timeOrigin,
        startedAt: this.started,
        requestedAt: requested,
        releaseAt: settle?.releaseAt ?? null,
        recordedAt: performance.now(),
        frameIntervalsMs: this.samples.slice(0, 4096),
        inputToDrawMs: this.inputSamples.slice(0, 4096),
        solveMs: this.solveSamples.slice(0, 4096),
        drawAtMs: this.drawTimes,
        submitMs: this.submitSamples,
        counts: { frame: this.samples.length, input: this.inputSamples.length, draw: this.solveSamples.length },
        truncated: Math.max(this.samples.length, this.inputSamples.length, this.solveSamples.length) > 4096,
        setup: setup ? { turn: setup, attach: this.attachSetup || null, context: this.contextSetup || null, surfaceWarm: this.surfaceWarm || null } : null,
        captureTrace: (this.captureTrace || []).filter(entry => entry.finishedAt >= requested),
        scope: "JS draw submission intervals and last coalesced input; not GPU presentation or physical latency",
      };
    }
    this.metrics ??= [];
    this.metrics.push(metric);
    this.metrics = this.metrics.slice(-30);
    this.root.dataset.curlMetrics = JSON.stringify(this.metrics);
  }
  finish() {
    cancelAnimationFrame(this.raf);
    this.scene = null;
    this.pendingTextures = [];
    // CSS hidden/opacity and even DOM detachment do not reliably retire a
    // WKWebView WebGL IOSurface. Clear and release the drawing buffer while the
    // context is still live, then detach it; warm() may allocate a transparent
    // buffer off-DOM for the next turn without retaining this landed face.
    this.clearSurface();
    if (this.gl && !this.gl.isContextLost()) this.gl.flush();
    this.canvas.width = this.canvas.height = 0;
    this.canvas.remove();
    for (const child of [...this.layer.children]) if (child !== this.canvas) child.remove();
    delete this.layer.dataset.pin;
    delete this.layer.dataset.binding;
    this.root.dataset.curlPhase = "idle";
    for (const resume of this.uploadWaiters) resume();
  }
  clearSurface() {
    if (!this.gl || this.gl.isContextLost()) return;
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
  }
  dispose() {
    if (this.root.__curlRendererTest === this) delete this.root.__curlRendererTest;
    this.finish();
    this.invalidate();
    this.assets.clear();
    this.assetBytes = 0;
    // Shrink while the context is live: WebKit can ignore framebuffer resizing
    // after synthetic context loss, retaining the full-size drawing buffers.
    this.canvas.width = this.canvas.height = 0;
    if (this.gl && !this.gl.isContextLost()) {
      for (const mesh of [...(this.meshPool || [this.mesh]), this.plane])
        if (mesh) {
          this.gl.deleteBuffer(mesh.buffer);
          this.gl.deleteBuffer(mesh.index);
        }
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.baseProgram) this.gl.deleteProgram(this.baseProgram);
      if (this.spineMesh) {
        this.gl.deleteBuffer(this.spineMesh.index);
        this.gl.deleteBuffer(this.spineMesh.buffer);
      }
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.canvas.remove();
  }
}
