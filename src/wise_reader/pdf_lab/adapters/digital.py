"""Actual digital PDF text extraction and faithful raster fallback.

Coordinates are displayed CropBox points after page rotation, with top-left origin.
The text ordering pass reverses the page rotation; source boxes retain it.
This conservative lab adapter is not a general layout/structure recognizer.
"""
from __future__ import annotations

import math
import re
import unicodedata
from pathlib import Path
from statistics import median

LIGATURES = str.maketrans({"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"})
BULLET_CHARS = '•●▪◦‣⁃\uf0b7\uf0a7'


def normalized_text(text: str) -> str:
    return unicodedata.normalize("NFC", text).translate(LIGATURES)


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def clamp(box, width, height):
    return [round(max(0, min(width if i % 2 == 0 else height, float(v))), 4) for i, v in enumerate(box)]


def unrotated_box(box, width, height, rotation):
    def transform(x, y):
        if rotation == 90: return y, width-x
        if rotation == 180: return width-x, height-y
        if rotation == 270: return height-y, x
        return x,y
    points=[transform(box[x],box[y]) for x,y in [(0,1),(2,1),(2,3),(0,3)]]
    return [min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]


class DigitalAdapter:
    def __init__(self, source: Path, output: Path):
        import pdfplumber
        import pypdfium2 as pdfium

        self.pdf = pdfplumber.open(source, unicode_norm="NFC")
        self.renderer = pdfium.PdfDocument(str(source))
        self.output = output
        self.asset_metadata = {}
        self.page_count = len(self.pdf.pages)
        self.output.joinpath("assets").mkdir(parents=True, exist_ok=True)

    def close(self):
        self.pdf.close()
        self.renderer.close()

    def crop_asset(self, page_number, bbox, suffix, *, native_raster_limit=False):
        page = self.renderer[page_number - 1]
        try:
            from ..conversion import ASSET_SCALE, MAX_ASSET_PIXELS

            width, height = page.get_size()
            area = max(1, (bbox[2]-bbox[0])*(bbox[3]-bbox[1]))
            target_scale = ASSET_SCALE
            native_limit = None
            original_page = self.pdf.pages[page_number-1]
            # A single unrotated scan has no extra detail at 4x its native
            # pixels. Opt in only for OCR image fallbacks; vector/mixed pages
            # and all existing callers retain the original rendering policy.
            if (native_raster_limit and original_page.rotation == 0
                    and not original_page.chars and not original_page.lines
                    and not original_page.rects and not original_page.curves
                    and len(original_page.images) == 1):
                from pypdfium2.raw import FPDF_PAGEOBJ_IMAGE

                # A rotated/sheared image inside an unrotated PDF page cannot
                # use its axis-aligned box as its native pixel density.
                images = list(page.get_objects(filter=[FPDF_PAGEOBJ_IMAGE], max_depth=1))
                matrix = images[0].get_matrix() if len(images) == 1 else None
                axis_aligned = matrix is not None and abs(matrix.b) < 1e-8 and abs(matrix.c) < 1e-8
                original = original_page.images[0]
                px = list(original['srcsize'])
                mask = original['stream'].attrs.get('SMask')
                if mask is not None:
                    attrs = mask.resolve().attrs if hasattr(mask, 'resolve') else getattr(mask, 'attrs', {})
                    px = [max(px[0], attrs.get('Width', 0)), max(px[1], attrs.get('Height', 0))]
                image_width, image_height = original['x1']-original['x0'], original['bottom']-original['top']
                if axis_aligned and image_width > 0 and image_height > 0 and min(px) > 0:
                    density = max(px[0]/image_width, px[1]/image_height)
                    if math.isfinite(density) and density > 0:
                        target_scale = min(target_scale, density)
                        if target_scale < ASSET_SCALE:
                            native_limit = {'reason': 'single_scan_native_pixels', 'native_scale': density,
                                            'intrinsic_pixels': px}
            # Render only the region. Reserve rounding headroom within the
            # raster budget and preserve native density for opted-in scans.
            scale = min(target_scale, ((MAX_ASSET_PIXELS-20_000)/area) ** 0.5)
            crop = (bbox[0], height-bbox[3], width-bbox[2], bbox[1])
            bitmap = page.render(scale=scale, crop=crop, limit_image_cache=True)
            try:
                image = bitmap.to_pil()
                name = f"assets/p{page_number:06d}-{suffix}.png"
                image.save(self.output / name)
                self.asset_metadata[name] = {'scale': scale, 'requested_scale': ASSET_SCALE,
                                             'budget_limited': scale < target_scale,
                                             'width_px': image.width, 'height_px': image.height}
                if native_limit is not None:
                    self.asset_metadata[name]['native_raster_limit'] = native_limit
                _,_,origin,_,_=self.geometry(page_number)
                rasters=[]
                for original in self.pdf.pages[page_number-1].images:
                    source_box=[original['x0']-origin[0],original['top']-origin[1],original['x1']-origin[0],original['bottom']-origin[1]]
                    if source_box[2]<=bbox[0] or source_box[0]>=bbox[2] or source_box[3]<=bbox[1] or source_box[1]>=bbox[3]:
                        continue
                    px=list(original['srcsize'])
                    mask=original['stream'].attrs.get('SMask')
                    if mask is not None:
                        attributes=mask.resolve().attrs if hasattr(mask,'resolve') else getattr(mask,'attrs',{})
                        px=[max(px[0],attributes.get('Width',0)),max(px[1],attributes.get('Height',0))]
                    native_scale=min(px[0]/max(1,source_box[2]-source_box[0]),px[1]/max(1,source_box[3]-source_box[1]))
                    rasters.append({'source_bbox':source_box,'intrinsic_pixels':px,'native_scale':native_scale,
                                    'raster_upsampled':scale>native_scale})
                self.asset_metadata[name]['source_rasters']=rasters
                self.asset_metadata[name]['detail_note']='Bitmap density does not add detail to a low-resolution source scan.' if rasters else 'Rendered native PDF text/vector content.'
                return name
            finally:
                bitmap.close()
        finally:
            page.close()

    def geometry(self, page_number):
        page = self.renderer[page_number - 1]
        try:
            width, height = page.get_size()
            media = page.get_mediabox()
            raw_crop = page.get_cropbox()
            rotation = page.get_rotation()
        finally:
            page.close()
        mx0, my0, mx1, my1 = media
        cx0, cy0 = max(raw_crop[0], mx0), max(raw_crop[1], my0)
        cx1, cy1 = min(raw_crop[2], mx1), min(raw_crop[3], my1)
        full_width, full_height = mx1-mx0, my1-my0
        def rotate(x, y):
            if rotation == 90: return full_height-y, x
            if rotation == 180: return full_width-x, full_height-y
            if rotation == 270: return y, full_width-x
            return x, y
        points = [rotate(x,y) for x,y in [(cx0-mx0,my1-cy1),(cx1-mx0,my1-cy1),(cx1-mx0,my1-cy0),(cx0-mx0,my1-cy0)]]
        # pdfminer objects are relative to MediaBox; pdfplumber restores its
        # normalized offset. Derive the rotated crop from PDFium's raw boxes,
        # rather than pdfplumber's untransformed asymmetric CropBox.
        offset = self.pdf.pages[page_number-1].mediabox[:2]
        crop = [min(p[0] for p in points)+offset[0], min(p[1] for p in points)+offset[1],
                max(p[0] for p in points)+offset[0], max(p[1] for p in points)+offset[1]]
        if abs(crop[2]-crop[0]-width)>.1 or abs(crop[3]-crop[1]-height)>.1:
            raise ValueError('PDF crop/rotation geometry is incompatible with renderer.')
        return width, height, crop, list(raw_crop), list(media)

    def vector_regions(self, page_number, covered=(), decorations=None):
        page = self.pdf.pages[page_number-1]
        width,height,crop,_,_=self.geometry(page_number)
        clipped=page.crop(crop,strict=False)
        boxes=[]
        drawing_objects=clipped.lines+clipped.rects+clipped.curves
        chars=clipped.chars
        body_size=median(c['size'] for c in chars if c['text'].strip()) if chars else 12
        for obj in drawing_objects:
            b=[obj['x0']-crop[0],obj['top']-crop[1],obj['x1']-crop[0],obj['bottom']-crop[1]]
            if any(b[0]>=v[0]-.5 and b[1]>=v[1]-.5 and b[2]<=v[2]+.5 and b[3]<=v[3]+.5 for v in covered):
                continue
            horizontal = page.rotation in [0,180] and b[3]-b[1] <= 1.5 and b[2]-b[0] > 8
            role = None
            if horizontal:
                # Preserve chart axes: connected/nearby tall paths are content.
                touches_drawing = any(other is not obj and other['bottom']-other['top'] > 3
                    and not (other['x1'] < obj['x0']-2 or other['x0'] > obj['x1']+2
                             or other['bottom'] < obj['top']-24 or other['top'] > obj['bottom']+24)
                    for other in drawing_objects)
                if not touches_drawing:
                    if b[2]-b[0] >= width*.5 and any(c['size'] > body_size*1.2
                        and 0 <= obj['top']-c['bottom'] <= 20
                        and obj['x0'] <= c['x0'] <= obj['x1'] for c in chars):
                        role='heading_rule'
                    elif any((a.get('uri') or getattr(a.get('data',{}).get('Subtype'),'name',None)=='Link') and a['bottom']-a['top'] <= body_size*3
                        and a['x0']-2 <= obj['x0'] <= obj['x1'] <= a['x1']+2
                        and a['top'] <= obj['top'] <= a['bottom']+2 for a in clipped.annots or []):
                        role='link_underline'
            if role:
                if decorations is not None:
                    decorations.append({'type':'separator','role':role,
                        'source':{'page_number':page_number,'bbox':clamp(b,width,height),
                                  'coordinate_space':'rotated_crop_top_left'}})
                continue
            boxes.append(b)
        if not boxes: return []
        if len(boxes) > 256:
            groups = [union(boxes)]
        else:
            groups = []
            for box in boxes:
                group = box
                again = True
                while again:
                    again = False
                    for previous in list(groups):
                        if not (group[2]+12 < previous[0] or previous[2]+12 < group[0] or group[3]+12 < previous[1] or previous[3]+12 < group[1]):
                            groups.remove(previous)
                            group = union([group,previous])
                            again = True
                groups.append(group)
        regions=[]
        for b in groups:
            # Thin rules/underlines need their pixels, not the surrounding prose.
            margin = 1 if min(b[2]-b[0],b[3]-b[1]) < 2 else 16
            regions.append(clamp([b[0]-margin,b[1]-margin,b[2]+margin,b[3]+margin],width,height))
        return regions

    def _chars(self, page, width, height, crop, excluded=()):
        from pdfplumber.utils import chars_to_textmap

        clipped = page.crop(crop, strict=False).dedupe_chars()
        chars = []
        rotation = page.rotation
        for original in clipped.chars:
            c = dict(original)
            box = [c['x0'] - crop[0], c['top'] - crop[1], c['x1'] - crop[0], c['bottom'] - crop[1]]
            c['_source_bbox'] = clamp(box, width, height)
            center=((box[0]+box[2])/2,(box[1]+box[3])/2)
            if any(b[0]-.5<=center[0]<=b[2]+.5 and b[1]-.5<=center[1]<=b[3]+.5 for b in excluded):
                continue
            def inverse(x, y):
                if rotation == 90:
                    return y, width - x
                if rotation == 180:
                    return width - x, height - y
                if rotation == 270:
                    return height - y, x
                return x, y
            points = [inverse(box[x], box[y]) for x, y in [(0,1), (2,1), (2,3), (0,3)]]
            c['x0'], c['top'] = min(p[0] for p in points), min(p[1] for p in points)
            c['x1'], c['bottom'] = max(p[0] for p in points), max(p[1] for p in points)
            c['upright'] = True
            c['size'] = c['bottom'] - c['top']
            c['doctop'] = c['top']
            chars.append(c)
        lines = chars_to_textmap(chars, layout=False, x_tolerance_ratio=.2).extract_text_lines(return_chars=True) if chars else []
        return clipped, lines

    def raster_markers(self, page_number, images, lines, crop, width, height, covered):
        """Recognize repeated neutral round/square prefix markers, not arbitrary icons."""
        from PIL import Image

        rotation=self.pdf.pages[page_number-1].rotation
        metadata=self.renderer.get_metadata_dict(skip_empty=True)
        producer=(metadata.get('Producer','')+' '+metadata.get('Creator','')).lower()
        word_exporter=('word' in producer and 'microsoft' in producer) or 'libreoffice' in producer
        candidates=[]
        for image_index,image in enumerate(images):
            bbox=[image['x0']-crop[0],image['top']-crop[1],image['x1']-crop[0],image['bottom']-crop[1]]
            box=unrotated_box(bbox,width,height,rotation)
            if not (2 <= box[2]-box[0] <= 18 and 2 <= box[3]-box[1] <= 20):
                continue
            if any(bbox[0]>=b[0] and bbox[1]>=b[1] and bbox[2]<=b[2] and bbox[3]<=b[3] for b in covered):
                continue
            matches=[]
            for index,line in enumerate(lines):
                chars=line['chars']
                if not chars or line['text'].lstrip()[:1] in BULLET_CHARS:
                    continue
                left=min(c['x0'] for c in chars)
                top=min(c['top'] for c in chars)
                bottom=max(c['bottom'] for c in chars)
                size=median(c['size'] for c in chars)
                if 0 <= left-box[2] <= size*3.5 and abs((top+bottom-box[1]-box[3])/2) <= size*.7:
                    matches.append((abs(top-box[1]),index))
            if matches:
                candidates.append({'image_index':image_index,'line_index':min(matches)[1],
                                   'bbox':clamp(bbox,width,height),'normal_box':box,
                                   'word_marker_resource':word_exporter and tuple(image['srcsize'])==(2,2)
                                       and image['stream'].attrs.get('SMask') is not None})
        markers={}
        for candidate in candidates:
            if not candidate['word_marker_resource'] and sum(abs(other['normal_box'][0]-candidate['normal_box'][0]) <= 3 for other in candidates) < 2:
                continue
            asset=self.crop_asset(page_number,candidate['bbox'],f'marker-{candidate["image_index"]:05d}')
            with Image.open(self.output/asset) as image:
                rgb=image.convert('RGB')
                mask=Image.new('L',rgb.size)
                pixels=list(rgb.getdata())
                mask.putdata([255 if max(p)<100 and max(p)-min(p)<24 else 0 for p in pixels])
                ink=mask.getbbox()
                if not ink:
                    continue
                ink_width,ink_height=ink[2]-ink[0],ink[3]-ink[1]
                count=sum(v>0 for v in mask.crop(ink).getdata())
                density=count/max(1,ink_width*ink_height)
                if min(ink_width,ink_height)<2 or not .65 <= ink_width/ink_height <= 1.55 or not .55 <= density <= 1:
                    continue
            markers[candidate['line_index']]={**candidate,'asset':asset,'kind':'bullet',
                'glyph':'•','classification':'repeated_neutral_round_or_square_prefix'}
        return markers

    def convert_page(self, page_number):
        page = self.pdf.pages[page_number - 1]
        width, height, crop, raw_crop, media = self.geometry(page_number)
        clipped = page.crop(crop,strict=False)
        tables = clipped.find_tables()
        # Include outer stroke thickness once in the table, rather than making
        # independent top/bottom "figure" strips around a complete table crop.
        table_boxes = [clamp([t.bbox[0]-crop[0]-2,t.bbox[1]-crop[1]-2,
                             t.bbox[2]-crop[0]+2,t.bbox[3]-crop[1]+2],width,height) for t in tables]
        clipped, lines = self._chars(page,width,height,crop,table_boxes)
        result = {'page_number': page_number, 'width': width, 'height': height, 'text': '', 'blocks': [],
                  'rotation': page.rotation, 'crop_box': raw_crop, 'media_box': media,
                  'coordinate_space': 'rotated_crop_top_left', 'extraction_method': 'digital_text',
                  'quality_state': 'candidate', 'warnings': [], 'non_content_objects': []}
        blocks = result['blocks']
        def append(kind, text, bbox, asset=None, **extra):
            blocks.append({'id': f'p{page_number:06d}-b{len(blocks)+1:05d}', 'type': kind, 'text': text,
                           'source': {'page_number': page_number, 'bbox': clamp(bbox,width,height)},
                           'asset': asset, **extra})
        def fallback(bbox, reason, kind='image_fallback'):
            append(kind, '', bbox, self.crop_asset(page_number,bbox,f'b{len(blocks)+1:05d}'), fallback_reason=reason,
                   source_type='table' if reason.startswith('table_') else ('formula' if reason.startswith('formula_') else 'image'))
        # Suspicious text is never silently treated as reliable OCR/text.
        text = normalized_text(' '.join(line['text'] for line in lines))
        if not clipped.chars and not clipped.images and not (clipped.lines or clipped.rects or clipped.curves) and not clipped.annots:
            result['quality_state']='blank'
            result['warnings'].append('Actual source page has no text, image, drawing or annotation content.')
            page.close()
            return result
        if (not text.strip() and not table_boxes) or any(unicodedata.category(c) == 'Cc' and not c.isspace() for c in text) or text.count('\ufffd') > max(1, len(text) * .01):
            fallback([0,0,width,height], 'ocr_required' if not text.strip() else 'corrupt_text_layer')
            result['quality_state'] = 'image_fallback'
            result['warnings'].append('No validated text; full original image is retained. This is not OCR.')
            page.close()
            return result
        image_boxes=[[im['x0']-crop[0],im['top']-crop[1],im['x1']-crop[0],im['bottom']-crop[1]] for im in clipped.images]
        if any((b[2]-b[0])*(b[3]-b[1]) >= width*height*.65 for b in image_boxes):
            fallback([0,0,width,height],'mixed_scan_requires_ocr')
            result['quality_state']='image_fallback'
            result['warnings'].append('Dominant original scan image: existing text/OCR overlay is withheld for actual OCR or faithful fallback.')
            page.close()
            return result
        vector_regions=self.vector_regions(page_number,table_boxes+image_boxes,result['non_content_objects'])
        if any((b[2]-b[0])*(b[3]-b[1]) > width*height*.65 for b in vector_regions):
            fallback([0,0,width,height],'complex_vector_layout')
            result['quality_state']='image_fallback'
            result['warnings'].append('Large unclassified vector layout: faithful whole original retained; native fragments withheld.')
            page.close()
            return result
        if vector_regions:
            clipped,lines=self._chars(page,width,height,crop,table_boxes+vector_regions)
        sizes = [c['size'] for line in lines for c in line['chars'] if c['text'].strip()]
        base_size = median(sizes) if sizes else 12
        from pdfplumber.utils import chars_to_textmap
        ambiguous = []
        split_lines = []
        normalized_height = width if page.rotation in [90,270] else height
        for line in lines:
            chars = list({id(c):c for c in line['chars']}.values())
            ordered = sorted(chars,key=lambda c:c['x0'])
            groups = [[]]
            for c in ordered:
                if groups[-1] and c['x0']-groups[-1][-1]['x1'] > max(48,base_size*4):
                    groups.append([])
                groups[-1].append(c)
            if len(groups)>1 and chars and min(c['top'] for c in chars) < normalized_height*.88:
                ambiguous.append(line)
            if len(groups)>1:
                for group in groups:
                    split_lines.extend(chars_to_textmap(group,layout=False,x_tolerance_ratio=.2).extract_text_lines(return_chars=True))
            else:
                split_lines.append(line)
        if len(ambiguous) >= 3:
            fallback([0,0,width,height],'ambiguous_reading_order')
            result['quality_state']='image_fallback'
            result['warnings'].append('Repeated body-column ambiguity: candidate text withheld.')
            page.close()
            return result
        lines = split_lines
        raster_markers=self.raster_markers(page_number,clipped.images,lines,crop,width,height,table_boxes+vector_regions)
        used_images=set()
        for line_index,line in enumerate(lines):
            # TextMap repeats the same glyph object when expanding a ligature.
            # Keep one original glyph/box; reading text remains expanded.
            chars = list({id(c): c for c in line['chars']}.values())
            if not chars:
                continue
            bbox = union([c['_source_bbox'] for c in chars])
            raw = line['text']
            content = normalized_text(raw)
            fonts = ' '.join(c['fontname'].lower() for c in chars)
            native_marker=bool(content.lstrip()[:1] and content.lstrip()[0] in BULLET_CHARS)
            marker=raster_markers.get(line_index)
            if native_marker:
                first=next(c for c in chars if c['text'].strip())
                marker={'kind':'bullet','glyph':'•','original_glyph':first['text'],
                        'bbox':first['_source_bbox'],'asset':None,'classification':'native_bullet_glyph'}
                content=re.sub('^['+BULLET_CHARS+']\\s*','',content.lstrip())
            link_glyphs=sum(any((a.get('uri') or getattr(a.get('data',{}).get('Subtype'),'name',None)=='Link')
                and a['x0']-2 <= c['_source_bbox'][0]+crop[0] <= a['x1']+2
                and a['top']-2 <= c['_source_bbox'][1]+crop[1] <= a['bottom']+2
                for a in clipped.annots or []) for c in chars)
            url_text=bool(re.search(r'https?://|www\.|\w+\?\S*=\S*&',content)) or (link_glyphs >= len(chars)*.7 and bool(re.search(r'[?&/]',content)))
            if not url_text and (re.search(r'[=∑∫√≤≥]',content) or any(f in fonts for f in ['cmmi','cmsy','math'])):
                # Expand slightly to retain ascenders/subscripts in the local crop.
                bbox = clamp([bbox[0]-2,bbox[1]-3,bbox[2]+2,bbox[3]+3],width,height)
                fallback(bbox,'formula_not_structurally_verified')
                continue
            size = median(c['size'] for c in chars)
            if marker:
                kind='list'
            elif re.fullmatch(r'(?:\*\s*){3,}',content):
                kind='separator'
            elif size > base_size*1.25:
                kind='heading'
            elif re.match(r'^(?:\d+[.)]|[*-])\s',content):
                kind='list'
            elif 'courier' in fonts or 'mono' in fonts:
                kind='code'
            else:
                kind='paragraph'
            glyphs=[{'text':c['text'],'bbox':c['_source_bbox']} for c in chars]
            # Join nearby prose lines; preserve raw line/glyph source mapping.
            previous = blocks[-1] if blocks else None
            previous_text_box=previous.get('text_bbox',previous['source']['bbox']) if previous else None
            if kind == 'paragraph' and previous and previous['type'] in ['paragraph','list'] and page.rotation == 0 and 0 <= bbox[1]-previous_text_box[3] <= base_size*.8 and abs(bbox[0]-previous_text_box[0]) <= base_size*1.5:
                previous['text'] += ' '+content
                previous['raw_text'] += '\n'+raw
                previous['raw_glyph_text'] += '\n'+''.join(c['text'] for c in chars)
                previous['source']['bbox'] = union([previous['source']['bbox'],bbox])
                previous['text_bbox']=union([previous_text_box,bbox])
                previous['source']['glyphs'].extend(glyphs)
            else:
                append(kind,content,bbox,raw_text=raw,raw_glyph_text=''.join(c['text'] for c in chars))
                blocks[-1]['source']['glyphs']=glyphs
                blocks[-1]['text_bbox']=bbox
                if marker:
                    blocks[-1]['source']['bbox']=union([bbox,marker['bbox']])
                    blocks[-1]['marker']={'kind':marker['kind'],'glyph':marker['glyph'],
                        'original_glyph':marker.get('original_glyph'),'asset':marker['asset'],
                        'classification':marker['classification'],
                        'source':{'page_number':page_number,'bbox':marker['bbox'],
                                  'coordinate_space':'rotated_crop_top_left'}}
                    if 'image_index' in marker:
                        used_images.add(marker['image_index'])
        for bbox in vector_regions:
            fallback(bbox,'vector_not_structurally_verified')
        for bbox in table_boxes:
            fallback(bbox,'table_not_structurally_verified')
        for image_index,image in enumerate(clipped.images):
            if image_index in used_images:
                continue
            bbox=[image['x0']-crop[0],image['top']-crop[1],image['x1']-crop[0],image['bottom']-crop[1]]
            if bbox[2]>bbox[0] and bbox[3]>bbox[1]:
                fallback(clamp(bbox,width,height),'original_image',kind='image')
        # Rotation is reversed for order but source boxes always refer to displayed PDF.
        def unrotated_order(block):
            x0,y0,x1,y1=block['source']['bbox']
            if page.rotation == 90: return (width-x1,y0)
            if page.rotation == 180: return (height-y1,width-x1)
            if page.rotation == 270: return (x0,height-y1)
            return (y0,x0)
        blocks.sort(key=unrotated_order)
        # Reliable title-based running furniture is retained as source metadata,
        # rather than repeated as paragraphs in the reading edition.
        title=normalized_text(self.renderer.get_metadata_dict(skip_empty=True).get('Title','')).lower()
        title_footer=[]
        if len(title)>8:
            for b in blocks:
                box=unrotated_box(b['source']['bbox'],width,height,page.rotation)
                if b['text'].lower().startswith(title) and box[1]>normalized_height*.89:
                    title_footer.append(b)
        if title_footer:
            for b in list(blocks):
                box=unrotated_box(b['source']['bbox'],width,height,page.rotation)
                if b in title_footer or (box[1]>normalized_height*.89 and re.fullmatch(r'\d{1,4}|[ivxlcdmIVXLCDM]{1,8}',b['text'])):
                    result['non_content_objects'].append({'type':'page_footer','role':'running_title' if b in title_footer else 'printed_page_label',
                        'text':b['text'],'source':b['source']})
                    blocks.remove(b)
        result['text']='\n\n'.join(b['text'] for b in blocks if b['text'])
        result['warnings'].append('Lightweight layout/structure heuristics; complex layouts and text-layer correctness need independent review.')
        if any(b['type']=='image_fallback' for b in blocks):
            result['quality_state']='candidate_with_fallback'
        page.close()
        return result
