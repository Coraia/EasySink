"""Local geometry corrections for native PDF text, with no model or OCR dependency.

These helpers belong to the digital path. OCR's geometry/cropping and vector
classifier keep their existing contracts. Unmapped glyphs are never decoded here.
"""
from __future__ import annotations

import re
from statistics import median

from .digital import clamp, normalized_text, union

MATH_FONT = re.compile(r'cmmi|cmsy|cmex|msam|msbm|math', re.I)
BAD_GLYPH = re.compile(r'\(cid:\d+\)|\ufffd')


def has_math_glyphs(chars):
    return any(MATH_FONT.search(c['fontname']) or BAD_GLYPH.search(c['text'])
               or re.search(r'[=∑∫√≤≥]',c['text']) for c in chars)


def intersects(a, b, gap=0):
    return not (a[2]+gap < b[0] or b[2]+gap < a[0]
                or a[3]+gap < b[1] or b[3]+gap < a[1])


def components(boxes, gap=0):
    """Sweep actual objects, not expanding bounding boxes that bridge blank text."""
    parents = list(range(len(boxes)))
    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    active = []
    for i in sorted(range(len(boxes)), key=lambda i: boxes[i][0]):
        active = [j for j in active if boxes[j][2]+gap >= boxes[i][0]]
        for j in active:
            if intersects(boxes[i], boxes[j], gap):
                a, b = root(i), root(j)
                if a != b:
                    parents[a] = b
        active.append(i)
    groups = {}
    for i in range(len(boxes)):
        groups.setdefault(root(i), []).append(i)
    return list(groups.values())


def protect_side_text(object_bbox, padded, text_lines):
    """Optional image padding cannot claim the start/end of an outside text run.

    A table cell belongs to its actual drawing bounds. A neighbouring sentence
    that starts beyond those bounds and continues beyond the padded crop does
    not. Split at layout gaps, retaining ordinary word spaces within each run.
    """
    padded=list(padded)
    for line in text_lines:
        runs=[]
        for c in sorted(line['chars'],key=lambda c:c['x0']):
            if not runs or c['x0']-runs[-1][-1]['x1']>max(4,min(c['size'],runs[-1][-1]['size'])*.8):
                runs.append([])
            runs[-1].append(c)
        for run in runs:
            # A radical/limit outside its drawing is part of that mathematical
            # region, not a side note. Keep the established crop/classification
            # boundary for math; this padding guard only protects ordinary prose.
            if has_math_glyphs(run):
                continue
            box=union([c['_source_bbox'] for c in run])
            if box[3]<=object_bbox[1] or box[1]>=object_bbox[3]:
                continue
            if object_bbox[2]<box[0]<=padded[2]<box[2]:
                padded[2]=max(object_bbox[2],box[0]-1)
            if box[0]<padded[0]<=box[2]<object_bbox[0]:
                padded[0]=min(object_bbox[0],box[2]+1)
    return padded


def visual_regions(clipped, crop, width, height, page_number, decorations, text_lines=()):
    """Keep figures local even when they contain hundreds of vector paths.

    Empty rectangular text frames and underlines are furniture; chart axes and
    arbitrary filled/vector shapes remain assets. No object-count whole-page union.
    """
    objects = clipped.lines+clipped.rects+clipped.curves
    chars = clipped.chars
    boxes = []
    for obj in objects:
        raw = [obj['x0'], obj['top'], obj['x1'], obj['bottom']]
        w, h = raw[2]-raw[0], raw[3]-raw[1]
        role = None
        # A rect/rounded rect enclosing many prose glyphs with an otherwise empty
        # interior is decoration. A chart/table has drawing paths in its interior.
        pts = obj.get('pts', [])
        perimeter = pts and all(min(abs(x-raw[0]),abs(x-raw[2]),abs(y-raw[1]),abs(y-raw[3])) <= 10 for x,y in pts)
        if w > width*.5 and h > 40 and perimeter:
            inside_chars = [c for c in chars if raw[0]+4<c['x0']<raw[2]-4 and raw[1]+4<c['top']<raw[3]-4]
            interior_shapes = [o for o in objects if o is not obj and
                raw[0]+10 < o['x0'] and o['x1'] < raw[2]-10 and
                raw[1]+10 < o['top'] and o['bottom'] < raw[3]-10 and o['bottom']-o['top']>3]
            if len(inside_chars)>80 and not interior_shapes:
                role = 'text_frame'
        if h <= 1.5 and w > .2:
            touching = any(o is not obj and o['bottom']-o['top']>3 and
                intersects(raw,[o['x0'],o['top'],o['x1'],o['bottom']],2) for o in objects)
            if not touching:
                above = [c for c in chars if raw[0]-1 <= c['x1'] and c['x0'] <= raw[2]+1 and
                    -1 <= raw[1]-c['bottom'] <= 3 and not MATH_FONT.search(c['fontname'])]
                math_above=any(raw[0]-1<=c['x1'] and c['x0']<=raw[2]+1 and -1<=raw[1]-c['bottom']<=3 and MATH_FONT.search(c['fontname']) for c in chars)
                if not math_above and len(re.findall(r'[A-Za-z]', ''.join(c['text'] for c in above))) >= 2:
                    role = 'text_underline'
                elif w > width*.65 and not any(raw[0]<c['x0']<raw[2] and abs(c['top']-raw[1])<4 for c in chars):
                    role = 'section_rule'
        b = clamp([raw[0]-crop[0],raw[1]-crop[1],raw[2]-crop[0],raw[3]-crop[1]],width,height)
        if role:
            decorations.append({'type':'separator','role':role,'source':{
                'page_number':page_number,'bbox':b,'coordinate_space':'rotated_crop_top_left'}})
        else:
            boxes.append(b)
    regions = []
    for indices in components(boxes, gap=12):
        b = union([boxes[i] for i in indices])
        margin = 1 if min(b[2]-b[0],b[3]-b[1])<2 else 12
        padded=[b[0]-margin,b[1]-margin,b[2]+margin,b[3]+margin]
        # Padding collects axis labels but must stop before a following caption.
        for line in text_lines:
            if re.match(r'^(?:Figure|Fig\.|Table)\s*\d',line['text']):
                top=min(c['_source_bbox'][1] for c in line['chars'])
                if b[3] < top <= padded[3]:
                    padded[3]=top-1
        padded=protect_side_text(b,padded,text_lines)
        regions.append({'bbox':clamp(padded,width,height),'object_bbox':b,
                        'reason':'vector_not_structurally_verified'})
    return regions


