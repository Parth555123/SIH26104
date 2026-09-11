"""
eval/codec_transcode.py
Transcode an input directory of WAVs through telephony codecs and restore each
to 8 kHz 16-bit mono PCM WAV for robustness evaluation.

Supported degraded versions:
  - G.711 µ-law (pcm_mulaw)
  - GSM 06.10 (libgsm)
  - Opus 16k (libopus)
  - AMR-NB 7.4k (libopencore_amrnb) [only if supported by ffmpeg build]

Usage (PowerShell from repo root):
    .\\.venv\\Scripts\\python.exe eval\\codec_transcode.py `
        --input_dir path\\to\\wavs `
        --output_dir path\\to\\degraded
"""

import argparse
from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


@dataclass
class CodecConfig:
    key: str
    description: str
    encoder: str
    subdir: str
    suffix: str
    intermediate_ext: str
    encode_args: list[str]


# Codec degradation configurations
CODECS = [
    CodecConfig(
        key="g711_mulaw",
        description="G.711 µ-law (pcm_mulaw)",
        encoder="pcm_mulaw",
        subdir="g711_mulaw",
        suffix="_g711",
        intermediate_ext=".wav",
        encode_args=["-ar", "8000", "-ac", "1", "-c:a", "pcm_mulaw"],
    ),
    CodecConfig(
        key="gsm",
        description="GSM 06.10 (libgsm)",
        encoder="libgsm",
        subdir="gsm",
        suffix="_gsm",
        intermediate_ext=".gsm",
        encode_args=["-ar", "8000", "-ac", "1", "-c:a", "libgsm"],
    ),
    CodecConfig(
        key="opus_16k",
        description="Opus 16k (libopus)",
        encoder="libopus",
        subdir="opus_16k",
        suffix="_opus",
        intermediate_ext=".opus",
        encode_args=["-c:a", "libopus", "-b:a", "16k", "-ar", "16000", "-ac", "1"],
    ),
    CodecConfig(
        key="amr_nb",
        description="AMR-NB 7.4k (libopencore_amrnb)",
        encoder="libopencore_amrnb",
        subdir="amr_nb",
        suffix="_amrnb",
        intermediate_ext=".amr",
        encode_args=["-ar", "8000", "-ac", "1", "-c:a", "libopencore_amrnb", "-b:a", "7.4k"],
    ),
]


def check_ffmpeg_available() -> bool:
    """Check whether ffmpeg is available in PATH."""
    return shutil.which("ffmpeg") is not None


def get_available_encoders() -> set[str]:
    """Query ffmpeg to detect which audio encoders are available in this build."""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-encoders"],
            capture_output=True,
            text=True,
            check=True,
        )
    except Exception as exc:
        print(f"WARNING: Could not query ffmpeg encoders: {exc}", file=sys.stderr)
        return set()

    encoders = set()
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("A"):
            encoders.add(parts[1])
    return encoders


def transcode_and_restore(
    input_wav: Path,
    output_wav: Path,
    codec: CodecConfig,
    temp_dir: Path,
) -> bool:
    """
    Transcode input WAV to degraded codec format, then restore to 8 kHz 16-bit mono PCM WAV.
    Returns True on success, False on failure. Never raises an unhandled exception.
    """
    temp_file = temp_dir / f"tmp_{codec.key}_{input_wav.stem}{codec.intermediate_ext}"

    try:
        # Step 1: Transcode input WAV into codec-compressed intermediate format
        cmd_encode = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_wav),
            *codec.encode_args,
            str(temp_file),
        ]
        res_encode = subprocess.run(cmd_encode, capture_output=True, text=True)
        if res_encode.returncode != 0:
            print(
                f"WARNING: [{codec.key}] Encode step failed for '{input_wav.name}': "
                f"{res_encode.stderr.strip()}",
                file=sys.stderr,
            )
            return False

        # Step 2: Decode intermediate file back to standard 8 kHz 16-bit mono PCM WAV
        output_wav.parent.mkdir(parents=True, exist_ok=True)
        cmd_decode = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(temp_file),
            "-ar",
            "8000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(output_wav),
        ]
        res_decode = subprocess.run(cmd_decode, capture_output=True, text=True)
        if res_decode.returncode != 0:
            print(
                f"WARNING: [{codec.key}] Restore step failed for '{input_wav.name}': "
                f"{res_decode.stderr.strip()}",
                file=sys.stderr,
            )
            return False

        return True
    except Exception as exc:
        print(
            f"WARNING: [{codec.key}] Unexpected error processing '{input_wav.name}': {exc}",
            file=sys.stderr,
        )
        return False
    finally:
        if temp_file.exists():
            try:
                temp_file.unlink()
            except OSError:
                pass


