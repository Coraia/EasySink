import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { enableAll, read, pageIndex, focus, selectParagraph, tools } from './reader-helpers.js';

test.use({ channel: 'chrome', trace: 'off', deviceScaleFactor: 2,
  launchOptions: { args: ['--use-angle=metal', '--enable-gpu'] } });
const body = 'A prominent contribution changes our understanding. The reasoning of these two men did not carry conviction, since knowledge is acquired in relations. '.repeat(8);
async function phase(page, phase, dx = 0, dy = 0, momentum = 0, handled = true) {
  const root = page.locator('.reader'), hasReader = await root.count();
  const before = hasReader
    ? await root.getAttribute('data-native-trackpad')
      .then(value => JSON.parse(value || '{}').events || 0)
    : 0;
  if (page.__desktopNative) await page.evaluate(payload => {
    const point = window.__e2eNativePointer || { clientX: innerWidth / 2, clientY: innerHeight / 2 };
    window.dispatchEvent(new CustomEvent('wise-reader-native-trackpad', { detail: {
      source: 'macOS-NSEvent', phase: payload.phase, dx: payload.dx, dy: payload.dy,
      momentum: payload.momentum, clientX: point.clientX, clientY: point.clientY,
      nativeTime: performance.now(), sequence: (window.__e2eNativeSequence = (window.__e2eNativeSequence || 0) + 1),
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, buttons: 0,
    } }));
  }, {phase, dx, dy, momentum});
  else page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase, dx, dy, momentum }));
  const publishes = (phase & (1 | 8 | 16)) || (momentum & 8);
  if (hasReader && handled && publishes) await expect.poll(async () => {
    const value = await page.locator('.reader').getAttribute('data-native-trackpad');
    return JSON.parse(value || '{}').events || 0;
  }).toBeGreaterThan(before);
  else await page.waitForTimeout(40);
}
async function over(page) {
  const point = await page.evaluate(() => {
    const article = document.querySelector('#article');
    const box = article.getBoundingClientRect();
    const blocked = 'button,a,input,textarea,select,[contenteditable],#reading-selection,#translation-pane,.inline-grammar,.annotation-pop,#tool-panel,#reader-chrome';
    for (const y of [.2, .4, .6, .8]) for (const x of [.2, .4, .6, .8]) {
      const clientX = box.left + box.width * x, clientY = box.top + box.height * y;
      const target = document.elementFromPoint(clientX, clientY);
      if (target?.closest('#reading-stage') && !target.closest(blocked)) return {clientX, clientY};
    }
    throw new Error('No unobstructed paper point');
  });
  await page.mouse.move(point.clientX, point.clientY);
}
async function overCardBody(page, card) {
  const point = await card.evaluate(element => {
    const box = element.getBoundingClientRect();
    for (const y of [.2, .4, .6, .8]) for (const x of [.2, .4, .6, .8]) {
      const clientX = box.left + box.width * x, clientY = box.top + box.height * y;
      const target = document.elementFromPoint(clientX, clientY);
      if (element.contains(target) && !target.closest('a,button,input,textarea,select,[contenteditable]'))
        return {clientX, clientY};
    }
    throw new Error('No non-control word-card point');
  });
  await page.mouse.move(point.clientX, point.clientY);
}
async function prepared(page, request, layout = 'single', {desktop = false, text = null} = {}) {
  await page.addInitScript(layout => {
    localStorage.setItem('wr2:page-layout', JSON.stringify(layout));
    localStorage.setItem('wr2:page-motion', JSON.stringify('curl'));
  }, layout);
  if (desktop) {
    page.__desktopNative = true;
    await page.addInitScript(() => {
      window.wiseReaderDesktop = {nativeTrackpad: true};
      addEventListener('pointermove', event => {
        window.__e2eNativePointer = {clientX: event.clientX, clientY: event.clientY};
      }, {capture: true});
    });
  } else {
    await page.route('**/api/reading/native-trackpad', route => route.fulfill({ json: {
      available: true, platform: 'darwin', url: 'ws://127.0.0.1:8769/events?token=fixture' } }));
    await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:8769\/events/, ws => {
      page.__native = ws;
      ws.send(JSON.stringify({ source: 'bridge-ready', monitorReady: true }));
    });
  }
  const doc = await (await request.post('/api/documents', { data: {
    title: 'Native trackpad production acceptance', text: text || Array(60).fill(body).join('\n\n') } })).json();
  await page.goto(`/?readingPerf=1#/read/${doc.id}`);
  await expect(page.locator('.reader')).toHaveAttribute('data-document-id', String(doc.id));
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-trackpad-mode', 'native');
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
  await over(page);
  return doc;
}
async function preparedPresentation(page, request, {
  desktop = false, text = null, retainedWord = 'conviction', retainedSide = null,
} = {}) {
  await request.patch('/api/profile', { data: { density: 15 } });
  const doc = await prepared(page, request, 'double', {desktop, text});
  const retainedRoot = retainedSide
    ? page.locator('.page-leaf').nth(retainedSide === 'left' ? 0 : 1)
    : page.locator('#article');
  const retained = retainedRoot.locator(`[data-word="${retainedWord}"]`).first();
  await retained.click();
  await expect(page.locator('.annotation-pop .dictionary-candidates')).toBeVisible();
  await page.locator('[data-retained]').click();
  await expect(page.locator('[data-retained]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-retained]')).toBeEnabled();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  await expect.poll(() => page.locator(`#article [data-target="${retainedWord}"]`).count()).toBeGreaterThan(0);
  await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
  await over(page);
  for (let i = 0; i < 2; i++) {
    await phase(page, 1, 700);
    await phase(page, 8);
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
    await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
  }
  const anchor = JSON.parse(await page.locator('.reader').getAttribute('data-source-position'));
  expect(anchor.block_id).toBeTruthy();
  expect(Number.isInteger(anchor.start)).toBe(true);
  const saved = await request.put(`/api/documents/${doc.id}/progress`, {
    data: { scroll_ratio: anchor.ratio, anchor },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-trackpad-mode', 'native');
  await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
  const plan = JSON.parse(await page.locator('.reader').getAttribute('data-curl-warm-plan'));
  expect(plan.presentation).toBe(true);
  expect(plan.windows.length).toBeGreaterThanOrEqual(2);
  expect(plan.keys).toHaveLength(6);
  await over(page);
  return {doc, plan};
}
const snap = page => page.evaluate(() => ({
  index: +document.querySelector('.reader').dataset.pageIndex,
  source: document.querySelector('.reader').dataset.sourcePosition,
  state: document.querySelector('.reader').dataset.trackpadState,
  pin: JSON.parse(document.querySelector('#page-curl-layer').dataset.pin || 'null'),
  resolution: JSON.parse(document.querySelector('.reader').dataset.curlResolution || 'null'),
}));
test.beforeEach(async ({ page, request }) => {
  await enableAll(request);
  page.__errors = []; page.on('pageerror', e => page.__errors.push(e.stack || e.message));
});
test.afterEach(async ({ page }, info) => {
  await info.attach('native-production.json', { body: JSON.stringify({
    scope: 'production DOM and Metal GPU, native phase fixture; physical trackpad acceptance separate',
    data: await page.evaluate(() => ({ ...document.querySelector('.reader')?.dataset })) }, null, 2), contentType: 'application/json' });
  expect(page.__errors).toEqual([]);
});
for (const layout of ['single', 'double']) test(`${layout}: contact holds, reverses, ends, and rapid/alternating turns preserve order`, async ({ page, request }, info) => {
  await prepared(page, request, layout);
  const step = layout === 'double' ? 2 : 1;
  const before = await snap(page);
  await phase(page, 1, 250, 25);
  await expect(page.locator('#page-curl-layer')).toBeVisible();
  await expect.poll(async () => (await snap(page)).pin).not.toBeNull();
  const held = await snap(page);
  await phase(page, 2, 0, 0, 0, false);
  await page.waitForTimeout(1000);
  expect((await snap(page)).index).toBe(0);
  expect((await snap(page)).pin).toEqual(held.pin);
  await phase(page, 4, -80, -10);
  await phase(page, 8);
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  expect((await snap(page)).source).toBe(before.source);
  for (let i = 0; i < 3; i++) {
    await phase(page, 1, 700); await phase(page, 8);
  }
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String(3 * step));
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  for (const [direction, target] of [[-1, 2], [1, 3], [-1, 2], [1, 3]]) {
    await phase(page, 1, direction * 700); await phase(page, 8);
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String(target * step));
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  }
  await phase(page, 0, 2000, 0, 1); await phase(page, 0, 1000, 0, 4); await phase(page, 0, 0, 0, 8);
  expect(await pageIndex(page)).toBe(3 * step);
  const metrics = await page.evaluate(() => JSON.parse(document.querySelector('.reader').dataset.curlMetrics));
  const native = metrics.filter(m => m.reason.startsWith('native-'));
  expect(native).toHaveLength(8);
  expect(native.every(m => m.release.actualDurationMs < 240)).toBe(true);
  await info.attach('native-sequence-timing.json', { body: JSON.stringify(native), contentType: 'application/json' });
});
test('tools, zoom, Escape and disconnect do not commit a held page; a source selection yields to paging', async ({ page, request }) => {
  await prepared(page, request);
  await phase(page, 1, 200);
  await page.keyboard.press('Escape');
  await phase(page, 8); expect(await pageIndex(page)).toBe(0);
  await page.locator('#show-tools').click();
  await expect(page.locator('.reader')).toHaveAttribute('data-chrome', 'open');
  await phase(page, 1, 900, 0, 0, false); await phase(page, 8, 0, 0, 0, false); expect(await pageIndex(page)).toBe(0);
  await focus(page); await selectParagraph(page, 0);
  await over(page); await phase(page, 1, 900); await phase(page, 8);
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '1');
  await expect(page.locator('#reading-selection')).toBeHidden();
  expect(await page.evaluate(() => getSelection()?.isCollapsed ?? true)).toBe(true);
  await over(page); await phase(page, 1, -900); await phase(page, 8);
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '0');
  await expect(page.locator('#reading-selection')).toBeHidden();
  await over(page);
  await page.locator('#article').dispatchEvent('wheel', { deltaX: 900, ctrlKey: true, bubbles: true });
  expect(await pageIndex(page)).toBe(0);
  await phase(page, 1, 200);
  await expect(page.locator('#page-curl-layer')).toBeVisible();
  await page.__native.close();
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-trackpad-mode', 'native-unavailable');
  expect(await pageIndex(page)).toBe(0);
  await page.locator('#reading-edge-next').click();
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '1');
});
test('an open word card keeps vertical card scrolling but its source word yields to horizontal paging', async ({ page, request }) => {
  await prepared(page, request, 'single', {desktop: true});
  const word = page.locator('#article [data-word="conviction"]').first();
  await word.click();
  const card = page.locator('.annotation-pop');
  await expect(card).toBeVisible();
  await page.getByRole('button', {name: '关闭注释', exact: true}).hover();
  await phase(page, 1, 900, 0, 0, false);
  await phase(page, 8, 0, 0, 0, false);
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '0');
  await expect(card).toBeVisible();
  await card.evaluate(element => {
    element.style.height = '180px';
    element.style.overflow = 'auto';
    const probe = document.createElement('div');
    probe.style.height = '420px';
    probe.dataset.scrollProbe = '';
    element.append(probe);
  });
  expect(await card.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await overCardBody(page, card);
  const scrollTop = await card.evaluate(element => element.scrollTop);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => card.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollTop);
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '0');
  await expect(card).toBeVisible();
  await phase(page, 1, 900);
  await phase(page, 8);
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '1');
  await expect(card).toBeHidden();
  await over(page);
  await phase(page, 1, -900);
  await phase(page, 8);
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '0');
  await word.click();
  await expect(page.locator('.annotation-pop')).toBeVisible();
});
for (const complete of [false, true]) test(`real annotation reflow preserves the ${complete ? 'landed' : 'cancelled'} source window`, async ({page, request}, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({width: 1200, height: 739});
  const text = Array.from({length: 72}, (_, index) =>
    `SOURCE SECTION ${String(index).padStart(2, '0')}. The small research team prepared a plan for the harbor, ` +
    'although each member proposed a different way to arrange the tables and check the lamps before sunset, ' +
    'using unaided observation, calm discussion, and careful notes. Each person checked the final diagram.').join('\n\n');
  await request.patch('/api/profile', {data: {density: 15, vocab_size: 8000}});
  const doc = await prepared(page, request, 'double', {desktop: true, text});
  const need = page.getByRole('button', {name: '需注释：后续相同适用表达继续显示', exact: true});
  await page.locator('#article .page-leaf').nth(1).locator('[data-word="unaided"]').first().click();
  await expect(page.locator('[data-retained]')).toBeEnabled();
  await page.locator('[data-retained]').click();
  await expect(page.locator('[data-retained]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-retained]')).toBeEnabled();
  if (await need.getAttribute('aria-pressed') !== 'true') await need.click();
  await expect(need).toHaveAttribute('aria-pressed', 'true');
  await expect(need).toBeEnabled();
  // Keep the same chain as the WK failure: a real dirty update completes a
  // turn, then another real update cancels/commits on that landed spread.
  await page.locator('#reading-edge-next').click();
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  await expect.poll(() => page.evaluate(() => JSON.parse(document.querySelector('.reader').dataset.curlMetrics).at(-1).completed)).toBe(true);
  // Observe real application state; never manufacture pendingLayout or change
  // the pagination/annotation implementation to make the fixture dirty.
  await page.evaluate(() => {
    const pages = document.querySelector('.reader').__curlRendererTest.pages;
    const reflow = pages.reflow.bind(pages), render = pages.render.bind(pages);
    window.__anchorRepro = {reflows: [], renders: [], landed: null, canonicalBuilds: 0};
    const build = pages.buildPages.bind(pages);
    pages.buildPages = (...args) => { window.__anchorRepro.canonicalBuilds++; return build(...args); };
    window.__sourceWitness = anchor => {
      const view = pages.r.captureView(), raw = anchor || view.visibleAnchor;
      const source = raw && {...raw, ratio: ((pages.offsets.get(raw.block_id) || 0) + raw.start) / pages.length};
      const node = source && [...document.querySelectorAll('#article [data-word]')].find(n =>
        n.dataset.sourceBlock === source.block_id && +n.dataset.sourceStart <= source.start && +n.dataset.sourceEnd > source.start);
      const leaf = node?.closest('.page-leaf'), box = node?.getBoundingClientRect(), paper = leaf?.getBoundingClientRect();
      const order = pages.r.doc.blocks.findIndex(b => b.id === source?.block_id);
      return {source, affinity: 'forward', order, reading: pages.position(),
        first: view.visibleAnchor, index: pages.index,
        location: box && {leaf: [...document.querySelectorAll('#article .page-leaf')].indexOf(leaf),
          x: (box.x - paper.x) / paper.width, y: (box.y - paper.y) / paper.height},
        pending: Boolean(pages.wordReflow.pendingLayout), dirty: pages.canonicalDirty,
        flushing: Boolean(pages.wordReflow.flushing), eligible: Boolean(pages.wordReflow.eligible()),
        signature: JSON.stringify(pages.activeAnnotations.map(a => [a.block.id,a.start,a.end,a.note])),
        canonicalRevision: pages.canonicalRevision, displayRevision: pages.displayRevision,
        geometryRestore: pages.geometryRestore || null};
    };
    pages.reflow = (anchor, options) => {
      window.__anchorRepro.reflows.push({anchor, options, at: performance.now(), witness: window.__sourceWitness()});
      return reflow(anchor, options);
    };
    pages.render = () => {
      const result = render();
      window.__anchorRepro.renders.push({at: performance.now(), witness: window.__sourceWitness()});
      return result;
    };
    const commit = pages.commitPresentation.bind(pages);
    pages.commitPresentation = packet => {
      const result = commit(packet);
      if (pages.presentedView === packet.view) window.__anchorRepro.landed = window.__sourceWitness();
      return result;
    };
  });
  const clean = await page.evaluate(() => window.__sourceWitness());
  await page.locator('#article .page-leaf').nth(1).locator('[data-word="unaided"]').first().click();
  const known = page.getByRole('button', {name: '认识：后续相同适用表达不再自动标注', exact: true});
  await known.click();
  await expect(known).toHaveAttribute('aria-pressed', 'true');
  await expect(known).toBeEnabled();
  // A legitimate earlier-occurrence update makes canonical page rebasing
  // deterministic across Chromium/WebKit font metrics, without changing the
  // visible source or fabricating pending state. The normal controller applies
  // the persisted record and emits the real annotation-signature change.
  const earlier = await page.evaluate(() => {
    const reader = document.querySelector('.reader').__curlRendererTest.pages.r;
    const block = reader.doc.blocks[0], start = block.text.indexOf('unaided');
    return reader.anchorFor(block.id, start, start + 'unaided'.length);
  });
  const saved = await request.post('/api/collections/feedback', {data: {
    doc_id: doc.id, anchor: earlier, retained: true, target: 'unaided',
    note: '在此语境中指没有外界协助而独立进行推理和理解。'.repeat(18),
  }});
  expect(saved.ok()).toBe(true);
  await page.evaluate(async () => {
    const reader = document.querySelector('.reader').__curlRendererTest.pages.r;
    await reader.collectionsController.reload();
    await reader.annotationDrawPromise;
  });
  await expect.poll(() => page.evaluate(() => Boolean(
    document.querySelector('.reader').__curlRendererTest.pages.wordReflow.pendingLayout))).toBe(true);
  await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'preparing');
  await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'playing');
  const before = await page.evaluate(() => window.__sourceWitness());
  expect(before.signature).not.toBe(clean.signature);
  expect(before.pending).toBe(true);
  expect(before.location).toBeTruthy();
  const edge = await page.locator('#reading-edge-next').boundingBox();
  const x = edge.x + edge.width / 2, y = edge.y + edge.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x - (complete ? 470 : 20), y);
  // Duplicate notifications may ask for reconciliation but must not duplicate
  // work or publish a pre-turn anchor over the eventual committed source.
  await page.evaluate(() => {
    const reader = document.querySelector('.reader').__curlRendererTest.pages.r;
    reader.emit('reading-uncovered'); reader.emit('reading-uncovered');
  });
  await page.mouse.up();
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  await expect.poll(() => page.evaluate(() => {
    const p = document.querySelector('.reader').__curlRendererTest.pages;
    return Boolean(p.wordReflow.pendingLayout || p.wordReflow.flushing || p.r.annotationRefreshPending || p.r.restoring);
  })).toBe(false);
  await page.waitForTimeout(350);
  const result = await page.evaluate(before => {
    const root = document.querySelector('.reader'), p = root.__curlRendererTest.pages;
    return {after: window.__sourceWitness(), originalLocation: window.__sourceWitness(before.source),
      trace: window.__anchorRepro, metric: JSON.parse(root.dataset.curlMetrics).at(-1),
      annotations: p.activeAnnotations.filter(a => a.target === 'unaided').length};
  }, before);
  await info.attach('semantic-anchor.json', {body: JSON.stringify({complete, clean, before, ...result}, null, 2), contentType: 'application/json'});
  await info.attach('semantic-anchor-stable.png', {body: await page.screenshot(), contentType: 'image/png'});
  expect(result.metric.completed).toBe(complete);
  expect(result.metric.reason).toBe(complete ? 'flick' : 'spring-back');
  const turn=result.metric.raw.setup.turn;
  expect(turn.outcome.status).toBe(complete ? 'landed' : 'cancelled');
  expect(turn.stable).toBe(true);
  expect(turn.sourceStable.anchor.block_id).toBe(result.after.first.block_id);
  expect(turn.sourceStable.anchor.start).toBe(result.after.first.start);
  expect(result.after.signature).toBe(before.signature);
  expect(result.after.pending).toBe(false);
  expect(result.after.dirty).toBe(false);
  expect(result.after.canonicalRevision).toBe(result.after.displayRevision);
  if (!complete) {
    expect(result.after.first.block_id).toBe(before.first.block_id);
    expect(result.after.first.start).toBe(before.first.start);
    expect(result.originalLocation.location?.leaf).toBe(before.location.leaf);
    expect(Math.abs(result.originalLocation.location.y - before.location.y)).toBeLessThan(.05);
    expect(result.trace.canonicalBuilds).toBe(1);
  } else {
    expect(result.trace.landed).toBeTruthy();
    expect(result.after.first.block_id).toBe(result.trace.landed.first.block_id);
    expect(result.after.first.start).toBe(result.trace.landed.first.start);
    expect(result.after.order).toBeGreaterThanOrEqual(before.order);
    expect(result.after.reading.ratio).toBeGreaterThan(before.reading.ratio);
    expect(result.trace.canonicalBuilds).toBe(1);
  }
});

