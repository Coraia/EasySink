// URL ranges only affect assistance. Never normalize or shorten source text.
// Keep the boundary policy aligned with wise_reader/source_urls.py. These
// offsets are block-local UTF-16 positions, as used by the reader's anchors.
export function sourceUrlRanges(text) {
  const pattern = /(?<![A-Za-z0-9_])(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'“”‘’]+/gi;
  const continuation = /([ \t\r\n]+)([^\s<>"'“”‘’]+)/y;
  const closers = { ")": "(", "]": "[", "}": "{" };
  const ranges = [];
  let covered = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start < covered) continue;
    let end = start + match[0].length;
    while ("-/?&=#%_".includes(text[end - 1])) {
      continuation.lastIndex = end;
      const next = continuation.exec(text);
      if (!next || (next[1].match(/\n/g) || []).length > 1 ||
          /^(?:https?:\/\/|ftp:\/\/|www\.)/i.test(next[2]) || !/(?:^|[?&])[A-Za-z0-9_.~%+-]+=/.test(next[2])) break;
      end = continuation.lastIndex;
    }
    covered = end;
    while (end > start) {
      const last = text[end - 1], value = text.slice(start, end);
      if (".,;:!?".includes(last) ||
          (closers[last] && value.split(last).length > value.split(closers[last]).length)) end--;
      else break;
    }
    if (end > start) ranges.push({ start, end });
  }
  return ranges;
}

export function overlapsSourceUrl(ranges, start, end) {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].start < end) low = middle + 1;
    else high = middle;
  }
  return start < end && low > 0 && ranges[low - 1].end > start;
}

// The ranges must come from the entire block, even when text is a clipped
// annotation/page fragment. Every returned piece retains its source position.
export function sourceUrlParts(text, offset, ranges) {
  const parts = [], end = offset + text.length;
  let cursor = offset;
  const add = (start, stop, url) => {
    if (stop > start) parts.push({ text: text.slice(start - offset, stop - offset), start, end: stop, url });
  };
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= end) break;
    const start = Math.max(cursor, range.start), stop = Math.min(end, range.end);
    add(cursor, start, false);
    add(start, stop, true);
    cursor = stop;
  }
  add(cursor, end, false);
  return parts;
}
