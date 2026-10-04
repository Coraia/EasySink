import { test, expect } from "@playwright/test";
import fs from "node:fs";
const sample = fs.readFileSync("web/sample.txt", "utf8");
const provider = "http://127.0.0.1:18768";
const key = "e2e-no-secret";
async function document(request) {
  return (
    await request.post("/api/documents", {
      data: { title: "The quiet art of paying attention", text: sample },
    })
  ).json();
}
async function openReader(page, id) {
  await page.goto("/#/read/" + id);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
}
async function targets(page) {
  return page
    .locator("[data-annotation]")
    .evaluateAll((els) => els.map((el) => el.dataset.target));
}
async function doubleClickWord(page, word) {
  const point = await page.locator("#article").evaluate((el, word) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement.closest(".gloss,[data-annotation],.bookmark-marker"))
        continue;
      const m = new RegExp("\\b" + word + "\\b", "i").exec(n.textContent);
      if (m) {
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + word.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
    }
    throw Error("Word not found: " + word);
  }, word);
  await page.mouse.dblclick(point.x, point.y);
  await expect(page.locator(".annotation-pop h3")).toHaveText(word);
}
test.beforeEach(async ({ page, request }) => {
  page.__errors = [];
  page.on("pageerror", (err) => page.__errors.push(err.message));
  page.on("console", (m) => {
    if (
      m.text().includes("Optional feature failed") ||
      /^Plugin /.test(m.text())
    )
      page.__errors.push(m.text());
  });
  for (const id of [
    "auth",
    "bookmarks",
    "tts",
    "progress",
    "notes",
    "translate",
  ])
    await request.patch("/api/plugins/" + id, { data: { enabled: true } });
  await request.patch("/api/profile", {
    data: {
      vocab_size: 4500,
      density: 4,
      repeat: false,
      l1_enabled: true,
      domains: [],
    },
  });
  for (const target of ["phone", "morning", "walk", "attention"])
    await request.post("/api/feedback", { data: { target, verdict: "reset" } });
});
test.afterEach(async ({ page }) => expect(page.__errors).toEqual([]));