test('geometry coalescing and retired documents reject old annotation tickets', async ({page, request}, info) => {
  test.setTimeout(60000);
  await preparedPresentation(page, request, {desktop: true});
  await page.locator('#article .page-leaf').nth(1).locator('[data-word]').first().click();
  await expect(page.locator('[data-retained]')).toBeEnabled();
  await page.locator('[data-retained]').click();
  await expect(page.locator('[data-retained]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-retained]')).toBeEnabled();
  await page.evaluate(() => {
    const pages=document.querySelector('.reader').__curlRendererTest.pages;
    window.__oldAnchorWork={pages,mutation:pages.wordReflow.pendingLayout,
      ticket:pages.captureLayoutTicket(),view:pages.r.captureView()};
  });
  expect(await page.evaluate(() => Boolean(window.__oldAnchorWork.mutation?.originView.visibleAnchor))).toBe(true);
  await page.getByRole('button', {name:'关闭注释',exact:true}).click();
  await tools(page,'typography');
  await page.locator('#type-size').evaluate(element => {
    for(const size of [24,26]) {element.value=size;element.dispatchEvent(new Event('input',{bubbles:true}));}
  });
  await tools(page,'appearance');
  await page.locator('#reader-layout').selectOption('single');
  await page.locator('#reader-layout').selectOption('double');
  await focus(page);
  await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('.reader').__curlRendererTest.pages.markStable()))).toBe(true);
  const geometry=await page.evaluate(async () => {
    const old=window.__oldAnchorWork,p=old.pages,before=p.r.captureView();
    const rejected=await p.wordReflow.flush({anchor:old.view.visibleAnchor,ticket:old.ticket,reconcile:true});
    return {before,after:p.r.captureView(),oldTicketCurrent:p.isCurrent(old.ticket),rejected,
      size:getComputedStyle(document.documentElement).getPropertyValue('--reading-size'),count:p.count,
      sourceVisible:p.r.isAnchorVisible(old.view.visibleAnchor)};
  });
  expect(geometry.oldTicketCurrent).toBe(false);
  expect(geometry.rejected).toBe(false);
  expect(geometry.sourceVisible).toBe(true);
  expect(geometry.size).toBe('26px'); expect(geometry.count).toBe(2);
  expect(geometry.after.visibleAnchor).toEqual(geometry.before.visibleAnchor);
  const next=await (await request.post('/api/documents',{data:{title:'New source owns the layout',text:body.repeat(4)}})).json();
  await page.goto(`/?readingPerf=1#/read/${next.id}`);
  await expect(page.locator('.reader')).toHaveAttribute('data-document-id',String(next.id));
  await expect(page.locator('.reader')).toHaveAttribute('data-ready','true');
  const retired=await page.evaluate(async () => {
    const old=window.__oldAnchorWork,p=document.querySelector('.reader').__curlRendererTest.pages;
    const before=p.r.captureView();
    const rejected=await old.pages.wordReflow.flush({anchor:old.view.visibleAnchor,ticket:old.ticket,reconcile:true});
    return {before,after:p.r.captureView(),rejected,oldAborted:old.pages.r.scope.signal.aborted,
      oldPending:Boolean(old.pages.wordReflow.pendingLayout),newPending:Boolean(p.wordReflow.pendingLayout)};
  });
  expect(retired.rejected).toBe(false); expect(retired.oldAborted).toBe(true);
  expect(retired.oldPending).toBe(false); expect(retired.newPending).toBe(false);
  expect(retired.after).toEqual(retired.before);
  await info.attach('geometry-and-retired-ticket.json',{body:JSON.stringify({geometry,retired},null,2),contentType:'application/json'});
});

