import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { readerDefaults, pageIndex, goPage } from "./reader-helpers.js";
const sample =
  "A prominent contribution can change our understanding.\n\n" +
  fs.readFileSync("web/sample.txt", "utf8");
async function openWord(page, request) {
  const doc = await (
    await request.post("/api/documents", {
      data: { title: "Word card scroll check", text: sample },
    })
  ).json();
  await page.goto("/#/read/" + doc.id);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await page.locator('.source-unit[data-word="prominent"]').first().click();
  await expect(page.locator(".annotation-pop .context-action")).toBeVisible();
  return page.getByRole("dialog", { name: "注释详情" });
}
async function wheelOver(page, pop, delta) {
  const rect = await pop.boundingBox(),
    view = page.viewportSize();
  await page.mouse.move(
    rect.x + rect.width / 2,
    Math.min(view.height - 25, rect.y + 60),
  );
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(250);
}
async function fits(page, pop) {
  await expect
    .poll(async () => {
      const rect = await pop.boundingBox(),
        view = page.viewportSize();
      return (
        !!rect &&
        rect.y >= 13 &&
        rect.x >= 13 &&
        rect.y + rect.height <= view.height - 13 &&
        rect.x + rect.width <= view.width - 13
      );
    })
    .toBe(true);
}
test.beforeEach(async ({ page, request }) => {
  await readerDefaults(page);
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
  for (const id of ["tts", "progress", "notes", "translate", "grammar"])
    await request.patch("/api/plugins/" + id, { data: { enabled: true } });
  await request.patch("/api/profile", {
    data: { density: 0, vocab_size: 8000 },
  });
  await request.put("/api/ai/config", {
    data: {
      text: { enabled: false },
      speech: { enabled: false, mode: "browser" },
    },
  });
});
test.afterEach(async ({ page }) => expect(page.__errors).toEqual([]));
test("short word card consumes trackpad wheel without moving the background; closing restores pagination", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1379, height: 720 });
  const pop = await openWord(page, request);
  const bg = await page.evaluate(() => scrollY);
  const index = await pageIndex(page);
  await wheelOver(page, pop, 420);
  expect(await page.evaluate(() => scrollY)).toBe(bg);
  expect(await pageIndex(page)).toBe(index);
  await fits(page, pop);
  await info.attach("short-word-card.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await goPage(page, index + 1);
});
test("long asynchronous word explanation stays inside the viewport and scrolls independently at both boundaries", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1379, height: 720 });
  await request.put("/api/ai/config", {
    data: {
      text: {
        enabled: true,
        base_url: "http://127.0.0.1:18768/v1",
        model: "long-context",
        api_key: "e2e-no-secret",
      },
    },
  });
  const pop = await openWord(page, request);
  await pop.locator(".context-action").click();
  await expect(pop.locator(".context-result")).toContainText(
    "这是本机验收用的长解释",
  );
  await fits(page, pop);
  expect(
    await pop.evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeGreaterThan(100);
  const bg = await page.evaluate(() => scrollY);
  await wheelOver(page, pop, 340);
  expect(await pop.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(bg);
  await pop.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await wheelOver(page, pop, 700);
  expect(await page.evaluate(() => scrollY)).toBe(bg);
  const bottom = await pop.evaluate((el) => el.scrollTop);
  await wheelOver(page, pop, -180);
  expect(await pop.evaluate((el) => el.scrollTop)).toBeLessThan(bottom);
  await pop.evaluate((el) => (el.scrollTop = 0));
  await wheelOver(page, pop, -700);
  expect(await page.evaluate(() => scrollY)).toBe(bg);
  await info.attach("long-card-scroll.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 640 });
  await fits(page, pop);
  const mobileBg = await page.evaluate(() => scrollY);
  await wheelOver(page, pop, 450);
  expect(await page.evaluate(() => scrollY)).toBe(mobileBg);
  await info.attach("word-card-resized.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});
