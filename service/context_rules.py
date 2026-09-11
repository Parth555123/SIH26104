"""
service/context_rules.py
Context-based risk score adjustments for voice cloning detection.

Pure functional rule engine evaluating call and transaction metadata to produce
an additive risk score adjustment (0.0 to 0.25 total) and a list of triggered
context flag strings.

Rules:
  1. Unknown or unregistered origin number  -> +0.10, "unknown_origin"
  2. First contact from this number         -> +0.05, "first_contact"
  3. Call outside 09:00–18:00 (off-hours)   -> +0.05, "off_hours"
  4. Transaction value above 10,00,000      -> +0.05, "high_value_txn"
"""

import datetime
from pathlib import Path
import re
from typing import Any

# Threshold for high value transactions: 10,00,000 (10 Lakh)
HIGH_VALUE_THRESHOLD = 1_000_000

# Rule weights
WEIGHT_UNKNOWN_ORIGIN = 0.10
WEIGHT_FIRST_CONTACT = 0.05
WEIGHT_OFF_HOURS = 0.05
WEIGHT_HIGH_VALUE_TXN = 0.05

START_BUSINESS_HOURS = datetime.time(9, 0, 0)
END_BUSINESS_HOURS = datetime.time(18, 0, 0)


def check_unknown_origin(metadata: dict[str, Any]) -> bool:
    """Check if the call origin number is unknown or unregistered."""
    if metadata.get("unknown_origin") is True or metadata.get("is_unknown_origin") is True:
        return True
    if metadata.get("unregistered") is True or metadata.get("is_unregistered") is True:
        return True
    if (
        metadata.get("is_registered") is False
        or metadata.get("registered") is False
        or metadata.get("origin_registered") is False
    ):
        return True

    flags = metadata.get("context_flags") or metadata.get("flags")
    if isinstance(flags, (list, tuple, set)) and "unknown_origin" in flags:
        return True

    for key in ("origin_number", "caller_id", "from_number", "phone_number", "origin"):
        if key in metadata:
            val = metadata[key]
            if val is None:
                return True
            val_str = str(val).strip().lower()
            if val_str in ("", "unknown", "anonymous", "private", "hidden", "unregistered", "restricted", "none", "null"):
                return True

            registered_numbers = metadata.get("registered_numbers") or metadata.get("known_numbers")
            if isinstance(registered_numbers, (list, tuple, set)):
                if val not in registered_numbers and val_str not in registered_numbers:
                    return True
            break

    return False


def check_first_contact(metadata: dict[str, Any]) -> bool:
    """Check if this call is the first contact from this origin number."""
    if metadata.get("first_contact") is True or metadata.get("is_first_contact") is True:
        return True

    flags = metadata.get("context_flags") or metadata.get("flags")
    if isinstance(flags, (list, tuple, set)) and "first_contact" in flags:
        return True

    for key in ("prior_calls", "past_calls", "previous_calls", "call_history_count"):
        if key in metadata:
            try:
                if int(metadata[key]) == 0:
                    return True
            except (ValueError, TypeError):
                pass

    return False


