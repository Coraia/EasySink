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
import { execFileSync } from "node:child_process";

const epub = fs.readFileSync("web/sample.epub");
function packageFixture(mode) {
  return execFileSync(".venv/bin/python", [
    "tests/browser/epub_fixtures.py",
    mode,
  ]);
}

test.beforeEach(async ({ request }) => {
  for (const id of ["importer", "library"])
    await request.patch("/api/plugins/" + id, { data: { enabled: true } });
});

async function upload(page, file) {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await page.locator("#upload-file").setInputFiles(file);
}

async function expectEpubReady(page, chapters = 2) {
  await expect(page.locator("#upload-state")).toContainText(
    new RegExp(`已完整导入 ${chapters} 章|已复用已有书籍`),
  );
}

test("the unified entry reveals URL consent only after recognizing a link", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await expect(page.getByRole("heading", { name: "把内容放进来" })).toBeVisible();
  await expect(page.locator("#url-import-panel")).toBeHidden();
  await expect(page.locator("#pdf-import-panel")).toBeHidden();

  await page.locator("#paste-text").fill("https://example.com/");
  await expect(page.locator("#import-detected-title")).toHaveText("已识别为网页链接");
  await expect(page.locator("#paste-state")).toContainText("不会保存为文字草稿");
  await expect(page.locator("#url-import-panel")).toBeVisible();
  await expect(page.locator("#pdf-import-panel")).toBeHidden();
  await page.getByRole("button", { name: "核对并导入" }).click();
  await expect(page.locator("#url-import-consent")).toBeVisible();
  await expect(page.locator("#url-import-consent-host")).toHaveText("example.com");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("#import-detected-copy")).toContainText("未访问该网站");
});

test("PDF selection waits for processing location before upload", async ({
  page,
}) => {
  const uploads = [];
  await page.route("**/api/pdf/capabilities**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        processing_enabled: true,
        adapters: [
          { id: "digital", available: true },
          { id: "mineru_source", available: true },
          {
            id: "omarchy",
            available: true,
            readiness: { state: "ready" },
          },
        ],
      }),
    }),
  );
  await page.route("**/api/pdf/imports", async (route) => {
    uploads.push((await route.request().postDataBuffer()).toString("utf8"));
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ detail: "E2E stopped after upload boundary" }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "＋ 添加阅读" }).click();
  await page.locator("#upload-file").setInputFiles({
    name: "processing-location.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%E2E\n"),
  });

  await expect(page.locator("#pdf-import-panel")).toBeVisible();
  await expect(page.locator("#import-continue")).toBeVisible();
  await expect(page.locator("#import-continue")).toBeEnabled();
  expect(uploads).toHaveLength(0);

  await page.locator("#pdf-import-engine").selectOption("omarchy");
  await page.getByRole("button", { name: "导入 PDF" }).click();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]).toContain('name="engine"');
  expect(uploads[0]).toContain("omarchy");
});

test("EPUB content survives a transport filename without its extension", async ({
  page,
}, testInfo) => {
  await upload(page, {
    name: "blob",
    mimeType: "application/octet-stream",
    buffer: epub,
  });
  await expectEpubReady(page);
  await testInfo.attach("import-complete", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.locator("#open-import").click();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#article h2").first()).toHaveText(
    "A conversation with a stranger",
  );
  await page.reload();
  await expect(page.locator("#article h2").first()).toHaveText(
    "A conversation with a stranger",
  );
  await tools(page, "outline");
  await chapter(page, 1);
  await expect(page.locator(".reading-heading h1")).toHaveText(
    "The space between things",
  );
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-pagination-ready",
    "true",
  );
  const pages = await pageCount(page);
  for (
    let i = 0;
    i < pages && !(await page.locator("#article .code").count());
    i++
  ) {
    await goPage(page, i);
  }
  await expect(page.locator("#article .code")).toContainText(
    "attention = curiosity + time",
  );
});

test("EPUB MIME is accepted without an EPUB filename and a retry recovers", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/api/library/books")).json();
  await upload(page, {
    name: "upload",
    mimeType: "application/epub+zip",
    buffer: Buffer.from("not an epub"),
  });
  await expect(page.locator("#upload-state")).toContainText("文件损坏");
  expect(await (await request.get("/api/library/books")).json()).toEqual(
    before,
  );
  await expect(page.locator("#upload-file")).toBeEnabled();
  await page.locator("#upload-file").setInputFiles({
    name: "upload",
    mimeType: "application/epub+zip",
    buffer: epub,
  });
  await expectEpubReady(page);
});

test("a non-EPUB ZIP is rejected and Markdown still imports", async ({
  page,
  request,
}) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const before = await (await request.get("/api/library/books")).json();
  // Valid empty ZIP, not an EPUB publication.
  await upload(page, {
    name: "archive.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("504b0506000000000000000000000000000000000000", "hex"),
  });
  await expect(page.locator("#upload-state")).toContainText(
    "支持 EPUB、TXT 和 Markdown 文件",
  );
  expect(await (await request.get("/api/library/books")).json()).toEqual(
    before,
  );
  await page.locator("#upload-file").setInputFiles({
    name: "Reading notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# A fresh start\n\nKeep reading with curiosity.\n\n- Notice the details\n- Ask a better question",
    ),
  });
  await expect(page.locator("#upload-state")).toContainText("已完整导入 1 章");
  await page.locator("#open-import").click();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  // Verify original text regardless of annotations enabled by earlier scenarios.
  await expect
    .poll(() =>
      page.locator("#article").evaluate((article) => {
        const source = article.cloneNode(true);
        source.querySelectorAll(".gloss").forEach((gloss) => gloss.remove());
        return source.textContent;
      }),
    )
    .toContain("Keep reading with curiosity.");
  await expect(page.locator("#article li")).toHaveCount(2);
  await expect(page.locator("#article li").first().locator("xpath=..")).toHaveJSProperty(
    "tagName",
    "UL",
  );
  expect(consoleErrors).not.toContain(
    "An invalid form control with name='' is not focusable.",
  );
});

