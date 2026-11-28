"""Convert a bounded completed source range to canonical reader blocks."""

import hashlib
import json
import math
import re

from .text_normalization import normalize_block
from .paragraph_groups import apply_paragraph_groups, paragraph_projection

OBJECT = "\ufffc"
NOTE_MARKER = re.compile(r"^(?:([0-9]+)[.)]|\[([0-9]+)\])\s")


def link_footnotes(blocks):
    notes, references = {}, {}
    for block in blocks:
        if block['type'] == 'footnote':
            if match := NOTE_MARKER.match(block['text']):
                notes.setdefault(match[1] or match[2], []).append(block)
        for style in block.get('inline_styles', []):
            marker = block['text'][style['start']:style['end']]
            if style['kind'] == 'sup' and re.fullmatch(r"[0-9]+", marker):
                offset = len(block['text'][:style['start']].encode('utf-16-le')) // 2
                references.setdefault(marker, []).append((block, offset))
    for marker, found in notes.items():
        refs = references.get(marker, ())
        if len(found) == len(refs) == 1:
            note, (body, offset) = found[0], refs[0]
            note['footnote_reference'] = {'id': body['id'], 'start': offset}
            body.setdefault('footnote_links', []).append({'id': note['id'], 'marker': marker})


def inline_objects(original, value, source):
    """Preserve one source character per image; recognition never rewrites it."""
    raw = original.get("text", "")
    trim = len(raw) - len(raw.lstrip())
    result, occupied = [], set()
    for item in original.get("inline_objects", []):
        start, end = item.get("start"), item.get("end")
        if type(start) is not int or type(end) is not int:
            raise ValueError("Inline formula is missing its source offsets.")
        start, end = start - trim, end - trim
        if not (0 <= start < end <= len(value) and end == start + 1
                and value[start:end] == OBJECT and start not in occupied):
            raise ValueError("Inline formula no longer matches its source character.")
        asset = item.get("asset_url")
        box = item.get("source", {}).get("bbox")
        if (not isinstance(asset, str) or not asset or not item.get("formula_id")
                or not isinstance(box, list) or len(box) != 4
                or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
                or not (box[0] < box[2] and box[1] < box[3])):
            raise ValueError("Inline formula source asset is unavailable.")
        occupied.add(start)
        font = item.get("font_size_pt", 10)
        if not isinstance(font, (int, float)) or not math.isfinite(font) or font <= 0:
            font = 10
        result.append({"start": start, "end": end, "asset_url": asset,
            "formula_id": item["formula_id"], "font_size_pt": font,
            "width": item.get("width") or box[2] - box[0],
            "height": item.get("height") or box[3] - box[1],
            "source": {**source, "bbox": box, "asset_url": asset}})
    return result


