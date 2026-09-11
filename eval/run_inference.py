"""
eval/run_inference.py
Batch inference with a pretrained AASIST checkpoint.

Usage (PowerShell from repo root):
    .\.venv\Scripts\python.exe eval\run_inference.py `
        --checkpoint path\to\AASIST.pth `
        --input_dir  path\to\wavs `
        --output_csv eval\scores.csv

Assumptions:
  - The AASIST repo has been cloned/copied so that `models\AASIST.py` is
    importable. Add the repo root to sys.path via --aasist_root if it is
    not the cwd (see argparse below).
  - Checkpoint is a plain state_dict saved with torch.save(model.state_dict()).
  - Input WAVs may be 8 kHz or any sample rate; every file is resampled to
    16 kHz before inference (CLAUDE.md hard constraint -- AASIST needs 16 kHz),
    then padded/truncated to 64600 samples (NB_SAMP) to match the ASVspoof
    eval protocol the published EER was measured on.
  - Score written to CSV is the *spoof probability* in [0, 1]:
      softmax(logits)[0, 0]  (index 0 = spoof class per AASIST data_utils.py)
    Higher score -> more likely synthetic/cloned voice.

SCORE POLARITY -- shared with eval/compute_eer.py, keep both in sync:
  score = P(spoof), higher = more synthetic (matches the live risk-score contract).
  When you add the label column for EER: label 1 = SPOOF (positive class),
  0 = bona fide. compute_eer.py is written to that convention and warns if a run
  comes out inverted (EER > 50%). Do NOT relabel bona fide as 1.
  (This flips Memory.md's "bona fide = positive class"; the eval pipeline
  standardises on spoof-positive end to end.)
"""

import argparse
import csv
import sys
from pathlib import Path

import torch
import torch.nn.functional as F
import torchaudio

TARGET_SR = 16_000  # AASIST expects 16 kHz raw waveform
NB_SAMP = 64_600    # AASIST nb_samp: the ASVspoof eval protocol pads/truncates
                    # every clip to this length. The published EER was measured
                    # this way; scoring native-length clips makes the temporal
                    # graph size vary per file and the EER stops matching the paper.


def pad_to_nb_samp(waveform: torch.Tensor) -> torch.Tensor:
    """Fix a (1, T) waveform to exactly NB_SAMP samples.

    Matches clovaai/aasist `data_utils.pad`: repeat-tile clips shorter than
    NB_SAMP (not zero-pad) and hard-truncate longer ones.
    """
    n = waveform.shape[-1]
    if n >= NB_SAMP:
        return waveform[..., :NB_SAMP]
    reps = NB_SAMP // n + 1
    return waveform.repeat(1, reps)[..., :NB_SAMP]


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_model(checkpoint_path: Path, aasist_root: Path, device: torch.device):
    """
    Dynamically import models.AASIST.Model following the official repo
    convention (importlib + architecture string from config).
    """
    if str(aasist_root) not in sys.path:
        sys.path.insert(0, str(aasist_root))

    try:
        from importlib import import_module
        module = import_module("models.AASIST")
        ModelClass = module.Model
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            f"Could not import 'models.AASIST'. "
            f"Make sure --aasist_root points to the cloned clovaai/aasist repo "
            f"(currently: {aasist_root}). Original error: {exc}"
        )

    # Load model_config from AASIST.conf if available; fallback to standard defaults.
    conf_path = aasist_root / "config" / "AASIST.conf"
    if conf_path.exists():
        import json
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

    model = ModelClass(model_config)
    state = torch.load(checkpoint_path, map_location=device)

    # Handle checkpoints wrapped in a dict
    if isinstance(state, dict) and "model" in state:
        state = state["model"]
    elif isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]

    model.load_state_dict(state)
    model.to(device)
    model.eval()
    return model


# ---------------------------------------------------------------------------
# Audio loading + resampling
# ---------------------------------------------------------------------------

