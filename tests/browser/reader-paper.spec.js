import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { enableAll, pageIndex } from "./reader-helpers.js";
import { probePaper } from "./paper-probe.js";
test.use({
  channel: "chrome",
  trace: "off",
  deviceScaleFactor: 2.2,
  launchOptions: { args: ["--use-angle=metal", "--enable-gpu"] },
});
const reference = fs
  .readFileSync("web/prototypes/paper-shape/paper-model.js", "utf8")
  .match(/export const paperVertex = `([\s\S]*?)`;/)[1];
for (const layout of ["single", "double"])
  for (const direction of [1, -1])
    for (const grab of [0.18, 0.82])
      test(`${layout} ${direction > 0 ? "next" : "previous"} grab=${grab}: production material, binding and pin match approved paper`, async ({
        page,
        request,
      }, info) => {
        test.setTimeout(45000);
        await enableAll(request);
        await page.setViewportSize(
          layout === "single"
            ? { width: 796, height: 1135 }
            : { width: 1440, height: 1000 },
        );
        await page.addInitScript((layout) => {
          localStorage.setItem("wr2:page-layout", JSON.stringify(layout));
          localStorage.setItem("wr2:page-motion", JSON.stringify("curl"));
        }, layout);
        const doc = await (
          await request.post("/api/documents", {
            data: {
              title: "Approved paper production acceptance",
              text: Array(50)
                .fill(
                  "The reasoning of these two men did not carry conviction, since knowledge is acquired in relations. ".repeat(
                    8,
                  ),
                )
                .join("\n\n"),
            },
          })
        ).json();
        await page.goto("/#/read/" + doc.id);
        await expect(page.locator(".reader")).toHaveAttribute(
          "data-curl-warm",
          "true",
        );
        if (direction < 0) {
          await page.locator("#reading-edge-next").click();
          await expect(page.locator(".reader")).toHaveAttribute(
            "data-page-index",
            layout === "double" ? "2" : "1",
          );
        }
        const from = await pageIndex(page),
          leaves = await page
            .locator("#article .page-leaf")
            .evaluateAll((es) =>
              es.map((e) => e.getBoundingClientRect().toJSON()),
            ),
          leaf = leaves[direction > 0 ? leaves.length - 1 : 0],
          edge = await page
            .locator("#reading-edge-" + (direction > 0 ? "next" : "prev"))
            .boundingBox();
        if (layout === "double")
          expect(Math.abs(leaves[1].left - leaves[0].right)).toBeLessThan(0.01);
        const start = {
          x: edge.x + edge.width / 2,
          y: leaf.y + leaf.height * grab,
        };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const poses = [];
        for (const vertical of [0, 0.001, 0.15, 0.34, 0.6])
          for (const progress of [0.12, 0.31, 0.55, 0.85, 0.97, 0.995]) {
            await page.mouse.move(
              start.x - direction * 2 * leaf.width * progress,
              start.y + (grab > 0.5 ? -1 : 1) * vertical * leaf.height,
              { steps: 6 },
            );
            await expect(page.locator("#page-curl-layer")).toBeVisible();
            const current = await probePaper(page),
              approved = await probePaper(page, reference);
            const aspect = leaf.height / leaf.width;
            let stretch = 0,
              rootError = 0,
              minZ = 0,
              difference = 0;
            for (let y = 0; y <= 24; y++)
              for (let x = 0; x <= 96; x++) {
                const a = current.rows[y].points[x],
                  b = approved.rows[y].points[x];
                difference = Math.max(
                  difference,
                  ...a.map((v, i) => Math.abs(v - b[i])),
                );
                minZ = Math.min(minZ, a[2]);
                if (x === 0)
                  rootError = Math.max(
                    rootError,
                    Math.abs(a[0]) * leaf.width,
                    Math.abs(a[1] - (y / 24 - 0.5)) * leaf.height,
                    Math.abs(a[2]) * leaf.width,
                  );
                for (const [dx, dy] of [
                  [1, 0],
                  [0, 1],
                ]) {
                  if (x + dx > 96 || y + dy > 24) continue;
                  const c = current.rows[y + dy].points[x + dx];
                  stretch = Math.max(
                    stretch,
                    Math.hypot(
                      c[0] - a[0],
                      (c[1] - a[1]) * aspect,
                      c[2] - a[2],
                    ) / (dx ? 1 / 96 : aspect / 24),
                  );
                }
              }
            const m = {
              vertical,
              progress,
              stretch,
              rootError,
              minZ,
              difference,
              gripError: current.gripError,
              pin: current.pin,
            };
            poses.push(m);
            if (
              (vertical === 0.6 && progress === 0.12) ||
              (vertical === 0.34 && progress === 0.31) ||
              stretch > 1.02 ||
              difference > 0.00002
            ) {
              await info.attach(
                "paper-" + vertical + "-" + progress + ".json",
                {
                  body: JSON.stringify({ metrics: m, current, approved }),
                  contentType: "application/json",
                },
              );
              await info.attach("paper-" + vertical + "-" + progress + ".png", {
                body: await page.screenshot(),
                contentType: "image/png",
              });
            }
            expect(stretch).toBeLessThanOrEqual(1.02);
            expect(rootError).toBeLessThan(1);
            expect(minZ).toBeGreaterThan(-0.00001);
            expect(difference).toBeLessThan(0.00002);
            expect(current.gripError).toBeLessThan(1);
            expect(current.error).toBe(0);
          }
        await info.attach("approved-paper-summary.json", {
          body: JSON.stringify(poses, null, 2),
          contentType: "application/json",
        });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        expect(await pageIndex(page)).toBe(from);
      });

test("missing shader precision safely preserves source and nonanimated navigation", async ({
  page,
  request,
}) => {
  await enableAll(request);
  await page.addInitScript(() => {
    localStorage.setItem("wr2:page-layout", JSON.stringify("single"));
    localStorage.setItem("wr2:page-motion", JSON.stringify("curl"));
    const original = WebGLRenderingContext.prototype.getShaderPrecisionFormat;
    WebGLRenderingContext.prototype.getShaderPrecisionFormat = function (
      shader,
      type,
    ) {
      if (type === this.HIGH_FLOAT)
        return { precision: 0, rangeMin: 0, rangeMax: 0 };
      return original.call(this, shader, type);
    };
  });
  const doc = await (
    await request.post("/api/documents", {
      data: {
        title: "Safe paper fallback",
        text: Array(30)
          .fill("Knowledge is acquired in relations. ".repeat(50))
          .join("\n\n"),
      },
    })
  ).json();
  await page.goto("/#/read/" + doc.id);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-curl-fallback",
    "High-precision paper rendering unavailable",
  );
  await page.locator("#reading-edge-next").click();
  await expect(page.locator(".reader")).toHaveAttribute("data-page-index", "1");
  await expect(page.locator("#page-curl-layer")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#page-curl-layer")).toHaveCSS("pointer-events", "none");
  await expect(page.locator("#article")).toContainText("Knowledge");
  await page.locator("#reading-edge-prev").click();
  await expect(page.locator(".reader")).toHaveAttribute("data-page-index", "0");
});
