import { test, expect } from "@playwright/test";
import { enableAll, read, readerDefaults } from "./reader-helpers.js";

for (const reflow of [false, true]) {
  test(`paragraph actions survive the blank band in ${reflow ? "annotation reflow" : "normal paged layout"}`, async ({ page, request }) => {
    await readerDefaults(page);
    await enableAll(request);
    await request.patch("/api/profile", { data: { density: 0, vocab_size: 8000 } });
    const text = "A prominent contribution can change our understanding. " +
      "The small research team prepared a plan for the harbor, although each member proposed a different way " +
      "to arrange the tables and check the lamps before sunset. Each person checked the final diagram. End.";
    const doc = await (await request.post("/api/documents", { data: {
      title: "Paragraph action pointer path", text: text + "\n\nAnother paragraph has its own actions.",
    } })).json();
    await read(page, doc.id);
    if (reflow) {
      await page.locator('#article [data-word="prominent"]').first().click();
      await page.getByRole("button", { name: "需注释：后续该词或短语继续显示", exact: true }).click();
      await page.getByRole("button", { name: "关闭注释", exact: true }).click();
      await expect(page.locator("#article .reflow-source-block").first()).toBeVisible();
      await expect(page.locator("#article")).not.toHaveAttribute("data-reflow-phase", "preparing");
      await expect(page.locator("#article")).not.toHaveAttribute("data-reflow-phase", "playing");
    }
    const blockId = doc.blocks[0].id;
    const fragment = reflow
      ? page.locator(`#article .source-fragment:has(.reflow-source-block[data-block="${blockId}"])`)
      : page.locator(`#article .source-fragment[data-fragment="${blockId}"]`);
    const lastWord = fragment.locator("[data-word]").last();
    const select = fragment.getByRole("button", { name: "选择这一段", exact: true });
    const wordBox = await lastWord.boundingBox(), buttonBox = await select.boundingBox();
    const start = { x: wordBox.x + wordBox.width / 2, y: wordBox.y + wordBox.height / 2 };
    const end = { x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 };
    expect(end.x - start.x).toBeGreaterThan(80);
    let blankHits = 0;
    async function travel() {
      await page.mouse.move(start.x, start.y);
      await expect(fragment).toHaveClass(/actions-visible/);
      await expect(select.locator("..")).toHaveCSS("opacity", "1");
      for (let step = 1; step <= 16; step++) {
        const point = { x: start.x + (end.x - start.x) * step / 16,
          y: start.y + (end.y - start.y) * step / 16 };
        await page.mouse.move(point.x, point.y);
        if (await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest(".source-unit,.paragraph-actions"), point)) blankHits++;
        await expect(fragment).toHaveClass(/actions-visible/);
        await expect(select.locator("..")).toHaveCSS("opacity", "1");
        await expect(select.locator("..")).toHaveCSS("pointer-events", "auto");
      }
    }
    await travel();
    if (reflow) expect(blankHits).toBeGreaterThan(0);
    await page.locator(`#article [data-block="${doc.blocks[1].id}"] [data-word]`).last().hover();
    await expect(fragment).not.toHaveClass(/actions-visible/);
    await travel();
    const leaf = await fragment.locator("xpath=ancestor::*[contains(@class, 'page-leaf')]").boundingBox();
    await page.mouse.move(leaf.x + 2, leaf.y + 2);
    await expect(fragment).not.toHaveClass(/actions-visible/);
    await travel();
    await page.mouse.click(end.x, end.y);
    await expect(page.locator("#reading-selection")).toBeVisible();
    await expect(page.locator("#reading-selection .selection-quote")).toContainText(text.slice(0, 100));
  });
}
