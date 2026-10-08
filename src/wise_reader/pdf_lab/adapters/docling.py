"""Docling + native Apple Vision local candidate, one actual source page at a time."""
from __future__ import annotations

import math
import os
import tempfile
import uuid
from pathlib import Path

from .digital import clamp, normalized_text, union


# Absolute PDF points: never scales with page dimensions or OCR raster size.
BBOX_TOLERANCE_POINTS = 1e-5


def _bounded_bbox(boxes, width, height, page_number):
    for box in boxes:
        if len(box) != 4 or any(not isinstance(value, (int, float))
                                or isinstance(value, bool) or not math.isfinite(value) for value in box):
            raise ValueError(f'Docling source bbox has non-finite coordinates on page {page_number}.')
        x0, y0, x1, y1 = box
        if not (x0 < x1 and y0 < y1):
            raise ValueError(f'Docling source bbox has non-positive area on page {page_number}.')
        if not (-BBOX_TOLERANCE_POINTS <= x0 < x1 <= width + BBOX_TOLERANCE_POINTS
                and -BBOX_TOLERANCE_POINTS <= y0 < y1 <= height + BBOX_TOLERANCE_POINTS):
            raise ValueError(f'Docling source bbox outside page {page_number}.')
    bbox = union(boxes)
    adjustment = max(0.0, -bbox[0], -bbox[1], bbox[2] - width, bbox[3] - height)
    bbox = clamp(bbox, width, height)
    # clamp rounds to four decimals; retain exact limits for fractional page sizes.
    bbox = [min(width if index % 2 == 0 else height, max(0.0, value))
            for index, value in enumerate(bbox)]
    if not (0 <= bbox[0] < bbox[2] <= width and 0 <= bbox[1] < bbox[3] <= height):
        raise ValueError(f'Docling source bbox has non-positive area after clamping on page {page_number}.')
    return bbox, adjustment


def _retain_raw(document, output, page_number, attempt):
    """Atomic no-overwrite retention of the first raw and each subsequent attempt."""
    directory = output / 'raw'
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix='.docling-raw-', suffix='.json', dir=directory)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        document.save_as_json(temporary)
        with temporary.open('rb') as stream:
            os.fsync(stream.fileno())
        destination = directory / f'docling-p{page_number:06d}.json'
        try:
            os.link(temporary, destination)
        except FileExistsError:
            destination = directory / f'docling-p{page_number:06d}-attempt{attempt:03d}-{uuid.uuid4().hex}.json'
            os.link(temporary, destination)
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


