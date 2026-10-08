import { $ } from "./core.js";

import {
  foldVertex,
  foldFragment,
  foldForPointer,
  paperMesh,
} from "./page-fold.js?v=20261008-paper";

// Software-only animation budget; hardware keeps native Retina resolution.
const SOFTWARE_PIXELS = 320000;

// One GPU service for one reader lifetime. Turns reuse programs, buffers and
// cached textures; each frame uploads a small mesh aligned with the curl.
export class PageCurlRenderer {
  constructor(pages) {
    this.pages = pages;
    this.cache = new Map();
    this.jobs = new Map();
    this.epoch = 0;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "curl-canvas";
    this.layer = $("#page-curl-layer");
    this.root = $(".reader");
    this.failed = false;
    this.root.dataset.curlContexts = "0";
    this.rules = null;
    this.raf = 0;
    this.warmTimer = 0;
    pages.r.scope.cleanup(() => this.dispose());
  }
  init() {
    if (this.gl || this.failed) return;
    try {
      const gl = (this.gl = this.canvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
      }));
      if (!gl) throw new Error("WebGL unavailable");
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
  }
  invalidate() {
    this.epoch++;
    clearTimeout(this.warmTimer);
    this.jobs.clear();
    if (this.gl && !this.gl.isContextLost())
      for (const value of this.cache.values())
        this.gl.deleteTexture(value.texture);
    this.cache.clear();
  }
  key(index) {
    return `${this.pages.generation}:${this.epoch}:${devicePixelRatio || 1}:${index}`;
  }
  async prepare(index) {
    const key = this.key(index),
      hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    if (this.jobs.has(key)) return this.jobs.get(key);
    if (!this.pages.pages[index]) return null;
    const epoch = this.epoch,
      generation = this.pages.generation;
    const job = (async () => {
      this.init();
      if (this.failed) return null;
      const leaf = $(".page-leaf"),
        rect = leaf?.getBoundingClientRect();
      if (!rect?.width) return null;
      const css = getComputedStyle(leaf),
        root = getComputedStyle(document.documentElement);
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
      copy.innerHTML = this.pages.leafMarkup(index);
      const page = copy.firstElementChild;
      page
        .querySelectorAll(".inline-grammar,.bookmark-marker,.paragraph-actions")
        .forEach((el) => el.remove());
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
      const ratio = Math.min(
        devicePixelRatio || 1,
        // Software decoding/upload matches its bounded animated canvas.
        // Oversized textures cannot recover resolution lost in that canvas.
        this.software
          ? Math.sqrt(
              SOFTWARE_PIXELS /
                (document.getElementById("article").getBoundingClientRect()
                  .width *
                  rect.height),
            )
          : 3,
        this.maxTexture / rect.height,
        this.maxTexture / rect.width,
        Math.sqrt(6e6 / (rect.width * rect.height)),
      );
      const w = Math.ceil(rect.width * ratio),
        h = Math.ceil(rect.height * ratio);
      const markup = `<div xmlns="http://www.w3.org/1999/xhtml" class="paged-reader" style="${xml(vars)}width:${rect.width}px;height:${rect.height}px;color:${root.getPropertyValue("--ink")};background:${root.getPropertyValue("--paper")}"><style>${xml(this.rules)}</style><div id="article" style="width:100%;height:100%;display:block">${new XMLSerializer().serializeToString(page)}</div></div>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${rect.width} ${rect.height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Page raster failed"));
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      });
      if (
        epoch !== this.epoch ||
        generation !== this.pages.generation ||
        this.pages.r.scope.signal.aborted ||
        this.failed
      )
        return null;
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
        width: rect.width,
        height: rect.height,
        pixels: w * h,
        pixelWidth: w,
        pixelHeight: h,
        ratio,
        key,
      };
      this.cache.set(key, value);
      // Six leaves and at most 24 million pixels (~96MB RGBA), regardless of book.
      while (
        this.cache.size > 6 ||
        [...this.cache.values()].reduce((n, v) => n + v.pixels, 0) > 24e6
      ) {
        const pinned = this.scene?.textures || [];
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
      return value;
    })()
      .catch((error) => {
        this.root.dataset.curlFallback = error.message;
        return null;
      })
      .finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }
  warm() {
    clearTimeout(this.warmTimer);
    const generation = this.pages.generation,
      epoch = this.epoch;
    this.warmTimer = setTimeout(async () => {
      const p = this.pages,
        indices = [
          p.index,
          p.index + p.count - 1,
          p.index + p.count,
          p.index - 1,
        ];
      for (const i of new Set(indices)) {
        if (
          generation !== p.generation ||
          epoch !== this.epoch ||
          p.r.scope.signal.aborted ||
          p.animating
        )
          return;
        await this.prepare(i);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      this.root.dataset.curlWarm = "true";
    }, 120);
  }
  attach(before, incoming, direction, front, back, grab) {
    if (this.failed || !front || !back) return false;
    const gl = this.gl,
      rect = $("#article").getBoundingClientRect(),
      stage = $("#reading-stage").getBoundingClientRect();
    const leaves = [...before.children].map((el) => ({
      x: +el.dataset.leafX,
      y: 0,
      width: front.width,
      height: front.height,
    }));
    const double = leaves.length === 2,
      leaf = leaves[direction > 0 && double ? 1 : 0],
      gap = double ? leaves[1].x - leaves[0].x - front.width : 0;
    Object.assign(this.layer.style, {
      left: rect.left - stage.left + "px",
      top: rect.top - stage.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
    this.layer.hidden = false;
    this.layer.inert = true;
    this.layer.replaceChildren();
    incoming.classList.add("curl-underlay");
    this.layer.append(incoming);
    if (double) {
      before.classList.add("curl-stationary");
      before.style.clipPath =
        direction > 0
          ? `inset(0 ${rect.width - leaves[0].x - leaf.width}px 0 0)`
          : `inset(0 0 0 ${leaves[1].x}px)`;
      this.layer.append(before);
    }
    this.layer.append(this.canvas);
    // Software rasterizers pay per shaded pixel. Keep the animated sheet
    // bounded; the live source DOM and its static text retain full resolution.
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
    this.root.dataset.curlDrawRatio = ratio.toFixed(3);
    this.root.dataset.curlTextureRatio = Math.min(
      front.ratio,
      back.ratio,
    ).toFixed(3);
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
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
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
    this.scene = {
      rect,
      leaf,
      direction,
      gap,
      grab,
      textures: [front.key, back.key],
    };
    this.samples = [];
    this.inputSamples = [];
    this.solveSamples = [];
    this.lastInputPose = null;
    this.lastFrame = 0;
    this.started = performance.now();
    this.firstFrame = null;
    this.root.dataset.curlPhase = "dragging";
    this.layer.dataset.renderer = "webgl-developable-paper";
    return true;
  }
  draw(progress, grab, dy, inputAt) {
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
      // Keep the last actual hand pose, not the automatic flat landing frame.
      // Bounded numeric evidence makes a reported distortion reproducible.
      this.lastInputPose = {
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
  }
  record(completed, reason, requested, settle) {
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
    this.metrics ??= [];
    this.metrics.push(metric);
    this.metrics = this.metrics.slice(-30);
    this.root.dataset.curlMetrics = JSON.stringify(this.metrics);
  }
  finish() {
    cancelAnimationFrame(this.raf);
    this.scene = null;
    this.layer.hidden = true;
    this.layer.replaceChildren();
    delete this.layer.dataset.pin;
    delete this.layer.dataset.binding;
    this.root.dataset.curlPhase = "idle";
  }
  dispose() {
    this.finish();
    this.invalidate();
    if (this.gl && !this.gl.isContextLost()) {
      for (const mesh of [this.mesh, this.plane])
        if (mesh) {
          this.gl.deleteBuffer(mesh.buffer);
          this.gl.deleteBuffer(mesh.index);
        }
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.spineMesh) {
        this.gl.deleteBuffer(this.spineMesh.index);
        this.gl.deleteBuffer(this.spineMesh.buffer);
      }
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.canvas.remove();
  }
}
