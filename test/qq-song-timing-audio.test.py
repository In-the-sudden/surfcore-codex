"""Focused offline checks for the song timing evidence rules."""

import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import numpy as np
import soundfile as sf


SPEC = importlib.util.spec_from_file_location(
    "song_timing_audio", Path(__file__).parents[1] / "plugin/src/qq-song-timing-audio.py")
TIMING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TIMING)


class SongTimingEvidenceTests(unittest.TestCase):
    def test_silent_input_is_rejected_before_loading_models(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "silent.wav"
            sf.write(path, np.zeros(16000), 16000)
            with self.assertRaisesRegex(TIMING.TimingUnavailable, "silent"):
                TIMING.bounded_audio(path)

    def test_instrumental_leakage_and_short_transients_are_rejected(self):
        mixture = np.full((10000, 2), 0.2, dtype=np.float32)
        for length in (0, 80):
            with self.subTest(transient_milliseconds=length):
                vocals = np.zeros_like(mixture)
                vocals[2000:2000 + length] = 0.1
                with self.assertRaisesRegex(TIMING.TimingUnavailable, "no sustained"):
                    TIMING.activity(vocals, mixture, 1000)

    def test_asr_hallucination_and_metadata_cannot_confirm_onset(self):
        def segment(text, probability=0.8):
            return {"text": text, "offsets": {"from": 0, "to": 3000},
                    "tokens": [{"text": text, "p": probability, "t_dtw": 100}]}

        document = {"transcription": [segment("aaaaaaa"), segment("Music subtitle"),
                                      segment("a real lyric", 0.1)]}
        self.assertEqual(TIMING.transcription_segments(document, 5, 50), [])

    def test_acoustic_onset_and_complete_phrase_are_supported_by_words(self):
        mixture = np.full((50000, 2), 0.2, dtype=np.float32)
        vocals = np.zeros_like(mixture)
        for start, end in ((5, 10), (10.4, 20), (20.4, 35), (35.3, 45)):
            vocals[round(start * 1000):round(end * 1000)] = 0.1
        intervals, mask, rms, ratio, threshold = TIMING.activity(vocals, mixture, 1000)
        segments = [
            {"start": 4.5, "end": 10.1, "text": "opening lyric", "probability": 0.7,
             "tokenTimes": [5.2, 6, 7]},
            {"start": 20.4, "end": 35.2, "text": "complete phrase", "probability": 0.8,
             "tokenTimes": [21, 30, 34.8]},
        ]
        result = TIMING.select_opening(intervals, mask, rms, ratio, threshold, segments, 50)
        self.assertAlmostEqual(result["opening"]["vocalStart"], 5, delta=0.04)
        self.assertAlmostEqual(result["opening"]["phraseEnd"], 35.1, delta=0.04)
        self.assertLessEqual(result["opening"]["phraseEnd"] - 4, 40)
        self.assertGreater(result["confidence"]["vocalSupport"], 0.9)

    def test_unconfirmed_early_vocal_and_missing_phrase_pause_are_rejected(self):
        mask = np.ones(2500, dtype=bool)
        late_words = [{"start": 15, "end": 20, "text": "late lyric", "probability": 0.9,
                       "tokenTimes": [15.3]}]
        with self.assertRaisesRegex(TIMING.TimingUnavailable, "earliest vocal"):
            TIMING.select_opening([(5, 20), (21, 40)], mask, None, None, 0.01, late_words, 50)
        opening_words = [{"start": 5, "end": 20, "text": "opening lyric", "probability": 0.9,
                          "tokenTimes": [5.3]}]
        with self.assertRaisesRegex(TIMING.TimingUnavailable, "No complete vocal phrase"):
            TIMING.select_opening([(5, 45)], mask, None, None, 0.01, opening_words, 50)

    def test_fallback_candidates_start_near_vocals_and_end_in_pauses(self):
        intervals = [(5, 14), (14.5, 24), (24.5, 35), (35.5, 45), (45.5, 60)]
        mask = np.zeros(3250, dtype=bool)
        for start, end in intervals:
            mask[round(start / TIMING.HOP_SECONDS):round(end / TIMING.HOP_SECONDS)] = True
        candidates = TIMING.fallback_segments(intervals, mask, 65)
        self.assertGreaterEqual(len(candidates), 3)
        self.assertEqual([candidates[0]["start"], candidates[0]["end"]], [4.4, 35.1])
        for candidate in candidates:
            self.assertTrue(20 <= candidate["end"] - candidate["start"] <= 40)
            self.assertTrue(any(abs(candidate["end"] - end - 0.1) < 0.001 for _, end in intervals))

    def test_fallback_does_not_cut_continuous_vocals_or_select_sparse_audio(self):
        self.assertEqual(TIMING.fallback_segments([(5, 50)], np.ones(2500, dtype=bool), 50), [])
        sparse = np.zeros(2500, dtype=bool)
        sparse[250:350] = True
        sparse[1500:1600] = True
        self.assertEqual(TIMING.fallback_segments([(5, 7), (30, 32)], sparse, 50), [])

    def test_fallback_start_stays_inside_the_leading_pause(self):
        intervals = [(5, 14), (14.5, 24), (24.7, 35), (35.5, 45), (45.7, 60)]
        mask = np.zeros(3250, dtype=bool)
        for start, end in intervals:
            mask[round(start / TIMING.HOP_SECONDS):round(end / TIMING.HOP_SECONDS)] = True
        candidates = TIMING.fallback_segments(intervals, mask, 65)
        self.assertTrue(any(candidate["start"] == 14.25 and candidate["end"] == 45.1
                            for candidate in candidates))
        for candidate in candidates:
            self.assertFalse(any(start <= candidate["start"] < end for start, end in intervals))

    def test_main_returns_partial_when_asr_is_empty_or_unavailable(self):
        mixture = np.full((50000, 2), 0.2, dtype=np.float32)
        vocals = np.zeros_like(mixture)
        for start, end in ((5, 14), (14.5, 24), (24.5, 35), (35.5, 45)):
            vocals[round(start * 1000):round(end * 1000)] = 0.1
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, cli, model = (root / name for name in ("source.wav", "whisper.exe", "ggml-base.bin"))
            for path in (source, cli, model):
                path.touch()
            arguments = ["timing", "--input", str(source), "--voice-root", str(root),
                         "--work-directory", str(root), "--whisper-cli", str(cli), "--whisper-model", str(model)]
            for asr_result in (([], None, 4.4), TIMING.TimingUnavailable("ASR unavailable")):
                with self.subTest(asr_result=asr_result):
                    output = io.StringIO()
                    outcome = {"side_effect": asr_result} if isinstance(asr_result, Exception) else {"return_value": asr_result}
                    recognize = patch.object(TIMING, "recognize", **outcome)
                    with patch("sys.argv", arguments), redirect_stdout(output), recognize, \
                            patch.object(TIMING, "bounded_audio", return_value=(mixture, 1000)), \
                            patch.object(TIMING, "separate_vocals", return_value=(vocals, mixture, 1000, "cpu")):
                        self.assertEqual(TIMING.main(), 0)
                    report = json.loads(output.getvalue())
                    self.assertEqual(report["status"], "partial")
                    self.assertEqual(report["method"], TIMING.METHOD)
                    self.assertIn("error", report)
                    self.assertNotIn("opening", report)
                    self.assertGreater(len(report["fallbackSegments"]), 0)

    def test_main_without_fallback_candidates_still_reports_unavailable(self):
        mixture = np.full((10000, 2), 0.2, dtype=np.float32)
        vocals = np.zeros_like(mixture)
        vocals[2000:5000] = 0.1
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            source.touch()
            output = io.StringIO()
            arguments = ["timing", "--input", str(source), "--voice-root", directory,
                         "--work-directory", directory]
            with patch("sys.argv", arguments), redirect_stdout(output), \
                    patch.object(TIMING, "bounded_audio", return_value=(mixture, 1000)), \
                    patch.object(TIMING, "separate_vocals", return_value=(vocals, mixture, 1000, "cpu")):
                self.assertEqual(TIMING.main(), 2)
            report = json.loads(output.getvalue())
            self.assertEqual(report["status"], "unavailable")
            self.assertNotIn("fallbackSegments", report)


if __name__ == "__main__":
    unittest.main()