test("retaining words is additive and undo restores prior feedback", async ({
  page,
  request,
}, testInfo) => {
  await request.patch("/api/profile", { data: { density: 2 } });
  const d = await document(request);
  await openReader(page, d.id);
  const baseline = await targets(page);
  const evidence = { baseline, steps: [] };
  for (const word of ["phone", "morning"]) {
    await doubleClickWord(page, word);
    await page.getByRole("button", { name: "保留注释", exact: true }).click();
    await expect(page.locator("#toast")).toContainText("已记住：保留这项注释");
    await expect(page.locator(`[data-target="${word}"]`)).toHaveCount(1);
    const current = await targets(page);
    expect(baseline.every((t) => current.includes(t))).toBeTruthy();
    expect(current).toContain(word);
    evidence.steps.push({ word, targets: current });
  }
  await page.reload();
  await expect(page.locator('[data-target="morning"]')).toHaveCount(1);
  const after = await targets(page);
  expect(baseline.every((t) => after.includes(t))).toBeTruthy();
  await testInfo.attach("annotation-retention.json", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  // A previously-known word: undo must restore known, rather than reset its history.
  await request.post("/api/feedback", {
    data: { target: "phone", verdict: "known" },
  });
  await page.reload();
  await doubleClickWord(page, "phone");
  await page.getByRole("button", { name: "保留注释", exact: true }).click();
  await page.locator("#toast button").click();
  await page.reload();
  await expect(page.locator('[data-target="phone"]')).toHaveCount(0);
  for (const target of ["phone", "morning"])
    await request.post("/api/feedback", { data: { target, verdict: "reset" } });
});
test("moderate and more assistance respond for the reported sample", async ({
  page,
  request,
}, testInfo) => {
  const d = await document(request);
  await openReader(page, d.id);
  const medium = await targets(page);
  await testInfo.attach("density-moderate.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.locator('[data-density="8"]').click();
  await expect(page.locator("#reader-save")).toHaveText("辅助偏好已自动保存");
  const more = await targets(page);
  await testInfo.attach("density-more.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  expect(more.length).toBeGreaterThan(medium.length);
  expect(medium.every((t) => more.includes(t))).toBeTruthy();
  await testInfo.attach("density-comparison.json", {
    body: JSON.stringify({ word_count: d.word_count, medium, more }, null, 2),
    contentType: "application/json",
  });
});
test("bookmark toggles, has an inline marker and survives redraw", async ({
  page,
  request,
}, testInfo) => {
  const d = await document(request);
  await openReader(page, d.id);
  await page.locator("#tool-bookmarks").click();
  await expect(page.locator(".bookmark-marker")).toHaveCount(1);
  await expect(page.locator("#tool-bookmarks")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#tool-bookmarks").click();
  await expect(page.locator(".bookmark-marker")).toHaveCount(0);
  expect(
    await (await request.get("/api/bookmarks?doc_id=" + d.id)).json(),
  ).toHaveLength(0);
  await page.locator("#tool-bookmarks").click();
  await page.locator('[data-density="8"]').click();
  await expect(page.locator(".bookmark-marker")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".bookmark-marker")).toHaveCount(1);
  await testInfo.attach("bookmark-marker.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.locator(".bookmark-marker").click();
  await expect(page.locator(".bookmark-marker")).toHaveCount(0);
});
test("AI config masks keys, hot-enables models, validates errors and translates end to end", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/#/ai");
  await expect(page.locator("#ai-text-form")).toBeVisible();
  await page.locator("#ai-text-url").fill(provider + "/v1");
  await page.locator("#ai-text-model").fill("e2e-model");
  await page.locator("#ai-text-key").fill(key);
  await page.locator("#ai-text-enabled").check();
  await page.locator("#ai-text-save").click();
  await expect(page.locator("#ai-text-status")).toContainText("已保存");
  await page.locator("#ai-text-test").click();
  await expect(page.locator("#ai-text-status")).toContainText("连接成功");
  const config = await (await request.get("/api/ai/config")).json();
  expect(JSON.stringify(config)).not.toContain(key);
  expect(config.text.has_api_key).toBeTruthy();
  expect(
    (await (await request.get("/api/profile")).json()).l1_available,
  ).toBeTruthy();
  await page.reload();
  await expect(page.locator("#ai-text-key")).toHaveValue("");
  await expect(page.locator("#ai-text-key")).toHaveAttribute(
    "placeholder",
    /已保存/,
  );
  const d = await document(request);
  await expect
    .poll(async () => {
      const list = await (await request.get("/api/jobs")).json();
      return list.find(
        (j) => j.kind === "annotations" && j.doc_ids.includes(d.id),
      )?.status;
    })
    .toBe("complete");
  await openReader(page, d.id);
  await expect(page.locator("#article")).toContainText("测试背景");
  await page.locator("#tool-translate").click();
  await page.locator("#generate-translation").click();
  await expect
    .poll(async () => {
      const list = await (await request.get("/api/jobs")).json();
      return list.find(
        (j) => j.kind === "translate" && j.doc_ids.includes(d.id),
      )?.status;
    })
    .toBe("complete");
  await openReader(page, d.id);
  await page.locator("#tool-translate").click();
  await expect(page.locator("#translation-body")).toContainText("测试译文");
  await page.goto("/#/ai");
  await page.locator("#ai-text-model").fill("broken-json");
  await page.locator("#ai-text-save").click();
  await page.locator("#ai-text-test").click();
  await expect(page.locator("#ai-text-status")).toContainText("无法读取");
  await page.locator("#ai-text-key").fill("wrong-test-key");
  await page.locator("#ai-text-model").fill("e2e-model");
  await page.locator("#ai-text-save").click();
  await page.locator("#ai-text-test").click();
  await expect(page.locator("#ai-text-status")).toContainText("凭据");
  await testInfo.attach("ai-error-redacted.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.locator("#ai-text-enabled").uncheck();
  await page.locator("#ai-text-save").click();
  expect(
    (await (await request.get("/api/profile")).json()).l1_available,
  ).toBeFalsy();
});
test("natural speech preview, original text, cache, pause and cancellation", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/#/ai");
  await page.locator("#ai-speech-url").fill(provider + "/v1");
  await page.locator("#ai-speech-model").fill("e2e-tts");
  await page.locator("#ai-speech-key").fill(key);
  await page.locator("#ai-speech-enabled").check();
  await page.locator("#ai-speech-save").click();
  await expect(page.locator("#ai-speech-status")).toContainText("已保存");
  await page.locator("#ai-speech-preview").click();
  await expect(page.locator("#ai-speech-audio")).toBeVisible();
  const d = await document(request);
  await openReader(page, d.id);
  await page.locator("#tool-tts").click();
  await page.locator("#speech-mode").selectOption("natural");
  await page.locator("#speech-play").click();
  await expect(page.locator("#speech-state")).toContainText("正在朗读");
  await testInfo.attach("natural-speech-panel.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.locator("#speech-pause").click();
  await expect(page.locator("#speech-state")).toContainText("已暂停");
  await page.locator("#speech-stop").click();
  await expect(page.locator("#speech-state")).toHaveText("朗读已停止");
  const before = await (await request.get(provider + "/observed")).json();
  await page.locator("#speech-play").click();
  await expect(page.locator("#speech-state")).toContainText("正在朗读");
  const cached = await (await request.get(provider + "/observed")).json();
  expect(cached.speech.length).toBe(before.speech.length);
  await page.locator("#speech-stop").click();
  await page.locator("#speech-voice").fill("bad-audio");
  await page.locator("#speech-play").click();
  await expect(page.locator("#speech-state")).toContainText("无法读取");
  await expect(page.locator("#speech-mode")).toHaveValue("natural");
  await expect(page.locator("#speech-audio")).toHaveCount(0);
  await page.locator("#speech-voice").fill("slow");
  await page.locator("#speech-play").click();
  await expect(page.locator("#speech-state")).toContainText("生成");
  await page.locator(".brand").click();
  await expect(page.locator(".welcome")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(
    await page.evaluate(() => !!document.querySelector("#speech-audio")),
  ).toBeFalsy();
  const observed = await (await request.get(provider + "/observed")).json();
  expect(observed.speech.every((p) => !/[一-鿿]/.test(p.input))).toBeTruthy();
  await testInfo.attach("speech-requests.json", {
    body: JSON.stringify(observed.speech, null, 2),
    contentType: "application/json",
  });
  await request.put("/api/ai/config", { data: { speech: { enabled: false } } });
});

test("repeated feedback remains additive across densities; pure source remains intact", async ({
  page,
  request,
}, testInfo) => {
  await request.patch("/api/profile", { data: { density: 2 } });
  const d = await document(request);
  await openReader(page, d.id);
  const baseline = await targets(page);
  for (let i = 0; i < 6; i++) {
    for (const word of ["phone", "morning"]) {
      if (i === 0) await doubleClickWord(page, word);
      else await page.locator(`[data-target="${word}"]`).click();
      await page.getByRole("button", { name: "保留注释", exact: true }).click();
      await expect(page.locator(".annotation-pop")).toHaveCount(0);
      await expect(page.locator(`[data-target="${word}"]`)).toHaveCount(1);
    }
    await page.locator('[data-density="4"]').click();
    await expect(page.locator("#reader-save")).toHaveText("辅助偏好已自动保存");
    await page.locator('[data-density="2"]').click();
    await expect(page.locator('[data-density="2"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(async () => {
        const visible = await targets(page);
        return baseline.every((t) => visible.includes(t));
      })
      .toBeTruthy();
    const current = await targets(page);
    expect(baseline.every((t) => current.includes(t))).toBeTruthy();
  }
  await page.locator('[data-density="0"]').click();
  await expect(page.locator("[data-annotation]")).toHaveCount(2);
  const source = await page.locator("#article").evaluate((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll(".gloss,.bookmark-marker").forEach((n) => n.remove());
    return [...copy.children].map((n) => n.textContent);
  });
  expect(source).toEqual(sample.trim().split(/\n\n+/));
  expect(
    (await (await request.get("/api/documents/" + d.id)).json()).text,
  ).toBe(sample);
  await testInfo.attach("repeated-preservation.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  for (const target of ["phone", "morning"])
    await request.post("/api/feedback", { data: { target, verdict: "reset" } });
});

test("configuration rejects invalid secrets safely; bookmark and speech plugins retain boundaries", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/api/ai/config")).json();
  const rejected = await request.put("/api/ai/config", {
    data: { text: { base_url: "https://user:password@example.com" } },
  });
  expect(rejected.status()).toBe(400);
  expect(await rejected.text()).not.toContain("password");
  const longKey = "e2e-private-".repeat(300);
  const tooLong = await request.put("/api/ai/config", {
    data: { text: { api_key: longKey } },
  });
  expect(tooLong.status()).toBe(422);
  expect(await tooLong.text()).not.toContain(longKey);
  expect(await (await request.get("/api/ai/config")).json()).toEqual(before);
  const d = await document(request);
  await openReader(page, d.id);
  const anchor = await page
    .locator("#article [data-block]")
    .first()
    .evaluate((el) => ({
      block_id: el.dataset.block,
      quote: el.textContent,
      ratio: 0,
    }));
  const responses = await Promise.all([
    request.post("/api/bookmarks", { data: { doc_id: d.id, anchor } }),
    request.post("/api/bookmarks", { data: { doc_id: d.id, anchor } }),
  ]);
  expect((await responses[0].json()).id).toBe((await responses[1].json()).id);
  expect(
    await (await request.get("/api/bookmarks?doc_id=" + d.id)).json(),
  ).toHaveLength(1);
  await request.patch("/api/plugins/tts", { data: { enabled: false } });
  expect(
    (await request.post("/api/speech", { data: { text: "Hello." } })).status(),
  ).toBe(404);
  await page.reload();
  await expect(page.locator("#tool-tts")).toHaveCount(0);
  await request.patch("/api/plugins/tts", { data: { enabled: true } });
  await request.put("/api/ai/config", {
    data: {
      speech: { enabled: false, clear_key: true },
      text: { enabled: false, clear_key: true },
    },
  });
  await page.goto("/#/ai");
  await expect(page.locator("#ai-speech-key")).toHaveAttribute(
    "placeholder",
    "填写此服务的 API Key",
  );
  expect(
    (await request.post("/api/speech", { data: { text: "Hello." } })).status(),
  ).toBe(400);
});

test("mobile AI configuration and bookmark markers fit and remain accessible", async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/ai");
  await expect(page.locator("#ai-text-form")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await testInfo.attach("mobile-ai-settings.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  const d = await document(request);
  await openReader(page, d.id);
  await page.locator("#tool-bookmarks").click();
  const marker = page.locator(".bookmark-marker");
  await expect(marker).toHaveCount(1);
  expect(
    await marker.evaluate((el) => el.getBoundingClientRect().left),
  ).toBeGreaterThanOrEqual(0);
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(marker).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await testInfo.attach("mobile-reader-feedback.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("entry, styles and dynamically imported plugins share a cache-busting source version", async ({
  page,
  request,
}, testInfo) => {
  // Warm the historical path; the current shell must not load it as its entry.
  await page.goto("/static/app.js");
  await page.goto("/");
  await expect(page.locator(".welcome")).toBeVisible();
  const entry = await page.locator('script[type="module"]').getAttribute("src");
  expect(entry).toMatch(/^\/assets\/[a-f0-9]{16}\/app\.js$/);
  const prefix = entry.replace("app.js", "");
  expect(
    await page.locator('link[rel="stylesheet"]').getAttribute("href"),
  ).toBe(prefix + "style.css");
  const imported = [];
  page.on("request", (req) => {
    if (req.url().includes("/plugins/") && req.url().endsWith(".js"))
      imported.push(new URL(req.url()).pathname);
  });
  await page.reload();
  await expect(page.locator(".welcome")).toBeVisible();
  // Disabled/enabled transitions should reinstall under the current version too.
  await page.goto("/#/labs");
  await page.locator('[data-plugin="tts"]').uncheck();
  await expect(page.locator("#plugin-save")).toContainText("已保存并生效");
  await page.locator('[data-plugin="tts"]').check();
  await expect(page.locator("#plugin-save")).toContainText("已保存并生效");
  expect(imported.length).toBeGreaterThan(0);
  expect(imported.every((path) => path.startsWith(prefix))).toBeTruthy();
  await page.getByRole("link", { name: "AI 与语音 ↗", exact: true }).click();
  await expect(page.locator("#ai-text-form")).toBeVisible();
  const headers = await request.get("/");
  expect(headers.headers()["cache-control"]).toContain("no-store");
  await testInfo.attach("asset-version.json", {
    body: JSON.stringify({ entry, prefix, imported }, null, 2),
    contentType: "application/json",
  });
});
