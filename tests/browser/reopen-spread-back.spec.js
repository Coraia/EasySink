import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { enableAll, readerDefaults } from './reader-helpers.js';

const engine = process.env.WR_E2E_ENGINE || 'chromium';
test.use({ browserName: engine, channel: engine === 'chromium' ? 'chrome' : '' });
const epub = fs.readFileSync(new URL('../fixtures/happy-prince.epub', import.meta.url));

for (const resume of ['marked-spread', 'right-leaf', 'last-leaf']) test(`reopened two-page ${resume} keeps spread labels and source seams aligned`, async ({ page, request }, info) => {
  test.setTimeout(90000);
  await readerDefaults(page);
  await page.setViewportSize({ width: 1600, height: 1088 });
  await page.addInitScript(() => {
    localStorage.setItem('wr2:page-layout', JSON.stringify('double'));
    localStorage.setItem('wr2:typography', JSON.stringify({ size: 22, line: 1.95, width: 900, font: 'serif' }));
  });
  await enableAll(request);
  await request.patch('/api/profile', { data: { density: 4 } });
  const imported = await request.post('/api/import', { multipart: {
    file: { name: 'happy-prince.epub', mimeType: 'application/epub+zip', buffer: epub },
  } });
  expect(imported.ok()).toBe(true);
  const book = await imported.json();
  const chapter = book.chapters.find(ch => ch.title === 'The Nightingale and the Rose.');
  const doc = await (await request.get(`/api/documents/${chapter.doc_id}?compact=true`)).json();
  expect((await request.put(`/api/documents/${doc.id}/progress`, { data: {
    scroll_ratio: 0, anchor: { block_id: doc.blocks[0].id, start: 0, end: 0, version: doc.version },
  } })).ok()).toBe(true);
  const evidence = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const settled = () => expect.poll(() => page.evaluate(() => document.querySelector('.reader')?.__curlRendererTest?.pages.r.interaction.canRecordPosition())).toBe(true);
  const record = async stage => {
    const view = await page.evaluate(stage => {
      const root = document.querySelector('.reader'), p = root.__curlRendererTest.pages;
      const offset = a => p.offsets.get(a.block_id) + a.start;
      const fragments = [...document.querySelectorAll('#article .page-leaf [data-block]')].filter(block =>
        !block.closest('[aria-hidden="true"]') && getComputedStyle(block).visibility !== 'hidden').map(block => {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node, text = '';
        while ((node = walker.nextNode())) if (
          !node.parentElement.closest('.gloss,.annotation-gloss-space,.paragraph-actions,.bookmark-marker,.note-marker,.reflow-reservation-text') &&
          getComputedStyle(node.parentElement).visibility !== 'hidden') text += node.textContent;
        return { id: block.dataset.block, start: +block.dataset.start, end: +block.dataset.end,
          from: p.offsets.get(block.dataset.block) + +block.dataset.start,
          to: p.offsets.get(block.dataset.block) + +block.dataset.end, text };
      }).filter(part => part.end > part.start);
      const first = fragments[0], last = fragments.at(-1);
      return { stage, index: p.index, label: document.querySelector('#reading-page-total').textContent,
        start: first.from, end: last.to, canonicalIndex: p.pageFor({ block_id: first.id, start: first.start }),
        position: p.r.position(), fragments, canonical: p.pages.map(parts => parts.map(part => ({ from: p.offsets.get(part.id) + part.start, to: p.offsets.get(part.id) + part.end }))),
        history: p.viewTrail?.map(view => ({ start: offset(view.start), end: offset(view.end), index: view.canonicalIndex })) };
    }, stage);
    evidence.push(view);
    console.log(stage, JSON.stringify({ label: view.label, start: view.start, end: view.end, canonicalIndex: view.canonicalIndex }));
    return view;
  };
  const turn = async direction => {
    const before = await page.locator('.reader').getAttribute('data-source-position');
    await page.locator(`#reading-edge-${direction}`).click();
    await expect(page.locator('.reader')).not.toHaveAttribute('data-source-position', before);
    await settled();
    return record(direction);
  };
  try {
    await page.goto(`/?readingPerf=1#/read/${doc.id}`);
    await settled();
    await expect(page.locator('.reader')).toHaveAttribute('data-page-layout', 'double');
    await record('opening');
    await turn('next');
    await page.locator('#article [data-word="tail"]').first().click();
    const need = page.locator('.annotation-pop [data-usage-action="need"]');
    await need.click();
    await expect(need).toBeEnabled();
    await expect(need).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '关闭注释', exact: true }).click();
    await settled();
    await record('tail-need');
    await turn('next');
    const departed = await turn('next');
    const destination = await page.evaluate(resume => {
      const p = document.querySelector('.reader').__curlRendererTest.pages;
      if (resume === 'marked-spread') return { anchor: p.r.position(), index: p.index };
      const index = resume === 'right-leaf' ? 5 : p.pages.length - 1;
      const part = p.pages[index][0];
      return { anchor: p.r.anchorFor(part.id, part.start, part.start), index: Math.floor(index / 2) * 2 };
    }, resume);
    await page.evaluate(async () => {
      const pending = [];
      window.dispatchEvent(new CustomEvent('reader-before-close', { detail: { waitUntil: promise => pending.push(promise) } }));
      await Promise.all(pending);
    });
    await page.goto('/health');
    if (resume !== 'marked-spread') expect((await request.put(`/api/documents/${doc.id}/progress`, {
      data: { anchor: destination.anchor },
    })).ok()).toBe(true);
    await page.goto(`/?readingPerf=1#/read/${doc.id}`);
    await settled();
    const reopened = await record('reopened');
    expect(reopened.position.block_id).toBe(destination.anchor.block_id);
    expect(reopened.position.start).toBe(destination.anchor.start);
    if (resume === 'marked-spread') {
      expect(reopened.start).toBeLessThanOrEqual(departed.start);
      expect(reopened.end).toBeGreaterThan(departed.start);
    }
    const backward = [reopened];
    for (let i = destination.index; i > 0; i -= 2) backward.push(await turn('prev'));
    expect(backward.map(view => view.index)).toEqual(Array.from({ length: destination.index / 2 + 1 }, (_, i) => destination.index - i * 2));
    if (resume !== 'last-leaf') expect(backward.map(view => view.label.match(/\d+–\d+/)?.[0]))
      .toEqual(resume === 'marked-spread' ? ['7–8', '5–6', '3–4', '1–2'] : ['5–6', '3–4', '1–2']);
    const normalize = value => value.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < backward.length; i++) {
      const view = backward[i];
      expect(view.index % 2, `${view.stage}: spread parity`).toBe(0);
      if (i) expect(view.end, 'contiguous spread seam').toBe(backward[i - 1].start);
      let cursor = view.start;
      for (const part of view.fragments) {
        expect(part.from, 'contiguous leaf and block seams').toBe(cursor);
        expect(normalize(part.text)).toBe(normalize(doc.blocks.find(block => block.id === part.id).text.slice(part.start, part.end)));
        cursor = part.to;
      }
      expect(cursor).toBe(view.end);
    }
    const first = page.locator('#article [data-block]').first();
    await expect(first).toHaveAttribute('data-block', doc.blocks[0].id);
    await expect(first).toHaveAttribute('data-start', '0');
    expect(backward.at(-1).start).toBe(0);
    expect(normalize(backward.at(-1).fragments[0].text)).toBe(doc.blocks[0].text);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('spread-history', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await page.goto('/health');
    const cleanup = await request.post('/api/collections/cleanup', { data: { book_id: book.book_id, feedback: true, confirm: true } });
    expect(cleanup.ok()).toBe(true);
  }
});
