import { test, expect } from "@playwright/test";
import { enableAll, read } from "./reader-helpers.js";

test.use({
  channel: "chrome",
  trace: "off",
  deviceScaleFactor: 2,
  launchOptions: { args: ["--use-angle=metal", "--enable-gpu"] },
});

const body =
  "A prominent contribution changes our understanding. " +
  "The reasoning of these two men did not carry conviction, since knowledge is acquired in relations. ".repeat(
    8,
  );

async function createBook(request, title) {
  const response = await request.post("/api/documents", {
    data: { title, text: Array(60).fill(body).join("\n\n") },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("the visible book spread matches the client at a wide desktop size", async ({
  page,
  request,
}, info) => {
  await enableAll(request);
  await page.setViewportSize({ width: 1986, height: 931 });
  await page.addInitScript(() => {
    localStorage.setItem("wr2:page-layout", JSON.stringify("double"));
    localStorage.setItem("wr2:page-motion", JSON.stringify("off"));
  });
  const doc = await createBook(request, "Window-sized reading acceptance");
  await read(page, doc.id);

  const geometry = await page.evaluate(() => {
    const box = (selector) =>
      document.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      client: { width: innerWidth, height: innerHeight },
      stage: box("#reading-stage"),
      spread: box("#article"),
      leaves: [...document.querySelectorAll("#article .page-leaf")].map((node) =>
        node.getBoundingClientRect().toJSON(),
      ),
    };
  });
  await info.attach("window-fit-geometry.json", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });
  await info.attach("window-fit.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  expect(geometry.leaves).toHaveLength(2);
  expect(geometry.stage.x).toBeLessThanOrEqual(1);
  expect(geometry.stage.y).toBeLessThanOrEqual(1);
  expect(geometry.stage.right).toBeGreaterThanOrEqual(geometry.client.width - 1);
  expect(geometry.stage.bottom).toBeGreaterThanOrEqual(geometry.client.height - 1);
  expect(geometry.spread.x).toBeLessThanOrEqual(1);
  expect(geometry.spread.y).toBeLessThanOrEqual(1);
  expect(geometry.spread.right).toBeGreaterThanOrEqual(geometry.client.width - 1);
  expect(geometry.spread.bottom).toBeGreaterThanOrEqual(geometry.client.height - 1);
});

test.describe("continuous native page turns", () => {
  test("three immediate swipes land without a pause between gestures", async ({
    page,
    request,
  }, info) => {
    await enableAll(request);
    await page.addInitScript(() => {
      localStorage.setItem("wr2:page-layout", JSON.stringify("single"));
      localStorage.setItem("wr2:page-motion", JSON.stringify("curl"));
    });
    await page.route("**/api/reading/native-trackpad", (route) =>
      route.fulfill({
        json: {
          available: true,
          platform: "darwin",
          url: "ws://127.0.0.1:8769/events?token=fixture",
        },
      }),
    );
    await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:8769\/events/, (ws) => {
      page.__native = ws;
      ws.send(JSON.stringify({ source: "bridge-ready", monitorReady: true }));
    });
    const doc = await createBook(request, "Continuous page-turn acceptance");
    await read(page, doc.id);
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-trackpad-mode",
      "native",
    );
    await expect(page.locator(".reader")).toHaveAttribute("data-curl-warm", "true");
    const paper = await page.locator("#article").boundingBox();
    await page.mouse.move(paper.x + paper.width * 0.7, paper.y + paper.height * 0.55);

    const started = Date.now();
    for (let i = 0; i < 3; i++) {
      page.__native.send(
        JSON.stringify({
          source: "e2e-phase-fixture",
          phase: 1,
          dx: 700,
          dy: 0,
          momentum: 0,
        }),
      );
      page.__native.send(
        JSON.stringify({
          source: "e2e-phase-fixture",
          phase: 8,
          dx: 0,
          dy: 0,
          momentum: 0,
        }),
      );
    }
    await expect(page.locator(".reader")).toHaveAttribute("data-page-index", "3");
    await expect(page.locator(".reader")).not.toHaveAttribute(
      "data-page-turning",
      "true",
    );
    const evidence = await page.evaluate((startedAt) => ({
      wallMs: Date.now() - startedAt,
      gestures: JSON.parse(
        document.querySelector(".reader").dataset.nativeGestures || "[]",
      ),
      metrics: JSON.parse(
        document.querySelector(".reader").dataset.curlMetrics || "[]",
      ).slice(-3),
    }), started);
    await info.attach("continuous-turns.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    const releases = evidence.gestures.filter((entry) => entry.kind === "release");
    const landings = evidence.gestures.filter((entry) => entry.kind === "landed");
    expect(releases).toHaveLength(3);
    expect(landings).toHaveLength(3);
    expect(landings.at(-1).at - releases[0].at).toBeLessThan(350);
  });
});

test("holding a direction key enters continuous paging without waiting for the tap animation", async ({
  page,
  request,
}, info) => {
  await enableAll(request);
  await page.addInitScript(() => {
    localStorage.setItem("wr2:page-layout", JSON.stringify("single"));
    localStorage.setItem("wr2:page-motion", JSON.stringify("curl"));
  });
  const doc = await createBook(request, "Held keyboard page-turn acceptance");
  await read(page, doc.id);
  await expect(page.locator(".reader")).toHaveAttribute("data-curl-warm", "true");

  const started = await page.evaluate(() => performance.now());
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(420);
  await page.keyboard.up("ArrowRight");
  const released = await page.evaluate(() => performance.now());
  const pageAtRelease = +(await page.locator(".reader").getAttribute("data-page-index"));
  await expect(page.locator(".reader")).not.toHaveAttribute("data-page-turning", "true");
  const finalPage = +(await page.locator(".reader").getAttribute("data-page-index"));
  await page.waitForTimeout(120);
  const pageAfterRelease = +(await page.locator(".reader").getAttribute("data-page-index"));
  const metrics = await page.evaluate(() =>
    JSON.parse(document.querySelector(".reader").dataset.curlMetrics || "[]")
      .filter((metric) => metric.reason === "keyboard-held"),
  );
  await info.attach("held-keyboard-turns.json", {
    body: JSON.stringify({ heldMs: released - started, pageAtRelease, finalPage, pageAfterRelease, metrics }, null, 2),
    contentType: "application/json",
  });
  expect(pageAtRelease).toBeGreaterThanOrEqual(2);
  expect(finalPage).toBeLessThanOrEqual(pageAtRelease + 1);
  expect(pageAfterRelease).toBe(finalPage);
  expect(metrics.length).toBeGreaterThanOrEqual(2);
  expect(metrics.every((metric) =>
    metric.release.requestedDurationMs >= 44 &&
    metric.release.requestedDurationMs <= 46,
  )).toBeTruthy();
  expect(Math.max(...metrics.map((metric) => metric.release.actualDurationMs))).toBeLessThan(95);
});

test("three rapid direction-key taps each advance a page without waiting for the prior curl", async ({
  page,
  request,
}, info) => {
  await enableAll(request);
  await page.addInitScript(() => {
    localStorage.setItem("wr2:page-layout", JSON.stringify("single"));
    localStorage.setItem("wr2:page-motion", JSON.stringify("curl"));
  });
  const doc = await createBook(request, "Rapid keyboard tap acceptance");
  await read(page, doc.id);
  await expect(page.locator(".reader")).toHaveAttribute("data-curl-warm", "true");

  const started = await page.evaluate(() => performance.now());
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(45);
  }
  await expect(page.locator(".reader")).toHaveAttribute("data-page-index", "3");
  await expect(page.locator(".reader")).not.toHaveAttribute(
    "data-page-turning",
    "true",
  );
  const evidence = await page.evaluate((startedAt) => ({
    wallMs: performance.now() - startedAt,
    pageIndex: +document.querySelector(".reader").dataset.pageIndex,
    metrics: JSON.parse(
      document.querySelector(".reader").dataset.curlMetrics || "[]",
    ).slice(-3),
  }), started);
  await info.attach("rapid-keyboard-taps.json", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  expect(evidence.wallMs).toBeLessThan(800);
  expect(evidence.metrics).toHaveLength(3);
});
