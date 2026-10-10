import { anchorSegments, sameSelection } from "./source-selection.js";
import { rangeAnchorFromPoints, sourcePointAt } from "./selection-range.js";

export function installSelectionHandles(r) {
  const layer = document.createElement("div");
  layer.className = "selection-handles";
  layer.innerHTML = ['start', 'end'].map(edge => `<button type="button" class="selection-handle" data-selection-edge="${edge}" aria-label="调整选区${edge === 'start' ? '起点' : '终点'}" title="拖动调整选区${edge === 'start' ? '起点' : '终点'}" hidden></button>`).join('');
  document.querySelector('.reader').append(layer);
  const handles = [...layer.children];
  let drag = null, frame = 0, lastPoint;

  const endpointRect = edge => {
    const part = edge === 'start' ? anchorSegments(r.selection)[0] : anchorSegments(r.selection).at(-1);
    if (!part) return null;
    const offset = edge === 'start' ? part.start : part.end;
    const runs = (r.selectedTextRanges || []).filter(run =>
      run.block.dataset.block === part.block_id && run.start <= offset && run.end >= offset);
    const candidates = edge === 'start' ? runs : runs.toReversed();
    for (const run of candidates) {
      const rects = [...run.range.getClientRects()];
      const rect = edge === 'start' ? rects[0] : rects.at(-1);
      const leaf = run.block.closest('.page-leaf').getBoundingClientRect();
      if (rect?.height && rect.bottom > Math.max(0, leaf.top) && rect.top < Math.min(innerHeight, leaf.bottom))
        return { x: edge === 'start' ? rect.left : rect.right, top: rect.top, height: rect.height };
    }
    return null;
  };
  r.positionSelectionHandles = () => {
    const show = r.selection && r.selection.kind !== 'image' && !r.selecting &&
      !r.aiSetupOpen && !r.grammarInspecting && !r.focus.isOpen() && !r.panelId && !r.pages?.animating;
    for (const button of handles) {
      const rect = show && endpointRect(button.dataset.selectionEdge);
      button.hidden = !rect;
      if (!rect) continue;
      button.style.left = rect.x + 'px';
      button.style.top = rect.top - 12 + 'px';
      button.style.setProperty('--selection-line-height', rect.height + 'px');
    }
  };
  const update = () => {
    frame = 0;
    if (!drag || !lastPoint) return;
    const point = sourcePointAt(lastPoint.x - drag.dx, lastPoint.y - drag.dy);
    if (!point) return;
    try {
      const anchor = rangeAnchorFromPoints(r, drag.fixed, point);
      if (!anchor?.quote.trim() || sameSelection(anchor, r.selection)) return;
      // Crossing the stationary end swaps handle roles, keeping the dragged
      // endpoint under the pointer without producing an inverted selection.
      const first = anchorSegments(anchor)[0];
      const edge = point.block_id === first.block_id && point.offset === first.start ? 'start' : 'end';
      if (drag.button.dataset.selectionEdge !== edge) {
        handles.find(b => b !== drag.button).dataset.selectionEdge = edge === 'start' ? 'end' : 'start';
        drag.button.dataset.selectionEdge = edge;
        for (const b of handles) {
          const name = b.dataset.selectionEdge === 'start' ? '起点' : '终点';
          b.setAttribute('aria-label', '调整选区' + name); b.title = '拖动调整选区' + name;
        }
      }
      r.choose(anchor);
      r.selectionPlacement = { block_id: point.block_id, offset: point.offset, trigger: 'range' };
    } catch (error) {
      if (drag.error !== error.message) r.status(error.message);
      drag.error = error.message;
    }
  };
  const finish = () => {
    if (!drag) return;
    cancelAnimationFrame(frame); update();
    const old = drag;
    drag = null; lastPoint = null;
    r.adjustingSelection = false;
    layer.classList.remove('is-dragging');
    if (old.button.hasPointerCapture(old.id)) old.button.releasePointerCapture(old.id);
    r.positionSelection();
  };
  r.scope.on(layer, 'pointerdown', ev => {
    const button = ev.target.closest('[data-selection-edge]');
    if (!button || ev.button !== 0 || !r.selection) return;
    ev.preventDefault(); ev.stopPropagation();
    const edge = button.dataset.selectionEdge, rect = endpointRect(edge);
    if (!rect) return;
    const parts = anchorSegments(r.selection), fixed = edge === 'start' ? parts.at(-1) : parts[0];
    drag = { id: ev.pointerId, button, fixed: {block_id: fixed.block_id, offset: edge === 'start' ? fixed.end : fixed.start},
      dx: ev.clientX - rect.x, dy: ev.clientY - (rect.top + rect.height / 2) };
    r.adjustingSelection = true;
    getSelection()?.removeAllRanges();
    r.emit('before-selection');
    for (const controller of r.pending.values()) controller.cancel();
    r.pending.clear();
    button.setPointerCapture(ev.pointerId);
    layer.classList.add('is-dragging');
    r.positionSelection();
  });
  r.scope.on(document, 'pointermove', ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    ev.preventDefault();
    lastPoint = {x: ev.clientX, y: ev.clientY};
    if (!frame) frame = requestAnimationFrame(update);
  }, { capture: true, passive: false });
  r.scope.on(document, 'pointerup', ev => {
    if (drag?.id !== ev.pointerId) return;
    lastPoint = {x: ev.clientX, y: ev.clientY};
    finish();
  }, {capture: true});
  r.scope.on(layer, 'lostpointercapture', finish);
  r.scope.on(document, 'pointercancel', finish, {capture: true});
  r.scope.on(window, 'blur', finish);
  r.scope.on(layer, 'click', ev => { ev.preventDefault(); ev.stopPropagation(); });
  // Keyboard adjustment uses character boundaries too, including surrogate pairs.
  r.scope.on(layer, 'keydown', ev => {
    if (!['ArrowLeft','ArrowRight'].includes(ev.key) || !r.selection) return;
    ev.preventDefault(); ev.stopPropagation();
    const edge = ev.target.dataset.selectionEdge, parts = anchorSegments(r.selection);
    const part = edge === 'start' ? parts[0] : parts.at(-1);
    const fixed = edge === 'start' ? parts.at(-1) : parts[0];
    const block = r.doc.blocks.find(b => b.id === part.block_id);
    let offset = edge === 'start' ? part.start : part.end;
    offset += ev.key === 'ArrowLeft' ? -1 : 1;
    if (offset > 0 && offset < block.text.length && /[\uDC00-\uDFFF]/.test(block.text[offset]))
      offset += ev.key === 'ArrowLeft' ? -1 : 1;
    offset = Math.max(0, Math.min(block.text.length, offset));
    try {
      const anchor = rangeAnchorFromPoints(r, {block_id: fixed.block_id, offset: edge === 'start' ? fixed.end : fixed.start}, {block_id: part.block_id, offset});
      if (anchor?.quote.trim()) {
        getSelection()?.removeAllRanges(); r.choose(anchor);
        r.selectionPlacement = {block_id: part.block_id, offset, trigger: 'range'};
        r.positionSelection();
      }
    } catch (error) { r.status(error.message); }
  });
  r.scope.cleanup(() => { cancelAnimationFrame(frame); drag = null; r.adjustingSelection = false; layer.remove(); });
}
