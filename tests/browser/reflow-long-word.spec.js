import { test, expect } from "@playwright/test";
import { enableAll, read, readerDefaults } from "./reader-helpers.js";

const engine = process.env.WR_E2E_ENGINE || "chromium";
test.use({
  browserName: engine,
  channel: engine === "chromium" ? "chrome" : "",
});

for (const word of ["un-Scriptural", "unScriptural"]) {
  for (const filler of [7, 8, 9, 10, 11, 12]) {
    test(`reflow keeps ${word} inside the column with ${filler} fillers`, async ({
      page,
      request,
    }, testInfo) => {
      await readerDefaults(page);
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.addInitScript(() =>
        localStorage.setItem(
          "wr2:typography",
          JSON.stringify({ size: 28, line: 1.95, width: 900, font: "serif" }),
        ),
      );
      await enableAll(request);
      await request.patch("/api/profile", {
        data: { density: 0, vocab_size: 8000 },
      });
      const text = `${"small ".repeat(filler)}river ${word} words remain complete after marking. A😀é.`;
      const doc = await (
        await request.post("/api/documents", {
          data: { title: "Native word wrapping", text },
        })
      ).json();
      await read(page, doc.id);
      const native = await page
        .locator("#article [data-block]")
        .first()
        .evaluate((block) => {
          const box = block.getBoundingClientRect();
          const words = [...block.querySelectorAll("[data-word]")];
          return {
            left: box.left,
            right: box.right,
            words: words.map((n) => ({
              text: n.textContent,
              rects: [...n.getClientRects()].map((r) => ({
                x: r.x,
                y: r.y,
                width: r.width,
              })),
            })),
          };
        });
      await testInfo.attach("native-layout", {
        body: JSON.stringify(native, null, 2),
        contentType: "application/json",
      });
      for (const entry of native.words)
        for (const r of entry.rects) {
          expect(r.x).toBeGreaterThanOrEqual(native.left - 1);
          expect(r.x + r.width).toBeLessThanOrEqual(native.right + 1);
        }
      if (filler <= 9 || filler === 12) {
        const river = native.words.find((n) => n.text === "river");
        const ending = native.words.find((n) => n.text === word);
        expect(ending.rects[0].y).toBe(river.rects[0].y);
        expect(ending.rects[0].x).toBeGreaterThan(river.rects[0].x);
      }
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const target of ["river", "small"]) {
        await page.locator(`#article [data-word="${target}"]`).first().click();
        for (const action of ["need", "known"]) {
          const button = page.locator(
            `.annotation-pop [data-usage-action="${action}"]`,
          );
          await button.click();
          await expect(button).toBeEnabled();
          await expect(
            page.locator("#article .reflow-inline-piece:visible").first(),
          ).toBeVisible();
          await expect(page.locator("#article")).not.toHaveAttribute(
            "data-reflow-phase",
            /preparing|playing/,
          );
          const actual = await page.locator("#article").evaluate((article) => {
            const pieces = [
              ...article.querySelectorAll(".reflow-inline-piece"),
            ].filter((n) => getComputedStyle(n).visibility !== "hidden");
            const rects = pieces.map((n) => {
              const r = n.getBoundingClientRect(),
                leaf = n.closest(".page-leaf").getBoundingClientRect();
              return {
                text: n.textContent,
                key: n.classList.contains("gloss") ? null : n.dataset.reflowKey,
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                leaf: {
                  left: leaf.left,
                  right: leaf.right,
                  top: leaf.top,
                  bottom: leaf.bottom,
                },
              };
            });
            const walker = document.createTreeWalker(
              article,
              NodeFilter.SHOW_TEXT,
            );
            let node,
              source = "";
            while ((node = walker.nextNode())) {
              if (
                node.parentElement.closest("[data-block]") &&
                !node.parentElement.closest(".gloss,.annotation-gloss-space") &&
                getComputedStyle(node.parentElement).visibility !== "hidden"
              )
                source += node.textContent;
            }
            return { rects, source };
          });
          await testInfo.attach(`${target}-${action}-layout`, {
            body: JSON.stringify(actual, null, 2),
            contentType: "application/json",
          });
          expect.soft(actual.source, `${action}: source text`).toBe(text);
          for (const r of actual.rects) {
            if (r.key) {
              const [block, start, end] = r.key.split(":");
              expect
                .soft(r.text, `${action}: UTF-16 source range`)
                .toBe(
                  doc.blocks
                    .find((b) => b.id === block)
                    .text.slice(+start, +end),
                );
            }
            expect
              .soft(r.left, `${action}: ${r.text} left`)
              .toBeGreaterThanOrEqual(native.left - 1);
            expect
              .soft(r.right, `${action}: ${r.text} right`)
              .toBeLessThanOrEqual(native.right + 1);
            expect
              .soft(r.left, `${action}: ${r.text} leaf left`)
              .toBeGreaterThanOrEqual(r.leaf.left);
            expect
              .soft(r.right, `${action}: ${r.text} leaf right`)
              .toBeLessThanOrEqual(r.leaf.right);
            expect
              .soft(r.top, `${action}: ${r.text} leaf top`)
              .toBeGreaterThanOrEqual(r.leaf.top);
            expect
              .soft(r.bottom, `${action}: ${r.text} leaf bottom`)
              .toBeLessThanOrEqual(r.leaf.bottom);
          }
        }
      }
      expect(errors).toEqual([]);
    });
  }
}
