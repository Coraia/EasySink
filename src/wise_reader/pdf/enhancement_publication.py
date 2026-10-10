"""Adopt a scoped recognition result through the existing immutable page bridge.

All provider text is data. The registered original, page identity and generation
are resolved by the caller. Partial intersections retain the prior page rather
than guessing how to delete text outside the user's authorized crop.
"""
from __future__ import annotations

import copy
import hashlib
import json
import shutil
import time
from pathlib import Path

from wise_reader.pdf_lab.worker import atomic_json, asset_holders, checked_page


def prepare_page(module, job, page):
    mapping, source = module.source_book(job["book_id"])
    number = job["scope"]["page_number"]
    region = job["scope"].get("region")
    accepted = module.store.query_one(
        "SELECT task_id FROM wr_pdf_page WHERE book_id=? AND page_number=?",
        (job["book_id"], number))
    previous = None
    old_task = None
    if accepted:
        old_task = module.originals.task(accepted["task_id"])
        result = module.workers.result(source, number, number, task_ids={old_task["id"]})
        previous = next((p for p in result["pages"] if p["page_number"] == number), None)
        if previous is None:
            raise ValueError("Previously accepted source page is unavailable; retained content was not changed.")
    incoming = copy.deepcopy(page)
    kept, kept_regions, kept_objects, insertion = [], [], [], None
    if region:
        # A crop has no authority over the rest of an unpublished page. Keep
        # its result replayable without claiming whole-page readiness.
        if previous is None:
            return None
        if any(abs(previous[k] - incoming[k]) > .1 for k in ('width', 'height')):
            return None

        def overlap(item):
            x0, y0, x1, y1 = region
            bx0, by0, bx1, by1 = item['source']['bbox']
            intersects = min(x1, bx1) > max(x0, bx0) and min(y1, by1) > max(y0, by0)
            contained = x0 - .5 <= bx0 and y0 - .5 <= by0 and bx1 <= x1 + .5 and by1 <= y1 + .5
            return intersects, contained

        for block in previous["blocks"]:
            intersects, contained = overlap(block)
            if intersects and not contained:
                return None  # Nothing outside the selected area can be discarded.
            if contained:
                if insertion is None:
                    insertion = len(kept)
            else:
                kept.append(copy.deepcopy(block))
        if insertion is None:
            # A crop in whitespace has no reliable place in the reading order.
            return None
        linked = {holder['formula_id'] for holder in asset_holders({'blocks': kept}) if holder.get('formula_id')}
        linked.update(fid for block in kept for fid in block.get('formula_ids', []))
        for name, retained in [('formula_regions', kept_regions), ('non_content_objects', kept_objects)]:
            for item in previous.get(name, []):
                intersects, contained = overlap(item)
                if intersects and (not contained or item.get('formula_id') in linked):
                    return None
                if not contained:
                    retained.append(copy.deepcopy(item))
        incoming["blocks"] = kept[:insertion] + incoming["blocks"] + kept[insertion:]
        incoming['formula_regions'] = kept_regions + incoming.get('formula_regions', [])
        incoming['non_content_objects'] = kept_objects + incoming.get('non_content_objects', [])
        for name in ('rotation', 'crop_box', 'formula_raster_target_dpi'):
            if name in previous:
                incoming[name] = copy.deepcopy(previous[name])
        incoming['warnings'] = copy.deepcopy(previous.get('warnings', [])) + incoming.get('warnings', [])
        incoming['extraction_method'] = 'mixed'
        incoming.setdefault('enhancement', {}).update(
            base_task_id=old_task['id'], base_extraction_method=previous.get('extraction_method'))
    if not incoming.get("blocks"):
        return None
    incoming["text"] = "\n\n".join(b.get("text", "") for b in incoming["blocks"])
    incoming.pop("conversion_task_id", None)
    incoming.pop("checkpoint", None)
    # A deterministic task mapping makes local replay idempotent and recoverable.
    material = json.dumps(incoming, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    task_id = hashlib.sha256(("enhancement:v2:" + job["id"] + ":" + material).encode()).hexdigest()[:32]
    task = module.originals.task(task_id)
    if not task:
        now = time.time()
        with module.originals.connect() as db:
            db.execute("INSERT OR IGNORE INTO tasks(id,book_id,state,engine,start_page,end_page,created_at,updated_at,metrics) VALUES(?,?,'running','external_vision',?,?,?,?,?)",
                       (task_id, source["id"], number, number, job.get('intent_created_at', job['created_at']), now,
                        json.dumps({'enhancement_job_id': job['id']})))
        task = module.originals.task(task_id)
    try:
        return _retain_page(module, job, incoming, source, task, old_task,
                            {'blocks': kept, 'formula_regions': kept_regions, 'non_content_objects': kept_objects})
    except BaseException:
        # A failed immutable publication must not block subsequent local work.
        module.originals.update(task['id'], state='failed', error={
            'code': 'enhancement_publication_failed', 'message': 'Publication failed; retained source and response are unchanged.'})
        raise


def _retain_page(module, job, incoming, source, task, old_task, retained):
    output = module.originals.output(task)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    old_holders = {id(holder) for holder in asset_holders(retained)}
    assets, copied = {}, {}
    for index, holder in enumerate(asset_holders(incoming)):
        holder.pop("asset_url", None)
        relative = holder.get("asset")
        if not relative:
            continue
        # Kept objects were copied from an already validated immutable page.
        old = id(holder) in old_holders
        if old:
            path = module.workers.asset_path(old_task, relative)
        else:
            path = module.enhancements.result_asset(job, relative)
        suffix = Path(path).suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise ValueError("Unsupported retained enhancement asset.")
        provenance = (old_task['id'] if old else job['id'], relative)
        target = copied.get(provenance)
        if target is None:
            target = f"assets/object-{index}{suffix}"
            (output / "assets").mkdir(exist_ok=True)
            shutil.copyfile(path, output / target)
            copied[provenance] = target
        holder["asset"] = target
        if holder.get("asset_metadata"):
            assets[target] = holder["asset_metadata"]
    incoming["assets"] = assets
    checked_page(incoming, task, source, output, incoming['page_number'])
    # Use the same immutable page/index contract as local conversions. Formula
    # lookup resolves registrations through this published task, including cache
    # reuse of unchanged crops; a monolithic schema1 result is not that contract.
    identity = hashlib.sha256(('enhancement-publication-v2:' + task['id']).encode()).hexdigest()
    incoming['checkpoint'] = {'complete': True, 'source_sha256': source['file_sha256'],
                              'processing_identity': identity}
    relative = f"pages/p{incoming['page_number']:06d}.json"
    atomic_json(output / relative, incoming)
    result = {"schema_version": 2, "engine": "external_vision", "page_count": source["page_count"],
              "source_sha256": source['file_sha256'], "processing_identity": identity,
              "settings": {"start_page": task['start_page'], "end_page": task['end_page']},
              "pages": [{"page_number": incoming['page_number'], "page_path": relative,
                         "sha256": hashlib.sha256((output / relative).read_bytes()).hexdigest()}],
              "metrics": {"enhancement_job_id": job["id"], "quality_reviewed": False}, "warnings": []}
    atomic_json(output / "result.json", result)
    return task
