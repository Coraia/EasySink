import { movement, completes } from "./reading-gesture-policy.js";

// App-owned phases; ordinary source DOM retains word selection and notes.
export function installNativeReadingTrackpad(ctx, config = {}) {
  const controller = new AbortController(), options = { signal: controller.signal };
  const desktop = config.desktop === true && window.wiseReaderDesktop?.nativeTrackpad === true;
  let socket, connected = desktop, monitorReady = desktop, stopped = false, attempts = 0, retry, handshake;
  let needsBegan = desktop;
  let discovering = false, lastDiscovery = -Infinity;
  let over = false, clientY = innerHeight * .55, active = null, flight = null, serial = 0;
  let provisional = { x: 0, y: 0, axis: null }, lastGate;
  const pending = [], records = [], bound = new WeakSet();
  const counts = { events: 0, physicalEvents: 0, fixtureEvents: 0, domEvents: 0, momentum: 0, releases: 0, landings: 0 };
  function publish() {
    const root = ctx.root.querySelector('.reader');
    if (!root) return;
    root.dataset.trackpadMode = connected && monitorReady ? 'native' : 'native-unavailable';
    root.dataset.trackpadTransport = desktop ? 'desktop-dom' : 'browser-websocket';
    root.dataset.nativeTrackpad = JSON.stringify(counts);
    root.dataset.nativeGestures = JSON.stringify(records);
  }
  function log(kind, extra = {}, update = true) {
    records.push({ at: performance.now(), kind, doc: ctx.reader?.doc.id,
      page: ctx.reader?.pages?.index, ...extra });
    if (records.length > 256) records.shift();
    if (update) publish();
  }
  function allowed(pages = ctx.reader?.pages) {
    return Boolean(pages && ctx.reader === pages.r && pages.canGrab(true) &&
      !pages.r.scope.signal.aborted && document.hasFocus() && !document.hidden &&
      !document.activeElement?.closest('input,textarea,select,[contenteditable]'));
  }
  function inPaper(target, horizontal = false) {
    if (!(target instanceof Element)) return false;
    const card = target.closest('.annotation-pop');
    if (card) {
      // A word card is scrollable assistance, not a modal. Keep vertical card
      // scrolling, but let a deliberate horizontal gesture turn the paper.
      return horizontal && !target.closest('a,button,input,textarea,select,[contenteditable]');
    }
    if (!target.closest('#reading-stage')) return false;
    return !target.closest('a,input,textarea,select,[contenteditable],#reading-selection,#translation-pane,.inline-grammar,#tool-panel,#reader-chrome') &&
      (!target.closest('button') || Boolean(target.closest('.reading-edge-grip')));
  }
  function gate() {
    if ((active || flight || pending.length) && !allowed()) { cancel('interaction-blocked'); return; }
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
    if (desktop) needsBegan = true;
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
      if (reason === 'route-leave' && reader.rangeHandoff) return;
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
    }, handoff(nextReader) {
      bind(nextReader);
      for (const g of new Set([...pending, active, flight].filter(Boolean))) {
        if (g.pages === pages) g.pages = nextReader.pages;
      }
      log('range-handoff', { from: reader.doc.id, to: nextReader.doc.id, queued: pending.length });
      gate();
    } };
    reader.scope.cleanup(() => {
      if (reader.rangeHandoff) return;
      cancel('route-leave'); over = false; gate();
    });
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
    const g = active = { id: ++serial, pages, direction, session, waiting, wasQueued: waiting,
      clientY, distance: direction * x, dy: -y, progress: 0, lastAt: at,
      turnDistance: session?.turnDistance || leaf.width * 2 + gap,
      height: session?.height || leaf.height, ended: false };
    if (waiting) pending.push(g); else if (session) flight = g;
    movement(g, direction * x, at); draw(g, at);
    log('began', { id: g.id, direction, waiting, boundary: !session && !waiting }); gate();
    if (waiting && flight?.ended) flight.session?.handoffRelease?.();
  }
  function release(g, forced = false, reason = 'native-ended') {
    if (g.ended) return;
    if (g.wasQueued && reason === 'native-ended') reason = 'native-queued-ended';
    g.ended = true; g.complete = !forced && completes(g);
    if (active === g) active = null;
    counts.releases++;
    log('release', { id: g.id, complete: g.complete, progress: g.progress,
      reason, inputToSignalMs: performance.now() - g.lastAt });
    if (!g.waiting) {
      if (g.session) {
        flight = g;
        if (g.complete) g.session.prefetchNext?.();
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
  function receive(e, transport = 'browser-websocket') {
    if (!allowed() || (!over && !active)) return;
    const at = performance.now(), phase = +e.phase || 0, momentum = +e.momentum || 0;
    counts.events++;
    // A source string in a CustomEvent is forgeable, including events dispatched
    // by WKWebView.evaluateJavaScript. DOM delivery is never physical evidence.
    if (transport === 'desktop-dom') counts.domEvents++;
    else if (e.source === 'macOS-NSEvent') counts.physicalEvents++;
    else counts.fixtureEvents++;
    if (transport === 'desktop-dom') log('phase', { transport, source: e.source, phase, momentum, dx: e.dx, dy: e.dy,
      nativeTime: e.nativeTime, sequence: e.sequence, clientX: e.clientX, clientY: e.clientY }, false);
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
    // Stationary contact can last indefinitely. Only native terminal phases
    // below may release; no timer guesses when a finger has lifted.
    if (phase & 2) return;
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
    if (phase & 16) {
      if (active) release(active, true, 'native-cancelled');
      provisional = { x: 0, y: 0, axis: null };
    }
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
      if (g.session) {
        if (g.complete) g.session.prefetchNext?.();
        g.session.release(g.complete, 'native-queued-ended', { inputAt: g.lastAt });
      }
      else { idle(g.pages); if (g.complete) g.pages.adjacent(g.direction); }
    }
  }
  function receiveDesktop(event) {
    const e = event.detail;
    if (stopped || !e || typeof e !== 'object') return;
    if (e.source === 'desktop-detached') {
      connected = monitorReady = false; over = false; cancel('desktop-detached'); return;
    }
    if (e.source === 'desktop-ready') {
      connected = monitorReady = window.wiseReaderDesktop?.nativeTrackpad === true;
      cancel('desktop-reattached'); return;
    }
    if (e.source === 'desktop-interrupted') { over = false; cancel(e.reason || 'desktop-interrupted'); return; }
    if (e.source !== 'macOS-NSEvent' || !connected || !monitorReady) return;
    if (![e.phase, e.momentum, e.dx, e.dy, e.clientX, e.clientY].every(Number.isFinite) ||
        !Number.isInteger(e.phase) || e.phase < 0 || e.phase > 63 ||
        !Number.isInteger(e.momentum) || e.momentum < 0 || e.momentum > 63 ||
        !(e.phase || e.momentum)) return;
    const horizontal = Boolean(active) || Math.abs(e.dx) > Math.abs(e.dy);
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.buttons || !allowed() ||
        !inPaper(document.elementFromPoint(e.clientX, e.clientY), horizontal)) {
      over = false; cancel('desktop-interaction-blocked'); return;
    }
    clientY = e.clientY; over = true;
    if (e.phase & 1) needsBegan = false;
    if (needsBegan && !e.momentum) return;
    receive(e, 'desktop-dom');
    if ((e.phase & (8 | 16)) || e.momentum) needsBegan = true;
  }
  if (desktop) window.addEventListener('wise-reader-native-trackpad', receiveDesktop, options);
  document.addEventListener('pointermove', e => {
    clientY = e.clientY; const next = inPaper(e.target);
    if (next !== over) { over = next; gate(); }
  }, options);
  document.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.buttons) { cancel('other-input'); return; }
    const horizontal = Boolean(active) || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (!inPaper(e.target, horizontal) || !allowed()) { over = false; cancel('interaction-blocked'); return; }
    clientY = e.clientY; over = true; gate();
    // Only horizontal page input is owned. Vertical scrolling and word cards survive.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || active) {
      e.preventDefault();
      if (!connected || !monitorReady) ctx.reader?.status('触控板接入未就绪，可用鼠标翻页', { notice: true });
    }
  }, { ...options, capture: true, passive: false });
  document.addEventListener('pointerdown', () => cancel('pointer-interrupt'), { ...options, capture: true });
  document.addEventListener('pointerup', gate, options);
  document.addEventListener('selectionchange', gate, options);
  document.addEventListener('focusin', gate, options);
  window.visualViewport?.addEventListener('resize', () => cancel('viewport-zoom'), options);
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
  function scheduleReconnect() {
    if (desktop || stopped || retry || discovering || (connected && monitorReady)) return;
    // A bridge restart may outlast the first discovery attempt. Keep one bounded
    // backoff loop for this installation, including unavailable/failed discovery.
    const delay = Math.min(15000, 1000 * 2 ** Math.min(attempts++, 4));
    retry = setTimeout(() => { retry = null; discover(); }, delay);
  }
  async function discover() {
    if (desktop || stopped || discovering || (socket && socket.readyState !== WebSocket.CLOSED)) return;
    discovering = true; lastDiscovery = performance.now();
    try {
      const response = await fetch('/api/reading/native-trackpad', { cache: 'no-store', signal: controller.signal });
      const value = response.ok ? await response.json() : null;
      if (!stopped && value?.available && typeof value.url === 'string') connect(value.url);
    } catch { /* A temporary outage must not terminate recovery. */ }
    finally {
      discovering = false;
      if (!socket || socket.readyState === WebSocket.CLOSED) scheduleReconnect();
    }
  }
  function recoverOnReturn() {
    if (desktop || stopped || document.hidden || (connected && monitorReady) ||
        (socket && socket.readyState !== WebSocket.CLOSED) || performance.now() - lastDiscovery < 1000) return;
    clearTimeout(retry); retry = null; discover();
  }
  window.addEventListener('focus', recoverOnReturn, options);
  window.addEventListener('online', recoverOnReturn, options);
  document.addEventListener('visibilitychange', recoverOnReturn, options);
  function connect(url) {
    if (stopped) return;
    const current = socket = new WebSocket(url);
    // Do not leave an open but unacknowledged connection looking usable.
    handshake = setTimeout(() => { if (socket === current && !monitorReady) current.close(); }, 4000);
    current.onopen = () => { if (socket !== current || stopped) return; connected = true; lastGate = undefined; gate(); };
    current.onmessage = message => {
      if (socket !== current || stopped) return;
      let e; try { e = JSON.parse(message.data); } catch { return; }
      if (e.source === 'bridge-ready') {
        monitorReady = e.monitorReady === true;
        if (monitorReady) { attempts = 0; clearTimeout(handshake); }
        gate();
      }
      else if (e.source === 'bridge-overflow' || e.source === 'monitor-exited') {
        monitorReady = false; cancel(e.source); publish(); current.close();
      }
      else if (e.source === 'macOS-NSEvent' || e.source === 'e2e-phase-fixture') receive(e);
    };
    current.onclose = () => {
      if (socket !== current) return;
      clearTimeout(handshake);
      connected = monitorReady = false; cancel('bridge-disconnected'); publish();
      scheduleReconnect();
    };
    current.onerror = () => { if (socket === current) { connected = false; publish(); } };
  }
  if (!desktop) connect(config.url);
  return () => { stopped = true; clearTimeout(retry); clearTimeout(handshake); cancel('uninstall'); controller.abort(); removeHook(); observer.disconnect(); socket?.close(); };
}
