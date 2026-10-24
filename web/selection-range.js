import { combineSelection } from "./source-selection.js";

const nonSource = ".gloss,.annotation-gloss-space,.bookmark-marker,.note-marker";

export function* sourceRuns(root = document.querySelector("#article")) {
  for (const block of root?.querySelectorAll("[data-block]:not([data-pdf-object])") || []) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node, offset = +block.dataset.start;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest(nonSource)) continue;
      yield { node, block, start: offset, end: offset + node.length };
      offset += node.length;
    }
  }
}

function comparePoints(a, ao, b, bo) {
  const left = document.createRange(), right = document.createRange();
  left.setStart(a, ao); left.collapse(true);
  right.setStart(b, bo); right.collapse(true);
  return left.compareBoundaryPoints(Range.START_TO_START, right);
}

export function rangeAnchorFromPoints(reader, first, last) {
  const blocks = reader.doc.blocks;
  let a = blocks.findIndex(b => b.id === first.block_id);
  let b = blocks.findIndex(b => b.id === last.block_id);
  if (a < 0 || b < 0) return null;
  if (a > b || (a === b && first.offset > last.offset)) {
    [first, last] = [last, first]; [a, b] = [b, a];
  }
  const parts = [];
  let length = 0;
  for (let i = a; i <= b; i++) {
    const block = blocks[i];
    if (block.asset_url && ["image", "image_fallback", "formula", "table"].includes(block.type))
      throw Error("选区含原图引用，请选择连续的已识别文字。");
    const start = i === a ? first.offset : 0, end = i === b ? last.offset : block.text.length;
    if (end <= start) continue;
    length += end - start + (parts.length ? 2 : 0);
    if (length > 8000) throw Error("本次选区超过 8000 个字符，请缩短后重试");
    parts.push(reader.anchorFor(block.id, start, end));
  }
  return combineSelection(parts);
}

export function anchorFromDOMRange(reader, range) {
  // Native selection can start in the grammar slot or finish in paragraph
  // furniture. Intersect it with source text instead of rejecting its endpoints.
  if ([...document.querySelectorAll("#article [data-pdf-object]")].some(el => range.intersectsNode(el)))
    throw Error("选区含原图引用，请选择连续的已识别文字。");
  let first, last;
  for (const run of sourceRuns()) {
    const { node, block, start } = run;
    if (!node.length ||
        comparePoints(range.endContainer, range.endOffset, node, 0) <= 0 ||
        comparePoints(range.startContainer, range.startOffset, node, node.length) >= 0) continue;
    const a = range.startContainer === node ? range.startOffset : 0;
    const b = range.endContainer === node ? range.endOffset : node.length;
    if (a >= b) continue;
    first ||= { block_id: block.dataset.block, offset: start + a };
    last = { block_id: block.dataset.block, offset: start + b };
  }
  return first && last ? rangeAnchorFromPoints(reader, first, last) : null;
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  const p = document.caretRangeFromPoint?.(x, y);
  return p ? { node: p.startContainer, offset: p.startOffset } : null;
}

// Keep native text nodes for drag recovery; never snap an endpoint to a word.
export function sourceCaretAt(x, y) {
  const point = caretAt(x, y);
  const element = point?.node.nodeType === 1 ? point.node : point?.node.parentElement;
  return element?.closest("#article [data-block]:not([data-pdf-object])") &&
    !element.closest(nonSource) ? point : null;
}

export function sourcePointAt(x, y) {
  let point = caretAt(x, y);
  let element = point?.node.nodeType === 1 ? point.node : point?.node.parentElement;
  let block = element?.closest("#article [data-block]:not([data-pdf-object])");
  if (!block || element.closest(nonSource)) {
    // Gaps between lines/paragraphs follow the nearest visible source edge.
    const choices = [...document.querySelectorAll("#article [data-block]:not([data-pdf-object])")]
      .map(el => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({rect}) => rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight);
    const distance = r => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    choices.sort((a, b) => distance(a.rect) - distance(b.rect));
    const nearest = choices[0];
    if (!nearest) return null;
    point = caretAt(Math.max(nearest.rect.left + 1, Math.min(x, nearest.rect.right - 1)),
      Math.max(nearest.rect.top + 1, Math.min(y, nearest.rect.bottom - 1)));
    element = point?.node.nodeType === 1 ? point.node : point?.node.parentElement;
    block = element?.closest("#article [data-block]:not([data-pdf-object])");
  }
  if (!block || element.closest(nonSource)) return null;
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(point.node, point.offset);
  const contents = before.cloneContents();
  contents.querySelectorAll(nonSource).forEach(el => el.remove());
  return { block_id: block.dataset.block, offset: +block.dataset.start + contents.textContent.length };
}