def check_off_hours(metadata: dict[str, Any]) -> bool:
    """
    Check if the call takes place outside 09:00–18:00 business hours.
    Returns True if time is strictly before 09:00:00 or strictly after 18:00:00.
    """
    if metadata.get("off_hours") is True or metadata.get("is_off_hours") is True:
        return True
    if metadata.get("after_hours") is True:
        return True

    flags = metadata.get("context_flags") or metadata.get("flags")
    if isinstance(flags, (list, tuple, set)) and ("off_hours" in flags or "after_hours" in flags):
        return True

    # Check explicit hour field
    for key in ("hour", "call_hour"):
        if key in metadata and metadata[key] is not None:
            try:
                hour = float(metadata[key])
                return hour < 9.0 or hour >= 18.0
            except (ValueError, TypeError):
                pass

    # Check timestamp / time fields
    for key in ("call_time", "time", "timestamp", "started_at", "call_started_at", "created_at"):
        if key in metadata and metadata[key] is not None:
            val = metadata[key]

            if isinstance(val, datetime.time):
                return val < START_BUSINESS_HOURS or val > END_BUSINESS_HOURS

            if isinstance(val, datetime.datetime):
                t = val.time()
                return t < START_BUSINESS_HOURS or t > END_BUSINESS_HOURS

            if isinstance(val, str):
                val_str = val.strip()
                # Try ISO format
                try:
                    dt = datetime.datetime.fromisoformat(val_str.replace("Z", "+00:00"))
                    t = dt.time()
                    return t < START_BUSINESS_HOURS or t > END_BUSINESS_HOURS
                except (ValueError, TypeError):
                    pass

                # Try HH:MM:SS or HH:MM
                match = re.search(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b", val_str)
                if match:
                    h = int(match.group(1))
                    m = int(match.group(2))
                    s = int(match.group(3)) if match.group(3) else 0
                    if 0 <= h <= 23 and 0 <= m <= 59 and 0 <= s <= 59:
                        t = datetime.time(h, m, s)
                        return t < START_BUSINESS_HOURS or t > END_BUSINESS_HOURS

            if isinstance(val, (int, float)) and val > 100_000:
                try:
                    dt = datetime.datetime.fromtimestamp(val)
                    t = dt.time()
                    return t < START_BUSINESS_HOURS or t > END_BUSINESS_HOURS
                except (ValueError, OSError, OverflowError):
                    pass

    return False


def check_high_value_txn(metadata: dict[str, Any]) -> bool:
    """Check if transaction value is strictly above 10,00,000 (10 Lakh)."""
    if metadata.get("high_value_txn") is True or metadata.get("is_high_value_txn") is True:
        return True

    flags = metadata.get("context_flags") or metadata.get("flags")
    if isinstance(flags, (list, tuple, set)) and "high_value_txn" in flags:
        return True

    for key in (
        "amount",
        "transaction_value",
        "txn_value",
        "transaction_amount",
        "txn_amount",
        "value",
    ):
        if key in metadata and metadata[key] is not None:
            val = metadata[key]
            if isinstance(val, (int, float)):
                return val > HIGH_VALUE_THRESHOLD
            if isinstance(val, str):
                cleaned = re.sub(r"[^\d.]", "", val)
                if cleaned:
                    try:
                        num = float(cleaned)
                        return num > HIGH_VALUE_THRESHOLD
                    except ValueError:
                        pass

    return False


def evaluate(metadata: dict[str, Any]) -> tuple[float, list[str]]:
    """
    Evaluate call and transaction metadata against context rules.

    Returns:
        tuple[float, list[str]]:
            - Additive adjustment in range [0.0, 0.25].
            - List of triggered flag strings:
              ["unknown_origin", "first_contact", "off_hours", "high_value_txn"]
    """
    if not isinstance(metadata, dict):
        return 0.0, []

    flags: list[str] = []
    adjustment = 0.0

    if check_unknown_origin(metadata):
        adjustment += WEIGHT_UNKNOWN_ORIGIN
        flags.append("unknown_origin")

    if check_first_contact(metadata):
        adjustment += WEIGHT_FIRST_CONTACT
        flags.append("first_contact")

    if check_off_hours(metadata):
        adjustment += WEIGHT_OFF_HOURS
        flags.append("off_hours")

    if check_high_value_txn(metadata):
        adjustment += WEIGHT_HIGH_VALUE_TXN
        flags.append("high_value_txn")

    total_adjustment = round(min(0.25, max(0.0, adjustment)), 4)
    return total_adjustment, flags


def _selfcheck() -> None:
    """Unit test selfcheck for context rules evaluation."""
    # Baseline empty metadata
    adj, flags = evaluate({})
    assert adj == 0.0 and flags == [], f"Empty dict failed: {adj}, {flags}"

    # Invalid type
    assert evaluate(None) == (0.0, [])  # type: ignore

    # Rule 1: unknown origin
    adj, flags = evaluate({"unknown_origin": True})
    assert adj == 0.10 and flags == ["unknown_origin"], (adj, flags)
    adj, flags = evaluate({"origin_number": "unknown"})
    assert adj == 0.10 and flags == ["unknown_origin"], (adj, flags)
    adj, flags = evaluate({"origin_number": None})
    assert adj == 0.10 and flags == ["unknown_origin"], (adj, flags)
    adj, flags = evaluate({"origin_number": "+919876543210", "registered": False})
    assert adj == 0.10 and flags == ["unknown_origin"], (adj, flags)
    adj, flags = evaluate({"origin_number": "+919876543210", "registered": True})
    assert adj == 0.0 and flags == [], (adj, flags)

    # Rule 2: first contact
    adj, flags = evaluate({"first_contact": True})
    assert adj == 0.05 and flags == ["first_contact"], (adj, flags)
    adj, flags = evaluate({"prior_calls": 0})
    assert adj == 0.05 and flags == ["first_contact"], (adj, flags)
    adj, flags = evaluate({"prior_calls": 3})
    assert adj == 0.0 and flags == [], (adj, flags)

    # Rule 3: off hours (09:00 - 18:00)
    adj, flags = evaluate({"call_time": "08:59:59"})
    assert adj == 0.05 and flags == ["off_hours"], (adj, flags)
    adj, flags = evaluate({"call_time": "09:00:00"})
    assert adj == 0.0 and flags == [], (adj, flags)
    adj, flags = evaluate({"call_time": "14:30:00"})
    assert adj == 0.0 and flags == [], (adj, flags)
    adj, flags = evaluate({"call_time": "18:00:00"})
    assert adj == 0.0 and flags == [], (adj, flags)
    adj, flags = evaluate({"call_time": "18:01:00"})
    assert adj == 0.05 and flags == ["off_hours"], (adj, flags)
    adj, flags = evaluate({"hour": 22})
    assert adj == 0.05 and flags == ["off_hours"], (adj, flags)

    # Rule 4: high value txn (> 10,00,000)
    adj, flags = evaluate({"amount": 1_000_000})
    assert adj == 0.0 and flags == [], (adj, flags)
    adj, flags = evaluate({"amount": 1_000_001})
    assert adj == 0.05 and flags == ["high_value_txn"], (adj, flags)
    adj, flags = evaluate({"amount": "15,00,000"})
    assert adj == 0.05 and flags == ["high_value_txn"], (adj, flags)
    adj, flags = evaluate({"amount": 500_000})
    assert adj == 0.0 and flags == [], (adj, flags)

    # Combined rules
    all_meta = {
        "origin_number": "anonymous",
        "first_contact": True,
        "call_time": "20:30",
        "amount": 2_500_000,
    }
    adj, flags = evaluate(all_meta)
    assert adj == 0.25, adj
    assert flags == ["unknown_origin", "first_contact", "off_hours", "high_value_txn"], flags

    print("service/context_rules.py: All selfcheck tests passed successfully.")


if __name__ == "__main__":
    _selfcheck()
