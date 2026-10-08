import { test, expect } from "@playwright/test";
test.use({
  channel: "chrome",
  trace: "off",
  viewport: { width: 1000, height: 1000 },
  launchOptions: { args: ["--use-angle=metal", "--enable-gpu"] },
});
const snap = (page) =>
  page.evaluate(() => ({
    page: +document.body.dataset.page,
    phase: document.body.dataset.gesture,
    progress: +document.querySelector(".turn-layer")?.dataset.progress,
    pin: JSON.parse(
      document.querySelector(".turn-layer")?.dataset.pin || "null",
    ),
    lab: JSON.parse(document.body.dataset.nativeSummary || "null"),
  }));
async function phase(page, value, dx = 0, dy = 0, momentum = 0) {
  page.__phaseWs.send(
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
async function ready(page, layout = "single", viewport = null) {
  const session = "e2e-" + Date.now();
  await page.setViewportSize(
    viewport || (layout === "double"
      ? { width: 1440, height: 1000 }
      : { width: 1000, height: 1000 }),
  );
  await page.addInitScript(
    ({ session, layout }) =>
      localStorage.setItem(
        "wise-reader:trackpad-native-prototype:v1:acceptance:" + session,
        JSON.stringify({ layout }),
      ),
    { session, layout },
  );
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:8769\/events/, (ws) => {
    page.__phaseWs = ws;
    ws.send(JSON.stringify({ source: "bridge-ready", monitorReady: true }));
  });
  await page.goto(
    "/static/prototypes/trackpad-native/index.html?test-session=" + session,
  );
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  // Warm the same geometry/renderer before timing the hands.
  await page.locator("#next").click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-page",
    layout === "double" ? "3" : "2",
  );
  await page.locator("#prev").click();
  await expect(page.locator("body")).toHaveAttribute("data-page", "1");
  await page.waitForTimeout(250);
}
test.beforeEach(async ({ page }) => {
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
});
test("extended sample provides sustained reading beyond the former sixth-page boundary", async ({ page }, info) => {
  await ready(page, "single", { width: 1280, height: 720 });
  await expect.poll(async () => +(await page.locator("body").getAttribute("data-pages"))).toBeGreaterThanOrEqual(60);
  for (let target = 2; target <= 13; target++) {
    await page.locator("#next").click();
    await expect(page.locator("body")).toHaveAttribute("data-page", String(target));
    await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
  }
  for (let target = 12; target >= 9; target--) {
    await page.locator("#prev").click();
    await expect(page.locator("body")).toHaveAttribute("data-page", String(target));
    await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
  }
  await info.attach("extended-sample.json", {
    body: JSON.stringify(await page.evaluate(() => ({
      page: document.body.dataset.page,
      pages: document.body.dataset.pages,
      scope: "sample length and mouse page sequence; physical trackpad remains manual acceptance",
    }))),
    contentType: "application/json",
  });
});
test.afterEach(async ({ page }, info) => {
  await info.attach("prototype-events.json", {
    body: JSON.stringify(
      await page.evaluate(() => ({
        summary: document.body.dataset.nativeSummary,
        events: document.body.dataset.nativeEvidence,
        metrics: document.body.dataset.curlMetrics,
        page: document.body.dataset.page,
      })),
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(page.__errors).toEqual([]);
});
test("mouse baseline holds contact, reverses and settles promptly only after pointerup", async ({
  page,
}, info) => {
  await ready(page);
  const b = await page.locator("#next").boundingBox();
  const x = b.x + b.width / 2,
    y = b.y + b.height * 0.55;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 260, y - 40, { steps: 8 });
  await expect.poll(async () => (await snap(page)).pin).not.toBeNull();
  const before = await snap(page);
  await page.waitForTimeout(1000);
  const held = await snap(page);
  expect(held.page).toBe(1);
  expect(Math.abs(held.pin.x - before.pin.x)).toBeLessThan(1);
  await page.mouse.move(x - 140, y - 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
  expect((await snap(page)).page).toBe(1);
  const measurements = await page.evaluate(() =>
    JSON.parse(document.body.dataset.settleMetrics || "[]"),
  );
  expect(measurements.at(-1).actualMs).toBeLessThan(240);
  await info.attach("mouse-held.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
test("phase-fixture trackpad folds in the same CSS pixel geometry as a mouse grip; vertical movement changes the same pin", async ({
  page,
}, info) => {
  await ready(page);
  const b = await page.locator("#next").boundingBox(),
    x = b.x + b.width / 2,
    y = b.y + b.height * 0.55;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 210, y - 30, { steps: 6 });
  await expect.poll(async () => (await snap(page)).pin).not.toBeNull();
  const mouse = await snap(page);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const rail = await page.locator("#gesture-rail").boundingBox();
  await page.mouse.move(rail.x + rail.width * 0.65, y);
  await page.evaluate(() => {
    window.__firstNativePin = null;
    const observer = new MutationObserver(() => {
      const el = document.querySelector(".turn-layer");
      if (el?.dataset.pin && document.body.dataset.nativeState === "tracking") {
        window.__firstNativePin = JSON.parse(el.dataset.pin);
        observer.disconnect();
      }
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-pin"],
    });
  });
  await phase(page, 1, 210, 30);
  await expect
    .poll(() => page.evaluate(() => window.__firstNativePin))
    .not.toBeNull();
  const pin = await page.evaluate(() => window.__firstNativePin);
  expect(Math.abs(pin.x - mouse.pin.x)).toBeLessThan(4);
  expect(Math.abs(pin.y - mouse.pin.y)).toBeLessThan(4);
  await phase(page, 8);
  await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
  await info.attach("pin-comparison.json", {
    body: JSON.stringify({ mouse, pin }),
    contentType: "application/json",
  });
});
test("phase-fixture contact pauses, true-ended signal releases, momentum is ignored -- physical Mac acceptance remains pending", async ({
  page,
}, info) => {
  await ready(page);
  const b = await page.locator("#gesture-rail").boundingBox();
  await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.55);
  await phase(page, 1, 200, 20);
  await expect.poll(async () => (await snap(page)).pin).not.toBeNull();
  const before = await snap(page);
  await phase(page, 2, 0, 0);
  await page.waitForTimeout(1000);
  const held = await snap(page);
  expect(held.page).toBe(before.page);
  expect(held.phase).toBe("dragging");
  expect(Math.abs(held.pin.x - before.pin.x)).toBeLessThan(1);
  await info.attach("phase-fixture-held.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await phase(page, 8);
  await phase(page, 0, 900, 0, 1);
  await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
  const after = await snap(page);
  expect(after.lab.ignoredMomentum).toBeGreaterThan(0);
  await info.attach("phase-fixture-scope.json", {
    body: JSON.stringify({
      scope: "WebSocket phase fixture; NOT physical Mac trackpad",
      before,
      held,
      after,
    }),
    contentType: "application/json",
  });
});

for (const layout of ["single", "double"])
  test(`${layout}: explicit-ended phase lands quickly, queued next hand and alternation keep order, Escape clears a held hand`, async ({
    page,
  }, info) => {
    await ready(page, layout);
    const step = layout === "double" ? 2 : 1;
    const b = await page.locator("#gesture-rail").boundingBox();
    await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.55);
    for (let i = 0; i < 3; i++) {
      await phase(page, 1, 500);
      await phase(page, 8);
      await page.waitForTimeout(45);
    }
    await expect(page.locator("body")).toHaveAttribute(
      "data-page",
      String(1 + 3 * step),
    );
    await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
    const list = [1 + 3 * step];
    for (const direction of [-1, 1, -1, 1]) {
      await phase(page, 1, direction * 500);
      await phase(page, 8);
      await expect(page.locator("body")).toHaveAttribute(
        "data-turning",
        "false",
      );
      list.push(+(await page.locator("body").getAttribute("data-page")));
    }
    expect(list).toEqual([
      1 + 3 * step,
      1 + 2 * step,
      1 + 3 * step,
      1 + 2 * step,
      1 + 3 * step,
    ]);
    await phase(page, 1, -100);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    await expect(page.locator("body")).toHaveAttribute(
      "data-page",
      String(1 + 3 * step),
    );
    await expect(page.locator("body")).toHaveAttribute("data-turning", "false");
    const records = await page.evaluate(() =>
      JSON.parse(document.body.dataset.settleMetrics || "[]"),
    );
    expect(records.slice(2).every((v) => v.actualMs < 240)).toBe(true);
    await info.attach("phase-sequence-and-settle.json", {
      body: JSON.stringify({
        scope: "phase fixture, not physical acceptance",
        list,
        records,
      }),
      contentType: "application/json",
    });
  });
