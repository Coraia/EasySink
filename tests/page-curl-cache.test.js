import assert from "node:assert/strict";
import test from "node:test";

import { PageCurlRenderer } from "../web/page-curl-renderer.js";
import { ReadingPages } from "../web/pagination.js";

test("page texture keys invalidate on source generation, renderer epoch, and DPR", () => {
  const priorDpr = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    const pages = { r: { doc: { id: 7, version: 11 } }, generation: 3 };
    const renderer = { pages, epoch: 5 };
    const key = (source = pages) => PageCurlRenderer.prototype.key.call(renderer, 4, source);
    const original = key();

    pages.generation = 4;
    assert.notEqual(key(), original, "font, viewport, or other reflow generation must invalidate");

    pages.generation = 3;
    renderer.epoch = 6;
    assert.notEqual(key(), original, "annotation paint invalidation must invalidate");

    renderer.epoch = 5;
    globalThis.devicePixelRatio = 3;
    assert.notEqual(key(), original, "DPR changes must invalidate");

    globalThis.devicePixelRatio = 2;
    const firstView = { ...pages, view: { textureGeneration: "3:view:1" } };
    const secondView = { ...pages, view: { textureGeneration: "3:view:2" } };
    assert.notEqual(key(firstView), key(secondView), "distinct source windows must never share textures");
    assert.equal(key(firstView), key(firstView), "one prepared source window keeps a stable key");
  } finally {
    if (priorDpr === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = priorDpr;
  }
});

test("presentation plan identity changes for a new window at the same canonical index", () => {
  const first = { textureGeneration: "9:view:4" };
  const pages = {
    r: { doc: { id: 7, version: 11 } },
    generation: 9,
    presentationRevision: 12,
    annotationLayout: [{ leaf: {} }],
    presentedView: first,
    viewTrail: [first],
    viewTrailIndex: 0,
    index: 24,
    count: 2,
  };
  const original = ReadingPages.prototype.presentationSourcePlanIdentity.call(pages);
  const second = { textureGeneration: "9:view:5" };
  pages.presentedView = second;
  pages.viewTrail = [second];
  pages.presentationRevision++;
  assert.notEqual(ReadingPages.prototype.presentationSourcePlanIdentity.call(pages), original);
  assert.equal(pages.index, 24, "canonical page index intentionally stays unchanged");
});
