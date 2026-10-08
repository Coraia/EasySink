import { movement, completes } from "./reading-gesture-policy.js";

// App-owned phases; ordinary source DOM retains word selection and notes.
export function installNativeReadingTrackpad(ctx, config) {
  const controller = new AbortController(), options = { signal: controller.signal };
  let socket, connected = false, monitorReady = false, stopped = false, attempts = 0, retry;
  let over = false, clientY = innerHeight * .55, active = null, flight = null, serial = 0;
  let provisional = { x: 0, y: 0, axis: null }, lastGate;
  const pending = [], records = [], bound = new WeakSet();
  const counts = { events: 0, physicalEvents: 0, fixtureEvents: 0, momentum: 0, releases: 0, landings: 0 };
  function publish() {
    const root = ctx.root.querySelector('.reader');
    if (!root) return;
    root.dataset.trackpadMode = connected && monitorReady ? 'native' : 'native-unavailable';
    root.dataset.nativeTrackpad = JSON.stringify(counts);
    root.dataset.nativeGestures = JSON.stringify(records);
  }
  function log(kind, extra = {}) {
    records.push({ at: performance.now(), kind, doc: ctx.reader?.doc.id,
      page: ctx.reader?.pages.index, ...extra });
    if (records.length > 256) records.shift();
    publish();
  }
  function allowed(pages = ctx.reader?.pages) {
    return Boolean(pages && ctx.reader === pages.r && pages.canGrab(true) &&
      !pages.r.scope.signal.aborted && document.hasFocus() && !document.hidden);
  }
  function inPaper(target) {
    return target instanceof Element && Boolean(target.closest('#reading-stage')) &&
      !target.closest('a,input,textarea,select,[contenteditable],#reading-selection,#translation-pane') &&
      (!target.closest('button') || Boolean(target.closest('.reading-edge-grip')));
  }
  function gate() {
    const on = allowed() && (over || Boolean(active));
    if (on !== lastGate) { log('gate', { enabled: on, over }); lastGate = on; }
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ active: on }));
    publish();
  }
  function idle(pages) {
    const root = pages?.r.el || ctx.root.querySelector('.reader');
    if (root) {
      root.dataset.trackpadState = 'idle';
      delete root.dataset.trackpadProgress;
      delete root.dataset.trackpadQueue;
    }
  }
  function cancel(reason, cancelPaper = true) {
    const g = active || flight || pending[0], session = active?.session || flight?.session;
    active = flight = null; pending.length = 0;
    provisional = { x: 0, y: 0, axis: null };
    idle(g?.pages);
    if (g) log('cancel', { id: g.id, reason });
    if (cancelPaper) session?.cancel(reason);
    gate();
  }
  function bind(reader) {
    const pages = reader.pages;
    if (!pages || bound.has(pages)) return;
    bound.add(pages);
    pages.trackpad = { cancel(reason) {
      if (reason === 'settled') {
        if (flight?.pages === pages) {
          counts.landings++; log('landed', { id: flight.id }); flight = null;
        }
        if (!active && !pending.length) idle(pages);
        // DOM commit follows finishAnimation synchronously; do not start earlier.
        queueMicrotask(drain);
      } else if (active?.pages === pages || flight?.pages === pages || pending.some(g => g.pages === pages)) {
        cancel(reason, false);
      }
    } };
    reader.scope.cleanup(() => { cancel('route-leave'); over = false; gate(); });
    publish(); gate();
  }
  const removeHook = ctx.hook('read', bind);
  if (ctx.reader) bind(ctx.reader);
  function draw(g, at) {
    g.progress = Math.max(0, Math.min(.98, g.distance / g.turnDistance));
    g.session?.update(g.progress, g.dy / g.height, at);
    const root = ctx.root.querySelector('.reader');
    if (root) {
      root.dataset.trackpadState = g.waiting ? 'queued' : 'tracking';
      root.dataset.trackpadProgress = g.progress.toFixed(3);
      root.dataset.trackpadQueue = String(pending.length);
    }
  }
  function start(x, y, at) {
    const pages = ctx.reader?.pages;
    if (!allowed(pages)) return;
    bind(pages.r);
    const direction = Math.sign(x), waiting = pages.animating || pending.length > 0;
    if (pending.length >= 8) { cancel('queue-overflow'); pages.r.status('翻页暂时繁忙，请重试'); return; }
    const session = waiting ? null : pages.beginTurn(direction, clientY);
    const leaf = document.querySelector('#article .page-leaf').getBoundingClientRect();
    const article = document.getElementById('article'), leaves = [...article.children];
    const gap = pages.count === 2 ? leaves[1].getBoundingClientRect().left - leaves[0].getBoundingClientRect().right : 0;
    const g = active = { id: ++serial, pages, direction, session, waiting,
      clientY, distance: direction * x, dy: -y, progress: 0, lastAt: at,
      turnDistance: session?.turnDistance || leaf.width * 2 + gap,
      height: session?.height || leaf.height, ended: false };
    if (waiting) pending.push(g); else if (session) flight = g;
    movement(g, direction * x, at); draw(g, at);
    log('began', { id: g.id, direction, waiting, boundary: !session && !waiting }); gate();
  }
  function release(g, forced = false, reason = 'native-ended') {
    if (g.ended) return;
    g.ended = true; g.complete = !forced && completes(g);
    if (active === g) active = null;
    counts.releases++;
    log('release', { id: g.id, complete: g.complete, progress: g.progress,
      reason, inputToSignalMs: performance.now() - g.lastAt });
    if (!g.waiting) {
      if (g.session) {
        flight = g;
        g.session.release(g.complete, reason, { inputAt: g.lastAt });
      } else {
        idle(g.pages);
        if (g.complete) Promise.resolve(g.pages.adjacent(g.direction)).catch(e => {
          if (!g.pages.r.scope.signal.aborted) g.pages.r.status(e.message);
        });
      }
    }
    provisional = { x: 0, y: 0, axis: null }; gate();
  }
  function receive(e) {
    if (!allowed() || (!over && !active)) return;
    const at = performance.now(), phase = +e.phase || 0, momentum = +e.momentum || 0;
    counts.events++;
    if (e.source === 'macOS-NSEvent') counts.physicalEvents++; else counts.fixtureEvents++;
    if (momentum) {
      counts.momentum++;
      if (active) release(active, false, 'native-momentum-transition');
      if (momentum & 8) publish();
      return;
    }
    if (phase & 32) return;
    if (phase & 1) {
      if (active) release(active, false, 'native-new-began');
      provisional = { x: 0, y: 0, axis: null };
    }
    const dx = +e.dx || 0, dy = +e.dy || 0;
    if (active && (dx || dy)) {
      const g = active;
      g.distance = Math.max(0, Math.min(g.turnDistance * .98, g.distance + g.direction * dx));
      g.dy -= dy; movement(g, g.direction * dx, at); draw(g, at);
    } else if (dx || dy) {
      provisional.x += dx; provisional.y += dy;
      if (!provisional.axis) {
        if (Math.abs(provisional.x) >= 12 && Math.abs(provisional.x) > Math.abs(provisional.y) * 1.35) provisional.axis = 'x';
        else if (Math.abs(provisional.y) >= 12 && Math.abs(provisional.y) > Math.abs(provisional.x) * 1.35) provisional.axis = 'y';
      }
      if (provisional.axis === 'x') start(provisional.x, provisional.y, at);
    }
    if (phase & 16) { if (active) release(active, true, 'native-cancelled'); }
    else if (phase & 8) {
      if (active) release(active);
      else provisional = { x: 0, y: 0, axis: null };
      publish();
    }
  }
  function drain() {
    const g = pending[0];
    if (!g || g.pages.animating) return;
    if (!allowed(g.pages)) { cancel('queued-interaction'); return; }
    pending.shift(); g.waiting = false;
    g.session = g.pages.beginTurn(g.direction, g.clientY);
    if (g.session) flight = g;
    draw(g, performance.now());
    if (g.ended) {
      if (g.session) g.session.release(g.complete, 'native-queued-ended', { inputAt: g.lastAt });
      else { idle(g.pages); if (g.complete) g.pages.adjacent(g.direction); }
    }
  }
  document.addEventListener('pointermove', e => {
    clientY = e.clientY; const next = inPaper(e.target);
    if (next !== over) { over = next; gate(); }
  }, options);
  document.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.buttons) { cancel('other-input'); return; }
    if (!inPaper(e.target) || !allowed()) { over = false; cancel('interaction-blocked'); return; }
    clientY = e.clientY; over = true; gate();
    // Only horizontal page input is owned. Vertical scrolling and word cards survive.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || active) {
      e.preventDefault();
      if (!connected || !monitorReady) ctx.reader?.status('触控板接入未就绪，可用鼠标翻页', { notice: true });
    }
  }, { ...options, capture: true, passive: false });
  document.addEventListener('pointerdown', () => cancel('pointer-interrupt'), { ...options, capture: true });
  document.addEventListener('pointerup', gate, options);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (active || flight || pending.length)) {
      e.preventDefault(); e.stopImmediatePropagation(); cancel('escape');
    }
  }, { ...options, capture: true });
  window.addEventListener('blur', () => { over = false; cancel('blur'); }, options);
  window.addEventListener('focus', gate, options);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { over = false; cancel('hidden'); } gate(); }, options);
  // A tool can open without moving the pointer: immediately gate native input.
  const observer = new MutationObserver(gate);
  observer.observe(ctx.root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden','data-chrome'] });
  async function connect(url) {
    if (stopped) return;
    socket = new WebSocket(url);
    socket.onopen = () => { connected = true; lastGate = undefined; gate(); };
    socket.onmessage = message => {
      let e; try { e = JSON.parse(message.data); } catch { return; }
      if (e.source === 'bridge-ready') { monitorReady = e.monitorReady === true; attempts = 0; gate(); }
      else if (e.source === 'bridge-overflow' || e.source === 'monitor-exited') { monitorReady = false; cancel(e.source); publish(); }
      else if (e.source === 'macOS-NSEvent' || e.source === 'e2e-phase-fixture') receive(e);
    };
    socket.onclose = () => {
      connected = monitorReady = false; cancel('bridge-disconnected'); publish();
      if (!stopped && attempts++ < 3) retry = setTimeout(async () => {
        try {
          const response = await fetch('/api/reading/native-trackpad', { cache: 'no-store', signal: controller.signal });
          const value = await response.json();
          if (value.available) connect(value.url);
        } catch { /* bounded reconnect; mouse and keyboard remain available */ }
      }, 1000 * attempts);
    };
    socket.onerror = () => { connected = false; publish(); };
  }
  connect(config.url);
  return () => { stopped = true; clearTimeout(retry); cancel('uninstall'); controller.abort(); removeHook(); observer.disconnect(); socket?.close(); };
}