test('double spread keeps the physical turn face and source continuity with cards on either leaf', async ({ page, request }, info) => {
  test.setTimeout(60000);
  const theology = Array.from({length: 72}, (_, index) =>
    `SOURCE SECTION ${String(index).padStart(2, '0')}. The small research team prepared a plan for the harbor, ` +
    'although each member proposed a different way to arrange the tables and check the lamps before sunset, ' +
    'using unaided observation, calm discussion, and careful notes. Each person checked the final diagram.').join('\n\n');
  await preparedPresentation(page, request, {desktop: true, text: theology,
    retainedWord: 'unaided', retainedSide: 'right'});
  const retainedRecord = await page.evaluate(() => {
    const item = document.querySelector('.reader').__curlRendererTest.pages.r.annotations
      .find(annotation => annotation.target === 'unaided');
    return item && {blockId: item.block.id, start: item.start, end: item.end,
      note: item.note, target: item.target};
  });
  expect(retainedRecord).toBeTruthy();
  await page.evaluate(() => {
    const renderer = document.querySelector('.reader').__curlRendererTest;
    const prepare = renderer.prepare.bind(renderer);
    renderer.prepare = async (index, source = renderer.pages, guard = null) => {
      const texture = await prepare(index, source, guard);
      if (texture) texture.__sourcePlan = {
        localIndex: index,
        sourceIndex: source.index,
        canonicalIndex: source.view?.canonicalIndex ?? index,
        historyIndex: source.intent?.historyIndex ?? null,
        direction: source.intent?.direction ?? null,
        presentation: Boolean(source.view),
        textureGeneration: source.view?.textureGeneration ?? source.generation,
      };
      return texture;
    };
    const reader = renderer.pages.r, closePop = reader.closePop.bind(reader), attach = renderer.attach.bind(renderer),
      reflow = renderer.pages.wordReflow, flush = reflow.flush.bind(reflow);
    window.__faceRepro = {closes: [], attaches: [], flushes: 0};
    reflow.flush = (...args) => {
      window.__faceRepro.flushes++;
      return flush(...args);
    };
    reader.closePop = () => {
      const before = {at: performance.now(), connected: Boolean(reader.popElement?.isConnected),
        anchor: reader.popAnchor ? {...reader.popAnchor} : null};
      closePop();
      window.__faceRepro.closes.push({...before, afterConnected: Boolean(reader.popElement?.isConnected)});
    };
    renderer.attach = (...args) => {
      window.__faceRepro.attaches.push({at: performance.now(), cardConnected: Boolean(reader.popElement?.isConnected),
        reflowPhase: document.querySelector('#article').dataset.reflowPhase || null});
      return attach(...args);
    };
  });

  const sourcePosition = async () => JSON.parse(
    await page.locator('.reader').getAttribute('data-source-position'));
  const leafContent = () => page.locator('.page-leaf').evaluateAll(leaves => leaves.map(leaf => ({
    text: (leaf.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    blocks: [...leaf.querySelectorAll('[data-block-id]')].slice(0, 4).map(node => ({
      blockId: node.dataset.blockId,
      start: node.dataset.start || null,
      end: node.dataset.end || null,
    })),
  })));
  const moveToEdge = async direction => {
    const point = await page.locator('#article').evaluate((article, direction) => {
      const box = article.getBoundingClientRect();
      return {clientX: direction > 0 ? box.right - 12 : box.left + 12,
        clientY: box.top + box.height * .55};
    }, direction);
    await page.mouse.move(point.clientX, point.clientY);
    return point;
  };
  const anchorLocation = anchor => anchor && page.evaluate(anchor => {
    const article = document.querySelector('#article').getBoundingClientRect();
    const node = [...document.querySelectorAll('#article [data-word]')].find(candidate =>
      candidate.dataset.sourceBlock === anchor.blockId &&
      Number(candidate.dataset.sourceStart) === anchor.start && Number(candidate.dataset.sourceEnd) === anchor.end);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return {side: box.left + box.width / 2 < article.left + article.width / 2 ? 'left' : 'right',
      rect: {left: box.left, top: box.top, width: box.width, height: box.height}};
  }, anchor);
  const retainedPresent = () => page.evaluate(record => {
    const annotations = document.querySelector('.reader').__curlRendererTest.pages.r.annotations;
    return annotations.filter(item => item.block.id === record.blockId && item.start === record.start &&
      item.end === record.end && item.note === record.note && item.target === record.target).length;
  }, retainedRecord);
  const openCard = async side => {
    if (!side) return null;
    const leafIndex = side === 'left' ? 0 : 1;
    const leaf = page.locator('.page-leaf').nth(leafIndex), unaided = leaf.locator('[data-word="unaided"]');
    const word = await unaided.count() ? unaided.first() : leaf.locator('[data-word]').first();
    await word.click();
    await expect(page.locator('.annotation-pop')).toBeVisible();
    return word.evaluate((node, side) => {
      const box = node.getBoundingClientRect(), article = document.querySelector('#article').getBoundingClientRect();
      return {requestedSide: side, actualSide: box.left + box.width / 2 < article.left + article.width / 2 ? 'left' : 'right',
        word: node.dataset.word, blockId: node.dataset.sourceBlock, start: Number(node.dataset.sourceStart),
        end: Number(node.dataset.sourceEnd), rect: {left: box.left, top: box.top, width: box.width, height: box.height}};
    }, side);
  };
  const heldScene = () => page.evaluate(() => {
    const root = document.querySelector('.reader'), renderer = root.__curlRendererTest,
      scene = renderer.scene, article = document.querySelector('#article').getBoundingClientRect(),
      leaves = [...document.querySelectorAll('.page-leaf')].map(leaf => {
        const box = leaf.getBoundingClientRect();
        return {left: box.left - article.left, width: box.width};
      }), plan = texture => texture?.__sourcePlan || {key: texture?.key || null};
    const activeFace = scene.leaf.x + scene.leaf.width / 2 < article.width / 2 ? 'left' : 'right';
    const view = renderer.pages.viewTrail?.[renderer.pages.viewTrailIndex] || renderer.pages.presentedView || null;
    return {
      direction: scene.direction,
      activeFace,
      activeLeaf: {x: scene.leaf.x, width: scene.leaf.width},
      leaves,
      article: {left: article.left, right: article.right, width: article.width},
      front: plan(scene.front),
      back: plan(scene.back),
      stationary: scene.stationary.map(item => ({x: item.x, source: plan(item.texture)})),
      pointerStart: window.__e2eNativePointer,
      progress: Number(root.dataset.trackpadProgress),
      binding: JSON.parse(document.querySelector('#page-curl-layer').dataset.binding || 'null'),
      pin: JSON.parse(document.querySelector('#page-curl-layer').dataset.pin || 'null'),
      pageIndex: Number(root.dataset.pageIndex),
      sourcePosition: JSON.parse(root.dataset.sourcePosition),
      warmPlan: JSON.parse(root.dataset.curlWarmPlan || 'null'),
      cardConnected: Boolean(renderer.pages.r.popElement?.isConnected),
      popAnchor: renderer.pages.r.popAnchor ? {...renderer.pages.r.popAnchor} : null,
      reflowPhase: document.querySelector('#article').dataset.reflowPhase || null,
      lifecycle: structuredClone(window.__faceRepro),
      presentation: {
        annotationLayout: Boolean(renderer.pages.annotationLayout),
        presentedView: Boolean(renderer.pages.presentedView),
        windowCanonicalIndex: view?.canonicalIndex ?? null,
        historyIndex: renderer.pages.viewTrailIndex ?? null,
      },
    };
  });

  const cases = [
    {name: 'no-card-next', card: null, direction: 1, face: 'right'},
    {name: 'no-card-previous', card: null, direction: -1, face: 'left'},
    {name: 'right-card-next', card: 'right', direction: 1, face: 'right', pendingReflow: true},
    {name: 'right-card-previous', card: 'right', direction: -1, face: 'left'},
    {name: 'left-card-next', card: 'left', direction: 1, face: 'right'},
    {name: 'left-card-previous', card: 'left', direction: -1, face: 'left', pendingReflow: true},
  ], evidence = [], baseIndex = Number(await page.locator('.reader').getAttribute('data-page-index')),
    basePosition = await sourcePosition();
  for (const item of cases) {
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String(baseIndex));
    await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
    const before = {index: baseIndex, sourcePosition: await sourcePosition(), leaves: await leafContent(),
      warmPlan: JSON.parse(await page.locator('.reader').getAttribute('data-curl-warm-plan'))};
    const cardTarget = await openCard(item.card);
    if (item.pendingReflow) await page.evaluate(() => {
      document.querySelector('.reader').__curlRendererTest.pages.wordReflow.pendingLayout ||= {reconcile: true};
    });
    let pointerStart;
    if (cardTarget) {
      await overCardBody(page, page.locator('.annotation-pop'));
      pointerStart = await page.evaluate(() => window.__e2eNativePointer);
    } else pointerStart = await moveToEdge(item.direction);
    await page.evaluate(() => { window.__faceRepro.closes = []; window.__faceRepro.attaches = []; });
    await phase(page, 1, item.direction * 13);
    await expect(page.locator('#page-curl-layer')).toBeVisible();
    await expect.poll(async () => page.evaluate(() => Boolean(
      document.querySelector('.reader').__curlRendererTest.scene))).toBe(true);
    await expect.poll(async () => page.locator('#page-curl-layer').getAttribute('data-pin')).not.toBeNull();
    await expect(page.locator('.annotation-pop')).toBeHidden();
    const initial = await heldScene(), initialTarget = await anchorLocation(cardTarget);
    await info.attach(`${item.name}-initial.png`, {body: await page.screenshot(), contentType: 'image/png'});
    expect(initial.cardConnected).toBe(false);
    expect(initial.lifecycle.attaches.at(-1)?.cardConnected).toBe(false);
    const outerEdge = item.direction > 0 ? initial.article.right : initial.article.left;
    expect(Math.abs(initial.pin.x - outerEdge)).toBeLessThan(30);
    await phase(page, 4, item.direction * 520);
    const held = await heldScene();
    const heldTarget = await anchorLocation(cardTarget);
    await info.attach(`${item.name}-held.png`, {body: await page.screenshot(), contentType: 'image/png'});
    expect(held.direction).toBe(item.direction);
    expect(held.activeFace).toBe(item.face);
    expect(held.pointerStart).toEqual(pointerStart);
    expect(held.front.presentation).toBe(true);
    expect(held.back.presentation).toBe(true);
    expect(held.front.localIndex).toBe(item.direction > 0 ? 1 : 0);
    expect(held.back.localIndex).toBe(item.direction > 0 ? 0 : 1);
    expect(held.front.canonicalIndex).toBe(baseIndex);
    expect(item.direction > 0
      ? held.back.canonicalIndex > baseIndex
      : held.back.canonicalIndex < baseIndex).toBe(true);
    if (cardTarget) expect(cardTarget.actualSide).toBe(item.card);
    await phase(page, 8);
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
    const landedIndex = Number(await page.locator('.reader').getAttribute('data-page-index'));
    expect(item.direction > 0 ? landedIndex > baseIndex : landedIndex < baseIndex).toBe(true);
    const after = {index: landedIndex, sourcePosition: await sourcePosition(), leaves: await leafContent()};
    expect(item.direction > 0
      ? after.sourcePosition.ratio > before.sourcePosition.ratio
      : after.sourcePosition.ratio < before.sourcePosition.ratio).toBe(true);
    await moveToEdge(-item.direction);
    await phase(page, 1, -item.direction * 700);
    await phase(page, 8);
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String(baseIndex));
    await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
    const returned = await sourcePosition();
    expect(returned.block_id).toBe(basePosition.block_id);
    expect(returned.start).toBe(basePosition.start);
    await expect.poll(retainedPresent).toBe(1);
    await expect.poll(() => page.evaluate(() => {
      const pages = document.querySelector('.reader').__curlRendererTest.pages;
      return {pending: Boolean(pages.wordReflow.pendingLayout), flushing: Boolean(pages.wordReflow.flushing)};
    })).toEqual({pending: false, flushing: false});
    evidence.push({...item, cardTarget, pointerStart, initial, initialTarget, held, heldTarget,
      before, after, returned});
  }
  // A short gesture exercises the other half of the ownership contract:
  // cancellation must hand the frozen presentation back to canonical reflow.
  const cancelTarget = await openCard('right'), cancelFlushes = await page.evaluate(() => {
    const before = window.__faceRepro.flushes;
    document.querySelector('.reader').__curlRendererTest.pages.wordReflow.pendingLayout ||= {reconcile: true};
    return before;
  });
  await overCardBody(page, page.locator('.annotation-pop'));
  await phase(page, 1, 13);
  await expect.poll(async () => page.evaluate(() => Boolean(
    document.querySelector('.reader').__curlRendererTest.scene))).toBe(true);
  await phase(page, 8);
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String(baseIndex));
  await expect.poll(() => page.evaluate(() => {
    const pages = document.querySelector('.reader').__curlRendererTest.pages;
    return {animating: pages.animating, pending: Boolean(pages.wordReflow.pendingLayout),
      flushing: Boolean(pages.wordReflow.flushing), flushes: window.__faceRepro.flushes};
  })).toEqual({animating: false, pending: false, flushing: false, flushes: cancelFlushes + 1});
  const cancelled = await sourcePosition();
  expect(cancelled.block_id).toBe(basePosition.block_id);
  expect(cancelled.start).toBe(basePosition.start);
  evidence.push({name: 'right-card-next-cancel', cardTarget: cancelTarget, sourcePosition: cancelled});

  // A failed adjacent presentation also returns ownership to canonical reflow,
  // once, without committing a page or losing the retained annotation.
  const errorTarget = await openCard('right'), errorFlushes = await page.evaluate(() => {
    const pages = document.querySelector('.reader').__curlRendererTest.pages;
    window.__faceRepro.preparePresentation = pages.preparePresentation;
    pages.preparePresentation = async () => { throw new Error('fixture presentation failure'); };
    pages.wordReflow.pendingLayout ||= {reconcile: true};
    return window.__faceRepro.flushes;
  });
  await overCardBody(page, page.locator('.annotation-pop'));
  await phase(page, 1, 13);
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  await expect.poll(() => page.evaluate(() => {
    const pages = document.querySelector('.reader').__curlRendererTest.pages;
    return {index: pages.index, pending: Boolean(pages.wordReflow.pendingLayout),
      flushing: Boolean(pages.wordReflow.flushing), flushes: window.__faceRepro.flushes};
  })).toEqual({index: baseIndex, pending: false, flushing: false, flushes: errorFlushes + 1});
  await page.evaluate(() => {
    const pages = document.querySelector('.reader').__curlRendererTest.pages;
    pages.preparePresentation = window.__faceRepro.preparePresentation;
  });
  await expect.poll(retainedPresent).toBe(1);
  evidence.push({name: 'right-card-next-error', cardTarget: errorTarget,
    sourcePosition: await sourcePosition()});

  // Hold the exact card-dismissal frame, abort the reader, then deliver it
  // late. No retired turn may attach a canvas after its run/scope changed.
  const abortTarget = await openCard('right');
  await overCardBody(page, page.locator('.annotation-pop'));
  const abortBefore = await page.evaluate(() => {
    const renderer = document.querySelector('.reader').__curlRendererTest,
      nativeFrame = window.requestAnimationFrame.bind(window);
    renderer.pages.wordReflow.pendingLayout ||= {reconcile: true};
    window.__staleCardFrame = {renderer, nativeFrame, callback: null,
      attaches: window.__faceRepro.attaches.length};
    window.requestAnimationFrame = callback => {
      if (!window.__staleCardFrame.callback) {
        window.__staleCardFrame.callback = callback;
        return 2147480000;
      }
      return nativeFrame(callback);
    };
    return {attaches: window.__staleCardFrame.attaches};
  });
  await phase(page, 1, 13);
  await expect.poll(() => page.evaluate(() => Boolean(window.__staleCardFrame.callback))).toBe(true);
  const aborted = await page.evaluate(async () => {
    const state = window.__staleCardFrame, pages = state.renderer.pages;
    pages.r.scope.dispose();
    window.requestAnimationFrame = state.nativeFrame;
    state.callback(performance.now());
    await new Promise(resolve => state.nativeFrame(() => state.nativeFrame(resolve)));
    return {aborted: pages.r.scope.signal.aborted, scene: Boolean(state.renderer.scene),
      attaches: window.__faceRepro.attaches.length,
      pending: Boolean(pages.wordReflow.pendingLayout), flushing: Boolean(pages.wordReflow.flushing)};
  });
  expect(aborted).toEqual({aborted: true, scene: false, attaches: abortBefore.attaches,
    pending: false, flushing: false});
  evidence.push({name: 'right-card-next-abort', cardTarget: abortTarget, ...aborted});
  await info.attach('double-spread-face-source-continuity.json', {
    body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
  });
});
test('a queued native gesture waits less than 50ms for the preceding page to land', async ({ page, request }, info) => {
  await page.addInitScript(() => {
    const limit = 2048, records = [], installed = [];
    const contexts = new WeakMap(), states = [];
    let counts = {}, dropped = 0, resetAt = performance.now(), probeErrors = 0;
    let serial = 0, liveBytes = 0, liveCount = 0, allocatedCount = 0;
    let peakBytes = 0, peakCount = 0, lifetimePeakBytes = 0, lifetimePeakCount = 0;
    let unsupportedUploads = 0, unknownBindings = 0, glErrors = 0, resetAllocation;
    const rafLimit = 2048, longTaskLimit = 256, rafRecords = [], longTaskRecords = [];
    let rafRequests = 0, rafCallbacks = 0, rafDropped = 0, longTaskCount = 0, longTaskDropped = 0;
    let schedulerErrors = 0, rafInstalled = false, longTaskStatus = 'unsupported', longTaskObserver;
    const collectLongTasks = entries => {
      try {
        const observedAt = performance.now();
        for (const entry of entries) {
          if (entry.startTime + entry.duration < resetAt) continue;
          longTaskCount++;
          if (longTaskRecords.length >= longTaskLimit) longTaskDropped++;
          else longTaskRecords.push({ startTime: entry.startTime, duration: entry.duration,
            name: entry.name, observedAt, startedBeforeReset: entry.startTime < resetAt });
        }
      } catch { schedulerErrors++; }
    };
    try {
      let owner = window, descriptor;
      while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, 'requestAnimationFrame')))
        owner = Object.getPrototypeOf(owner);
      if (typeof descriptor?.value === 'function') {
        const original = descriptor.value;
        Object.defineProperty(owner, 'requestAnimationFrame', { ...descriptor, value: function (...args) {
          const callback = args[0];
          if (typeof callback !== 'function') return Reflect.apply(original, this, args);
          const callRequestedAt = performance.now();
          let requestId;
          const wrapped = function (...callbackArgs) {
            const entryPerformanceNow = performance.now();
            let threw = false;
            try { return Reflect.apply(callback, this, callbackArgs); }
            catch (error) { threw = true; throw error; }
            finally {
              const exitPerformanceNow = performance.now();
              try {
                rafCallbacks++;
                if (rafRecords.length >= rafLimit) rafDropped++;
                else rafRecords.push({ requestId, callRequestedAt, rafTimestamp: callbackArgs[0],
                  entryPerformanceNow, exitPerformanceNow, requestedBeforeReset: callRequestedAt < resetAt, threw });
              } catch { schedulerErrors++; }
            }
          };
          requestId = Reflect.apply(original, this, [wrapped, ...args.slice(1)]);
          rafRequests++;
          return requestId; // Native IDs remain valid for the untouched cancelAnimationFrame.
        } });
        rafInstalled = true;
      }
    } catch { schedulerErrors++; }
    if (window.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
      try {
        longTaskObserver = new PerformanceObserver(list => collectLongTasks(list.getEntries()));
        longTaskObserver.observe({ type: 'longtask', buffered: true });
        longTaskStatus = 'observing';
      } catch { longTaskStatus = 'unavailable'; schedulerErrors++; }
    }
    const schedulerSnapshot = () => {
      if (longTaskObserver) collectLongTasks(longTaskObserver.takeRecords());
      return {
        scope: 'all observed post-reset JS rAF callbacks and browser long tasks; excludes physical input and GPU presentation',
        rafInstalled, rafLimit, rafRequests, rafCallbacks, rafDropped, rafRecords,
        longTaskStatus, longTaskLimit, longTaskCount, longTaskDropped, longTaskRecords, schedulerErrors,
      };
    };
    const allocation = () => ({ liveBytes, liveTextureCount: liveCount, allocatedTextureCount: allocatedCount });
    const stateFor = gl => {
      let state = contexts.get(gl);
      if (!state) {
        state = { id: states.length + 1, unit: 33984, bindings: new Map(), textures: new WeakMap(), live: new Map() };
        contexts.set(gl, state); states.push(state);
      }
      return state;
    };
    const notePeak = () => {
      peakBytes = Math.max(peakBytes, liveBytes); peakCount = Math.max(peakCount, liveCount);
      lifetimePeakBytes = Math.max(lifetimePeakBytes, liveBytes);
      lifetimePeakCount = Math.max(lifetimePeakCount, liveCount);
    };
    const uploadInfo = (stage, args) => {
      const image = stage === 'texImage2D', sourceOverload = args.length === (image ? 6 : 7);
      const source = sourceOverload ? args.at(-1) : args[8];
      // Intrinsic source dimensions only; no document queries or layout reads.
      return {
        target: args[0], level: args[1],
        sourceType: source?.constructor?.name || (source === null ? 'null' : typeof source),
        width: sourceOverload ? (source?.naturalWidth ?? source?.videoWidth ?? source?.width ?? null) : args[image ? 3 : 4],
        height: sourceOverload ? (source?.naturalHeight ?? source?.videoHeight ?? source?.height ?? null) : args[image ? 4 : 5],
        format: args[sourceOverload ? (image ? 3 : 4) : 6],
        type: args[sourceOverload ? (image ? 4 : 5) : 7],
        ...(image ? { internalFormat: args[2] } : { xoffset: args[2], yoffset: args[3] }),
      };
    };
    window.__wrQueuedGLWitness = {
      reset() {
        records.length = 0; counts = {}; dropped = 0; resetAt = performance.now();
        rafRecords.length = 0; longTaskRecords.length = 0;
        rafRequests = rafCallbacks = rafDropped = longTaskCount = longTaskDropped = 0;
        // Warm-up textures and binding identities remain live across this reset.
        resetAllocation = allocation(); peakBytes = liveBytes; peakCount = liveCount;
      },
      snapshot() { return {
        limit, installed, resetAt, timeOrigin: performance.timeOrigin, counts, dropped, probeErrors, records,
        scheduler: schedulerSnapshot(),
        textureLifetime: {
          scope: 'API-accounted uncompressed RGBA/UNSIGNED_BYTE 2D texture storage; excludes drawing buffers, decoded images, driver copies and deferred GPU deletion',
          referenceBudgetBytes: 96_000_000, referenceLeafLimit: 6,
          atReset: resetAllocation, current: allocation(), peakBytes, peakTextureCount: peakCount,
          lifetimePeakBytes, lifetimePeakTextureCount: lifetimePeakCount,
          unsupportedUploads, unknownBindings, glErrors,
          textures: states.flatMap(state => [...state.live.values()].map(texture => ({
            id: texture.id, contextId: state.id, bytes: texture.bytes, levels: [...texture.levels.values()],
          }))),
        },
      }; },
    };
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const prototype = window[name]?.prototype;
      for (const stage of ['createTexture', 'deleteTexture', 'bindTexture', 'activeTexture',
        'texImage2D', 'texSubImage2D', 'getError', 'getParameter']) {
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, stage);
        if (typeof descriptor?.value !== 'function') continue;
        const original = descriptor.value;
        installed.push(`${name}.${stage}`);
        Object.defineProperty(prototype, stage, { ...descriptor, value: function (...args) {
          const startedAt = performance.now();
          let threw = false, result;
          try { result = Reflect.apply(original, this, args); return result; }
          catch (error) { threw = true; throw error; }
          finally {
            const finishedAt = performance.now();
            try {
              counts[stage] = (counts[stage] || 0) + 1;
              const state = stateFor(this);
              const entry = { stage, context: name, startedAt, finishedAt,
                contextId: state.id, durationMs: finishedAt - startedAt, threw };
              if (stage === 'getParameter') entry.parameter = args[0];
              if (stage === 'getError') {
                entry.result = typeof result === 'number' ? result : null;
                if (!threw && result !== 0) glErrors++;
              }
              if (!threw && stage === 'createTexture' && result) {
                const texture = { id: ++serial, bytes: 0, levels: new Map() };
                state.textures.set(result, texture); state.live.set(texture.id, texture);
                liveCount++; entry.textureId = texture.id;
              }
              if (!threw && stage === 'activeTexture') state.unit = args[0];
              if (!threw && stage === 'bindTexture') {
                state.bindings.set(`${state.unit}:${args[0]}`, args[1]);
                entry.textureId = state.textures.get(args[1])?.id ?? null;
                entry.unit = state.unit; entry.target = args[0];
                if (args[1] && !state.textures.has(args[1])) unknownBindings++;
              }
              if (stage === 'deleteTexture') {
                const texture = state.textures.get(args[0]);
                entry.textureId = texture?.id ?? null; entry.allocationBefore = allocation();
                entry.deletedBytes = texture?.bytes ?? 0;
                if (!threw && texture) {
                  liveBytes -= texture.bytes; liveCount--; if (texture.bytes) allocatedCount--;
                  state.textures.delete(args[0]); state.live.delete(texture.id);
                  for (const [binding, value] of state.bindings) if (value === args[0]) state.bindings.set(binding, null);
                }
                entry.allocationAfter = allocation();
              }
              if (stage === 'texImage2D' || stage === 'texSubImage2D') {
                Object.assign(entry, uploadInfo(stage, args));
                const texture = state.textures.get(state.bindings.get(`${state.unit}:${entry.target}`));
                entry.textureId = texture?.id ?? null; entry.unit = state.unit;
                entry.allocationBefore = allocation(); entry.textureBytesBefore = texture?.bytes ?? null;
                const supported = entry.target === 3553 && entry.format === 6408 && entry.type === 5121 &&
                  Number.isInteger(entry.width) && entry.width >= 0 && Number.isInteger(entry.height) && entry.height >= 0;
                if (!threw) {
                  if (!texture) unknownBindings++;
                  if (!supported) unsupportedUploads++;
                  if (texture && supported && stage === 'texImage2D') {
                    const key = `${entry.target}:${entry.level}`, bytes = entry.width * entry.height * 4;
                    const previous = texture.levels.get(key)?.bytes || 0, before = texture.bytes;
                    texture.levels.set(key, { target: entry.target, level: entry.level, width: entry.width,
                      height: entry.height, format: entry.format, type: entry.type, bytes });
                    texture.bytes += bytes - previous; liveBytes += bytes - previous;
                    if (!before && texture.bytes) allocatedCount++;
                    else if (before && !texture.bytes) allocatedCount--;
                  }
                }
                // Sub-image uploads replace pixels inside existing storage; no new allocation.
                entry.textureBytesAfter = texture?.bytes ?? null; entry.allocationAfter = allocation();
              }
              notePeak();
              // Draw-time binding churn updates state but cannot exhaust the evidence ring.
              if (stage !== 'bindTexture' && stage !== 'activeTexture') {
                if (records.length >= limit) dropped++;
                else records.push(entry);
              }
            } catch {
              // Observation must never replace the original GL result or exception.
              probeErrors++;
            }
          }
        } });
      }
    }
  });
  await prepared(page, request);
  await page.evaluate(() => window.__wrQueuedGLWitness.reset());
  const gaps = [], pairs = [];
  let metrics = [], glStages;
  try {
    expect(+(await page.locator('.reader').getAttribute('data-page-count'))).toBeGreaterThan(24);
    for (let pair = 0; pair < 12; pair++) {
      const baseline = await page.evaluate(() => ({
        gestureId: Math.max(0, ...JSON.parse(document.querySelector('.reader').dataset.nativeGestures).map(record => record.id || 0)),
        metricSequence: JSON.parse(document.querySelector('.reader').dataset.curlMetrics || '[]').at(-1)?.sequence || 0,
      }));
      await phase(page, 1, 700);
      page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase: 8, dx: 0, dy: 0, momentum: 0 }));
      page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase: 1, dx: 700, dy: 0, momentum: 0 }));
      page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase: 8, dx: 0, dy: 0, momentum: 0 }));
      await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String((pair + 1) * 2));
      await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
      const sample = await page.evaluate(() => ({
        records: JSON.parse(document.querySelector('.reader').dataset.nativeGestures),
        metrics: JSON.parse(document.querySelector('.reader').dataset.curlMetrics),
        pageIndex: +document.querySelector('.reader').dataset.pageIndex,
        visibility: document.visibilityState, focused: document.hasFocus(),
      }));
      const recent = sample.records.filter(record => record.id > baseline.gestureId);
      const queuedBegins = recent.filter(record => record.kind === 'began' && record.waiting);
      const queued = queuedBegins[0];
      const precedingLandings = recent.filter(record => record.kind === 'landed' && record.id === queued?.id - 1);
      const queuedLandings = recent.filter(record => record.kind === 'landed' && record.id === queued?.id);
      const pairMetrics = sample.metrics.filter(metric => metric.sequence > baseline.metricSequence);
      const gap = precedingLandings[0]?.at - queued?.at;
      pairs.push({ pair, baseline, queuedId: queued?.id, precedingId: queued?.id - 1,
        gapMs: gap, pageIndex: sample.pageIndex, visibility: sample.visibility, focused: sample.focused,
        records: recent, metrics: pairMetrics });
      expect(queuedBegins, `pair ${pair}: exactly one queued begin`).toHaveLength(1);
      expect(queued.id).toBe(baseline.gestureId + 2);
      expect(precedingLandings, `pair ${pair}: exact predecessor landing`).toHaveLength(1);
      expect(queuedLandings, `pair ${pair}: exact queued landing`).toHaveLength(1);
      expect(Number.isFinite(gap)).toBe(true);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(queuedLandings[0].at).toBeGreaterThanOrEqual(precedingLandings[0].at);
      expect(pairMetrics).toHaveLength(2);
      expect(pairMetrics.map(metric => metric.reason)).toEqual(['native-ended', 'native-queued-ended']);
      expect(pairMetrics.every(metric => metric.completed)).toBe(true);
      for (const metric of pairMetrics) if (metric.lastInputPose) {
        const progress = metric.lastInputPose.progress;
        expect(Number.isFinite(progress), `pair ${pair}: finite input pose progress`).toBe(true);
        expect(progress, `pair ${pair}: input pose stays above zero`).toBeGreaterThanOrEqual(0);
        expect(progress, `pair ${pair}: input pose stays below one`).toBeLessThanOrEqual(1);
      }
      gaps.push(gap);
    }
  } finally {
    const evidence = await page.evaluate(() => ({
      metrics: JSON.parse(document.querySelector('.reader').dataset.curlMetrics || '[]'),
      records: JSON.parse(document.querySelector('.reader').dataset.nativeGestures || '[]'),
      glStages: window.__wrQueuedGLWitness.snapshot(),
    }));
    metrics = evidence.metrics; glStages = evidence.glStages;
    await info.attach('queued-native-turn-gap.json', {
      body: JSON.stringify({ scope: 'queued begin to predecessor JS landed event; excludes subsequent DOM commit and GPU presentation',
        gaps, pairs, metrics, records: evidence.records }, null, 2), contentType: 'application/json'
    });
    await info.attach('queued-native-gl-stages.json', {
      body: JSON.stringify(glStages, null, 2), contentType: 'application/json'
    });
  }
  expect(gaps).toHaveLength(12);
  expect(metrics).toHaveLength(24);
  expect(glStages.dropped).toBe(0);
  expect(glStages.probeErrors).toBe(0);
  expect(glStages.scheduler.rafInstalled).toBe(true);
  expect(glStages.scheduler.schedulerErrors).toBe(0);
  expect(glStages.scheduler.rafDropped).toBe(0);
  expect(glStages.scheduler.longTaskDropped).toBe(0);
  expect(glStages.records.some(record => ['texImage2D', 'texSubImage2D'].includes(record.stage))).toBe(true);
  expect(glStages.textureLifetime.glErrors).toBe(0);
  expect(glStages.textureLifetime.unsupportedUploads).toBe(0);
  expect(glStages.textureLifetime.unknownBindings).toBe(0);
  expect(glStages.textureLifetime.lifetimePeakBytes).toBeLessThanOrEqual(96e6);
  expect(glStages.textureLifetime.lifetimePeakTextureCount).toBeLessThanOrEqual(6);
  expect(Math.max(...metrics.map(metric => metric.release.textureWaitMs))).toBeLessThan(35);
  expect(Math.max(...gaps)).toBeLessThan(50);
});
test('Retina 120Hz phase-fixture turns retain bounded rendering latency and GPU cache over repeated reversals', async ({ page, request }, info) => {
  await prepared(page, request);
  for (let i = 0; i < 12; i++) {
    const direction = i % 2 ? -1 : 1;
    // Continuous 120Hz input for frame cadence. Sparse 20ms command delivery
    // skips RAFs by design; inactive input gaps are not GPU frame duration.
    page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase: 1, dx: direction * 40 }));
    for (let n = 0; n < 15; n++) {
      await page.waitForTimeout(8);
      page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase: 4, dx: direction * 40 }));
    }
    await phase(page, 8);
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String(i % 2 ? 0 : 1));
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  }
  const metrics = await page.evaluate(() => JSON.parse(document.querySelector('.reader').dataset.curlMetrics));
  await info.attach('retina-frame-metrics.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  expect(metrics).toHaveLength(12);
  const percentile = values => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)];
  const frames = metrics.flatMap(metric => metric.raw.frameIntervalsMs);
  const inputs = metrics.flatMap(metric => metric.raw.inputToDrawMs);
  expect(frames.length).toBeGreaterThan(100);
  expect(inputs.length).toBeGreaterThan(100);
  expect(percentile(frames)).toBeLessThan(34);
  expect(percentile(inputs)).toBeLessThan(34);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-pixels'))).toBeLessThanOrEqual(24e6);
});
for (const dpr of [1, 2, 3]) test(`DPR ${dpr}: canvas and page textures retain native resolution with bounded cache`, async ({ browser, request }, info) => {
  const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  await prepared(page, request);
  await phase(page, 1, 220, 20);
  await expect(page.locator('#page-curl-layer')).toBeVisible();
  const value = await snap(page);
  expect(value.resolution.software).toBe(false);
  expect(value.resolution.canvas.ratio).toBeCloseTo(dpr, 3);
  expect(value.resolution.front.ratio).toBeCloseTo(dpr, 3);
  expect(value.resolution.back.ratio).toBeCloseTo(dpr, 3);
  await info.attach(`retina-${dpr}-held.png`, { body: await page.screenshot(), contentType: 'image/png' });
  await info.attach('resolution.json', { body: JSON.stringify(value), contentType: 'application/json' });
  await phase(page, 4, 700);
  await phase(page, 8);
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '1');
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-leaves'))).toBeLessThanOrEqual(6);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-pixels'))).toBeLessThanOrEqual(24e6);
  // Idle lookahead must keep the current leaf resident at high DPR. A cache
  // budget can remain bounded while evicting the page the next turn needs.
  await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
  await phase(page, 1, 700, 20);
  await expect(page.locator('#page-curl-layer')).toBeVisible();
  await phase(page, 8);
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '2');
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  const metrics = await page.evaluate(() => JSON.parse(document.querySelector('.reader').dataset.curlMetrics));
  const last = metrics.at(-1);
  await info.attach('second-turn-cache.json', { body: JSON.stringify(last), contentType: 'application/json' });
  expect(last.raw.captureTrace.filter(capture => capture.index === 1)).toEqual([]);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-bytes'))).toBeLessThanOrEqual(96e6);
  await context.close();
});
test('wide DPR 3 double spread keeps all required faces at native resolution', async ({ browser, request }, info) => {
  const context = await browser.newContext({ deviceScaleFactor: 3, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  try {
    await prepared(page, request, 'double');
    await phase(page, 1, 700);
    await expect(page.locator('#page-curl-layer')).toBeVisible();
    await expect.poll(async () => (await snap(page)).resolution).not.toBeNull();
    const held = await snap(page);
    await info.attach('wide-double-retina.json', { body: JSON.stringify(held), contentType: 'application/json' });
    await info.attach('wide-double-held.png', { body: await page.screenshot(), contentType: 'image/png' });
    expect(held.resolution.front.ratio).toBeCloseTo(3, 3);
    expect(held.resolution.back.ratio).toBeCloseTo(3, 3);
    await phase(page, 8);
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '2');
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
    await phase(page, 1, -700);
    await expect(page.locator('#page-curl-layer')).toBeVisible();
    await phase(page, 8);
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '0');
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
    await expect(page.locator('.reader')).not.toHaveAttribute('data-curl-fallback', /.+/);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('wide-double-state.json', { body: JSON.stringify({ errors,
      data: await page.evaluate(() => ({ ...document.querySelector('.reader')?.dataset })) }), contentType: 'application/json' });
    await context.close();
  }
});

