import { pageCount, readerDefaults } from "./reader-helpers.js";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => readerDefaults(page));

const provider = `http://127.0.0.1:${process.env.WR_E2E_PROVIDER_PORT || "18768"}`;

const sampleText = [
  "The doctrine, which reveals its origin, shapes the entire argument. It remains central to modern theology.",
  "It is clear that the reasoning of these two men did not carry conviction, since it was felt that the fact that we know things only in their relations does not mean that the knowledge so acquired is merely a relative or unreal knowledge.",
].join("\n\n");

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

async function create(request, text = sampleText) {
  return (
    await request.post("/api/documents", {
      data: { title: "Grammar mode prototype", text },
    })
  ).json();
}

async function read(page, id) {
  await page.goto("/#/read/" + id);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
}

async function grammarCalls(request) {
  const value = await (await request.get(provider + "/observed")).json();
  return value.chat.filter((v) => v.task === "grammar-map");
}

test("grammar mode defaults off, prefetches window on toggle, and shows clause attribution & cross-sentence it reference on hover", async ({
  page,
  request,
}, info) => {
  await enableAI(request);
  const before = (await grammarCalls(request)).length;
  const doc = await create(request);
  await read(page, doc.id);

  // Off by default: zero AI calls and hovering does not show hover card or highlights.
  const toggle = page.locator("[data-grammar-mode-toggle]");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-grammar-window]")).toBeHidden();
  await page.locator('.source-unit[data-word="which"]').first().hover();
  await expect(page.locator(".grammar-hover-card")).toBeHidden();
  await expect(page.locator(".linked-grammar")).toHaveCount(0);
  expect((await grammarCalls(request)).length).toBe(before);

  // One-click toggle ON: window selector appears, background prefetch completes.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-grammar-window]")).toBeVisible();
  await expect(page.locator("[data-grammar-window]")).toHaveValue("1");
  await expect(page.locator("[data-grammar-mode-status]")).toContainText(
    "已就绪 3/3",
  );
  const afterPrefetch = (await grammarCalls(request)).length;
  expect(afterPrefetch - before).toBe(3);

  // Hover `which`: highlights clause and modified head (`The doctrine`), shows hover card.
  await page.locator('.source-unit[data-word="which"]').first().hover();
  const card = page.locator(".grammar-hover-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("从句修饰");
  await expect(card).toContainText("修饰对象");
  await expect(card).toContainText("The doctrine");
  await expect(page.locator(".linked-grammar")).not.toHaveCount(0);
  await expect(page.locator(".linked-grammar-target")).not.toHaveCount(0);

  // Hover `that` appositive clause: highlights clause and modified head (`the fact`).
  await page.locator('.source-unit[data-word="we"]').first().hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText("从句修饰");
  await expect(card).toContainText("修饰对象");
  await expect(card).toContainText("the fact");

  // Hover cross-sentence referential `It`: highlights `It` + `The doctrine` in the PRIOR sentence!
  await page.locator('.source-unit[data-word="It"]').first().hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText("代词回指");
  await expect(card).toContainText("回指先行词");
  await expect(card).toContainText("The doctrine");
  await expect(page.locator(".linked-reference")).not.toHaveCount(0);
  const targetTexts = await page
    .locator(".linked-grammar-target")
    .allTextContents();
  expect(targetTexts.join(" ")).toContain("The");
  expect(targetTexts.join(" ")).toContain("doctrine");

  await info.attach("grammar-mode-cross-sentence-it.png", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });

  // Hover formal `It` in second paragraph: explicitly states formal subject, NO target highlight.
  await page.locator('.source-unit[data-word="It"]').nth(1).hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText("形式主语，无先行词");
  await expect(page.locator(".linked-grammar-target")).toHaveCount(0);

  // Toggle OFF: hides hover card/highlights and disables hover inspection.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(card).toBeHidden();
  await expect(page.locator(".linked-grammar")).toHaveCount(0);
  await expect(page.locator(".linked-grammar-target")).toHaveCount(0);
  await page.locator('.source-unit[data-word="which"]').first().hover();
  await expect(card).toBeHidden();

  // Re-enabling hits cache with zero extra AI calls.
  await toggle.click();
  await expect(page.locator("[data-grammar-mode-status]")).toContainText(
    "已就绪 3/3",
  );
  expect((await grammarCalls(request)).length).toBe(afterPrefetch);
});

test("multi-page window selector scopes prefetch to current page (±0) vs adjacent pages (±1)", async ({
  page,
  request,
}) => {
  await enableAI(request);
  const longText = Array.from(
    { length: 40 },
    (_, i) =>
      `Paragraph ${i + 1} states that the doctrine shapes the debate in section ${i + 1}. It remains central to every careful reader of theology in chapter ${i + 1}.`,
  ).join("\n\n");
  const doc = await create(request, longText);
  await page.goto("/#/read/" + doc.id);
  await page.evaluate(() => {
    localStorage.setItem("wr2:page-layout", '"single"');
    localStorage.setItem("wr2:grammar-mode-window", "0");
  });
  await page.reload();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  expect(await pageCount(page)).toBeGreaterThanOrEqual(4);

  const before = (await grammarCalls(request)).length;
  const toggle = page.locator("[data-grammar-mode-toggle]");
  const select = page.locator("[data-grammar-window]");
  await toggle.click();
  await expect(select).toHaveValue("0");
  await expect(page.locator("[data-grammar-mode-status]")).toContainText(
    "已就绪",
  );
  const afterWindow0 = (await grammarCalls(request)).length - before;
  expect(afterWindow0).toBeGreaterThan(0);
  expect(afterWindow0).toBeLessThan(80);

  // Expand window to ±1 page: fetches only newly-included pages, reusing cached current page.
  await select.selectOption("1");
  await expect(page.locator("[data-grammar-mode-status]")).toContainText(
    "已就绪",
  );
  const afterWindow1 = (await grammarCalls(request)).length - before;
  expect(afterWindow1).toBeGreaterThan(afterWindow0);
  expect(afterWindow1).toBeLessThan(80);
});

test("turning grammar mode off mid-flight cancels remaining prefetch and stops new paid calls", async ({
  page,
  request,
}) => {
  await enableAI(request, "slow-assist");
  const manySentences = Array.from(
    { length: 8 },
    (_, i) =>
      `Sentence ${i + 1} states that the doctrine holds in section ${i + 1}.`,
  ).join(" ");
  const doc = await create(request, manySentences);
  await read(page, doc.id);

  const before = (await grammarCalls(request)).length;
  const toggle = page.locator("[data-grammar-mode-toggle]");
  await toggle.click();
  await expect(page.locator("[data-grammar-mode-status]")).toContainText(
    "分析中",
  );

  // Turn off immediately while the first batch of <=3 is in flight.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(1600);

  // At most the initial concurrency batch (<=3) could have hit the provider;
  // remaining queued sentences must never be dispatched, and cancelled ones must not persist.
  const totalCalls = (await grammarCalls(request)).length - before;
  expect(totalCalls).toBeLessThanOrEqual(3);
  const saved = await (
    await request.get(`/api/documents/${doc.id}/assists`)
  ).json();
  expect(saved).toEqual([]);
});
