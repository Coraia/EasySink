import { test, expect } from "@playwright/test";
import { enableAll, read, tools } from "./reader-helpers.js";

test("reading settings stay in a shallow bottom drawer and apply live", async ({
  request,
  page,
}) => {
  await enableAll(request);
  const doc = await (
    await request.post("/api/documents", {
      data: {
        title: "A quiet afternoon",
        text: Array(40)
          .fill(
            "The afternoon light fell across the open book. Outside the window, the trees moved slowly in the wind, and the reader paused to consider the story.",
          )
          .join("\n\n"),
      },
    })
  ).json();
  await read(page, doc.id);
  const panel = page.locator("#tool-panel");
  await expect(panel).toBeHidden();
  for (const id of ["appearance", "typography", "more"]) {
    await tools(page, id);
    await expect(panel).toHaveClass(/reading-drawer/);
    await panel.evaluate((el) =>
      Promise.all(el.getAnimations().map((a) => a.finished)),
    );
    const box = await panel.boundingBox();
    expect(box.height).toBeLessThanOrEqual(page.viewportSize().height / 3);
    expect(box.y).toBeGreaterThan(page.viewportSize().height / 2);
    expect(
      await page
        .locator("#panel-dismiss")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    if (id === "appearance") {
      await page.locator('[data-reader-theme="sepia"]').click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "sepia");
      await expect(panel).toBeVisible();
    }
    if (id === "typography") {
      await page.locator("#type-size").fill("28");
      await page.locator("#type-size").dispatchEvent("input");
      await expect(page.locator("#type-state")).toHaveText("已自动保存 ✓");
      expect(
        await page
          .locator("html")
          .evaluate((el) => el.style.getPropertyValue("--reading-size")),
      ).toBe("28px");
      await expect(panel).toBeVisible();
    }
  }
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await tools(page, "more");
  await page.locator("#chrome-dismiss").click({ position: { x: 20, y: 100 } });
  await expect(panel).toBeHidden();
  await tools(page, "typography");
  await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
  await expect(panel).toBeHidden();
  await tools(page, "outline");
  await expect(panel).not.toHaveClass(/reading-drawer/);
});
