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
      await page.evaluate(() => {
        window.nativeReflowLayouts = [];
        window.caretAffinities = 0;
        const getClientRects = Range.prototype.getClientRects;
        Range.prototype.getClientRects = function () {
          const rects = getClientRects.call(this);
          if (
            this.toString() === "S" &&
            this.startContainer === this.endContainer &&
            this.startOffset > 0 &&
            this.startContainer.parentElement.closest(
              ".annotation-reflow-measure",
            ) &&
            rects.length === 1 &&
            rects[0].width > 0
          ) {
            const previous = this.cloneRange();
            previous.setStart(this.startContainer, this.startOffset - 1);
            previous.setEnd(this.startContainer, this.startOffset);
            const r = getClientRects.call(previous)[0];
            if (r && r.y < rects[0].y) {
              // System WKWebView includes the previous line's caret before the visible glyph.
              window.caretAffinities++;
              return [new DOMRect(r.right, r.y, 0, r.height), ...rects];
            }
          }
          return rects;
        };
        const remove = Element.prototype.remove;
        Element.prototype.remove = function () {
          if (this.matches(".annotation-reflow-measure") && this.isConnected) {
            const range = document.createRange(),
              glyphs = [],
              words = [];
            const walker = document.createTreeWalker(
              this,
              NodeFilter.SHOW_TEXT,
            );
            let node,
              source = "",
              notes = "";
            while ((node = walker.nextNode())) {
              const note = Boolean(node.parentElement.closest(".gloss"));
              if (note) notes += node.textContent;
              else source += node.textContent;
              for (const { segment, index } of new Intl.Segmenter(undefined, {
                granularity: "grapheme",
              }).segment(node.textContent)) {
                range.setStart(node, index);
                range.setEnd(node, index + segment.length);
                const rects = [...range.getClientRects()];
                const r = rects.find((r) => r.width > 0) || rects[0];
                if (r?.width) glyphs.push({ text: segment, x: r.x, y: r.y });
                if (
                  node.parentElement
                    .closest("[data-word]")
                    ?.textContent.includes("Scriptural")
                )
                  words.push({
                    text: segment,
                    rects: rects.map((r) => ({
                      x: r.x,
                      y: r.y,
                      width: r.width,
                    })),
                  });
              }
            }
            const css = getComputedStyle(this);
            window.nativeReflowLayouts.push({
              source,
              notes,
              glyphs,
              words,
              top: this.getBoundingClientRect().top,
              lineHeight: parseFloat(css.lineHeight),
              width: this.getBoundingClientRect().width,
              wordBreak: css.wordBreak,
              overflowWrap: css.overflowWrap,
            });
          }
          return remove.call(this);
        };
      });
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
                wordKey: n.dataset.word
                  ? [
                      n.dataset.sourceBlock,
                      n.dataset.sourceStart,
                      n.dataset.sourceEnd,
                    ].join(":")
                  : null,
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
            const notes = pieces
              .filter((n) => n.classList.contains("gloss"))
              .map((n) => n.textContent)
              .join("");
            const suffix = pieces
              .filter((n) => !n.classList.contains("gloss"))
              .map((n) => n.textContent)
              .join("");
            const native = window.nativeReflowLayouts.findLast(
              (layout) => layout.source === suffix && layout.notes === notes,
            );
            const lines = (glyphs) => {
              const rows = new Map();
              for (const glyph of glyphs) {
                const row = Math.round(
                  (glyph.y - native.top) / native.lineHeight,
                );
                if (!rows.has(row)) rows.set(row, []);
                rows.get(row).push(glyph);
              }
              return [...rows]
                .sort((a, b) => a[0] - b[0])
                .map(([row, glyphs]) => ({
                  row,
                  text: glyphs
                    .sort((a, b) => a.x - b.x)
                    .map((g) => g.text)
                    .join(""),
                }));
            };
            const range = document.createRange(),
              glyphs = [];
            for (const piece of pieces) {
              const node = piece.firstChild;
              for (const { segment, index } of new Intl.Segmenter(undefined, {
                granularity: "grapheme",
              }).segment(node.textContent)) {
                range.setStart(node, index);
                range.setEnd(node, index + segment.length);
                const r = [...range.getClientRects()].find((r) => r.width > 0);
                if (r) glyphs.push({ text: segment, x: r.x, y: r.y });
              }
            }
            const canvas = document.createElement("canvas"),
              context = canvas.getContext("2d");
            context.font = getComputedStyle(
              article.querySelector("[data-word]"),
            ).font;
            return {
              rects,
              source,
              native,
              lines: lines(glyphs),
              nativeLines: lines(native.glyphs),
              space: context.measureText(" ").width,
            };
          });
          await testInfo.attach(`${target}-${action}-layout`, {
            body: JSON.stringify(actual, null, 2),
            contentType: "application/json",
          });
          expect.soft(actual.source, `${action}: source text`).toBe(text);
          expect
            .soft(actual.lines, `${target} ${action}: native visible lines`)
            .toEqual(actual.nativeLines);
          const words = Map.groupBy(
            actual.rects.filter((r) => r.wordKey),
            (r) => r.wordKey,
          );
          for (const fragments of words.values())
            for (let i = 0; i < fragments.length - 1; i++)
              expect
                .soft(
                  fragments[i].text.endsWith("-"),
                  `${action}: split after ${fragments[i].text}`,
                )
                .toBe(true);
          const rows = Map.groupBy(
            actual.rects.filter((r) => r.right > r.left && r.text.trim()),
            (r) =>
              Math.round(
                (r.top - actual.native.top) / actual.native.lineHeight,
              ),
          );
          for (const pieces of rows.values()) {
            pieces.sort((a, b) => a.left - b.left);
            for (let i = 1; i < pieces.length; i++)
              expect
                .soft(
                  pieces[i].left - pieces[i - 1].right,
                  `${action}: gap ${pieces[i - 1].text}|${pieces[i].text}`,
                )
                .toBeLessThanOrEqual(actual.space + 1);
          }
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
      if (word === "un-Scriptural" && filler === 9)
        expect(
          await page.evaluate(() => window.caretAffinities),
        ).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    });
  }
}