test('double-spread source resume keeps both adjacent presentation windows warm', async ({ page, request }, info) => {
  await preparedPresentation(page, request);
  const before = await page.evaluate(() =>
    JSON.parse(document.querySelector('.reader').dataset.curlMetrics || '[]').length);
  const plans = [];
  for (const direction of [1, -1, -1, 1]) {
    await phase(page, 1, direction * 700);
    await phase(page, 8);
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
    await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
    plans.push(await page.evaluate(() => ({
      index: +document.querySelector('.reader').dataset.pageIndex,
      plan: JSON.parse(document.querySelector('.reader').dataset.curlWarmPlan),
    })));
  }
  const metrics = await page.evaluate(() =>
    JSON.parse(document.querySelector('.reader').dataset.curlMetrics || '[]'));
  const turns = metrics.slice(before);
  await info.attach('presentation-cache-turns.json', {
    body: JSON.stringify(turns, null, 2), contentType: 'application/json',
  });
  expect(turns).toHaveLength(4);
  expect(plans.every(({plan}) => plan.presentation && plan.keys.length === 6)).toBe(true);
  expect(turns.every(metric => metric.warm)).toBe(true);
  expect(turns.flatMap(metric => metric.raw.captureTrace)).toEqual([]);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-leaves'))).toBeLessThanOrEqual(6);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-bytes'))).toBeLessThanOrEqual(128e6);

  const rewarmed = page.evaluate(() => new Promise(resolve => {
    const root = document.querySelector('.reader');
    let cleared = root.dataset.curlWarm !== 'true';
    const observer = new MutationObserver(() => {
      if (root.dataset.curlWarm !== 'true') cleared = true;
      else if (cleared) { observer.disconnect(); resolve(); }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-curl-warm'] });
  }));
  await page.setViewportSize({ width: 1320, height: 900 });
  await rewarmed;
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
  await over(page);
  const afterReflow = await page.evaluate(() =>
    JSON.parse(document.querySelector('.reader').dataset.curlMetrics || '[]').length);
  await phase(page, 1, 700);
  await phase(page, 8);
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  const reflowMetric = await page.evaluate(() =>
    JSON.parse(document.querySelector('.reader').dataset.curlMetrics || '[]').at(-1));
  expect(reflowMetric.sequence).toBeGreaterThan(afterReflow);
  expect(reflowMetric.warm).toBe(true);
  expect(reflowMetric.raw.captureTrace).toEqual([]);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-leaves'))).toBeLessThanOrEqual(6);
});

