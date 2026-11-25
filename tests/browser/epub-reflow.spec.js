import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { enableAll, readerDefaults } from './reader-helpers.js';

const engine = process.env.WR_E2E_ENGINE || 'chromium';
test.use({ browserName: engine, channel: engine === 'chromium' ? 'chrome' : '' });
const epub = fs.readFileSync(new URL('../fixtures/happy-prince.epub', import.meta.url));
const key = a => `${a.block}:${a.start}:${a.end}`;

// Read the mounted DOM, not the paginator's proposed packets. Hidden reflow
// reservations and annotation furniture are not source text.
async function paper(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.reader'), pages = root.__curlRendererTest.pages;
    const rects = node => [...node.getClientRects()].filter(r => r.width && r.height)
      .map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    const visible = node => getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
    const identity = item => item && ({ block: item.block.id, start: item.start, end: item.end, note: item.note });
    const fragments = [], words = [], glosses = [], geometry = [];
    for (const [column, leaf] of [...document.querySelectorAll('#article .page-leaf')].entries()) {
      const bounds = leaf.getBoundingClientRect();
      for (const block of leaf.querySelectorAll('[data-block]')) {
        if (!visible(block)) continue;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node, text = '';
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (parent.closest('.gloss,.annotation-gloss-space,.paragraph-actions,.bookmark-marker,.note-marker,.reflow-reservation-text') || !visible(parent)) continue;
          text += node.textContent;
        }
        if (text) fragments.push({ block: block.dataset.block, start: +block.dataset.start, end: +block.dataset.end, text });
      }
      for (const node of leaf.querySelectorAll('[data-word]')) {
        if (!visible(node) || node.closest('.annotation-gloss-space,.reflow-reservation-text')) continue;
        const boxes = rects(node);
        if (!boxes.length) continue;
        words.push({ block: node.dataset.sourceBlock, start: +node.dataset.sourceStart, end: +node.dataset.sourceEnd,
          word: node.dataset.word, column, boxes, annotated: Boolean(node.closest('[data-annotation]')),
          inside: boxes.every(b => b.left >= Math.max(0, bounds.left) && b.right <= Math.min(innerWidth, bounds.right) &&
            b.top >= Math.max(0, bounds.top) && b.bottom <= Math.min(innerHeight, bounds.bottom)) });
      }
      for (const node of leaf.querySelectorAll('.gloss')) {
        if (!visible(node) || node.closest('.annotation-gloss-space')) continue;
        const annotation = pages.r.annotations[+node.closest('[data-annotation]')?.dataset.annotation];
        for (const box of rects(node)) {
          const gloss = { ...identity(annotation), text: node.textContent, column, box };
          glosses.push(gloss);
          if (box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1)
            geometry.push({ kind: 'gloss-outside-page', gloss, page: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom } });
        }
      }
    }
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (const gloss of glosses) {
      const word = words.find(word => word.column === gloss.column && word.boxes.some(box => overlaps(gloss.box, box)));
      if (word) geometry.push({ kind: 'gloss-over-word', gloss, word });
    }
    for (let i = 0; i < glosses.length; i++) for (let j = i + 1; j < glosses.length; j++)
      if (glosses[i].column === glosses[j].column && overlaps(glosses[i].box, glosses[j].box))
        geometry.push({ kind: 'gloss-over-gloss', first: glosses[i], second: glosses[j] });
    return { doc: +root.dataset.documentId, index: +root.dataset.pageIndex, fragments, words, glosses, geometry,
      active: pages.activeAnnotations.map(identity) };
  });
}

