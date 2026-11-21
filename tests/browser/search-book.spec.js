import { test, expect } from "@playwright/test";
import { read, tools, readerDefaults, enableAll } from "./reader-helpers.js";

async function createBook(request) {
  const createdBook = await request.post("/api/library/books", {
    data: { title: "Search Book " + Date.now(), author: "Test Author" },
  });
  expect(createdBook.ok()).toBeTruthy();
  const book = await createdBook.json();

  const chapters = [
    {
      title: "Chapter 1",
      text: "Introduction to perception.\n\nOpening notes about focus and reading attention.",
    },
    {
      title: "Chapter 2",
      text: "Middle section.\n\nTransitional discussion of memory and reflection.",
    },
    {
      title: "Chapter 3",
      text: "# Phenomenology Milestone\n\nLonger paragraph explaining how phenomenology connects perception across chapters.",
    },
  ];

  const docIds = [];
  for (const ch of chapters) {
    const docRes = await request.post("/api/documents", {
      data: { title: ch.title, text: ch.text },
    });
    expect(docRes.ok()).toBeTruthy();
    const doc = await docRes.json();
    const adoptRes = await request.post(
      `/api/library/books/${book.id}/adopt/${doc.id}`,
    );
    expect(adoptRes.ok()).toBeTruthy();
    docIds.push(doc.id);
  }
  return { bookId: book.id, docIds };
}

test.beforeEach(async ({ page, request }) => {
  await readerDefaults(page);
  await enableAll(request);
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
});

test.afterEach(async ({ page }) => {
  expect(page.__errors).toEqual([]);
});

test("whole-book search finds cross-chapter headings, jumps cleanly, and filters scope", async ({
  page,
  request,
}) => {
  const { docIds } = await createBook(request);
  await read(page, docIds[0]);

  await tools(page, "search");
  await expect(page.locator('[data-search-scope="book"]')).toHaveClass(/active/);
  await expect(page.locator('[data-search-scope="book"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Search keyword located only in chapter 3: must not auto-jump away from chapter 1.
  await page.locator("#find-text").fill("phenomenology");
  const items = page.locator("#find-results .search-result-item");
  await expect(items).toHaveCount(2);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-document-id",
    String(docIds[0]),
  );
  await expect(items.first().locator(".search-heading-badge")).toHaveText("标题");
  await expect(page.locator("#find-count")).toContainText("2 处");

  // Clicking result jumps to chapter 3 and highlights the match.
  await items.first().click();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-document-id",
    String(docIds[2]),
  );
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#article")).toContainText(/Phenomenology[\s\S]*Milestone/);
  await expect(page.locator("#article .search-hit").first()).toBeVisible();

  // Reopening search restores last query for the same book and marks current chapter hits.
  await tools(page, "search");
  await expect(page.locator("#find-text")).toHaveValue("phenomenology");
  await expect(items).toHaveCount(2);
  await expect(items.first().locator(".search-current-badge")).toHaveText("当前");

  // Headings-only filter narrows results to the heading hit.
  await page.locator("#find-headings-only").check();
  await expect(items).toHaveCount(1);
  await expect(items.first().locator(".search-heading-badge")).toHaveText("标题");

  // Switching to current-document scope searches only within chapter 3.
  await page.locator('[data-search-scope="current"]').click();
  await expect(page.locator('[data-search-scope="current"]')).toHaveClass(/active/);
  await expect(page.locator("#find-headings-wrap")).toBeHidden();
  await page.locator("#find-text").fill("perception");
  await expect(page.locator("#find-count")).toHaveText("1 / 1 处");
  await expect(items).toHaveCount(0);
});
