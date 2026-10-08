import { test, expect } from "@playwright/test";
import { enableAll, read } from "./reader-helpers.js";
test.use({
  trace: "off",
  channel: "chrome",
  launchOptions: { args: ["--use-angle=metal", "--enable-gpu"] },
});
const position = (page, value) =>
  expect(page.locator(".reader")).toHaveAttribute(
    "data-page-index",
    String(value),
  );
const quiet = (page) => page.waitForTimeout(320);
async function over(page) {
  const b = await page.locator("#article").boundingBox();
  await page.mouse.move(b.x + b.width * 0.65, b.y + 220);
}
async function book(request) {
  return (
    await request.post("/api/documents", {
      data: {
        title: "Coast acceptance",
        text: Array(50)
          .fill(
            "A prominent contribution changes our understanding. The reasoning of these two men did not carry conviction, since knowledge is acquired in relations. ".repeat(
              4,
            ),
          )
          .join("\n\n"),
      },
    })
  ).json();
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
test.beforeEach(async ({ page, request }) => {
  await enableAll(request);
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
  await page.addInitScript(() =>
    localStorage.setItem("wr2:page-layout", JSON.stringify("double")),
  );
});
test.afterEach(async ({ page }, info) => {
  await info.attach("coast-end-state.json", {
    body: JSON.stringify(
      await page.evaluate(() => document.querySelector(".reader")?.dataset),
    ),
    contentType: "application/json",
  });
  expect(page.__errors).toEqual([]);
});
test.describe("reversible coast and buffered handoff on Metal", () => {
  async function prepared(page, request) {
    await page.addInitScript(() =>
      localStorage.setItem("wr2:page-motion", JSON.stringify("curl")),
    );
    const doc = await book(request);
    await read(page, doc.id);
    await page.locator("#reading-edge-next").click();
    await position(page, 2);
    await page.locator("#reading-edge-prev").click();
    await position(page, 0);
    await quiet(page);
    await over(page);
    return {
      doc,
      anchor: await page
        .locator(".reader")
        .getAttribute("data-source-position"),
    };
  }
  test("a paused hand resumes from visible paper; reverse above halfway cancels before any commit", async ({
    page,
    request,
  }, info) => {
    const { anchor } = await prepared(page, request);
    await page.evaluate(() => {
      window.__reverse = null;
      document.addEventListener(
        "wheel",
        (ev) => {
          if (ev.deltaX >= 0) return;
          const pin = () =>
            JSON.parse(
              document.querySelector("#page-curl-layer").dataset.pin || "null",
            );
          const value = (window.__reverse = {
            at: performance.now(),
            before: pin(),
          });
          requestAnimationFrame(() => {
            value.after = pin();
            value.frameAt = performance.now();
          });
        },
        { passive: true, capture: true },
      );
    });
    await page.mouse.wheel(420, 0);
    await page.waitForTimeout(140);
    await position(page, 0);
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-trackpad-state",
      "settling",
    );
    const before = await fold(page);
    await page.mouse.wheel(-30, 0);
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-trackpad-state",
      "tracking",
    );
    await expect
      .poll(() => page.evaluate(() => window.__reverse?.after))
      .not.toBeNull();
    const event = await page.evaluate(() => window.__reverse);
    const back = await fold(page);
    expect(event.after.x - event.before.x).toBeGreaterThan(20);
    expect(event.after.x - event.before.x).toBeLessThan(100);
    await finishGesture(page);
    await position(page, 0);
    expect(
      await page.locator(".reader").getAttribute("data-source-position"),
    ).toBe(anchor);
    await info.attach("coast-reverse.json", {
      body: JSON.stringify({ before, back, event }),
      contentType: "application/json",
    });
  });
  test("a paused sub-half hand can continue forward without losing distance or jumping direction", async ({
    page,
    request,
  }, info) => {
    await prepared(page, request);
    await page.mouse.wheel(270, 0);
    await page.waitForTimeout(140);
    await position(page, 0);
    const before = await fold(page);
    await page.mouse.wheel(90, 0);
    await expect
      .poll(async () => (await fold(page)).pin?.x ?? Infinity)
      .toBeLessThan(before.pin.x - 40);
    const after = await fold(page);
    expect(after.progress).toBeGreaterThanOrEqual(0.59);
    await finishGesture(page);
    await position(page, 2);
    await info.attach("coast-resume.json", {
      body: JSON.stringify({ before, after }),
      contentType: "application/json",
    });
  });
  test("a new hand during cancel is retained; Escape also clears queued input without a late commit", async ({
    page,
    request,
  }, info) => {
    const { anchor } = await prepared(page, request);
    await page.mouse.wheel(480, 0);
    await page.waitForTimeout(40);
    await page.mouse.wheel(-60, 0);
    await page.waitForTimeout(270);
    await position(page, 0);
    await page.mouse.wheel(420, 0);
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-trackpad-queue",
      "1",
    );
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-page-index",
      "2",
    );
    await quiet(page);
    await page.mouse.wheel(-480, 0);
    await page.waitForTimeout(40);
    await page.mouse.wheel(60, 0);
    await page.waitForTimeout(270);
    await page.mouse.wheel(-420, 0);
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-trackpad-queue",
      "1",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(900);
    await position(page, 2);
    await expect(page.locator(".reader")).not.toHaveAttribute(
      "data-page-turning",
      "true",
    );
    await quiet(page);
    await page.mouse.wheel(-420, 0);
    await finishGesture(page);
    await position(page, 0);
    expect(
      await page.locator(".reader").getAttribute("data-source-position"),
    ).toBe(anchor);
    await info.attach("handoff-end.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
