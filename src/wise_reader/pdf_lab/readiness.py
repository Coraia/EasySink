"""Bounded, read-only admission checks for the dedicated Omarchy OCR worker.

This observes installed identities and current GPU resources, not inference or
quality. It never switches llm-switch slots, reserves GPU memory or loads models.
"""
from __future__ import annotations

import json
import shlex
import subprocess
import time

OMARCHY_HEALTH_TIMEOUT_SECONDS = 5
MIN_GPU_FREE_MIB = 4096  # Admission headroom for two workers; not a peak-memory claim.

_OMARCHY_HEALTH = r'''
import ast, importlib.metadata, json, subprocess, time
from pathlib import Path
root = Path.home() / 'apps' / 'wise-reader-ocr'
health = {'state': 'unavailable', 'code': 'dependency_not_ready',
          'message': 'Omarchy 的专用 OCR 依赖或模型未准备好。', 'checked_at': time.time(),
          'engine': 'rapidocr', 'model': 'PP-OCRv6_rec_medium', 'minimum_free_mib': 4096}
try:
    health['versions'] = {name: importlib.metadata.version(name)
                          for name in ('rapidocr', 'onnxruntime-gpu', 'pypdfium2')}
    for name in ('omarchy_ocr_probe.py', 'omarchy_ocr_parallel.py', 'omarchy_ocr_bench.py'):
        if not (root / name).is_file():
            raise ValueError('dedicated_runner_missing')
    model_dir = Path(importlib.metadata.distribution('rapidocr').locate_file('rapidocr/models'))
    required = {model_dir / 'PP-OCRv6_det_small.onnx': 9929594,
                model_dir / 'PP-OCRv6_rec_small.onnx': 21234383,
                model_dir / 'ch_ppocr_mobile_v2.0_cls_mobile.onnx': 585532,
                root / 'models' / 'PP-OCRv6_rec_medium.onnx': 76629984}
    if any(not path.is_file() or path.stat().st_size != size for path, size in required.items()):
        raise ValueError('pinned_model_missing_or_changed')
    # Read constants without executing the probe or hashing/loading its weights.
    constants = {}
    for node in ast.parse((root / 'omarchy_ocr_probe.py').read_text()).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in ('PROTOCOL_VERSION', 'MEDIUM_SHA256', 'SETTINGS'):
                constants[node.targets[0].id] = ast.literal_eval(node.value)
    expected = {'workers': 2, 'device': 'cuda', 'max_side': 2200, 'det_side': 736,
                'rec_batch': 64, 'text_score': 0.0, 'use_cls': False, 'max_retries': 1,
                'language': 'chinese_cht', 'deadline_seconds': 600,
                'page_timeout_seconds': 15, 'engine_start_timeout_seconds': 30}
    if (constants.get('PROTOCOL_VERSION') != 1 or constants.get('SETTINGS') != expected or
            constants.get('MEDIUM_SHA256') != 'eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b'):
        raise ValueError('dedicated_configuration_changed')
    health.update(code='gpu_unavailable', message='Omarchy 的 GPU 驱动暂不可用，请恢复后重新检查。')
    gpu_result = subprocess.run(['nvidia-smi', '--id=0',
        '--query-gpu=name,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
        capture_output=True, text=True, timeout=1.5, check=True)
    fields = [value.strip() for value in gpu_result.stdout.strip().split(',')]
    name, total, free, utilization = fields
    gpu = {'name': name, 'total_mib': int(total), 'free_mib': int(free), 'utilization_percent': int(utilization)}
    if not 0 <= gpu['free_mib'] <= gpu['total_mib'] or not 0 <= gpu['utilization_percent'] <= 100:
        raise ValueError('invalid_gpu_snapshot')
    health['gpu'] = gpu
    # llm-switch starts these mutually exclusive slots. Catch the loading phase
    # as well as memory already allocated; do not run llm-switch itself.
    slots = ['llama-server', 'llama-server-q4km', 'llama-server-unc', 'llama-server-unclong',
             'llama-server-uncv', 'llama-server-vlong', 'tabby', 'comfyui', 'vllm-vl', 'glm-ocr-67']
    health.update(code='service_state_unknown', message='尚未确认 Omarchy 的 GPU 服务占用，请重新检查。')
    services = subprocess.run(['systemctl', '--user', 'show', '--property=Id', '--property=ActiveState',
                              *[name + '.service' for name in slots]],
                             capture_output=True, text=True, timeout=1.5, check=True)
    occupied = []
    for record in services.stdout.strip().split('\n\n'):
        values = dict(line.split('=', 1) for line in record.splitlines() if '=' in line)
        if values.get('ActiveState') in ('active', 'activating', 'reloading', 'deactivating'):
            occupied.append(values.get('Id', '').removesuffix('.service'))
    health['active_gpu_services'] = occupied
    if occupied:
        health.update(state='busy', code='gpu_service_busy',
                      message='Omarchy 的 GPU 正由其他模型服务使用或启动中。请释放该服务后重新检查，或改用当前电脑。')
    elif gpu['free_mib'] < health['minimum_free_mib']:
        health.update(state='busy', code='gpu_memory_busy',
                      message='Omarchy 空闲显存不足，暂不能启动 OCR。请释放显存后重新检查，或改用当前电脑。')
    else:
        health.update(state='ready', code='ready', message='专用 OCR 模型与 GPU 启动条件已就绪。')
except Exception as error:
    health['diagnostic'] = type(error).__name__ + ': ' + str(error)[:240]
    if isinstance(error, subprocess.TimeoutExpired):
        health.update(state='unknown', code='probe_timeout', message='Omarchy 状态检查超时，请重新检查。')
print(json.dumps(health, ensure_ascii=False))
'''


