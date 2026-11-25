import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { enableAll, read, readerDefaults } from './reader-helpers.js';

for (const [from, to] of [
  [{ width: 1600, height: 1088 }, { width: 1000, height: 760 }],
  [{ width: 1000, height: 760 }, { width: 1600, height: 1088 }],
  [{ width: 1000, height: 760 }, { width: 1000, height: 760 }],
]) test(`open word card keeps mark effective after resize ${from.width} to ${to.width}`, async ({ page, request }) => {
  await readerDefaults(page);
  await page.setViewportSize(from);
  await page.addInitScript(() => localStorage.setItem('wr2:typography', JSON.stringify({ size: 28, line: 1.95, width: 760, font: 'serif' })));
  await enableAll(request);
  await request.patch('/api/profile', { data: { density: 4 } });
  const text = fs.readFileSync(new URL('../../web/sample.txt', import.meta.url), 'utf8');
  const doc = await (await request.post('/api/documents', { data: { title: 'Resize with open word card', text } })).json();
  await read(page, doc.id);
  await page.locator('#article [data-word="river"]').first().click();
  await page.locator('.annotation-pop [data-usage-action="known"]').click();
  await expect(page.locator('.annotation-pop [data-usage-action="known"]')).toBeEnabled();
  await page.reload();
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  await page.locator('#article [data-word="river"]').first().click();
  await expect(page.locator('.annotation-pop [data-usage-action="known"]')).toHaveAttribute('aria-pressed', 'true');
  const leaf = await page.locator('#article .page-leaf').first().elementHandle();
  await page.setViewportSize(to);
  if (from.width !== to.width) await expect.poll(() => leaf.evaluate(node => node.isConnected)).toBe(false);
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  await expect(page.locator('.annotation-pop')).toBeVisible();
  await page.locator('.annotation-pop [data-usage-action="need"]').click();
  await expect(page.locator('.annotation-pop [data-usage-action="need"]')).toBeEnabled();
  await expect(page.locator('.annotation-pop [data-usage-action="need"]')).toHaveAttribute('aria-pressed', 'true');
  const visibleGlosses = () => page.locator('#article .gloss, #article .reflow-note-piece').evaluateAll(nodes => nodes.filter(node => {
    const box = node.getBoundingClientRect(), css = getComputedStyle(node);
    return box.width && box.height && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight &&
      css.visibility !== 'hidden' && css.display !== 'none';
  }).map(node => node.textContent).join(''));
  await expect.poll(visibleGlosses).toMatch(/河.*江/);
  await expect(page.locator('.annotation-pop')).toBeVisible();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  await page.locator('#reading-edge-next').click();
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '1');
  await page.locator('#reading-edge-prev').click();
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '0');
  await expect.poll(visibleGlosses).toMatch(/河.*江/);
});