test('stale presentation warm cannot write, evict, or mark a newer plan warm', async ({ page, request }, info) => {
  await preparedPresentation(page, request);
  await page.evaluate(() => {
    const renderer = document.querySelector('.reader').__curlRendererTest;
    const original = renderer.prepare.bind(renderer);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.__warmRace = { blocked: false, done: false };
    window.__releaseWarmRace = release;
    renderer.prepare = async function(index, source, guard) {
      if (guard && !window.__warmRace.blocked) {
        const state = window.__warmRace;
        state.blocked = true;
        state.oldKey = this.key(index, source);
        state.oldRun = this.warmPlan?.run;
        await gate;
        state.beforeKeys = [...this.cache.keys()];
        state.beforePlan = JSON.parse(this.root.dataset.curlWarmPlan || 'null');
        state.beforeWarm = this.root.dataset.curlWarm || null;
        const value = await original(index, source, guard);
        state.result = Boolean(value);
        state.afterKeys = [...this.cache.keys()];
        state.afterPlan = JSON.parse(this.root.dataset.curlWarmPlan || 'null');
        state.afterWarm = this.root.dataset.curlWarm || null;
        state.done = true;
        return value;
      }
      return original(index, source, guard);
    };
  });
  await phase(page, 1, 700);
  await phase(page, 8);
  await expect.poll(() => page.evaluate(() => window.__warmRace.blocked)).toBe(true);
  for (let i = 0; i < 4; i++) {
    await phase(page, 1, 700);
    await phase(page, 8);
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
    await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
  }
  const beforeRelease = await page.evaluate(() => ({
    race: { ...window.__warmRace },
    plan: JSON.parse(document.querySelector('.reader').dataset.curlWarmPlan),
  }));
  expect(beforeRelease.plan.presentation).toBe(true);
  expect(beforeRelease.plan.run).toBeGreaterThan(beforeRelease.race.oldRun);
  expect(beforeRelease.plan.keys).not.toContain(beforeRelease.race.oldKey);
  await page.evaluate(() => window.__releaseWarmRace());
  await expect.poll(() => page.evaluate(() => window.__warmRace.done)).toBe(true);
  const race = await page.evaluate(() => window.__warmRace);
  await info.attach('stale-warm-race.json', {
    body: JSON.stringify(race, null, 2), contentType: 'application/json',
  });
  expect(race.result).toBe(false);
  expect(race.afterKeys).toEqual(race.beforeKeys);
  expect(race.afterPlan).toEqual(race.beforePlan);
  expect(race.beforePlan.run).toBeGreaterThan(race.oldRun);
  expect(race.beforeWarm).toBe('true');
  expect(race.afterWarm).toBe('true');
  await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm-status', 'ready');
});

