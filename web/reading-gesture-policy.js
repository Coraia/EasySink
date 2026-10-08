// The prototype shares intent and release policy across mouse and trackpad.
export function movement(g, delta, now) {
  g.velocity = delta / Math.max(1, now - (g.lastAt || now));
  const sign = Math.sign(delta);
  if (sign) {
    g.intentDistance =
      sign === g.intentSign
        ? (g.intentDistance || 0) + Math.abs(delta)
        : Math.abs(delta);
    g.intentSign = sign;
    if (g.intentDistance >= 3) g.reversing = sign < 0;
  }
  g.lastAt = now;
}
export function completes(g, tap = false) {
  const age = Math.max(0, performance.now() - (g.lastAt || 0));
  const velocity = (g.velocity || 0) * Math.exp(-age / 120);
  return (
    tap ||
    (!g.reversing &&
      (g.progress > 0.28 || (g.progress > 0.05 && velocity > 0.55)))
  );
}
