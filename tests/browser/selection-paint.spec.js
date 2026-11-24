import { test, expect } from '@playwright/test';
import { enableAll, read, readerDefaults } from './reader-helpers.js';

for (const reflow of [false, true]) for (const precise of [true, false]) {
  test(`drag selection has one paint in ${reflow ? 'reflow' : 'plain'} layout with ${precise ? 'custom highlights' : 'word fallback'}`, async ({ page, request }) => {
    await readerDefaults(page);
    await page.setViewportSize({ width: 1000, height: 800 });
    if (!precise) await page.addInitScript(() => Object.defineProperty(CSS, 'highlights', { value: undefined }));
    await enableAll(request);
    await request.patch('/api/profile', { data: { density: 0, vocab_size: 8000 } });
    const quote = 'second sentence carries the meaning forward for a while';
    const text = `A prominent contribution can change our understanding. The ${quote}. The third sentence closes the discussion with a careful observation.`;
    const doc = await (await request.post('/api/documents', { data: { title: 'Selection paint', text } })).json();
    await read(page, doc.id);
    // UA selection paint can be opaque even when its computed background is transparent.
    await page.addStyleTag({ content: '::selection { background-color: Highlight; color: HighlightText; }' });
    if (reflow) {
      await page.locator(`#article [data-word="${precise ? 'prominent' : 'contribution'}"]`).click();
      await page.locator('.annotation-pop [data-usage-action="need"]').click();
      await expect(page.locator('.annotation-pop [data-usage-action="need"]')).toBeEnabled();
      await page.getByRole('button', { name: '关闭注释', exact: true }).click();
      await expect(page.locator('#article .reflow-source-block').first()).toBeVisible();
      await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'preparing');
      await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'playing');
    }
    async function endpoint(word, end) {
      return page.locator(`#article [data-word="${word}"]`).evaluate((node, end) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode(), range = document.createRange();
        range.setStart(text, end ? text.length - 1 : 0);
        range.setEnd(text, end ? text.length : 1);
        const box = range.getBoundingClientRect();
        return { x: end ? box.right - 0.5 : box.left + 0.5, y: box.top + box.height / 2 };
      }, end);
    }
    const start = await endpoint('second', false), end = await endpoint('while', true);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    if (precise) expect(await page.evaluate(() => CSS.highlights.has('reader-selection'))).toBe(false);
    await page.mouse.move(end.x, end.y, { steps: 20 });
    const nativeColor = await page.locator('#article [data-word="second"]').evaluate(node => getComputedStyle(node, '::selection').backgroundColor);
    if (precise) {
      expect(nativeColor).toBe('rgba(0, 0, 0, 0)');
      await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get('reader-selection') || [])].map(range => range.toString()).join(''))).toBe(quote);
    } else {
      expect(nativeColor).not.toBe('rgba(0, 0, 0, 0)');
    }
    await expect(page.locator('#reading-selection')).toBeHidden();
    await page.mouse.up();
    await expect(page.locator('#reading-selection .selection-quote')).toHaveText(`已选原文 · ${quote}`);
    expect(await page.evaluate(() => getSelection().toString())).toBe(quote);
    if (precise) {
      expect(await page.evaluate(() => [...CSS.highlights.get('reader-selection')].map(range => range.toString()).join(''))).toBe(quote);
      await expect(page.locator('.reader')).toHaveClass(/precise-selection/);
    } else {
      await expect(page.locator('.reader')).not.toHaveClass(/precise-selection/);
      expect(await page.locator('#article .source-unit.is-selected:visible').allTextContents()).toEqual(quote.split(' '));
      await expect(page.locator('#article .source-unit.is-selected:visible').first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await expect(page.locator('[data-selection-edge="start"]')).toBeVisible();
    await expect(page.locator('[data-selection-edge="end"]')).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.keyboard.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(quote);
    await page.locator('[data-selection-edge="end"]').press('ArrowLeft');
    await expect(page.locator('#reading-selection .selection-quote')).toHaveText(`已选原文 · ${quote.slice(0, -1)}`);
    await page.keyboard.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(quote.slice(0, -1));
    const handle = await page.locator('[data-selection-edge="end"]').boundingBox();
    const shorterEnd = await endpoint('for', true);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(shorterEnd.x, shorterEnd.y, { steps: 12 });
    await page.mouse.up();
    const adjusted = quote.slice(0, quote.lastIndexOf(' for') + 4);
    await expect(page.locator('#reading-selection .selection-quote')).toHaveText(`已选原文 · ${adjusted}`);
    await page.keyboard.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(adjusted);
    await page.locator('[data-selection-edge="end"]').click();
    expect(await page.evaluate(() => getSelection().toString())).toBe(adjusted);
    expect(await page.locator('#article [data-word="second"]').evaluate(node => getComputedStyle(node, '::selection').backgroundColor))
      .toBe('rgba(0, 0, 0, 0)');
    await page.locator('[data-selection-action="lookup"]').click();
    await expect(page.locator('.annotation-pop')).toBeVisible();
    await page.getByRole('button', { name: '关闭注释', exact: true }).click();
    await page.locator('[data-selection-clear]').click();
    await expect(page.locator('#reading-selection')).toBeHidden();
    await expect(page.locator('#article .is-selected')).toHaveCount(0);
    await expect(page.locator('#article')).not.toHaveClass(/has-reader-selection/);
    if (precise) expect(await page.evaluate(() => CSS.highlights.has('reader-selection'))).toBe(false);
  });
}