test('presentation warm stays false when its texture budget rejects a required face', async ({ page, request }) => {
  await preparedPresentation(page, request);
  await page.evaluate(() => {
    document.querySelector('.reader').__curlRendererTest.textureBudget = () => 1;
  });
  await phase(page, 1, 700);
  await phase(page, 8);
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm-status', 'failed');
  await expect(page.locator('.reader')).not.toHaveAttribute('data-curl-warm', 'true');
  const plan = JSON.parse(await page.locator('.reader').getAttribute('data-curl-warm-plan'));
  expect(plan.presentation).toBe(true);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-leaves'))).toBeLessThanOrEqual(6);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-bytes'))).toBeLessThanOrEqual(128e6);
});

test('native end crosses a chapter; old momentum and route cleanup never move the new chapter', async ({ page, request }) => {
  await prepared(page, request);
  const imported = await (await request.post('/api/import', { multipart: { file: {
    name: 'Native-chapters.epub', mimeType: 'application/epub+zip', buffer: fs.readFileSync('web/sample.epub') } } })).json();
  await read(page, imported.chapters[0].doc_id);
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  const count = +(await page.locator('.reader').getAttribute('data-page-count'));
  for (let i = 1; i < count; i++) {
    await page.locator('#reading-edge-next').click();
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String(i));
  }
  await over(page); await phase(page, 1, 950); await phase(page, 8);
  await expect(page.locator('.reader')).toHaveAttribute('data-document-id', String(imported.chapters[1].doc_id));
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', 'true');
  await phase(page, 0, 950, 0, 1); await phase(page, 0, 950, 0, 4); await phase(page, 0, 0, 0, 8);
  expect(await pageIndex(page)).toBe(0);
  await over(page); await phase(page, 1, 220);
  await page.goto('/'); await phase(page, 8);
  await expect(page.locator('.reader')).toHaveCount(0);
});

