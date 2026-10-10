#!/usr/bin/env python3
"""One offline CPU formula inference. Input paths come only from FormulaService."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sys
import tempfile
import threading
import time

# Only the lightweight discovery module is imported from the checkout. Model
# packages remain confined to this disposable child and its registered venv.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def sha(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024**2), b""):
            value.update(chunk)
    return value.hexdigest()


def atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix=".formula-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def offline_guard():
    def audit(event, args):
        if event in {"socket.connect", "socket.bind", "socket.getaddrinfo", "socket.sendto"}:
            raise RuntimeError("Formula recognition is offline; network access is prohibited.")
        if event in {"subprocess.Popen", "os.system", "os.posix_spawn"}:
            raise RuntimeError("Formula recognition cannot launch other processes.")
    sys.addaudithook(audit)
    # Installed before any inference imports, in addition to local/offline env.
    def blocked(*args, **kwargs):
        raise RuntimeError("Formula recognition is offline.")
    socket.create_connection = blocked


def watch_parent(parent):
    def watch():
        while True:
            if os.getppid() != parent:
                os.killpg(os.getpgrp(), signal.SIGKILL)
            time.sleep(.5)
    threading.Thread(target=watch, daemon=True).start()


def recognize(request):
    started = time.monotonic()
    identity = request["identity"]
    crop = Path(request["crop"])
    if (not crop.is_file() or not 0 < crop.stat().st_size == request["bytes"] <= 16 * 1024**2
            or sha(crop) != request["crop_sha256"]):
        raise ValueError("Crop size/checksum changed.")
    from wise_reader.pdf_lab.adapters.mineru_runtime import discover_mineru_runtime, verify_runtime_files
    runtime = discover_mineru_runtime()
    if runtime.identity != identity["runtime_identity"]:
        raise ValueError("Formula runtime identity changed.")
    verification = verify_runtime_files(runtime, [Path(request["model"]), Path(request["config"])])
    import onnxruntime as ort
    sessions = []
    original = ort.InferenceSession

    class CPUOnlySession(original):
        def __init__(self, path_or_bytes, *args, **kwargs):
            names = [p[0] if isinstance(p, tuple) else p for p in kwargs.get("providers", [])]
            if names != ["CPUExecutionProvider"] or Path(path_or_bytes).resolve() != Path(request["model"]).resolve():
                raise RuntimeError("Only the pinned formula model on CPU is permitted.")
            options = kwargs.get("sess_options") or (args[0] if args else None)
            if options is None or (options.intra_op_num_threads, options.inter_op_num_threads) != (4, 1):
                raise RuntimeError("CPU thread limits must be 4/1.")
            super().__init__(path_or_bytes, *args, **kwargs)
            if self.get_providers() != ["CPUExecutionProvider"]:
                raise RuntimeError("Unexpected execution provider.")
            sessions.append({"providers": self.get_providers(), "intra_threads": 4, "inter_threads": 1})

    ort.InferenceSession = CPUOnlySession
    import numpy as np
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 16_000_000
    from mineru.model.mfr.pp_formulanet_plus_m_onnx import PPFormulaNetPlusMONNX
    imported = time.monotonic()
    with Image.open(crop) as image:
        if (image.size != (request["width_px"], request["height_px"])
                or not 0 < image.width * image.height <= 16_000_000
                or getattr(image, "n_frames", 1) != 1):
            raise ValueError("Crop geometry or frame count is invalid.")
        rgb = np.asarray(image.convert("RGB"))
    model = PPFormulaNetPlusMONNX(request["model"], request["config"], device="cpu", intra_op_num_threads=4)
    initialized = time.monotonic()
    prediction = model.predict([{"label": "display_formula", "bbox": [0, 0, rgb.shape[1], rgb.shape[0]]}],
                               rgb, batch_size=1, interline_enable=True)
    latex = prediction[0].get("latex") if isinstance(prediction, list) and prediction else None
    if not isinstance(latex, str) or not 0 < len(latex.strip()) <= 65536:
        raise ValueError("Formula prediction is empty or exceeds the output budget.")
    if not sessions:
        raise RuntimeError("No verified CPU inference session was used.")
    return {"status": "completed", "identity": identity, "latex": latex.strip(), "sessions": sessions,
            "verification": verification,
            "timings": {"prepare_s": round(imported - started, 3), "model_s": round(initialized - imported, 3),
                        "inference_s": round(time.monotonic() - initialized, 3),
                        "total_s": round(time.monotonic() - started, 3)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    offline_guard()
    try:
        if args.input.stat().st_size > 64 * 1024:
            raise ValueError("Formula request exceeds the budget.")
        request = json.loads(args.input.read_text())
        watch_parent(request["parent_pid"])
        with Path(request["lock"]).open("a+") as lock:
            # The service waits before spawning. If another import wins the
            # small handoff race, wait here within the parent's enforced timeout.
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = recognize(request)
        atomic_json(args.output, result)
        return 0
    except Exception as exc:
        # Full diagnostics stay in the private worker artifact, never the API.
        atomic_json(args.output, {"status": "failed", "error": {"code": "formula_worker_failed",
                                                                  "type": type(exc).__name__, "message": str(exc)[:2000]}})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
