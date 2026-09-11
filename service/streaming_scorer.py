"""Streaming fused risk scorer.

Consumes 20 ms / 8 kHz frames from file_feeder or audiosocket_server (identical
`on_audio(index, chunk)` callback), keeps a 4.0 s ring buffer, and every 0.5 s
hop resamples the trailing window 8 kHz -> 16 kHz and pads it to AASIST's 64600
samples (nb_samp) before scoring.

Why 4 s (Decisions.md): AASIST's published EER was measured on ~4.04 s clips.
A shorter window runs without error but silently miscalibrates the score, and a
confident-but-invalid number is the worst failure for a fraud detector. Cost:
no score for the first ~4 s of a call -- see `_emit_listening`.

The upsample is MANDATORY (System-Architecture.md, top integration risk). This
module prints the first window's tensor shape and asserts it is exactly 64600.

Layer scoring sits behind the `LayerScorer` protocol so published-weights AASIST
(and ECAPA / parselmouth) slot in unchanged. The placeholder here is RMS-derived.

Context: `context_rules.evaluate(metadata)` is called each hop. Its flags become
the message `context_flags`; its additive adjustment is applied *after* EMA
smoothing, immediately before thresholding, and the result is clamped to [0, 1].
The adjustment is a per-call constant from metadata (origin number, call start
time, transaction amount) — smoothing it would only delay a value we already
know and inflate time-to-detection.
"""

from __future__ import annotations

import logging
import math
import time
from collections import deque
import json
from pathlib import Path
import sys
from typing import Callable, Protocol

import numpy as np
import torch
import torchaudio

import context_rules

logger = logging.getLogger(__name__)

SRC_RATE = 8000
MODEL_RATE = 16000
NB_SAMP = 64600             # AASIST nb_samp: its published operating-point length
FRAME_SAMPLES = 160         # 20 ms @ 8 kHz  (a 320-byte s16le frame)
WINDOW_SECONDS = 4.0
WINDOW_SAMPLES = int(SRC_RATE * WINDOW_SECONDS)   # 32000 (4.0 s @ 8 kHz)
HOP_FRAMES = 25            # 0.5 s hop / 20 ms per frame

# Fusion weights — module-level constants, never learned or tuned (Decisions.md D6).
W_ACOUSTIC = 0.60
W_SPEAKER = 0.25
W_PROSODY = 0.15

EMA_ALPHA = 0.3

# State thresholds (api-contract.md): OK < 0.55, ESCALATE 0.55-0.80, BLOCK > 0.80.
ESCALATE_AT = 0.55
BLOCK_AT = 0.80

ScoreCallback = Callable[[dict], None]
TransitionCallback = Callable[[dict], None]


class LayerScorer(Protocol):
    def score(self, window_16k: torch.Tensor) -> dict[str, float | None]:
        """Return {'acoustic': .., 'prosody': .., 'speaker': ..}, with None for unbuilt layers."""


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


class AasistScorer:
    """Acoustic layer scorer backed by pretrained AASIST (16 kHz raw waveform)."""

    _model: torch.nn.Module | None = None
    _device: torch.device | None = None

    def __init__(
        self,
        checkpoint_path: Path | str | None = None,
        aasist_root: Path | str | None = None,
        device: torch.device | None = None,
    ) -> None:
        self.device = device or torch.device("cuda" if torch.cuda.is_available() else "cpu")
        repo_root = Path(__file__).resolve().parent.parent
        self.aasist_root = Path(aasist_root) if aasist_root else (repo_root / "aasist")
        self.checkpoint_path = (
            Path(checkpoint_path)
            if checkpoint_path
            else (self.aasist_root / "models" / "weights" / "AASIST.pth")
        )

        if AasistScorer._model is None or AasistScorer._device != self.device:
            if str(self.aasist_root) not in sys.path:
                sys.path.insert(0, str(self.aasist_root))

            from importlib import import_module
            module = import_module("models.AASIST")
            ModelClass = module.Model

            conf_path = self.aasist_root / "config" / "AASIST.conf"
            if conf_path.exists():
                with conf_path.open("r", encoding="utf-8") as f:
                    model_config = json.load(f)["model_config"]
            else:
                model_config = {
                    "architecture": "AASIST",
                    "nb_samp": 64600,
                    "first_conv": 128,
                    "filts": [70, [1, 32], [32, 32], [32, 64], [64, 64]],
                    "gat_dims": [64, 32],
                    "pool_ratios": [0.5, 0.7, 0.5, 0.5],
                    "temperatures": [2.0, 2.0, 100.0, 100.0],
                }

            model = ModelClass(model_config).to(self.device)
            state = torch.load(self.checkpoint_path, map_location=self.device)
            if isinstance(state, dict) and "model" in state:
                state = state["model"]
            elif isinstance(state, dict) and "state_dict" in state:
                state = state["state_dict"]

            model.load_state_dict(state)
            model.eval()
            AasistScorer._model = model
            AasistScorer._device = self.device

        self.model = AasistScorer._model

    def score(self, window_16k: torch.Tensor) -> dict[str, float | None]:
        """
        Run AASIST inference on 16 kHz window (NB_SAMP=64600).
        Returns {'acoustic': spoof_prob, 'prosody': None, 'speaker': None}.
        Unbuilt layers return None so fusion renormalises over active layers.
        """
        x = window_16k.to(self.device)
        if x.ndim == 1:
            x = x.unsqueeze(0)
        elif x.ndim == 3:
            x = x.squeeze(1)

        with torch.no_grad():
            _, logits = self.model(x)
            probs = torch.softmax(logits, dim=-1)
            acoustic = probs[0, 0].item()

        return {
            "acoustic": _clamp(acoustic),
            "prosody": None,
            "speaker": None,
        }