for (const [layout, size] of [['double', 22], ['single', 28]]) {
  test(`public-domain EPUB ${layout} ${size}px: marking, reflow and chapter boundaries`, async ({ page, request }, info) => {
    test.setTimeout(240000);
    const findings = [], actions = [], traversals = [], seenGlosses = new Set(), expected = new Map();
    const check = (stage, kind, details) => findings.push({ stage, kind, details });
    page.on('pageerror', error => check('browser', 'pageerror', error.message));
    await readerDefaults(page);
    await page.setViewportSize({ width: 1600, height: 1088 });
    await page.addInitScript(({ layout, size }) => {
      localStorage.setItem('wr2:page-layout', JSON.stringify(layout));
      localStorage.setItem('wr2:typography', JSON.stringify({ size, line: 1.95, width: 760, font: 'serif' }));
    }, { layout, size });
    await enableAll(request);
    // Both layouts import the same fingerprint. Resume positions belong to a
    // different contract and must not start the second case halfway through.
    await request.patch('/api/plugins/progress', { data: { enabled: false } });
    const response = await request.post('/api/import', { multipart: {
      file: { name: 'happy-prince.epub', mimeType: 'application/epub+zip', buffer: epub },
    } });
    expect(response.ok(), await response.text()).toBe(true);
    const book = await response.json();
    expect(book.chapters).toHaveLength(7);
    const start = book.chapters.findIndex(ch => ch.title === 'The Happy Prince.');
    expect(start).toBeGreaterThan(0);
    const stories = book.chapters.slice(start, start + 2);
    expect(stories[1].title).toBe('The Nightingale and the Rose.');
    const documents = await Promise.all(stories.map(async ch => {
      const response = await request.get(`/api/documents/${ch.doc_id}?compact=true`);
      expect(response.ok()).toBe(true);
      return response.json();
    }));

    async function ready(id, pagination = true) {
      await expect(page.locator('.reader')).toHaveAttribute('data-document-id', String(id));
      await expect(page.locator('.reader')).toHaveAttribute('data-ready', 'true');
      if (pagination) await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
      await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'preparing');
      await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'playing');
    }
    async function witness(stage) {
      const state = await paper(page);
      for (const issue of state.geometry) check(stage, 'geometry', issue);
      for (const gloss of state.glosses) seenGlosses.add(`${state.doc}:${key(gloss)}`);
      return state;
    }
    async function turn(direction) {
      const leaf = await page.locator('#article .page-leaf').first().elementHandle();
      await page.locator(`#reading-edge-${direction}`).click();
      await expect.poll(() => leaf.evaluate(node => node.isConnected)).toBe(false);
      await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
    }
    async function rewind(doc) {
      for (let i = 0; i < 200; i++) {
        const state = await paper(page), first = state.fragments[0];
        expect(state.doc).toBe(doc.id);
        if (first?.block === doc.blocks[0].id && first.start === 0) return;
        await turn('prev');
      }
      throw new Error('Previous-page navigation never reached the chapter source start');
    }
    async function close() {
      await page.getByRole('button', { name: '关闭注释', exact: true }).click();
      await ready(+(await page.locator('.reader').getAttribute('data-document-id')));
    }
    async function choose(candidates) {
      for (const word of candidates) {
        const response = await request.post('/api/lookup', { data: { word: word.word, mark_unknown: false } });
        expect(response.ok()).toBe(true);
        const entry = await response.json();
        if (entry.dictionary?.senses?.some(sense => sense.text || sense.raw)) return word;
      }
      throw new Error('No dictionary-backed word in the requested page/line region');
    }
    async function open(word) {
      await page.locator(`#article [data-word][data-source-block="${word.block}"][data-source-start="${word.start}"]`).first().click();
      await expect(page.locator('.annotation-pop [data-usage-action="need"]')).toBeEnabled();
    }
    async function mark(word, sequence, stage, requireGloss = false) {
      for (const action of sequence) {
        const button = page.locator(`.annotation-pop [data-usage-action="${action}"]`);
        await button.click();
        await expect(button).toBeEnabled();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await ready(+(await page.locator('.reader').getAttribute('data-document-id')), false);
        const state = await witness(`${stage}:${action}`);
        const active = state.active.some(a => a.block === word.block && a.start <= word.start && a.end >= word.end);
        const shown = state.glosses.some(a => a.block === word.block && a.start <= word.start && a.end >= word.end);
        const need = action === 'need';
        if (active !== need || (!need && shown) || (requireGloss && need && !shown))
          check(stage, 'mark-state', { word, action, active, shown });
        for (const value of expected.values()) if (value.word.toLowerCase() === word.word.toLowerCase()) value.need = need;
        expected.set(`${state.doc}:${key(word)}`, { ...word, doc: state.doc, need });
        actions.push({ stage, word, action, active, shown });
      }
    }
    const eligible = state => state.words.filter(w => /^[a-z]{4,}$/i.test(w.word) && !w.annotated && w.inside);

    async function rounds(stage) {
      const state = await witness(stage), candidates = eligible(state).filter(w => w.column === 0);
      const group = candidates.find(word => candidates.some(other => other.block === word.block && other.boxes[0].top > word.boxes[0].bottom));
      expect(group).toBeTruthy();
      const first = await choose(candidates.filter(w => w.block === group.block && Math.abs(w.boxes[0].top - group.boxes[0].top) < 2));
      const nextLine = candidates.filter(w => w.block === first.block && w.boxes[0].top > first.boxes[0].bottom);
      const second = await choose(nextLine.filter(w => Math.abs(w.boxes[0].top - nextLine[0].boxes[0].top) < 2));
      for (const [i, word] of [first, second].entries()) {
        await open(word);
        await mark(word, ['need', 'known', 'need'], `${stage}:consecutive-line-${i}`, true);
        await close();
      }
      const lastWords = eligible(await paper(page)).filter(w => w.column === 0).reverse();
      const bottom = await choose(lastWords.filter(w => Math.abs(w.boxes[0].bottom - lastWords[0].boxes[0].bottom) < 2));
      await open(bottom);
      await mark(bottom, ['need', 'known', 'need', 'known'], `${stage}:page-end`);
      await close();
    }

    // Visit every mounted source fragment in order, validating both source
    // offsets and actual DOM text. Whitespace may collapse at soft line wraps.
    async function chapterText(doc, stage) {
      const texts = new Map(doc.blocks.map(b => [b.id, ''])), offsets = new Map(doc.blocks.map(b => [b.id, 0]));
      const visited = new Set();
      for (let spread = 0; spread < 200; spread++) {
        const state = await witness(`${stage}:spread-${spread}`);
        if (state.doc !== doc.id) { check(stage, 'premature-chapter-boundary', { expected: doc.id, actual: state.doc }); break; }
        const window = state.fragments.map(f => [f.block, f.start, f.end]);
        if (visited.has(JSON.stringify(window))) { check(stage, 'repeated-source-window', window); break; }
        visited.add(JSON.stringify(window));
        for (const fragment of state.fragments) {
          if (fragment.start !== offsets.get(fragment.block))
            check(stage, 'source-boundary', { block: fragment.block, expected: offsets.get(fragment.block), actual: fragment.start, end: fragment.end });
          texts.set(fragment.block, texts.get(fragment.block) + fragment.text);
          offsets.set(fragment.block, fragment.end);
        }
        const end = state.fragments.at(-1), last = doc.blocks.at(-1);
        if (end?.block === last.id && end.end === last.text.length) break;
        await turn('next');
      }
      const compact = text => text.replace(/\s/g, '');
      for (const block of doc.blocks) {
        if (offsets.get(block.id) !== block.text.length || compact(texts.get(block.id)) !== compact(block.text))
          check(stage, 'chapter-source-text', { block: block.id, end: offsets.get(block.id), expectedEnd: block.text.length,
            expected: block.text, actual: texts.get(block.id) });
      }
      traversals.push({ stage, chapter: doc.title, spreads: visited.size,
        expectedCharacters: doc.blocks.reduce((sum, b) => sum + compact(b.text).length, 0),
        actualCharacters: [...texts.values()].reduce((sum, text) => sum + compact(text).length, 0) });
    }

    try {
      await page.goto(`/?readingPerf=1#/read/${documents[0].id}`);
      await ready(documents[0].id);
      await rounds('first-story');
      for (let i = 0; i < 3; i++) { await turn('next'); await witness(`forward-${i}`); }
      for (let i = 0; i < 3; i++) { await turn('prev'); await witness(`back-${i}`); }
      await chapterText(documents[0], 'first-story-full-source');
      await turn('next');
      await ready(documents[1].id);
      await rounds('second-story');
      await chapterText(documents[1], 'second-story-full-source');
      // Return through the actual chapter-edge handoff, not a direct route jump.
      await rewind(documents[1]);
      await turn('prev');
      await ready(documents[0].id);
      await rewind(documents[0]);
      await witness('returned-first-story');

      const word = await choose(eligible(await paper(page)).filter(w => w.column === 0));
      await open(word);
      await mark(word, ['need', 'known'], 'before-resize', true);
      await close();
      await page.reload();
      await ready(documents[0].id);
      await open(word);
      const leaf = await page.locator('#article .page-leaf').first().elementHandle();
      await page.setViewportSize({ width: 1000, height: 760 });
      await expect.poll(() => leaf.evaluate(node => node.isConnected)).toBe(false);
      await ready(documents[0].id);
      await expect(page.locator('.annotation-pop')).toBeVisible();
      await mark(word, ['need'], 'open-card-resize', true);
      await info.attach('open-card-resize.png', { body: await page.screenshot(), contentType: 'image/png' });
      await close();
      await rounds('after-viewport-change');
      await chapterText(documents[0], 'resized-full-source');
      for (const [id, value] of expected) if (value.need && !seenGlosses.has(id)) check('final', 'missing-needed-gloss', value);
    } finally {
      await info.attach('epub-reflow-evidence.json', { body: JSON.stringify({ source: 'Project Gutenberg 902', layout, size, actions, traversals, findings }, null, 2), contentType: 'application/json' });
    }
    for (const kind of ['geometry', 'mark-state', 'source-boundary', 'chapter-source-text', 'premature-chapter-boundary', 'repeated-source-window', 'missing-needed-gloss', 'pageerror']) {
      const failures = findings.filter(f => f.kind === kind);
      expect.soft(failures.slice(0, 5), `${kind}: ${failures.length} findings; full evidence attached`).toEqual([]);
    }
  });
}