def owned_regions(regions, chars, width, height):
    """One raster owner for intersecting candidates, including nested chart grids.

    Retain whole boundary glyphs when a crop would otherwise cut through them.
    The same final regions exclude text and generate assets.
    """
    entries = [dict(r) for r in regions]
    # Iterate because the final crop rectangle, unlike the source objects, also
    # owns its blank interior. Never emit both a plot and a crop inside that plot.
    while entries:
        before=[r['bbox'] for r in entries]
        for entry in entries:
            b=entry['bbox']
            # Ignore mere touching: extending to one complete glyph must not
            # repeatedly absorb its contiguous neighbours across a prose line.
            touched=[c['_source_bbox'] for c in chars if
                     min(b[2],c['_source_bbox'][2])-max(b[0],c['_source_bbox'][0])>.1 and
                     min(b[3],c['_source_bbox'][3])-max(b[1],c['_source_bbox'][1])>.1]
            if touched:
                entry['bbox']=clamp(union([b]+touched),width,height)
        groups = components([r['bbox'] for r in entries])
        if len(groups) == len(entries):
            if before == [r['bbox'] for r in entries]:break
            continue
        merged = []
        for group in groups:
            items = [entries[i] for i in group]
            owner = max(items, key=lambda r:(r['bbox'][2]-r['bbox'][0])*(r['bbox'][3]-r['bbox'][1]))
            merged.append({**owner,'bbox':clamp(union([r['bbox'] for r in items]),width,height),
                'regions':sum((r.get('regions',[{'reason':r['reason'],'bbox':r['bbox']}]) for r in items),[])})
        entries = merged
    return entries