// Stress the local root patch while recording the existing real RAF metrics.
// The fixture supplies native phases; it does not claim physical handfeel.
test("deep diagonal native turns preserve root rendering cadence and release timing", async ({
  page,
  request,
}, info) => {
  await prepared(page, request, "double");
  const leaves = await page
    .locator("#article .page-leaf")
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().toJSON()));
  const width = leaves[0].width,
    height = leaves[0].height,
    gap = leaves[1].left - leaves[0].right;
  await page.mouse.move(
    leaves[1].left + width * 0.7,
    leaves[1].top + height * 0.18,
  );
  for (let i = 0; i < 12; i++) {
    const direction = i % 2 ? -1 : 1;
    const dx = (direction * (2 * width + gap) * 0.97) / 24,
      dy = (-height * 0.34) / 24;
    for (let n = 0; n < 24; n++) {
      page.__native.send(
        JSON.stringify({
          source: "e2e-phase-fixture",
          phase: n === 0 ? 1 : 4,
          dx,
          dy,
        }),
      );
      await page.waitForTimeout(8);
    }
    // Keep input active around a deep diagonal pose, where the root patch runs.
    for (let n = 0; n < 16; n++) {
      page.__native.send(
        JSON.stringify({
          source: "e2e-phase-fixture",
          phase: 4,
          dx: direction * (n % 2 ? -2 : 2),
          dy: 0,
        }),
      );
      await page.waitForTimeout(8);
    }
    await phase(page, 8);
    await expect(page.locator(".reader")).toHaveAttribute(
      "data-page-index",
      String(i % 2 ? 0 : 2),
    );
    await expect(page.locator(".reader")).not.toHaveAttribute(
      "data-page-turning",
      "true",
    );
  }
  const metrics = await page.evaluate(() =>
    JSON.parse(document.querySelector(".reader").dataset.curlMetrics),
  );
  await info.attach("deep-root-frame-metrics.json", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  expect(metrics).toHaveLength(12);
  expect(Math.max(...metrics.map((m) => m.p95FrameMs))).toBeLessThan(34);
  expect(Math.max(...metrics.map((m) => m.p95InputMs))).toBeLessThan(34);
  expect(
    Math.max(...metrics.map((m) => m.release.actualDurationMs)),
  ).toBeLessThan(240);
});
