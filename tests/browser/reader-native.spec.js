import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { enableAll, read, pageIndex, focus, selectParagraph } from './reader-helpers.js';

test.use({ channel: 'chrome', trace: 'off', deviceScaleFactor: 2,
  launchOptions: { args: ['--use-angle=metal', '--enable-gpu'] } });
const body = 'A prominent contribution changes our understanding. The reasoning of these two men did not carry conviction, since knowledge is acquired in relations. '.repeat(8);
async function phase(page, phase, dx = 0, dy = 0, momentum = 0, handled = true) {
  const root = page.locator('.reader'), hasReader = await root.count();
  const before = hasReader
    ? await root.getAttribute('data-native-trackpad')
      .then(value => JSON.parse(value || '{}').events || 0)
    : 0;
  page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase, dx, dy, momentum }));
  const publishes = (phase & (1 | 8 | 16)) || (momentum & 8);
  if (hasReader && handled && publishes) await expect.poll(async () => {
    const value = await page.locator('.reader').getAttribute('data-native-trackpad');
    return JSON.parse(value || '{}').events || 0;
  }).toBeGreaterThan(before);
  else await page.waitForTimeout(40);
}
async function over(page) {
  const box = await page.locator('#article').boundingBox();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .55);
}
async function prepared(page, request, layout = 'single') {
  await page.addInitScript(layout => {
    localStorage.setItem('wr2:page-layout', JSON.stringify(layout));
    localStorage.setItem('wr2:page-motion', JSON.stringify('curl'));
  }, layout);
  await page.route('**/api/reading/native-trackpad', route => route.fulfill({ json: {
    available: true, platform: 'darwin', url: 'ws://127.0.0.1:8769/events?token=fixture' } }));
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:8769\/events/, ws => {
    page.__native = ws;
    ws.send(JSON.stringify({ source: 'bridge-ready', monitorReady: true }));
  });
  const doc = await (await request.post('/api/documents', { data: {
    title: 'Native trackpad production acceptance', text: Array(60).fill(body).join('\n\n') } })).json();
  await page.goto(`/?readingPerf=1#/read/${doc.id}`);
  await expect(page.locator('.reader')).toHaveAttribute('data-document-id', String(doc.id));
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-trackpad-mode', 'native');
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
  await over(page);
  return doc;
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
test('a queued native gesture waits less than 50ms for the preceding page to land', async ({ page, request }, info) => {
  await prepared(page, request);
  const gaps = [];
  for (let pair = 0; pair < 6; pair++) {
    const baseline = await page.evaluate(() => JSON.parse(document.querySelector('.reader').dataset.nativeGestures).length);
    await phase(page, 1, 700);
    page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase: 8, dx: 0, dy: 0, momentum: 0 }));
    page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase: 1, dx: 700, dy: 0, momentum: 0 }));
    page.__native.send(JSON.stringify({ source: 'e2e-phase-fixture', phase: 8, dx: 0, dy: 0, momentum: 0 }));
    await expect(page.locator('.reader')).toHaveAttribute('data-page-index', String((pair + 1) * 2));
    await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
    const records = await page.evaluate(() => JSON.parse(document.querySelector('.reader').dataset.nativeGestures));
    const recent = records.slice(baseline);
    const queued = recent.find(record => record.kind === 'began' && record.waiting);
    const precedingLanding = recent.find(record => record.kind === 'landed' && record.at >= queued.at);
    gaps.push(precedingLanding.at - queued.at);
  }
  const metrics = await page.evaluate(() => JSON.parse(document.querySelector('.reader').dataset.curlMetrics));
  await info.attach('queued-native-turn-gap.json', {
    body: JSON.stringify({ gaps, metrics }, null, 2), contentType: 'application/json'
  });
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
  await phase(page, 8);
  await expect(page.locator('.reader')).not.toHaveAttribute('data-page-turning', 'true');
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-leaves'))).toBeLessThanOrEqual(6);
  expect(+(await page.locator('.reader').getAttribute('data-curl-cached-pixels'))).toBeLessThanOrEqual(24e6);
  await context.close();
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