class RmsPlaceholderScorer:
    """Stand-in until AASIST / ECAPA / parselmouth land. Deterministic, RMS-derived."""

    def score(self, window_16k: torch.Tensor) -> dict[str, float]:
        rms = float(window_16k.pow(2).mean().clamp_min(1e-12).sqrt())
        s = math.tanh(rms * 3.0)
        return {
            "acoustic": _clamp(s),
            "prosody": _clamp(s * 0.85),
            "speaker": _clamp(s * 0.92),
        }


def _state(score: float) -> str:
    if score > BLOCK_AT:
        return "BLOCK"
    if score >= ESCALATE_AT:
        return "ESCALATE"
    return "OK"


def _pad_to_nb_samp(wav: torch.Tensor) -> torch.Tensor:
    """Force a 1-D waveform to exactly NB_SAMP samples.

    The 4.0 s buffer resamples 8 kHz -> 16 kHz to exactly 64000 samples; AASIST
    wants 64600. The 600-sample gap is closed by TILING (repeat the window, then
    truncate) -- identical to clovaai/aasist `data_utils.pad`. NOT zero-padding:
    that would feed the model ~37 ms of silence it never saw in training.
    """
    n = wav.shape[-1]
    if n >= NB_SAMP:
        return wav[..., :NB_SAMP]
    reps = NB_SAMP // n + 1
    return wav.repeat(reps)[..., :NB_SAMP]


