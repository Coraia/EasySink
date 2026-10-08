/*
 * Outline targets can be external, missing, malformed, outside the CropBox, or
 * expressed in rotated PDF coordinates. Never turn an unknown target into page 1.
 * A ready range can contain holes; only an actual block proves its page is ready.
 * Compact reading blocks have no glyph coordinates: ambiguous columns, stale
 * geometry and an unnamed position inside a long paragraph must fall back to the
 * original page. Reader anchors retain the actual block source, never a guessed
 * character offset or the outline's synthetic highlight rectangle.
 */

const GEOMETRY_EPSILON = 0.75;
const NEAR_TOP = 48;
const finite = Number.isFinite;
const sameBook = (a, b) => a != null && b != null && String(a) === String(b);

function failure(message) {
  throw new Error(message);
}

function checkedPoint(point, width, height) {
  if (
    !Array.isArray(point) || point.length !== 2 || !point.every(finite) ||
    point[0] < -GEOMETRY_EPSILON || point[1] < -GEOMETRY_EPSILON ||
    point[0] > width + GEOMETRY_EPSILON || point[1] > height + GEOMETRY_EPSILON
  ) failure("这个目录目标超出原页可见区域，暂无法可靠定位。");
  return [Math.max(0, Math.min(width, point[0])), Math.max(0, Math.min(height, point[1]))];
}

function visibleBand(value, limit) {
  const size = Math.min(6, limit);
  const low = Math.max(0, Math.min(limit - size, value - size / 2));
  return [low, low + size];
}

/** Resolve one user-selected outline item, without scanning any other page. */
export async function resolveOutlineTarget(pdfDocument, item, metadata) {
  if (!item || item.url || item.unsafeUrl || item.action || item.attachment)
    failure("这个目录项目指向外部内容或不支持的动作，无法在本书中定位。");
  let dest = item.dest;
  if (typeof dest === "string") {
    if (!dest.length) failure("这个目录项目没有有效的目标名称。");
    try { dest = await pdfDocument.getDestination(dest); }
    catch { failure("这个目录项目的命名目标无法读取，暂不能可靠定位。"); }
  }
  if (!Array.isArray(dest) || dest.length < 2)
    failure("这个目录项目的目标未找到，暂无法可靠定位。");

  const ref = dest[0];
  let index;
  if (Number.isSafeInteger(ref) && ref >= 0) index = ref;
  else if (ref && typeof ref === "object" && Number.isSafeInteger(ref.num) && ref.num > 0 &&
    Number.isSafeInteger(ref.gen) && ref.gen >= 0) {
    try { index = await pdfDocument.getPageIndex(ref); }
    catch { failure("这个目录项目的原页引用无法读取，暂不能可靠定位。"); }
  }
  else failure("这个目录项目的原页引用无效。");
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(pdfDocument.numPages) ||
    index >= pdfDocument.numPages) failure("这个目录项目的原页超出本书范围。");

  const mode = dest[1]?.name;
  const args = dest.slice(2);
  const validLength = mode === "XYZ" ? args.length >= 2 && args.length <= 3 :
    ["Fit", "FitB"].includes(mode) ? args.length === 0 :
    ["FitH", "FitBH", "FitV", "FitBV"].includes(mode) ? args.length <= 1 :
    mode === "FitR" ? args.length === 4 : false;
  if (!validLength || !args.every(value => finite(value) || (mode !== "FitR" && value === null)))
    failure("这个目录项目的定位方式或坐标暂不支持。");
  if (mode === "XYZ" && args[2] != null && args[2] < 0)
    failure("这个目录项目的缩放参数无效。");
  if (!metadata || metadata.book_id == null || !metadata.source_sha256)
    failure("当前原件身份暂不可用，无法可靠定位目录。");

  let page;
  try { page = await pdfDocument.getPage(index + 1); }
  catch { failure("这个目录目标的原页暂时无法读取。"); }
  const viewport = page.getViewport({ scale: 1 });
  const width = viewport.width, height = viewport.height;
  const box = page.view;
  if (![width, height].every(value => finite(value) && value > 0) ||
    !Array.isArray(box) || box.length !== 4 || !box.every(finite) ||
    box[0] >= box[2] || box[1] >= box[3] || ![0, 90, 180, 270].includes(page.rotate))
    failure("这个目录目标的原页几何信息暂不可用。");
  const source = {
    page_number: index + 1,
    book_id: metadata.book_id,
    source_sha256: metadata.source_sha256,
    coordinate_space: "rotated_crop_top_left",
    width, height, rotation: page.rotate, crop_box: [...box],
  };
  const target = { page_number: index + 1, source, kind: "page", x: null, y: null };
  const point = (x, y) => checkedPoint(viewport.convertToViewportPoint(x, y), width, height);
  if (mode === "Fit" || mode === "FitB") return target;

  if (mode === "FitR") {
    const [left, bottom, right, top] = args;
    if (left >= right || bottom >= top) failure("这个目录项目的目标区域无效。");
    const points = [point(left, bottom), point(left, top), point(right, bottom), point(right, top)];
    const region = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
      Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
    if (region[2] <= region[0] || region[3] <= region[1]) failure("这个目录项目的目标区域为空。");
    return { ...target, kind: "region", x: region[0], y: region[1], region,
      source: { ...source, bbox: [...region] } };
  }

  let rawX = null, rawY = null;
  if (mode === "XYZ") [rawX, rawY] = args;
  else if (mode === "FitH" || mode === "FitBH") rawY = args[0] ?? null;
  else rawX = args[0] ?? null;
  if (rawX == null && rawY == null) return { ...target, kind: "point" };
  if (rawX != null && rawY != null) [target.x, target.y] = point(rawX, rawY);
  else {
    const a = point(rawX ?? box[0], rawY ?? box[1]);
    const b = point(rawX ?? box[2], rawY ?? box[3]);
    // A known PDF y becomes viewport x after a quarter turn; preserve that
    // uncertainty rather than pretending that it is a vertical reading target.
    if (Math.abs(a[0] - b[0]) < 0.001) target.x = (a[0] + b[0]) / 2;
    else if (Math.abs(a[1] - b[1]) < 0.001) target.y = (a[1] + b[1]) / 2;
    else failure("这个目录目标的坐标方向暂无法可靠对应。");
  }
  const horizontal = target.x == null ? [0, width] : visibleBand(target.x, width);
  const vertical = target.y == null ? [0, height] : visibleBand(target.y, height);
  target.kind = "point";
  target.source.bbox = [horizontal[0], vertical[0], horizontal[1], vertical[1]];
  return target;
}

