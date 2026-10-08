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
  await page.mouse.up();
  await expect(page.locator(".reader")).not.toHaveAttribute(
    "data-page-turning",
    "true",
  );
  return { pin, from: index, to: await pageIndex(page) };
}
test("default focus, toolbar hit areas and toggle back retain readable source; progress release/return", async ({
  request,
  page,
}, info) => {
  const d = await book(request);
  await read(page, d.id);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-chrome",
    "closed",
  );
  const text = await page.locator("#article").textContent();
  await tools(page, "notes");
  await page.locator("#tool-notes").click();
  await expect(page.locator("#tool-panel")).toBeHidden();
  await expect(page.locator("#reader-chrome")).toBeVisible();
  await page.mouse.move(650, 350);
  await expect(page.locator("#article")).toBeVisible();
  expect(await page.locator("#article").textContent()).toBe(text);
  const buttons = await page
    .locator("#reader-actions button")
    .evaluateAll((es) =>
      es.map((e) => ({
        text: e.textContent,
        rect: e.getBoundingClientRect().toJSON(),
      })),
    );
  expect(buttons.every((b) => !b.text.trim())).toBe(true);
  expect(buttons.every((b) => b.rect.width > 70)).toBe(true);
  await tools(page, "progress");
  const slider = await page.locator("#reading-seek").boundingBox(),
    before = await page.locator(".reader").getAttribute("data-source-position");
  await page.mouse.move(
    slider.x + slider.width * 0.2,
    slider.y + slider.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    slider.x + slider.width * 0.75,
    slider.y + slider.height / 2,
    { steps: 10 },
  );
  expect(
    await page.locator(".reader").getAttribute("data-source-position"),
  ).toBe(before);
  await page.mouse.up();
  await expect(page.locator(".reader")).not.toHaveAttribute(
    "data-source-position",
    before,
  );
  await page.locator("#seek-return").click();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-source-position",
    before,
  );
  await info.attach("reader-toolbar.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
test("paper follows both vertical directions; cancel does not commit; lighting switch and single page survive", async ({
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
    "data-page-layout",
    "double",
  );
  const cases = [];
  cases.push(await dragging(page, "next", -450, -120, info));
  expect(cases[0].to).toBe(2);
  cases.push(await dragging(page, "prev", 450, 120));
  expect(cases[1].to).toBe(0);
  const box = await page.locator("#reading-edge-next").boundingBox(),
    index = await pageIndex(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 50, box.y + box.height / 2, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await pageIndex(page)).toBe(index);
  await tools(page, "appearance");
  await page.locator("#reader-light").uncheck();
  await page.locator("[data-reader-theme=night]").click();
  await page.locator("#reader-layout").selectOption("single");
  await focus(page);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-page-layout",
    "single",
  );
  const off = await dragging(page, "next", -450, 120);
  expect(off.to).toBe(off.from + 1);
  await tools(page, "appearance");
  await page.locator("#reader-light").check();
  await focus(page);
  cases.push(await dragging(page, "prev", 450, -120));
  await info.attach("paper-direction.json", {
    body: JSON.stringify(cases, null, 2),
    contentType: "application/json",
  });
});
