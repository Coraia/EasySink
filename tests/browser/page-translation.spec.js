import { test, expect } from "@playwright/test";
import { goPage, read, readerDefaults, selectParagraph } from "./reader-helpers.js";

const provider = `http://127.0.0.1:${process.env.WR_E2E_PROVIDER_PORT || "18768"}`;
const toggle = page => page.getByRole("button", {name: "整本翻译", exact: true});
const translation = page => page.locator("[data-page-translation]");
const status = page => page.locator("[data-page-translation-status]");
const sentence = "The reader recalled the bright morning and walked into the quiet village.";
const longParagraph = Array.from({length: 35}, (_, i) => `Line${i + 1} ${sentence}`).join(" ");
const otherParagraphs = Array.from({length: 24}, (_, i) => `Paragraph${i + 1} ${(sentence + " ").repeat(6).trim()}`);

async function configure(request, model) {
  expect((await request.put("/api/ai/config", {data: {text: {
    enabled: true, base_url: provider + "/v1", model, api_key: "e2e-no-secret",
  }}})).ok()).toBeTruthy();
}
async function calls(request) {
  const body = await (await request.get(provider + "/observed")).json();
  return body.chat.filter(call => call.task === "page-translation");
}
async function sample(request, text) {
  return (await request.post("/api/documents", {data: {title: "Page translation fixture", text}})).json();
}

test.beforeEach(async ({page}) => {
  await readerDefaults(page);
  await page.setViewportSize({width: 1060, height: 760});
});

test("reads a cross-page paragraph once, buffers ahead, and preserves selection translation", async ({page, request}) => {
  await configure(request, "slow-assist");
  const before = (await calls(request)).length;
  const doc = await sample(request, [longParagraph, ...otherParagraphs].join("\n\n"));
  await read(page, doc.id);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".caption-end [data-grammar-mode-toggle]")).toBeVisible();
  await expect(translation(page)).toBeHidden();
  expect((await calls(request)).length).toBe(before);

  await toggle(page).click();
  await expect(status(page)).toContainText("仍可继续阅读原文");
  await expect(page.locator("#article")).toContainText("Line1");
  await expect.poll(async () => (await calls(request)).length).toBe(before + 1);
  const batch = (await calls(request))[before].paragraphs;
  expect(batch.filter(unit => unit.source.includes("Line1 ")).map(unit => unit.source)).toEqual([longParagraph]);
  await expect(translation(page)).toContainText("译文 1：Line1");
  await goPage(page, 1);
  await expect(translation(page)).not.toContainText("译文 1：Line1");
  await expect(translation(page)).toContainText(/译文 \d+：Line/);
  expect((await calls(request)).length).toBe(before + 1);

  await goPage(page, 0);
  await expect(translation(page)).toContainText("译文 1：Line1");
  await selectParagraph(page);
  await page.locator("[data-selection-action=translation]").click();
  await expect(page.locator("[data-selection-translation]")).toContainText("回到选区");
  await expect(translation(page)).toBeHidden();
  await page.getByRole("button", {name: "收起对照译文"}).click();
  await expect(translation(page)).toBeVisible();
  expect((await calls(request)).length).toBe(before + 1);
  for (let index = 2; index <= 5 && (await calls(request)).length === before + 1; index++) {
    await goPage(page, index);
    if ((await calls(request)).length === before + 1)
      await page.waitForLoadState("networkidle");
  }
  await expect.poll(async () => (await calls(request)).length).toBe(before + 2);
  const refill = (await calls(request))[before + 1].paragraphs;
  expect(refill.every(unit => batch.every(prior => prior.source !== unit.source))).toBe(true);
  await expect(status(page)).toHaveText("");
});

test("a failed batch is not retried automatically and replays from a later page", async ({page, request}) => {
  await configure(request, "bad-alignment");
  const before = (await calls(request)).length;
  const doc = await sample(request, otherParagraphs.join("\n\n"));
  await read(page, doc.id);
  await toggle(page).click();
  const retry = page.getByRole("button", {name: "重试这一批"});
  await expect(retry).toBeVisible();
  const batch = (await calls(request))[before].paragraphs;
  expect(batch.length).toBeGreaterThan(2);
  await goPage(page, 1);
  await expect(retry).toBeVisible();
  expect((await calls(request)).length).toBe(before + 1);
  await configure(request, "e2e-model");
  await retry.click();
  await expect(translation(page)).toContainText("测试段落译文");
  expect((await calls(request))[before + 1].paragraphs).toEqual(batch);
  await goPage(page, 0);
  await expect(translation(page)).toContainText("Paragraph1");
});

test("disabling during a request stops prefetch and reopening uses the saved translation", async ({page, request}) => {
  await configure(request, "slow-assist");
  const before = (await calls(request)).length;
  const doc = await sample(request, otherParagraphs.join("\n\n"));
  await read(page, doc.id);
  const done = page.waitForResponse(res => res.url().endsWith("/page-translation") && res.request().postDataJSON().generate);
  await toggle(page).click();
  await expect.poll(async () => (await calls(request)).length).toBe(before + 1);
  await toggle(page).click();
  await expect(translation(page)).toBeHidden();
  await done;
  await goPage(page, 1);
  await goPage(page, 0);
  expect((await calls(request)).length).toBe(before + 1);
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await toggle(page).click();
  await expect(translation(page)).toContainText("Paragraph1");
  expect((await calls(request)).length).toBe(before + 1);
});

test("prefetches across a chapter boundary and shows only the new chapter's translation", async ({page, request}) => {
  await configure(request, "e2e-model");
  const book = await (await request.post("/api/library/books", {data: {title: "Translation chapters"}})).json();
  const first = await sample(request, "Evening settled over the first chapter.");
  const secondSource = "Morning welcomed the second chapter.";
  const second = await sample(request, secondSource);
  for (const doc of [first, second])
    expect((await request.post(`/api/library/books/${book.id}/adopt/${doc.id}`)).ok()).toBe(true);
  const before = (await calls(request)).length;
  await read(page, first.id);
  await toggle(page).click();
  await expect(translation(page)).toContainText("译文 1：Evening");
  expect((await calls(request))[before].paragraphs.map(unit => unit.source)).toContain(secondSource);
  await page.locator("#reading-edge-next").click();
  await expect(page.locator(".reader")).toHaveAttribute("data-document-id", String(second.id));
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(translation(page)).toContainText("译文 1：Morning");
  await expect(translation(page)).not.toContainText("Evening");
  expect((await calls(request)).length).toBe(before + 1);
});

test("switching back to a two-page spread keeps the same visible source start", async ({page, request}) => {
  await configure(request, "e2e-model");
  await page.setViewportSize({width: 1440, height: 900});
  await page.addInitScript(() => localStorage.setItem("wr2:page-layout", JSON.stringify("double")));
  const doc = await sample(request, [longParagraph, ...otherParagraphs].join("\n\n"));
  await read(page, doc.id);
  const reader = page.locator(".reader");
  await expect(reader).toHaveAttribute("data-page-layout", "double");
  await toggle(page).click();
  await goPage(page, 2);
  const start = () => page.locator("#article .reading-prose [data-block]").first()
    .evaluate(node => [node.dataset.block, +node.dataset.start]);
  const previous = await start();
  expect(previous[0] !== doc.blocks[0].id || previous[1] > 0).toBe(true);
  await toggle(page).click();
  await expect(translation(page)).toBeHidden();
  await expect(reader).toHaveAttribute("data-page-layout", "double");
  await expect.poll(start).toEqual(previous);
});
