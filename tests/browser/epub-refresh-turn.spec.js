import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { enableAll, readerDefaults } from './reader-helpers.js';

for (const [turn, status] of [[false, 200], [true, 200], [true, 503]]) test(`delayed EPUB refresh ${status} preserves the source ${turn ? 'after next' : 'without navigation'}`, async ({ page, request }, info) => {
  await readerDefaults(page);
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.addInitScript(() => localStorage.setItem('wr2:typography', JSON.stringify({ size: 28, line: 1.95, width: 760, font: 'serif' })));
  await enableAll(request);
  await request.patch('/api/plugins/progress', { data: { enabled: false } });
  const imported = await request.post('/api/import', { multipart: {
    file: { name: 'happy-prince.epub', mimeType: 'application/epub+zip', buffer: fs.readFileSync(new URL('../fixtures/happy-prince.epub', import.meta.url)) },
  } });
  expect(imported.ok()).toBe(true);
  const book = await imported.json(), doc = book.chapters.find(ch => ch.title === 'The Happy Prince.');
  await page.goto(`/?readingPerf=1#/read/${doc.doc_id}`);
  await expect.poll(() => page.evaluate(() => document.querySelector('.reader')?.__curlRendererTest?.pages.r.interaction.isSettled())).toBe(true);
  await page.locator('#article [data-word="High"]').first().click();
  await page.locator('.annotation-pop [data-usage-action="need"]').click();
  await expect(page.locator('.annotation-pop [data-usage-action="need"]')).toBeEnabled();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let arrived;
  const requested = new Promise(resolve => { arrived = resolve; });
  await page.route(`**/api/documents/${doc.doc_id}?compact=true*`, async route => {
    arrived();
    await held;
    if (status === 200) await route.continue();
    else await route.fulfill({ status, json: { detail: 'Metadata temporarily unavailable' } });
  });
  const evidence = [];
  async function record(stage) {
    evidence.push(await page.evaluate(stage => {
      const p = document.querySelector('.reader').__curlRendererTest.pages;
      return { stage, index: p.index, navigation: p.navigation, refreshing: p.r.restoring,
        start: p.r.captureView().visibleAnchor, historyIndex: p.viewTrailIndex,
        history: p.viewTrail?.map(v => ({ start: v.start, end: v.end })) };
    }, stage));
  }
  try {
    await page.getByRole('button', { name: '关闭注释', exact: true }).click();
    await requested;
    await record('metadata-request-held');
    if (turn) {
      await page.locator('#reading-edge-next').click();
      await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '1');
    }
    await record(turn ? 'next-committed' : 'no-navigation');
    const next = evidence.at(-1).start;
    release();
    await expect.poll(() => page.evaluate(() => document.querySelector('.reader').__curlRendererTest.pages.r.interaction.isSettled())).toBe(true);
    await record('metadata-published');
    expect(evidence.at(-1).start).toEqual(next);
  } finally {
    release();
    await info.attach('refresh-turn-order.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    const cleanup = await request.post('/api/collections/cleanup', { data: { book_id: book.book_id, feedback: true, confirm: true } });
    expect(cleanup.ok()).toBe(true);
  }
});
