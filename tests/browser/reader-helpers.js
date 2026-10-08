import { expect } from "@playwright/test";
export async function readerDefaults(page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("wr2:page-layout"))
      localStorage.setItem("wr2:page-layout", JSON.stringify("single"));
    if (!localStorage.getItem("wr2:page-motion"))
      localStorage.setItem("wr2:page-motion", JSON.stringify("off"));
  });
}
export async function tools(page, id) {
  const doc = page.url().match(/read\/(\d+)/)?.[1];
  if (doc)
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-document-id",
      doc,
    );
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  if ((await page.locator("#reader-chrome").getAttribute("hidden")) !== null)
    await page.locator("#show-tools").click();
  const button = page.locator("#tool-" + id);
  if (!(await button.isVisible())) await page.locator("#tool-more").click();
  if (
    (await button.getAttribute("aria-expanded")) === "true" &&
    (await page.locator("#tool-panel").isVisible())
  )
    return;
  await button.click();
}
export async function focus(page) {
  if (await page.locator("#tool-panel").isVisible())
    await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
  if (await page.locator("#reader-chrome").isVisible())
    await page
      .locator("#chrome-dismiss")
      .click({ position: { x: 20, y: 150 } });
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-chrome",
    "closed",
  );
}
export async function home(page) {
  if (await page.locator(".reader").count()) {
    if (!(await page.locator("#reader-chrome").isVisible()))
      await page.locator("#show-tools").click();
    await page.getByRole("link", { name: "返回书架", exact: true }).click();
  } else await page.locator(".brand").click();
}
export async function pageIndex(page) {
  return +(await page.locator(".reader").getAttribute("data-page-index"));
}
export async function pageCount(page) {
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  return +(await page.locator(".reader").getAttribute("data-page-count"));
}
export async function goPage(page, wanted) {
  wanted = Number(wanted);
  await focus(page);
  if (await page.locator("[data-selection-clear]").isVisible())
    await page.locator("[data-selection-clear]").click();
  const layout = await page.locator(".reader").getAttribute("data-page-layout");
  expect(layout).toBe("single");
  let current = await pageIndex(page);
  while (current !== wanted) {
    await page
      .locator("#reading-edge-" + (wanted > current ? "next" : "prev"))
      .click();
    const next = current + Math.sign(wanted - current);
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-page-index",
      String(next),
    );
    current = next;
  }
}
export async function density(page, value) {
  if (!(await page.locator(`[data-density="${value}"]`).isVisible()))
    await tools(page, "more");
  await page.locator(`[data-density="${value}"]`).click();
  await expect(page.locator("#reader-save")).toHaveText("辅助偏好已自动保存");
  await focus(page);
}
export async function selectParagraph(page, index = 0) {
  await focus(page);
  const row = page
    .locator("#article .source-fragment")
    .filter({ has: page.locator("[data-select-block]") })
    .nth(index);
  await row.hover();
  await row.locator("[data-select-block]").click();
  await expect(page.locator("#reading-selection")).toBeVisible();
}
export async function read(page, id) {
  await page.goto("/#/read/" + id);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-document-id",
    String(id),
  );
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
}
export async function chapter(page, index) {
  const link = page.locator("#tool-panel .toc-link").nth(index);
  const href = await link.getAttribute("href");
  await link.click();
  await expect(page).toHaveURL(
    new RegExp(href.replace("#/", "#/").replace("/", "\\/") + "$"),
  );
  const id = href.match(/read\/(\d+)/)[1];
  await expect(page.locator(".reader")).toHaveAttribute("data-document-id", id);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
}
export async function enableAll(request) {
  const catalog = await (await request.get("/api/plugins")).json();
  for (const item of catalog.plugins)
    // The auth test owns the lock; don't relock its disposable account later.
    if (item.id !== "auth")
      await request.patch("/api/plugins/" + item.id, {
        data: { enabled: true },
      });
  await request.put("/api/ai/config", {
    data: {
      text: { enabled: false },
      speech: { enabled: false, mode: "browser" },
    },
  });
  await request.patch("/api/profile", {
    data: { density: 4, vocab_size: 4500, repeat: false, domains: [] },
  });
}
