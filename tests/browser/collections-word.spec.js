import { test, expect } from "@playwright/test";
import { enableAll, read, readerDefaults } from "./reader-helpers.js";

const provider = `http://127.0.0.1:${process.env.WR_E2E_PROVIDER_PORT || "18768"}`;

test.beforeEach(async ({ page, request }) => {
  await readerDefaults(page);
  await enableAll(request);
  await request.patch("/api/profile", {
    data: { density: 0, vocab_size: 8000, l1_enabled: false },
  });
  page.__collectionErrors = [];
  page.on("pageerror", (error) => page.__collectionErrors.push(error.message));
  page.on("console", (message) => {
    if (/Optional feature failed|^Plugin /.test(message.text()))
      page.__collectionErrors.push(message.text());
  });
});

test.afterEach(async ({ page, request }, info) => {
  try {
    await info.attach("reader-state.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(page.__collectionErrors).toEqual([]);
  } finally {
    const response = await request.put("/api/ai/config", {
      data: { text: { enabled: false, clear_key: true } },
    });
    expect(response.ok()).toBeTruthy();
    const config = await response.json();
    expect(config.text).toMatchObject({
      enabled: false, has_api_key: false, available: false,
    });
    const profile = await (await request.get("/api/profile")).json();
    expect(profile.l1_available).toBe(false);
    await info.attach("shared-ai-cleanup.json", {
      body: JSON.stringify({ text: config.text, l1_available: profile.l1_available }, null, 2),
      contentType: "application/json",
    });
  }
});

test("the source dictionary card opens a phrase member without changing the phrase or saving it", async ({
  page,
  request,
}, info) => {
  await request.patch("/api/profile", { data: { density: 15 } });
  const doc = await (await request.post("/api/documents", {
    data: {
      title: "Phrase member reading acceptance",
      text: "We wanted to break the ice before the conversation began.",
    },
  })).json();
  await read(page, doc.id);
  const phrase = page.locator('#article .annotation[data-kind="phrase"]');
  await expect(phrase).toContainText("break the ice");
  await phrase.click();
  await expect(page.locator(".annotation-pop h3")).toHaveText("break the ice");
  const dictionary = page.locator(".annotation-pop .dictionary-candidates");
  await expect(dictionary).toBeVisible();
  await expect(dictionary).toContainText("通用候选");
  await dictionary.getByText("单独查词", { exact: true }).click();
  await dictionary.getByRole("button", { name: "ice", exact: true }).click();
  await expect(page.locator(".annotation-pop h3")).toHaveText("ice");
  await expect(page.locator(".annotation-pop .dictionary-candidates")).toBeVisible();
  await expect(page.locator("[data-collection-word]")).toHaveText("收藏词语");
  await page.getByRole("button", { name: "关闭注释", exact: true }).click();
  await expect(phrase).toContainText("break the ice");
  const state = await (await request.get(`/api/collections/state/${doc.id}`)).json();
  expect(state.items).toEqual([]);
  expect(state.feedback).toEqual([]);
  await info.attach("phrase-member-state.json", {
    body: JSON.stringify(state, null, 2),
    contentType: "application/json",
  });
});

test("adopting an unsaved word updates only its occurrence, undo restores it, and personal meaning stays independent", async ({
  page,
  request,
}, info) => {
  await request.put("/api/ai/config", {
    data: { text: {
      enabled: true,
      base_url: provider + "/v1",
      model: "e2e-model",
      api_key: "e2e-no-secret",
    } },
  });
  const doc = await (await request.post("/api/documents", {
    data: {
      title: "Independent adopted explanation acceptance",
      text: "The reasoning did not carry conviction, since knowledge is acquired in relations.\n\nShe spoke with conviction about the future.",
    },
  })).json();
  await read(page, doc.id);
  const occurrences = page.locator('#article [data-word="conviction"]');
  await expect(occurrences).toHaveCount(2);
  await occurrences.nth(1).click();
  await expect(page.locator(".annotation-pop .dictionary-candidates")).toBeVisible();
  const otherDictionary = await page.locator(".annotation-pop .dictionary-candidates").innerText();
  await page.getByRole("button", { name: "关闭注释", exact: true }).click();
  await occurrences.first().click();
  await expect(page.locator(".annotation-pop .dictionary-candidates")).toBeVisible();
  await page.locator("[data-retained]").click();
  await expect(page.locator("[data-retained]")).toHaveText("已保留注释 ✓");
  const retained = page.locator('#article [data-target="conviction"]');
  await expect(retained).toHaveCount(1);
  const isolationChecks = [];
  const verifyOtherOccurrence = async (phase) => {
    if (await page.locator(".annotation-pop").isVisible())
      await page.getByRole("button", { name: "关闭注释", exact: true }).click();
    await expect(occurrences).toHaveCount(2);
    await occurrences.nth(1).click();
    await expect(page.locator(".annotation-pop h3")).toHaveText("conviction");
    await expect(page.getByRole("button", { name: "解释这里的意思", exact: true })).toBeEnabled();
    await expect(page.locator(".collections-current-meaning")).toBeHidden();
    await expect(page.locator("[data-context-adopt]")).toBeHidden();
    await expect(page.locator(".annotation-pop .dictionary-candidates")).toHaveText(otherDictionary, { useInnerText: true });
    isolationChecks.push({ phase, occurrence: 2, dictionary: otherDictionary, adopted: false });
    await info.attach(`other-occurrence-${phase}.png`, {
      body: await page.screenshot(), contentType: "image/png",
    });
    await page.getByRole("button", { name: "关闭注释", exact: true }).click();
    await retained.click();
    await expect(page.locator(".collections-current-meaning")).toContainText("令人信服");
    await expect(page.getByRole("button", { name: "已用于此处释义 ✓", exact: true })).toBeDisabled();
    await expect(retained.locator(".gloss")).toHaveText("令人信服");
  };
  const originalGloss = await retained.locator(".gloss").innerText();
  await page.getByRole("button", { name: "解释这里的意思", exact: true }).click();
  await expect(page.locator(".context-result")).toContainText("令人信服");
  await page.getByRole("button", { name: "用于此处释义", exact: true }).click();
  await expect(retained.locator(".gloss")).toHaveText("令人信服");
  await expect(page.locator(".collections-current-meaning")).toContainText("令人信服");
  await expect(page.locator("[data-collection-word]")).toHaveText("收藏词语");
  let state = await (await request.get(`/api/collections/state/${doc.id}`)).json();
  expect(state.items).toEqual([]);
  expect(state.feedback).toHaveLength(1);
  expect(state.feedback[0].understood).not.toBe(true);
  await page.locator("#toast").getByRole("button", { name: "撤销", exact: true }).click();
  await expect(retained.locator(".gloss")).toHaveText(originalGloss);
  // Undo is outside the word card, so the reader closes that card on pointerdown.
  await retained.click();
  await expect(page.locator(".collections-current-meaning")).toBeHidden();
  await page.getByRole("button", { name: "用于此处释义", exact: true }).click();
  await expect(retained.locator(".gloss")).toHaveText("令人信服");
  await verifyOtherOccurrence("after-readoption");
  await page.locator("[data-collection-word]").click();
  await expect(page.locator("[data-collection-word]")).toHaveText("已收藏词语 ✓");
  await page.getByRole("button", { name: "我的释义 / 已存解释", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "收藏详情", exact: true });
  await editor.getByRole("textbox", { name: "我的释义", exact: true }).fill("我的理解：论证产生的说服力。");
  await expect(editor.locator("[data-save-status]")).toHaveText("已保存");
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await retained.click();
  await page.getByRole("button", { name: "我的释义 / 已存解释", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "我的释义", exact: true })).toHaveValue("我的理解：论证产生的说服力。");
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await retained.click();
  await page.locator("[data-collection-word]").click();
  await expect(page.locator("[data-collection-word]")).toHaveText("收藏词语");
  await expect(retained.locator(".gloss")).toHaveText("令人信服");
  await page.reload();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await expect(retained).toHaveCount(1);
  await expect(retained.locator(".gloss")).toHaveText("令人信服");
  await verifyOtherOccurrence("after-reload");
  state = await (await request.get(`/api/collections/state/${doc.id}`)).json();
  expect(state.items).toEqual([]);
  expect(state.feedback).toHaveLength(1);
  expect(state.feedback[0].understood).not.toBe(true);
  await info.attach("adoption-after-uncollect.json", {
    body: JSON.stringify({ scope: "real Reader and API with deterministic local model fixture", originalGloss, isolationChecks, state }, null, 2),
    contentType: "application/json",
  });
});
