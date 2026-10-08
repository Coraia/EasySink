#!/usr/bin/env python3
"""Bounded offline GLM-OCR full-page measurement, independent of family67 service."""
from __future__ import annotations
import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
import time


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda: f.read(1024*1024), b''):
            h.update(data)
    return h.hexdigest()


def atomic(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    with temp.open('w', encoding='utf8') as f:
        json.dump(value, f, ensure_ascii=False, allow_nan=False)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(path)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    started = time.perf_counter()
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--model', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--pages', default='46,100,300')
    p.add_argument('--deadline', type=float, default=190)
    p.add_argument('--page-deadline', type=float, default=60)
    p.add_argument('--max-tokens', type=int, default=4096)
    p.add_argument('--max-side', type=int, default=2200)
    args = p.parse_args()
    numbers = sorted(set(int(n) for n in args.pages.split(',')))
    if not numbers or min(numbers)<1 or len(numbers)>3 or not 1<=args.deadline<=210 or not 1<=args.page_deadline<=90 or not 1<=args.max_tokens<=4096 or not 512<=args.max_side<=2200:
        raise ValueError('Unbounded settings')
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output/'raw').mkdir()
    cache = args.output/'cache'
    for key in ['HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_HUB_DISABLE_TELEMETRY']:
        os.environ[key]='1'
    for key in ['HF_HOME','XDG_CACHE_HOME','TORCH_HOME']:
        os.environ[key]=str(cache/key.lower())
    os.environ['OMP_NUM_THREADS']='2'
    os.environ['TOKENIZERS_PARALLELISM']='false'
    original_socket = socket.socket
    class OfflineSocket(original_socket):
        def connect(self, address):
            if self.family in (socket.AF_INET, socket.AF_INET6):
                raise RuntimeError('Network is disabled for document inference')
            return super().connect(address)
        def connect_ex(self, address):
            if self.family in (socket.AF_INET, socket.AF_INET6):
                raise RuntimeError('Network is disabled for document inference')
            return super().connect_ex(address)
    socket.socket=OfflineSocket
    metadata={'source_sha256':digest(args.source), 'runner_sha256':digest(Path(__file__)),
              'model_files':{q.name:{'sha256':digest(q),'bytes':q.stat().st_size} for q in sorted(args.model.iterdir()) if q.is_file()},
              'pages_requested':numbers,'layout_enabled':False,'prompt':'Text Recognition:',
              'settings':{'max_side':args.max_side,'max_tokens':args.max_tokens,'page_deadline':args.page_deadline,'deadline':args.deadline,'dtype':'bfloat16','attention':'sdpa','do_sample':False,'repetition_penalty':1.1},
              'versions':{n:importlib.metadata.version(n) for n in ('torch','transformers','pymupdf','pillow')}}
    atomic(args.output/'manifest.json',metadata)
    emit({'event':'loading','source_sha256':metadata['source_sha256']})
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import pymupdf
        from PIL import Image
        from transformers import AutoProcessor, GlmOcrForConditionalGeneration, StoppingCriteria, StoppingCriteriaList
        torch.set_num_threads(2)
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError('CUDA bfloat16 unavailable')
        processor=AutoProcessor.from_pretrained(str(args.model), local_files_only=True, trust_remote_code=False)
        model=GlmOcrForConditionalGeneration.from_pretrained(str(args.model), torch_dtype=torch.bfloat16, attn_implementation='sdpa', local_files_only=True, trust_remote_code=False).to('cuda:0').eval()
        torch.cuda.synchronize()
    metadata['init_ms']=round((time.perf_counter()-started)*1000,3)
    metadata['gpu']=torch.cuda.get_device_name(0)
    atomic(args.output/'manifest.json',metadata)
    emit({'event':'ready','init_ms':metadata['init_ms'],'gpu':metadata['gpu']})
    doc=pymupdf.open(args.source)
    if max(numbers)>len(doc):
        raise ValueError('Source page out of range')
    summaries=[]
    for number in numbers:
        if time.perf_counter()-started>=args.deadline:
            break
        page_start=time.perf_counter()
        page=doc[number-1]
        width,height=page.rect.width,page.rect.height
        scale=min(1.,args.max_side/max(width,height))
        pix=page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),colorspace=pymupdf.csRGB,alpha=False)
        im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
        image_path=args.output/'raw'/f'p{number:06d}-input.png'
        im.save(image_path)
        rendered=time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            template=processor.apply_chat_template([{'role':'user','content':[{'type':'image'},{'type':'text','text':'Text Recognition:'}]}],tokenize=False,add_generation_prompt=True)
            inputs=processor(text=template,images=im,return_tensors='pt').to('cuda:0',torch.bfloat16)
            input_count=inputs['input_ids'].shape[-1]
            operation_end=min(started+args.deadline,time.perf_counter()+args.page_deadline)
            class DeadlineStop(StoppingCriteria):
                def __call__(self,input_ids,scores,**kwargs):
                    return time.perf_counter()>=operation_end
            prepared=time.perf_counter()
            with torch.inference_mode():
                output=model.generate(**inputs,do_sample=False,max_new_tokens=args.max_tokens,repetition_penalty=1.1,stopping_criteria=StoppingCriteriaList([DeadlineStop()]))
            torch.cuda.synchronize()
            generated=time.perf_counter()
            tokens=output[0][input_count:]
            token_ids=tokens.detach().cpu().tolist()
            text=processor.decode(tokens,skip_special_tokens=True)
        eos=model.generation_config.eos_token_id
        eos=eos if isinstance(eos,list) else [eos]
        is_eos=bool(token_ids) and token_ids[-1] in eos
        reason='eos' if is_eos else ('deadline' if generated>=operation_end else 'token_limit_or_other')
        record={'page_number':number,'source_sha256':metadata['source_sha256'],'width':width,'height':height,
                'pixel_dimensions':list(im.size),'input_sha256':digest(image_path),'text':text,'token_ids':token_ids,
                'tokens':len(token_ids),'input_tokens':input_count,'finish_reason':reason,'truncated':not is_eos,'layout_enabled':False,
                'metrics':{'render_and_save_ms':round((rendered-page_start)*1000,3),'preprocess_ms':round((prepared-rendered)*1000,3),'generation_ms':round((generated-prepared)*1000,3),'page_ms':round((time.perf_counter()-page_start)*1000,3)},
                'gpu_peak_allocated_bytes':torch.cuda.max_memory_allocated()}
        atomic(args.output/'raw'/f'p{number:06d}.json',record)
        (args.output/'raw'/f'p{number:06d}.txt').write_text(text,encoding='utf8')
        summary={k:v for k,v in record.items() if k not in ('text','token_ids')}
        summary['characters']=len(text)
        summaries.append(summary)
        emit({'event':'page_completed',**summary})
        im.close()
        del output,inputs,tokens
    doc.close()
    result={'event':'finished','requested':len(numbers),'completed':len(summaries),'pages':summaries,'elapsed_ms':round((time.perf_counter()-started)*1000,3),'init_ms':metadata['init_ms']}
    atomic(args.output/'result.json',result)
    emit(result)
    return 0 if len(summaries)==len(numbers) and all(not s['truncated'] and s['characters'] for s in summaries) else 2


if __name__=='__main__':
    raise SystemExit(main())
