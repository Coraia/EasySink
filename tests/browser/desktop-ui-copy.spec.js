import { test, expect } from "@playwright/test";
import { enableAll, readerDefaults, read, tools } from "./reader-helpers.js";

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop" : "web"} storage wording and density choices`, async ({
    page,
    request,
  }) => {
    await readerDefaults(page);
    await enableAll(request);
    if (desktop)
      await page.addInitScript(() => {
        window.wiseReaderDesktop = { nativeTrackpad: true };
      });
    await page.goto("/#/profile");
    await expect(page.locator("#theme-state")).toHaveText(
      `在${desktop ? "本机" : "此浏览器"}自动保存`,
    );
    const labels = ["原文", "轻 · 2 处", "适中 · 4 处", "多 · 8 处"];
    await expect(page.locator("#default-density")).toHaveAttribute(
      "aria-label",
      "辅助密度",
    );
    await expect(page.locator("#default-density option")).toHaveText(labels);
    const response = await request.post("/api/documents", {
      data: { title: "UI copy", text: "Curiosity is a quiet form of courage." },
    });
    expect(response.ok()).toBeTruthy();
    const doc = await response.json();
    await read(page, doc.id);
    await tools(page, "appearance");
    await expect(page.locator("[data-density]")).toHaveText(labels);
    await tools(page, "typography");
    await expect(page.locator("#type-state")).toHaveText(
      `调整后自动保存到${desktop ? "本机" : "此浏览器"}`,
    );
  });
}