for (const mode of ["single", "nested"])
  test(`Mac EPUB package imports from a ${mode} wrapper directory`, async ({
    page,
  }) => {
    await upload(page, {
      name: "sample.epub.zip",
      mimeType: "application/zip",
      buffer: packageFixture(mode),
    });
    await expectEpubReady(page);
    await page.locator("#open-import").click();
    await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");

    await expect(page.locator("#article h2").first()).toHaveText(
      "A conversation with a stranger",
    );
    await page.reload();
    await expect(page.locator("#article h2").first()).toHaveText(
      "A conversation with a stranger",
    );
  });

for (const [mode, message] of [
  ["ambiguous", "多本 EPUB"],
  ["unsafe", "路径越界"],
])
  test(`EPUB wrapper rejects ${mode} roots without saving a book`, async ({
    page,
    request,
  }) => {
    const before = await (await request.get("/api/library/books")).json();
    await upload(page, {
      name: "wrapped.epub.zip",
      mimeType: "application/zip",
      buffer: packageFixture(mode),
    });
    await expect(page.locator("#upload-state")).toContainText(message);
    expect(await (await request.get("/api/library/books")).json()).toEqual(
      before,
    );
  });

test("the supplied Python Pocket Reference package imports and reopens", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.WR_E2E_EPUB_PACKAGE,
    "Supply a local package archive to verify the user's book",
  );
  test.setTimeout(90000);
  const receipt = process.env.WR_E2E_EPUB_PACKAGE.replace(
    /\.zip$/,
    ".receipt.json",
  );
  if (fs.existsSync(receipt))
    await testInfo.attach("actual-book-fixture-receipt", {
      body: fs.readFileSync(receipt),
      contentType: "application/json",
    });
  await upload(page, {
    name: "Python Pocket Reference.epub.zip",
    mimeType: "application/zip",
    buffer: fs.readFileSync(process.env.WR_E2E_EPUB_PACKAGE),
  });
  await expect(page.locator("#upload-state")).toContainText("已完整导入 5 章", {
    timeout: 60000,
  });
  await testInfo.attach("actual-book-import-complete", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.locator("#open-import").click();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  await tools(page, "outline");
  await chapter(page, 2);
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true", {
    timeout: 30000,
  });
  const title = await page.locator(".reading-heading h1").textContent();
  expect(await page.locator("#article").innerText()).toContain("Python");
  await page.reload();
  await expect(page.locator(".reading-heading h1")).toHaveText(title, {
    timeout: 30000,
  });
});

test("one EPUB stays one shelf entry across reload and search; chapters only appear inside its book", async ({
  page,
  request,
}, info) => {
  const standalone = await (
    await request.post("/api/documents", {
      data: {
        title: "Standalone shelf check",
        text: "An independent article should remain on the shelf.",
      },
    })
  ).json();
  // Importing the same source again must reuse the existing book, regardless
  // of the transport filename used by this test or an earlier scenario.
  await upload(page, {
    name: "One Book.epub",
    mimeType: "application/epub+zip",
    buffer: epub,
  });
  await expectEpubReady(page);
  await page.locator("#open-import").click();
  await expect(page.locator(".reader")).toHaveAttribute("data-ready", "true");
  const chapterId = +page.url().match(/read\/(\d+)/)[1];
  const importedDoc = await (
    await request.get("/api/documents/" + chapterId + "?compact=true")
  ).json();
  const bookId = importedDoc.chapter.book_id;
  const book = await (await request.get("/api/library/books/" + bookId)).json();
  const ids = book.chapters.map((ch) => ch.doc_id);
  await expect(page.locator("#translate-book")).toHaveCount(0);
  for (let round = 0; round < 2; round++) {
    await page.goto("/");
    const card = page
      .locator(`#article-grid .book-card[href="#/read/${ids[0]}"]`)
      .filter({
        has: page.getByRole("heading", {
          name: "The Quiet Reader",
          exact: true,
        }),
      });
    await expect(card).toHaveCount(1);
    await expect(card.locator(".book-cover small")).toContainText("EPUB");
    for (const ch of book.chapters)
      await expect(
        page.locator("#article-grid h3").filter({ hasText: ch.title }),
      ).toHaveCount(0);
    await expect(
      page.locator('#article-grid a[href="#/read/' + standalone.id + '"]'),
    ).toBeVisible();
    await page.locator("#shelf-search").fill("The Quiet Reader");
    await expect(card).toHaveCount(1);
  }
  await info.attach("one-book-on-shelf.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page
    .locator(`#article-grid .book-card[href="#/read/${ids[0]}"]`)
    .filter({
      has: page.getByRole("heading", { name: "The Quiet Reader", exact: true }),
    })
    .click();
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-document-id",
    String(ids[0]),
  );
  await tools(page, "outline");
  await expect(page.locator("#tool-panel .toc-link")).toHaveCount(2);
});
