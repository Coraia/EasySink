"""Bounded OCR-box reading order; no inference, invented text, or model calls.

Only a unique, empty two-column gutter with dense prose is accepted. A small
side region remains an image. Any unresolved geometry returns None to retain
Omarchy's existing conservative regional fallback.
"""
from __future__ import annotations

import re
from statistics import median

POLICY = 'bounded_prose_columns_v2'
REGIONAL_POLICY = 'isolated_horizontal_prose_v1'
FORMULA = re.compile(r'[∑∫√≤≥≠±]|\\(?:frac|begin|sqrt)\b|\|[^|]+\|[^|]+\|')


def box(line):
    return line['source']['bbox']


def bounds(lines):
    boxes = [box(line) for line in lines]
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def uncovered_image_bands(image, lines, covered, width, height):
    """Locate substantial source pixels that OCR/image blocks do not represent.

    This is an object-preservation signal, never text recognition. Work on a
    bounded preview; mask individual OCR boxes, not their paragraph envelope.
    Full-width bands extend to surrounding text, preserving faint illustration
    edges/reflections that a contrast threshold alone would clip.
    """
    from PIL import ImageChops, ImageDraw, ImageFilter

    sx, sy = image.width / width, image.height / height
    gray = image.convert('L')
    residual = ImageChops.difference(gray, gray.filter(ImageFilter.GaussianBlur(16)))
    residual = residual.point(lambda value: 255 if value >= 6 else 0)
    draw = ImageDraw.Draw(residual)
    for line in lines:
        b = box(line); pad = (b[3] - b[1]) * .35
        # A blurred text edge extends beyond its OCR box. Mask two blur
        # radii as well, or those halos reconnect into false picture regions.
        px, py = max(pad * sx, 32), max(pad * sy, 32)
        draw.rectangle([b[0] * sx - px, b[1] * sy - py,
                        b[2] * sx + px, b[3] * sy + py], fill=0)
    for b in covered:
        draw.rectangle([b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy], fill=0)
    draw.rectangle([0, 0, image.width - 1, image.height - 1], outline=0, width=12)
    step, tiles = 16, set()
    for y in range(0, image.height, step):
        for x in range(0, image.width, step):
            tile = residual.crop((x, y, min(x + step, image.width), min(y + step, image.height)))
            if tile.histogram()[255] >= 12:
                tiles.add((x // step, y // step))
    bands = []
    while tiles:
        first = tiles.pop(); pending, component = [first], [first]
        while pending:
            x, y = pending.pop()
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1),
                           (-1, -1), (1, 1), (-1, 1), (1, -1)):
                neighbor = (x + dx, y + dy)
                if neighbor in tiles:
                    tiles.remove(neighbor); pending.append(neighbor); component.append(neighbor)
        x0, y0 = min(t[0] for t in component) * step, min(t[1] for t in component) * step
        x1, y1 = (max(t[0] for t in component) + 1) * step, (max(t[1] for t in component) + 1) * step
        if len(component) < 20 or x1 - x0 < image.width * .15 or y1 - y0 < image.height * .08:
            continue
        top, bottom = y0 / sy, min(height, y1 / sy)
        before = [box(line)[3] for line in lines if box(line)[3] < top]
        after = [box(line)[1] for line in lines if box(line)[1] > bottom]
        bands.append([max(0, max(before, default=0) - 2), min(height, min(after, default=height) + 2)])
    # Sparse illustrated pages often print their few text rows over a faint
    # photograph. OCR masks hide those picture edges, so a text-boundary crop
    # cannot safely separate them. Retain the composition alongside live text.
    if bands and len(lines) <= 16:
        return [[0, 0, width, height]]
    merged = []
    # Masking an OCR row can disconnect one illustration into two pieces.
    # Bridge at most that row plus its two masking margins, keeping the
    # original composition instead of cropping through a heading/grid.
    masked_row = 64 / sy + median(box(line)[3] - box(line)[1] for line in lines)
    for top, bottom in sorted(bands):
        if merged and top <= merged[-1][1] + masked_row:
            merged[-1][1] = max(merged[-1][1], bottom)
        else:
            merged.append([top, bottom])
    return [[0, top, width, bottom] for top, bottom in merged]


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


