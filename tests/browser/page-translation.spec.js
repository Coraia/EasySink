import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
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

async function importPDF(request, name, count) {
  const capability = await (await request.get("/api/pdf/capabilities")).json();
  test.skip(!capability.adapters?.some(engine => engine.id === "digital" && engine.available), "local digital PDF worker unavailable");
  const buffer = execFileSync(".venv/bin/python", ["-c",
    "import sys; sys.path.insert(0, 'tests'); from pdf_prose_fixture import pdf_fixture; sys.stdout.buffer.write(pdf_fixture(sys.argv[1]))", name]);
  const response = await request.post("/api/pdf/imports", {multipart: {
    engine: "digital", file: {name: name + ".pdf", mimeType: "application/pdf", buffer},
  }});
  expect(response.ok()).toBeTruthy();
  const {book_id} = await response.json();
  const book = async () => (await request.get(`/api/pdf/books/${book_id}`)).json();
  await expect.poll(async () => (await book()).pdf.ready_pages).toBe(count);
  return book();
}

test("PDF reader keeps furniture separate, restores roles, and aligns translation across source ranges", async ({page, request}) => {
  const book = await importPDF(request, "range-edge", 9);
  const [left, right] = book.pdf.ranges;
  await configure(request, "slow-assist");
  await read(page, right.doc_id);
  const header = page.locator("#article .pdf-page-furniture").getByRole("button", {name: "ODD ARCHIVE"});
  await expect(header).toBeVisible();
  await expect(page.locator("#article [data-block]").filter({hasText: "ODD ARCHIVE"})).toHaveCount(0);
  const prose = page.locator("#article .reading-prose").first();
  await expect(prose).toHaveText(/ODD ARCHIVE.*to the laboratory.*RESEARCH DIVISION COPY\s*9/s);
  const bounds = await prose.evaluate(node => {
    const footer = node.querySelector(".pdf-page-furniture-bottom").getBoundingClientRect();
    const caption = document.querySelector(".reader-page-caption").getBoundingClientRect();
    return {gap: footer.top - node.querySelector("[data-block]").getBoundingClientRect().bottom,
      inset: caption.top - footer.bottom};
  });
  expect(bounds.gap).toBeGreaterThan(70);
  expect(bounds.inset).toBeGreaterThanOrEqual(0);
  expect(bounds.inset).toBeLessThan(35);
  await header.click();
  await page.getByRole("button", {name: "保留在正文", exact: true}).click();
  const promoted = page.locator("#article [data-block]").filter({hasText: "ODD ARCHIVE"});
  await expect(promoted).toBeVisible();
  await promoted.hover();
  const row = page.locator("#article .source-fragment").filter({
    has: page.locator("[data-block]").filter({hasText: "ODD ARCHIVE"}),
  });
  await row.getByRole("button", {name: "正文分类"}).click();
  await page.getByRole("button", {name: "恢复自动判断", exact: true}).click();
  await expect(header).toBeVisible();
  const before = (await calls(request)).length;
  await toggle(page).click();
  await expect.poll(async () => (await calls(request)).length).toBeGreaterThan(before);
  const callsOnPDF = (await calls(request)).slice(before).flatMap(call => call.paragraphs);
  expect(callsOnPDF.some(unit => unit.source.includes("remaining material to the laboratory"))).toBe(true);
  expect(callsOnPDF.every(unit => !unit.source.includes("ARCHIVE") && !unit.source.includes("DIVISION COPY"))).toBe(true);
  const translationButton = page.locator("[data-page-pair]").first();
  await expect(translationButton).toBeVisible();
  await translationButton.hover();
  await expect(page.locator("#article .linked-translation").first()).toBeVisible();
  expect(left.doc_id).not.toBe(right.doc_id);
  const translated = (await calls(request)).length;
  await header.click();
  await page.getByRole("button", {name: "保留在正文", exact: true}).click();
  await expect(promoted).toBeVisible();
  await expect(status(page)).toHaveText("正文已更新；如需翻译，请关闭再开启整本翻译。");
  await expect(page.locator("[data-page-translation-progress]")).toBeHidden();
  expect((await calls(request)).length).toBe(translated);
  await promoted.hover();
  await row.getByRole("button", {name: "正文分类"}).click();
  await page.getByRole("button", {name: "恢复自动判断", exact: true}).click();
  await expect(header).toBeVisible();
});

