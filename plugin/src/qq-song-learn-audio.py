"""Prepare and mix the bounded stems produced by the local song models."""

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf


RATE = 44100
MAX_FRAMES = RATE * 40
CONVERSION_TOLERANCE = RATE // 10


def audio(path, channels, frames=None, tolerance=0):
    info = sf.info(path)
    if (info.samplerate != RATE or info.channels != channels
            or not 0 < info.frames <= MAX_FRAMES + tolerance
            or (frames is not None and abs(info.frames - frames) > tolerance)):
        raise ValueError(f"Unexpected stem format or length: {path.name}")
    samples, _ = sf.read(path, dtype="float32", always_2d=True)
    if not np.isfinite(samples).all():
        raise ValueError(f"Invalid samples in {path.name}")
    return samples


def peak(samples):
    return float(np.max(np.abs(samples)))


def rms(samples):
    return float(np.sqrt(np.mean(np.square(samples), dtype=np.float64)))


def karaoke_gain(samples):
    level = peak(samples)
    if level < 1e-5:
        raise ValueError("Separated vocals are effectively silent")
    return min(1.0, 0.95 / level)


def prepare(clip, vocals, output):
    frames = len(audio(clip, 2))
    samples = audio(vocals, 2, frames)
    sf.write(output, samples * karaoke_gain(samples), RATE, subtype="PCM_16")


def lead(clip, vocals, karaoke_input, primary, secondary, stereo_output, mono_output):
    frames = len(audio(clip, 2))
    original_vocals = audio(vocals, 2, frames)
    normalized_vocals = audio(karaoke_input, 2, frames)
    residual = audio(primary, 2, frames)
    lead_estimate = audio(secondary, 2, frames)
    if rms(normalized_vocals - (residual + lead_estimate)) > 0.03 * rms(normalized_vocals):
        raise ValueError("Karaoke stems do not reconstruct the aligned input")
    # The KARA_2 secondary output is the main-vocal estimate for this model.
    lead_estimate /= karaoke_gain(original_vocals)
    mono = lead_estimate.mean(axis=1, keepdims=True)
    if rms(mono) < 1e-5:
        raise ValueError("Estimated main vocal is effectively silent")
    sf.write(stereo_output, lead_estimate, RATE, subtype="FLOAT")
    sf.write(mono_output, mono, RATE, subtype="FLOAT")


def mix(clip, lead_estimate, converted, output):
    original = audio(clip, 2)
    frames = len(original)
    old_lead = audio(lead_estimate, 2, frames)
    new_lead = audio(converted, 1, frames, CONVERSION_TOLERANCE)
    if len(new_lead) < frames:
        new_lead = np.pad(new_lead, ((0, frames - len(new_lead)), (0, 0)))
    new_lead = new_lead[:frames]
    source_rms = rms(old_lead.mean(axis=1))
    converted_rms = rms(new_lead)
    if min(source_rms, converted_rms) < 1e-5:
        raise ValueError("Original or converted lead is effectively silent")
    gain = source_rms / converted_rms
    if not 0.25 <= gain <= 4:
        raise ValueError("Converted lead needs more than 12 dB of gain matching")
    # Subtract only the aligned lead estimate to preserve the source's remaining mix.
    mixed = (original - old_lead + new_lead * gain).mean(axis=1)
    sf.write(output, mixed * min(1.0, 0.84 / max(peak(mixed), 1e-5)), RATE, subtype="FLOAT")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, operation, fields in (
        ("prepare", prepare, ("clip", "vocals", "output")),
        ("lead", lead, ("clip", "vocals", "karaoke_input", "primary", "secondary", "stereo_output", "mono_output")),
        ("mix", mix, ("clip", "lead_estimate", "converted", "output")),
    ):
        subparser = subparsers.add_parser(name)
        subparser.set_defaults(operation=operation)
        for field in fields:
            subparser.add_argument(field, type=Path)
    args = vars(parser.parse_args())
    operation = args.pop("operation")
    args.pop("command")
    operation(**args)


if __name__ == "__main__":
    main()
