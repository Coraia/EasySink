"""Conservative reading-prose projection; retain every source object separately."""
import math
import re
from statistics import median

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


def _label(page):
    width, height = page.get('width', 0), page.get('height', 0)
    if width <= 0 or height <= 0 or len(page.get('blocks', [])) > 256:
        return None
    candidates = []
    for block in page['blocks']:
        text, box = block.get('text', '').strip(), _box(block)
        if (not _plain(block) or not re.fullmatch(r'[0-9]{1,5}', text) or
                box[1] < height * .90 or box[3] > height or
                box[2] - box[0] > width * .12 or box[3] - box[1] > height * .04):
            continue
        others = [b for b in page['blocks'] if b is not block and _box(b)]
        prose = [b for b in others if _plain(b) and sum(c.isalpha() for c in b.get('text', '')) >= 40]
        if (not prose or not others or
                box[1] - max(_box(b)[3] for b in others) < height * .012):
            continue
        candidates.append((block, int(text)))
    return candidates[0] if len(candidates) == 1 else None


def _same_pages(a, b):
    return (b.get('page_number') == a.get('page_number', -2) + 1 and
            a.get('conversion_task_id') and a.get('conversion_task_id') == b.get('conversion_task_id') and
            a.get('source_sha256') and a.get('source_sha256') == b.get('source_sha256') and
            a.get('rotation', 0) == b.get('rotation', 0) and
            a.get('crop_box') == b.get('crop_box') and
            all(a.get(k, 0) > 0 and b.get(k, 0) > 0 and
                abs(a[k] - b[k]) <= a[k] * .02 for k in ['width', 'height']))


def _line_height(block):
    values = [line['bbox'][3] - line['bbox'][1] for line in block.get('source', {}).get('lines', [])
              if isinstance(line.get('bbox'), list) and len(line['bbox']) == 4 and line['bbox'][3] > line['bbox'][1]]
    return median(values) if values else None


def _continuation(a, b, left, right):
    if not _same_pages(a, b) or not _plain(left) or not _plain(right):
        return False
    before, after = left.get('text', '').strip(), right.get('text', '').strip()
    marker = r'^(?:[•●▪◦]|\d{1,3}[.)]\s|\[\d+\]|[A-Z][.)]\s|[IVX]+\.\s)'
    if (len(before) < 80 or len(before.split()) < 12 or len(after) < 25 or len(after.split()) < 5 or
            not re.match(r'^[a-z]', after) or re.match(marker, before) or re.match(marker, after) or
            re.search(r'[.!?;:][\s"\')\]”’]*$', before) or not re.search(r'[a-z,]$', before)):
        return False
    x, y = _box(left), _box(right)
    lh, rh = _line_height(left), _line_height(right)
    if not lh or not rh or not .75 <= lh / rh <= 1.35:
        return False
    lines = left.get('source', {}).get('lines', [])
    body_left = min((line['bbox'][0] for line in lines), default=x[0])
    first = right.get('source', {}).get('lines', [{}])[0].get('bbox', y)
    return (x[3] >= a['height'] * .78 and y[1] <= b['height'] * .20 and
            abs(x[0] / a['width'] - y[0] / b['width']) <= .025 and
            abs(first[0] - body_left) <= max(lh, rh) * .65)


def paragraph_projection(pages):
    """Return confirmed furniture and source-ID groups, never mutate pages."""
    pages = [p for p in pages if p.get('quality_state') != 'rejected']
    labels = {p['page_number']: _label(p) for p in pages}
    confirmed = {}
    for a, b in zip(pages, pages[1:]):
        left, right = labels[a['page_number']], labels[b['page_number']]
        if not left or not right or not _same_pages(a, b):
            continue
        lb, rb = _box(left[0]), _box(right[0])
        if (right[1] == left[1] + 1 and
                abs((lb[0] + lb[2]) / (2 * a['width']) - (rb[0] + rb[2]) / (2 * b['width'])) <= .035 and
                abs(lb[1] / a['height'] - rb[1] / b['height']) <= .02):
            confirmed[a['page_number']] = left[0]
            confirmed[b['page_number']] = right[0]
    links = []
    for a, b in zip(pages, pages[1:]):
        left = [v for v in a['blocks'] if v is not confirmed.get(a['page_number'])]
        right = [v for v in b['blocks'] if v is not confirmed.get(b['page_number'])]
        if left and right and _continuation(a, b, left[-1], right[0]):
            pair = ['pdf-' + left[-1]['id'], 'pdf-' + right[0]['id']]
            if links and links[-1][-1] == pair[0]:
                links[-1].append(pair[1])
            else:
                links.append(pair)
    return confirmed, links


def apply_paragraph_groups(blocks, groups):
    indexes = {block['id']: i for i, block in enumerate(blocks)}
    for members in groups:
        positions = [indexes.get(member) for member in members]
        if (any(i is None for i in positions) or
                positions != list(range(positions[0], positions[0] + len(members))) or
                any(blocks[i]['type'] != 'paragraph' or blocks[i].get('asset_url') for i in positions)):
            continue
        metadata = {'id': 'paragraph-' + members[0], 'blocks': members, 'policy': POLICY}
        for i in positions:
            blocks[i]['paragraph_group'] = metadata
