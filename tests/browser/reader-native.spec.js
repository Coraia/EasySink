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
async function prepared(page, request, layout = 'single', {desktop = false} = {}) {
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
async function preparedPresentation(page, request) {
  await request.patch('/api/profile', { data: { density: 15 } });
  const doc = await prepared(page, request, 'double');
  const retained = page.locator('#article [data-word="conviction"]').first();
  await retained.click();
  await expect(page.locator('.annotation-pop .dictionary-candidates')).toBeVisible();
  await page.locator('[data-retained]').click();
  await expect(page.locator('[data-retained]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-retained]')).toBeEnabled();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  await expect(page.locator('#article [data-target="conviction"]')).toHaveCount(1);
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
