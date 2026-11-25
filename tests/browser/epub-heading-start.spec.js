import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { enableAll, readerDefaults } from './reader-helpers.js';

const engine = process.env.WR_E2E_ENGINE || 'chromium';
test.use({ browserName: engine, channel: engine === 'chromium' ? 'chrome' : '' });
const epub = fs.readFileSync(new URL('../fixtures/happy-prince.epub', import.meta.url));

for (const laterMark of [false, true]) {
  test(`EPUB chapter heading survives page history ${laterMark ? 'with' : 'without'} a later word reflow`, async ({ page, request }, info) => {
    test.setTimeout(90000);
    const evidence = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await readerDefaults(page);
    await page.addInitScript(() => {
      localStorage.setItem('wr2:page-layout', JSON.stringify('single'));
      localStorage.setItem('wr2:typography', JSON.stringify({ size: 28, line: 1.95, width: 760, font: 'serif' }));
    });
    await page.setViewportSize({ width: 1000, height: 760 });
    await enableAll(request);
    await request.patch('/api/plugins/progress', { data: { enabled: false } });
    await request.patch('/api/profile', { data: { density: 4, vocab_size: 4500 } });
    const imported = await request.post('/api/import', { multipart: {
      file: { name: 'happy-prince.epub', mimeType: 'application/epub+zip', buffer: epub },
    } });
    expect(imported.ok()).toBe(true);
    const book = await imported.json();
    const chapter = book.chapters.find(c => c.title === 'The Nightingale and the Rose.');
    const doc = await (await request.get(`/api/documents/${chapter.doc_id}?compact=true`)).json();
    async function settled() {
      await expect(page.locator('.reader')).toHaveAttribute('data-ready', 'true');
      await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'preparing');
      await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'playing');
    }
    async function record(stage) {
      evidence.push(await page.evaluate(stage => {
        const p = document.querySelector('.reader').__curlRendererTest.pages;
        return { stage, index: p.index, identity: p.viewIdentity,
          first: document.querySelector('#article [data-block]')?.outerHTML,
          history: p.viewTrail?.map(v => ({ start: v.start, end: v.end, identity: v.identity, snapshots: Boolean(v.snapshots) })),
          historyIndex: p.viewTrailIndex };
      }, stage));
    }
    async function actions(word, sequence) {
      await page.locator('#article [data-word]').filter({ hasText: new RegExp(`^${word}$`, 'i') }).first().click();
      for (const action of sequence) {
        const button = page.locator(`.annotation-pop [data-usage-action="${action}"]`);
        await expect(button).toBeEnabled();
        await button.click();
        await expect(button).toBeEnabled();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await settled();
      }
      await page.getByRole('button', { name: '关闭注释', exact: true }).click();
      await settled();
    }
    async function turn(direction) {
      const leaf = await page.locator('#article .page-leaf').first().elementHandle();
      await page.locator(`#reading-edge-${direction}`).click();
      await expect.poll(() => leaf.evaluate(n => n.isConnected)).toBe(false);
      await settled();
      await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
      await record(direction);
    }
    const first = page.locator('#article [data-block]').first();
    async function opening() {
      await expect(first).toHaveAttribute('data-block', doc.blocks[0].id);
      await expect(first).toHaveAttribute('data-start', '0');
      await expect(first).toHaveAttribute('data-end', String(doc.blocks[0].text.length));
      expect(await first.locator('[data-word]').evaluateAll(nodes => nodes.map(n => n.dataset.word)))
        .toEqual(['The', 'Nightingale', 'and', 'the', 'Rose']);
    }
    try {
      await page.goto(`/?readingPerf=1#/read/${doc.id}`);
      await settled();
      await actions('rose', ['need']);
      await actions('wondered', ['known']);
      await page.reload();
      await settled();
      await opening();
      await actions('wondered', ['need', 'known']);
      await opening();
      await record('opening-after-mark');
      await turn('next');
      await turn('next');
      if (laterMark) { await actions('break', ['need', 'known']); await record('later-mark'); }
      await turn('prev');
      await turn('prev');
      await opening();
      expect(errors).toEqual([]);
    } finally {
      await info.attach('heading-history.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    }
  });
}
