import {
  chapter,
  tools,
  focus,
  home,
  density,
  pageIndex,
  pageCount,
  goPage,
  readerDefaults,
  selectParagraph as selectCurrent,
} from "./reader-helpers.js";
import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => readerDefaults(page));
import fs from "node:fs";
const original = fs.readFileSync("web/grammar-sample.txt", "utf8");
const sentence = original.split("\n\n")[0];
const provider = `http://127.0.0.1:${process.env.WR_E2E_PROVIDER_PORT || "18768"}`;
async function enableAI(request, model = "e2e-model") {
  await request.put("/api/ai/config", {
    data: {
      text: {
        enabled: true,
        base_url: provider + "/v1",
        model,
        api_key: "e2e-no-secret",
      },
    },
  });
}
async function create(request, text = original) {
  return (
    await request.post("/api/documents", {
      data: { title: "V3 immersion acceptance", text },
    })
  ).json();
}
async function read(page, id) {
  await page.goto("/#/read/" + id);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
}
async function calls(request, task) {
  const value = await (await request.get(provider + "/observed")).json();
  return value.chat.filter((v) => v.task === task);
}
async function selectParagraph(page) {
  await selectCurrent(page);
}
async function chooseRange(page, first, last) {
  await page
    .locator(`[data-word="${first}"]`)
    .first()
    .evaluate((el, last) => {
      const end = [
        ...el.closest("[data-block]").querySelectorAll("[data-word]"),
      ].find((n) => n.dataset.word === last);
      const range = document.createRange();
      range.setStart(el.firstChild, 0);
      range.setEnd(end.firstChild, end.firstChild.textContent.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, last);
  await expect(page.locator("#reading-selection")).toBeVisible();
}
test.beforeEach(async ({ request, page }) => {
  page.__v3errors = [];
  page.on("pageerror", (e) => page.__v3errors.push(e.message));
  page.on("console", (m) => {
    if (m.text().includes("Optional feature failed"))
      page.__v3errors.push(m.text());
  });
  const catalog = await (await request.get("/api/plugins")).json();
  for (const plugin of catalog.plugins)
    await request.patch("/api/plugins/" + plugin.id, {
      data: { enabled: true },
    });
  await request.patch("/api/profile", {
    data: { density: 0, vocab_size: 8000, l1_enabled: true },
  });
  await request.put("/api/ai/config", {
    data: {
      text: { enabled: false },
      speech: {
        enabled: false,
        mode: "browser",
        voice: "marin",
        local_voice: "Samantha",
      },
    },
  });
});
test.afterEach(async ({ page }) => expect(page.__v3errors).toEqual([]));

test("pagination reconstructs long source exactly; source anchors survive layout and page turns", async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const text =
    "😀 " +
    sentence +
    "\n\n" +
    Array(180)
      .fill("Relationships help us understand what knowledge can mean.")
      .join(" ") +
    "\n\nLast paragraph for precise navigation.";
  const d = await create(request, text);
  await read(page, d.id);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  const n = await pageCount(page);
  expect(n).toBeGreaterThan(2);
  const source = new Map(),
    fragments = [];
  for (let i = 0; i < n; i++) {
    await goPage(page, i);
    const parts = await page
      .locator("#article [data-block]")
      .evaluateAll((els) =>
        els.map((el) => {
          const copy = el.cloneNode(true);
          copy
            .querySelectorAll(".gloss,.bookmark-marker")
            .forEach((n) => n.remove());
          return {
            id: el.dataset.block,
            start: +el.dataset.start,
            end: +el.dataset.end,
            text: copy.textContent,
          };
        }),
      );
    for (const part of parts) {
      source.set(part.id, (source.get(part.id) || "") + part.text);
      fragments.push(part);
      expect(part.end - part.start).toBe(part.text.length);
    }
  }
  expect([...source.values()]).toEqual(d.blocks.map((b) => b.text));
  // The final page may begin in the preceding paragraph. Explicitly locate
  // the final paragraph before checking that exact source anchor survives.
  await tools(page, "search");
  await page.locator("#find-text").fill("Last paragraph");
  await expect(page.locator("#find-count")).toHaveText("1 / 1 处");
  await page.getByRole("button", { name: "关闭侧栏" }).click();

  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/documents/${d.id}/progress`)).json())
          .anchor?.block_id,
    )
    .toBe(d.blocks.at(-1).id);
  await page.reload();
  await expect(
    page.locator(`[data-block="${d.blocks.at(-1).id}"]`),
  ).toBeVisible();
  await tools(page, "typography");
  await page.locator("#type-size").fill("28");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(
    page.locator(`[data-block="${d.blocks.at(-1).id}"]`),
  ).toBeVisible();
  await info.attach("exact-pagination.json", {
    body: JSON.stringify({ pages: n, fragments }, null, 2),
    contentType: "application/json",
  });
});

test("partial selection translates only selected clause; grammar expands full sentence inline, cache reuses +", async ({
  page,
  request,
}, info) => {
  await enableAI(request);
  const before = await calls(request, "grammar-map");
  const d = await create(request);
  await read(page, d.id);
  expect((await calls(request, "grammar-map")).length).toBe(before.length);
  await expect(page.locator("[data-grammar-toggle]")).toHaveCount(0);
  await chooseRange(page, "The", "conviction");
  await page.locator('[data-selection-action="translation"]').click();
  await page.locator('[data-selection-action="grammar"]').click();
  await expect(page.locator("[data-pair]").first()).toBeVisible();
  await expect(page.locator('[data-grammar-node="main"]')).toBeVisible();
  const translations = await calls(request, "selection-translation"),
    grammars = await calls(request, "grammar-map");
  expect(translations.at(-1).source).toBe(
    "The reasoning of these two men did not carry conviction",
  );
  expect(grammars.at(-1).source).toBe(sentence);
  await expect(page.locator("#translation-pane .inline-grammar")).toHaveCount(
    0,
  );
  await expect(
    page.locator("[data-fragment] .inline-grammar:visible"),
  ).toHaveCount(1);
  const source = await page.locator("#article").boundingBox(),
    translation = await page.locator("#translation-pane").boundingBox();
  expect(translation.x).toBeGreaterThan(source.x + source.width);
  await page.locator("[data-pair]").first().hover();
  await expect(page.locator(".linked-translation")).not.toHaveCount(0);
  const beforeHoverPage = String(await pageIndex(page));
  await page.locator('.source-unit[data-word="it"]').first().hover();
  await expect(page.locator(".linked-grammar")).not.toHaveCount(0);
  await expect(page.locator(".grammar-detail")).toContainText(
    "不是指向某物的 it",
  );
  expect(String(await pageIndex(page))).toBe(beforeHoverPage);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  const pages = await pageCount(page);
  await page.locator("[data-grammar-slot] button").first().click();
  await page.locator("[data-grammar-slot] button").first().click();
  expect((await calls(request, "grammar-map")).length).toBe(grammars.length);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  expect(await pageCount(page)).toBe(pages);
  await chooseRange(page, "The", "conviction");
  await page.locator('[data-selection-action="notes"]').click();
  await expect(page.locator("#note-quote")).toHaveText(
    "The reasoning of these two men did not carry conviction",
  );
  await page.locator("#note-body").fill("只给选择的主干留下想法。");
  await expect(page.locator("#note-state")).toContainText("已保存");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.reload();
  await expect(page.locator('[data-grammar-node="main"]')).toBeVisible();
  expect((await calls(request, "grammar-map")).length).toBe(grammars.length);
  await info.attach("inline-grammar-and-translation.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

test("cancel requests has no late UI or saved result; malformed alignment and grammar fail safely", async ({
  page,
  request,
}, info) => {
  await enableAI(request, "slow-assist");
  const d = await create(request);
  await read(page, d.id);
  await selectParagraph(page);
  await page.locator('[data-selection-action="grammar"]').click();
  await page.locator("[data-grammar-cancel]").click();
  await page.locator('[data-selection-action="translation"]').click();
  await page.locator('[data-selection-action="translation"]').click();
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-grammar-toggle]")).toHaveCount(0);
  await expect(page.locator("#translation-pane")).toBeHidden();
  expect(
    await (await request.get(`/api/documents/${d.id}/assists`)).json(),
  ).toEqual([]);
  await enableAI(request, "bad-alignment");
  await page.locator('[data-selection-action="translation"]').click();
  await expect(page.locator("#reader-save")).toContainText("模型改动或遗漏");
  await expect(page.locator("#article")).toContainText("The reasoning");
  await enableAI(request, "bad-grammar");
  await page.locator('[data-selection-action="grammar"]').click();
  await expect(page.locator("#reader-save")).toContainText("语法层级循环");
  await expect(page.locator("[data-grammar-toggle]")).toHaveCount(0);
  expect(
    await (await request.get(`/api/documents/${d.id}/assists`)).json(),
  ).toEqual([]);
  await info.attach("invalid-assistance-still-readable.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("single-word IPA and AI context are explicit; selected text stays exact including ligatures", async ({
  page,
  request,
}, info) => {
  await enableAI(request);
  const d = await create(request);
  await read(page, d.id);
  const before = await calls(
    request,
    "anchored-usage-then-gloss-and-source-rendering",
  );
  await page.locator('[data-word="conviction"]').click();
  await expect(page.locator("[data-word-ipa]")).toBeVisible();
  expect(
    (await calls(request, "anchored-usage-then-gloss-and-source-rendering"))
      .length,
  ).toBe(before.length);
  await page
    .getByRole("button", { name: "解释这里的意思", exact: true })
    .click();
  await expect(page.locator(".context-result")).toContainText("令人信服");
  const actual = (
    await calls(request, "anchored-usage-then-gloss-and-source-rendering")
  ).at(-1);
  expect(actual.selected_text).toBe("conviction");
  expect(actual.nearby_excerpt.quote).toContain("did not carry conviction");
  expect(actual.focus_sources[0].marked_text).toContain("conviction");
  await page.getByRole("button", { name: "关闭注释" }).click();
  await page.locator('[data-word="Inﬁnite"]').click();
  await expect(page.locator(".annotation-pop h3")).toHaveText("Inﬁnite");
  await expect(page.locator(".annotation-pop .meaning")).not.toContainText(
    "夜间",
  );
  await info.attach("context-and-ipa.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("computer speech is preferred even with remote configured; playback is local and never displaces source", async ({
  page,
  request,
}, info) => {
  await request.put("/api/ai/config", {
    data: {
      speech: {
        enabled: true,
        base_url: provider + "/v1",
        api_key: "e2e-no-secret",
        model: "e2e-tts",
        mode: "local",
        voice: "marin",
      },
    },
  });
  const status = await (await request.get("/api/speech/status")).json();
  test.skip(
    !status.local.available,
    "macOS native speech requires an installed English voice",
  );
  const before = await (await request.get(provider + "/observed")).json();
  const d = await create(
    request,
    original +
      "\n\n" +
      Array(80).fill("Continue reading the source in its context.").join(" "),
  );
  await read(page, d.id);
  const old = await page.locator(".reader-page-caption").boundingBox();
  const evidence = [];
  page.on("response", (res) => {
    if (res.url().endsWith("/api/speech/local"))
      evidence.push({
        status: res.status(),
        engine: res.headers()["x-speech-engine"],
        cache: res.headers()["x-speech-cache"],
      });
  });
  await page
    .locator("#article .source-fragment")
    .filter({ has: page.locator("[data-read-block]") })
    .first()
    .hover();
  await page.locator("[data-read-block]").first().click();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-audio-state",
    "playing",
  );
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-speech-engine",
    "local",
  );
  expect(await page.locator(".reader-page-caption").boundingBox()).toEqual(old);
  await expect(page.locator("audio,#speech-player,#speech-state")).toHaveCount(
    0,
  );
  await expect(page.locator("#tool-panel")).toBeHidden();
  await page
    .locator("#article .source-fragment")
    .filter({ has: page.locator("[data-read-block]") })
    .first()
    .hover();
  await page.locator("[data-read-block]").first().click();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-audio-state",
    "stopped",
  );
  await page
    .locator("#article .source-fragment")
    .filter({ has: page.locator("[data-read-block]") })
    .first()
    .hover();
  await page.locator("[data-read-block]").first().click();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-audio-state",
    "playing",
  );
  await goPage(page, (await pageIndex(page)) + 1);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-audio-state",
    "stopped",
  );
  const after = await (await request.get(provider + "/observed")).json();
  expect(after.speech.length).toBe(before.speech.length);
  expect(evidence.every((v) => v.engine === "macos-local")).toBeTruthy();
  expect(evidence.at(-1).cache).toBe("hit");
  await info.attach("native-speech-evidence.json", {
    body: JSON.stringify({ evidence, voices: status.local.voices }, null, 2),
    contentType: "application/json",
  });
});

test("late-page note and bookmark keep source offsets after density, font, viewport and reload", async ({
  page,
  request,
}, info) => {
  const d = await create(
    request,
    Array(170)
      .fill(
        "A careful reader returns to the exact place where a useful idea appeared.",
      )
      .join(" "),
  );
  await read(page, d.id);
  await goPage(page, "2");
  const chosen = await page
    .locator("#article [data-word]")
    .first()
    .evaluate((el) => ({
      word: el.dataset.word,
      start: +el.dataset.sourceStart,
    }));
  await chooseRange(page, chosen.word, chosen.word);
  await page.locator('[data-selection-action="notes"]').click();
  await page.locator("#note-body").fill("页码变了，位置不应变。");
  await expect(page.locator("#note-state")).toContainText("已保存");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await chooseRange(page, chosen.word, chosen.word);
  await page.locator("[data-selection-more]").click();
  await page.locator('[data-selection-action="bookmarks"]').click();
  await expect(page.locator(".bookmark-marker")).toHaveCount(1);
  const notes = await (await request.get("/api/notes?doc_id=" + d.id)).json(),
    marks = await (await request.get("/api/bookmarks?doc_id=" + d.id)).json();
  expect(notes[0].anchor.start).toBe(chosen.start);
  expect(marks[0].anchor.start).toBe(chosen.start);
  await density(page, 8);
  await expect(page.locator("#reader-save")).toHaveText("辅助偏好已自动保存");
  await tools(page, "typography");
  await page.locator("#type-size").fill("28");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await page.goto("/#/bookmarks");
  await page.locator(`[data-bm="${marks[0].id}"]`).click();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  const fragment = await page
    .locator("#article [data-block]")
    .first()
    .evaluate((el) => ({ start: +el.dataset.start, end: +el.dataset.end }));
  expect(fragment.start).toBeLessThanOrEqual(chosen.start);
  expect(fragment.end).toBeGreaterThan(chosen.start);
  await expect(page.locator(".bookmark-marker")).toHaveCount(1);
  await focus(page);
  await page.locator(".bookmark-marker").click();
  await expect(page.locator(".bookmark-marker")).toHaveCount(0);
  expect(
    (await (await request.get("/api/notes?doc_id=" + d.id)).json())[0].anchor,
  ).toEqual(notes[0].anchor);
  await info.attach("anchor-after-reflow.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

test("whole-book traces include earlier chapters; confirmed AI review never changes original notes", async ({
  page,
  request,
}, info) => {
  await enableAI(request);
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await page.locator("#upload-file").setInputFiles("web/sample.epub");
  await expect(page.locator("#upload-state")).toContainText("已完整导入 2 章");
  await page.locator("#open-import").click();

  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  const id = +page.url().match(/read\/(\d+)/)[1];
  await selectCurrent(page);
  await page.locator('[data-selection-action="notes"]').click();
  await page.locator("#note-body").fill("第一章的原始想法必须保留。");
  await expect(page.locator("#note-state")).toContainText("已保存");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  const notes = await (await request.get("/api/notes?doc_id=" + id)).json();
  await tools(page, "outline");
  await chapter(page, 1);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await tools(page, "traces");
  await expect(page.locator(".trace-entries")).toContainText(
    "第一章的原始想法",
  );
  await page.locator("#review-generate").click();
  await expect(page.locator("#review-draft")).toBeVisible();
  await page
    .locator("#review-body")
    .fill("我确认后的回顾：复习第一章的原始想法。");
  await page.locator("#review-confirm").click();
  await expect(page.locator("#review-status")).toHaveText("回顾已确认保留");
  expect(await (await request.get("/api/notes?doc_id=" + id)).json()).toEqual(
    notes,
  );
  await page.reload();
  await tools(page, "traces");
  await expect(page.locator("#review-body")).toHaveValue(
    "我确认后的回顾：复习第一章的原始想法。",
  );
  const reviewBefore = await (
    await request.get(`/api/documents/${id}/review`)
  ).json();
  await enableAI(request, "slow-assist");
  await page.locator("#review-generate").click();
  await page.locator("#review-generate").click();
  await expect(page.locator("#review-status")).toHaveText("已取消整理");
  await page.waitForTimeout(1500);
  expect(
    await (await request.get(`/api/documents/${id}/review`)).json(),
  ).toEqual(reviewBefore);
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await tools(page, "traces");
  await expect(page.locator("#review-body")).toHaveValue(
    "我确认后的回顾：复习第一章的原始想法。",
  );
  await info.attach("book-review-keeps-raw-traces.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("grammar switch removes interaction but preserves records; small dark layout retains translation and structure", async ({
  page,
  request,
}, info) => {
  await enableAI(request);
  const d = await create(request);
  await read(page, d.id);
  await selectParagraph(page);
  await page.locator('[data-selection-action="grammar"]').click();
  await expect(page.locator('[data-grammar-node="main"]')).toBeVisible();
  const records = await (
    await request.get(`/api/documents/${d.id}/assists`)
  ).json();
  await request.patch("/api/plugins/grammar", { data: { enabled: false } });
  await page.reload();
  await selectParagraph(page);
  await expect(
    page.locator('[data-selection-action="grammar"],[data-grammar-toggle]'),
  ).toHaveCount(0);
  expect(
    (
      await request.post(`/api/documents/${d.id}/grammar`, {
        data: { anchor: records[0].anchor },
      })
    ).status(),
  ).toBe(404);
  await request.patch("/api/plugins/grammar", { data: { enabled: true } });
  await page.reload();
  await expect(page.locator('[data-grammar-node="main"]')).toBeVisible();
  expect(
    await (await request.get(`/api/documents/${d.id}/assists`)).json(),
  ).toEqual(records);
  await chooseRange(page, "The", "conviction");
  await page.locator('[data-selection-action="translation"]').click();
  await expect(page.locator("[data-pair]").first()).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "night";
  });
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await expect(
    page.locator("[data-fragment] .inline-grammar:visible"),
  ).toHaveCount(1);
  await expect(page.locator("#translation-pane")).toBeVisible();
  await info.attach("320px-dark-reading.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});
