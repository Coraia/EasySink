"""URL source intervals for presentation; never rewrite text or token IDs.

Keep the boundary policy aligned with web/source-urls.js. Python offsets remain
code points here; the web helper computes UTF-16 offsets from its own source.
"""

from __future__ import annotations

from bisect import bisect_left
import re


_URL = re.compile(r"(?<![A-Za-z0-9_])(?:https?://|ftp://|www\.)[^\s<>\"'“”‘’]+", re.I)
_CONTINUATION = re.compile(r"([ \t\r\n]+)([^\s<>\"'“”‘’]+)")
_START = re.compile(r"^(?:https?://|ftp://|www\.)", re.I)
_CLOSERS = {')': '(', ']': '[', '}': '{'}


def url_ranges(text: str) -> list[tuple[int, int]]:
    """Find visible URLs, including an unambiguous PDF path continuation.

    `.../text- idx?c=...` is one interval, preserving its literal space. A bare
    following word is not enough evidence to extend a URL into adjacent prose.
    """
    ranges = []
    covered = 0
    for match in _URL.finditer(text):
        start, end = match.span()
        if start < covered:
            continue
        while text[end - 1] in '-/?&=#%_':
            continuation = _CONTINUATION.match(text, end)
            if continuation is None:
                break
            gap, tail = continuation.groups()
            if gap.count('\n') > 1 or _START.match(tail) or not re.search(r'(?:^|[?&])[A-Za-z0-9_.~%+-]+=', tail):
                break
            end = continuation.end()
        covered = end
        while end > start:
            last = text[end - 1]
            if last in '.,;:!?':
                end -= 1
            elif last in _CLOSERS and text.count(last, start, end) > text.count(_CLOSERS[last], start, end):
                end -= 1
            else:
                break
        if end > start:
            ranges.append((start, end))
    return ranges


def overlaps_url(ranges: list[tuple[int, int]], start: int, end: int) -> bool:
    """Check a half-open source range against sorted nonoverlapping URLs."""
    index = bisect_left(ranges, (end,)) - 1
    return start < end and index >= 0 and ranges[index][1] > start
