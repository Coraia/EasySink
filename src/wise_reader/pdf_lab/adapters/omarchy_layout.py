"""Bounded OCR-box reading order; no inference, invented text, or model calls.

Only a unique, empty two-column gutter with dense prose is accepted. A small
side region remains an image. Any unresolved geometry returns None to retain
Omarchy's existing conservative regional fallback.
"""
from __future__ import annotations

import re
from statistics import median

POLICY = 'bounded_prose_columns_v2'
FORMULA = re.compile(r'[∑∫√≤≥≠±]|\\(?:frac|begin|sqrt)\b|\|[^|]+\|[^|]+\|')


def box(line):
    return line['source']['bbox']


def bounds(lines):
    boxes = [box(line) for line in lines]
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def ordered(lines):
    return sorted(lines, key=lambda line: (box(line)[1], box(line)[0], line['id']))


def prose(lines, *, minimum=6):
    if len(lines) < minimum or any(FORMULA.search(line['text']) for line in lines):
        return False
    texts = [line['text'].strip() for line in lines]
    heights = [box(line)[3] - box(line)[1] for line in lines]
    lengths = [len(re.sub(r'\s+', '', text)) for text in texts]
    # Tables/catalogues have short, repetitive cells; accept only running prose.
    if median(lengths) < 10 or sum(bool(re.search(r'[，。；！？、,;.!?]', text)) for text in texts) < len(texts) * .3:
        return False
    if sum(bool(re.match(r'^[★☆●•]|^\d+[A-Z]\b', text)) for text in texts) > len(texts) * .15:
        return False
    rows = ordered(lines)
    h = median(heights)
    # Aligned complete sentences can be table cells. Require repeated actual
    # wraps (same left edge, no sentence ending), not just long OCR strings.
    wraps = sum(not re.search(r'[。！？.!?][”’\"\']?$', a['text'].strip()) and
                abs(box(b)[0] - box(a)[0]) <= h * .7
                for a, b in zip(rows, rows[1:]))
    if wraps < 3:
        return False
    gaps = [box(b)[1] - box(a)[3] for a, b in zip(rows, rows[1:])]
    return sum(-.4 * h <= gap <= 1.5 * h for gap in gaps) >= len(gaps) * .8


def _segment(kind, lines, **extra):
    return {'kind': kind, 'lines': ordered(lines), **extra}


def recover_layout(lines, width, height):
    # A physically detached running header is not part of a sidebar. Preserve
    # its lines independently, never discard it or merge its bounding image
    # with a distant callout. Titles below this narrow top strip stay in body.
    if not lines or any(FORMULA.search(line['text']) for line in lines):
        return None
    h = median(box(line)[3] - box(line)[1] for line in lines)
    header = [line for line in lines if box(line)[3] <= height * .085]
    body = [line for line in lines if line not in header]
    if (header and body and min(box(line)[1] for line in body) -
            max(box(line)[3] for line in header) >= h * .7):
        result = _recover_body(body, width, height)
        if result:
            return [_segment('text', header, role='running_header')] + result
        return None
    return _recover_body(lines, width, height)