class DoclingAdapter:
    def __init__(self, source: Path, output: Path, digital):
        from ..conversion import model_directory

        # Set before heavyweight imports. Models must already be local.
        os.environ['HF_HUB_OFFLINE']='1'
        os.environ['TRANSFORMERS_OFFLINE']='1'
        os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
        os.environ['OMP_NUM_THREADS']='2'
        from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import OcrMacOptions, PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption

        options=PdfPipelineOptions(artifacts_path=model_directory(),enable_remote_services=False,
                                   do_ocr=True,do_table_structure=True,do_formula_enrichment=False,
                                   do_code_enrichment=False,do_picture_classification=False,
                                   do_picture_description=False,
                                   ocr_options=OcrMacOptions(lang=['en-US'],recognition='accurate',force_full_page_ocr=True),
                                   accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU,num_threads=2))
        self.converter=DocumentConverter(format_options={InputFormat.PDF:PdfFormatOption(pipeline_options=options)})
        self.source,self.output,self.digital=source,output,digital
        self.output.joinpath('raw').mkdir(parents=True,exist_ok=True)

    def normalize_visible_page(self,page_number):
        """Materialize the actual displayed crop in a known local one-page plane."""
        import pypdfium2 as pdfium
        from PIL import Image,ImageChops,ImageStat
        from ..conversion import ASSET_SCALE,file_sha256

        width,height,_,crop,media=self.digital.geometry(page_number)
        asset=self.digital.crop_asset(page_number,[0,0,width,height],'ocr-visible-input')
        with Image.open(self.output/asset) as raster:
            bitmap=pdfium.PdfBitmap.from_pil(raster.convert('RGB'))
            pixels=list(raster.size)
        # Integer pixels divided by the render scale define the new PDF plane.
        # The small ceil-rounding difference is explicitly mapped to originals.
        input_width,input_height=pixels[0]/ASSET_SCALE,pixels[1]/ASSET_SCALE
        document=pdfium.PdfDocument.new()
        normalized=document.new_page(input_width,input_height)
        image=pdfium.PdfImage.new(document)
        image.set_bitmap(bitmap)
        image.set_matrix(pdfium.PdfMatrix(input_width,0,0,input_height,0,0))
        normalized.insert_obj(image)
        normalized.gen_content()
        relative=f'inputs/p{page_number:06d}-visible-normalized.pdf'
        (self.output/'inputs').mkdir(exist_ok=True)
        document.save(self.output/relative)
        normalized.close();document.close();bitmap.close()
        proof=pdfium.PdfDocument(self.output/relative)
        check_page=proof[0];check=check_page.render(scale=ASSET_SCALE)
        try:
            check_image=check.to_pil().convert('RGB')
            with Image.open(self.output/asset) as original:
                original=original.convert('RGB')
                if original.size!=check_image.size:
                    raise ValueError('Normalized OCR input pixel geometry differs from visible original.')
                difference=ImageChops.difference(original,check_image)
                maximum=max(v[1] for v in difference.getextrema())
                mean=sum(ImageStat.Stat(difference).mean)/3
                # Explicitly verify orientation/visible content, no guessed crop.
                if mean>1 or maximum>64:
                    raise ValueError('Normalized OCR input does not faithfully reproduce visible original.')
                check_image.save(self.output/'inputs'/f'p{page_number:06d}-normalization-proof.png')
        finally:
            check.close();check_page.close();proof.close()
        return {'version':1,'asset':asset,'input_path':relative,
                'input_sha256':file_sha256(self.output/relative),'input_page_number':1,
                'original_page_number':page_number,'original_width':width,'original_height':height,
                'original_crop_box':crop,'original_media_box':media,
                'input_width':input_width,'input_height':input_height,'pixel_dimensions':pixels,
                'input_to_original':[width/input_width,0,0,height/input_height,0,0],
                'pixel_proof':{'maximum_channel_difference':maximum,'mean_channel_difference':mean}}

    def convert_page(self, page_number, attempt=1):
        if type(attempt) is not int or attempt < 1:
            raise ValueError('Docling attempt must be a positive integer.')
        source_page=self.digital.pdf.pages[page_number-1]
        cropped=any(abs(a-b)>.01 for a,b in zip(source_page.cropbox,source_page.mediabox))
        normalization=self.normalize_visible_page(page_number) if cropped or source_page.rotation else None
        input_page=1 if normalization else page_number
        input_source=self.output/normalization['input_path'] if normalization else self.source
        result=self.converter.convert(input_source,page_range=(input_page,input_page),raises_on_error=True)
        document=result.document
        # Retain the actual engine result before adaptation, including failures.
        raw_path=_retain_raw(document,self.output,page_number,attempt)
        page=self.normalize_document(page_number,document,normalization)
        page['raw_result_path']=raw_path.relative_to(self.output).as_posix()
        page['conversion_attempt']=attempt
        return page

    def normalize_document(self, page_number, document, normalization=None):
        """Adapt a captured/actual engine document without initializing OCR models."""
        source_page=self.digital.pdf.pages[page_number-1]
        input_page=1 if normalization else page_number
        render_page=self.digital.renderer[page_number-1]
        try:
            width,height=render_page.get_size()
        finally:
            render_page.close()
        page={'page_number':page_number,'width':width,'height':height,'text':'','blocks':[],
              'rotation':source_page.rotation,'crop_box':self.digital.geometry(page_number)[3],
              'coordinate_space':'rotated_crop_top_left','extraction_method':'docling_ocr',
              'quality_state':'candidate','warnings':['Actual local OCR candidate. Completion does not imply independent quality acceptance.'],
              'ocr_backend':'Apple Vision/ocrmac','language':['en-US'],'non_content_objects':[],
              'bbox_adjustment_count':0,
              'bbox_diagnostics':{'absolute_tolerance_points':BBOX_TOLERANCE_POINTS,'maximum_boundary_adjustment_points':0.0}}
        if normalization:
            page['normalization']=normalization
        blocks=page['blocks']
        engine_page=document.pages.get(input_page)
        # Do not invent coordinate transforms for unverified upstream geometry.
        expected_width=normalization['input_width'] if normalization else width
        expected_height=normalization['input_height'] if normalization else height
        geometry_ok=(engine_page is not None and abs(engine_page.size.width-expected_width)<.1 and abs(engine_page.size.height-expected_height)<.1)
        if not geometry_ok:
            page['quality_state']='image_fallback'
            page['warnings'].append('Docling rotated/cropped source geometry is not verified; OCR candidate withheld.')
            bbox=[0,0,width,height]
            blocks.append({'id':f'p{page_number:06d}-b00001','type':'image_fallback','text':'',
                           'source':{'page_number':page_number,'bbox':bbox},
                           'asset':self.digital.crop_asset(page_number,bbox,'docling-geometry-fallback'),
                           'fallback_reason':'unverified_ocr_geometry'})
            return page
        from docling_core.types.doc import ContentLayer
        items = list(document.iterate_items(included_content_layers=set(ContentLayer)))
        items += list(document.iterate_items(root=document.furniture,included_content_layers=set(ContentLayer)))
        seen = set()
        for item,_ in items:
            if item.self_ref in seen:
                continue
            seen.add(item.self_ref)
            prov=[p for p in getattr(item,'prov',[]) if p.page_no==input_page]
            if not prov:
                continue
            boxes=[]
            for p in prov:
                b=p.bbox.to_top_left_origin(expected_height)
                boxes.append([b.l*width/expected_width,b.t*height/expected_height,
                              b.r*width/expected_width,b.b*height/expected_height])
            bbox,adjustment=_bounded_bbox(boxes,width,height,page_number)
            if adjustment:
                page['bbox_adjustment_count']+=1
                diagnostics=page['bbox_diagnostics']
                diagnostics['maximum_boundary_adjustment_points']=max(
                    diagnostics['maximum_boundary_adjustment_points'],adjustment)
            label=str(item.label.value)
            raw=getattr(item,'text','')
            text=normalized_text(raw)
            if label in ['page_header','page_footer']:
                page['non_content_objects'].append({'type':label,'role':'running_furniture','text':text,
                    'source':{'page_number':page_number,'bbox':bbox,'coordinate_space':'rotated_crop_top_left'}})
                continue
            kind={'title':'heading','section_header':'heading','list_item':'list','code':'code',
                  'picture':'image','table':'image_fallback','formula':'image_fallback',
                  'page_header':'page_header','page_footer':'page_footer','footnote':'footnote'}.get(label,'paragraph')
            asset=None
            extra={}
            if label in ['table','formula','picture']:
                bbox=clamp([bbox[0]-2,bbox[1]-2,bbox[2]+2,bbox[3]+2],width,height)
            # Digital originals expose actual math glyph/font evidence. Do not
            # publish OCR substitutions for unverified inline mathematical terms.
            _,_,origin,_,_=self.digital.geometry(page_number)
            native_math=any(bbox[0] <= c['x0']-origin[0] <= bbox[2]
                and bbox[1] <= c['top']-origin[1] <= bbox[3]
                and (c['text'] in '=∑∫√≤≥' or any('\u0370' <= ch <= '\u03ff' for ch in c['text'])
                     or ('symbol' in c['fontname'].lower() and c['text'] not in '•●▪◦‣⁃'))
                for c in source_page.chars if 'glyphless' not in c['fontname'].lower())
            if label in ['table','formula','picture']:
                asset=self.digital.crop_asset(page_number,bbox,f'docling-b{len(blocks)+1:05d}')
                text=''
                if label in ['table','formula']:
                    extra={'fallback_reason':f'{label}_not_independently_structurally_verified','source_type':label}
            elif native_math:
                kind='image_fallback'
                asset=self.digital.crop_asset(page_number,bbox,f'docling-b{len(blocks)+1:05d}')
                text=''
                extra={'fallback_reason':'unverified_inline_math_in_'+label,'source_type':label}
            elif not text.strip():
                continue
            blocks.append({'id':f'p{page_number:06d}-b{len(blocks)+1:05d}','type':kind,'text':text,'raw_text':raw,
                           'source':{'page_number':page_number,'bbox':bbox,
                                     'charspans':[list(p.charspan) for p in prov]},'asset':asset,'source_label':label,**extra})
        covered=[b['source']['bbox'] for b in blocks if b['type'] in ['image','image_fallback']]
        # Retain any original vector drawings not represented by model objects.
        for bbox in self.digital.vector_regions(page_number,covered):
            blocks.append({'id':f'p{page_number:06d}-b{len(blocks)+1:05d}','type':'image_fallback','text':'',
                           'source':{'page_number':page_number,'bbox':bbox},
                           'asset':self.digital.crop_asset(page_number,bbox,f'docling-unclassified-vectors-{len(blocks)+1:05d}'),
                           'fallback_reason':'unclassified_vector_graphics'})
        page['text']='\n\n'.join(b['text'] for b in blocks if b['text'])
        # Protect complex pages when the actual model leaves native content
        # uncovered or substitutes scripts/symbols. This is an honest original
        # fallback, not a claim that mathematical structure was recognized.
        native=[c for c in source_page.chars if c['text'].strip() and 'glyphless' not in c['fontname'].lower()]
        origin=self.digital.geometry(page_number)[2]
        coverage=[b['source']['bbox'] for b in blocks+page['non_content_objects']]
        missing=sum(not any(b[0]-1 <= (c['x0']+c['x1'])/2-origin[0] <= b[2]+1
                           and b[1]-1 <= (c['top']+c['bottom'])/2-origin[1] <= b[3]+1 for b in coverage) for c in native)
        left=any(b['source']['bbox'][2] <= width*.53 for b in blocks)
        right=any(b['source']['bbox'][0] >= width*.47 for b in blocks)
        math_count=sum(b.get('source_type')=='formula' or b.get('source_label')=='formula' for b in blocks)
        original_text=''.join(c['text'] for c in native)
        unexpected=any('\u0400' <= c <= '\u04ff' for c in page['text']) and not any('\u0400' <= c <= '\u04ff' for c in original_text)
        unexpected=unexpected or ('$' in page['text'] and '$' not in original_text and math_count>=3)
        if native and left and right and math_count>=3 and (missing>=20 or unexpected):
            bbox=[0,0,width,height]
            page['blocks']=[{'id':f'p{page_number:06d}-b00001','type':'image_fallback','text':'',
                'source':{'page_number':page_number,'bbox':bbox},
                'asset':self.digital.crop_asset(page_number,bbox,'complex-quality-original'),
                'fallback_reason':'complex_columns_math_or_content_not_reliably_preserved'}]
            page['text']=''
            page['quality_state']='image_fallback'
            page['quality_diagnostics']={'uncovered_native_glyphs':missing,'math_objects':math_count,
                                         'two_column_regions':True,'unexpected_script_or_symbol':unexpected}
            page['warnings'].append('Complex page content/order/math could not be reliably preserved; complete original retained.')
            return page
        if not blocks:
            bbox=[0,0,width,height]
            page['blocks']=[{'id':f'p{page_number:06d}-b00001','type':'image_fallback','text':'',
                'source':{'page_number':page_number,'bbox':bbox},
                'asset':self.digital.crop_asset(page_number,bbox,'ocr-no-content-original'),
                'fallback_reason':'ocr_no_content_original_requires_review'}]
            page['quality_state']='image_fallback'
            page['warnings'].append('OCR returned no readable content; actual original retained, continue later source pages.')
            return page
        if any(b['type']=='image_fallback' for b in blocks):
            page['quality_state']='candidate_with_fallback'
        return page