function matchingGeometry(source, target) {
  const expected = target.source;
  return source?.coordinate_space === "rotated_crop_top_left" &&
    expected?.coordinate_space === source.coordinate_space &&
    ["width", "height"].every(key => finite(source[key]) && source[key] > 0 &&
      finite(expected[key]) && Math.abs(source[key] - expected[key]) <= GEOMETRY_EPSILON) &&
    source.rotation === expected.rotation &&
    Array.isArray(source.crop_box) && Array.isArray(expected.crop_box) &&
    source.crop_box.length === 4 && expected.crop_box.length === 4 &&
    source.crop_box.every((value, index) => finite(value) &&
      Math.abs(value - expected.crop_box[index]) <= GEOMETRY_EPSILON) &&
    Array.isArray(source.bbox) && source.bbox.length === 4 && source.bbox.every(finite) &&
    source.bbox[0] >= -GEOMETRY_EPSILON && source.bbox[1] >= -GEOMETRY_EPSILON &&
    source.bbox[2] <= source.width + GEOMETRY_EPSILON &&
    source.bbox[3] <= source.height + GEOMETRY_EPSILON &&
    source.bbox[2] > source.bbox[0] && source.bbox[3] > source.bbox[1];
}

function anchor(doc, block, offset = 0) {
  const text = typeof block.text === "string" ? block.text : "";
  const image = Boolean(block.asset_url && ["image", "image_fallback", "formula", "table"].includes(block.type));
  return {
    version: doc.version, block_id: block.id, start: offset, end: offset,
    quote: "", prefix: text.slice(Math.max(0, offset - 40), offset),
    suffix: text.slice(offset, offset + 40), ratio: 0, kind: image ? "image" : "text",
    pdf_source: { ...block.source, book_id: doc.pdf.book_id, source_sha256: doc.pdf.source_sha256,
      ...(image ? { asset_url: block.asset_url } : {}) },
  };
}

