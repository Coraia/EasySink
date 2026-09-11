import { test, expect } from "@playwright/test";
import fs from "node:fs";
const sample = fs.readFileSync("web/sample.txt", "utf8");
const pluginIds = [
  "auth",
  "library",
  "importer",
  "immersive",
  "notes",
  "translate",
  "bookmarks",
  "progress",
  "export",
  "tts",
  "theme",
  "typography",
  "search",
  "stats",
  "shortcuts",
];
let errors = [];
async function doc(request, title = "Browser acceptance") {
  return (
    await request.post("/api/documents", { data: { title, text: sample } })
  ).json();
}
async function read(page, id) {
  await page.goto("/#/read/" + id);
  await expect(page.locator("#article")).toBeVisible();
  await expect(page.locator("#tool-notes")).toBeVisible();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
}
test.beforeEach(async ({ page, request }) => {
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.text().includes("Optional feature failed") ||
      /^Plugin /.test(m.text())
    )
      errors.push(m.text());
  });
  for (const id of pluginIds)
    await request.patch("/api/plugins/" + id, { data: { enabled: true } });
  await request.patch("/api/profile", {
    data: {
      density: 8,
      domains: [],
      vocab_size: 8000,
      repeat: false,
      l1_enabled: true,
    },
  });
});
test.afterEach(() => expect(errors).toEqual([]));

test("home, paste import, draft restoration and real document", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "留在故事里。" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/desktop-home.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await page.locator("#paste-title").fill("My browser article");
  await page.locator("#paste-text").fill(sample);
  await expect(page.locator("#paste-state")).toContainText("草稿已自动保存");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await expect(page.locator("#paste-text")).toHaveValue(sample);
  await page.getByRole("button", { name: "开始阅读 →", exact: true }).click();
  await expect(page.locator("#article")).toBeVisible();
  await expect(page.locator(".reading-heading h1")).toHaveText(
    "My browser article",
  );
  await page.screenshot({
    path: "test-results/desktop-reader.png",
    fullPage: false,
  });
});

test("settings show autosave and survive reload; themes stay readable", async ({
  page,
  request,
}) => {
  await page.goto("/#/profile");
  await page.locator("[data-domain=politics]").click();
  await page.locator("[data-domain=science]").click();
  await expect(page.locator("#profile-save")).toHaveText("已自动保存 ✓");
  await expect
    .poll(
      async () =>
        new Set((await (await request.get("/api/profile")).json()).domains)
          .size,
    )
    .toBe(2);
  await page.locator("[data-theme-choice=night]").click();
  await page.reload();
  await expect(page.locator("[data-domain=politics]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  const d = await doc(request, "Night reading");
  await read(page, d.id);
  await page.locator("[data-annotation]").first().click();
  await expect(page.locator(".annotation-pop")).toBeVisible();
  const colors = await page.locator(".annotation-pop").evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor,
    color: getComputedStyle(el).color,
  }));
  expect(colors.bg).not.toBe("rgb(255, 255, 255)");
  expect(colors.bg).not.toBe(colors.color);
});

test("known feedback remains hidden after navigating away and reloading", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await read(page, d.id);
  const first = page.locator("[data-annotation]").first();
  const surface = await first.locator(".source-text").textContent();
  await first.click();
  await page.getByRole("button", { name: "已掌握 ✓", exact: true }).click();
  await expect(
    page.locator(".source-text").filter({
      hasText: new RegExp(
        "^" + surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      ),
    }),
  ).toHaveCount(0);
  await page.locator(".brand").click();
  await read(page, d.id);
  await expect(
    page
      .locator(".source-text")
      .filter({ hasText: new RegExp("^" + surface + "$") }),
  ).toHaveCount(0);
});

test("density changes preserve note draft, quote, side panel and reading position", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await read(page, d.id);
  await page.locator("[data-block]").nth(6).scrollIntoViewIfNeeded();
  await page.locator("#tool-notes").click();
  await page
    .locator("#note-body")
    .fill("A thought which must survive density changes.");
  await expect(page.locator("#note-state")).toHaveText("已自动保存 ✓");
  const before = await page.evaluate(() => scrollY);
  await page.locator('[data-density="2"]').click();
  await expect(page.locator("#reader-save")).toHaveText("辅助偏好已自动保存");
  await expect(page.locator("#note-body")).toHaveValue(
    "A thought which must survive density changes.",
  );
  expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(
    450,
  );
  await page.reload();
  await page.locator("#tool-notes").click();
  await expect(page.locator("#note-body")).toHaveValue(
    "A thought which must survive density changes.",
  );
  const notes = await (await request.get("/api/notes?doc_id=" + d.id)).json();
  expect(notes).toHaveLength(1);
});

