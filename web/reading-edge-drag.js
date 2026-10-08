// Pointer policy is separate from paper rendering and stable source anchors.
import { movement, completes } from "./reading-gesture-policy.js";
export function installReadingEdgeDrag(pages) {
  const scope = pages.r.scope;
  let active = null;
  const consume = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  function cancel(reason = "cancelled") {
    const g = active;
    if (!g) return;
    active = null;
    g.session?.cancel(reason);
    if (g.el.hasPointerCapture(g.id)) g.el.releasePointerCapture(g.id);
  }
  for (const [id, direction] of [
    ["reading-edge-prev", -1],
    ["reading-edge-next", 1],
  ]) {
    const el = document.getElementById(id);
    scope.on(el, "pointerdown", (ev) => {
      if (!ev.isPrimary || ev.button !== 0 || active || !pages.canGrab())
        return;
      const session = pages.beginTurn(direction, ev.clientY);
      consume(ev);
      el.setPointerCapture(ev.pointerId);
      active = {
        el,
        id: ev.pointerId,
        session,
        direction,
        x: ev.clientX,
        y: ev.clientY,
        started: performance.now(),
        lastX: ev.clientX,
        lastAt: performance.now(),
        velocity: 0,
        progress: 0,
        moved: false,
      };
    });
    scope.on(el, "pointermove", (ev) => {
      const g = active;
      if (!g || g.id !== ev.pointerId) return;
      consume(ev);
      const now = performance.now(),
        dx = g.direction * (g.x - ev.clientX);
      movement(g, g.direction * (g.lastX - ev.clientX), now);
      g.lastX = ev.clientX;
      g.lastAt = now;
      if (Math.hypot(ev.clientX - g.x, ev.clientY - g.y) > 7) g.moved = true;
      g.progress = Math.max(
        0,
        Math.min(0.98, dx / (g.session?.turnDistance || pages.width * 2)),
      );
      g.session?.update(g.progress, (ev.clientY - g.y) / g.session.height, now);
    });
    scope.on(el, "pointerup", (ev) => {
      const g = active;
      if (!g || g.id !== ev.pointerId) return;
      active = null;
      consume(ev);
      const now = performance.now(),
        tap = !g.moved && now - g.started < 240,
        flick =
          g.moved &&
          g.progress > 0.05 &&
          g.velocity > 0.55 &&
          now - g.lastAt < 90,
        complete = completes(g, tap);
      if (g.session)
        g.session.release(
          complete,
          tap ? "tap" : flick ? "flick" : complete ? "distance" : "spring-back",
        );
      else if (complete) pages.adjacent(direction);
      if (el.hasPointerCapture(g.id)) el.releasePointerCapture(g.id);
    });
    scope.on(el, "pointercancel", () => cancel("pointer-cancel"));
    scope.on(el, "lostpointercapture", () => cancel("capture-lost"));
    scope.on(el, "click", (ev) => {
      consume(ev);
      // Pointer releases own their commit. A keyboard activation has no release.
      if (ev.detail === 0 && pages.canGrab()) pages.adjacent(direction);
    });
  }
  scope.on(
    document,
    "keydown",
    (ev) => {
      if (ev.key === "Escape" && (active || pages.preview)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        cancel("escape");
        pages.finishAnimation("escape");
      }
    },
    { capture: true },
  );
  scope.on(window, "blur", () => {
    cancel("window-blur");
    pages.finishAnimation("window-blur");
  });
  scope.on(document, "visibilitychange", () => {
    if (document.hidden) {
      cancel("hidden");
      pages.finishAnimation("hidden");
    }
  });
  scope.cleanup(() => cancel("route-leave"));
  return { cancel };
}