def load_wav_16k(wav_path: Path) -> torch.Tensor:
    """
    Load a WAV, resample to 16 kHz, convert to mono, return shape (1, T).
    Critical: AudioSocket delivers 8 kHz; AASIST needs 16 kHz -- skipping
    this step is explicitly called the highest-risk defect in CLAUDE.md.
    """
    try:
        waveform, sr = torchaudio.load(str(wav_path))
    except Exception:
        import soundfile as sf
        data, sr = sf.read(str(wav_path), dtype="float32")
        waveform = torch.from_numpy(data)
        if waveform.ndim == 1:
            waveform = waveform.unsqueeze(0)
        else:
            waveform = waveform.transpose(0, 1)

    if waveform.shape[0] > 1:          # stereo/multi-channel -> mono
        waveform = waveform.mean(dim=0, keepdim=True)

    if sr != TARGET_SR:
        resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=TARGET_SR)
        waveform = resampler(waveform)  # (1, T_16k)

    waveform = pad_to_nb_samp(waveform)  # (1, 64600) -- ASVspoof protocol length
    return waveform


# ---------------------------------------------------------------------------
# Single-file inference
# ---------------------------------------------------------------------------

def infer_score(
    model: torch.nn.Module,
    waveform: torch.Tensor,
    device: torch.device,
    first_file: bool = False,
) -> float:
    """
    Returns the spoof score in [0, 1].

    AASIST forward returns (last_hidden, output) where output is (B, 2) logits.
    Class 0 = spoof, class 1 = bonafide per data_utils.py label mapping:
        d_meta[key] = 1 if label == "bonafide" else 0
    So spoof score = softmax(logits)[0, 0].
    """
    x = waveform.to(device)    # Expected shape for AASIST: (B=1, nb_samp=64600)
    if x.ndim == 1:
        x = x.unsqueeze(0)
    elif x.ndim == 3:
        x = x.squeeze(1)

    with torch.no_grad():
        _, logits = model(x)   # logits: (1, 2)

    if first_file:
        print(f"  [DEBUG] input tensor shape : {x.shape}")
        print(f"  [DEBUG] logits tensor shape: {logits.shape}")

    probs = F.softmax(logits, dim=-1)   # (1, 2)
    return probs[0, 0].item()           # spoof probability, scalar in [0, 1]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Batch AASIST inference: score every WAV in input_dir, write CSV."
    )
    p.add_argument(
        "--checkpoint", required=True, type=Path,
        help="Path to the pretrained AASIST .pth file (state_dict).",
    )
    p.add_argument(
        "--input_dir", required=True, type=Path,
        help="Directory containing .wav files to score (searched recursively).",
    )
    p.add_argument(
        "--output_csv", required=True, type=Path,
        help="Output CSV path. Columns: filename, score.",
    )
    p.add_argument(
        "--aasist_root", type=Path, default=Path("."),
        help=(
            "Root of the cloned clovaai/aasist repo so that 'models.AASIST' "
            "is importable. Defaults to the current working directory."
        ),
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    # Windows-safe path validation via pathlib
    if not args.checkpoint.exists():
        sys.exit(f"ERROR: checkpoint not found: {args.checkpoint}")
    if not args.input_dir.is_dir():
        sys.exit(f"ERROR: input_dir is not a directory: {args.input_dir}")

    print(f"Loading model from: {args.checkpoint}")
    model = load_model(args.checkpoint, args.aasist_root.resolve(), device)
    print("Model loaded.")

    wav_files = sorted(args.input_dir.rglob("*.wav"))
    if not wav_files:
        sys.exit(f"ERROR: no .wav files found under {args.input_dir}")
    print(f"Found {len(wav_files)} WAV file(s). Running inference...")

    args.output_csv.parent.mkdir(parents=True, exist_ok=True)

    with args.output_csv.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["filename", "score"])

        for idx, wav_path in enumerate(wav_files):
            try:
                waveform = load_wav_16k(wav_path)
                score = infer_score(model, waveform, device, first_file=(idx == 0))
                rel = wav_path.relative_to(args.input_dir)
                writer.writerow([str(rel), f"{score:.6f}"])
                print(f"  [{idx + 1:4d}/{len(wav_files)}]  {rel}  ->  score={score:.4f}")
            except Exception as exc:  # noqa: BLE001
                print(f"  WARN: skipping {wav_path.name}: {exc}")

    print(f"\nDone. Scores written to: {args.output_csv}")


if __name__ == "__main__":
    main()