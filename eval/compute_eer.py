"""
Compute EER from a filename,score,label CSV.

SCORE POLARITY -- shared with eval/run_inference.py, keep both in sync:
  * score = P(spoof): softmax(AASIST logits)[spoof], higher => more synthetic/cloned.
    This matches the live risk-score contract (higher = more suspicious).
  * label = 1 for SPOOF (the positive class here), 0 for bona fide.

Spoof is the positive class on purpose: it is the class the score ranks high.
Labelling bona fide as 1 against these spoof-probability scores inverts the ROC
and reports EER = (1 - true_EER), i.e. > 50%. compute_eer() prints a loud warning
to stderr if that happens so an inverted run is caught, not believed.

(Note: this flips the "bona fide = positive class (1)" convention in Memory.md --
the eval pipeline now standardises on spoof-positive end to end.)
"""

import argparse
import csv
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import brentq
from sklearn.metrics import roc_curve


def compute_eer(scores, labels):
    """Return (EER, threshold). Positive class is SPOOF (label 1); scores are P(spoof)."""
    score_values = np.asarray(scores, dtype=float)
    label_values = np.asarray(labels, dtype=int)

    if score_values.ndim != 1 or label_values.ndim != 1:
        raise ValueError("scores and labels must be one-dimensional")
    if len(score_values) != len(label_values) or len(score_values) == 0:
        raise ValueError("scores and labels must be non-empty and equally sized")
    if not np.isin(label_values, (0, 1)).all() or len(np.unique(label_values)) != 2:
        raise ValueError("labels must include both 0 (bona fide) and 1 (spoof)")

    # pos_label=1 == spoof: the class the P(spoof) score ranks high.
    fpr, tpr, thresholds = roc_curve(
        label_values, score_values, pos_label=1, drop_intermediate=False
    )
    fnr = 1.0 - tpr

    # Keep the final point at each repeated FPR so interpolation is well-defined.
    unique_fpr, reversed_indices = np.unique(fpr[::-1], return_index=True)
    indices = len(fpr) - 1 - reversed_indices
    unique_fnr = fnr[indices]
    unique_thresholds = thresholds[indices]

    eer = brentq(lambda point: np.interp(point, unique_fpr, unique_fnr) - point, 0.0, 1.0)
    threshold = float(np.interp(eer, unique_fpr, unique_thresholds))

    if eer > 0.5:
        print(
            f"WARNING: EER = {eer:.1%} (> 50%). Scores and labels are almost certainly "
            "inverted. This pipeline expects score = P(spoof) (higher = more synthetic) "
            "and label 1 = spoof, 0 = bona fide. Fix the labelling or the score column, "
            "not this function.",
            file=sys.stderr,
        )

    return float(eer), threshold


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute EER from filename,score,label CSV data.")
    parser.add_argument("csv_path", type=Path, help="CSV containing filename,score,label columns")
    args = parser.parse_args()

    scores = []
    labels = []
    with args.csv_path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        required_columns = {"filename", "score", "label"}
        if reader.fieldnames is None or not required_columns.issubset(reader.fieldnames):
            raise ValueError("CSV must contain filename,score,label columns")
        for row in reader:
            scores.append(float(row["score"]))
            labels.append(int(row["label"]))

    n_spoof = sum(labels)
    print(f"{len(labels)} utts | {n_spoof} spoof (label 1) | {len(labels) - n_spoof} bona fide (label 0)")

    eer, threshold = compute_eer(scores, labels)
    print(f"EER: {eer:.2%}   (positive class = spoof; score = P(spoof))")
    print(f"Threshold at EER: {threshold:.6f}")


if __name__ == "__main__":
    main()