class StreamingScorer:
    def __init__(
        self,
        call_id: str,
        on_score: ScoreCallback,
        *,
        on_transition: TransitionCallback | None = None,
        scorer: LayerScorer | None = None,
        metadata: dict | None = None,
    ) -> None:
        self.call_id = call_id
        self._on_score = on_score
        self._on_transition = on_transition
        self._scorer = scorer or AasistScorer()
        # origin_number, call start time, transaction amount, ... — see context_rules
        self._metadata = dict(metadata or {})
        self._buf: deque[float] = deque(maxlen=WINDOW_SAMPLES)
        self._frames = 0
        self._ema: float | None = None
        self._t0: float | None = None
        self._prev_state = "OK"
        self._detected = False
        self._first_score_logged = False
        self._logged_shape = False

    def feed(self, index: int, chunk: bytes) -> None:
        """`on_audio` callback. `index` is the source's monotonic 20 ms frame index."""
        if self._t0 is None:
            self._t0 = time.perf_counter()
        samples = np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768.0
        self._buf.extend(samples.tolist())
        self._frames += 1
        if self._frames % HOP_FRAMES != 0:
            return
        adjustment, flags = context_rules.evaluate(self._metadata)
        if len(self._buf) == WINDOW_SAMPLES:
            self._score_window(adjustment, flags)
        else:
            self._emit_listening(flags)

    def _emit_listening(self, flags: list[str]) -> None:
        """Pre-roll: the 4 s buffer is not full yet. Emit an explicit 'no score
        yet' message (score / layers = null) so the dashboard shows 'listening'
        instead of a flat zero line. A provisional score here would be an
        uncalibrated AASIST run -- worse than no number at all.

        Context flags are carried already: they come from metadata, which is
        known before any audio arrives."""
        self._on_score({
            "call_id": self.call_id,
            "t": round(self._frames * 0.02, 3),
            "score": None,
            "layers": {"acoustic": None, "prosody": None, "speaker": None},
            "context_flags": list(flags),
            "state": "OK",
        })

    def _score_window(self, adjustment: float, flags: list[str]) -> None:
        window_8k = torch.tensor(self._buf, dtype=torch.float32)
        # resample yields exactly 64000 samples; pad up to AASIST's 64600 (nb_samp)
        # by tiling, per _pad_to_nb_samp.
        window_16k = _pad_to_nb_samp(
            torchaudio.functional.resample(window_8k, SRC_RATE, MODEL_RATE)
        )

        if not self._logged_shape:
            self._logged_shape = True
            print(f"[scorer] first window: 8 kHz {tuple(window_8k.shape)} -> 16 kHz "
                  f"+ tile-pad {tuple(window_16k.shape)} (target nb_samp={NB_SAMP})")
            logger.info("first window shape %s", tuple(window_16k.shape))
            assert window_16k.shape[-1] == NB_SAMP, (
                f"window is {window_16k.shape[-1]} samples, expected {NB_SAMP} "
                f"(AASIST nb_samp). Resample/pad broken; scores would be invalid."
            )

        if not self._first_score_logged:
            self._first_score_logged = True
            wall = time.perf_counter() - self._t0
            logger.warning("call %s: time-to-first-score t=%.2fs, %.2fs after stream start",
                           self.call_id, self._frames * 0.02, wall)
            print(f"[scorer] {self.call_id}: first score at t={self._frames * 0.02:.2f}s "
                  f"({wall:.2f}s wall from stream start)")

        layers = self._scorer.score(window_16k)
        layer_weights = {
            "acoustic": W_ACOUSTIC,
            "speaker": W_SPEAKER,
            "prosody": W_PROSODY,
        }
        active_layers = {
            k: (val, layer_weights[k])
            for k, val in layers.items()
            if val is not None and k in layer_weights
        }
        if active_layers:
            total_weight = sum(w for _, w in active_layers.values())
            fused = sum(val * w for val, w in active_layers.values()) / total_weight
        else:
            fused = 0.0
        self._ema = (
            fused if self._ema is None
            else EMA_ALPHA * fused + (1 - EMA_ALPHA) * self._ema
        )
        # context adjustment lands AFTER smoothing, right before thresholding:
        # it's a per-call constant, so EMA would only delay it. Clamp to [0, 1].
        score = round(_clamp(self._ema + adjustment), 3)
        state = _state(score)
        t = round(self._frames * 0.02, 3)

        if state in ("ESCALATE", "BLOCK") and not self._detected:
            self._detected = True
            wall = time.perf_counter() - self._t0
            logger.warning("call %s: time-to-first-ESCALATE t=%.2fs, %.2fs after stream start",
                           self.call_id, t, wall)
            print(f"[scorer] {self.call_id}: first ESCALATE at t={t:.2f}s "
                  f"({wall:.2f}s wall from stream start)")

        if state != self._prev_state:
            if self._on_transition is not None:
                self._on_transition({
                    "call_id": self.call_id,
                    "t": t,
                    "from_state": self._prev_state,
                    "to_state": state,
                    "flags": list(flags),
                })
            self._prev_state = state

        self._on_score({
            "call_id": self.call_id,
            "t": t,
            "score": score,
            "layers": {
                "acoustic": round(layers["acoustic"], 3) if layers.get("acoustic") is not None else None,
                "prosody": round(layers["prosody"], 3) if layers.get("prosody") is not None else None,
                "speaker": round(layers["speaker"], 3) if layers.get("speaker") is not None else None,
            },
            "context_flags": list(flags),
            "state": state,
        })


def _sine_frame(i: int, amp: float) -> bytes:
    n = np.arange(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES)
    return (amp * np.sin(2 * np.pi * 200.0 * n / SRC_RATE) * 32767).astype("<i2").tobytes()


