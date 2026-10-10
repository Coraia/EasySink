import { e } from "./core.js";

// Presentation metadata only: never inserts/removes source characters or changes
// selection offsets. Adapter ranges are Unicode codepoints; DOM uses UTF-16.
export function pdfInlineStyles(block) {
  if (!Array.isArray(block.inline_styles)) return [];
  const offsets = [0];
  for (const char of block.text) offsets.push(offsets.at(-1) + char.length);
  const ranges = block.inline_styles
    .filter(s => s && ["sup", "sub"].includes(s.kind) && Number.isInteger(s.start) &&
      Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end < offsets.length)
    .map(s => ({start: offsets[s.start], end: offsets[s.end], kind: s.kind}))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  // Malformed overlapping styles must not duplicate source text.
  let end = -1;
  return ranges.filter(s => {
    if (s.start < end) return false;
    end = s.end; return true;
  });
}

// Formula assets must be registered to this book, never an external image/path.
export function pdfAssetURL(value, book) {
  if (typeof value !== "string" || book == null) return null;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && !url.username && !url.password &&
      url.pathname.startsWith(`/api/pdf/books/${encodeURIComponent(book)}/assets/`)
      ? url.href : null;
  } catch { return null; }
}

const positive = (value) => Number.isFinite(value) && value > 0 ? value : null;

export function pdfInlineObjects(block, book) {
  const chars = Array.from(block.text || ""), objects = new Map();
  for (const item of Array.isArray(block.inline_objects) ? block.inline_objects : []) {
    if (!item || !Number.isInteger(item.start) || item.end !== item.start + 1 ||
        chars[item.start] !== "\uFFFC" || objects.has(item.start)) continue;
    // An invalid cross-book entry remains a visible source-view fallback.
    if (item.source?.book_id != null && String(item.source.book_id) !== String(book)) continue;
    objects.set(item.start, item);
  }
  let offset = 0;
  const result = [];
  chars.forEach((char, index) => {
    if (char === "\uFFFC") {
      const item = objects.get(index) || {}, source = item.source || block.source || {};
      const box = source.bbox;
      const font = positive(item.font_size_pt) || positive(block.font_size_pt) || 10;
      const width = positive(item.width) || positive(box?.[2] - box?.[0]) || font;
      const height = positive(item.height) || positive(box?.[3] - box?.[1]) || font;
      result.push({ ...item, source, start: offset, end: offset + 1, width, height,
        widthEm: width / font, heightEm: height / font,
        asset_url: pdfAssetURL(item.asset_url, book), block_id: block.id });
    }
    offset += char.length;
  });
  return result;
}

function inlineObjectMarkup(item) {
  const width = Number(item.widthEm.toFixed(4)), height = Number(item.heightEm.toFixed(4));
  // Only this hidden text node represents the object in the source. No labels,
  // fallback text or formula output may add to TreeWalker/Range text offsets.
  const image = item.asset_url
    ? `<img src="${e(item.asset_url)}" alt="" aria-hidden="true" width="${Math.ceil(item.width * 3)}" height="${Math.ceil(item.height * 3)}" data-pdf-width-em="${width}" data-pdf-height-em="${height}" style="aspect-ratio:${item.width}/${item.height}" draggable="false" decoding="async">`
    : "";
  return `<span class="source-unit pdf-inline-formula${image ? "" : " pdf-inline-missing"}" role="button" tabindex="0" data-pdf-inline="${item.start}" data-source-block="${e(item.block_id)}" data-source-start="${item.start}" data-source-end="${item.end}" aria-label="${image ? "查看原式" : "原式预览暂不可用，核对原版"}" style="width:${image ? width : 1}em"><span class="pdf-inline-anchor" aria-hidden="true">\uFFFC</span>${image}</span>`;
}

function renderStyles(text, offset, styles, render) {
  const end = offset + text.length;
  let cursor = offset, html = "";
  for (const span of styles) {
    const a = Math.max(offset, span.start), z = Math.min(end, span.end);
    if (a >= z) continue;
    if (a > cursor) html += render(text.slice(cursor - offset, a - offset), cursor);
    html += `<${span.kind} class="pdf-inline-script">${render(text.slice(a - offset, z - offset), a)}</${span.kind}>`;
    cursor = z;
  }
  return html + render(text.slice(cursor - offset), cursor);
}

export function renderPdfInline(text, offset, styles, render, objects = []) {
  const end = offset + text.length;
  let cursor = offset, html = "";
  for (const item of objects) {
    if (item.start < offset || item.end > end) continue;
    html += renderStyles(text.slice(cursor - offset, item.start - offset), cursor, styles, render);
    html += inlineObjectMarkup(item);
    cursor = item.end;
  }
  return html + renderStyles(text.slice(cursor - offset), cursor, styles, render);
}
