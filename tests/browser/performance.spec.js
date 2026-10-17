import {
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
import { execFileSync } from "node:child_process";
const fixture = execFileSync(".venv/bin/python", [
  "tests/browser/performance-book.py",
]);
async function importBook(request) {
  for (const id of [
    "importer",
    "library",
    "progress",
    "bookmarks",
    "search",
    "typography",
    "notes",
  ])
    await request.patch("/api/plugins/" + id, { data: { enabled: true } });
  await request.patch("/api/profile", {
    data: { density: 4, vocab_size: 8000, l1_enabled: true },
  });
  const r = await request.post("/api/import", {
    multipart: {
      file: {
        name: "performance.epub",
        mimeType: "application/epub+zip",
        buffer: fixture,
      },
    },
    timeout: 60000,
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
async function monitor(page) {
  await page.addInitScript(() => {
    window.__readingPerf = { tasks: [] };
    new PerformanceObserver((list) =>
      window.__readingPerf.tasks.push(
        ...list
          .getEntries()
          .map((e) => ({ start: e.startTime, duration: e.duration })),
      ),
    ).observe({ type: "longtask", buffered: true });
    new MutationObserver(() => {
      if (
        !window.__readingPerf.firstSource &&
        document.querySelector("#article [data-block]")
      ) {
        window.__readingPerf.firstSource = performance.now();
        window.__readingPerf.firstSourceComplete =
          document.querySelector(".reader").dataset.paginationReady;
        // Exercise the actual paragraph-selection handler at first availability,
        // rather than assume Playwright's later polling catches the same frame.
        document.querySelector("[data-select-block]")?.click();
        window.__readingPerf.selectedQuote =
          document.querySelector(".selection-quote")?.textContent;
      }
      if (
        !window.__readingPerf.ready &&
        document.querySelector('.reader[data-ready="true"]')
      )
        window.__readingPerf.ready = performance.now();
      if (
        !window.__readingPerf.complete &&
        document.querySelector('.reader[data-pagination-ready="true"]')
      )
        window.__readingPerf.complete = performance.now();
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-ready", "data-pagination-ready"],
    });
  });
}

test("large EPUB opens before complete pagination; background work leaves selection and page intact", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const book = await importBook(request);
  const id = book.chapters[0].doc_id;
  await monitor(page);
  await page.goto("/#/read/" + id);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  const atReady = await page.evaluate(() => ({
    ...window.__readingPerf,
    paginationReady: document.querySelector(".reader").dataset.paginationReady,
    page: document.querySelector(".reader").dataset.pageIndex,
    renderedBlocks: document.querySelectorAll("#article [data-block]").length,
  }));
  await info.attach("first-availability.json", {
    body: JSON.stringify(atReady, null, 2),
    contentType: "application/json",
  });
  expect(atReady.firstSourceComplete).toBe("false");
  expect(atReady.renderedBlocks).toBeLessThan(10);
  expect(atReady.firstSource).toBeLessThan(2000);
  // The actual paragraph selection was invoked by the observer at first source availability.
  // Background navigation must not repaint the source or discard the selected range.
  await expect(page.locator(".selection-quote")).toHaveText(
    atReady.selectedQuote,
  );
  const selected = await page.locator("#reading-selection").textContent();
  const source = await page.locator("#article").innerHTML();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
    { timeout: 20000 },
  );
  expect(await page.locator("#article").innerHTML()).toBe(source);
  expect(await page.locator("#reading-selection").textContent()).toBe(selected);
  const result = await page.evaluate(() => window.__readingPerf);
  expect(result.complete).toBeGreaterThan(result.firstSource);
  // Reflow near the beginning while thousands of later fragments remain.
  // A late background batch must never reset the newly restored page.
  await tools(page, "typography");
  await page.locator("#type-size").fill("26");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await goPage(page, (await pageIndex(page)) + 1);
  await expect(page.locator(".reader")).toHaveAttribute("data-page-index", "1");
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  await expect(page.locator(".reader")).toHaveAttribute("data-page-index", "1");
  await goPage(page, (await pageIndex(page)) - 1);
  await expect(page.locator(".reader")).toHaveAttribute("data-page-index", "0");
  const pages = await pageCount(page);
  expect(pages).toBeGreaterThan(200);
  await goPage(page, (await pageIndex(page)) + 1);
  await expect(page.locator(".reader")).toHaveAttribute("data-page-index", "1");
  expect(errors).toEqual([]);
  await info.attach("large-book-performance.json", {
    body: JSON.stringify(
      {
        scope:
          "synthetic EPUB; four chapters, over one million source characters; first chapter cold analysis after import cache eviction; local Chromium, not million English words",
        chapters: book.chapters,
        atReady,
        result,
        pages,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await info.attach("large-book-readable.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("late source restore survives reflow, bookmarks and reopen; leaving cancels old pagination", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const book = await importBook(request),
    id = book.chapters[0].doc_id;
  await page.goto("/#/read/" + id);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await tools(page, "search");
  await page.locator("#find-text").fill("Destination marker 1");
  await expect(page.locator("#article")).toContainText("Destination marker 1", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await tools(page, "bookmarks");
  await expect(page.locator("#tool-bookmarks")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/documents/${id}/progress`)).json())
          .anchor?.quote,
    )
    .toContain("Destination marker");
  await page.evaluate(() => {
    window.__reflowSnapshots = [];
    window.__reflowObserver = new MutationObserver(() =>
      window.__reflowSnapshots.push(
        document.querySelector("#article").textContent,
      ),
    );
    window.__reflowObserver.observe(document.querySelector("#article"), {
      childList: true,
    });
  });
  await tools(page, "typography");
  await page.locator("#type-size").fill("28");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator("#article")).toContainText("Destination marker 1", {
    timeout: 20000,
  });
  await expect(page.locator(".bookmark-marker")).toBeVisible();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  const reflows = await page.evaluate(() => {
    window.__reflowObserver.disconnect();
    return window.__reflowSnapshots;
  });
  expect(reflows.length).toBeGreaterThan(0);
  expect(
    reflows.every((text) => text.includes("Destination marker 1")),
  ).toBeTruthy();
  await page.reload();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true", {
    timeout: 20000,
  });
  await expect(page.locator("#article")).toContainText("Destination marker 1");
  await expect(page.locator(".bookmark-marker")).toBeVisible();
  const compact = await (
    await request.get(`/api/documents/${id}?compact=true`)
  ).json();
  expect(compact).not.toHaveProperty("text");
  expect(compact).not.toHaveProperty("fragments");
  const next = book.chapters[1].doc_id;
  await page.goto("/#/read/" + next);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await home(page);
  await expect(page.locator("#shelf-count")).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.locator(".reader")).toHaveCount(0);
  await expect(page.locator(".reading-page-measure")).toHaveCount(0);
  expect(errors).toEqual([]);
  await info.attach("restore-evidence.json", {
    body: JSON.stringify(
      {
        id,
        sourceVersion: compact.version,
        blocks: compact.blocks.length,
        bookmarkCount: (
          await (await request.get("/api/bookmarks?doc_id=" + id)).json()
        ).length,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("content analysis optimization retains exact phrases and live personal feedback", async ({
  page,
  request,
}) => {
  await request.patch("/api/profile", {
    data: { density: 15, vocab_size: 8000, l1_enabled: true },
  });
  const created = await request.post("/api/documents", {
    data: {
      title: "Phrase cache acceptance",
      text: "We wanted to break the ice before the conversation began.",
    },
  });
  expect(created.ok()).toBeTruthy();
  const doc = await created.json();
  await page.goto("/#/read/" + doc.id);
  await expect(page.locator('.annotation[data-kind="phrase"]')).toContainText(
    "打破沉默",
  );
  await page.locator('.annotation[data-kind="phrase"]').click();
  await page.locator("[data-understood]").click();
  await expect(page.locator('.annotation[data-kind="phrase"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await expect(page.locator('.annotation[data-kind="phrase"]')).toHaveCount(0);
});
