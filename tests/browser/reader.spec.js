import { test, expect } from "@playwright/test";
import fs from "node:fs";
import {
  read,
  tools,
  focus,
  home,
  readerDefaults,
  enableAll,
  selectParagraph,
  density,
  goPage,
  pageCount,
} from "./reader-helpers.js";
const sample = fs.readFileSync("web/sample.txt", "utf8");
async function document(request, text = sample) {
  const r = await request.post("/api/documents", {
    data: { title: "Reader acceptance " + Date.now(), text },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
test.beforeEach(async ({ page, request }) => {
  await readerDefaults(page);
  await enableAll(request);
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
});
test.afterEach(async ({ page }) => expect(page.__errors).toEqual([]));
test("paste import persists a draft and opens an immersive source", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await expect(page.getByRole("heading", { name: "把内容放进来" })).toBeVisible();
  await page.locator("#paste-text").fill(sample);
  await expect(page.locator("#import-detected-title")).toHaveText("已识别为粘贴文字");
  await page.locator("#paste-title").fill("My article");
  await expect(page.locator("#paste-state")).toContainText("草稿已自动保存");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await expect(page.locator("#paste-text")).toHaveValue(sample);
  await page.getByRole("button", { name: "开始阅读 →", exact: true }).click();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-chrome",
    "closed",
  );
  await expect(page.locator("#article")).toContainText("On a mild");
});
test("profile autosave, domains and theme survive reload", async ({ page }) => {
  await page.goto("/#/profile");
  await page.locator("[data-domain=politics]").click();
  await page.locator("[data-domain=religion]").click();
  await expect(page.locator("#profile-save")).toContainText("已自动保存");
  await page.locator("[data-theme-choice=night]").click();
  await page.reload();
  await expect(page.locator("[data-domain=politics]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
});
test("notes: selection creates one autosaved note, edits, marker, list, deletion and undo", async ({
  page,
  request,
}, info) => {
  const d = await document(request);
  await read(page, d.id);
  await selectParagraph(page, 1);
  const quote = await page
    .locator(".reader")
    .getAttribute("data-source-position");
  await page.locator("[data-selection-action=notes]").click();
  await expect(page.locator("#note-quote")).toContainText("On a mild");
  expect(await page.locator("#note-quote").textContent()).not.toMatch(
    /[一-鿿]/,
  );
  await page.locator("#note-body").fill("First thought");
  await expect(page.locator("#note-state")).toContainText("已保存");
  await page.locator("#note-done").click();
  await expect(page.locator(".note-marker")).toHaveCount(1);
  await expect(page.locator("#tool-notes .note-count")).toHaveText("1");
  await tools(page, "notes");
  await expect(page.locator("#notes-content")).toContainText("First thought");
  const notes = await (await request.get("/api/notes?doc_id=" + d.id)).json();
  expect(notes).toHaveLength(1);
  expect(notes[0].anchor.quote).toContain("On a mild");
  await page.locator(`[data-note-edit="${notes[0].id}"]`).click();
  await page.locator("#note-body").fill("Edited thought");
  await expect(page.locator("#note-state")).toContainText("已保存");
  await page.locator("#note-done").click();
  await tools(page, "notes");
  await page.locator(`[data-note-more="${notes[0].id}"]`).click();
  await page.locator(`[data-note-delete="${notes[0].id}"]`).click();
  await expect(page.locator(".note-marker")).toHaveCount(0);
  await page.locator("#toast button").click();
  await expect(page.locator(".note-marker")).toHaveCount(1);
  await focus(page);
  await page.locator(".note-marker").click();
  await expect(page.locator("#tool-panel")).toContainText("Edited thought");
  await info.attach("notes-crud.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.reload();
  await tools(page, "notes");
  await expect(page.locator("#notes-content")).toContainText("Edited thought");
  expect(
    (await (await request.get("/api/notes?doc_id=" + d.id)).json())[0].anchor,
  ).toEqual(notes[0].anchor);
});
test("slow saves, density, close/reopen and offline preserve a single note and its source", async ({
  page,
  request,
}) => {
  const d = await document(request);
  await read(page, d.id);
  await selectParagraph(page);
  await page.locator("[data-selection-action=notes]").click();
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST")
      await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  await page.locator("#note-body").fill("Draft one");
  await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
  await tools(page, "notes");
  if (await page.locator("[data-note-resume]").count())
    await page.locator("[data-note-resume]").first().click();
  else {
    await expect(page.locator("[data-note-edit]").first()).toBeVisible();
    await page.locator("[data-note-edit]").first().click();
  }
  await page.locator("#note-body").fill("Latest thought");
  await expect(page.locator("#note-state")).toContainText("已保存");
  await page.context().setOffline(true);
  await page.locator("#note-body").fill("Offline thought");
  await expect(page.locator("#note-state")).toContainText("草稿");
  await page.context().setOffline(false);
  await expect(page.locator("#note-state")).toContainText("已保存");
  await page.locator("#note-done").click();
  await density(page, 8);
  await focus(page);
  await tools(page, "notes");
  await expect(page.locator("#notes-content")).toContainText("Offline thought");
  expect(
    await (await request.get("/api/notes?doc_id=" + d.id)).json(),
  ).toHaveLength(1);
});
test("search, typography and tool toggle preserve original source and typed input", async ({
  page,
  request,
}) => {
  const d = await document(request);
  await read(page, d.id);
  await tools(page, "search");
  await page.locator("#find-text").fill("attention");
  await expect(page.locator(".search-hit").first()).toBeVisible();
  await page.locator("#find-text").press("f");
  await expect(page.locator("#find-text")).toHaveValue("attentionf");
  await tools(page, "typography");
  await page.locator("#type-size").fill("26");
  await expect(page.locator("#type-state")).toContainText("保存");
  await page.locator("#tool-typography").click();
  await expect(page.locator("#tool-panel")).toBeHidden();
  await expect(page.locator("#reader-chrome")).toBeVisible();
  await focus(page);
  expect(
    (await (await request.get("/api/documents/" + d.id)).json()).text,
  ).toBe(sample);
});
test("progress saves a stable location; release seeks and return restores it; route cleanup stays clean", async ({
  page,
  request,
}) => {
  const d = await document(
    request,
    Array(100)
      .fill("A careful reader returns to the source without losing a thought.")
      .join(" "),
  );
  await read(page, d.id);
  await pageCount(page);
  const before = await page
    .locator(".reader")
    .getAttribute("data-source-position");
  await tools(page, "progress");
  await page.locator("#reading-seek").fill("850");
  await expect(page.locator(".reader")).not.toHaveAttribute(
    "data-source-position",
    before,
  );
  await page.locator("#seek-return").click();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-source-position",
    before,
  );
  await page.locator("#reading-seek").fill("500");
  await focus(page);
  await tools(page, "bookmarks");
  await focus(page);
  await expect(page.locator(".bookmark-marker")).toBeVisible();
  await home(page);
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/documents/${d.id}/progress`)).json())
          .anchor?.ratio || 0,
    )
    .toBeGreaterThan(0.3);
  const saved = await (
    await request.get(`/api/documents/${d.id}/progress`)
  ).json();
  expect(saved.anchor.ratio).toBeGreaterThan(0.3);
  await page.goto("/#/profile");
  await page.waitForTimeout(800);
  expect(
    await (await request.get(`/api/documents/${d.id}/progress`)).json(),
  ).toEqual(saved);
  await request.patch("/api/plugins/progress", { data: { enabled: false } });
  await page.goto("/#/bookmarks");
  const marks = await (
    await request.get("/api/bookmarks?doc_id=" + d.id)
  ).json();
  await page.locator(`[data-bm="${marks[0].id}"]`).click();
  await expect(page.locator(".bookmark-marker")).toBeVisible();
});
test("missing AI is explicit, legacy translations remain stored, exports download", async ({
  page,
  request,
}) => {
  const d = await document(request);
  await request.put(`/api/documents/${d.id}/translation`, {
    data: { body: "历史译文保留" },
  });
  await read(page, d.id);
  await selectParagraph(page);
  const result = page.waitForResponse((res) =>
    res.url().endsWith("/translate-selection"),
  );
  await page.locator("[data-selection-action=translation]").click();
  expect((await result).status()).toBe(400);
  await expect(page.getByRole("dialog", { name: "阅读中的文本 AI 设置" })).toBeVisible();
  await expect(page.locator("#ai-text-status")).toContainText("未启用");
  await page.getByRole("button", { name: "收起 AI 设置" }).click();
  await expect(page.locator("#translation-pane")).toBeHidden();
  await page.reload();
  expect(
    (await (await request.get(`/api/documents/${d.id}/translation`)).json())
      .body,
  ).toBe("历史译文保留");
  await expect(
    page.locator("#translate-whole,#generate-translation,#translate-book"),
  ).toHaveCount(0);
  await page.goto("/#/profile");
  const promise = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出个人词表 ↗" }).click();
  expect((await promise).suggestedFilename()).toMatch(/csv$/);
});
test("all feature switches remain reversible and preserve notes", async ({
  page,
  request,
}) => {
  const d = await document(request);
  await request.post("/api/notes", {
    data: { doc_id: d.id, body: "Persistent note" },
  });
  await page.goto("/#/labs");
  const switches = page.locator("[data-plugin]");
  const catalog = await (await request.get("/api/plugins")).json();
  await expect(switches).toHaveCount(catalog.plugins.length);
  for (const box of await switches.all()) {
    await box.uncheck();
    await expect(page.locator("#plugin-save")).toContainText("已保存并生效");
  }
  await read(page, d.id);
  await expect(page.locator("#tool-notes")).toHaveCount(0);
  await page.goto("/#/notes");
  await expect(
    page.getByRole("heading", { name: "这个功能已关闭" }),
  ).toBeVisible();
  await page.goto("/#/labs");
  await page.locator("[data-plugin=notes]").check();
  await expect(page.locator("#plugin-save")).toContainText("已保存并生效");
  await page.goto("/#/notes");
  await expect(page.locator("#notes-list")).toContainText("Persistent note");
});
test("slow old route cannot replace a new route; mobile note editor fits", async ({
  page,
  request,
}, info) => {
  const d = await document(request);
  await page.goto("/");
  await page.route(`**/api/documents/${d.id}*`, async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    try {
      await route.continue();
    } catch {}
  });
  await page.evaluate((id) => (location.hash = "#/read/" + id), d.id);
  await page.waitForTimeout(100);
  await page.goto("/#/profile");
  await page.waitForTimeout(850);
  await expect(page.locator("#domains")).toBeVisible();
  await expect(page.locator("#article")).toHaveCount(0);
  await page.unrouteAll();
  await page.setViewportSize({ width: 390, height: 844 });
  await read(page, d.id);
  await selectParagraph(page);
  await page.locator("[data-selection-action=notes]").click();
  await page.locator("#note-body").fill("Mobile note");
  await expect(page.locator("#note-state")).toContainText("已保存");
  const rect = await page.locator("#tool-panel").boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(391);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await info.attach("mobile-note.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
test("speech consumes only English and is stopped on leaving; finish/archive remain reversible", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.__spoken = [];
    window.__cancelled = 0;
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        getVoices: () => [],
        cancel: () => window.__cancelled++,
        speak: (u) => window.__spoken.push({ text: u.text, lang: u.lang }),
      },
    });
  });
  const d = await document(request);
  await read(page, d.id);
  await tools(page, "tts");
  expect(await page.evaluate(() => window.__spoken.length)).toBe(1);
  expect((await page.evaluate(() => window.__spoken))[0].text).not.toMatch(
    /[一-鿿]/,
  );
  await home(page);
  expect(await page.evaluate(() => window.__cancelled)).toBeGreaterThan(0);
  await read(page, d.id);
  await tools(page, "more");
  await page.locator("#finish-reading").click();
  await expect(page.locator("#finish-reading")).toHaveText("已记录 ✓");
  await expect(page.locator(".trace-entries")).toHaveCount(1);
  await tools(page, "more");
  await page.locator("#archive-reading").click();
  await expect(page.locator("#archive-reading")).toHaveText("移回书架");
  await page.goto("/#/stats");
  await expect(page.locator(".stats-grid")).toContainText("标记读完");
  await read(page, d.id);
  await tools(page, "more");
  await page.locator("#archive-reading").click();
  await expect(page.locator("#archive-reading")).toHaveText("归档");
  expect(
    (await (await request.get("/api/documents/" + d.id)).json()).text,
  ).toBe(sample);
});
test("local auth protects data, rejects wrong login and unlocks with saved credentials", async ({
  page,
  request,
}) => {
  await request.patch("/api/plugins/auth", { data: { enabled: true } });
  await page.goto("/#/login");
  await page.locator("#auth-user").fill("acceptance");
  await page.locator("#auth-password").fill("test-only-password");
  await page.getByRole("button", { name: "设置访问锁", exact: true }).click();
  await expect(page.locator(".welcome")).toBeVisible();
  await page.goto("/#/profile");
  await page.locator("#logout-local").click();
  await expect(page.locator("#auth-user")).toBeVisible();
  expect((await request.get("/api/documents")).status()).toBe(401);
  await page.locator("#auth-user").fill("acceptance");
  await page.locator("#auth-password").fill("wrong");
  await page.getByRole("button", { name: "解锁阅读空间" }).click();
  await expect(page.locator("#auth-error")).toContainText("用户名或密码不正确");
  await page.locator("#auth-password").fill("test-only-password");
  await page.getByRole("button", { name: "解锁阅读空间" }).click();
  await expect(page.locator(".welcome")).toBeVisible();
  // The shared server is disposable. Keep later fixtures unlocked without touching production data.
  await page.evaluate(() =>
    fetch("/api/plugins/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }),
  );
});
