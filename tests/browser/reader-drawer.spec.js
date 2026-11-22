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
    if (id === "more") {
      await expect(page.locator("#reader-actions button")).toHaveText([
        "目录",
        "笔记",
        "收藏",
        "进度",
        "样式",
        "字体",
        "更多",
      ]);
      await expect(
        panel
          .getByRole("region", { name: "阅读操作" })
          .getByRole("button", { name: "搜索", exact: true }),
      ).toBeVisible();
      await expect(
        panel
          .getByRole("region", { name: "阅读视图" })
          .getByRole("button", { name: "回到专注" }),
      ).toBeVisible();
      await expect(
        panel
          .getByRole("region", { name: "设置" })
          .getByRole("link", { name: "阅读偏好" }),
      ).toBeVisible();
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

test("the last page offers a finish screen without recording until confirmed", async ({
  request,
  page,
}) => {
  await enableAll(request);
  const doc = await (
    await request.post("/api/documents", {
      data: {
        title: "A small ending",
        text: Array(60)
          .fill("The last light bounced off the water.")
          .join("\n\n"),
      },
    })
  ).json();
  await read(page, doc.id);
  const end = page.locator("#reading-end");
  await expect(end).toBeHidden();
  await tools(page, "progress");
  const seek = page.locator("#reading-seek");
  await seek.fill("1000");
  await seek.dispatchEvent("change");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(end).toBeVisible();
  const reader = page.locator(".reader");
  const position = await reader.getAttribute("data-source-position");
  await end.click();
  const ending = page.getByRole("dialog", { name: "读到文末了" });
  await expect(ending).toContainText(doc.title);
  await ending.getByRole("button", { name: "回到正文" }).click();
  await expect(ending).toBeHidden();
  await expect(end).toBeFocused();
  await expect(reader).toHaveAttribute("data-source-position", position);
  const logs = async () =>
    (await (await request.get("/api/reading-log")).json()).filter(
      (log) => log.doc_id === doc.id,
    );
  expect(await logs()).toHaveLength(0);
  await page.route(
    `**/api/documents/${doc.id}/finish`,
    (route) => route.fulfill({ status: 503, json: { detail: "暂时无法保存" } }),
    { times: 1 },
  );
  await end.click();
  const save = ending.getByRole("button", { name: "标记读完" });
  await save.click();
  await expect(ending.getByRole("alert")).toHaveText("暂时无法保存");
  await expect(save).toBeEnabled();
  expect(await logs()).toHaveLength(0);
  await save.click();
  await expect(page.getByRole("dialog", { name: "阅读已记录" })).toBeVisible();
  expect(await logs()).toHaveLength(1);
  await page.getByRole("link", { name: "返回书架", exact: false }).click();
  await expect(page).toHaveURL(/#\/$/);
});
