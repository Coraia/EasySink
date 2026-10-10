"""Bounded, isolated PDF rasterizer; no model, network or user credentials."""
from __future__ import annotations

import hashlib
from contextlib import closing
import json
import math
from pathlib import Path
import sys

MAX_PIXELS = 6_000_000
MAX_BYTES = 12 * 1024**2


def render(source, number, region, destination):
    import pypdfium2 as pdfium

    before = Path(source).stat()
    signature = [before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns]
    sha = hashlib.sha256()
    with Path(source).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024**2), b''):
            sha.update(chunk)
    with pdfium.PdfDocument(source) as pdf:
        if not 1 <= number <= len(pdf):
            raise ValueError('page_out_of_range')
        with closing(pdf[number - 1]) as page:
            width, height = page.get_size()
            if not all(math.isfinite(v) and v > 0 for v in (width, height)):
                raise ValueError('invalid_geometry')
            box = region if region is not None else [0, 0, width, height]
            if (not isinstance(box, list) or len(box) != 4
                    or any(type(v) not in (float, int) or not math.isfinite(v) for v in box)
                    or not (0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height)):
                raise ValueError('invalid_region')
            area = (box[2] - box[0]) * (box[3] - box[1])
            if area < 1:
                raise ValueError('region_too_small')
            scale = min(2.0, ((MAX_PIXELS - 20_000) / area) ** .5)
            crop = (box[0], height - box[3], width - box[2], box[1])
            with closing(page.render(scale=scale, crop=crop, limit_image_cache=True)) as bitmap:
                image = bitmap.to_pil()
                if image.width * image.height > MAX_PIXELS:
                    raise ValueError('image_too_large')
                image.save(destination, format='PNG')
                pixels = [image.width, image.height]
                image.close()
            if Path(destination).stat().st_size > MAX_BYTES:
                raise ValueError('image_too_large')
            after = Path(source).stat()
            if signature != [after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns]:
                raise ValueError('source_changed_during_render')
            return {'page_number': number, 'width': width, 'height': height,
                    'rotation': page.get_rotation(), 'crop_box': list(page.get_cropbox()),
                    'coordinate_space': 'rotated_crop_top_left', 'bbox': box,
                    'source_sha256': sha.hexdigest(), 'source_signature': signature,
                    'pixels': pixels, 'scale': scale}


if __name__ == '__main__':
    try:
        metadata = render(sys.argv[1], int(sys.argv[2]), json.loads(sys.argv[3]), sys.argv[4])
        print(json.dumps(metadata, allow_nan=False))
    except Exception:
        # Do not print file paths or raw native-library diagnostics to the API.
        print('{"error":"source_render_failed"}')
        sys.exit(1)
