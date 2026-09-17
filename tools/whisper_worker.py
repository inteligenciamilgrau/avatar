# Persistent Faster-Whisper worker. JSONL on stdin, JSONL on stdout.
import glob
import json
import os
import sys
import traceback

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)

ALLOWED = {
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    "large-v2",
    "large-v3",
    "large-v3-turbo",
    "turbo",
    "distil-large-v3",
    "distil-small.en",
}

MODEL = None
MODEL_NAME = None
DEVICE = None
COMPUTE = None
CUDA_DIRS = []

CPU_THREADS = max(2, min(8, (os.cpu_count() or 4) // 2))


def site_package_roots():
    roots = []
    try:
        import site

        roots.extend(site.getsitepackages())
        try:
            roots.append(site.getusersitepackages())
        except Exception:
            pass
    except Exception:
        pass
    # Sibling virtualenvs: CUDA runtimes often live in whichever venv has torch installed.
    parent = os.path.dirname(sys.prefix)
    if os.path.isdir(parent):
        try:
            for name in sorted(os.listdir(parent)):
                sp = os.path.join(parent, name, "Lib", "site-packages")
                if os.path.isdir(sp):
                    roots.append(sp)
        except Exception:
            pass
    return roots


def find_cuda_dirs():
    """ctranslate2 needs cuBLAS and cuDNN next to it. They ship inside pip packages
    (nvidia-cublas-cu12, nvidia-cudnn-cu12) or bundled with torch, so collect whichever
    folders actually carry the DLLs."""
    found = []
    seen = set()

    def take(folder):
        if not folder or not os.path.isdir(folder):
            return
        key = os.path.normcase(os.path.abspath(folder))
        if key in seen:
            return
        seen.add(key)
        found.append(os.path.abspath(folder))

    for p in os.environ.get("WHISPER_CUDA_DLL_DIR", "").split(os.pathsep):
        take(p.strip())

    # Os wheels da NVIDIA usam bin/ no Windows e lib/ no Linux; o torch junta tudo em lib/.
    patterns = [
        ("nvidia", "*", "bin"),
        ("nvidia", "*", "lib"),
        ("torch", "lib"),
    ]
    libs = ("cublas64_*.dll", "cudnn64_*.dll", "libcublas.so*", "libcudnn.so*")
    for root in site_package_roots():
        for parts in patterns:
            for sub in sorted(glob.glob(os.path.join(root, *parts))):
                if any(glob.glob(os.path.join(sub, pat)) for pat in libs):
                    take(sub)

    return found


def register_cuda_dirs():
    """LoadLibrary inside ctranslate2 searches PATH, not the add_dll_directory list,
    so both have to be set."""
    global CUDA_DIRS
    CUDA_DIRS = find_cuda_dirs()
    if not CUDA_DIRS:
        return
    os.environ["PATH"] = os.pathsep.join(CUDA_DIRS) + os.pathsep + os.environ.get("PATH", "")
    if hasattr(os, "add_dll_directory"):
        for d in CUDA_DIRS:
            try:
                os.add_dll_directory(d)
            except Exception:
                pass
    sys.stderr.write("whisper cuda dirs: %s\n" % " | ".join(CUDA_DIRS))
    sys.stderr.flush()


register_cuda_dirs()


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def smoke_test(model):
    """A WhisperModel builds fine on CUDA even when cuBLAS is missing -- the failure only
    surfaces on the first real inference. One tiny encode here keeps a broken GPU setup
    from falling over mid-conversation."""
    import numpy as np

    segments, _ = model.transcribe(
        np.zeros(16000, dtype="float32"),
        language="en",
        beam_size=1,
        vad_filter=False,
        without_timestamps=True,
        condition_on_previous_text=False,
    )
    for _ in segments:
        break


def load_model(name, device_pref="auto"):
    global MODEL, MODEL_NAME, DEVICE, COMPUTE
    from faster_whisper import WhisperModel

    name = str(name or "small").strip() or "small"
    if name not in ALLOWED:
        name = "small"
    device_pref = (device_pref or "auto").lower()
    attempts = []
    if device_pref in ("auto", "cuda"):
        attempts.extend([("cuda", "float16"), ("cuda", "int8_float16"), ("cuda", "int8")])
    if device_pref in ("auto", "cpu"):
        attempts.append(("cpu", "int8"))

    last_err = None
    seen = set()
    for device, compute in attempts:
        key = (device, compute)
        if key in seen:
            continue
        seen.add(key)
        try:
            sys.stderr.write("whisper load %s %s %s\n" % (name, device, compute))
            sys.stderr.flush()
            kwargs = {"device": device, "compute_type": compute}
            if device == "cpu":
                kwargs["cpu_threads"] = CPU_THREADS
            candidate = WhisperModel(name, **kwargs)
            smoke_test(candidate)
            MODEL = candidate
            MODEL_NAME = name
            DEVICE = device
            COMPUTE = compute
            return {"ok": True, "model": name, "device": device, "compute": compute}
        except Exception as e:
            last_err = e
            sys.stderr.write("whisper fail %s %s: %s\n" % (device, compute, e))
            sys.stderr.flush()
            MODEL = None
    err = str(last_err or "nao carregou o Faster Whisper")
    if "cublas" in err.lower() or "cudnn" in err.lower():
        err += " (sem CUDA: instale nvidia-cublas-cu12 e nvidia-cudnn-cu12, ou aponte WHISPER_CUDA_DLL_DIR para a pasta das DLLs)"
    return {"ok": False, "error": err}


def transcribe(path, language):
    if MODEL is None:
        loaded = load_model(MODEL_NAME or "small", "auto")
        if not loaded.get("ok"):
            return loaded
    if not path or not os.path.isfile(path):
        return {"ok": False, "error": "arquivo de audio ausente"}
    lang = (language or "pt").strip().lower()
    if lang in ("", "auto", "detect"):
        lang = None
    elif len(lang) > 8:
        lang = "pt"
    segments, info = MODEL.transcribe(
        path,
        language=lang,
        beam_size=3,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        without_timestamps=True,
        condition_on_previous_text=False,
    )
    parts = []
    for seg in segments:
        t = (seg.text or "").strip()
        if t:
            parts.append(t)
    text = " ".join(parts).strip()
    detected = getattr(info, "language", None) or lang or ""
    duration = float(getattr(info, "duration", 0) or 0)
    return {
        "ok": True,
        "text": text,
        "language": detected,
        "duration": duration,
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute": COMPUTE,
    }


def status():
    return {
        "ok": True,
        "ready": MODEL is not None,
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute": COMPUTE,
        "cuda": bool(CUDA_DIRS),
    }


def handle(msg):
    cmd = str(msg.get("cmd") or "").lower()
    if cmd == "ping":
        return status()
    if cmd == "load":
        return load_model(msg.get("model") or "small", msg.get("device") or "auto")
    if cmd == "transcribe":
        return transcribe(msg.get("path"), msg.get("language") or "pt")
    if cmd == "quit":
        return {"ok": True, "bye": True}
    return {"ok": False, "error": "comando desconhecido"}


def main():
    reply({"ok": True, "event": "hello", "ready": False})
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        req_id = None
        try:
            msg = json.loads(line)
            req_id = msg.get("id")
            out = handle(msg)
        except Exception as e:
            out = {"ok": False, "error": str(e), "trace": traceback.format_exc()[-400:]}
        if req_id is not None:
            out["id"] = req_id
        reply(out)
        if out.get("bye"):
            break


if __name__ == "__main__":
    main()
