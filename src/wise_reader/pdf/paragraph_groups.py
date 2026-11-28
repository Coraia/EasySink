"""Conservative reading-prose projection; retain every source object separately."""
import math
import re
from statistics import median

from .text_normalization import source_lines

POLICY = 'adjacent-source-pages-continuation-v1'


def _box(block):
    value = block.get('source', {}).get('bbox')
    if (not isinstance(value, list) or len(value) != 4 or
            any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in value)):
        return None
    return value if 0 <= value[0] < value[2] and 0 <= value[1] < value[3] else None


def _plain(block):
    return (block.get('type') == 'paragraph' and not block.get('asset') and
            not block.get('asset_url') and not block.get('inline_objects') and _box(block))


def _margin_objects(page):
    height = page.get('height', 0)
    if not height or not page.get('width'):
        return ()
    objects = [*page['blocks'], *page.get('non_content_objects', [])]
    boxes = [(obj, box) for obj in objects if (box := _box(obj))]
    sizes = [size for obj, box in boxes
             if height * .075 < box[1] < height * .89 and _plain(obj)
             and (size := _line_height(source_lines(obj)))]
    body_size = median(sizes) if sizes else 0
    result = []
    for obj, box in boxes:
        text = ' '.join(obj.get('text', '').casefold().split())
        size = box[3] - box[1]
        if not text or obj.get('asset') or obj.get('asset_url') or size > height * .04:
            continue
        side = 'header' if box[3] < height * .075 else 'footer' if box[1] > height * .89 else None
        if side and all(max(box[1] - other[3], other[1] - box[3]) >= size * .65
                        for item, other in boxes if item is not obj):
            result.append((obj, side, text, box, body_size))
    return result


def _furniture(pages):
    by_number = {p['page_number']: p for p in pages}
    candidates = {n: _margin_objects(p) for n, p in by_number.items()}
    result = {}
    for n, objects in candidates.items():
        page = by_number[n]
        peers = [(other, by_number[other], item) for other in range(n - 2, n + 3)
                 if other != n and other in by_number and _same_layout(page, by_number[other])
                 for item in candidates[other]]
        for obj, side, text, box, body_size in objects:
            matching = [(other, item[2]) for other, other_page, item in peers if item[1] == side
                        and abs(box[0] / page['width'] - item[3][0] / other_page['width']) <= .045
                        and abs(box[1] / page['height'] - item[3][1] / other_page['height']) <= .025]
            hint = obj.get('role')
            numeric = re.fullmatch(r'[0-9]{1,5}', text)
            numbers = numeric and any(re.fullmatch(r'[0-9]{1,5}', t) and int(t) - int(text) == other - n
                                      for other, t in matching)
            repeats = [other for other, t in matching if t == text]
            if side == 'footer' and numbers:
                result[id(obj)] = ('printed-page-label', 'detached-margin+consecutive-label')
            elif side == 'footer' and hint == 'printed_page_label' and (numeric or re.fullmatch(r'[ivxlcdm]{1,8}', text)):
                result[id(obj)] = ('printed-page-label', 'detached-margin+engine-label')
            elif repeats and not numeric:
                pattern = 'alternating-pages' if all((other - n) % 2 == 0 for other in repeats) else 'adjacent-pages'
                result[id(obj)] = (side, 'detached-margin+recurring-text+' + pattern)
            elif hint in {'running_title', 'running_furniture'} and obj.get('type') == 'page_' + side:
                result[id(obj)] = (side, 'detached-margin+engine-label')
            elif side == 'footer' and (obj['type'] == 'footnote' or
                    body_size and box[3] - box[1] < .92 * body_size and
                    re.match(r'^(?:\d+[.)]|\[\d+\])\s+\S', text)):
                result[id(obj)] = ('footnote', 'detached-margin+footnote-label-or-marker')
    return result


def _same_layout(a, b):
    return (a.get('source_sha256') and a.get('source_sha256') == b.get('source_sha256') and
            a.get('rotation', 0) == b.get('rotation', 0) and
            a.get('crop_box') == b.get('crop_box') and
            all(a.get(k, 0) > 0 and b.get(k, 0) > 0 and
                abs(a[k] - b[k]) <= a[k] * .02 for k in ['width', 'height']))


