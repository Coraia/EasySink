import { sourceCaretAt } from "./selection-range.js";

// At a focusable word's leading edge Chromium can put the initial caret in
// the preceding space, then leave it collapsed throughout an otherwise valid
// mouse drag. Recover only that stalled native gesture, using character carets.
export function installSelectionDragRecovery(reader) {
  let gesture = null, frame = 0;
  const update = () => {
    frame = 0;
    const g = gesture;
    if (!g?.moved || !g.start.node.isConnected) return;
    const selection = getSelection();
    if (!selection || (!g.recovering && !selection.isCollapsed)) return;
    const end = sourceCaretAt(g.x, g.y);
    if (!end) return;
    g.recovering = true;
    selection.setBaseAndExtent(g.start.node, g.start.offset, end.node, end.offset);
  };
  reader.scope.on(document.querySelector("#article"), "pointerdown", event => {
    if (event.button !== 0 || event.pointerType !== "mouse" ||
        !event.target.closest("[data-block]") ||
        event.target.closest(".gloss,button,a,input,textarea,select,[data-pdf-object]")) return;
    const start = sourceCaretAt(event.clientX, event.clientY);
    if (start) gesture = { id: event.pointerId, start, x: event.clientX, y: event.clientY,
      originX: event.clientX, originY: event.clientY, moved: false, recovering: false };
  });
  reader.scope.on(document, "pointermove", event => {
    if (gesture?.id !== event.pointerId || !(event.buttons & 1)) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    gesture.moved ||= Math.hypot(event.clientX - gesture.originX, event.clientY - gesture.originY) > 6;
    if (gesture.moved && !frame) frame = requestAnimationFrame(update);
  });
  const stop = () => { cancelAnimationFrame(frame); frame = 0; gesture = null; };
  reader.scope.on(document, "pointerup", event => {
    if (gesture?.id !== event.pointerId) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    cancelAnimationFrame(frame); update(); stop();
  }, { capture: true });
  reader.scope.on(document, "pointercancel", stop);
  reader.scope.on(window, "blur", stop);
  reader.scope.cleanup(stop);
}