def _selfcheck() -> None:
    # scenario 1: context flags reach both listening + scored messages, and the
    # post-EMA adjustment flips the state a bare acoustic score would leave at OK.
    meta = {"origin_number": "anonymous", "amount": 5_000_000}
    exp_adj, exp_flags = context_rules.evaluate(meta)
    assert (exp_adj, exp_flags) == (0.15, ["unknown_origin", "high_value_txn"]), (exp_adj, exp_flags)

    msgs: list[dict] = []
    transitions: list[dict] = []
    sc = StreamingScorer(
        "selftest",
        msgs.append,
        on_transition=transitions.append,
        scorer=RmsPlaceholderScorer(),
        metadata=meta,
    )
    for i in range(260):  # 5.2 s -> 7 pre-roll hops + scored from the 4.0 s fill
        sc.feed(i, _sine_frame(i, 0.3))

    listening = [m for m in msgs if m["score"] is None]
    scored = [m for m in msgs if m["score"] is not None]
    assert len(listening) == 7 and len(scored) == 3, (len(listening), len(scored))
    for m in msgs:
        assert set(m) == {"call_id", "t", "score", "layers", "context_flags", "state"}, set(m)
        assert m["context_flags"] == exp_flags, m["context_flags"]      # flags on BOTH kinds
    for m in listening:
        assert m["state"] == "OK" and all(v is None for v in m["layers"].values()), m
    assert listening[0]["t"] == 0.5 and scored[0]["t"] == 4.0
    # the 0.3 sine alone smooths to ~0.54 (OK); +0.15 context pushes it to ESCALATE
    assert scored[0]["state"] == "ESCALATE" and 0.55 <= scored[0]["score"] < 0.80, scored[0]
    assert [(t["from_state"], t["to_state"]) for t in transitions] == [("OK", "ESCALATE")]
    assert transitions[0]["flags"] == exp_flags

    # scenario 2: loud audio + full 0.25 adjustment clamps the final score to 1.0
    meta2 = {"origin_number": "anonymous", "first_contact": True,
             "call_time": "23:00", "amount": 5_000_000}
    assert context_rules.evaluate(meta2)[0] == 0.25
    m2: list[dict] = []
    sc2 = StreamingScorer("clamp", m2.append, scorer=RmsPlaceholderScorer(), metadata=meta2)
    for i in range(210):
        sc2.feed(i, _sine_frame(i, 0.99))
    s2 = [m for m in m2 if m["score"] is not None]
    assert s2 and s2[0]["score"] == 1.0 and s2[0]["state"] == "BLOCK", s2[:1]

    # scenario 3: verify default AasistScorer initializes and scores with None for unbuilt layers
    aasist_sc = AasistScorer()
    dummy_win = torch.zeros(NB_SAMP, dtype=torch.float32)
    scores = aasist_sc.score(dummy_win)
    assert set(scores) == {"acoustic", "prosody", "speaker"}
    assert 0.0 <= scores["acoustic"] <= 1.0
    assert scores["prosody"] is None and scores["speaker"] is None

    # scenario 4: verify fusion renormalization with unbuilt layers (acoustic-only)
    class AcousticOnlyScorer:
        def score(self, window_16k: torch.Tensor) -> dict[str, float | None]:
            return {"acoustic": 0.40, "prosody": None, "speaker": None}

    m4: list[dict] = []
    sc4 = StreamingScorer("renorm", m4.append, scorer=AcousticOnlyScorer())
    for i in range(210):
        sc4.feed(i, _sine_frame(i, 0.1))
    s4 = [m for m in m4 if m["score"] is not None]
    assert s4, "Expected scored messages"
    # Fused score equals acoustic score (0.40) rather than diluted by W_ACOUSTIC (0.40 * 0.60 = 0.24)
    assert abs(s4[-1]["score"] - 0.40) < 0.005, f"Expected 0.40, got {s4[-1]['score']}"
    assert s4[-1]["layers"]["acoustic"] == 0.40
    assert s4[-1]["layers"]["prosody"] is None
    assert s4[-1]["layers"]["speaker"] is None

    print(f"ok: flags {exp_flags} on {len(listening)} listening + {len(scored)} scored; "
          f"post-EMA +{exp_adj} -> {scored[0]['state']} @ {scored[0]['score']}; "
          f"clamp: loud + 0.25 -> {s2[0]['score']} {s2[0]['state']}; "
          f"AasistScorer: dummy acoustic={scores['acoustic']:.4f}, prosody={scores['prosody']}, speaker={scores['speaker']}; "
          f"renorm: acoustic-only 0.40 -> fused={s4[-1]['score']} (not diluted to 0.24)")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    _selfcheck()
