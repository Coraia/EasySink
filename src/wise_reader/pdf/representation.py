"""Convert a bounded completed source range to canonical reader blocks."""

import hashlib
import json
import math

OBJECT = "\ufffc"


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


def build_representation(pages, book_id, source_sha256):
    blocks, text, position = [], [], 0
    for page in pages:
        if page.get("quality_state") == "rejected":
            continue
        for original in page["blocks"]:
            asset = original.get("asset_url")
            kind = original["type"]
            if asset:
                kind = "image_fallback" if kind == "image_fallback" else "image"
                value = OBJECT
            else:
                value = original.get("text", "").strip()
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
    canonical = "\n\n".join(text)
    revision = hashlib.sha256(json.dumps({"text": canonical, "blocks": blocks}, ensure_ascii=False,
        sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    for block in blocks:
        block["source"]["object_id"] = block["id"]
        block["source"]["revision"] = revision
        for item in block.get("inline_objects", []):
            item["source"]["object_id"] = block["id"]
            item["source"]["revision"] = revision
    return canonical, blocks, revision
