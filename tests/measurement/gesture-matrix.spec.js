import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { enableAll, read, pageIndex } from "../browser/reader-helpers.js";

const smoke = process.env.WR_MATRIX_SMOKE === "1";
const rates = smoke
  ? [["fast", 3]]
  : [
      ["slow", 0.4],
      ["medium", 1.2],
      ["fast", 3],
    ];
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const backup = "outputs/wise-reader-trackpad-release-20261007/before/";

for (const version of process.env.WR_MATRIX_VERSION === "current"
  ? ["current"]
  : ["current", "previous"])
  for (const layout of ["single", "double"]) {
    test(`${version} ${layout} speed and gesture matrix`, async ({
      page,
      request,
      browser,
    }, info) => {
      test.setTimeout(300000);
      await enableAll(request);
      await page.setViewportSize(
        layout === "single"
          ? { width: 796, height: 1135 }
          : { width: 1440, height: 1000 },
      );
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      if (version === "previous") {
        for (const module of ["pagination.js", "reading-trackpad.js"])
          await page.route(
            new RegExp(
              "/(?:assets/[^/]+|static)/" +
                module.replace(".", "\\.") +
                "(?:\\?.*)?$",
            ),
            (route) =>
              route.fulfill({
                body: fs.readFileSync(backup + module),
                contentType: "text/javascript",
              }),
          );
      }
      await page.addInitScript(
        ({ layout }) => {
          localStorage.setItem("wr2:page-motion", JSON.stringify("curl"));
          localStorage.setItem("wr2:page-layout", JSON.stringify(layout));
          const names = new WeakMap(),
            progress = new WeakMap();
          const proto = WebGLRenderingContext.prototype;
          const get = proto.getUniformLocation,
            uniform = proto.uniform1f,
            draw = proto.drawElements;
          proto.getUniformLocation = function (program, name) {
            const value = get.call(this, program, name);
            if (value) names.set(value, name);
            return value;
          };
          proto.uniform1f = function (location, value) {
            if (names.get(location) === "u_progress") progress.set(this, value);
            return uniform.call(this, location, value);
          };
          proto.drawElements = function (...args) {
            const start = performance.now();
            const value = draw.apply(this, args);
            if (window.__case && args[1] > 6) {
              const root = document.querySelector(".reader");
              window.__case.draws.push({
                time: start,
                progress: progress.get(this),
                phase: root.dataset.curlPhase,
                state: root.dataset.trackpadState,
                session: window.__session,
                index: +root.dataset.pageIndex,
                model: +(root.dataset.trackpadProgress ?? NaN),
                submitCpuMs: performance.now() - start,
              });
            }
            return value;
          };
        },
        { layout },
      );
      const doc = await (
        await request.post("/api/documents", {
          data: {
            title: "Gesture numerical measurement",
            text: Array.from(
              { length: 600 },
              (_, i) =>
                `Section ${i + 1}. ` +
                "A prominent contribution changes our understanding. The reasoning did not carry conviction, since knowledge is acquired through relations. ".repeat(
                  5,
                ),
            ).join("\n\n"),
          },
        })
      ).json();
      await read(page, doc.id);
      await expect(page.locator(".reader")).toHaveAttribute(
        "data-pagination-ready",
        "true",
      );
      const step = layout === "double" ? 2 : 1;
      await page.locator("#reading-edge-next").click();
      await expect(page.locator(".curl-canvas")).toBeVisible();
      const gpu = await page.evaluate(() => {
        const c = document.querySelector(".curl-canvas"),
          gl = c.getContext("webgl");
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          renderer: debug
            ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
          width: c.width,
          height: c.height,
          device: document.querySelector(".reader").dataset.curlDevice,
          dpr: devicePixelRatio,
          userAgent: navigator.userAgent,
        };
      });
      await expect(page.locator(".reader")).toHaveAttribute(
        "data-page-index",
        String(step),
      );
      await page.locator("#reading-edge-prev").click();
      await expect(page.locator(".reader")).toHaveAttribute(
        "data-page-index",
        "0",
      );
      await page.waitForTimeout(750);
      await page.evaluate(() => {
        window.__wheelCalibration = null;
        document.addEventListener(
          "wheel",
          (ev) => {
            window.__wheelCalibration = ev.deltaX;
            ev.preventDefault();
          },
          { once: true, passive: false },
        );
      });
      const strip = await page.locator("#show-tools").boundingBox();
      await page.mouse.move(
        strip.x + strip.width / 2,
        strip.y + strip.height / 2,
      );
      await page.mouse.wheel(20, 0);
      await expect
        .poll(() => page.evaluate(() => window.__wheelCalibration))
        .not.toBeNull();
      const observed = await page.evaluate(() => window.__wheelCalibration);
      const wheelScale = 20 / observed;
      expect(wheelScale).toBeGreaterThanOrEqual(0.5);
      expect(wheelScale).toBeLessThanOrEqual(3);
      const environment = {
        gpu,
        wheelCalibration: { dispatched: 20, observed, scale: wheelScale },
        browser: browser.version(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        viewport: page.viewportSize(),
      };
      fs.writeFileSync(
        info.outputPath("environment.json"),
        JSON.stringify(environment),
      );
      await page.waitForTimeout(350);
      const box = await page.locator("#article").boundingBox();
      await page.mouse.move(box.x + box.width * 0.62, box.y + 230);
      await page.evaluate(() => {
        const root = document.querySelector(".reader"),
          layer = document.querySelector("#page-curl-layer");
        window.__case = null;
        window.__gesture = null;
        window.__session = null;
        let lastIndex = +root.dataset.pageIndex;
        const state = () => ({
          time: performance.now(),
          index: +root.dataset.pageIndex,
          phase: root.dataset.curlPhase,
          state: root.dataset.trackpadState,
          model: +(root.dataset.trackpadProgress ?? NaN),
          pin: JSON.parse(layer.dataset.pin || "null"),
          session: window.__session,
        });
        document.addEventListener(
          "wheel",
          (ev) => {
            if (window.__case)
              window.__case.inputs.push({
                ...state(),
                gesture: window.__gesture?.id,
                x: ev.deltaX,
                y: ev.deltaY,
                eventTime: ev.timeStamp,
              });
          },
          { passive: true, capture: true },
        );
        new MutationObserver((records) => {
          if (!window.__case) return;
          if (
            records.some((r) => r.attributeName === "data-trackpad-progress") &&
            root.dataset.trackpadState === "tracking"
          ) {
            window.__session = window.__gesture?.id;
            window.__case.models.push({
              ...state(),
              gesture: window.__gesture?.id,
            });
          }
          const index = +root.dataset.pageIndex;
          if (index !== lastIndex) {
            window.__case.commits.push({ ...state(), from: lastIndex });
            lastIndex = index;
          }
        }).observe(root, { attributes: true });
        window.__recording = true;
        const frame = () => {
          const at = performance.now();
          if (window.__case) {
            const sample = state();
            sample.probeCpuMs = performance.now() - at;
            window.__case.rafs.push(sample);
          }
          if (window.__recording) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      const rows = [];
      async function pulse(direction, segments, rate, id) {
        const geometry = await page.evaluate(
          ({ direction, id }) => {
            const leaves = [...document.querySelector("#article").children];
            const leaf =
              leaves[
                direction > 0 && leaves.length === 2 ? 1 : 0
              ].getBoundingClientRect();
            const gap =
              leaves.length === 2
                ? leaves[1].getBoundingClientRect().left -
                  leaves[0].getBoundingClientRect().right
                : 0;
            const g = {
              id,
              direction,
              baseX: direction > 0 ? leaf.right : leaf.left,
              turnDistance: leaf.width * 2 + gap,
              travel: Math.max(280, Math.min(600, (leaf.width * 2 + gap) / 2)),
              index: +document.querySelector(".reader").dataset.pageIndex,
            };
            window.__gesture = g;
            return g;
          },
          { direction, id },
        );
        const dispatch = [],
          pending = [];
        const started = performance.now();
        let elapsed = 0;
        for (const amount of segments) {
          const duration = (Math.abs(amount) / rate) * 1000;
          const n = Math.max(2, Math.ceil(duration / 33) + 1);
          const delta = (direction * amount * geometry.travel) / n;
          for (let i = 0; i < n; i++) {
            const planned = elapsed + (duration * i) / (n - 1);
            await sleep(started + planned - performance.now());
            const at = performance.now() - started;
            dispatch.push({ plannedMs: planned, dispatchMs: at, x: delta });
            pending.push(page.mouse.wheel(delta * wheelScale, 0));
          }
          elapsed += duration + 33;
        }
        await Promise.all(pending);
        return { ...geometry, rate, segments, dispatch };
      }
      async function sample(speed, rate, scenario, gap, repetition) {
        await page.waitForTimeout(800);
        const initial = await page.evaluate(() => ({
          index: +document.querySelector(".reader").dataset.pageIndex,
          anchor: document.querySelector(".reader").dataset.sourcePosition,
          metrics: JSON.parse(
            document.querySelector(".reader").dataset.curlMetrics || "[]",
          ),
        }));
        const id = `${version}/${layout}/${speed}/${scenario}/${gap}/${repetition}`;
        await page.evaluate((id) => {
          window.__session = null;
          window.__case = {
            id,
            inputs: [],
            draws: [],
            rafs: [],
            models: [],
            commits: [],
          };
        }, id);
        const directions =
          scenario === "continuous"
            ? [1, 1, 1]
            : scenario === "alternating"
              ? [1, -1, 1, -1]
              : [1];
        const gestures = [];
        for (let g = 0; g < directions.length; g++) {
          if (g) await page.waitForTimeout(gap);
          gestures.push(
            await pulse(
              directions[g],
              scenario === "cancel" ? [0.8, -0.1] : [0.7],
              rate,
              g,
            ),
          );
        }
        await page.waitForTimeout(1100);
        const actual = await page.evaluate(() => {
          const value = window.__case;
          window.__case = null;
          return {
            ...value,
            finalIndex: +document.querySelector(".reader").dataset.pageIndex,
            finalAnchor:
              document.querySelector(".reader").dataset.sourcePosition,
            metrics: JSON.parse(
              document.querySelector(".reader").dataset.curlMetrics || "[]",
            ),
          };
        });
        let wanted = initial.index;
        const expectedCommits =
          scenario === "cancel"
            ? []
            : directions.map((d) => (wanted += d * step));
        const row = {
          id,
          version,
          layout,
          speed,
          rate,
          scenario,
          gap,
          repetition,
          step,
          initial,
          gestures,
          expectedCommits,
          ...actual,
        };
        rows.push(row);
        fs.writeFileSync(
          info.outputPath(id.replaceAll("/", "-") + ".json"),
          JSON.stringify(row),
        );
        console.log(
          `${id}: wheel=${row.inputs.length} model=${row.models.length} commit=${JSON.stringify(row.commits.map((c) => c.index))}/${JSON.stringify(expectedCommits)}`,
        );
        await info.attach(id.replaceAll("/", "-") + ".json", {
          body: JSON.stringify(row),
          contentType: "application/json",
        });
      }
      for (const [speed, rate] of rates)
        for (const scenario of [
          "complete",
          "cancel",
          "continuous",
          "alternating",
        ])
          for (let repetition = 0; repetition < (smoke ? 1 : 2); repetition++)
            await sample(speed, rate, scenario, 600, repetition);
      for (const gap of smoke ? [280] : [280, 400])
        for (const scenario of ["continuous", "alternating"])
          await sample("fast", 3, scenario, gap, 0);
      await page.evaluate(() => {
        window.__recording = false;
      });
      const witness = {
        version,
        layout,
        smoke,
        environment,
        rows,
        errors,
      };
      await info.attach("matrix-witness.json", {
        body: JSON.stringify(witness),
        contentType: "application/json",
      });
      await info.attach("matrix-end.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      expect(errors).toEqual([]);
      expect(
        gpu.device,
        "Requires a hardware GPU; do not promote SwiftShader to Mac device evidence",
      ).toBe("gpu");
      const failed = rows.filter(
        (r) =>
          JSON.stringify(r.commits.map((c) => c.index)) !==
          JSON.stringify(r.expectedCommits),
      );
      expect(
        failed.map((r) => ({
          id: r.id,
          expected: r.expectedCommits,
          actual: r.commits.map((c) => c.index),
        })),
        "Mismatch is a measured feature failure, not successful measurement acceptance",
      ).toEqual([]);
    });
  }
