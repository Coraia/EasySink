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
    // Native diagnostics cannot add a URL flag. Keep bounded numeric traces in
    // its existing export, without book text or a second sampling timer.
    this.collectPerformance = window.wiseReaderDesktop?.nativeTrackpad === true ||
      new URLSearchParams(location.search).get("readingPerf") === "1";
    this.metricSequence = 0;
    pages.r.scope.cleanup(() => { if (!this.handingOff && this.pages === pages) this.dispose(); });
  }
  rebind(pages) {
    clearTimeout(this.warmTimer);
    cancelAnimationFrame(this.surfaceWarmRaf);
    this.surfaceWarm = null;
    for (const capture of this.captures) capture.abort();
    this.captures.clear();
    this.jobs.clear();
    const previousRoot = this.root;
    this.pages = pages;
    this.root = $(".reader");
    this.layer = $("#page-curl-layer");
    this.mountSurface();
    this.handingOff = false;
    this.root.dataset.curlContexts = this.gl ? "1" : "0";
    this.root.dataset.curlMetrics = JSON.stringify(this.metrics || []);
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
      const mesh = (vertices, indices) => {
        const buffer = gl.createBuffer(),
          index = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array(vertices),
          gl.STATIC_DRAW,
        );
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
        gl.bufferData(
          gl.ELEMENT_ARRAY_BUFFER,
          new Uint16Array(indices),
          gl.STATIC_DRAW,
        );
        return { buffer, index, count: indices.length };
      };
      this.mesh = mesh([0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 1, 3, 2]);
      // An independent diagnostic uses the same vertex shader at material x=0;
      // it does not depend on adaptive paper vertices or cover any gap.
      this.spineMesh = mesh(
        Array.from({ length: 25 }, (_, y) => [0, y / 24]).flat(),
        Array.from({ length: 25 }, (_, y) => y),
      );
      this.plane = mesh([0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 1, 3, 2]);
      gl.frontFace(gl.CW);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    // Retain WebKit's compositing surface between turns. Removing a Retina
    // canvas and mounting it again can stall the first moving frame even with
    // warm textures and an unchanged drawing-buffer size.
    this.layer.hidden = false;
    Object.assign(this.layer.style, { contain: "layout paint", willChange: "transform" });
    this.layer.inert = true;
    this.layer.setAttribute("aria-hidden", "true");
    this.layer.append(this.canvas);
  }
  invalidate() {
    this.epoch++;
    cancelAnimationFrame(this.surfaceWarmRaf);
    this.primedSurface = null;
    this.pendingTextures = [];
    this.surfaceWarm = null;
    clearTimeout(this.warmTimer);
    for (const capture of this.captures) capture.abort();
    this.captures.clear();
    this.jobs.clear();
    if (this.gl && !this.gl.isContextLost())
      for (const value of this.cache.values())
        this.gl.deleteTexture(value.texture);
    this.cache.clear();
  }
  key(index, source = this.pages) {
    return `${source.r.doc.id}:${source.r.doc.version}:${source.generation}:${this.epoch}:${devicePixelRatio || 1}:${index}`;
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
  async prepare(index, source = this.pages) {
    // Resuming at an anchor may start a two-page spread on either parity.
    // Only pad the final spread reachable from that start, never an unfinished
    // layout whose provisional blank may become real text on the next yield.
    const trailingBlank = source.complete === true && source.count === 2 &&
      index === source.pages.length && source.index < source.pages.length &&
      (source.pages.length - source.index) % source.count === 1;
    if (index < 0 || (index >= source.pages.length && !trailingBlank)) return null;
    const key = this.key(index, source),
      hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    if (this.jobs.has(key)) return this.jobs.get(key);
    if (this.pages.r.scope.signal.aborted || this.jobs.size >= MAX_CAPTURE_JOBS) return null;
    const captureStartedAt = performance.now();
    const owner = this.pages, epoch = this.epoch,
      generation = this.pages.generation;
    const capture = new AbortController();
    this.captures.add(capture);
    const previousCapture = this.captureTail;
    let rasterImage = null;
    const job = (async () => {
      // A texture count limit cannot bound concurrent decoded SVG surfaces.
      // Keep one capture active; abort also releases its decoder on route leave.
      await previousCapture;
      capture.signal.throwIfAborted();
      if (owner !== this.pages || epoch !== this.epoch || generation !== this.pages.generation) return null;
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
        Math.sqrt(6e6 / (rect.width * rect.height)),
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
      if (owner !== this.pages || epoch !== this.epoch || generation !== this.pages.generation || this.pages.r.scope.signal.aborted) return null;
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
      if (
        owner !== this.pages || epoch !== this.epoch ||
        generation !== this.pages.generation ||
        this.pages.r.scope.signal.aborted ||
        this.failed
      )
        return null;
      const uploadStartedAt = performance.now();
      const gl = this.gl,
        active = gl.getParameter(gl.ACTIVE_TEXTURE),
        bound = gl.getParameter(gl.TEXTURE_BINDING_2D),
        texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.anisotropy && !this.software)
        gl.texParameterf(
          gl.TEXTURE_2D,
          this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(
            4,
            gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT),
          ),
        );
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      if (gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(texture);
        throw new Error("Texture upload failed");
      }
      gl.bindTexture(gl.TEXTURE_2D, bound);
      gl.activeTexture(active);
      const value = {
        texture,
        embeddedImages,
        width: rect.width,
        height: rect.height,
        pixels: w * h,
        bytes: w * h * 4,
        pixelWidth: w,
        pixelHeight: h,
        ratio,
        key,
      };
      if (this.collectPerformance) {
        this.captureTrace ??= [];
        this.captureTrace.push({startedAt: captureStartedAt, uploadStartedAt, finishedAt: performance.now(), moving: Boolean(this.scene), index, documentId: source.r.doc.id});
        this.captureTrace = this.captureTrace.slice(-24);
      }
      this.cache.set(key, value);
      // Preserve native raster density and the existing six-leaf / 96MB budget.
      while (
        this.cache.size > 6 ||
        [...this.cache.values()].reduce((n, v) => n + v.bytes, 0) > TEXTURE_BYTES
      ) {
        const pinned = [...(this.scene?.textures || []), ...(this.pendingTextures || [])];
        const oldest = [...this.cache.keys()].find((k) => !pinned.includes(k));
        if (!oldest) break;
        if (oldest === key && this.cache.size === 1) break;
        gl.deleteTexture(this.cache.get(oldest).texture);
        this.cache.delete(oldest);
      }
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
        if (rasterImage) {
          rasterImage.onload = rasterImage.onerror = null;
          rasterImage.removeAttribute("src");
          rasterImage = null;
        }
        this.captures.delete(capture);
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      });
    this.captureTail = job;
    this.jobs.set(key, job);
    return job;
  }
  warm() {
    clearTimeout(this.warmTimer);
    const generation = this.pages.generation,
      epoch = this.epoch;
    this.warmTimer = setTimeout(async () => {
      const p = this.pages,
        index = p.index,
        indices = [
          p.index,
          p.index + p.count - 1,
          p.index + p.count,
          p.index - 1,
          p.index + p.count * 2 - 1,
          p.index - p.count,
        ];
      for (const i of new Set(indices)) {
        if (
          p !== this.pages || p.index !== index ||
          generation !== p.generation ||
          epoch !== this.epoch ||
          p.r.scope.signal.aborted ||
          p.animating
        )
          return;
        await this.prepare(i);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Texture readiness does not allocate the final drawing buffer. Prepare
      // that same buffer while idle; attach still verifies its current size.
      if (p !== this.pages || p.index !== index || generation !== p.generation || epoch !== this.epoch ||
          p.r.scope.signal.aborted || p.animating || this.failed || !this.gl) return;
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
        this.primePresentation(width, height, generation, epoch);
      }
      this.root.dataset.curlWarm = "true";
    }, 120);
  }
  primePresentation(width, height, generation, epoch) {
    const identity = `${width}:${height}`;
    if (this.primedSurface === identity) return;
    cancelAnimationFrame(this.surfaceWarmRaf);
    const owner = this.pages;
    let remaining = 4;
    const frame = () => {
      this.surfaceWarmRaf = 0;
      if (owner !== this.pages || generation !== owner.generation ||
          epoch !== this.epoch || owner.r.scope.signal.aborted ||
          owner.animating || this.scene || this.failed ||
          this.canvas.width !== width || this.canvas.height !== height) return;
      // Allocating a drawing buffer is not presenting it. Warm WebKit's bounded
      // presentation-buffer rotation while idle, with transparent frames only.
      // No perpetual loop, extra textures, lower DPI or wait in the input path.
      this.clearSurface();
      this.gl.flush();
      if (--remaining) this.surfaceWarmRaf = requestAnimationFrame(frame);
      else this.primedSurface = identity;
    };
    this.surfaceWarmRaf = requestAnimationFrame(frame);
  }
  surfaceDimensions(rect) {
    const pixels = this.software ? SOFTWARE_PIXELS : 8000000;
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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
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
    this.clearSurface();
    for (const child of [...this.layer.children]) if (child !== this.canvas) child.remove();
    delete this.layer.dataset.pin;
    delete this.layer.dataset.binding;
    this.root.dataset.curlPhase = "idle";
  }
  clearSurface() {
    if (!this.gl || this.gl.isContextLost()) return;
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
  }
  dispose() {
    this.finish();
    this.invalidate();
    this.assets.clear();
    this.assetBytes = 0;
    // Shrink while the context is live: WebKit can ignore framebuffer resizing
    // after synthetic context loss, retaining the full-size drawing buffers.
    this.canvas.width = this.canvas.height = 0;
    if (this.gl && !this.gl.isContextLost()) {
      for (const mesh of [this.mesh, this.plane])
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
