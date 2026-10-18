import { installReadingTrackpad as installWheel } from "./reading-wheel.js";
import { installNativeReadingTrackpad } from "./reading-native-trackpad.js?v=20261018-page-turn-latency-selection";

// Native stages on supported local Macs; legacy wheel is explicitly compatibility.
export function installReadingTrackpad(ctx) {
  // The host injects this at documentStart, before application modules load.
  // Desktop phases do not depend on the optional browser WebSocket service.
  if (window.wiseReaderDesktop?.nativeTrackpad === true) {
    return installNativeReadingTrackpad(ctx, { desktop: true });
  }
  let disposed = false, remove, config = null;
  const mode = r => { if (r?.scope.signal.aborted) return;
    const root = ctx.root.querySelector('.reader');
    if (root) root.dataset.trackpadMode = config?.available ? 'native-connecting' : 'wheel-compatibility';
  };
  const hook = ctx.hook('read', mode);
  fetch('/api/reading/native-trackpad', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : { available: false })
    .catch(() => ({ available: false }))
    .then(value => {
      if (disposed) return;
      config = value; mode(ctx.reader);
      remove = value.available ? installNativeReadingTrackpad(ctx, value) : installWheel(ctx);
    });
  return () => { disposed = true; remove?.(); hook(); };
}