def _line_height(lines):
    values = [box[3] - box[1] for line in lines if (box := _box({'source': line}))]
    return median(values) if values else None


def _possible_end(page, block):
    box = _plain(block)
    text = block.get('text', '').strip()
    return (box and box[3] >= page['height'] * .78 and len(text) >= 80 and
        len(text.split()) >= 12 and source_lines(block) and re.search(r'(?:[a-z]-?|,)$', text))


def _possible_start(page, block):
    box = _plain(block)
    text = block.get('text', '').strip()
    return (box and box[1] <= page['height'] * .20 and len(text) >= 25 and
        len(text.split()) >= 5 and source_lines(block) and re.match(r'^[a-z]', text))


def _continuation(a, b, left, right):
    if (b['page_number'] != a['page_number'] + 1 or not _same_layout(a, b)
            or not _possible_end(a, left) or not _possible_start(b, right)):
        return False
    before, after = left.get('text', '').strip(), right.get('text', '').strip()
    marker = r'^(?:[•●▪◦]|\d{1,3}[.)]\s|\[\d+\]|[A-Z][.)]\s|[IVX]+\.\s)'
    if re.match(marker, before) or re.match(marker, after):
        return False
    x, y = _box(left), _box(right)
    lines, right_lines = source_lines(left), source_lines(right)
    lh, rh = _line_height(lines), _line_height(right_lines)
    if not lh or not rh or not .75 <= lh / rh <= 1.35:
        return False
    body_left = min((line['bbox'][0] for line in lines), default=x[0])
    first = right_lines[0]['bbox']
    return (x[3] >= a['height'] * .78 and y[1] <= b['height'] * .20 and
            abs(x[0] / a['width'] - y[0] / b['width']) <= .025 and
            abs(first[0] - body_left) <= max(lh, rh) * .65)


def paragraph_projection(pages, page_count, overrides):
    """Return confirmed furniture and source-ID groups, never mutate pages."""
    pages = [p for p in pages if p.get('quality_state') != 'rejected']
    confirmed = _furniture(pages)
    for page in pages:
        for obj in [*page['blocks'], *page['non_content_objects']]:
            action = overrides.get((page['page_number'], page.get('conversion_task_id'), obj['id']))
            if action == 'body':
                confirmed.pop(id(obj), None)
            elif action == 'outside':
                confirmed[id(obj)] = ('excluded', 'manual')
    body = {p['page_number']: [v for v in p['blocks'] if id(v) not in confirmed] for p in pages}
    links, possible = [], {}
    for a, b in zip(pages, pages[1:]):
        left = body[a['page_number']]
        right = body[b['page_number']]
        if left and right and _continuation(a, b, left[-1], right[0]):
            pair = ['pdf-' + left[-1]['id'], 'pdf-' + right[0]['id']]
            if links and links[-1][-1] == pair[0]:
                links[-1].append(pair[1])
            else:
                links.append(pair)
    for page in pages:
        n = page['page_number']
        if not body[n]:
            continue
        for offset, edge, check in ((-1, body[n][0], _possible_start), (1, body[n][-1], _possible_end)):
            if 1 <= n + offset <= page_count and check(page, edge):
                possible.setdefault('pdf-' + edge['id'], []).append(n + offset)
    return confirmed, links, possible


def apply_paragraph_groups(blocks, groups):
    indexes = {block['id']: i for i, block in enumerate(blocks)}
    for members in groups:
        if len(members) < 2:
            continue
        positions = [indexes.get(member) for member in members]
        if (any(i is None for i in positions) or positions != sorted(positions) or
                any(not blocks[i].get('pdf_role') and blocks[i]['id'] not in members
                    for i in range(positions[0], positions[-1] + 1)) or
                any(blocks[i]['type'] != 'paragraph' or blocks[i].get('asset_url') for i in positions)):
            continue
        metadata = {'id': 'paragraph-' + members[0], 'blocks': members, 'policy': POLICY}
        for i in positions:
            blocks[i]['paragraph_group'] = metadata
