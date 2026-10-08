// Input policy is independent of paper geometry and reading progress.
export function installEdgeDrag({ begin, enabled }) {
  let active = null;
  function cancel(reason = "cancelled") {
    const gesture = active;
    if (!gesture) return;
    active = null;
    gesture.session.cancel(reason);
    if (gesture.el.hasPointerCapture(gesture.id))
      gesture.el.releasePointerCapture(gesture.id);
  }
  for (const [id, direction] of [
    ["prev", -1],
    ["next", 1],
  ]) {
    const el = document.getElementById(id);
    el.addEventListener("pointerdown", (ev) => {
      if (!ev.isPrimary || ev.button !== 0 || active || !enabled()) return;
      const session = begin(direction, ev.clientY);
      if (!session) return;
      ev.preventDefault();
      ev.stopPropagation();
      el.setPointerCapture(ev.pointerId);
      active = {
        id: ev.pointerId,
        el,
        session,
        direction,
        x: ev.clientX,
        y: ev.clientY,
        time: performance.now(),
        lastX: ev.clientX,
        lastAt: performance.now(),
        velocity: 0,
        moved: false,
        progress: 0,
      };
    });
    el.addEventListener("pointermove", (ev) => {
      const g = active;
      if (!g || g.id !== ev.pointerId) return;
      ev.preventDefault();
      const now = performance.now();
      const dx = g.direction * (g.x - ev.clientX);
      const sample =
        (g.direction * (g.lastX - ev.clientX)) / Math.max(1, now - g.lastAt);
      g.velocity = sample;
      g.lastX = ev.clientX;
      g.lastAt = now;
      if (Math.hypot(ev.clientX - g.x, ev.clientY - g.y) > 7) g.moved = true;
      g.progress = Math.max(0, Math.min(0.98, dx / g.session.turnDistance));
      g.session.update(g.progress, (ev.clientY - g.y) / g.session.height, now);
    });
    el.addEventListener("pointerup", (ev) => {
      const g = active;
      if (!g || g.id !== ev.pointerId) return;
      active = null;
      ev.preventDefault();
      ev.stopPropagation();
      const now = performance.now(),
        tap = !g.moved && now - g.time < 240;
      const flick =
        g.moved &&
        g.progress > 0.05 &&
        g.velocity > 0.55 &&
        now - g.lastAt < 90;
      const complete = tap || g.progress > 0.28 || flick;
      g.session.release(
        complete,
        tap ? "tap" : flick ? "flick" : complete ? "distance" : "spring-back",
      );
      if (el.hasPointerCapture(g.id)) el.releasePointerCapture(g.id);
    });
    el.addEventListener("pointercancel", () => cancel("pointer-cancel"));
    el.addEventListener("lostpointercapture", () => cancel("capture-lost"));
  }
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key === "Escape" && active) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        cancel("escape");
      }
    },
    true,
  );
  document.addEventListener("curl-context-lost", () => cancel("gpu-lost"));
  window.addEventListener("blur", () => cancel("window-blur"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancel("hidden");
  });
  return { cancel, isActive: () => Boolean(active) };
}
