import { test, expect } from '@playwright/test';
import { enableAll, read, pageIndex } from './reader-helpers.js';
test.use({ channel: 'chrome', trace: 'off', deviceScaleFactor: 2,
  launchOptions: { args: ['--use-angle=metal', '--enable-gpu'] } });

async function scan(page, png, binding) {
  return page.evaluate(async ({ png, binding }) => {
    // Decode the actual screenshot, not a second copy of the geometry formula.
    const blob = await (await fetch('data:image/png;base64,' + png)).blob();
    const image = await createImageBitmap(blob), ratio = image.width / innerWidth;
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);
    const x0 = binding.x * ratio, top = Math.ceil((binding.top + 8) * ratio), bottom = Math.floor((binding.bottom - 8) * ratio);
    let rows = 0, found = 0, maximumError = 0;
    const dots = [];
    for (let y = top; y <= bottom; y += 4) {
      rows++; const xs = [];
      for (let x = Math.max(0, Math.floor(x0 - 12 * ratio)); x <= Math.min(image.width - 1, Math.ceil(x0 + 12 * ratio)); x++) {
        const p = (y * image.width + x) * 4;
        // Antialiased green over black letters is darker than over white paper.
        // Its chroma still identifies the GPU marker; brightness is not position.
        if (data[p + 1] - data[p] > 50 && data[p + 1] - data[p + 2] > 50) xs.push(x + .5);
      }
      if (xs.length) {
        found++;
        const center = xs.reduce((a, x) => a + x, 0) / xs.length;
        const error = Math.abs(center - x0) / ratio;
        maximumError = Math.max(maximumError, error);
        if (dots.length < 10 || y > bottom - 40) dots.push({ y: y / ratio, x: center / ratio, error });
      }
    }
    image.close();
    return { rows, found, coverage: found / rows, maximumError, dots, binding, ratio };
  }, { png: png.toString('base64'), binding });
}
for (const layout of ['single', 'double'])
  for (const direction of [1, -1])
    for (const corner of ['top', 'bottom'])
      test(`${layout} ${direction > 0 ? 'next' : 'previous'} ${corner}: GPU inner edge remains bound for shallow, middle and deep diagonal folds`, async ({ page, request }, info) => {
        await enableAll(request);
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.setViewportSize({ width: layout === 'double' ? 1440 : 1100, height: 1000 });
        await page.addInitScript(layout => {
          localStorage.setItem('wr2:page-layout', JSON.stringify(layout));
          localStorage.setItem('wr2:page-motion', JSON.stringify('curl'));
        }, layout);
        const doc = await (await request.post('/api/documents', { data: {
          title: 'Bound-book acceptance', text: Array(50).fill('A prominent contribution changes our understanding. The reasoning of these two men did not carry conviction, since knowledge is acquired in relations. '.repeat(6)).join('\n\n') } })).json();
        await page.goto('/?debug-spine=1#/read/' + doc.id);
        await expect(page.locator('.reader')).toHaveAttribute('data-ready', 'true');
        await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
        await expect(page.locator('.reader')).toHaveAttribute('data-curl-warm', 'true');
        const side = direction > 0 ? 'next' : 'prev';
        if (direction < 0) {
          await page.locator('#reading-edge-next').click();
          await expect(page.locator('.reader')).toHaveAttribute('data-page-index', layout === 'double' ? '2' : '1');
        }
        const startIndex = await pageIndex(page);
        const geometry = async () => {
          const edge = await page.locator('#reading-edge-' + side).boundingBox();
          const leaves = await page.locator('#article .page-leaf').evaluateAll(es => es.map(e => e.getBoundingClientRect().toJSON()));
          const leaf = leaves[direction > 0 ? leaves.length - 1 : 0];
          return { x: edge.x + edge.width / 2, y: leaf.y + leaf.height * (corner === 'top' ? .18 : .82),
            width: leaf.width, height: leaf.height,
            gap: leaves.length === 2 ? leaves[1].left - leaves[0].right : 0,
            binding: { x: direction > 0 ? leaf.left : leaf.right, top: leaf.top, bottom: leaf.bottom } };
        };
        const g = await geometry();
        await page.mouse.move(g.x, g.y); await page.mouse.down();
        const observations = [];
        for (const progress of [.35, .65, .85]) {
          await page.mouse.move(g.x - direction * progress * (2 * g.width + g.gap),
            g.y + (corner === 'top' ? 1 : -1) * .34 * g.height, { steps: 12 });
          await expect(page.locator('#page-curl-layer')).toBeVisible();
          await expect.poll(() => page.locator('#page-curl-layer').getAttribute('data-binding')).not.toBeNull();
          const png = await page.screenshot(), pixels = await scan(page, png, g.binding);
          await info.attach(`spine-${progress}.png`, { body: png, contentType: 'image/png' });
          observations.push({ progress, ...pixels });
          await info.attach(`spine-pixels-${progress}.json`, { body: JSON.stringify(pixels, null, 2), contentType: 'application/json' });
          expect(pixels.coverage).toBeGreaterThan(.97);
          expect(pixels.maximumError).toBeLessThanOrEqual(1.5);
          expect(await pageIndex(page)).toBe(startIndex);
        }
        await info.attach('GPU-spine-pixels.json', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
        await page.keyboard.press('Escape'); await page.mouse.up();
        expect(await pageIndex(page)).toBe(startIndex);
        // Repeat the deep fold with diagnostic markings absent for visual review.
        await read(page, doc.id);
        if (direction < 0 && await pageIndex(page) === 0) {
          await page.locator('#reading-edge-next').click();
          await expect(page.locator('.reader')).toHaveAttribute('data-page-index', layout === 'double' ? '2' : '1');
        }
        const clean = await geometry();
        await page.mouse.move(clean.x, clean.y); await page.mouse.down();
        await page.mouse.move(clean.x - direction * .85 * (2 * clean.width + clean.gap),
          clean.y + (corner === 'top' ? 1 : -1) * .34 * clean.height, { steps: 16 });
        await expect(page.locator('#page-curl-layer')).toBeVisible();
        await info.attach('bound-book-clean.png', { body: await page.screenshot(), contentType: 'image/png' });
        await page.keyboard.press('Escape'); await page.mouse.up();
        expect(errors).toEqual([]);
      });
