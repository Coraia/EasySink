// Coordinates are in the original, intrinsically rotated CropBox viewport.
// Display zoom / additional rotation never change the authorized source area.
export function attachRegionPicker(sheet, scope, geometry, onSelect) {
  const { width, height, rotation = 0, page_number } = geometry;
  let active = false, drag = null, box = null;
  const overlay = document.createElement("div");
  overlay.className = "pdf-region-selection";
  overlay.hidden = true;
  sheet.append(overlay);
  const clamp = (v, high) => Math.max(0, Math.min(high, v));
  const sourcePoint = (event) => {
    const r = sheet.getBoundingClientRect();
    const dx = clamp((event.clientX - r.left) / r.width, 1);
    const dy = clamp((event.clientY - r.top) / r.height, 1);
    if (rotation === 90) return [dy * width, (1 - dx) * height];
    if (rotation === 180) return [(1 - dx) * width, (1 - dy) * height];
    if (rotation === 270) return [(1 - dy) * width, dx * height];
    return [dx * width, dy * height];
  };
  const displayPoint = (x, y) => rotation === 90 ? [1 - y / height, x / width]
    : rotation === 180 ? [1 - x / width, 1 - y / height]
    : rotation === 270 ? [y / height, 1 - x / width]
    : [x / width, y / height];
  const paint = () => {
    overlay.hidden = !box;
    if (!box) return;
    const a = displayPoint(box[0], box[1]), b = displayPoint(box[2], box[3]);
    Object.assign(overlay.style, { left: `${Math.min(a[0], b[0]) * 100}%`,
      top: `${Math.min(a[1], b[1]) * 100}%`, width: `${Math.abs(a[0] - b[0]) * 100}%`,
      height: `${Math.abs(a[1] - b[1]) * 100}%` });
  };
  const setActive = (value) => {
    active = value;
    sheet.classList.toggle("pdf-region-picking", active);
  };
  const releaseDrag = () => {
    const id = drag?.id;
    drag = null;
    if (id !== undefined && sheet.hasPointerCapture(id)) sheet.releasePointerCapture(id);
  };
  const finish = (event, cancelled = false) => {
    if (!drag || event.pointerId !== drag.id) return;
    const id = drag.id;
    drag = null;
    if (sheet.hasPointerCapture(id)) sheet.releasePointerCapture(id);
    if (cancelled || !box || box[2] - box[0] < 4 || box[3] - box[1] < 4) box = null;
    paint();
    setActive(false);
    onSelect(box ? { page_number, bbox: box.map((n) => Math.round(n * 100) / 100),
      width, height, coordinate_space: "rotated_crop_top_left" } : null);
  };
  scope.on(sheet, "pointerdown", (event) => {
    if (!active || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    drag = { id: event.pointerId, point: sourcePoint(event) };
    box = null;
    paint();
    sheet.setPointerCapture(event.pointerId);
  });
  scope.on(sheet, "pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const a = drag.point, b = sourcePoint(event);
    box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    paint();
  });
  scope.on(sheet, "pointerup", (event) => finish(event));
  scope.on(sheet, "pointercancel", (event) => finish(event, true));
  scope.on(sheet, "lostpointercapture", (event) => finish(event, true));
  scope.cleanup(() => {
    releaseDrag(); overlay.remove(); setActive(false);
  });
  return { activate: () => { releaseDrag(); box = null; paint(); setActive(true); },
    clear: () => { releaseDrag(); box = null; paint(); setActive(false); onSelect(null); },
    get active() { return active; } };
}