def build_representation(pages, book_id, source_sha256, scope=None, page_count=None, overrides=None):
    blocks, text, position = [], [], 0
    overrides = overrides or {}
    classified = []
    for raw_page in pages:
        page = {**raw_page, 'blocks': list(raw_page['blocks']), 'non_content_objects': []}
        for index, original in enumerate(raw_page.get('non_content_objects', [])):
            key = original.get('id', f"p{page['page_number']:06d}-margin-{index}")
            item = {**original, 'id': key}
            if overrides.get((page['page_number'], page.get('conversion_task_id'), key)) == 'body':
                item['type'] = 'paragraph'
                box = item['source']['bbox']
                index = next((i for i, b in enumerate(page['blocks']) if b['source']['bbox'][1] > box[1]), len(page['blocks']))
                page['blocks'].insert(index, item)
            else:
                page['non_content_objects'].append(item)
        classified.append(page)
    pages = classified
    furniture, paragraph_groups, possible = paragraph_projection(pages,
        page_count or (pages[-1]['page_number'] if pages else 0), overrides)
    published = {p['page_number'] for p in pages if p.get('quality_state') != 'rejected'}
    task_ids = {'pdf-' + original['id']: page.get('conversion_task_id')
                for page in pages for original in page['blocks']}
    for page in pages:
        if (page.get("quality_state") == "rejected" or
                scope and not scope[0] <= page['page_number'] <= scope[1]):
            continue
        first = len(blocks)
        margin = []
        non_content = page.get('non_content_objects', [])
        has_prose = any(id(block) not in furniture or furniture[id(block)][0] == 'footnote'
                        for block in page['blocks'])
        for index, original in enumerate([*page['blocks'], *non_content]):
            if not (role := furniture.get(id(original))) or role[0] == 'footnote':
                continue
            key = original.get('id', f"p{page['page_number']:06d}-margin-{index - len(page['blocks'])}")
            item_id = f"pdf-{key}"
            margin.append({'id': item_id, 'role': role[0], 'text': original['text'], 'evidence': role[1],
                'pdf_prose_override': overrides.get((page['page_number'], page.get('conversion_task_id'), key)),
                'source': {'page_number': page['page_number'], 'bbox': original['source']['bbox'],
                    'coordinate_space': page.get('coordinate_space'), 'width': page['width'], 'height': page['height'],
                    'rotation': page.get('rotation', 0), 'crop_box': page.get('crop_box'),
                    'book_id': book_id, 'source_sha256': source_sha256,
                    'conversion_task_id': page.get('conversion_task_id', ''), 'object_id': item_id}})
        for original in page["blocks"]:
            role = furniture.get(id(original))
            if role and role[0] != 'footnote' and has_prose:
                continue
            normalization = None
            asset = original.get("asset_url")
            kind = original["type"]
            if asset:
                kind = "image_fallback" if kind == "image_fallback" else "image"
                value = OBJECT
            else:
                value, normalization = normalize_block(original, page)
                if not value:
                    continue
                kind = {"list": "list-item", "table": "table-row"}.get(kind, kind)
            if text:
                position += 2
            source = {"page_number": original["source"]["page_number"], "bbox": original["source"]["bbox"],
                "width": page["width"], "height": page["height"],
                "coordinate_space": page.get("coordinate_space"), "rotation": page.get("rotation", 0),
                "crop_box": page.get("crop_box"), "book_id": book_id, "source_sha256": source_sha256}
            if page.get("conversion_task_id"):
                source["conversion_task_id"] = page["conversion_task_id"]
            block = {"id": f"pdf-{original['id']}", "type": kind, "text": value,
                     "start": position, "end": position + len(value), "source": source,
                     "source_page": page["page_number"], "quality_state": page.get("quality_state", "candidate")}
            if action := overrides.get((page['page_number'], page.get('conversion_task_id'), original['id'])):
                block['pdf_prose_override'] = action
            if role:
                block['pdf_role'], block['pdf_role_evidence'] = role
                if role[0] == 'footnote':
                    block['type'] = 'footnote'
            if edges := possible.get(block['id']):
                block['pdf_prose_waits'] = [p for p in edges if p not in published]
                block['pdf_prose_neighbors'] = edges
            if normalization:
                block["normalization"] = normalization
            if original.get("formula_id"):
                block["formula_id"] = original["formula_id"]
                block["source_type"] = "formula"
            if not asset and original.get("inline_objects"):
                block["inline_objects"] = inline_objects(original, value, source)
            if not asset and isinstance(original.get("inline_styles"), list):
                # The adapter uses Unicode codepoint offsets. Keep these separate
                # from source anchors; the reader converts them to DOM UTF-16.
                raw = original.get("text", "")
                trim = len(raw) - len(raw.lstrip())
                styles = []
                for span in original["inline_styles"]:
                    if (not isinstance(span, dict) or not isinstance(span.get("kind"), str)
                            or span["kind"] not in {"sup", "sub"}
                            or type(span.get("start")) is not int
                            or type(span.get("end")) is not int):
                        continue
                    begin, end = max(0, span["start"] - trim), min(len(value), span["end"] - trim)
                    if begin < end:
                        styles.append({"start": begin, "end": end, "kind": span["kind"]})
                if styles:
                    block["inline_styles"] = styles
            if asset:
                if original.get("source_type") in {"image", "chart", "table"}:
                    block["source_type"] = original["source_type"]
                x0, y0, x1, y1 = source["bbox"]
                source["asset_url"] = asset
                block.update(asset_url=asset, width=max(1, x1 - x0), height=max(1, y1 - y0),
                    caption=original.get("caption", ""), fallback_reason=original.get("fallback_reason"))
            blocks.append(block)
            text.append(value)
            position = block["end"]
        if margin and len(blocks) > first:
            block_ids = {b['id'] for b in blocks[first:]}
            kept = [item for item in margin if item['id'] not in block_ids]
            if kept:
                blocks[first]['page_furniture'] = kept
        link_footnotes(blocks[first:])
    by_id = {block['id']: block for block in blocks}
    for group in paragraph_groups:
        for index, block_id in enumerate(group):
            if block_id in by_id:
                block = by_id[block_id]
                if index and group[index - 1] not in by_id:
                    edge = group[index - 1]
                    block['pdf_prose_previous'] = [edge, task_ids[edge]]
                if index + 1 < len(group) and group[index + 1] not in by_id:
                    edge = group[index + 1]
                    block['pdf_prose_next'] = [edge, task_ids[edge]]
    apply_paragraph_groups(blocks, [[id for id in group if id in by_id] for group in paragraph_groups])
    canonical = "\n\n".join(text)
    revision = hashlib.sha256(json.dumps({"text": canonical, "blocks": blocks}, ensure_ascii=False,
        sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    for block in blocks:
        block["source"]["object_id"] = block["id"]
        block["source"]["revision"] = revision
        for item in block.get('page_furniture', []):
            item['source']['revision'] = revision
        for item in block.get("inline_objects", []):
            item["source"]["object_id"] = block["id"]
            item["source"]["revision"] = revision
    return canonical, blocks, revision