test("search never corrupts original text; shortcuts ignore input fields; typography and focus work", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await read(page, d.id);
  const original = await page.locator("#article").evaluate((el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll(".gloss").forEach((n) => n.remove());
    return c.textContent;
  });
  await page.locator("#tool-search").click();
  await page.locator("#find-text").fill("attention");
  await expect(page.locator(".search-hit").first()).toBeVisible();
  await page.locator("#find-text").press("f");
  await expect(page.locator("body")).not.toHaveClass(/immersive/);
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  expect(
    await page.locator("#article").evaluate((el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll(".gloss").forEach((n) => n.remove());
      return c.textContent;
    }),
  ).toBe(original);
  await page.locator("#tool-typography").click();
  await page.locator("#type-size").fill("28");
  await expect(page.locator("#type-state")).toHaveText("已自动保存 ✓");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.locator("#tool-immersive").click();
  await expect(page.locator(".top")).toBeHidden();
  await page.locator("#tool-immersive").click();
  await expect(page.locator(".top")).toBeVisible();
});

test("progress cleanup does not save settings scroll; bookmarks work when progress is disabled", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await read(page, d.id);
  await page.locator("[data-block]").nth(8).scrollIntoViewIfNeeded();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/documents/${d.id}/progress`)).json())
          .scroll_ratio,
    )
    .toBeGreaterThan(0.05);
  await page.locator("#tool-bookmarks").click();
  await expect(page.locator("#toast")).toContainText("已为这段文字添加书签");
  await page.goto("/#/profile");
  await expect(page.locator("#domains")).toBeVisible();
  const before = await (
    await request.get(`/api/documents/${d.id}/progress`)
  ).json();
  await page.locator("#profile-extensions").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  const after = await (
    await request.get(`/api/documents/${d.id}/progress`)
  ).json();
  expect(after).toEqual(before);
  await request.patch("/api/plugins/progress", { data: { enabled: false } });
  await page.goto("/#/bookmarks");
  await page.locator("[data-bm]").first().click();
  await expect(page.locator("#article")).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(200);
});

test("translation auto-saves; missing AI is explicit; export downloads", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await read(page, d.id);
  await page.locator("#tool-translate").click();
  await expect(page.locator("#generate-translation")).toBeDisabled();
  await page.locator("#translation-body").fill("一段真实保存的中文译文。");
  await expect(page.locator("#translation-state")).toHaveText("已自动保存 ✓");
  await page.locator('[data-density="4"]').click();
  await expect(page.locator("#translation-body")).toHaveValue(
    "一段真实保存的中文译文。",
  );
  await page.reload();
  await page.locator("#tool-translate").click();
  await expect(page.locator("#translation-body")).toHaveValue(
    "一段真实保存的中文译文。",
  );
  await page.goto("/#/profile");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出个人词表 ↗" }).click();
  expect((await download).suggestedFilename()).toMatch(/csv$/);
});

test("all 15 switches save; disabling notes retains data and restores its route", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await request.post("/api/notes", {
    data: { doc_id: d.id, body: "Persistent note" },
  });
  await page.goto("/#/labs");
  await expect(page.locator("[data-plugin]")).toHaveCount(15);
  for (const id of pluginIds) {
    const box = page.locator(`[data-plugin=${id}]`);
    await box.uncheck();
    await expect(page.locator("#plugin-save")).toHaveText("已保存并生效 ✓");
    await expect(box).toBeEnabled();
  }
  await page.goto("/#/read/" + d.id);
  await expect(page.locator("#article")).toBeVisible();
  await expect(page.locator("#tool-notes")).toHaveCount(0);
  await page.goto("/#/notes");
  await expect(
    page.getByRole("heading", { name: "这个功能已关闭" }),
  ).toBeVisible();
  await page.goto("/#/labs");
  await page.locator("[data-plugin=notes]").check();
  await expect(page.locator("#plugin-save")).toHaveText("已保存并生效 ✓");
  await page.goto("/#/notes");
  await expect(page.locator("#notes-list")).toContainText("Persistent note");
});

test("slow response from old route cannot overwrite a new page", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await page.goto("/");
  await expect(page.locator(".welcome")).toBeVisible();
  await page.route(`**/api/documents/${d.id}`, async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    try {
      await route.continue();
    } catch {}
  });
  await page.evaluate((id) => (location.hash = "#/read/" + id), d.id);
  await page.waitForTimeout(150);
  await page.locator("a[data-nav=profile]").click();
  await expect(page.locator("#domains")).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator("#domains")).toBeVisible();
  await expect(page.locator("#article")).toHaveCount(0);
});

test("mobile reading and note panel fit viewport", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const d = await doc(request);
  await read(page, d.id);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator("#tool-notes").click();
  await page.locator("#note-body").fill("手机上的笔记");
  await expect(page.locator("#note-state")).toHaveText("已自动保存 ✓");
  expect(
    await page
      .locator("#tool-panel")
      .evaluate((el) => el.getBoundingClientRect().right),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/mobile-reader.png",
    fullPage: false,
  });
});

test("EPUB file upload, ordered chapters and invalid file feedback", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await page.locator("#upload-file").setInputFiles({
    name: "bad.epub",
    mimeType: "application/epub+zip",
    buffer: Buffer.from("invalid zip"),
  });
  await expect(page.locator("#upload-state")).toContainText("文件损坏");
  await page.locator("#upload-file").setInputFiles("web/sample.epub");
  await expect(page.locator("#upload-state")).toContainText("已完整导入 2 章");
  await page.locator("#open-import").click();
  await expect(
    page.getByRole("heading", { name: "The Quiet Reader" }),
  ).toBeVisible();
  await page
    .getByRole("link")
    .filter({ hasText: "A conversation with a stranger" })
    .click();
  await expect(page.locator("#article h2").first()).toHaveText(
    "A conversation with a stranger",
  );
  await page.locator("#tool-outline").click();
  await expect(page.locator("#tool-panel .toc-link")).toHaveCount(2);
  await page.locator("#tool-panel .toc-link").nth(1).click();
  await expect(page.locator("#article .code")).toContainText(
    "attention = curiosity + time",
  );
});

test("note selection excludes glosses, rapid close/reopen creates one note, offline draft recovers", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await read(page, d.id);
  await page
    .locator("[data-block]")
    .nth(1)
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await expect(page.locator("#tool-notes")).toHaveText("笔记 · 已选文字");
  await page.locator("#tool-notes").click();
  await expect(page.locator("#note-quote")).toContainText("On a mild");
  expect(await page.locator("#note-quote").textContent()).not.toMatch(
    /[\u4e00-\u9fff]/,
  );
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST")
      await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await page.locator("#note-body").fill("Draft one");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.locator("#tool-notes").click();
  await page.locator("#note-body").fill("Newest draft survives");
  await expect(page.locator("#note-state")).toHaveText("已自动保存 ✓");
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/notes?doc_id=" + d.id)).json()).length,
    )
    .toBe(1);
  expect(
    (await (await request.get("/api/notes?doc_id=" + d.id)).json())[0].body,
  ).toBe("Newest draft survives");
  await page.context().setOffline(true);
  await page.locator("#note-body").fill("Written without a connection");
  await expect(page.locator("#note-state")).toHaveText("未同步 · 草稿已保留");
  await page.context().setOffline(false);
  await expect(page.locator("#note-state")).toHaveText("已自动保存 ✓");
});

test("speech uses English source chunks and stops on leaving the reader", async ({
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
  const d = await doc(request);
  await read(page, d.id);
  await page.locator("#tool-tts").click();
  await page.locator("#speech-play").click();
  const spoken = await page.evaluate(() => window.__spoken);
  expect(spoken).toHaveLength(1);
  expect(spoken[0].lang).toBe("en-US");
  expect(spoken[0].text).not.toMatch(/[\u4e00-\u9fff]/);
  expect(spoken[0].text.length).toBeLessThanOrEqual(221);
  const before = await page.evaluate(() => window.__cancelled);
  await page.locator(".brand").click();
  await expect(page.locator(".welcome")).toBeVisible();
  expect(await page.evaluate(() => window.__cancelled)).toBeGreaterThan(before);
});

test("finish, stats page and reversible archive preserve source", async ({
  page,
  request,
}) => {
  const d = await doc(request);
  await read(page, d.id);
  await page.locator("#finish-reading").click();
  await expect(page.locator("#finish-reading")).toHaveText("已记录 ✓");
  await page.locator("#archive-reading").click();
  await expect(page.locator("#archive-reading")).toHaveText("移回书架");
  await page.goto("/#/stats");
  await expect(
    page.getByRole("heading", { name: "每一页，都算数。" }),
  ).toBeVisible();
  await expect(page.locator(".stats-grid")).toContainText("标记读完的篇数");
  await page.goto("/");
  await page.locator("[data-filter=archived]").click();
  await expect(page.locator("#article-grid")).toContainText(d.title);
  await page.locator(`#article-grid a[href="#/read/${d.id}"]`).click();
  await page.locator("#archive-reading").click();
  await expect(page.locator("#archive-reading")).toHaveText("归档");
  expect(
    (await (await request.get("/api/documents/" + d.id)).json()).text,
  ).toBe(sample);
});

test("real local auth protects data and permits login; logout resets test lock", async ({
  page,
  request,
}) => {
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
  // Shared disposable test server: disable the lock via the authenticated browser before next test.
  await page.evaluate(() =>
    fetch("/api/plugins/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }),
  );
});