/** Return a standard Reader anchor only when this source position is reliable. */
export function readingAnchorForTarget(doc, target, title = "") {
  if (!doc?.pdf || !target || !sameBook(doc.pdf.book_id, target.source?.book_id) ||
    !doc.pdf.source_sha256 || doc.pdf.source_sha256 !== target.source?.source_sha256 ||
    !Number.isInteger(target.page_number) || target.page_number < 1 ||
    target.source.page_number !== target.page_number) return null;
  const blocks = (doc.blocks || []).filter(block => block.source?.page_number === target.page_number &&
    sameBook(block.source.book_id, doc.pdf.book_id) &&
    block.source.source_sha256 === doc.pdf.source_sha256);
  if (!blocks.length) return null;
  // A source-page directory does not need another PDF.js request just to reach
  // its first already-published block.
  if (target.kind === "page") return anchor(doc, blocks[0]);
  if (!finite(target.y) || (target.x != null && !finite(target.x))) return null;
  if (target.kind !== "point" && target.kind !== "region") return null;
  const region = target.kind === "region" ? target.region : null;
  if (target.kind === "region" && (!Array.isArray(region) || region.length !== 4 ||
    !region.every(finite) || region[0] >= region[2] || region[1] >= region[3])) return null;
  const nearby = blocks.filter(block => {
    if (!matchingGeometry(block.source, target)) return false;
    const [left, top, right, bottom] = block.source.bbox;
    if (region) return right > region[0] && left < region[2] && bottom > region[1] && top < region[3];
    if (top > target.y + NEAR_TOP || bottom < target.y - 8) return false;
    return target.x == null || (target.x >= left - NEAR_TOP && target.x <= right + NEAR_TOP);
  });
  if (!nearby.length) return null;

  const needle = typeof title === "string" ? title.trim() : "";
  if (needle) {
    const matches = blocks.flatMap(block => {
      const text = typeof block.text === "string" ? block.text : "";
      const start = text.indexOf(needle);
      if (start < 0) return [];
      return [{ block, start, unique: text.indexOf(needle, start + 1) < 0 }];
    });
    if (matches.length === 1 && matches[0].unique && nearby.includes(matches[0].block))
      return anchor(doc, matches[0].block, matches[0].start);
  }

  if (nearby.some(block => {
    const [left, top, right, bottom] = block.source.bbox;
    const horizontallyInside = region ? right > region[0] && left < region[2] :
      target.x == null || (target.x >= left && target.x <= right);
    return horizontallyInside && bottom - top > NEAR_TOP &&
      target.y > top + 12 && target.y < bottom;
  })) return null;

  const candidates = nearby.filter(block => {
    const [, top, , bottom] = block.source.bbox;
    if (Math.abs(top - target.y) > NEAR_TOP) return false;
    // A point well inside a long paragraph has no reliable text offset.
    return target.y <= top + 12 || bottom - top <= NEAR_TOP;
  });
  if (!candidates.length) return null;
  const horizontalDistance = block => {
    if (target.x == null || region) return 0;
    const [left, , right] = block.source.bbox;
    return Math.max(left - target.x, target.x - right, 0);
  };
  candidates.sort((a, b) => horizontalDistance(a) - horizontalDistance(b) ||
    Math.abs(a.source.bbox[1] - target.y) - Math.abs(b.source.bbox[1] - target.y));
  const best = candidates[0], box = best.source.bbox;
  const ambiguous = candidates.slice(1).some(block => {
    const other = block.source.bbox;
    if (Math.abs(horizontalDistance(block) - horizontalDistance(best)) > 1) return false;
    const sameLine = Math.abs(other[1] - box[1]) <= 24;
    const differentColumns = other[2] < box[0] - 4 || other[0] > box[2] + 4;
    const sameStart = Math.abs(other[1] - box[1]) <= GEOMETRY_EPSILON;
    return (sameLine && differentColumns) || sameStart;
  });
  return ambiguous ? null : anchor(doc, best);
}
