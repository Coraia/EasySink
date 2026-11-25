import { test, expect } from '@playwright/test';
import { enableAll, readerDefaults } from './reader-helpers.js';

const engine = process.env.WR_E2E_ENGINE || 'chromium';
test.use({ browserName: engine, channel: engine === 'chromium' ? 'chrome' : '' });

test('backward pages after reopening preserve the opening and contiguous source', async ({ page, request }, info) => {
  await readerDefaults(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.addInitScript(() => localStorage.setItem('wr2:typography', JSON.stringify({ size: 28, line: 1.95, width: 900, font: 'serif' })));
  await enableAll(request);
  await request.patch('/api/profile', { data: { density: 4, vocab_size: 8000 } });
  const words = ['un-Scriptural', 'un-Scriptural', 'un-Scriptural', 'unScriptural', 'counter-revolutionary', 'incomprehensibility'];
  const text = words.map((word, i) => 'small '.repeat(i + 7) + `river ${word} ${i === 5 ? 'remains' : 'words remain'} complete after marking.`).join('\n\n');
  const response = await request.post('/api/import', { multipart: { file: { name: 'reflow-long-words.txt', mimeType: 'text/plain', buffer: Buffer.from(text) } } });
  expect(response.ok()).toBe(true);
  const book = await response.json(), id = book.chapters[0].doc_id;
  const doc = await (await request.get(`/api/documents/${id}`)).json();
  const steps = [];
  const settled = () => expect.poll(() => page.evaluate(() => document.querySelector('.reader')?.__curlRendererTest?.pages.r.interaction.canRecordPosition())).toBe(true);
  const record = async name => {
    const step = await page.evaluate(name => {
      const p = document.querySelector('.reader').__curlRendererTest.pages;
      const global = a => p.offsets.get(a.block_id) + a.start;
      const fragments = [...document.querySelectorAll('#article .page-leaf [data-block]')].filter(node =>
        !node.closest('[aria-hidden="true"]') && getComputedStyle(node).visibility !== 'hidden').map(block => {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node, text = '', inside = true;
        const bounds = block.closest('.page-leaf').getBoundingClientRect();
        while ((node = walker.nextNode())) {
          if (!node.parentElement.closest('.gloss,.annotation-gloss-space,.paragraph-actions,.bookmark-marker,.note-marker,.reflow-reservation-text') &&
              getComputedStyle(node.parentElement).visibility !== 'hidden') {
            text += node.textContent;
            const range = document.createRange(); range.selectNodeContents(node);
            inside &&= [...range.getClientRects()].every(rect => !rect.width || !rect.height ||
              rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1);
          }
        }
        return { block_id: block.dataset.block, start: +block.dataset.start, end: +block.dataset.end,
          from: p.offsets.get(block.dataset.block) + +block.dataset.start,
          to: p.offsets.get(block.dataset.block) + +block.dataset.end, text, inside };
      }).filter(part => part.end > part.start);
      const view = p.currentPresentation();
      return { name, index: p.index, position: p.r.position(), start: global(view.start), end: global(view.end), fragments };
    }, name);
    steps.push(step);
    console.log(name, JSON.stringify({ start: step.start, end: step.end, ratio: step.position.ratio }));
    return step;
  };
  const turn = async (direction, index) => {
    await page.locator(`#reading-edge-${direction}`).click();
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String(index));
    await settled();
    return record(`${direction}-${index + 1}`);
  };
  try {
    await page.goto(`/?readingPerf=1#/read/${id}`);
    await settled();
    await page.locator('#article [data-word="river"]').first().click();
    for (const action of ['need', 'known']) {
      const button = page.locator(`.annotation-pop [data-usage-action="${action}"]`);
      await button.click();
      await expect(button).toBeEnabled();
      await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', /preparing|playing/);
    }
    await page.locator('#article [data-word="small"]').first().click();
    await page.locator('.annotation-pop [data-usage-action="need"]').click();
    await expect(page.locator('.annotation-pop [data-usage-action="need"]')).toBeEnabled();
    await page.locator('.annotation-pop .close').click();
    await settled();
    await record('marked');
    for (let i = 1; i <= 3; i++) await turn('next', i);
    const departed = steps.at(-1);
    await page.evaluate(async () => {
      const pending = [];
      window.dispatchEvent(new CustomEvent('reader-before-close', { detail: { waitUntil: promise => pending.push(promise) } }));
      await Promise.all(pending);
    });
    const saved = await (await request.get(`/api/documents/${id}/progress`)).json();
    expect(saved.anchor.block_id).toBe(departed.position.block_id);
    expect(saved.anchor.start).toBe(departed.position.start);
    await page.goto('/#/');
    await page.goto(`/?readingPerf=1#/read/${id}`);
    await settled();
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '3');
    const reopened = await record('reopened');
    expect(reopened.start).toBe(departed.start);
    const backward = [reopened];
    for (let i = 2; i >= 0; i--) backward.unshift(await turn('prev', i));
    expect(backward[0].start).toBe(0);
    expect(backward[0].position.start).toBe(0);
    expect(backward[0].position.ratio).toBe(0);
    await expect(page.locator(`#article [data-word="small"][data-source-block="${doc.blocks[0].id}"]`)).toHaveCount(7);
    await expect(page.locator('#article [data-word="small"]').first()).toHaveAttribute('data-source-start', '0');
    const normalize = value => value.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < backward.length; i++) {
      const view = backward[i];
      if (i) expect(view.start, `${view.name}: contiguous page boundary`).toBe(backward[i - 1].end);
      let cursor = view.start;
      for (const fragment of view.fragments) {
        expect(fragment.from, `${view.name}: contiguous fragments`).toBe(cursor);
        expect(fragment.inside, `${view.name}: source within page`).toBe(true);
        const source = doc.blocks.find(block => block.id === fragment.block_id).text.slice(fragment.start, fragment.end);
        expect(normalize(fragment.text), `${view.name}: rendered source`).toBe(normalize(source));
        cursor = fragment.to;
      }
      expect(cursor, `${view.name}: complete visible window`).toBe(view.end);
    }
  } finally {
    await info.attach('source-windows', { body: JSON.stringify(steps, null, 2), contentType: 'application/json' });
  }
});
