import { test, expect } from "@playwright/test";
import { enableAll, read, readerDefaults } from "./reader-helpers.js";

const engine = process.env.WR_E2E_ENGINE || "chromium";
test.use({
  browserName: engine,
  channel: engine === "chromium" ? "chrome" : "",
});

test("annotation reflow keeps mixed typography on separate reading lines", async ({
  page,
  request,
}) => {
  await readerDefaults(page);
  await page.setViewportSize({ width: 1000, height: 820 });
  await page.addInitScript(() =>
    localStorage.setItem(
      "wr2:typography",
      JSON.stringify({ size: 22, line: 1.95, width: 660, font: "serif" }),
    ),
  );
  await enableAll(request);
  await request.patch("/api/profile", {
    data: { density: 0, vocab_size: 8000 },
  });
  const body =
    "A prominent contribution can change our understanding. " +
    "The small research team prepared a plan for the harbor before sunrise. " +
    "Each member proposed a different way to arrange the tables.";
  const heading =
    "The Research Team Studies a New Map of the Harbor and Its Surroundings";
  const footnote =
    "A field note documents the origin of the diagram and compares records kept by the crew. "
      .repeat(4)
      .trim();
  const response = await request.post("/api/documents", {
    data: {
      title: "Mixed reading edition",
      text: [body, heading, footnote].join("\n\n"),
    },
  });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json();
  await page.route(
    new RegExp(`/api/documents/${doc.id}(?:\\?|$)`),
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.blocks[1].type = "heading";
      await route.fulfill({ response, json });
    },
  );
  await page.route("**/style.css*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
        .reading-prose h2 { line-height: 1.45; }
        .reading-prose p[data-block="${doc.blocks[2].id}"] {
          font-size: 14px;
          line-height: normal;
        }
      `,
    });
  });
  await read(page, doc.id);
  await expect(page.locator("#article h2")).toHaveText(heading);
  await page.locator('#article [data-word="prominent"]').first().click();
  const need = page.locator('.annotation-pop [data-usage-action="need"]');
  await need.click();
  await expect(need).toBeEnabled();
  await expect(
    page.locator("#article .reflow-inline-piece").first(),
  ).toBeVisible();
  await expect(page.locator("#article")).not.toHaveAttribute(
    "data-reflow-phase",
    /preparing|playing/,
  );

  const pieces = await page
    .locator("#article .reflow-inline-piece")
    .evaluateAll((nodes) => {
      const rows = new Map();
      return nodes.flatMap((node) => {
        const { top, bottom, left, right, width, height } =
          node.getBoundingClientRect();
        if (
          !width ||
          !node.textContent.trim() ||
          getComputedStyle(node).visibility === "hidden"
        )
          return [];
        const block = node.closest("[data-block]");
        if (!rows.has(node.parentElement))
          rows.set(node.parentElement, rows.size);
        return [
          {
            text: node.textContent,
            block: block.dataset.block,
            top,
            bottom,
            left,
            right,
            height,
            row: rows.get(node.parentElement),
          },
        ];
      });
    });
  for (const block of doc.blocks) {
    expect(pieces.some((piece) => piece.block === block.id)).toBe(true);
  }
  const collisions = [];
  for (const [i, a] of pieces.entries()) {
    for (const b of pieces.slice(i + 1)) {
      const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (vertical > Math.min(a.height, b.height) / 2 && horizontal > 1) {
        collisions.push([a, b]);
      }
    }
  }
  expect(collisions).toEqual([]);
  const footnotePieces = pieces.filter(
    (piece) => piece.block === doc.blocks[2].id,
  );
  const visualLines = new Set(
    footnotePieces.map((piece) => Math.round(piece.top)),
  );
  expect(visualLines.size).toBeGreaterThan(1);
  expect(new Set(footnotePieces.map((piece) => piece.row)).size).toBe(
    visualLines.size,
  );
});