def recover_prose_regions(lines, width, height):
    """Recover detached prose from a page with uncertain objects.

    A local vertical label or detector ordering error does not invalidate text
    elsewhere. Do not infer table order, repair words, or crop an illustration
    to its OCR labels. Dense offset prose also retains the source image strips
    on both sides; accepting that text must not discard an adjacent photograph.
    """
    if not 1 <= len(lines) <= 240:
        return None
    rows = ordered(lines)
    marks = {}
    for mark in rows:
        a = box(mark)
        if len(mark['text']) > 3:
            continue
        neighbors = []
        for line in rows:
            b = box(line); h = b[3] - b[1]
            if (line is not mark and line.get('confidence', 0) >= .95 and
                    len(line['text']) >= 7 and any(c.isalpha() for c in line['text']) and
                    b[2] - b[0] > 3 * h and a[2] - a[0] < h and
                    a[3] - a[1] < .8 * h and abs(a[0] - b[2]) < .85 * h and
                    b[1] - .25 * h <= a[1] < a[3] <= b[3] + .15 * h):
                neighbors.append(line)
        if len(neighbors) == 1:
            marks.setdefault(neighbors[0]['id'], []).append(mark)
    rows = [line for line in rows if not any(line in attached for attached in marks.values())]
    caps = {}
    for cap in rows:
        c = box(cap)
        if cap.get('confidence', 0) < .98 or not re.fullmatch(r'[A-Z]', cap['text']):
            continue
        candidates = []
        for line in rows:
            b = box(line); h = b[3] - b[1]
            if (line['text'][:1].islower() and line.get('confidence', 0) >= .9 and
                    1.3 <= (c[3] - c[1]) / h <= 3 and c[0] < b[0] and
                    -.35 * h <= b[0] - c[2] <= .5 * h and
                    abs(c[1] - b[1]) <= .5 * h and c[3] > b[3] + .4 * h):
                candidates.append(line)
        if len(candidates) == 1 and candidates[0]['id'] not in caps:
            caps[candidates[0]['id']] = cap
    rows = [line for line in rows if line not in caps.values()]

    def horizontal(line):
        b = box(line)
        return (line.get('confidence', 0) >= .9 and
                b[2] - b[0] > 1.2 * (b[3] - b[1]) and
                not FORMULA.search(line['text']))

    def seed(line):
        b, text = box(line), line['text'].strip()
        return (horizontal(line) and b[0] < width * .2 and b[2] > width * .75
                and len(text) >= 45 and len(text.split()) >= 7)

    def offset_seed(line):
        b, text = box(line), line['text'].strip()
        return (horizontal(line) and line.get('confidence', 0) >= .95 and
                b[0] >= width * .2 and b[2] - b[0] >= width * .6 and
                len(text) >= 45 and len(text.split()) >= 7)

    # Only a separately recognized, geometrically attached capital is exempt.
    # Other conflicting rows stay images; modest adjacent-line overlap is normal.
    def isolated(line):
        b = box(line)
        for other in rows:
            if other is line:
                continue
            a = box(other)
            overlap = min(a[3], b[3]) - max(a[1], b[1])
            if overlap > min(a[3] - a[1], b[3] - b[1]) * .4:
                return False
        return True

    # Short sentence tails and bullets need not fill a line. Establish their
    # body lane from several independent full-width prose rows, then require
    # matching type size, indentation, proximity and no competing column.
    # Tiny attached glyphs above remain separate source images, even when the
    # recognizer confidently calls a closing quote a digit.
    body_seeds = [line for line in rows if seed(line) and isolated(line)
                  and line.get('confidence', 0) >= .95]
    body_height = median(box(line)[3] - box(line)[1] for line in body_seeds) if body_seeds else 0
    body_left = median(box(line)[0] for line in body_seeds) if body_seeds else 0

    def contextual(line):
        if len(body_seeds) < 3 or not horizontal(line) or not isolated(line):
            return False
        b, text = box(line), line['text'].strip()
        return (line.get('confidence', 0) >= .95 and len(text.split()) >= 2 and
                len(text) >= 7 and sum(c.isalpha() for c in text) >= len(text) * .5 and
                .7 * body_height <= b[3] - b[1] <= 1.5 * body_height and
                body_left - 1.5 * body_height <= b[0] <= body_left + 2 * body_height and
                b[0] < width * .2 and b[1] > height * .055 and
                any(max(box(other)[1] - b[3], b[1] - box(other)[3], 0) <= 6 * body_height
                    for other in body_seeds))

    runs, run = [], []
    for line in rows:
        b = box(line)
        compatible = False
        if run and horizontal(line) and isolated(line):
            last = box(run[-1]); h = last[3] - last[1]
            compatible = (.65 <= (b[3] - b[1]) / h <= 1.5 and
                          -.4 * h <= b[1] - last[3] <= 1.2 * h and
                          abs(b[0] - min(box(item)[0] for item in run)) <= 2 * h)
        if run and not compatible:
            runs.append(run); run = []
        if compatible or ((seed(line) or offset_seed(line) or contextual(line)) and isolated(line)):
            run.append(line)
    if run:
        runs.append(run)
    accepted = []
    for run in runs:
        seeds = sum(seed(line) for line in run)
        context_run = all(contextual(line) for line in run)
        offset = seeds == 0 and not context_run
        if offset:
            h = median(box(line)[3] - box(line)[1] for line in run)
            if (sum(offset_seed(line) for line in run) < 4 or not prose(run) or
                    any(line.get('confidence', 0) < .95 for line in run) or
                    max(box(line)[0] for line in run) - min(box(line)[0] for line in run) > .7 * h):
                continue
        elif seeds < 2 and not context_run and not (len(run) == 1 and len(run[0]['text']) >= 55
                             and re.search(r'[.!?:][”’"\']?$', run[0]['text'].strip())):
            continue
        top, bottom = bounds(run)[1::2]
        if any(line not in run and min(box(line)[3], bottom) - max(box(line)[1], top) >
               (box(line)[3] - box(line)[1]) * .4 for line in rows):
            continue
        accepted.append((run, offset))
    if not accepted:
        return None
    plan, cursor = [], 0
    for run, offset in accepted:
        cap = caps.get(run[0]['id'])
        left, top, right, bottom = bounds(run + ([cap] if cap else []))
        if top > cursor:
            plan.append(_segment('image', [l for l in rows if box(l)[1] < top and box(l)[3] > cursor],
                bbox=[0, cursor, width, top], reason='surrounding_layout_unverified'))
        if offset and left > 0:
            plan.append(_segment('image', [], bbox=[0, top, left, bottom],
                                 reason='beside_prose_unverified'))
        plan.append(_segment('text', run, role='offset_prose' if offset else 'isolated_prose', drop_cap=cap))
        if offset and right < width:
            plan.append(_segment('image', [], bbox=[right, top, width, bottom],
                                 reason='beside_prose_unverified'))
        for line in run:
            for mark in marks.get(line['id'], []):
                plan.append(_segment('image', [mark], reason='attached_glyph_unverified'))
        cursor = bottom
    if cursor < height:
        plan.append(_segment('image', [l for l in rows if box(l)[3] > cursor],
            bbox=[0, cursor, width, height], reason='surrounding_layout_unverified'))
    return plan


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
