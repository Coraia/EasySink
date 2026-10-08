import { bridgeURL } from "./bridge-config.js";
import { movement, completes } from "./input-policy.js";

// No silence/release timer: only explicit NSEvent ended/cancelled/momentum phases.
export function installNativeTrackpad({ begin, enabled, busy }) {
  const rail = document.getElementById("gesture-rail"),
    body = document.body;
  let socket = null,
    connected = false,
    monitorReady = false,
    over = false,
    active = null,
    flight = null,
    serial = 0;
  let point = { y: innerHeight * 0.55 },
    provisional = { x: 0, y: 0, axis: null, lastAt: 0 };
  const pending = [],
    evidence = [];
  const summary = {
    connected: false,
    monitorReady: false,
    physicalEvents: 0,
    fixtureEvents: 0,
    releases: 0,
    landings: 0,
    ignoredMomentum: 0,
  };
  function publish() {
    body.dataset.nativeSummary = JSON.stringify(summary);
    body.dataset.nativeEvidence = JSON.stringify(evidence);
    const label = document.getElementById("lab-status");
    label.textContent =
      !connected || !monitorReady
        ? "原型 · 本机接入未就绪，鼠标纸边可体验"
        : summary.fixtureEvents
          ? "原型 · 模拟阶段验证，不是物理触控板验收"
          : summary.physicalEvents
            ? "原型 · 本机手势阶段已收到"
            : "原型 · 本机已连接，等待触控板手势";
  }
  function log(kind, extra = {}) {
    evidence.push({
      at: performance.now(),
      kind,
      page: +body.dataset.page,
      ...extra,
    });
    if (evidence.length > 512) evidence.shift();
    publish();
  }
  function gate() {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          active: document.hasFocus() && enabled() && (over || Boolean(active)),
        }),
      );
  }
  function state(name) {
    body.dataset.nativeState = name;
  }
  function cancel(reason = "cancelled") {
    const current = active?.session || flight?.session;
    active = flight = null;
    pending.length = 0;
    provisional = { x: 0, y: 0, axis: null, lastAt: 0 };
    state("idle");
    current?.cancel(reason);
    log("cancel", { reason });
    gate();
  }
  function release(g, forcedCancel = false, reason = "native-ended") {
    if (g.ended) return;
    g.ended = true;
    g.complete = !forcedCancel && completes(g);
    if (active === g) active = null;
    summary.releases++;
    log("release", {
      id: g.id,
      complete: g.complete,
      progress: g.progress,
      reason,
      inputToSignalMs: performance.now() - g.lastAt,
    });
    if (!g.waiting && g.session) {
      flight = g;
      g.session.release(g.complete, reason);
    } else if (!g.waiting) state("idle");
    provisional = { x: 0, y: 0, axis: null, lastAt: 0 };
    gate();
  }
  function draw(g, inputAt) {
    g.progress = Math.max(0, Math.min(0.98, g.distance / g.turnDistance));
    g.session?.update(g.progress, g.dy / g.height, inputAt);
    state(g.waiting ? "queued" : "tracking");
    log("model", {
      id: g.id,
      distance: g.distance,
      dy: g.dy,
      progress: g.progress,
      turnDistance: g.turnDistance,
      waiting: g.waiting,
    });
  }
  function start(x, y, inputAt) {
    const direction = Math.sign(x),
      waiting = busy();
    const session = waiting ? null : begin(direction, point.y);
    if (!session && !waiting) return;
    if (pending.length >= 8) {
      cancel("queue-overflow");
      return;
    }
    const leaf = document
      .getElementById(
        direction > 0 && body.dataset.layout === "double" ? "right" : "left",
      )
      .getBoundingClientRect();
    const other = document.getElementById("right").getBoundingClientRect(),
      left = document.getElementById("left").getBoundingClientRect();
    const g = (active = {
      id: ++serial,
      direction,
      session,
      waiting,
      distance: direction * x,
      dy: -y,
      turnDistance:
        session?.turnDistance ||
        leaf.width * 2 +
          (body.dataset.layout === "double" ? other.left - left.right : 0),
      height: session?.height || leaf.height,
      progress: 0,
      lastAt: inputAt,
      ended: false,
    });
    if (waiting) pending.push(g);
    else flight = g;
    movement(g, direction * x, inputAt);
    draw(g, inputAt);
    gate();
  }
  function receive(event) {
    if (!enabled() || !document.hasFocus() || (!over && !active)) return;
    const at = performance.now(),
      phase = Number(event.phase) || 0,
      momentum = Number(event.momentum) || 0;
    if (event.source === "macOS-NSEvent") summary.physicalEvents++;
    else summary.fixtureEvents++;
    log("phase", {
      source: event.source,
      phase,
      momentum,
      dx: event.dx,
      dy: event.dy,
      nativeTime: event.nativeTime,
    });
    if (momentum) {
      summary.ignoredMomentum++;
      if (active) release(active, false, "native-momentum-transition");
      publish();
      return;
    }
    if (phase & 32) return; // mayBegin has no committed scroll/grip yet.
    if (phase & 1) {
      if (active) release(active, false, "native-new-began");
      provisional = { x: 0, y: 0, axis: null, lastAt: at };
    }
    const dx = Number(event.dx) || 0,
      dy = Number(event.dy) || 0;
    if (active && (dx || dy)) {
      const g = active;
      g.distance = Math.max(
        0,
        Math.min(g.turnDistance * 0.98, g.distance + g.direction * dx),
      );
      g.dy -= dy;
      movement(g, g.direction * dx, at);
      draw(g, at);
    } else if (dx || dy) {
      provisional.x += dx;
      provisional.y += dy;
      if (!provisional.axis) {
        if (
          Math.abs(provisional.x) >= 12 &&
          Math.abs(provisional.x) > Math.abs(provisional.y) * 1.35
        )
          provisional.axis = "x";
        else if (
          Math.abs(provisional.y) >= 12 &&
          Math.abs(provisional.y) > Math.abs(provisional.x) * 1.35
        )
          provisional.axis = "y";
      }
      if (provisional.axis === "x") start(provisional.x, provisional.y, at);
    }
    if (phase & 16) {
      if (active) release(active, true, "native-cancelled");
    } else if (phase & 8) {
      if (active) release(active, false, "native-ended");
      else provisional = { x: 0, y: 0, axis: null, lastAt: 0 };
    }
  }
  function drain() {
    if (busy() || !pending.length || !enabled()) return;
    const g = pending.shift();
    g.waiting = false;
    g.session = begin(g.direction, point.y);
    if (!g.session) {
      cancel("boundary");
      return;
    }
    flight = g;
    draw(g, performance.now());
    if (g.ended) g.session.release(g.complete, "native-queued-ended");
  }
  rail.addEventListener("pointerenter", (e) => {
    over = true;
    point.y = e.clientY;
    gate();
  });
  rail.addEventListener("pointerleave", () => {
    over = false;
    gate();
  });
  rail.addEventListener("pointermove", (e) => {
    point.y = e.clientY;
  });
  rail.addEventListener(
    "wheel",
    (e) => {
      // All physical movement comes from AppKit; never double-apply browser wheel.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        cancel("zoom");
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      point.y = e.clientY;
      over = true;
      gate();
      if (e.ctrlKey || e.metaKey || e.altKey) cancel("zoom");
    },
    { passive: false },
  );
  window.addEventListener("blur", () => {
    cancel("blur");
    gate();
  });
  window.addEventListener("focus", gate);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancel("hidden");
    gate();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && (active || flight || pending.length)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel("escape");
      }
    },
    true,
  );
  if (bridgeURL) {
    socket = new WebSocket(bridgeURL);
    socket.onopen = () => {
      connected = summary.connected = true;
      gate();
      publish();
    };
    socket.onmessage = (e) => {
      let value;
      try {
        value = JSON.parse(e.data);
      } catch {
        return;
      }
      if (value.source === "bridge-ready") {
        monitorReady = summary.monitorReady = value.monitorReady === true;
        gate();
        publish();
        return;
      }
      if (
        value.source === "bridge-overflow" ||
        value.source === "monitor-exited"
      ) {
        cancel(value.source);
        monitorReady = summary.monitorReady = false;
        publish();
        return;
      }
      if (
        value.source === "macOS-NSEvent" ||
        value.source === "e2e-phase-fixture"
      )
        receive(value);
    };
    socket.onclose = () => {
      connected = summary.connected = false;
      cancel("bridge-disconnected");
      publish();
    };
    socket.onerror = () => {
      connected = summary.connected = false;
      publish();
    };
  }
  publish();
  state("idle");
  return {
    cancel,
    paperSettled() {
      if (flight) {
        summary.landings++;
        log("landed", { id: flight.id });
        flight = null;
      }
      if (!active && !pending.length) state("idle");
      queueMicrotask(drain);
    },
    gate,
  };
}
