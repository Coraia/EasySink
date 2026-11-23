import { test, expect } from '@playwright/test';
import { enableAll, read, readerDefaults } from './reader-helpers.js';

const engine = process.env.WR_E2E_ENGINE || 'chromium';
test.use({ browserName: engine, channel: engine === 'chromium' ? 'chrome' : '' });
test('returning to the first spread after word reflows preserves the document opening', async ({ page, request }) => {
  await readerDefaults(page);
  await page.addInitScript(() => {
    localStorage.setItem('wr2:page-layout', JSON.stringify('double'));
    localStorage.setItem('wr2:page-motion', JSON.stringify('curl'));
  });
  await page.setViewportSize({ width: 1600, height: 1088 });
  await enableAll(request);
  await request.patch('/api/profile', { data: { density: 0, vocab_size: 8000 } });
  const opening = 'The parable of the sower is easy to sentimentalize and hard to inhabit. A sower goes out to sow. ';
  const text = opening + `Some seed falls on the path, some on rocky ground, some among thorns, some on good soil. The yield is uneven, and the sower does not seem particularly careful. Modern readers, trained by optimization, want to improve the technique. Why waste seed on the path? Why not till the rocks first? The story is uninterested in process improvement. It is interested in reception.

In the synoptic telling, the disciples ask why he speaks in parables. The answer is uncomfortable. Parables both reveal and conceal. They are not illustrations for a principle you already possess. They are a threshold: those who have ears, hear. That sentence has been used as a club and as a comfort. Used as a club, it sorts the room into insiders and outsiders. Used as a comfort, it admits that understanding is not a technique you can grind through on a schedule. The word arrives. The soil is whatever it is that morning.

Augustine, reading the same passage, refused to let the soils become a caste system. Conversion, for him, is not a one-time reclassification of dirt. The path can be broken up. The thorns can be pulled. Grace is not a fertilizer you apply after the seed is in; it is the possibility that the field is not finished. That reading sits in tension with any piety that treats spiritual biography as a completed map. It also sits in tension with a church that wants metrics: attendance, giving, professions of faith counted like bushels.

I have been around enough Bible studies to watch the thorns named too quickly. Careers, phones, politics. All real. The more interesting thorns are the religious ones: the desire to be the good soil in the story, to be the character who understood the parable on first hearing. That desire is a kind of hardness. It wants the yield without the waiting. It wants the interpretation without the weather.

The incarnation is the church's claim that God did not stay in the commentary. The Word became flesh and dwelt among us. That sentence is doing metaphysical work and agricultural work at once. If the sower is also the seed, then the unevenness of the harvest is not a failure of targeting. It is the shape of a world that can refuse. Consent, in this frame, is not a legal checkbox. It is the terrifying dignity of being soil that can say no.

None of this requires you to believe it. It does require you to notice that the New Testament is not a self-help manual with rural metaphors. It is a set of claims about what kind of universe this is: whether it is closed, whether it can be addressed, whether a person can be known without being used. The sower keeps sowing. That persistence is either sentimentality or the most serious thing in the book.

` +
    ('The small research team prepared a plan for the harbor and checked the lamps before sunset.\n\n').repeat(60);
  const doc = await (await request.post('/api/documents', { data: { title: 'Reflow opening', text } })).json();
  await read(page, doc.id);
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  const settled = async () => {
    await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'preparing');
    await expect(page.locator('#article')).not.toHaveAttribute('data-reflow-phase', 'playing');
  };
  async function actions(word, sequence) {
    const target = word === 'not'
      ? page.locator('#article .page-leaf').first().locator('[data-word="not"]').last()
      : page.locator(`#article [data-word="${word}"]`).first();
    await target.click();
    for (const action of sequence) {
      const button = page.locator(`.annotation-pop [data-usage-action="${action}"]`);
      await expect(button).toBeEnabled();
      await button.click();
      await expect(button).toBeEnabled();
      await settled();
    }
  }
  await actions('parable', ['need', 'known', 'auto', 'need', 'known', 'need']);
  await actions('not', ['need']);
  await actions('legal', ['need', 'known', 'auto']);
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  await settled();
  await expect(page.locator('.reader')).toHaveAttribute('data-pagination-ready', 'true');
  await page.locator('#reading-edge-next').click();
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '2');
  await page.locator('#reading-edge-prev').click();
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '0');
  const first = page.locator('#article .page-leaf').first().locator('[data-word]').first();
  await expect(first).toBeVisible();
  await expect(first).toHaveAttribute('data-source-start', '0');
  await expect(first).toHaveText('The');
  expect(await page.locator('#article [data-word]').evaluateAll(nodes => nodes.slice(0, 15).map(n => n.textContent)))
    .toEqual(opening.match(/[A-Za-z]+/g).slice(0, 15));
  await expect(page.locator('#article [data-target="not"] .gloss').first()).toBeVisible();

  const end = await page.locator('#article [data-block]').last().evaluate(n => ({ block: n.dataset.block, start: +n.dataset.end }));
  const order = doc.blocks.findIndex(b => b.id === end.block);
  const next = end.start === doc.blocks[order].text.length ? { block: doc.blocks[order + 1].id, start: 0 } : end;
  await page.locator('#reading-edge-next').click();
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '2');
  await expect(page.locator('#article [data-block]').first()).toHaveAttribute('data-block', next.block);
  await expect(page.locator('#article [data-block]').first()).toHaveAttribute('data-start', String(next.start));
  await page.locator('#reading-edge-prev').click();
  await expect(page.locator('.reader')).toHaveAttribute('data-page-index', '0');
  await expect(first).toHaveAttribute('data-source-start', '0');
});