def find_wav_files(input_dir: Path) -> list[Path]:
    """Find all .wav files in input_dir recursively, in a cross-platform manner."""
    return sorted(p for p in input_dir.rglob("*") if p.is_file() and p.suffix.lower() == ".wav")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Transcode an input directory of WAVs through telephony codecs "
            "(G.711 µ-law, GSM 06.10, Opus 16k, AMR-NB 7.4k) and restore each "
            "to 8 kHz 16-bit mono PCM WAV."
        )
    )
    parser.add_argument(
        "--input_dir",
        "-i",
        type=Path,
        default=None,
        help="Input directory containing WAV files (searched recursively).",
    )
    parser.add_argument(
        "--output_dir",
        "-o",
        type=Path,
        default=None,
        help="Output directory where degraded codec subdirectories will be created.",
    )
    parser.add_argument(
        "--codecs",
        nargs="+",
        default=None,
        help="Optional list of codec keys to run (e.g. --codecs g711_mulaw gsm). Defaults to all available.",
    )
    # Positional fallback support
    parser.add_argument("pos_input_dir", type=Path, nargs="?", default=None, help=argparse.SUPPRESS)
    parser.add_argument("pos_output_dir", type=Path, nargs="?", default=None, help=argparse.SUPPRESS)

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    input_dir = args.input_dir or args.pos_input_dir
    output_dir = args.output_dir or args.pos_output_dir

    if input_dir is None or output_dir is None:
        sys.exit("ERROR: Both --input_dir and --output_dir must be specified.")

    if not input_dir.is_dir():
        sys.exit(f"ERROR: Input directory does not exist or is not a directory: {input_dir}")

    if not check_ffmpeg_available():
        print("WARNING: 'ffmpeg' executable not found in PATH. Skipping transcode.", file=sys.stderr)
        return

    # Check encoder support in ffmpeg build
    available_encoders = get_available_encoders()
    active_codecs: list[CodecConfig] = []

    filter_keys = set(args.codecs) if args.codecs else None

    for codec in CODECS:
        if filter_keys and codec.key not in filter_keys and codec.subdir not in filter_keys:
            continue

        if codec.encoder in available_encoders:
            active_codecs.append(codec)
        else:
            print(
                f"WARNING: Codec '{codec.description}' encoder '{codec.encoder}' "
                f"is not available in this ffmpeg build. Skipping.",
                file=sys.stderr,
            )

    if not active_codecs:
        print("WARNING: No requested/supported codecs available to run. Exiting cleanly.", file=sys.stderr)
        return

    wav_files = find_wav_files(input_dir)
    if not wav_files:
        print(f"WARNING: No .wav files found under {input_dir}. Exiting cleanly.", file=sys.stderr)
        return

    print(f"Found {len(wav_files)} WAV file(s) in: {input_dir}")
    print(f"Active codecs ({len(active_codecs)}): {', '.join(c.key for c in active_codecs)}")
    print(f"Output directory: {output_dir}")

    total_tasks = len(wav_files) * len(active_codecs)
    completed_count = 0
    success_count = 0

    with tempfile.TemporaryDirectory() as temp_dir_str:
        temp_dir = Path(temp_dir_str)

        for codec in active_codecs:
            codec_output_dir = output_dir / codec.subdir
            codec_output_dir.mkdir(parents=True, exist_ok=True)
            print(f"\n--- Transcoding: {codec.description} -> {codec_output_dir} ---")

            for idx, wav_path in enumerate(wav_files, start=1):
                completed_count += 1
                rel_path = wav_path.relative_to(input_dir)
                stem = wav_path.stem
                out_path = codec_output_dir / rel_path.parent / f"{stem}{codec.suffix}.wav"

                ok = transcode_and_restore(
                    input_wav=wav_path,
                    output_wav=out_path,
                    codec=codec,
                    temp_dir=temp_dir,
                )
                if ok:
                    success_count += 1
                    print(f"  [{idx:4d}/{len(wav_files)}] {rel_path} -> {out_path.name}")
                else:
                    print(f"  [{idx:4d}/{len(wav_files)}] FAILED: {rel_path}")

    print(f"\nCompleted: {success_count}/{total_tasks} degraded audio files successfully generated.")


if __name__ == "__main__":
    main()
