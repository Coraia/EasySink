import { test, expect } from "@playwright/test";
import { probePaper } from "./paper-probe.js";
test.use({
  channel: "chrome",
  trace: "off",
  deviceScaleFactor: 2.2,
  viewport: { width: 796, height: 1135 },
  launchOptions: { args: ["--use-angle=metal", "--enable-gpu"] },
});
const session = "paper-shape-e2e";
test.beforeEach(async ({ page }) => {
  page.__logs = [];
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) page.__logs.push(m.text());
  });
  page.on("pageerror", (e) => page.__logs.push(e.message));
});
test.afterEach(async ({ page }, info) => {
  await info.attach("browser-state.json", {
    body: JSON.stringify({
      logs: page.__logs,
      data: await page.evaluate(() => ({ ...document.body.dataset })),
    }),
    contentType: "application/json",
  });
});
async function ready(page, layout = "single") {
  await page.addInitScript(
    ({ session, layout }) =>
      localStorage.setItem(
        "wise-reader:paper-shape-prototype:v1:acceptance:" + session,
        JSON.stringify({ layout }),
      ),
    { session, layout },
  );
  await page.route("**/api/reading/native-trackpad", (r) =>
    r.fulfill({
      json: {
        available: true,
        url: "ws://127.0.0.1:8769/events?token=fixture",
      },
    }),
  );
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:8769\/events/, (ws) => {
    page.__native = ws;
    ws.send(JSON.stringify({ source: "bridge-ready", monitorReady: true }));
  });
  await page.goto(
    "/static/prototypes/paper-shape/index.html?test-session=" + session,
  );
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(document.body.dataset.nativeSummary || "{}").monitorReady,
      ),
    )
    .toBe(true);
  await page.waitForTimeout(350);
}
function lengths(d) {
  const aspect = d.uniforms.u_leaf[3] / d.uniforms.u_leaf[2];
  let maximum = 0,
    rootError = 0,
    minZ = 0,
    where;
  for (let y = 0; y <= 24; y++)
    for (let x = 0; x <= 96; x++) {
      const a = d.rows[y].points[x];
      minZ = Math.min(minZ, a[2]);
      if (x === 0)
        rootError = Math.max(
          rootError,
          Math.abs(a[0]) * d.uniforms.u_leaf[2],
          Math.abs(a[1] - (y / 24 - 0.5)) * d.uniforms.u_leaf[3],
          Math.abs(a[2]) * d.uniforms.u_leaf[2],
        );
      for (const [dx, dy, axis] of [
        [1, 0, "x"],
        [0, 1, "y"],
      ]) {
        if (x + dx > 96 || y + dy > 24) continue;
        const b = d.rows[y + dy].points[x + dx],
          ratio =
            Math.hypot(b[0] - a[0], (b[1] - a[1]) * aspect, b[2] - a[2]) /
            (dx ? 1 / 96 : aspect / 24);
        if (ratio > maximum) {
          maximum = ratio;
          where = { x, y, axis };
        }
      }
    }
  return { maximum, rootError, minZ, where, gripError: d.gripError };
}
test("same portrait distortion gestures now preserve material lengths and the entire bound edge", async ({
  page,
}, info) => {
  await ready(page);
  const leaf = await page.locator("#left").boundingBox(),
    edge = await page.locator("#next").boundingBox();
  const start = { x: edge.x + edge.width / 2, y: leaf.y + leaf.height * 0.55 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const rows = [];
  for (const pose of [
    { p: 0.31, dy: -0.34 },
    { p: 0.12, dy: -0.6 },
    { p: 0.55, dy: 0.34 },
    { p: 0.85, dy: 0.6 },
    { p: 0.97, dy: -0.6 },
    { p: 0.31, dy: 0 },
  ]) {
    await page.mouse.move(
      start.x - 2 * leaf.width * pose.p,
      start.y + leaf.height * pose.dy,
      { steps: 10 },
    );
    await expect(page.locator(".turn-layer canvas")).toBeVisible();
    const d = await probePaper(page, null, {
        article: "#spread",
        layer: ".turn-layer",
      }),
      m = lengths(d);
    rows.push({ pose, ...m, pin: d.pin });
    await info.attach("paper-" + pose.p + "-" + pose.dy + ".json", {
      body: JSON.stringify({ pose, metrics: m, data: d }),
      contentType: "application/json",
    });
    await info.attach("paper-" + pose.p + "-" + pose.dy + ".png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(m.maximum).toBeLessThanOrEqual(1.02);
    expect(m.rootError).toBeLessThan(1);
    expect(m.minZ).toBeGreaterThan(-0.00001);
    expect(m.gripError).toBeLessThan(1);
    expect(d.error).toBe(0);
  }
  await info.attach("paper-summary.json", {
    body: JSON.stringify(rows, null, 2),
    contentType: "application/json",
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("body")).toHaveAttribute("data-page", "1");
});

for (const layout of ["single", "double"])
  for (const side of [1, -1])
    for (const grab of [0.18, 0.82])
      test(`${layout} ${side > 0 ? "next" : "previous"} grab ${grab}: material and binding across horizontal, small and extreme diagonal folds`, async ({
        page,
      }, info) => {
        test.setTimeout(45000);
        if (layout === "double")
          await page.setViewportSize({ width: 1440, height: 1000 });
        await ready(page, layout);
        if (side < 0) {
          await page.locator("#next").click();
          await expect(page.locator("body")).toHaveAttribute(
            "data-page",
            layout === "double" ? "3" : "2",
          );
        }
        const before = await page.locator("body").getAttribute("data-page"),
          leaf = await page
            .locator(side > 0 && layout === "double" ? "#right" : "#left")
            .boundingBox(),
          edge = await page.locator(side > 0 ? "#next" : "#prev").boundingBox();
        const start = {
          x: edge.x + edge.width / 2,
          y: leaf.y + grab * leaf.height,
        };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const measurements = [];
        for (const dy of [0, 0.001, 0.15, 0.34, 0.6])
          for (const p of [0.12, 0.31, 0.55, 0.85, 0.97]) {
            await page.mouse.move(
              start.x - side * 2 * leaf.width * p,
              start.y + (grab > 0.5 ? -1 : 1) * dy * leaf.height,
              { steps: 5 },
            );
            await expect(page.locator(".turn-layer canvas")).toBeVisible();
            const data = await probePaper(page, null, {
                article: "#spread",
                layer: ".turn-layer",
              }),
              m = lengths(data);
            measurements.push({ p, dy, ...m, pin: data.pin });
            if (m.maximum > 1.02 || m.gripError > 1) {
              await info.attach("failed-pose.json", {
                body: JSON.stringify({ data, m, p, dy }),
                contentType: "application/json",
              });
              await info.attach("failed-pose.png", {
                body: await page.screenshot(),
                contentType: "image/png",
              });
            }
            expect(m.maximum).toBeLessThanOrEqual(1.02);
            expect(m.rootError).toBeLessThan(1);
            expect(m.minZ).toBeGreaterThan(-0.00001);
            expect(m.gripError).toBeLessThan(1);
          }
        await info.attach("material-matrix.json", {
          body: JSON.stringify(measurements, null, 2),
          contentType: "application/json",
        });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await expect(page.locator("body")).toHaveAttribute("data-page", before);
      });
async function phase(page, value, dx = 0, dy = 0, momentum = 0) {
  page.__native.send(
    JSON.stringify({
      source: "e2e-phase-fixture",
      phase: value,
      dx,
      dy,
      momentum,
    }),
  );
  await page.waitForTimeout(20);
}
for (const layout of ["single", "double"])
  test(`${layout}: native contact holds, reversal cancels, queued and alternating turns stay ordered`, async ({
    page,
  }, info) => {
    if (layout === "double")
      await page.setViewportSize({ width: 1440, height: 1000 });
    await ready(page, layout);
    const leaf = await page
      .locator(layout === "double" ? "#right" : "#left")
      .boundingBox();
    await page.mouse.move(
      leaf.x + leaf.width * 0.7,
      leaf.y + leaf.height * 0.55,
    );
    await phase(page, 1, leaf.width * 0.5, 40);
    await expect(page.locator(".turn-layer")).toBeVisible();
    const pin = await page.locator(".turn-layer").getAttribute("data-pin");
    await phase(page, 2);
    await page.waitForTimeout(1000);
    expect(await page.locator(".turn-layer").getAttribute("data-pin")).toBe(
      pin,
    );
    await expect(page.locator("body")).toHaveAttribute("data-page", "1");
    await phase(page, 4, -leaf.width * 0.3, -20);
    await phase(page, 8);
    await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
    await expect(page.locator("body")).toHaveAttribute("data-page", "1");
    const step = layout === "double" ? 2 : 1;
    for (let i = 0; i < 3; i++) {
      await phase(page, 1, leaf.width * 1.2);
      await phase(page, 8);
      await page.waitForTimeout(45);
    }
    await expect(page.locator("body")).toHaveAttribute(
      "data-page",
      String(1 + 3 * step),
    );
    await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
    for (const [direction, n] of [
      [-1, 2],
      [1, 3],
      [-1, 2],
      [1, 3],
    ]) {
      await phase(page, 1, direction * leaf.width * 1.2);
      await phase(page, 8);
      await expect(page.locator("body")).toHaveAttribute(
        "data-page",
        String(1 + n * step),
      );
      await expect(page.locator("body")).toHaveAttribute(
        "data-turning",
        "false",
      );
    }
    await phase(page, 0, 900, 0, 1);
    await phase(page, 0, 0, 0, 8);
    await expect(page.locator("body")).toHaveAttribute(
      "data-page",
      String(1 + 3 * step),
    );
    await info.attach("native-scope.json", {
      body: JSON.stringify({
        scope: "native phase fixture; physical handfeel awaits user",
        state: await page.evaluate(() => ({ ...document.body.dataset })),
      }),
      contentType: "application/json",
    });
  });
test("mouse and native phases feed the same physical pin and diagonal direction", async ({
  page,
}) => {
  await ready(page);
  const leaf = await page.locator("#left").boundingBox(),
    edge = await page.locator("#next").boundingBox();
  const y = leaf.y + leaf.height * 0.55;
  await page.mouse.move(edge.x + edge.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(
    edge.x + edge.width / 2 - leaf.width * 0.62,
    y + leaf.height * 0.08,
    { steps: 10 },
  );
  await expect(page.locator(".turn-layer")).toBeVisible();
  const mouse = JSON.parse(
    await page.locator(".turn-layer").getAttribute("data-pin"),
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.mouse.move(leaf.x + leaf.width * 0.7, y);
  await phase(page, 1, leaf.width * 0.62, -leaf.height * 0.08);
  await expect(page.locator(".turn-layer")).toBeVisible();
  const native = JSON.parse(
    await page.locator(".turn-layer").getAttribute("data-pin"),
  );
  expect(Math.abs(native.x - mouse.x)).toBeLessThan(1);
  expect(Math.abs(native.y - mouse.y)).toBeLessThan(1);
  expect(native.y).toBeGreaterThan(y);
  await phase(page, 16);
  await expect(page.locator("body")).toHaveAttribute("data-page", "1");
});
test("Retina sustained diagonal frames and settles stay bounded with native textures", async ({
  page,
}, info) => {
  await ready(page);
  const leaf = await page.locator("#left").boundingBox();
  await page.mouse.move(leaf.x + leaf.width * 0.7, leaf.y + leaf.height * 0.55);
  // Warmup is explicit and saved; the following test measures sustained input.
  await phase(page, 1, leaf.width * 0.6, -20);
  await phase(page, 16);
  await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
  for (let i = 0; i < 10; i++) {
    const sign = i % 2 ? -1 : 1;
    for (let j = 0; j < 24; j++) {
      page.__native.send(
        JSON.stringify({
          source: "e2e-phase-fixture",
          phase: j === 0 ? 1 : 4,
          dx: (sign * leaf.width * 1.1) / 24,
          dy: (-leaf.height * 0.12) / 24,
        }),
      );
      await page.waitForTimeout(8);
    }
    await phase(page, 8);
    await expect(page.locator("body")).toHaveAttribute(
      "data-page",
      i % 2 ? "1" : "2",
    );
    await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
  }
  const data = await page.evaluate(() => ({
    metrics: JSON.parse(document.body.dataset.curlMetrics),
    settles: JSON.parse(document.body.dataset.settleMetrics),
    resolution: JSON.parse(document.body.dataset.paintResolution),
    pixels: +document.body.dataset.cachedTexturePixels,
    contexts: +document.body.dataset.gpuContexts,
  }));
  await info.attach("retina-performance.json", {
    body: JSON.stringify(data, null, 2),
    contentType: "application/json",
  });
  const metrics = data.metrics.slice(-10);
  expect(Math.max(...metrics.map((m) => m.p95FrameMs))).toBeLessThan(34);
  expect(Math.max(...metrics.map((m) => m.p95InputMs))).toBeLessThan(34);
  expect(Math.max(...metrics.map((m) => m.p95SolveMs))).toBeLessThan(8);
  expect(
    Math.max(...data.settles.slice(-10).map((s) => s.actualMs)),
  ).toBeLessThan(240);
  expect(data.resolution.canvasRatio).toBeCloseTo(2.2, 2);
  expect(data.resolution.textureRatio).toBeCloseTo(2.2, 2);
  expect(data.pixels).toBeLessThanOrEqual(24e6);
  expect(data.contexts).toBe(1);
});
test("visual preset can be inspected and dismissed without changing the reading position", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#show-tools").click();
  await page.locator("#help").click();
  await page.locator("#example-extreme").click();
  await expect(page.locator(".turn-layer canvas")).toBeVisible();
  await expect(page.locator("#example-close")).toBeVisible();
  await page.locator("#example-close").click();
  await expect(page.locator(".turn-layer")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-page", "1");
});
