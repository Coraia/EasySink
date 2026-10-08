"""Convert a bounded completed source range to canonical reader blocks."""

import hashlib
import json

OBJECT = "\ufffc"


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
            if asset:
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
    return canonical, blocks, revision
