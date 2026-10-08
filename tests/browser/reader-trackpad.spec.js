import { test, expect } from "@playwright/test";
import fs from "node:fs";
// Snapshot/trace recording can pause native wheel injection > the quiet gap.
// Keep physical timing checks untraced; JSON input times + PNGs are evidence.
test.use({ trace: "off" });
import {
  enableAll,
  read,
  focus,
  tools,
  pageIndex,
  pageCount,
  goPage,
  selectParagraph,
} from "./reader-helpers.js";

const paragraph =
  "A prominent contribution can change our understanding. " +
  "The reasoning of these two men did not carry conviction, since knowledge is acquired in relations. ".repeat(
    4,
  );
async function book(request) {
  const response = await request.post("/api/documents", {
    data: {
      title: "Trackpad acceptance",
      text: Array(50).fill(paragraph).join("\n\n"),
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function quiet(page) {
  await page.waitForTimeout(320);
}
async function over(page, locator = page.locator("#article")) {
  const rect = await locator.boundingBox();
  await page.mouse.move(
    rect.x + rect.width * 0.65,
    rect.y + Math.min(220, rect.height / 2),
  );
}
async function wheel(page, x, y = 0) {
  await page.mouse.wheel(x, y);
  await page.waitForTimeout(45); // Chrome delivers wheel asynchronously.
}
async function position(page, value) {
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-page-index",
    String(value),
  );
}
test.beforeEach(async ({ page, request }) => {
  await enableAll(request);
  await page.addInitScript(() =>
    localStorage.setItem("wr2:page-motion", JSON.stringify("off")),
  );
  await page.addInitScript(() => {
    window.__trackpadEvents = [];
    document.addEventListener(
      "wheel",
      (ev) =>
        window.__trackpadEvents.push({ time: performance.now(), x: ev.deltaX }),
      { capture: true, passive: true },
    );
  });
  page.__errors = [];
  page.on("pageerror", (error) => page.__errors.push(error.message));
});
test.afterEach(async ({ page }, info) => {
  const state = await page.evaluate(() => ({
    reader: document.querySelector(".reader")?.dataset,
    input: window.__trackpadEvents,
  }));
  await info.attach("gesture-end-state.json", {
    body: JSON.stringify(state, null, 2),
    contentType: "application/json",
  });
  expect(page.__errors).toEqual([]);
});

for (const layout of ["single", "double"]) {
  test(`horizontal wheel advances/reverses exactly one ${layout} spread and keeps source anchors`, async ({
    page,
    request,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem("wr2:page-layout", JSON.stringify(value)),
      layout,
    );
    const doc = await book(request);
    await read(page, doc.id);
    const step = layout === "double" ? 2 : 1;
    const source = await page
      .locator(".reader")
      .getAttribute("data-source-position");
    await over(page);
    await wheel(page, 30);
    await position(page, 0);
    await wheel(page, 55);
    await position(page, 0);
    for (let i = 0; i < 16; i++) await wheel(page, i < 8 ? 30 : 12);
    await position(page, 0);
    await quiet(page);
    await position(page, step);
    await wheel(page, -420);
    await quiet(page);
    await position(page, 0);
    expect(
      await page.locator(".reader").getAttribute("data-source-position"),
    ).toBe(source);
    await quiet(page);
    await wheel(page, -120); // First page boundary, no negative index.
    await position(page, 0);
    await info.attach(`${layout}-trackpad.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

test("vertical, diagonal, jitter and synthetic pinch streams never flip; a fresh swipe still works", async ({
  page,
  request,
}) => {
  const doc = await book(request);
  await read(page, doc.id);
  await over(page);
  for (const [x, y] of [
    [0, 300],
    [40, 300],
    [110, 20],
  ])
    await wheel(page, x, y);
  await position(page, 0); // Vertical axis stays locked for this burst.
  await quiet(page);
  await wheel(page, 150, 150);
  await position(page, 0);
  await quiet(page);
  for (const x of [8, -7, 6, -5]) await wheel(page, x);
  await position(page, 0);
  await quiet(page);
  await page.locator("#article").dispatchEvent("wheel", {
    deltaX: 200,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await wheel(page, 120);
  await position(page, 0);
  await quiet(page);
  await wheel(page, 420);
  await quiet(page);
  await position(page, 2);
});

test("warm-paper inertia keeps a single provisional session until release; reduced motion still pages", async ({
  page,
  request,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("wr2:page-motion", JSON.stringify("curl")),
  );
  const doc = await book(request);
  await read(page, doc.id);
  // Stop retrying cold software-GPU timing: its initial compile can stall the
  // automation driver past the quiet gap. Test a genuine continuous warm
  // stream here; first real Mac use remains a separate acceptance boundary.
  await page.locator("#reading-edge-next").click();
  await position(page, 2);
  await page.locator("#reading-edge-prev").click();
  await position(page, 0);
  const baseline = JSON.parse(
    await page.locator(".reader").getAttribute("data-curl-metrics"),
  ).length;
  await over(page);
  await page.evaluate(() => {
    window.__trackpadEvents = [];
    document.addEventListener(
      "wheel",
      (ev) => {
        window.__trackpadEvents.push({ time: performance.now(), x: ev.deltaX });
      },
      { capture: true, passive: true },
    );
  });
  await held(page, 1, async () => {
    await page.mouse.wheel(100, 0);
    // Keep injecting native input while the first GPU frame is acknowledged;
    // awaiting that acknowledgement alone can introduce a test idle gap.
    for (let i = 0; i < 32; i++) await wheel(page, i < 10 ? 35 : 10);
    const events = await page.evaluate(() => window.__trackpadEvents);
    const gaps = events.slice(1).map((event, i) => event.time - events[i].time);
    await info.attach("trackpad-input-stream.json", {
      body: JSON.stringify({ events, gaps }, null, 2),
      contentType: "application/json",
    });
    expect(Math.max(...gaps)).toBeLessThan(240);
    await position(page, 0);
  });
  await quiet(page);
  await position(page, 2);
  await expect(page.locator(".reader")).not.toHaveAttribute(
    "data-page-turning",
    "true",
  );
  const metrics = JSON.parse(
    await page.locator(".reader").getAttribute("data-curl-metrics"),
  ).slice(baseline);
  expect(metrics.filter((m) => m.completed)).toHaveLength(1);
  expect(metrics[0].renderer).toBe("webgl-developable-paper");
  await info.attach("trackpad-curl-metrics.json", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  await quiet(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await wheel(page, -420);
  await quiet(page);
  await position(page, 0);
  await expect(page.locator("#page-curl-layer")).toBeHidden();
});

test("tools, word card, selection and translation retain ownership of scrolling", async ({
  page,
  request,
}, info) => {
  const doc = await book(request);
  await read(page, doc.id);
  await tools(page, "notes");
  await over(page, page.locator("#tool-panel"));
  await wheel(page, 420);
  await position(page, 0);
  await focus(page);
  await over(page);
  await wheel(page, 420); // Tail arriving after closing tools must be ignored.
  await quiet(page);
  await position(page, 0);
  await quiet(page);
  await page.locator('.source-unit[data-word="prominent"]').first().click();
  const pop = page.locator(".annotation-pop");
  await expect(pop).toBeVisible();
  await over(page, pop);
  await wheel(page, 420);
  await wheel(page, 0, 180);
  await position(page, 0);
  await page.keyboard.press("Escape");
  await selectParagraph(page, 1);
  await quiet(page);
  await over(page);
  await wheel(page, 420);
  await quiet(page);
  await position(page, 0);
  await expect(page.locator("#reading-selection")).toBeVisible();
  await request.put("/api/ai/config", {
    data: {
      text: {
        enabled: true,
        base_url: "http://127.0.0.1:18768/v1",
        model: "e2e-model",
        api_key: "e2e-no-secret",
      },
    },
  });
  await page.locator('[data-selection-action="translation"]').click();
  await expect(
    page.locator("#translation-pane [data-pair]").first(),
  ).toBeVisible();
  const translated = await page.locator("#translation-pane").textContent();
  const index = await pageIndex(page);
  await quiet(page);
  await over(page, page.locator("#translation-pane"));
  await wheel(page, 420);
  await quiet(page);
  expect(await pageIndex(page)).toBe(index);
  expect(await page.locator("#translation-pane").textContent()).toBe(
    translated,
  );
  await info.attach("assistance-scroll-protected.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("synthetic line/page wheel units normalize; keyboard and blank-click navigation remain functional", async ({
  page,
  request,
}) => {
  const doc = await book(request);
  await read(page, doc.id);
  for (const [deltaX, deltaMode, expected] of [
    [24, 1, 2],
    [-1, 2, 0],
  ]) {
    await quiet(page);
    await page.locator("#article").dispatchEvent("wheel", {
      deltaX,
      deltaMode,
      bubbles: true,
      cancelable: true,
    });
    await quiet(page);
    await position(page, expected);
  }
  await page.keyboard.press("ArrowRight");
  await position(page, 2);
  await page.locator("#reading-edge-prev").click();
  await position(page, 0);
  await page.goto("/");
  await page.mouse.wheel(160, 0);
  await expect(page.locator(".reader")).toHaveCount(0);
  await read(page, doc.id);
  await quiet(page);
  await over(page);
  await wheel(page, 420);
  await quiet(page);
  await position(page, 2);
});

test("one wheel burst crosses an EPUB chapter without flipping its first page again", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/import", {
    multipart: {
      file: {
        name: "Trackpad.epub",
        mimeType: "application/epub+zip",
        buffer: fs.readFileSync("web/sample.epub"),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const imported = await response.json();
  await page.addInitScript(() =>
    localStorage.setItem("wr2:page-layout", JSON.stringify("single")),
  );
  await read(page, imported.chapters[0].doc_id);
  await goPage(page, (await pageCount(page)) - 1);
  // Force a real loading gap. Tail wheel events continue during route loading.
  await page.route("**/api/documents/*?compact=true", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await over(page);
  const end = await pageIndex(page);
  await wheel(page, 380);
  await wheel(page, -220);
  await quiet(page);
  await position(page, end);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-document-id",
    String(imported.chapters[0].doc_id),
  );
  await wheel(page, 420);
  await quiet(page);
  // A second burst arrives during the deliberately delayed chapter load.
  for (let i = 0; i < 12; i++) await wheel(page, 40);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-document-id",
    String(imported.chapters[1].doc_id),
  );
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await position(page, 0);
  await quiet(page);
  await wheel(page, 420);
  await quiet(page);
  await position(page, 1);
});

// Native wheel keeps a real gesture alive while screenshots/assertions observe
// it; without this, inspection itself can exceed the 240ms end threshold.
async function held(page, direction, observe) {
  let running = true;
  const pump = (async () => {
    while (running) {
      await page.mouse.wheel(direction, 0);
      await page.waitForTimeout(45);
    }
  })();
  try {
    return await observe();
  } finally {
    running = false;
    await pump;
  }
}
async function fold(page) {
  return page.evaluate(() => ({
    progress: +document.querySelector(".reader").dataset.trackpadProgress,
    pin: JSON.parse(
      document.querySelector("#page-curl-layer").dataset.pin || "null",
    ),
    index: +document.querySelector(".reader").dataset.pageIndex,
    state: document.querySelector(".reader").dataset.trackpadState,
  }));
}
async function finishGesture(page) {
  await quiet(page);
  await expect(page.locator(".reader")).not.toHaveAttribute(
    "data-page-turning",
    "true",
  );
}

test("warm paper continuously follows both directions; halfway reversal returns without changing source anchors", async ({
  page,
  request,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("wr2:page-motion", JSON.stringify("curl")),
  );
  const doc = await book(request);
  await read(page, doc.id);
  await page.locator("#reading-edge-next").click();
  await position(page, 2);
  await page.locator("#reading-edge-prev").click();
  await position(page, 0);
  const baseline = JSON.parse(
    await page.locator(".reader").getAttribute("data-curl-metrics"),
  ).length;
  await over(page);
  const anchor = await page
    .locator(".reader")
    .getAttribute("data-source-position");
  let early, halfway, returning;
  await held(page, 1, async () => {
    await wheel(page, 180);
    await expect.poll(async () => (await fold(page)).pin).not.toBeNull();
    early = await fold(page);
    expect(early.progress).toBeGreaterThan(0.28);
    expect(early.progress).toBeLessThan(0.4);
    expect(early.index).toBe(0);
    await wheel(page, 140);
    await expect
      .poll(async () => (await fold(page)).pin?.x ?? Infinity)
      .toBeLessThan(early.pin.x - 100);
    await info.attach("trackpad-halfway-paper.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    halfway = await fold(page);
    expect(halfway.progress).toBeGreaterThan(0.5);
    expect(halfway.index).toBe(0);
    expect(
      await page.locator(".reader").getAttribute("data-source-position"),
    ).toBe(anchor);
    await wheel(page, -180);
    await expect
      .poll(async () => (await fold(page)).pin?.x ?? -Infinity)
      .toBeGreaterThan(halfway.pin.x + 100);
    await info.attach("trackpad-reversing-paper.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    returning = await fold(page);
    expect(returning.progress).toBeLessThan(halfway.progress);
  });
  await finishGesture(page);
  await position(page, 0);
  expect(
    await page.locator(".reader").getAttribute("data-source-position"),
  ).toBe(anchor);
  await wheel(page, 420);
  await finishGesture(page);
  await position(page, 2);
  // Previous-page paper mirrors the motion and also remains reversible.
  let prev, prevBack;
  await held(page, -1, async () => {
    await wheel(page, -320);
    await expect.poll(async () => (await fold(page)).pin).not.toBeNull();
    prev = await fold(page);
    await wheel(page, 180);
    await expect
      .poll(async () => (await fold(page)).pin?.x ?? Infinity)
      .toBeLessThan(prev.pin.x - 100);
    prevBack = await fold(page);
    expect(prevBack.progress).toBeLessThan(prev.progress);
  });
  await finishGesture(page);
  await position(page, 2);
  await wheel(page, -420);
  await finishGesture(page);
  await position(page, 0);
  const metrics = JSON.parse(
    await page.locator(".reader").getAttribute("data-curl-metrics"),
  ).slice(baseline);
  expect(metrics.map((m) => m.completed)).toEqual([false, true, false, true]);
  expect(metrics.map((m) => m.reason)).toEqual([
    "trackpad-return",
    "trackpad-complete",
    "trackpad-return",
    "trackpad-complete",
  ]);
  await info.attach("continuous-paper-witness.json", {
    body: JSON.stringify(
      { baseline, early, halfway, returning, prev, prevBack, metrics },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("backward intent above halfway cancels; sub-half release and interrupted gestures cannot commit late", async ({
  page,
  request,
}, info) => {
  const doc = await book(request);
  await read(page, doc.id);
  await over(page);
  const anchor = await page
    .locator(".reader")
    .getAttribute("data-source-position");
  await wheel(page, 480);
  await wheel(page, -50); // Still > half, but deliberately pulling back.
  await quiet(page);
  await position(page, 0);
  expect(
    await page.locator(".reader").getAttribute("data-source-position"),
  ).toBe(anchor);
  await wheel(page, 480);
  for (let i = 0; i < 6; i++) await wheel(page, -1);
  await quiet(page);
  await position(page, 0); // Slow reverse is accumulated, not discarded as noise.
  await wheel(page, 180);
  await quiet(page);
  await position(page, 0);
  await wheel(page, 420);
  await page.keyboard.press("Escape");
  await quiet(page);
  await position(page, 0);
  await wheel(page, 420);
  await page.locator("#show-tools").click();
  await quiet(page);
  await position(page, 0);
  await focus(page);
  await over(page);
  await wheel(page, 420);
  await page.goto("/");
  await quiet(page);
  await read(page, doc.id);
  await position(page, 0);
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-page-layout",
    "single",
  );
  await over(page);
  await wheel(page, 260);
  await quiet(page);
  await position(page, 1);
  await info.attach("small-screen-trackpad.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("release lands quickly in both directions without a jump or a second page commit", async ({
  page,
  request,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("wr2:page-motion", JSON.stringify("curl")),
  );
  const doc = await book(request);
  await read(page, doc.id);
  await page.locator("#reading-edge-next").click();
  await position(page, 2);
  await page.locator("#reading-edge-prev").click();
  await position(page, 0);
  const anchor = await page
    .locator(".reader")
    .getAttribute("data-source-position");
  const baseline = JSON.parse(
    await page.locator(".reader").getAttribute("data-curl-metrics"),
  ).length;
  await over(page);
  await page.evaluate(() => {
    window.__releaseFrames = [];
    window.__trackpadEvents = [];
    document.addEventListener(
      "wheel",
      (ev) => {
        window.__trackpadEvents.push({ time: performance.now(), x: ev.deltaX });
      },
      { capture: true, passive: true },
    );
    window.__releaseRecording = true;
    const frame = () => {
      const root = document.querySelector(".reader"),
        layer = document.querySelector("#page-curl-layer");
      window.__releaseFrames.push({
        time: performance.now(),
        phase: root.dataset.curlPhase,
        index: +root.dataset.pageIndex,
        pin: JSON.parse(layer.dataset.pin || "null"),
      });
      if (window.__releaseRecording) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  for (const [direction, expected] of [
    [1, 2],
    [-1, 0],
  ]) {
    await quiet(page);
    await held(page, direction, async () => {
      await wheel(page, direction * 320);
      await expect.poll(async () => (await fold(page)).pin).not.toBeNull();
      expect(await pageIndex(page)).toBe(direction > 0 ? 0 : 2);
    });
    await finishGesture(page);
    await position(page, expected);
  }
  const witness = await page.evaluate(() => {
    window.__releaseRecording = false;
    return { frames: window.__releaseFrames, events: window.__trackpadEvents };
  });
  const metrics = JSON.parse(
    await page.locator(".reader").getAttribute("data-curl-metrics"),
  ).slice(baseline);
  await info.attach("release-timing-and-real-frames.json", {
    body: JSON.stringify(
      {
        environment: "warm Chromium paper; actual Mac hand feel pending",
        baseline,
        metrics,
        ...witness,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(metrics).toHaveLength(2);
  for (const metric of metrics) {
    expect(metric.completed).toBe(true);
    expect(metric.reason).toBe("trackpad-complete");
    expect(metric.release.idleMs).toBeGreaterThanOrEqual(80);
    expect(metric.release.idleMs).toBeLessThan(150);
    expect(metric.release.textureWaitMs).toBeLessThan(35);
    expect(metric.release.actualDurationMs).toBeLessThan(230);
    expect(metric.release.inputToLandingMs).toBeLessThan(480);
  }
  const segments = [];
  for (const frame of witness.frames) {
    if (frame.phase !== "settling" || !frame.pin) continue;
    if (!segments.length || segments.at(-1)[0].index !== frame.index)
      segments.push([]);
    segments.at(-1).push(frame);
  }
  expect(segments).toHaveLength(2);
  for (const [i, segment] of segments.entries()) {
    expect(segment.length).toBeGreaterThanOrEqual(4);
    for (let n = 1; n < segment.length; n++) {
      const dx = segment[n].pin.x - segment[n - 1].pin.x;
      expect(i === 0 ? dx : -dx).toBeLessThanOrEqual(0.5);
    }
    expect(Math.abs(segment.at(-1).pin.x - segment[0].pin.x)).toBeGreaterThan(
      200,
    );
  }
  expect(
    await page.locator(".reader").getAttribute("data-source-position"),
  ).toBe(anchor);
  await info.attach("release-landed.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
