// A reversible preview can settle before the input stream is confirmed. New
// streams own their compressed input even while the previous paper is landing.
export function installReadingTrackpad(ctx) {
  const quiet = 240,
    coastAfter = 90,
    dominance = 1.35;
  const controller = new AbortController();
  let last = -Infinity,
    x = 0,
    y = 0,
    axis = null,
    locked = false;
  let active = null,
    flight = null,
    timer = 0;
  const pending = [];
  const clamp = (p) => Math.max(0, Math.min(0.98, p));
  const markIdle = (g) => {
    g.root.dataset.trackpadState = "idle";
    delete g.root.dataset.trackpadProgress;
  };
  function cancel(reason) {
    const g = active,
      pages = flight;
    active = null;
    clearTimeout(timer);
    timer = 0;
    pending.length = 0;
    locked = true;
    if (g) {
      markIdle(g);
      delete g.root.dataset.trackpadQueue;
    }
    flight = null;
    if (pages) pages.finishAnimation(reason);
  }
  function coast(g) {
    if (g.waiting || !g.session || g.coasting) return;
    g.coasting = true;
    g.root.dataset.trackpadState = "settling";
    const complete = g.progress >= 0.5 && !g.reversing;
    g.session.release(
      complete,
      complete ? "trackpad-complete" : "trackpad-return",
      { inputAt: g.lastAt, notBefore: g.lastAt + quiet },
    );
  }
  function finalize(g) {
    if (active !== g) return;
    clearTimeout(timer);
    timer = 0;
    g.ended = true;
    coast(g);
    active = null;
    locked = true;
    if (!g.waiting && !g.session) {
      markIdle(g);
      if (g.progress >= 0.5 && !g.reversing)
        Promise.resolve()
          .then(() => {
            if (!g.reader.scope.signal.aborted && ctx.reader === g.reader)
              return g.pages.adjacent(g.direction);
          })
          .catch((err) => {
            if (!g.reader.scope.signal.aborted) {
              console.error(err);
              g.reader.status("翻页暂时失败，请重试");
            }
          });
    }
  }
  function arm(g) {
    if (active !== g) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        if (active !== g) return;
        coast(g);
        timer = setTimeout(
          () => finalize(g),
          Math.max(0, g.lastAt + quiet - performance.now()),
        );
      },
      Math.max(0, g.lastAt + coastAfter - performance.now()),
    );
  }
  function paintModel(g, catchUp = false) {
    g.root.dataset.trackpadState = g.waiting ? "queued" : "tracking";
    g.root.dataset.trackpadProgress = g.progress.toFixed(3);
    g.session?.update(clamp(g.progress + g.offset), 0, g.inputAt, catchUp);
  }
  function update(g, delta, now) {
    if (g.coasting) {
      const p = g.session?.resume();
      // Keep logical distance/intent, but continue from the visible paper. An
      // interrupted coast must not move backwards when the finger moves ahead.
      if (typeof p === "number") g.offset = p - g.progress;
      g.coasting = false;
    }
    g.distance = Math.max(0, Math.min(g.travel * 0.98, g.distance + delta));
    const sign = Math.sign(delta);
    if (sign) {
      g.intentDistance =
        sign === g.intentSign
          ? g.intentDistance + Math.abs(delta)
          : Math.abs(delta);
      g.intentSign = sign;
      if (g.intentDistance >= 3) g.reversing = sign < 0;
    }
    g.progress = g.distance / g.travel;
    g.inputAt = now;
    paintModel(g);
    g.lastAt = last = performance.now();
    arm(g);
  }
  function drain(pages) {
    if (
      pages.animating ||
      pages.r.scope.signal.aborted ||
      ctx.reader !== pages.r
    )
      return;
    const g = pending[0];
    if (!g || g.pages !== pages) return;
    if (!pages.canGrab()) {
      cancel("queued-interaction");
      return;
    }
    pending.shift();
    g.root.dataset.trackpadQueue = String(pending.length);
    g.waiting = false;
    g.session = pages.beginTurn(g.direction, g.clientY);
    if (g.session) flight = pages;
    paintModel(g, true);
    if (g.ended || active !== g) {
      coast(g);
      if (!g.session && g.progress >= 0.5 && !g.reversing)
        Promise.resolve(pages.adjacent(g.direction)).catch(console.error);
    } else arm(g);
  }
  function bind(pages, root) {
    if (pages.trackpad) return;
    pages.trackpad = {
      cancel(reason) {
        if (flight === pages) flight = null;
        if (reason === "settled") {
          if (active?.pages === pages && !active.waiting) {
            active = null;
            clearTimeout(timer);
            timer = 0;
            locked = true;
          }
          if (!active?.waiting) {
            root.dataset.trackpadState = "idle";
            delete root.dataset.trackpadProgress;
          }
          queueMicrotask(() => drain(pages));
        } else {
          if (active?.pages === pages) {
            active = null;
            clearTimeout(timer);
            timer = 0;
          }
          for (let i = pending.length - 1; i >= 0; i--)
            if (pending[i].pages === pages) pending.splice(i, 1);
          root.dataset.trackpadState = "idle";
          delete root.dataset.trackpadProgress;
          delete root.dataset.trackpadQueue;
          locked = true;
        }
      },
    };
    pages.r.scope.cleanup(() => {
      if (
        active?.pages === pages ||
        flight === pages ||
        pending.some((g) => g.pages === pages)
      )
        cancel("route-leave");
    });
  }
  const onWheel = (ev) => {
    if (!document.body.classList.contains("paged-reading")) {
      cancel("outside-reader");
      last = -Infinity;
      return;
    }
    const now = performance.now();
    if (now - last > quiet) {
      if (active) finalize(active);
      x = y = 0;
      axis = null;
      locked = false;
    }
    last = now;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      cancel("zoom");
      return;
    }
    const unit = ev.deltaMode === 1 ? 16 : 1;
    const dx = ev.deltaX * (ev.deltaMode === 2 ? innerWidth : unit);
    x += dx;
    y += ev.deltaY * (ev.deltaMode === 2 ? innerHeight : unit);
    if (!axis) {
      if (Math.abs(x) >= 12 && Math.abs(x) > Math.abs(y) * dominance)
        axis = "x";
      else if (Math.abs(y) >= 12 && Math.abs(y) > Math.abs(x) * dominance)
        axis = "y";
    }
    const reader = ctx.reader,
      pages = reader?.pages;
    const target = ev.target instanceof Element ? ev.target : null;
    const inPaper =
      Boolean(target?.closest("#reading-stage")) &&
      !target.closest(
        "button, a, input, textarea, select, [contenteditable], #reading-selection, #translation-pane",
      );
    const ours = Boolean(
      pages?.preview &&
      (flight === pages || (active?.session && active.pages === pages)),
    );
    if (!pages || !inPaper || ev.buttons || !pages.canGrab(ours)) {
      cancel("interaction-blocked");
      if (axis === "x" && (inPaper || !reader)) ev.preventDefault();
      return;
    }
    if (axis !== "x") return;
    ev.preventDefault();
    if (locked) return;
    if (active) {
      update(active, active.direction * dx, now);
      return;
    }
    const direction = Math.sign(x),
      root = ctx.root.querySelector(".reader");
    bind(pages, root);
    const waiting = pages.animating || pending.length > 0;
    if (waiting && pending.length >= 32) {
      cancel("queue-overflow");
      reader.status("翻页暂时繁忙，请重试");
      return;
    }
    const session = waiting ? null : pages.beginTurn(direction, ev.clientY);
    const g = (active = {
      reader,
      pages,
      root,
      direction,
      session,
      waiting,
      clientY: ev.clientY,
      travel: Math.max(
        280,
        Math.min(600, (session?.turnDistance || pages.width * 2 || 1200) / 2),
      ),
      distance: 0,
      progress: 0,
      offset: 0,
      reversing: false,
      coasting: false,
      ended: false,
      intentSign: 0,
      intentDistance: 0,
    });
    if (session) flight = pages;
    if (waiting) {
      pending.push(g);
      root.dataset.trackpadQueue = String(pending.length);
    }
    update(g, Math.abs(x), now);
    if (waiting && !pages.animating) queueMicrotask(() => drain(pages));
  };
  document.addEventListener("wheel", onWheel, {
    passive: false,
    capture: true,
    signal: controller.signal,
  });
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Escape" || !(active || flight || pending.length)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      cancel("escape");
    },
    { capture: true, signal: controller.signal },
  );
  window.addEventListener("blur", () => cancel("window-blur"), {
    signal: controller.signal,
  });
  document.addEventListener(
    "pointerdown",
    () => {
      if (active || flight || pending.length) cancel("pointer-interrupt");
    },
    { capture: true, signal: controller.signal },
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) cancel("hidden");
    },
    { signal: controller.signal },
  );
  return () => {
    cancel("uninstall");
    controller.abort();
  };
}
