import { test, expect } from "@playwright/test";
import { enableAll } from "./reader-helpers.js";

test.use({
  channel: "chrome",
  trace: "off",
  deviceScaleFactor: 2.2,
  launchOptions: { args: ["--use-angle=metal", "--enable-gpu"] },
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
