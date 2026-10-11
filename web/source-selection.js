// Source coordinates stay local to each block; joined quotes are display/AI text.
export const anchorSegments = (anchor) =>
  anchor ? (anchor.segments?.length ? anchor.segments : [anchor]) : [];

// Excerpts are UI labels; stored source quotes retain their exact object offsets.
export const sourceExcerpt = (text) => String(text ?? "").replaceAll("\uFFFC", "〔原式〕");

export function combineSelection(parts, base = parts[0]) {
  if (!parts.length) return null;
  const clean = parts.map(({ segments, ...part }) => part);
  return { ...base, ...clean[0], version: base.version || clean[0].version, quote: clean.map(p => p.quote).join("\n\n"),
    segments: clean.length > 1 ? clean : [] };
}

export function sameSelection(a, b) {
  if (!a || !b || a.version !== b.version) return false;
  const left = anchorSegments(a), right = anchorSegments(b);
  return left.length === right.length && left.every((p, i) =>
    p.block_id === right[i].block_id && p.start === right[i].start && p.end === right[i].end);
}

// A saved highlight is one record: a selection wholly inside it addresses the
// whole record. Compare source blocks and versions, never matching quote text.
export function containsSelection(outer, inner) {
  if (!outer || !inner || outer.kind === "image" || inner.kind === "image" ||
      outer.version !== inner.version) return false;
  const saved = anchorSegments(outer), selected = anchorSegments(inner);
  return selected.length > 0 && selected.every(part =>
    Number.isInteger(part.start) && Number.isInteger(part.end) && part.end > part.start &&
    saved.some(range => range.block_id === part.block_id &&
      range.start <= part.start && range.end >= part.end));
}

export const linkedRanges = (anchor, ranges) => ranges.flatMap(range =>
  (range.ranges || [range]).map(part => ({ ...part, block_id: part.block_id || anchor.block_id })));

export function rangeAnchor(anchor, range) {
  return combineSelection(linkedRanges(anchor, [range]), { ...anchor, segments: [] });
}