def _recover_body(lines, width, height):
    """Return disjoint, source-preserving segments or None (not proven safe).

    Geometry was already validated by the caller. Work is capped so malicious
    dense OCR pages cannot add unbounded pair/candidate work.
    """
    if not 6 <= len(lines) <= 240 or any(FORMULA.search(line['text']) for line in lines):
        return None
    h = median(box(line)[3] - box(line)[1] for line in lines)
    edge = [line for line in lines if len(line['text'].strip()) <= 2 and
            box(line)[2] - box(line)[0] < width * .04 and
            (box(line)[2] < width * .035 or box(line)[0] > width * .965)]
    body = [line for line in lines if line not in edge]
    # Physical edge noise must be separated from the entire body by a wide gap.
    if edge and (len(body) < 6 or any(
        min(abs(box(e)[2] - box(b)[0]), abs(box(b)[2] - box(e)[0])) < width * .07
        for e in edge for b in body)):
        edge = []; body = list(lines)
    candidates = set()
    for i, a in enumerate(body):
        ab = box(a)
        for b in body[i + 1:]:
            bb = box(b)
            if min(ab[3], bb[3]) - max(ab[1], bb[1]) < h * .45:
                continue
            left, right = (ab, bb) if ab[0] < bb[0] else (bb, ab)
            if right[0] - left[2] > h * .15:
                candidates.add(round((left[2] + right[0]) / 2, 2))
    if len(candidates) > 100:
        return None
    plans = {}
    for split in sorted(candidates):
        left = [line for line in body if box(line)[2] <= split]
        right = [line for line in body if box(line)[0] >= split]
        if min(len(left), len(right)) < 3:
            continue
        # Running headers are independent from the body columns. A spanning
        # line delimits the candidate band, never gets sliced or reordered.
        overlap_top = max(min(box(l)[1] for l in left), min(box(l)[1] for l in right))
        overlap_bottom = min(max(box(l)[3] for l in left), max(box(l)[3] for l in right))
        bridge = [line for line in body if line not in left and line not in right]
        cross = [line for line in bridge if box(line)[1] < overlap_bottom and box(line)[3] > overlap_top]
        if cross:
            # Use the largest span bounded by full-width lines. This admits
            # wrapped sidebars without assuming the whole page has two columns.
            cuts = sorted([0, height] + [v for line in bridge for v in (box(line)[1], box(line)[3])])
            spans = [(a, b) for a, b in zip(cuts, cuts[1:]) if b-a >= h*3]
        else:
            spans = [(max([box(l)[3] for l in bridge if box(l)[3] <= overlap_top] or [0]),
                      min([box(l)[1] for l in bridge if box(l)[1] >= overlap_bottom] or [height]))]
        for top, bottom in spans:
            ls = [l for l in left if box(l)[1] >= top and box(l)[3] <= bottom]
            rs = [l for l in right if box(l)[1] >= top and box(l)[3] <= bottom]
            if min(len(ls), len(rs)) < 3:
                continue
            lb, rb = bounds(ls), bounds(rs)
            if rb[0] - lb[2] <= h*.15 or min(lb[3],rb[3])-max(lb[1],rb[1]) < h*2:
                continue
            region = ls + rs
            if any(l not in region and box(l)[1] < max(lb[3],rb[3]) and box(l)[3] > min(lb[1],rb[1]) for l in body):
                continue
            mode = None
            if prose(ls) and prose(rs) and min(lb[2]-lb[0],rb[2]-rb[0]) >= .55*max(lb[2]-lb[0],rb[2]-rb[0]):
                mode = 'columns'
            elif prose(ls) and len(rs) <= 8 and rb[2]-rb[0] <= (lb[2]-lb[0])*.6 and rb[3]-rb[1] < height*.3:
                mode = 'right_sidebar'
            elif prose(rs) and len(ls) <= 8 and lb[2]-lb[0] <= (rb[2]-rb[0])*.6 and lb[3]-lb[1] < height*.3:
                mode = 'left_sidebar'
            if mode:
                signature = (mode, tuple(sorted(l['id'] for l in region)))
                plans[signature] = (mode, ls, rs)
    # Multiple unrelated viable zones are not silently flattened.
    if len(plans) != 1:
        if edge and not plans:
            return [_segment('text', body), _segment('image', edge, reason='detached_edge_region_unverified')]
        return None
    mode, left, right = next(iter(plans.values()))
    chosen = left + right
    y0, y1 = min(box(l)[1] for l in chosen), max(box(l)[3] for l in chosen)
    before = [l for l in body if box(l)[3] <= y0 and l not in chosen]
    after = [l for l in body if box(l)[1] >= y1 and l not in chosen]
    if len(before) + len(after) + len(chosen) != len(body):
        return None
    if mode == 'columns':
        plan = [_segment('text', before), _segment('text', left, role='column_left'),
                _segment('text', right, role='column_right'), _segment('text', after)]
    else:
        # Keep continuation through the first post-sidebar paragraph boundary
        # before placing the image, rather than interrupting a wrapped sentence.
        main, sidebar = (left, right) if mode == 'right_sidebar' else (right, left)
        continuation = []
        for line in ordered(after):
            b = box(line)
            if continuation and (b[0] > min(box(l)[0] for l in before + main) + 1.1*h or
                                 b[1] - box(continuation[-1])[3] > h*.6):
                break
            continuation.append(line)
        plan = [_segment('text', before + main + continuation, role='body_around_sidebar'),
                _segment('image', sidebar, reason='sidebar_reading_order_unverified'),
                _segment('text', [l for l in after if l not in continuation])]
    if edge:
        plan.append(_segment('image', edge, reason='detached_edge_region_unverified'))
    return [segment for segment in plan if segment['lines']]