test("PDF furniture stays on the first and last fragments when a source page splits", async ({page, request}) => {
  const book = await importPDF(request, "range-edge", 9);
  await page.addInitScript(() => localStorage.setItem("wr2:typography",
    JSON.stringify({size: 30, line: 2, width: 660, font: "serif"})));
  await page.setViewportSize({width: 440, height: 420});
  await read(page, book.pdf.ranges[1].doc_id);
  const top = page.locator("#article .pdf-page-furniture-top");
  const bottom = page.locator("#article .pdf-page-furniture-bottom");
  const source = page.locator("#article [data-block]");
  await expect(top).toHaveText("ODD ARCHIVE");
  await expect(bottom).toHaveCount(0);
  const id = await source.getAttribute("data-block");
  const split = await source.getAttribute("data-end");
  await goPage(page, 1);
  await expect(top).toHaveCount(0);
  await expect(source).toHaveAttribute("data-block", id);
  await expect(source).toHaveAttribute("data-start", split);
  await expect(bottom).toHaveText(/RESEARCH DIVISION COPY\s*9/);
  await goPage(page, 0);
  await expect(top).toHaveText("ODD ARCHIVE");
  await expect(bottom).toHaveCount(0);
});

test("PDF reader displays evidence-backed native line repairs", async ({page, request}) => {
  const book = await importPDF(request, "line-break", 1);
  await read(page, book.pdf.reading_doc_id);
  const body = page.locator("#article .reading-prose");
  await expect(body).toContainText("carefully prepared the instruments");
  await expect(body).toContainText("the location was marked");
  await expect(body).toContainText("in side pockets");
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
  await expect(translation(page).getByRole("progressbar")).toBeVisible();
  await expect(page.locator("#article")).toContainText("Line1");
  await expect.poll(async () => (await calls(request)).length).toBe(before + 1);
  const batch = (await calls(request))[before].paragraphs;
  await expect(status(page)).toContainText(`本批 ${batch.length} 段，模型处理中`);
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

test("a partially successful batch saves valid paragraphs and retries just the selected failure", async ({page, request}) => {
  await configure(request, "partial-page");
  const before = (await calls(request)).length;
  const doc = await sample(request, ["Alpha remained readable.", "Birch was translated.", "Cedar was translated."].join("\n\n"));
  await read(page, doc.id);
  await toggle(page).click();
  const retry = page.getByRole("button", {name: "重试第 1 段"});
  await expect(retry).toBeVisible();
  const batch = (await calls(request))[before].paragraphs;
  await expect(status(page)).toHaveText("本页已完成 2 / 3 段 · 1 段未完成");
  await expect(translation(page)).toContainText("译文 1：Birch");
  await expect(translation(page)).toContainText("译文未能与原文完整对齐");
  await page.reload();
  await toggle(page).click();
  await expect(retry).toBeVisible();
  expect((await calls(request)).length).toBe(before + 1);
  await configure(request, "e2e-model");
  await retry.click();
  await expect(translation(page)).toContainText("译文 1：Alpha");
  await expect(translation(page)).toContainText("译文 1：Birch");
  await expect(retry).toBeHidden();
  expect((await calls(request))[before + 1].paragraphs).toEqual(batch.slice(0, 1));
});

test("leaving the reader and reopening an active batch does not resend it", async ({page, request}) => {
  await configure(request, "slow-assist");
  const before = (await calls(request)).length;
  const doc = await sample(request, [longParagraph, ...otherParagraphs].join("\n\n"));
  await read(page, doc.id);
  await toggle(page).click();
  await expect.poll(async () => (await calls(request)).length).toBe(before + 1);
  await page.reload();
  await toggle(page).click();
  await expect(translation(page)).toContainText("译文 1：Line1");
  await goPage(page, 1);
  await goPage(page, 0);
  await expect(translation(page)).toContainText("译文 1：Line1");
  expect((await calls(request)).length).toBe(before + 1);
});

test("surfaces the provider rate limit without resending", async ({page, request}) => {
  await configure(request, "page-rate-limit");
  const before = (await calls(request)).length;
  const doc = await sample(request, "A quiet reading page.");
  await read(page, doc.id);
  await toggle(page).click();
  await expect(translation(page)).toContainText("AI 服务额度或频率已达上限");
  await expect(translation(page).getByRole("progressbar")).toBeHidden();
  expect((await calls(request)).length).toBe(before + 1);
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
