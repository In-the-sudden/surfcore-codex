"""Locate a bounded song opening with local Demucs and Whisper models."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

import numpy as np
import soundfile as sf
from scipy.ndimage import binary_closing, binary_opening
from scipy.signal import resample_poly


MAX_ANALYSIS_SECONDS = 100
HOP_SECONDS = 0.02
MODEL_SHA256 = "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4"
METHOD = "demucs-whisper-base-dtw-v1"


class TimingUnavailable(ValueError):
    pass


def local_file(value):
    path = Path(value)
    if not path.is_absolute() or str(path).startswith(("\\\\", "//")):
        raise TimingUnavailable("Expected an absolute local file")
    path = path.resolve(strict=True)
    if not path.is_file():
        raise TimingUnavailable("Expected a regular local file")
    return path


def bounded_audio(path):
    if path.suffix.lower() != ".wav" or path.stat().st_size > 40 * 1024 * 1024:
        raise TimingUnavailable("Timing input must be a bounded WAV file")
    info = sf.info(path)
    if (info.samplerate not in (16000, 22050, 44100, 48000)
            or info.channels not in (1, 2)
            or not 1 <= info.duration <= MAX_ANALYSIS_SECONDS + 0.01):
        raise TimingUnavailable("Timing input layout or duration is unsupported")
    samples, rate = sf.read(path, dtype="float32", always_2d=True)
    if not np.isfinite(samples).all() or np.max(np.abs(samples)) < 0.0001:
        raise TimingUnavailable("Timing input is silent or invalid")
    return samples, rate


def separate_vocals(samples, rate, voice_root, work_directory):
    import torch

    root = voice_root / "song-xiaoxiaoqiji"
    manifest = json.loads((root / "model-manifest.json").read_text("utf-8"))
    asset = manifest.get("asset", {})
    if (not manifest.get("complete") or asset.get("sha256") != MODEL_SHA256
            or Path(asset.get("filename", "")).name != asset.get("filename")):
        raise TimingUnavailable("The pinned local Demucs model is unavailable")
    checkpoint = local_file(root / "models" / asset["filename"])
    with checkpoint.open("rb") as checkpoint_file:
        checksum = hashlib.file_digest(checkpoint_file, "sha256").hexdigest()
    if (checkpoint.stat().st_size != asset.get("bytes")
            or checksum != MODEL_SHA256):
        raise TimingUnavailable("The local Demucs checksum does not match")
    sys.path.insert(0, str(root / "demucs-v4.0.1"))
    from demucs.apply import apply_model
    from demucs.audio import convert_audio
    from demucs.states import load_model

    torch.set_num_threads(min(6, os.cpu_count() or 1))
    torch.manual_seed(42)
    package = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = load_model(package, strict=True).eval().cpu()
    wave = convert_audio(torch.from_numpy(samples.T.copy()), rate, model.samplerate, model.audio_channels)
    reference = wave.mean(0)
    offset, scale = reference.mean(), reference.std()
    if not torch.isfinite(scale) or scale <= 1e-8:
        raise TimingUnavailable("Timing input has no measurable audio")
    normalized = (wave - offset) / scale
    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        with torch.inference_mode():
            stems = apply_model(model, normalized[None], device=device, shifts=0,
                                split=True, overlap=0.25, progress=False,
                                num_workers=0, segment=min(6, model.segment))[0].cpu()
    except (torch.cuda.OutOfMemoryError, RuntimeError) as error:
        if device != "cuda" or "out of memory" not in str(error).lower():
            raise
        model.cpu()
        torch.cuda.empty_cache()
        device = "cpu"
        with torch.inference_mode():
            stems = apply_model(model, normalized[None], device=device, shifts=0,
                                split=True, overlap=0.25, progress=False,
                                num_workers=0, segment=min(6, model.segment))[0].cpu()
    vocals = (stems[model.sources.index("vocals")] * scale + offset).T.numpy()
    mixture = wave.T.numpy()
    if not np.isfinite(vocals).all():
        raise TimingUnavailable("Demucs returned invalid vocal samples")
    sf.write(work_directory / "timing-vocals.wav", vocals, model.samplerate, subtype="FLOAT")
    return vocals, mixture, model.samplerate, device


def activity(vocals, mixture, rate):
    hop = round(rate * HOP_SECONDS)
    frames = min(len(vocals), len(mixture)) // hop
    if frames < 50:
        raise TimingUnavailable("Not enough samples to detect a sustained vocal")
    vocal_rms = np.sqrt(np.mean(vocals[:frames * hop].reshape(frames, hop, -1) ** 2, axis=(1, 2)))
    mixture_rms = np.sqrt(np.mean(mixture[:frames * hop].reshape(frames, hop, -1) ** 2, axis=(1, 2)))
    threshold = max(0.003, float(np.quantile(vocal_rms, 0.9)) * 0.06)
    ratio = vocal_rms / np.maximum(mixture_rms, 0.00001)
    mask = (vocal_rms >= threshold) & (ratio >= 0.12)
    # Join consonant-sized gaps, then discard isolated separation transients.
    mask = binary_closing(mask, structure=np.ones(8, dtype=bool))
    mask = binary_opening(mask, structure=np.ones(9, dtype=bool))
    changes = np.diff(np.r_[False, mask, False].astype(int))
    intervals = list(zip(np.flatnonzero(changes == 1) * HOP_SECONDS,
                         np.flatnonzero(changes == -1) * HOP_SECONDS))
    intervals = [(float(start), float(end)) for start, end in intervals if end - start >= 0.24]
    if not intervals:
        raise TimingUnavailable("The separated stem has no sustained vocal activity")
    return intervals, mask, vocal_rms, ratio, threshold


def fallback_segments(intervals, mask, duration):
    candidates = []
    for first_index, (vocal_start, _) in enumerate(intervals):
        previous_end = intervals[first_index - 1][1] if first_index else 0
        leading_pause = vocal_start - previous_end
        if leading_pause < 0.35:
            continue
        start = round(max(0, vocal_start - min(0.6, leading_pause / 2)), 3)
        endings = []
        for index in range(first_index, len(intervals)):
            pause_start = intervals[index][1]
            pause_end = intervals[index + 1][0] if index + 1 < len(intervals) else duration
            gap = pause_end - pause_start
            if gap < 0.35:
                continue
            end = round(min(duration, pause_start + min(0.1, gap / 3)), 3)
            if not 20 <= end - start <= 40:
                continue
            first_frame = max(0, round(start / HOP_SECONDS))
            last_frame = min(len(mask), round(end / HOP_SECONDS))
            support = float(mask[first_frame:last_frame].mean()) if last_frame > first_frame else 0
            if support >= 0.4:
                endings.append({"start": start, "end": end, "vocalSupport": round(support, 4),
                                "startGap": round(leading_pause, 3), "endGap": round(gap, 3)})
        if endings:
            candidates.append(min(endings, key=lambda value: abs(value["end"] - start - 30)))
    return candidates


def content_text(text):
    return "".join(character for character in text if character.isalnum())


def transcription_segments(document, offset, duration):
    segments = []
    for segment in document.get("transcription", []):
        text = content_text(segment.get("text", ""))
        if len(text) < 3 or re.search(r"(.)\1{5,}", text):
            continue
        if any(word in text.lower() for word in ("music", "subtitle", "字幕", "谢谢观看", "感谢观看")):
            continue
        offsets = segment.get("offsets", {})
        start, end = offsets.get("from"), offsets.get("to")
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (start, end)):
            continue
        start, end = start / 1000 + offset, end / 1000 + offset
        if not offset <= start < end <= duration + 0.1 or end - start > 25:
            continue
        tokens = [token for token in segment.get("tokens", [])
                  if not token.get("text", "").startswith("[_") and content_text(token.get("text", ""))]
        probabilities = [token.get("p", 0) for token in tokens]
        if not probabilities or float(np.mean(probabilities)) < 0.25:
            continue
        dtw = [token.get("t_dtw", -1) / 100 + offset for token in tokens
               if isinstance(token.get("t_dtw"), (int, float)) and token["t_dtw"] >= 0 and token.get("p", 0) >= 0.2]
        segments.append({"start": start, "end": end, "text": segment["text"].strip(),
                         "probability": round(float(np.mean(probabilities)), 4),
                         "tokenTimes": [round(value, 3) for value in dtw]})
    return segments


def recognize(vocals, rate, onset, cli, model, work_directory):
    offset = max(0, onset - 0.6)
    limit = min(len(vocals) / rate, offset + 43)
    snippet = vocals[round(offset * rate):round(limit * rate)].mean(axis=1)
    divisor = math.gcd(rate, 16000)
    snippet = resample_poly(snippet, 16000 // divisor, rate // divisor)
    input_path = work_directory / "timing-asr.wav"
    output = work_directory / "timing-asr"
    sf.write(input_path, snippet, 16000, subtype="PCM_16")
    arguments = [str(cli), "-m", str(model), "-f", str(input_path), "-l", "auto", "-ng",
                 "-ojf", "-of", str(output), "-t", "6", "-nf", "-sow", "-dtw", "base", "-nfa", "-sns", "-mc", "0"]
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=90, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    (work_directory / "timing-whisper.log").write_bytes(result.stderr[-256 * 1024:])
    if result.returncode != 0:
        raise TimingUnavailable("The local Whisper model could not produce timestamps")
    document = json.loads(output.with_suffix(".json").read_text("utf-8"))
    return transcription_segments(document, offset, limit), document.get("result", {}).get("language"), offset


def select_opening(intervals, mask, vocal_rms, ratio, threshold, segments, duration):
    if not segments:
        raise TimingUnavailable("Whisper did not confirm usable singing or speech")
    onset = intervals[0][0]
    first = segments[0]
    anchors = first["tokenTimes"] or [first["start"]]
    if (first["start"] > onset + 2 or not any(onset - 0.4 <= value <= onset + 2.5 for value in anchors)
            or first["end"] < onset + 0.5):
        raise TimingUnavailable("The earliest vocal activity was not confirmed by local speech timestamps")
    # Require voiced energy beneath the recognized words, not an ASR-only hallucination.
    support_start = max(0, round(max(first["start"], onset) / HOP_SECONDS))
    support_end = min(len(mask), round(first["end"] / HOP_SECONDS))
    support = float(mask[support_start:support_end].mean()) if support_end > support_start else 0
    if support < 0.4 or first["probability"] < 0.25:
        raise TimingUnavailable("Recognized text lacks sustained separated-vocal support")
    target = onset + 30
    clip_start = max(0, onset - 1)
    candidates = []
    for index, (start, end) in enumerate(intervals[:-1]):
        next_start = intervals[index + 1][0]
        gap = next_start - end
        if (gap < 0.18 or end < onset + 18 or end - clip_start > 39.9
                or end > duration - 0.12):
            continue
        boundary_distance = min(abs(segment["end"] - end) for segment in segments)
        if boundary_distance > 1.1:
            continue
        if not any(segment["start"] < end and segment["end"] >= end - 1.1 for segment in segments):
            continue
        tail = min(0.1, gap / 3)
        phrase_end = round(end + tail, 3)
        candidates.append({"phraseEnd": phrase_end, "pauseStart": round(end, 3),
                           "pauseEnd": round(next_start, 3), "asrDistance": round(boundary_distance, 3),
                           "score": abs(phrase_end - target) + boundary_distance * 0.25})
    if not candidates:
        raise TimingUnavailable("No complete vocal phrase with an audible pause was confirmed near thirty seconds")
    chosen = min(candidates, key=lambda candidate: candidate["score"])
    if chosen["phraseEnd"] - clip_start > 40:
        raise TimingUnavailable("The confirmed phrase exceeds the forty-second clip limit")
    return {"opening": {"vocalStart": round(onset, 3), "phraseEnd": chosen["phraseEnd"]},
            "confidence": {"level": "supported", "asrProbability": first["probability"],
                           "vocalSupport": round(support, 4)},
            "evidence": {"vocalThreshold": round(threshold, 7), "frameSeconds": HOP_SECONDS,
                         "firstRecognizedSegment": first, "selectedPause": chosen,
                         "activityIntervals": [[round(start, 3), round(end, 3)] for start, end in intervals],
                         "recognizedSegments": segments}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--work-directory", required=True, type=Path)
    parser.add_argument("--voice-root", required=True, type=Path)
    parser.add_argument("--whisper-cli", type=Path, default=os.environ.get("SURFCORE_WHISPER_CLI"))
    parser.add_argument("--whisper-model", type=Path, default=os.environ.get("SURFCORE_WHISPER_MODEL"))
    args = parser.parse_args()
    started = time.perf_counter()
    report = {"method": METHOD, "status": "unavailable"}
    fallback = []
    try:
        source = local_file(args.input)
        root = args.voice_root.resolve(strict=True)
        work_directory = args.work_directory.resolve(strict=True)
        if not work_directory.is_dir() or not work_directory.is_relative_to(root):
            raise TimingUnavailable("The timing workspace must be inside the voice directory")
        samples, rate = bounded_audio(source)
        duration = len(samples) / rate
        vocals, mixture, rate, device = separate_vocals(samples, rate, root, work_directory)
        intervals, mask, vocal_rms, ratio, threshold = activity(vocals, mixture, rate)
        fallback = fallback_segments(intervals, mask, duration)
        report.update({"duration": round(duration, 3), "device": device,
                       "models": {"separation": "htdemucs", "separationSha256": MODEL_SHA256,
                                  "recognition": "whisper.cpp-base-dtw"}})
        onset = intervals[0][0]
        if onset > duration - 20:
            raise TimingUnavailable("The bounded analysis window does not include a complete opening phrase")
        whisper_root = root / 'whisper'
        cli = local_file(args.whisper_cli or whisper_root / 'bin' / 'Release' / 'whisper-cli.exe')
        model = local_file(args.whisper_model or whisper_root / 'ggml-base.bin')
        if "base" not in model.name.lower():
            raise TimingUnavailable("This timestamp implementation expects the local Whisper base model")
        segments, language, asr_offset = recognize(vocals, rate, onset, cli, model, work_directory)
        report.update(select_opening(intervals, mask, vocal_rms, ratio, threshold, segments, duration))
        report.update({"status": "detected", "language": language, "asrOffset": round(asr_offset, 3)})
        return 0
    except Exception as error:
        report["error"] = str(error)[:800]
        if fallback:
            report.update({"status": "partial", "fallbackSegments": fallback})
            return 0
        return 2
    finally:
        report["elapsedSeconds"] = round(time.perf_counter() - started, 3)
        print(json.dumps(report, ensure_ascii=True, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