def glyph_lines(lines, base_size):
    """Attach small superscript/subscript glyphs to nearby baseline text.

    Work from native glyph positions. Math strings stay literal; script ranges
    refer to normalized Python strings, including expanded ligatures.
    """
    chars = [dict(c) for c in {id(c):c for line in lines for c in line['chars']}.values()]
    for c in chars:c.pop('_script',None)
    anchors = [c for c in chars if c['size'] >= base_size*.82]
    small = [c for c in chars if c['size'] < base_size*.82]
    rows = []
    for c in sorted(anchors,key=lambda c:(c['bottom'],c['x0'])):
        compatible = [r for r in rows[-4:] if abs(r['baseline']-c['bottom']) <= min(base_size,c['size'])*.20]
        if compatible:
            r = min(compatible,key=lambda r:abs(r['baseline']-c['bottom']))
            r['chars'].append(c)
        else:
            rows.append({'baseline':c['bottom'],'chars':[c]})
    for c in small:
        # A smaller font on the SAME baseline is still text (e.g. bold labels
        # beside a date). It must not become individual orphan character rows.
        same=[r for r in rows if abs(r['baseline']-c['bottom'])<c['size']*.15
              and c['size']>=median(g['size'] for g in r['chars'])*.78]
        if same:
            min(same,key=lambda r:abs(r['baseline']-c['bottom']))['chars'].append(c)
            continue
        candidates=[]
        center=(c['top']+c['bottom'])/2
        for r in rows:
            rc=r['chars']
            main=[g for g in rc if not g.get('_script')]
            size=median(g['size'] for g in main)
            mid=r['baseline']-size/2
            # Require horizontal proximity too; don't join marginal labels into prose.
            near=min((max(g['x0']-c['x1'],c['x0']-g['x1'],0) for g in main),default=1e6)
            if c['size'] < size*.86 and abs(center-mid)<size*.90 and near<size*2:
                candidates.append((abs(center-mid)+near*.1,r,mid,size))
        if candidates:
            _,r,mid,size=min(candidates,key=lambda v:v[0])
            copied=dict(c)
            copied['_script']='sub' if center>mid+size*.1 else 'sup'
            r['chars'].append(copied)
        else:
            rows.append({'baseline':c['bottom'],'chars':[c]})
    output=[]
    for r in sorted(rows,key=lambda r:min(c['top'] for c in r['chars'])):
        cs=r['chars']
        main=sorted([c for c in cs if not c.get('_script')],key=lambda c:c['x0'])
        local_size=median(c['size'] for c in main) if main else base_size
        mathematical=has_math_glyphs(cs)
        # Join script runs before associating them with a base glyph. Overlapping
        # upper/lower runs are independent, so p^K_(h,l) does not become phK,l.
        runs=[]
        for kind in ('sup','sub'):
            for c in sorted((c for c in cs if c.get('_script')==kind),key=lambda c:c['x0']):
                if runs and runs[-1]['kind']==kind and c['x0']-runs[-1]['chars'][-1]['x1']<base_size*.4 and abs(c['top']-runs[-1]['chars'][-1]['top'])<base_size*.25:
                    runs[-1]['chars'].append(c)
                else:
                    runs.append({'kind':kind,'chars':[c]})
        attached={}
        for run in runs:
            left=run['chars'][0]['x0']
            preceding=[(i,c) for i,c in enumerate(main) if c['x0']<=left+.5]
            at=preceding[-1][0] if preceding else -1
            attached.setdefault(at,[]).append(run)
        text='';styles=[];previous_right=None;previous_size=local_size
        def add_run(run):
            nonlocal text,previous_right
            start=len(text)
            text += normalized_text(''.join(c['text'] for c in run['chars']))
            if len(text)>start:styles.append({'start':start,'end':len(text),'kind':run['kind']})
            previous_right=max(previous_right or 0,max(c['x1'] for c in run['chars']))
        for run in attached.get(-1,[]):add_run(run)
        for i,c in enumerate(main):
            spacing=max(.8,(base_size if mathematical else min(local_size,previous_size,c['size']))*.18)
            if previous_right is not None and c['x0']-previous_right>spacing and text and not text.endswith(' ') and not c['text'].isspace():
                text+=' '
            text+=normalized_text(c['text'])
            previous_right=max(previous_right or 0,c['x1'])
            previous_size=c['size']
            for run in attached.get(i,[]):add_run(run)
        output.append({'text':text,'chars':cs,'inline_styles':styles})
    return output


def prose_words(line):
    # PDF glyph arrays often have no explicit space glyph. Counting concatenated
    # glyphs would turn a whole English sentence into one word.
    plain=line.get('text')
    if plain is None:
        plain='';right=None
        for c in sorted(line['chars'],key=lambda c:c['x0']):
            if right is not None and c['x0']-right>max(.8,c['size']*.18):plain+=' '
            plain+=c['text']
            right=c['x1']
    plain=BAD_GLYPH.sub(' ',plain)
    return re.findall(r'[A-Za-z]{3,}',plain)


def formula_regions(lines, base_size, width, height):
    """Display equations own their adjacent limits/scripts, not surrounding prose."""
    groups=[]
    for line in lines:
        cs=line['chars'];text=line['text']
        math=any(MATH_FONT.search(c['fontname']) for c in cs) or re.search(r'[=∑∫√≤≥]|\(cid:',text)
        math_count=sum(bool(MATH_FONT.search(c['fontname']) or re.search(r'[=∑∫√≤≥]',c['text'])) for c in cs if c['text'].strip())
        density=math_count/max(1,sum(bool(c['text'].strip()) for c in cs))
        words=prose_words(line)
        display=not words or density>.35 or re.search(r'\(\d+\)\s*$',text)
        if math and len(words)<3 and display:
            b=union([c['_source_bbox'] for c in cs])
            if groups and groups[-1] and 0 <= b[1]-groups[-1][3] < base_size*1.4:
                groups[-1]=union([groups[-1],b])
            elif groups and groups[-1] and intersects(groups[-1],b,base_size*.3):
                groups[-1]=union([groups[-1],b])
            else:
                groups.append(b)
        # A real prose line breaks a multi-line display region.
        elif groups:
            groups.append(None)
    return [{'bbox':clamp([b[0]-2,b[1]-2,b[2]+2,b[3]+2],width,height),
             'reason':'formula_not_structurally_verified'} for b in groups if b]
