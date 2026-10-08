import { test, expect } from "@playwright/test";
import { tools, focus, read, enableAll, pageIndex } from "./reader-helpers.js";
test.beforeEach(async ({ request, page }) => {
  await enableAll(request);
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
});
test.afterEach(async ({ page }) => expect(page.__errors).toEqual([]));
async function book(request) {
  return await (
    await request.post("/api/documents", {
      data: {
        title: "Paper physics acceptance",
        text: Array.from(
          { length: 50 },
          (_, i) =>
            `Section ${i + 1}. ` +
            Array(5)
              .fill(
                "The reasoning of these two men did not carry conviction, since knowledge is acquired in relations.",
              )
              .join(" "),
        ).join("\n\n"),
      },
    })
  ).json();
}
async function dragging(page, side, dx, dy, info) {
  const box = await page.locator("#reading-edge-" + side).boundingBox(),
    index = await pageIndex(page);
  const start = { x: box.x + box.width / 2, y: box.y + box.height * 0.55 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 18 });
  await expect(page.locator("#page-curl-layer")).toHaveAttribute(
    "data-renderer",
    "webgl-developable-paper",
  );
  await expect(page.locator("#page-curl-layer")).toBeVisible();
  await expect
    .poll(
      async () =>
        await page.locator("#page-curl-layer").getAttribute("data-pin"),
    )
    .not.toBeNull();
  const pin = JSON.parse(
    await page.locator("#page-curl-layer").getAttribute("data-pin"),
  );
  expect(await pageIndex(page)).toBe(index);
  expect(Math.sign(pin.y - start.y)).toBe(Math.sign(dy));
  if (info)
    await info.attach("paper-light-mid-drag.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  const gpu = await page.evaluate(() => {
    const c = document.querySelector(".curl-canvas");
    const gl = c.getContext("webgl");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      width: c.width,
      height: c.height,
      renderer: ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
    };
  });
  await page.mouse.up();
  await expect(page.locator(".reader")).not.toHaveAttribute(
    "data-page-turning",
    "true",
  );
  return { pin, gpu, from: index, to: await pageIndex(page) };
}
test.use({ trace: "off" });
test("12 continuous paper turns keep a bounded GPU cache and record frame timing separately from screenshots", async ({
  request,
  page,
}, info) => {
  const d = await book(request);
  await read(page, d.id);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-curl-warm",
    "true",
  );
  const witnesses = [];
  for (let i = 0; i < 12; i++)
    witnesses.push(
      await dragging(
        page,
        i % 2 ? "prev" : "next",
        i % 2 ? 450 : -450,
        i % 2 ? -80 : 80,
      ),
    );
  const gpu = witnesses[0].gpu;
  const metrics = JSON.parse(
    await page.locator(".reader").getAttribute("data-curl-metrics"),
  );
  await info.attach("paper-frame-metrics.json", {
    body: JSON.stringify({ gpu, metrics }, null, 2),
    contentType: "application/json",
  });
  expect(metrics).toHaveLength(12);
  expect(metrics.every((m) => m.completed)).toBe(true);
  expect(Math.max(...metrics.map((m) => m.p95FrameMs))).toBeLessThan(34);
  expect(
    +(await page.locator(".reader").getAttribute("data-curl-cached-leaves")),
  ).toBeLessThanOrEqual(6);
  await info.attach("paper-frame-metrics.json", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
});