def omarchy_capability(digital_ready):
    began = time.monotonic()
    value = {'id': 'omarchy', 'label': 'Omarchy OCR (your remote computer)',
             'available': False, 'missing_reason': None, 'supports_ocr': True,
             'supports_ranges': False, 'external_to_current_computer': True,
             'requires_explicit_selection': True, 'host': 'omarchy', 'paid': False,
             'probe_scope': 'installed pinned model/configuration + live GPU memory/driver and service state; no inference',
             'probe_timeout_seconds': OMARCHY_HEALTH_TIMEOUT_SECONDS}
    health = {'state': 'unknown', 'code': 'service_unreachable', 'checked_at': time.time(),
              'message': '无法连接 Omarchy，请确认它已开机并连接网络，或改用当前电脑。'}
    if not digital_ready:
        health.update(state='unavailable', code='local_renderer_missing', message='本机 PDF 组件未准备好，暂不能导入 PDF。')
    else:
        try:
            from .adapters.omarchy import HOST, REMOTE_ROOT
            command = ('"$HOME/' + REMOTE_ROOT + '/.venv/bin/python" -c ' + shlex.quote(_OMARCHY_HEALTH))
            probe = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', HOST, command],
                                   stdin=subprocess.DEVNULL, capture_output=True,
                                   timeout=OMARCHY_HEALTH_TIMEOUT_SECONDS, check=False)
            if probe.returncode or len(probe.stdout) > 16 * 1024:
                raise ValueError('Remote readiness command failed.')
            result = json.loads(probe.stdout)
            if not isinstance(result, dict) or result.get('state') not in {'ready', 'busy', 'unavailable', 'unknown'}:
                raise ValueError('Invalid readiness response.')
            if not isinstance(result.get('message'), str) or not result.get('code'):
                raise ValueError('Incomplete readiness response.')
            if result['state'] == 'ready':
                gpu = result.get('gpu', {})
                if (result.get('engine') != 'rapidocr' or result.get('model') != 'PP-OCRv6_rec_medium'
                        or not result.get('versions', {}).get('rapidocr')
                        or type(gpu.get('free_mib')) is not int or type(gpu.get('total_mib')) is not int
                        or not MIN_GPU_FREE_MIB <= gpu['free_mib'] <= gpu['total_mib']
                        or result.get('active_gpu_services') != []):
                    raise ValueError('Readiness omitted current GPU/model evidence.')
            health = result
            value['available'] = health['state'] == 'ready'
            value['version'] = health.get('versions', {}).get('rapidocr')
        except (OSError, ImportError, ValueError, TypeError, KeyError, AttributeError, subprocess.TimeoutExpired) as error:
            if isinstance(error, subprocess.TimeoutExpired):
                health.update(code='probe_timeout', message='Omarchy 状态检查超时，请重新检查或改用当前电脑。')
    health['checked_at'] = time.time()
    health['elapsed_ms'] = round((time.monotonic() - began) * 1000, 1)
    value['readiness'] = health
    value['missing_reason'] = None if value['available'] else health['message']
    return value
